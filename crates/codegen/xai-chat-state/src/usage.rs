//! Per-prompt and per-session billing ledgers (not serialized).
//!
//! `total_tokens()` is input + output: Responses wire `total` is live context
//! length. Every model call is folded with a [`CallPurpose`]. Only main-loop
//! calls advance `main_loop_model_calls`; compaction and child work fold into
//! the same totals under `by_purpose`, so the session bill reconciles without
//! claiming extra turns.
//!
//! # Completeness ownership
//!
//! Wire incomplete is the OR of these stores (each has a distinct role):
//!
//! - **`UsageLedger.incomplete`** — durable on the bill snapshot. Set by nested
//!   subagent incomplete fold, drain timeout, true apply-miss, and
//!   `mark_usage_incomplete`. Monotonic for a ledger instance.
//! - **Sticky (`subagent_usage_not_applied` on the coordinator)** — pin-scoped
//!   **report** signal (session-only attribution or apply-miss report). Not a
//!   second token sink; does not stain ledgers by itself.
//! - **Foreground live IDs** — fold may still land; freeze drains ≤120s or fails
//!   closed. Cancel skips multi-second drain (actor-loop safety).
//! - **Background live** — never waits; prompt report incomplete immediately;
//!   spend still folds into the session ledger at completion (no session-ledger
//!   incomplete).
//!
//! Freeze and cancel share one outcome policy: ledger marks only on fail-closed;
//! sticky and background_live are report-level only.
//!
//! Projection (`PromptUsage`) never invents tokens; it only ORs completeness
//! and scrubs costs when partial or incomplete.

use indexmap::IndexMap;
use xai_grok_sampling_types::TokenUsage;

/// Why a model call was issued.
///
/// Only [`CallPurpose::MainLoop`] advances [`UsageLedger::main_loop_model_calls`]
/// (the wire `numTurns`). Every other purpose is spend that must stay visible in
/// the session bill without being counted as a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CallPurpose {
    /// Main agent loop: the tool loop and its retries.
    MainLoop,
    /// Compaction through the single-pass / full-replace engine.
    CompactSingle,
    /// Two-pass compaction pass 1 (the speculative prefire summary).
    CompactPass1,
    /// Two-pass compaction pass 2 (the summary the successor actually sees).
    CompactPass2,
    /// Child-agent work folded from a child session ledger.
    Subagent,
    /// The `/recap` summary of earlier work.
    Recap,
    /// The per-turn narrative summary.
    TurnSummary,
    /// The session title refresh.
    TitleRefresh,
    /// The `/btw` side question.
    Btw,
}

impl CallPurpose {
    /// Every purpose, in reporting order.
    pub const ALL: [Self; 9] = [
        Self::MainLoop,
        Self::CompactSingle,
        Self::CompactPass1,
        Self::CompactPass2,
        Self::Subagent,
        Self::Recap,
        Self::TurnSummary,
        Self::TitleRefresh,
        Self::Btw,
    ];

    /// Stable identifier for reports and telemetry. Also the label auxiliary
    /// calls log their prompt-cache buckets under.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MainLoop => "main_loop",
            Self::CompactSingle => "compact_single",
            Self::CompactPass1 => "compact_pass1",
            Self::CompactPass2 => "compact_pass2",
            Self::Subagent => "subagent",
            Self::Recap => "recap",
            Self::TurnSummary => "turn_summary",
            Self::TitleRefresh => "title_refresh",
            Self::Btw => "btw",
        }
    }

    /// True for the main agent loop, the only purpose that advances the turn count.
    pub fn is_main_loop(self) -> bool {
        matches!(self, Self::MainLoop)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cached_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub reasoning_tokens: u64,
    pub model_calls: u64,
    pub api_duration_ms: u64,
    /// USD ticks (1e10 per USD). Absent when no call reported cost.
    pub cost_usd_ticks: Option<i64>,
    pub cost_missing_calls: u64,
    /// Completed calls whose provider response omitted usage. Their spend is
    /// unknown, never zero, so they add no tokens and no `model_calls`.
    pub usage_missing_calls: u64,
}

