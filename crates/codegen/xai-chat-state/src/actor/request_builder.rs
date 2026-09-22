//! ConversationRequest assembly — image compaction, pruning, repair, memory injection.

use xai_grok_sampling_types::{ConversationItem, ConversationRequest, ToolSpec, TraceContext};

use super::ChatStateActor;
use crate::events::ChatStateEvent;
use crate::image_budget::{ImageBudgetOutcome, apply_image_budget};
use crate::types::PruningConfig;

/// Placeholder inserted when a tool result is hard-cleared.
/// `pub(super)` so `mutations.rs` can use the same string on the retained conversation.
pub(super) const HARD_CLEAR_PLACEHOLDER: &str = "[Tool result omitted — too old]";

/// Placeholder used by the opt-in step-aware pruning experiment.
const STEP_BUDGET_PLACEHOLDER: &str = "[Tool result omitted — outside recent step budget]";

/// Placeholder used when the step budget is spent keeping pinned evidence, so the model can
/// tell why this result went before results the budget would otherwise have covered.
const STEP_BUDGET_PINNED_PLACEHOLDER: &str =
    "[Tool result omitted — recent step budget spent on newer pinned evidence]";

/// Whether a result was already replaced by one of the step-budget placeholders.
fn is_step_budget_placeholder(content: &str) -> bool {
    content == STEP_BUDGET_PLACEHOLDER || content == STEP_BUDGET_PINNED_PLACEHOLDER
}

/// Separator inserted between head and tail in soft-trimmed results.
const SOFT_TRIM_SEPARATOR: &str = "\n\n[…trimmed…]\n\n";

impl ChatStateActor {
    /// Build a `ConversationRequest` from current actor state (image eviction, prune, memory reminder).
    /// The command handler already ran integrity repair on the actor conversation before this clone.
    /// Do not re-run dangling/dedup repair on the clone — those would be O(n) no-ops.
    pub(super) fn build_conversation_request(
        &mut self,
        tool_definitions: Vec<ToolSpec>,
        memory_reminder: Option<String>,
        persist_memory_reminder: bool,
        trace: Option<Box<dyn TraceContext>>,
        conv_id: String,
        req_id: String,
    ) -> ConversationRequest {
        let mut memory_reminder = memory_reminder;
        if let Some(reminder) = memory_reminder.as_deref()
            && persist_memory_reminder
        {
            // A live in-place inject can prepend a `System` item, shifting indices
            // under an active capture; snapshot + rebase like the other mutators.
            self.snapshot_turn_slice();
            let injected = inject_memory_reminder(&mut self.state.conversation, reminder);
            if injected {
                self.persistence.replace_history(&self.state.conversation);
                memory_reminder = None;
            }
            self.rebase_turn_capture_offset();
        }
        let budgeted = apply_image_budget(self.state.conversation.clone());
        let ImageBudgetOutcome {
            body_bytes,
            body_bytes_after,
            inline_images,
            needs_image_compaction,
            evicted,
        } = budgeted.outcome;
        let mut items = budgeted.items;
        if inline_images > 0 {
            self.send_event(ChatStateEvent::ImageBudget {
                body_bytes,
                trigger_bytes: crate::image_budget::IMAGE_COMPACT_TRIGGER_BYTES,
                reclaim_target_bytes: crate::image_budget::IMAGE_COMPACT_RECLAIM_TARGET_BYTES,
                inline_images,
                needs_image_compaction,
                evicted,
                body_bytes_after,
            });
        }
        items = self.prune_items_for_turn_request(items);
        if let Some(reminder) = memory_reminder {
            inject_memory_reminder(&mut items, &reminder);
        }
        items = crate::compaction_utils::ModelRequestHistory::from_raw(items).into_items();

        // Step 4: Assemble request
        ConversationRequest {
            items,
            tools: tool_definitions,
            hosted_tools: vec![],
            tool_choice: None,
            model: Some(self.state.sampling_config.model.clone()),
            temperature: self.state.sampling_config.temperature,
            max_output_tokens: self.state.sampling_config.max_completion_tokens,
            top_p: self.state.sampling_config.top_p,
            x_grok_conv_id: Some(conv_id),
            x_grok_req_id: Some(req_id),
            x_grok_session_id: None,
            x_grok_turn_idx: None,
            x_grok_transient_retry: None,
            x_grok_agent_id: None,
            x_grok_deployment_id: None,
            x_grok_user_id: None,
            trace,
            traceparent: None,
            prompt_cache_key: None,
            reasoning_effort: self.state.sampling_config.reasoning_effort,
            json_schema: None,
            // Execute completed tool calls on a Length-truncated turn instead
            // of failing it; text-only salvage stays behind `CompletePartial`.
            length_policy: xai_grok_sampling_types::LengthPolicy::CompleteToolCalls,
        }
    }

