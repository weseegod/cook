use super::types::{WebSearchConfig, WebSearchWire};
use crate::attribution::{SharedAttributionCallback, ToolConsumer};
use crate::types::SharedApiKeyProvider;
use async_openai::types::responses as rs;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
/// Anthropic `web_search_20250305` server tool spec: the search runs server-side inside a
/// Messages turn and returns structured result blocks. DeepSeek exposes no dedicated search
/// endpoint, so this Messages call is how its native search is reached.
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side search budget per Messages call. Mirrors `deepseek-harness`'s provider default.
const MESSAGES_MAX_USES: u32 = 5;
/// Upper bound on generated tokens for the auxiliary Messages call.
const MESSAGES_MAX_TOKENS: u32 = 4096;
/// A minimal, purpose-built HTTP client for calling the Responses or Messages API
/// with web search capability.
#[derive(Clone)]
pub struct WebSearchClient {
    http: reqwest::Client,
    base_url: String,
    model: String,
    /// Static key from the config. Sent as `x-api-key` on the Messages wire, where the endpoint
    /// reads that header even when `Authorization` is also present.
    api_key: String,
    wire: WebSearchWire,
    /// Whether the Responses call may authenticate with the live session bearer. False for a
    /// third-party BYOK endpoint, where the config's own `api_key` is the credential.
    use_session_bearer: bool,
    /// Authoritative domain allowlist from `[toolset.web_search] allowed_domains`. When set it
    /// governs the search and the model's per-call `allowed_domains` is ignored (see
    /// [`Self::resolve_filters`]). Mutually exclusive with `default_excluded_domains`.
    default_allowed_domains: Option<Vec<String>>,
    /// Authoritative domain blocklist from `[toolset.web_search] excluded_domains`.
    /// The model cannot un-set it by naming a blocked domain in its own
    /// `allowed_domains`. Mutually exclusive with `default_allowed_domains`.
    default_excluded_domains: Option<Vec<String>>,
    api_key_provider: Option<SharedApiKeyProvider>,
    /// Optional 401-attribution hook. Callers can wire this so a 401
    /// from the Responses API emits an `auth_401_attribution` event
    /// with `consumer == "WebSearch"`.
    attribution_callback: Option<SharedAttributionCallback>,
}
impl WebSearchClient {
    /// Create a new web search client from `WebSearchConfig::Enabled`.
    ///
    /// Returns `Err` if the config is `Disabled` or if header values are invalid.
    pub fn new(
        config: &WebSearchConfig,
        api_key_provider: Option<SharedApiKeyProvider>,
    ) -> Result<Self, xai_tool_runtime::ToolError> {
        let WebSearchConfig::Enabled {
            wire,
            use_session_bearer,
            api_key,
            base_url,
            model,
            extra_headers,
            alpha_test_key,
            allowed_domains,
            excluded_domains,
        } = config
        else {
            return Err(xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                "Cannot create WebSearchClient from disabled config".to_string(),
            ));
        };
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Invalid API key for header: {e}"),
                )
            })?,
        );
        for (key, value) in extra_headers {
            let header_name = HeaderName::from_bytes(key.as_bytes()).map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Invalid header name '{key}': {e}"),
                )
            })?;
            let header_value = HeaderValue::from_str(value).map_err(|e| {
                xai_tool_runtime::ToolError::execution(
                    xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                    format!("Invalid header value for '{key}': {e}"),
                )
            })?;
            headers.insert(header_name, header_value);
        }
        let _ = alpha_test_key;
        let key = crate::util::shared_http::cache_key("web_search", &headers);
        let http = crate::util::shared_http::cached_client(key, || {
            xai_grok_extra_ca::build_reqwest_client(|builder| {
                builder.default_headers(headers.clone())
            })
        })
        .map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to build HTTP client: {e}"),
            )
        })?;
        Ok(Self {
            http,
            base_url: base_url.clone(),
            model: model.clone(),
            api_key: api_key.clone(),
            wire: *wire,
            use_session_bearer: *use_session_bearer,
            default_allowed_domains: allowed_domains.clone(),
            default_excluded_domains: excluded_domains.clone(),
            api_key_provider,
            attribution_callback: None,
        })
    }
    /// Resolve the effective domain filters for a request. This is required for `excluded_domains` to be a real block. Otherwise the model could
    /// bypass the user's blocklist simply by naming the blocked domain in its own `allowed_domains`. Only when no config policy is set does the
    /// model's per-call allowlist apply. The two lists are mutually exclusive, so at most one of the returned options is `Some`.
    fn resolve_filters(
        &self,
        model_allowed: Option<Vec<String>>,
    ) -> (Option<Vec<String>>, Option<Vec<String>>) {
        if let Some(allowed) = self
            .default_allowed_domains
            .clone()
            .filter(|d| !d.is_empty())
        {
            return (Some(allowed), None);
        }
        if let Some(excluded) = self
            .default_excluded_domains
            .clone()
            .filter(|d| !d.is_empty())
        {
            return (None, Some(excluded));
        }
        (model_allowed.filter(|d| !d.is_empty()), None)
    }
    /// Build the serialized `/responses` request body for a single web search. The request always
    /// carries exactly one tool (`web_search`) at index 0.
    fn build_request_json(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
        excluded_domains: Option<Vec<String>>,
    ) -> Result<serde_json::Value, xai_tool_runtime::ToolError> {
        let err = |msg: String| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                msg,
            )
        };
        let web_search = rs::WebSearchToolArgs::default()
            .filters(rs::WebSearchToolFilters { allowed_domains })
            .build()
            .map_err(|e| err(format!("Failed to build web search tool: {e}")))?;
        let request = rs::CreateResponseArgs::default()
            .model(self.model.clone())
            .input(query.to_string())
            .tools(vec![rs::Tool::WebSearch(web_search)])
            .store(false)
            .temperature(0.1)
            .top_p(0.95)
            .max_output_tokens(8192u32)
            .build()
            .map_err(|e| err(format!("Failed to build request: {e}")))?;
        let mut body = serde_json::to_value(&request)
            .map_err(|e| err(format!("Failed to serialize request: {e}")))?;
        if let Some(excluded) = excluded_domains.filter(|d| !d.is_empty()) {
            let tool = body
                .get_mut("tools")
                .and_then(|t| t.as_array_mut())
                .and_then(|arr| arr.first_mut())
                .and_then(|t| t.as_object_mut());
            if let Some(tool) = tool {
                let filters = tool
                    .entry("filters")
                    .or_insert_with(|| serde_json::json!({}));
                if let Some(obj) = filters.as_object_mut() {
                    obj.insert("excluded_domains".to_owned(), serde_json::json!(excluded));
                }
            }
        }
        Ok(body)
    }
    /// Wire a 401-attribution callback into this client. Idempotent;
    /// safe to call before or after the first request.
    pub fn with_attribution_callback(
        mut self,
        callback: Option<SharedAttributionCallback>,
    ) -> Self {
        self.attribution_callback = callback;
        self
    }
    /// The bearer to override the config key with on a Responses call, or `None` to keep the
    /// client's own `Authorization: Bearer {api_key}`. The session provider mints first-party xAI
    /// tokens, so it is consulted only when the endpoint is a first-party route.
    async fn current_bearer(&self) -> Option<String> {
        if !self.use_session_bearer {
            return None;
        }
        crate::types::api_key_provider::resolve_bearer(self.api_key_provider.as_ref()).await
    }
    fn record_401_attribution(&self, sent_bearer: Option<&str>) {
        crate::attribution::emit_401(
            self.attribution_callback.as_ref(),
            ToolConsumer::WebSearch,
            sent_bearer,
        );
    }
    /// Perform a web search query using the Responses API. Returns `(content, citations)` where
    /// content is the assistant's text and citations are unique URLs found in the response
    /// annotations.
    pub async fn search(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<String>), xai_tool_runtime::ToolError> {
        if self.wire == WebSearchWire::Messages {
            let (content, pairs) = self.search_messages(query, allowed_domains).await?;
            let citations = pairs.into_iter().map(|(_title, url)| url).collect();
            return Ok((content, citations));
        }
        self.search_responses(query, allowed_domains).await
    }
    async fn search_responses(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<String>), xai_tool_runtime::ToolError> {
        let (allowed, excluded) = self.resolve_filters(allowed_domains);
        let request = self.build_request_json(query, allowed, excluded)?;
        let url = format!("{}/responses", self.base_url.trim_end_matches('/'));
        let sent_bearer = self.current_bearer().await;
        let mut req = self.http.post(&url).json(&request);
        if let Some(ref key) = sent_bearer {
            req = req.header(AUTHORIZATION, format!("Bearer {key}"));
        }
        let response = req.send().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("HTTP request failed: {e}"),
            )
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.record_401_attribution(sent_bearer.as_deref());
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            return Err(xai_tool_runtime::ToolError::unauthorized(format!(
                "Responses API returned 401 Unauthorized: {body}"
            ))
            .with_details(serde_json::json!({
                "tool_id": "web_search",
                "status": 401,
            })));
        }
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            return Err(xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Responses API returned {status}: {body}"),
            ));
        }
        let bytes = response.bytes().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to read response body: {e}"),
            )
        })?;
        let response_obj = parse_response(&bytes).map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to parse response: {e}"),
            )
        })?;
        let content = response_obj
            .output_text()
            .unwrap_or_else(|| "No search results found.".to_string());
        let citations = extract_citations(&response_obj);
        Ok((content, citations))
    }
    /// Same as [`Self::search`] but also extracts per-citation titles when the Responses API surfaces them. Returns `(content,
    /// citations_with_titles)` where each citation is `(title, url)`. Empty `title` strings indicate the upstream didn't supply one for that URL.
    /// Used by the cursor-compat `WebSearch` adapter to render a `Links:\n1. [title](url)` list instead of the LLM synthesis text.
    pub async fn search_with_titles(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<(String, String)>), xai_tool_runtime::ToolError> {
        if self.wire == WebSearchWire::Messages {
            return self.search_messages(query, allowed_domains).await;
        }
        self.search_with_titles_responses(query, allowed_domains)
            .await
    }
    async fn search_with_titles_responses(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<(String, String)>), xai_tool_runtime::ToolError> {
        let (allowed, excluded) = self.resolve_filters(allowed_domains);
        let request = self.build_request_json(query, allowed, excluded)?;
        let url = format!("{}/responses", self.base_url.trim_end_matches('/'));
        let sent_bearer = self.current_bearer().await;
        let mut req = self.http.post(&url).json(&request);
        if let Some(ref key) = sent_bearer {
            req = req.header(AUTHORIZATION, format!("Bearer {key}"));
        }
        let response = req.send().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("HTTP request failed: {e}"),
            )
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            self.record_401_attribution(sent_bearer.as_deref());
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            return Err(xai_tool_runtime::ToolError::unauthorized(format!(
                "Responses API returned 401 Unauthorized: {body}"
            ))
            .with_details(serde_json::json!({
                "tool_id": "web_search",
                "status": 401,
            })));
        }
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            return Err(xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Responses API returned {status}: {body}"),
            ));
        }
        let bytes = response.bytes().await.map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to read response body: {e}"),
            )
        })?;
        let response_obj = parse_response(&bytes).map_err(|e| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                format!("Failed to parse response: {e}"),
            )
        })?;
        let content = response_obj
            .output_text()
            .unwrap_or_else(|| "No search results found.".to_string());
        let pairs = extract_citation_pairs(&response_obj);
        Ok((content, pairs))
    }
    /// Serialized Anthropic Messages body for one server-side search. Mirrors the `web_search_20250305`
    /// server tool that `deepseek-harness` sends, minus the provider prose: the caller reads result blocks.
    fn build_messages_request_json(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
        excluded_domains: Option<Vec<String>>,
    ) -> serde_json::Value {
        let mut tool = serde_json::json!({
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": MESSAGES_MAX_USES,
        });
        if let Some(obj) = tool.as_object_mut() {
            if let Some(allowed) = allowed_domains.filter(|d| !d.is_empty()) {
                obj.insert("allowed_domains".to_owned(), serde_json::json!(allowed));
            }
            if let Some(excluded) = excluded_domains.filter(|d| !d.is_empty()) {
                obj.insert("blocked_domains".to_owned(), serde_json::json!(excluded));
            }
        }
        serde_json::json!({
            "model": self.model,
            "max_tokens": MESSAGES_MAX_TOKENS,
            "messages": [{
                "role": "user",
                "content": [{ "type": "text", "text": query }],
            }],
            "tools": [tool],
        })
    }
    /// Run native server search through the Anthropic-compatible Messages endpoint. Returns the
    /// formatted source list and `(title, url)` pairs. Provider prose is never copied into the
    /// tool result; a body with no `web_search_tool_result` block is an error rather than a
    /// prose-scraping fallback.
    async fn search_messages(
        &self,
        query: &str,
        allowed_domains: Option<Vec<String>>,
    ) -> Result<(String, Vec<(String, String)>), xai_tool_runtime::ToolError> {
        let err = |msg: String| {
            xai_tool_runtime::ToolError::execution(
                xai_tool_protocol::ToolId::new("web_search").expect("valid"),
                msg,
            )
        };
        let (allowed, excluded) = self.resolve_filters(allowed_domains);
        let request = self.build_messages_request_json(query, allowed, excluded);
        let url = format!("{}/messages", self.base_url.trim_end_matches('/'));
        // The Messages wire is the model provider's own search surface, so the key resolved into
        // this config authenticates it. The session bearer provider mints first-party xAI tokens
        // for hosted routes and must not be attached to a third-party search endpoint, so it is
        // deliberately not consulted here.
        let key = self.api_key.as_str();
        let mut req = self
            .http
            .post(&url)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("x-api-key", key)
            .header(AUTHORIZATION, format!("Bearer {key}"))
            .json(&request);
        let response = req
            .send()
            .await
            .map_err(|e| err(format!("Messages API request to {url} failed: {e}")))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            return Err(xai_tool_runtime::ToolError::unauthorized(format!(
                "Messages API returned 401 Unauthorized: {body}"
            ))
            .with_details(serde_json::json!({
                "tool_id": "web_search",
                "status": 401,
            })));
        }
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Failed to read error body".to_string());
            return Err(err(format!("Messages API returned {status}: {body}")));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| err(format!("Failed to read response body: {e}")))?;
        let body: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|e| err(format!("Failed to parse Messages response: {e}")))?;
        let rows = parse_messages_search_sources(&body).ok_or_else(|| {
            err("Messages API response contained no web_search_tool_result block".to_string())
        })?;
        let content = format_messages_sources(&rows);
        let pairs = rows
            .into_iter()
            .map(|(title, url, _s)| (title, url))
            .collect();
        Ok((content, pairs))
    }
}

