# Desktop ↔ TUI capability map

Method-level inventory of what the TUI (pager + agent) actually uses, and the live Desktop status of each. This is the protocol track. Presentation (how a tool row *looks*) stays in [`tui-presentation.md`](tui-presentation.md). Architecture contract stays in [`desktop-app.md`](desktop-app.md). Folding the live client onto that contract: [`desktop-app-client-implement.md`](desktop-app-client-implement.md). Production sequencing after honesty/registry: [`desktop-app-implement.md`](desktop-app-implement.md).

**This file does not implement any `gap` / `stub` row.**

Harvested 2026-09-18 from git `705f3572`. A string is in this map only if it appears in one of the sources in §0.

---

## How to read

| Column | Meaning |
|---|---|
| Id | Stable row id for later PRs (`desktop-app-client-implement.md` and `desktop-app-implement.md` cite these, not invent method names) |
| Wire | Exact method / `sessionUpdate` / `ToolKind` string |
| Dir | `C→A` client request, `C→A notif`, `A→C` reverse request, `A→C notif`, or agent-internal |
| TUI | File:function that handles it (pager or shell) |
| Desktop | File that handles it, or `—` |
| Status | see legend |
| Must | `protocol` / `surface` / `chrome` / `out` |

**Status (these four words only, plus `ok-prompt` in §9):**

- `ok` — Desktop speaks it and a user can complete the TUI flow
- `partial` — method exists but envelope, UI, or notification loop is wrong
- `stub` — answers without doing the work (terminal stubs are the type specimen)
- `gap` — TUI uses it; Desktop ignores, `-32601`s, or has no surface
- `na` — TUI-only chrome or explicitly out of product scope; still listed so we do not rediscover it

**Must:**

- `protocol` — Desktop must answer or the turn/session is wrong
- `surface` — user-facing TUI feature Desktop must expose somehow (a compact panel is enough; not a pixel clone)
- `chrome` — TUI-only paint; Desktop analog optional
- `out` — leader/cloud/xAI-account, not this fork’s product

---

## 0. Sources of truth

| Role | Path |
|---|---|
| Agent dispatch | `crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs` `ext_method` (L1966–2342), `ext_notification` (L2351+) |
| Nested C→A handlers | `crates/codegen/xai-grok-shell/src/extensions/{mcp,terminal,fs,task,skills,plugins,hooks,marketplace,memory,auth,git,worktree,hunk_tracker,pr,bundle,search,code_nav,debug,rewind,feedback}.rs` |
| MCP wire constants | `crates/codegen/xai-grok-mcp/src/wire.rs` |
| TUI reverse + notifs | `crates/codegen/xai-grok-pager/src/app/acp_handler/mod.rs` `handle_ext_method`, `handle_ext_notification` |
| TUI session updates | `crates/codegen/xai-grok-pager/src/acp/tracker.rs`, `…/acp_handler/session_notification.rs` |
| TUI initialize caps | `crates/codegen/xai-grok-pager/src/acp/mod.rs` `client_capabilities_meta` |
| TUI slash registry | `crates/codegen/xai-grok-pager/src/slash/commands/mod.rs` `builtin_commands` |
| Agent slash builtins | `crates/codegen/xai-grok-shell/src/session/slash_commands.rs` `BUILTIN_COMMANDS` |
| Desktop reverse | `frontend/apps/let-cook/src/acp/client.ts` `handleMessage`; `src-tauri/src/acp_host.rs` `handle_host_request` |
| Desktop forward | `frontend/apps/let-cook/src/acp/{xai,extensions,providers,client,host,wire-params}.ts` |
| Desktop settings surfaces | `frontend/apps/let-cook/src/ui/settings/{connectors,context-panels,hooks-panel}.tsx`; group headers `…/settings/group-header.tsx`; grouping `…/settings/{skills-groups,connectors-groups}.ts` |
| Desktop transcript | `frontend/apps/let-cook/src/state/session.ts` `reduceNotifications` / `reduceTranscript` |
| Tools | `crates/codegen/xai-grok-tools/src/types/tool.rs` `ToolKind`; pager `scrollback/blocks/tool/*`; Desktop `ui/chat/tool-card.tsx` |
| User-facing names | `~/.cook/docs/user-guide/` (`04-slash-commands`, `07-mcp-servers`, `08-skills`, `09-plugins`, `10-hooks`, `13-memory`, `16-subagents`, `19-plan-mode`, `20-background-tasks`, `21-terminal-support`, `23-dashboard`) |

Related, do not merge:

- [`tui-presentation.md`](tui-presentation.md) — how the TUI paints
- [`desktop-app.md`](desktop-app.md) — Desktop architecture contract; §5.3 points here
- [`desktop-app-client-implement.md`](desktop-app-client-implement.md) — honesty / reverse policy / notification registry fold; cite row ids
- [`desktop-app-implement.md`](desktop-app-implement.md) — production roadmap; cite row ids; registry entry required

---

## 1. Handshake

### 1.1 `initialize`

| Field | TUI | Desktop | Status | Must |
|---|---|---|---|---|
| `protocolVersion` | ACP v1 (`acp/mod.rs` `initialize`) | `PROTOCOL_VERSION` (`client.ts` `initialize`) | `ok` | protocol |
| `clientInfo` | pager `clientType` / `clientVersion` in request `_meta` | `{ name, title: "Let Cook", version }` | `ok` | protocol |
| `_meta.clientIdentifier` | pager default `PAGER_CLIENT_TYPE`; optional `--client-identifier` | `grok-desktop` (`CLIENT_META`) | `ok` | protocol |
| `_meta.clientType` | pager product string | `grok_desktop` | `ok` | protocol |
| `_meta.mcpApps` | not set by pager | `false` | `ok` — honest; SDK MCP stays off until R-sdk (see H-mcp) | protocol |
| `_meta.bufferingSettings` | — | `{ minDelayMs: 16, maxDelayMs: 64, maxBytes: 65536 }` | `ok` | chrome |
| `clientCapabilities.fs.readTextFile` / `writeTextFile` | CLI `--fs-read` / `--fs-write`, **default false**. Pager does **not** implement `fs/*` (`acp_handler` `_ => false` drops the oneshot) | `true` / `true`; host implements in `acp_host.rs` | `ok` (Desktop is ahead of default TUI) | protocol |
| `clientCapabilities.terminal` | CLI `--terminal`, **default false**. If set, `WaitForTerminalExit` is rejected honestly (`wait_for_exit_not_supported`) | `false` (no PTY; host does not stub `terminal/*`) | `ok` | protocol |
| `clientCapabilities.plan` | — | `{}` | `ok` | protocol |
| `_meta["x.ai/folderTrust"].interactive` | not advertised by pager (folder-trust is a desktop/GUI round-trip) | `{ interactive: true }` | `ok` | protocol |
| `x.ai/incrementalBashOutput` | `true` | — | `gap` | protocol |
| `x.ai/hunkTracker` | `{ mode }` (canonicalized; default `off`) | — | `na` (IDE hunk UI; Desktop Review is Tauri git, not this cap) | chrome |
| `x.ai/bashOutputNoColor` | `true` | — | `gap` (agent may send ANSI in bash rows) | protocol |
| `x.ai/gitHeadChanged` | `true` | — | `gap` | surface |
| `x.ai/userMessageEcho` | always `true` | — | `gap` | chrome |
| `x.ai/statusLine` | `flags.status_line` from `[ui.status_line]` | — | `na` | chrome |
| `x.ai/hooks` on **agent** `agentCapabilities.meta` | agent always advertises hook schema | ignored (initialize response discarded) | `na` until Desktop registers client hooks | protocol |
| `x.ai/fs_notify` (agent cap) | agent advertises | ignored | `na` | chrome |
| `x.ai/codeNavigation` | agent reads if client sends | — | `na` | chrome |