    pub(super) fn prune_items_for_turn_request(
        &self,
        mut items: Vec<ConversationItem>,
    ) -> Vec<ConversationItem> {
        if should_prune(
            self.state.total_tokens,
            self.state.sampling_config.context_window,
        ) {
            let report = prune_conversation(&mut items, &self.pruning_config);
            // The step-aware policy is opt-in and changes what the model sees inside a single
            // user turn, so a run that used it has to say so: nothing else reports it, because
            // the pruned request copy is never persisted.
            if report.rounds_cleared_by_step_budget > 0 || report.pinned_kept > 0 {
                tracing::info!(
                    rounds_cleared_by_step_budget = report.rounds_cleared_by_step_budget,
                    pinned_kept = report.pinned_kept,
                    soft_trimmed = report.soft_trimmed,
                    hard_cleared = report.hard_cleared,
                    chars_reclaimed = report.chars_reclaimed,
                    "step-aware tool result pruning rewrote the request copy"
                );
            } else {
                tracing::debug!(
                    soft_trimmed = report.soft_trimmed,
                    hard_cleared = report.hard_cleared,
                    chars_reclaimed = report.chars_reclaimed,
                    "pruned tool results in the request copy"
                );
            }
        }
        items
    }
}

// ============================================================================
// Pruning (standalone functions, no actor state needed)
// ============================================================================

/// Check whether pruning should run based on context utilization.
///
/// Returns `true` when `total_tokens` exceeds 50% of `context_window`.
pub(crate) fn should_prune(total_tokens: u64, context_window: std::num::NonZeroU64) -> bool {
    total_tokens > context_window.get() / 2
}

/// What one pass of [`prune_conversation`] did to the request copy.
///
/// Counts results, not characters of prompt: only `chars_reclaimed` is a size, and it counts the
/// characters dropped from replaced results, so it is an upper bound on what the turn saved.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PruningReport {
    /// Older rounds inside a recent turn cleared by the opt-in step budget.
    pub rounds_cleared_by_step_budget: usize,
    /// Results replaced with the head/tail trim.
    pub soft_trimmed: usize,
    /// Results replaced with the hard-clear placeholder.
    pub hard_cleared: usize,
    /// Results kept raw because their provenance pinned them.
    pub pinned_kept: usize,
    /// Characters removed from results, summed over every replacement above.
    pub chars_reclaimed: usize,
}

