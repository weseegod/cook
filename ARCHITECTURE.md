# Cook — Architecture

This document is the engineer-facing map of the repository: the main
components, their boundaries, and where to go to change them. For installation
and basic use, see [`README.md`](README.md). The upstream synchronization
process is in [`UPSTREAM-MERGE.md`](UPSTREAM-MERGE.md).

## 1. Product and runtime overview

Cook is a Rust workspace for a local-first AI coding agent. The CLI binary is
`cook` (built from `xai-grok-pager-bin`), and its default home is `~/.cook`.
The same agent runtime serves these entry points:

- **Interactive TUI** — full-screen terminal interface, launched by `cook`.
- **Headless mode** — `cook -p "<prompt>"` for scripts and CI.
- **ACP server** — `cook agent stdio` for editor integrations using the Agent
  Client Protocol (ACP).
- **Let Cook Desktop** — Tauri and React client in
  [`frontend/apps/let-cook/`](frontend/apps/let-cook/). It connects to the
  existing agent; its module map is
  [`frontend/apps/let-cook/ARCHITECTURE.md`](frontend/apps/let-cook/ARCHITECTURE.md),
  and its product boundary is specified in
  [`docs/desktop-app.md`](docs/desktop-app.md).

The TUI normally uses the agent in-process. Leader mode lets multiple clients
share an agent process over a Unix socket. Desktop starts `cook agent stdio`.
Across these modes, `xai-grok-shell` owns session execution; the clients handle
input and presentation.

```text
TUI / headless ──entry points──┐
                               ├──> xai-grok-shell ──> sampler ──> model API
ACP clients ──ACP stdio────────┘          │
                                          ├── tool runtime ──> xai-grok-tools
                                          │                         │
                                          │                         └── xai-grok-workspace
                                          └── session events / storage

Let Cook Desktop ──ACP stdio──> cook agent stdio ──> xai-grok-shell
```

Shared services include configuration and authentication, MCP, sandboxing,
memory, Markdown rendering, session events and indexes, telemetry, and
updates. Session events are the canonical record; SQLite databases are derived
indexes or metadata stores.

## 2. Runtime and crate boundaries

Paths below are relative to the repository root.

| Component | Responsibility | Main location |
|---|---|---|
| `xai-grok-pager-bin` | `cook` entry point and subcommand dispatch | `crates/codegen/xai-grok-pager-bin/` |
| `xai-grok-pager` | TUI, headless client, ACP client, actions and scrollback | `crates/codegen/xai-grok-pager/` |
| `xai-grok-pager-render` | Terminal drawing, themes, syntax highlighting and glyphs | `crates/codegen/xai-grok-pager-render/` |
| `xai-grok-shell` | Agent runtime, session actors, turns, goals, subagents and workflows | `crates/codegen/xai-grok-shell/` |
| `xai-grok-agent` | Agent definition, system prompts, tools and policy configuration | `crates/codegen/xai-grok-agent/` |
| `xai-grok-sampler` and `xai-grok-sampling-types` | Provider requests, streaming, retries and wire-format conversion | `crates/codegen/xai-grok-sampler/`, `crates/codegen/xai-grok-sampling-types/` |
| `xai-grok-tools` and `xai-tool-runtime` | Tool registry, dispatch and implementations | `crates/codegen/xai-grok-tools/`, `crates/common/xai-tool-runtime/` |
| `xai-grok-workspace` | Filesystem, processes, permissions, VCS, checkpoints and worktrees | `crates/codegen/xai-grok-workspace/` |
| Let Cook | Tauri host and React ACP client; a leaf application | `frontend/apps/let-cook/` |

Other shared crates are grouped by purpose:

- **Conversation and storage:** `xai-chat-state`, `xai-grok-session-events`,
  `xai-grok-session-search`, `xai-active-sessions`, and
  `xai-grok-foreign-sessions`.
- **Context and memory:** `xai-grok-compaction`, `xai-compaction-transcript`,
  `xai-grok-memory`, `xai-token-estimation`, and `xai-grok-markdown`.
- **Configuration and identity:** `xai-grok-config`, `xai-grok-config-types`,
  `xai-grok-auth`, `xai-grok-home`, `xai-grok-paths`, `xai-grok-secrets`, and
  `xai-grok-env`.
- **Execution and integrations:** `xai-grok-mcp`, `xai-grok-sandbox`,
  `xai-computer-hub-*`, `xai-fast-worktree`, `xai-fsnotify`, and
  `xai-codebase-graph`.
- **Operations:** `xai-grok-update`, `xai-grok-version`,
  `xai-grok-telemetry`, `xai-grok-hooks`, `xai-grok-voice`, and
  `xai-grok-announcements`.

The workspace is organized into `crates/codegen/*` for product and feature
crates, `crates/common/*` for shared libraries, and `crates/build/` for build
helpers. `prod/` and `third_party/` contain supporting and vendored sources.

