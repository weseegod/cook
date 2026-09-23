//! Per-response tool-call budget shared by every L2 transform.
//!
//! A per-call ceiling cannot see a response that streams an unbounded *number* of small calls, and
//! the idle timer never fires on one because every `tool_calls` delta counts as progress. This guard
//! sits downstream of the three L2 transforms and ends the attempt on whichever limit trips first.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use futures_util::Stream;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use xai_grok_sampling_types::SamplingError;

use crate::events::{SamplingErrorInfo, SamplingEvent};
use crate::types::RequestId;

/// Total tool-call argument bytes one response may stream (the Xiaomi adapter's per-call 32 KiB cut stays as the provider-specific first line).
pub const DEFAULT_MAX_TOOL_CALL_ARGUMENT_BYTES: u64 = 256 * 1024;
/// Distinct tool-call indices one response may open. Matches the pager's own per-sample label cap.
pub const DEFAULT_MAX_TOOL_CALLS: u64 = 64;
/// Wall-clock ceiling for a tool-call channel that closes no call and produces no other output.
pub const DEFAULT_MAX_TOOL_CALL_STREAM_SECS: u64 = 600;
/// Repetition alone cannot distinguish a runaway stream from a finite request for identical
/// calls. The shared guard defaults this optional check off; count, byte, and time limits remain.
pub const DEFAULT_MAX_REPEATED_TOOL_CALLS: u64 = 0;

/// Ceilings on one response's tool-call traffic.
/// A limit of `0` disables that check; every field has a serde default, so a partial override parses.
/// Byte accounting counts `arguments_delta` as forwarded: Xiaomi's synthetic reconciling deltas replay a
/// whole call's arguments, so that path spends the budget roughly twice, and the per-call 32 KiB cut there
/// usually fires first anyway.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolCallBudget {
    /// Total bytes of `arguments_delta` across the response.
    pub max_argument_bytes: u64,
    /// Count of distinct `tool_index` values in the response.
    pub max_tool_calls: u64,
    /// Seconds of continuous tool-call deltas with no text/reasoning output in between.
    pub max_stream_secs: u64,
    /// Optional run length of consecutive calls identical after whitespace normalization.
    /// Zero disables this check; finite repeated calls can be intentional.
    pub max_repeated_calls: u64,
}

impl Default for ToolCallBudget {
    fn default() -> Self {
        Self {
            max_argument_bytes: DEFAULT_MAX_TOOL_CALL_ARGUMENT_BYTES,
            max_tool_calls: DEFAULT_MAX_TOOL_CALLS,
            max_stream_secs: DEFAULT_MAX_TOOL_CALL_STREAM_SECS,
            max_repeated_calls: DEFAULT_MAX_REPEATED_TOOL_CALLS,
        }
    }
}

/// Which ceiling tripped; also the `limit` field of the breach log line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetLimit {
    ArgumentBytes,
    ToolCalls,
    StallSecs,
    RepeatedCalls,
}

impl BudgetLimit {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ArgumentBytes => "argument_bytes",
            Self::ToolCalls => "tool_calls",
            Self::StallSecs => "stall_secs",
            Self::RepeatedCalls => "repeated_calls",
        }
    }
}

/// A tripped limit together with the terminal failure the attempt ends with.
#[derive(Debug)]
pub struct Breach {
    pub limit: BudgetLimit,
    pub error: SamplingError,
}

/// One call's accumulated name and arguments; frozen once another call index starts.
#[derive(Debug, Default)]
struct InFlightCall {
    name: String,
    arguments: String,
}

/// Running counters for a single response.
struct ToolCallBudgetState {
    budget: ToolCallBudget,
    argument_bytes: u64,
    indices: BTreeSet<u32>,
    calls: BTreeMap<u32, InFlightCall>,
    /// Index whose arguments are still arriving.
    open_index: Option<u32>,
    /// Whitespace-normalized fingerprint of the last frozen call.
    last_fingerprint: Option<String>,
    /// Calls in the trailing run of identical fingerprints.
    repeated_run: u64,
    /// Set while tool-call deltas are the only progress seen; text/reasoning clears it.
    tool_channel_started: Option<tokio::time::Instant>,
}

