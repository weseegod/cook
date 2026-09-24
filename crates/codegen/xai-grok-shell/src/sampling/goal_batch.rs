//! Isolated OpenAI-compatible Batch API transport for experimental `/goal_batch`.
//! No live sampler or `/goal` turn calls this module.

use crate::agent::config::{Config, resolve_model_list};
use anyhow::{Context, Result, bail};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::sse::{Event, KeepAlive, Sse},
    routing::post,
};
use futures::stream;
use reqwest::{Client as HttpClient, Url, multipart};
use serde_json::Value;
use std::collections::HashSet;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// One model round is submitted as one asynchronous Batch API job.
#[derive(Clone)]
pub struct BatchClient {
    http: HttpClient,
    base_url: Url,
    api_key: String,
    model_slug: String,
}

impl BatchClient {
    /// Resolve the configured model and bearer. Providers with a dedicated
    /// batch endpoint (for example Xiaomi) require an explicit URL override.
    pub fn from_config(
        config: &Config,
        model_id: &str,
        batch_base_url: Option<&str>,
    ) -> Result<Self> {
        let models = resolve_model_list(config, None);
        let entry = models
            .get(model_id)
            .with_context(|| format!("unknown model {model_id:?}"))?;
        if !entry.info.supports_batch_api {
            bail!("{model_id} does not have supports_batch_api = true");
        }
        let key = entry
            .own_credential()
            .context("Batch API requires a configured model/provider API key")?;
        let realtime_url = Url::parse(&entry.info.base_url).context("invalid model base URL")?;
        if is_xiaomi_host(realtime_url.host_str().unwrap_or_default()) && !key.starts_with("sk-") {
            bail!("Xiaomi Batch API requires a pay-as-you-go sk- key");
        }
        let selected_url = match batch_base_url {
            Some(url) => url,
            None if realtime_url.host_str() == Some("api.openai.com") => {
                "https://api.openai.com/v1"
            }
            None => bail!(
                "{model_id} needs an explicit Batch API base URL; use --base-url <provider batch URL>"
            ),
        };
        let base_url = validate_batch_base_url(selected_url, &realtime_url)?;
        Ok(Self {
            http: HttpClient::builder()
                .timeout(Duration::from_secs(120))
                .build()
                .context("creating Batch API client")?,
            base_url,
            api_key: key,
            model_slug: entry.info.model.clone(),
        })
    }

    fn endpoint(&self, path: &str) -> Result<Url> {
        self.base_url
            .join(path)
            .with_context(|| format!("invalid Batch API path {path:?}"))
    }

    async fn checked_json(response: reqwest::Response) -> Result<Value> {
        let status = response.status();
        let body = response
            .text()
            .await
            .context("reading Batch API response")?;
        if !status.is_success() {
            bail!(
                "Batch API returned {status}: {}",
                body.chars().take(2000).collect::<String>()
            );
        }
        serde_json::from_str(&body).context("parsing Batch API response")
    }

    pub async fn submit_jsonl(&self, input: &str) -> Result<Value> {
        validate_batch_jsonl(input, &self.model_slug)?;
        let file = multipart::Part::bytes(input.as_bytes().to_vec())
            .file_name("cook-batch.jsonl")
            .mime_str("application/jsonl")?;
        let form = multipart::Form::new()
            .text("purpose", "batch")
            .part("file", file);
        let uploaded = Self::checked_json(
            self.http
                .post(self.endpoint("files")?)
                .bearer_auth(&self.api_key)
                .multipart(form)
                .send()
                .await
                .context("uploading batch input")?,
        )
        .await?;
        let file_id = uploaded["id"]
            .as_str()
            .context("Batch API upload did not return a file id")?;
        Self::checked_json(
            self.http
                .post(self.endpoint("batches")?)
                .bearer_auth(&self.api_key)
                .json(&serde_json::json!({
                    "input_file_id": file_id,
                    "endpoint": "/v1/chat/completions",
                    "completion_window": "24h"
                }))
                .send()
                .await
                .context("creating batch job")?,
        )
        .await
    }