Desktop **discards** `InitializeResponse` (`client.ts` `initialize` awaits and drops it). TUI parses `defaultAuthMethodId`, `availableCommands`, `cancelRewind`, `sessionRecap`, `feedbackTraceOffer`, `grokShell`.

### 1.2 Agent `InitializeResponse.meta` (what the client should consume)

| Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|
| `mcpApps` | echo of client support | client sends `false`; unused | `ok` | protocol |
| `x.ai/mcp/sdk` | agent always `true` | unused | `gap` — enabling SDK MCP without `sdk_call` is class A | protocol |
| `x.ai/pluginDirs` | agent `true` | unused | `na` | chrome |
| `availableCommands` | parsed at connect | unused; later `x.ai/commands/list` | `partial` | surface |
| `sessionRecap` | gates `/recap` | unused | `gap` | surface |
| `cancelRewind` | parsed | unused | `gap` | surface |
| `feedbackTraceOffer` | parsed | unused | `na` | chrome |
| `defaultAuthMethodId` | preferred-method source of truth | unused | `partial` | protocol |
| `modelState` / `mcpServers` / `voiceMode` / `grokShell` | parsed | unused | `partial` / `na` | — |

### 1.3 `session/new` / `session/load`

| Field | TUI | Desktop | Status | Must |
|---|---|---|---|---|
| `cwd` | session cwd | chosen folder | `ok` | protocol |
| `mcpServers` | `discover_mcp_servers` → `load_mcp_servers` (`effects/mod.rs`) | **`[]` always** (`newSession`, `loadSession`, crash reload) | `partial` — agent-hosted config MCP can still attach via Settings `x.ai/mcp/*`; **SDK MCP never attaches** (class F) | protocol |
| `_meta["x.ai/mcp/servers"]` | not sent | not sent | `gap` (unsafe to enable until R-sdk exists) | protocol |
| `_meta["x.ai/hooks"]` | not sent | not sent | `gap` (latent; `hooks/run` only fires if registered) | protocol |
| `_meta.modelId` | yes | `localStorage thanh.defaultModel` | `ok` | protocol |
| `_meta.yoloMode` / `autoMode` | always | `yoloMode: true` only when stored | `ok` | protocol |
| `_meta.clientIdentifier` | on initialize; session flags vary | `grok-desktop` on `session/new` only; **absent on `session/load`** | `partial` | protocol |
| `session/load` `_meta` | yolo/model/mcp as create | `{ sessionId, cwd, mcpServers: [] }` only | `partial` | protocol |

### 1.4 Handshake bugs that cause later “random” errors

| Id | Bug | Class | Fix (not in this work) |
|---|---|---|---|
| **H-term** | Was: advertise `terminal: true` + stub `exitCode: 0`. **Fixed (C1):** `terminal: false`; host declines unknown `terminal/*` without stub success. | — | Keep closed until a real PTY |
| **H-mcp** | Still `mcpServers: []` / no SDK servers (class F until R-sdk). **Fixed (C1):** `mcpApps: false`. | F | Keep SDK off until R-sdk |

---

## 2. Standard ACP

| Id | Wire | Dir | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|---|
| ACP-init | `initialize` | C→A | `acp/mod.rs` `initialize` | `client.ts` `initialize` | `ok` | protocol |
| ACP-auth | `authenticate` | C→A | pager auth flow | **not sent**. Reverse `authenticate` would `-32601`. Auth UI is BYOK + `x.ai/auth/info` | `partial` | protocol |
| ACP-new | `session/new` | C→A | `effects` `CreateSession` | `client.ts` `newSession` | `ok` | protocol |
| ACP-load | `session/load` | C→A | pager resume | `client.ts` `loadSession` | `ok` | protocol |
| ACP-prompt | `session/prompt` | C→A | pager submit | `client.ts` `dispatchPrompt` (text + image parts) | `ok` | protocol |
| ACP-cancel | `session/cancel` | C→A | pager | `client.ts` `cancel` (`notify`) | `ok` | protocol |
| ACP-model | `session/set_model` | C→A | `/model` | `client.ts` `setModel` | `ok` | protocol |
| ACP-mode | `session/set_mode` | C→A | `/plan` | `xai.ts` `setMode` (`plan` / `default`) | `ok` | protocol |
| ACP-upd | `session/update` | A→C notif | `acp_handler` + `tracker.rs` | `client.ts` `handleMessages` → `session.ts` | `partial` (several tags dropped; §4) | protocol |
| ACP-perm | `session/request_permission` | A→C | `handle_permission_request` | `client.ts` parks `pendingPermission` | `ok` | protocol |
| ACP-fs-r | `fs/read_text_file` | A→C | not implemented; cap default false | `acp_host.rs` `read_text_file` (cwd + `~/.cook/sessions`; ignores line/limit) | `ok` | protocol |
| ACP-fs-w | `fs/write_text_file` | A→C | not implemented; cap default false | `acp_host.rs` `write_text_file` (same sandbox; **plan.md allow-path**) | `ok` | protocol |
| ACP-t-c | `terminal/create` | A→C | not advertised by default; unhandled if it arrives | not advertised (`terminal: false`); no host stub | `ok` | protocol |
| ACP-t-o | `terminal/output` | A→C | — | not advertised | `ok` | protocol |
| ACP-t-w | `terminal/wait_for_exit` | A→C | honest `-32601` if advertised | not advertised | `ok` | protocol |
| ACP-t-r | `terminal/release` | A→C | — | not advertised | `ok` | protocol |
| ACP-t-k | `terminal/kill` | A→C | — | not advertised | `ok` | protocol |

Plan-mode and goal-plan files are written through ACP-fs-w into `$COOK_HOME/sessions` (else `$GROK_HOME/sessions`, else `~/.cook/sessions`): `<session>/plan.md` is the legacy plan-mode fallback; current plan-mode episodes, `/goal` planner output, and `/goal --plan` seeds use `<session>/plans/<utc>.md`, published to `<slug>-<utc>.md`. Inactive `--from-plan` / approve-as-goal reuses that episode. The private goal verifier baseline remains `<session>/goal/plan.baseline.md` and is never listed. That allow-path is load-bearing. The desktop reads and prunes episodes through C-plans rather than the filesystem, so the list also works for a session loaded from disk. The list payload includes `title` (the plan H1) so the header chip can name the episode.

---

## 3. Reverse `x.ai/*` requests (A→C) — error class A

These block the agent until the client answers. A `-32601` is a user-visible failure.

### 3.1 Closed list the agent is allowed to send

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| R-ask | `x.ai/ask_user_question` | `handle_ask_user_question` | `client.ts` `pendingQuestion` | `ok` | protocol |
| R-plan | `x.ai/exit_plan_mode` | `handle_exit_plan_mode` | `client.ts` `beginPlanReview` + plan card | `ok` | protocol |
| R-elicit | `x.ai/mcp/elicit` | `handle_mcp_elicit` | reverse registry parks elicit card; `N-mcp-elic` clears | `ok` | protocol |
| R-trust | `x.ai/folder_trust/request` | not handled (not advertised) | reverse registry parks trust card | `ok` | protocol |
| R-sdk | `x.ai/mcp/sdk_call` | not handled; pager does not register SDK MCP | typed decline `{ ok: false }` (known-unimplemented) | `partial` | protocol |
| R-hook | `x.ai/hooks/run` | not handled; pager does not stamp `_meta["x.ai/hooks"]` | typed decline `{ ok: false }` (known-unimplemented) | `partial` (latent) | protocol |

Standard ACP reverse (`session/request_permission`, `fs/*`, `terminal/*`) is §2.