/// Prune old, large tool results from the conversation in place.
/// Turn age is estimated by walking backward and counting `User` items.
/// When configured, tool-call-bearing assistant items also bound raw results
/// within a single user turn by round count and cumulative character budget.
pub(crate) fn prune_conversation(
    conversation: &mut [ConversationItem],
    config: &PruningConfig,
) -> PruningReport {
    let mut report = PruningReport::default();
    let mut total_chars_before = 0usize;
    let mut total_chars_after = 0usize;
    if !config.enabled {
        return report;
    }

    let mut turn_from_end: usize = 0;
    let mut seen_first_user = false;
    let mut tool_round_from_end: usize = 0;
    let mut recent_tool_result_chars: usize = 0;
    let step_policy_enabled =
        config.keep_last_n_tool_rounds > 0 || config.recent_tool_result_char_budget > 0;
    // Whether any pinned result is present decides which omission placeholder the model sees,
    // so it is read before the mutating walk.
    let any_pinned = config.pin_evidence
        && conversation.iter().any(
            |item| matches!(item, ConversationItem::ToolResult(tr) if tr.provenance.is_pinned()),
        );

    for item in conversation.iter_mut().rev() {
        if matches!(item, ConversationItem::User(_)) {
            if seen_first_user {
                turn_from_end += 1;
            }
            seen_first_user = true;
            continue;
        }

        if let ConversationItem::Assistant(assistant) = item {
            if !assistant.tool_calls.is_empty() {
                tool_round_from_end = tool_round_from_end.saturating_add(1);
            }
            continue;
        }

        let ConversationItem::ToolResult(tool_result) = item else {
            continue;
        };

        let content_len = tool_result.content.chars().count();
        let recent_turn = turn_from_end < config.keep_last_n_turns;

        // Preserve the legacy behavior unless the step-aware experiment is
        // explicitly configured. Under the experiment, the active round is
        // always retained; older rounds must fit both limits that are enabled.
        if !step_policy_enabled && recent_turn {
            continue;
        }
        if step_policy_enabled && recent_turn {
            recent_tool_result_chars = recent_tool_result_chars.saturating_add(content_len);
            let active_round = tool_round_from_end == 0;
            let within_round_window = config.keep_last_n_tool_rounds == 0
                || tool_round_from_end < config.keep_last_n_tool_rounds;
            let within_char_budget = config.recent_tool_result_char_budget == 0
                || recent_tool_result_chars <= config.recent_tool_result_char_budget;

            if active_round || (within_round_window && within_char_budget) {
                continue;
            }

            // Evidence the model has not consumed outranks recency and the character budget.
            // A pin is deliberately not charged against `recent_tool_result_char_budget`:
            // dropping it to fit that budget is the failure the pin exists to prevent.
            if config.pin_evidence && tool_result.provenance.is_pinned() {
                report.pinned_kept += 1;
                continue;
            }

            if !is_step_budget_placeholder(&tool_result.content) {
                let placeholder = if any_pinned {
                    STEP_BUDGET_PINNED_PLACEHOLDER
                } else {
                    STEP_BUDGET_PLACEHOLDER
                };
                total_chars_before += content_len;
                total_chars_after += placeholder.chars().count();
                report.rounds_cleared_by_step_budget += 1;
                tool_result.content = std::sync::Arc::<str>::from(placeholder);
            }
            continue;
        }

        // Hard clear: very old tool results → replace entirely.
        if turn_from_end >= config.hard_clear_age_turns {
            if tool_result.content.as_ref() != HARD_CLEAR_PLACEHOLDER {
                total_chars_before += content_len;
                total_chars_after += HARD_CLEAR_PLACEHOLDER.chars().count();
                report.hard_cleared += 1;
                tool_result.content = std::sync::Arc::<str>::from(HARD_CLEAR_PLACEHOLDER);
            }
            continue;
        }

        // Soft trim: large tool results → keep head + tail.
        if content_len > config.soft_trim_threshold {
            let head = safe_char_slice(&tool_result.content, 0, config.soft_trim_head);
            let tail = safe_char_slice_tail(&tool_result.content, config.soft_trim_tail);
            let trimmed = format!("{head}{SOFT_TRIM_SEPARATOR}{tail}");
            total_chars_before += content_len;
            total_chars_after += trimmed.chars().count();
            report.soft_trimmed += 1;
            tool_result.content = std::sync::Arc::<str>::from(trimmed);
        }
    }

    report.chars_reclaimed = total_chars_before.saturating_sub(total_chars_after);
    report
}

// ============================================================================
// Memory reminder injection
// ============================================================================

use crate::types::MEMORY_CONTEXT_OPEN_TAG;

/// Upsert a memory reminder into the conversation's system message.
/// Replaces a prior reminder section in-place, or prepends a `System` item if none exists.
/// Returns `true` when the conversation was changed.
pub(super) fn inject_memory_reminder(items: &mut Vec<ConversationItem>, reminder: &str) -> bool {
    let reminder = reminder.trim();
    if reminder.is_empty() {
        return false;
    }

    if let Some(ConversationItem::System(sys)) = items.first_mut() {
        upsert_memory_reminder_text(&mut sys.content, reminder)
    } else {
        items.insert(0, ConversationItem::system(reminder));
        true
    }
}

