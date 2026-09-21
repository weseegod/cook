//! Fork-owned BYOK provider extension: `x.ai/providers/*` and `x.ai/models/set_default`.
//!
//! The agent is the only writer of `config.toml`. Every mutation goes through `toml_edit`
//! so pre-existing comments and unknown keys survive a round-trip, and no client ever
//! parses or emits TOML itself.
//!
//! Secrets never travel outward: [`handle_list`] reports credential *presence* plus a
//! last-4 hint, never the key value.

use std::time::{Duration, Instant};

use agent_client_protocol as acp;
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::{ExtResult, parse_params, to_raw_response};
use crate::agent::MvpAgent;

/// Ceiling for one credential probe. A hung provider must not wedge the settings dialog.
const TEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Error bodies are echoed back to the UI; cap them so a giant HTML error page is not a response.
const ERROR_BODY_LIMIT: usize = 400;
/// Cap on discovered models merged into the catalog from one `/models` response.
const MAX_DISCOVERED_MODELS: usize = 200;

// ── Entry point ─────────────────────────────────────────────────────

pub async fn handle(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    match args.method.as_ref() {
        "x.ai/providers/list" => handle_list(),
        "x.ai/providers/presets" => handle_presets(),
        "x.ai/providers/upsert" => handle_upsert(agent, args).await,
        "x.ai/providers/delete" => handle_delete(agent, args).await,
        "x.ai/providers/test" => handle_test(args).await,
        "x.ai/providers/discover_models" => handle_discover_models(agent, args).await,
        "x.ai/models/set_default" => handle_set_default(agent, args).await,
        _ => Err(acp::Error::method_not_found()),
    }
}

// ── `x.ai/providers/list` ───────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderView {
    id: String,
    base_url: Option<String>,
    api_backend: Option<String>,
    /// A usable credential is configured (inline key or declared env var).
    has_key: bool,
    inline_key: bool,
    /// Last-4 style hint (`sk-…abcd`); `None` when no inline key or it is too short to hint.
    key_hint: Option<String>,
    env_key: Option<String>,
    /// The declared env var currently resolves in the agent's environment.
    env_key_present: bool,
    extra_headers: IndexMap<String, String>,
    models: Vec<LinkedModel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedModel {
    id: String,
    name: Option<String>,
    input: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    providers: Vec<ProviderView>,
    default_model: Option<String>,
}

fn handle_list() -> ExtResult {
    let snapshot = match provider_snapshot() {
        Ok(snapshot) => snapshot,
        Err(e) => return Err(acp::Error::internal_error().data(e.to_string())),
    };
    let mut providers: Vec<ProviderView> = Vec::new();
    for (id, provider) in &snapshot.providers {
        let inline = provider
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty());
        let env_key = provider
            .env_key
            .as_ref()
            .and_then(env_key_primary)
            .map(str::to_owned);
        let env_key_present = env_key
            .as_deref()
            .is_some_and(|name| std::env::var(name).is_ok_and(|v| !v.is_empty()));
        let mut models: Vec<LinkedModel> = snapshot
            .models
            .iter()
            .filter(|(_, m)| m.model_provider.as_deref() == Some(id.as_str()))
            .map(|(key, m)| LinkedModel {
                id: key.clone(),
                name: m.name.clone(),
                input: m.input.as_ref().map(|modalities| {
                    modalities
                        .iter()
                        .filter_map(|m| serde_json::to_value(m).ok())
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                }),
            })
            .collect();
        models.sort_by(|a, b| a.id.cmp(&b.id));
        providers.push(ProviderView {
            id: id.clone(),
            base_url: provider.base_url.clone(),
            api_backend: provider
                .api_backend
                .as_ref()
                .and_then(|b| serde_json::to_value(b).ok())
                .and_then(|v| v.as_str().map(str::to_owned)),
            has_key: inline.is_some() || env_key.is_some(),
            inline_key: inline.is_some(),
            key_hint: inline.and_then(key_hint),
            env_key,
            env_key_present,
            extra_headers: provider.extra_headers.clone(),
            models,
        });
    }
    providers.sort_by(|a, b| a.id.cmp(&b.id));
    to_raw_response(&ListResponse {
        providers,
        default_model: snapshot.default_model,
    })
}

/// `sk-…abcd` — never enough of the key to reconstruct it.
fn key_hint(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() < 12 {
        return None;
    }
    let head: String = chars[..2].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    Some(format!("{head}…{tail}"))
}

// ── `x.ai/providers/presets` ────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresetModel {
    id: &'static str,
    model: &'static str,
    name: &'static str,
    input: &'static [&'static str],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderPreset {
    id: &'static str,
    label: &'static str,
    /// `None` for the custom card: the user supplies the URL.
    base_url: Option<&'static str>,
    api_backend: &'static str,
    env_key: Option<&'static str>,
    /// One-line hint shown under the card ("create a key at …").
    help: &'static str,
    /// Offers "Discover models" (the provider exposes an OpenAI-compatible `/models`).
    discover: bool,
    /// Some providers need a fixed header on every request (Anthropic's API version). Serialized
    /// as a name→value map, matching the shape `upsert` accepts back.
    #[serde(serialize_with = "headers_as_map")]
    extra_headers: &'static [(&'static str, &'static str)],
    models: &'static [PresetModel],
}