### 3.2 Unknown reverse policy

**Today**

| Client | Unknown A→C **request** (`id` present) | Unknown A→C **notification** |
|---|---|---|
| TUI | `tracing::warn` **and** `-32601` (`handle_ext_method` unknown arm). TUI does not advertise caps it cannot honour, so the agent should not send R-sdk / R-hook / `terminal/*`. | `_ => false`; envelope still `Ok(())` |
| Desktop | typed decline `{ ok: false }` via `acp/reverse` (C2); `-32601` only if advertised-required. Caps honest (`terminal`/`mcpApps` false). | log-only unknown notifications via `acp/notifications` |

**Policy (architecture [`desktop-app.md`](desktop-app.md) §5.5; fold in
[`desktop-app-client-implement.md`](desktop-app-client-implement.md) **C2**,
do not implement in the map PR):**

1. Known interaction methods (R-ask, R-plan, R-elicit, R-trust): implement, or answer a **typed cancel/decline** so the turn continues.
2. Unknown **notifications**: log and ignore (Desktop already does this). Do not `-32601` a notification.
3. Unknown **requests**: answer `{ ok: false }` / typed decline. **Do not `-32601`** unless the client advertised that capability (or the agent marked the method required). `-32601` is reserved for “I claimed this and I refuse it” (TUI `WaitForTerminalExit`) — not for “I never heard of this.”
4. Do not register SDK MCP (`_meta["x.ai/mcp/servers"]`) until R-sdk is implemented. Do not advertise `terminal: true` until ACP-t-* is real.

---

## 4. Extension notifications (A→C) — error class B

Ignored notifications do not crash; they stale the UI (MCP tools in the model, never in Settings; background tasks finish invisibly).

### 4.1 Standalone methods (`handle_ext_notification` closed list)

TUI match: `acp_handler/mod.rs` L605–628. Plus session-update carriers via `is_session_update_ext_method`.

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| N-sn | `x.ai/session_notification` | `handle_session_notification` | `client.ts` merged with `session/update` | `partial` | protocol |
| N-su | `x.ai/session/update` | same | **not consumed** (only `session/update` and `x.ai/session_notification`) | `gap` | protocol |
| N-follow | `x.ai/follow_ups` | `handle_follow_ups` | ignored | `gap` | surface |
| N-tbg | `x.ai/task_backgrounded` | `handle_task_backgrounded` | notice toast (no dock yet) | `partial` | surface |
| N-tdone | `x.ai/task_completed` | `handle_task_completed` | notice toast (no dock yet) | `partial` | surface |
| N-models | `x.ai/models/update` | `handle_models_update` | `client.ts` catalog refresh | `ok` | protocol |
| N-settings | `x.ai/settings/update` | `handle_settings_update` | ignored | `gap` | surface |
| N-sessions | `x.ai/sessions/changed` | `handle_sessions_changed` | ignored (sidebar polls `session/list`) | `partial` | surface |
| N-queue | `x.ai/queue/changed` | `handle_queue_changed` | syncs `queuedPromptCount` | `partial` (no queue list UI yet) | surface |
| N-pcomplete | `x.ai/session/prompt_complete` | `handle_prompt_complete` | `finishTurn` via notification registry | `ok` | protocol |
| N-interject | `x.ai/session/interjection` | `handle_interjection` | ignored | `gap` | surface |
| N-mon | `x.ai/monitor_event` | `handle_monitor_event` | ignored | `gap` | surface |
| N-sched-c | `x.ai/scheduled_task_created` | handler | ignored | `gap` | surface |
| N-sched-f | `x.ai/scheduled_task_fired` | handler | ignored | `gap` | surface |
| N-sched-d | `x.ai/scheduled_task_deleted` | handler | ignored | `gap` | surface |
| N-ann | `x.ai/announcements/update` | `handle_announcements_update` | ignored (generated type unused) | `na` | chrome |
| N-git | `x.ai/git_head_changed` | `handle_git_head_changed` | ignored (Review is Tauri `loadWorkspaceReview`, not this notif) | `gap` | surface |
| N-ver | `x.ai/leader/version_mismatch` | toast | ignored | `out` | out |
| N-mcp-init | `x.ai/mcp/init_progress` | `handle_mcp_init_progress` | catalog status patch | `ok` | surface |
| N-mcp-tools | `x.ai/mcp/tools_changed` | `handle_mcp_tools_changed` | catalog tools patch; an empty catalog triggers a `connectors` refetch instead of dropping the push | `ok` | surface |
| N-mcp-inited | `x.ai/mcp_initialized` | same handler | status → ready | `ok` | surface |
| N-mcp-stat | `x.ai/mcp/server_status` | gated `handle_mcp_server_status` | catalog status patch | `ok` | surface |
| N-mcp-elic | `x.ai/mcp/elicit_complete` | `handle_mcp_elicit_complete` | clears pending elicit | `ok` | protocol |
| N-mcp-srv | `x.ai/mcp/servers_updated` | `handle_mcp_servers_updated` | merges into MCP catalog (Connectors live; an unannotated payload keeps known tools) | `ok` | surface |
| N-yolo | `x.ai/yolo_mode_changed` | settings path | consumed no-op | `ok` | protocol |
| N-chunk | `x.ai/session/updates/chunk` | — | ignored | `na` | chrome |
| N-hookev | `x.ai/hooks/event` | — | ignored | `gap` | surface |
| N-fsn | `x.ai/fs_notify` / `x.ai/fs/index` / `x.ai/fs/index/delta` | — | ignored | `na` | chrome |
| N-wt | `x.ai/git/worktree/status` | — | ignored | `na` | chrome |
| N-search | `x.ai/search/fuzzy/status` / `x.ai/search/content/status` | — | ignored | `na` | chrome |
| N-pty | `x.ai/terminal/pty/notification` | — | ignored | `na` | chrome |

### 4.2 `sessionUpdate` tags inside `session/update` / `x.ai/session_notification`

ACP tags (`tracker.rs` + `session.ts`):

| Id | Tag | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| U-user | `user_message_chunk` | tracker | `reduceUserChunk` | `ok` | protocol |
| U-agent | `agent_message_chunk` | tracker | `reduceMessageChunk` | `ok` | protocol |
| U-thought | `agent_thought_chunk` | tracker | thinking row | `ok` | protocol |
| U-tool | `tool_call` / `tool_call_update` | tracker | `reduceTool` | `ok` | protocol |
| U-plan | `plan` / `plan_update` | handler before tracker | `reducePlan` | `ok` | protocol |
| U-planrm | `plan_removed` | — (TUI uses `plan_cleared`) | `reduceTranscript` | `ok` | protocol |
| U-cmds | `available_commands_update` | tracker pending catalog | catalog store only | `ok` | surface |
| U-mode | `current_mode_update` | tracker no-op; handler elsewhere | `planMode` | `ok` | protocol |
| U-usage | `usage_update` | handler (not tracker) | `usage` | `partial` (live turns often skip this; Desktop also polls `session/info`) | protocol |
| U-info | `session_info_update` | tracker `_` | title / modelId | `ok` | surface |

xAI tags TUI `session_notification.rs` handles (Desktop reducer `_` unless noted):