fn upsert_memory_reminder_text(system_prompt: &mut std::sync::Arc<str>, reminder: &str) -> bool {
    let existing_start = system_prompt.find(MEMORY_CONTEXT_OPEN_TAG).map(|idx| {
        system_prompt
            .get(..idx)
            .unwrap_or("")
            .trim_end_matches('\n')
            .len()
    });

    let updated: String = if let Some(prefix_len) = existing_start {
        let prefix = system_prompt
            .get(..prefix_len)
            .unwrap_or("")
            .trim_end_matches('\n');
        if prefix.is_empty() {
            reminder.to_string()
        } else {
            format!("{prefix}\n\n{reminder}")
        }
    } else if system_prompt.trim_end() == reminder {
        system_prompt.as_ref().to_owned()
    } else if system_prompt.is_empty() {
        reminder.to_string()
    } else {
        format!("{}\n\n{reminder}", system_prompt.trim_end_matches('\n'))
    };

    if system_prompt.as_ref() == updated.as_str() {
        false
    } else {
        *system_prompt = std::sync::Arc::<str>::from(updated);
        true
    }
}

// ============================================================================
// String helpers
// ============================================================================

fn safe_char_slice(s: &str, start: usize, count: usize) -> String {
    s.chars().skip(start).take(count).collect()
}