    /// Submit exactly one non-streaming Chat Completions request for one agent
    /// model round. The caller retains `custom_id` to correlate the result.
    pub async fn submit_one(&self, custom_id: &str, body: Value) -> Result<String> {
        let line = serde_json::json!({
            "custom_id": custom_id,
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": body,
        });
        let job = self.submit_jsonl(&line.to_string()).await?;
        job["id"]
            .as_str()
            .map(str::to_owned)
            .context("Batch API did not return a job id")
    }

    pub fn model_slug(&self) -> &str {
        &self.model_slug
    }

    pub async fn status(&self, batch_id: &str) -> Result<Value> {
        validate_batch_id(batch_id)?;
        Self::checked_json(
            self.http
                .get(self.endpoint(&format!("batches/{batch_id}"))?)
                .bearer_auth(&self.api_key)
                .send()
                .await
                .context("querying batch job")?,
        )
        .await
    }

    pub async fn cancel(&self, batch_id: &str) -> Result<Value> {
        validate_batch_id(batch_id)?;
        Self::checked_json(
            self.http
                .post(self.endpoint(&format!("batches/{batch_id}/cancel"))?)
                .bearer_auth(&self.api_key)
                .send()
                .await
                .context("cancelling batch job")?,
        )
        .await
    }

    /// Poll a single agent round. Cancellation is explicit: if the foreground
    /// turn goes away, ask the provider to cancel the charged job as well.
    pub async fn wait_one(
        &self,
        batch_id: &str,
        custom_id: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25 * 60 * 60);
        let mut status_failures = 0u8;
        loop {
            let status = tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = self.cancel(batch_id).await;
                    bail!("batch job {batch_id} cancelled");
                }
                status = self.status(batch_id) => status,
            };
            let job = match status {
                Ok(job) => {
                    status_failures = 0;
                    job
                }
                Err(error) => {
                    status_failures += 1;
                    if status_failures >= 5 {
                        let _ = self.cancel(batch_id).await;
                        return Err(error).context(format!(
                            "batch job {batch_id} status failed five consecutive times"
                        ));
                    }
                    tracing::warn!(%batch_id, %error, status_failures, "retrying batch status");
                    tokio::select! {
                        _ = cancel.cancelled() => {
                            let _ = self.cancel(batch_id).await;
                            bail!("batch job {batch_id} cancelled");
                        }
                        _ = tokio::time::sleep(Duration::from_secs(30)) => {}
                    }
                    continue;
                }
            };
            match job["status"].as_str().unwrap_or_default() {
                "completed" => {
                    let output = self.results(batch_id, false).await?;
                    return extract_batch_response(&output, custom_id);
                }
                "failed" | "expired" | "cancelled" => {
                    bail!("batch job {batch_id} ended with status {}", job["status"]);
                }
                _ => {}
            }
            if tokio::time::Instant::now() >= deadline {
                bail!("batch job {batch_id} did not finish within 25 hours");
            }
            tokio::select! {
                _ = cancel.cancelled() => {
                    let _ = self.cancel(batch_id).await;
                    bail!("batch job {batch_id} cancelled");
                }
                _ = tokio::time::sleep(Duration::from_secs(30)) => {}
            }
        }
    }

    pub async fn results(&self, batch_id: &str, errors: bool) -> Result<String> {
        let job = self.status(batch_id).await?;
        let field = if errors {
            "error_file_id"
        } else {
            "output_file_id"
        };
        let file_id = job[field]
            .as_str()
            .with_context(|| format!("job has no {field}; current status: {}", job["status"]))?;
        // IDs are server-supplied, but still keep them within a single path segment.
        if !file_id.starts_with("file-")
            || !file_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            bail!("Batch API returned an invalid file id");
        }
        let response = self
            .http
            .get(self.endpoint(&format!("files/{file_id}/content"))?)
            .bearer_auth(&self.api_key)
            .send()
            .await
            .context("downloading batch results")?;
        let status = response.status();
        let body = response.text().await.context("reading batch results")?;
        if !status.is_success() {
            bail!(
                "Batch API returned {status}: {}",
                body.chars().take(2000).collect::<String>()
            );
        }
        Ok(body)
    }
}

