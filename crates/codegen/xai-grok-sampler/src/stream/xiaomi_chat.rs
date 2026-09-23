//! Xiaomi MiMo compatibility for its non-standard Chat Completions stream.
//!
//! MiMo may expose the intended call as a literal XML envelope in `content` while its parallel
//! `tool_calls` deltas all reuse index zero. The standard transform must not guess around that
//! wire violation, so this adapter owns the narrow recovery grammar and repetition guard.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::stream::tool_call_budget::DEFAULT_MAX_TOOL_CALLS;

const TOOL_OPEN: &str = "<tool_call>";
const TOOL_CLOSE: &str = "</tool_call>";
const FUNCTION_OPEN: &str = "<function=";
const FUNCTION_CLOSE: &str = "</function>";
const PARAM_OPEN: &str = "<parameter=";
const PARAM_CLOSE: &str = "</parameter>";
const CODE_FENCE: &str = "```";
pub(super) const RUNAWAY_REPEAT_THRESHOLD: usize = DEFAULT_MAX_TOOL_CALLS as usize;
/// Bytes buffered for one in-flight call before the adapter stops reading: an open `<tool_call>`
/// envelope held back from `content`, or one call's accumulated `tool_calls[].arguments`. A model
/// past this is not progressing, so waiting for the completion budget only looks like a hang.
pub(super) const IN_FLIGHT_CALL_CEILING_BYTES: usize = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RecoveredToolCall {
    pub(super) name: String,
    pub(super) arguments: String,
}

/// Why the adapter stopped reading before the provider ended the stream.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SalvageReason {
    /// The same closed envelope arrived [`RUNAWAY_REPEAT_THRESHOLD`] times.
    RepeatedEnvelope,
    /// One call buffered more than [`IN_FLIGHT_CALL_CEILING_BYTES`].
    OversizeCall,
}

#[derive(Debug, Default)]
pub(super) struct XiaomiMimoAdapter {
    allowed_tools: HashSet<String>,
    raw_content: String,
    recovered_calls: Vec<RecoveredToolCall>,
    sanitized_content: String,
    emitted_content_len: usize,
    held_bytes: usize,
    runaway: bool,
}

/// One scan of the raw content: what is safe to show, which calls are complete, and how much of
/// a still-open envelope is being held back.
struct Extraction {
    sanitized: String,
    calls: Vec<RecoveredToolCall>,
    held_bytes: usize,
}

impl XiaomiMimoAdapter {
    pub(super) fn new(allowed_tools: impl IntoIterator<Item = String>) -> Self {
        Self {
            allowed_tools: allowed_tools.into_iter().collect(),
            ..Self::default()
        }
    }

    pub(super) fn push_text(&mut self, text: &str) -> String {
        self.raw_content.push_str(text);
        let extraction = extract_tool_calls(&self.raw_content, &self.allowed_tools, false);
        self.runaway = has_repeated_tail(&extraction.calls, RUNAWAY_REPEAT_THRESHOLD);
        self.held_bytes = extraction.held_bytes;
        self.sanitized_content = extraction.sanitized;
        self.recovered_calls = extraction.calls;
        let visible = self.sanitized_content[self.emitted_content_len..].to_owned();
        self.emitted_content_len = self.sanitized_content.len();
        visible
    }

    pub(super) fn salvage_reason(&self) -> Option<SalvageReason> {
        if self.runaway {
            Some(SalvageReason::RepeatedEnvelope)
        } else if self.held_bytes > IN_FLIGHT_CALL_CEILING_BYTES {
            Some(SalvageReason::OversizeCall)
        } else {
            None
        }
    }

    /// Complete the adapter. `finalize` is the stream ending normally, where text held for an
    /// unclosed envelope is still worth showing. A stream the adapter cut passes `false`: that
    /// text was never shown, and emitting it now is the raw-XML transcript the hold exists to
    /// prevent.
    pub(super) fn finish(mut self, finalize: bool) -> (String, Vec<RecoveredToolCall>, bool) {
        let extraction = extract_tool_calls(&self.raw_content, &self.allowed_tools, finalize);
        let tail = extraction.sanitized[self.emitted_content_len..].to_owned();
        self.sanitized_content = extraction.sanitized;
        self.recovered_calls = extraction.calls;
        let calls = if self.runaway {
            collapse_repeated_tail(self.recovered_calls)
        } else {
            self.recovered_calls
        };
        (tail, calls, self.runaway)
    }
}

