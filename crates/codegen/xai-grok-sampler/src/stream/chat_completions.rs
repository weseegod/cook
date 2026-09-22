//! Layer-2 stream transform for the Chat Completions API.
//!
//! Consumes a raw `ChatCompletionChunk` stream and produces [`SamplingEvent`]s.
//! Pure: no I/O, no shell coupling.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use futures_util::stream::{BoxStream, Stream};

use xai_grok_sampling_types::{
    AssistantItem, ChatCompletionChunk, ConversationItem, ConversationResponse,
    ResponseModelMetadata, SamplingError, StopReason, TokenUsage, ToolCall,
};

use crate::ChatCompletionsAdapter;
use crate::events::{SamplingChannel, SamplingErrorInfo, SamplingEvent};
use crate::metrics::InferenceLatencyStats;
use crate::stream::xiaomi_chat::{RecoveredToolCall, XiaomiMimoAdapter};
use crate::types::RequestId;

type ToolCallParts = (String, String, String);

/// Accumulates streamed Chat Completions tool calls while tolerating providers that restart the
/// wire `index` at zero for a later call in the same response. The provider call id is the stable
/// identity; wire indices are only routing hints for argument-only continuation chunks.
#[derive(Default)]
struct XiaomiToolCallAccumulator {
    calls: BTreeMap<u32, ToolCallParts>,
    active_by_wire_index: BTreeMap<u32, u32>,
    next_logical_index: u64,
}

impl XiaomiToolCallAccumulator {
    fn resolve_logical_index(&mut self, wire_index: u32, incoming_id: Option<&str>) -> (u32, bool) {
        if let Some(&logical_index) = self.active_by_wire_index.get(&wire_index) {
            let current_id = self
                .calls
                .get(&logical_index)
                .map(|parts| parts.0.as_str())
                .unwrap_or_default();
            let starts_new_call = incoming_id
                .is_some_and(|id| !id.is_empty() && !current_id.is_empty() && id != current_id);
            if !starts_new_call {
                return (logical_index, false);
            }

            let logical_index = self.allocate_logical_index();
            self.active_by_wire_index.insert(wire_index, logical_index);
            return (logical_index, true);
        }

        // Preserve compliant provider indices when possible. This keeps existing event consumers
        // byte-for-byte compatible for ordinary 0,1,2... parallel calls.
        let logical_index = if self.calls.contains_key(&wire_index) {
            self.allocate_logical_index()
        } else {
            self.calls.entry(wire_index).or_default();
            self.next_logical_index = self.next_logical_index.max(u64::from(wire_index) + 1);
            wire_index
        };
        self.active_by_wire_index.insert(wire_index, logical_index);
        (logical_index, false)
    }

    fn allocate_logical_index(&mut self) -> u32 {
        while let Ok(candidate) = u32::try_from(self.next_logical_index) {
            if !self.calls.contains_key(&candidate) {
                self.calls.entry(candidate).or_default();
                self.next_logical_index += 1;
                return candidate;
            }
            self.next_logical_index += 1;
        }
        panic!("exhausted logical tool-call indices")
    }
}

fn parts_into_tool_call((id, name, arguments): ToolCallParts) -> ToolCall {
    ToolCall {
        id: std::sync::Arc::<str>::from(id),
        name,
        arguments: std::sync::Arc::<str>::from(arguments),
    }
}

fn select_xiaomi_calls(
    request_id: &RequestId,
    structured: Vec<ToolCallParts>,
    recovered: Vec<RecoveredToolCall>,
) -> Vec<ToolCall> {
    if recovered.is_empty() {
        return structured.into_iter().map(parts_into_tool_call).collect();
    }

    let mut structured = structured.into_iter().map(Some).collect::<Vec<_>>();
    recovered
        .into_iter()
        .enumerate()
        .map(|(index, recovered)| {
            let matching = structured.iter_mut().find(|slot| {
                slot.as_ref().is_some_and(|(_, name, arguments)| {
                    name == &recovered.name && json_arguments_equal(arguments, &recovered.arguments)
                })
            });
            let id = matching
                .and_then(Option::take)
                .map(|(id, _, _)| id)
                .filter(|id| !id.is_empty())
                .unwrap_or_else(|| format!("xiaomi_xml_{request_id}_{index}"));
            ToolCall {
                id: std::sync::Arc::<str>::from(id),
                name: recovered.name,
                arguments: std::sync::Arc::<str>::from(recovered.arguments),
            }
        })
        .collect()
}

fn json_arguments_equal(left: &str, right: &str) -> bool {
    match (
        serde_json::from_str::<serde_json::Value>(left),
        serde_json::from_str::<serde_json::Value>(right),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

/// The output stream emits exactly one terminal event per request.
/// Callers must not consume past the terminal event (the implementation `return`s after yielding it).
pub fn stream_chat_completions<'a>(
    raw_stream: BoxStream<'a, Result<ChatCompletionChunk, SamplingError>>,
    model_metadata: Option<ResponseModelMetadata>,
    request_id: RequestId,
    idle_timeout: Duration,
) -> impl Stream<Item = SamplingEvent> + Send + 'a {
    stream_chat_completions_with_adapter(
        raw_stream,
        model_metadata,
        request_id,
        idle_timeout,
        ChatCompletionsAdapter::Standard,
        Vec::new(),
    )
}

