# Let Cook — Architecture

This is the engineer-facing map of the desktop app: what the pieces are, how
they fit, and **where to go to change, fix, or implement something**. It is
written for an AI agent or a human opening `frontend/apps/let-cook/` cold.

Paths below are relative to this directory unless they start with `docs/` or
`crates/`.

Let Cook is a chat-first ACP client. It runs `cook agent stdio`, shares
`~/.cook` with the CLI, and paints what that agent sends. Sampling, tools,
and the canonical session record stay in the agent.

| Doc | Role |
|---|---|
| This file | Module map — where to edit |
| [`docs/desktop-app.md`](../../../docs/desktop-app.md) | Contract: product boundary, capability honesty, inbound routing, host roles |
| [`docs/desktop-tui-capability-map.md`](../../../docs/desktop-tui-capability-map.md) | Which ACP / `x.ai/*` methods the running app speaks (cite row ids) |
| [`docs/desktop-app-client-implement.md`](../../../docs/desktop-app-client-implement.md) | Remaining client-fold plan. Where it disagrees with this file or `src/acp/handshake.ts`, those win |
| [`docs/desktop-app-implement.md`](../../../docs/desktop-app-implement.md) | Production product plan |
| [`docs/tui-presentation.md`](../../../docs/tui-presentation.md) | How the TUI paints. Desktop copies it |
| [`docs/let-cook-color-contrast.md`](../../../docs/let-cook-color-contrast.md) | Theme files, contrast floors, token roles |
| [`docs/desktop-release.md`](../../../docs/desktop-release.md) | Installers, minisign, `latest.json` |
| [`README.md`](README.md) | Dev commands, binary resolution, updater gate |
| [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) | Rest of the repo |

`src-tauri` has an empty `[workspace]` and is a leaf crate. Cargo commands for
it use `--manifest-path src-tauri/Cargo.toml`.

---

## 1. Shape

```
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React, no Node)                                    │
│  src/ui          presentation                                 │
│  src/state       Zustand transcript · TanStack Query catalogs │
│  src/acp         CookAcpClient · registries · C→A wrappers    │
└────────────────────────────▲─────────────────────────────────┘
                             │ Tauri IPC
                             │ src/acp/host.ts  ↔  src-tauri/src/lib.rs
┌────────────────────────────┴─────────────────────────────────┐
│  Rust host (src-tauri) — three roles, one crate              │
│  acp_host.rs         stdio mux · fs/read_text_file · write   │
│  provider_config.rs  locked writes of ~/.cook/config.toml    │
│  workspace.rs        read-only git review · file tree        │
│  bin_resolve.rs      which `cook` binary to spawn            │
└────────────────────────────▲─────────────────────────────────┘
                             │ stdin/stdout JSON-RPC ACP
                             ▼
                    cook agent stdio
                    clientIdentifier: grok-desktop
                    ~/.cook  (config, auth, sessions, models)
```

One window, one agent process. Another conversation is `session/new` or
`session/load` on that process. Lifecycle, the honesty table, and what the
host is allowed to write are the contract in
[`docs/desktop-app.md`](../../../docs/desktop-app.md) §3–§4.

Startup paints from `src/main.tsx`: QueryClient, theme, then `AppShell`.

---

## 2. Directory map

```
src/main.tsx                 boot
src/updater.ts               app-shell updater used by the open-app banner + Settings → About
src/invariants.test.ts       renderer must not call models, tools, or HTTP
src/acp/                     protocol client (see §3)
src/state/                   transcript, catalogs, activity, goal, plan review
src/ui/                      screens (see §4)
src/theme/                   CSS. Tokens and floors: docs/let-cook-color-contrast.md
src-tauri/src/               Rust host (see §5)
src-tauri/tauri.conf.json    dev bundle. Updater off
src-tauri/tauri.release.conf.json
                             release updater endpoint + pubkey
public/providers/            provider logo SVGs
tests/                       Playwright, mock ACP transport
scripts/                     tauri wrapper, install.sh, latest.json, version-from-tag
```

---

## 3. ACP client (`src/acp/`)

`CookAcpClient` in `client.ts` is the object the UI calls (`acpClient`). It
owns connect, crash restart, prompt send, and queue send-now. Inbound agent
messages are `client/messages.ts` `handleInboundMessages`: a pending response
completes the renderer promise; a message with an id goes to the reverse
registry; everything else goes to the notification registry.

