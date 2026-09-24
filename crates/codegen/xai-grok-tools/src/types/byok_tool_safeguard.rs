//! Rewrite a tool call whose name is not in the active toolset onto one that is.
//!
//! Bring-your-own-key models emit names from other agents' training data. Session
//! `01a0cca3-fe66-79d2-a183-756ae945a612` (`xiaomi/mimo-v2.6-flash`) called `glob`
//! with `{pattern, path}` while the Cook toolset only has `list_dir`, and the turn
//! failed with "Tool not found: glob". The same miss will happen for any BYOK model
//! that says `Bash`, `Read`, or `Glob`.
//!
//! This is not the Xiaomi stream adapter and not the OpenCode toolset. Those stay
//! on their own paths. A registered `glob` (the OpenCode tool) is left alone, so
//! this rewrite cannot retarget a toolset that already provides the name.

use serde_json::{Value, json};

use super::claude_alias::{self, AliasTargets};
use super::tool::ToolKind;

/// Spellings BYOK models use that are not already a row in the Claude alias table.
/// Each one points at that table's canonical name so there is still a single map.
const EXTRA_SPELLINGS: &[(&str, &str)] = &[
    ("shell", "Bash"),
    ("exec", "Bash"),
    ("terminal", "Bash"),
    ("find_files", "Glob"),
    ("file_search", "Glob"),
    ("glob_file_search", "Glob"),
    ("dir", "LS"),
];

/// `None` when `name` is already registered, or when no registered tool can carry the call.
/// `available` is the active toolset's client-facing names.
pub(crate) fn rewrite(name: &str, args: &Value, available: &[&str]) -> Option<(String, Value)> {
    if available.iter().any(|have| *have == name) {
        return None;
    }
    // Same tool, different case (`Glob` on a toolset that registered `glob`).
    if let Some(have) = available
        .iter()
        .find(|have| have.eq_ignore_ascii_case(name))
    {
        return Some(((*have).to_string(), args.clone()));
    }
    let targets = targets_for(name)?;
    let mut candidates: Vec<&str> = targets.grok.to_vec();
    if candidates.is_empty()
        && let Some(fallback) = kind_fallback(targets.kind)
    {
        candidates.push(fallback);
    }
    for candidate in candidates {
        if !available.iter().any(|have| *have == candidate) {
            continue;
        }
        // A candidate that cannot carry these arguments is skipped so a later
        // registered name (write before search_replace) still gets a chance.
        if let Some(rewritten) = remap(candidate, args) {
            return Some((candidate.to_string(), rewritten));
        }
    }
    None
}

fn targets_for(name: &str) -> Option<AliasTargets> {
    if let Some(targets) = claude_alias::alias_targets_ignore_case(name) {
        return Some(targets);
    }
    let canonical = EXTRA_SPELLINGS
        .iter()
        .find(|(spelling, _)| spelling.eq_ignore_ascii_case(name))
        .map(|(_, canonical)| *canonical)?;
    claude_alias::alias_targets_ignore_case(canonical)
}

/// Rows that name a kind but no Grok tool (`LS`, `PowerShell`) still have one obvious host tool.
fn kind_fallback(kind: Option<ToolKind>) -> Option<&'static str> {
    match kind {
        Some(ToolKind::List | ToolKind::ListDir) => Some("list_dir"),
        Some(ToolKind::Execute) => Some("run_terminal_command"),
        Some(ToolKind::Read) => Some("read_file"),
        Some(ToolKind::Search) => Some("grep"),
        Some(ToolKind::Edit | ToolKind::Write) => Some("search_replace"),
        _ => None,
    }
}

fn remap(target: &str, args: &Value) -> Option<Value> {
    match target {
        "list_dir" => Some(list_dir_arguments(args)),
        "read_file" => read_file_arguments(args),
        "run_terminal_command" => bash_arguments(args),
        "grep" => grep_arguments(args),
        "search_replace" => search_replace_arguments(args),
        "write" => write_arguments(args),
        // Hashline inputs are not the Claude/OpenCode shapes. Guessing would run the
        // wrong tool. Skip so the call stays "tool doesn't exist" instead.
        "hashline_read" | "hashline_edit" | "hashline_grep" => None,
        // Same field names on both sides (web_search, todo_write, …).
        _ => Some(args.clone()),
    }
}

