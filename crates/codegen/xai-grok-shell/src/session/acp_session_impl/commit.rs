//! The isolated `/commit` turn.
//!
//! `/commit` and `/commit-and-push` never run on the parent conversation. The host takes a compact
//! git snapshot, spawns a fresh child whose prompt carries only the plan and the working-tree
//! instructions, then reports one sentence back into the parent `chat_history`. The child's
//! transcript never reaches the parent, so the command costs a fresh small turn instead of a full
//! history replay.
//!
//! The spawn is hidden behind [`CommitSpawner`] so tests inject a deterministic child.

use std::path::{Path, PathBuf};

use xai_grok_tools::implementations::grok_build::task::backend::{ChannelBackend, SubagentBackend};
use xai_grok_tools::implementations::grok_build::task::types::{
    SubagentEvent, SubagentOwner, SubagentRequest, SubagentRuntimeOverrides,
};

use super::*;

/// Subagent type for the commit child: the general-purpose inventory, narrowed to write and execute.
const COMMIT_SUBAGENT_TYPE: &str = "general-purpose";

/// Label shown in the pager's subagent strip.
const COMMIT_SUBAGENT_DESCRIPTION: &str = "commit";

/// Reasoning effort for the commit child: committing needs no deep reasoning.
const COMMIT_SUBAGENT_REASONING_EFFORT: &str = "low";

/// Wall-clock budget for each host-side git probe.
const COMMIT_GIT_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Most uncommitted paths named in the receipt.
const COMMIT_LEFT_UNCOMMITTED_MAX: usize = 10;

/// The compact git facts the commit flow reads before and after the child.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CommitGitState {
    /// `HEAD` commit; `None` when the repository has no commit yet.
    pub head: Option<String>,
    /// Current branch; `None` when detached.
    pub branch: Option<String>,
    /// Tracked upstream of the current branch.
    pub upstream: Option<String>,
    /// Commits the branch is ahead of its upstream.
    pub ahead: usize,
    /// Changed paths in the working tree.
    pub dirty_files: Vec<String>,
    /// Whether a merge, rebase, cherry-pick, or bisect is in progress.
    pub operation_in_progress: bool,
}

/// What the commit turn did, reduced to the facts the receipt needs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CommitReport {
    /// The host stopped before the child ran; the exact sentence to report.
    pub stopped: Option<String>,
    /// `HEAD` before the child ran.
    pub head_before: Option<String>,
    /// `HEAD` after the child ran.
    pub head_after: Option<String>,
    /// Short hash of the new commit, when one was created.
    pub short_hash: Option<String>,
    /// Subject of the new commit.
    pub subject: Option<String>,
    /// Branch after the run.
    pub branch: Option<String>,
    /// Upstream after the run.
    pub upstream: Option<String>,
    /// Commits still ahead of upstream after the run.
    pub ahead_after: usize,
    /// Whether the run asked to push.
    pub push_requested: bool,
    /// Files still uncommitted after the run.
    pub left_uncommitted: Vec<String>,
}

impl CommitReport {
    /// The one sentence appended to the parent `chat_history` and shown to the user.
    pub(crate) fn sentence(&self) -> String {
        if let Some(stopped) = &self.stopped {
            return stopped.clone();
        }
        let committed = self.head_before != self.head_after && self.short_hash.is_some();
        if !committed {
            return "Commit stopped: the commit did not complete.".to_string();
        }
        let short = self.short_hash.clone().unwrap_or_default();
        let branch = self
            .branch
            .clone()
            .unwrap_or_else(|| "detached HEAD".to_string());
        let subject = self.subject.clone().unwrap_or_default();
        let mut line = format!("Committed {short} on {branch}: {subject}.");
        if self.push_requested {
            let pushed = self.upstream.is_some() && self.ahead_after == 0;
            if pushed {
                let upstream = self.upstream.clone().unwrap_or_default();
                line = format!(
                    "Committed {short} on {branch} and pushed to {upstream}: {subject}."
                );
            } else {
                let reason = if self.upstream.is_none() {
                    "the branch has no upstream"
                } else {
                    "the branch is still ahead of its upstream"
                };
                line.push_str(&format!(" Push did not happen: {reason}."));
            }
        }
        if !self.left_uncommitted.is_empty() {
            let shown = self
                .left_uncommitted
                .iter()
                .take(COMMIT_LEFT_UNCOMMITTED_MAX)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            line.push_str(&format!(" Left uncommitted: {shown}."));
        }
        line
    }
}