struct ProxyState {
    client: BatchClient,
    secret: String,
    current_job: parking_lot::Mutex<Option<String>>,
}

/// Loopback transport owned only by an active `/goal_batch` run. It translates
/// one ordinary agent sampling round into one provider batch job, then emits the
/// finished response as Chat Completions SSE so the existing tool loop can
/// process the same model output. No global sampler behavior is changed.
pub struct GoalBatchProxy {
    state: Arc<ProxyState>,
    base_url: String,
    server: tokio::task::JoinHandle<()>,
}

impl std::fmt::Debug for GoalBatchProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoalBatchProxy")
            .field("base_url", &self.base_url)
            .field("current_job", &self.current_job_id())
            .finish_non_exhaustive()
    }
}

impl GoalBatchProxy {
    pub async fn start(client: BatchClient) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .context("binding goal_batch loopback adapter")?;
        let address = listener.local_addr()?;
        let state = Arc::new(ProxyState {
            client,
            secret: format!("goal-batch-{}", uuid::Uuid::new_v4()),
            current_job: parking_lot::Mutex::new(None),
        });
        let app = Router::new()
            .route("/v1/chat/completions", post(proxy_chat_completion))
            .layer(DefaultBodyLimit::max(128 * 1024 * 1024))
            .with_state(Arc::clone(&state));
        let server = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::error!(%error, "goal_batch loopback adapter stopped");
            }
        });
        Ok(Self {
            state,
            base_url: format!("http://{address}/v1"),
            server,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn bearer(&self) -> &str {
        &self.state.secret
    }

    pub fn current_job_id(&self) -> Option<String> {
        self.state.current_job.lock().clone()
    }

    pub async fn current_job_status(&self) -> Result<Option<Value>> {
        let id = self.current_job_id();
        match id {
            Some(id) => self.state.client.status(&id).await.map(Some),
            None => Ok(None),
        }
    }
}

impl Drop for GoalBatchProxy {
    fn drop(&mut self) {
        self.server.abort();
        if let Some(id) = self.state.current_job.lock().clone()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let client = self.state.client.clone();
            runtime.spawn(async move {
                if let Err(error) = client.cancel(&id).await {
                    tracing::warn!(%id, %error, "could not cancel abandoned batch job");
                }
            });
        }
    }
}

async fn proxy_chat_completion(
    State(state): State<Arc<ProxyState>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Result<Sse<impl futures::Stream<Item = Result<Event, Infallible>>>, (StatusCode, String)> {
    let expected = format!("Bearer {}", state.secret);
    if headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(expected.as_str())
    {
        return Err((
            StatusCode::UNAUTHORIZED,
            "goal_batch adapter authentication failed".into(),
        ));
    }
    if body["model"] != state.client.model_slug() || !body["messages"].is_array() {
        return Err((
            StatusCode::BAD_REQUEST,
            "goal_batch model or messages mismatch".into(),
        ));
    }
    if !body.is_object() {
        return Err((
            StatusCode::BAD_REQUEST,
            "goal_batch request must be an object".into(),
        ));
    }
    let object = body.as_object_mut().expect("checked object");
    object.remove("stream");
    object.remove("stream_options");
    let custom_id = format!("goal-batch-{}", uuid::Uuid::new_v4());
    let job_id = state
        .client
        .submit_one(&custom_id, body)
        .await
        .map_err(|error| (StatusCode::BAD_GATEWAY, error.to_string()))?;
    *state.current_job.lock() = Some(job_id.clone());
    tracing::info!(%job_id, "goal_batch model round submitted");
    let (tx, rx) = mpsc::channel::<Event>(4);
    tokio::spawn(async move {
        let cancel = CancellationToken::new();
        let outcome = tokio::select! {
            _ = tx.closed() => {
                cancel.cancel();
                let _ = state.client.cancel(&job_id).await;
                *state.current_job.lock() = None;
                return;
            }
            outcome = state.client.wait_one(&job_id, &custom_id, &cancel) => outcome,
        };
        *state.current_job.lock() = None;
        match outcome.and_then(chat_response_to_sse_chunks) {
            Ok(chunks) => {
                for chunk in chunks {
                    if tx.send(Event::default().data(chunk)).await.is_err() {
                        return;
                    }
                }
                let _ = tx.send(Event::default().data("[DONE]")).await;
            }
            Err(error) => {
                tracing::error!(%job_id, %error, "goal_batch model round failed");
                let _ = tx
                    .send(
                        Event::default().data(
                            serde_json::json!({"error": {
                                "type": "batch_job_failed",
                                "message": format!("Batch job {job_id} failed: {error}"),
                                "code": "batch_job_failed"
                            }})
                            .to_string(),
                        ),
                    )
                    .await;
            }
        }
    });
    let events = stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|event| (Ok(event), rx))
    });
    Ok(Sse::new(events).keep_alive(KeepAlive::default().interval(Duration::from_secs(15))))
}