fn headers_as_map<S: serde::Serializer>(
    headers: &&'static [(&'static str, &'static str)],
    serializer: S,
) -> Result<S::Ok, S::Error> {
    use serde::ser::SerializeMap;
    let mut map = serializer.serialize_map(Some(headers.len()))?;
    for (name, value) in headers.iter() {
        map.serialize_entry(name, value)?;
    }
    map.end()
}

const fn seed(
    id: &'static str,
    model: &'static str,
    name: &'static str,
    input: &'static [&'static str],
) -> PresetModel {
    PresetModel {
        id,
        model,
        name,
        input,
    }
}

const TEXT: &[&str] = &["text"];
const TEXT_IMAGE: &[&str] = &["text", "image"];

const PRESETS: &[ProviderPreset] = &[
    ProviderPreset {
        id: "openai",
        label: "OpenAI",
        base_url: Some("https://api.openai.com/v1"),
        api_backend: "chat_completions",
        env_key: Some("OPENAI_API_KEY"),
        help: "Create a key at platform.openai.com/api-keys",
        discover: true,
        extra_headers: &[],
        models: &[
            seed("gpt-5", "gpt-5", "GPT-5", TEXT_IMAGE),
            seed("gpt-4.1", "gpt-4.1", "GPT-4.1", TEXT_IMAGE),
            seed("o4-mini", "o4-mini", "o4-mini", TEXT),
        ],
    },
    ProviderPreset {
        id: "anthropic",
        label: "Anthropic",
        base_url: Some("https://api.anthropic.com/v1"),
        api_backend: "messages",
        env_key: Some("ANTHROPIC_API_KEY"),
        help: "Create a key at console.anthropic.com",
        discover: true,
        extra_headers: &[("anthropic-version", "2023-06-01")],
        models: &[
            seed("claude-opus-4-6", "claude-opus-4-6", "Claude Opus", TEXT_IMAGE),
            seed(
                "claude-sonnet-4-6",
                "claude-sonnet-4-6",
                "Claude Sonnet",
                TEXT_IMAGE,
            ),
            seed(
                "claude-haiku-4-5",
                "claude-haiku-4-5",
                "Claude Haiku",
                TEXT_IMAGE,
            ),
        ],
    },
    ProviderPreset {
        id: "openrouter",
        label: "OpenRouter",
        base_url: Some("https://openrouter.ai/api/v1"),
        api_backend: "chat_completions",
        env_key: Some("OPENROUTER_API_KEY"),
        help: "Create a key at openrouter.ai/keys",
        discover: true,
        extra_headers: &[],
        models: &[
            seed(
                "anthropic/claude-sonnet-4.6",
                "anthropic/claude-sonnet-4.6",
                "Claude Sonnet 4.6",
                TEXT_IMAGE,
            ),
            seed(
                "deepseek/deepseek-chat",
                "deepseek/deepseek-chat",
                "DeepSeek Chat",
                TEXT,
            ),
        ],
    },
    ProviderPreset {
        id: "deepseek",
        label: "DeepSeek",
        base_url: Some("https://api.deepseek.com"),
        api_backend: "chat_completions",
        env_key: Some("DEEPSEEK_API_KEY"),
        help: "Create a key at platform.deepseek.com",
        discover: true,
        extra_headers: &[],
        models: &[
            seed("deepseek-chat", "deepseek-chat", "DeepSeek Chat", TEXT),
            seed(
                "deepseek-reasoner",
                "deepseek-reasoner",
                "DeepSeek Reasoner",
                TEXT,
            ),
        ],
    },
    ProviderPreset {
        id: "zai",
        label: "Z.ai",
        base_url: Some("https://api.z.ai/api/paas/v4/"),
        api_backend: "chat_completions",
        env_key: Some("ZAI_API_KEY"),
        help: "Create a key at z.ai",
        discover: true,
        extra_headers: &[],
        models: &[
            seed("glm-5.1", "glm-5.1", "GLM-5.1", TEXT),
            seed("glm-5", "glm-5", "GLM-5", TEXT),
            seed("glm-4.7", "glm-4.7", "GLM-4.7", TEXT),
        ],
    },
    ProviderPreset {
        id: "xai",
        label: "xAI",
        base_url: Some("https://api.x.ai/v1"),
        api_backend: "chat_completions",
        env_key: Some("XAI_API_KEY"),
        help: "Create a key at console.x.ai, or run `cook login` for session auth",
        discover: true,
        extra_headers: &[],
        models: &[
            seed("grok-4.5", "grok-4.5", "Grok 4.5", TEXT_IMAGE),
            seed("grok-4.5-mini", "grok-4.5-mini", "Grok 4.5 Mini", TEXT_IMAGE),
        ],
    },
    ProviderPreset {
        id: "google",
        label: "Google Gemini",
        base_url: Some("https://generativelanguage.googleapis.com/v1beta/openai/"),
        api_backend: "chat_completions",
        env_key: Some("GEMINI_API_KEY"),
        help: "Create a key at aistudio.google.com/apikey",
        discover: true,
        extra_headers: &[],
        models: &[
            seed("gemini-2.5-pro", "gemini-2.5-pro", "Gemini 2.5 Pro", TEXT_IMAGE),
            seed(
                "gemini-2.5-flash",
                "gemini-2.5-flash",
                "Gemini 2.5 Flash",
                TEXT_IMAGE,
            ),
        ],
    },
    ProviderPreset {
        id: "groq",
        label: "Groq",
        base_url: Some("https://api.groq.com/openai/v1"),
        api_backend: "chat_completions",
        env_key: Some("GROQ_API_KEY"),
        help: "Create a key at console.groq.com/keys",
        discover: true,
        extra_headers: &[],
        models: &[],
    },
    ProviderPreset {
        id: "mistral",
        label: "Mistral",
        base_url: Some("https://api.mistral.ai/v1"),
        api_backend: "chat_completions",
        env_key: Some("MISTRAL_API_KEY"),
        help: "Create a key at console.mistral.ai",
        discover: true,
        extra_headers: &[],
        models: &[],
    },
    ProviderPreset {
        id: "moonshot",
        label: "Moonshot / Kimi",
        base_url: Some("https://api.moonshot.ai/v1"),
        api_backend: "chat_completions",
        env_key: Some("MOONSHOT_API_KEY"),
        help: "Create a key at platform.moonshot.ai",
        discover: true,
        extra_headers: &[],
        models: &[
            seed("kimi-k2.6", "kimi-k2.6", "Kimi K2.6", TEXT),
            seed("kimi-k3", "kimi-k3", "Kimi K3", TEXT),
        ],
    },
    ProviderPreset {
        id: "together",
        label: "Together",
        base_url: Some("https://api.together.xyz/v1"),
        api_backend: "chat_completions",
        env_key: Some("TOGETHER_API_KEY"),
        help: "Create a key at api.together.ai/settings/api-keys",
        discover: true,
        extra_headers: &[],
        models: &[],
    },
    ProviderPreset {
        id: "fireworks",
        label: "Fireworks",
        base_url: Some("https://api.fireworks.ai/inference/v1"),
        api_backend: "chat_completions",
        env_key: Some("FIREWORKS_API_KEY"),
        help: "Create a key at fireworks.ai/account/api-keys",
        discover: true,
        extra_headers: &[],
        models: &[],
    },
    ProviderPreset {
        id: "ollama",
        label: "Ollama (local)",
        base_url: Some("http://127.0.0.1:11434/v1"),
        api_backend: "chat_completions",
        env_key: None,
        help: "Runs locally; no API key required",
        discover: true,
        extra_headers: &[],
        models: &[],
    },
    ProviderPreset {
        id: "custom",
        label: "OpenAI-compatible",
        base_url: None,
        api_backend: "chat_completions",
        env_key: None,
        help: "Any OpenAI-compatible endpoint: paste its base URL and a model id",
        discover: true,
        extra_headers: &[],
        models: &[],
    },
];

