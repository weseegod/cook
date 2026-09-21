//! ChatGPT and Claude OAuth for Settings → Models → Connect.
//!
//! Copied from Quac's `auth/src/{private_providers,provider_oauth}.rs`: ChatGPT uses Codex
//! device-auth (no paste); Claude uses PKCE and the user pastes the callback code. Grok stays
//! on the agent's `authenticate` / `x.ai/auth/*` flow so the session lands in `auth.json`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::provider_config::{self, ProviderUpsert};

const CHATGPT_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEVICE_POLL_DEADLINE: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone)]
enum PendingKind {
    Device,
    Pkce {
        verifier: String,
        state: String,
        token_url: String,
        redirect_uri: String,
        json_body: bool,
    },
}

#[derive(Debug, Clone)]
struct Pending {
    id: String,
    kind: PendingKind,
}

#[derive(Debug, Clone)]
enum Outcome {
    Pending,
    Token(String),
    Error(String),
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
static OUTCOME: Mutex<Outcome> = Mutex::new(Outcome::Pending);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthStart {
    id: String,
    mode: &'static str,
    authorize_url: String,
    user_code: Option<String>,
    needs_code: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthStatus {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub async fn start(id: String) -> Result<OauthStart, String> {
    match id.as_str() {
        "openai" => start_chatgpt().await,
        "anthropic" => start_claude().await,
        other => Err(format!("OAuth is not available for `{other}`")),
    }
}

pub async fn poll(id: String) -> Result<OauthStatus, String> {
    let outcome = OUTCOME.lock().map_err(|error| error.to_string())?.clone();
    match outcome {
        Outcome::Pending => Ok(OauthStatus { status: "pending", error: None }),
        Outcome::Error(error) => Ok(OauthStatus { status: "error", error: Some(error) }),
        Outcome::Token(token) => {
            persist_oauth(&id, &token)?;
            clear();
            Ok(OauthStatus { status: "connected", error: None })
        }
    }
}

pub async fn submit_code(id: String, code: String) -> Result<OauthStatus, String> {
    let pending = PENDING
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or_else(|| "no pending login".to_owned())?;
    if pending.id != id {
        return Err("no pending login for this provider".into());
    }
    let PendingKind::Pkce {
        verifier,
        state,
        token_url,
        redirect_uri,
        json_body,
    } = pending.kind
    else {
        return Err("this login does not take a pasted code".into());
    };
    let (authorization_code, pasted_state) = parse_paste(&code);
    let exchange_state = pasted_state.as_deref().unwrap_or(&state);
    let token = exchange_code(
        &token_url,
        &authorization_code,
        &verifier,
        &redirect_uri,
        if json_body { Some(exchange_state) } else { None },
        json_body,
        CLAUDE_CLIENT_ID,
    )
    .await?;
    persist_oauth(&id, &token)?;
    clear();
    Ok(OauthStatus { status: "connected", error: None })
}

pub fn cancel(_id: String) -> Result<(), String> {
    clear();
    Ok(())
}

pub fn logout(id: String) -> Result<(), String> {
    provider_config::clear_oauth(&id)
}

async fn start_chatgpt() -> Result<OauthStart, String> {
    clear();
    let http = crate::http::client();
    let response = http
        .post("https://auth.openai.com/api/accounts/deviceauth/usercode")
        .header("Accept", "application/json")
        .json(&serde_json::json!({ "client_id": CHATGPT_CLIENT_ID }))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status().as_u16();
    if status == 404 {
        return Err("ChatGPT device login is not enabled. Enable device code authorization in ChatGPT → Settings → Security, then try Connect again.".into());
    }
    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("ChatGPT device login failed (HTTP {status}): {body}"));
    }
    let value: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    let device_code = value
        .get("device_auth_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let user_code = value
        .get("user_code")
        .or_else(|| value.get("usercode"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    if device_code.is_empty() || user_code.is_empty() {
        return Err("ChatGPT returned an invalid device code".into());
    }
    let interval = value.get("interval").and_then(serde_json::Value::as_u64).unwrap_or(5).max(1);
    *PENDING.lock().map_err(|error| error.to_string())? = Some(Pending {
        id: "openai".into(),
        kind: PendingKind::Device,
    });
    *OUTCOME.lock().map_err(|error| error.to_string())? = Outcome::Pending;
    spawn_chatgpt_poller(device_code, user_code.clone(), interval);
    let authorize_url = format!("https://auth.openai.com/codex/device?user_code={user_code}");
    Ok(OauthStart {
        id: "openai".into(),
        mode: "device",
        authorize_url,
        user_code: Some(user_code),
        needs_code: false,
    })
}

async fn start_claude() -> Result<OauthStart, String> {
    clear();
    let (verifier, challenge) = pkce_pair();
    let state = random_state();
    let redirect_uri = "https://console.anthropic.com/oauth/code/callback";
    let authorize_url = format!(
        "https://claude.ai/oauth/authorize?response_type=code&client_id={CLAUDE_CLIENT_ID}&redirect_uri={}&scope={}&code_challenge={challenge}&code_challenge_method=S256&state={state}&code=true",
        urlencoding(&redirect_uri),
        urlencoding("org:create_api_key user:profile user:inference"),
    );
    *PENDING.lock().map_err(|error| error.to_string())? = Some(Pending {
        id: "anthropic".into(),
        kind: PendingKind::Pkce {
            verifier,
            state,
            token_url: "https://console.anthropic.com/v1/oauth/token".into(),
            redirect_uri: redirect_uri.into(),
            json_body: true,
        },
    });
    *OUTCOME.lock().map_err(|error| error.to_string())? = Outcome::Pending;
    Ok(OauthStart {
        id: "anthropic".into(),
        mode: "paste",
        authorize_url,
        user_code: None,
        needs_code: true,
    })
}

fn spawn_chatgpt_poller(device_code: String, user_code: String, interval_secs: u64) {
    tauri::async_runtime::spawn(async move {
        let result = poll_chatgpt(&device_code, &user_code, interval_secs).await;
        if let Ok(mut outcome) = OUTCOME.lock() {
            *outcome = match result {
                Ok(token) => Outcome::Token(token),
                Err(error) => Outcome::Error(error),
            };
        }
    });
}

async fn poll_chatgpt(device_code: &str, user_code: &str, interval_secs: u64) -> Result<String, String> {
    let http = crate::http::client();
    let interval = Duration::from_secs(interval_secs.max(1));
    let deadline = Instant::now() + DEVICE_POLL_DEADLINE;
    loop {
        let response = http
            .post("https://auth.openai.com/api/accounts/deviceauth/token")
            .header("Accept", "application/json")
            .json(&serde_json::json!({
                "device_auth_id": device_code,
                "user_code": user_code,
            }))
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        if status == 200 {
            let value: serde_json::Value =
                serde_json::from_str(&text).map_err(|error| error.to_string())?;
            let authorization_code = value
                .get("authorization_code")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            let verifier = value
                .get("code_verifier")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_owned();
            if authorization_code.is_empty() || verifier.is_empty() {
                return Err("ChatGPT device poll returned no authorization_code".into());
            }
            return exchange_code(
                "https://auth.openai.com/oauth/token",
                &authorization_code,
                &verifier,
                "https://auth.openai.com/deviceauth/callback",
                None,
                false,
                CHATGPT_CLIENT_ID,
            )
            .await;
        }
        if status == 403 || status == 404 {
            if Instant::now() > deadline {
                return Err("device code expired; connect again".into());
            }
            tokio::time::sleep(interval).await;
            continue;
        }
        return Err(format!("ChatGPT device poll failed (HTTP {status})"));
    }
}

async fn exchange_code(
    token_url: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    state: Option<&str>,
    json_body: bool,
    client_id: &str,
) -> Result<String, String> {
    let http = crate::http::client();
    let response = if json_body {
        let mut body = serde_json::json!({
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": redirect_uri,
            "code_verifier": verifier,
        });
        if let Some(state) = state {
            body["state"] = serde_json::json!(state);
        }
        http.post(token_url)
            .header("Accept", "application/json")
            .json(&body)
            .send()
            .await
    } else {
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("client_id", client_id),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
        ];
        if let Some(state) = state {
            form.push(("state", state));
        }
        http.post(token_url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form_encode(&form))
            .send()
            .await
    }
    .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("token exchange failed ({status}): {body}"));
    }
    let value: serde_json::Value = response.json().await.map_err(|error| error.to_string())?;
    value
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "token exchange returned no access_token".to_owned())
}