| Id | Tag | Desktop | Status | Must |
|---|---|---|---|---|
| U-goal | `goal_updated` | `reduceGoalUpdate` | `ok` | surface |
| U-sub-s | `subagent_spawned` | dropped | `gap` | surface |
| U-sub-p | `subagent_progress` | dropped | `gap` | surface |
| U-sub-f | `subagent_finished` | dropped | `gap` | surface |
| U-turn | `turn_completed` | dropped (Desktop uses prompt RPC) | `partial` | protocol |
| U-wf | `workflow_updated` | dropped | `gap` | surface |
| U-hook* | `hook_annotation` / `hook_run_started` / `hook_execution` / `hooks_changed` | dropped | `gap` | surface |
| U-plug | `plugins_changed` | dropped | `gap` | surface |
| U-memf | `memory_files` | dropped | `gap` | surface |
| U-ac* | `auto_compact_*` | dropped | `gap` | surface |
| U-recap | `session_recap` / `session_recap_unavailable` / `last_turn_summary` / `session_summary_generated` | dropped | `gap` | surface |
| U-model | `model_changed` / `model_auto_switched` | dropped (`models/update` covers catalog) | `partial` | protocol |
| U-status | `session_status` | dropped | `na` | chrome |
| U-planx | `plan_kept` / `plan_cleared` / `plan_executing` | dropped | `partial` | surface |
| U-ix | `interaction_resolved` | dropped | `gap` | protocol |
| U-misc | `retry_state`, `image_*`, `tool_call_delta_chunk`, `memory_*` (flush/dream/capture) | dropped | `partial` | chrome |

xAI tags TUI also ignores (`session_notification` `_`): `diff_review`, `memory_flush_started`, `memory_dream_queued`, `memory_dream_started`, `auto_continue_completed`, `feedback_request`, `relay_sync_status`, `auto_recovery_*`, `plugin_updates_installed`, `compaction_checkpoint`, `rewind_marker`, `background_tasks`, `pending_interaction`, `response_started`, `reasoning_completed`, `response_completed`. Desktop: same drop. Must `na` / `chrome` unless a later surface needs them.

---

## 5. Client → agent `x.ai/*`

Agent match: `acp_agent.rs` L1966–2342. Desktop wrappers: `xai.ts`, `extensions.ts`, `providers.ts`, `client.ts`. Tauri host intercepts some provider/model writes (not the agent).

`host.ts` `wireMethod` prefixes C→A `x.ai/*` as `_x.ai/…`. Bare `x.ai/…` is class E (`-32601`). Already handled; do not “fix” twice.

### 5.1 Session

| Id | Wire | Dir | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|---|
| C-sess-info | `x.ai/session/info` | C→A | `/session-info`, `/context` | `xai.ts` `sessionInfo`; `/context`; usage chip | `ok` | surface |
| C-sess-list | `x.ai/session/list` / `x.ai/sessions/list` | C→A | `/resume` | `xai.ts` `listSessions`; sidebar | `ok` | surface |
| C-sess-hist | `x.ai/session/load_history` | C→A | resume replay | wrapper only | `gap` | surface |
| C-sess-ren | `x.ai/session/rename` | C→A | `/rename` | sidebar | `ok` | surface |
| C-sess-del | `x.ai/session/delete` | C→A | `/delete` | sidebar | `ok` | surface |
| C-sess-fork | `x.ai/session/fork` | C→A | `/fork` | wrapper only | `gap` | surface |
| C-sess-close | `x.ai/session/close` | C→A | quit/home | — | `gap` | chrome |
| C-sess-search | `x.ai/session/search` | C→A | resume search | sidebar query on `list` | `partial` | surface |
| C-sess-usage | `x.ai/session/usage` | C→A | `/usage` | — | `gap` | surface |
| C-sess-upd | `x.ai/session/updates` | C→A | reconnect | — | `gap` | protocol |
| C-sess-state | `x.ai/session/state` / `import` / `repair` | C→A | debug/import | — | `na` | chrome |
| C-plans | `x.ai/session/plans` / `plans/delete` | C→A | `/view-plan` shows the current episode only | `plan-files.ts`; header plan list (`plan-chip.tsx`) shows each episode's H1 `title`, with Copy / Copy file path / Delete | `ok` | surface |
| C-sess-del-all | `x.ai/sessions/delete_all` | C→A | — (delete one session at a time) | Settings → Data Controls (`data-controls.tsx`), behind a confirmation | `gap` in the TUI, `ok` on the desktop | surface |
| C-sess-mcp | `x.ai/session/update_mcp_servers` | C→A | MCP modal | — (uses `x.ai/mcp/*`) | `partial` | protocol |
| C-sess-wt | `x.ai/session/resolve_local_for_worktree_resume` / `rehydrate` | C→A | worktree resume | — | `na` | chrome |
| C-sess-sum | `x.ai/session_summaries/*` | C→A | dashboard roster | — | `na` | chrome |
| C-ws | `x.ai/workspaces/list` | C→A | welcome | — | `na` | chrome |
| C-local-ws | `x.ai/session/add_local_workspace` | C→A | `local-workspace` feature | — | `na` | out |

### 5.2 Models / providers

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-mod-list | `x.ai/models/list` | `/model` | `xai.ts` `listModels` | `ok` | surface |
| C-mod-def | `x.ai/models/set_default` | settings | Tauri `desktop_model_set_default`; ACP fallback | `ok` | surface |
| C-mod-up | `x.ai/models/upsert` | — | **Tauri** `desktop_model_upsert`. **Not** in agent `ext_method` | `ok` (host) | surface |
| C-mod-del | `x.ai/models/delete` | — | **Tauri** `desktop_model_delete`. **Not** in agent `ext_method` | `ok` (host) | surface |
| C-prov-list | `x.ai/providers/list` | — | Tauri `desktop_provider_list`; ACP fallback | `ok` | surface |
| C-prov-pre | `x.ai/providers/presets` | — | `providers.ts` | `ok` | surface |
| C-prov-up | `x.ai/providers/upsert` | — | Tauri + ACP fallback | `ok` | surface |
| C-prov-del | `x.ai/providers/delete` | — | Tauri + ACP fallback | `ok` | surface |
| C-prov-test | `x.ai/providers/test` | — | always ACP | `ok` | surface |
| C-prov-disc | `x.ai/providers/discover_models` | — | always ACP | `ok` | surface |
| C-prov-probe | `x.ai/providers/probe_models` | — | **Tauri only** (`desktop_provider_models`). **Not** an agent method | `ok` (host) | surface |

### 5.3 Commands / permissions / plan / queue

| Id | Wire | Dir | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|---|
| C-cmd | `x.ai/commands/list` | C→A | slash menu | `xai.ts` `listCommands` | `ok` | surface |
| C-yolo | `x.ai/yolo_mode_changed` | C→A notif | `/always-approve` | `client.ts` `setYolo` | `ok` | protocol |
| C-perm | `x.ai/permissions/reset` | C→A **notif** on agent | settings | `xai.ts` `resetPermissions` via **`request`** (Settings General). Agent handles it as `ext_notification` | `partial` | surface |
| C-toggle-plan | `x.ai/toggle_plan_mode` | C→A notif | legacy | Desktop uses `session/set_mode` | `na` | protocol |
| C-q-rm | `x.ai/queue/remove` | C→A notif | queue pane | — | `gap` | surface |
| C-q-re | `x.ai/queue/reorder` | C→A notif | queue pane | — | `gap` | surface |
| C-q-cl | `x.ai/queue/clear` | C→A notif | queue pane | — | `gap` | surface |
| C-q-ed | `x.ai/queue/edit` / `hold_edit` / `release_edit` | C→A notif | queue pane | — | `gap` | surface |
| C-q-in | `x.ai/queue/interject` | C→A notif | `/btw` / queue | — | `gap` | surface |

Desktop queues a second `session/prompt` (`queuePrompt`). That is not the TUI queue protocol.

### 5.4 Memory / compact

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-mem-f | `x.ai/memory/flush` | `/flush` | Settings Memory | `ok` | surface |
| C-mem-r | `x.ai/memory/rewrite` | — | Settings Memory | `ok` | surface |
| C-mem-g | `x.ai/memory/forget` | — | Settings Memory | `ok` | surface |
| C-compact | `x.ai/compact_conversation` | `/compact` (pager + agent) | forwarded as prompt only | `ok-prompt` / `partial` (no compact UI) | surface |