/// Parse `git status --porcelain=v1 -z --branch` output.
///
/// Returns `(branch, upstream, ahead, behind, dirty_files)`. Records are NUL-separated; the first
/// is the `##` header when `--branch` is set.
pub(crate) fn parse_status_z(raw: &[u8]) -> (Option<String>, Option<String>, usize, usize, Vec<String>) {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0usize;
    let mut behind = 0usize;
    let mut dirty = Vec::new();
    for record in raw.split(|b| *b == 0) {
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        if let Some(header) = text.strip_prefix("## ") {
            let (local, rest) = match header.split_once("...") {
                Some((local, rest)) => (local, Some(rest)),
                None => (header, None),
            };
            let local = local.trim();
            if !local.is_empty() && local != "HEAD" && !local.starts_with("HEAD (no branch)") {
                branch = Some(local.to_string());
            }
            if let Some(rest) = rest {
                let (name, bracket) = match rest.split_once(" [") {
                    Some((name, bracket)) => (name, Some(bracket)),
                    None => (rest, None),
                };
                let name = name.trim();
                if !name.is_empty() {
                    upstream = Some(name.to_string());
                }
                if let Some(bracket) = bracket {
                    for part in bracket.trim_end_matches(']').split(',') {
                        let part = part.trim();
                        if let Some(n) = part.strip_prefix("ahead ") {
                            ahead = n.trim().parse().unwrap_or(0);
                        } else if let Some(n) = part.strip_prefix("behind ") {
                            behind = n.trim().parse().unwrap_or(0);
                        }
                    }
                }
            }
            continue;
        }
        // `XY path`; the third byte is the separator space.
        if text.len() > 3 && text.as_bytes().get(2) == Some(&b' ') {
            let path = text[3..].to_string();
            if !path.is_empty() {
                dirty.push(path);
            }
        }
    }
    (branch, upstream, ahead, behind, dirty)
}

/// Whether a merge, rebase, cherry-pick, or bisect marker exists under the git dir.
fn operation_marker_present(cwd: &Path, git_dir: &str) -> bool {
    let path = Path::new(git_dir);
    let dir = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "BISECT_LOG",
        "rebase-merge",
        "rebase-apply",
    ]
    .iter()
    .any(|marker| dir.join(marker).exists())
}

/// Run one bounded git probe; `None` on spawn failure or timeout.
async fn run_git(cwd: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut cmd = tokio::process::Command::new(crate::util::subprocess::git_bin());
    cmd.args(args).current_dir(cwd);
    match tokio::time::timeout(COMMIT_GIT_PROBE_TIMEOUT, cmd.output()).await {
        Ok(Ok(output)) => Some(output),
        _ => None,
    }
}

/// Read the compact git state the commit flow needs. `None` when `cwd` is not a git work tree.
pub(crate) async fn probe_commit_git_state(cwd: &Path) -> Option<CommitGitState> {
    let inside = run_git(cwd, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !inside.status.success() || String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return None;
    }
    let head = run_git(cwd, &["rev-parse", "--verify", "HEAD"])
        .await
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|sha| !sha.is_empty());
    let status = run_git(
        cwd,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--untracked-files=normal",
        ],
    )
    .await?;
    let (branch, upstream, ahead, _behind, dirty_files) = parse_status_z(&status.stdout);
    let git_dir = run_git(cwd, &["rev-parse", "--git-dir"])
        .await
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string());
    let operation_in_progress = git_dir
        .as_deref()
        .is_some_and(|dir| operation_marker_present(cwd, dir));
    Some(CommitGitState {
        head,
        branch,
        upstream,
        ahead,
        dirty_files,
        operation_in_progress,
    })
}