/// Convert a completed non-streaming response to the wire chunks the normal
/// Chat Completions stream decoder consumes. Tool-call indices are added here
/// because a completed response has no streaming index field.
fn chat_response_to_sse_chunks(body: Value) -> Result<Vec<String>> {
    let choice = body["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .context("batch response has no first choice")?;
    let message = &choice["message"];
    let tool_calls: Vec<Value> = message["tool_calls"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, call)| {
            serde_json::json!({
                "index": index,
                "id": call["id"],
                "type": call["type"],
                "function": call["function"],
            })
        })
        .collect();
    let finish_reason = choice["finish_reason"]
        .as_str()
        .unwrap_or(if tool_calls.is_empty() {
            "stop"
        } else {
            "tool_calls"
        });
    let chunk = serde_json::json!({
        "id": body["id"],
        "object": "chat.completion.chunk",
        "created": body["created"],
        "model": body["model"],
        "choices": [{
            "index": 0,
            "delta": {
                "role": "assistant",
                "content": message["content"],
                "reasoning_content": message["reasoning_content"],
                "tool_calls": tool_calls,
            },
            "finish_reason": finish_reason,
        }],
        "usage": body["usage"],
    });
    Ok(vec![chunk.to_string()])
}

fn extract_batch_response(jsonl: &str, custom_id: &str) -> Result<Value> {
    for (index, line) in jsonl.lines().enumerate() {
        let result: Value = serde_json::from_str(line)
            .with_context(|| format!("invalid batch output line {}", index + 1))?;
        if result["custom_id"] != custom_id {
            continue;
        }
        if result["response"]["status_code"] != 200 {
            bail!("batch request {custom_id} failed: {}", result["error"]);
        }
        let body = &result["response"]["body"];
        if !body.is_object() || !body["choices"].is_array() {
            bail!("batch request {custom_id} returned no Chat Completions body");
        }
        return Ok(body.clone());
    }
    bail!("batch output has no result for {custom_id}")
}

fn is_xiaomi_host(host: &str) -> bool {
    host == "xiaomimimo.com" || host.ends_with(".xiaomimimo.com")
}

fn validate_batch_base_url(value: &str, realtime_url: &Url) -> Result<Url> {
    let mut url = Url::parse(value).context("invalid Batch API base URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("Batch API base URL must be HTTPS without credentials, query, or fragment");
    }
    let realtime_host = realtime_url.host_str().unwrap_or_default();
    let batch_host = url.host_str().unwrap_or_default();
    if is_xiaomi_host(realtime_host) {
        if !batch_host.starts_with("batch-api-") || !batch_host.ends_with(".xiaomimimo.com") {
            bail!("use the account-region Batch API URL shown in Xiaomi's Batch Inference console");
        }
    } else if batch_host != realtime_host {
        bail!("Batch API URL host must match the model provider host");
    }
    if url.path().trim_end_matches('/') != "/v1" {
        bail!("Batch API base URL must end in /v1");
    }
    url.set_path("/v1/");
    Ok(url)
}