fn list_dir_arguments(args: &Value) -> Value {
    if let Some(dir) = str_field(args, &["target_directory"]) {
        return json!({ "target_directory": dir });
    }
    let path = str_field(args, &["path", "directory", "dir"]).unwrap_or("");
    let pattern = str_field(args, &["pattern", "glob_pattern", "glob"]).unwrap_or("");
    json!({ "target_directory": directory_for_glob(path, pattern) })
}

/// Directory a glob call was actually aimed at.
/// `**/*` keeps `path`. `scripts/real-model-suite/**/*` keeps the prefix before the first wildcard.
fn directory_for_glob(path: &str, pattern: &str) -> String {
    let path = path.trim().trim_end_matches('/');
    let prefix = glob_directory_prefix(pattern);
    match (path.is_empty() || path == ".", prefix.is_empty()) {
        (true, true) => ".".to_string(),
        (true, false) => prefix,
        (false, true) => path.to_string(),
        (false, false) => format!("{path}/{prefix}"),
    }
}

fn glob_directory_prefix(pattern: &str) -> String {
    let pattern = pattern.trim().trim_start_matches("./");
    if pattern.is_empty() || is_match_all(pattern) {
        return String::new();
    }
    let mut parts = Vec::new();
    for segment in pattern.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        // A `..` segment is not a directory the model meant to list.
        if segment == ".."
            || segment.contains('*')
            || segment.contains('?')
            || segment.contains('[')
        {
            break;
        }
        parts.push(segment);
    }
    parts.join("/")
}

fn is_match_all(pattern: &str) -> bool {
    matches!(
        pattern.trim_matches('/'),
        "*" | "**" | "**/*" | "**/**" | "*.*" | "**/*.*"
    )
}

fn read_file_arguments(args: &Value) -> Option<Value> {
    let path = str_field(args, &["target_file", "file_path", "path", "file"])?;
    let mut out = match args {
        Value::Object(map) => Value::Object(map.clone()),
        _ => Value::Object(Default::default()),
    };
    if let Value::Object(map) = &mut out {
        map.insert("target_file".to_string(), json!(path));
        // `read_file` accepts `file_path` as an alias of `target_file`. Leaving both
        // keys set makes serde reject the object as a duplicate field.
        for alias in ["file_path", "path", "file"] {
            if alias != "target_file" {
                map.remove(alias);
            }
        }
    }
    Some(out)
}

fn bash_arguments(args: &Value) -> Option<Value> {
    let command = str_field(args, &["command", "cmd"])?;
    let mut out = match args {
        Value::Object(map) => Value::Object(map.clone()),
        _ => Value::Object(Default::default()),
    };
    if let Value::Object(map) = &mut out {
        map.insert("command".to_string(), json!(command));
        map.entry("description")
            .or_insert_with(|| Value::String(String::new()));
    }
    Some(out)
}

fn grep_arguments(args: &Value) -> Option<Value> {
    str_field(args, &["pattern"])?;
    Some(args.clone())
}

fn search_replace_arguments(args: &Value) -> Option<Value> {
    let file_path = str_field(args, &["file_path", "path", "target_file"])?;
    // A full-file `Write` (`content` only) must not become an empty-old_string edit.
    let old_string = str_field(args, &["old_string", "old_str"])?;
    let new_string = str_field(args, &["new_string", "new_str"])?;
    let mut out = match args {
        Value::Object(map) => Value::Object(map.clone()),
        _ => Value::Object(Default::default()),
    };
    if let Value::Object(map) = &mut out {
        map.insert("file_path".to_string(), json!(file_path));
        map.insert("old_string".to_string(), json!(old_string));
        map.insert("new_string".to_string(), json!(new_string));
    }
    Some(out)
}

fn write_arguments(args: &Value) -> Option<Value> {
    let file_path = str_field(args, &["file_path", "path", "target_file"])?;
    let content = str_field(args, &["content", "contents"])?;
    Some(json!({ "file_path": file_path, "content": content }))
}