fn handle_presets() -> ExtResult {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PresetsResponse {
        presets: &'static [ProviderPreset],
    }
    to_raw_response(&PresetsResponse { presets: PRESETS })
}

// ── `x.ai/providers/upsert` ─────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedModelRequest {
    /// Catalog key (`[model.<id>]`); defaults to `model`.
    #[serde(default)]
    id: Option<String>,
    model: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    input: Option<Vec<String>>,
    #[serde(default)]
    context_window: Option<u64>,
    #[serde(default)]
    max_completion_tokens: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertRequest {
    id: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_backend: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    env_key: Option<String>,
    #[serde(default)]
    extra_headers: IndexMap<String, String>,
    #[serde(default)]
    models: Vec<SeedModelRequest>,
    #[serde(default)]
    set_as_default: bool,
}

impl UpsertRequest {
    fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("provider id must not be empty".to_owned());
        }
        if self.id.len() > 64 {
            return Err("provider id must be at most 64 characters".to_owned());
        }
        let base_url = self.base_url.as_deref().unwrap_or("").trim();
        if base_url.is_empty() {
            return Err("baseUrl is required".to_owned());
        }
        if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
            return Err("baseUrl must start with http:// or https://".to_owned());
        }
        if let Some(backend) = self.api_backend.as_deref()
            && !matches!(backend, "chat_completions" | "responses" | "messages")
        {
            return Err(format!("unsupported apiBackend `{backend}`"));
        }
        let inline = self
            .api_key
            .as_deref()
            .map(str::trim)
            .is_some_and(|k| !k.is_empty());
        let env = self
            .env_key
            .as_deref()
            .map(str::trim)
            .is_some_and(|k| !k.is_empty());
        if inline && env {
            return Err("pass either apiKey or envKey, not both".to_owned());
        }
        if let Some(name) = self.env_key.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            if !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                return Err("envKey must be a variable name (A-Z, 0-9, _)".to_owned());
            }
        }
        for model in &self.models {
            if model.model.trim().is_empty() {
                return Err("every model needs an API model id".to_owned());
            }
            if let Some(input) = &model.input {
                for modality in input {
                    if !matches!(modality.as_str(), "text" | "image") {
                        return Err(format!("unsupported input modality `{modality}`"));
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpsertResponse {
    ok: bool,
    id: String,
    models: Vec<String>,
    default_model: Option<String>,
}

async fn handle_upsert(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: UpsertRequest = parse_params(args)?;
    let result = upsert_provider(&req).await;
    match result {
        Ok(response) => match reload_models(agent) {
            Ok(_) => to_raw_response(&response),
            Err(e) => Err(acp::Error::internal_error()
                .data(format!("provider saved, but the model catalog reload failed: {e}"))),
        },
        Err(e) => Err(acp::Error::invalid_params().data(e.to_string())),
    }
}

async fn upsert_provider(req: &UpsertRequest) -> anyhow::Result<UpsertResponse> {
    req.validate().map_err(anyhow::Error::msg)?;
    let existing = provider_snapshot()?;
    let known = existing.providers.contains_key(&req.id);
    let inline = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    let env = req
        .env_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    if inline.is_none() && env.is_none() && !known {
        anyhow::bail!("a new provider needs apiKey or envKey");
    }

    let seeds: Vec<SeedModelRequest> = req.models.clone();
    let mut written_models: Vec<String> = Vec::new();
    let mut default_model = None;

    mutate_user_config(|doc| {
        let providers = child_table(doc, "model_providers")?;
        if !providers.contains_key(&req.id) {
            let mut table = toml_edit::Table::new();
            table.insert("base_url", toml_edit::value(req.base_url.clone().unwrap_or_default()));
            providers.insert(&req.id, toml_edit::Item::Table(table));
        }
        let provider = providers
            .get_mut(&req.id)
            .and_then(|item| item.as_table_mut())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "[model_providers.{}] exists but is not a table; fix config.toml first",
                    req.id
                )
            })?;

        if let Some(url) = req.base_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            provider.insert("base_url", toml_edit::value(url));
        }
        if let Some(backend) = req.api_backend.as_deref() {
            provider.insert("api_backend", toml_edit::value(backend));
        }
        if req.extra_headers.is_empty() {
            provider.remove("extra_headers");
        } else {
            let mut headers = toml_edit::Table::new();
            for (name, value) in &req.extra_headers {
                headers.insert(name, toml_edit::value(value.clone()));
            }
            provider.insert("extra_headers", toml_edit::Item::Table(headers));
        }
        // One credential at a time: setting a key clears a stale env var and vice versa.
        if let Some(key) = inline {
            provider.insert("api_key", toml_edit::value(key));
            provider.remove("env_key");
        } else if let Some(name) = env {
            provider.insert("env_key", toml_edit::value(name));
            provider.remove("api_key");
        }

        let models = child_table(doc, "model")?;
        for seed in &seeds {
            let catalog_id = seed.id.clone().unwrap_or_else(|| seed.model.clone());
            let catalog_id = catalog_id.trim();
            if catalog_id.is_empty() {
                continue;
            }
            if !models.contains_key(catalog_id) {
                models.insert(catalog_id, toml_edit::Item::Table(toml_edit::Table::new()));
            }
            let table = models
                .get_mut(catalog_id)
                .and_then(|item| item.as_table_mut())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "[model.{catalog_id}] exists but is not a table; fix config.toml first"
                    )
                })?;
            table.insert("model", toml_edit::value(seed.model.trim()));
            table.insert("model_provider", toml_edit::value(req.id.clone()));
            if let Some(name) = &seed.name {
                table.insert("name", toml_edit::value(name.clone()));
            }
            if let Some(input) = &seed.input {
                let array = input.iter().map(|m| toml_edit::Value::from(m.clone()));
                table.insert("input", toml_edit::value(toml_edit::Array::from_iter(array)));
            }
            if let Some(window) = seed.context_window {
                table.insert("context_window", toml_edit::value(window as i64));
            }
            if let Some(max) = seed.max_completion_tokens {
                table.insert("max_completion_tokens", toml_edit::value(max as i64));
            }
            if !written_models.iter().any(|id| id == catalog_id) {
                written_models.push(catalog_id.to_owned());
            }
        }

        if req.set_as_default && let Some(first) = written_models.first() {
            let models_section = child_table(doc, "models")?;
            models_section.insert("default", toml_edit::value(first.clone()));
            default_model = Some(first.clone());
        }
        Ok(())
    })
    .await?;

    Ok(UpsertResponse {
        ok: true,
        id: req.id.clone(),
        models: written_models,
        default_model,
    })
}

