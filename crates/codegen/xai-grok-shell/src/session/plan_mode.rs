//! Plan mode state machine and prompt text generation.
//!
//! This module contains the [`PlanModeTracker`] struct that manages the full plan mode lifecycle for a session.
//! It is designed to be testable in isolation: pure state machine logic, with no references to `SessionActor`, conversation history, or async I/O.
//!
//! The `SessionActor` owns one `PlanModeTracker` (behind a `Mutex`).
//! It calls the tracker's methods at the appropriate points (`handle_session_mode`, `handle_prompt`, `handle_completion`, `run_compact`).
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Longest kebab-case slug published into an episode filename. Cut at a hyphen so the
/// name stays a readable prefix, not a mid-word stump.
const PLAN_SLUG_MAX: usize = 40;
/// `YYYY-MM-DDTHH-MM-SSZ`
const UTC_STAMP_LEN: usize = 20;
/// List/chip fallback when a plan file has no H1 yet (or is empty).
pub(crate) const UNTITLED_PLAN: &str = "Untitled plan";
/// Lives alongside `session_yolo_mode` and `active_agent_type`: it is session-scoped mutable state, not part of AgentDefinition.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PlanModeState {
    /// Normal operating mode. No plan mode constraints.
    Inactive,
    /// Client toggled plan mode ON, but no prompt has been sent yet.
    /// The model does not know about plan mode yet.
    /// Transitions: -> Active (first user prompt triggers injection) -> Inactive (client toggles off before any prompt).
    Pending,
    /// The model has received plan mode instructions (either via system-reminder injection or via EnterPlanMode tool result).
    /// Write tools are blocked except for the plan file.
    /// Transitions: -> Inactive (ExitPlanMode approved, or user toggles off when idle) -> ExitPending (user toggles off while a turn is in-flight).
    Active,
    /// Client toggled plan mode OFF while Active and a model turn is in-flight.
    /// We need to wait for the current turn to finish (or cancel it), then cleanly exit.
    /// Transitions: -> Inactive (after turn completes, exit attachment injected).
    ExitPending,
}
pub struct PlanModeTracker {
    state: PlanModeState,
    /// Used for reentry detection: if true and we enter Active again, inject the reentry reminder instead of the standard one.
    was_previously_active: bool,
    /// An even count means the full reminder, an odd count the sparse one. Reset on compaction.
    reminder_count: u32,
    /// Flag: inject a plan_mode_exit reminder on the next turn.
    /// Set only when the model has no in-context exit signal: user-initiated exits (toggle) and exits queued via [`Self::queue_exit_reminder`].
    pending_exit_reminder: bool,
    /// `exit_plan_mode` approval UI is outstanding (client has not answered).
    /// Persisted so resume can restore approval chrome.
    awaiting_plan_approval: bool,
    /// Rendered activation reminder buffered by a mid-turn toggle ([`Self::activate_mid_turn`]).
    /// While set, the model has NOT seen plan mode yet.
    /// A toggle-off withdraws it and rolls the activation back instead of deferring an exit the model never knew about.
    pending_activation: Option<PendingActivation>,
    /// The session directory holding the plan files (`plans/` and the legacy `plan.md`).
    session_dir: PathBuf,
    /// Current planning episode's plan file. Allocated by [`Self::begin_plan_episode`] under
    /// `<session_dir>/plans/<utc>.md`; published to `<slug>-<utc>.md` when the episode becomes
    /// Inactive. `<session_dir>/plan.md` until a session starts its first episode.
    plan_file_path: PathBuf,
    /// Every path allocated in this process, so two episodes inside the same clock second still get
    /// distinct files even before either is written to disk. Not persisted: on resume the restored
    /// `plan_file_path` plus an on-disk exists() check cover the same guarantee.
    episode_files: Vec<PathBuf>,
}
/// A buffered mid-turn activation reminder plus the state needed to roll the activation back if it is withdrawn before delivery.
struct PendingActivation {
    /// Pre-wrapped `<system-reminder>` text, ready to push verbatim.
    text: String,
    /// `was_previously_active` before this activation, restored on withdrawal so a rolled-back activation doesn't fake a reentry.
    prior_was_previously_active: bool,
}
/// Persisted to `plan_mode.json` in the session directory and restored on session reload/resume so plan mode survives process restarts.
/// The `plan_file_path` is NOT persisted; it is recomputed from session metadata.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PlanModeSnapshot {
    pub state: PlanModeState,
    pub was_previously_active: bool,
    pub reminder_count: u32,
    pub pending_exit_reminder: bool,
    /// Client was shown `exit_plan_mode` approval but has not answered yet.
    /// Survives process restart so the pager can restore approval chrome without treating every Active session that has a plan.md as pending.
    #[serde(default)]
    pub awaiting_plan_approval: bool,
    /// Current episode's plan file, relative to the session directory (`plans/<utc>.md` while
    /// planning, `plans/<slug>-<utc>.md` after the episode is published).
    /// `None` on snapshots written before episodes were allocated, and for the legacy
    /// `<session_dir>/plan.md` default: both restore to `<session_dir>/plan.md`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_file: Option<String>,
}
impl PlanModeTracker {
    /// Create a new tracker. `session_dir` is the session's storage
    /// directory (e.g., `~/.grok/sessions/<encoded-cwd>/<session-id>/`).
    pub fn new(session_dir: PathBuf) -> Self {
        Self {
            state: PlanModeState::Inactive,
            was_previously_active: false,
            reminder_count: 0,
            pending_exit_reminder: false,
            awaiting_plan_approval: false,
            pending_activation: None,
            plan_file_path: legacy_plan_file_path(&session_dir),
            session_dir,
            episode_files: Vec::new(),
        }
    }
    /// `session_dir` is used to recompute `plan_file_path`.
    /// Transient states depend on in-flight client/turn interactions that don't survive a restart, so they are collapsed:
    /// `Pending` becomes `Inactive`, and `ExitPending` becomes `Inactive` with the exit reminder set.
    pub(crate) fn from_snapshot(session_dir: PathBuf, mut snapshot: PlanModeSnapshot) -> Self {
        match snapshot.state {
            PlanModeState::Pending => {
                snapshot.state = PlanModeState::Inactive;
            }
            PlanModeState::ExitPending => {
                snapshot.state = PlanModeState::Inactive;
                snapshot.pending_exit_reminder = true;
            }
            _ => {}
        }
        Self {
            state: snapshot.state,
            was_previously_active: snapshot.was_previously_active,
            reminder_count: snapshot.reminder_count,
            pending_exit_reminder: snapshot.pending_exit_reminder,
            awaiting_plan_approval: snapshot.awaiting_plan_approval,
            pending_activation: None,
            plan_file_path: restore_plan_file_path(&session_dir, snapshot.plan_file.as_deref()),
            session_dir,
            episode_files: Vec::new(),
        }
    }
    /// Mark that the client is waiting on plan approval (`exit_plan_mode` parked).
    pub(crate) fn set_awaiting_plan_approval(&mut self, awaiting: bool) {
        self.awaiting_plan_approval = awaiting;
    }
    /// Whether approval is outstanding (also true after resume from snapshot).
    pub(crate) fn is_awaiting_plan_approval(&self) -> bool {
        self.awaiting_plan_approval
    }
    pub fn snapshot(&self) -> PlanModeSnapshot {
        PlanModeSnapshot {
            state: self.state,
            was_previously_active: self.was_previously_active,
            awaiting_plan_approval: self.awaiting_plan_approval,
            reminder_count: self.reminder_count,
            pending_exit_reminder: self.pending_exit_reminder,
            plan_file: self.relative_plan_file(),
        }
    }

    /// The current plan file relative to the session directory, when it lives inside it.
    /// Used for persistence so a session's plan file survives resume.
    fn relative_plan_file(&self) -> Option<String> {
        let relative = self.plan_file_path.strip_prefix(&self.session_dir).ok()?;
        let text = relative.to_string_lossy().replace('\\', "/");
        (!text.is_empty()).then_some(text)
    }

    /// The path a new episode would allocate, without mutating tracker state.
    /// Deterministic for unchanged state so a caller can render the activation reminder with the
    /// path the subsequent [`Self::activate`] / [`Self::activate_mid_turn`] will install.
    ///
    /// Identities already on disk (including a published `<slug>-<utc>.md`) count as taken, so a
    /// later episode in the same UTC second still gets `-2` after the previous file was renamed.
    pub(crate) fn next_episode_path(&self) -> PathBuf {
        next_episode_path_with_extra(&self.session_dir, self.episode_files.iter())
    }