impl ToolCallBudgetState {
    fn new(budget: ToolCallBudget) -> Self {
        Self {
            budget,
            argument_bytes: 0,
            indices: BTreeSet::new(),
            calls: BTreeMap::new(),
            open_index: None,
            last_fingerprint: None,
            repeated_run: 0,
            tool_channel_started: None,
        }
    }

    /// Count one event; `Some` means a ceiling is reached and the response must end.
    fn observe(&mut self, event: &SamplingEvent) -> Option<Breach> {
        match event {
            SamplingEvent::ToolCallDelta {
                tool_index,
                name,
                arguments_delta,
                ..
            } => self.note_tool_call(*tool_index, name.as_deref(), arguments_delta.as_deref()),
            // Text or reasoning is progress on another channel, so the stall clock restarts.
            SamplingEvent::ChannelToken { .. } => {
                self.tool_channel_started = None;
                None
            }
            // The last call is only complete when the response is.
            SamplingEvent::Completed { .. } => {
                self.close_open_call();
                self.repetition_breach()
            }
            _ => None,
        }
    }

    fn note_tool_call(
        &mut self,
        index: u32,
        name: Option<&str>,
        arguments_delta: Option<&str>,
    ) -> Option<Breach> {
        let now = tokio::time::Instant::now();
        if self.tool_channel_started.is_none() {
            self.tool_channel_started = Some(now);
        }

        self.argument_bytes += arguments_delta.map_or(0, |delta| delta.len() as u64);
        if self.limit_of(self.budget.max_argument_bytes) < self.argument_bytes {
            return Some(self.breach(
                BudgetLimit::ArgumentBytes,
                format!(
                    "the response streamed {} bytes of tool-call arguments, past the {} byte ceiling for one response",
                    self.argument_bytes, self.budget.max_argument_bytes
                ),
            ));
        }

        if self.indices.insert(index) {
            let opened = self.indices.len() as u64;
            if self.limit_of(self.budget.max_tool_calls) < opened {
                return Some(self.breach(
                    BudgetLimit::ToolCalls,
                    format!(
                        "the response opened {opened} tool calls, past the {} call ceiling for one response",
                        self.budget.max_tool_calls
                    ),
                ));
            }
            if self.open_index != Some(index) {
                self.close_open_call();
            }
            self.open_index = Some(index);
            if let Some(breach) = self.repetition_breach() {
                return Some(breach);
            }
        }

        let call = self.calls.entry(index).or_default();
        if let Some(name) = name.filter(|name| !name.is_empty()) {
            call.name = name.to_string();
        }
        if let Some(delta) = arguments_delta {
            call.arguments.push_str(delta);
        }

        self.stall_breach(now)
    }

    /// `limit` when that check is armed; `u64::MAX` when the caller disabled it with `0`.
    fn limit_of(&self, limit: u64) -> u64 {
        if limit == 0 { u64::MAX } else { limit }
    }

    /// Freeze the call whose arguments were still arriving and fold it into the repetition run.
    fn close_open_call(&mut self) {
        let Some(call) = self
            .open_index
            .take()
            .and_then(|index| self.calls.get(&index))
        else {
            return;
        };
        let fingerprint = normalized_fingerprint(call);
        self.repeated_run = if self.last_fingerprint.as_deref() == Some(fingerprint.as_str()) {
            self.repeated_run + 1
        } else {
            1
        };
        self.last_fingerprint = Some(fingerprint);
    }

    fn repetition_breach(&self) -> Option<Breach> {
        if self.repeated_run >= self.limit_of(self.budget.max_repeated_calls) {
            return Some(self.breach(
                BudgetLimit::RepeatedCalls,
                format!(
                    "the model repeated the same tool call {} times in a row, past the {} call ceiling",
                    self.repeated_run, self.budget.max_repeated_calls
                ),
            ));
        }
        None
    }