fn persist_oauth(id: &str, access_token: &str) -> Result<(), String> {
    provider_config::upsert_provider(ProviderUpsert::oauth(id, access_token))
}

fn clear() {
    if let Ok(mut pending) = PENDING.lock() {
        *pending = None;
    }
    if let Ok(mut outcome) = OUTCOME.lock() {
        *outcome = Outcome::Pending;
    }
}

fn pkce_pair() -> (String, String) {
    let mut raw = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut raw);
    let verifier = URL_SAFE_NO_PAD.encode(raw);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn random_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex_encode(&bytes)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn parse_paste(raw: &str) -> (String, Option<String>) {
    let trimmed = raw.trim();
    if let Ok(url) = reqwest::Url::parse(trimmed) {
        let mut code = String::new();
        let mut state = None;
        for (key, value) in url.query_pairs() {
            if key == "code" {
                code = value.into_owned();
            } else if key == "state" {
                state = Some(value.into_owned());
            }
        }
        if !code.is_empty() {
            return (code, state);
        }
    }
    if let Some((code, state)) = trimmed.split_once('#') {
        return (code.trim().to_string(), Some(state.trim().to_string()));
    }
    (trimmed.to_string(), None)
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", urlencoding(key), urlencoding(value)))
        .collect::<Vec<_>>()
        .join("&")
}

fn urlencoding(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*byte as char),
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}