fn str_field<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    let Value::Object(map) = args else {
        return None;
    };
    keys.iter().find_map(|key| map.get(*key)?.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grok() -> Vec<&'static str> {
        vec![
            "read_file",
            "list_dir",
            "grep",
            "run_terminal_command",
            "search_replace",
            "write",
        ]
    }

    #[test]
    fn xiaomi_glob_calls_list_the_directory_the_pattern_names() {
        let available = grok();
        let cases = [
            (
                json!({"pattern": "**/*", "path": "/home/thanh/Projects/cook/scripts/real-model-suite"}),
                "/home/thanh/Projects/cook/scripts/real-model-suite",
            ),
            (
                json!({"path": "/home/thanh/Projects/cook", "pattern": "scripts/real-model-suite/**/*"}),
                "/home/thanh/Projects/cook/scripts/real-model-suite",
            ),
            (
                json!({"path": "/home/thanh/Projects/cook", "pattern": "docs/real-model*"}),
                "/home/thanh/Projects/cook/docs",
            ),
        ];
        for (args, directory) in cases {
            let (name, rewritten) = rewrite("glob", &args, &available).expect("glob rewrites");
            assert_eq!(name, "list_dir");
            assert_eq!(rewritten["target_directory"], directory);
        }
    }

    #[test]
    fn registered_glob_is_not_rewritten() {
        let available = ["glob", "read", "bash"];
        assert!(rewrite("glob", &json!({"pattern": "**/*"}), &available).is_none());
    }

    #[test]
    fn different_case_uses_the_registered_tool() {
        let available = ["glob"];
        let args = json!({"pattern": "*.rs", "path": "src"});
        let (name, rewritten) = rewrite("Glob", &args, &available).expect("case fold");
        assert_eq!(name, "glob");
        assert_eq!(rewritten, args);
    }

    #[test]
    fn bash_and_read_spellings_hit_the_grok_tools() {
        let available = grok();
        let (name, args) = rewrite("Bash", &json!({"cmd": "ls"}), &available).expect("bash");
        assert_eq!(name, "run_terminal_command");
        assert_eq!(args["command"], "ls");

        let (name, args) = rewrite("shell", &json!({"command": "pwd"}), &available).expect("shell");
        assert_eq!(name, "run_terminal_command");
        assert_eq!(args["command"], "pwd");

        let (name, args) =
            rewrite("read", &json!({"file_path": "ARCHITECTURE.md"}), &available).expect("read");
        assert_eq!(name, "read_file");
        assert_eq!(args["target_file"], "ARCHITECTURE.md");
    }

    #[test]
    fn ls_uses_list_dir_when_the_alias_row_names_no_tool() {
        let (name, args) = rewrite("ls", &json!({"path": "crates"}), &grok()).expect("ls");
        assert_eq!(name, "list_dir");
        assert_eq!(args["target_directory"], "crates");
    }

    #[test]
    fn missing_host_tool_and_unknown_names_stay_unknown() {
        let no_list = ["read_file", "grep"];
        assert!(rewrite("glob", &json!({"pattern": "**/*", "path": "."}), &no_list).is_none());
        assert!(rewrite("frobnicate", &json!({}), &grok()).is_none());
    }

    #[test]
    fn write_without_an_edit_payload_does_not_become_search_replace() {
        let available = ["search_replace", "read_file"];
        assert!(
            rewrite(
                "Write",
                &json!({"file_path": "a.rs", "content": "fn main() {}"}),
                &available,
            )
            .is_none()
        );
    }

    #[test]
    fn edit_rewrites_onto_search_replace() {
        let available = grok();
        let (name, args) = rewrite(
            "Edit",
            &json!({"path": "a.rs", "old_str": "a", "new_str": "b"}),
            &available,
        )
        .expect("edit");
        assert_eq!(name, "search_replace");
        assert_eq!(args["file_path"], "a.rs");
        assert_eq!(args["old_string"], "a");
        assert_eq!(args["new_string"], "b");
    }
}