    fn stall_breach(&self, now: tokio::time::Instant) -> Option<Breach> {
        let limit = self.limit_of(self.budget.max_stream_secs);
        if limit == u64::MAX {
            return None;
        }
        let started = self.tool_channel_started?;
        let elapsed = now.duration_since(started);
        (elapsed >= Duration::from_secs(limit)).then(|| {
            self.breach(
                BudgetLimit::StallSecs,
                format!(
                    "tool-call arguments kept arriving for {}s without the turn producing anything else, past the {}s ceiling",
                    elapsed.as_secs(),
                    self.budget.max_stream_secs
                ),
            )
        })
    }

    fn breach(&self, limit: BudgetLimit, detail: String) -> Breach {
        Breach {
            limit,
            error: SamplingError::ToolCallBudgetExceeded(detail),
        }
    }
}

/// Whitespace-normalized `name` plus `arguments`, so a provider that only reformats a repeated call still trips the repetition ceiling.
/// JSON arguments are compared as parsed values, which drops insignificant whitespace (spacing, key layout) while keeping
/// parameter values exact: distinct calls legitimately share a name and parameter keys but not their values.
fn normalized_fingerprint(call: &InFlightCall) -> String {
    let arguments = match serde_json::from_str::<serde_json::Value>(&call.arguments) {
        Ok(value) => value.to_string(),
        Err(_) => collapse_whitespace(&call.arguments),
    };
    format!("{}\u{1}{}", call.name, arguments)
}

/// Collapse whitespace runs to a single space so a non-JSON payload still compares across formatting differences.
fn collapse_whitespace(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_whitespace = false;
    for ch in input.chars() {
        if ch.is_whitespace() {
            in_whitespace = true;
            continue;
        }
        if in_whitespace && !out.is_empty() {
            out.push(' ');
        }
        in_whitespace = false;
        out.push(ch);
    }
    out
}