// ── `x.ai/providers/delete` ─────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRequest {
    id: String,
    /// Model to promote into `[models] default` when the removed ones included the default.
    #[serde(default, alias = "replacement_model")]
    replacement: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeleteResponse {
    ok: bool,
    id: String,
    removed_models: Vec<String>,
    default_model: Option<String>,
}

async fn handle_delete(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: DeleteRequest = parse_params(args)?;
    match delete_provider(&req).await {
        Ok(response) => match reload_models(agent) {
            Ok(_) => to_raw_response(&response),
            Err(e) => Err(acp::Error::internal_error()
                .data(format!("provider removed, but the model catalog reload failed: {e}"))),
        },
        Err(e) => Err(acp::Error::invalid_params().data(e.to_string())),
    }
}

async fn delete_provider(req: &DeleteRequest) -> anyhow::Result<DeleteResponse> {
    let snapshot = provider_snapshot()?;
    if !snapshot.providers.contains_key(&req.id) {
        anyhow::bail!("no provider `{}` is configured", req.id);
    }
    let removed_models: Vec<String> = snapshot
        .models
        .iter()
        .filter(|(_, m)| m.model_provider.as_deref() == Some(req.id.as_str()))
        .map(|(key, _)| key.clone())
        .collect();

    // Refuse before writing anything: a dangling `[models] default` would leave the picker
    // pointing at a model that no longer exists.
    let mut new_default = None;
    if let Some(current) = snapshot.default_model.as_deref()
        && removed_models.iter().any(|id| id == current)
    {
        let replacement = req
            .replacement
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty() && !removed_models.iter().any(|id| id == r));
        match replacement {
            Some(replacement) => new_default = Some(replacement.to_owned()),
            None => anyhow::bail!(
                "refusing to delete `{}`: [models] default = `{current}` would dangle; \
                 pass a replacement model id",
                req.id
            ),
        }
    }

    mutate_user_config(|doc| {
        if let Some(providers) = doc.get_mut("model_providers").and_then(child_as_table) {
            providers.remove(&req.id);
            if providers.is_empty() {
                doc.remove("model_providers");
            }
        }
        if let Some(models) = doc.get_mut("model").and_then(child_as_table) {
            for id in &removed_models {
                models.remove(id);
            }
            if models.is_empty() {
                doc.remove("model");
            }
        }
        if let Some(replacement) = &new_default
            && let Some(section) = doc.get_mut("models").and_then(child_as_table)
        {
            section.insert("default", toml_edit::value(replacement.clone()));
        }
        Ok(())
    })
    .await?;

    Ok(DeleteResponse {
        ok: true,
        id: req.id.clone(),
        removed_models,
        default_model: new_default,
    })
}