/// Parse `web_search_tool_result` blocks from an Anthropic Messages response into
/// `(title, url, snippet)` rows, deduplicated by URL. Returns `None` when the response carries
/// no such block, which the caller treats as an error. Snippets come from URL-keyed
/// `cited_text` entries on `text` blocks, mirroring the harness provider.
fn parse_messages_search_sources(
    body: &serde_json::Value,
) -> Option<Vec<(String, String, String)>> {
    let mut snippets: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let blocks = body.get("content")?.as_array()?;
    let mut found_block = false;
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) == Some("text")
            && let Some(citations) = block.get("citations").and_then(|c| c.as_array())
        {
            for citation in citations {
                let url = citation.get("url").and_then(|u| u.as_str());
                let text = citation.get("cited_text").and_then(|t| t.as_str());
                if let (Some(url), Some(text)) = (url, text)
                    && !snippets.contains_key(url)
                {
                    snippets.insert(url.to_string(), text.to_string());
                }
            }
        }
    }
    let mut rows: Vec<(String, String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) != Some("web_search_tool_result") {
            continue;
        }
        let Some(items) = block.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for item in items {
            if item.get("type").and_then(|t| t.as_str()) != Some("web_search_result") {
                continue;
            }
            let Some(url) = item.get("url").and_then(|u| u.as_str()) else {
                continue;
            };
            if !seen.insert(url.to_string()) {
                continue;
            }
            found_block = true;
            let title = item
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let snippet = snippets.get(url).cloned().unwrap_or_default();
            rows.push((title, url.to_string(), snippet));
        }
    }
    found_block.then_some(rows)
}

