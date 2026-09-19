# Implement + test: restore fork core after v1.0.14 merge

Step-by-step spec for a later implementation pass. Do **not** re-run an
upstream merge. Do **not** bump the version / publish a release unless asked.

Playbook contract: [`UPSTREAM-MERGE.md`](../UPSTREAM-MERGE.md)
(Must-not-regress A/B/C + trim D).

Last known-good fork tip for lost logic: **`499e1d56`** (Release v1.0.11).
Broken tip: **`692cb182`** (Merge upstream) + **`fce062a9`** (Release v1.0.14).

Restore fork behavior from `499e1d56` **onto the current files**. Keep
upstream's new APIs (`GrokHomeSource`, `home_dir()`, tool-call refactor).
Do not check out old files wholesale.

---

## Current breakage (verify before coding)

| # | User-visible | Root cause on current `main` |
|---|--------------|------------------------------|
| A | `~/.cook/config.toml` ignored (BYOK models missing) | `xai-dirs` `grok_home_in` joins `".grok"` |
| B | `g` run as goal does nothing useful | Pager still sends `"approved_as_goal"`; shell maps unknown → `Cancelled` (request changes). `GoalPlanSource` / `setup_goal(..., plan_source)` dropped. **Shell tests currently do not compile.** |
| C | `/model` after a plan is covered | Draw order: slash dropdown, then `line_viewer` paints over it. `active_modal` returns before the plan, so Ctrl+M hides the plan instead of stacking. |
| D | Privacy banner, `/privacy`, `/usage` limits, announcements still in the TUI | grok.com product chrome not re-hidden after the sync |

```bash
# A — home is wrong
rg 'join\("\.grok"\)' crates/codegen/xai-dirs/src/lib.rs
# expect a hit today; must be empty after the fix

# B — enum missing
rg 'ApprovedAsGoal|GoalPlanSource' --type rust
# expect almost nothing in production; tests still name GoalPlanSource and fail to compile

# C — draw order
rg -n 'active_modal.is_some|line_viewer.is_some|slash_open' \
  crates/codegen/xai-grok-pager/src/app/agent_view/render.rs
```

---

## Order of work

1. A — `xai-dirs` home
2. B1 — `GoalPlanSource` + `setup_goal` third arg (unblocks shell compile)
3. B2 — `ApprovedAsGoal` mid-turn + resume
4. C — picker z-order + render test
5. D — hide Privacy / usage limits / announcements
6. Run the test block at the bottom

No other features. No dual-home. No deleting whole crates.

---

## A. BYOK home = `~/.cook`

**File:** `crates/codegen/xai-dirs/src/lib.rs`

Keep every upstream addition:

- `GrokHomeSource` enum
- `pub fn home_dir()` (`std::env::home_dir`, not `dirs::home_dir`)
- `resolve_grok_home_with_source()`
- `resolve_grok_home_from` returning `Option<(PathBuf, GrokHomeSource)>`

Change only the directory name:

| Location | After |
|----------|--------|
| `grok_home_in` | `.join(".cook")` |
| `GrokHomeSource::HomeDefault` doc | `` `<home>/.thanh` `` |
| crate / `default_grok_home` docs | restore the fork paragraph: isolated from official grok's `~/.grok` |
| test `empty_env_falls_through_to_os_home` | `.join(".cook")` |
| test `default_grok_home_has_no_verbatim_prefix` | `assert!(home.ends_with(".thanh"))` |

**Also:** `crates/codegen/xai-dirs/Cargo.toml` description: `<home>/.thanh`.

`xai-fast-worktree/src/db/mod.rs` already comments `.cook` and already calls
`xai_dirs::resolve_grok_home()`. No change there once `xai-dirs` is fixed.

**Do not** mass-replace project `.grok/` (workspace config, agents, hooks,
`lsp.json`). Those are not the user home.

**Do not** read both `~/.grok` and `~/.cook`.

