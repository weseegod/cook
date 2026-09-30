//! The narrow edits allowed after a plan is frozen.

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

/// A pending checklist line may become checked. The rest of the line stays byte-for-byte.
fn checkbox_marked(before: &str, after: &str) -> bool {
    let Some(rest) = before.strip_prefix("- [ ] ") else {
        return false;
    };
    after.strip_prefix("- [x] ").is_some_and(|next| next == rest)
        || after.strip_prefix("- [X] ").is_some_and(|next| next == rest)
}

fn checklist_status_only(old_body: &str, new_body: &str) -> bool {
    let old: Vec<_> = old_body.split_inclusive('\n').collect();
    let new: Vec<_> = new_body.split_inclusive('\n').collect();
    old.len() == new.len()
        && old
            .iter()
            .zip(new)
            .all(|(before, after)| before == &after || checkbox_marked(before, after))
}

/// Preserve approved text byte-for-byte, except checklist boxes flipping to done and appended deviations.
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
            "Task checklist" | "Steps" if old_body != new_body => {
                if !checklist_status_only(old_body, new_body) {
                    return Err("approved plan text changed");
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
## Current anchors\n- `src/file.rs` `new:validate_plan_contract` observed: file currently has no contract validator.\n- `tests/file.rs` `new:contract_tests` observed: test file does not exist yet.\n\n\
## Edit brief\n### `src/file.rs`\n- Now: No contract validator exists.\n- Change: Add `validate_plan_contract` that checks plan shape.\n- Keep: Existing public API unchanged.\n- Proof: `cargo test plan_contract`\n\n\
### `src/file.rs`\n- Now: No anchor or brief validation exists.\n- Change: Add anchor and brief shape checks.\n- Keep: Error messages name the failing section.\n- Proof: `cargo test plan_contract`\n\n\
### `tests/file.rs`\n- Now: No contract tests exist.\n- Change: Add tests for valid and invalid plans.\n- Keep: No test depends on plan text order.\n- Proof: `cargo test plan_contract`\n\n\
## Task checklist\n- [ ] `src/file.rs` — implement. Done when: result exists.\n- [ ] `src/file.rs` — connect. Done when: call works.\n- [ ] `tests/file.rs` — test. Done when: test passes.\n\n\
## Deviations\n(none yet)\n";

    #[test]
    fn permits_checkbox_flips_and_deviations() {
        let checked = PLAN.replace(
            "- [ ] `src/file.rs` — implement. Done when: result exists.",
            "- [x] `src/file.rs` — implement. Done when: result exists.",
        );
        assert!(progress_only_delta(PLAN, &checked).is_ok());
        let rewritten = PLAN.replace(
            "- [ ] `src/file.rs` — implement. Done when: result exists.",
            "- [x] `src/file.rs` — implement differently. Done when: result exists.",
        );
        assert!(progress_only_delta(PLAN, &rewritten).is_err());
        assert!(progress_only_delta(&checked, PLAN).is_err());
        let with_deviation = PLAN.replace(
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
            progress_only_delta(PLAN, &PLAN.replace("A checkable result", "A different result"))
                .is_err()
        );
    }

    #[test]
    fn checklist_last_still_allows_a_flip_and_an_appended_deviation() {
        let plan = "# Plan: Last checklist\n\n\
## Acceptance criteria\n- Criterion: the result exists\n  Command: `cargo test`\n\n\
## Deviations\n(none yet)\n\n\
## Task checklist\n- [ ] `src/file.rs` — implement. Done when: result exists.\n";
        let checked = plan.replace("- [ ] `src/file.rs`", "- [x] `src/file.rs`");
        assert!(progress_only_delta(plan, &checked).is_ok());
        let with_deviation = plan.replace("(none yet)", "- Used a smaller helper.");
        assert!(progress_only_delta(plan, &with_deviation).is_ok());
        let both = checked.replace("(none yet)", "- Used a smaller helper.");
        assert!(progress_only_delta(plan, &both).is_ok());
        let rewritten_test = plan.replace("the result exists", "a different result");
        assert!(progress_only_delta(plan, &rewritten_test).is_err());
    }

    #[test]
    fn rejects_edit_to_brief_after_freeze() {
        let edited = PLAN.replace(
            "- Change: Add `validate_plan_contract` that checks plan shape.",
            "- Change: Add `validate_contract` that checks plan shape.",
        );
        assert!(progress_only_delta(PLAN, &edited).is_err());
    }
}
