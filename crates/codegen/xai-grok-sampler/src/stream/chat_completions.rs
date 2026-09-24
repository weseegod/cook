//! Layer-2 stream transform for the Chat Completions API.
//!
//! Consumes a raw `ChatCompletionChunk` stream and produces [`SamplingEvent`]s.
//! Pure: no I/O, no shell coupling.

use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use futures_util::stream::{BoxStream, Stream};

use xai_grok_sampling_types::{
    AssistantItem, ChatCompletionChunk, ConversationItem, ConversationResponse, FinishReason,
    ResponseModelMetadata, SamplingError, StopReason, TokenUsage, ToolCall,
};

use crate::events::{SamplingChannel, SamplingErrorInfo, SamplingEvent};
use crate::metrics::InferenceLatencyStats;
use crate::stream::tool_call_budget::DEFAULT_MAX_PER_CALL_ARGUMENT_BYTES;
use crate::stream::tool_call_recovery::{ContentToolCallHoldback, recover_tool_calls_from_text};
use crate::types::RequestId;

type ToolCallParts = (String, String, String);

/// Accumulates streamed Chat Completions tool calls while tolerating providers that restart the
/// wire `index` at zero for a later call in the same response. The provider call id is the stable
/// identity; wire indices are only routing hints for argument-only continuation chunks.
#[derive(Default)]
struct ToolCallAccumulator {
    calls: BTreeMap<u32, ToolCallParts>,
    active_by_wire_index: BTreeMap<u32, u32>,
    next_logical_index: u64,
}

impl ToolCallAccumulator {
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

/// llama.cpp puts MiMo's literal XML envelopes in `tool_calls[].function.arguments`.
/// Those strings are not JSON, so the next-request sanitizer used to replace them with
/// `{}` and the tool ran with no path. Recover the envelopes and keep any sibling call
/// whose arguments were already valid JSON.
fn arguments_are_json(arguments: &str) -> bool {
    serde_json::from_str::<serde::de::IgnoredAny>(arguments).is_ok()
}

/// Markers llama.cpp inserts when a MiMo XML envelope is concatenated into a JSON string.
const XML_ARGUMENT_MARKERS: &[&str] = &[
    "<tool_call>",
    "</tool_call>",
    "</function>",
    "</parameter>",
    "<function=",
    "<parameter=",
];

fn earliest_xml_argument_marker(value: &str) -> Option<usize> {
    XML_ARGUMENT_MARKERS
        .iter()
        .filter_map(|marker| value.find(marker))
        .min()
}

/// A JSON object can still parse when an XML envelope was written inside a string value.
/// Cut each contaminated string at the marker so the tool does not execute the envelope.
/// Returns `None` when nothing was contaminated. An empty string means the object had no
/// remaining argument text and must not be executed.
fn strip_xml_embedded_in_json_arguments(arguments: &str) -> Option<String> {
    let mut value: serde_json::Value = serde_json::from_str(arguments).ok()?;
    let object = value.as_object_mut()?;
    let mut contaminated = false;
    for field in object.values_mut() {
        let serde_json::Value::String(text) = field else {
            continue;
        };
        let Some(at) = earliest_xml_argument_marker(text) else {
            continue;
        };
        contaminated = true;
        *text = text[..at].trim_end().to_owned();
    }
    if !contaminated {
        return None;
    }
    object.retain(|_, field| match field {
        serde_json::Value::String(text) => !text.is_empty(),
        _ => true,
    });
    let useful = object
        .values()
        .any(|field| matches!(field, serde_json::Value::String(text) if !text.is_empty()));
    useful.then(|| value.to_string())
}

/// An unclosed JSON string often runs up to an XML tag, with a literal `\n` (the two
/// characters, not a newline) where llama.cpp separated the tags. Close the string at the
/// marker and keep that object. The stuffed envelopes are the same ramble `complete_json_prefix`
/// already refuses to execute.
fn salvage_truncated_json_before_xml(arguments: &str) -> Option<String> {
    let at = earliest_xml_argument_marker(arguments)?;
    let mut head = arguments[..at].trim_end();
    while let Some(stripped) = head.strip_suffix("\\n") {
        head = stripped.trim_end();
    }
    if !head.starts_with('{') {
        return None;
    }
    let mut closed = head.to_owned();
    let mut in_string = false;
    let mut escape = false;
    let mut depth = 0i32;
    for ch in closed.chars() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
    }
    if in_string {
        closed.push('"');
    }
    while depth > 0 {
        closed.push('}');
        depth -= 1;
    }
    strip_xml_embedded_in_json_arguments(&closed).or_else(|| {
        let value: serde_json::Value = serde_json::from_str(&closed).ok()?;
        let object = value.as_object()?;
        let useful = object
            .values()
            .any(|field| matches!(field, serde_json::Value::String(text) if !text.is_empty()));
        useful.then(|| value.to_string())
    })
}