/// Chat Completions transform with an explicitly selected provider compatibility adapter.
/// The standard path remains strict OpenAI wire behavior; only the Xiaomi strategy interprets
/// MiMo's literal XML tool envelopes and reused indices.
pub fn stream_chat_completions_with_adapter<'a>(
    raw_stream: BoxStream<'a, Result<ChatCompletionChunk, SamplingError>>,
    model_metadata: Option<ResponseModelMetadata>,
    request_id: RequestId,
    idle_timeout: Duration,
    adapter: ChatCompletionsAdapter,
    allowed_tool_names: Vec<String>,
) -> impl Stream<Item = SamplingEvent> + Send + 'a {
    async_stream::stream! {
        let decode_region = crate::span_timing::Region::from_span(tracing::info_span!(
            "sampling.stream_decode",
            ttft_ms = tracing::field::Empty,
            ttlb_ms = tracing::field::Empty,
            output_tokens = tracing::field::Empty,
            chunk_count = tracing::field::Empty,
        ));
        let stream_start = Instant::now();
        let mut chunk_timestamps: Vec<Instant> = Vec::new();

        // Emit StreamStarted before reading any chunks so subscribers can record TTFB / TTLB baselines
        yield SamplingEvent::StreamStarted {
            request_id: request_id.clone(),
            timestamp_ms: chrono::Utc::now().timestamp_millis(),
        };

        if let Some(metadata) = model_metadata {
            yield SamplingEvent::ModelMetadata {
                request_id: request_id.clone(),
                metadata,
            };
        }

        // Per-response accumulators
        let mut first_chunk_seen = false;
        let mut first_choice_seen = false;
        let mut first_token_emitted = false;
        let mut model: String = String::new();
        let mut model_fingerprint: Option<String> = None;
        let mut usage: Option<TokenUsage> = None;
        let mut cost_usd_ticks: Option<i64> = None;
        let mut finish_reason: Option<StopReason> = None;

        let mut content_acc = String::new();
        let mut reasoning_acc = String::new();
        // Standard OpenAI-compatible calls are correlated only by their specified wire index.
        // Xiaomi's index-reuse workaround is isolated behind its selected adapter.
        let mut standard_tool_calls: BTreeMap<u32, ToolCallParts> = BTreeMap::new();
        let mut xiaomi_tool_calls = XiaomiToolCallAccumulator::default();
        let mut xiaomi_adapter = (adapter == ChatCompletionsAdapter::XiaomiMimo)
            .then(|| XiaomiMimoAdapter::new(allowed_tool_names));

        // Index counter spanning text and reasoning chunks (matches the shell's chunk_index used for notification correlation)
        let mut chunk_index: u64 = 0;
        // Separate counter for AgentMessageChunk (text-only) emissions
        // Mirrored onto ConversationResponse.message_chunks_emitted so downstream can detect lost streaming events
        let mut message_chunk_count: u64 = 0;

        // The outer `tokio::time::timeout(idle_timeout, stream.next())` already catches a transport that stops yielding chunks
        // This second timer catches the model emitting keepalive or empty-delta SSE events: they satisfy the outer timer but make no real progress
        // Some inference engines do exactly that
        let mut last_content_chunk_at = Instant::now();

        let mut stream = raw_stream;
        'stream: loop {
            let next = match tokio::time::timeout(idle_timeout, stream.next()).await {
                Ok(Some(next)) => next,
                Ok(None) => break, // stream ended normally
                Err(_elapsed) => {
                    let err = SamplingError::IdleTimeout {
                        elapsed_secs: idle_timeout.as_secs(),
                    };
                    yield SamplingEvent::Failed {
                        request_id: request_id.clone(),
                        error: SamplingErrorInfo::from(&err),
                    };
                    return;
                }
            };
            let chunk = match next {
                Ok(chunk) => chunk,
                Err(err) => {
                    yield SamplingEvent::Failed {
                        request_id: request_id.clone(),
                        error: SamplingErrorInfo::from(&err),
                    };
                    return;
                }
            };

            if !first_chunk_seen {
                model = chunk.model.clone();
                model_fingerprint = chunk
                    .system_fingerprint
                    .clone()
                    .filter(|s| !s.is_empty());
                first_chunk_seen = true;
            }

            if let Some(u) = chunk.usage.clone() {
                // Wire cost is cumulative for the response, so last-write-wins.
                // Never clobber a known cost with missing/unreported.
                let chunk_cost = xai_grok_sampling_types::reported_cost_ticks(u.cost_in_usd_ticks);
                cost_usd_ticks = match (cost_usd_ticks, chunk_cost) {
                    (_, Some(n)) => Some(n),
                    (prev, None) => prev,
                };
                usage = Some(u.into());
            }

            // Track whether this chunk carried meaningful content.
            // Set inside the choices loop and checked at the end.
            let mut chunk_has_content = false;

            for choice in chunk.choices.into_iter() {
                first_choice_seen = true;
                if let Some(fr) = choice.finish_reason {
                    finish_reason = Some(fr.into());
                    chunk_has_content = true;
                }

                let delta = choice.delta;

                if let Some(text) = delta.content
                    && !text.is_empty()
                {
                    if !first_token_emitted {
                        first_token_emitted = true;
                        yield SamplingEvent::FirstToken {
                            request_id: request_id.clone(),
                        };
                    }
                    chunk_has_content = true;
                    chunk_timestamps.push(Instant::now());
                    if let Some(adapter) = xiaomi_adapter.as_mut() {
                        let visible = adapter.push_text(&text);
                        if !visible.is_empty() {
                            chunk_index += 1;
                            message_chunk_count += 1;
                            content_acc.push_str(&visible);
                            yield SamplingEvent::ChannelToken {
                                request_id: request_id.clone(),
                                channel: SamplingChannel::Text,
                                text: visible,
                                chunk_index,
                            };
                        }
                        if adapter.should_salvage() {
                            tracing::warn!(
                                request_id = %request_id,
                                "xiaomi adapter stopped a repeated literal tool-call envelope"
                            );
                            finish_reason = Some(StopReason::ToolCalls);
                            break 'stream;
                        }
                    } else {
                        chunk_index += 1;
                        message_chunk_count += 1;
                        content_acc.push_str(&text);
                        yield SamplingEvent::ChannelToken {
                            request_id: request_id.clone(),
                            channel: SamplingChannel::Text,
                            text,
                            chunk_index,
                        };
                    }
                }

                if let Some(thought) = delta.reasoning_content
                    && !thought.is_empty()
                {
                    if !first_token_emitted {
                        first_token_emitted = true;
                        yield SamplingEvent::FirstToken {
                            request_id: request_id.clone(),
                        };
                    }
                    chunk_has_content = true;
                    chunk_index += 1;
                    reasoning_acc.push_str(&thought);
                    yield SamplingEvent::ChannelToken {
                        request_id: request_id.clone(),
                        channel: SamplingChannel::Reasoning,
                        text: thought,
                        chunk_index,
                    };
                }

                for tc_delta in delta.tool_calls.into_iter() {
                    chunk_has_content = true;
                    let wire_index = tc_delta.index;
                    let (logical_index, entry, remapped) = if xiaomi_adapter.is_some() {
                        let (logical_index, remapped) = xiaomi_tool_calls
                            .resolve_logical_index(wire_index, tc_delta.id.as_deref());
                        let entry = xiaomi_tool_calls
                            .calls
                            .get_mut(&logical_index)
                            .expect("resolved logical tool-call index must exist");
                        (logical_index, entry, remapped)
                    } else {
                        let entry = standard_tool_calls.entry(wire_index).or_default();
                        (wire_index, entry, false)
                    };
                    if remapped {
                        tracing::warn!(
                            request_id = %request_id,
                            wire_index,
                            logical_index,
                            "xiaomi adapter remapped a reused tool-call index"
                        );
                    }

                    let mut id_for_event: Option<String> = None;
                    let mut name_for_event: Option<String> = None;
                    let mut args_for_event: Option<String> = None;

                    if let Some(id) = tc_delta.id {
                        entry.0 = id.clone();
                        id_for_event = Some(id);
                    }
                    if let Some(func) = tc_delta.function {
                        if let Some(name) = func.name {
                            entry.1 = name.clone();
                            name_for_event = Some(name);
                        }
                        if let Some(args) = func.arguments {
                            entry.2.push_str(&args);
                            args_for_event = Some(args);
                        }
                    }

                    if xiaomi_adapter.is_none() {
                        yield SamplingEvent::ToolCallDelta {
                            request_id: request_id.clone(),
                            tool_index: logical_index,
                            id: id_for_event,
                            name: name_for_event,
                            arguments_delta: args_for_event,
                        };
                    }
                }
            }

            if chunk_has_content {
                last_content_chunk_at = Instant::now();
            } else if last_content_chunk_at.elapsed() > idle_timeout {
                let err = SamplingError::IdleTimeout {
                    elapsed_secs: idle_timeout.as_secs(),
                };
                yield SamplingEvent::Failed {
                    request_id: request_id.clone(),
                    error: SamplingErrorInfo::from(&err),
                };
                return;
            }
        }

        // ── Build the final response ─────────────────────────────────
        let tool_calls: Vec<ToolCall> = if let Some(adapter) = xiaomi_adapter {
            let structured: Vec<ToolCallParts> = xiaomi_tool_calls.calls.into_values().collect();
            let (tail, recovered, runaway) = adapter.finish();
            if !tail.is_empty() {
                chunk_index += 1;
                message_chunk_count += 1;
                content_acc.push_str(&tail);
                yield SamplingEvent::ChannelToken {
                    request_id: request_id.clone(),
                    channel: SamplingChannel::Text,
                    text: tail,
                    chunk_index,
                };
            }
            let recovered_from_xml = !recovered.is_empty();
            let selected = select_xiaomi_calls(&request_id, structured, recovered);
            if !selected.is_empty() {
                tracing::warn!(
                    request_id = %request_id,
                    recovered_from_xml,
                    runaway,
                    tool_call_count = selected.len(),
                    "xiaomi compatibility adapter selected tool calls"
                );
                for (tool_index, call) in selected.iter().enumerate() {
                    yield SamplingEvent::ToolCallDelta {
                        request_id: request_id.clone(),
                        tool_index: u32::try_from(tool_index).expect("tool-call count exceeds u32"),
                        id: Some(call.id.to_string()),
                        name: Some(call.name.clone()),
                        arguments_delta: Some(call.arguments.to_string()),
                    };
                }
            }
            selected
        } else {
            standard_tool_calls
                .into_values()
                .map(parts_into_tool_call)
                .collect()
        };

        // Tool calls override the stop reason, even an explicit `length`.
        // NOTE: the Messages backend has the opposite precedence: Length wins there
        // Load-bearing; don't "fix" here
        if !tool_calls.is_empty() {
            if finish_reason == Some(StopReason::Length) {
                tracing::warn!(
                    request_id = %request_id,
                    "tool calls mask a length-truncated response; arguments may be truncated"
                );
            }
            finish_reason = Some(StopReason::ToolCalls);
        }

        // Build the trailing Assistant and any reasoning sibling
        let mut items: Vec<ConversationItem> = Vec::new();
        if first_choice_seen {
            if !reasoning_acc.is_empty() {
                items.push(ConversationItem::Reasoning(
                    xai_grok_sampling_types::synthesized_reasoning_item(reasoning_acc),
                ));
            }
            items.push(ConversationItem::Assistant(AssistantItem {
                content: std::sync::Arc::<str>::from(content_acc),
                tool_calls,
                model_id: Some(model),
                model_fingerprint,
                // Chat Completions does not echo the applied reasoning effort.
                reasoning_effort: None,
            }));
        } else {
            items.push(ConversationItem::assistant(""));
        }

        let stream_end = Instant::now();
        let metrics =
            InferenceLatencyStats::from_timestamps(stream_start, &chunk_timestamps, stream_end);

        decode_region
            .span()
            .record("ttlb_ms", metrics.time_to_last_byte_ms as i64);
        decode_region
            .span()
            .record("chunk_count", metrics.chunk_count as i64);
        if let Some(ttft) = metrics.time_to_first_token_ms {
            decode_region.span().record("ttft_ms", ttft as i64);
        }
        if let Some(u) = usage.as_ref() {
            decode_region
                .span()
                .record("output_tokens", u.completion_tokens as i64);
        }
        drop(decode_region);

        let response = ConversationResponse {
            items,
            stop_reason: finish_reason,
            usage,
            cost_usd_ticks,
            message_chunks_emitted: message_chunk_count,
            doom_loop_signals: Vec::new(),
            stop_message: None,
            message_id: None,
            raw_stop_reason: None,
            stop_sequence: None,
        };

        yield SamplingEvent::Completed {
            request_id: request_id.clone(),
            response: Box::new(response),
            metrics,
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    fn nth<T>(xs: &[T], i: usize) -> &T {
        let Some(x) = xs.get(i) else {
            panic!("expected item {i}, got {} items", xs.len());
        };
        x
    }
    use std::pin::pin;
    use xai_grok_sampling_types::{
        ChatChunkChoice, ChatChunkDelta, FinishReason, Role, ToolCallDelta as ChunkToolCallDelta,
        ToolCallFunctionDelta, Usage, rs,
    };

    fn rid() -> RequestId {
        RequestId::from("test-req")
    }

    fn make_chunk(deltas: Vec<ChatChunkDelta>) -> ChatCompletionChunk {
        ChatCompletionChunk {
            id: "chunk-1".into(),
            object: "chat.completion.chunk".into(),
            created: 0,
            model: "test-model".into(),
            choices: deltas
                .into_iter()
                .enumerate()
                .map(|(i, delta)| ChatChunkChoice {
                    index: i as u32,
                    delta,
                    finish_reason: None,
                })
                .collect(),
            usage: None,
            system_fingerprint: None,
        }
    }

    fn text_chunk(text: &str) -> ChatCompletionChunk {
        make_chunk(vec![ChatChunkDelta {
            role: Some(Role::Assistant),
            content: Some(text.to_string()),
            reasoning_content: None,
            tool_calls: vec![],
            tool_call_id: None,
        }])
    }

    fn final_chunk(reason: FinishReason) -> ChatCompletionChunk {
        let mut chunk = make_chunk(vec![ChatChunkDelta::default()]);
        let Some(choice) = chunk.choices.first_mut() else {
            panic!("expected a choice");
        };
        choice.finish_reason = Some(reason);
        chunk
    }

    async fn collect(s: impl Stream<Item = SamplingEvent>) -> Vec<SamplingEvent> {
        let mut out = Vec::new();
        let mut s = pin!(s);
        while let Some(ev) = s.next().await {
            out.push(ev);
        }
        out
    }

    #[tokio::test]
    async fn empty_stream_yields_started_then_completed() {
        let raw = stream::iter(Vec::<Result<ChatCompletionChunk, SamplingError>>::new()).boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        assert_eq!(events.len(), 2);
        assert!(matches!(
            nth(&events, 0),
            SamplingEvent::StreamStarted { .. }
        ));
        match &nth(&events, 1) {
            SamplingEvent::Completed { response, .. } => {
                assert!(response.is_empty());
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn text_only_stream_emits_first_token_then_channel_tokens_then_completed() {
        let chunks: Vec<Result<ChatCompletionChunk, SamplingError>> = vec![
            Ok(text_chunk("Hello, ")),
            Ok(text_chunk("world!")),
            Ok(final_chunk(FinishReason::Stop)),
        ];
        let raw = stream::iter(chunks).boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        // Expected sequence: StreamStarted, FirstToken, two ChannelToken(Text), Completed
        assert!(matches!(
            nth(&events, 0),
            SamplingEvent::StreamStarted { .. }
        ));
        assert!(matches!(nth(&events, 1), SamplingEvent::FirstToken { .. }));

        let text_tokens: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                SamplingEvent::ChannelToken {
                    channel: SamplingChannel::Text,
                    text,
                    ..
                } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(text_tokens, vec!["Hello, ", "world!"]);

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let a = response.assistant().expect("assistant item present");
                assert_eq!(a.content.as_ref(), "Hello, world!");
                assert_eq!(response.stop_reason, Some(StopReason::Stop));
                assert_eq!(response.message_chunks_emitted, 2);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reasoning_chunk_emits_reasoning_channel_and_first_token_once() {
        let mut reasoning_chunk = make_chunk(vec![ChatChunkDelta {
            role: Some(Role::Assistant),
            content: None,
            reasoning_content: Some("thinking...".into()),
            tool_calls: vec![],
            tool_call_id: None,
        }]);
        let Some(choice) = reasoning_chunk.choices.first_mut() else {
            panic!("expected a choice");
        };
        choice.finish_reason = None;

        let chunks: Vec<Result<ChatCompletionChunk, SamplingError>> = vec![
            Ok(reasoning_chunk),
            Ok(text_chunk("done")),
            Ok(final_chunk(FinishReason::Stop)),
        ];
        let raw = stream::iter(chunks).boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        let first_token_count = events
            .iter()
            .filter(|e| matches!(e, SamplingEvent::FirstToken { .. }))
            .count();
        assert_eq!(first_token_count, 1);

        let mut saw_reasoning = false;
        let mut saw_text = false;
        for e in &events {
            if let SamplingEvent::ChannelToken { channel, text, .. } = e {
                match channel {
                    SamplingChannel::Reasoning => {
                        assert_eq!(text, "thinking...");
                        saw_reasoning = true;
                    }
                    SamplingChannel::Text => {
                        assert_eq!(text, "done");
                        saw_text = true;
                    }
                }
            }
        }
        assert!(saw_reasoning && saw_text);

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let r = response
                    .reasoning_items()
                    .next()
                    .expect("reasoning sibling preserved");
                let Some(part) = r.summary.first() else {
                    panic!("expected a summary part");
                };
                let rs::SummaryPart::SummaryText(t) = part;
                assert_eq!(t.text, "thinking...");
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    /// A text-only `length` finish completes with `stop_reason=Length` and the partial text preserved.
    /// Deciding whether to fail or salvage the truncation belongs to `drive_l2`, not this transform.
    #[tokio::test]
    async fn length_finish_completes_with_length_stop() {
        let raw = stream::iter::<Vec<Result<ChatCompletionChunk, SamplingError>>>(vec![
            Ok(text_chunk("truncated answ")),
            Ok(final_chunk(FinishReason::Length)),
        ])
        .boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert_eq!(response.stop_reason, Some(StopReason::Length));
                assert_eq!(response.assistant_text(), "truncated answ");
            }
            other => panic!("expected Completed(Length), got {other:?}"),
        }
    }

    /// Pins the load-bearing precedence: tool calls override an explicit `length` finish (opposite of the Messages backend).
    /// See the NOTE at the override site.
    #[tokio::test]
    async fn tool_calls_override_length_finish() {
        let tool_chunk = make_chunk(vec![ChatChunkDelta {
            role: None,
            content: None,
            reasoning_content: None,
            tool_calls: vec![ChunkToolCallDelta {
                index: 0,
                id: Some("call_cut".into()),
                kind: Some("function".into()),
                function: Some(ToolCallFunctionDelta {
                    name: Some("do_thing".into()),
                    arguments: Some("{\"x\": \"trunc".into()),
                }),
            }],
            tool_call_id: None,
        }]);
        let raw = stream::iter::<Vec<Result<ChatCompletionChunk, SamplingError>>>(vec![
            Ok(tool_chunk),
            Ok(final_chunk(FinishReason::Length)),
        ])
        .boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert_eq!(response.stop_reason, Some(StopReason::ToolCalls));
                assert_eq!(response.tool_calls().len(), 1);
            }
            other => panic!("expected Completed(ToolCalls), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn tool_call_stream_emits_deltas_and_assembles_final_call() {
        // First chunk has id, name, and part of arguments
        let chunk1 = make_chunk(vec![ChatChunkDelta {
            role: None,
            content: None,
            reasoning_content: None,
            tool_calls: vec![ChunkToolCallDelta {
                index: 0,
                id: Some("call_abc".into()),
                kind: Some("function".into()),
                function: Some(ToolCallFunctionDelta {
                    name: Some("do_thing".into()),
                    arguments: Some("{\"x\":".into()),
                }),
            }],
            tool_call_id: None,
        }]);
        // Second chunk has only an argument fragment
        let chunk2 = make_chunk(vec![ChatChunkDelta {
            role: None,
            content: None,
            reasoning_content: None,
            tool_calls: vec![ChunkToolCallDelta {
                index: 0,
                id: None,
                kind: None,
                function: Some(ToolCallFunctionDelta {
                    name: None,
                    arguments: Some("1}".into()),
                }),
            }],
            tool_call_id: None,
        }]);

        let raw = stream::iter::<Vec<Result<ChatCompletionChunk, SamplingError>>>(vec![
            Ok(chunk1),
            Ok(chunk2),
        ])
        .boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        let deltas: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                SamplingEvent::ToolCallDelta {
                    tool_index,
                    id,
                    name,
                    arguments_delta,
                    ..
                } => Some((
                    *tool_index,
                    id.clone(),
                    name.clone(),
                    arguments_delta.clone(),
                )),
                _ => None,
            })
            .collect();

        assert_eq!(deltas.len(), 2);
        assert_eq!(nth(&deltas, 0).0, 0);
        assert_eq!(nth(&deltas, 0).1.as_deref(), Some("call_abc"));
        assert_eq!(nth(&deltas, 0).2.as_deref(), Some("do_thing"));
        assert_eq!(nth(&deltas, 0).3.as_deref(), Some("{\"x\":"));
        assert_eq!(nth(&deltas, 1).1, None);
        assert_eq!(nth(&deltas, 1).2, None);
        assert_eq!(nth(&deltas, 1).3.as_deref(), Some("1}"));

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 1);
                assert_eq!(nth(calls, 0).id.as_ref(), "call_abc");
                assert_eq!(nth(calls, 0).name, "do_thing");
                assert_eq!(nth(calls, 0).arguments.as_ref(), "{\"x\":1}");
                assert_eq!(response.stop_reason, Some(StopReason::ToolCalls));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    /// Xiaomi-compatible streams have been observed starting a later tool call with a fresh id
    /// while reusing wire index zero. The calls must remain separate instead of inheriting one
    /// another's argument fragments.
    #[tokio::test]
    async fn xiaomi_adapter_remaps_reused_wire_indices_without_affecting_standard_path() {
        let chunks = vec![
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_wait".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("get_task_output".into()),
                        arguments: Some("{\"task_ids\":[\"task-1\"],".into()),
                    }),
                }],
                ..Default::default()
            }]),
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: None,
                    kind: None,
                    function: Some(ToolCallFunctionDelta {
                        name: None,
                        arguments: Some("\"timeout_ms\":600000}".into()),
                    }),
                }],
                ..Default::default()
            }]),
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_todo".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("todo_write".into()),
                        arguments: Some("{\"todos\":[".into()),
                    }),
                }],
                ..Default::default()
            }]),
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: None,
                    kind: None,
                    function: Some(ToolCallFunctionDelta {
                        name: None,
                        arguments: Some("{\"id\":\"1\",\"status\":\"completed\"}]}".into()),
                    }),
                }],
                ..Default::default()
            }]),
        ];
        let events = collect(stream_chat_completions_with_adapter(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            ChatCompletionsAdapter::XiaomiMimo,
            vec!["get_task_output".into(), "todo_write".into()],
        ))
        .await;

        let logical_indices: Vec<u32> = events
            .iter()
            .filter_map(|event| match event {
                SamplingEvent::ToolCallDelta { tool_index, .. } => Some(*tool_index),
                _ => None,
            })
            .collect();
        assert_eq!(logical_indices, vec![0, 1]);

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 2);
                assert_eq!(calls[0].id.as_ref(), "call_wait");
                assert_eq!(calls[0].name, "get_task_output");
                assert_eq!(
                    calls[0].arguments.as_ref(),
                    "{\"task_ids\":[\"task-1\"],\"timeout_ms\":600000}"
                );
                assert_eq!(calls[1].id.as_ref(), "call_todo");
                assert_eq!(calls[1].name, "todo_write");
                assert_eq!(
                    calls[1].arguments.as_ref(),
                    "{\"todos\":[{\"id\":\"1\",\"status\":\"completed\"}]}"
                );
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn xiaomi_xml_is_authoritative_over_corrupted_parallel_structured_calls() {
        let xml = "Waiting.<tool_call><function=get_command_or_subagent_output><parameter=task_ids>[\"task-1\"]</parameter><parameter=timeout_ms>180000</parameter></function></tool_call>";
        let chunk = make_chunk(vec![ChatChunkDelta {
            content: Some(xml.into()),
            tool_calls: vec![
                ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_wrong_read".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("read_file".into()),
                        arguments: Some(
                            r#"{"task_ids":["task-1"],"timeout_ms":{"target_file":"./model.sh"}"#
                                .into(),
                        ),
                    }),
                },
                ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_wrong_todo".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("todo_write".into()),
                        arguments: Some("{}".into()),
                    }),
                },
            ],
            ..Default::default()
        }]);
        let events = collect(stream_chat_completions_with_adapter(
            stream::iter([Ok(chunk)]).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            ChatCompletionsAdapter::XiaomiMimo,
            vec![
                "get_command_or_subagent_output".into(),
                "read_file".into(),
                "todo_write".into(),
            ],
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert_eq!(response.assistant_text(), "Waiting.");
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "get_command_or_subagent_output");
                assert_eq!(
                    serde_json::from_str::<serde_json::Value>(&calls[0].arguments).unwrap(),
                    serde_json::json!({"task_ids": ["task-1"], "timeout_ms": 180000})
                );
                assert!(calls[0].id.starts_with("xiaomi_xml_"));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn standard_adapter_does_not_interpret_literal_xiaomi_xml() {
        let xml = "<tool_call><function=get_command_or_subagent_output><parameter=task_ids>[\"task-1\"]</parameter></function></tool_call>";
        let events = collect(stream_chat_completions(
            stream::iter([Ok(text_chunk(xml))]).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert_eq!(response.assistant_text(), xml);
                assert!(response.tool_calls().is_empty());
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn xiaomi_repeated_xml_is_salvaged_before_the_stream_finishes() {
        let block = "<tool_call><function=get_command_or_subagent_output><parameter=task_ids>[\"task-1\"]</parameter><parameter=timeout_ms>180000</parameter></function></tool_call>";
        let chunks = vec![
            text_chunk(block),
            text_chunk(block),
            text_chunk(block),
            text_chunk("this chunk must never be consumed"),
        ];
        let events = collect(stream_chat_completions_with_adapter(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            ChatCompletionsAdapter::XiaomiMimo,
            vec!["get_command_or_subagent_output".into()],
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert!(response.assistant_text().is_empty());
                assert_eq!(response.tool_calls().len(), 1);
                assert_eq!(
                    response.tool_calls()[0].name,
                    "get_command_or_subagent_output"
                );
                assert_eq!(response.stop_reason, Some(StopReason::ToolCalls));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn compliant_parallel_tool_indices_remain_unchanged_when_interleaved() {
        let chunks = vec![
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![
                    ChunkToolCallDelta {
                        index: 0,
                        id: Some("call_a".into()),
                        kind: Some("function".into()),
                        function: Some(ToolCallFunctionDelta {
                            name: Some("tool_a".into()),
                            arguments: Some("{\"a\":".into()),
                        }),
                    },
                    ChunkToolCallDelta {
                        index: 1,
                        id: Some("call_b".into()),
                        kind: Some("function".into()),
                        function: Some(ToolCallFunctionDelta {
                            name: Some("tool_b".into()),
                            arguments: Some("{\"b\":".into()),
                        }),
                    },
                ],
                ..Default::default()
            }]),
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![
                    ChunkToolCallDelta {
                        index: 1,
                        function: Some(ToolCallFunctionDelta {
                            arguments: Some("2}".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                    ChunkToolCallDelta {
                        index: 0,
                        function: Some(ToolCallFunctionDelta {
                            arguments: Some("1}".into()),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            }]),
        ];
        let events = collect(stream_chat_completions(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        let logical_indices: Vec<u32> = events
            .iter()
            .filter_map(|event| match event {
                SamplingEvent::ToolCallDelta { tool_index, .. } => Some(*tool_index),
                _ => None,
            })
            .collect();
        assert_eq!(logical_indices, vec![0, 1, 1, 0]);
        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 2);
                assert_eq!(calls[0].arguments.as_ref(), "{\"a\":1}");
                assert_eq!(calls[1].arguments.as_ref(), "{\"b\":2}");
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn mid_stream_error_yields_failed_no_completed() {
        let chunks: Vec<Result<ChatCompletionChunk, SamplingError>> = vec![
            Ok(text_chunk("hi")),
            Err(SamplingError::EventStreamError("conn reset".into())),
        ];
        let raw = stream::iter(chunks).boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        assert!(
            events
                .iter()
                .any(|e| matches!(e, SamplingEvent::Failed { .. }))
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, SamplingEvent::Completed { .. }))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn idle_timeout_when_stream_stalls() {
        // A stream that yields one chunk then hangs forever.
        let raw = stream::iter(vec![Ok(text_chunk("hello"))])
            .chain(stream::pending())
            .boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_millis(100),
        ))
        .await;

        // The stream emits StreamStarted, FirstToken, ChannelToken, then Failed(IdleTimeout) when the stall hits the deadline
        match events.last().unwrap() {
            SamplingEvent::Failed { error, .. } => {
                assert_eq!(error.kind, crate::events::SamplingErrorKind::IdleTimeout);
            }
            other => panic!("expected Failed(IdleTimeout), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn model_metadata_yielded_after_stream_started() {
        let raw = stream::iter(Vec::<Result<ChatCompletionChunk, SamplingError>>::new()).boxed();
        let metadata = ResponseModelMetadata {
            context_window: Some(8192),
            max_completion_tokens: Some(4096),
            models_etag: None,
        };
        let events = collect(stream_chat_completions(
            raw,
            Some(metadata.clone()),
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        assert!(matches!(
            nth(&events, 0),
            SamplingEvent::StreamStarted { .. }
        ));
        match &nth(&events, 1) {
            SamplingEvent::ModelMetadata { metadata: m, .. } => {
                assert_eq!(m.context_window, Some(8192));
                assert_eq!(m.max_completion_tokens, Some(4096));
            }
            other => panic!("expected ModelMetadata second, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn usage_is_extracted_from_chunk() {
        let mut chunk_with_usage = make_chunk(vec![ChatChunkDelta::default()]);
        chunk_with_usage.usage = Some(Usage {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            prompt_tokens_details: None,
            completion_tokens_details: None,
            cost_in_usd_ticks: None,
        });

        let chunks: Vec<Result<ChatCompletionChunk, SamplingError>> = vec![
            Ok(text_chunk("ok")),
            Ok(chunk_with_usage),
            Ok(final_chunk(FinishReason::Stop)),
        ];
        let raw = stream::iter(chunks).boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let u = response.usage.as_ref().expect("usage extracted");
                assert_eq!(u.prompt_tokens, 100);
                assert_eq!(u.completion_tokens, 50);
                assert_eq!(u.total_tokens, 150);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    /// Server-reported cost lands on the response; the REST mapper's `0` backfill means "unreported" and must yield `None`.
    #[tokio::test]
    async fn cost_is_extracted_and_zero_is_unreported() {
        for (wire, expected) in [(Some(78), Some(78)), (Some(0), None), (None, None)] {
            let mut chunk_with_usage = make_chunk(vec![ChatChunkDelta::default()]);
            chunk_with_usage.usage = Some(Usage {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                prompt_tokens_details: None,
                completion_tokens_details: None,
                cost_in_usd_ticks: wire,
            });
            let chunks: Vec<Result<ChatCompletionChunk, SamplingError>> = vec![
                Ok(text_chunk("ok")),
                Ok(chunk_with_usage),
                Ok(final_chunk(FinishReason::Stop)),
            ];
            let raw = stream::iter(chunks).boxed();
            let events = collect(stream_chat_completions(
                raw,
                None,
                rid(),
                Duration::from_secs(60),
            ))
            .await;
            match events.last().unwrap() {
                SamplingEvent::Completed { response, .. } => {
                    assert_eq!(response.cost_usd_ticks, expected, "wire {wire:?}");
                }
                other => panic!("expected Completed, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn later_missing_cost_does_not_clobber_earlier_ticks() {
        let mut first = make_chunk(vec![ChatChunkDelta::default()]);
        first.usage = Some(Usage {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            prompt_tokens_details: None,
            completion_tokens_details: None,
            cost_in_usd_ticks: Some(99),
        });
        let mut second = make_chunk(vec![ChatChunkDelta::default()]);
        second.usage = Some(Usage {
            prompt_tokens: 12,
            completion_tokens: 6,
            total_tokens: 18,
            prompt_tokens_details: None,
            completion_tokens_details: None,
            cost_in_usd_ticks: Some(0),
        });
        let chunks: Vec<Result<ChatCompletionChunk, SamplingError>> = vec![
            Ok(text_chunk("ok")),
            Ok(first),
            Ok(second),
            Ok(final_chunk(FinishReason::Stop)),
        ];
        let raw = stream::iter(chunks).boxed();
        let events = collect(stream_chat_completions(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
        ))
        .await;
        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert_eq!(response.cost_usd_ticks, Some(99));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }
}
