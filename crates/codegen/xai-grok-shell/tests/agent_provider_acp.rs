//! End-to-end `x.ai/providers/*` over ACP on a temp `GROK_HOME`.
//!
//! Drives the real agent (in-process, duplex pipes) and the real config writer, then reads
//! `config.toml` back to prove what landed on disk. The provider's own endpoint is a second
//! mock HTTP server, so "the probe hit the provider, not xAI" is an observed fact.

mod acp_harness;

use std::sync::Arc;

use acp_harness::{AutoApproveClient, RPC_TIMEOUT, connect_and_auth};
use agent_client_protocol::{self as acp, Agent as _};
use serde_json::{Value, json};
use xai_grok_test_support::{MockInferenceServer, MockModelEntry};

/// Pre-existing user config: a comment and an unrelated table must survive every mutation.
const PRE_SEEDED: &str = r#"# hand-written note: keep me
[ui]
theme = "dark"

[mcp_servers.example]
command = "/bin/true"
"#;

const DEEPSEEK_KEY: &str = "sk-live-deepseek-0123456789abcd";

async fn ext(
    conn: &acp::ClientSideConnection,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let raw = serde_json::value::RawValue::from_string(params.to_string())
        .expect("serialize ext params");
    match tokio::time::timeout(
        RPC_TIMEOUT,
        conn.ext_method(acp::ExtRequest::new(method, Arc::from(raw))),
    )
    .await
    {
        Err(_) => panic!("{method} timed out"),
        Ok(Err(e)) => Err(format!("{e:?}")),
        Ok(Ok(resp)) => match serde_json::from_str::<Value>(resp.0.get()) {
            Ok(value) => Ok(value),
            Err(e) => panic!("{method}: bad response: {e}"),
        },
    }
}

async fn ok(conn: &acp::ClientSideConnection, method: &str, params: Value) -> Value {
    match ext(conn, method, params).await {
        Ok(value) => value,
        Err(e) => panic!("{method} failed: {e}"),
    }
}

/// Unwrap the agent's `ExtMethodResult` envelope, the way a client does.
fn envelope(value: Value) -> Value {
    match value.get("result") {
        Some(inner) if value.get("error").is_none() => inner.clone(),
        _ => value,
    }
}

fn provider<'a>(listed: &'a Value, id: &str) -> &'a Value {
    listed["providers"]
        .as_array()
        .unwrap_or_else(|| panic!("providers array missing: {listed}"))
        .iter()
        .find(|p| p["id"] == json!(id))
        .unwrap_or_else(|| panic!("provider {id} missing from {listed}"))
}

