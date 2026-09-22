//! Xiaomi MiMo compatibility for its non-standard Chat Completions stream.
//!
//! MiMo may expose the intended call as a literal XML envelope in `content` while its parallel
//! `tool_calls` deltas all reuse index zero. The standard transform must not guess around that
//! wire violation, so this adapter owns the narrow recovery grammar and repetition guard.

use std::collections::HashSet;

use serde_json::{Map, Value};

const TOOL_OPEN: &str = "<tool_call>";
const TOOL_CLOSE: &str = "</tool_call>";
const FUNCTION_OPEN: &str = "<function=";
const FUNCTION_CLOSE: &str = "</function>";
const PARAM_OPEN: &str = "<parameter=";
const PARAM_CLOSE: &str = "</parameter>";
const CODE_FENCE: &str = "```";
const RUNAWAY_REPEAT_THRESHOLD: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RecoveredToolCall {
    pub(super) name: String,
    pub(super) arguments: String,
}

#[derive(Debug, Default)]
pub(super) struct XiaomiMimoAdapter {
    allowed_tools: HashSet<String>,
    raw_content: String,
    recovered_calls: Vec<RecoveredToolCall>,
    sanitized_content: String,
    emitted_content_len: usize,
    runaway: bool,
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
        let (sanitized, calls) = extract_tool_calls(&self.raw_content, &self.allowed_tools, false);
        self.runaway = has_repeated_tail(&calls, RUNAWAY_REPEAT_THRESHOLD);
        self.sanitized_content = sanitized;
        self.recovered_calls = calls;
        let visible = self.sanitized_content[self.emitted_content_len..].to_owned();
        self.emitted_content_len = self.sanitized_content.len();
        visible
    }

    pub(super) fn should_salvage(&self) -> bool {
        self.runaway
    }

    pub(super) fn finish(mut self) -> (String, Vec<RecoveredToolCall>, bool) {
        let (sanitized, calls) = extract_tool_calls(&self.raw_content, &self.allowed_tools, true);
        let tail = sanitized[self.emitted_content_len..].to_owned();
        self.sanitized_content = sanitized;
        self.recovered_calls = calls;
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
) -> (String, Vec<RecoveredToolCall>) {
    let mut sanitized = String::with_capacity(content.len());
    let mut calls = Vec::new();
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
                    sanitized.push_str(&rest[..rest.len() - held]);
                }
                break;
            }
        }
    }

    (sanitized, calls)
}

fn longest_tool_prefix_suffix(text: &str) -> usize {
    (1..TOOL_OPEN.len())
        .rev()
        .find(|&len| text.ends_with(&TOOL_OPEN[..len]))
        .unwrap_or(0)
}

fn parse_envelope(envelope: &str, allowed_tools: &HashSet<String>) -> Option<RecoveredToolCall> {
    let inner = envelope.strip_prefix(TOOL_OPEN)?.strip_suffix(TOOL_CLOSE)?;
    let function = inner.strip_prefix(FUNCTION_OPEN)?;
    let name_end = function.find('>')?;
    let name = function[..name_end].trim();
    if name.is_empty() || !allowed_tools.contains(name) {
        return None;
    }
    let params = function[name_end + 1..].strip_suffix(FUNCTION_CLOSE)?;
    let mut cursor = 0;
    let mut arguments = Map::new();
    while cursor < params.len() {
        let rest = &params[cursor..];
        if rest.trim().is_empty() {
            break;
        }
        let parameter = rest.strip_prefix(PARAM_OPEN)?;
        let key_end = parameter.find('>')?;
        let key = parameter[..key_end].trim();
        if key.is_empty() {
            return None;
        }
        let value_start = key_end + 1;
        let value_end = parameter[value_start..].find(PARAM_CLOSE)? + value_start;
        let raw_value = parameter[value_start..value_end].trim();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed() -> HashSet<String> {
        ["wait", "todo_write"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn extracts_parameters_and_preserves_surrounding_prose() {
        let input = "before <tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter><parameter=timeout_ms>600000</parameter></function></tool_call> after";
        let (text, calls) = extract_tool_calls(input, &allowed(), true);
        assert_eq!(text, "before  after");
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
        let (text, calls) = extract_tool_calls(&input, &allowed(), true);
        assert_eq!(text, input);
        assert!(calls.is_empty());
    }

    #[test]
    fn detects_and_deduplicates_a_repeated_tail() {
        let block = "<tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter></function></tool_call>";
        let mut adapter = XiaomiMimoAdapter::new(["wait".to_owned()]);
        let visible = adapter.push_text(&format!("{block}{block}{block}"));
        assert!(visible.is_empty());
        assert!(adapter.should_salvage());
        let (tail, calls, runaway) = adapter.finish();
        assert!(tail.is_empty());
        assert!(runaway);
        assert_eq!(calls.len(), 1);
    }

    #[test]
    fn preserves_two_identical_calls_below_the_runaway_threshold() {
        let block = "<tool_call><function=wait><parameter=task_ids>[\"t1\"]</parameter></function></tool_call>";
        let mut adapter = XiaomiMimoAdapter::new(["wait".to_owned()]);
        assert!(adapter.push_text(&format!("{block}{block}")).is_empty());
        assert!(!adapter.should_salvage());

        let (_, calls, runaway) = adapter.finish();
        assert!(!runaway);
        assert_eq!(calls.len(), 2);
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

        let (tail, calls, runaway) = adapter.finish();
        assert!(tail.is_empty());
        assert!(!runaway);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "wait");
        assert_eq!(calls[0].arguments, r#"{"timeout_ms":100}"#);
    }
}