/// Count one response's tool-call traffic and end it on the first ceiling reached.
/// Wrapped around every L2 transform at the dispatch site, so a provider looping on tool calls cannot
/// stream for ever behind an idle timer that every delta resets.
pub fn guard_tool_call_budget<'a, S>(
    events: S,
    request_id: RequestId,
    budget: ToolCallBudget,
) -> impl Stream<Item = SamplingEvent> + Send + 'a
where
    S: Stream<Item = SamplingEvent> + Send + 'a,
{
    async_stream::stream! {
        let mut state = ToolCallBudgetState::new(budget);
        let mut events = Box::pin(events);
        while let Some(event) = events.next().await {
            if let Some(breach) = state.observe(&event) {
                tracing::warn!(
                    target: crate::sampling_log::TARGET,
                    tool_call_budget = true,
                    limit = breach.limit.as_str(),
                    detail = %breach.error,
                    "tool-call budget exceeded; ending the attempt"
                );
                yield SamplingEvent::Failed {
                    request_id: request_id.clone(),
                    error: SamplingErrorInfo::from(&breach.error),
                };
                return;
            }
            yield event;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::SamplingChannel;
    use futures_util::stream::BoxStream;

    fn rid() -> RequestId {
        RequestId::from("test-req")
    }

    fn delta(index: u32, name: Option<&str>, arguments: Option<&str>) -> SamplingEvent {
        SamplingEvent::ToolCallDelta {
            request_id: rid(),
            tool_index: index,
            id: None,
            name: name.map(str::to_string),
            arguments_delta: arguments.map(str::to_string),
        }
    }

    fn text_token(text: &str) -> SamplingEvent {
        SamplingEvent::ChannelToken {
            request_id: rid(),
            channel: SamplingChannel::Text,
            text: text.to_string(),
            chunk_index: 0,
        }
    }

    fn stream_of(events: Vec<SamplingEvent>) -> BoxStream<'static, SamplingEvent> {
        futures_util::stream::iter(events).boxed()
    }

    async fn collect(events: Vec<SamplingEvent>, budget: ToolCallBudget) -> Vec<SamplingEvent> {
        guard_tool_call_budget(stream_of(events), rid(), budget)
            .collect()
            .await
    }

    /// One event per entry, each arriving `secs` after the previous one.
    fn spaced(events: Vec<(u64, SamplingEvent)>) -> BoxStream<'static, SamplingEvent> {
        futures_util::stream::iter(events)
            .then(|(secs, event)| async move {
                tokio::time::sleep(Duration::from_secs(secs)).await;
                event
            })
            .boxed()
    }

    async fn collect_spaced(
        events: Vec<(u64, SamplingEvent)>,
        budget: ToolCallBudget,
    ) -> Vec<SamplingEvent> {
        guard_tool_call_budget(spaced(events), rid(), budget)
            .collect()
            .await
    }

    fn failed_kind(events: &[SamplingEvent]) -> Option<crate::events::SamplingErrorKind> {
        match events.last()? {
            SamplingEvent::Failed { error, .. } => Some(error.kind),
            _ => None,
        }
    }

    #[tokio::test]
    async fn argument_bytes_past_the_ceiling_end_the_response() {
        let budget = ToolCallBudget {
            max_argument_bytes: 8,
            ..Default::default()
        };
        let events = collect(
            vec![
                delta(0, Some("grep"), Some("abcd")),
                delta(0, None, Some("efgh")),
                delta(0, None, Some("ijkl")),
            ],
            budget,
        )
        .await;

        assert_eq!(
            failed_kind(&events),
            Some(crate::events::SamplingErrorKind::ToolCallBudgetExceeded)
        );
        // The first two deltas are forwarded; the third is where the ceiling is crossed.
        assert_eq!(events.len(), 3);
        let SamplingEvent::Failed { error, .. } = events.last().unwrap() else {
            panic!("expected a Failed terminal event");
        };
        assert!(error.message.contains("12 bytes"), "{}", error.message);
        assert!(
            error.message.contains("8 byte ceiling"),
            "{}",
            error.message
        );
    }

    #[tokio::test]
    async fn distinct_call_indices_past_the_ceiling_end_the_response() {
        let budget = ToolCallBudget {
            max_tool_calls: 2,
            ..Default::default()
        };
        let events = collect(
            vec![
                delta(0, Some("grep"), Some("{}")),
                delta(1, Some("grep"), Some("{}")),
                delta(2, Some("grep"), Some("{}")),
            ],
            budget,
        )
        .await;

        assert_eq!(
            failed_kind(&events),
            Some(crate::events::SamplingErrorKind::ToolCallBudgetExceeded)
        );
        assert_eq!(events.len(), 3);
        let SamplingEvent::Failed { error, .. } = events.last().unwrap() else {
            panic!("expected a Failed terminal event");
        };
        assert!(error.message.contains("3 tool calls"), "{}", error.message);
    }

    #[tokio::test]
    async fn a_continuation_delta_for_a_known_index_is_not_a_new_call() {
        let budget = ToolCallBudget {
            max_tool_calls: 1,
            ..Default::default()
        };
        let events = collect(
            vec![
                delta(0, Some("grep"), Some("{}")),
                delta(0, None, Some("{}")),
            ],
            budget,
        )
        .await;

        assert!(failed_kind(&events).is_none(), "{events:?}");
        assert_eq!(events.len(), 2);
    }

    #[tokio::test]
    async fn a_run_of_identical_calls_ends_the_response_as_a_loop() {
        // Whitespace-only differences must not hide the loop; the fourth index is what closes the third call.
        let events = collect(
            vec![
                delta(0, Some("grep"), Some(r#"{"pattern": "x"}"#)),
                delta(1, Some("grep"), Some("{ \"pattern\" : \"x\" }")),
                delta(2, Some("grep"), Some(r#"{"pattern":"x"}"#)),
                delta(3, Some("grep"), Some(r#"{"pattern":"y"}"#)),
            ],
            ToolCallBudget {
                max_repeated_calls: 3,
                ..Default::default()
            },
        )
        .await;

        assert_eq!(
            failed_kind(&events),
            Some(crate::events::SamplingErrorKind::ToolCallBudgetExceeded)
        );
        let SamplingEvent::Failed { error, .. } = events.last().unwrap() else {
            panic!("expected a Failed terminal event");
        };
        assert!(
            error.message.contains("3 times in a row"),
            "{}",
            error.message
        );
    }

    #[tokio::test]
    async fn finite_identical_calls_pass_the_default_budget() {
        let events = collect(
            (0..5)
                .map(|index| delta(index, Some("echo"), Some(r#"{"text":"ping"}"#)))
                .collect(),
            ToolCallBudget::default(),
        )
        .await;
        assert_eq!(events.len(), 5);
        assert!(failed_kind(&events).is_none(), "{events:?}");
    }

    #[tokio::test]
    async fn distinct_consecutive_calls_do_not_trip_the_repetition_ceiling() {
        let events = collect(
            vec![
                delta(0, Some("read_file"), Some(r#"{"path": "a.rs"}"#)),
                delta(1, Some("read_file"), Some(r#"{"path": "b.rs"}"#)),
                delta(2, Some("read_file"), Some(r#"{"path": "c.rs"}"#)),
                delta(3, Some("read_file"), Some(r#"{"path": "d.rs"}"#)),
            ],
            ToolCallBudget::default(),
        )
        .await;

        assert!(failed_kind(&events).is_none(), "{events:?}");
        assert_eq!(events.len(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn text_output_restarts_the_tool_call_stall_clock() {
        let budget = ToolCallBudget {
            max_stream_secs: 100,
            ..Default::default()
        };
        // Every delta arrives 60s after the previous event, so the 240s total only stays under the
        // ceiling because the text token restarts the clock.
        let events = collect_spaced(
            vec![
                (60, delta(0, Some("grep"), Some("{}"))),
                (60, text_token("still working")),
                (60, delta(0, None, Some("{}"))),
                (60, delta(0, None, Some("{}"))),
            ],
            budget,
        )
        .await;
        assert!(failed_kind(&events).is_none(), "{events:?}");
        assert_eq!(events.len(), 4);

        // Without the text token the same spacing trips the ceiling.
        let events = collect_spaced(
            vec![
                (60, delta(0, Some("grep"), Some("{}"))),
                (60, delta(0, None, Some("{}"))),
                (60, delta(0, None, Some("{}"))),
            ],
            budget,
        )
        .await;
        assert_eq!(
            failed_kind(&events),
            Some(crate::events::SamplingErrorKind::ToolCallBudgetExceeded)
        );
        let SamplingEvent::Failed { error, .. } = events.last().unwrap() else {
            panic!("expected a Failed terminal event");
        };
        assert!(error.message.contains("120s"), "{}", error.message);
    }

    #[tokio::test]
    async fn a_zero_limit_disables_its_check() {
        let budget = ToolCallBudget {
            max_argument_bytes: 0,
            max_tool_calls: 0,
            max_stream_secs: 0,
            max_repeated_calls: 0,
        };
        let events = collect(
            vec![
                delta(0, Some("grep"), Some(r#"{"pattern":"x"}"#)),
                delta(1, Some("grep"), Some(r#"{"pattern":"x"}"#)),
                delta(2, Some("grep"), Some(r#"{"pattern":"x"}"#)),
                delta(3, Some("grep"), Some(r#"{"pattern":"x"}"#)),
            ],
            budget,
        )
        .await;

        assert!(failed_kind(&events).is_none(), "{events:?}");
        assert_eq!(events.len(), 4);
    }

    #[test]
    fn a_partial_config_override_keeps_the_defaults_for_the_rest() {
        let budget: ToolCallBudget =
            serde_json::from_str(r#"{"max_tool_calls": 8}"#).expect("parses");
        assert_eq!(budget.max_tool_calls, 8);
        assert_eq!(
            budget.max_argument_bytes,
            DEFAULT_MAX_TOOL_CALL_ARGUMENT_BYTES
        );
        assert_eq!(budget.max_stream_secs, DEFAULT_MAX_TOOL_CALL_STREAM_SECS);
        assert_eq!(budget.max_repeated_calls, DEFAULT_MAX_REPEATED_TOOL_CALLS);
    }

    #[tokio::test]
    async fn a_response_within_budget_forwards_every_event() {
        let events = collect(
            vec![
                delta(0, Some("grep"), Some(r#"{"pattern":"x"}"#)),
                text_token("done"),
            ],
            ToolCallBudget::default(),
        )
        .await;
        assert_eq!(events.len(), 2);
    }
}