fn has_repeated_tail(calls: &[RecoveredToolCall], threshold: usize) -> bool {
    let Some(last) = calls.last() else {
        return false;
    };
    calls
        .iter()
        .rev()
        .take_while(|call| *call == last)
        .take(threshold)
        .count()
        >= threshold
}

fn collapse_repeated_tail(mut calls: Vec<RecoveredToolCall>) -> Vec<RecoveredToolCall> {
    let Some(last) = calls.last().cloned() else {
        return calls;
    };
    let repeated = calls.iter().rev().take_while(|call| **call == last).count();
    if repeated >= RUNAWAY_REPEAT_THRESHOLD {
        calls.truncate(calls.len() - repeated + 1);
    }
    calls
}

fn extract_tool_calls(
    content: &str,
    allowed_tools: &HashSet<String>,
    finalizing: bool,
) -> Extraction {
    let mut sanitized = String::with_capacity(content.len());
    let mut calls = Vec::new();
    let mut held_bytes = 0;
    let mut cursor = 0;
    let mut in_code_fence = false;

    while cursor < content.len() {
        let rest = &content[cursor..];
        let next_fence = rest.find(CODE_FENCE);
        let next_tool = (!in_code_fence).then(|| rest.find(TOOL_OPEN)).flatten();

        match (next_fence, next_tool) {
            (Some(fence), Some(tool)) if fence <= tool => {
                let end = cursor + fence + CODE_FENCE.len();
                sanitized.push_str(&content[cursor..end]);
                cursor = end;
                in_code_fence = !in_code_fence;
            }
            (Some(fence), None) => {
                let end = cursor + fence + CODE_FENCE.len();
                sanitized.push_str(&content[cursor..end]);
                cursor = end;
                in_code_fence = !in_code_fence;
            }
            (_, Some(tool)) => {
                let start = cursor + tool;
                sanitized.push_str(&content[cursor..start]);
                let Some(relative_end) = content[start..].find(TOOL_CLOSE) else {
                    if finalizing {
                        sanitized.push_str(&content[start..]);
                    } else {
                        held_bytes = content.len() - start;
                    }
                    break;
                };
                let end = start + relative_end + TOOL_CLOSE.len();
                let envelope = &content[start..end];
                if let Some(call) = parse_envelope(envelope, allowed_tools) {
                    calls.push(call);
                } else {
                    sanitized.push_str(envelope);
                }
                cursor = end;
            }
            (None, None) => {
                if finalizing || in_code_fence {
                    sanitized.push_str(rest);
                } else {
                    let held = longest_tool_prefix_suffix(rest);
                    held_bytes = held;
                    sanitized.push_str(&rest[..rest.len() - held]);
                }
                break;
            }
        }
    }

    Extraction {
        sanitized,
        calls,
        held_bytes,
    }
}

fn longest_tool_prefix_suffix(text: &str) -> usize {
    (1..TOOL_OPEN.len())
        .rev()
        .find(|&len| text.ends_with(&TOOL_OPEN[..len]))
        .unwrap_or(0)
}

/// llama.cpp inserts either a real newline or the two-character JSON escape `\n` between tags.
fn skip_xml_separators(text: &str) -> &str {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_whitespace() {
            index += 1;
            continue;
        }
        if index + 1 < bytes.len() && bytes[index] == b'\\' && bytes[index + 1] == b'n' {
            index += 2;
            continue;
        }
        break;
    }
    &text[index..]
}

fn trim_xml_separators(text: &str) -> &str {
    let start = skip_xml_separators(text);
    let bytes = start.as_bytes();
    let mut end = bytes.len();
    loop {
        if end > 0 && bytes[end - 1].is_ascii_whitespace() {
            end -= 1;
            continue;
        }
        if end >= 2 && bytes[end - 2] == b'\\' && bytes[end - 1] == b'n' {
            end -= 2;
            continue;
        }
        break;
    }
    &start[..end]
}