### Tests (A)

```bash
cargo test -p xai-dirs --lib
```

Must pass: `default_grok_home_has_no_verbatim_prefix`,
`empty_env_falls_through_to_os_home`, `env_wins_over_os_home`.

Manual: `cook models` lists `[model.*]` from `~/.cook/config.toml`.

---

## B. `g` run as goal + `/goal --from-plan`

Pager send path is intact:

- `plan_approval_view.rs` `send_approved_as_goal` → JSON `{ "outcome": "approved_as_goal" }`
- `plan.rs` `approve_plan_as_goal`
- `viewer.rs` / `plan.rs` key `g`

Shell handling was dropped. Tests still expect the old API and **do not
compile** (`GoalPlanSource` unresolved; e2e calls `setup_goal("do X", None, None)`
with 3 args vs production 2 args).

Port from `499e1d56` function-by-function. Reference:

```bash
git show 499e1d56:crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs
git show 499e1d56:crates/codegen/xai-grok-shell/src/session/acp_session_impl/goal.rs
git show 499e1d56:crates/codegen/xai-grok-shell/src/session/slash_commands.rs
```

### B1 — `slash_commands.rs` + `goal.rs` + `turn.rs`

**`crates/codegen/xai-grok-shell/src/session/slash_commands.rs`**

Restore:

```rust
pub(crate) enum GoalPlanSource {
    Path(String),      // --plan <path>
    SessionPlan,       // --from-plan  → the plan tracker's current episode file
    Content(String),   // approved plan body from the pager
}

pub(crate) struct GoalArgs {
    pub objective: String,
    pub token_budget: Option<i64>,
    pub plan_source: Option<GoalPlanSource>,
}
```

- Replace `parse_goal_budget` with `parse_goal_args` from `499e1d56`.
  Trailing standalone `--budget <n>`, `--plan <path>`, `--from-plan`.
  Conflicting or malformed flags stay in the objective untouched.
- `BuiltinAction::GoalSet` gains `plan_source: Option<GoalPlanSource>`.
- `/goal` `argument_hint`:
  `"<objective> [--budget <tokens>] [--plan <path> | --from-plan] | status | pause | resume | clear"`.
- `resolve` arm uses `parse_goal_args` and passes `plan_source`.

**`goal.rs`**

- Restore `read_goal_plan_source(&self, source: GoalPlanSource) -> Result<String, String>`
  (`Content` as-is; `SessionPlan` reads `goal_tracker.plan_mode_plan_path()`;
  `Path` joins session cwd). Empty body → `Err`.
- Change signature:

  ```rust
  pub(super) async fn setup_goal(
      &self,
      objective: &str,
      token_budget: Option<i64>,
      plan_source: Option<GoalPlanSource>,
  ) -> String
  ```

- After `create_goal(...)`, if a source was provided and read OK:
  `self.goal_tracker.lock().seed_plan(content);`
  (`GoalTracker::seed_plan` already exists — do not reimplement.)
  If read fails, return `"Cannot start the goal: {detail}"` and **do not**
  create the goal (match `499e1d56`: read *before* create).

**`turn.rs`** (~line 534):

```rust
BuiltinAction::GoalSet { objective, token_budget, plan_source } => {
    let reminder = self.setup_goal(&objective, token_budget, plan_source).await;
```

Update every `setup_goal` call site. E2e tests already pass three args:

- `acp_session_tests/goal/goal_planner_e2e_tests.rs`

`slash_commands_tests.rs` already has `goal_set_plan_flag_parses`,
`goal_set_from_plan_flag_parses`, conflict cases — they compile again once
the enum and field exist.

### B2 — `tool_calls.rs`

**`crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs`**

1. `PlanApprovalOutcome` add `ApprovedAsGoal`.

   ```rust
   match resp.outcome.as_str() {
       "approved" => Self::Approved,
       "approved_as_goal" => Self::ApprovedAsGoal,
       "abandoned" => Self::Abandoned,
       _ => Self::Cancelled,
   }
   ```