    /// Start a new planning episode on a fresh file under `<session_dir>/plans/`.
    ///
    /// Called when plan mode activates from `Inactive`, so each `/plan` (or agent
    /// `enter_plan_mode`) after a finished episode gets its own timestamped file instead of
    /// overwriting the previous plan. Request-changes does not re-activate and so keeps editing
    /// the current file. The file is renamed to `<slug>-<utc>.md` only when the episode becomes
    /// Inactive, so the path the reminder named stays valid through the planning turn.
    /// Returns the newly installed path.
    pub(crate) fn begin_plan_episode(&mut self) -> PathBuf {
        let path = self.next_episode_path();
        if let Some(dir) = path.parent()
            && let Err(e) = std::fs::create_dir_all(dir)
        {
            tracing::warn!(
                error = %e,
                dir = %dir.display(),
                "failed to create plan episode directory"
            );
        }
        if let Err(e) = std::fs::File::create(&path) {
            tracing::warn!(
                error = %e,
                path = %path.display(),
                "failed to squat plan episode file"
            );
        }
        self.episode_files.push(path.clone());
        self.plan_file_path = path.clone();
        path
    }
    pub fn state(&self) -> PlanModeState {
        self.state
    }
    pub fn is_active(&self) -> bool {
        self.state == PlanModeState::Active
    }
    /// The prompt-mode mirrors follow the tracker, never the other way round.
    /// A restored tracker is the only thing that knows a resumed session is still planning.
    /// Seeding a mirror `Agent` under a restored `Active` makes the first prompt resolve `Agent` and reconcile the plan mode away.
    pub(crate) fn session_prompt_mode(&self) -> PromptMode {
        if self.is_active() {
            PromptMode::Plan
        } else {
            PromptMode::Agent
        }
    }
    pub fn plan_file_path(&self) -> &Path {
        &self.plan_file_path
    }
    /// Used to bypass the permission prompt for plan file edits during plan mode.
    pub(crate) fn should_auto_approve_edit(&self, edit_path: &Path) -> bool {
        self.is_active() && is_plan_file_write(edit_path, &self.plan_file_path)
    }
    /// Whether the next reminder should be the full variant.
    pub(crate) fn should_use_full_reminder(&self) -> bool {
        self.reminder_count.is_multiple_of(2)
    }
    pub(crate) fn has_pending_exit_reminder(&self) -> bool {
        self.pending_exit_reminder
    }
    pub(crate) fn is_reentry(&self) -> bool {
        self.was_previously_active && self.state == PlanModeState::Pending
    }
    /// Client toggled plan mode ON.
    /// Returns true if state actually changed.
    /// Handles re-entry from `ExitPending` by cancelling the deferred exit and returning directly to `Active` (the model already has plan mode context).
    pub(crate) fn enter_pending(&mut self) -> bool {
        match self.state {
            PlanModeState::Inactive => {
                self.state = PlanModeState::Pending;
                self.pending_exit_reminder = false;
                true
            }
            PlanModeState::ExitPending => {
                self.state = PlanModeState::Active;
                self.pending_exit_reminder = false;
                true
            }
            _ => false,
        }
    }
    /// First user prompt while Pending: activate plan mode on a fresh plan file.
    /// Returns true if state actually changed.
    pub fn activate(&mut self) -> bool {
        if self.state != PlanModeState::Pending {
            return false;
        }
        self.begin_plan_episode();
        self.state = PlanModeState::Active;
        self.was_previously_active = true;
        self.reminder_count = 0;
        true
    }
    /// Mid-turn toggle: activate immediately and buffer the pre-rendered activation reminder.
    /// Only valid from `Pending` (a re-entry from `ExitPending` needs no reminder).
    /// The reminder is recorded (alternation counter) at delivery ([`Self::take_pending_activation`]), not here.
    pub(crate) fn activate_mid_turn(&mut self, rendered_reminder: String) -> bool {
        if self.state != PlanModeState::Pending {
            return false;
        }
        self.begin_plan_episode();
        let prior_was_previously_active = self.was_previously_active;
        self.state = PlanModeState::Active;
        self.was_previously_active = true;
        self.reminder_count = 0;
        self.pending_activation = Some(PendingActivation {
            text: rendered_reminder,
            prior_was_previously_active,
        });
        true
    }
    /// Take the buffered mid-turn activation reminder for delivery.
    /// The caller pushes it into the conversation and then calls [`Self::record_reminder_injected`].
    pub(crate) fn take_pending_activation(&mut self) -> Option<String> {
        self.pending_activation.take().map(|p| p.text)
    }
    pub fn has_pending_activation(&self) -> bool {
        self.pending_activation.is_some()
    }
    /// Agent called EnterPlanMode tool: go directly to Active.
    /// Returns true if state actually changed.
    pub(crate) fn activate_from_tool(&mut self) -> bool {
        if self.state != PlanModeState::Inactive {
            return false;
        }
        self.state = PlanModeState::Active;
        self.was_previously_active = true;
        self.reminder_count = 0;
        self.pending_exit_reminder = false;
        true
    }
    /// Does NOT set `pending_exit_reminder`: callers must ensure the model gets an in-context exit signal.
    /// Either push a tool result that states the exit, or explicitly call [`Self::queue_exit_reminder`] when the result text carries no such signal.
    /// A reminder queued here would only drain at the next turn start, arriving a turn late and stale.
    pub(crate) fn deactivate_approved(&mut self) -> bool {
        if self.state != PlanModeState::Active {
            return false;
        }
        self.state = PlanModeState::Inactive;
        self.reminder_count = 0;
        self.awaiting_plan_approval = false;
        self.pending_activation = None;
        self.publish_episode_name();
        true
    }
    /// Client toggled plan mode OFF.
    /// `turn_in_flight`: whether a model turn is currently running.
    pub(crate) fn user_exit(&mut self, turn_in_flight: bool) {
        self.awaiting_plan_approval = false;
        if let Some(pending) = self.pending_activation.take()
            && self.state == PlanModeState::Active
        {
            self.state = PlanModeState::Inactive;
            self.was_previously_active = pending.prior_was_previously_active;
            self.publish_episode_name();
            return;
        }
        match self.state {
            PlanModeState::Pending => {
                self.state = PlanModeState::Inactive;
            }
            PlanModeState::Active => {
                if turn_in_flight {
                    self.state = PlanModeState::ExitPending;
                } else {
                    self.state = PlanModeState::Inactive;
                    self.pending_exit_reminder = true;
                    self.publish_episode_name();
                }
            }
            _ => {}
        }
    }
    /// Current turn completed while in ExitPending.
    pub(crate) fn complete_deferred_exit(&mut self) {
        if self.state != PlanModeState::ExitPending {
            return;
        }
        self.state = PlanModeState::Inactive;
        self.pending_exit_reminder = true;
        self.publish_episode_name();
    }

    /// Rename the current episode file to `<slug>-<utc>.md` from its H1, if it has one.
    ///
    /// Only safe once the episode is Inactive: the activation reminder named the UTC path, and
    /// in-flight writes still target it. Request-changes stays Active and so keeps that path.
    /// `episode_files` keeps the original UTC allocation so a same-second next episode still
    /// collides in memory even after this file has moved.
    fn publish_episode_name(&mut self) {
        self.plan_file_path = publish_plan_episode(&self.plan_file_path);
    }
    /// Queue the one-shot exit reminder for the next turn.
    /// For exit paths whose tool result carries no exit signal (the compat harness).
    /// Policy and rationale live on the bridge's `queue_exit_reminder_on_approved_exit` flag.
    pub(crate) fn queue_exit_reminder(&mut self) {
        self.pending_exit_reminder = true;
    }
    /// Called after injecting a per-turn reminder.
    pub(crate) fn record_reminder_injected(&mut self) {
        self.reminder_count += 1;
    }
    /// Called after injecting the exit reminder.
    pub(crate) fn clear_pending_exit_reminder(&mut self) {
        self.pending_exit_reminder = false;
    }
    /// Called after compaction. Resets reminder counter so next injection is the full variant.
    pub(crate) fn reset_after_compaction(&mut self) {
        if self.state == PlanModeState::Active {
            self.reminder_count = 0;
            self.pending_activation = None;
        }
    }
}
/// Returns a MiniJinja template string with `${{ tools.by_kind.X }}` and `${{ plan_path }}` / `${{ plan_has_content }}` placeholders.
/// The caller must render it via `TemplateRenderer::render_with_extra()` passing.
/// ```json { "plan_path": "/path/to/plan.md", "plan_has_content": true } ```.
pub(crate) fn plan_mode_reminder_full_template() -> &'static str {
    "\
Plan mode is active. Do not make any edits or writes to the system.

