//! Next concrete step from the plan episode.
//!
//! The first unchecked box under `## Task checklist` or `## Steps` is the step.
//! `plan.json` is the fallback only when that episode has no checklist heading.
//! Verifier-verdict gaps stay on `render_verifier_gaps_block` in `acp_session.rs`.
//! If the plan read fails, the caller falls back to a generic line, so this helper never returns that line itself.

use std::path::Path;

/// Each goal nudge fires per turn, so a hostile or runaway verdict/plan must not blow up the context.
pub(crate) const MAX_READ_BYTES: usize = 8 * 1024;

/// Verbatim plan attached once after compaction. Larger than the checklist scan: the checklist is last, and an 8 KiB head would drop it.
pub(crate) const PLAN_COMPACTION_READ_BYTES: usize = 32 * 1024;

/// Which short wrapper surrounds the saved plan. The file read is the same for both.
#[derive(Clone, Copy)]
pub(crate) enum PlanCompactionMode {
    Active,
    Passive,
}

/// The next step is the first unchecked box in the plan file.
///
/// `plan.json` is only the fallback for an old episode whose checklist was stripped out of the file.
pub(crate) fn first_pending_plan_item(episode: &Path) -> Option<String> {
    if let Some(body) = read_capped(episode)
        && has_checklist_section(&body)
    {
        return extract_first_unchecked(&body);
    }
    let session_dir = episode.parent()?.parent()?;
    let state = std::fs::read(session_dir.join("plan.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<crate::tools::todo::TodoState>(&bytes).ok());
    match state {
        Some(state) if state.binding().is_some() => state
            .binding()
            .filter(|binding| session_dir.join(&binding.episode) == episode)
            .and_then(|_| {
                state
                    .first_pending()
                    .map(|(id, item)| format!("{id}: {}", item.content))
            }),
        _ => first_unchecked_plan_item(episode),
    }
}

/// Returns `None` on any I/O failure (missing file, permission denied, etc.).
/// When the buffer reaches the cap, the trailing potentially-incomplete line is dropped.
/// That keeps a bullet that spans the cap boundary from leaking a half-truncated tail upstream.
fn read_capped(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(MAX_READ_BYTES.min(4096));
    file.take(MAX_READ_BYTES as u64)
        .read_to_end(&mut buf)
        .ok()?;
    if buf.len() >= MAX_READ_BYTES
        && let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n')
    {
        buf.truncate(last_nl);
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// One soft reminder per user prompt when a turn ends with no tool call and the checklist is still open.
/// A second stop is allowed to finish. This is not a completion gate.
pub(crate) const PLAN_STOP_NUDGE_CAP: u32 = 1;

/// A normal coding turn has no structured-output schema. That is not a reason to skip the reminder.
pub(crate) fn should_plan_stop_nudge(
    turn_refused: bool,
    truncated: bool,
    fires: u32,
    goal_loop: bool,
) -> bool {
    !turn_refused && !truncated && fires < PLAN_STOP_NUDGE_CAP && !goal_loop
}

/// Every unchecked box under `## Task checklist` or `## Steps`.
/// Checkboxes outside those sections, including under `## Acceptance criteria`, are not steps.
/// No checklist heading means no steps: this does not fall back to other boxes or `plan.json`.
pub(crate) fn open_checklist_steps(body: &str) -> Vec<String> {
    let Some(name) = checklist_section_name(body) else {
        return Vec::new();
    };
    let mut section_level: Option<usize> = None;
    let mut steps = Vec::new();
    for line in body.lines() {
        if is_section_header(line, name) {
            section_level = Some(header_level(line));
            continue;
        }
        let Some(level) = section_level else {
            continue;
        };
        if is_any_header(line) && header_level(line) <= level {
            break;
        }
        if let Some(item) = parse_checkbox_item(line.trim_start()) {
            steps.push(item);
        }
    }
    steps
}

/// First unchecked box under `## Task checklist` or `## Steps`.
pub(crate) fn open_checklist_step(body: &str) -> Option<String> {
    open_checklist_steps(body).into_iter().next()
}

/// Reads the episode and returns every open checklist step. A missing file is an empty list.
pub(crate) fn open_checklist_steps_at(path: &Path) -> Vec<String> {
    let Some(body) = read_capped(path) else {
        return Vec::new();
    };
    open_checklist_steps(&body)
}

pub(crate) fn plan_stop_reminder(steps: &[String]) -> String {
    let mut listed = String::new();
    for step in steps {
        listed.push_str("- ");
        listed.push_str(step);
        listed.push('\n');
    }
    format!(
        "You stopped without a tool call while the plan still has open steps:\n\
{listed}\
Continue the first open step whose result is not already in the tree. \
Mark a step only when its Done when observation holds. \
If a planned check already finished on the tree after the last edit, \
cite that result and do not run it again. If you are blocked, name these steps and the \
observation that is still missing, then stop."
    )
}

/// Saved plan, verbatim, with a short mode wrapper.
///
/// Passive and empty is `None`. Active and empty still returns the wrapper so plan mode
/// keeps its boundary. A missing file is `None` from [`plan_compaction_reminder_at`].
pub(crate) fn plan_compaction_reminder(
    body: &str,
    mode: PlanCompactionMode,
    path_display: &str,
    truncated: bool,
) -> Option<String> {
    let empty = body.trim().is_empty();
    if empty && matches!(mode, PlanCompactionMode::Passive) {
        return None;
    }
    let mut out = match mode {
        PlanCompactionMode::Active => format!(
            "This is the current plan, saved at {path_display}. \
Plan mode is still active. Its rules still apply, and the only file you may edit is this plan file. \
End the turn by clarifying with the user or presenting the plan."
        ),
        PlanCompactionMode::Passive => format!(
            "This is the current plan, saved at {path_display}. \
If the latest user message changes or adds work, update this saved plan and its checklist, \
keep the steps that still apply, and continue the work. \
If that message only asks for status or an explanation, answer it and do not edit the plan."
        ),
    };
    if empty {
        out.push_str(&format!(
            "\n\nNo plan is written yet. Write it to {path_display}."
        ));
    } else {
        out.push_str("\n\n");
        out.push_str(body);
        if truncated {
            out.push_str("\n\nThe copy stopped at 32 KiB. Read the plan file for the rest.");
        }
    }
    Some(out)
}

struct VerbatimPlan {
    body: String,
    truncated: bool,
}

/// Whole plan up to [`PLAN_COMPACTION_READ_BYTES`]. One extra byte distinguishes a file that
/// ends exactly on the cap from a file that continues. A cut keeps the last complete line.
fn read_plan_verbatim(path: &Path) -> Option<VerbatimPlan> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    file.take((PLAN_COMPACTION_READ_BYTES as u64) + 1)
        .read_to_end(&mut buf)
        .ok()?;
    let truncated = buf.len() > PLAN_COMPACTION_READ_BYTES;
    if truncated {
        buf.truncate(PLAN_COMPACTION_READ_BYTES);
        if let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') {
            buf.truncate(last_nl);
        }
    }
    Some(VerbatimPlan {
        body: String::from_utf8_lossy(&buf).into_owned(),
        truncated,
    })
}

/// Reads the episode and returns the compaction reminder. A missing or unreadable file is `None`.
pub(crate) fn plan_compaction_reminder_at(path: &Path, mode: PlanCompactionMode) -> Option<String> {
    let read = read_plan_verbatim(path)?;
    plan_compaction_reminder(
        &read.body,
        mode,
        &path.display().to_string(),
        read.truncated,
    )
}

/// Legacy fallback: first unchecked `- [ ]` (or `* [ ]` / `+ [ ]`) markdown checkbox.
/// Numbered `## Acceptance criteria` are not mined: they never get checked off, so criterion 1 would surface forever.
/// When the plan has a `## Task checklist` or `## Steps` section only its checkboxes are mined.
pub(crate) fn first_unchecked_plan_item(path: &Path) -> Option<String> {
    let body = read_capped(path)?;
    extract_first_unchecked(&body)
}

/// Case-insensitive match of a markdown header line (`#`-prefixed at any level) against a section `name` ("task checklist", "non-goals", ...).
fn is_section_header(line: &str, name: &str) -> bool {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('#') {
        return false;
    }
    let title = trimmed.trim_start_matches('#').trim();
    title.eq_ignore_ascii_case(name)
}

fn is_any_header(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

fn header_level(line: &str) -> usize {
    line.trim_start().chars().take_while(|c| *c == '#').count()
}

/// Deeper subheaders (e.g. `### Phase 1`) stay inside the section; only a header at the checklist's own level or shallower ends it.
fn has_checklist_section(body: &str) -> bool {
    body.lines()
        .any(|line| is_section_header(line, "task checklist") || is_section_header(line, "steps"))
}

fn checklist_section_name(body: &str) -> Option<&'static str> {
    if body
        .lines()
        .any(|line| is_section_header(line, "task checklist"))
    {
        Some("task checklist")
    } else if body.lines().any(|line| is_section_header(line, "steps")) {
        Some("steps")
    } else {
        None
    }
}

/// Markdown of the checklist section, without its heading. `None` when the plan has no checklist.
pub(crate) fn checklist_section_text(body: &str) -> Option<String> {
    let name = checklist_section_name(body)?;
    let mut section_level: Option<usize> = None;
    let mut lines = Vec::new();
    for line in body.lines() {
        if is_section_header(line, name) {
            section_level = Some(header_level(line));
            continue;
        }
        let Some(level) = section_level else {
            continue;
        };
        if is_any_header(line) && header_level(line) <= level {
            break;
        }
        if !line.trim().is_empty() {
            lines.push(line.trim_end());
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn first_unchecked_in_checklist(body: &str, name: &str) -> Option<String> {
    let mut section_level: Option<usize> = None;
    for line in body.lines() {
        if is_section_header(line, name) {
            section_level = Some(header_level(line));
            continue;
        }
        let Some(level) = section_level else {
            continue;
        };
        if is_any_header(line) && header_level(line) <= level {
            return None;
        }
        if let Some(item) = parse_checkbox_item(line.trim_start()) {
            return Some(item);
        }
    }
    None
}

/// Sections whose checkboxes must never be mined as a next step.
const EXCLUDED_SECTIONS: &[&str] = &["non-goals", "deviations"];

fn extract_first_unchecked(body: &str) -> Option<String> {
    if let Some(name) = checklist_section_name(body) {
        return first_unchecked_in_checklist(body, name);
    }
    let mut excluded = false;
    for line in body.lines() {
        if is_any_header(line) {
            excluded = EXCLUDED_SECTIONS
                .iter()
                .any(|name| is_section_header(line, name));
            continue;
        }
        if excluded {
            continue;
        }
        if let Some(item) = parse_checkbox_item(line.trim_start()) {
            return Some(item);
        }
    }
    None
}

fn strip_bullet_marker(trimmed: &str) -> Option<&str> {
    trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))
        .map(str::trim_start)
}

/// STRICTLY requires the literal `[ ]` glyph after the bullet marker; a plain `- foo` bullet returns `None`.
/// `- [x]` / `- [X]` (resolved) also return `None` so iteration continues to the next unchecked item.
fn parse_checkbox_item(trimmed: &str) -> Option<String> {
    let after_marker = strip_bullet_marker(trimmed)?;
    let after_checkbox = after_marker.strip_prefix("[ ]")?;
    let text = after_checkbox.trim();
    (!text.is_empty()).then(|| text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    fn write_temp(body: &str) -> NamedTempFile {
        let f = NamedTempFile::new().expect("temp file must be creatable");
        std::fs::write(f.path(), body).expect("write must succeed");
        f
    }

    #[test]
    fn checklist_in_the_plan_file_beats_plan_json() {
        use crate::tools::todo::{TodoItem, TodoPriority, TodoState, TodoStatus};
        use xai_grok_tools::implementations::grok_build::todo::TodoBindingKind;
        let dir = tempfile::tempdir().unwrap();
        let plans = dir.path().join("plans");
        std::fs::create_dir(&plans).unwrap();
        let episode = plans.join("goal.md");
        std::fs::write(
            &episode,
            "# Plan\n\n## Task checklist\n- [x] done item\n- [ ] file item\n",
        )
        .unwrap();
        let mut state = TodoState::default();
        state.push(
            "step-1".into(),
            TodoItem {
                content: "json item".into(),
                priority: TodoPriority::Medium,
                status: TodoStatus::Pending,
                meta: None,
            },
        );
        state.bind(TodoBindingKind::Approved, "plans/goal.md".into());
        std::fs::write(
            dir.path().join("plan.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        assert_eq!(
            first_pending_plan_item(&episode).as_deref(),
            Some("file item")
        );
        std::fs::write(&episode, "# Plan\n\n## Task checklist\n- [x] done item\n").unwrap();
        assert_eq!(first_pending_plan_item(&episode), None);
    }

    #[test]
    fn stripped_episode_falls_back_to_plan_json() {
        use crate::tools::todo::{TodoItem, TodoPriority, TodoState, TodoStatus};
        use xai_grok_tools::implementations::grok_build::todo::TodoBindingKind;
        let dir = tempfile::tempdir().unwrap();
        let plans = dir.path().join("plans");
        std::fs::create_dir(&plans).unwrap();
        let episode = plans.join("goal.md");
        std::fs::write(&episode, "# Plan\n\n## Goal\nShip it.\n").unwrap();
        let mut state = TodoState::default();
        state.push(
            "step-1".into(),
            TodoItem {
                content: "current item".into(),
                priority: TodoPriority::Medium,
                status: TodoStatus::Pending,
                meta: None,
            },
        );
        state.bind(TodoBindingKind::Approved, "plans/goal.md".into());
        std::fs::write(
            dir.path().join("plan.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        assert_eq!(
            first_pending_plan_item(&episode).as_deref(),
            Some("step-1: current item")
        );
        state.update(&"step-1".into(), None, Some(TodoStatus::Completed));
        std::fs::write(
            dir.path().join("plan.json"),
            serde_json::to_vec(&state).unwrap(),
        )
        .unwrap();
        assert_eq!(first_pending_plan_item(&episode), None);
    }

    #[test]
    fn plan_extracts_first_unchecked_item() {
        let body = "# Plan\n\n- [x] done\n- [x] also done\n- [ ] write the integration test\n- [ ] ship it\n";
        assert_eq!(
            extract_first_unchecked(body).as_deref(),
            Some("write the integration test"),
        );
    }

    #[test]
    fn plan_tolerates_indented_and_alt_bullets() {
        let body = "  - [x] one\n   * [ ] indented star item\n";
        assert_eq!(
            extract_first_unchecked(body).as_deref(),
            Some("indented star item"),
        );
    }

    #[test]
    fn plan_returns_none_when_all_items_checked() {
        let body = "- [x] one\n- [x] two\n";
        assert!(extract_first_unchecked(body).is_none());
    }

    #[test]
    fn plan_returns_none_on_empty_unchecked_label() {
        let body = "- [ ]   \n- [ ] real item\n";
        assert_eq!(extract_first_unchecked(body).as_deref(), Some("real item"),);
    }

    #[test]
    fn plan_does_not_mine_numbered_acceptance_criteria() {
        let numbered = "# Plan\n\n## Acceptance criteria\n\n1. app is created\n2. physics works\n";
        assert!(extract_first_unchecked(numbered).is_none());
        // Even with an inline `[ ]` glyph, a numbered item lacks the bullet marker `parse_checkbox_item` requires, so it is ignored
        let numbered_checkbox = "1. [ ] still a criterion, not a checkbox\n";
        assert!(extract_first_unchecked(numbered_checkbox).is_none());
    }

    #[test]
    fn plan_plain_bullet_without_checkbox_returns_none() {
        let body = "## Non-goals\n- a plain bullet\n- another plain bullet\n";
        assert!(extract_first_unchecked(body).is_none());
    }

    #[test]
    fn plan_checkbox_edge_cases() {
        let no_space = "- [ ]foo no space\n";
        assert_eq!(
            extract_first_unchecked(no_space).as_deref(),
            Some("foo no space"),
        );

        let upper_x = "- [X] uppercase done\n- [ ] real\n";
        assert_eq!(extract_first_unchecked(upper_x).as_deref(), Some("real"),);
    }

    #[test]
    fn tests_section_bullets_are_not_the_next_step_when_the_checklist_is_last() {
        let body = "# Plan\n\n## Tests\n- Criterion: the board loads\n  Command: `node --check app.js`\n\n## Deviations\n(none yet)\n\n## Steps\n- [x] `index.html` — page. Done when: file exists.\n- [ ] `js/app.js` — loop. Done when: check runs.\n";
        assert_eq!(
            extract_first_unchecked(body).as_deref(),
            Some("`js/app.js` — loop. Done when: check runs."),
        );
        let tests_only =
            "## Tests\n- Criterion: the board loads\n  Behavior: the page shows the board\n";
        assert!(extract_first_unchecked(tests_only).is_none());
        let checklist_last =
            "## Deviations\n- [ ] not a step\n\n## Task checklist\n- [ ] real last step\n";
        assert_eq!(
            extract_first_unchecked(checklist_last).as_deref(),
            Some("real last step"),
        );
    }

    #[test]
    fn checklist_section_scopes_extraction() {
        let body = "# Plan\n\n## Task checklist\n- [x] scaffold\n- [ ] wire input handling\n\n## Notes\n- [ ] stray box elsewhere\n";
        assert_eq!(
            extract_first_unchecked(body).as_deref(),
            Some("wire input handling"),
        );
        // All checklist items are done, so the result is None even though a stray box exists
        let done = "## Task checklist\n- [x] scaffold\n\n## Notes\n- [ ] stray box\n";
        assert!(extract_first_unchecked(done).is_none());
    }

    #[test]
    fn checklist_subheaders_do_not_end_the_section() {
        let body = "## Task checklist\n### Phase 1\n- [x] done\n### Phase 2\n- [ ] phase two step\n\n## Notes\n- [ ] stray box\n";
        assert_eq!(
            extract_first_unchecked(body).as_deref(),
            Some("phase two step"),
        );
        let ended = "## Task checklist\n- [x] done\n## Notes\n- [ ] stray box\n";
        assert!(extract_first_unchecked(ended).is_none());
    }

    #[test]
    fn non_goals_and_deviations_checkboxes_are_excluded() {
        let body =
            "## Non-goals\n- [ ] out-of-scope feature\n\n## Deviations\n- [ ] noted deviation\n";
        assert!(extract_first_unchecked(body).is_none());
        // A real checkbox after an excluded section is still found.
        let mixed = "## Non-goals\n- [ ] out of scope\n\n## Steps\n- [ ] real next step\n";
        assert_eq!(
            extract_first_unchecked(mixed).as_deref(),
            Some("real next step"),
        );
    }

    #[test]
    fn missing_file_returns_none() {
        let path = std::path::PathBuf::from("/definitely/not/a/real/path/xyzzy.md");
        assert!(first_unchecked_plan_item(&path).is_none());
    }

    #[test]
    fn malformed_markdown_returns_none_without_panicking() {
        let f = write_temp("# Plan\n\n");
        assert!(first_unchecked_plan_item(f.path()).is_none());
    }

    /// Invalid UTF-8 must not panic; `from_utf8_lossy` substitutes `U+FFFD` and the extractor returns the item after the garbage.
    #[test]
    fn invalid_utf8_plan_body_is_tolerated() {
        let f = NamedTempFile::new().unwrap();
        std::fs::write(f.path(), b"\xFF\xFE garbage\n- [ ] real step\n".as_slice()).unwrap();
        assert_eq!(
            first_unchecked_plan_item(f.path()).as_deref(),
            Some("real step"),
        );
    }

    #[test]
    fn read_is_capped_at_max_read_bytes() {
        assert_eq!(
            MAX_READ_BYTES,
            8 * 1024,
            "documented 8 KiB cap must not drift",
        );

        let mut body = String::new();
        body.push_str("- [ ] visible step\n");
        // Pad past the cap; lines after this point must stay invisible.
        while body.len() < MAX_READ_BYTES + 32 {
            body.push('x');
        }
        body.push_str("\n- [ ] HIDDEN past cap\n");
        assert!(body.len() > MAX_READ_BYTES + 16);

        let f = write_temp(&body);

        let raw = read_capped(f.path()).expect("read must succeed");
        assert!(
            !raw.contains("HIDDEN"),
            "read_capped must drop content past the cap: {raw}",
        );
        assert!(raw.contains("visible step"));

        let item = first_unchecked_plan_item(f.path()).expect("must extract within cap");
        assert!(
            !item.contains("HIDDEN"),
            "extractor must hide content past MAX_READ_BYTES: {item}",
        );
        assert!(item.contains("visible step"));
    }

    #[test]
    fn bullet_spanning_cap_boundary_is_dropped() {
        let mut body = String::new();
        body.push_str("- [ ] short visible step\n");
        // Pad just short of the cap, then plant an item that crosses it.
        while body.len() < MAX_READ_BYTES - 32 {
            body.push('x');
        }
        body.push_str("\n- [ ] ");
        let cross_text = "y".repeat(128);
        body.push_str(&cross_text);
        body.push('\n');
        assert!(body.len() > MAX_READ_BYTES);

        let f = write_temp(&body);
        let item = first_unchecked_plan_item(f.path()).expect("must extract within cap");
        assert_eq!(
            item, "short visible step",
            "must return the in-cap item; truncated tail must not leak: {item}",
        );
    }

    #[test]
    fn read_capped_handles_files_smaller_than_cap() {
        let f = write_temp("- [ ] tiny step\n");
        assert_eq!(
            first_unchecked_plan_item(f.path()).as_deref(),
            Some("tiny step"),
        );
    }

    #[test]
    fn open_checklist_step_ignores_criteria_and_finished_lists() {
        let open = "# Plan\n\n## Acceptance criteria\n- Criterion: the board loads\n  Behavior: the page shows the board\n\n## Steps\n- [x] `index.html` — page. Done when: file exists.\n- [ ] `js/app.js` — loop. Done when: check runs.\n";
        assert_eq!(
            open_checklist_step(open).as_deref(),
            Some("`js/app.js` — loop. Done when: check runs."),
        );
        let done = open.replace("- [ ] `js/app.js`", "- [x] `js/app.js`");
        assert!(open_checklist_step(&done).is_none());
        let criteria_only = "## Acceptance criteria\n- [ ] not a step\n";
        assert!(open_checklist_step(criteria_only).is_none());
        assert!(open_checklist_steps(criteria_only).is_empty());
        let two = "# Plan\n\n## Steps\n- [ ] write shapes.js\n- [x] done shell\n- [ ] Run ## Acceptance criteria.\n";
        let steps = open_checklist_steps(two);
        assert_eq!(
            steps,
            vec![
                "write shapes.js".to_string(),
                "Run ## Acceptance criteria.".to_string(),
            ]
        );
        let reminder = plan_stop_reminder(&steps);
        assert!(reminder.contains("write shapes.js"));
        assert!(reminder.contains("Run ## Acceptance criteria."));
        assert!(reminder.contains("do not run it again"));
        assert!(!reminder.contains("done shell"));
        assert!(should_plan_stop_nudge(false, false, 0, false));
        assert!(!should_plan_stop_nudge(true, false, 0, false));
        assert!(!should_plan_stop_nudge(false, true, 0, false));
        assert!(!should_plan_stop_nudge(false, false, 1, false));
        assert!(!should_plan_stop_nudge(false, false, 0, true));
        assert_eq!(PLAN_STOP_NUDGE_CAP, 1);
    }

    #[test]
    fn compaction_reminder_keeps_the_saved_plan_verbatim() {
        let body = "\
# Plan

## Goal
Ship the editor.

## Context
- layout notes that must stay out

## Acceptance criteria
- Criterion: the canvas pans
  Behavior: dragging empty canvas moves the view

## Steps
- [x] already shipped
- [ ] write canvas.js
";
        let path = "plans/editor.md";
        let passive = plan_compaction_reminder(body, PlanCompactionMode::Passive, path, false)
            .expect("passive");
        assert!(passive.contains("Ship the editor."));
        assert!(passive.contains("## Context"));
        assert!(passive.contains("already shipped"));
        assert!(passive.contains("- [x] already shipped"));
        assert!(passive.contains("- [ ] write canvas.js"));
        assert!(passive.contains("update this saved plan and its checklist"));
        assert!(passive.contains("do not edit the plan"));
        assert!(passive.contains("continue the work"));
        assert!(!passive.contains("only file you may edit"));
        let active = plan_compaction_reminder(body, PlanCompactionMode::Active, path, false)
            .expect("active");
        assert!(active.contains("already shipped"));
        assert!(active.contains("## Context"));
        assert!(active.contains("Plan mode is still active"));
        assert!(active.contains("only file you may edit"));
        assert!(!active.contains("continue the work"));
        assert!(plan_compaction_reminder("", PlanCompactionMode::Passive, path, false).is_none());
        let empty_active = plan_compaction_reminder("", PlanCompactionMode::Active, path, false)
            .expect("empty active");
        assert!(empty_active.contains("No plan is written yet"));
        assert!(empty_active.contains(path));
        assert!(empty_active.contains("Plan mode is still active"));
        let tests_only = "\
## Tests
- Criterion: the board loads
  Command: `cargo test`

## Steps
- [x] page exists
";
        let from_tests =
            plan_compaction_reminder(tests_only, PlanCompactionMode::Passive, path, false)
                .expect("tests heading stays");
        assert!(from_tests.contains("## Tests"));
        assert!(from_tests.contains("page exists"));
        assert!(!from_tests.contains("## Acceptance criteria"));
        let missing = std::path::Path::new("/definitely/not/a/real/path/xyzzy-plan.md");
        assert!(plan_compaction_reminder_at(missing, PlanCompactionMode::Passive).is_none());
        assert!(plan_compaction_reminder_at(missing, PlanCompactionMode::Active).is_none());
    }

    #[test]
    fn compaction_reminder_notes_when_the_plan_exceeds_the_copy_cap() {
        assert_eq!(PLAN_COMPACTION_READ_BYTES, 32 * 1024);
        let mut body = String::from("# Plan\n\n## Goal\nkeep this goal\n");
        while body.len() <= PLAN_COMPACTION_READ_BYTES {
            body.push_str("x\n");
        }
        body.push_str("HIDDEN_PAST_CAP\n");
        let f = write_temp(&body);
        let reminder = plan_compaction_reminder_at(f.path(), PlanCompactionMode::Passive)
            .expect("truncated plan");
        assert!(reminder.contains("keep this goal"));
        assert!(reminder.contains("The copy stopped at 32 KiB"));
        assert!(!reminder.contains("HIDDEN_PAST_CAP"));
    }
}
