//! `x.ai/session/plans` lists a session's plan files; `x.ai/session/plans/delete` removes one.
//!
//! Plan mode allocates one file per planning episode under `<session>/plans/<utc>.md`
//! (`session/plan_mode.rs`), then publishes it to `<slug>-<utc>.md` when the episode becomes
//! Inactive. The legacy `<session>/plan.md` is kept for sessions written before that. The desktop
//! client paints them under the header chip and drives Copy and Delete from this response, because
//! the renderer may not read or unlink files itself.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use agent_client_protocol as acp;
use serde::Deserialize;

use super::{ExtResult, to_raw_response};
use crate::session::plan_mode::{
    PlanModeState, UNTITLED_PLAN, episode_list_sort_key, legacy_plan_file_path, plan_display_title,
    plan_heading, read_plan_mode_snapshot, restore_plan_file_path,
};
use crate::session::storage as st;

/// Above this an entry is reported without its body: the list is a dropdown, and a plan this size
/// is not something the menu can usefully copy or preview.
const MAX_PLAN_BYTES: u64 = 1024 * 1024;

/// Only markdown is a plan; anything else in `plans/` is left alone, and cannot be deleted here.
const PLAN_EXTENSION: &str = "md";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanFileEntry {
    /// File name with extension. An episode starts as `<utc>.md` and is published to
    /// `<slug>-<utc>.md` when the episode ends.
    name: String,
    /// H1 from the plan body (`# Plan: …`), or `"Untitled plan"` when the file has no heading.
    title: String,
    /// Absolute path, for the client's "Copy file path".
    path: String,
    /// Path relative to the session directory, the form `plan_mode.json` records an episode in.
    relative_path: String,
    size_bytes: u64,
    /// Last write, epoch milliseconds. Request-changes edits in place, so this is not creation time.
    modified_ms: u64,
    /// The episode file the session's plan-mode tracker is pointed at.
    active: bool,
    /// Whether `x.ai/session/plans/delete` accepts this file.
    deletable: bool,
    /// File text, `None` when unreadable, not UTF-8, or above `MAX_PLAN_BYTES`.
    content: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanList {
    plans: Vec<PlanFileEntry>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Deleted {
    deleted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListRequest {
    session_id: String,
    cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRequest {
    session_id: String,
    cwd: String,
    path: String,
}

/// `x.ai/session/plans`: the session's plan files, newest first, with the current episode marked.
pub(crate) async fn handle_list(args: &acp::ExtRequest) -> ExtResult {
    let request: ListRequest = super::parse_params(args)?;
    let dir = session_dir(&request.session_id, &request.cwd)?;
    to_raw_response(&PlanList {
        plans: list_plans(&dir),
    })
}

/// `x.ai/session/plans/delete`: remove one plan file from the session.
pub(crate) async fn handle_delete(args: &acp::ExtRequest) -> ExtResult {
    let request: DeleteRequest = super::parse_params(args)?;
    let dir = session_dir(&request.session_id, &request.cwd)?;
    delete_plan(&dir, Path::new(&request.path))
        .map_err(|message| acp::Error::invalid_params().data(message))?;
    to_raw_response(&Deleted { deleted: true })
}

fn session_dir(session_id: &str, cwd: &str) -> Result<PathBuf, acp::Error> {
    super::session_state::validate_session_uuid(session_id)?;
    super::session_state::resolve_session_dir(session_id, cwd)
        .ok_or_else(|| acp::Error::invalid_params().data("session not found"))
}

/// The session's plan files, newest first.
///
/// Newest first by the UTC token in the filename (`<utc>` or `<slug>-<utc>`), not by the slug
/// prefix. Request-changes edits in place, so mtime is last write, not creation. The legacy
/// `<session>/plan.md` carries no timestamp and is reported last.
pub(crate) fn list_plans(session_dir: &Path) -> Vec<PlanFileEntry> {
    let snapshot = read_plan_mode_snapshot(session_dir);
    let active = restore_plan_file_path(
        session_dir,
        snapshot.as_ref().and_then(|s| s.plan_file.as_deref()),
    );
    // The tracker's file is only *held* by a running episode: with plan mode off it is just the
    // most recent plan, and deleting it is safe.
    let active_is_held = snapshot
        .as_ref()
        .is_some_and(|s| s.state != PlanModeState::Inactive);
    let goal_plan = held_goal_plan_file(session_dir);

    let mut paths: Vec<PathBuf> = std::fs::read_dir(session_dir.join(st::PLANS_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == PLAN_EXTENSION))
        .collect();

    let legacy = legacy_plan_file_path(session_dir);
    if legacy.is_file() {
        paths.push(legacy);
    }
    paths.sort_by(|a, b| episode_list_sort_key(b).cmp(&episode_list_sort_key(a)));

    paths
        .iter()
        .map(|path| {
            describe(
                session_dir,
                path,
                &active,
                active_is_held,
                goal_plan.as_deref(),
            )
        })
        .collect()
}

/// How many plan files a session directory holds: the per-episode `plans/*.md` plus the legacy
/// `plan.md`. Deleting a session takes its directory with them, so a bulk wipe reports this to say
/// what the conversations carried.
pub(crate) fn count_plan_files(session_dir: &Path) -> usize {
    let episodes = std::fs::read_dir(session_dir.join(st::PLANS_DIR))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry
                .path()
                .extension()
                .is_some_and(|ext| ext == PLAN_EXTENSION)
        })
        .count();
    episodes + usize::from(legacy_plan_file_path(session_dir).is_file())
}

/// Remove one plan file.
///
/// Reachability is deliberately narrow: a direct `.md` child of `<session>/plans/`, or the legacy
/// `<session>/plan.md`. The active file is refused while its episode is running, because a parked
/// `exit_plan_mode` and a live planning turn both still read it.
pub(crate) fn delete_plan(session_dir: &Path, target: &Path) -> Result<(), String> {
    let plans_dir = session_dir.join(st::PLANS_DIR);
    let is_episode = target.parent() == Some(plans_dir.as_path())
        && target.extension().is_some_and(|ext| ext == PLAN_EXTENSION);
    if !is_episode && target != legacy_plan_file_path(session_dir) {
        return Err(format!(
            "{} is not a plan file of this session",
            target.display()
        ));
    }
    if !target.is_file() {
        return Err(format!("{} no longer exists", target.display()));
    }
    if is_active_held(session_dir, target) {
        return Err(format!(
            "{} is the current plan and cannot be deleted while plan mode is on",
            target.display()
        ));
    }
    if held_goal_plan_file(session_dir).as_deref() == Some(target) {
        return Err(format!(
            "{} is the active goal plan and cannot be deleted until the goal ends or is cleared",
            target.display()
        ));
    }
    std::fs::remove_file(target).map_err(|e| format!("could not delete {}: {e}", target.display()))
}

fn held_goal_plan_file(session_dir: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(session_dir.join(st::GOAL_STATE_FILE)).ok()?;
    let goal: crate::session::goal_tracker::GoalOrchestration =
        serde_json::from_slice(&bytes).ok()?;
    (goal.status == crate::session::goal_tracker::GoalStatus::Active || goal.status.is_paused())
        .then_some(goal.plan_file)
        .flatten()
}

fn is_active_held(session_dir: &Path, target: &Path) -> bool {
    let Some(snapshot) = read_plan_mode_snapshot(session_dir) else {
        return false;
    };
    snapshot.state != PlanModeState::Inactive
        && restore_plan_file_path(session_dir, snapshot.plan_file.as_deref()) == target
}

fn describe(
    session_dir: &Path,
    path: &Path,
    active: &Path,
    active_is_held: bool,
    goal_plan: Option<&Path>,
) -> PlanFileEntry {
    let metadata = std::fs::metadata(path).ok();
    let is_active = path == active;
    let content = read_content(path);
    let title = content
        .as_deref()
        .map(plan_display_title)
        .or_else(|| heading_from_path(path))
        .unwrap_or_else(|| UNTITLED_PLAN.to_string());
    PlanFileEntry {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        title,
        path: path.display().to_string(),
        relative_path: path
            .strip_prefix(session_dir)
            .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default(),
        size_bytes: metadata.as_ref().map(|m| m.len()).unwrap_or(0),
        modified_ms: metadata
            .and_then(|m| m.modified().ok())
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|since| since.as_millis() as u64)
            .unwrap_or(0),
        active: is_active,
        deletable: (!is_active || !active_is_held) && goal_plan != Some(path),
        content,
    }
}

fn read_content(path: &Path) -> Option<String> {
    if std::fs::metadata(path).ok()?.len() > MAX_PLAN_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// First 8 KiB, enough to recover an H1 from a plan the list withheld as too large.
fn heading_from_path(path: &Path) -> Option<String> {
    use std::io::Read;
    const HEAD: usize = 8 * 1024;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEAD];
    let n = file.read(&mut buf).ok()?;
    plan_heading(std::str::from_utf8(&buf[..n]).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const EPISODE_A: &str = "2026-09-19T04-44-27Z.md";
    const EPISODE_B: &str = "2026-09-19T04-44-42Z.md";

    fn write_plan(dir: &Path, relative: &str, body: &str) -> PathBuf {
        let path = dir.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, body).unwrap();
        path
    }

    /// Persist a snapshot the way the tracker does: `plan_file` relative to the session directory.
    fn write_snapshot(dir: &Path, state: &str, plan_file: Option<&str>) {
        let mut snapshot = json!({ "state": state, "was_previously_active": true, "reminder_count": 0, "pending_exit_reminder": false, "awaiting_plan_approval": false });
        if let Some(plan_file) = plan_file {
            snapshot["plan_file"] = json!(plan_file);
        }
        std::fs::write(dir.join(st::PLAN_MODE_FILE), snapshot.to_string()).unwrap();
    }

    fn write_goal_snapshot(
        dir: &Path,
        status: crate::session::goal_tracker::GoalStatus,
        plan_file: &Path,
    ) {
        let mut goal = crate::session::goal_tracker::make_base_orchestration();
        goal.status = status;
        goal.plan_file = Some(plan_file.to_path_buf());
        let path = dir.join(st::GOAL_STATE_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&goal).unwrap()).unwrap();
    }

    fn names(plans: &[PlanFileEntry]) -> Vec<&str> {
        plans.iter().map(|plan| plan.name.as_str()).collect()
    }

    #[test]
    fn lists_episodes_newest_first_with_the_legacy_plan_last() {
        let tmp = tempfile::tempdir().unwrap();
        write_plan(tmp.path(), "plan.md", "# legacy");
        write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        write_plan(tmp.path(), &format!("plans/{EPISODE_B}"), "# b");
        // Not a plan: never listed, never deletable.
        std::fs::write(tmp.path().join("plans/notes.txt"), "x").unwrap();

        let plans = list_plans(tmp.path());

        assert_eq!(names(&plans), vec![EPISODE_B, EPISODE_A, "plan.md"]);
    }

    #[test]
    fn marks_the_tracked_episode_active_and_protected_while_planning() {
        let tmp = tempfile::tempdir().unwrap();
        write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        write_plan(tmp.path(), &format!("plans/{EPISODE_B}"), "# b");
        write_snapshot(tmp.path(), "Active", Some(&format!("plans/{EPISODE_B}")));

        let plans = list_plans(tmp.path());

        let active: Vec<&str> = plans
            .iter()
            .filter(|plan| plan.active)
            .map(|plan| plan.name.as_str())
            .collect();
        assert_eq!(active, vec![EPISODE_B]);
        // An earlier episode stays deletable while a later one is being planned.
        let earlier = plans.iter().find(|plan| plan.name == EPISODE_A).unwrap();
        assert!(earlier.deletable);
        let current = plans.iter().find(|plan| plan.name == EPISODE_B).unwrap();
        assert!(!current.deletable);
    }

    #[test]
    fn every_file_is_deletable_once_plan_mode_is_inactive() {
        let tmp = tempfile::tempdir().unwrap();
        write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        write_snapshot(tmp.path(), "Inactive", Some(&format!("plans/{EPISODE_A}")));

        let plans = list_plans(tmp.path());

        assert!(plans[0].active);
        assert!(plans[0].deletable);
    }

    #[test]
    fn a_snapshot_without_an_episode_file_makes_the_legacy_plan_active() {
        let tmp = tempfile::tempdir().unwrap();
        write_plan(tmp.path(), "plan.md", "# legacy");
        write_snapshot(tmp.path(), "Active", None);

        let plans = list_plans(tmp.path());

        assert_eq!(names(&plans), vec!["plan.md"]);
        assert!(plans[0].active);
        assert!(!plans[0].deletable);
    }

    #[test]
    fn reports_paths_size_and_content() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# plan\n");
        write_snapshot(tmp.path(), "Active", Some(&format!("plans/{EPISODE_A}")));

        let plans = list_plans(tmp.path());

        assert_eq!(plans[0].path, path.display().to_string());
        assert_eq!(plans[0].relative_path, format!("plans/{EPISODE_A}"));
        assert_eq!(plans[0].size_bytes, 7);
        assert!(plans[0].modified_ms > 0);
        assert_eq!(plans[0].content.as_deref(), Some("# plan\n"));
        assert_eq!(plans[0].title, "plan");
    }

    #[test]
    fn title_comes_from_the_h1_and_untitled_without_one() {
        let tmp = tempfile::tempdir().unwrap();
        write_plan(
            tmp.path(),
            &format!("plans/{EPISODE_A}"),
            "# Plan: Clean all files\n\nDelete them.\n",
        );
        write_plan(tmp.path(), &format!("plans/{EPISODE_B}"), "no heading\n");

        let plans = list_plans(tmp.path());
        let by_name = |name: &str| plans.iter().find(|plan| plan.name == name).unwrap();
        assert_eq!(by_name(EPISODE_A).title, "Clean all files");
        assert_eq!(by_name(EPISODE_B).title, "Untitled plan");
    }

    #[test]
    fn oversized_files_still_report_the_h1_from_the_head() {
        let tmp = tempfile::tempdir().unwrap();
        let mut body = "# Plan: Huge cleanup\n".to_string();
        body.extend(std::iter::repeat_n('a', MAX_PLAN_BYTES as usize));
        write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), &body);

        let plans = list_plans(tmp.path());
        assert_eq!(plans[0].content, None);
        assert_eq!(plans[0].title, "Huge cleanup");
    }

    #[test]
    fn lists_slug_prefixed_files_by_utc_not_by_slug() {
        let tmp = tempfile::tempdir().unwrap();
        write_plan(
            tmp.path(),
            "plans/zebra-2026-09-19T04-44-27Z.md",
            "# Zebra\n",
        );
        write_plan(
            tmp.path(),
            "plans/alpha-2026-09-19T04-44-42Z.md",
            "# Alpha\n",
        );
        write_plan(tmp.path(), "plan.md", "# legacy");

        let plans = list_plans(tmp.path());
        assert_eq!(
            names(&plans),
            vec![
                "alpha-2026-09-19T04-44-42Z.md",
                "zebra-2026-09-19T04-44-27Z.md",
                "plan.md"
            ]
        );
    }

    #[test]
    fn content_is_absent_above_the_cap_and_for_non_utf8() {
        let tmp = tempfile::tempdir().unwrap();
        write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        let huge = tmp.path().join(format!("plans/{EPISODE_B}"));
        std::fs::write(&huge, vec![b'a'; MAX_PLAN_BYTES as usize + 1]).unwrap();
        let binary = tmp.path().join("plans/2026-09-19T04-44-53Z.md");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();

        let plans = list_plans(tmp.path());

        let by_name = |name: &str| plans.iter().find(|plan| plan.name == name).unwrap();
        assert_eq!(by_name(EPISODE_A).content.as_deref(), Some("# a"));
        assert_eq!(by_name(EPISODE_B).content, None);
        assert_eq!(by_name("2026-09-19T04-44-53Z.md").content, None);
        // The size is still reported, so the client can say why it cannot copy it.
        assert_eq!(by_name(EPISODE_B).size_bytes, MAX_PLAN_BYTES + 1);
    }

    #[test]
    fn a_session_without_plans_lists_nothing() {
        let tmp = tempfile::tempdir().unwrap();

        assert!(list_plans(tmp.path()).is_empty());
    }

    #[test]
    fn delete_removes_an_earlier_episode() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        write_plan(tmp.path(), &format!("plans/{EPISODE_B}"), "# b");
        write_snapshot(tmp.path(), "Active", Some(&format!("plans/{EPISODE_B}")));

        delete_plan(tmp.path(), &path).unwrap();

        assert!(!path.exists());
        assert_eq!(names(&list_plans(tmp.path())), vec![EPISODE_B]);
    }

    #[test]
    fn delete_removes_the_legacy_plan() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = write_plan(tmp.path(), "plan.md", "# legacy");

        delete_plan(tmp.path(), &legacy).unwrap();

        assert!(!legacy.exists());
    }

    #[test]
    fn delete_refuses_the_active_file_while_planning() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        write_snapshot(tmp.path(), "Active", Some(&format!("plans/{EPISODE_A}")));

        let error = delete_plan(tmp.path(), &path).unwrap_err();

        assert!(error.contains("current plan"), "{error}");
        assert!(path.exists());
    }

    #[test]
    fn goal_episode_is_protected_until_the_goal_is_terminal() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        write_goal_snapshot(
            tmp.path(),
            crate::session::goal_tracker::GoalStatus::UserPaused,
            &path,
        );

        assert!(!list_plans(tmp.path())[0].deletable);
        let error = delete_plan(tmp.path(), &path).unwrap_err();
        assert!(error.contains("active goal plan"), "{error}");

        write_goal_snapshot(
            tmp.path(),
            crate::session::goal_tracker::GoalStatus::Complete,
            &path,
        );
        assert!(list_plans(tmp.path())[0].deletable);
        delete_plan(tmp.path(), &path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delete_refuses_anything_outside_the_sessions_plan_files() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tmp.path().parent().unwrap().join("outside.md");
        std::fs::write(&outside, "# outside").unwrap();
        write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# a");
        std::fs::write(tmp.path().join("plans/notes.txt"), "x").unwrap();

        for target in [
            outside.clone(),
            tmp.path().join(st::SUMMARY_FILE),
            tmp.path().join("plans/notes.txt"),
            tmp.path().join("plans/nested"),
            tmp.path()
                .join(format!("plans/{EPISODE_A}"))
                .parent()
                .unwrap()
                .join("..")
                .join("plan.json"),
            PathBuf::from("plan.md"),
        ] {
            let error =
                delete_plan(tmp.path(), &target).expect_err(&format!("{target:?} must be refused"));
            assert!(error.contains("is not a plan file"), "{error}");
        }
        std::fs::remove_file(&outside).unwrap();
    }

    #[test]
    fn delete_reports_a_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join(st::PLANS_DIR).join(EPISODE_A);

        let error = delete_plan(tmp.path(), &missing).unwrap_err();

        assert!(error.contains("no longer exists"), "{error}");
    }

    #[test]
    fn counts_episodes_and_the_legacy_plan() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            count_plan_files(tmp.path()),
            0,
            "an empty session has no plans"
        );

        write_plan(tmp.path(), &format!("plans/{EPISODE_A}"), "# one");
        write_plan(tmp.path(), &format!("plans/{EPISODE_B}"), "# two");
        assert_eq!(count_plan_files(tmp.path()), 2);

        // Only markdown counts, matching what the list reports and what delete accepts.
        write_plan(tmp.path(), "plans/notes.txt", "not a plan");
        assert_eq!(count_plan_files(tmp.path()), 2);

        write_plan(tmp.path(), "plan.md", "# legacy");
        assert_eq!(count_plan_files(tmp.path()), 3);
    }
}
