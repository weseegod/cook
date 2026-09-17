//! Desktop-owned provider/model settings backed by `~/.thanh/config.toml`.
//!
//! Secrets stay in this native process. The renderer receives only credential presence and a
//! first-four/last-four hint. Every write is a locked, atomic TOML edit so comments and unrelated
//! upstream fields survive.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use toml_edit::{Array, DocumentMut, Item, Table, Value};

/// Bound on a provider's `/models` body, so a huge listing cannot exhaust memory.
const PROBE_BODY_LIMIT: u64 = 4 * 1024 * 1024;
/// Mirrors the agent's discovery cap: one listing cannot offer hundreds of models.
const PROBE_MODEL_LIMIT: usize = 200;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderList {
    providers: Vec<ProviderView>,
    models: Vec<ModelView>,
    default_model: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderView {
    id: String,
    name: Option<String>,
    base_url: Option<String>,
    api_backend: Option<String>,
    has_key: bool,
    inline_key: bool,
    key_hint: Option<String>,
    env_key: Option<String>,
    env_key_present: bool,
    extra_headers: std::collections::BTreeMap<String, String>,
    models: Vec<ModelView>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelView {
    id: String,
    model: Option<String>,
    provider: String,
    name: Option<String>,
    input: Vec<String>,
    context_window: Option<u64>,
    max_completion_tokens: Option<u32>,
    supports_reasoning_effort: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedModel {
    id: String,
    model: String,
    name: String,
    #[serde(default)]
    input: Vec<String>,
    context_window: Option<u64>,
    max_completion_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUpsert {
    id: String,
    name: Option<String>,
    base_url: String,
    api_backend: String,
    api_key: Option<String>,
    env_key: Option<String>,
    #[serde(default)]
    extra_headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    models: Vec<SeedModel>,
    #[serde(default)]
    set_as_default: bool,
}

impl ProviderUpsert {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn model_ids(&self) -> Vec<String> {
        self.models.iter().map(|model| model.id.clone()).collect()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUpsert {
    id: String,
    model: Option<String>,
    provider_id: Option<String>,
    name: Option<String>,
    #[serde(default)]
    input: Vec<String>,
    context_window: Option<u64>,
    max_completion_tokens: Option<u32>,
}

impl ModelUpsert {
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// What `probe_models` needs to read one provider's `/models`: resolved endpoint and credential.
///
/// Holds the credential, so it is deliberately neither `Debug` nor serializable.
pub struct ProbeTarget {
    id: String,
    url: String,
    api_backend: String,
    key: Option<String>,
    extra_headers: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModels {
    ok: bool,
    id: String,
    models: Vec<ProbeModel>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeModel {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_completion_tokens: Option<u32>,
}

pub fn list() -> Result<ProviderList, String> {
    let doc = load()?;
    Ok(list_document(&doc))
}

/// Resolve a configured provider into a probe target. Blocking file IO; call it from a blocking task.
pub fn probe_target(id: &str) -> Result<ProbeTarget, String> {
    let id = checked_id(id, "provider id")?.to_owned();
    let doc = load()?;
    let table = doc
        .get("model_providers")
        .and_then(Item::as_table)
        .and_then(|providers| providers.get(&id))
        .and_then(Item::as_table)
        .ok_or_else(|| format!("provider `{id}` is not configured"))?;
    let base_url = string(table, "base_url")
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("provider `{id}` has no base URL"))?;
    let key = string(table, "api_key")
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            string(table, "env_key")
                .filter(|name| !name.trim().is_empty())
                .and_then(|name| std::env::var(name).ok())
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        });
    let extra_headers = table
        .get("extra_headers")
        .and_then(Item::as_table)
        .map(|headers| {
            headers
                .iter()
                .filter_map(|(name, value)| {
                    value.as_str().map(|value| (name.to_owned(), value.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ProbeTarget {
        id,
        url: format!("{}/models", base_url.trim_end_matches('/')),
        api_backend: string(table, "api_backend").unwrap_or_else(|| "chat_completions".to_owned()),
        key,
        extra_headers,
    })
}

/// Read a provider's `/models` listing without touching `config.toml`.
///
/// This is the picker's source of truth for "which models does this endpoint offer": the agent's
/// discovery method writes every id it finds as a `[model.*]` row, which is not what a preview
/// before choosing should do.
pub async fn probe_models(target: ProbeTarget) -> Result<ProviderModels, String> {
    let ProbeTarget {
        id,
        url,
        api_backend,
        key,
        extra_headers,
    } = target;
    let mut request = crate::http::client().get(&url);
    if let Some(key) = key.as_deref() {
        request = if api_backend == "messages" {
            request.header("x-api-key", key)
        } else {
            request.header("authorization", format!("Bearer {key}"))
        };
    }
    for (name, value) in &extra_headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let failure = |error: String| ProviderModels {
        ok: false,
        id: id.clone(),
        models: Vec::new(),
        error: Some(redact(&error, key.as_deref())),
    };
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => return Ok(failure(error.to_string())),
    };
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > PROBE_BODY_LIMIT)
    {
        return Ok(failure("/models answered with more data than this probe accepts".to_owned()));
    }
    let body = response.bytes().await.map_err(|error| error.to_string())?;
    let body = String::from_utf8_lossy(&body[..body.len().min(PROBE_BODY_LIMIT as usize)]).into_owned();
    if !status.is_success() {
        return Ok(failure(format!(
            "HTTP {}: {}",
            status.as_u16(),
            redact(&truncate(body.trim(), 400), key.as_deref())
        )));
    }
    let parsed: serde_json::Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(error) => return Ok(failure(format!("could not parse the /models response: {error}"))),
    };
    let models = parse_models_listing(&parsed);
    if models.is_empty() {
        return Ok(failure("/models returned no model ids".to_owned()));
    }
    Ok(ProviderModels {
        ok: true,
        id,
        models,
        error: None,
    })
}

/// Parse the OpenAI-compatible `{ "data": [...] }` shape, OpenRouter metadata, and Google's
/// `{ "models": [{ "name": "models/<id>" }] }`, in the order the provider reported them.
fn parse_models_listing(value: &serde_json::Value) -> Vec<ProbeModel> {
    let Some(entries) = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(serde_json::Value::as_array)
        .or_else(|| value.as_array())
    else {
        return Vec::new();
    };
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for entry in entries {
        if models.len() >= PROBE_MODEL_LIMIT {
            break;
        }
        // OpenAI-compatible endpoints key the entry by `id`; Google lists `models/<id>` in `name`.
        let explicit_id = entry.get("id").and_then(serde_json::Value::as_str);
        let Some(id) = explicit_id
            .or_else(|| entry.get("name").and_then(serde_json::Value::as_str))
            .map(|raw| raw.strip_prefix("models/").unwrap_or(raw).trim())
            .filter(|id| !id.is_empty() && id.chars().count() <= 160)
        else {
            continue;
        };
        if !seen.insert(id.to_owned()) {
            continue;
        }
        let name = explicit_id
            .and(entry.get("name").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|name| !name.is_empty() && *name != id)
            .map(str::to_owned);
        models.push(ProbeModel {
            id: id.to_owned(),
            name,
            context_window: listing_number(entry, CONTEXT_KEYS),
            max_completion_tokens: listing_number(entry, OUTPUT_KEYS)
                .and_then(|value| u32::try_from(value).ok()),
        });
    }
    models
}

const CONTEXT_KEYS: &[&str] = &[
    "context_length",
    "context_window",
    "max_context_length",
    "max_input_tokens",
];
const OUTPUT_KEYS: &[&str] = &[
    "max_completion_tokens",
    "max_output_tokens",
    "max_completion_length",
];

/// One limit off a listing entry, preferring the provider's own top-level field over `top_provider`.
fn listing_number(entry: &serde_json::Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| entry.get(*key).and_then(serde_json::Value::as_u64))
        .or_else(|| {
            let top = entry.get("top_provider")?;
            keys.iter()
                .find_map(|key| top.get(*key).and_then(serde_json::Value::as_u64))
        })
}

/// Keep a credential out of an error body that is echoed back to the renderer.
fn redact(message: &str, key: Option<&str>) -> String {
    match key.filter(|key| key.len() >= 8) {
        Some(key) => message.replace(key, "***"),
        None => message.to_owned(),
    }
}

fn truncate(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    value.chars().take(limit).collect()
}

fn list_document(doc: &DocumentMut) -> ProviderList {
    let names = doc.get("desktop_provider_names").and_then(Item::as_table);
    let all_models = read_models(doc);
    let mut providers = Vec::new();
    if let Some(entries) = doc.get("model_providers").and_then(Item::as_table) {
        for (id, item) in entries.iter() {
            let Some(table) = item.as_table() else {
                continue;
            };
            let inline = string(table, "api_key").filter(|value| !value.trim().is_empty());
            let env_key = string(table, "env_key").filter(|value| !value.trim().is_empty());
            let env_key_present = env_key
                .as_deref()
                .is_some_and(|key| std::env::var(key).is_ok_and(|value| !value.trim().is_empty()));
            let extra_headers = table
                .get("extra_headers")
                .and_then(Item::as_table)
                .map(|headers| {
                    headers
                        .iter()
                        .filter_map(|(key, value)| {
                            value
                                .as_str()
                                .map(|value| (key.to_owned(), value.to_owned()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            providers.push(ProviderView {
                id: id.to_owned(),
                name: names
                    .and_then(|names| names.get(id))
                    .and_then(Item::as_str)
                    .map(str::to_owned),
                base_url: string(table, "base_url"),
                api_backend: string(table, "api_backend"),
                has_key: inline.is_some() || env_key.is_some(),
                inline_key: inline.is_some(),
                key_hint: inline.as_deref().and_then(key_hint),
                env_key,
                env_key_present,
                extra_headers,
                models: all_models
                    .iter()
                    .filter(|model| model.provider == id)
                    .cloned()
                    .collect(),
            });
        }
    }
    let default_model = doc
        .get("models")
        .and_then(Item::as_table)
        .and_then(|models| models.get("default"))
        .and_then(Item::as_str)
        .map(str::to_owned);
    ProviderList {
        providers,
        models: all_models,
        default_model,
    }
}

pub fn upsert_provider(request: ProviderUpsert) -> Result<(), String> {
    validate_provider(&request)?;
    update(|doc| {
        let providers = child_table(doc, "model_providers")?;
        if !providers.contains_key(&request.id) {
            providers.insert(&request.id, Item::Table(Table::new()));
        }
        let provider = providers
            .get_mut(&request.id)
            .and_then(Item::as_table_mut)
            .ok_or_else(|| format!("[model_providers.{}] must be a table", request.id))?;
        provider.insert("base_url", toml_edit::value(request.base_url.trim()));
        provider.insert(
            "api_backend",
            toml_edit::value(request.api_backend.as_str()),
        );
        if request.extra_headers.is_empty() {
            provider.remove("extra_headers");
        } else {
            let mut headers = Table::new();
            for (name, value) in &request.extra_headers {
                headers.insert(name, toml_edit::value(value.as_str()));
            }
            provider.insert("extra_headers", Item::Table(headers));
        }
        if let Some(key) = request
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|key| !key.is_empty())
        {
            provider.insert("api_key", toml_edit::value(key));
            provider.remove("env_key");
        } else if let Some(name) = request
            .env_key
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            provider.insert("env_key", toml_edit::value(name));
            provider.remove("api_key");
        }

        let names = child_table(doc, "desktop_provider_names")?;
        match request
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => {
                names.insert(&request.id, toml_edit::value(name));
            }
            None => {
                names.remove(&request.id);
            }
        }

        let models = child_table(doc, "model")?;
        for seed in &request.models {
            write_model(
                models,
                &seed.id,
                &seed.model,
                Some(&request.id),
                Some(&seed.name),
                &seed.input,
                seed.context_window,
                seed.max_completion_tokens,
            )?;
        }
        if request.set_as_default {
            if let Some(first) = request.models.first() {
                child_table(doc, "models")?.insert("default", toml_edit::value(first.id.as_str()));
            }
        }
        Ok(())
    })
}

pub fn upsert_model(request: ModelUpsert) -> Result<(), String> {
    validate_model(&request)?;
    update(|doc| {
        let existing = doc
            .get("model")
            .and_then(Item::as_table)
            .and_then(|models| models.get(&request.id))
            .and_then(Item::as_table);
        let api_model = request
            .model
            .as_deref()
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .or_else(|| {
                existing
                    .and_then(|model| model.get("model"))
                    .and_then(Item::as_str)
            })
            .unwrap_or(request.id.as_str())
            .to_owned();
        let provider = request
            .provider_id
            .as_deref()
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                existing
                    .and_then(|model| model.get("model_provider"))
                    .and_then(Item::as_str)
                    .map(str::to_owned)
            });
        let models = child_table(doc, "model")?;
        write_model(
            models,
            &request.id,
            &api_model,
            provider.as_deref().filter(|provider| *provider != "xai"),
            request.name.as_deref(),
            &request.input,
            request.context_window,
            request.max_completion_tokens,
        )
    })
}

pub fn delete_model(model_id: &str) -> Result<(), String> {
    let model_id = checked_id(model_id, "model id")?.to_owned();
    update(|doc| {
        let current = doc
            .get("models")
            .and_then(Item::as_table)
            .and_then(|models| models.get("default"))
            .and_then(Item::as_str);
        if current == Some(model_id.as_str()) {
            return Err(format!(
                "refusing to delete `{model_id}`: select another default model first"
            ));
        }
        let models = doc
            .get_mut("model")
            .and_then(Item::as_table_mut)
            .ok_or_else(|| "no configured models".to_owned())?;
        if models.remove(&model_id).is_none() {
            return Err(format!("model `{model_id}` is not configured"));
        }
        Ok(())
    })
}

pub fn delete_provider(id: &str, replacement: Option<&str>) -> Result<(), String> {
    let id = checked_id(id, "provider id")?.to_owned();
    update(|doc| {
        let removed: Vec<String> = read_models(doc)
            .into_iter()
            .filter(|model| model.provider == id)
            .map(|model| model.id)
            .collect();
        let current = doc
            .get("models")
            .and_then(Item::as_table)
            .and_then(|models| models.get("default"))
            .and_then(Item::as_str)
            .map(str::to_owned);
        if current
            .as_ref()
            .is_some_and(|current| removed.contains(current))
        {
            let replacement = replacement.map(str::trim).filter(|value| !value.is_empty()).ok_or_else(|| {
                format!("removing `{id}` would leave the default model dangling; choose a replacement")
            })?;
            child_table(doc, "models")?.insert("default", toml_edit::value(replacement));
        }
        let providers = doc
            .get_mut("model_providers")
            .and_then(Item::as_table_mut)
            .ok_or_else(|| "no configured providers".to_owned())?;
        if providers.remove(&id).is_none() {
            return Err(format!("provider `{id}` is not configured"));
        }
        if let Some(models) = doc.get_mut("model").and_then(Item::as_table_mut) {
            for model in removed {
                models.remove(&model);
            }
        }
        if let Some(names) = doc
            .get_mut("desktop_provider_names")
            .and_then(Item::as_table_mut)
        {
            names.remove(&id);
        }
        Ok(())
    })
}

pub fn set_default_model(model_id: &str) -> Result<(), String> {
    let model_id = checked_id(model_id, "model id")?;
    update(|doc| {
        child_table(doc, "models")?.insert("default", toml_edit::value(model_id));
        Ok(())
    })
}

fn read_models(doc: &DocumentMut) -> Vec<ModelView> {
    let Some(models) = doc.get("model").and_then(Item::as_table) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|(id, item)| {
            let table = item.as_table()?;
            let provider = string(table, "model_provider").unwrap_or_else(|| "xai".to_owned());
            Some(ModelView {
                id: id.to_owned(),
                model: string(table, "model"),
                provider,
                name: string(table, "name"),
                input: table
                    .get("input")
                    .and_then(Item::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_else(|| vec!["text".to_owned()]),
                context_window: integer(table, "context_window")
                    .and_then(|value| u64::try_from(value).ok()),
                max_completion_tokens: integer(table, "max_completion_tokens")
                    .and_then(|value| u32::try_from(value).ok()),
                supports_reasoning_effort: table
                    .get("supports_reasoning_effort")
                    .and_then(Item::as_bool),
            })
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn write_model(
    models: &mut Table,
    id: &str,
    api_model: &str,
    provider: Option<&str>,
    name: Option<&str>,
    input: &[String],
    context_window: Option<u64>,
    max_completion_tokens: Option<u32>,
) -> Result<(), String> {
    let id = checked_id(id, "model id")?;
    if !models.contains_key(id) {
        models.insert(id, Item::Table(Table::new()));
    }
    let table = models
        .get_mut(id)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| format!("[model.{id}] must be a table"))?;
    table.insert("model", toml_edit::value(api_model.trim()));
    match provider {
        Some(value) => {
            table.insert("model_provider", toml_edit::value(value));
        }
        None => {
            table.remove("model_provider");
        }
    }
    match name.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            table.insert("name", toml_edit::value(value));
        }
        None => {
            table.remove("name");
        }
    }
    let modalities = input.iter().map(|value| Value::from(value.as_str()));
    table.insert("input", toml_edit::value(Array::from_iter(modalities)));
    if let Some(value) = context_window {
        table.insert(
            "context_window",
            toml_edit::value(i64::try_from(value).map_err(|_| "context window is too large")?),
        );
    }
    if let Some(value) = max_completion_tokens {
        table.insert("max_completion_tokens", toml_edit::value(i64::from(value)));
    }
    Ok(())
}

fn validate_provider(request: &ProviderUpsert) -> Result<(), String> {
    checked_id(&request.id, "provider id")?;
    if request
        .name
        .as_deref()
        .is_some_and(|name| name.trim().chars().count() > 80)
    {
        return Err("provider name must be at most 80 characters".to_owned());
    }
    if !(request.base_url.starts_with("http://") || request.base_url.starts_with("https://")) {
        return Err("base URL must start with http:// or https://".to_owned());
    }
    if !matches!(
        request.api_backend.as_str(),
        "chat_completions" | "responses" | "messages"
    ) {
        return Err("unsupported API backend".to_owned());
    }
    if request
        .api_key
        .as_deref()
        .is_some_and(|key| !key.trim().is_empty())
        && request
            .env_key
            .as_deref()
            .is_some_and(|key| !key.trim().is_empty())
    {
        return Err("use either an API key or environment variable".to_owned());
    }
    for model in &request.models {
        validate_modalities(&model.input)?;
    }
    Ok(())
}

fn validate_model(request: &ModelUpsert) -> Result<(), String> {
    checked_id(&request.id, "model id")?;
    if request
        .name
        .as_deref()
        .is_some_and(|name| name.trim().chars().count() > 120)
    {
        return Err("model name must be at most 120 characters".to_owned());
    }
    if request.context_window == Some(0) {
        return Err("context window must be greater than zero".to_owned());
    }
    if request.max_completion_tokens == Some(0) {
        return Err("output limit must be greater than zero".to_owned());
    }
    validate_modalities(&request.input)
}

fn validate_modalities(input: &[String]) -> Result<(), String> {
    if input.is_empty() {
        return Err("select at least one input modality".to_owned());
    }
    if let Some(value) = input
        .iter()
        .find(|value| !matches!(value.as_str(), "text" | "image"))
    {
        return Err(format!("unsupported input modality `{value}`"));
    }
    Ok(())
}

fn checked_id<'a>(id: &'a str, label: &str) -> Result<&'a str, String> {
    let value = id.trim();
    if value.is_empty() {
        return Err(format!("{label} must not be empty"));
    }
    if value.chars().count() > 160 {
        return Err(format!("{label} is too long"));
    }
    Ok(value)
}

fn string(table: &Table, key: &str) -> Option<String> {
    table.get(key).and_then(Item::as_str).map(str::to_owned)
}
fn integer(table: &Table, key: &str) -> Option<i64> {
    table.get(key).and_then(Item::as_integer)
}

fn key_hint(key: &str) -> Option<String> {
    let chars: Vec<char> = key.chars().collect();
    (chars.len() >= 12).then(|| {
        let first: String = chars[..4].iter().collect();
        let last: String = chars[chars.len() - 4..].iter().collect();
        format!("{first}…{last}")
    })
}

fn config_home() -> PathBuf {
    std::env::var_os("THANH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".thanh")))
        .unwrap_or_else(|| PathBuf::from(".thanh"))
}
fn config_path() -> PathBuf {
    config_home().join("config.toml")
}

fn load() -> Result<DocumentMut, String> {
    let path = config_path();
    match fs::read_to_string(&path) {
        Ok(source) if source.trim().is_empty() => Ok(DocumentMut::new()),
        Ok(source) => source
            .parse()
            .map_err(|error| format!("{} is invalid TOML: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DocumentMut::new()),
        Err(error) => Err(format!("could not read {}: {error}", path.display())),
    }
}

fn update(edit: impl FnOnce(&mut DocumentMut) -> Result<(), String>) -> Result<(), String> {
    let home = config_home();
    fs::create_dir_all(&home)
        .map_err(|error| format!("could not create {}: {error}", home.display()))?;
    let lock_path = home.join(".config-init.lock");
    let lock = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("could not open config lock: {error}"))?;
    acquire_config_lock(&lock, &lock_path)?;
    let mut doc = load()?;
    edit(&mut doc)?;
    atomic_write(&config_path(), doc.to_string().as_bytes())
}

fn acquire_config_lock(lock: &File, path: &Path) -> Result<(), String> {
    for _ in 0..50 {
        match lock.try_lock_exclusive() {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => return Err(format!("could not lock {}: {error}", path.display())),
        }
    }
    Err(format!("timed out waiting for {} after 1s", path.display()))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = path.with_extension(format!("toml.{}.{}.tmp", std::process::id(), nonce));
    let result = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("could not create temporary config: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("could not secure temporary config: {error}"))?;
        }
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("could not write config: {error}"))?;
        fs::rename(&temp, path)
            .map_err(|error| format!("could not replace {}: {error}", path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn child_table<'a>(doc: &'a mut DocumentMut, key: &str) -> Result<&'a mut Table, String> {
    if !doc.contains_key(key) {
        let mut table = Table::new();
        table.set_implicit(true);
        doc.insert(key, Item::Table(table));
    }
    doc.get_mut(key)
        .and_then(Item::as_table_mut)
        .ok_or_else(|| format!("`{key}` must be a table"))
}

#[cfg(test)]
mod tests {
    use super::{child_table, key_hint, list_document, parse_models_listing, redact};

    #[test]
    fn models_listing_reads_openai_and_top_provider_limits() {
        let listing = serde_json::json!({
            "data": [
                {"id": "stealth/union-alpha", "name": "Union Alpha", "context_length": 262_144,
                 "top_provider": {"context_length": 262_144, "max_completion_tokens": 131_072}},
                {"id": "deepseek-chat", "max_output_tokens": 8_192},
                {"id": "stealth/union-alpha"}
            ]
        });
        let models = parse_models_listing(&listing);
        assert_eq!(models.len(), 2, "duplicate ids collapse: {models:?}");
        assert_eq!(models[0].id, "stealth/union-alpha");
        assert_eq!(models[0].name.as_deref(), Some("Union Alpha"));
        assert_eq!(models[0].context_window, Some(262_144));
        assert_eq!(models[0].max_completion_tokens, Some(131_072));
        assert_eq!(models[1].context_window, None);
        assert_eq!(models[1].max_completion_tokens, Some(8_192));
    }

    #[test]
    fn models_listing_reads_google_and_bare_arrays() {
        let google = serde_json::json!({"models": [{"name": "models/gemini-2.5-pro"}]});
        let models = parse_models_listing(&google);
        assert_eq!(models[0].id, "gemini-2.5-pro");
        assert_eq!(models[0].name, None, "the wire name is not a display name");

        let bare = serde_json::json!([{"id": "kimi-k3"}]);
        assert_eq!(parse_models_listing(&bare)[0].id, "kimi-k3");
        assert!(parse_models_listing(&serde_json::json!({"error": "nope"})).is_empty());
    }

    #[test]
    fn probe_errors_never_echo_the_credential() {
        let message = "HTTP 401: invalid key sk-live-0123456789abcd rejected";
        let redacted = redact(message, Some("sk-live-0123456789abcd"));
        assert!(!redacted.contains("sk-live-0123456789abcd"), "{redacted}");
        assert_eq!(redact("no key here", None), "no key here");
    }

    #[test]
    fn key_hint_is_first_four_last_four_only() {
        assert_eq!(
            key_hint("sk-live-0123456789abcd").as_deref(),
            Some("sk-l…abcd")
        );
        assert_eq!(key_hint("short"), None);
    }

    #[test]
    fn config_snapshot_detects_inline_keys_and_model_limits() {
        let source = r#"
[models]
default = "deepseek/deepseek-flash"

[model."deepseek/deepseek-flash"]
model = "deepseek-flash"
model_provider = "deepseek"
name = "DeepSeek Flash"
context_window = 300000
max_completion_tokens = 64000
input = ["text"]

[model_providers.deepseek]
base_url = "https://api.deepseek.com"
api_key = "sk-live-0123456789abcd"
api_backend = "chat_completions"
"#;
        let doc = source.parse().expect("fixture TOML");
        let snapshot = list_document(&doc);
        let provider = snapshot
            .providers
            .iter()
            .find(|provider| provider.id == "deepseek")
            .expect("provider");
        assert!(provider.has_key);
        assert!(provider.inline_key);
        assert_eq!(provider.key_hint.as_deref(), Some("sk-l…abcd"));
        assert_eq!(provider.models[0].context_window, Some(300_000));
        assert_eq!(provider.models[0].max_completion_tokens, Some(64_000));
        assert_eq!(
            snapshot.default_model.as_deref(),
            Some("deepseek/deepseek-flash")
        );
    }

    #[test]
    fn desktop_provider_names_render_as_their_own_table() {
        let mut doc = toml_edit::DocumentMut::new();
        child_table(&mut doc, "desktop_provider_names")
            .expect("table")
            .insert("deepseek", toml_edit::value("Work DeepSeek"));
        let rendered = doc.to_string();
        assert!(rendered.contains("[desktop_provider_names]"), "{rendered}");
        assert!(
            rendered.contains("deepseek = \"Work DeepSeek\""),
            "{rendered}"
        );
    }
}