`/memory` browser is §9 / §12 (`memory_files` notif). Settings buttons are not that browser.

### 5.5 Skills / workflows / plugins / marketplace / hooks

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-sk-list | `x.ai/skills/list` | `/skills` | Settings Skills, topic groups (Game / Documents / …) with Project / User / Plugin wrappers when mixed | `ok` | surface |
| C-sk-tog | `x.ai/skills/toggle` | modal | Settings toggle, persists `[skills].disabled`; group switch fans out sequential `{ name, enabled, cwd }` calls | `ok` | surface |
| C-sk-add | `x.ai/skills/add` / `remove` / `reset` / `config` | modal | Settings Skills add/remove/reset/config | `ok` (`refresh-baseline` still `gap`) | surface |
| C-wf-list | `x.ai/workflows/list` | `/workflows` | Settings Skills workflow list (browse-only) | `partial` | surface |
| C-pl-list | `x.ai/plugins/list` | `/plugins` | Settings list with enable/disable | `ok` | surface |
| C-pl-act | `x.ai/plugins/action` | modal | Settings enable/disable | `ok` (install/uninstall/update still CLI) | surface |
| C-pl-nt | `x.ai/plugins/notify-updates` | modal | — | `gap` | chrome |
| C-pl-rel | `x.ai/plugins/reload` | `/plugins reload` | Settings Reload plugins | `ok` | surface |
| C-mkt | `x.ai/marketplace/list` / `action` | `/marketplace` | — | `gap` | surface |
| C-hk-list | `x.ai/hooks/list` | `/hooks` | — | `gap` | surface |
| C-hk-act | `x.ai/hooks/action` | modal | — | `gap` | surface |

### 5.6 MCP prefix (`x.ai/mcp/*`)

Constants: `extensions/mcp.rs` `mcp_methods` + `xai-grok-mcp/src/wire.rs`.

| Id | Wire | Dir | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|---|
| C-mcp-list | `x.ai/mcp/list` | C→A | `/mcps` | `extensions.ts` Connectors, uncached first read so `session.tools` is annotated | `ok` | surface |
| C-mcp-tog | `x.ai/mcp/toggle` | C→A | modal | Connectors per-connector header switch (`displayName` title); Managed / Plugin / Local are captions only | `ok` | surface |
| C-mcp-up | `x.ai/mcp/upsert` | C→A | modal | Connectors add (stdio + HTTP) | `ok` | surface |
| C-mcp-del | `x.ai/mcp/delete` | C→A | modal | Connectors delete (local servers only) | `ok` | surface |
| C-mcp-tool | `x.ai/mcp/toggle_tool` | C→A | modal | Connectors per-tool switch | `ok` | surface |
| C-mcp-auth | `x.ai/mcp/auth_status` / `auth_trigger` / `setup` | C→A | connectors UI | Connectors auth status / authenticate / setup form | `ok` | surface |
| C-mcp-res | `x.ai/mcp/read_resource` | C→A | debug | — | `na` | chrome |
| C-mcp-call | `x.ai/mcp/call` | C→A | debug / outside LLM loop | — | `na` | chrome |
| C-mcp-sdk | `x.ai/mcp/sdk_call` | A→C | see R-sdk | see R-sdk | `gap` | protocol |
| C-mcp-elicit | `x.ai/mcp/elicit` | A→C | see R-elicit | see R-elicit | `partial` | protocol |

### 5.7 Tasks / scheduler / subagent

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-task-list | `x.ai/task/list` | dock / `/tasks` | — | `gap` | surface |
| C-task-kill | `x.ai/task/kill` | dock | — | `gap` | surface |
| C-sched-del | `x.ai/scheduler/delete` | `/loop` cancel | — | `gap` | surface |
| C-sub-msg | `x.ai/subagent/message` | dock reply | — | `gap` | surface |
| C-sub-can | `x.ai/subagent/cancel` | dock | — | `gap` | surface |
| C-sub-get | `x.ai/subagent/get` | dock | — | `gap` | surface |
| C-sub-run | `x.ai/subagent/list_running` | dashboard | — | `gap` | surface |

Scheduler **create** is the `scheduler_create` tool / `/loop`, not a C→A `x.ai/scheduler/create`.

### 5.8 Terminal prefix (`x.ai/terminal/*`)

C→A (client asks the **agent** for a PTY). Distinct from ACP `terminal/*` (agent asks the **client**).

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-term-* | `create` / `kill` / `output` / `wait_for_exit` / `release` / `background` / `list` | TUI terminal | host stubs `x.ai/terminal/create` and catch-all `x.ai/terminal/*` → `{}` | `stub` | protocol |
| C-pty | `pty/create` / `load` / `resize` | TUI PTY | same stub `{}` | `stub` | protocol |
| C-pty-in | `x.ai/terminal/pty/input` | C→A **notif** | — | `gap` | protocol |

### 5.9 FS prefix (`x.ai/fs/*`) — client → agent

Not ACP `fs/*`. Settings project files use three of five.

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-fs-read | `x.ai/fs/read_file` | various | Settings project files | `ok` | surface |
| C-fs-write | `x.ai/fs/write_file` | various | Settings project files | `ok` | surface |
| C-fs-ex | `x.ai/fs/exists` | various | wrapper only | `partial` | surface |
| C-fs-list | `x.ai/fs/list` | file UI | — (Files panel is Tauri) | `na` | chrome |
| C-fs-del | `x.ai/fs/delete_file` | file UI | — | `gap` | surface |

### 5.10 Search, code-nav, git, worktree, hunk-tracker, PR, bundle, debug, rewind, recap, feedback, share

| Id | Prefix / method | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-search | `x.ai/search/fuzzy/{open,change,close}`, `x.ai/search/content` | `/find` | — | `na` | chrome |
| C-code | `x.ai/code/goto-definition` / `goto-references` / `find-definitions` / `find-references` / `status` | IDE | — | `na` | chrome |
| C-git | `x.ai/git/{git_repo_root,serialize_changes,status,files,diffs,stage,stage/content,unstage,discard,commit,checkout,stash,info,branches,current_commit,checkout_session_head,checkout_commit}` | git UI | Review panel is **Tauri** `loadWorkspaceReview`, not these methods | `na` | chrome |
| C-wt | `x.ai/git/worktree/*` (create, remove, apply, create_from_worktree{,_sync}, resume_session, list, show, gc, db/{stats,rebuild,path}, detach, salvage, clean-artifacts) | worktrees | — | `na` | chrome |
| C-hunk | `x.ai/hunk-tracker/{get-hunks,get-files,get-all-file-contents,get-summary,hunk-action,file-action,turn-action,all-action}` | hunk cap | — | `na` | chrome |
| C-pr | `x.ai/pr/status` | — | — | `na` | chrome |
| C-bundle | `x.ai/bundle/{sync,status,entry/get}` | bundle | — | `out` | out |
| C-debug | `x.ai/debug/{trigger_feedback,arm_auto_compact,agent}` | debug builds | — | `na` | chrome |
| C-rew | `x.ai/rewind/execute` / `x.ai/rewind/points` | `/rewind` | — | `gap` | surface |
| C-recap | `x.ai/recap` | `/recap` | — | `gap` | surface |
| C-fb | `x.ai/feedback` + `dismiss` + `drafts/{list,get,delete,update}` + `upload-trace` | `/feedback` | — | `gap` | surface |
| C-btw | `x.ai/btw` | `/btw` | — | `gap` | surface |
| C-review | `x.ai/review/comment` / `comment/delete` | plan comments (TUI) | plan dialog is local to `exit_plan_mode` body | `partial` | surface |
| C-share | `x.ai/share_session` | `/share` | — | `out` | out |
| C-ph | `x.ai/prompt_history` | `/history` | — | `gap` | chrome |
| C-sug | `x.ai/suggest` / `suggestPrompt` | suggest | — | `na` | chrome |
| C-inj | `x.ai/interject` | interject | — | `gap` | surface |