| Path | Role |
|---|---|
| `client.ts` | Lifecycle and the calls the UI makes. Prompt ids, painted-prompt set, `sendQueueEntryNow` |
| `client/messages.ts` | Inbound pipeline. Session updates, child-session routing, registry dispatch |
| `client/initialize.ts` | `initialize` once per process, from `handshake.ts` |
| `client/requests.ts` | Session helpers: model, yolo, permission answer, usage, plan-file pull |
| `client/state.ts` | Which session an update belongs to. `routeChildUpdate` for a subagent |
| `client/wire.ts` | Unwrap method and params |
| `host.ts` | Tauri IPC. `wireMethod` prefixes C→A `x.ai/*` as `_x.ai/…`. `desktopCommand` is the mock/test fallback |
| `handshake.ts` | `CAPABILITIES`. The only advertise table. Contract: desktop-app §4.2 |
| `reverse/` | A→C requests that carry an id. Interactions in `reverse/interactions.ts`; typed decline in `reverse/policy.ts` |
| `notifications/` | A→C notifications. Handlers in `notifications/handlers.ts`, including `x.ai/queue/changed` |
| `xai.ts` | `XaiClient`: session, model catalog, commands |
| `extensions.ts` | MCP connectors, skills, plugins, project files |
| `settings-ext.ts` | Memory files, hooks, workflows |
| `providers.ts` | Provider and model upsert. Tauri writes through the host; mock falls back to `x.ai/providers/*` |
| `provider-presets.ts` | Offline preset mirror for Settings and first-run connect. Agent `x.ai/providers/presets` wins when it answers |
| `provider-oauth.ts` | ChatGPT / Claude connect IPC |
| `turn-ops.ts` | Queue interject, edit, remove. `sendQueuedPromptNow` |
| `session-ops.ts` | Rewind and recap |
| `plan-files.ts` | `x.ai/session/plans` list and delete |
| `activity.ts` | Tasks, subagents, scheduled tasks |
| `workspace.ts` | Renderer side of the read-only file/review sidecar |
| `attachments.ts` | Composer attachments and image parts |
| `mcp-servers.ts` | Normalize and merge the MCP catalog |
| `session-events.ts` | Dedupe and prompt correlation |
| `client-coalesce.ts` | Coalesce `session/update` before the reducer |
| `mock-transport.ts` | ACP stand-in for Playwright (`VITE_MOCK_ACP=1`) and unit tests |
| `os-notify.ts` | Turn-complete OS notification copy |
| `trace.ts` | `COOK_DESKTOP_TRACE=1` method/id trace |

C→A wrappers are still the flat files above (`xai.ts`, `extensions.ts`,
`providers.ts`, `turn-ops.ts`, `session-ops.ts`, `settings-ext.ts`). Grouping
them under `acp/methods/` is the unfinished C4 note in the client-implement
doc, and it is optional there.

Adding a reverse method or a notification means one capability-map row, one
registry entry, and one test. The registries live in `reverse/registry.ts`
and `notifications/registry.ts`.

---

## 4. State and UI

### State (`src/state/`)

| Path | Role |
|---|---|
| `session.ts` | Barrel. UI imports the store and block types from here |
| `session/store.ts` | Zustand session: transcript, composer draft, queue, connection, plan files |
| `session/transcript.ts` | `reduceTranscript` and `reduceNotifications`. Replay and live updates share this reducer |
| `session/types.ts` | Block and turn types |
| `session/cursor.ts` | Turn elapsed time and the turn-marker string |
| `catalog.ts` | Models and slash commands. `useModelSelection` is what the picker reads |
| `activity.ts`, `activity/` | Tasks, subagents, workflows. Child transcripts live here |
| `goal.ts` | Goal chip and detail labels |
| `plan-review.ts` | Parked plan review: body, comments, decision bar |
| `artifacts.ts` | Preview-panel open signal. `git_head_changed` |
| `tools-panel.ts` | Which utility-panel view to open |
| `query-client.ts` | TanStack Query client. Catalog screens use it |

### Frame

`ui/app-shell.tsx` is the window: session sidebar, `ChatView`, utility panel,
lazy Settings, command palette, shortcuts, welcome, and connect-provider.
`MIN_CHAT_WIDTH_WITH_TOOLS` (600) collapses the sidebar when the tools panel
would squeeze the chat.