2. Restore `plan_title_or_default(plan: &str) -> String` (first `# ` heading,
   strip optional `Plan:` prefix, fallback `"Implement the approved plan"`).

3. Restore `complete_exit_plan_intercept(&self, call, tool_call_id, message)`
   — same shape as the Abandoned/Cancelled arms: tool update Completed +
   `push_tool_result` + `Ok(Err(ToolLoop::Continue))`.

4. `ResumeAction` add `LeaveAndStartGoal(String)`.

5. `resume_action_for(outcome, feedback, plan_content: Option<String>)`:

   ```rust
   PlanApprovalOutcome::ApprovedAsGoal => {
       ResumeAction::LeaveAndStartGoal(plan_content.unwrap_or_default())
   }
   ```

6. Mid-turn intercept, after the `Approved` arm (~line 1810):

   ```rust
   PlanApprovalOutcome::ApprovedAsGoal => {
       self.leave_plan_mode_to_default();
       if !self.goal_enabled { /* complete_exit_plan_intercept with implement fallback */ }
       let Some(plan_body) = plan_content.filter(|s| !s.trim().is_empty()) else { /* same fallback */ };
       let objective = plan_title_or_default(&plan_body);
       let reminder = self.setup_goal(&objective, None, Some(GoalPlanSource::Content(plan_body))).await;
       return self.complete_exit_plan_intercept(&call, &tool_call_id, format!(
           "The plan has been approved and started as an autonomous goal. \
            Do not implement it in this turn — the goal loop drives execution.\n\n{reminder}"
       )).await;
   }
   ```

   Fallback copy when goal is disabled or plan body empty: prefix +
   `PLAN_APPROVED_IMPLEMENT_MESSAGE` (see `499e1d56` around the
   `ApprovedAsGoal` arm).

7. `resume_plan_approval`: pass `Some(plan_content)` into `resume_action_for`.
   New arm `LeaveAndStartGoal(plan_body)`:

   - `leave_plan_mode_to_default()`
   - if `!goal_enabled` → `start_resume_turn(implement fallback, Agent)`
   - else `setup_goal(&plan_title_or_default(&plan_body), None, Some(Content(plan_body)))`
     then `start_resume_turn(reminder, Agent)`

8. Unit tests in `plan_approval_helper_tests`:

   - `"approved_as_goal"` → `ApprovedAsGoal`
   - `resume_action_for(ApprovedAsGoal, None, Some(body))` → `LeaveAndStartGoal(body)`
   - empty body → `LeaveAndStartGoal("")`

Update every `resume_action_for(...)` call (production + tests) to the
3-arg form.

### Tests (B)

```bash
cargo test -p xai-grok-shell --lib \
  outcome_from_response_maps_known_and_fails_closed \
  resume_action_maps_each_outcome \
  resume_approved_as_goal_seeds_goal_with_plan \
  goal_set_plan_flag_parses \
  goal_set_from_plan_flag_parses \
  goal_set_conflicting_or_malformed_plan_flags_stay_in_objective \
  goal_set_plan_and_budget_combine_in_either_order

cargo test -p xai-grok-pager --lib \
  approve_as_goal_sends_goal_outcome_with_freeform_notes
```

`cargo test -p xai-grok-shell --lib` must **compile**. Today it does not.

Manual: park a plan, press `g` → goal loop starts with the plan as contract
(not a "revise the plan" turn).

---

## C. Model picker on top of the plan overlay

**File:** `crates/codegen/xai-grok-pager/src/app/agent_view/render.rs`

Today (~3138–3714):

1. Draw prompt
2. Draw file-search / slash / completion / history dropdowns
3. If `active_modal`: draw modal, **return** (plan never paints)
4. If `line_viewer`: draw plan overlay top→prompt, **return** (step 2 is overwritten)