### Process and release

`crates/codegen/xai-grok-pager-bin/src/main.rs` initializes the CLI and routes
subcommands such as `agent`, `models`, `leader`, `worktree`, `sessions`, and
`update`. The default path starts the TUI; headless and ACP modes enter shell
agent entry points.

- `./build.sh` builds the release CLI and installs `cook` under
  `~/.cook/bin/`, with a user-local command link when supported.
- `scripts/publish_release.sh` handles the version bump, tag, and push. The
  release workflow builds the CLI and Let Cook for supported platforms and
  publishes artifacts to <https://download.letcook.dev>. See
  [`docs/desktop-release.md`](docs/desktop-release.md).
- `SOURCE_REV` records the upstream monorepo commit used for the current sync.

## 3. Request lifecycle

A conversation turn crosses these boundaries:

1. A client receives user input. The TUI sends it to its agent connection;
   Desktop sends ACP messages to `cook agent stdio`.
2. `xai-grok-shell` resolves the model, workspace, agent definition, MCP
   configuration, trust, and session context. `MvpAgent` starts a session
   actor in `crates/codegen/xai-grok-shell/src/session/acp_session_impl/`.
3. The session actor builds the request, tools, reminders, and context, then
   `xai-grok-sampler` streams the provider response.
4. Tool calls pass through session validation, permission and hook handling,
   then `WorkspaceOps::call_tool` and the tool runtime.
5. Tools use workspace filesystem and process interfaces. Results, usage, and
   session events return to the agent and are sent to connected clients.
6. The client renders the response. The TUI uses `xai-grok-markdown` and
   `xai-grok-pager-render`; Desktop uses its React transcript components.

The shell's `src/session/acp_session_impl/` contains session setup, the run
loop, turn handling, tool dispatch, and tool-call processing. The session actor
runs on its own OS thread with a current-thread Tokio runtime. Sampler and
chat-state responsibilities are in their own crates.

### Important subsystem locations

- **TUI:** `crates/codegen/xai-grok-pager/src/app/` contains the app state,
  event loop, dispatch, effects, and ACP handling. `src/views/` contains
  screens and widgets; `src/scrollback/` contains conversation rendering;
  `src/slash/commands/` contains slash commands.
- **Shell and sessions:** `crates/codegen/xai-grok-shell/src/agent/` contains
  the ACP agent and subagent coordination. `src/session/` contains turns,
  compaction, goal orchestration, MCP, workflows, persistence, and memory
  coordination. Built-in Rhai workflow scripts are under
  `src/session/workflows/`.
- **Tools:** `crates/codegen/xai-grok-tools/src/implementations/` groups tools
  by profile, including `grok_build/`, `codex/`, and `opencode/`. The registry
  and built-in registrations are in `src/registry/types.rs`.
- **Workspace:** `crates/codegen/xai-grok-workspace/src/` contains filesystem,
  session, permissions, worktree, and execution code. Its
  `AsyncFileSystem` and terminal interfaces are the boundaries used by tools.
- **Desktop:** The product contract is in
  [`docs/desktop-app.md`](docs/desktop-app.md); the method-level comparison
  with TUI behavior is in [`docs/desktop-tui-capability-map.md`](docs/desktop-tui-capability-map.md).

The desktop capability map records which methods the client actually
implements. Treat it as the wire-status reference; the product contract
explains intended boundaries.

## 4. Where to make a change

In the change maps, shortened paths such as `xai-grok-shell/src/...` refer to
files inside that crate; `src/...` is relative to the crate named in the same
row or bullet. Resolve each crate directory from its entry in §2 or its
`Cargo.toml`.

### TUI and presentation

| Change | Location |
|---|---|
| Add a TUI screen or widget | `crates/codegen/xai-grok-pager/src/views/` and `src/app/` |
| Change a default key binding | `crates/codegen/xai-grok-pager/src/actions/defaults.rs` |
| Add a slash command | `crates/codegen/xai-grok-pager/src/slash/commands/`, registered in `src/slash/registry.rs` |
| Change scrollback or Markdown behavior | `crates/codegen/xai-grok-pager/src/scrollback/` and `crates/codegen/xai-grok-markdown/` |
| Change terminal drawing, color, theme, or highlighting | `crates/codegen/xai-grok-pager-render/src/` |
| Read the TUI presentation catalog | [`docs/tui-presentation.md`](docs/tui-presentation.md) |
| Change the desktop app | [`frontend/apps/let-cook/ARCHITECTURE.md`](frontend/apps/let-cook/ARCHITECTURE.md) |

The pager re-exports rendering primitives from `xai-grok-pager-render`. Keep
raw drawing and theme changes there; screen behavior belongs in
`xai-grok-pager`.

### Agent, tools, and workspace