### 5.11 Auth / cloud / privacy / internal

| Id | Wire | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| C-auth-info | `x.ai/auth/info` | `/login` | `app-shell.tsx`, Settings providers | `ok` | surface |
| C-auth-out | `x.ai/auth/logout` | `/logout` | mock only | `gap` | surface |
| C-auth-url | `x.ai/auth/get_url` / `submit_code` / `cancel` / `getBearerToken` / `check_subscription` | login | — | `partial` | surface |
| C-getkey | `x.ai/getApiKey` | legacy | **must not call for BYOK** | `na` | protocol |
| C-setkey | `x.ai/setApiKey` | xAI session key | **must not call for BYOK** (Tauri writes `[model_providers.*]`) | `na` | protocol |
| C-cloud | `x.ai/cloud/terminate`, `x.ai/cloud/env/{list,create,update,delete}` | sandbox | — | `out` | out |
| C-priv | `x.ai/privacy/setCodingDataRetention` | `/privacy` | — | `out` | out |
| C-cons | `x.ai/consent/record` | consent | — | `out` | out |
| C-roll | `x.ai/rollout/survey` | survey | — | `out` | out |
| C-int | `x.ai/internal/*` | leader | — | `out` | out |
| C-tel | `x.ai/telemetry/*`, `x.ai/log` | telemetry | — | `out` | out |

---

## 6. Builtin tools (agent-side, Desktop presents)

Desktop does not implement tools. It must (a) not break the reverse channel a tool needs, (b) paint the tool row (`tui-presentation.md` §7). `ok` only if **both** presentation and dependencies work.

Internal kinds: `crates/codegen/xai-grok-tools/src/types/tool.rs` `ToolKind`. TUI picks a renderer in `tracker.rs` `tool_call_to_block` → `scrollback/blocks/tool/*`. Desktop `tool-card.tsx` is string/regex on `kind`/`title` (no `ToolKind` import).

| Id | ToolKind | TUI renderer | Desktop card | Reverse / notif deps | Status | Must |
|---|---|---|---|---|---|---|
| T-read | `Read` | `tool/read.rs` | path header + content | — | `ok` | surface |
| T-edit | `Edit` | `tool/edit.rs` (diff hunks) | generic + markdown/diff content | — | `partial` (no TUI hunk highlight) | surface |
| T-write | `Write` | edit.rs `"Creating "` | `Creating {path}`, body opened while it fits the chat frame | ACP fs for plan.md | `ok` | surface |
| T-del | `Delete` | `other.rs` | generic | — | `ok` | surface |
| T-move | `Move` | `other.rs` | generic | — | `ok` | surface |
| T-list | `ListDir` / `List` | `list_dir.rs` | `List {path}` | — | `ok` | surface |
| T-search | `Search` | `search.rs` | search icon | — | `ok` | surface |
| T-lsp | `Lsp` | `other.rs` | generic | code-nav cap | `na` | chrome |
| T-exec | `Execute` | `execute.rs` | `$ {command}` | H-term if agent uses ACP terminal; `incrementalBashOutput` / `bashOutputNoColor` | `partial` | surface |
| T-plan | `Plan` | todo overlay | todo overlay (hidden by default) | U-plan | `ok` | surface |
| T-web-s | `WebSearch` | `web_search.rs` | globe | — | `ok` | surface |
| T-web-f | `WebFetch` | `web_fetch.rs` | globe | — | `ok` | surface |
| T-bg | `BackgroundTaskAction` | dock | — | N-tbg / N-tdone | `gap` | surface |
| T-wait | `WaitTasksAction` | dock | — | N-tdone | `gap` | surface |
| T-kill | `KillTaskAction` | dock | — | C-task-kill | `gap` | surface |
| T-skill | `Skill` | `other.rs` Skill | verb-group `skill` | C-sk-list | `partial` | surface |
| T-mems | `MemorySearch` | `memory_search.rs` | verb-group | — | `ok` | surface |
| T-memg | `MemoryGet` | `other.rs` | generic | — | `ok` | surface |
| T-task | `Task` | subagent rows | verb-group `subagent`/`task` | U-sub-*, C-sub-* | `gap` | surface |
| T-msg | `ActiveAgentMessage` | `sent_message.rs` | — | C-sub-msg | `gap` | surface |
| T-enter | `EnterPlan` | plan chrome | `/plan` + mode | ACP-mode | `ok` | surface |
| T-exit | `ExitPlan` | plan review | R-plan | R-plan | `ok` | protocol |
| T-ask | `AskUser` | question card | R-ask | R-ask | `ok` | protocol |
| T-img | `ImageGen` | `other.rs` media | generic | — | `ok` | surface |
| T-vid | `VideoGen` / `ImageToVideo` / `ReferenceToVideo` | media | generic | — | `ok` | surface |
| T-app | `DeployApp` / `InitOrUpdateApp` | `other.rs` | generic | `out` if xAI cloud | `na` | out |
| T-st | `SearchTool` | `search_tool.rs` | verb-group | MCP notifs | `partial` | surface |
| T-use | `UseTool` | `use_tool.rs` | generic | MCP notifs / R-elicit / R-sdk | `partial` | surface |
| T-mon | `Monitor` | monitor rows | — | N-mon | `gap` | surface |
| T-goal | `GoalUpdate` | goal meter | goal meter (`goal_updated`) | U-goal | `ok` | surface |
| T-wf | `Workflow` | workflow runs | — | U-wf | `gap` | surface |
| T-fb | `Feedback` | `/feedback` | generic | C-fb | `gap` | surface |
| T-other | `Other` | `other.rs` | title fallback `"Tool"` | — | `ok` | surface |

---

## 7. MCP

Ties handshake + reverse + notifs + Settings.

| Id | Path | Status | Must |
|---|---|---|---|
| MCP-agent | Agent-hosted servers (`config.toml` / `x.ai/mcp/upsert`). Desktop Settings list/toggle/add (`extensions.ts`, `connectors.tsx`) | `ok` — `N-mcp-*` consumed; a payload not yet session-annotated keeps the tools already listed | surface |
| MCP-auth | `auth_status` / `auth_trigger` / `setup`. Connectors status / authenticate / setup form | `ok` | surface |
| MCP-sdk | `session/new` `_meta["x.ai/mcp/servers"]` + reverse `x.ai/mcp/sdk_call`. Desktop: empty servers + `-32601` | `gap` and **unsafe to enable** | protocol |
| MCP-call | `x.ai/mcp/call` outside the LLM loop | `na` | chrome |
| MCP-elicit | Modal exists; `elicit_complete` ignored | `partial` | protocol |
| MCP-empty | `mcpServers: []` on every new/load | `partial` (class F for SDK; agent-side config may still attach) | protocol |

---

## 8. Skills, plugins, workflows, hooks