/// MiMo sometimes emits a complete structured argument object and then keeps generating an XML
/// tool envelope in the same string. Prefer the already-complete structured call: executing the
/// appended envelopes as siblings can turn one intended action into dozens of unrelated calls.
fn complete_json_prefix(arguments: &str) -> Option<&str> {
    let mut values = serde_json::Deserializer::from_str(arguments).into_iter::<serde_json::Value>();
    let value = values.next()?.ok()?;
    if !value.is_object() {
        return None;
    }
    let offset = values.byte_offset();
    let tail = arguments.get(offset..)?.trim_start();
    (tail.contains("<tool_call>")).then(|| &arguments[..offset])
}

fn promote_embedded_xml_calls(calls: Vec<ToolCall>, allowed: &HashSet<String>) -> Vec<ToolCall> {
    let mut embedded = String::new();
    let mut out = Vec::new();
    let mut unresolved = Vec::new();
    for mut call in calls {
        if arguments_are_json(call.arguments.as_ref()) {
            // XML after a closing brace is handled by `complete_json_prefix` and is not
            // promoted. XML inside a string still parses, and executing it writes the
            // envelope into the tool. Strip that text; do not run the inner envelopes
            // as extra calls (one stuffed blob can contain dozens of unrelated tools).
            match strip_xml_embedded_in_json_arguments(call.arguments.as_ref()) {
                Some(cleaned) => {
                    call.arguments = std::sync::Arc::<str>::from(cleaned);
                    out.push(call);
                }
                None if earliest_xml_argument_marker(call.arguments.as_ref()).is_some() => {}
                None => out.push(call),
            }
        } else if let Some(prefix) = complete_json_prefix(call.arguments.as_ref()) {
            call.arguments = std::sync::Arc::<str>::from(prefix);
            out.push(call);
        } else if let Some(salvaged) = salvage_truncated_json_before_xml(call.arguments.as_ref()) {
            call.arguments = std::sync::Arc::<str>::from(salvaged);
            out.push(call);
        } else {
            embedded.push_str(call.arguments.as_ref());
            unresolved.push(call);
        }
    }
    let recovered = recover_tool_calls_from_text(&embedded, allowed);
    if recovered.is_empty() {
        // No XML to promote: keep the wire calls. Dropping them turned a Length
        // stop with truncated JSON (or a raw path) into an empty MaxTokensTruncation.
        out.extend(unresolved);
        return out;
    }
    for (index, recovered) in recovered.into_iter().enumerate() {
        let already = out.iter().any(|call| {
            call.name == recovered.name
                && json_arguments_equal(&call.arguments, &recovered.arguments)
        });
        if already {
            continue;
        }
        out.push(ToolCall {
            id: std::sync::Arc::<str>::from(format!("embedded_xml_{index}")),
            name: recovered.name,
            arguments: std::sync::Arc::<str>::from(recovered.arguments),
        });
    }
    out
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

/// A model can emit the same call several times in one response with fresh ids. Those calls run
/// concurrently, so the copies cannot observe one another's results and only repeat the effect.
fn collapse_duplicate_calls(calls: Vec<ToolCall>) -> Vec<ToolCall> {
    let mut unique: Vec<ToolCall> = Vec::with_capacity(calls.len());
    for call in calls {
        if unique.iter().any(|seen| {
            seen.name == call.name
                && (json_arguments_equal(seen.arguments.as_ref(), call.arguments.as_ref())
                    || terminal_execution_equal(seen, &call))
        }) {
            continue;
        }
        unique.push(call);
    }
    unique
}

/// Descriptions label a terminal call but do not change the command it runs.
/// Keep execution options in the comparison: a foreground and background call
/// with the same command are not interchangeable.
fn terminal_execution_equal(left: &ToolCall, right: &ToolCall) -> bool {
    if left.name != "run_terminal_command" {
        return false;
    }
    let (Ok(mut left), Ok(mut right)) = (
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&left.arguments),
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&right.arguments),
    ) else {
        return false;
    };
    left.remove("description");
    right.remove("description");
    for arguments in [&mut left, &mut right] {
        if let Some(serde_json::Value::String(command)) = arguments.get_mut("command") {
            *command = xai_tool_types::terminal_command::command_execution_key(command);
        }
    }
    left == right
}

