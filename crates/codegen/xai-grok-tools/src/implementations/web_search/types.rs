use indexmap::IndexMap;

/// Which wire carries the `web_search` tool for a model.
///
/// `Inherit` is the model-entry default: the wire is derived from the entry's `api_backend`
/// and `supports_backend_search`. `Off` forces the tool off for that entry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchWire {
    /// Derive from `api_backend`: `messages` for the Messages API, `responses` when the entry
    /// also sets `supports_backend_search`, off otherwise.
    #[default]
    Inherit,
    Off,
    /// Server tool `web_search_20250305` on the Anthropic-compatible Messages endpoint.
    Messages,
    /// Hosted `web_search` on the Responses API.
    Responses,
}

impl WebSearchWire {
    /// The wire this entry uses once `Inherit` is resolved against its backend flags.
    pub fn resolve(self, messages_backend: bool, supports_backend_search: bool) -> Self {
        match self {
            Self::Inherit if messages_backend => Self::Messages,
            Self::Inherit if supports_backend_search => Self::Responses,
            Self::Inherit => Self::Off,
            other => other,
        }
    }
}

/// Configuration for the web search tool. Use `Disabled` when no API key is available or web search should be turned off. The `Enabled` variant
/// is inherently large (credentials, headers, domain filters) while `Disabled` is empty, but this config is built once per session and never
/// stored in bulk collections, so boxing would add indirection for no real benefit.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum WebSearchConfig {
    #[default]
    Disabled,
    Enabled {
        /// Wire the search runs on. Serialized for callers that persist the config; absent means `responses`.
        #[serde(default, skip_serializing_if = "is_responses_wire")]
        wire: WebSearchWire,
        /// Whether the Responses call may authenticate with the live session bearer instead of
        /// `api_key`. True only for first-party xAI routes (`api.x.ai`, the CLI chat proxy); a
        /// third-party BYOK Responses endpoint must be authenticated with its own key, or the
        /// session JWT is leaked to it and its key is displaced.
        #[serde(default)]
        use_session_bearer: bool,
        api_key: String,
        base_url: String,
        model: String,
        #[serde(default, skip_serializing_if = "IndexMap::is_empty")]
        extra_headers: IndexMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        alpha_test_key: Option<String>,
        /// Authoritative domain allowlist from `[toolset.web_search] allowed_domains`. When set, it governs the client-side
        /// web_search tool and the model's own per-call `allowed_domains` is ignored (see `resolve_filters`), so a configured
        /// policy cannot be bypassed. Mutually exclusive with `excluded_domains`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allowed_domains: Option<Vec<String>>,
        /// Authoritative domain blocklist from `[toolset.web_search] excluded_domains`. Like `allowed_domains` it governs
        /// outright: the model cannot un-block a domain by naming it in its own per-call `allowed_domains`, which is what makes
        /// this a real block. Mutually exclusive with `allowed_domains`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        excluded_domains: Option<Vec<String>>,
    },
}

fn is_responses_wire(wire: &WebSearchWire) -> bool {
    *wire == WebSearchWire::Responses
}

impl WebSearchConfig {
    /// Returns `true` when the config is the `Enabled` variant.
    pub fn is_enabled(&self) -> bool {
        matches!(self, Self::Enabled { .. })
    }

    /// Wire this config runs on; `Disabled` has none.
    pub fn wire(&self) -> Option<WebSearchWire> {
        match self {
            Self::Enabled { wire, .. } => Some(*wire),
            Self::Disabled => None,
        }
    }