## Plan File:
${%- if plan_has_content %}
A plan file exists at ${{ plan_path }}. \
You can read it and make edits using the ${{ tools.by_kind.edit }} tool.
${%- else %}
No plan written yet. Write your plan to ${{ plan_path }} \
using the ${{ tools.by_kind.edit }} tool. \
Start the file with `# Plan: <short title>` (5–10 words, no file paths).
${%- endif %}

You should build your plan by writing to or editing this file. \
Note that this is the only file you are allowed to edit.

Your turn should only end with either ${{ tools.by_kind.ask_user }} to clarify \
requirements or ${{ tools.by_kind.exit_plan }} to present your plan to the user."
}
/// Static string for alternating turns (when `reminder_count` is odd) to save tokens.
/// No MiniJinja placeholders: plan path and tool names are only in the full reminder.
pub(crate) fn plan_mode_reminder_sparse_template() -> &'static str {
    "Plan mode is still active. Do not make any edits or writes to the system except for the plan file."
}
/// Returns a MiniJinja template string injected when entering plan mode for the second or later time in the same session.
/// Render via `TemplateRenderer::render_with_extra()` with `{ "plan_path": "..." }`.
/// The path is the NEW episode's file (allocation happens on activation), so the copy must not
/// claim a previous plan exists: doing so makes the model read the old plan back into context.
pub(crate) fn plan_mode_reentry_reminder_template() -> &'static str {
    "\
## Returning to Plan Mode

You are entering plan mode again. A new plan file has been opened at ${{ plan_path }} \
for this planning session and it starts empty. \
Start the file with `# Plan: <short title>` (5–10 words, no file paths).

Your turn should only end with either ${{ tools.by_kind.ask_user }} to clarify requirements or ${{ tools.by_kind.exit_plan }} to present your plan to the user."
}

/// `<session_dir>/plan.md`: the single plan file used before per-episode allocation, and the
/// fallback for snapshots that predate it.
pub(crate) fn legacy_plan_file_path(session_dir: &Path) -> PathBuf {
    session_dir.join("plan.md")
}

/// The persisted snapshot for a session directory, for readers that are not holding a tracker
/// (the plan-file listing extension). A missing or malformed file is `None`, and callers fall back
/// to the legacy `plan.md` default exactly as [`restore_plan_file_path`] does.
pub(crate) fn read_plan_mode_snapshot(session_dir: &Path) -> Option<PlanModeSnapshot> {
    let text =
        std::fs::read_to_string(session_dir.join(crate::session::storage::PLAN_MODE_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Resolve a persisted `plan_file` against the session directory.
/// Falls back to [`legacy_plan_file_path`] for `None`, empty, or unsafe values: an absolute path
/// or any `..` component would escape the session directory the edit gate and ACP allow-path are
/// anchored to.
pub(crate) fn restore_plan_file_path(session_dir: &Path, plan_file: Option<&str>) -> PathBuf {
    use std::path::Component;
    let fallback = legacy_plan_file_path(session_dir);
    let Some(plan_file) = plan_file else {
        return fallback;
    };
    let relative = Path::new(plan_file);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return fallback;
    }
    session_dir.join(relative)
}

/// First markdown H1, with a leading `Plan:` stripped. `None` when the file has no heading.
pub(crate) fn plan_heading(body: &str) -> Option<String> {
    body.lines()
        .map(str::trim_start)
        .find(|line| line.starts_with("# ") && line.len() > 2)
        .map(|line| {
            let title = line["# ".len()..].trim();
            title
                .strip_prefix("Plan:")
                .map(str::trim)
                .filter(|rest| !rest.is_empty())
                .unwrap_or(title)
                .to_owned()
        })
        .filter(|title| !title.is_empty())
}

/// Chip/list title: the H1, or [`UNTITLED_PLAN`] when the file is empty or has no heading.
pub(crate) fn plan_display_title(body: &str) -> String {
    plan_heading(body).unwrap_or_else(|| UNTITLED_PLAN.to_string())
}

/// Kebab-case filename prefix from a plan heading: paths, parentheticals, and punctuation dropped,
/// then truncated at a hyphen so it stays a readable prefix.
pub(crate) fn plan_file_slug(title: &str) -> String {
    let mut stripped = String::with_capacity(title.len());
    let mut depth = 0i32;
    for c in title.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = (depth - 1).max(0),
            _ if depth == 0 => stripped.push(c),
            _ => {}
        }
    }
    let mut slug = String::new();
    let mut last_dash = false;
    for token in stripped.split_whitespace() {
        if is_pathish_token(token) {
            continue;
        }
        for c in token.chars() {
            if c.is_ascii_alphanumeric() {
                slug.push(c.to_ascii_lowercase());
                last_dash = false;
            } else if !slug.is_empty() && !last_dash {
                slug.push('-');
                last_dash = true;
            }
        }
        if !slug.is_empty() && !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    truncate_slug(&slug, PLAN_SLUG_MAX)
}

/// Allocate the next timestamp identity for a plan episode without changing plan-mode state.
/// Existing published names count because [`episode_stamp`] reads the identity from the suffix.
pub(crate) fn next_episode_path(session_dir: &Path) -> PathBuf {
    next_episode_path_with_extra(session_dir, std::iter::empty::<&PathBuf>())
}

fn next_episode_path_with_extra<'a>(
    session_dir: &Path,
    extra: impl IntoIterator<Item = &'a PathBuf>,
) -> PathBuf {
    let plans_dir = session_dir.join(crate::session::storage::PLANS_DIR);
    let stamp = chrono::Utc::now().format("%Y-%m-%dT%H-%M-%SZ").to_string();
    let mut taken = HashSet::new();
    let mut add = |path: &Path| {
        if let Some(name) = path.file_name().and_then(|n| n.to_str())
            && let Some(id) = episode_stamp(name)
        {
            taken.insert(id.to_string());
        }
    };
    for path in extra {
        add(path);
    }
    if let Ok(entries) = std::fs::read_dir(&plans_dir) {
        for entry in entries.flatten() {
            add(&entry.path());
        }
    }
    let mut identity = stamp.clone();
    let mut suffix = 2u32;
    while taken.contains(&identity) {
        identity = format!("{stamp}-{suffix}");
        suffix += 1;
    }
    plans_dir.join(format!("{identity}.md"))
}

/// Publish a completed episode from `<utc>.md` to `<h1-slug>-<utc>.md`.
/// Missing headings, already-published paths, and I/O failures leave the original path in place.
pub(crate) fn publish_plan_episode(path: &Path) -> PathBuf {
    let Some(plans_dir) = path.parent() else {
        return path.to_path_buf();
    };
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return path.to_path_buf();
    };
    let Some(stamp) = episode_stamp(name) else {
        return path.to_path_buf();
    };
    let Ok(body) = std::fs::read_to_string(path) else {
        return path.to_path_buf();
    };
    let Some(heading) = plan_heading(&body) else {
        return path.to_path_buf();
    };
    let slug = plan_file_slug(&heading);
    if slug.is_empty() || name != format!("{stamp}.md") {
        return path.to_path_buf();
    }
    let dest = published_episode_path(plans_dir, path, &slug, stamp);
    if dest == path {
        return path.to_path_buf();
    }
    match std::fs::rename(path, &dest) {
        Ok(()) => dest,
        Err(e) => {
            tracing::warn!(
                error = %e,
                from = %path.display(),
                to = %dest.display(),
                "failed to publish plan episode name"
            );
            path.to_path_buf()
        }
    }
}

fn is_pathish_token(token: &str) -> bool {
    token.contains('/')
        || token.contains('\\')
        || token.contains("://")
        || (token.len() >= 2
            && token.as_bytes()[1] == b':'
            && token.as_bytes()[0].is_ascii_alphabetic())
}

