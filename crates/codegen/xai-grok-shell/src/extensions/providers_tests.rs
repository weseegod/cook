//! Unit coverage for the pure halves of `x.ai/providers/*`: validation, secret redaction,
//! `/models` parsing, and the TOML surgery (which must preserve comments and unknown keys).

use super::*;

fn upsert(id: &str, base_url: &str) -> UpsertRequest {
    UpsertRequest {
        id: id.to_owned(),
        base_url: Some(base_url.to_owned()),
        api_backend: Some("chat_completions".to_owned()),
        api_key: None,
        env_key: None,
        extra_headers: IndexMap::new(),
        models: Vec::new(),
        set_as_default: false,
    }
}

#[test]
fn validation_requires_a_base_url_and_one_credential_shape() {
    let mut req = upsert("deepseek", " ");
    assert!(req.validate().unwrap_err().contains("baseUrl is required"));

    req.base_url = Some("api.deepseek.com".to_owned());
    assert!(
        req.validate()
            .unwrap_err()
            .contains("must start with http")
    );

    req.base_url = Some("https://api.deepseek.com".to_owned());
    req.api_key = Some("sk-a".to_owned());
    req.env_key = Some("DEEPSEEK_API_KEY".to_owned());
    assert!(req.validate().unwrap_err().contains("not both"));

    req.api_key = None;
    req.env_key = Some("deepseek key".to_owned());
    assert!(req.validate().unwrap_err().contains("variable name"));

    req.env_key = Some("DEEPSEEK_API_KEY".to_owned());
    req.api_backend = Some("grpc".to_owned());
    assert!(req.validate().unwrap_err().contains("apiBackend"));
}

#[test]
fn validation_rejects_unknown_input_modalities() {
    let mut req = upsert("deepseek", "https://api.deepseek.com");
    req.api_key = Some("sk-a".to_owned());
    req.models = vec![SeedModelRequest {
        id: None,
        model: "deepseek-chat".to_owned(),
        name: None,
        input: Some(vec!["video".to_owned()]),
        context_window: None,
        max_completion_tokens: None,
    }];
    assert!(req.validate().unwrap_err().contains("video"));
}

#[test]
fn key_hint_never_reveals_a_short_key() {
    assert_eq!(key_hint("sk-live-1234567890"), Some("sk…7890".to_owned()));
    assert_eq!(key_hint("short"), None);
    assert_eq!(key_hint("sk-12345678"), None);
    let hint = key_hint("sk-live-1234567890").expect("hint");
    assert!(!hint.contains("123456789"));
}

#[test]
fn redaction_strips_the_credential_from_provider_errors() {
    let text = "401 unauthorized for key sk-secret-value";
    assert_eq!(
        redact(text, Some("sk-secret-value")),
        "401 unauthorized for key ***"
    );
    assert_eq!(redact(text, None), text);
}

#[test]
fn truncate_caps_long_error_bodies_on_a_char_boundary() {
    let long = "é".repeat(ERROR_BODY_LIMIT + 50);
    let cut = truncate(&long);
    assert_eq!(cut.chars().count(), ERROR_BODY_LIMIT + 1);
}

#[test]
fn parsed_models_reads_openai_and_ollama_shapes() {
    let openai: serde_json::Value =
        serde_json::json!({"data": [{"id": "gpt-5"}, {"id": "gpt-4.1", "name": "GPT-4.1"}]});
    let models = parse_discovered_models(&openai);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].id, "gpt-5");
    assert_eq!(models[1].name.as_deref(), Some("GPT-4.1"));

    let ollama: serde_json::Value = serde_json::json!({"models": [{"name": "llama3", "model": "llama3"}]});
    let models = parse_discovered_models(&ollama);
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "llama3");
    assert_eq!(models[0].name, None, "a duplicated name is not echoed");

    let deduped: serde_json::Value = serde_json::json!({"data": [{"id": "a"}, {"id": "a"}]});
    assert_eq!(parse_discovered_models(&deduped).len(), 1);
}

