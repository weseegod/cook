# Thanh Desktop — Architecture

Thanh Desktop is a **chat-first ACP client** for the existing `thanh` agent.
It does not reimplement sampling, tools, or session storage.

**Code:** `frontend/apps/thanh-desktop/` (Tauri 2 + React, shipped as v1).  
**Agent:** `thanh agent stdio` (`xai-grok-shell` / `MvpAgent`).  
**Home:** `~/.thanh`, shared with the CLI.

Production work (providers, Claude Desktop–class features, packaging) lives in
[`docs/desktop-app-implement.md`](desktop-app-implement.md). BYOK TOML:
[`docs/byok-models.md`](byok-models.md). Runtime map: [`ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## 1. Product boundary

Desktop is a presentation client, not an IDE and not a second agent.

| Is | Is not |
|---|---|
| Streaming chat over ACP | Cursor / VS Code feature clone |
| Tool cards, diffs, permissions | Debugger, git GUI, LSP IDE |
| Shared `~/.thanh` with CLI | Separate auth/config/session store |
| Linux + macOS first | Electron Chromium bundle |

Upstream Grok Build already used this shape (`frontend/apps/grok-desktop`,
`clientIdentifier: grok-desktop`). This fork does not ship that tree. Thanh
Desktop is a new app on the **same ACP contract**.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2 | Rust host, small installer, capability allowlist, Linux-first |
| UI | React 19 + Vite + TypeScript | Chat/markdown/diff ecosystem |
| Agent | Discovered `thanh agent stdio` | One runtime with TUI/headless |
| Protocol | ACP v1 + typed `x.ai/*` | Same wire as pager / IDE clients |
| State | Zustand + TanStack Query | Transcript vs catalogs |
| CSS | Tailwind v4 + semantic CSS tokens | VS Code visual density with TUI transcript semantics |
| Packages | pnpm | Matches announcements `generate.sh` |

`src-tauri` is **not** a member of the generated root Cargo workspace. It has
an empty `[workspace]` so `cargo` in that directory does not join the 93-crate
tree.

Electron remains an escape hatch only if WebKitGTK fails streaming or a future
xterm embed. Native GUI (egui/GPUI) would invent a third markdown stack.

---

## 3. Process model

```
┌──────────────────────────────────────────────────────────────────┐
│  thanh-desktop (Tauri 2)                                         │
│                                                                  │
│  ┌─────────────────────────────┐   IPC (typed commands/events)  │
│  │ Renderer (React, no Node)   │ ◄────────────────────────────► │
│  │  chat · sessions · settings │                                │
│  │  permissions · diffs · mcp  │   ┌─────────────────────────┐  │
│  └─────────────────────────────┘   │ Rust host (src-tauri)   │  │
│                                    │  window · dialog        │  │
│                                    │  spawn/kill sidecar     │  │
│                                    │  ACP stdio mux          │  │
│                                    │  updater · deep link    │  │
│                                    └────────────┬────────────┘  │
└─────────────────────────────────────────────────┼───────────────┘
                                                  │ stdin/stdout
                                                  │ JSON-RPC ACP
                                                  ▼
                                   ┌──────────────────────────────┐
                                   │ thanh agent stdio            │
                                   │ xai-grok-shell · MvpAgent    │
                                   │ clientIdentifier:            │
                                   │   grok-desktop               │
                                   │   (alias thanh-desktop)      │
                                   └──────────────┬───────────────┘
                                                  │
                                   ~/.thanh  (config, auth, sessions,
                                    models, memory, logs) — shared CLI
```

**Lifecycle**

1. Resolve binary: `THANH_BIN` → `~/.thanh/bin/thanh` → bundled sidecar (stable).
2. Major-version gate against `xai-grok-version`.
3. Spawn `thanh agent stdio` with the workspace cwd.
4. `initialize` **once per agent process**.
5. `session/new` or `session/load` per conversation.
6. Crash → host restart + client `session/load` replay.
7. Quit → cancel in-flight turn, kill the child process group.

v1: one window ↔ one agent process.

---

## 4. Invariants

**Forbidden**

- Calling the LLM or tools from React or from a Tauri command.
- Workspace FS via `@tauri-apps/plugin-fs` except folder pick / reveal-in-finder.
- A second session store. Canonical records stay `events.jsonl` + agent SQLite.
- A second `config.toml` writer in the renderer. Mutations go through the agent.

**Allowed in the Rust host**

- Spawn/restart the sidecar, stdio, JSON-RPC id map, notification coalescing.
- Native folder dialog, notifications, window state, app updater, OIDC deep link.

Unknown `x.ai/*` methods: log and ignore. Never crash the host.

---

## 5. ACP contract

### 5.1 `initialize`

```json
{
  "protocolVersion": "1",
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },
    "terminal": true
  },
  "clientInfo": { "name": "Thanh Desktop" },
  "_meta": {
    "clientIdentifier": "grok-desktop",
    "clientType": "grok_desktop",
    "mcpApps": true
  }
}
```

`grok-desktop` maps to `ClientType::Desktop` in
`xai-grok-workspace` (`permission/types.rs`). Alias `thanh-desktop` must keep
the same behavior (permission prompts, MCP apps, folder trust).

`terminal: true` is advertised even when the UI stubs PTY, so the agent can
emit terminal methods.

### 5.2 Standard ACP

| Direction | Methods |
|---|---|
| Client → Agent | `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_model` |
| Agent → Client | `session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, terminal create/output |

Host implements `fs/read_text_file` / `fs/write_text_file` in Rust, restricted
to the session cwd and explicit allow-paths.

### 5.3 `x.ai/*` groups

Wire strings in `mvp_agent/acp_agent.rs` and `xai-grok-mcp/src/wire.rs` are
authoritative.

| Group | Methods |
|---|---|
| Session | `x.ai/session/list`, `search`, `load_history`, `info`, `close`, `rename`, `delete`, `fork`, `usage` |
| Models | `x.ai/models/list`, `x.ai/models/update` |
| Commands | `x.ai/commands/list` |
| Permissions | `session/request_permission`, `x.ai/permissions/reset`, `x.ai/yolo_mode_changed` |
| Plan / queue | `x.ai/toggle_plan_mode`, `x.ai/exit_plan_mode`, `x.ai/queue/*` |
| Tasks | `x.ai/task/*`, `x.ai/subagent/*`, `x.ai/scheduler/*` |
| Terminal | `x.ai/terminal/*` |
| MCP | `x.ai/mcp/call`, `sdk_call`, `elicit`, tools_changed |
| Auth | `x.ai/auth/*`, `x.ai/getApiKey`, `x.ai/setApiKey` |
| Memory / skills | `x.ai/memory/*`, `x.ai/skills/*`, `x.ai/workflows/list` |
| Interaction | `x.ai/ask_user_question`, rewind, compact, folder trust |

v1 handles a subset (sessions, models, commands, permissions, plan, ask-user,
folder trust, a single API-key field). Production extensions are listed in the
implement doc.

### 5.4 Transcript presentation

ACP notifications are an event stream, not presentation-ready chat rows. The
desktop client keeps a turn-scoped streaming cursor like the TUI tracker:

- adjacent `AgentMessageChunk` updates append to the active assistant segment;
  clients must not require a `messageId`, because standard ACP chunks do not
  guarantee one;
- a tool call closes the active prose segment, updates in place by
  `toolCallId`, and consecutive thought/tool events project into one compact
  activity group;
- prompt completion, cancellation, load completion, or failure finalizes all
  active segments before syntax highlighting and Mermaid rendering;
- replay and live updates use the same reducer so loading a session cannot
  produce a different transcript shape.

The visual language intentionally follows VS Code Dark Modern for density,
typography, controls, focus states, and colors. This does not change the product
boundary: Thanh Desktop remains chat-first and does not add an editor, LSP,
debugger, or git workbench.

---

## 6. Layout

```
frontend/apps/thanh-desktop/
  src/
    acp/          # host IPC, ThanhAcpClient, x.ai wrappers, ts-rs generated/
    state/        # session transcript, catalogs
    ui/           # app-shell, chat, permissions, sessions, settings, welcome
    theme/
  src-tauri/src/  # acp_host.rs, bin_resolve.rs — not a workspace crate
  scripts/install.sh
```

Announcements and updater tests target this path:

- `crates/codegen/xai-grok-announcements/generate.sh`
- `crates/codegen/xai-grok-update/tests/test_install_sh.rs`

---

## 7. Key decisions

1. Desktop is an ACP client. Reuse `thanh agent stdio` and `~/.thanh`.
2. Tauri 2 + React + Vite + TypeScript.
3. Chat-first, not an IDE.
4. `clientIdentifier: grok-desktop`; `thanh-desktop` is an alias.
5. Path `frontend/apps/thanh-desktop/` avoids colliding with upstream
   `grok-desktop` if that tree is ever merged.
6. `src-tauri` stays out of the Cargo workspace.
7. Alpha requires the CLI binary; stable may bundle a sidecar. The app never
   overwrites `~/.thanh/bin/thanh`.
8. Renderer does not merge `config.toml`.
9. This fork is BYOK: no xAI subscription required.

---

## 8. Dev loop

```sh
cd frontend/apps/thanh-desktop
pnpm install
pnpm test
pnpm tauri dev
```

| Var | Meaning |
|---|---|
| `THANH_BIN` | Override path to `thanh` |
| Home resolution | Must stay `~/.thanh`, never `~/.grok` |

Linux build deps: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `librsvg2-dev`,
`patchelf`, `libssl-dev`.
