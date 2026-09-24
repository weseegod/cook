//! Estimated composition of one outbound model request, by component.
//!
//! `UsageLedger` records what a call *cost*; this records what the prompt it sent was *made of*.
//! The two answer different questions: the ledger says how many tokens were billed, and the
//! breakdown says which parts of the request produced them. Both are estimates in the same
//! bytes/4 units the context-budget code already uses — not provider tokenizer counts.

use xai_grok_sampling_types::{ConversationItem, ConversationRequest, SyntheticReason};

use crate::actor::state::{
    estimate_item_tokens, estimate_tool_specs_tokens, estimate_user_item_tokens,
};

/// Estimated token composition of one request.
///
/// Every bucket is filled from the item's type and, for user-shaped items, its
/// [`SyntheticReason`], so a component never has to be guessed from message text.
/// [`Self::total_tokens`] covers the request's items and its declared tool specs; hosted tools and
/// any provider-side framing are not estimated and are therefore outside the total.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RequestComponents {
    /// `System` items: the primary system prompt plus runtime-injected system messages.
    pub system_tokens: u64,
    /// The serialized `tools` specs carried on the request.
    pub tool_schema_tokens: u64,
    /// Text of user items the human typed.
    pub user_tokens: u64,
    /// Text of runtime-injected user items (reminders, project instructions, auto-continue).
    pub injected_tokens: u64,
    /// Text of compaction-injected user items (the compact summary, re-read file contents).
    pub compaction_meta_tokens: u64,
    /// Image parts across every user-shaped item **and every tool result**, at the shared
    /// per-image estimate. Wider than the budget estimator, which counts only user-item images;
    /// a tool result can carry inline images that the provider still bills.
    pub image_tokens: u64,
    /// Assistant text plus tool-call arguments.
    pub assistant_tokens: u64,
    /// Replayed reasoning.
    pub reasoning_tokens: u64,
    /// Tool results, including backend-hosted calls.
    pub tool_result_tokens: u64,
}

impl RequestComponents {
    /// Estimate one request's composition.
    pub fn from_request(request: &ConversationRequest) -> Self {
        let mut components = Self {
            tool_schema_tokens: estimate_tool_specs_tokens(&request.tools),
            ..Default::default()
        };
        for item in &request.items {
            match item {
                ConversationItem::System(_) => {
                    components.system_tokens += estimate_item_tokens(item)
                }
                ConversationItem::User(u) => {
                    let (text, images) = estimate_user_item_tokens(u);
                    components.image_tokens += images;
                    match u.synthetic_reason {
                        SyntheticReason::Human => components.user_tokens += text,
                        SyntheticReason::CompactionMeta => {
                            components.compaction_meta_tokens += text
                        }
                        _ => components.injected_tokens += text,
                    }
                }
                ConversationItem::Assistant(_) => {
                    components.assistant_tokens += estimate_item_tokens(item)
                }
                ConversationItem::Reasoning(_) => {
                    components.reasoning_tokens += estimate_item_tokens(item)
                }
                ConversationItem::BackendToolCall(_) => {
                    components.tool_result_tokens += estimate_item_tokens(item)
                }
                ConversationItem::ToolResult(tr) => {
                    components.tool_result_tokens += estimate_item_tokens(item);
                    components.image_tokens +=
                        xai_token_estimation::estimate_image_tokens(tr.images.len() as u64);
                }
            }
        }
        components
    }

    /// Sum of every bucket. Hosted tools are not included; see the type docs.
    pub fn total_tokens(&self) -> u64 {
        self.system_tokens
            .saturating_add(self.tool_schema_tokens)
            .saturating_add(self.user_tokens)
            .saturating_add(self.injected_tokens)
            .saturating_add(self.compaction_meta_tokens)
            .saturating_add(self.image_tokens)
            .saturating_add(self.assistant_tokens)
            .saturating_add(self.reasoning_tokens)
            .saturating_add(self.tool_result_tokens)
    }