| Change | Location |
|---|---|
| Change prompt handling or the turn loop | `crates/codegen/xai-grok-shell/src/session/acp_session_impl/` |
| Change tool dispatch, hooks, or permissions around calls | `xai-grok-shell/src/session/acp_session_impl/tool_calls.rs` and `tool_dispatch.rs` |
| Change session startup or actor spawn | `xai-grok-shell/src/session/acp_session_impl/spawn.rs`, `session_setup.rs`, and `xai-grok-shell/src/agent/mvp_agent/` |
| Change compaction | `xai-grok-shell/src/session/compaction*.rs`, `two_pass.rs`, `session/helpers/`, and `xai-grok-compaction` |
| Change goal orchestration | `xai-grok-shell/src/session/goal_*.rs` and `goal_classifier/` |
| Change subagents | `xai-grok-shell/src/agent/subagent/` and `xai-grok-subagent-resolution/` |
| Change workflow execution or scripts | `xai-grok-shell/src/session/workflow/` and `src/session/workflows/` |
| Add or change a tool | `xai-grok-tools/src/implementations/`, then update `src/registry/types.rs` and tool metadata as needed |
| Change local file or process access | `xai-grok-tools/src/computer/local/` and `xai-grok-workspace/src/file_system/` |
| Change approvals, git, checkpoints, or worktrees | `xai-grok-workspace/src/permission/`, `src/session/`, or `src/worktree/` |
| Change MCP transports or credentials | `xai-grok-mcp/`; session-level MCP integration is in `xai-grok-shell/src/session/` |

### Configuration, storage, and operations

| Change | Location |
|---|---|
| Add a config setting or change config merging | `xai-grok-config/` and shared value types in `xai-grok-config-types/` |
| Change model configuration or provider behavior | `xai-grok-shell/src/agent/` and `xai-grok-sampling-types/` |
| Change session event schema | `xai-grok-session-events/` |
| Change session search | `xai-grok-session-search/` |
| Change memory persistence | `xai-grok-memory/`; shell coordination is in `xai-grok-shell/src/session/` |
| Change self-update or version feed | `xai-grok-update/`, `xai-grok-version/`, and `xai-grok-pager-bin/` |
| Change telemetry | `xai-grok-telemetry/` |
| Change voice input | `xai-grok-voice/` and `xai-grok-pager/src/voice/` |
| Change CLI entry dispatch | `crates/codegen/xai-grok-pager-bin/src/main.rs` |

For core-agent context and token behavior, see
[`docs/core-agent-flow-and-token-optimization.md`](docs/core-agent-flow-and-token-optimization.md).
For the real-model suite verification order, see
[`docs/real-model-suite-run-order.md`](docs/real-model-suite-run-order.md).

## 5. Storage and repository conventions

Cook's default home is `~/.cook`. `$COOK_HOME` selects a custom home; `$GROK_HOME`
is a compatibility fallback, subject to protections against using the real
`~/.grok` or `~/.thanh` directories. Project `.grok/` configuration belongs to
the workspace and is separate from the user home.

| Path under `~/.cook` | Contents |
|---|---|
| `config.toml`, `managed_config.toml`, `requirements.toml` | User and managed configuration layers |
| `auth.json` and credential stores | Authentication and provider credentials |
| `bin/cook` | Managed CLI binary, updated by the self-updater |
| `sessions/` | Session event records, transcripts, and uploads |
| Search databases | Derived indexes; they are not the canonical session history |
| `memory/`, `memory-v2/` | Legacy memory and opt-in topic/observation memory |
| `logs/`, `docs/user-guide/`, caches | Logs, extracted user guides, and caches |

Repository conventions:

- The root `Cargo.toml` is generated. Edit per-crate manifests instead of the
  workspace manifest.
- The toolchain is pinned in `rust-toolchain.toml`; formatting and lint
  configuration are in `rustfmt.toml` and `clippy.toml`.
- Prefer targeted crate checks such as `cargo check -p <crate>`; full workspace
  builds take longer.
- `frontend/apps/let-cook/src-tauri` is a leaf crate with its own empty
  `[workspace]`. Do not add it to the generated root workspace or make it
  depend directly on shell, pager, or tools crates. Desktop behavior belongs
  in the ACP client and its host boundary.
- Unit tests generally live beside the implementation; integration and
  snapshot tests live in crate test directories.

## 6. Maintainer references

- [`UPSTREAM-MERGE.md`](UPSTREAM-MERGE.md) — upstream sync and fork-owned
  surfaces.
- [`docs/byok-models.md`](docs/byok-models.md) — model/provider configuration.
- [`docs/desktop-release.md`](docs/desktop-release.md) — desktop packaging and
  release process.
- [`crates/codegen/xai-grok-pager/docs/user-guide/`](crates/codegen/xai-grok-pager/docs/user-guide/)
  — CLI usage, configuration, permissions, MCP, plugins, and integrations.
