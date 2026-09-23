//! Recovery of XML tool envelopes embedded in malformed Chat Completions arguments
//! or streamed in `content`. The shared stream budget bounds this fallback for local
//! OpenAI-compatible servers.

use serde_json::{Map, Value};
use std::collections::HashSet;

const TOOL_OPEN: &str = "<tool_call>";
const TOOL_CLOSE: &str = "</tool_call>";
const FUNCTION_OPEN: &str = "<function=";
const FUNCTION_CLOSE: &str = "</function>";
const PARAM_OPEN: &str = "<parameter=";
const PARAM_CLOSE: &str = "</parameter>";
const CODE_FENCE: &str = "```";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RecoveredToolCall {
    pub(super) name: String,
    pub(super) arguments: String,
}

/// Incremental scan of Chat Completions `content` that may contain `<tool_call>` envelopes.
/// Closed envelopes are recovered and removed from the visible text; an unclosed open tag is
/// held back until the close tag arrives or the stream ends.
#[derive(Debug, Default)]
pub(super) struct ContentToolCallHoldback {
    allowed_tools: HashSet<String>,
    raw: String,
    emitted_len: usize,
    recovered: Vec<RecoveredToolCall>,
}

/// One scan of buffered content: text safe to show, recovered calls, and how many trailing
/// bytes are still held for an open envelope (or a partial `<tool_call` prefix).
struct ContentExtraction {
    sanitized: String,
    calls: Vec<RecoveredToolCall>,
    held_bytes: usize,
}

impl ContentToolCallHoldback {
    pub(super) fn new(allowed_tools: impl IntoIterator<Item = String>) -> Self {
        Self {
            allowed_tools: allowed_tools.into_iter().collect(),
            ..Default::default()
        }
    }

    /// Append a content delta. Returns text that is safe to emit now (excludes any open envelope).
    pub(super) fn push(&mut self, text: &str) -> String {
        self.raw.push_str(text);
        self.resync(false)
    }

    /// End of stream: flush any held open-envelope text into the visible tail and recover
    /// whatever closed envelopes remain.
    pub(super) fn finish(mut self) -> (String, Vec<RecoveredToolCall>) {
        let visible = self.resync(true);
        (visible, self.recovered)
    }

    /// Bytes currently held back from `content` for an open envelope (for the per-call ceiling).
    pub(super) fn held_bytes(&self) -> usize {
        extract_content_tool_calls(&self.raw, &self.allowed_tools, false).held_bytes
    }

    fn resync(&mut self, finalizing: bool) -> String {
        let extraction = extract_content_tool_calls(&self.raw, &self.allowed_tools, finalizing);
        self.recovered = extraction.calls;
        let sanitized = extraction.sanitized;
        let visible = sanitized[self.emitted_len.min(sanitized.len())..].to_owned();
        self.emitted_len = sanitized.len();
        visible
    }
}

fn extract_content_tool_calls(
    content: &str,
    allowed_tools: &HashSet<String>,
    finalizing: bool,
) -> ContentExtraction {
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
                sanitized.push_str(&rest[..fence + CODE_FENCE.len()]);
                cursor += fence + CODE_FENCE.len();
                in_code_fence = !in_code_fence;
            }
            (Some(fence), None) => {
                sanitized.push_str(&rest[..fence + CODE_FENCE.len()]);
                cursor += fence + CODE_FENCE.len();
                in_code_fence = !in_code_fence;
            }
            (_, Some(tool)) => {
                sanitized.push_str(&rest[..tool]);
                let start = cursor + tool;
                let Some(relative_end) = content[start..].find(TOOL_CLOSE) else {
                    if finalizing {
                        sanitized.push_str(&content[start..]);
                    } else {
                        held_bytes = content.len() - start;
                    }
                    break;
                };
                let end = start + relative_end + TOOL_CLOSE.len();
                if let Some(call) = parse_envelope(&content[start..end], allowed_tools) {
                    calls.push(call);
                } else {
                    // Unknown / unparseable envelope: keep the raw text visible.
                    sanitized.push_str(&content[start..end]);
                }
                cursor = end;
            }
            (None, None) => {
                if finalizing {
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

    ContentExtraction {
        sanitized,
        calls,
        held_bytes,
    }
}

fn longest_tool_prefix_suffix(text: &str) -> usize {
    let bytes = text.as_bytes();
    for len in (1..TOOL_OPEN.len()).rev() {
        if bytes.len() >= len && bytes[bytes.len() - len..] == TOOL_OPEN.as_bytes()[..len] {
            return len;
        }
    }
    0
}

fn extract_tool_calls(content: &str, allowed_tools: &HashSet<String>) -> Vec<RecoveredToolCall> {
    extract_content_tool_calls(content, allowed_tools, true).calls
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

/// Recover tool envelopes placed in a Chat Completions `arguments` string.
pub(super) fn recover_tool_calls_from_text(
    content: &str,
    allowed_tools: &HashSet<String>,
) -> Vec<RecoveredToolCall> {
    if !content.contains(TOOL_OPEN) {
        return Vec::new();
    }
    extract_tool_calls(content, allowed_tools)
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
        let calls = extract_tool_calls(input, &allowed_read());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, r#"{"target_file":"task.txt"}"#);
    }

    #[test]
    fn parses_envelope_when_llama_inserts_a_newline_after_tool_call() {
        let input = "<tool_call>\n<function=read_file><parameter=target_file>task.txt</parameter>\n</function>\n</tool_call>";
        let calls = extract_tool_calls(input, &allowed_read());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read_file");
        assert_eq!(calls[0].arguments, r#"{"target_file":"task.txt"}"#);
    }

    #[test]
    fn extracts_parameters_with_surrounding_prose() {
        let input = "before <tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter><parameter=timeout_ms>600000</parameter></function></tool_call> after";
        let calls = extract_tool_calls(input, &allowed());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "wait");
        assert_eq!(
            calls[0].arguments,
            r#"{"task_ids":["t1"],"timeout_ms":600000}"#
        );
    }

    #[test]
    fn ignores_code_fences_and_unknown_tools() {
        let fenced = "```xml\n<tool_call><function=wait></function></tool_call>\n```";
        let unknown = "<tool_call><function=delete_everything></function></tool_call>";
        let input = format!("{fenced}{unknown}");
        let calls = extract_tool_calls(&input, &allowed());
        assert!(calls.is_empty());
    }
}
