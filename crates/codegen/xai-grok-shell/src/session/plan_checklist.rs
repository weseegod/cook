//! Move a draft episode's checklist into the session's durable TodoState.

use crate::tools::todo::{TodoItem, TodoPriority, TodoState, TodoStatus};
use std::path::{Path, PathBuf};
use xai_grok_tools::implementations::grok_build::todo::TodoBindingKind;

pub(crate) fn binding_episode(session_dir: &Path, episode: &Path) -> String {
    episode
        .strip_prefix(session_dir)
        .unwrap_or(episode)
        .to_string_lossy()
        .into_owned()
}

/// Returns the contract without its checklist and the parsed tasks, if the section exists.
/// Draft validation happens before calling this for new plans. This parser also accepts checked
/// boxes so it can import preexisting episodes without rewriting their frozen bytes.
pub(crate) fn extract(body: &str, heading: &str) -> Result<(String, Option<TodoState>), String> {
    let marker = format!("## {heading}");
    let mut start = None;
    let mut end = body.len();
    let mut offset = 0;
    for line in body.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == marker {
            if start.is_some() {
                return Err(format!("duplicate {marker}"));
            }
            start = Some(offset);
        } else if start.is_some() && line.starts_with("## ") && end == body.len() {
            end = offset;
        }
        offset += line.len();
    }
    let Some(start) = start else {
        return Ok((body.to_owned(), None));
    };
    let section = &body[start + marker.len()..end];
    let mut state = TodoState::default();
    for line in section.lines().map(str::trim) {
        let (status, rest) = if let Some(rest) = line.strip_prefix("- [ ] ") {
            (TodoStatus::Pending, rest)
        } else if let Some(rest) = line
            .strip_prefix("- [x] ")
            .or_else(|| line.strip_prefix("- [X] "))
        {
            (TodoStatus::Completed, rest)
        } else if line.is_empty() {
            continue;
        } else {
            return Err(format!("{marker} contains a non-checklist line"));
        };
        let path = rest
            .strip_prefix('`')
            .and_then(|text| text.split_once('`'))
            .map(|(path, _)| path)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| format!("{marker} item needs a backticked path"))?;
        let done_when = rest
            .split_once("Done when: ")
            .map(|(_, proof)| proof.trim())
            .filter(|proof| !proof.is_empty())
            .ok_or_else(|| format!("{marker} item needs Done when"))?;
        let id = format!("step-{}", state.todo_items().count() + 1);
        state.push(
            id,
            TodoItem {
                content: rest.to_owned(),
                priority: TodoPriority::default(),
                status,
                meta: Some(serde_json::json!({"path": path, "done_when": done_when})),
            },
        );
    }
    if state.is_empty() {
        return Err(format!("{marker} has no items"));
    }
    let mut stripped = String::with_capacity(body.len() - (end - start));
    stripped.push_str(&body[..start]);
    stripped.push_str(&body[end..]);
    Ok((stripped, Some(state)))
}

/// Upgrade one old episode on load. Its bytes (and frozen baseline) remain untouched.
pub(crate) fn import_legacy(
    session_dir: &Path,
    current_plan: Option<&Path>,
    goal_plan: Option<&Path>,
    existing: Option<TodoState>,
) -> (Option<TodoState>, bool) {
    if existing
        .as_ref()
        .is_some_and(|state| state.binding().is_some())
    {
        return (existing, false);
    }
    let mut candidates: Vec<PathBuf> = goal_plan
        .filter(|path| path.is_file())
        .into_iter()
        .map(Path::to_path_buf)
        .collect();
    if candidates.is_empty()
        && let Ok(entries) = std::fs::read_dir(session_dir.join("plans"))
    {
        let mut episodes: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension().is_some_and(|ext| ext == "md")
                    && !path.to_string_lossy().ends_with(".frozen.md")
            })
            .collect();
        episodes.sort_by_key(|path| {
            std::fs::metadata(path)
                .and_then(|meta| meta.modified())
                .ok()
        });
        if let Some(latest) = episodes.pop() {
            candidates.push(latest);
        }
    }
    if candidates.is_empty() {
        candidates.extend(
            current_plan
                .filter(|path| path.is_file())
                .map(Path::to_path_buf),
        );
    }
    for path in candidates {
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (heading, kind) in [
            ("Task checklist", TodoBindingKind::Approved),
            ("Steps", TodoBindingKind::Passive),
        ] {
            if let Ok((_, Some(mut state))) = extract(&body, heading) {
                state.bind(kind, binding_episode(session_dir, &path));
                return (Some(state), true);
            }
        }
    }
    (existing, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_only_the_checklist_and_preserves_status_and_metadata() {
        let body = "# Plan: Work\n\n## Steps\n- [x] `a.rs` — build. Done when: it runs.\n- [ ] `b.rs` — test. Done when: tests pass.\n\n## Notes\nKeep this.\n";
        let (contract, state) = extract(body, "Steps").unwrap();
        assert_eq!(contract, "# Plan: Work\n\n## Notes\nKeep this.\n");
        let state = state.unwrap();
        assert_eq!(state.first_pending().unwrap().0, "step-2");
        assert_eq!(
            state.todo_items().next().unwrap().meta.as_ref().unwrap()["path"],
            "a.rs"
        );
    }

    #[test]
    fn imports_old_episode_once_without_changing_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let plans = dir.path().join("plans");
        std::fs::create_dir(&plans).unwrap();
        let episode = plans.join("old.md");
        let body = "# Plan: Old\n\n## Task checklist\n- [x] `a.rs` — build. Done when: built.\n- [ ] `b.rs` — test. Done when: tested.\n";
        std::fs::write(&episode, body).unwrap();
        let (state, imported) = import_legacy(dir.path(), Some(&episode), None, None);
        assert!(imported);
        let state = state.unwrap();
        assert_eq!(state.binding().unwrap().kind, TodoBindingKind::Approved);
        assert_eq!(state.binding().unwrap().episode, "plans/old.md");
        assert_eq!(state.first_pending().unwrap().0, "step-2");
        let (_, imported_again) = import_legacy(dir.path(), Some(&episode), None, Some(state));
        assert!(!imported_again);
        assert_eq!(std::fs::read_to_string(&episode).unwrap(), body);
    }

    #[test]
    fn imports_old_passive_steps_without_rewriting_episode() {
        let dir = tempfile::tempdir().unwrap();
        let plans = dir.path().join("plans");
        std::fs::create_dir(&plans).unwrap();
        let episode = plans.join("working.md");
        let body = "# Plan: Working\n\n## Goal\nBuild it.\n\n## Files\n- `app.js`\n\n## Steps\n- [x] `app.js` — build. Done when: it runs.\n- [ ] `app.js` — check. Done when: tests pass.\n";
        std::fs::write(&episode, body).unwrap();
        let (state, imported) = import_legacy(dir.path(), None, None, Some(TodoState::default()));
        assert!(imported);
        let state = state.unwrap();
        assert_eq!(state.binding().unwrap().kind, TodoBindingKind::Passive);
        assert_eq!(state.first_pending().unwrap().0, "step-2");
        assert_eq!(std::fs::read_to_string(episode).unwrap(), body);
    }
}