/// Render parsed sources as the tool result the model reads. Every URL is listed even when the
/// upstream result carried no title or snippet, so a citation never silently disappears.
fn format_messages_sources(rows: &[(String, String, String)]) -> String {
    if rows.is_empty() {
        return "No search results found.".to_string();
    }
    let mut out = String::from("Sources:\n");
    for (title, url, snippet) in rows {
        let label = if title.is_empty() { url } else { title };
        out.push_str(&format!("- [{label}]({url})"));
        if !snippet.is_empty() {
            out.push('\n');
            out.push_str(snippet);
        }
        out.push('\n');
    }
    out
}

/// Deserialize a Responses body, dropping any output item the SDK cannot deserialize. A provider
/// may emit its own item kinds (OpenRouter returns `openrouter:web_search`), and one unrecognized
/// item must not fail the whole search: the `message` items the caller reads are still there.
/// Everything outside `output` is parsed strictly.
fn parse_response(bytes: &[u8]) -> Result<rs::Response, serde_json::Error> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
    if let Some(output) = value
        .get_mut("output")
        .and_then(serde_json::Value::as_array_mut)
    {
        output.retain(|item| serde_json::from_value::<rs::OutputItem>(item.clone()).is_ok());
    }
    serde_json::from_value(value)
}

/// Extract citation URLs from the Response output items.
/// The async-openai crate doesn't provide a helper for this, and the `url` field
/// in `UrlCitationBody` is private, so we serialize to JSON to extract it.
fn extract_citations(response: &rs::Response) -> Vec<String> {
    let mut citations = Vec::new();
    for output_item in &response.output {
        if let rs::OutputItem::Message(output_message) = output_item {
            for message_content in &output_message.content {
                if let rs::OutputMessageContent::OutputText(text_content) = message_content {
                    for annotation in &text_content.annotations {
                        if let rs::Annotation::UrlCitation(url_citation) = annotation
                            && let Ok(json) = serde_json::to_value(url_citation)
                            && let Some(url) = json.get("url").and_then(|v| v.as_str())
                        {
                            citations.push(url.to_string());
                        }
                    }
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    citations.retain(|url| seen.insert(url.clone()));
    citations
}
/// Extract `(title, url)` pairs from the Responses API annotations. `title` may be an empty string
/// when upstream doesn't supply one. URLs are deduplicated while preserving the first-seen order so
/// the rendered `Links:` list is stable and free of duplicates.
fn extract_citation_pairs(response: &rs::Response) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for output_item in &response.output {
        if let rs::OutputItem::Message(output_message) = output_item {
            for message_content in &output_message.content {
                if let rs::OutputMessageContent::OutputText(text_content) = message_content {
                    for annotation in &text_content.annotations {
                        if let rs::Annotation::UrlCitation(url_citation) = annotation
                            && let Ok(json) = serde_json::to_value(url_citation)
                        {
                            let url = json.get("url").and_then(|v| v.as_str()).unwrap_or("");
                            if url.is_empty() {
                                continue;
                            }
                            let title = json
                                .get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            pairs.push((title, url.to_string()));
                        }
                    }
                }
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    pairs.retain(|(_t, url)| seen.insert(url.clone()));
    pairs
}
#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;
    /// Helper to create a Response from JSON for testing.
    fn response_from_json(json: serde_json::Value) -> rs::Response {
        serde_json::from_value(json).expect("Failed to parse test Response JSON")
    }
    /// Build a client with the given configured domain defaults.
    fn client_with_defaults(
        allowed: Option<Vec<String>>,
        excluded: Option<Vec<String>>,
    ) -> WebSearchClient {
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: false,
            api_key: "test-key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: allowed,
            excluded_domains: excluded,
        };
        WebSearchClient::new(&config, None).expect("client should build")
    }
    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn resolve_filters_config_allowlist_wins_over_model() {
        let client = client_with_defaults(Some(v(&["config.com"])), None);
        let (allowed, excluded) = client.resolve_filters(Some(v(&["model.com"])));
        assert_eq!(allowed, Some(v(&["config.com"])));
        assert!(excluded.is_none());
    }
    #[test]
    fn resolve_filters_uses_config_allowlist_when_model_silent() {
        let client = client_with_defaults(Some(v(&["config.com"])), None);
        let (allowed, excluded) = client.resolve_filters(None);
        assert_eq!(allowed, Some(v(&["config.com"])));
        assert!(excluded.is_none());
    }
    #[test]
    fn resolve_filters_config_blocklist_applies_when_no_allowlist() {
        let client = client_with_defaults(None, Some(v(&["reddit.com"])));
        let (allowed, excluded) = client.resolve_filters(None);
        assert!(allowed.is_none());
        assert_eq!(excluded, Some(v(&["reddit.com"])));
    }
    #[test]
    fn resolve_filters_config_blocklist_cannot_be_bypassed_by_model() {
        let client = client_with_defaults(None, Some(v(&["github.com"])));
        let (allowed, excluded) = client.resolve_filters(Some(v(&["github.com"])));
        assert!(
            allowed.is_none(),
            "model allowlist must not override the block"
        );
        assert_eq!(excluded, Some(v(&["github.com"])));
    }
    #[test]
    fn resolve_filters_no_config_honors_model_allowlist() {
        let client = client_with_defaults(None, None);
        let (allowed, excluded) = client.resolve_filters(Some(v(&["model.com"])));
        assert_eq!(allowed, Some(v(&["model.com"])));
        assert!(excluded.is_none());
    }
    #[test]
    fn build_request_json_injects_excluded_domains() {
        let client = client_with_defaults(None, None);
        let body = client
            .build_request_json("q", None, Some(v(&["reddit.com"])))
            .expect("request json builds");
        let Some(filters) = body.pointer("/tools/0/filters") else {
            panic!("missing tools[0].filters: {body}");
        };
        assert_eq!(
            filters.get("excluded_domains"),
            Some(&serde_json::json!(["reddit.com"]))
        );
        assert!(filters.get("allowed_domains").is_none());
    }
    #[test]
    fn build_request_json_allowlist_only_has_no_excluded_key() {
        let client = client_with_defaults(None, None);
        let body = client
            .build_request_json("q", Some(v(&["docs.x.ai"])), None)
            .expect("request json builds");
        let Some(filters) = body.pointer("/tools/0/filters") else {
            panic!("missing tools[0].filters: {body}");
        };
        assert_eq!(
            filters.get("allowed_domains"),
            Some(&serde_json::json!(["docs.x.ai"]))
        );
        assert!(filters.get("excluded_domains").is_none());
    }
    #[test]
    fn test_new_client_uses_configured_model() {
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: false,
            api_key: "test-key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "custom-enterprise-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let client = WebSearchClient::new(&config, None).expect("client should build");
        assert_eq!(client.model, "custom-enterprise-model");
    }
    /// Counts attribution callback invocations for the test below.
    #[derive(Default, Debug)]
    struct CountingCallback {
        invocations: std::sync::Mutex<Vec<(ToolConsumer, Option<String>)>>,
    }
    impl crate::attribution::Auth401AttributionCallback for CountingCallback {
        fn record_401(&self, consumer: ToolConsumer, sent_bearer_suffix: Option<&str>) {
            self.invocations
                .lock()
                .unwrap()
                .push((consumer, sent_bearer_suffix.map(|s| s.to_string())));
        }
    }
    /// `record_401_attribution` invokes the wired callback with
    /// `ToolConsumer::WebSearch` and the truncated bearer prefix.
    /// The full bearer never crosses the trait boundary.
    #[test]
    fn record_401_attribution_passes_truncated_prefix_to_callback() {
        let cb = std::sync::Arc::new(CountingCallback::default());
        let cb_dyn: crate::attribution::SharedAttributionCallback = cb.clone();
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: false,
            api_key: "ignored".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let client = WebSearchClient::new(&config, None)
            .expect("client should build")
            .with_attribution_callback(Some(cb_dyn));
        client.record_401_attribution(Some("bearer-with-long-tail-aaaadistinct"));
        let calls = cb.invocations.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let Some(call) = calls.first() else {
            panic!("expected one attribution call");
        };
        assert_eq!(call.0, ToolConsumer::WebSearch);
        assert_eq!(call.1.as_deref(), Some("aaaadistinct"));
        assert_eq!(
            call.1.as_deref().map(str::len),
            Some(crate::attribution::BEARER_SUFFIX_LEN),
        );
    }
    /// `record_401_attribution` is a no-op when no callback is wired
    /// -- the BYOK / standalone case must not panic or allocate.
    #[test]
    fn record_401_attribution_is_noop_without_callback() {
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: false,
            api_key: "test-key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let client = WebSearchClient::new(&config, None).expect("client should build");
        client.record_401_attribution(Some("any-bearer"));
        client.record_401_attribution(None);
    }
    #[test]
    fn test_extract_citations_empty_response() {
        let response = response_from_json(serde_json::json!({
            "id": "resp_test",
            "object": "response",
            "created_at": 1234567890,
            "status": "completed",
            "output": [],
            "model": "test-model"
        }));
        let citations = extract_citations(&response);
        assert!(citations.is_empty());
    }
    #[test]
    fn test_extract_citations_with_url_citations() {
        let response = response_from_json(serde_json::json!({
            "id": "resp_test",
            "object": "response",
            "created_at": 1234567890,
            "status": "completed",
            "model": "test-model",
            "output": [
                {
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Here is some info about Rust.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://www.rust-lang.org/",
                                    "title": "Rust Programming Language",
                                    "start_index": 0,
                                    "end_index": 10
                                },
                                {
                                    "type": "url_citation",
                                    "url": "https://docs.rs/",
                                    "title": "Docs.rs",
                                    "start_index": 11,
                                    "end_index": 20
                                }
                            ]
                        }
                    ]
                }
            ]
        }));
        let citations = extract_citations(&response);
        assert_eq!(citations.len(), 2);
        let [first, second] = citations.as_slice() else {
            panic!("expected 2 citations: {citations:?}");
        };
        assert_eq!(first, "https://www.rust-lang.org/");
        assert_eq!(second, "https://docs.rs/");
    }
    /// OpenRouter returns its own `openrouter:web_search` item next to the `message`; the SDK does
    /// not model that type, and one unrecognized item must not fail the search.
    #[test]
    fn parse_response_drops_output_items_the_sdk_does_not_model() {
        let body = serde_json::to_vec(&serde_json::json!({
            "id": "resp_test",
            "object": "response",
            "created_at": 1234567890,
            "status": "completed",
            "model": "test-model",
            "output": [
                {
                    "type": "openrouter:web_search",
                    "id": "st_1",
                    "status": "completed",
                    "action": { "type": "search", "query": "rust" }
                },
                {
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Rust 1.99.0 is the latest stable release.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://blog.rust-lang.org/releases/latest/",
                                    "title": "Announcing Rust 1.99.0",
                                    "start_index": 0,
                                    "end_index": 37
                                }
                            ]
                        }
                    ]
                }
            ]
        }))
        .expect("fixture serializes");
        let response = parse_response(&body).expect("unknown output items are dropped, not fatal");
        assert_eq!(
            response.output_text().as_deref(),
            Some("Rust 1.99.0 is the latest stable release.")
        );
        assert_eq!(
            extract_citation_pairs(&response),
            vec![(
                "Announcing Rust 1.99.0".to_string(),
                "https://blog.rust-lang.org/releases/latest/".to_string()
            )]
        );
    }

    #[test]
    fn test_extract_citations_deduplicates() {
        let response = response_from_json(serde_json::json!({
            "id": "resp_test",
            "object": "response",
            "created_at": 1234567890,
            "status": "completed",
            "model": "test-model",
            "output": [
                {
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Info with duplicate citations.",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://example.com/page1",
                                    "title": "Page 1",
                                    "start_index": 0,
                                    "end_index": 5
                                },
                                {
                                    "type": "url_citation",
                                    "url": "https://example.com/page2",
                                    "title": "Page 2",
                                    "start_index": 6,
                                    "end_index": 10
                                },
                                {
                                    "type": "url_citation",
                                    "url": "https://example.com/page1",
                                    "title": "Page 1 Again",
                                    "start_index": 11,
                                    "end_index": 15
                                }
                            ]
                        }
                    ]
                }
            ]
        }));
        let citations = extract_citations(&response);
        assert_eq!(citations.len(), 2);
        let [first, second] = citations.as_slice() else {
            panic!("expected 2 citations: {citations:?}");
        };
        assert_eq!(first, "https://example.com/page1");
        assert_eq!(second, "https://example.com/page2");
    }
    #[test]
    fn test_extract_citations_multiple_messages() {
        let response = response_from_json(serde_json::json!({
            "id": "resp_test",
            "object": "response",
            "created_at": 1234567890,
            "status": "completed",
            "model": "test-model",
            "output": [
                {
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "First message",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://first.com/",
                                    "title": "First",
                                    "start_index": 0,
                                    "end_index": 5
                                }
                            ]
                        }
                    ]
                },
                {
                    "type": "message",
                    "id": "msg_2",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Second message",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://second.com/",
                                    "title": "Second",
                                    "start_index": 0,
                                    "end_index": 6
                                }
                            ]
                        }
                    ]
                }
            ]
        }));
        let citations = extract_citations(&response);
        assert_eq!(citations.len(), 2);
        let [first, second] = citations.as_slice() else {
            panic!("expected 2 citations: {citations:?}");
        };
        assert_eq!(first, "https://first.com/");
        assert_eq!(second, "https://second.com/");
    }
    #[test]
    fn test_extract_citations_ignores_non_url_annotations() {
        let response = response_from_json(serde_json::json!({
            "id": "resp_test",
            "object": "response",
            "created_at": 1234567890,
            "status": "completed",
            "model": "test-model",
            "output": [
                {
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Some text",
                            "annotations": [
                                {
                                    "type": "url_citation",
                                    "url": "https://valid.com/",
                                    "title": "Valid",
                                    "start_index": 0,
                                    "end_index": 4
                                }
                            ]
                        }
                    ]
                }
            ]
        }));
        let citations = extract_citations(&response);
        assert_eq!(citations.len(), 1);
        assert_eq!(
            citations.first().map(String::as_str),
            Some("https://valid.com/")
        );
    }
    /// A provider that always returns `None`, simulating an API-key user
    /// whose token has aged past the client-side TTL.
    struct NoneProvider;
    impl crate::types::ApiKeyProvider for NoneProvider {
        fn current_api_key(&self) -> Option<String> {
            None
        }
    }
    /// When the dynamic provider returns `None`, the static `api_key` from config must still be
    /// sent as the Authorization header. This is a regression scenario: API-key users past the
    /// 30-day client TTL saw 401 because no auth was sent.
    #[tokio::test]
    async fn static_api_key_is_fallback_when_provider_returns_none() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .and(header("Authorization", "Bearer static-key-from-config"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "resp_test",
                "object": "response",
                "created_at": 1234567890,
                "status": "completed",
                "model": "test-model",
                "output": [{
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "search result",
                        "annotations": []
                    }]
                }]
            })))
            .mount(&server)
            .await;
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: true,
            api_key: "static-key-from-config".to_string(),
            base_url: server.uri(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let provider: SharedApiKeyProvider = std::sync::Arc::new(NoneProvider);
        let client = WebSearchClient::new(&config, Some(provider)).expect("client should build");
        let (content, _citations) = client
            .search("test query", None)
            .await
            .expect("search must succeed with static key fallback");
        assert_eq!(content, "search result");
    }
    /// When the provider returns a fresh key, it overrides the static one.
    #[tokio::test]
    async fn provider_key_overrides_static_key() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        struct FreshProvider;
        impl crate::types::ApiKeyProvider for FreshProvider {
            fn current_api_key(&self) -> Option<String> {
                Some("fresh-key-from-provider".to_string())
            }
        }
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .and(header("Authorization", "Bearer fresh-key-from-provider"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "resp_test",
                "object": "response",
                "created_at": 1234567890,
                "status": "completed",
                "model": "test-model",
                "output": [{
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "fresh result",
                        "annotations": []
                    }]
                }]
            })))
            .mount(&server)
            .await;
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: true,
            api_key: "stale-static-key".to_string(),
            base_url: server.uri(),
            model: "test-model".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let provider: SharedApiKeyProvider = std::sync::Arc::new(FreshProvider);
        let client = WebSearchClient::new(&config, Some(provider)).expect("client should build");
        let (content, _citations) = client
            .search("test query", None)
            .await
            .expect("search must succeed with provider key");
        assert_eq!(content, "fresh result");
    }
    #[test]
    fn test_extract_citations_no_annotations() {
        let response = response_from_json(serde_json::json!({
            "id": "resp_test",
            "object": "response",
            "created_at": 1234567890,
            "status": "completed",
            "model": "test-model",
            "output": [
                {
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "Plain text with no annotations",
                            "annotations": []
                        }
                    ]
                }
            ]
        }));
        let citations = extract_citations(&response);
        assert!(citations.is_empty());
    }
    fn messages_client() -> WebSearchClient {
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Messages,
            use_session_bearer: false,
            api_key: "test-key".to_string(),
            base_url: "https://api.deepseek.com/anthropic/v1".to_string(),
            model: "deepseek-flash".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        WebSearchClient::new(&config, None).expect("client should build")
    }

    #[test]
    fn build_messages_request_json_carries_server_tool() {
        let client = messages_client();
        let body = client.build_messages_request_json("matplotlib lognorm", None, None);
        assert_eq!(body["model"], "deepseek-flash");
        assert_eq!(body["tools"][0]["type"], "web_search_20250305");
        assert_eq!(body["tools"][0]["name"], "web_search");
        assert_eq!(body["tools"][0]["max_uses"], MESSAGES_MAX_USES);
        assert_eq!(
            body["messages"][0]["content"][0]["text"],
            "matplotlib lognorm"
        );
    }

    #[test]
    fn build_messages_request_json_maps_allowlist_to_allowed_domains() {
        let client = messages_client();
        let body = client.build_messages_request_json("q", Some(v(&["docs.x.ai"])), None);
        assert_eq!(
            body["tools"][0]["allowed_domains"],
            serde_json::json!(["docs.x.ai"])
        );
        assert!(body["tools"][0].get("blocked_domains").is_none());
    }

    #[test]
    fn build_messages_request_json_maps_excluded_to_blocked_domains() {
        let client = messages_client();
        let body = client.build_messages_request_json("q", None, Some(v(&["reddit.com"])));
        assert_eq!(
            body["tools"][0]["blocked_domains"],
            serde_json::json!(["reddit.com"])
        );
        assert!(body["tools"][0].get("allowed_domains").is_none());
    }

    #[test]
    fn parse_messages_search_sources_reads_result_blocks_with_cited_snippets() {
        let body = serde_json::json!({
            "content": [
                { "type": "server_tool_use", "id": "srv_1", "name": "web_search" },
                { "type": "web_search_tool_result", "tool_use_id": "srv_1", "content": [
                    { "type": "web_search_result", "url": "https://example.com/a", "title": "A", "page_age": "2024-01-02" },
                    { "type": "web_search_result", "url": "https://example.com/b", "title": "B" }
                ]},
                { "type": "text", "text": "prose the tool must not copy", "citations": [
                    { "type": "web_search_result_location", "url": "https://example.com/a", "cited_text": "unique detail" }
                ]}
            ]
        });
        let rows = parse_messages_search_sources(&body).expect("block present");
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            (
                "A".to_string(),
                "https://example.com/a".to_string(),
                "unique detail".to_string()
            )
        );
        assert_eq!(
            rows[1],
            (
                "B".to_string(),
                "https://example.com/b".to_string(),
                String::new()
            )
        );
        let content = format_messages_sources(&rows);
        assert!(content.starts_with("Sources:\n"));
        assert!(content.contains("[A](https://example.com/a)"));
        assert!(!content.contains("prose the tool must not copy"));
    }

    #[test]
    fn parse_messages_search_sources_is_none_without_result_block() {
        let body = serde_json::json!({
            "content": [{ "type": "text", "text": "just prose, no search ran" }]
        });
        assert!(parse_messages_search_sources(&body).is_none());
    }

    #[test]
    fn parse_messages_search_sources_dedupes_urls() {
        let body = serde_json::json!({
            "content": [
                { "type": "web_search_tool_result", "content": [
                    { "type": "web_search_result", "url": "https://example.com/a", "title": "A" }
                ]},
                { "type": "web_search_tool_result", "content": [
                    { "type": "web_search_result", "url": "https://example.com/a", "title": "A again" }
                ]}
            ]
        });
        let rows = parse_messages_search_sources(&body).expect("block present");
        assert_eq!(rows.len(), 1);
    }

    /// The result block is the only source the tool reads on the Messages wire: the request
    /// carries the server tool, the response yields sources, and provider prose is never copied.
    #[tokio::test]
    async fn messages_wire_posts_the_server_tool_and_reads_its_result_block() {
        use wiremock::matchers::{body_partial_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .and(header("anthropic-version", ANTHROPIC_VERSION))
            .and(header("x-api-key", "test-key"))
            .and(body_partial_json(serde_json::json!({
                "tools": [{
                    "type": "web_search_20250305",
                    "name": "web_search",
                    "max_uses": MESSAGES_MAX_USES,
                }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [
                    { "type": "web_search_tool_result", "tool_use_id": "srv_1", "content": [
                        {
                            "type": "web_search_result",
                            "url": "https://docs.example/a",
                            "title": "Doc A",
                            "page_age": "2026-01-01",
                        }
                    ]},
                    {
                        "type": "text",
                        "text": "provider prose the tool must not copy",
                        "citations": [{
                            "type": "web_search_result_location",
                            "url": "https://docs.example/a",
                            "cited_text": "the cited snippet",
                        }],
                    }
                ]
            })))
            .mount(&server)
            .await;

        let mut client = messages_client();
        client.base_url = server.uri();
        let (content, citations) = client
            .search("rust async", None)
            .await
            .expect("a result block must yield sources");
        assert!(
            content.contains("[Doc A](https://docs.example/a)"),
            "{content}"
        );
        assert!(content.contains("the cited snippet"), "{content}");
        assert!(
            !content.contains("provider prose"),
            "prose must not be copied into the tool result: {content}"
        );
        assert_eq!(citations, vec!["https://docs.example/a".to_string()]);
    }

    /// The Messages wire targets the model provider's own search endpoint, so it authenticates
    /// with the key resolved into the config. A session bearer provider (first-party xAI) must
    /// never override it: that would both break the provider's auth and hand the session token
    /// to a third party.
    #[tokio::test]
    async fn messages_wire_ignores_the_session_bearer_provider() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        struct SessionProvider;
        impl crate::types::ApiKeyProvider for SessionProvider {
            fn current_api_key(&self) -> Option<String> {
                Some("session-bearer-jwt".to_string())
            }
        }
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .and(header("x-api-key", "provider-key-from-config"))
            .and(header("Authorization", "Bearer provider-key-from-config"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{ "type": "web_search_tool_result", "tool_use_id": "srv_1", "content": [
                    {
                        "type": "web_search_result",
                        "url": "https://docs.example/a",
                        "title": "Doc A",
                    }
                ]}]
            })))
            .mount(&server)
            .await;

        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Messages,
            use_session_bearer: false,
            api_key: "provider-key-from-config".to_string(),
            base_url: server.uri(),
            model: "deepseek-flash".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let provider: SharedApiKeyProvider = std::sync::Arc::new(SessionProvider);
        let client = WebSearchClient::new(&config, Some(provider)).expect("client should build");
        let (content, _citations) = client
            .search("rust async", None)
            .await
            .expect("the config key must authenticate the messages call");
        assert!(content.contains("https://docs.example/a"), "{content}");
    }

    /// A third-party Responses endpoint must be authenticated with its own key. The session bearer
    /// provider mints first-party xAI tokens, so `use_session_bearer = false` keeps it out of the
    /// request instead of leaking the session JWT to the provider.
    #[tokio::test]
    async fn responses_wire_ignores_the_session_bearer_provider_when_not_first_party() {
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        struct SessionProvider;
        impl crate::types::ApiKeyProvider for SessionProvider {
            fn current_api_key(&self) -> Option<String> {
                Some("session-bearer-jwt".to_string())
            }
        }
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .and(header("Authorization", "Bearer provider-key-from-config"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "resp_test",
                "object": "response",
                "created_at": 1234567890,
                "status": "completed",
                "model": "test-model",
                "output": [{
                    "type": "message",
                    "id": "msg_1",
                    "status": "completed",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "Rust 1.99.0",
                        "annotations": []
                    }]
                }]
            })))
            .mount(&server)
            .await;

        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: false,
            api_key: "provider-key-from-config".to_string(),
            base_url: server.uri(),
            model: "google/gemini-2.5-flash-lite".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let provider: SharedApiKeyProvider = std::sync::Arc::new(SessionProvider);
        let client = WebSearchClient::new(&config, Some(provider)).expect("client should build");
        let (content, _citations) = client
            .search("rust stable", None)
            .await
            .expect("the config key must authenticate the responses call");
        assert_eq!(content, "Rust 1.99.0");
    }

    /// A body with no result block is a failed tool call, so the model can tell that no search
    /// ran instead of reading prose as if it were a result.
    #[tokio::test]
    async fn messages_wire_without_a_result_block_fails_the_tool() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [{ "type": "text", "text": "I could not search the web" }]
            })))
            .mount(&server)
            .await;

        let mut client = messages_client();
        client.base_url = server.uri();
        let error = client
            .search("rust async", None)
            .await
            .expect_err("a body without a result block must fail");
        assert!(
            error.to_string().contains("no web_search_tool_result"),
            "unexpected error: {error}"
        );
    }
}