fn truncate_slug(slug: &str, max: usize) -> String {
    if slug.len() <= max {
        return slug.to_string();
    }
    let cut = &slug[..max];
    match cut.rfind('-') {
        Some(i) if i > 0 => cut[..i].to_string(),
        _ => cut.to_string(),
    }
}

/// UTC identity at the end of a plan filename: `2026-09-19T06-51-34Z` or `2026-09-19T06-51-34Z-2`.
pub(crate) fn episode_stamp(filename: &str) -> Option<&str> {
    let stem = filename.strip_suffix(".md")?;
    let z = stem.rfind('Z')?;
    if z + 1 < UTC_STAMP_LEN {
        return None;
    }
    let start = z + 1 - UTC_STAMP_LEN;
    if !is_utc_stamp(&stem[start..=z]) {
        return None;
    }
    let after = &stem[z + 1..];
    if after.is_empty() {
        return Some(&stem[start..=z]);
    }
    let digits = after.strip_prefix('-')?;
    if !digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit()) {
        return Some(&stem[start..]);
    }
    None
}

fn is_utc_stamp(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == UTC_STAMP_LEN
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b'-'
        && b[16] == b'-'
        && b[19] == b'Z'
        && b.iter()
            .enumerate()
            .all(|(i, c)| matches!(i, 4 | 7 | 10 | 13 | 16 | 19) || c.is_ascii_digit())
}

/// Newest-first list key: stamped files before unstamped (legacy `plan.md`), later UTC first,
/// then the same-second suffix, then the name.
pub(crate) fn episode_list_sort_key(path: &Path) -> (bool, String, u32, String) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    match episode_stamp(&name) {
        Some(id) => {
            let (datetime, suffix) = split_stamp_suffix(id);
            (true, datetime, suffix, name)
        }
        None => (false, String::new(), 0, name),
    }
}

fn split_stamp_suffix(id: &str) -> (String, u32) {
    if let Some((datetime, rest)) = id.rsplit_once('-')
        && datetime.ends_with('Z')
        && let Ok(n) = rest.parse::<u32>()
    {
        return (datetime.to_string(), n);
    }
    (id.to_string(), 0)
}

fn published_episode_path(plans_dir: &Path, current: &Path, slug: &str, stamp: &str) -> PathBuf {
    let mut candidate = plans_dir.join(format!("{slug}-{stamp}.md"));
    let mut n = 2u32;
    while candidate != current && candidate.exists() {
        candidate = plans_dir.join(format!("{slug}-{n}-{stamp}.md"));
        n += 1;
    }
    candidate
}