/// Short hash and subject of `HEAD`.
async fn read_commit_summary(cwd: &Path) -> Option<(String, String)> {
    let out = run_git(cwd, &["log", "-1", "--format=%h%n%s"]).await?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let hash = lines.next()?.trim().to_string();
    if hash.is_empty() {
        return None;
    }
    let subject = lines.next().unwrap_or_default().trim().to_string();
    Some((hash, subject))
}

/// The commit child's terminal result.
pub(crate) struct CommitChildResult {
    /// The child's final text.
    pub output: String,
    /// Whether the child was cancelled.
    pub cancelled: bool,
}

/// Build the commit child's prompt from the plan in use.
///
/// The prompt carries the plan (or its path) and the working-tree instructions only: it never
/// receives the parent conversation, so the child cannot read it.
pub(crate) fn build_commit_child_prompt(
    hint: &str,
    push: bool,
    plan: Option<&crate::session::commit_plan::CommitPlanSource>,
) -> String {
    let plan_ref = plan.map(|source| match source {
        crate::session::commit_plan::CommitPlanSource::Body(body) => {
            xai_grok_tools::implementations::grok_build::CommitPlan::Body(body.as_str())
        }
        crate::session::commit_plan::CommitPlanSource::Path(path) => {
            xai_grok_tools::implementations::grok_build::CommitPlan::Path(path.as_str())
        }
    });
    xai_grok_tools::implementations::grok_build::commit_instruction_with_plan(hint, push, plan_ref)
}

/// The subagent request the commit flow sends: a fresh child with write and execute capability,
/// never a fork of the parent conversation. `/commit` and `/commit-and-push` are mechanical, so
/// the child runs at low reasoning effort; the spawn gate drops the override for a model without
/// reasoning-effort support and clamps it to the model default when `low` is not offered.
pub(crate) fn commit_subagent_request(
    prompt: String,
    parent_session_id: String,
    parent_prompt_id: Option<String>,
    cwd: Option<String>,
) -> SubagentRequest {
    SubagentRequest {
        id: uuid::Uuid::now_v7().to_string(),
        prompt,
        description: COMMIT_SUBAGENT_DESCRIPTION.to_string(),
        subagent_type: COMMIT_SUBAGENT_TYPE.to_string(),
        parent_session_id,
        parent_prompt_id,
        resume_from: None,
        cwd,
        runtime_overrides: SubagentRuntimeOverrides {
            capability_mode: Some(xai_tool_types::SubagentCapabilityMode::All),
            reasoning_effort: Some(COMMIT_SUBAGENT_REASONING_EFFORT.to_string()),
            ..Default::default()
        },
        run_in_background: false,
        // Harness-internal: never surface to the model's idle reminder.
        surface_completion: false,
        // Never auto-backgrounded: the command runs until the child finishes or is cancelled.
        await_to_completion: true,
        // Fresh context: the child must not see the parent conversation.
        fork_context: false,
        owner: SubagentOwner::Task,
        cancel_token: tokio_util::sync::CancellationToken::new(),
        spawn_root: Default::default(),
        tool_call_id: None,
    }
}

/// Runs the commit child. Production uses [`ChannelSpawner`]; tests inject a fake.
#[async_trait::async_trait]
pub(crate) trait CommitSpawner: Send + Sync {
    /// Spawn the commit child with `prompt` and await its terminal result.
    async fn run(&self, prompt: String) -> Result<CommitChildResult, String>;
}

/// Production spawner: sends the request over the session's subagent channel.
pub(crate) struct ChannelSpawner {
    pub(crate) event_tx: tokio::sync::mpsc::UnboundedSender<SubagentEvent>,
    pub(crate) foreground_wait:
        Option<xai_grok_tools::implementations::grok_build::task::types::SubagentForegroundWait>,
    pub(crate) parent_session_id: String,
    pub(crate) parent_prompt_id: Option<String>,
    pub(crate) cwd: Option<String>,
}