// ── `x.ai/providers/test` ───────────────────────────────────────────

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestRequest {
    id: String,
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    api_backend: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    env_key: Option<String>,
    #[serde(default)]
    model: Option<String>,
}

/// A resolved endpoint + credential for one probe request.
#[derive(Debug, Clone)]
struct ProbeTarget {
    base_url: String,
    api_backend: String,
    api_key: Option<String>,
    env_key: Option<String>,
    extra_headers: IndexMap<String, String>,
    model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResponse {
    ok: bool,
    status: Option<u16>,
    /// Truncated error text (or HTTP status text when the body was empty).
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Which endpoint answered, so the UI can show "hit <url>".
    url: String,
    model: Option<String>,
    latency_ms: u128,
}

async fn handle_test(args: &acp::ExtRequest) -> ExtResult {
    let req: TestRequest = parse_params(args)?;
    let target = match resolve_probe_target(&req) {
        Ok(target) => target,
        Err(e) => return Err(acp::Error::invalid_params().data(e.to_string())),
    };
    let probe = probe_credential(&target).await;
    to_raw_response(&probe)
}

/// Merge the request over the saved provider so the form can test before saving.
fn resolve_probe_target(req: &TestRequest) -> anyhow::Result<ProbeTarget> {
    let snapshot = provider_snapshot()?;
    let saved = snapshot.providers.get(&req.id);
    let base_url = req
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_owned)
        .or_else(|| saved.and_then(|p| p.base_url.clone()))
        .ok_or_else(|| anyhow::anyhow!("baseUrl is required to test a provider"))?;
    let api_backend = req
        .api_backend
        .as_deref()
        .map(str::to_owned)
        .or_else(|| {
            saved
                .and_then(|p| p.api_backend.as_ref())
                .and_then(backend_name)
        })
        .unwrap_or_else(|| "chat_completions".to_owned());
    let inline = req
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
        .or_else(|| saved.and_then(|p| p.api_key.clone()));
    let env_key = req
        .env_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_owned)
        .or_else(|| saved.and_then(|p| p.env_key.as_ref()).and_then(env_key_primary).map(str::to_owned));
    let mut extra_headers = saved.map(|p| p.extra_headers.clone()).unwrap_or_default();
    if let Some(header) = preset_api_version_header(&req.id, &api_backend) {
        extra_headers
            .entry(header.0.to_owned())
            .or_insert_with(|| header.1.to_owned());
    }
    let model = req
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            snapshot
                .models
                .iter()
                .find(|(_, m)| m.model_provider.as_deref() == Some(req.id.as_str()))
                .and_then(|(key, m)| m.model.clone().or_else(|| Some(key.clone())))
        });
    Ok(ProbeTarget {
        base_url,
        api_backend,
        api_key: inline,
        env_key,
        extra_headers,
        model,
    })
}