#[test]
fn parsed_models_reads_codex_slugs_and_skips_hidden_models() {
    let codex: serde_json::Value = serde_json::json!({
        "models": [
            {"slug": "gpt-5.6-luna", "display_name": "GPT-5.6-Luna", "visibility": "list"},
            {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide"}
        ]
    });
    let models = parse_discovered_models(&codex);
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id, "gpt-5.6-luna");
    assert_eq!(models[0].name.as_deref(), Some("GPT-5.6-Luna"));

    let url = models_list_url("https://chatgpt.com/backend-api/codex/");
    assert!(url.starts_with("https://chatgpt.com/backend-api/codex/models?client_version="));
    assert_eq!(models_list_url("https://api.openai.com/v1"), "https://api.openai.com/v1/models");
}

#[test]
fn presets_cover_every_documented_provider() {
    let ids: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
    for expected in [
        "openai",
        "anthropic",
        "openrouter",
        "deepseek",
        "zai",
        "xai",
        "google",
        "groq",
        "mistral",
        "moonshot",
        "together",
        "fireworks",
        "ollama",
        "custom",
    ] {
        assert!(ids.contains(&expected), "missing preset {expected}");
    }
    let anthropic = PRESETS.iter().find(|p| p.id == "anthropic").unwrap();
    assert_eq!(anthropic.api_backend, "messages");
    assert_eq!(anthropic.extra_headers, &[("anthropic-version", "2023-06-01")]);
    let ollama = PRESETS.iter().find(|p| p.id == "ollama").unwrap();
    assert!(ollama.env_key.is_none(), "Ollama needs no key");
    let zai = PRESETS.iter().find(|p| p.id == "zai").unwrap();
    assert_eq!(zai.base_url, Some("https://api.z.ai/api/paas/v4/"));
    assert_eq!(zai.env_key, Some("ZAI_API_KEY"));
    assert_eq!(
        zai.models.iter().map(|model| model.id).collect::<Vec<_>>(),
        ["glm-5.1", "glm-5", "glm-4.7"]
    );
    let custom = PRESETS.iter().find(|p| p.id == "custom").unwrap();
    assert!(custom.base_url.is_none(), "the custom card takes a user URL");
    assert_eq!(preset_api_version_header("anthropic", "messages").unwrap().0, "anthropic-version");
    assert!(preset_api_version_header("deepseek", "chat_completions").is_none());
}

/// The mutation helper shared by upsert/delete/set_default. Exercised directly so the
/// comment-preservation contract holds without a live agent.
fn edit(source: &str, f: impl FnOnce(&mut toml_edit::DocumentMut) -> anyhow::Result<()>) -> String {
    let mut doc: toml_edit::DocumentMut = source.parse().expect("valid fixture");
    f(&mut doc).expect("mutation succeeds");
    doc.to_string()
}

#[test]
fn provider_upsert_preserves_comments_and_unrelated_tables() {
    let source = r#"# my hand-written notes
[ui]
theme = "dark"

[mcp_servers.local]
command = "/bin/echo"

[model_providers.old]
base_url = "https://old.example/v1"
api_key = "sk-old"
"#;
    let req = UpsertRequest {
        api_key: Some("sk-new".to_owned()),
        models: vec![SeedModelRequest {
            id: Some("deepseek/chat".to_owned()),
            model: "deepseek-chat".to_owned(),
            name: Some("DeepSeek Chat".to_owned()),
            input: Some(vec!["text".to_owned()]),
            context_window: Some(128_000),
            max_completion_tokens: None,
        }],
        set_as_default: true,
        ..upsert("deepseek", "https://api.deepseek.com")
    };
    let out = edit(source, |doc| {
        let providers = child_table(doc, "model_providers")?;
        let provider = providers
            .entry(&req.id)
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_mut()
            .unwrap();
        provider.insert("base_url", toml_edit::value("https://api.deepseek.com"));
        provider.insert("api_key", toml_edit::value("sk-new"));
        let models = child_table(doc, "model")?;
        let table = models
            .entry("deepseek/chat")
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()))
            .as_table_mut()
            .unwrap();
        table.insert("model", toml_edit::value("deepseek-chat"));
        table.insert("model_provider", toml_edit::value("deepseek"));
        table.insert("context_window", toml_edit::value(128_000i64));
        child_table(doc, "models")?.insert("default", toml_edit::value("deepseek/chat"));
        Ok(())
    });

    assert!(out.contains("# my hand-written notes"), "comments survive: {out}");
    assert!(out.contains("theme = \"dark\""));
    assert!(out.contains("[mcp_servers.local]"));
    assert!(out.contains("[model_providers.old]"), "other providers survive");
    assert!(out.contains("api_key = \"sk-old\""));
    // A key with `/` (and any other non-bare character) must be rendered quoted, or the
    // dotted key would silently become nested tables.
    assert!(out.contains("[model.\"deepseek/chat\"]"), "quoted catalog key: {out}");
    assert!(out.contains("default = \"deepseek/chat\""));
    let reparsed: toml::Value = toml::from_str(&out).expect("output is valid TOML");
    assert_eq!(
        reparsed["model"]["deepseek/chat"]["model_provider"].as_str(),
        Some("deepseek")
    );
}