Target:

1. Draw prompt (unchanged)
2. If `line_viewer`: draw the plan overlay (same `overlay_area` as today).
   **Do not return yet** when a dropdown or `active_modal` needs to sit on top.
3. Draw file-search / slash / completion / history dropdowns
   (move the existing block here; do not draw twice)
4. If `active_modal`: `draw_active_modal`, then return
5. If `line_viewer` was drawn and there is no modal: return with the same
   cursor / shortcuts-bar behavior as today
   (`plan_prompt_focused` → prompt cursor; else viewer cursor)

Keep: plan overlay still hides image / video / gboom / block viewers.

Input routing is already correct (`try_plan_overlay_agent_action`, slash-on-Enter
in `plan.rs`, `/` on preview in `viewer.rs`). Do not change keys unless the
render-only fix is not enough.

### New render test

Next to `model_picker_during_plan_approval` /
`plan_approval_slash_tests`. Fixtures: `make_agent`,
`make_plan_approval_view_state`, `reopen_plan_approval`.

Two cases (or one parameterized):

1. Parked plan + `line_viewer` + `active_modal = ArgPicker { command: "model", items: ["Test Model"], ... }`
2. Parked plan + prompt `"/model"` with slash dropdown open

Draw into a `ratatui::buffer::Buffer`. Assert:

- picker / dropdown content is present (model name or `/model` match rows)
- that region is not only plan-body cells (plan is not the topmost layer)

Existing tests that must still pass:

```bash
cargo test -p xai-grok-pager --lib \
  model_picker_during_plan_approval \
  plan_preview_slash_starts_command_on_prompt
```

Manual: with a parked plan, `/model` or `Ctrl+M` shows the list **on top of**
the plan. Overlay stays; `a` / `g` still work after picking.

---

## D. Trim grok.com chrome (Privacy, usage limits, announcements)

Hide at chokepoints. Do **not** delete the files (upstream will re-add them
next sync). Re-apply this hide after every merge.

**Keep** `/context` (context-window tokens) and `/session-info`. Hide grok.com
*limits*, not local session facts.

### D1 — Privacy

| What to hide | Chokepoint | Change |
|--------------|------------|--------|
| "Help improve Grok" banner | `AppView::privacy_banner_should_show` in `app_view.rs` | `return false;` as the first line (keep the rest of the function for upstream shape) |
| `/privacy` | `PrivacyCommand` in `slash/commands/privacy.rs` | override `fn visible(&self, _ctx: &AppCtx) -> bool { false }` and refuse in `run` with a short error |
| Settings → "Coding data, retention, and training" | `setting_row_visible` in `views/settings_modal/state.rs` | `if meta.key == "coding_data_sharing" { return false; }` |

Do not send `PUT /v1/privacy/coding-data-retention` from the TUI after this
(banner gone, row gone, command hidden). Leave the HTTP helper in place.

Tests to add / adjust:

- `privacy_banner_should_show` is false even when rollout + opted-out + auth done
- `PrivacyCommand.visible` is false
- settings rows do not contain `coding_data_sharing` (update tests that
  currently `expect("coding_data_sharing must be registered")` as a *row* —
  the registry entry can stay; the **row** must not appear)

Existing PTY `privacy_banner_e2e` will fail if run — that is expected; do not
keep the banner to satisfy those tests. Gate or skip them if they are in the
default `cargo test -p xai-grok-pager` set.

### D2 — Usage limits (`/usage`, `/cost`, upgrade CTAs)

`/usage` is already gated by `usage_command_visible` (hidden for external
auth). Make the fork hide it for **everyone**:

**`AppView::sync_billing_surface_to_agents`** (`app_view.rs` ~1462):

```rust
let usage_cmd = false; // BYOK fork: no grok.com usage/limits UI
```

(Today: `let usage_cmd = !self.has_external_auth_provider;`)