| Id | Item | TUI | Desktop | Status | Must |
|---|---|---|---|---|---|
| SK-disc | Discovery: `x.ai/skills/list`, slash names from `available_commands_update`, `SKILL.md` as `Skill` rows | modal + slash | Settings Skills list grouped by source + search + toggle, `cwd` always sent; slash `ok-prompt` for invocable skills | `ok` | surface |
| SK-mut | add/remove/config/reset/refresh-baseline | modal | add/remove/config/reset in Settings Skills | `partial` (`refresh-baseline` still `gap`) | surface |
| PL-list | `x.ai/plugins/list` | `/plugins` | Settings list with enable/disable | `ok` | surface |
| PL-act | `action` / `notify-updates` / `reload` | modal | enable/disable + reload in Settings Skills | `partial` (install/uninstall/update, notify-updates still `gap`) | surface |
| WF-list | `x.ai/workflows/list`, `/workflow`, `ToolKind::Workflow` | `/workflows` + runs pane | `/workflow` as prompt only; no runs surface | `gap` | surface |
| HK | Client `_meta["x.ai/hooks"]`, `x.ai/hooks/{list,action,run}` | `/hooks` modal; does **not** register client hooks on `session/new` | **gap** | surface |

User-guide: `08-skills.md`, `09-plugins.md`, `10-hooks.md`.

---

## 9. Slash commands

Three sources, one table. Desktop `CLIENT_COMMANDS` are the only client handlers; everything else in the menu is forwarded as a prompt (`slash-commands.ts`).

**Status here:** `ok` (client handler), `ok-prompt` (forwarded and the agent does it), `gap` (TUI surface missing), `chrome` (TUI-only paint).

### 9.1 Desktop `CLIENT_COMMANDS`

`frontend/apps/let-cook/src/ui/chat/slash-commands.ts`

| Id | Command | Aliases | Status | Must |
|---|---|---|---|---|
| SL-plan | `/plan` | — | `ok` | surface |
| SL-model | `/model` | — | `ok` | surface |
| SL-new | `/new` | — | `ok` | surface |
| SL-ctx | `/context` | — | `ok` | surface |
| SL-yolo | `/always-approve` | — | `ok` | surface |
| SL-vplan | `/view-plan` | `show-plan`, `plan-view` | `ok` | surface |

### 9.2 Pager builtins

Registry: `slash/commands/mod.rs` `builtin_commands()` (72 objects). Shell ACP names blocked from the catalog: `help`, `hooks-*`, `reload-plugins`.

| Command | Aliases | Desktop | Status | Must |
|---|---|---|---|---|
| `/tutorial` | `tour`, `onboarding` | — | `chrome` | chrome |
| `/settings` | `config`, `preferences`, `prefs` | Settings panel (not this slash) | `ok` (UI) / `gap` (slash) | surface |
| `/dashboard` | `agents-dashboard`, `sessions` | — | `gap` | surface |
| `/workflows` | — | — | `gap` | surface |
| `/plugins` | `plugin` | Settings list | `partial` | surface |
| `/btw` | — | — | `gap` | surface |
| `/voice` | — | — | `na` | chrome |
| `/new` | — | client | `ok` | surface |
| `/effort` | — | forwarded | `ok-prompt` | surface |
| `/model` | `m` | client | `ok` | surface |
| `/context` | — | client | `ok` | surface |
| `/clear` | — | — | `chrome` | chrome |
| `/compact` | — | forwarded (agent half) | `ok-prompt` | surface |
| `/fork` | — | wrapper, no UI | `gap` | surface |
| `/resume` | — | sidebar, no picker slash | `partial` | surface |
| `/loop` | — | forwarded | `ok-prompt` | surface |
| `/plan` | — | client | `ok` | surface |
| `/view-plan` | `show-plan`, `plan-view` | client | `ok` | surface |
| `/remember` | — | forwarded | `ok-prompt` | surface |
| `/recap` | `summarize` | — | `gap` | surface |
| `/rewind` | `undo` | — | `gap` | surface |
| `/jump` | — | — | `chrome` | chrome |
| `/expand` | — | — | `chrome` | chrome |
| `/edit-prompt` | — | — | `chrome` | chrome |
| `/queue` | — | stacked `session/prompt` | `partial` | surface |
| `/session-info` | user-guide `status`/`info` are **agent** aliases | `/context` subset | `partial` | surface |
| `/share` | — | — | `out` | out |
| `/rename` | `title` | sidebar | `ok` | surface |
| `/history` | — | — | `chrome` | chrome |
| `/transcript` | `log` | — | `chrome` | chrome |
| `/export` | — | — | `gap` | surface |
| `/copy` | — | copy actions exist | `partial` | chrome |
| `/find` | — | — | `chrome` | chrome |
| `/usage` | `cost` | — | `gap` | surface |
| `/tasks` | — | — | `gap` | surface |
| `/skills` | — | Settings | `partial` | surface |
| `/mcps` | — | Settings Connectors | `partial` | surface |
| `/hooks` | — | — | `gap` | surface |
| `/marketplace` | — | — | `gap` | surface |
| `/workflow` | — | forwarded | `ok-prompt` (no runs pane) | surface |
| `/personas` | — | — | `na` | chrome |
| `/config-agents` | `agents` | — | `na` | chrome |
| `/theme` | `t` | — | `chrome` | chrome |
| `/auto` | — | — | `gap` | surface |
| `/always-approve` | — | client | `ok` | surface |
| `/vim-mode` | — | — | `chrome` | chrome |
| `/multiline` | `ml` | Enter vs Shift+Enter is web-native | `chrome` | chrome |
| `/compact-mode` | — | — | `chrome` | chrome |
| `/timestamps` | — | — | `chrome` | chrome |
| `/toggle-mouse-reporting` | — | — | `chrome` | chrome |
| `/minimal` / `/fullscreen` | `full` | — | `chrome` | chrome |
| `/timeline` | — | — | `chrome` | chrome |
| `/cd` | — | folder picker | `chrome` | chrome |
| `/imagine` | — | forwarded | `ok-prompt` | surface |
| `/imagine-video` | — | forwarded | `ok-prompt` | surface |
| `/docs` | `howto`, `guides` | — | `chrome` | chrome |
| `/release-notes` | `changelog` | — | `chrome` | chrome |
| `/announcements` | — | — | `na` | chrome |
| `/feedback` | — | forwarded | `ok-prompt` / `gap` (no form/drafts) | surface |
| `/privacy` | — | — | `out` | out |
| `/doctor` | `terminal-setup`, `terminal-check`, `terminal-info` | — | `chrome` | chrome |
| `/import-claude` | — | — | `na` | chrome |
| `/login` | — | provider connect | `partial` | surface |
| `/logout` | — | — | `gap` | surface |
| `/home` | `welcome` | — | `chrome` | chrome |
| `/delete` | — | sidebar | `ok` | surface |
| `/help` | — | — | `chrome` | chrome |
| `/quit` | `exit` | window close | `chrome` | chrome |
| `/gboom` | hidden | — | `na` | chrome |
| `/scroll-debug` | hidden | — | `na` | chrome |
| `/debug` | debug builds | — | `na` | chrome |

### 9.3 Shell builtins (`InitializeResponse.meta.availableCommands` + `x.ai/commands/list`)

`slash_commands.rs` `BUILTIN_COMMANDS` + `PROMPT_COMMANDS` + skill/workflow names.

| Command | Gate | Desktop | Status | Must |
|---|---|---|---|---|
| `/compact` | always | forwarded | `ok-prompt` | surface |
| `/always-approve` (`yolo`) | always | client (not agent) | `ok` | surface |
| `/flush` | memory | Settings + forwarded | `ok` | surface |
| `/dream` | memory | forwarded | `ok-prompt` | surface |
| `/memory` (`mem`) | memory configured | Settings actions ≠ browser | `gap` | surface |
| `/context` | always | client | `ok` | surface |
| `/hooks-trust` `/hooks-list` `/hooks-add` `/hooks-remove` `/hooks-untrust` | hooks | pager folds into `/hooks` | `gap` | surface |
| `/plugins` | plugins | Settings list | `partial` | surface |
| `/reload-plugins` | plugins | — | `gap` | surface |
| `/session-info` (`status`, `info`) | always | `/context` subset | `partial` | surface |
| `/feedback` | feedback | forwarded | `ok-prompt` | surface |
| `/deep-research` | workflows | forwarded | `ok-prompt` | surface |
| `/workflow` | workflows | forwarded | `ok-prompt` | surface |
| `/goal` | goal | forwarded; goal meter exists | `ok-prompt` | surface |
| `/loop` | scheduler | forwarded | `ok-prompt` | surface |
| skill names (`user-invocable`) | catalog | forwarded | `ok-prompt` | surface |
| workflow names | catalog | forwarded | `ok-prompt` | surface |