impl UsageTotals {
    fn from_call(
        usage: &TokenUsage,
        api_duration_ms: Option<u64>,
        cost_usd_ticks: Option<i64>,
    ) -> Self {
        let cost_usd_ticks = xai_grok_sampling_types::reported_cost_ticks(cost_usd_ticks);
        Self {
            input_tokens: u64::from(usage.prompt_tokens),
            output_tokens: u64::from(usage.completion_tokens),
            cached_read_tokens: u64::from(usage.cached_prompt_tokens),
            cache_creation_tokens: u64::from(usage.cache_creation_prompt_tokens),
            reasoning_tokens: u64::from(usage.reasoning_tokens),
            model_calls: 1,
            api_duration_ms: api_duration_ms.unwrap_or(0),
            cost_usd_ticks,
            cost_missing_calls: u64::from(cost_usd_ticks.is_none()),
            usage_missing_calls: 0,
        }
    }

    pub fn total_tokens(&self) -> u64 {
        self.input_tokens.saturating_add(self.output_tokens)
    }

    pub fn cost_is_partial(&self) -> bool {
        self.cost_usd_ticks.is_some() && self.cost_missing_calls > 0
    }

    fn fold_totals(&mut self, other: &UsageTotals) {
        let Self {
            input_tokens,
            output_tokens,
            cached_read_tokens,
            cache_creation_tokens,
            reasoning_tokens,
            model_calls,
            api_duration_ms,
            cost_usd_ticks,
            cost_missing_calls,
            usage_missing_calls,
        } = other;
        self.input_tokens = self.input_tokens.saturating_add(*input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(*output_tokens);
        self.cached_read_tokens = self.cached_read_tokens.saturating_add(*cached_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(*cache_creation_tokens);
        self.reasoning_tokens = self.reasoning_tokens.saturating_add(*reasoning_tokens);
        self.model_calls = self.model_calls.saturating_add(*model_calls);
        self.api_duration_ms = self.api_duration_ms.saturating_add(*api_duration_ms);
        self.cost_missing_calls = self.cost_missing_calls.saturating_add(*cost_missing_calls);
        self.usage_missing_calls = self
            .usage_missing_calls
            .saturating_add(*usage_missing_calls);
        self.cost_usd_ticks = merge_cost_ticks(self.cost_usd_ticks, *cost_usd_ticks);
    }
}

fn merge_cost_ticks(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0).saturating_add(b.unwrap_or(0))),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsageLedger {
    pub totals: UsageTotals,
    pub by_model: IndexMap<String, UsageTotals>,
    /// Totals per call purpose. [`CallPurpose::MainLoop`] mirrors the folded
    /// main-loop calls; the side-call purposes explain the rest of `totals`.
    pub by_purpose: IndexMap<CallPurpose, UsageTotals>,
    /// Main-agent loop rounds for `num_turns` (subagents excluded).
    pub main_loop_model_calls: u64,
    /// Completed side calls (compaction, recap, title refresh, turn summary).
    /// Never counted by `main_loop_model_calls`.
    pub side_call_model_calls: u64,
    /// Bill may under-count (drain timeout, nested subagent incomplete, apply failure).
    pub incomplete: bool,
}

impl UsageLedger {
    /// Fold one main-agent-loop model call. This is the only writer of
    /// `main_loop_model_calls` (the wire `numTurns`); side calls such as
    /// compaction must use [`Self::record_side_call`].
    pub fn record_main_loop_call(
        &mut self,
        model_id: &str,
        usage: &TokenUsage,
        api_duration_ms: Option<u64>,
        cost_usd_ticks: Option<i64>,
    ) {
        let call = UsageTotals::from_call(usage, api_duration_ms, cost_usd_ticks);
        self.main_loop_model_calls = self.main_loop_model_calls.saturating_add(1);
        self.by_purpose
            .entry(CallPurpose::MainLoop)
            .or_default()
            .fold_totals(&call);
        self.fold_entry(model_id, &call);
    }

