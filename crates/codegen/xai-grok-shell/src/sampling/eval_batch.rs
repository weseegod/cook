//! Batch API gate for offline eval calls (design doc section 9).
//!
//! Ordinary interactive turns never read [`ModelInfo::supports_batch_api`]. Offline
//! eval callers use a frozen snapshot whose next line does not edit a live tree.
//! This module encodes the gate:
//! the flag must be on, the call must not gate the next tool step, and nobody
//! may be waiting on a stream or a permission prompt. The prompt-identity rule
//! is enforced by construction: the batch body's messages are built from the
//! same conversation items the realtime path would send, via
//! [`conversation_to_chat_messages`] — never a reduced or re-summarized copy.

use crate::agent::config::ModelInfo;
use crate::sampling::{ChatCompletionRequest, ToolDefinition, conversation_to_chat_messages};
use xai_grok_sampling_types::conversation::ConversationItem;

/// The design-doc section 9 conditions the caller must attest to, beyond the flag itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EvalBatchConditions {
    /// The call does not gate the next tool step: the loop can proceed while the job waits.
    pub gates_next_tool_step: bool,
    /// Nobody is waiting on a stream from this call.
    pub waiting_on_stream: bool,
    /// No permission prompt is open that this call would block on.
    pub permission_prompt_open: bool,
}

impl EvalBatchConditions {
    fn all_clear(self) -> bool {
        !(self.gates_next_tool_step || self.waiting_on_stream || self.permission_prompt_open)
    }
}

/// Build the Batch API request body for an offline eval call, or `None` when the gate is closed.
///
/// The gate is closed unless the resolved model has `supports_batch_api = true` and every
/// [`EvalBatchConditions`] attestation is clear. When open, the body carries the model slug and
/// the same folded messages the realtime Chat Completions path would send, plus the same tools
/// (`tool_choice` set only when tools are present, as Chat Completions rejects it otherwise).
pub fn eval_batch_request(
    model: &ModelInfo,
    realtime_items: Vec<ConversationItem>,
    tools: Vec<ToolDefinition>,
    conditions: EvalBatchConditions,
) -> Option<ChatCompletionRequest> {
    if !model.supports_batch_api || !conditions.all_clear() {
        return None;
    }
    let mut request = ChatCompletionRequest::new(
        model.model.clone(),
        conversation_to_chat_messages(realtime_items),
    );
    if !tools.is_empty() {
        request = request.with_tools(tools);
    }
    Some(request)
}

#[cfg(test)]
mod eval_batch_tests {
    use super::*;
    use crate::agent::config::{Config, resolve_model_list};
    use std::sync::Arc;
    use xai_grok_sampling_types::conversation::{ConversationItem, ToolResultItem};

    /// Resolve a model through the real `Config::new_from_toml_cfg` + `resolve_model_list`
    /// pipeline so the flag is read from config the way any caller would read it.
    fn resolve_model(toml_body: &str) -> ModelInfo {
        let raw_config: toml::Value = toml::from_str(toml_body).unwrap();
        let cfg = Config::new_from_toml_cfg(&raw_config).expect("config should parse");
        let resolved = resolve_model_list(&cfg, None);
        resolved
            .get("local/bonsai2")
            .expect("model should exist")
            .info
            .clone()
    }

    /// A frozen realtime snapshot: user ask, a tool result holding evidence lines, and a follow-up.
    fn realtime_items() -> Vec<ConversationItem> {
        vec![
            ConversationItem::user("read the file and tell me what changed"),
            ConversationItem::ToolResult(ToolResultItem {
                tool_call_id: "call_1".to_string(),
                content: Arc::<str>::from("evidence line one\nevidence line two"),
                images: Vec::new(),
                provenance: Default::default(),
            }),
            ConversationItem::user("summarize the evidence"),
        ]
    }

    fn realtime_tools() -> Vec<ToolDefinition> {
        vec![
            ToolDefinition::function("read_file", Some("Read a file"), serde_json::json!({})),
            ToolDefinition::function("grep", Some("Search a tree"), serde_json::json!({})),
        ]
    }

    const MODEL_ON: &str = r#"
        [model."local/bonsai2"]
        model = "bonsai2"
        base_url = "http://127.0.0.1:8080/v1"
        context_window = 32768
        supports_batch_api = true
    "#;

    const MODEL_OFF: &str = r#"
        [model."local/bonsai2"]
        model = "bonsai2"
        base_url = "http://127.0.0.1:8080/v1"
        context_window = 32768
    "#;

    fn clear_conditions() -> EvalBatchConditions {
        EvalBatchConditions::default()
    }

    #[test]
    fn flag_false_builds_no_batch_body() {
        let model = resolve_model(MODEL_OFF);
        let body = eval_batch_request(
            &model,
            realtime_items(),
            realtime_tools(),
            clear_conditions(),
        );
        assert!(
            body.is_none(),
            "a model without supports_batch_api must not get a batch body",
        );
    }

    #[test]
    fn conditions_veto_even_with_flag_true() {
        let model = resolve_model(MODEL_ON);
        for conditions in [
            EvalBatchConditions {
                gates_next_tool_step: true,
                ..Default::default()
            },
            EvalBatchConditions {
                waiting_on_stream: true,
                ..Default::default()
            },
            EvalBatchConditions {
                permission_prompt_open: true,
                ..Default::default()
            },
        ] {
            let body = eval_batch_request(&model, realtime_items(), realtime_tools(), conditions);
            assert!(
                body.is_none(),
                "a section-9 condition failure must close the gate: {conditions:?}",
            );
        }
    }

    #[test]
    fn flag_true_body_carries_the_realtime_messages_and_tools() {
        let model = resolve_model(MODEL_ON);
        let items = realtime_items();
        let body = eval_batch_request(&model, items.clone(), realtime_tools(), clear_conditions())
            .expect("flag true with clear conditions must build a batch body");
        assert_eq!(body.model.as_deref(), Some("bonsai2"));
        // Prompt identity: the same folded messages the realtime path would send.
        let expected = conversation_to_chat_messages(items);
        let actual = serde_json::to_value(&body.messages).unwrap();
        let expected = serde_json::to_value(&expected).unwrap();
        assert_eq!(
            actual, expected,
            "batch body must carry the realtime messages verbatim"
        );
        // Evidence lines survive the fold.
        let flattened = actual.to_string();
        assert!(
            flattened.contains("evidence line one"),
            "evidence lines must survive"
        );
        assert!(
            flattened.contains("evidence line two"),
            "evidence lines must survive"
        );
        // Tools survive: every realtime tool is in the batch body.
        let tools = body.tools.expect("tools must be carried");
        let names: Vec<&str> = tools.iter().map(|t| t.function.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["read_file", "grep"],
            "batch body must not drop tools"
        );
    }
}