    /// Return a copy safe for returning to clients. The `api_key` is replaced with
    /// `"***REDACTED***"` and the optional extra access key field is stripped.
    pub fn redacted(&self) -> Self {
        match self {
            Self::Disabled => Self::Disabled,
            Self::Enabled {
                wire,
                use_session_bearer,
                base_url,
                model,
                extra_headers,
                allowed_domains,
                excluded_domains,
                ..
            } => Self::Enabled {
                wire: *wire,
                use_session_bearer: *use_session_bearer,
                api_key: "***REDACTED***".to_string(),
                base_url: base_url.clone(),
                model: model.clone(),
                extra_headers: extra_headers.clone(),
                alpha_test_key: None,
                allowed_domains: allowed_domains.clone(),
                excluded_domains: excluded_domains.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_default_is_disabled() {
        let config = WebSearchConfig::default();
        assert!(!config.is_enabled());
    }

    #[test]
    fn test_config_redacted() {
        let mut headers = IndexMap::new();
        headers.insert("X-Custom".to_string(), "value".to_string());
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: true,
            api_key: "secret-key-12345".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "test-web-search-model".to_string(),
            extra_headers: headers,
            alpha_test_key: Some("alpha-secret".to_string()),
            allowed_domains: Some(vec!["docs.x.ai".to_string()]),
            excluded_domains: None,
        };
        let redacted = config.redacted();
        match redacted {
            WebSearchConfig::Enabled {
                wire,
                use_session_bearer,
                api_key,
                base_url,
                model,
                extra_headers,
                alpha_test_key,
                allowed_domains,
                excluded_domains,
            } => {
                assert_eq!(wire, WebSearchWire::Responses);
                assert!(
                    use_session_bearer,
                    "the bearer switch is routing policy, not a secret, and survives redaction"
                );
                assert_eq!(api_key, "***REDACTED***");
                assert_eq!(base_url, "https://api.x.ai/v1");
                assert_eq!(model, "test-web-search-model");
                assert_eq!(extra_headers.get("X-Custom").unwrap(), "value");
                assert!(alpha_test_key.is_none());
                // Domain filters survive redaction (not secrets).
                assert_eq!(allowed_domains, Some(vec!["docs.x.ai".to_string()]));
                assert!(excluded_domains.is_none());
            }
            _ => panic!("Expected Enabled variant"),
        }
    }

    #[test]
    fn test_config_serde_roundtrip() {
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Messages,
            use_session_bearer: false,
            api_key: "key".to_string(),
            base_url: "https://api.deepseek.com/anthropic/v1".to_string(),
            model: "deepseek-flash".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: WebSearchConfig = serde_json::from_str(&json).unwrap();
        assert!(parsed.is_enabled());
        assert_eq!(parsed.wire(), Some(WebSearchWire::Messages));
        assert!(json.contains("\"wire\":\"messages\""));
    }

    #[test]
    fn inherit_wire_derives_from_backend_flags() {
        assert_eq!(
            WebSearchWire::Inherit.resolve(true, false),
            WebSearchWire::Messages
        );
        assert_eq!(
            WebSearchWire::Inherit.resolve(false, true),
            WebSearchWire::Responses
        );
        assert_eq!(
            WebSearchWire::Inherit.resolve(false, false),
            WebSearchWire::Off
        );
        assert_eq!(
            WebSearchWire::Off.resolve(true, true),
            WebSearchWire::Off,
            "an explicit Off is not overridden by backend flags"
        );
    }

    #[test]
    fn responses_wire_is_omitted_from_serialized_config() {
        let config = WebSearchConfig::Enabled {
            wire: WebSearchWire::Responses,
            use_session_bearer: false,
            api_key: "key".to_string(),
            base_url: "https://api.x.ai/v1".to_string(),
            model: "m".to_string(),
            extra_headers: IndexMap::new(),
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(
            !json.contains("\"wire\""),
            "responses is the default wire and stays off the wire; got {json}"
        );
    }

    #[test]
    fn test_config_deserialize_from_set_options_payload() {
        let json = r#"{
            "status": "enabled",
            "api_key": "xai-abc123",
            "base_url": "https://api.x.ai/v1",
            "model": "test-web-search-model"
        }"#;
        let config: WebSearchConfig = serde_json::from_str(json).unwrap();
        assert!(config.is_enabled());
    }
}
