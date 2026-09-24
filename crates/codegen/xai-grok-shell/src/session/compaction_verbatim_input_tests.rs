use super::{
    CompactInputStage, SUMMARY_BUDGET_RESERVE_TOKENS, fitted_input_budget,
    start_verbatim_compact_turns,
};
use xai_chat_state::estimate_conversation_tokens;
use xai_grok_sampling_types::ConversationItem;

#[test]
fn fitted_input_budget_subtracts_reserve_and_tools() {
    assert_eq!(
        fitted_input_budget(100_000, 10_000),
        100_000 - SUMMARY_BUDGET_RESERVE_TOKENS - 10_000
    );
}

#[test]
fn fitted_input_budget_stays_positive_when_reserve_exceeds_window() {
    // suite session.compaction: context_window=8192, tool schema ~11k tokens.
    // The old formula (window - 32768 - tools) saturated to 0 and thrashed.
    let window = 8_192;
    let tools = 11_728;
    let budget = fitted_input_budget(window, tools);
    assert!(
        budget > 0,
        "budget must remain positive on a window smaller than the fixed reserve: {budget}"
    );
    assert!(budget < window);
}

#[test]
fn fitted_input_budget_ignores_tools_that_do_not_fit() {
    let window = 8_192;
    let with_oversized_tools = fitted_input_budget(window, window * 2);
    let without_tools = fitted_input_budget(window, 0);
    assert_eq!(
        with_oversized_tools, without_tools,
        "tools larger than half the free room must not zero the budget"
    );
    assert!(without_tools > 0);
}

#[test]
fn start_verbatim_stays_verbatim_when_estimate_fits() {
    let turns = vec![
        ConversationItem::system("sys"),
        ConversationItem::user("hello"),
        ConversationItem::assistant("hi"),
    ];
    let (out, stage) = start_verbatim_compact_turns(turns.clone(), 0, 500_000);
    assert_eq!(stage, CompactInputStage::Verbatim);
    assert_eq!(out.len(), turns.len());
    assert_eq!(
        estimate_conversation_tokens(&out),
        estimate_conversation_tokens(&turns)
    );
}

#[test]
fn start_verbatim_fits_when_estimate_exceeds_budget() {
    let turns = vec![
        ConversationItem::system("sys"),
        ConversationItem::user("x".repeat(200_000)),
    ];
    let window = 50_000;
    let budget = fitted_input_budget(window, 0);
    let (out, stage) = start_verbatim_compact_turns(turns, 0, window);
    assert_eq!(stage, CompactInputStage::VerbatimFitted);
    assert!(estimate_conversation_tokens(&out) <= budget);
}

#[test]
fn start_verbatim_fits_on_small_suite_compaction_window() {
    let turns = vec![
        ConversationItem::system("You are a compaction summarizer."),
        ConversationItem::user("x".repeat(50_000)),
    ];
    let window = 8_192;
    let tools = 11_728;
    let budget = fitted_input_budget(window, tools);
    assert!(budget > 0);
    let (out, stage) = start_verbatim_compact_turns(turns, tools, window);
    assert_eq!(stage, CompactInputStage::VerbatimFitted);
    assert!(
        estimate_conversation_tokens(&out) <= budget,
        "fitted turns must respect the non-zero budget"
    );
}