---

## 10. Tasks, subagents, scheduler, monitor, dashboard

TUI: dock + dashboard (`16-subagents.md`, `20-background-tasks.md`, `23-dashboard.md`) driven by `x.ai/task/*`, `x.ai/subagent/*`, `x.ai/scheduler/*`, and §4 notifs.

Desktop: **no dock, no dashboard, notifs ignored**. Status is `surface`, not `chrome` — Desktop must be able to *use* what TUI uses. A first Desktop surface can be a compact panel, not a pixel clone of the TUI dock.

| Id | Item | Status | Must |
|---|---|---|---|
| TK-dock | background tasks + N-tbg / N-tdone | `gap` | surface |
| TK-sub | subagent spawn/progress/finish + C-sub-* | `gap` | surface |
| TK-sched | `/loop` + scheduler notifs | `gap` (create via prompt may work; no list/cancel UI) | surface |
| TK-mon | `x.ai/monitor_event` | `gap` | surface |
| TK-dash | `/dashboard` | `gap` | surface |

---

## 11. Terminal

Three channels:

| Channel | Who implements | Desktop today |
|---|---|---|
| ACP `terminal/*` | **client** (agent thinks a PTY exists iff `clientCapabilities.terminal`) | advertised `true`, **stub** (H-term) |
| `x.ai/terminal/*` | **agent** (client asks the agent for a PTY) | host catch-all stub `{}` |
| `Execute` / bash | **agent** (no client PTY required) | tool row `ok`/`partial`; ANSI if cap missing |

TUI: default `terminal: false`. `--terminal` still **rejects** `WaitForTerminalExit` honestly.

**Recommendation:** until a real PTY exists, **stop advertising** `terminal: true` (do not lie on the wire).

---

## 12. Memory, compact, rewind

| Id | Item | Desktop | Status | Must |
|---|---|---|---|---|
| MEM-btn | Settings `flush` / `rewrite` / `forget` | `context-panels.tsx` | `ok` | surface |
| MEM-ui | TUI `/memory` browser (`memory_files` notif) | — | `gap` | surface |
| MEM-slash | `/flush` `/dream` `/remember` | prompt / Settings | `ok` / `ok-prompt` | surface |
| MEM-compact | `/compact` + `x.ai/compact_conversation` + auto-compact tags | prompt only | `partial` | surface |
| MEM-rew | `/rewind` + `x.ai/rewind/{points,execute}` | — | `gap` | surface |

---

## 13. Auth, providers, models

Healthiest Desktop slice. Map still lists the `setApiKey` landmine.

| Id | Item | Status | Must |
|---|---|---|---|
| A-info | `x.ai/auth/info` | `ok` | surface |
| A-byok | `x.ai/providers/*` + Tauri config writes | `ok` | surface |
| A-models | `x.ai/models/list` + `set_default` + host upsert/delete | `ok` | surface |
| A-setkey | `x.ai/setApiKey` | **do not call for BYOK** (`desktop-app-implement.md` §3.1) | protocol |
| A-getkey | `x.ai/getApiKey` | unused | `na` | protocol |
| A-login | ACP `authenticate` / device-code | `partial` | surface |

---

## 14. Plan and goal

Wire is mostly `ok` on this branch. Presentation issues stay in the Chat UI plan.

| Id | Item | Status | Must |
|---|---|---|---|
| P-mode | `session/set_mode` | `ok` | protocol |
| P-list | `x.ai/session/plans` | header plan list, current episode marked, per-row Copy / Copy file path / Delete | surface |
| P-del | `x.ai/session/plans/delete` | deletes one plan file; a running plan-mode episode or active/paused goal contract is refused agent-side | surface |
| P-acp | ACP `plan` / `plan_update` / `plan_removed` | `ok` | protocol |
| P-exit | `x.ai/exit_plan_mode` | `ok` | protocol |
| P-goal | `goal_updated` on `x.ai/session_notification` | `ok` | surface |
| P-slash | `/plan` `/view-plan` `/goal` | `ok` / `ok-prompt` | surface |

A session's plan files are removed with the session: Settings → Data Controls (`x.ai/sessions/delete_all`) deletes every local session directory, and each directory carries its `plans/` and `plan_mode.json`.

---

## 15. Filesystem

Two channels:

| Channel | Direction | Desktop | Status |
|---|---|---|---|
| ACP `fs/read_text_file` / `write_text_file` | A→C | host, cwd + sessions-root allow-path | `ok` |
| `x.ai/fs/{read_file,write_file,exists}` | C→A | Settings project files (`exists` unused) | `ok` / `partial` |
| `x.ai/fs/{list,delete_file}` | C→A | missing | `gap` / `na` (Files panel is Tauri) |

**Invariant:** listed plan contracts live under the agent session store, outside the workspace: `<session>/plan.md` is legacy-only; plan-mode and goal-plan episodes use `<session>/plans/<utc>.md`, published to `<slug>-<utc>.md`. Goal execution does not activate plan mode. `<session>/goal/plan.baseline.md` is private verifier state, never a C-plans row. ACP-fs-w must keep the session-store allow-path (`acp_host.rs` `agent_state_root`).

---

## 16. Error classes (so field failures are diagnosable)

| Class | Symptom | Typical cause | Example |
|---|---|---|---|
| **A** | Turn fails / tool error `Method not found` | reverse request `-32601` | `client.ts` `handleMessage` L429–432; R-sdk if SDK MCP is enabled |
| **B** | UI stale (MCP tools, tasks, queue) | ignored notif | `console.debug("Ignored ACP notification: …")`; Connectors without `servers_updated` |
| **C** | Agent behaves as if a feature exists | advertised cap + stub | `terminal: true` + `acp_host.rs` fake `exitCode: 0` |
| **D** | Feature missing from menu | pager-only slash, no Desktop surface | `/dashboard`, `/rewind`, `/memory` browser |
| **E** | Envelope miss | `x.ai/` vs `_x.ai/` | `host.ts` `wireMethod` — **already handled**; do not “fix” twice |
| **F** | Empty `mcpServers` | SDK MCP never attached | `client.ts` `newSession` / `loadSession` `mcpServers: []` |

---

## 17. After the map: implementation order (pointer only)

Do not implement in the map PR. Cite row ids. The fold onto the architecture
contract is sequenced in
[`desktop-app-client-implement.md`](desktop-app-client-implement.md):

1. **Stop class C and class A** (client-implement **C1–C2**). Honest
   `initialize` caps (H-term: `terminal: false`). Unknown reverse policy
   (§3.2). Implement R-sdk **only if** we send MCP SDK servers (H-mcp).
2. **Consume the notifs Settings and Chat already need** (**C3**):
   N-pcomplete, N-mcp-srv / N-mcp-tools / N-mcp-init / N-mcp-elic, N-queue,
   N-tdone.
3. **Surfaces** (production / later PRs, **registry entry required**):
   MEM-rew, TK-* compact panel, remaining slash `ok-prompt` vs `gap` (§9).
4. **Terminal:** real PTY **or** `terminal: false` (keep H-term closed).

Chat UI rebuild stays a separate track (presentation). This map is the protocol track.
