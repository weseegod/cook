# Grok Build (`thanh`) — Architecture

This document is the engineer-facing map of the repository: what the pieces
are, how they fit together, and — most importantly — **where to go to change,
fix, or implement something**. It is written for an AI agent or a human coming
into the tree cold. See `README.md` for user-level build/install info and
`UPSTREAM-MERGE.md` for the fork's sync playbook.

---

## 1. Overview

This is a Rust workspace (93 crates) implementing **Grok Build**, a
terminal-based AI coding agent. This fork ships the binary as **`thanh`**
(the cargo artifact is `xai-grok-pager`) with its own home directory
**`~/.thanh`**, fully isolated from the official grok CLI's `~/.grok`.

The product runs in four modes, all sharing one agent runtime:

- **Interactive TUI** — full-screen terminal UI (default).
- **Headless single-turn** — `thanh -c "<prompt>"` for scripting/CI.
- **Stdio / ACP agent** — `thanh agent stdio`, the
  [Agent Client Protocol](https://agentclientprotocol.com) server used by
  editor integrations.
- **Desktop ACP client** — Tauri 2 + React application in
  `frontend/apps/thanh-desktop/`. Architecture:
  [`docs/desktop-app.md`](docs/desktop-app.md). Production plan:
  [`docs/desktop-app-implement.md`](docs/desktop-app-implement.md). Same agent
  process as the TUI; does not reimplement tools or sampling.

System context (arrows = data flow):

```
┌──────────────────────────┐        ACP messages         ┌───────────────────────────────┐
│  xai-grok-pager (TUI)    │  ◄───────────────────────►  │  xai-grok-shell (agent)        │
│  input, views, scrollback│   (AcpClientMessage ⇄       │  leader process · MvpAgent     │
│  slash cmds, headless CLI│    AcpAgentMessage)         │  owns the conversation session │
└──────────────────────────┘                             └───────────────┬───────────────┘
        ▲ renders via                 ▲ ACP stdio                        │
        │                             │                                  │
┌──────────────────────────┐  ┌───────┴────────────────┐  tool calls     │ LLM requests
│ xai-grok-pager-render    │  │ thanh-desktop (Tauri)  │         ▼       ▼
│ theme · render · terminal│  │ React ACP client       │  ┌────────────┐ ┌──────────────┐
│ (draw primitives)        │  │ docs/desktop-app.md    │  │ xai-grok-  │ │ xai-grok-    │
└──────────────────────────┘  └────────────────────────┘  │ tools      │ │ sampler      │
                                                          └─────┬──────┘ └──────────────┘
                                                                ▼
                                             ┌─────────────────────────────────────┐
                                             │ xai-grok-workspace                   │
                                             │ FS (AsyncFileSystem) · VCS · exec ·  │
                                             │ permissions · checkpoints · worktrees│
                                             └─────────────────────────────────────┘
```

Shared infrastructure underneath everything: `xai-grok-config` (config),
`xai-grok-mcp` (MCP servers), `xai-grok-sandbox` (sandboxing), `xai-grok-memory`
(persistent memory), `xai-grok-markdown` (streaming markdown), session storage
(`events.jsonl` + SQLite indexes), `xai-grok-telemetry`, `xai-grok-update`.

---

## 2. Binary & process model

### Entry point: `xai-grok-pager-bin`

Everything starts at `crates/codegen/xai-grok-pager-bin/src/main.rs`
(`fn main` ~L1879, `async fn async_main` ~L1970). This crate exists so the
binary can link both `xai-grok-pager` and `xai-grok-pager-minimal` without a
cargo cycle. `main()` sets up: mermaid and voice **subprocesses**, release
channel, jemalloc hooks, fd limits, crash handlers, and a capped tokio runtime.
`async_main()` dispatches every subcommand (`agent`, `models`, `leader`,
`worktree`, `sessions`, `update`, `login`, …); the default path goes to the
TUI via `xai_grok_pager::app::run(...)` or to an agent entry point
(`xai_grok_shell::agent::app::{run_headless, run_leader, run_stdio_agent}`).

### Leader-follower model

The shell is **leader-based** (`crates/codegen/xai-grok-shell/src/leader/`):
a single leader process owns the agent; TUI stdio, IDE, and headless clients
connect over a Unix socket. `connect_or_spawn`, `LeaderConnection`
(`leader/mod.rs`), server at `leader/server.rs`. The main TUI usually runs
in-process against the agent; `leader` mode lets multiple clients share one
agent process.

### Build / release

- `build.sh` — `cargo build -p xai-grok-pager-bin --release`, installs the
  artifact as `thanh` into `~/.thanh/bin/thanh` + `~/.local/bin` symlink.
- `scripts/publish_release.sh` — bumps the lockstepped version in
  `xai-grok-version` + `xai-grok-pager-bin`, builds locally, publishes
  `thanh-<ver>-<os>-<arch>` assets + `stable`/`alpha` channel pointers to
  GitHub Releases (the updater reads these).
- `SOURCE_REV` at the root records the upstream monorepo commit SHA.

---

## 3. Crate map

All paths under `crates/`. The workspace is split into `crates/codegen/*`
(products and feature crates), `crates/common/*` (shared leaf libraries),
`crates/build/` (protoc build helpers), `prod/mc/` and `third_party/`
(vendored).

### The four pillars

| Crate | Path | Role |
|---|---|---|
| `xai-grok-pager` | `crates/codegen/xai-grok-pager` | The TUI: app loop, input, actions, views, scrollback, slash commands. ACP **client**. |
| `xai-grok-shell` | `crates/codegen/xai-grok-shell` | The agent runtime: `MvpAgent` (ACP `Agent` impl), session actor, turn loop, subagents, workflows. ACP **server**. |
| `xai-grok-tools` | `crates/codegen/xai-grok-tools` | Tool registry + all tool implementations + terminal/FS execution backends. |
| `xai-grok-workspace` | `crates/codegen/xai-grok-workspace` | Host-local FS (`AsyncFileSystem`), VCS (git/jj), execution handles, permissions, checkpoints, worktrees. |

### Presentation & rendering

| Crate | Role |
|---|---|
| `xai-grok-pager-render` | Draw primitives: `theme`, `render`, `terminal`, `appearance`, `syntax`, `glyphs`. **Re-exported by the pager** (`pager/src/lib.rs:58-61`) — theme/render changes live HERE. |
| `xai-grok-pager-minimal` | Experimental scrollback-native minimal UI (`pager/src/minimal/` is its seam). |
| `xai-grok-pager-diff` / `-pty-harness` | Diff rendering support / pty testing harness. |
| `xai-grok-markdown` (+ `-core`) | Streaming markdown → TUI renderer (syntect highlighting, checkpointed re-render); `-core` is the headless parser config shared with analysis. |
| `xai-grok-mermaid` | Mermaid diagram rendering (out-of-process). |
| `xai-ratatui-inline`, `xai-ratatui-textarea` | Vendored ratatui widgets. |
| `xai-token-estimation`, `xai-grok-status-line` | Token counting / status-line rendering support. |

### Agent runtime & LLM

| Crate | Role |
|---|---|
| `xai-grok-shell` | See §4 deep dive. |
| `xai-grok-shell-base`, `xai-grok-shell-session-support` | Build-cache split-outs of shell foundation/session-support modules (re-exported at original paths). |
| `xai-grok-agent` | The portable `Agent` type: bundles tools + system prompt + compaction/reminder policy + model config. |
| `xai-grok-subagent-resolution` | Pure logic resolving a subagent spawn: model/persona/capabilities/isolation, prompt loading, resume validation. |
| `xai-chat-state` | Actor owning in-memory conversation state (extracted from shell's `acp_session.rs`). |
| `xai-grok-sampler` + `xai-grok-sampling-types` | Actor-based LLM inference: HTTP streaming, retry, cancellation (`sampling/` in shell re-exports the types). |
| `xai-grok-compaction`, `xai-compaction-transcript` | Shared transport-agnostic context-window compaction engine. |
| `xai-interjection-core` | Mid-turn user-interjection buffering/formatting. |
| `xai-grok-memory` | Persistent memory under `~/.thanh/memory/` (global `MEMORY.md` + per-workspace blake3 dirs; FTS5 + vector store). |

### Tools infrastructure

| Crate | Role |
|---|---|
| `xai-grok-tools` | See §4 deep dive. |
| `xai-tool-runtime` | The unified `Tool` trait, dispatch, error taxonomy, notifications — **every tool author implements this**. |
| `xai-tool-types` | Canonical tool-description types + built-in subagent/task types. |
| `xai-tool-protocol` | Computer Hub wire-protocol types (JSON-RPC envelope, method catalog, error codes). |
| `xai-grok-mcp` | MCP integration: quarantines `rmcp` + reqwest 0.13; owns MCP credential store + OAuth flow. |
| `xai-computer-hub-core` / `-sdk` / `-mcp-adapter` | Hub transport/registry + connection pool + MCP→hub bridge. |

### Workspace & execution

| Crate | Role |
|---|---|
| `xai-grok-workspace` | See §4 deep dive. |
| `xai-grok-workspace-types` / `-client` / `-daemon` | RPC types / remote workspace client / standalone workspace-server binary. |
| `xai-grok-sandbox` | Kernel sandboxing (Landlock/Seatbelt via nono) applied at startup; per-subprocess network blocking (seccomp). |
| `xai-fast-worktree` | Fast git-worktree creation via CoW cloning (btrfs/overlay backends, NFS, GC, SQLite metadata). |
| `xai-fsnotify`, `xai-hunk-tracker` | Filesystem watching and per-hunk change tracking. |
| `xai-codebase-graph` | tree-sitter code graph: go-to-def/ref, initial + incremental indexing (rayon, mmap). |
| `xai-gix-status`, `xai-file-utils`, `xai-fuzzy-file-search`, `ptyctl` / `ptyctl-cli` | git status, file helpers, fuzzy path search, pty control. |

### Config & auth

| Crate | Role |
|---|---|
| `xai-grok-config` | Effective config loader: merge order `managed_config.toml` > `config.toml` > signed `requirements.toml` > macOS MDM, TOML merge, `[[version_overrides]]`. |
| `xai-grok-config-types` | Dependency-light config value types (dependency inversion for the shell). |
| `xai-grok-auth` | Bearer-token auth trait seam + retry middleware. |
| `xai-grok-home`, `xai-grok-paths` | Home-dir resolution (`~/.thanh` by default) + path helpers. |
| `xai-grok-secrets`, `xai-grok-extra-ca`, `xai-grok-http`, `xai-grok-env` | Secrets handling, extra CA roots, HTTP helpers, env presets. |

### Sessions & storage

| Crate | Role |
|---|---|
| `xai-grok-session-events` | Typed per-session event log (`events.jsonl`) — **the canonical session record**. |
| `xai-grok-session-search` | SQLite FTS5 search index over sessions (`session_search.sqlite`, BM25). |
| `xai-grok-active-sessions`, `xai-grok-foreign-sessions` | Active-session tracking / read-only discovery of Claude/Codex/Cursor sessions. |
| `xai-sqlite-journal` | Filesystem-aware SQLite journal-mode selection (WAL vs rollback on network mounts). |

### Lifecycle, ops & misc

| Crate | Role |
|---|---|
| `xai-grok-update`, `xai-grok-version` | Self-update (feed: `weseegod/thanh` releases) + version lockstep. |
| `xai-grok-telemetry` | Mixpanel events, Sentry errors, OpenTelemetry tracing, unified log. |
| `xai-grok-hooks` (+ `xai-hooks-plugins-types`) | JSON-defined hooks discovered from hook dirs, run as subprocesses at lifecycle/tool events. |
| `xai-grok-announcements`, `xai-grok-diag-server`, `xai-crash-handler`, `xai-system-power` | Banner announcements, in-guest `/ready` HTTP server, crash handling, power events. |
| `xai-grok-voice` | Streaming STT voice dictation (mic → transcript into prompt). |
| `xai-grok-*cmd` rotating crates + `xai-grok-models`, `xai-grok-plugin-marketplace`, `xai-grok-bundle`, `xai-prompt-queue`, `xai-grok-http` | Models catalog, plugin marketplace, bundled assets, prompt queue, HTTP. |
| `xai-acp-lib`, `xai-agent-lifecycle` | ACP channel helpers (`AcpAgentTx`/`AcpClientRx`, `acp_send`) + agent lifecycle. |
| `xai-circuit-breaker`, `xai-tracing`, `xai-tracing-macros`, `xai-grok-test-support`, `xai-test-utils`, `xai-mixpanel` | Shared small leaves. |
| `xai-grok-tools-api` (proto), `xai-proto-build`, `prod/mc/cli-chat-proxy-types` | Protobuf plumbing. |
| `third_party/` | Vendored: `dagre_rust`, `graphlib_rust`, `mermaid-to-svg`, `ordered_hashmap` (Mermaid diagram stack). |

---

## 4. Deep dives

### 4.1 `xai-grok-pager` — the TUI (ACP client)

Entry: `src/app/mod.rs` → `pub async fn run(...)`; event loop at
`src/app/event_loop.rs` (a thin `tokio::select!` over crossterm events, the
ACP channel, spawned-task results, animation ticks, config watcher). The
Elm-style core:

- **`src/app/app_view.rs`** — `AppView`: root component owning all app state;
  `handle_input()` + `draw()`.
- **`src/app/agent_view/`** — `AgentView`: per-agent main turn screen
  (input in `input.rs`/`interactions.rs`, rendering in `render.rs`).
- **`src/app/dispatch/`** — pure `Action → state mutation + Vec<Effect>`
  (sync, testable); `router.rs`, `modes.rs`, `voice.rs`.
- **`src/app/effects/`** — side-effect execution (spawned tasks).
- **`src/app/acp_handler/`** — routing incoming ACP messages
  (background tasks, subagents, permissions, MCP, queue).

Other key trees:

- `src/actions/` — action registry; **all default key bindings live in
  `src/actions/defaults.rs`** (`ActionId` in `actions/mod.rs`).
- `src/input/` — key handling (`key.rs`, `key!()` macro), line editor, mouse.
- `src/views/` — one module per screen/widget: `welcome/`, `prompt_widget/`,
  `status_line/`, `todo_pane.rs`, `tasks_pane.rs`, `modal.rs`,
  `modal_window.rs`, `overlay.rs`, `picker.rs`, `settings_modal/`,
  `agents_modal.rs`, `question_view.rs`, `session_picker.rs`, `dashboard/`, …
- `src/scrollback/` — conversation display: `render.rs`, `wrappers/`,
  `blocks/` (per-content-type renderers, incl. `blocks/markdown_content.rs`),
  `state/` (layout/nav/selection). Presentation catalog:
  [`docs/tui-presentation.md`](docs/tui-presentation.md).
- `src/slash/` — slash-command registry (`registry.rs`) + one file per command
  under `slash/commands/` (70+ commands).
- `src/acp/` — ACP connection: `AcpConnection { tx, rx }` over
  `xai-acp-lib`; leader bridge in `leader_bridge.rs`.
- `src/headless/` — headless CLI + external protocol + reducer.
- `src/minimal/` — seam for `xai-grok-pager-minimal`.

**Render boundary:** raw drawing (theme, `draw_frame`, `PagerTerminal`,
highlighting, overlays) does **not** live in this crate — it is re-exported
from `xai-grok-pager-render` (`src/lib.rs:58-61`). If a change is about
*pixels/colors/terminal output*, go to `xai-grok-pager-render`; if it is about
*screens, widgets, or behavior*, stay in `xai-grok-pager`.

### 4.2 `xai-grok-shell` — the agent runtime (ACP server)

Entry: `MvpAgent` implements `acp::Agent` — `src/agent/mvp_agent/acp_agent.rs`
(`initialize` ~L41, `new_session` ~L919, `new_session_inner` in
`session_setup.rs`). The session actor is the heart:

- **Spawn:** `src/session/acp_session_impl/spawn.rs` —
  `spawn_session_actor` runs each session on its own OS thread with a
  current-thread tokio runtime (`spawn_session_on_thread`, `SessionThread`).
- **Main loop:** `src/session/acp_session_impl/run_loop.rs` — `run_session`
  multiplexes `SessionCommand`, `ChatStateEvent`, `SessionEvent`; sets up
  fs-watch, status emitter, MCP dispatcher, idle arms.
- **Turn:** `src/session/acp_session_impl/turn.rs` (`handle_prompt`, sampling
  loop) → `sampler_turn.rs` (tool definitions, auth retry, sampler config,
  usage recording) → `tool_dispatch.rs` (`dispatch_tool` → `WorkspaceOps::call_tool`).
- **Handle:** `src/session/handle.rs` (`SessionHandle` + `SessionCommand` channel).

Other trees:

- `src/agent/` — `mvp_agent/` (agent impl, `subagent_spawn.rs`),
  `subagent/` (subagent coordinator seam — `spawn.rs`:
  `spawn_subagent_coordinator`, child via `handle_request.rs`),
  `server.rs` (`run_agent_server`).
- `src/session/` (281 files) — everything session-scoped: `compaction*.rs`,
  `two_pass.rs`, `helpers/` (compaction prompts), `goal_*.rs` +
  `goal_classifier/` (goal orchestration), `mcp_*.rs` (MCP dispatch/restart/
  managed), `storage/` + `persistence.rs` (transcripts), `worktree.rs` +
  `worktree_pool.rs`, `memory/` (shim to `xai-grok-memory`), plus the
  `acp_session_impl/` behaviors listed above.
- `src/session/workflow/` — workflow engine: `registry.rs` (built-in
  registration, `include_str!` of the .rhai), `manager.rs` (run lifecycle),
  `host_service.rs` (dispatch to the external `xai-workflow` crate, which
  drives subagents), `tracker.rs`/`store.rs`/`listing.rs`.
- `src/session/workflows/` — the actual scripts: `deep_research.rhai`.
- `src/leader/` — leader-follower IPC (see §2).
- `src/auth/` — OIDC/device-code flows, JWT, credential providers, token
  refresh.
- `src/remote/` — backend HTTP clients (sandbox, chat-models, conversations,
  skills, workspaces, sync).
- `src/extensions/` — extension points (46 files: MCP, notification, bundle,
  web-search, image-gen, …).
- `src/config/` — config load/reload/watcher; `src/cli_models.rs` for
  `thanh models`; `src/plugin.rs` for plugin lifecycle; `src/mcp_doctor.rs`
  for `thanh mcp doctor`.

### 4.3 `xai-grok-tools` — tools registry + implementations

- **Registry:** `src/registry/types.rs` — `ToolRegistryBuilder::new()`
  registers the canonical built-in set (~L680-770); `register::<T>()` is the
  per-tool API; `register_tool_pack()` lets out-of-tree packs contribute.
  `SessionContext` is the public boundary (backend, fs, cwd, session folder,
  notifications, subagent/scheduler/memory/web config). Dispatch runs through
  `xai-computer-hub-sdk::LocalRegistry` → `FinalizedToolset::prepare_dispatch`.
- **The `Tool` trait is `xai_tool_runtime::Tool`** (external crate); each tool
  implements it + `crate::types::tool_metadata::ToolMetadata`.
- **Implementations** — `src/implementations/`, grouped by toolset:
  - `grok_build/` — the modern main toolset: `bash/`, `read_file/`,
    `search_replace/`, `grep/`, `list_dir/`, `web_fetch/` (+SSRF),
    `web_search/`, `image_gen|edit|video_gen/`, `task/` (subagent
    coordinator), `scheduler/` (recurring tasks), `todo/`, `kill_task/`,
    `lsp/`, `ask_user_question/`, `enter_plan_mode/`, `exit_plan_mode/`,
    `update_goal/`, `workflow/`, `monitor/`.
  - `codex/` — Codex-style tools, incl. `apply_patch/` (pure patch engine:
    `parser.rs`, `apply.rs`, `seek_sequence.rs`).
  - `opencode/` — OpenCode-style tools (`bash`, `edit`, `write`, `read`, …).
  - `grok_build_concise/`, `grok_build_hashline/` — alternate edit tool suites.
  - `lsp/` — LSP client manager/diagnostics; `memory/`, `skills/`,
    `search_tool/`, `use_tool/`, `read_file/` (pdf/pptx/image special
    formats), `web_search/`, `editor_infra/` (file-operation locking).
- **Execution backends** — `src/computer/`: `types.rs` (`TerminalBackend`,
  `AsyncFileSystem` traits), `local/` (`terminal.rs` — pty + process groups +
  seccomp child-net filter; `file_system.rs` — sandbox violation logging;
  `static_shell.rs`).
- **Cross-cutting:** `src/tool_taxonomy.rs` (canonical `x.ai/tool` `_meta`
  envelope), `src/normalization.rs` (input normalization), `src/versions.rs`
  (behavior-version presets), `src/notification/` (`FileWritten` streaming
  notifications), `src/reminders/` (LSP diagnostics, task completion, skill
  discovery reminders), `src/persistence.rs` (resource persistence bundle).

### 4.4 `xai-grok-workspace` — FS, VCS, execution, permissions

- **`src/handle.rs`** — `WorkspaceHandle`: the public API surface (connect,
  drain, turn hooks, session/toolset lifecycle, checkpointing).
- **`src/session/`** — `WorkspaceSession` + `WorkspaceShared` (`mod.rs`),
  `checkpoint.rs`/`checkpoint_store.rs`/`file_state.rs` (rewind machinery),
  `git.rs` (git2 status/diffs + CLI stage/commit/push), `git_gate.rs`,
  `jj.rs`, `swap_policy.rs`, `tool_config.rs`.
- **`src/file_system/`** — `fs.rs` (`AsyncFileSystem` trait — the abstraction
  every tool reads/writes through), `local_fs.rs` (`LocalFs`), `adapter.rs`/
  `acp_fs.rs`, `git_status.rs`, `codebase_index.rs`, `index.rs`, `content.rs`
  (streaming content search).
- **`src/permission/`** — approval system: `manager/` (`bash_grants.rs`,
  `request_classification.rs`), `policy.rs`, `rules.rs`, `exec_risk.rs`,
  `bash_command_splitting.rs`, `auto_mode/`.
- **`src/worktree/`** — git-worktree lifecycle via `xai-fast-worktree`.
- **`src/fs_notify.rs`** — bridges `xai-fsnotify` events into hunk tracker,
  codebase graph, and workspace event broadcast.
- **`src/hub*.rs`** — remote workspace-server wiring (Computer Hub);
  `src/bin/workspace_server.rs` is the standalone server binary.
- Also: `workspace_ops.rs` (high-level ops incl. `call_tool`), `recovery.rs`/
  `restore_fetch.rs`, `upload/`, `discovery.rs`/`folder_trust.rs`/`trust.rs`.

---

## 5. Key flows

### 5.1 A conversation turn (TUI → agent → tools → back)

1. User types in the pager → `AppView` → outbound `AcpAgentMessage` on the
   ACP channel (`pager/src/acp/`, `xai-acp-lib::acp_send`).
2. `MvpAgent` (`shell/src/agent/mvp_agent/acp_agent.rs`) receives it;
   `new_session` → `session_setup.rs` resolves workspace/MCP/context →
   `spawn_session_actor` (`acp_session_impl/spawn.rs`) starts an
   actor on its own thread.
3. `run_session` (`acp_session_impl/run_loop.rs`) routes the prompt →
   `handle_prompt` (`turn.rs`) → `sampler_turn.rs` builds tools+auth and
   streams the LLM response through `xai-grok-sampler` (HTTP streaming with
   retry/cancellation).
4. Tool calls go `tool_dispatch.rs:dispatch_tool` → `WorkspaceOps::call_tool`
   (`xai-grok-workspace`) → computer-hub `LocalRegistry` dispatch →
   the `xai_tool_runtime::Tool` impl in `xai-grok-tools` → real work on
   `AsyncFileSystem`/`TerminalBackend` (backed by `LocalFs` + pty).
5. Per-tool progress (`FileWritten`, status, turn results) streams back as
   ACP notifications; the pager renders them into scrollback blocks
   (`scrollback/blocks/`) with `xai-grok-markdown`.

### 5.2 Subagents

`start_subagent_coordinator` (parent, `agent/mvp_agent/subagent_spawn.rs`) →
`spawn_subagent_coordinator` (`agent/subagent/spawn.rs`) → the coordinator
lives in `xai-grok-tools` (`implementations/grok_build/task/coordinator.rs`).
Each child runs as its own session via `spawn_session_on_thread` in an
isolated fast worktree (`xai-fast-worktree`), with resolution
(model/persona/isolation) from `xai-grok-subagent-resolution`.

### 5.3 Workflows (.rhai)

Slash command `/workflow` (or the `workflow` tool) → `session/workflow/
manager.rs` (run lifecycle) → `host_service.rs` → external **`xai-workflow`**
crate executes the Rhai script, driving subagents via
`SubagentBackend` (`xai-grok-tools::implementations::grok_build::task`).
Built-in scripts live in `shell/src/session/workflows/` (e.g.
`deep_research.rhai`) and are registered in `workflow/registry.rs` via
`include_str!`.

### 5.4 UI event loop

crossterm events + ACP channel + task results + animation ticks are
multiplexed in `pager/src/app/event_loop.rs` → `AppView::handle_input`
(`app_view.rs`) → key resolved via `ActionRegistry` (3-layer bubble:
pane → agent → global) → `dispatch/` produces new state + `Effect`s →
effects spawn tasks → `Presenter` coalesces draws → `render::draw::draw_frame`
(`xai-grok-pager-render`) writes frames on a dedicated writer thread.

---

## 6. Storage layout (`~/.thanh`)

| Path | Contents |
|---|---|
| `config.toml` | User config (model, keys, agents, permissions, UI). |
| `managed_config.toml`, `requirements.toml` | Higher-priority config layers merged by `xai-grok-config` (managed > user > signed requirements > MDM). |
| `auth.json` / credentials | Auth tokens (`xai-grok-auth`); MCP credentials in `mcp_credentials.json` (`xai-grok-mcp`). |
| `bin/thanh` | The managed binary (updated in place by the self-updater). |
| `sessions/<session_id>/` | Per-session dirs: `events.jsonl` (canonical record via `xai-grok-session-events`), transcripts, uploads. |
| `sessions/session_search.sqlite` | **Derived** FTS5 search index (`xai-grok-session-search`). |
| `memory/` | `MEMORY.md` + per-workspace blake3-hashed dirs (`xai-grok-memory`). |
| `logs/`, `docs/user-guide/`, caches | Logs, extracted docs, caches. |

**Sessions are NOT stored in SQLite** — the JSON-lines files are canonical;
SQLite only backs derived indexes (search, memory vectors, worktree tracking)
and read-only foreign agent stores (Claude/Codex/Cursor).

---

## 7. Change-map: "where do I go to…"

### UI / pager

| I want to… | Go to |
|---|---|
| Add / change a TUI screen or widget | `crates/codegen/xai-grok-pager/src/views/` (register in `views/mod.rs`); main-turn elements hook into `app/agent_view/` (`render.rs`, `interactions.rs`) |
| Change a key binding / add an action | `pager/src/actions/defaults.rs` (default key per `ActionId`) + `actions/mod.rs` (add variant) |
| Add a slash command | `pager/src/slash/commands/<name>.rs` (mirror an existing one) + register in `slash/registry.rs` |
| Change theme / colors | `xai-grok-pager-render/src/theme/` (per-theme palettes e.g. `groknight.rs`, `ThemeKind` in `theme/mod.rs`, `cache.rs`) |
| Change scrollback / markdown rendering | `pager/src/scrollback/` (layout `render.rs`, per-content `blocks/`) + `xai-grok-markdown` (streaming renderer) |
| Change raw drawing / terminal output | `xai-grok-pager-render/src/render/` (`draw.rs`, `highlight.rs`, overlays) |
| Change the event loop / app startup | `pager/src/app/event_loop.rs`, `app/mod.rs` |
| Change headless / external protocol | `pager/src/headless/` (`cli.rs`, `ext_protocol.rs`) |
| Read the TUI presentation catalog (screens, realtime, timers, tool rows, folds, cards) | [`docs/tui-presentation.md`](docs/tui-presentation.md) |
| Change / start the desktop app | `frontend/apps/thanh-desktop/`; architecture [`docs/desktop-app.md`](docs/desktop-app.md); production plan [`docs/desktop-app-implement.md`](docs/desktop-app-implement.md). Keep model/tool execution in `thanh agent stdio`. TUI chrome to copy: [`docs/tui-presentation.md`](docs/tui-presentation.md). |

### Agent / shell

| I want to… | Go to |
|---|---|
| Change the turn loop / prompt handling | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/{turn,sampler_turn,run_loop}.rs` |
| Change how tools are dispatched per turn | `session/acp_session_impl/tool_dispatch.rs` (+ `tool_calls.rs`) |
| Change session startup / actor spawn | `session/acp_session_impl/{spawn,session_setup}.rs`, `agent/mvp_agent/acp_agent.rs` |
| Change context compaction | `session/compaction*.rs`, `session/two_pass.rs`, `session/helpers/` + shared `xai-grok-compaction` |
| Change subagent behavior | `agent/subagent/` (coordinator seam) + `xai-grok-subagent-resolution` (pure resolution) |
| Change workflows (Rust side / scripts) | `session/workflow/` (Rust) + `session/workflows/*.rhai` |
| Change goal orchestration | `session/goal_*.rs`, `session/goal_classifier/` |
| Change MCP integration | `xai-grok-mcp` (transports/credentials/OAuth) + `session/mcp_*.rs` (session-side) |
| Change auth / tokens | `auth/` + `xai-grok-auth` (trait seam) |
| Change agent definitions / system prompt | `xai-grok-agent` (Agent bundle, prompt templates) |
| Change model config (BYOK) | `agent/config.rs`, `agent/models.rs`, `config_model_override_parse.rs`; image stripping in `xai-grok-sampling-types/src/conversation.rs` |
| Change LLM sampling / streaming / retry | `xai-grok-sampler` |

### Tools / workspace

| I want to… | Go to |
|---|---|
| Add a new agent tool | `crates/codegen/xai-grok-tools/src/implementations/<toolset>/<name>/` implementing `xai_tool_runtime::Tool` + `ToolMetadata`, then register in `registry/types.rs` (`ToolRegistryBuilder`) and add wire metadata in `tool_taxonomy.rs` |
| Change an existing tool's behavior | its file under `implementations/<toolset>/` (e.g. `grok_build/search_replace/`, `codex/apply_patch/`) |
| Change terminal / process execution | `xai-grok-tools/src/computer/local/terminal.rs` (pty, process groups, net filter); workspace side: `xai-grok-workspace/src/config.rs` (`SessionTerminalBackend`) |
| Change file-system access behavior | `xai-grok-tools/src/computer/local/file_system.rs` + `xai-grok-workspace/src/file_system/` (`AsyncFileSystem`, `LocalFs`) |
| Change permission / approval gating | `xai-grok-workspace/src/permission/` |
| Change git / VCS / checkpoints | `xai-grok-workspace/src/session/` (`git.rs`, `jj.rs`, `checkpoint*.rs`), `file_system/git_status.rs` |
| Change worktree creation / GC | `xai-fast-worktree` |
| Change sandboxing | `xai-grok-sandbox` + enforcement points in `computer/local/*.rs` |
| Change file watching / index sync | `xai-grok-workspace/src/fs_notify.rs`, `xai-fsnotify`, `xai-hunk-tracker`, `xai-codebase-graph` |
| Change hooks (external scripts) | `xai-grok-hooks` + turn-hook dispatch in `workspace/src/handle.rs` |

### Config, storage, ops

| I want to… | Go to |
|---|---|
| Add a config key / change merge order | `xai-grok-config` (+ `xai-grok-config-types` for shared value types) |
| Change session event schema | `xai-grok-session-events` |
| Change session search / FTS5 index | `xai-grok-session-search` |
| Change memory persistence | `xai-grok-memory` |
| Change self-update / version feed | `xai-grok-update` (fork feed `weseegod/thanh`; version crates: `xai-grok-version`, `xai-grok-pager-bin`) |
| Change telemetry / analytics | `xai-grok-telemetry` |
| Change voice input | `xai-grok-voice` (+ pager `src/voice/`) |
| Change CLI subcommands / entry dispatch | `xai-grok-pager-bin/src/main.rs` (`async_main`) |

---

## 8. Fork notes & conventions

### BYOK customization layer

This fork keeps upstream core as-is and adds a thin layer so third-party
models (DeepSeek, OpenRouter, OpenAI-compatible) work with bring-your-own-key.
Frequently touched fork-owned files (also the upstream-merge inventory in
`UPSTREAM-MERGE.md`):

- Identity: `thanh` binary, `~/.thanh` home (never `~/.grok`; single source of
  truth `xai-dirs` `grok_home_in`), fork release feed in
  `xai-grok-update/src/version.rs` + `auto_update.rs`.
- BYOK model config: `xai-grok-shell/src/agent/config.rs`,
  `config_model_override_parse.rs`, `models.rs` — `input`/`input_modalities`
  parsing and text-only capability checks.
- Image stripping for text-only models: `strip_image_parts_for_text_only` in
  `xai-grok-sampling-types/src/conversation.rs` (+ call sites in shell
  session code).
- Plan approval: `g` run-as-goal (`ApprovedAsGoal`) and `/model` picker on
  top of the overlay (not covered by `line_viewer`).
- Trim grok.com chrome: no Privacy banner / `/privacy` / coding-data row; no
  `/usage` limits or upgrade CTAs; no announcement promo; paywall stripped
  (`subscription.rs` keeps the gate chokepoint). Keep `/context` and
  `/session-info`.
- TUI UX: `/clear`, `/new` keep-model behavior, turn-status/tasks-pane tweaks
  in `xai-grok-pager`.
- Build/release: `build.sh`, `scripts/publish_release.sh` (local builds, no
  CI), `docs/byok-models.md`, `docs/post-merge-core-fix.md`,
  `docs/desktop-app.md` + `docs/desktop-app-implement.md` (desktop ACP
  client; code in `frontend/apps/thanh-desktop/`, not a workspace crate).
- Merge playbook: `UPSTREAM-MERGE.md` (must-not-regress A/B/C + trim D).

### Conventions every engineer should know

- **The root `Cargo.toml` is generated** — workspace members/deps/lints/
  profiles. Edit **per-crate `Cargo.toml`** files instead.
- Toolchain pinned by `rust-toolchain.toml`; lint config `clippy.toml`,
  format config `rustfmt.toml` at repo root.
- **Build/test per-crate**: `cargo check -p <crate>` — full-workspace builds
  are slow. Fast pre-gate for the core: `cargo check -p xai-grok-shell
  -p xai-grok-pager -p xai-grok-sampling-types`.
- `SOURCE_REV` records the upstream monorepo SHA of the current sync.
- Tests: unit tests live next to code (`*_tests.rs` files or inline `mod
  tests`), integration tests in `tests/`, snapshot tests via `insta`.
- The tool RPC stack is branded "xAI Computer Hub" (`xai-computer-hub-*`,
  `xai-tool-*`): the unified `Tool` trait and dispatch live in
  `xai-tool-runtime`, wire types in `xai-tool-protocol`.

---

*Maintained as the navigational companion to `README.md`. When a crate,
module, or path here moves, update this file in the same change.*