#[async_trait::async_trait]
impl CommitSpawner for ChannelSpawner {
    async fn run(&self, prompt: String) -> Result<CommitChildResult, String> {
        let request = commit_subagent_request(
            prompt,
            self.parent_session_id.clone(),
            self.parent_prompt_id.clone(),
            self.cwd.clone(),
        );
        let backend = ChannelBackend::new(self.event_tx.clone());
        let result = backend
            .spawn_with_foreground_wait(request, self.foreground_wait.as_ref())
            .await
            .map_err(|error| error.to_string())?;
        if result.backgrounded {
            return Err(
                "engine bug: commit child was auto-backgrounded despite await_to_completion"
                    .to_string(),
            );
        }
        if !result.success && !result.cancelled {
            return Err(result
                .error
                .unwrap_or_else(|| "unknown subagent error".to_string()));
        }
        Ok(CommitChildResult {
            output: result.output.to_string(),
            cancelled: result.cancelled,
        })
    }
}

impl SessionActor {
    /// The plan the session is currently working from, by priority.
    pub(super) fn commit_plan_path_in_use(&self) -> Option<PathBuf> {
        let active_goal_plan = {
            let tracker = self.goal_tracker.lock();
            tracker.snapshot().and_then(|goal| {
                (goal.status == crate::session::goal_tracker::GoalStatus::Active)
                    .then(|| goal.plan_file.clone())
                    .flatten()
            })
        };
        let tracker = self.plan_mode.lock();
        let candidates = crate::session::commit_plan::CommitPlanCandidates {
            approved_plan: tracker.frozen_plan().map(|plan| plan.episode.as_path()),
            implementing_approved: self
                .implementing_approved_plan
                .load(std::sync::atomic::Ordering::Relaxed),
            current_plan_file: tracker.plan_file_path(),
            active_goal_plan: active_goal_plan.as_deref(),
            passive_episode: tracker.passive_episode(),
            plan_mode_open: tracker.is_active() || tracker.is_awaiting_plan_approval(),
        };
        crate::session::commit_plan::select_commit_plan_path(&candidates)
    }

    /// Read the plan in use and decide whether its body travels or only its path.
    pub(super) async fn commit_plan_in_use(
        &self,
    ) -> Option<crate::session::commit_plan::CommitPlanSource> {
        let path = self.commit_plan_path_in_use()?;
        let body = tokio::fs::read_to_string(&path).await.ok()?;
        crate::session::commit_plan::commit_plan_source(&path, &body)
    }

    /// Run `/commit` or `/commit-and-push` as an isolated turn.
    pub(super) async fn run_commit_command(
        self: &Arc<Self>,
        hint: String,
        push: bool,
    ) -> PromptTurnResult {
        let command_text = if push {
            format!("/commit-and-push{}", hint_suffix(&hint))
        } else {
            format!("/commit{}", hint_suffix(&hint))
        };
        let cwd = PathBuf::from(self.tool_context.cwd.as_str());
        let Some(before) = probe_commit_git_state(&cwd).await else {
            return self
                .finish_commit(
                    &command_text,
                    "Commit stopped: this workspace is not a git repository.".to_string(),
                )
                .await;
        };
        if before.operation_in_progress {
            return self
                .finish_commit(
                    &command_text,
                    "Commit stopped: a merge, rebase, cherry-pick, or bisect is in progress."
                        .to_string(),
                )
                .await;
        }
        if before.dirty_files.is_empty() {
            return self.finish_commit(&command_text, "Nothing to commit.".to_string()).await;
        }
        let Some(event_tx) = self.tool_context.subagent_event_tx.clone() else {
            return self
                .finish_commit(
                    &command_text,
                    "Commit stopped: subagents are unavailable in this session.".to_string(),
                )
                .await;
        };

        let plan = self.commit_plan_in_use().await;
        let prompt = build_commit_child_prompt(&hint, push, plan.as_ref());

        let spawner = ChannelSpawner {
            event_tx,
            foreground_wait: Some(crate::tools::tool_context::subagent_foreground_wait(
                self.tool_context.blocking_wait_depth.clone(),
            )),
            parent_session_id: self.session_id_string(),
            parent_prompt_id: self
                .current_prompt_id
                .lock()
                .expect("current_prompt_id mutex poisoned")
                .clone(),
            cwd: Some(self.tool_context.cwd.as_str().to_owned()),
        };
        let outcome = spawner.run(prompt).await;

        let after = probe_commit_git_state(&cwd).await.unwrap_or_default();
        let committed = after.head != before.head;
        let (short_hash, subject) = if committed {
            match read_commit_summary(&cwd).await {
                Some((hash, subject)) => (Some(hash), Some(subject)),
                None => (None, None),
            }
        } else {
            (None, None)
        };
        let report = CommitReport {
            stopped: None,
            head_before: before.head.clone(),
            head_after: after.head.clone(),
            short_hash,
            subject,
            branch: after.branch.clone(),
            upstream: after.upstream.clone(),
            ahead_after: after.ahead,
            push_requested: push,
            left_uncommitted: after.dirty_files.clone(),
        };
        let sentence = match outcome {
            Ok(result) if !result.cancelled => report.sentence(),
            Ok(_) => {
                // Cancelled: keep a commit that landed, otherwise say it stopped.
                let mut cancelled = report;
                if cancelled.short_hash.is_none() {
                    cancelled.stopped = Some("Commit stopped: cancelled.".to_string());
                }
                cancelled.sentence()
            }
            Err(_) => {
                let mut failed = report;
                if failed.short_hash.is_none() {
                    failed.stopped =
                        Some("Commit stopped: the commit child failed to run.".to_string());
                }
                failed.sentence()
            }
        };
        self.finish_commit(&command_text, sentence).await
    }