`ui/chat/chat-view.tsx` is the chat column. A subagent `[view]` replaces that
column with `subagent-takeover.tsx` (same `TranscriptPane` rows, no composer).
Otherwise the column is `TranscriptPane` plus queue bar, turn status, prompt,
and the rewind / recap / plan dialogs. A background command stays in
`ui/activity/task-viewer.tsx`.

`ui/chat/transcript-pane.tsx` virtualizes. `transcript-projection.ts` is the
one projection; `transcript-row.tsx` is the one switch that paints it (message,
thought, tool, verb group, session event). A second switch is how a child view
drifts from the parent chat. Tool and thinking rows are `tool-card.tsx`.
Markdown is `markdown.tsx`.

### Header

`ui/chat/agent-header.tsx` is the status bar. Left: workspace and plans.
Right, in fixed slots: goal or the plan checklist, line changes, Git, tools.

| Chip | File |
|---|---|
| Plans | `ui/chat/plan-chip.tsx` (list rules: desktop-app §7) |
| Tasks | `ui/activity/tasks-chip.tsx`, menu `tasks-menu.tsx` |
| Goal | `ui/chat/goal-status.tsx`, detail `goal-detail.tsx` |
| Checklist when there is no goal | `ui/chat/todo-chip.tsx` |
| Diffstat | `ui/chat/header-diffstat.tsx` |
| Git | `ui/chat/git-chip.tsx`, probe `git-status.ts` |
| Context | `ui/chat/context-chip.tsx` |

### Composer and queue

| Path | Role |
|---|---|
| `ui/chat/prompt-slot.tsx` | Places the composer |
| `ui/chat/composer.tsx` | Prompt, Enter, slash menu, attachments. Empty Enter during a turn calls `sendQueueEntryNow` |
| `ui/chat/composer/` | Slash host, attachment hook, `@` file search hook |
| `ui/chat/slash-commands.ts` | Client slash entries |
| `ui/chat/model-picker.tsx` | Saved models only. Catalog metadata comes from `state/catalog.ts` |
| `ui/chat/queue-bar.tsx` | Queued rows. **Send now** calls `sendQueueEntryNow` for that row |
| `ui/chat/stop-turn-button.tsx` | Cancel the running turn |
| `ui/chat/composer-rails.tsx` | Status row: tokens/s and `+N −M`. Samples and prefs live in `composer-metrics.ts` and `ui/preferences.ts` |
| `ui/chat/at-context.ts`, `file-search.ts` | `@` completion over the host workspace index |

### Prompt queue

The agent's `x.ai/queue/changed` notification is the source of truth for row
id, version, and order (`notifications/handlers.ts`).

`composer.tsx` submits another `session/prompt` while a turn is running.
`client.ts` assigns the prompt id and sends `_meta.clientIdentifier:
grok-desktop`. The shell uses that identifier as the queue-row owner.

Empty Enter selects the first queued row. The queue bar's **Send now** button
selects its own row. Both go through `CookAcpClient.sendQueueEntryNow`, which
calls `turn-ops.ts` `sendQueuedPromptNow` (`x.ai/queue/interject` with the row
id and version). If Enter arrives before the queue notification, the client
waits until that prompt id is confirmed, then sends.

The shell promotes the row and cancels the running turn when it should. The
promotion's `runningText` paints the queued user message. Desktop also opts
into live `user_message_chunk` echoes and skips a second paint when
`client.ts` already recorded that prompt id (`client/messages.ts`).

The TUI follows the same notification in
`crates/codegen/xai-grok-pager/src/app/dispatch/queue.rs`.

### Sidebar, tools, permissions, welcome

| Path | Role |
|---|---|
| `ui/sessions/session-sidebar.tsx` | Conversation list, pin, rename, delete, drag, resize |
| `ui/sessions/session-sidebar/` | Row, menus, dialogs |
| `ui/utility-panel.tsx` | Right panel: Review, Files, Activity, Preview |
| `ui/artifacts-panel.tsx` | Preview |
| `ui/activity/activity-panel.tsx` | Activity list inside the utility panel |
| `ui/permissions/` | Permission modal and ask/elicit modal. Opened from `acp/reverse/interactions.ts` |
| `ui/welcome/welcome.tsx` | No workspace yet |
| `ui/welcome/connect-provider.tsx` | First-run provider connect |
| `ui/palette/command-palette.tsx` | Command palette. Items in `palette-items.ts` |
| `ui/shortcuts/shortcuts-sheet.tsx` | Shortcut sheet |
| `ui/storage.ts` | Renderer-local UI prefs (sidebar, dismissed connect). Session records stay in the agent |
| `ui/theme/theme.tsx` | Light / dark / system. Colors themselves are `src/theme/tokens.css` |

