//! The review-time plan shape and the narrow edits allowed after a plan is frozen.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

// Child sessions share this process but have their own plan tracker. The registry lets
// their edit gate protect an approved parent episode as well.
static FROZEN_PLANS: LazyLock<Mutex<HashMap<PathBuf, PathBuf>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn register_frozen_plan(episode: &Path, baseline: &Path) {
    if let Ok(path) = std::fs::canonicalize(episode) {
        FROZEN_PLANS
            .lock()
            .unwrap()
            .insert(path, baseline.to_path_buf());
    }
}

pub(crate) fn unregister_frozen_plan(episode: &Path) {
    if let Ok(path) = std::fs::canonicalize(episode) {
        FROZEN_PLANS.lock().unwrap().remove(&path);
    }
}

pub(crate) fn registered_frozen_plans() -> Vec<(PathBuf, PathBuf)> {
    FROZEN_PLANS
        .lock()
        .unwrap()
        .iter()
        .map(|(a, b)| (a.clone(), b.clone()))
        .collect()
}

fn sections(body: &str) -> HashMap<&str, Vec<&str>> {
    let mut sections = HashMap::<&str, Vec<&str>>::new();
    let mut current = "";
    for line in body.lines() {
        if let Some(name) = line.strip_prefix("## ") {
            current = name;
            sections.entry(current).or_default();
        } else {
            sections.entry(current).or_default().push(line);
        }
    }
    sections
}

fn content<'a>(sections: &'a HashMap<&str, Vec<&'a str>>, name: &str) -> Vec<&'a str> {
    sections
        .get(name)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect()
}

fn numbered(line: &str) -> bool {
    let Some((number, rest)) = line.split_once(". ") else {
        return false;
    };
    !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) && !rest.trim().is_empty()
}

fn checklist(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("- [ ] `") else {
        return false;
    };
    let Some((path, detail)) = rest.split_once("` — ") else {
        return false;
    };
    !path.trim().is_empty()
        && detail.contains(". Done when: ")
        && !detail.ends_with(". Done when: ")
}

fn normalize_checkbox(line: &str) -> &str {
    if line.starts_with("- [ ]") || line.starts_with("- [x]") || line.starts_with("- [X]") {
        &line[5..]
    } else {
        line
    }
}