    /// Fold one side call that spends provider tokens outside the main tool loop.
    /// Never advances `main_loop_model_calls`, so a compaction summary cannot
    /// inflate the reported turn count.
    pub fn record_side_call(
        &mut self,
        purpose: CallPurpose,
        model_id: &str,
        usage: &TokenUsage,
        api_duration_ms: Option<u64>,
        cost_usd_ticks: Option<i64>,
    ) {
        debug_assert!(
            !purpose.is_main_loop(),
            "main-loop usage must go through record_main_loop_call"
        );
        let call = UsageTotals::from_call(usage, api_duration_ms, cost_usd_ticks);
        self.side_call_model_calls = self.side_call_model_calls.saturating_add(1);
        self.by_purpose
            .entry(purpose)
            .or_default()
            .fold_totals(&call);
        self.fold_entry(model_id, &call);
    }

    /// Record a completed call whose provider response omitted usage.
    /// Unknown spend stays unknown: no tokens and no `model_calls` are invented.
    pub fn record_usage_missing(&mut self, purpose: CallPurpose) {
        self.totals.usage_missing_calls = self.totals.usage_missing_calls.saturating_add(1);
        let entry = self.by_purpose.entry(purpose).or_default();
        entry.usage_missing_calls = entry.usage_missing_calls.saturating_add(1);
    }

    /// Fold subagent usage without incrementing `main_loop_model_calls`.
    pub fn record_subagent(&mut self, by_model: &[(String, UsageTotals)], incomplete: bool) {
        for (model_id, totals) in by_model {
            self.by_purpose
                .entry(CallPurpose::Subagent)
                .or_default()
                .fold_totals(totals);
            self.fold_entry(model_id, totals);
        }
        if incomplete {
            self.incomplete = true;
        }
    }

    pub fn mark_incomplete(&mut self) {
        self.incomplete = true;
    }