/// The one cheap call: a 1-token completion on the provider's own base URL, or `GET /models`
/// when no model id is known yet. Never xAI's endpoint, never the provider's key in the reply.
async fn probe_credential(target: &ProbeTarget) -> TestResponse {
    let started = Instant::now();
    let key = target.api_key.clone().or_else(|| {
        target
            .env_key
            .as_deref()
            .and_then(|name| std::env::var(name).ok())
            .filter(|v| !v.is_empty())
    });
    let client = crate::http::shared_client();
    let base = target.base_url.trim_end_matches('/');

    let request = match target.model.as_deref() {
        Some(model) if target.api_backend == "messages" => client
            .post(format!("{base}/messages"))
            .json(&serde_json::json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "ping" }],
            })),
        Some(model) if target.api_backend == "responses" => client
            .post(format!("{base}/responses"))
            .json(&serde_json::json!({
                "model": model,
                // ChatGPT's Codex Responses endpoint requires the structured input form;
                // the public Responses API accepts it too, so keep the probe portable.
                "input": [{
                    "role": "user",
                    "content": [{"type": "input_text", "text": "ping"}]
                }],
                "max_output_tokens": 16,
            })),
        Some(model) => client
            .post(format!("{base}/chat/completions"))
            .json(&serde_json::json!({
                "model": model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "ping" }],
            })),
        None => client.get(format!("{base}/models")),
    };

    let request = with_credentials(request, &target.api_backend, key.as_deref(), &target.extra_headers);
    let url = request
        .try_clone()
        .and_then(|r| r.build().ok())
        .map(|r| r.url().to_string())
        .unwrap_or_else(|| format!("{base}/models"));

    let sent = tokio::time::timeout(TEST_TIMEOUT, request.send()).await;
    let latency_ms = started.elapsed().as_millis();
    match sent {
        Err(_) => TestResponse {
            ok: false,
            status: None,
            error: Some(format!("timed out after {}s", TEST_TIMEOUT.as_secs())),
            url,
            model: target.model.clone(),
            latency_ms,
        },
        Ok(Err(e)) => TestResponse {
            ok: false,
            status: None,
            error: Some(redact(&truncate(&e.to_string()), key.as_deref())),
            url,
            model: target.model.clone(),
            latency_ms,
        },
        Ok(Ok(response)) => {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status.is_success() {
                TestResponse {
                    ok: true,
                    status: Some(status.as_u16()),
                    error: None,
                    url,
                    model: target.model.clone(),
                    latency_ms,
                }
            } else {
                let detail = if body.trim().is_empty() {
                    status.canonical_reason().unwrap_or("request failed").to_owned()
                } else {
                    truncate(&body)
                };
                TestResponse {
                    ok: false,
                    status: Some(status.as_u16()),
                    error: Some(redact(&detail, key.as_deref())),
                    url,
                    model: target.model.clone(),
                    latency_ms,
                }
            }
        }
    }
}

fn with_credentials(
    request: reqwest::RequestBuilder,
    api_backend: &str,
    key: Option<&str>,
    extra_headers: &IndexMap<String, String>,
) -> reqwest::RequestBuilder {
    let mut request = request;
    for (name, value) in extra_headers {
        request = request.header(name, value);
    }
    match key {
        Some(key) if key.starts_with("sk-ant-oat") => request
            .bearer_auth(key)
            .header("anthropic-beta", "oauth-2024-06-04"),
        Some(key) if api_backend == "messages" => request.header("x-api-key", key),
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

/// Never echo the credential back, even if a provider reflected it into an error body.
fn redact(text: &str, key: Option<&str>) -> String {
    match key {
        Some(key) if !key.is_empty() && text.contains(key) => text.replace(key, "***"),
        _ => text.to_owned(),
    }
}

fn truncate(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= ERROR_BODY_LIMIT {
        return trimmed.to_owned();
    }
    let head: String = trimmed.chars().take(ERROR_BODY_LIMIT).collect();
    format!("{head}…")
}

// ── `x.ai/providers/discover_models` ────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveredModel {
    id: String,
    name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscoverResponse {
    ok: bool,
    id: String,
    /// Every id the provider reported.
    discovered: Vec<DiscoveredModel>,
    /// Ids newly merged into the catalog as `[model.*]` rows.
    added: Vec<String>,
    /// Ids already in the catalog, left alone (a new row would shadow the existing model).
    skipped: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

async fn handle_discover_models(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: TestRequest = parse_params(args)?;
    let target = match resolve_probe_target(&req) {
        Ok(mut target) => {
            // Discovery is always a `/models` read, never a completion.
            target.model = None;
            target
        }
        Err(e) => return Err(acp::Error::invalid_params().data(e.to_string())),
    };
    let key = target.api_key.clone().or_else(|| {
        target
            .env_key
            .as_deref()
            .and_then(|name| std::env::var(name).ok())
            .filter(|v| !v.is_empty())
    });
    let client = crate::http::shared_client();
    let base = target.base_url.trim_end_matches('/');
    let request = with_credentials(
        client.get(format!("{base}/models")),
        &target.api_backend,
        key.as_deref(),
        &target.extra_headers,
    );
    let response = match tokio::time::timeout(TEST_TIMEOUT, request.send()).await {
        Err(_) => {
            return to_raw_response(&DiscoverResponse {
                ok: false,
                id: req.id.clone(),
                discovered: Vec::new(),
                added: Vec::new(),
                skipped: Vec::new(),
                error: Some(format!("timed out after {}s", TEST_TIMEOUT.as_secs())),
            });
        }
        Ok(Err(e)) => {
            return to_raw_response(&DiscoverResponse {
                ok: false,
                id: req.id.clone(),
                discovered: Vec::new(),
                added: Vec::new(),
                skipped: Vec::new(),
                error: Some(redact(&truncate(&e.to_string()), key.as_deref())),
            });
        }
        Ok(Ok(response)) => response,
    };
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return to_raw_response(&DiscoverResponse {
            ok: false,
            id: req.id.clone(),
            discovered: Vec::new(),
            added: Vec::new(),
            skipped: Vec::new(),
            error: Some(redact(
                &format!("HTTP {}: {}", status.as_u16(), truncate(&body)),
                key.as_deref(),
            )),
        });
    }
    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(e) => {
            return to_raw_response(&DiscoverResponse {
                ok: false,
                id: req.id.clone(),
                discovered: Vec::new(),
                added: Vec::new(),
                skipped: Vec::new(),
                error: Some(format!("could not parse /models response: {e}")),
            });
        }
    };
    let discovered = parse_discovered_models(&parsed);
    if discovered.is_empty() {
        return to_raw_response(&DiscoverResponse {
            ok: false,
            id: req.id.clone(),
            discovered,
            added: Vec::new(),
            skipped: Vec::new(),
            error: Some("/models returned no model ids".to_owned()),
        });
    }

    // Skip ids the catalog already knows: a fresh `[model.<id>]` row would shadow the
    // existing entry (and reroute a native model to this third-party endpoint).
    let mut known: Vec<String> = provider_snapshot()?.models.keys().cloned().collect();
    known.extend(agent.models_manager.models().keys().cloned());
    let to_add: Vec<DiscoveredModel> = discovered
        .iter()
        .filter(|m| !known.iter().any(|k| k == &m.id))
        .cloned()
        .collect();
    let skipped: Vec<String> = discovered
        .iter()
        .filter(|m| known.iter().any(|k| k == &m.id))
        .map(|m| m.id.clone())
        .collect();
    let added: Vec<String> = to_add.iter().map(|m| m.id.clone()).collect();
    if !to_add.is_empty() {
        let provider_id = req.id.clone();
        let seeds = to_add.clone();
        mutate_user_config(|doc| {
            let models = child_table(doc, "model")?;
            for seed in &seeds {
                if !models.contains_key(&seed.id) {
                    models.insert(&seed.id, toml_edit::Item::Table(toml_edit::Table::new()));
                }
                let table = models
                    .get_mut(&seed.id)
                    .and_then(|item| item.as_table_mut())
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "[model.{}] exists but is not a table; fix config.toml first",
                            seed.id
                        )
                    })?;
                table.insert("model", toml_edit::value(seed.id.clone()));
                table.insert("model_provider", toml_edit::value(provider_id.clone()));
                if let Some(name) = &seed.name {
                    table.insert("name", toml_edit::value(name.clone()));
                }
            }
            Ok(())
        })
        .await?;
        if let Err(e) = reload_models(agent) {
            tracing::warn!(error = %e, "model catalog reload after discover_models failed");
        }
    }

    to_raw_response(&DiscoverResponse {
        ok: true,
        id: req.id.clone(),
        discovered,
        added,
        skipped,
        error: None,
    })
}

