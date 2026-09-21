//! ChatGPT Codex Responses endpoint compatibility.
//!
//! Quirks are gated **only** by the Codex base URL so Platform OpenAI
//! (`api.openai.com`), xAI Responses, chat_completions, and local providers keep
//! today's behavior. Call sites should go through these helpers instead of
//! scattering `if base_url == …` checks.

/// ChatGPT OAuth / Codex backend (not the Platform OpenAI API).
pub const CHATGPT_CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";

/// True when `base_url` is the ChatGPT Codex Responses host (trailing slash ignored).
pub fn is_chatgpt_codex_endpoint(base_url: &str) -> bool {
    base_url.trim_end_matches('/') == CHATGPT_CODEX_BASE_URL
}

/// `GET …/models` URL. Codex requires `client_version`; every other host stays plain.
pub fn models_list_url(base_url: &str, client_version: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if is_chatgpt_codex_endpoint(base) {
        format!("{base}/models?client_version={client_version}")
    } else {
        format!("{base}/models")
    }
}

/// Codex rejects `max_output_tokens`; clear it only for that endpoint.
pub fn clear_max_output_tokens_if_codex(base_url: &str, max_output_tokens: &mut Option<u32>) {
    if is_chatgpt_codex_endpoint(base_url) {
        *max_output_tokens = None;
    }
}

/// Credential-probe body for `api_backend = "responses"`.
///
/// Uses structured `input` (portable). Omits `max_output_tokens` on Codex, which
/// rejects that field; other Responses hosts still get a small token cap.
pub fn responses_probe_body(model: &str, base_url: &str) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "input": [{
            "role": "user",
            "content": [{"type": "input_text", "text": "ping"}]
        }],
    });
    if !is_chatgpt_codex_endpoint(base_url) {
        body["max_output_tokens"] = serde_json::json!(16);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_codex_url_with_or_without_trailing_slash() {
        assert!(is_chatgpt_codex_endpoint(CHATGPT_CODEX_BASE_URL));
        assert!(is_chatgpt_codex_endpoint(&format!("{CHATGPT_CODEX_BASE_URL}/")));
        assert!(!is_chatgpt_codex_endpoint("https://api.openai.com/v1"));
        assert!(!is_chatgpt_codex_endpoint("https://cli-chat-proxy.grok.com/v1"));
    }

    #[test]
    fn models_list_url_adds_client_version_only_for_codex() {
        assert_eq!(
            models_list_url(CHATGPT_CODEX_BASE_URL, "1.0.39"),
            format!("{CHATGPT_CODEX_BASE_URL}/models?client_version=1.0.39")
        );
        assert_eq!(
            models_list_url("https://api.openai.com/v1/", "1.0.39"),
            "https://api.openai.com/v1/models"
        );
    }

    #[test]
    fn clears_max_output_tokens_only_for_codex() {
        let mut tokens = Some(64u32);
        clear_max_output_tokens_if_codex("https://api.openai.com/v1", &mut tokens);
        assert_eq!(tokens, Some(64));
        clear_max_output_tokens_if_codex(CHATGPT_CODEX_BASE_URL, &mut tokens);
        assert_eq!(tokens, None);
    }

    #[test]
    fn responses_probe_omits_max_output_tokens_on_codex() {
        let codex = responses_probe_body("gpt-5.6-luna", CHATGPT_CODEX_BASE_URL);
        assert!(codex.get("max_output_tokens").is_none());
        let platform = responses_probe_body("gpt-5", "https://api.openai.com/v1");
        assert_eq!(platform.get("max_output_tokens"), Some(&serde_json::json!(16)));
    }
}