#[test]
fn provider_delete_removes_the_provider_and_its_models_only() {
    // The comment above `[model_providers.deepseek]` is that table's own decor, so it leaves with
    // it; comments belonging to anything we keep must survive.
    let source = r#"[ui]
theme = "dark"

# keep me
[model_providers.other]
base_url = "https://other.example/v1"

# deepseek notes
[model_providers.deepseek]
base_url = "https://api.deepseek.com"
api_key = "sk-x"

[model."deepseek/chat"]
model = "deepseek-chat"
model_provider = "deepseek"

[model.keep]
model = "keep"
model_provider = "other"

[models]
default = "keep"
"#;
    let out = edit(source, |doc| {
        if let Some(providers) = doc.get_mut("model_providers").and_then(child_as_table) {
            providers.remove("deepseek");
        }
        if let Some(models) = doc.get_mut("model").and_then(child_as_table) {
            models.remove("deepseek/chat");
        }
        Ok(())
    });
    assert!(out.contains("# keep me"), "kept comment survives: {out}");
    assert!(out.contains("theme = \"dark\""), "unrelated table survives: {out}");
    assert!(!out.contains("[model_providers.deepseek]"));
    assert!(!out.contains("deepseek/chat"));
    assert!(!out.contains("# deepseek notes"), "the removed table's decor goes with it: {out}");
    assert!(out.contains("[model_providers.other]"));
    assert!(out.contains("[model.keep]"));
    assert!(out.contains("default = \"keep\""));
    let reparsed: toml::Value = toml::from_str(&out).expect("output is valid TOML");
    assert_eq!(reparsed["models"]["default"].as_str(), Some("keep"));
}

#[test]
fn child_table_creates_implicit_parents_only_when_absent() {
    let out = edit("# notes\n[ui]\ntheme = \"dark\"\n", |doc| {
        child_table(doc, "model_providers")?.insert(
            "deepseek",
            toml_edit::Item::Table(toml_edit::Table::new()),
        );
        Ok(())
    });
    assert!(!out.contains("[model_providers]\n"), "no bare parent header: {out}");
    assert!(out.contains("[model_providers.deepseek]"));
    assert!(out.starts_with("# notes"), "leading comment survives: {out}");
    assert!(out.contains("theme = \"dark\""), "existing table survives: {out}");
}

#[test]
fn child_table_rejects_a_non_table_section() {
    let mut doc: toml_edit::DocumentMut =
        "model_providers = \"oops\"\n".parse().expect("valid fixture");
    let err = child_table(&mut doc, "model_providers").unwrap_err();
    assert!(err.to_string().contains("not a table"), "{err}");
}

#[test]
fn presets_match_the_shared_desktop_fixture() {
    // `provider-presets.fixture.json` is the contract the desktop's preset mirror also asserts
    // against, so the cards can never advertise a provider the agent does not know.
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../frontend/apps/let-cook/src/acp/provider-presets.fixture.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let fixture: serde_json::Value = serde_json::from_str(&raw).expect("fixture is JSON");
    let snapshot: serde_json::Value = serde_json::to_value(PRESETS).expect("presets serialize");
    assert_eq!(snapshot, fixture, "the agent preset catalog drifted from the fixture");
}

#[test]
fn env_key_primary_reads_single_and_list_forms() {
    use crate::agent::config::EnvKeys;
    assert_eq!(
        env_key_primary(&EnvKeys::single("DEEPSEEK_API_KEY")),
        Some("DEEPSEEK_API_KEY")
    );
    assert_eq!(
        env_key_primary(&EnvKeys::new(vec!["A_KEY", "B_KEY"])),
        Some("A_KEY")
    );
    assert_eq!(env_key_primary(&EnvKeys::new(Vec::<String>::new())), None);
}