/// OpenAI returns `{ "data": [ { "id": … } ] }`; Ollama's native shape is `{ "models": [ … ] }`.
fn parse_discovered_models(body: &serde_json::Value) -> Vec<DiscoveredModel> {
    let entries = body
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| body.get("models").and_then(|v| v.as_array()));
    let mut out: Vec<DiscoveredModel> = Vec::new();
    for entry in entries.into_iter().flatten() {
        let id = ["id", "name", "model"]
            .iter()
            .find_map(|key| entry.get(*key).and_then(|v| v.as_str()))
            .map(str::trim)
            .filter(|id| !id.is_empty());
        let Some(id) = id else { continue };
        let name = entry
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::to_owned)
            .filter(|n| n != id);
        if out.iter().any(|m| m.id == id) {
            continue;
        }
        out.push(DiscoveredModel {
            id: id.to_owned(),
            name,
        });
        if out.len() >= MAX_DISCOVERED_MODELS {
            break;
        }
    }
    out
}

// ── `x.ai/models/set_default` ───────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetDefaultRequest {
    #[serde(alias = "model_id", alias = "id")]
    model_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetDefaultResponse {
    ok: bool,
    default_model: String,
}

async fn handle_set_default(agent: &MvpAgent, args: &acp::ExtRequest) -> ExtResult {
    let req: SetDefaultRequest = parse_params(args)?;
    let model_id = req.model_id.trim();
    if model_id.is_empty() {
        return Err(acp::Error::invalid_params().data("modelId must not be empty"));
    }
    // The live catalog is authoritative (bundled native models are not in config.toml).
    let catalog = agent.models_manager.models();
    if !catalog.is_empty() && !catalog.contains_key(model_id) {
        return Err(acp::Error::invalid_params()
            .data(format!("unknown model `{model_id}`; refresh the catalog first")));
    }
    let model_id = model_id.to_owned();
    let written = model_id.clone();
    if let Err(e) = mutate_user_config(move |doc| {
        let section = child_table(doc, "models")?;
        section.insert("default", toml_edit::value(written));
        Ok(())
    })
    .await
    {
        return Err(acp::Error::internal_error().data(e.to_string()));
    }
    match reload_models(agent) {
        Ok(_) => to_raw_response(&SetDefaultResponse {
            ok: true,
            default_model: model_id,
        }),
        Err(e) => Err(acp::Error::internal_error()
            .data(format!("default saved, but the model catalog reload failed: {e}"))),
    }
}

// ── config read/write plumbing ──────────────────────────────────────

struct ProviderSnapshot {
    providers: IndexMap<String, crate::agent::model_providers::ModelProviderConfig>,
    models: IndexMap<String, crate::agent::config::ConfigModelOverride>,
    default_model: Option<String>,
}

/// Effective config (what the agent actually runs), so `list` matches the picker.
fn provider_snapshot() -> anyhow::Result<ProviderSnapshot> {
    let raw = crate::config::load_effective_config()?;
    let config = crate::agent::config::Config::new_from_toml_cfg(&raw)
        .map_err(|e| anyhow::anyhow!("config.toml could not be parsed: {e}"))?;
    Ok(ProviderSnapshot {
        providers: config.model_providers,
        models: config.config_models,
        default_model: config.models.default,
    })
}