    fn fold_entry(&mut self, model_id: &str, totals: &UsageTotals) {
        self.totals.fold_totals(totals);
        self.by_model
            .entry(model_id.to_owned())
            .or_default()
            .fold_totals(totals);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tu(prompt: u32, completion: u32) -> TokenUsage {
        TokenUsage {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: 999_999,
            reasoning_tokens: 0,
            cached_prompt_tokens: 0,
            cache_creation_prompt_tokens: 0,
        }
    }

    #[test]
    fn ledger_sums_partial_subagent_and_zero_cost() {
        let mut ledger = UsageLedger::default();
        ledger.record_main_loop_call("m", &tu(1, 1), None, Some(0));
        assert_eq!(ledger.totals.cost_usd_ticks, None);
        assert_eq!(ledger.totals.cost_missing_calls, 1);

        ledger.record_main_loop_call("a", &tu(100, 10), Some(100), None);
        ledger.record_main_loop_call("a", &tu(50, 5), Some(50), Some(70));
        assert_eq!(ledger.totals.cost_usd_ticks, Some(70));
        assert!(ledger.totals.cost_is_partial());
        assert_eq!(ledger.main_loop_model_calls, 3);

        ledger.record_subagent(
            &[(
                "b".into(),
                UsageTotals {
                    input_tokens: 5,
                    model_calls: 1,
                    ..Default::default()
                },
            )],
            false,
        );
        assert_eq!(ledger.by_model.get("b").map(|m| m.input_tokens), Some(5));
        assert_eq!(ledger.main_loop_model_calls, 3);
        assert_eq!(ledger.totals.model_calls, 4);
        assert!(!ledger.incomplete);

        ledger.record_subagent(&[], true);
        assert!(ledger.incomplete);
    }

    #[test]
    fn side_calls_fold_into_totals_without_counting_as_turns() {
        let mut ledger = UsageLedger::default();
        ledger.record_main_loop_call("m", &tu(100, 10), None, Some(5));

        ledger.record_side_call(
            CallPurpose::CompactSingle,
            "m",
            &tu(1_000, 200),
            Some(2_500),
            Some(7),
        );
        ledger.record_side_call(CallPurpose::CompactPass1, "m", &tu(400, 90), None, None);

        // The session bill reconciles: totals cover every purpose.
        assert_eq!(ledger.totals.input_tokens, 1_500);
        assert_eq!(ledger.totals.output_tokens, 300);
        assert_eq!(ledger.totals.model_calls, 3);
        // Compaction is not a turn.
        assert_eq!(ledger.main_loop_model_calls, 1);
        assert_eq!(ledger.side_call_model_calls, 2);

        let compact = ledger
            .by_purpose
            .get(&CallPurpose::CompactSingle)
            .expect("single-pass compaction recorded");
        assert_eq!(compact.input_tokens, 1_000);
        assert_eq!(compact.model_calls, 1);
        assert_eq!(compact.api_duration_ms, 2_500);
        let main = ledger
            .by_purpose
            .get(&CallPurpose::MainLoop)
            .expect("main loop recorded");
        assert_eq!(main.input_tokens, 100);
        assert_eq!(main.model_calls, 1);
        assert_eq!(
            ledger
                .by_purpose
                .get(&CallPurpose::CompactPass2)
                .map(|t| t.model_calls),
            None,
            "unused purposes stay absent rather than zero rows"
        );
    }

    #[test]
    fn missing_usage_is_counted_per_purpose_and_never_invented_as_tokens() {
        let mut ledger = UsageLedger::default();
        ledger.record_usage_missing(CallPurpose::CompactSingle);
        ledger.record_usage_missing(CallPurpose::CompactSingle);
        ledger.record_usage_missing(CallPurpose::MainLoop);

        assert_eq!(ledger.totals.usage_missing_calls, 3);
        assert_eq!(ledger.totals.model_calls, 0, "no call is fabricated");
        assert_eq!(ledger.totals.input_tokens, 0);
        assert_eq!(ledger.main_loop_model_calls, 0);
        assert_eq!(ledger.side_call_model_calls, 0);
        assert_eq!(
            ledger
                .by_purpose
                .get(&CallPurpose::CompactSingle)
                .expect("missing usage is visible for the purpose")
                .usage_missing_calls,
            2
        );
        assert!(
            ledger
                .by_purpose
                .get(&CallPurpose::MainLoop)
                .is_some_and(|t| t.usage_missing_calls == 1 && t.model_calls == 0)
        );
    }

    #[test]
    fn subagent_usage_uses_its_own_purpose_row() {
        let mut ledger = UsageLedger::default();
        ledger.record_subagent(
            &[(
                "child".into(),
                UsageTotals {
                    input_tokens: 5,
                    model_calls: 1,
                    ..Default::default()
                },
            )],
            false,
        );

        assert_eq!(ledger.main_loop_model_calls, 0);
        assert_eq!(ledger.side_call_model_calls, 0);
        assert_eq!(
            ledger
                .by_purpose
                .get(&CallPurpose::Subagent)
                .map(|t| t.input_tokens),
            Some(5)
        );
    }

    #[test]
    fn purpose_labels_are_stable() {
        let labels: Vec<&str> = CallPurpose::ALL.iter().map(|p| p.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "main_loop",
                "compact_single",
                "compact_pass1",
                "compact_pass2",
                "subagent",
                // The four auxiliary labels are the strings those calls already log their
                // prompt-cache buckets under, so this list must not drift from them.
                "recap",
                "turn_summary",
                "title_refresh",
                "btw"
            ]
        );
        assert_eq!(
            CallPurpose::ALL.iter().filter(|p| p.is_main_loop()).count(),
            1
        );
    }

    #[test]
    fn auxiliary_purposes_fold_outside_the_main_loop() {
        for purpose in [
            CallPurpose::Recap,
            CallPurpose::TurnSummary,
            CallPurpose::TitleRefresh,
            CallPurpose::Btw,
        ] {
            assert!(!purpose.is_main_loop(), "{purpose:?} is not the main loop");
            let mut ledger = UsageLedger::default();
            ledger.record_side_call(purpose, "m", &TokenUsage::default(), None, None);
            assert_eq!(ledger.main_loop_model_calls, 0);
            assert_eq!(ledger.side_call_model_calls, 1);
            assert_eq!(ledger.by_purpose[&purpose].model_calls, 1);
        }
    }
}