### Settings

`ui/settings/settings-panel.tsx` declares the tabs.

| Tab | File |
|---|---|
| General | `settings-panel.tsx` (theme, always-approve, composer prefs) |
| Models | `providers.tsx`, `providers/` (cards, dialogs, OAuth, logos), `model-dialog.tsx`, `provider-form.tsx` |
| Connectors | `connectors.tsx`, grouping `connectors-groups.ts` |
| Memory & project | `context-panels.tsx` (`MemoryPanel`, `ProjectInstructionsPanel`) |
| Skills | `context-panels.tsx` `SkillsPanel`, grouping `skills-groups.ts` |
| Hooks | `hooks-panel.tsx` |
| Data Controls | `data-controls.tsx` — delete all conversations (`x.ai/sessions/delete_all`). Rules: desktop-app §7 |
| About | `settings-panel.tsx` `AboutUpdates`, backed by `src/updater.ts` (also drives the open-app banner in `update-banner.tsx`) |

Provider logos: SVG at `public/providers/{id}.svg`, registered in
`ui/settings/providers/provider-logo.tsx` (`PROVIDER_LOGO_IDS`, and
`PROVIDER_LOGO_FILE` when the file name differs from the id).

Saved models reach the chat picker only after Settings writes them. Discovery
("Get models") is `providers.ts` `probeProviderModels` → host
`desktop_provider_models` / `desktop_model_*`. Grok OAuth can exist as
provider id `xai` without a `[model_providers.xai]` block; the host then
writes those models as built-in xAI models.

---

## 5. Rust host (`src-tauri/src/`)

Commands are registered in `lib.rs` `invoke_handler`. A command that can wait
is `async`: IPC runs on the event-loop thread, and a blocking command freezes
the window.

| File | Role | Contract |
|---|---|---|
| `acp_host.rs` | Spawn and kill `cook agent stdio`, JSON-RPC ids, notification coalescing, native `fs/read_text_file` and `fs/write_text_file` | desktop-app §4.3 ACP mux. `terminal: false` until a real PTY exists |
| `provider_config.rs` | Atomic `~/.cook/config.toml` edits. Credential stays in this process; the renderer gets presence only. `/models` probe | The production Desktop write path for `[model_providers.*]` and `[model.*]` |
| `provider_oauth.rs` | ChatGPT device flow and Claude PKCE. Grok login stays on the agent's `authenticate` | |
| `http.rs` | The one HTTP client, used by provider probes | |
| `workspace.rs` | Git review vs `HEAD`, file tree, preview, native open. Paths stay inside the workspace root | Read-only sidecar |
| `bin_resolve.rs` | `COOK_BIN`, then `~/.cook/bin/cook`, then an optional bundled sidecar. Home is `$COOK_HOME`, then `$GROK_HOME`, then `~/.cook` | README § Agent binary resolution |
| `logging.rs` | `~/.cook/logs/desktop.log`. Verbose ACP trace is `COOK_DESKTOP_TRACE=1` | |
| `lib.rs` | Command list: ACP, folder/file pickers, workspace, providers, models, OAuth, OS notify, open path/url | |

The updater plugin updates this app binary. It does not write
`~/.cook/bin/cook`.

---

## 6. Change-map

### Chat and chrome