fn safe_char_slice_tail(s: &str, count: usize) -> String {
    let total = s.chars().count();
    if count >= total {
        return s.to_string();
    }
    s.chars().skip(total - count).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use xai_grok_sampling_types::{ToolCall, ToolResultProvenance};

    fn tool_round(id: usize, content_len: usize) -> [ConversationItem; 2] {
        [
            ConversationItem::assistant_tool_calls(vec![ToolCall {
                id: format!("call_{id}").into(),
                name: "bash".to_owned(),
                arguments: "{}".into(),
            }]),
            ConversationItem::tool_result(format!("call_{id}"), "x".repeat(content_len)),
        ]
    }

    /// A tool round whose result carries execution provenance.
    fn tool_round_with(
        id: usize,
        content_len: usize,
        provenance: ToolResultProvenance,
    ) -> [ConversationItem; 2] {
        let [assistant, result] = tool_round(id, content_len);
        let result = match result {
            ConversationItem::ToolResult(mut item) => {
                item.provenance = provenance;
                ConversationItem::ToolResult(item)
            }
            other => other,
        };
        [assistant, result]
    }

    /// Step-aware limits tight enough that only the active round and pins survive.
    fn step_arm_config() -> PruningConfig {
        PruningConfig {
            keep_last_n_turns: 3,
            keep_last_n_tool_rounds: 3,
            recent_tool_result_char_budget: 450,
            pin_evidence: true,
            ..Default::default()
        }
    }

    fn result_contents(conv: &[ConversationItem]) -> Vec<String> {
        conv.iter()
            .filter_map(|item| match item {
                ConversationItem::ToolResult(result) => Some(result.content.to_string()),
                _ => None,
            })
            .collect()
    }

    /// The phase-2 `pin_old_failure` shape: rounds 1–6 are success noise except round 2, which
    /// is the only failure, and the two newest rounds are unrelated success. The failure is
    /// outside the round window, so only the pin keeps it.
    #[test]
    fn pinned_failure_outside_the_round_window_stays_raw() {
        let mut conv = vec![ConversationItem::user("fix the failure")];
        for id in 0..8 {
            let provenance = ToolResultProvenance {
                failed: id == 2,
                ..Default::default()
            };
            conv.extend(tool_round_with(id, 200, provenance));
        }

        let report = prune_conversation(&mut conv, &step_arm_config());

        let results = result_contents(&conv);
        assert_eq!(results.len(), 8, "tool-call pairing must be preserved");
        assert_eq!(results[7].len(), 200, "active round must remain raw");
        assert_eq!(results[2].len(), 200, "the failed round must stay raw");
        assert_eq!(report.pinned_kept, 1);
        assert_eq!(
            results[0], STEP_BUDGET_PINNED_PLACEHOLDER,
            "omissions must name the pins that spent the budget"
        );
        assert_eq!(results[1], STEP_BUDGET_PINNED_PLACEHOLDER);
        assert_eq!(results[3], STEP_BUDGET_PINNED_PLACEHOLDER);
    }

    #[test]
    fn pin_is_off_unless_the_step_arm_enables_it() {
        let mut conv = vec![ConversationItem::user("fix the failure")];
        for id in 0..8 {
            let provenance = ToolResultProvenance {
                failed: id == 2,
                ..Default::default()
            };
            conv.extend(tool_round_with(id, 200, provenance));
        }

        let report = prune_conversation(
            &mut conv,
            &PruningConfig {
                pin_evidence: false,
                ..step_arm_config()
            },
        );

        let results = result_contents(&conv);
        assert_eq!(results[2], STEP_BUDGET_PLACEHOLDER);
        assert_eq!(report.pinned_kept, 0);
    }

    /// A pin is not charged against the character budget: it survives even when the pin plus
    /// the active round exceed the budget on their own.
    #[test]
    fn pin_is_not_charged_against_the_character_budget() {
        let mut conv = vec![ConversationItem::user("fix the failure")];
        for id in 0..8 {
            let provenance = ToolResultProvenance {
                failed: id == 2,
                ..Default::default()
            };
            conv.extend(tool_round_with(id, 200, provenance));
        }
        // Budget below one result, so nothing but the active round and pins would fit.
        let config = PruningConfig {
            recent_tool_result_char_budget: 50,
            ..step_arm_config()
        };

        prune_conversation(&mut conv, &config);

        let results = result_contents(&conv);
        assert_eq!(results[7].len(), 200, "active round must remain raw");
        assert_eq!(results[2].len(), 200, "a pin outranks the budget");
    }

    /// `still_live` and `unresolved_edit` pin the same way as `failed`.
    #[test]
    fn live_process_and_unverified_edit_results_are_pinned_too() {
        for provenance in [
            ToolResultProvenance {
                still_live: true,
                ..Default::default()
            },
            ToolResultProvenance {
                unresolved_edit: true,
                ..Default::default()
            },
        ] {
            let mut conv = vec![ConversationItem::user("keep going")];
            for id in 0..8 {
                let this = if id == 2 {
                    provenance
                } else {
                    ToolResultProvenance::default()
                };
                conv.extend(tool_round_with(id, 200, this));
            }

            let report = prune_conversation(&mut conv, &step_arm_config());

            assert_eq!(result_contents(&conv)[2].len(), 200, "{provenance:?}");
            assert_eq!(report.pinned_kept, 1, "{provenance:?}");
        }
    }

    /// A run with no pinned result keeps the original omission placeholder.
    #[test]
    fn unpinned_omissions_keep_the_original_placeholder() {
        let mut conv = vec![ConversationItem::user("fix the failure")];
        for id in 0..8 {
            conv.extend(tool_round(id, 200));
        }

        let report = prune_conversation(&mut conv, &step_arm_config());

        let results = result_contents(&conv);
        assert_eq!(results[0], STEP_BUDGET_PLACEHOLDER);
        assert_eq!(results[5], STEP_BUDGET_PLACEHOLDER);
        assert_eq!(report.pinned_kept, 0);
    }

    #[test]
    fn should_prune_gating() {
        use std::num::NonZeroU64;
        let cw = NonZeroU64::new(10000).unwrap();
        assert!(!should_prune(1000, cw)); // 10%
        assert!(should_prune(6000, cw)); // 60%
        assert!(!should_prune(5000, cw)); // 50% exact (> not >=)
    }

    #[test]
    fn prune_disabled_is_noop() {
        let mut conv = vec![ConversationItem::tool_result("c1", "x".repeat(10_000))];
        let config = PruningConfig {
            enabled: false,
            ..Default::default()
        };
        prune_conversation(&mut conv, &config);
        let [ConversationItem::ToolResult(tr)] = conv.as_slice() else {
            panic!("expected one tool result: {conv:?}")
        };
        assert_eq!(tr.content.len(), 10_000);
    }

    #[test]
    fn step_aware_pruning_bounds_many_tool_rounds_inside_one_user_turn() {
        let mut conv = vec![ConversationItem::user("fix the failure")];
        for id in 0..8 {
            conv.extend(tool_round(id, 200));
        }
        let config = PruningConfig {
            keep_last_n_turns: 3,
            keep_last_n_tool_rounds: 3,
            recent_tool_result_char_budget: 450,
            ..Default::default()
        };

        prune_conversation(&mut conv, &config);

        let results: Vec<_> = conv
            .iter()
            .filter_map(|item| match item {
                ConversationItem::ToolResult(result) => Some(result.content.as_ref()),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 8, "tool-call pairing must be preserved");
        assert_eq!(results[7].len(), 200, "active round must remain raw");
        assert_eq!(results[6].len(), 200, "newest prior round fits the budget");
        assert_eq!(
            results[5], STEP_BUDGET_PLACEHOLDER,
            "third-newest result crosses the 450-character budget"
        );
        assert!(
            results[..6]
                .iter()
                .all(|result| *result == STEP_BUDGET_PLACEHOLDER)
        );
    }

    #[test]
    fn prune_report_counts_what_the_step_budget_cleared() {
        let mut conv = vec![ConversationItem::user("fix the failure")];
        for id in 0..8 {
            conv.extend(tool_round(id, 200));
        }
        let config = PruningConfig {
            keep_last_n_turns: 3,
            keep_last_n_tool_rounds: 3,
            recent_tool_result_char_budget: 450,
            ..Default::default()
        };

        let report = prune_conversation(&mut conv, &config);

        assert_eq!(report.rounds_cleared_by_step_budget, 6);
        assert_eq!(report.soft_trimmed, 0);
        assert_eq!(report.hard_cleared, 0);
        assert_eq!(
            report.chars_reclaimed,
            6 * (200 - STEP_BUDGET_PLACEHOLDER.chars().count())
        );
    }

    #[test]
    fn prune_report_is_empty_when_pruning_is_disabled() {
        let mut conv = vec![ConversationItem::tool_result("c1", "x".repeat(10_000))];
        let config = PruningConfig {
            enabled: false,
            ..Default::default()
        };

        let report = prune_conversation(&mut conv, &config);

        assert_eq!(report, PruningReport::default());
        assert_eq!(report.chars_reclaimed, 0);
    }

    #[test]
    fn prune_report_counts_legacy_replacements_and_reclaimed_chars() {
        // Thirteen user turns, so the walk's turn age reaches past `hard_clear_age_turns`: the last
        // three turns stay raw, the next seven are soft trimmed, and the two oldest are hard cleared.
        let mut conv = Vec::new();
        for turn in 0..13 {
            conv.push(ConversationItem::user(format!("turn {turn}")));
            conv.extend(tool_round(turn, 10_000));
        }

        let report = prune_conversation(&mut conv, &PruningConfig::default());

        assert_eq!(report.rounds_cleared_by_step_budget, 0);
        assert_eq!(report.soft_trimmed, 7);
        assert_eq!(report.hard_cleared, 2);
        assert!(report.chars_reclaimed > 0);
    }

    #[test]
    fn zero_step_limits_preserve_legacy_recent_turn_behavior() {
        let mut conv = vec![ConversationItem::user("one long turn")];
        for id in 0..8 {
            conv.extend(tool_round(id, 8_000));
        }

        prune_conversation(&mut conv, &PruningConfig::default());

        assert!(conv.iter().all(|item| match item {
            ConversationItem::ToolResult(result) => result.content.len() == 8_000,
            _ => true,
        }));
    }

    #[test]
    fn inject_memory_into_existing_system() {
        let mut items = vec![
            ConversationItem::system("You are helpful."),
            ConversationItem::user("hi"),
        ];
        inject_memory_reminder(&mut items, "Remember: user likes rust");
        if let Some(ConversationItem::System(sys)) = items.first() {
            assert!(sys.content.contains("Remember: user likes rust"));
            assert!(sys.content.starts_with("You are helpful."));
        }
        assert_eq!(items.len(), 2); // no new item added
    }

    #[test]
    fn inject_memory_prepends_when_no_system() {
        let mut items = vec![ConversationItem::user("hi")];
        inject_memory_reminder(&mut items, "Remember: user likes rust");
        assert_eq!(items.len(), 2);
        assert!(matches!(items.first(), Some(ConversationItem::System(_))));
    }
}