fn parse_envelope(envelope: &str, allowed_tools: &HashSet<String>) -> Option<RecoveredToolCall> {
    // llama.cpp streams the envelope as argument deltas and often inserts a
    // newline between the tags. Trim so `<tool_call>\n<function=...>` still parses.
    let inner = skip_xml_separators(
        envelope
            .strip_prefix(TOOL_OPEN)?
            .strip_suffix(TOOL_CLOSE)?
            .trim(),
    );
    let function = inner.strip_prefix(FUNCTION_OPEN)?;
    let name_end = function.find('>')?;
    let name = function[..name_end].trim();
    if name.is_empty() || !allowed_tools.contains(name) {
        return None;
    }
    // A newline before `</function>` is part of the same llama.cpp chunking.
    let body = function[name_end + 1..].trim();
    let close_at = body.rfind(FUNCTION_CLOSE)?;
    let params = body[..close_at].trim();
    let mut cursor = 0;
    let mut arguments = Map::new();
    while cursor < params.len() {
        let rest = &params[cursor..];
        let skipped = rest.len() - skip_xml_separators(rest).len();
        cursor += skipped;
        let rest = &params[cursor..];
        if rest.is_empty() {
            break;
        }
        let Some(parameter) = rest.strip_prefix(PARAM_OPEN) else {
            return None;
        };
        let key_end = parameter.find('>')?;
        let key = parameter[..key_end].trim();
        if key.is_empty() {
            return None;
        }
        let value_start = key_end + 1;
        let value_end = parameter[value_start..].find(PARAM_CLOSE)? + value_start;
        let raw_value = trim_xml_separators(&parameter[value_start..value_end]);
        let value =
            serde_json::from_str(raw_value).unwrap_or_else(|_| Value::String(raw_value.to_owned()));
        arguments.insert(key.to_owned(), value);
        cursor += PARAM_OPEN.len() + value_end + PARAM_CLOSE.len();
    }

    Some(RecoveredToolCall {
        name: name.to_owned(),
        arguments: Value::Object(arguments).to_string(),
    })
}