That hides `/usage` and `/cost` on every slash surface (agent, welcome,
dashboard). `UsageCommand::visible` / `run` already honor the flag.

Do **not** restore grok.com credit / quota bars in `usage_modal.rs`
`usage_lines` if they reappear. Context tab (`/context`) and Session-info
tab (`/session-info`) stay.

Upgrade CTAs / SuperGrok links: do not add new ones. If a pinned upgrade CTA
still renders, skip painting `hit_upgrade_cta` / announcement upgrade slot
when there is no grok.com session (API-key / BYOK). Prefer a single early
return in the announcement/upgrade render path over deleting `announcements.rs`.

Tests:

- `usage_hidden_when_command_not_visible` already exists — keep it
- Add/adjust: after `sync_billing_surface_to_agents`,
  `usage_command_visible()` is false even without external auth
- `show_usage_opens_modal_on_usage_tab_with_fetches` currently assumes
  `/usage` works — either keep `Action::ShowUsage` functional if dispatched
  directly, or update the test to expect a no-op. Prefer: slash hidden,
  `Action::ShowUsage` still opens the **session-token** tab if you want a
  back door; simplest is hide slash and leave the action (dead from the UI).

### D3 — Announcements

| What to hide | Chokepoint | Change |
|--------------|------------|--------|
| Product promo banner | `handle_announcements_update` / `apply_announcements_update` | no-op: do not set `app.announcement` from remote |
| `/announcements` | `AnnouncementsCommand::visible` | `false` |

`GROK_ANNOUNCEMENTS_OVERRIDE` already exists as an escape hatch — do not
remove it; the fork default is "no banner".

### D4 — Paywall / telemetry (already in the playbook)

- `subscription.rs`: keep current fork (gate chokepoint, no consumer
  free→paid deferral). Do not restore the paywall.
- Telemetry: still a **target** trim (`xai-grok-telemetry` wiring in
  `pager-bin`). Out of scope for this pass unless it is a one-line hide.
  Do not delete the crate in this change set.

### Tests (D)

```bash
# Privacy row gone, command hidden
cargo test -p xai-grok-pager --lib setting_row_visible privacy

# Usage slash hidden
cargo test -p xai-grok-pager --lib usage_hidden_when_command_not_visible
```

Manual:

- Welcome / agent view: no "Help improve Grok" banner
- `/privacy` not in the slash list
- Settings: no Privacy / coding-data row
- `/usage` and `/cost` not in the slash list
- `/context` and `/session-info` still open
- No announcement promo bar

---

## Combined test gate (must all pass)

```bash
cargo check -p xai-dirs -p xai-grok-shell -p xai-grok-pager -p xai-grok-sampling-types

cargo test -p xai-dirs --lib

cargo test -p xai-grok-shell --lib \
  outcome_from_response_maps_known_and_fails_closed \
  resume_action_maps_each_outcome \
  resume_approved_as_goal_seeds_goal_with_plan \
  goal_set_plan_flag_parses \
  goal_set_from_plan_flag_parses \
  goal_set_conflicting_or_malformed_plan_flags_stay_in_objective

cargo test -p xai-grok-pager --lib \
  model_picker_during_plan_approval \
  plan_preview_slash_starts_command_on_prompt \
  approve_as_goal_sends_goal_outcome_with_freeform_notes \
  usage_hidden_when_command_not_visible
# plus the new z-order render test and privacy-row-hidden test
```

`xai-grok-shell --lib` compiling is a hard gate (today it does not).

Full `./build.sh` only after the targeted tests pass.

---

## Out of scope

- Re-merging upstream
- Version bump / `scripts/publish_release.sh`
- Dual-home (`~/.grok` + `~/.cook`)
- Deleting `xai-grok-telemetry` / `privacy_banner.rs` / `usage_modal.rs`
- Redesigning plan-approval UI
- Project-level `.grok/` paths