fn validate_batch_id(id: &str) -> Result<()> {
    if !id.starts_with("batch_")
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        bail!("invalid batch id");
    }
    Ok(())
}

fn validate_batch_jsonl(input: &str, model_slug: &str) -> Result<()> {
    if input.is_empty() || input.len() > 128 * 1024 * 1024 {
        bail!("batch input must be nonempty and no larger than 128 MB");
    }
    let mut ids = HashSet::new();
    for (index, line) in input.lines().enumerate() {
        let request: Value = serde_json::from_str(line)
            .with_context(|| format!("invalid JSON on batch input line {}", index + 1))?;
        let id = request["custom_id"]
            .as_str()
            .with_context(|| format!("line {} has no custom_id", index + 1))?;
        if id.is_empty() || !ids.insert(id.to_owned()) {
            bail!("line {} has an empty or duplicate custom_id", index + 1);
        }
        if request["method"] != "POST" || request["url"] != "/v1/chat/completions" {
            bail!("line {} must POST to /v1/chat/completions", index + 1);
        }
        let body = &request["body"];
        if body["model"] != model_slug || !body["messages"].is_array() || body["stream"] == true {
            bail!(
                "line {} must use configured model {model_slug}, messages, and non-streaming output",
                index + 1
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_openai_model_uses_its_own_key_and_batch_opt_in() {
        let raw: toml::Value = toml::from_str(
            r#"
            [model."openai/test"]
            model = "test-model"
            base_url = "https://api.openai.com/v1"
            api_key = "sk-test"
            context_window = 32000
            supports_batch_api = true
            "#,
        )
        .unwrap();
        let config = Config::new_from_toml_cfg(&raw).unwrap();
        let client = BatchClient::from_config(&config, "openai/test", None).unwrap();
        assert_eq!(client.model_slug(), "test-model");
        assert_eq!(client.base_url.as_str(), "https://api.openai.com/v1/");
        assert_eq!(client.api_key, "sk-test");
        let denied: toml::Value = toml::from_str(
            r#"
            [model."openai/test"]
            model = "test-model"
            base_url = "https://api.openai.com/v1"
            api_key = "sk-test"
            context_window = 32000
            "#,
        )
        .unwrap();
        let denied = Config::new_from_toml_cfg(&denied).unwrap();
        assert!(BatchClient::from_config(&denied, "openai/test", None).is_err());
    }

    #[test]
    fn batch_url_is_provider_scoped_and_uses_v1_prefix() {
        let xiaomi = Url::parse("https://api.xiaomimimo.com/v1").unwrap();
        let url =
            validate_batch_base_url("https://batch-api-cn.xiaomimimo.com/v1", &xiaomi).unwrap();
        assert_eq!(url.as_str(), "https://batch-api-cn.xiaomimimo.com/v1/");
        for bad in [
            "https://api.xiaomimimo.com/v1",
            "http://batch-api-cn.xiaomimimo.com/v1",
            "https://batch-api-cn.xiaomimimo.com.evil.test/v1",
            "https://batch-api-cn.xiaomimimo.com/v1/extra",
            "https://batch-api-cn.xiaomimimo.com/v1?x=1",
        ] {
            assert!(validate_batch_base_url(bad, &xiaomi).is_err(), "{bad}");
        }
        let openai = Url::parse("https://api.openai.com/v1").unwrap();
        assert!(validate_batch_base_url("https://api.openai.com/v1", &openai).is_ok());
        assert!(validate_batch_base_url("https://other.example/v1", &openai).is_err());
    }

    #[test]
    fn batch_jsonl_rejects_mismatched_and_interactive_requests() {
        let valid = r#"{"custom_id":"one","method":"POST","url":"/v1/chat/completions","body":{"model":"mimo-v2.6-flash","messages":[{"role":"user","content":"Hello"}]}}"#;
        assert!(validate_batch_jsonl(valid, "mimo-v2.6-flash").is_ok());
        assert!(validate_batch_jsonl(valid, "mimo-v2.6-pro").is_err());
        assert!(validate_batch_jsonl(&format!("{valid}\n{valid}"), "mimo-v2.6-flash").is_err());
        let streaming = valid.replace("\"messages\":", "\"stream\":true,\"messages\":");
        assert!(validate_batch_jsonl(&streaming, "mimo-v2.6-flash").is_err());
    }

    #[test]
    fn batch_output_correlates_by_custom_id_and_requires_success() {
        let output = concat!(
            "{\"custom_id\":\"other\",\"response\":{\"status_code\":200,\"body\":{\"choices\":[]}}}\n",
            "{\"custom_id\":\"wanted\",\"response\":{\"status_code\":200,\"body\":{\"id\":\"ok\",\"choices\":[]}}}\n"
        );
        assert_eq!(
            extract_batch_response(output, "wanted").unwrap()["id"],
            "ok"
        );
        assert!(extract_batch_response(output, "absent").is_err());
        let failed = r#"{"custom_id":"wanted","response":{"status_code":429,"body":{}},"error":{"code":"rate_limit"}}"#;
        assert!(extract_batch_response(failed, "wanted").is_err());
    }

    #[test]
    fn completed_tool_call_becomes_valid_stream_chunk() {
        let response = serde_json::json!({
            "id": "chat-1", "created": 123, "model": "mimo-v2.6-flash",
            "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                "role": "assistant", "content": null, "reasoning_content": "read first",
                "tool_calls": [{"id": "call-1", "type": "function", "function": {
                    "name": "read_file", "arguments": "{\"target_file\":\"task.txt\"}"
                }}]
            }}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        });
        let chunks = chat_response_to_sse_chunks(response).unwrap();
        let chunk: xai_grok_sampling_types::ChatCompletionChunk =
            serde_json::from_str(&chunks[0]).unwrap();
        assert_eq!(chunk.choices[0].delta.tool_calls[0].index, 0);
        assert_eq!(
            chunk.choices[0].delta.tool_calls[0].id.as_deref(),
            Some("call-1")
        );
        assert_eq!(
            chunk.choices[0].delta.reasoning_content.as_deref(),
            Some("read first")
        );
        assert!(matches!(
            chunk.choices[0].finish_reason,
            Some(xai_grok_sampling_types::FinishReason::ToolCalls)
        ));
    }

    #[tokio::test]
    async fn batch_http_round_trip_uses_files_and_batches_endpoints() {
        use axum::{
            Router,
            body::Bytes,
            http::HeaderMap,
            routing::{get, post},
        };

        async fn upload(headers: HeaderMap, body: Bytes) -> axum::Json<Value> {
            assert_eq!(headers["authorization"], "Bearer sk-test");
            assert!(String::from_utf8_lossy(&body).contains("cook-batch-smoke"));
            axum::Json(serde_json::json!({"id":"file-input"}))
        }
        async fn create(headers: HeaderMap, body: Bytes) -> axum::Json<Value> {
            assert_eq!(headers["authorization"], "Bearer sk-test");
            let request: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(request["input_file_id"], "file-input");
            assert_eq!(request["endpoint"], "/v1/chat/completions");
            axum::Json(serde_json::json!({"id":"batch_smoke","status":"validating"}))
        }
        async fn status() -> axum::Json<Value> {
            axum::Json(serde_json::json!({
                "id":"batch_smoke", "status":"completed", "output_file_id":"file-output"
            }))
        }
        let app = Router::new()
            .route("/v1/files", post(upload))
            .route("/v1/batches", post(create))
            .route("/v1/batches/batch_smoke", get(status))
            .route(
                "/v1/files/file-output/content",
                get(|| async { "{\"custom_id\":\"cook-batch-smoke\"}\n" }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = BatchClient {
            http: HttpClient::new(),
            base_url: Url::parse(&format!("http://{address}/v1/")).unwrap(),
            api_key: "sk-test".into(),
            model_slug: "mimo-v2.6-flash".into(),
        };
        let input = r#"{"custom_id":"cook-batch-smoke","method":"POST","url":"/v1/chat/completions","body":{"model":"mimo-v2.6-flash","messages":[{"role":"user","content":"OK"}]}}"#;
        let job = client.submit_jsonl(input).await.unwrap();
        assert_eq!(job["id"], "batch_smoke");
        assert_eq!(
            client.status("batch_smoke").await.unwrap()["status"],
            "completed"
        );
        assert_eq!(
            client.results("batch_smoke", false).await.unwrap(),
            "{\"custom_id\":\"cook-batch-smoke\"}\n"
        );
        assert!(client.results("batch_smoke", true).await.is_err());
        server.abort();
    }

    #[tokio::test]
    async fn proxy_runs_two_dependent_model_rounds_as_two_batch_jobs() {
        use axum::{body::Bytes, extract::Path, routing::get};
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Clone, Default)]
        struct Fake {
            jobs: Arc<AtomicUsize>,
            custom_ids: Arc<parking_lot::Mutex<Vec<String>>>,
        }
        async fn upload(State(fake): State<Fake>, body: Bytes) -> Json<Value> {
            let text = String::from_utf8(body.to_vec()).unwrap();
            let start = text.find("{\"custom_id\"").unwrap();
            let request: Value = serde_json::Deserializer::from_str(&text[start..])
                .into_iter()
                .next()
                .unwrap()
                .unwrap();
            fake.custom_ids
                .lock()
                .push(request["custom_id"].as_str().unwrap().to_owned());
            Json(serde_json::json!({"id":"file-input"}))
        }
        async fn create(State(fake): State<Fake>) -> Json<Value> {
            let id = fake.jobs.fetch_add(1, Ordering::SeqCst) + 1;
            Json(serde_json::json!({"id":format!("batch_{id}"),"status":"validating"}))
        }
        async fn status(Path(id): Path<String>) -> Json<Value> {
            Json(serde_json::json!({
                "id": id, "status": "completed",
                "output_file_id": format!("file-{}", id.trim_start_matches("batch_"))
            }))
        }
        async fn output(State(fake): State<Fake>, Path(file): Path<String>) -> String {
            let index: usize = file.trim_start_matches("file-").parse().unwrap();
            let custom_id = fake.custom_ids.lock()[index - 1].clone();
            let message = if index == 1 {
                serde_json::json!({"role":"assistant","content":null,"tool_calls":[{
                    "id":"call-1","type":"function","function":{"name":"read_file","arguments":"{}"}
                }]})
            } else {
                serde_json::json!({"role":"assistant","content":"Done"})
            };
            let finish = if index == 1 { "tool_calls" } else { "stop" };
            serde_json::json!({
                "custom_id": custom_id,
                "response": {"status_code":200,"body":{
                    "id":format!("chat-{index}"),"created":1,"model":"test-model",
                    "choices":[{"index":0,"finish_reason":finish,"message":message}]
                }}
            })
            .to_string()
        }
        let fake = Fake::default();
        let app = Router::new()
            .route("/v1/files", post(upload))
            .route("/v1/batches", post(create))
            .route("/v1/batches/{id}", get(status))
            .route("/v1/files/{file}/content", get(output))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let proxy = GoalBatchProxy::start(BatchClient {
            http: HttpClient::new(),
            base_url: Url::parse(&format!("http://{address}/v1/")).unwrap(),
            api_key: "sk-test".into(),
            model_slug: "test-model".into(),
        })
        .await
        .unwrap();
        let http = HttpClient::new();
        for (round, expected) in [(1, "tool_calls"), (2, "Done")] {
            let response = http
                .post(format!("{}/chat/completions", proxy.base_url()))
                .bearer_auth(proxy.bearer())
                .json(&serde_json::json!({
                    "model":"test-model","stream":true,
                    "messages":[{"role":"user","content":format!("round {round}")}]
                }))
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            let events = response.text().await.unwrap();
            assert!(events.contains(expected), "{events}");
            assert!(events.contains("data: [DONE]"), "{events}");
        }
        assert_eq!(fake.jobs.load(Ordering::SeqCst), 2);
        server.abort();
    }
}