/// Read-modify-write of the user `config.toml` under the shared write lock, preserving
/// comments, ordering, and unknown keys via `toml_edit`.
async fn mutate_user_config<F>(f: F) -> anyhow::Result<()>
where
    F: FnOnce(&mut toml_edit::DocumentMut) -> anyhow::Result<()>,
{
    let path = crate::util::config::user_config_path();
    let _guard = crate::util::config::lock_config_writes()
        .await
        .map_err(|e| anyhow::anyhow!("could not lock {}: {e}", path.display()))?;
    let original = crate::util::config::read_to_string_or_empty(&path)
        .map_err(|e| anyhow::anyhow!("failed to read {}: {e}", path.display()))?;
    let mut doc: toml_edit::DocumentMut = if original.trim().is_empty() {
        toml_edit::DocumentMut::new()
    } else {
        original.parse().map_err(|e| {
            anyhow::anyhow!(
                "refusing to overwrite unparseable {}: {e}; fix the syntax first",
                path.display()
            )
        })?
    };
    f(&mut doc)?;
    let updated = doc.to_string();
    if updated == original {
        return Ok(());
    }
    crate::util::config::atomic_write_string(&path, &updated)
        .map_err(|e| anyhow::anyhow!("failed to write {}: {e}", path.display()))?;
    Ok(())
}

/// A child table, created implicit so a fresh file renders `[model_providers.x]` without a
/// bare `[model_providers]` header.
fn child_table<'a>(
    doc: &'a mut toml_edit::DocumentMut,
    key: &str,
) -> anyhow::Result<&'a mut toml_edit::Table> {
    if !doc.contains_key(key) {
        let mut table = toml_edit::Table::new();
        table.set_implicit(true);
        doc.insert(key, toml_edit::Item::Table(table));
    }
    doc.get_mut(key)
        .and_then(child_as_table)
        .ok_or_else(|| anyhow::anyhow!("`{key}` in config.toml is not a table"))
}

fn child_as_table(item: &mut toml_edit::Item) -> Option<&mut toml_edit::Table> {
    item.as_table_mut()
}

fn env_key_primary(keys: &crate::agent::config::EnvKeys) -> Option<&str> {
    use crate::agent::config::EnvKeys;
    match keys {
        EnvKeys::One(name) => Some(name.as_str()).filter(|n| !n.is_empty()),
        EnvKeys::Many(names) => names.first().map(String::as_str).filter(|n| !n.is_empty()),
    }
}

fn backend_name(backend: &crate::sampling::ApiBackend) -> Option<String> {
    serde_json::to_value(backend)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
}

fn preset_api_version_header(id: &str, api_backend: &str) -> Option<(&'static str, &'static str)> {
    PRESETS
        .iter()
        .find(|preset| preset.id == id)
        .filter(|preset| preset.api_backend == api_backend)
        .and_then(|preset| preset.extra_headers.first().copied())
}

/// Re-resolve the model catalog from disk and push `x.ai/models/update` to every client.
fn reload_models(agent: &MvpAgent) -> anyhow::Result<()> {
    reload_models_from_disk(agent).map_err(anyhow::Error::msg)
}

/// Re-resolve the model list from `config.toml` after this module wrote it.
///
/// Mirrors the agent's `internal/reload_models` path: prefetched (API) and default models are not
/// re-fetched, only the user's TOML entries are re-resolved. Kept fork-local so the extension stays
/// self-contained: upstream's `session_admin` reload is on the watcher path, and the fork cannot
/// wait for the watcher to notice its own write.
fn reload_models_from_disk(agent: &MvpAgent) -> Result<(), String> {
    let disk_config = crate::config::load_effective_config().map_err(|e| e.to_string())?;
    let toml_config = crate::agent::config::Config::new_from_toml_cfg(&disk_config)
        .map_err(|e| e.to_string())?;

    // Merge TOML-derived model fields into the agent's in-memory config. Runtime-only fields
    // (#[serde(skip)]: remote_settings, endpoints, CLI flags) are preserved.
    {
        let agent_config = agent.cfg.borrow();
        let overrides = crate::config::ModelOverrideConfig::resolve(
            agent_config.web_search_model_override.as_deref(),
            agent_config.session_summary_model_override.as_deref(),
            &disk_config,
            agent_config.remote_settings.as_ref(),
        );
        drop(agent_config);
        let mut agent_config = agent.cfg.borrow_mut();
        agent_config.models = toml_config.models.clone();
        agent_config.config_models = toml_config.config_models.clone();
        agent_config.web_search_model = overrides.web_search;
        agent_config.session_summary_model = overrides.session_summary;
        agent_config.image_description_model = overrides.image_description;
        agent_config.prompt_suggest_model_pin = overrides.prompt_suggestion;
    }
    // `new_from_toml_cfg` cleared the campaign overlay and `pre_campaign_default`; recompute them so
    // a reload matches spawn.
    {
        let mut agent_config = agent.cfg.borrow_mut();
        crate::util::config::sync_campaign_fields(&mut agent_config);
    }
    let merged_config = agent.cfg.borrow().clone();

    agent.models_manager.apply_config(merged_config);
    agent.sync_process_static_api_key(None);

    let count = agent.models_manager.models().len();
    tracing::info!(count, "model list reloaded from config.toml");
    Ok(())
}

#[cfg(test)]
#[path = "providers_tests.rs"]
mod tests;
