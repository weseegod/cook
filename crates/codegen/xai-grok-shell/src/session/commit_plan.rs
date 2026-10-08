//! Plan selection for the isolated `/commit` turn.
//!
//! The commit turn runs with no parent conversation, so the plan is the only place the *reason* for
//! the current changes survives. These helpers pick the plan the session is working from and decide
//! whether its body is small enough to inline into the commit prompt or only its path should travel.

use std::path::{Path, PathBuf};

/// Largest plan body inlined into the commit prompt; a larger plan contributes only its path.
pub(crate) const COMMIT_PLAN_INLINE_LIMIT: usize = 32 * 1024;

/// How the plan for the current changes reaches the commit turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommitPlanSource {
    /// The plan body, inlined because it is small.
    Body(String),
    /// The plan file's path, when the body is too large to inline.
    Path(String),
}

/// Priority inputs for [`select_commit_plan_path`].
pub(crate) struct CommitPlanCandidates<'a> {
    /// The approved plan the session is implementing, when it has one.
    pub approved_plan: Option<&'a Path>,
    /// Whether the session is currently implementing an approved plan.
    pub implementing_approved: bool,
    /// The current plan-mode episode path.
    pub current_plan_file: &'a Path,
    /// The active goal's plan episode, when a goal is running.
    pub active_goal_plan: Option<&'a Path>,
    /// The passive working-plan episode, when one was saved.
    pub passive_episode: Option<&'a Path>,
    /// Whether plan mode is open (active or awaiting approval).
    pub plan_mode_open: bool,
}

/// Pick the plan the session is working from, by priority:
/// the approved plan, the active goal's plan, the passive working plan, then an open plan-mode
/// episode. Only files the session is actually bound to are considered; a stray file in `plans/`
/// is never picked.
pub(crate) fn select_commit_plan_path(c: &CommitPlanCandidates<'_>) -> Option<PathBuf> {
    if let Some(path) = c.approved_plan {
        return Some(path.to_path_buf());
    }
    if c.implementing_approved {
        return Some(c.current_plan_file.to_path_buf());
    }
    if let Some(path) = c.active_goal_plan {
        return Some(path.to_path_buf());
    }
    if let Some(path) = c.passive_episode {
        return Some(path.to_path_buf());
    }
    if c.plan_mode_open {
        return Some(c.current_plan_file.to_path_buf());
    }
    None
}

/// Decide how a plan body reaches the commit turn: inlined, by path, or not at all.
///
/// An empty or unreadable plan is no plan; the commit turn then writes the message from the diff.
pub(crate) fn commit_plan_source(path: &Path, body: &str) -> Option<CommitPlanSource> {
    if body.trim().is_empty() {
        return None;
    }
    if body.len() > COMMIT_PLAN_INLINE_LIMIT {
        return Some(CommitPlanSource::Path(path.display().to_string()));
    }
    Some(CommitPlanSource::Body(body.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidates<'a>(
        approved: Option<&'a Path>,
        implementing: bool,
        current: &'a Path,
        goal: Option<&'a Path>,
        passive: Option<&'a Path>,
        open: bool,
    ) -> CommitPlanCandidates<'a> {
        CommitPlanCandidates {
            approved_plan: approved,
            implementing_approved: implementing,
            current_plan_file: current,
            active_goal_plan: goal,
            passive_episode: passive,
            plan_mode_open: open,
        }
    }

    #[test]
    fn approved_plan_wins_over_every_other_candidate() {
        let current = Path::new("plans/current.md");
        let c = candidates(
            Some(Path::new("plans/approved.md")),
            false,
            current,
            Some(Path::new("plans/goal.md")),
            Some(Path::new("plans/passive.md")),
            true,
        );
        assert_eq!(select_commit_plan_path(&c), Some(PathBuf::from("plans/approved.md")));
    }

    #[test]
    fn implementing_approved_falls_back_to_the_current_episode() {
        let current = Path::new("plans/current.md");
        let c = candidates(None, true, current, None, None, false);
        assert_eq!(select_commit_plan_path(&c), Some(PathBuf::from("plans/current.md")));
    }

    #[test]
    fn active_goal_plan_beats_the_passive_and_open_episodes() {
        let current = Path::new("plans/current.md");
        let c = candidates(
            None,
            false,
            current,
            Some(Path::new("plans/goal.md")),
            Some(Path::new("plans/passive.md")),
            true,
        );
        assert_eq!(select_commit_plan_path(&c), Some(PathBuf::from("plans/goal.md")));
    }

    #[test]
    fn passive_episode_beats_an_open_plan_mode_episode() {
        let current = Path::new("plans/current.md");
        let c = candidates(
            None,
            false,
            current,
            None,
            Some(Path::new("plans/passive.md")),
            true,
        );
        assert_eq!(select_commit_plan_path(&c), Some(PathBuf::from("plans/passive.md")));
    }

    #[test]
    fn open_plan_mode_episode_is_the_last_resort() {
        let current = Path::new("plans/current.md");
        let c = candidates(None, false, current, None, None, true);
        assert_eq!(select_commit_plan_path(&c), Some(PathBuf::from("plans/current.md")));
    }

    #[test]
    fn no_candidate_yields_no_plan() {
        let current = Path::new("plans/current.md");
        let c = candidates(None, false, current, None, None, false);
        assert_eq!(select_commit_plan_path(&c), None);
    }

    #[test]
    fn small_body_is_inlined() {
        let path = Path::new("plans/fix.md");
        let source = commit_plan_source(path, "# Plan: fix it\n");
        assert_eq!(
            source,
            Some(CommitPlanSource::Body("# Plan: fix it\n".to_string()))
        );
    }

    #[test]
    fn empty_or_whitespace_body_is_no_plan() {
        let path = Path::new("plans/fix.md");
        assert_eq!(commit_plan_source(path, ""), None);
        assert_eq!(commit_plan_source(path, "   \n\t"), None);
    }

    #[test]
    fn oversized_body_contributes_only_the_path() {
        let path = Path::new("plans/big.md");
        let body = "x".repeat(COMMIT_PLAN_INLINE_LIMIT + 1);
        assert_eq!(
            commit_plan_source(path, &body),
            Some(CommitPlanSource::Path("plans/big.md".to_string()))
        );
    }
}