    /// Add another request's composition into this one, bucket by bucket.
    /// Sums are meaningful because they cover the same set of calls the ledger's token
    /// totals cover, so a bucket's share of the total is comparable to the billed input.
    pub fn fold(&mut self, other: &Self) {
        self.system_tokens = self.system_tokens.saturating_add(other.system_tokens);
        self.tool_schema_tokens = self
            .tool_schema_tokens
            .saturating_add(other.tool_schema_tokens);
        self.user_tokens = self.user_tokens.saturating_add(other.user_tokens);
        self.injected_tokens = self.injected_tokens.saturating_add(other.injected_tokens);
        self.compaction_meta_tokens = self
            .compaction_meta_tokens
            .saturating_add(other.compaction_meta_tokens);
        self.image_tokens = self.image_tokens.saturating_add(other.image_tokens);
        self.assistant_tokens = self.assistant_tokens.saturating_add(other.assistant_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(other.reasoning_tokens);
        self.tool_result_tokens = self
            .tool_result_tokens
            .saturating_add(other.tool_result_tokens);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_grok_sampling_types::{ContentPart, ToolSpec, UserItem};

    fn user_with(reason: SyntheticReason, text: &str) -> ConversationItem {
        ConversationItem::User(UserItem {
            content: vec![ContentPart::Text {
                text: std::sync::Arc::<str>::from(text),
            }],
            synthetic_reason: reason,
            cwd_generation: None,
            prior_turn_interrupt: None,
            prompt_index: None,
        })
    }

    fn request(items: Vec<ConversationItem>, tools: Vec<ToolSpec>) -> ConversationRequest {
        ConversationRequest {
            items,
            tools,
            ..Default::default()
        }
    }

    fn tool(name: &str, description: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_string(),
            description: Some(description.to_string()),
            parameters: serde_json::json!({"type": "object"}),
        }
    }

    #[test]
    fn components_split_by_item_type_and_synthetic_reason() {
        let system = "you are an agent";
        let human = "fix the bug";
        let reminder = "<system-reminder>plan mode";
        let summary = "summary of earlier work";
        let assistant = "looking at it";
        let result = "file contents";

        let components = RequestComponents::from_request(&request(
            vec![
                ConversationItem::system(system),
                user_with(SyntheticReason::Human, human),
                user_with(SyntheticReason::SystemReminder, reminder),
                user_with(SyntheticReason::CompactionMeta, summary),
                ConversationItem::assistant(assistant),
                ConversationItem::ToolResult(xai_grok_sampling_types::ToolResultItem {
                    tool_call_id: "call_1".to_string(),
                    content: std::sync::Arc::<str>::from(result),
                    images: Vec::new(),
                    ..Default::default()
                }),
            ],
            vec![tool("read_file", "read a file")],
        ));

        // Four bytes per token, asserted against each literal's own length so the test pins the
        // bucket assignment rather than re-deriving the arithmetic.
        let tokens = |s: &str| s.len() as u64 / 4;
        assert_eq!(components.system_tokens, tokens(system));
        assert_eq!(components.user_tokens, tokens(human));
        assert_eq!(components.injected_tokens, tokens(reminder));
        assert_eq!(components.compaction_meta_tokens, tokens(summary));
        assert_eq!(components.assistant_tokens, tokens(assistant));
        assert_eq!(components.tool_result_tokens, tokens(result));
        assert!(components.tool_schema_tokens > 0);
        assert_eq!(components.image_tokens, 0);
        assert_eq!(components.reasoning_tokens, 0);
        assert_eq!(
            components.total_tokens(),
            components.system_tokens
                + components.tool_schema_tokens
                + components.user_tokens
                + components.injected_tokens
                + components.compaction_meta_tokens
                + components.assistant_tokens
                + components.tool_result_tokens
        );
    }

    #[test]
    fn tool_result_images_are_counted() {
        let components = RequestComponents::from_request(&request(
            vec![ConversationItem::ToolResult(
                xai_grok_sampling_types::ToolResultItem {
                    tool_call_id: "call_1".to_string(),
                    content: std::sync::Arc::<str>::from("see attached"),
                    images: vec![ContentPart::Image {
                        url: std::sync::Arc::<str>::from("data:image/png;base64,AAAA"),
                    }],
                    ..Default::default()
                },
            )],
            vec![],
        ));

        assert_eq!(
            components.tool_result_tokens,
            "see attached".len() as u64 / 4
        );
        assert_eq!(
            components.image_tokens,
            xai_token_estimation::estimate_image_tokens(1)
        );
    }

    #[test]
    fn images_are_split_out_of_their_user_item() {
        let text = "what is this";
        let mut item = user_with(SyntheticReason::Human, text);
        if let ConversationItem::User(u) = &mut item {
            u.content.push(ContentPart::Image {
                url: std::sync::Arc::<str>::from("data:image/png;base64,AAAA"),
            });
        }
        let components = RequestComponents::from_request(&request(vec![item], vec![]));

        assert_eq!(
            components.user_tokens,
            text.len() as u64 / 4,
            "the text stays a user token"
        );
        assert_eq!(
            components.image_tokens,
            xai_token_estimation::estimate_image_tokens(1)
        );
    }

    #[test]
    fn every_other_synthetic_reason_lands_in_injected() {
        for reason in [
            SyntheticReason::SystemReminder,
            SyntheticReason::ProjectInstructions,
            SyntheticReason::AutoContinue,
            SyntheticReason::Interjection,
        ] {
            let components =
                RequestComponents::from_request(&request(vec![user_with(reason, "abc")], vec![]));
            assert_eq!(components.injected_tokens, 0, "under one token rounds down");
            assert_eq!(components.user_tokens, 0);
            assert_eq!(components.compaction_meta_tokens, 0);
        }

        let components = RequestComponents::from_request(&request(
            vec![user_with(
                SyntheticReason::ProjectInstructions,
                "read AGENTS.md first",
            )],
            vec![],
        ));
        assert_eq!(
            components.injected_tokens,
            "read AGENTS.md first".len() as u64 / 4
        );
        assert_eq!(components.user_tokens, 0);
    }

    #[test]
    fn fold_sums_every_bucket() {
        let mut total = RequestComponents::default();
        let one = RequestComponents {
            system_tokens: 10,
            tool_result_tokens: 4,
            ..Default::default()
        };
        let two = RequestComponents {
            system_tokens: 3,
            image_tokens: 7,
            ..Default::default()
        };
        total.fold(&one);
        total.fold(&two);

        assert_eq!(total.system_tokens, 13);
        assert_eq!(total.tool_result_tokens, 4);
        assert_eq!(total.image_tokens, 7);
        assert_eq!(total.total_tokens(), 24);
    }

    #[test]
    fn an_empty_request_is_all_zero() {
        let components = RequestComponents::from_request(&request(vec![], vec![]));
        assert_eq!(components, RequestComponents::default());
        assert_eq!(components.total_tokens(), 0);
    }
}
