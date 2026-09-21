//! Folding completed side-call usage into the session ledger.
//!
//! A model call that runs outside the main tool loop still spends provider tokens. Every such call
//! routes its response through [`record_side_call_response`] so the session bill accounts for it
//! under its own [`xai_chat_state::CallPurpose`] row.

/// Folds one completed side call's provider-reported usage into the session ledger under `purpose`.
///
/// A response that omits usage is counted as missing rather than folded as zero, and marks the
/// session bill incomplete: the call happened and cost something, so it must not read as free.
/// It never advances `main_loop_model_calls`, so a side call cannot inflate the reported turn count.
///
/// `api_duration_ms` is whatever the caller measured around the call, or `None` where the call site
/// has no start timestamp; passing `None` records an absent duration rather than a measured zero.
pub(crate) fn record_side_call_response(
    handle: &xai_chat_state::ChatStateHandle,
    purpose: xai_chat_state::CallPurpose,
    model: &str,
    response: &xai_grok_sampling_types::ConversationResponse,
    api_duration_ms: Option<u64>,
) {
    match response.usage.as_ref() {
        Some(usage) => handle.record_side_call_usage(
            purpose,
            model.to_owned(),
            usage.clone(),
            api_duration_ms,
            response.cost_usd_ticks,
        ),
        None => {
            handle.record_usage_missing(purpose);
            handle.mark_usage_incomplete_nowait(false, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use xai_grok_sampling_types::{ConversationResponse, TokenUsage};

    fn response(usage: Option<TokenUsage>, cost_usd_ticks: Option<i64>) -> ConversationResponse {
        ConversationResponse {
            items: Vec::new(),
            stop_reason: None,
            usage,
            cost_usd_ticks,
            message_chunks_emitted: 1,
            doom_loop_signals: Vec::new(),
            stop_message: None,
            message_id: None,
            raw_stop_reason: None,
            stop_sequence: None,
        }
    }

    #[tokio::test]
    async fn side_call_usage_folds_under_its_own_purpose() {
        let (chat_event_tx, _chat_event_rx) = tokio::sync::mpsc::unbounded_channel();
        let handle = xai_chat_state::ChatStateActor::spawn(
            vec![],
            xai_grok_sampling_types::SamplingConfig::default(),
            Box::new(xai_chat_state::NullChatPersistence),
            chat_event_tx,
            tokio_util::sync::CancellationToken::new(),
        );

        super::record_side_call_response(
            &handle,
            xai_chat_state::CallPurpose::GoalEvaluator,
            "test-model",
            &response(
                Some(TokenUsage {
                    prompt_tokens: 900,
                    cached_prompt_tokens: 800,
                    completion_tokens: 40,
                    ..Default::default()
                }),
                Some(7),
            ),
            Some(1_500),
        );
        // A call whose response carried no usage: its spend is unknown, not zero.
        super::record_side_call_response(
            &handle,
            xai_chat_state::CallPurpose::Laziness,
            "test-model",
            &response(None, None),
            None,
        );

        let session = handle
            .try_get_session_usage()
            .await
            .expect("session ledger");

        let goal = session
            .by_purpose
            .get(&xai_chat_state::CallPurpose::GoalEvaluator)
            .expect("goal evaluator row");
        assert_eq!(goal.input_tokens, 900);
        assert_eq!(goal.output_tokens, 40);
        assert_eq!(goal.model_calls, 1);
        assert_eq!(goal.usage_missing_calls, 0);
        assert_eq!(goal.api_duration_ms, 1_500);

        let laziness = session
            .by_purpose
            .get(&xai_chat_state::CallPurpose::Laziness)
            .expect("laziness row");
        assert_eq!(laziness.usage_missing_calls, 1);
        assert_eq!(
            laziness.model_calls, 0,
            "an unreported call adds no tokens and no model calls"
        );

        assert_eq!(session.side_call_model_calls, 1);
        assert_eq!(
            session.main_loop_model_calls, 0,
            "a side call is not a turn"
        );
        assert_eq!(session.totals.cost_usd_ticks, Some(7));
        assert_eq!(session.totals.usage_missing_calls, 1);
        assert!(session.incomplete);
    }
}