| I want to… | Go to |
|---|---|
| Change the window frame, sidebar vs tools width, or which overlay is open | `src/ui/app-shell.tsx` |
| Change how a transcript row looks | `src/ui/chat/transcript-row.tsx` and `tool-card.tsx`. Projection: `transcript-projection.ts`. Paint rules: [`docs/tui-presentation.md`](../../../docs/tui-presentation.md). Forbidden chrome: desktop-app §7 |
| Change what an agent update becomes in the transcript | `src/state/session/transcript.ts` |
| Change the composer, Enter, or slash menu | `src/ui/chat/composer.tsx`, `slash-commands.ts`, `composer/` |
| Change the model picker or which models appear | `src/ui/chat/model-picker.tsx`, `src/state/catalog.ts`. Saving a model is Settings → Models |
| Change queue or Send now | §4 Prompt queue |
| Change the status row (tokens/s, diffstat) | `src/ui/chat/composer-rails.tsx`, `composer-metrics.ts` |
| Change a header chip | The chip file in §4 Header |
| Change plan-file list, copy, or delete | `src/ui/chat/plan-chip.tsx`, `src/acp/plan-files.ts` |
| Change the subagent's own view | `src/ui/chat/subagent-takeover.tsx`, routing in `src/acp/client/state.ts` |
| Change tasks, the tasks chip, or the background stdout viewer | `src/ui/activity/`, store `src/state/activity/` |
| Change the right-hand Review / Files / Preview panel | `src/ui/utility-panel.tsx`, `src/acp/workspace.ts`, host `src-tauri/src/workspace.rs` |
| Change permissions, questions, or plan-mode exit UI | `src/ui/permissions/`, `src/acp/reverse/interactions.ts` |
| Change the conversation list | `src/ui/sessions/session-sidebar.tsx` |
| Add or change a Settings tab | `src/ui/settings/settings-panel.tsx` and the tab file in §4 |
| Change provider connect, OAuth, or model save | `src/ui/settings/providers.tsx`, `src/acp/providers.ts`, host `provider_config.rs` / `provider_oauth.rs` |
| Add a provider logo | `public/providers/{id}.svg` and `PROVIDER_LOGO_IDS` in `provider-logo.tsx` |
| Change colors or contrast | `src/theme/tokens.css`. Rules and the CSS module list: [`docs/let-cook-color-contrast.md`](../../../docs/let-cook-color-contrast.md) |
| Change keyboard shortcuts shown to the user | `src/ui/shortcuts/shortcuts-sheet.tsx` and the handler that already listens (shell, composer, utility panel) |
| Change the command palette | `src/ui/palette/` |
| Change first-run or the empty window | `src/ui/welcome/` |

### Protocol and host

| I want to… | Go to |
|---|---|
| Change what `initialize` advertises | `src/acp/handshake.ts`. Honesty rules: desktop-app §4.2 |
| Handle a new agent→client request | `src/acp/reverse/` and a capability-map row |
| Handle a new agent→client notification | `src/acp/notifications/handlers.ts` and a capability-map row |
| Call a new client→agent method | The wrapper file in §3 (`xai.ts`, `extensions.ts`, `providers.ts`, `turn-ops.ts`, `session-ops.ts`, `settings-ext.ts`) via `host.ts` `request` |
| Change crash restart or connect | `src/acp/client.ts` |
| Change fs reads the agent asks the client for | `src-tauri/src/acp_host.rs` |
| Change which `cook` binary starts | `src-tauri/src/bin_resolve.rs` |
| Change desktop logging | `src-tauri/src/logging.rs` |
| Add a Tauri command | Implement it in `src-tauri/src/`, register it in `lib.rs`, call it from `src/acp/host.ts` |
| Change the app updater | `src/updater.ts`, open-app banner in `update-banner.tsx` (outside sidebar), Settings → About in `settings-panel.tsx`, `tauri.release.conf.json`. Publish path: [`docs/desktop-release.md`](../../../docs/desktop-release.md) |
| Change a model, a tool, or session storage | The agent. Repo map: [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) |

### Tests

| I want to… | Go to |
|---|---|
| Unit-test a module | The colocated `*.test.ts` / `*.test.tsx`. `pnpm test` runs Vitest and `scripts/*.test.mjs` |
| Lock a renderer invariant (no `fetch`, no `config.toml` writer) | `src/invariants.test.ts` |
| Exercise the UI the way a user does | `tests/*.spec.ts`. Playwright starts Vite with `VITE_MOCK_ACP=1` (`playwright.config.ts`) against `src/acp/mock-transport.ts`. `COOK_E2E_PORT` moves it off 1420 |
| Test the host | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Run the app | [`README.md`](README.md) |

---

*Maintained as the navigational companion to [`docs/desktop-app.md`](../../../docs/desktop-app.md). When a module or path here moves, update this file in the same change.*