fn model_ids(provider: &Value) -> Vec<String> {
    provider["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m["id"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn provider_acp_round_trip() {
    acp_harness::run_agent_test_with_models(
        vec![MockModelEntry::new("test-model")],
        |_cwd, _server| async move {
            let grok_home =
                std::path::PathBuf::from(std::env::var("GROK_HOME").expect("harness sets GROK_HOME"));
            let config_path = grok_home.join("config.toml");
            std::fs::write(&config_path, PRE_SEEDED).expect("seed config.toml");

            // The third-party endpoint, separate from the agent's own catalog source.
            let endpoint = MockInferenceServer::start_with_models(vec![MockModelEntry::new(
                "provider-only-model",
            )])
            .await
            .expect("provider mock server");
            let base_url = endpoint.url();

            let (conn, _init) = connect_and_auth(AutoApproveClient, "provider-acp-test").await;

            // ── preset catalog ──────────────────────────────────────
            let presets = ok(&conn, "x.ai/providers/presets", json!({})).await;
            let preset_ids: Vec<&str> = presets["presets"]
                .as_array()
                .expect("presets array")
                .iter()
                .filter_map(|p| p["id"].as_str())
                .collect();
            for expected in ["openai", "anthropic", "deepseek", "ollama", "custom"] {
                assert!(preset_ids.contains(&expected), "missing preset {expected}");
            }
            let anthropic = presets["presets"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["id"] == json!("anthropic"))
                .unwrap();
            assert_eq!(anthropic["apiBackend"], json!("messages"));
            assert_eq!(
                anthropic["extraHeaders"]["anthropic-version"],
                json!("2023-06-01")
            );
            assert!(
                !presets.to_string().contains("apiKey"),
                "presets must carry no secrets"
            );

            // ── upsert with an inline key ───────────────────────────
            let upserted = ok(
                &conn,
                "x.ai/providers/upsert",
                json!({
                    "id": "deepseek",
                    "baseUrl": base_url,
                    "apiBackend": "chat_completions",
                    "apiKey": DEEPSEEK_KEY,
                    "models": [{
                        "id": "deepseek-chat",
                        "model": "deepseek-chat",
                        "name": "DeepSeek Chat",
                        "input": ["text"],
                        "contextWindow": 128000,
                    }],
                }),
            )
            .await;
            assert_eq!(upserted["ok"], json!(true), "{upserted}");
            assert!(
                upserted["models"]
                    .as_array()
                    .expect("models array")
                    .iter()
                    .any(|m| m.as_str() == Some("deepseek-chat")),
                "upsert reports the seeded catalog ids: {upserted}"
            );

            let listed = ok(&conn, "x.ai/providers/list", json!({})).await;
            let listed_text = listed.to_string();
            assert!(
                !listed_text.contains(DEEPSEEK_KEY),
                "the key must never be echoed: {listed}"
            );
            let deepseek = provider(&listed, "deepseek");
            assert_eq!(deepseek["hasKey"], json!(true));
            assert_eq!(deepseek["inlineKey"], json!(true));
            assert_eq!(deepseek["baseUrl"], json!(base_url));
            assert_eq!(deepseek["apiBackend"], json!("chat_completions"));
            assert_eq!(
                deepseek["keyHint"],
                json!("sk…abcd"),
                "only a last-4 style hint is ever sent"
            );
            assert!(
                model_ids(deepseek).contains(&"deepseek-chat".to_owned()),
                "the seeded model is linked to its provider: {deepseek}"
            );
            let on_disk = std::fs::read_to_string(&config_path).unwrap();
            assert!(on_disk.contains(&format!("api_key = \"{DEEPSEEK_KEY}\"")), "{on_disk}");
            assert!(on_disk.contains("[model_providers.deepseek]"), "{on_disk}");

            // ── upsert with env_key writes no secret ────────────────
            ok(
                &conn,
                "x.ai/providers/upsert",
                json!({
                    "id": "openrouter",
                    "baseUrl": base_url,
                    "apiBackend": "chat_completions",
                    "envKey": "PROVIDER_ACP_TEST_OPENROUTER_KEY",
                    "models": [{"id": "openrouter/model", "model": "vendor/model"}],
                }),
            )
            .await;
            let listed = ok(&conn, "x.ai/providers/list", json!({})).await;
            let openrouter = provider(&listed, "openrouter");
            assert_eq!(openrouter["envKey"], json!("PROVIDER_ACP_TEST_OPENROUTER_KEY"));
            assert_eq!(openrouter["inlineKey"], json!(false));
            assert_eq!(openrouter["hasKey"], json!(true));
            assert_eq!(
                openrouter["envKeyPresent"],
                json!(false),
                "an unset env var is reported as such"
            );
            assert_eq!(openrouter["keyHint"], json!(null));
            let on_disk = std::fs::read_to_string(&config_path).unwrap();
            assert!(on_disk.contains("env_key = \"PROVIDER_ACP_TEST_OPENROUTER_KEY\""));
            assert!(on_disk.contains("[model.\"openrouter/model\"]"), "{on_disk}");

            // ── credential probe against the provider's own URL ─────
            let tested = ok(&conn, "x.ai/providers/test", json!({"id": "deepseek"})).await;
            assert_eq!(tested["ok"], json!(true), "probe failed: {tested}");
            assert_eq!(tested["status"], json!(200));
            assert!(
                tested["url"].as_str().unwrap_or_default().starts_with(&base_url),
                "the probe must hit the provider's base URL: {tested}"
            );
            let probe = endpoint
                .requests()
                .into_iter()
                .find(|entry| entry.path.contains("chat/completions"))
                .expect("provider endpoint saw no completion request");
            assert_eq!(
                probe.authorization.as_deref(),
                Some(format!("Bearer {DEEPSEEK_KEY}").as_str()),
                "the saved credential is sent to the provider"
            );
            assert_eq!(
                probe.body.as_ref().and_then(|b| b["model"].as_str()),
                Some("deepseek-chat")
            );

            // A wrong path yields the HTTP status and a bounded message, not a panic.
            let failed = ok(
                &conn,
                "x.ai/providers/test",
                json!({"id": "deepseek", "baseUrl": format!("{}/missing", endpoint.origin())}),
            )
            .await;
            assert_eq!(failed["ok"], json!(false));
            assert_eq!(failed["status"], json!(404));
            assert!(
                failed["error"].as_str().is_some_and(|e| !e.is_empty()),
                "an HTTP failure reports a reason: {failed}"
            );
            assert!(!failed.to_string().contains(DEEPSEEK_KEY));

            // ── discover merges unknown ids into the catalog ────────
            let discovered =
                ok(&conn, "x.ai/providers/discover_models", json!({"id": "deepseek"})).await;
            assert_eq!(discovered["ok"], json!(true), "{discovered}");
            assert!(
                endpoint.request_count_for("/v1/models") >= 1,
                "discovery reads the provider's /models"
            );
            let added: Vec<&str> = discovered["added"]
                .as_array()
                .expect("added array")
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            assert!(
                added.contains(&"provider-only-model"),
                "discovered ids merge into the catalog: {discovered}"
            );
            let on_disk = std::fs::read_to_string(&config_path).unwrap();
            assert!(
                on_disk.contains("[model.provider-only-model]"),
                "the discovered model row is written: {on_disk}"
            );
            let listed = ok(&conn, "x.ai/providers/list", json!({})).await;
            assert!(model_ids(provider(&listed, "deepseek")).contains(&"provider-only-model".to_owned()));

            // ── persist the default model through the agent ─────────
            // `x.ai/models/list` keeps the `ExtMethodResult` envelope; the client unwraps it.
            let models = envelope(ok(&conn, "x.ai/models/list", json!({})).await);
            assert!(
                models["availableModels"]
                    .as_array()
                    .expect("availableModels")
                    .iter()
                    .any(|m| m["modelId"] == json!("deepseek-chat")),
                "the seeded BYOK model is selectable: {models}"
            );
            let defaulted =
                ok(&conn, "x.ai/models/set_default", json!({"modelId": "deepseek-chat"})).await;
            assert_eq!(defaulted["ok"], json!(true), "{defaulted}");
            let on_disk = std::fs::read_to_string(&config_path).unwrap();
            assert!(on_disk.contains("default = \"deepseek-chat\""), "{on_disk}");
            let models = envelope(ok(&conn, "x.ai/models/list", json!({})).await);
            assert_eq!(
                models["currentModelId"],
                json!("deepseek-chat"),
                "a fresh models/list reports the persisted default: {models}"
            );
            assert_eq!(
                ok(&conn, "x.ai/providers/list", json!({})).await["defaultModel"],
                json!("deepseek-chat")
            );

            // ── delete refuses a dangling default, then honours one ─
            let refusal = ext(&conn, "x.ai/providers/delete", json!({"id": "deepseek"})).await;
            let detail = refusal.expect_err("deleting the default provider must fail closed");
            assert!(
                detail.contains("would dangle"),
                "the refusal names the dangling default: {detail}"
            );

            let deleted = ok(
                &conn,
                "x.ai/providers/delete",
                json!({"id": "deepseek", "replacement": "test-model"}),
            )
            .await;
            assert_eq!(deleted["ok"], json!(true), "{deleted}");
            let removed: Vec<&str> = deleted["removedModels"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|v| v.as_str())
                .collect();
            assert!(removed.contains(&"deepseek-chat"));
            assert!(removed.contains(&"provider-only-model"));

            let on_disk = std::fs::read_to_string(&config_path).unwrap();
            assert!(!on_disk.contains("[model_providers.deepseek]"), "{on_disk}");
            assert!(!on_disk.contains("deepseek-chat"), "{on_disk}");
            assert!(!on_disk.contains("provider-only-model"), "{on_disk}");
            assert!(on_disk.contains("default = \"test-model\""), "{on_disk}");
            let listed = ok(&conn, "x.ai/providers/list", json!({})).await;
            assert!(
                !listed["providers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|p| p["id"] == json!("deepseek")),
                "the provider is gone: {listed}"
            );

            // ── legacy setApiKey routes a provider key to the provider ──
            ok(
                &conn,
                "x.ai/setApiKey",
                json!({"apiKey": "sk-openrouter-abcdef123456", "provider": "openrouter"}),
            )
            .await;
            let on_disk = std::fs::read_to_string(&config_path).unwrap();
            assert!(
                on_disk.contains("api_key = \"sk-openrouter-abcdef123456\""),
                "a provider-scoped key lands in the provider table: {on_disk}"
            );
            assert!(
                !on_disk.contains("env_key = \"PROVIDER_ACP_TEST_OPENROUTER_KEY\""),
                "the replaced env_key is cleared: {on_disk}"
            );
            let listed = ok(&conn, "x.ai/providers/list", json!({})).await;
            let openrouter = provider(&listed, "openrouter");
            assert_eq!(openrouter["inlineKey"], json!(true));
            assert_eq!(openrouter["envKey"], json!(null));
            assert!(!listed.to_string().contains("sk-openrouter-abcdef123456"));

            // ── pre-existing user content survived every write ──────
            let on_disk = std::fs::read_to_string(&config_path).unwrap();
            assert!(on_disk.contains("# hand-written note: keep me"), "{on_disk}");
            assert!(on_disk.contains("theme = \"dark\""), "{on_disk}");
            assert!(on_disk.contains("[mcp_servers.example]"), "{on_disk}");
            assert!(on_disk.contains("command = \"/bin/true\""), "{on_disk}");
            let reparsed: toml::Value = toml::from_str(&on_disk).expect("config.toml stays valid TOML");
            assert_eq!(reparsed["ui"]["theme"].as_str(), Some("dark"));
        },
    );
}