    /// Show the receipt, append the command plus the sentence to the parent `chat_history`, and end
    /// the turn. The child's transcript is never copied.
    async fn finish_commit(
        self: &Arc<Self>,
        command_text: &str,
        sentence: String,
    ) -> PromptTurnResult {
        self.send_host_turn_slash_command_output(&sentence).await;
        self.chat_state_handle
            .push_user_message(ConversationItem::user(command_text.to_string()));
        self.chat_state_handle
            .push_assistant_response(ConversationItem::assistant(sentence));
        ok_end_turn(0, None)
    }
}

/// ` <hint>` when the user gave one, otherwise nothing.
fn hint_suffix(hint: &str) -> String {
    let hint = hint.trim();
    if hint.is_empty() {
        String::new()
    } else {
        format!(" {hint}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_z_reads_branch_upstream_and_ahead() {
        let raw = b"## main...origin/main [ahead 1, behind 2]\0 M src/lib.rs\0?? new.txt\0";
        let (branch, upstream, ahead, behind, dirty) = parse_status_z(raw);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(upstream.as_deref(), Some("origin/main"));
        assert_eq!(ahead, 1);
        assert_eq!(behind, 2);
        assert_eq!(dirty, vec!["src/lib.rs".to_string(), "new.txt".to_string()]);
    }

    #[test]
    fn parse_status_z_handles_a_branch_without_upstream() {
        let raw = b"## feature/x\0";
        let (branch, upstream, ahead, behind, dirty) = parse_status_z(raw);
        assert_eq!(branch.as_deref(), Some("feature/x"));
        assert_eq!(upstream, None);
        assert_eq!((ahead, behind), (0, 0));
        assert!(dirty.is_empty());
    }

    #[test]
    fn parse_status_z_handles_a_detached_head() {
        let raw = b"## HEAD (no branch)\0";
        let (branch, upstream, ..) = parse_status_z(raw);
        assert_eq!(branch, None);
        assert_eq!(upstream, None);
    }

    #[test]
    fn receipt_reports_nothing_to_commit_verbatim() {
        let report = CommitReport {
            stopped: Some("Nothing to commit.".to_string()),
            ..Default::default()
        };
        assert_eq!(report.sentence(), "Nothing to commit.");
    }

    #[test]
    fn receipt_reports_a_plain_commit() {
        let report = CommitReport {
            head_before: Some("aaa".to_string()),
            head_after: Some("bbb".to_string()),
            short_hash: Some("abc1234".to_string()),
            subject: Some("Save optional request headers".to_string()),
            branch: Some("main".to_string()),
            ..Default::default()
        };
        assert_eq!(
            report.sentence(),
            "Committed abc1234 on main: Save optional request headers."
        );
    }

    #[test]
    fn receipt_reports_a_pushed_commit() {
        let report = CommitReport {
            head_before: Some("aaa".to_string()),
            head_after: Some("bbb".to_string()),
            short_hash: Some("abc1234".to_string()),
            subject: Some("Save headers".to_string()),
            branch: Some("main".to_string()),
            upstream: Some("origin/main".to_string()),
            ahead_after: 0,
            push_requested: true,
            ..Default::default()
        };
        assert_eq!(
            report.sentence(),
            "Committed abc1234 on main and pushed to origin/main: Save headers."
        );
    }

    #[test]
    fn receipt_reports_a_push_that_did_not_happen() {
        let report = CommitReport {
            head_before: Some("aaa".to_string()),
            head_after: Some("bbb".to_string()),
            short_hash: Some("abc1234".to_string()),
            subject: Some("Save headers".to_string()),
            branch: Some("main".to_string()),
            upstream: Some("origin/main".to_string()),
            ahead_after: 1,
            push_requested: true,
            ..Default::default()
        };
        assert_eq!(
            report.sentence(),
            "Committed abc1234 on main: Save headers. \
             Push did not happen: the branch is still ahead of its upstream."
        );
    }

    #[test]
    fn receipt_names_left_uncommitted_files() {
        let report = CommitReport {
            head_before: Some("aaa".to_string()),
            head_after: Some("bbb".to_string()),
            short_hash: Some("abc1234".to_string()),
            subject: Some("Save headers".to_string()),
            branch: Some("main".to_string()),
            left_uncommitted: vec!["a.rs".to_string(), "b.rs".to_string()],
            ..Default::default()
        };
        assert_eq!(
            report.sentence(),
            "Committed abc1234 on main: Save headers. Left uncommitted: a.rs, b.rs."
        );
    }

    #[test]
    fn receipt_reports_a_stopped_commit_when_no_commit_landed() {
        let report = CommitReport {
            head_before: Some("aaa".to_string()),
            head_after: Some("aaa".to_string()),
            ..Default::default()
        };
        assert_eq!(report.sentence(), "Commit stopped: the commit did not complete.");
    }

    #[test]
    fn child_prompt_carries_the_plan_and_never_a_parent_marker() {
        use crate::session::commit_plan::CommitPlanSource;
        let plan = CommitPlanSource::Body("# Plan: isolate the commit turn".to_string());
        let prompt = build_commit_child_prompt("ship it", true, Some(&plan));
        assert!(prompt.contains("# Plan: isolate the commit turn"));
        assert!(prompt.contains("ship it"));
        assert!(prompt.contains("## Then push"));
        // A fresh turn: nothing from the parent conversation is reachable.
        assert!(prompt.contains("you do NOT have the conversation"));
        assert!(!prompt.contains("<parent-history>"));
    }

    #[test]
    fn child_prompt_without_a_plan_says_so() {
        let prompt = build_commit_child_prompt("", false, None);
        assert!(prompt.contains("No plan is attached to this session"));
        assert!(!prompt.contains("## Then push"));
    }

    #[test]
    fn child_request_is_a_fresh_write_capable_child() {
        let request = commit_subagent_request(
            "prompt".to_string(),
            "parent".to_string(),
            Some("prompt-1".to_string()),
            Some("/repo".to_string()),
        );
        assert!(!request.fork_context, "the child must not fork the parent context");
        assert!(!request.surface_completion, "the child must not wake the parent");
        assert!(request.await_to_completion);
        assert!(!request.run_in_background);
        assert_eq!(
            request.runtime_overrides.capability_mode,
            Some(xai_tool_types::SubagentCapabilityMode::All)
        );
        assert_eq!(
            request.runtime_overrides.reasoning_effort.as_deref(),
            Some("low"),
            "the commit child must not inherit the session's reasoning effort"
        );
        assert_eq!(request.subagent_type, "general-purpose");
    }
}