#[cfg(test)]
mod terminal_dedup_tests {
    use super::*;

    fn call(id: &str, arguments: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "run_terminal_command".into(),
            arguments: arguments.into(),
        }
    }

    #[test]
    fn duplicate_terminal_commands_ignore_description_only() {
        let calls = vec![
            call(
                "first",
                r#"{"command":"./job.sh","description":"one","background":true}"#,
            ),
            call(
                "second",
                r#"{"description":"two","background":true,"command":"./job.sh"}"#,
            ),
            call(
                "foreground",
                r#"{"command":"./job.sh","background":false}"#,
            ),
            call("other", r#"{"command":"echo done","background":true}"#),
        ];
        let unique = collapse_duplicate_calls(calls);
        assert_eq!(
            unique.iter().map(|c| c.id.as_ref()).collect::<Vec<_>>(),
            ["first", "foreground", "other"]
        );
    }

    #[test]
    fn duplicate_terminal_commands_share_runtime_execution_key() {
        let calls = vec![
            call("first", r#"{"command":"export A=1; B=2 job --fast"}"#),
            call("same", r#"{"command":"export A=1 B=2; job --fast"}"#),
            call("different", r#"{"command":"echo ready > out; job --fast"}"#),
        ];
        let unique = collapse_duplicate_calls(calls);
        assert_eq!(
            unique.iter().map(|c| c.id.as_ref()).collect::<Vec<_>>(),
            ["first", "different"]
        );
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
    stream_chat_completions_with_tools(
        raw_stream,
        model_metadata,
        request_id,
        idle_timeout,
        Vec::new(),
    )
}

/// Chat Completions transform with names of tools eligible for malformed-argument recovery.
pub fn stream_chat_completions_with_tools<'a>(
    raw_stream: BoxStream<'a, Result<ChatCompletionChunk, SamplingError>>,
    model_metadata: Option<ResponseModelMetadata>,
    request_id: RequestId,
    idle_timeout: Duration,
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
        // Call ids are stable when a provider reuses a wire index for a later call.
        let mut tool_calls = ToolCallAccumulator::default();
        let allowed_recovery: HashSet<String> = allowed_tool_names.iter().cloned().collect();
        let mut content_holdback = ContentToolCallHoldback::new(allowed_tool_names);

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
        loop {
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
                    if let FinishReason::Unknown(other) = &fr {
                        tracing::warn!(
                            request_id = %request_id,
                            finish_reason = %other,
                            "provider reported an unrecognized finish reason; ending the turn as a clean stop"
                        );
                    }
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
                    // Hold an unclosed `<tool_call>` suffix out of the visible text channel.
                    // Closed envelopes are recovered and stripped; only safe prose is forwarded.
                    let visible = content_holdback.push(&text);
                    if content_holdback.held_bytes() > DEFAULT_MAX_PER_CALL_ARGUMENT_BYTES as usize {
                        let err = SamplingError::ToolCallBudgetExceeded(format!(
                            "an open <tool_call> in content buffered {} bytes, past the {} byte per-call ceiling",
                            content_holdback.held_bytes(),
                            DEFAULT_MAX_PER_CALL_ARGUMENT_BYTES
                        ));
                        yield SamplingEvent::Failed {
                            request_id: request_id.clone(),
                            error: SamplingErrorInfo::from(&err),
                        };
                        return;
                    }
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
                    let (logical_index, remapped) = tool_calls
                        .resolve_logical_index(wire_index, tc_delta.id.as_deref());
                    let entry = tool_calls
                        .calls
                        .get_mut(&logical_index)
                        .expect("resolved logical tool-call index must exist");
                    if remapped {
                        tracing::warn!(
                            request_id = %request_id,
                            wire_index,
                            logical_index,
                            "provider reused a tool-call index with a new id"
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

                    // Execution waits for the final response, after argument recovery and deduplication.
                    yield SamplingEvent::ToolCallDelta {
                        request_id: request_id.clone(),
                        tool_index: logical_index,
                        id: id_for_event,
                        name: name_for_event,
                        arguments_delta: args_for_event,
                    };
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
        let (held_tail, content_recovered) = content_holdback.finish();
        if !held_tail.is_empty() {
            chunk_index += 1;
            message_chunk_count += 1;
            content_acc.push_str(&held_tail);
            yield SamplingEvent::ChannelToken {
                request_id: request_id.clone(),
                channel: SamplingChannel::Text,
                text: held_tail,
                chunk_index,
            };
        }

        let tool_calls: Vec<ToolCall> = tool_calls
            .calls
            .into_values()
            .map(parts_into_tool_call)
            .collect();
        let mut tool_calls = promote_embedded_xml_calls(tool_calls, &allowed_recovery);
        for (index, recovered) in content_recovered.into_iter().enumerate() {
            let already = tool_calls.iter().any(|call| {
                call.name == recovered.name
                    && json_arguments_equal(call.arguments.as_ref(), &recovered.arguments)
            });
            if already {
                continue;
            }
            tool_calls.push(ToolCall {
                id: std::sync::Arc::<str>::from(format!("content_xml_{index}")),
                name: recovered.name,
                arguments: std::sync::Arc::<str>::from(recovered.arguments),
            });
        }
        let original_count = tool_calls.len();
        let tool_calls = collapse_duplicate_calls(tool_calls);
        if tool_calls.len() != original_count {
            tracing::warn!(
                request_id = %request_id,
                original_count,
                unique_count = tool_calls.len(),
                "collapsed duplicate tool calls in one response"
            );
        }
        // Drop calls whose arguments are not a JSON object; keep valid siblings.
        // Aborting the whole response left the TUI showing in-progress widgets for calls
        // that never executed, and blocked every sibling that was already well-formed.
        let (tool_calls, invalid): (Vec<_>, Vec<_>) = tool_calls.into_iter().partition(|call| {
            serde_json::from_str::<serde_json::Value>(call.arguments.as_ref())
                .ok()
                .is_some_and(|value| value.is_object())
        });
        for call in &invalid {
            tracing::warn!(
                request_id = %request_id,
                tool_name = %call.name,
                tool_call_id = %call.id,
                "dropping tool call whose arguments are not a JSON object; siblings still execute"
            );
        }

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

    /// A provider-specific finish reason must end the turn, not fail it: the chunk carrying it is
    /// the last one, so failing the parse discards an already-streamed response (session 01a0c8a1).
    #[tokio::test]
    async fn unknown_finish_reason_completes_the_turn_instead_of_failing() {
        let chunks: Vec<Result<ChatCompletionChunk, SamplingError>> = vec![
            Ok(text_chunk("partial answer")),
            Ok(final_chunk(FinishReason::Unknown(
                "repetition_truncation".to_string(),
            ))),
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
                assert_eq!(response.assistant_text(), "partial answer");
                assert_eq!(response.stop_reason, Some(StopReason::Stop));
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

    /// A Length stop with a non-JSON tool call keeps the response: the bad call is dropped and
    /// the stop reason stays Length when nothing valid remains.
    #[tokio::test]
    async fn length_stop_keeps_non_json_non_xml_tool_arguments() {
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
                assert_eq!(response.stop_reason, Some(StopReason::Length));
                assert!(
                    response.assistant().map(|a| a.tool_calls.is_empty()).unwrap_or(true),
                    "non-JSON arguments must be dropped, not fail the response"
                );
            }
            other => panic!("expected Completed(Length), got {other:?}"),
        }
    }

    /// A Length stop with malformed arguments drops that call; the response still completes.
    #[tokio::test]
    async fn malformed_tool_arguments_dropped_before_execution() {
        let tool_chunk = make_chunk(vec![ChatChunkDelta {
            role: None,
            content: None,
            reasoning_content: None,
            tool_calls: vec![ChunkToolCallDelta {
                index: 0,
                id: Some("call_read".into()),
                kind: Some("function".into()),
                function: Some(ToolCallFunctionDelta {
                    name: Some("read_file".into()),
                    arguments: Some(
                        "/tmp/workdir/secret.txt</parameter></function></tool_call>".into(),
                    ),
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

        assert!(
            matches!(events.last(), Some(SamplingEvent::Completed { .. })),
            "{events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, SamplingEvent::Failed { .. }))
        );
    }

    /// One valid call and one non-JSON call: siblings still return ToolCalls.
    #[tokio::test]
    async fn mixed_valid_and_non_json_tool_calls_keep_the_valid_sibling() {
        let tool_chunk = make_chunk(vec![ChatChunkDelta {
            role: None,
            content: None,
            reasoning_content: None,
            tool_calls: vec![
                ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_good".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("read_file".into()),
                        arguments: Some(r#"{"target_file":"a.rs"}"#.into()),
                    }),
                },
                ChunkToolCallDelta {
                    index: 1,
                    id: Some("call_bad".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("read_file".into()),
                        arguments: Some("not-json".into()),
                    }),
                },
            ],
            tool_call_id: None,
        }]);
        let raw = stream::iter::<Vec<Result<ChatCompletionChunk, SamplingError>>>(vec![
            Ok(tool_chunk),
            Ok(final_chunk(FinishReason::ToolCalls)),
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
                let calls = &response.assistant().expect("assistant").tool_calls;
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "read_file");
                assert_eq!(calls[0].arguments.as_ref(), r#"{"target_file":"a.rs"}"#);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    /// An open `<tool_call>` in content is held out of Text until the close tag.
    #[tokio::test]
    async fn open_tool_call_in_content_is_held_until_closed() {
        let open = text_chunk("before <tool_call><function=read_file><parameter=target_file>a.rs");
        let close = text_chunk("</parameter></function></tool_call> after");
        let raw = stream::iter::<Vec<Result<ChatCompletionChunk, SamplingError>>>(vec![
            Ok(open),
            Ok(close),
            Ok(final_chunk(FinishReason::Stop)),
        ])
        .boxed();
        let events = collect(stream_chat_completions_with_tools(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
            vec!["read_file".into()],
        ))
        .await;

        let text: String = events
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
        assert!(
            !text.contains("<tool_call>"),
            "open envelope must not leak into Text: {text:?}"
        );
        assert!(text.contains("before"), "{text:?}");
        assert!(text.contains("after"), "{text:?}");

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert_eq!(response.stop_reason, Some(StopReason::ToolCalls));
                let calls = &response.assistant().expect("assistant").tool_calls;
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0].name, "read_file");
            }
            other => panic!("expected Completed, got {other:?}"),
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

    /// Local llama.cpp streams MiMo's XML envelopes as `function.arguments` chunks, including a
    /// newline after `<tool_call>`. The stream must recover the call instead of keeping
    /// the non-JSON argument string.
    #[tokio::test]
    async fn standard_path_recovers_xml_envelopes_stuffed_into_tool_arguments() {
        let arguments = concat!(
            "{\"target_directory\":\"</parameter>\\n</function></tool_call>",
            "<tool_call>\n<function=read_file><parameter=target_file>task.txt</parameter>\n</function>\n</tool_call>"
        );
        let chunks = vec![
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_list".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("list_dir".into()),
                        arguments: Some(arguments.into()),
                    }),
                }],
                ..Default::default()
            }]),
            final_chunk(FinishReason::ToolCalls),
        ];
        let events = collect(stream_chat_completions_with_tools(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["read_file".into(), "list_dir".into()],
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 1, "recovered calls: {calls:?}");
                assert_eq!(calls[0].name, "read_file");
                assert_eq!(calls[0].arguments.as_ref(), r#"{"target_file":"task.txt"}"#);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn standard_path_keeps_complete_json_prefix_and_ignores_appended_xml_calls() {
        let arguments = concat!(
            "{\"command\":\"printf ok\"}",
            "<tool_call><function=read_file><parameter=target_file>secret.txt</parameter>",
            "</function></tool_call>"
        );
        let chunks = vec![
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_bash".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("run_terminal_command".into()),
                        arguments: Some(arguments.into()),
                    }),
                }],
                ..Default::default()
            }]),
            final_chunk(FinishReason::ToolCalls),
        ];
        let events = collect(stream_chat_completions_with_tools(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["run_terminal_command".into(), "read_file".into()],
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 1, "calls: {calls:?}");
                assert_eq!(calls[0].name, "run_terminal_command");
                assert_eq!(calls[0].arguments.as_ref(), r#"{"command":"printf ok"}"#);
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    /// llama.cpp can close a JSON string only after it has already written an XML envelope into
    /// the value. The object parses, so the prefix splitter never runs, and the tool executes the
    /// envelope (a path or a shell command full of `</parameter>`). Keep the text before the
    /// marker and do not promote the stuffed envelopes as extra calls.
    #[tokio::test]
    async fn standard_path_strips_xml_envelopes_embedded_inside_json_strings() {
        let arguments = r#"{"command":"printf MARKER > out.txt\n</parameter></function></tool_call><tool_call><function=search_replace><parameter=file_path>out.txt</parameter></function></tool_call>","description":"write marker"}"#;
        let chunks = vec![
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_bash".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("run_terminal_command".into()),
                        arguments: Some(arguments.into()),
                    }),
                }],
                ..Default::default()
            }]),
            final_chunk(FinishReason::ToolCalls),
        ];
        let events = collect(stream_chat_completions_with_tools(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["run_terminal_command".into(), "search_replace".into()],
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(
                    calls.len(),
                    1,
                    "stuffed envelopes must not become calls: {calls:?}"
                );
                assert_eq!(calls[0].name, "run_terminal_command");
                let parsed: serde_json::Value =
                    serde_json::from_str(calls[0].arguments.as_ref()).expect("cleaned arguments");
                assert_eq!(parsed["command"], "printf MARKER > out.txt");
                assert_eq!(parsed["description"], "write marker");
                assert!(!calls[0].arguments.contains("</parameter>"));
                assert!(!calls[0].arguments.contains("<tool_call>"));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn standard_path_drops_a_json_call_whose_strings_are_only_xml_debris() {
        let arguments = r#"{"command":"</parameter>\n<parameter=description>Test</parameter></function></tool_call>"}"#;
        let chunks = vec![
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_bash".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("run_terminal_command".into()),
                        arguments: Some(arguments.into()),
                    }),
                }],
                ..Default::default()
            }]),
            final_chunk(FinishReason::Stop),
        ];
        let events = collect(stream_chat_completions_with_tools(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["run_terminal_command".into()],
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                assert!(
                    response.tool_calls().is_empty(),
                    "debris-only arguments must not run: {:?}",
                    response.tool_calls()
                );
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    /// The generation hits the token cap inside a JSON string, after llama.cpp has already
    /// written a literal `\n</parameter>` and more envelopes. Keep the command before that
    /// marker. Do not execute the stuffed sibling calls.
    #[tokio::test]
    async fn standard_path_salvages_an_unclosed_json_string_before_an_xml_marker() {
        let arguments = r#"{"command":"cat secret.txt > out.txt\n</parameter><parameter=description>copy</parameter></function></tool_call><tool_call><function=run_terminal_command>\n<parameter=command>\nxxd out.txt</parameter></function></tool_call>"#;
        let chunks = vec![
            make_chunk(vec![ChatChunkDelta {
                tool_calls: vec![ChunkToolCallDelta {
                    index: 0,
                    id: Some("call_bash".into()),
                    kind: Some("function".into()),
                    function: Some(ToolCallFunctionDelta {
                        name: Some("run_terminal_command".into()),
                        arguments: Some(arguments.into()),
                    }),
                }],
                ..Default::default()
            }]),
            final_chunk(FinishReason::Length),
        ];
        let events = collect(stream_chat_completions_with_tools(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["run_terminal_command".into()],
        ))
        .await;

        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 1, "stuffed calls must not run: {calls:?}");
                assert_eq!(calls[0].name, "run_terminal_command");
                let parsed: serde_json::Value =
                    serde_json::from_str(calls[0].arguments.as_ref()).expect("salvaged arguments");
                assert_eq!(parsed["command"], "cat secret.txt > out.txt");
                assert!(!calls[0].arguments.contains("</parameter>"));
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    /// Some streams start a later tool call with a fresh id
    /// while reusing wire index zero. The calls must remain separate instead of inheriting one
    /// another's argument fragments.
    #[tokio::test]
    async fn reused_wire_indices_follow_call_ids() {
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
        let events = collect(stream_chat_completions_with_tools(
            stream::iter(chunks.into_iter().map(Ok)).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["get_task_output".into(), "todo_write".into()],
        ))
        .await;

        // Four argument deltas use the two logical call indices.
        let logical_indices: Vec<u32> = events
            .iter()
            .filter_map(|event| match event {
                SamplingEvent::ToolCallDelta { tool_index, .. } => Some(*tool_index),
                _ => None,
            })
            .collect();
        assert_eq!(logical_indices, vec![0, 0, 1, 1]);

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
    async fn repeated_structured_calls_collapse_but_distinct_call_survives() {
        let chunks = (0..9)
            .map(|index| {
                Ok(make_chunk(vec![ChatChunkDelta {
                    tool_calls: vec![ChunkToolCallDelta {
                        index: 0,
                        id: Some(format!("call_{index}")),
                        kind: Some("function".into()),
                        function: Some(ToolCallFunctionDelta {
                            name: Some("grep".into()),
                            arguments: Some(if index < 8 {
                                r#"{"pattern":"same"}"#.into()
                            } else {
                                r#"{"pattern":"other"}"#.into()
                            }),
                        }),
                    }],
                    ..Default::default()
                }]))
            })
            .collect::<Vec<_>>();
        let stream = stream_chat_completions_with_tools(
            stream::iter(chunks).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["grep".into()],
        );
        let events = collect(crate::stream::guard_tool_call_budget(
            stream,
            rid(),
            crate::stream::ToolCallBudget::default(),
        ))
        .await;
        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 2);
                assert_eq!(calls[0].id.as_ref(), "call_0");
                assert_eq!(calls[0].arguments.as_ref(), r#"{"pattern":"same"}"#);
                assert_eq!(calls[1].id.as_ref(), "call_8");
                assert_eq!(calls[1].arguments.as_ref(), r#"{"pattern":"other"}"#);
            }
            other => panic!("expected one call through budget, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn three_distinct_parallel_calls_survive() {
        let chunks = ["alpha", "beta", "gamma"]
            .into_iter()
            .enumerate()
            .map(|(index, text)| {
                Ok(make_chunk(vec![ChatChunkDelta {
                    tool_calls: vec![ChunkToolCallDelta {
                        index: index as u32,
                        id: Some(format!("call_{index}")),
                        kind: Some("function".into()),
                        function: Some(ToolCallFunctionDelta {
                            name: Some("echo".into()),
                            arguments: Some(format!(r#"{{"text":"{text}"}}"#)),
                        }),
                    }],
                    ..Default::default()
                }]))
            })
            .collect::<Vec<_>>();
        let events = collect(stream_chat_completions_with_tools(
            stream::iter(chunks).boxed(),
            None,
            rid(),
            Duration::from_secs(60),
            vec!["echo".into()],
        ))
        .await;
        match events.last().unwrap() {
            SamplingEvent::Completed { response, .. } => {
                let calls = response.tool_calls();
                assert_eq!(calls.len(), 3);
                assert_eq!(calls[0].arguments.as_ref(), r#"{"text":"alpha"}"#);
                assert_eq!(calls[1].arguments.as_ref(), r#"{"text":"beta"}"#);
                assert_eq!(calls[2].arguments.as_ref(), r#"{"text":"gamma"}"#);
            }
            other => panic!("expected three parallel calls, got {other:?}"),
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

    /// Lesson 4 lock: tool-call progress must reach the consumer while the response is still open.
    /// The second chunk is withheld until a delta is observed, so a transform that buffers the whole
    /// generation before emitting anything stalls here instead of emitting deltas at the end.
    async fn a_tool_call_delta_precedes_the_terminal_event() {
        let (release, hold) = tokio::sync::oneshot::channel::<()>();
        let first = make_chunk(vec![ChatChunkDelta {
            tool_calls: vec![ChunkToolCallDelta {
                index: 0,
                id: Some("call_1".into()),
                kind: Some("function".into()),
                function: Some(ToolCallFunctionDelta {
                    name: Some("grep".into()),
                    arguments: Some("{\"path\":".into()),
                }),
            }],
            ..Default::default()
        }]);
        let mut last = final_chunk(FinishReason::ToolCalls);
        last.choices[0].delta.tool_calls = vec![ChunkToolCallDelta {
            index: 0,
            id: None,
            kind: None,
            function: Some(ToolCallFunctionDelta {
                name: None,
                arguments: Some("\"src\"}".into()),
            }),
        }];
        let raw = stream::iter([Ok(first)])
            .chain(stream::once(async move {
                let _ = hold.await;
                Ok(last)
            }))
            .boxed();

        let mut stream = Box::pin(stream_chat_completions_with_tools(
            raw,
            None,
            rid(),
            Duration::from_secs(60),
            Vec::new(),
        ));
        let mut release = Some(release);
        let mut events = Vec::new();
        loop {
            match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
                Ok(Some(event)) => {
                    if matches!(event, SamplingEvent::ToolCallDelta { .. })
                        && let Some(tx) = release.take()
                    {
                        let _ = tx.send(());
                    }
                    events.push(event);
                    if matches!(
                        events.last(),
                        Some(SamplingEvent::Completed { .. } | SamplingEvent::Failed { .. })
                    ) {
                        break;
                    }
                }
                Ok(None) => break,
                Err(_) => panic!(
                    "timed out waiting for a ToolCallDelta : the transform buffered the stream instead of forwarding tool-call progress"
                ),
            }
        }
        assert!(
            release.is_none(),
            "expected a ToolCallDelta before the terminal event "
        );
        assert!(
            matches!(events.last(), Some(SamplingEvent::Completed { .. })),
            "{events:?}"
        );
    }

    #[tokio::test]
    async fn tool_call_deltas_precede_completion() {
        a_tool_call_delta_precedes_the_terminal_event().await;
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