pub(crate) fn validate_plan_contract(body: &str) -> Result<(), Vec<String>> {
    let sections = sections(body);
    let mut errors = Vec::new();
    let headings: Vec<_> = body
        .lines()
        .filter_map(|line| line.strip_prefix("## "))
        .collect();
    let mut expected = vec![
        "Goal kind",
        "Decisions",
        "Context",
        "Acceptance criteria",
        "Verification plan",
        "Non-goals",
        "Assumed scope",
    ];
    if content(&sections, "Goal kind") == ["code-change"] {
        expected.extend(["Implementation approach", "Task checklist"]);
    }
    expected.push("Deviations");
    if headings.last() == Some(&"Risks / Contradictions") {
        expected.push("Risks / Contradictions");
    }
    if headings != expected {
        errors.push("Plan sections must appear once in the required order".into());
    }
    let first = body.lines().next().unwrap_or("");
    if !first.starts_with("# Plan: ")
        || first.contains('/')
        || first.contains('\\')
        || !(5..=10).contains(
            &first
                .trim_start_matches("# Plan: ")
                .split_whitespace()
                .count(),
        )
    {
        errors.push("H1 must be `# Plan: <5–10 word title>` without a path".into());
    }
    let kind = content(&sections, "Goal kind");
    if kind.len() != 1 || !matches!(kind[0], "code-change" | "analysis" | "research") {
        errors.push("## Goal kind must contain exactly code-change, analysis, or research".into());
    }
    for (name, minimum, maximum) in [
        ("Decisions", 1, usize::MAX),
        ("Context", 3, 8),
        ("Non-goals", 1, usize::MAX),
    ] {
        let lines = content(&sections, name);
        if lines.len() < minimum
            || lines.len() > maximum
            || lines
                .iter()
                .any(|line| !line.starts_with("- ") || line.len() <= 2)
        {
            errors.push(format!(
                "## {name} needs {minimum}{} bullet(s)",
                if maximum == usize::MAX {
                    " or more"
                } else {
                    "–8"
                }
            ));
        }
    }
    for name in ["Acceptance criteria", "Verification plan"] {
        let lines = content(&sections, name);
        if lines.is_empty() || lines.iter().any(|line| !numbered(line)) {
            errors.push(format!("## {name} needs numbered items"));
        }
    }
    let scope = content(&sections, "Assumed scope");
    if scope.is_empty() || scope.iter().any(|line| !line.contains('`')) {
        errors.push("## Assumed scope needs backticked items".into());
    }
    if content(&sections, "Deviations") != ["(none yet)"] {
        errors.push("## Deviations must contain exactly `(none yet)`".into());
    }
    if body.contains("```") {
        errors.push("Code fences are not allowed in a plan".into());
    }
    let mut current = "";
    for line in body.lines() {
        if let Some(name) = line.strip_prefix("## ") {
            current = name;
        }
        if current != "Task checklist"
            && (line.contains("- [ ]") || line.contains("- [x]") || line.contains("- [X]"))
        {
            errors.push("Checkboxes belong only in ## Task checklist".into());
            break;
        }
    }
    if kind == ["code-change"] {
        if content(&sections, "Implementation approach").is_empty() {
            errors.push("## Implementation approach is required for code-change".into());
        }
        let tasks = content(&sections, "Task checklist");
        if !(3..=8).contains(&tasks.len()) || tasks.iter().any(|line| !checklist(line)) {
            errors.push(
                "## Task checklist needs 3–8 `- [ ] `<path>` — ... Done when: ...` lines".into(),
            );
        }
        if tasks.last().is_some_and(|line| {
            !line.to_ascii_lowercase().contains("test")
                && !line.to_ascii_lowercase().contains("evidence")
                && !line.to_ascii_lowercase().contains("verify")
        }) {
            errors.push("The last checklist item must be a test or evidence step".into());
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

/// Preserve all approved text byte-for-byte except checklist state and appended deviations.
pub(crate) fn progress_only_delta(baseline: &str, proposed: &str) -> Result<(), &'static str> {
    fn parts(body: &str) -> Vec<(String, String)> {
        let mut result = vec![(String::new(), String::new())];
        for line in body.split_inclusive('\n') {
            if let Some(name) = line.strip_prefix("## ") {
                result.push((name.trim_end().to_owned(), line.to_owned()));
            } else {
                result.last_mut().unwrap().1.push_str(line);
            }
        }
        result
    }
    fn deviation_lines(body: &str) -> Result<Vec<&str>, &'static str> {
        let content = body
            .strip_prefix("## Deviations\n")
            .ok_or("deviations heading changed")?;
        let lines: Vec<_> = content.lines().filter(|line| !line.is_empty()).collect();
        if lines == ["(none yet)"] {
            return Ok(Vec::new());
        }
        if lines.is_empty()
            || lines
                .iter()
                .any(|line| !line.starts_with("- ") || line.len() <= 2)
        {
            return Err("deviations must be bullets");
        }
        Ok(lines)
    }
    let old = parts(baseline);
    let new = parts(proposed);
    if old.len() != new.len() {
        return Err("section count changed");
    }
    for ((old_name, old_body), (new_name, new_body)) in old.iter().zip(&new) {
        if old_name != new_name {
            return Err("section changed");
        }
        match old_name.as_str() {
            "Task checklist" => {
                let old_lines: Vec<_> = old_body.split_inclusive('\n').collect();
                let new_lines: Vec<_> = new_body.split_inclusive('\n').collect();
                if old_lines.len() != new_lines.len()
                    || old_lines
                        .iter()
                        .zip(&new_lines)
                        .any(|(a, b)| normalize_checkbox(a) != normalize_checkbox(b))
                {
                    return Err("checklist text changed");
                }
            }
            "Deviations" => {
                let before = deviation_lines(old_body)?;
                let after = deviation_lines(new_body)?;
                if !after.starts_with(&before) {
                    return Err("existing deviation changed");
                }
                if before.is_empty() {
                    let (prefix, suffix) = old_body
                        .split_once("(none yet)")
                        .ok_or("original deviation marker missing")?;
                    let inserted = new_body
                        .strip_prefix(prefix)
                        .and_then(|body| body.strip_suffix(suffix))
                        .ok_or("deviation whitespace changed")?;
                    if inserted != "(none yet)" && inserted != after.join("\n") {
                        return Err("deviation text changed");
                    }
                } else if new_body != old_body {
                    if after.len() == before.len() {
                        return Err("no deviation was appended");
                    }
                    let last = before.last().unwrap();
                    let end =
                        old_body.rfind(last).ok_or("existing deviation missing")? + last.len();
                    let (prefix, suffix) = old_body.split_at(end);
                    let inserted = new_body
                        .strip_prefix(prefix)
                        .and_then(|body| body.strip_suffix(suffix))
                        .ok_or("existing deviation bytes changed")?;
                    if inserted != format!("\n{}", after[before.len()..].join("\n")) {
                        return Err("new deviations must be appended bullets");
                    }
                }
            }
            _ if old_body != new_body => return Err("approved plan text changed"),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAN: &str = "# Plan: Build a complete reusable plan contract\n\n\
## Goal kind\ncode-change\n\n\
## Decisions\n- Use one file.\n\n\
## Context\n- First fact.\n- Second fact.\n- Third fact.\n\n\
## Acceptance criteria\n1. A checkable result.\n\n\
## Verification plan\n1. gating: run `cargo test` and observe success.\n\n\
## Non-goals\n- Extra features.\n\n\
## Assumed scope\n- `src/file.rs`\n\n\
## Implementation approach\nUse a pure function.\n\n\
## Task checklist\n- [ ] `src/file.rs` — implement. Done when: result exists.\n- [ ] `src/file.rs` — connect. Done when: call works.\n- [ ] `tests/file.rs` — test. Done when: test passes.\n\n\
## Deviations\n(none yet)\n";

    #[test]
    fn validates_complete_plan_and_reports_missing_sections() {
        assert!(validate_plan_contract(PLAN).is_ok());
        let errors = validate_plan_contract("# Plan: Only a title exists here now\n").unwrap_err();
        assert!(errors.iter().any(|e| e.contains("Goal kind")));
        assert!(errors.iter().any(|e| e.contains("Task checklist")) == false);
    }

    #[test]
    fn validates_checklist_shape_and_checkbox_location() {
        let invalid = PLAN.replace(
            "- [ ] `src/file.rs` — implement. Done when: result exists.",
            "- [ ] implement",
        );
        assert!(
            validate_plan_contract(&invalid)
                .unwrap_err()
                .iter()
                .any(|e| e.contains("Task checklist"))
        );
        let invalid = PLAN.replace("- First fact.", "- [ ] First fact.");
        assert!(
            validate_plan_contract(&invalid)
                .unwrap_err()
                .iter()
                .any(|e| e.contains("Checkboxes"))
        );
    }

    #[test]
    fn permits_progress_and_rejects_contract_edits() {
        let ticked = PLAN.replace(
            "- [ ] `src/file.rs` — implement",
            "- [x] `src/file.rs` — implement",
        );
        assert!(progress_only_delta(PLAN, &ticked).is_ok());
        let with_deviation = ticked.replace(
            "(none yet)",
            "- Used a smaller helper.\n- Kept existing API.",
        );
        assert!(progress_only_delta(PLAN, &with_deviation).is_ok());
        let appended = with_deviation.replace(
            "- Kept existing API.",
            "- Kept existing API.\n- Added another note.",
        );
        assert!(progress_only_delta(&with_deviation, &appended).is_ok());
        assert!(progress_only_delta(PLAN, &PLAN.replace("(none yet)", "\n- New note.")).is_err());
        assert!(
            progress_only_delta(
                &with_deviation,
                &appended.replace("Used a smaller helper", "Used a larger helper")
            )
            .is_err()
        );
        assert!(
            progress_only_delta(
                PLAN,
                &PLAN.replace("A checkable result", "A different result")
            )
            .is_err()
        );
    }
}