/// Tool calls MiMo stuffed into a Chat Completions `arguments` string instead of `content`.
pub(super) fn recover_tool_calls_from_text(
    content: &str,
    allowed_tools: &HashSet<String>,
) -> Vec<RecoveredToolCall> {
    if !content.contains(TOOL_OPEN) {
        return Vec::new();
    }
    extract_tool_calls(content, allowed_tools, true).calls
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> HashSet<String> {
        ["wait", "todo_write"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    fn allowed_read() -> HashSet<String> {
        ["read_file"].into_iter().map(str::to_owned).collect()
    }

    #[test]
    fn parses_envelope_when_llama_inserts_a_json_escaped_newline_between_tags() {
        let input = "<tool_call>\\n<function=read_file>\\n<parameter=target_file>\\ntask.txt</parameter>\\n</function>\\n</tool_call>";
        let extraction = extract_tool_calls(input, &allowed_read(), true);
        assert_eq!(extraction.calls.len(), 1);
        assert_eq!(extraction.calls[0].name, "read_file");
        assert_eq!(
            extraction.calls[0].arguments,
            r#"{"target_file":"task.txt"}"#
        );
    }

    #[test]
    fn parses_envelope_when_llama_inserts_a_newline_after_tool_call() {
        let input = "<tool_call>\n<function=read_file><parameter=target_file>task.txt</parameter>\n</function>\n</tool_call>";
        let extraction = extract_tool_calls(input, &allowed_read(), true);
        assert_eq!(extraction.sanitized, "");
        assert_eq!(extraction.calls.len(), 1);
        assert_eq!(extraction.calls[0].name, "read_file");
        assert_eq!(
            extraction.calls[0].arguments,
            r#"{"target_file":"task.txt"}"#
        );
    }

    #[test]
    fn extracts_parameters_and_preserves_surrounding_prose() {
        let input = "before <tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter><parameter=timeout_ms>600000</parameter></function></tool_call> after";
        let extraction = extract_tool_calls(input, &allowed(), true);
        assert_eq!(extraction.sanitized, "before  after");
        assert_eq!(extraction.calls.len(), 1);
        assert_eq!(extraction.calls[0].name, "wait");
        assert_eq!(
            extraction.calls[0].arguments,
            r#"{"task_ids":["t1"],"timeout_ms":600000}"#
        );
    }

    #[test]
    fn ignores_code_fences_and_unknown_tools() {
        let fenced = "```xml\n<tool_call><function=wait></function></tool_call>\n```";
        let unknown = "<tool_call><function=delete_everything></function></tool_call>";
        let input = format!("{fenced}{unknown}");
        let extraction = extract_tool_calls(&input, &allowed(), true);
        assert_eq!(extraction.sanitized, input);
        assert!(extraction.calls.is_empty());
    }

    /// The held count is the open envelope, not every byte the scan consumed.
    #[test]
    fn counts_only_the_still_open_envelope_as_held() {
        let block = "<tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter></function></tool_call>";
        let closed = extract_tool_calls(&format!("{block}prose"), &allowed(), false);
        assert_eq!(closed.sanitized, "prose");
        assert_eq!(closed.held_bytes, 0);

        let open = extract_tool_calls(
            &format!("prose{block}<tool_call><function=wait>"),
            &allowed(),
            false,
        );
        assert_eq!(open.sanitized, "prose");
        assert_eq!(
            open.held_bytes,
            "<tool_call><function=wait>".len(),
            "only the unclosed envelope is held"
        );
    }

    #[test]
    fn detects_and_deduplicates_a_repeated_tail() {
        let block = "<tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter></function></tool_call>";
        let mut adapter = XiaomiMimoAdapter::new(["wait".to_owned()]);
        let visible = adapter.push_text(&block.repeat(RUNAWAY_REPEAT_THRESHOLD));
        assert!(visible.is_empty());
        assert_eq!(
            adapter.salvage_reason(),
            Some(SalvageReason::RepeatedEnvelope)
        );
        let (tail, calls, runaway) = adapter.finish(true);
        assert!(tail.is_empty());
        assert!(runaway);
        assert_eq!(calls.len(), 1);
    }

    #[test]
    fn preserves_five_identical_calls_below_the_runaway_threshold() {
        let block = "<tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter></function></tool_call>";
        let mut adapter = XiaomiMimoAdapter::new(["wait".to_owned()]);
        assert!(adapter.push_text(&block.repeat(5)).is_empty());
        assert_eq!(adapter.salvage_reason(), None);

        let (_, calls, runaway) = adapter.finish(true);
        assert!(!runaway);
        assert_eq!(calls.len(), 5);
    }

    #[test]
    fn streams_prose_while_holding_an_xml_envelope_split_across_chunks() {
        let mut adapter = XiaomiMimoAdapter::new(["wait".to_owned()]);
        assert_eq!(adapter.push_text("before <tool_"), "before ");
        assert_eq!(
            adapter.push_text(
                "call><function=wait><parameter=timeout_ms>100</parameter></function></tool_call> after"
            ),
            " after"
        );

        let (tail, calls, runaway) = adapter.finish(true);
        assert!(tail.is_empty());
        assert!(!runaway);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "wait");
        assert_eq!(calls[0].arguments, r#"{"timeout_ms":100}"#);
    }

    #[test]
    fn an_open_envelope_past_the_ceiling_asks_to_be_cut() {
        let mut adapter = XiaomiMimoAdapter::new(["read_file".to_owned()]);
        adapter.push_text("<tool_call><function=read_file><parameter=target_file>");
        assert_eq!(adapter.salvage_reason(), None);

        adapter.push_text(&"x".repeat(IN_FLIGHT_CALL_CEILING_BYTES));
        assert_eq!(adapter.salvage_reason(), Some(SalvageReason::OversizeCall));

        // Cut: the held envelope is dropped rather than shown as raw XML.
        let (tail, calls, runaway) = adapter.finish(false);
        assert!(tail.is_empty());
        assert!(calls.is_empty());
        assert!(!runaway);
    }
}