/// Rejection message for an edit outside the plan file while plan mode is active.
/// Returned as the tool result so the model knows the only editable path.
/// Render via `TemplateRenderer::render_with_extra()` with `{ "plan_path": "..." }`.
pub(crate) fn plan_mode_edit_rejected_template() -> &'static str {
    "Rejected: file edits are not allowed in plan mode - the only editable file is the plan file (${{ plan_path }})."
}
/// Returns a MiniJinja template string injected once after exiting plan mode (user-initiated exit via toggle).
/// Contains no placeholders.
pub(crate) fn plan_mode_exit_reminder_template() -> &'static str {
    "\
You have exited plan mode. You can now make edits, run tools, and take actions."
}
/// `target_path` is the absolute path the tool is trying to write to.
/// `plan_file` is the absolute path from [`PlanModeTracker::plan_file_path`].
pub(crate) fn is_plan_file_write(target_path: &Path, plan_file: &Path) -> bool {
    target_path == plan_file
}
/// Whether the path's final component ends with a markdown suffix (case-insensitive).
/// Suffixes align with client / workspace `MARKDOWN_SUFFIXES`: `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdx`.
/// In plan mode the shell rejects `Write` and `StrReplace` when this is false.
pub(crate) fn is_markdown_file_path(path: &Path) -> bool {
    const MARKDOWN_SUFFIXES: &[&str] = &[".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdx"];
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let bytes = name.as_bytes();
    MARKDOWN_SUFFIXES.iter().any(|suffix| {
        let suffix = suffix.as_bytes();
        let Some(start) = bytes.len().checked_sub(suffix.len()) else {
            return false;
        };
        bytes
            .get(start..)
            .is_some_and(|tail| tail.eq_ignore_ascii_case(suffix))
    })
}
/// An empty pre-seeded plan file (created by enter_plan_mode) reports false so the reminder still tells the model to write its plan.
/// Divergence: uses `metadata().len() > 0` (cheap per-turn stat), so a whitespace-only file counts as content here.
/// `exit_plan_mode` trims and treats such a file as empty; harmless because the seed is always `b""`.
pub(crate) async fn plan_file_has_content(path: &std::path::Path) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}
/// The prompt mode sent by the client in `_meta.mode`.
/// Determines whether the prompt expects tool use / file edits (`Agent`) or is read-only (`Ask` / `Plan`).
/// Used to decide whether a forked session needs worktrees or can run in read-only mode.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize, strum::Display,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum PromptMode {
    /// Full agent with tool use and file edits.
    #[default]
    Agent,
    /// Question-answering only, no tool use.
    Ask,
    /// Planning/reasoning only, no tool use.
    Plan,
}
impl PromptMode {
    /// Parse from the `_meta.mode` string. Unknown values default to `Agent`.
    pub(crate) fn from_meta_str(s: &str) -> Self {
        match s {
            "ask" => Self::Ask,
            "plan" => Self::Plan,
            _ => Self::Agent,
        }
    }
    /// Whether this mode is read-only (no file mutations expected).
    pub fn is_read_only(self) -> bool {
        matches!(self, Self::Ask | Self::Plan)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    /// A per-test session directory. `activate()` allocates a plan file under it, so two tests
    /// sharing a directory (or a clock second) could collide.
    fn test_tracker() -> PlanModeTracker {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cook-plan-mode-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        PlanModeTracker::new(dir)
    }
    #[test]
    fn user_initiated_lifecycle() {
        let mut t = test_tracker();
        assert_eq!(t.state(), PlanModeState::Inactive);
        assert!(t.enter_pending());
        assert_eq!(t.state(), PlanModeState::Pending);
        assert!(t.activate());
        assert_eq!(t.state(), PlanModeState::Active);
        assert!(t.deactivate_approved());
        assert_eq!(t.state(), PlanModeState::Inactive);
    }
    #[test]
    fn user_exit_while_turn_in_flight() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.user_exit(true);
        assert_eq!(t.state(), PlanModeState::ExitPending);
        t.complete_deferred_exit();
        assert_eq!(t.state(), PlanModeState::Inactive);
        assert!(t.has_pending_exit_reminder());
    }
    #[test]
    fn pending_cancel_is_clean() {
        let mut t = test_tracker();
        t.enter_pending();
        t.user_exit(false);
        assert_eq!(t.state(), PlanModeState::Inactive);
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn agent_initiated_skips_pending() {
        let mut t = test_tracker();
        assert!(t.activate_from_tool());
        assert_eq!(t.state(), PlanModeState::Active);
    }
    #[test]
    fn reentry_detected() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.deactivate_approved();
        t.enter_pending();
        assert!(t.is_reentry());
    }
    #[test]
    fn reminder_alternation() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        assert!(t.should_use_full_reminder());
        t.record_reminder_injected();
        assert!(!t.should_use_full_reminder());
        t.record_reminder_injected();
        assert!(t.should_use_full_reminder());
    }
    #[test]
    fn plan_file_in_session_dir() {
        let t = PlanModeTracker::new(PathBuf::from("/home/user/.grok/sessions/proj/abc-123"));
        assert_eq!(
            t.plan_file_path(),
            Path::new("/home/user/.grok/sessions/proj/abc-123/plan.md")
        );
    }
    /// A session that never plans must not scatter empty `plans/` files.
    #[test]
    fn pending_does_not_allocate_a_plan_file() {
        let mut t = test_tracker();
        let legacy = t.plan_file_path().to_path_buf();
        assert!(t.enter_pending());
        assert_eq!(t.plan_file_path(), legacy);
        assert!(t.episode_files.is_empty());
        assert!(!t.enter_pending(), "already pending");
        assert!(t.episode_files.is_empty());
    }
    #[test]
    fn first_episode_allocates_a_timestamped_file_under_plans() {
        let mut t = test_tracker();
        t.enter_pending();
        assert!(t.activate());
        let path = t.plan_file_path().to_path_buf();
        assert_eq!(path.parent(), Some(t.session_dir.join("plans").as_path()));
        assert_eq!(path.extension().and_then(|e| e.to_str()), Some("md"));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.ends_with("Z.md") && name.starts_with("20"),
            "expected a UTC timestamp filename, got {name}"
        );
        assert!(path.parent().unwrap().is_dir(), "plans/ must exist on disk");
    }
    /// The whole point of the change: episode two must not reuse (or truncate) episode one's file.
    #[test]
    fn second_episode_allocates_a_different_file_and_keeps_the_first() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let first = t.plan_file_path().to_path_buf();
        std::fs::write(&first, "# first plan\n").unwrap();
        assert!(t.deactivate_approved());
        let published = t.plan_file_path().to_path_buf();
        assert_ne!(
            published, first,
            "Inactive publishes the H1 into the filename"
        );
        assert!(!first.exists());

        t.enter_pending();
        t.activate();
        let second = t.plan_file_path().to_path_buf();

        assert_ne!(published, second);
        assert_eq!(
            std::fs::read_to_string(&published).unwrap(),
            "# first plan\n"
        );
        assert_eq!(t.episode_files.len(), 2);
    }
    /// Two episodes inside one clock second still get distinct paths: the previous allocation may
    /// not have been written to disk yet.
    #[test]
    fn same_second_episodes_do_not_collide() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let first = t.plan_file_path().to_path_buf();
        t.deactivate_approved();
        t.enter_pending();
        t.activate();
        assert_ne!(first, t.plan_file_path());
    }
    /// Mid-turn activation installs the path its caller already rendered the reminder with.
    #[test]
    fn midturn_activation_installs_the_path_it_announced() {
        let mut t = test_tracker();
        t.enter_pending();
        let announced = t.next_episode_path();
        assert!(t.activate_mid_turn("reminder text".into()));
        assert_eq!(t.plan_file_path(), announced);
    }
    /// Toggling off then back on while the turn is in flight is the same episode, so the file stays.
    #[test]
    fn reenter_from_exit_pending_keeps_the_same_file() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let active = t.plan_file_path().to_path_buf();
        t.user_exit(true);
        assert!(t.enter_pending());
        assert_eq!(t.plan_file_path(), active);
        assert_eq!(t.episode_files.len(), 1);
    }
    /// Request-changes keeps the episode `Active` and never re-activates, so it keeps its file.
    #[test]
    fn activating_an_active_episode_does_not_rotate_the_file() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let path = t.plan_file_path().to_path_buf();
        assert!(!t.activate());
        assert!(!t.activate_mid_turn("dup".into()));
        assert_eq!(t.plan_file_path(), path);
        assert_eq!(t.episode_files.len(), 1);
    }
    /// History still contains the previous episode's write path, so only the current file is writable.
    #[test]
    fn earlier_episode_file_is_not_writable() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let first = t.plan_file_path().to_path_buf();
        t.deactivate_approved();
        t.enter_pending();
        t.activate();
        assert!(t.should_auto_approve_edit(t.plan_file_path()));
        assert!(!t.should_auto_approve_edit(&first));
    }
    #[test]
    fn snapshot_round_trips_the_episode_file() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let expected = t.plan_file_path().to_path_buf();
        let snap = t.snapshot();
        assert!(
            snap.plan_file
                .as_deref()
                .unwrap_or_default()
                .starts_with("plans/"),
            "{:?}",
            snap.plan_file
        );

        let restored = PlanModeTracker::from_snapshot(t.session_dir.clone(), snap);
        assert_eq!(restored.plan_file_path(), expected);
    }
    #[test]
    fn snapshot_without_plan_file_restores_the_legacy_path() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let mut snap = t.snapshot();
        snap.plan_file = None;
        let restored = PlanModeTracker::from_snapshot(t.session_dir.clone(), snap);
        assert_eq!(restored.plan_file_path(), t.session_dir.join("plan.md"));
    }

    #[test]
    fn plan_heading_strips_the_plan_prefix() {
        assert_eq!(plan_heading("# Plan: Ship it").as_deref(), Some("Ship it"));
        assert_eq!(
            plan_heading("  # Clean all files").as_deref(),
            Some("Clean all files")
        );
        assert_eq!(plan_heading("## Plan: not an h1\n"), None);
        assert_eq!(plan_heading(""), None);
    }

    #[test]
    fn plan_file_slug_drops_paths_parens_and_truncates() {
        assert_eq!(
            plan_file_slug("Clean (delete) all files in /Users/thanhbm/Projects/hello-world"),
            "clean-all-files-in"
        );
        assert_eq!(
            plan_file_slug("Clean directory and create PixiJS v5 Hello World"),
            "clean-directory-and-create-pixijs-v5"
        );
        assert_eq!(plan_file_slug("C:\\Users\\me\\plan"), "");
        assert_eq!(plan_file_slug(""), "");
    }

    #[test]
    fn episode_stamp_reads_utc_from_slug_and_plain_names() {
        assert_eq!(
            episode_stamp("2026-09-19T06-51-34Z.md"),
            Some("2026-09-19T06-51-34Z")
        );
        assert_eq!(
            episode_stamp("clean-all-files-2026-09-19T06-51-34Z.md"),
            Some("2026-09-19T06-51-34Z")
        );
        assert_eq!(
            episode_stamp("2026-09-19T06-51-34Z-2.md"),
            Some("2026-09-19T06-51-34Z-2")
        );
        assert_eq!(
            episode_stamp("pixijs-2-2026-09-19T06-51-34Z.md"),
            Some("2026-09-19T06-51-34Z")
        );
        assert_eq!(episode_stamp("plan.md"), None);
    }

    #[test]
    fn deactivate_publishes_the_h1_into_the_filename() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let allocated = t.plan_file_path().to_path_buf();
        let stamp = episode_stamp(allocated.file_name().unwrap().to_str().unwrap()).unwrap();
        std::fs::write(
            &allocated,
            "# Plan: Clean (delete) all files in /Users/thanhbm/Projects/hello-world\n",
        )
        .unwrap();
        assert!(t.deactivate_approved());
        let published = t.plan_file_path().to_path_buf();
        assert_eq!(
            published.file_name().unwrap().to_str().unwrap(),
            format!("clean-all-files-in-{stamp}.md")
        );
        assert!(!allocated.exists());
        assert!(published.exists());
        assert_eq!(
            t.snapshot().plan_file.as_deref(),
            Some(format!("plans/clean-all-files-in-{stamp}.md").as_str())
        );
    }

    #[test]
    fn deactivate_keeps_a_utc_name_when_there_is_no_heading() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let allocated = t.plan_file_path().to_path_buf();
        std::fs::write(&allocated, "no heading here\n").unwrap();
        assert!(t.deactivate_approved());
        assert_eq!(t.plan_file_path(), allocated);
    }

    #[test]
    fn deactivate_does_not_rename_the_legacy_plan_file() {
        let mut t = test_tracker();
        let legacy = t.plan_file_path().to_path_buf();
        std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::fs::write(&legacy, "# Plan: Legacy\n").unwrap();
        t.enter_pending();
        t.user_exit(false);
        assert_eq!(t.plan_file_path(), legacy);
        assert!(legacy.exists());
    }

    #[test]
    fn published_name_collision_inserts_a_counter_before_the_stamp() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let allocated = t.plan_file_path().to_path_buf();
        let stamp = episode_stamp(allocated.file_name().unwrap().to_str().unwrap()).unwrap();
        let taken = t
            .session_dir
            .join(crate::session::storage::PLANS_DIR)
            .join(format!("ship-it-{stamp}.md"));
        std::fs::write(&taken, "# other\n").unwrap();
        std::fs::write(&allocated, "# Plan: Ship it\n").unwrap();
        assert!(t.deactivate_approved());
        assert_eq!(
            t.plan_file_path().file_name().unwrap().to_str().unwrap(),
            format!("ship-it-2-{stamp}.md")
        );
    }

    #[test]
    fn next_episode_skips_a_stamp_already_published_under_a_slug() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let first = t.plan_file_path().to_path_buf();
        std::fs::write(&first, "# Plan: Alpha\n").unwrap();
        t.deactivate_approved();
        let published = t.plan_file_path().to_path_buf();
        assert!(
            published
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("alpha-")
        );

        t.enter_pending();
        t.activate();
        let second = t.plan_file_path().to_path_buf();
        assert_ne!(second, published);
        let second_name = second.file_name().unwrap().to_str().unwrap();
        assert!(
            second_name.ends_with("Z.md")
                || second_name.contains("Z-2.md")
                || second_name.contains("-2.md"),
            "second episode must not reuse the published file, got {second_name}"
        );
    }

    #[test]
    fn user_exit_while_idle_publishes_the_episode_name() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let allocated = t.plan_file_path().to_path_buf();
        let stamp = episode_stamp(allocated.file_name().unwrap().to_str().unwrap()).unwrap();
        std::fs::write(&allocated, "# Plan: Idle exit\n").unwrap();
        t.user_exit(false);
        assert_eq!(
            t.plan_file_path().file_name().unwrap().to_str().unwrap(),
            format!("idle-exit-{stamp}.md")
        );
    }

    #[test]
    fn complete_deferred_exit_publishes_the_episode_name() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let allocated = t.plan_file_path().to_path_buf();
        let stamp = episode_stamp(allocated.file_name().unwrap().to_str().unwrap()).unwrap();
        std::fs::write(&allocated, "# Plan: Deferred\n").unwrap();
        t.user_exit(true);
        assert_eq!(
            t.plan_file_path(),
            allocated,
            "in-flight exit must not rename"
        );
        t.complete_deferred_exit();
        assert_eq!(
            t.plan_file_path().file_name().unwrap().to_str().unwrap(),
            format!("deferred-{stamp}.md")
        );
    }
    #[test]
    fn unsafe_snapshot_plan_file_falls_back_to_the_legacy_path() {
        let dir = PathBuf::from("/tmp/cook-plan-mode-unsafe");
        for value in [
            "",
            "../outside.md",
            "/abs/outside.md",
            "plans/../../x.md",
            "./",
        ] {
            assert_eq!(
                restore_plan_file_path(&dir, Some(value)),
                dir.join("plan.md"),
                "value {value:?} must not escape the session directory"
            );
        }
    }
    #[test]
    fn safe_snapshot_plan_file_restores_under_the_session_dir() {
        let dir = PathBuf::from("/tmp/cook-plan-mode-safe");
        assert_eq!(
            restore_plan_file_path(&dir, Some("plans/2026-09-19T14-30-22Z.md")),
            dir.join("plans/2026-09-19T14-30-22Z.md")
        );
    }
    #[test]
    fn compaction_resets_to_full_reminder() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.record_reminder_injected();
        t.reset_after_compaction();
        assert!(t.should_use_full_reminder());
    }
    #[test]
    fn midturn_activation_buffers_and_delivers_exactly_once() {
        let mut t = test_tracker();
        t.enter_pending();
        assert!(t.activate_mid_turn("reminder text".into()));
        assert_eq!(t.state(), PlanModeState::Active);
        assert!(t.has_pending_activation());
        assert!(t.should_use_full_reminder());
        assert_eq!(
            t.take_pending_activation().as_deref(),
            Some("reminder text")
        );
        assert!(!t.has_pending_activation());
        t.record_reminder_injected();
        assert!(!t.should_use_full_reminder());
        assert_eq!(t.take_pending_activation(), None);
        assert_eq!(t.take_pending_activation(), None);
    }
    #[test]
    fn midturn_activation_requires_pending() {
        let mut t = test_tracker();
        assert!(!t.activate_mid_turn("x".into()));
        t.enter_pending();
        t.activate();
        assert!(!t.activate_mid_turn("dup".into()));
        assert!(!t.has_pending_activation());
        t.user_exit(true);
        assert!(!t.activate_mid_turn("x".into()));
        assert!(!t.has_pending_activation());
    }
    #[test]
    fn user_exit_withdraws_undelivered_activation() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate_mid_turn("reminder text".into());
        t.user_exit(true);
        assert_eq!(t.state(), PlanModeState::Inactive);
        assert!(!t.has_pending_activation());
        assert!(!t.has_pending_exit_reminder());
        t.enter_pending();
        assert!(!t.is_reentry());
    }
    #[test]
    fn user_exit_after_delivery_defers_exit_normally() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate_mid_turn("reminder text".into());
        t.take_pending_activation();
        t.record_reminder_injected();
        t.user_exit(true);
        assert_eq!(t.state(), PlanModeState::ExitPending);
    }
    #[test]
    fn withdrawal_preserves_real_reentry_flag() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.deactivate_approved();
        t.enter_pending();
        t.activate_mid_turn("reminder text".into());
        t.user_exit(true);
        t.enter_pending();
        assert!(t.is_reentry());
    }
    #[test]
    fn compaction_drops_undelivered_activation() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate_mid_turn("reminder text".into());
        t.reset_after_compaction();
        assert!(!t.has_pending_activation());
        assert_eq!(t.state(), PlanModeState::Active);
    }
    use std::collections::HashMap;
    use xai_grok_tools::types::template_renderer::TemplateRenderer;
    use xai_grok_tools::types::tool::ToolKind;
    /// Build a test TemplateRenderer with standard Grok Build tool mappings.
    fn test_renderer() -> TemplateRenderer {
        let tools: HashMap<ToolKind, String> = [
            (ToolKind::Edit, "search_replace".to_owned()),
            (ToolKind::Read, "read_file".to_owned()),
            (ToolKind::List, "list_dir".to_owned()),
            (ToolKind::Search, "grep".to_owned()),
            (ToolKind::AskUser, "ask_user_question".to_owned()),
            (ToolKind::ExitPlan, "exit_plan_mode".to_owned()),
        ]
        .into();
        TemplateRenderer::new(tools, HashMap::new())
    }
    /// Build a TemplateRenderer with custom (non-default) tool names.
    fn custom_renderer() -> TemplateRenderer {
        let tools: HashMap<ToolKind, String> = [
            (ToolKind::Edit, "EditFile".to_owned()),
            (ToolKind::Read, "ReadFile".to_owned()),
            (ToolKind::List, "ListFiles".to_owned()),
            (ToolKind::Search, "SearchContent".to_owned()),
            (ToolKind::AskUser, "AskUser".to_owned()),
            (ToolKind::ExitPlan, "FinishPlan".to_owned()),
        ]
        .into();
        TemplateRenderer::new(tools, HashMap::new())
    }
    fn render(
        renderer: &TemplateRenderer,
        template: &str,
        plan_path: &str,
        plan_has_content: bool,
    ) -> String {
        let extra = serde_json::json!({
            "plan_path": plan_path,
            "plan_has_content": plan_has_content,
        });
        renderer.render_with_extra(template, &extra).unwrap()
    }
    #[test]
    fn full_reminder_interpolates_plan_path_and_edit_tool() {
        let r = test_renderer();
        let with_plan = render(
            &r,
            plan_mode_reminder_full_template(),
            "/tmp/session/plan.md",
            true,
        );
        let without_plan = render(
            &r,
            plan_mode_reminder_full_template(),
            "/tmp/session/plan.md",
            false,
        );
        assert_ne!(
            with_plan, without_plan,
            "plan_has_content must change the compiled reminder"
        );
        for text in [&with_plan, &without_plan] {
            assert!(text.contains("/tmp/session/plan.md"));
            assert!(text.contains("search_replace"));
            assert!(!text.contains("${{"));
        }
        assert!(
            without_plan.contains("# Plan:"),
            "empty-plan reminder must tell the model to start with a short H1: {without_plan}"
        );
    }
    #[test]
    fn full_reminder_resolves_all_tool_names() {
        let r = test_renderer();
        let text = render(&r, plan_mode_reminder_full_template(), "/tmp/plan.md", true);
        assert!(text.contains("search_replace"));
        assert!(text.contains("ask_user_question"));
        assert!(text.contains("exit_plan_mode"));
        assert!(
            !text.contains("${{"),
            "unresolved template placeholder found"
        );
    }
    #[test]
    fn full_reminder_with_custom_tool_names() {
        let r = custom_renderer();
        let text = render(&r, plan_mode_reminder_full_template(), "/tmp/plan.md", true);
        assert!(text.contains("EditFile"));
        assert!(text.contains("AskUser"));
        assert!(text.contains("FinishPlan"));
        assert!(!text.contains("search_replace"));
        assert!(!text.contains("ask_user_question"));
        assert!(!text.contains("exit_plan_mode"));
    }
    #[test]
    fn sparse_reminder_does_not_interpolate() {
        let r = test_renderer();
        let text = render(
            &r,
            plan_mode_reminder_sparse_template(),
            "/tmp/plan.md",
            false,
        );
        assert!(!text.contains("/tmp/plan.md"));
        assert!(!text.contains("exit_plan_mode"));
        assert!(!text.contains("${{"));
    }
    #[test]
    fn sparse_reminder_ignores_custom_tool_names() {
        let r = custom_renderer();
        let text = render(
            &r,
            plan_mode_reminder_sparse_template(),
            "/tmp/plan.md",
            false,
        );
        assert!(!text.contains("AskUser"));
        assert!(!text.contains("FinishPlan"));
        assert!(!text.contains("${{"));
    }
    #[test]
    fn reentry_reminder_renders() {
        let r = test_renderer();
        let text = render(
            &r,
            plan_mode_reentry_reminder_template(),
            "/tmp/plan.md",
            false,
        );
        assert!(text.contains("/tmp/plan.md"));
        assert!(text.contains("exit_plan_mode"));
        assert!(text.contains("ask_user_question"));
        assert!(!text.contains("${{"));
    }
    #[test]
    fn reentry_reminder_with_custom_names() {
        let r = custom_renderer();
        let text = render(
            &r,
            plan_mode_reentry_reminder_template(),
            "/tmp/plan.md",
            false,
        );
        assert!(text.contains("FinishPlan"));
        assert!(text.contains("AskUser"));
        assert!(!text.contains("exit_plan_mode"));
        assert!(!text.contains("ask_user_question"));
    }
    /// Reentry allocates a fresh file, so the reminder must not send the model back to the old plan.
    #[test]
    fn reentry_reminder_does_not_claim_a_previous_plan_exists() {
        let r = test_renderer();
        let text = render(
            &r,
            plan_mode_reentry_reminder_template(),
            "/s/plans/2026-09-19T14-30-22Z.md",
            false,
        );
        assert!(text.contains("/s/plans/2026-09-19T14-30-22Z.md"));
        assert!(!text.contains("exists at"));
        assert!(!text.contains("previous planning session"));
        assert!(!text.contains("from your previous"));
        assert!(text.contains("starts empty"));
        assert!(text.contains("# Plan:"));
    }
    /// The rendered reentry path is the NEW episode's file, never the one just finished.
    #[test]
    fn reentry_render_names_only_the_new_episode_file() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let previous = t.plan_file_path().to_path_buf();
        t.deactivate_approved();

        t.enter_pending();
        assert!(t.is_reentry());
        let next = t.next_episode_path();
        t.activate();
        assert_eq!(t.plan_file_path(), next);

        let r = test_renderer();
        let text = render(
            &r,
            plan_mode_reentry_reminder_template(),
            &next.display().to_string(),
            false,
        );
        assert!(text.contains(next.to_string_lossy().as_ref()));
        assert!(!text.contains(previous.to_string_lossy().as_ref()));
    }
    #[test]
    fn exit_reminder_renders() {
        let r = test_renderer();
        let text = render(
            &r,
            plan_mode_exit_reminder_template(),
            "/tmp/plan.md",
            false,
        );
        assert!(!text.contains("/tmp/plan.md"));
        assert!(!text.contains("${{"));
    }
    #[test]
    fn edit_rejected_template_renders() {
        let r = test_renderer();
        let text = render(
            &r,
            plan_mode_edit_rejected_template(),
            "/tmp/session/plan.md",
            false,
        );
        assert!(text.contains("/tmp/session/plan.md"));
        assert!(!text.contains("${{"));
    }
    #[test]
    fn templates_are_static_with_no_hardcoded_tool_names() {
        let hardcoded_names = [
            "search_replace",
            "read_file",
            "list_dir",
            "grep",
            "ask_user_question",
            "exit_plan_mode",
        ];
        let templates = [
            plan_mode_reminder_full_template(),
            plan_mode_reminder_sparse_template(),
            plan_mode_reentry_reminder_template(),
            plan_mode_exit_reminder_template(),
            plan_mode_edit_rejected_template(),
        ];
        for template in &templates {
            for name in &hardcoded_names {
                assert!(
                    !template.contains(name),
                    "template contains hardcoded tool name '{name}': {template:.80}..."
                );
            }
        }
    }
    #[test]
    fn is_plan_file_write_exact_match() {
        let plan = Path::new("/home/user/.grok/sessions/proj/abc/plan.md");
        let target = Path::new("/home/user/.grok/sessions/proj/abc/plan.md");
        assert!(is_plan_file_write(target, plan));
    }
    #[test]
    fn is_plan_file_write_different_path() {
        let plan = Path::new("/home/user/.grok/sessions/proj/abc/plan.md");
        let target = Path::new("/home/user/project/src/main.rs");
        assert!(!is_plan_file_write(target, plan));
    }
    #[test]
    fn is_markdown_file_path_recognizes_extensions() {
        assert!(is_markdown_file_path(Path::new("/x/plan.md")));
        assert!(is_markdown_file_path(Path::new("notes.MDX")));
        assert!(is_markdown_file_path(Path::new("readme.markdown")));
        assert!(is_markdown_file_path(Path::new("/a/guide.mdown")));
        assert!(is_markdown_file_path(Path::new("x.mkd")));
        assert!(is_markdown_file_path(Path::new("x.MKDN")));
        assert!(!is_markdown_file_path(Path::new("/src/lib.rs")));
        assert!(!is_markdown_file_path(Path::new("/no-extension")));
        assert!(!is_markdown_file_path(Path::new("/src/notmd.rs")));
        assert!(!is_markdown_file_path(Path::new("企业AI决策清单.html")));
        assert!(is_markdown_file_path(Path::new("企业AI决策清单.md")));
        assert!(is_markdown_file_path(Path::new("计划.markdown")));
        assert!(!is_markdown_file_path(Path::new("md")));
        assert!(!is_markdown_file_path(Path::new("x")));
    }
    #[test]
    fn auto_approve_edit_when_active_and_plan_file() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let plan = t.plan_file_path().to_path_buf();
        assert!(t.should_auto_approve_edit(&plan));
    }
    #[test]
    fn no_auto_approve_edit_when_active_but_different_file() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        assert!(!t.should_auto_approve_edit(Path::new("/some/other/file.rs")));
    }
    #[test]
    fn no_auto_approve_edit_when_inactive() {
        let t = test_tracker();
        let plan = t.plan_file_path().to_path_buf();
        assert!(!t.should_auto_approve_edit(&plan));
    }
    #[test]
    fn no_auto_approve_edit_when_pending() {
        let mut t = test_tracker();
        t.enter_pending();
        let plan = t.plan_file_path().to_path_buf();
        assert!(!t.should_auto_approve_edit(&plan));
    }
    #[test]
    fn double_enter_pending_is_noop() {
        let mut t = test_tracker();
        assert!(t.enter_pending());
        assert!(!t.enter_pending());
        assert_eq!(t.state(), PlanModeState::Pending);
    }
    #[test]
    fn activate_from_inactive_only() {
        let mut t = test_tracker();
        assert!(!t.activate());
        assert_eq!(t.state(), PlanModeState::Inactive);
    }
    #[test]
    fn activate_from_tool_when_already_active() {
        let mut t = test_tracker();
        t.activate_from_tool();
        assert!(!t.activate_from_tool());
        assert_eq!(t.state(), PlanModeState::Active);
    }
    #[test]
    fn deactivate_when_not_active() {
        let mut t = test_tracker();
        assert!(!t.deactivate_approved());
        assert_eq!(t.state(), PlanModeState::Inactive);
    }
    #[test]
    fn user_exit_from_inactive_is_noop() {
        let mut t = test_tracker();
        t.user_exit(false);
        assert_eq!(t.state(), PlanModeState::Inactive);
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn complete_deferred_exit_when_not_exit_pending_is_noop() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.complete_deferred_exit();
        assert_eq!(t.state(), PlanModeState::Active);
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn user_exit_while_idle_sets_exit_reminder() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.user_exit(false);
        assert_eq!(t.state(), PlanModeState::Inactive);
        assert!(t.has_pending_exit_reminder());
        t.clear_pending_exit_reminder();
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn enter_pending_clears_pending_exit_reminder() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.user_exit(false);
        assert!(t.has_pending_exit_reminder());
        t.enter_pending();
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn activate_from_tool_clears_pending_exit_reminder() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.user_exit(false);
        assert!(t.has_pending_exit_reminder());
        t.activate_from_tool();
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn deactivate_approved_does_not_set_pending_exit_reminder() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        assert!(!t.has_pending_exit_reminder());
        t.deactivate_approved();
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn queue_exit_reminder_arms_flag() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.deactivate_approved();
        assert!(!t.has_pending_exit_reminder());
        t.queue_exit_reminder();
        assert!(t.has_pending_exit_reminder());
        t.clear_pending_exit_reminder();
        assert!(!t.has_pending_exit_reminder());
    }
    #[test]
    fn compaction_reset_only_when_active() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.record_reminder_injected();
        t.deactivate_approved();
        t.reset_after_compaction();
    }
    #[test]
    fn snapshot_round_trip_active() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.record_reminder_injected();
        let snap = t.snapshot();
        assert_eq!(snap.state, PlanModeState::Active);
        assert!(snap.was_previously_active);
        assert_eq!(snap.reminder_count, 1);
        let restored = PlanModeTracker::from_snapshot(PathBuf::from("/tmp/test-session"), snap);
        assert_eq!(restored.state(), PlanModeState::Active);
        assert!(!restored.should_use_full_reminder());
    }
    /// A resumed session that was planning still reports `Plan`.
    /// The mirrors are seeded from this at spawn.
    /// Seeding `Agent` instead makes the first prompt resolve `Agent`, reconcile, and drop the plan mode silently.
    #[test]
    fn session_prompt_mode_follows_a_restored_active_tracker() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        let restored = PlanModeTracker::from_snapshot(PathBuf::from("/tmp/test"), t.snapshot());
        assert_eq!(restored.state(), PlanModeState::Active);
        assert_eq!(restored.session_prompt_mode(), PromptMode::Plan);
        assert_eq!(
            test_tracker().session_prompt_mode(),
            PromptMode::Agent,
            "an inactive tracker is agent mode"
        );
    }
    #[test]
    fn snapshot_pending_collapses_to_inactive() {
        let mut t = test_tracker();
        t.enter_pending();
        let snap = t.snapshot();
        assert_eq!(snap.state, PlanModeState::Pending);
        let restored = PlanModeTracker::from_snapshot(PathBuf::from("/tmp/test-session"), snap);
        assert_eq!(restored.state(), PlanModeState::Inactive);
    }
    #[test]
    fn snapshot_exit_pending_collapses_to_inactive_with_reminder() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.user_exit(true);
        let snap = t.snapshot();
        assert_eq!(snap.state, PlanModeState::ExitPending);
        let restored = PlanModeTracker::from_snapshot(PathBuf::from("/tmp/test-session"), snap);
        assert_eq!(restored.state(), PlanModeState::Inactive);
        assert!(restored.has_pending_exit_reminder());
    }
    #[test]
    fn snapshot_inactive_restores_cleanly() {
        let t = test_tracker();
        let snap = t.snapshot();
        let restored = PlanModeTracker::from_snapshot(PathBuf::from("/tmp/test-session"), snap);
        assert_eq!(restored.state(), PlanModeState::Inactive);
        assert!(!restored.has_pending_exit_reminder());
    }
    #[test]
    fn reenter_from_exit_pending_cancels_deferred_exit() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.user_exit(true);
        assert_eq!(t.state(), PlanModeState::ExitPending);
        assert!(t.enter_pending());
        assert_eq!(t.state(), PlanModeState::Active);
        assert!(!t.has_pending_exit_reminder());
        t.complete_deferred_exit();
        assert_eq!(t.state(), PlanModeState::Active);
    }
    #[test]
    fn was_previously_active_persists_through_agent_exit() {
        let mut t = test_tracker();
        t.activate_from_tool();
        assert!(t.is_active());
        t.deactivate_approved();
        assert_eq!(t.state(), PlanModeState::Inactive);
        t.enter_pending();
        assert!(t.is_reentry());
    }
    #[test]
    fn full_lifecycle_with_exit_pending() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        assert!(t.should_use_full_reminder());
        t.record_reminder_injected();
        assert!(!t.should_use_full_reminder());
        t.record_reminder_injected();
        t.user_exit(true);
        assert_eq!(t.state(), PlanModeState::ExitPending);
        t.complete_deferred_exit();
        assert_eq!(t.state(), PlanModeState::Inactive);
        assert!(t.has_pending_exit_reminder());
        t.clear_pending_exit_reminder();
        assert!(!t.has_pending_exit_reminder());
        t.enter_pending();
        assert!(t.is_reentry());
        t.activate();
        assert_eq!(t.state(), PlanModeState::Active);
        assert!(t.should_use_full_reminder());
    }
    #[test]
    fn test_prompt_mode_from_meta_str_known_values() {
        assert_eq!(PromptMode::from_meta_str("ask"), PromptMode::Ask);
        assert_eq!(PromptMode::from_meta_str("plan"), PromptMode::Plan);
        assert_eq!(PromptMode::from_meta_str("agent"), PromptMode::Agent);
    }
    #[test]
    fn test_prompt_mode_from_meta_str_unknown_defaults_to_agent() {
        assert_eq!(PromptMode::from_meta_str(""), PromptMode::Agent);
        assert_eq!(PromptMode::from_meta_str("unknown"), PromptMode::Agent);
        assert_eq!(PromptMode::from_meta_str("ASK"), PromptMode::Agent);
        assert_eq!(PromptMode::from_meta_str("Plan"), PromptMode::Agent);
        assert_eq!(PromptMode::from_meta_str("code"), PromptMode::Agent);
    }
    #[test]
    fn test_prompt_mode_is_read_only() {
        assert!(!PromptMode::Agent.is_read_only());
        assert!(PromptMode::Ask.is_read_only());
        assert!(PromptMode::Plan.is_read_only());
    }
    #[test]
    fn test_prompt_mode_default_is_agent() {
        assert_eq!(PromptMode::default(), PromptMode::Agent);
    }
    #[test]
    fn test_prompt_mode_serde_round_trip() {
        for mode in [PromptMode::Agent, PromptMode::Ask, PromptMode::Plan] {
            let json = serde_json::to_string(&mode).unwrap();
            let deserialized: PromptMode = serde_json::from_str(&json).unwrap();
            assert_eq!(deserialized, mode, "round-trip failed for {json}");
        }
    }
    #[test]
    fn test_prompt_mode_serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&PromptMode::Agent).unwrap(),
            r#""agent""#
        );
        assert_eq!(serde_json::to_string(&PromptMode::Ask).unwrap(), r#""ask""#);
        assert_eq!(
            serde_json::to_string(&PromptMode::Plan).unwrap(),
            r#""plan""#
        );
    }
    #[test]
    fn awaiting_plan_approval_survives_snapshot_round_trip() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.set_awaiting_plan_approval(true);
        assert!(t.is_awaiting_plan_approval());
        let restored =
            PlanModeTracker::from_snapshot(PathBuf::from("/tmp/test-session"), t.snapshot());
        assert_eq!(restored.state(), PlanModeState::Active);
        assert!(restored.is_awaiting_plan_approval());
    }
    #[test]
    fn deactivate_approved_clears_awaiting_flag() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.set_awaiting_plan_approval(true);
        t.deactivate_approved();
        assert!(!t.is_awaiting_plan_approval());
    }
    #[test]
    fn user_exit_clears_awaiting_flag() {
        let mut t = test_tracker();
        t.enter_pending();
        t.activate();
        t.set_awaiting_plan_approval(true);
        t.user_exit(false);
        assert!(!t.is_awaiting_plan_approval());
    }
    #[test]
    fn snapshot_without_awaiting_field_defaults_false() {
        let legacy = r#"{
            "state": "Active",
            "was_previously_active": true,
            "reminder_count": 0,
            "pending_exit_reminder": false
        }"#;
        let snapshot: PlanModeSnapshot = serde_json::from_str(legacy).unwrap();
        assert!(!snapshot.awaiting_plan_approval);
        let restored = PlanModeTracker::from_snapshot(PathBuf::from("/tmp/test-session"), snapshot);
        assert!(!restored.is_awaiting_plan_approval());
    }
}
