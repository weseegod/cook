# Thanh Desktop — Implementation Spec

Thanh Desktop is a **chat-first ACP client** for the existing `thanh` agent.
It is not a Cursor-class IDE and it does not reimplement the agent.

This document is the canonical spec. The app path is
`frontend/apps/thanh-desktop/` (**implemented**). The agent remains
`thanh agent stdio` (`xai-grok-shell` /
`MvpAgent`).

Related: [`ARCHITECTURE.md`](../ARCHITECTURE.md) (runtime map),
[`docs/byok-models.md`](byok-models.md) (BYOK config).

---

## 1. Product

| v1 ships | v1 does not ship |
|---|---|
| Streaming chat + markdown | Full editor (Monaco as IDE) |
| Session list / resume / search | Debugger, git GUI, LSP IDE |
| Tool cards (bash, read, edit, grep, web) | Multi-window IDE workspace |
| Permission, plan-mode, ask-user prompts | A second agent runtime |
| Model picker + BYOK settings | Electron Chromium bundle |
| Folder picker + workspace trust | Re-skin of the TUI in a PTY |
| Shared `~/.thanh` with the CLI | Separate config / auth home |
| Linux x86_64 + macOS aarch64 | Windows (v2) |

**Why this product.** `thanh` already is the product. TUI, headless, and ACP
stdio share one runtime. Desktop is a better presentation layer (fonts,
images, diffs, mouse, layout), not a second brain.

Upstream Grok Build already treated desktop this way: a TypeScript app at
`frontend/apps/grok-desktop` speaking ACP with `clientIdentifier:
grok-desktop`. This fork does not ship `frontend/`. Thanh Desktop is a new
app on the **same contract**, not a recovery of upstream UI source.

---

## 2. Stack

### 2.1 Choices

| Layer | Choice | Rejected |
|---|---|---|
| Desktop shell | **Tauri 2** | Electron, Wails, Neutralino, egui/iced/GPUI |
| UI | **React 19 + Vite + TypeScript** | Svelte/Solid (weaker chat/markdown/xterm ecosystem) |
| Agent | **Sidecar / discovered `thanh agent stdio`** | Port agent to TS, HTTP headless |
| Protocol | **ACP v1** (`@agentclientprotocol/sdk`) + typed `x.ai/*` | Homegrown JSON-RPC |
| UI state | Zustand (transcript/turn) + TanStack Query (lists) | Redux |
| Markdown | `react-markdown` + Shiki, block-level streaming | Port `xai-grok-markdown` (TUI-only) |
| CSS | Tailwind v4 + tokens mapped from TUI appearance | CSS-in-JS |
| Package manager | pnpm | npm/yarn as source of truth |
| Repo path | `frontend/apps/thanh-desktop/` | Root-level app; `grok-desktop` (upstream collision) |

### 2.2 Why Tauri 2 + React is the right stack here

Not “Tauri always beats Electron”. It matches five constraints of this fork:

1. **The agent is already a Rust binary.** Spawning `thanh agent stdio` from
   the Tauri host is the natural primitive. Electron would still need a child
   process and a packer, with no extra leverage.
2. **The UI is a web problem.** Streaming markdown, mermaid, images, diff
   hunks, permission modals — web renderers beat immediate-mode GUI. The TUI
   already proved the feature set; desktop needs pixels, not a third renderer.
3. **Installer size.** Releases are GitHub assets built locally. Electron is
   150–250 MB; Tauri is ~8–20 MB plus an optional `thanh` sidecar. Users often
   already have the CLI.
4. **Security.** The agent runs bash on the user machine. Tauri’s capability
   allowlist and a renderer without Node is a smaller attack surface than
   Chromium + Node.
5. **Linux is first-class** (dev machine + `linux-x86_64` CLI releases). Pin
   `webkit2gtk-4.1` and test the target distro.

React is not the fastest UI runtime. ACP + the LLM are the bottleneck.
Switching UI frameworks later is cheap; switching Electron ↔ Tauri is not.

### 2.3 Rejected stacks

| Stack | When it would win | Why not for v1 |
|---|---|---|
| Electron + React | Pixel-identical Chromium, heavy Monaco/xterm, enterprise updater | Huge binary; no Rust leverage. Escape hatch only if WebKitGTK fails streaming or xterm. |
| GPUI (Zed) | GPU-native editor, team locked to Zed | No chat/markdown ecosystem; this fork does not inherit Zed. |
| egui / iced / Slint | Internal tools, simple chrome | Would invent a third markdown/image/diff stack. |
| Wails | Go backend | Backend is Rust. |
| PTY window around the TUI | One-week ship | Not a desktop app. |
| Svelte/Solid + Tauri | Tiny apps, compiler-first teams | React wins at markdown, `@xterm/xterm`, CodeMirror, chat components. |

### 2.4 Risks and mitigations

| Risk | Mitigation |
|---|---|
| Linux WebKitGTK version skew | Document `webkit2gtk-4.1`; smoke markdown/stream/scroll on Ubuntu LTS; mermaid WASM fallback |
| Large NDJSON streams jank the WebView | Coalesce ACP notifications in the Rust host; send `bufferingSettings` on `initialize` |
| Two artifacts to update (`thanh` + app) | Alpha: require installed CLI. Stable: optional sidecar. CLI updater never writes the app; Tauri updater never writes `~/.thanh/bin/thanh` |
| `@agentclientprotocol/sdk` does not cover `x.ai/*` | Thin `ThanhAcpClient` over the SDK + hand-typed / ts-rs extension methods |
| Windows WebView2 | Not a v1 blocker |

---

## 3. Architecture

One agent, many clients. Desktop is a sibling of the TUI and of editor ACP
integrations.

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

**Forbidden**

- Calling the LLM or tools from React or from a Tauri command.
- Reading/writing the workspace with `@tauri-apps/plugin-fs` except folder
  pick / reveal-in-file-manager.
- A second session store. Canonical records stay `events.jsonl` + the
  agent’s SQLite search index.

**Allowed in the Rust host (not in the agent)**

- Spawn/restart the sidecar, stdio pipes, JSON-RPC id map.
- Native folder dialog, notifications, window state.
- Custom protocol / deep link for OIDC (optional; BYOK is API-key first).
- App self-update.

### 3.1 Process model

1. App start → resolve binary: `THANH_BIN`, else `~/.thanh/bin/thanh`, else
   bundled sidecar (stable only).
2. Version gate: `thanh --version` must share the app’s major
   (`xai-grok-version` lockstep).
3. Spawn `thanh agent stdio`. Working directory is last workspace or the
   folder picker result.
4. `initialize` **once per agent process** (`MvpAgent::initialize` invariant).
5. `session/new` or `session/load` per conversation.
6. Sidecar crash → host restart + client replays `session/load` (same pattern
   as the pager leader bridge).
7. App quit → `session/cancel` if a turn is live, then kill the child process
   group.

v1: one window ↔ one agent process. Do not share the leader socket across
windows yet.

### 3.2 `initialize` contract

```json
{
  "protocolVersion": "1",
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },
    "terminal": true
  },
  "meta": {
    "clientIdentifier": "grok-desktop",
    "clientType": "grok_desktop",
    "mcpApps": true
  }
}
```

`clientIdentifier: grok-desktop` maps to existing `ClientType::Desktop` in
`xai-grok-workspace` (`permission/types.rs`): permission prompts, user-agent
`grok-desktop`, MCP apps, folder trust. Add alias `thanh-desktop` in
`ClientType::from_client_identifier` without changing behavior.

Advertise `terminal: true` from day one so the agent can emit PTY methods;
the UI may stub them until v2.

### 3.3 ACP methods

**ACP v1 (via `@agentclientprotocol/sdk`)**

| Direction | Methods |
|---|---|
| Client → Agent | `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_model` |
| Agent → Client | `session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, terminal create/output |

**`x.ai/*` extensions — v1 must handle**

| Group | Methods | UI |
|---|---|---|
| Session | `x.ai/session/list`, `search`, `load_history`, `info`, `close`, `rename`, `delete`, `fork`, `usage` | Sidebar, search, hydrate |
| Models | `x.ai/models/list` + `x.ai/models/update` | Model picker (BYOK) |
| Commands | `x.ai/commands/list` | Slash palette |
| Permissions | `session/request_permission`, `x.ai/permissions/reset`, `x.ai/yolo_mode_changed` | Approve modal / YOLO |
| Plan | `x.ai/toggle_plan_mode`, `x.ai/exit_plan_mode` | Plan banner |
| Queue | `x.ai/queue/*` | Prompt queue |
| Tasks / subagents | `x.ai/task/*`, `x.ai/subagent/*`, `x.ai/scheduler/*` | Tasks pane (v1.1 ok to stub) |
| Terminal | `x.ai/terminal/*`, `x.ai/terminal/pty/input` | xterm.js in v2; ack/stub in v1 |
| MCP | `x.ai/mcp/call`, `sdk_call`, `elicit`, tools_changed | MCP modal (v1.1) |
| Auth | `x.ai/auth/*`, `x.ai/getApiKey`, `x.ai/setApiKey` | Login / BYOK |
| Memory / skills | `x.ai/memory/*`, `x.ai/skills/*`, `x.ai/workflows/list` | Settings |
| Interaction | `x.ai/ask_user_question`, rewind, compact | Minimal v1 surfaces |

Unknown extension methods: log and ignore. Never crash the host.

Wire strings live in the shell (`mvp_agent/acp_agent.rs` `ext_method` match)
and `xai-grok-mcp/src/wire.rs`. Treat those as the source of truth when
adding a typed client method.

### 3.4 Client FS / permission callbacks

If `clientCapabilities.fs` is advertised, the agent may ask the **client** to
read/write text files. For Thanh Desktop the workspace is local, so the host
should:

- Implement `fs/read_text_file` / `fs/write_text_file` in the Rust host
  (not the renderer), restricted to the session cwd and explicit allow-paths.
- Prefer letting the agent use its own `LocalFs` when the client does not
  need editor buffers. Start with fs capabilities **on** (matches Grok
  Desktop / IDE clients) so permission + code-nav paths stay identical.

`session/request_permission` must always be answered by the UI (allow once /
always / reject). `ClientType::Desktop` already has
`can_present_permission_prompt = true`.

---

## 4. Repository layout

```
frontend/apps/thanh-desktop/
  package.json
  pnpm-lock.yaml
  vite.config.ts
  index.html
  README.md
  scripts/install.sh          # stub until packaging PR
  src/
    main.tsx
    acp/
      host.ts                 # Tauri invoke wrappers
      client.ts               # session state machine
      xai.ts                  # typed x.ai/* methods
      generated/              # ts-rs (announcements, etc.)
    state/
      session.ts
      catalog.ts
    ui/
      app-shell.tsx
      chat/
      permissions/
      sessions/
      settings/
      welcome/
    theme/
  src-tauri/
    Cargo.toml                # [workspace] empty — NOT a root workspace member
    tauri.conf.json
    capabilities/default.json
    src/
      lib.rs
      main.rs
      acp_host.rs
      bin_resolve.rs
```

**Cargo workspace.** `src-tauri` must **not** be added to the generated root
`Cargo.toml` members list. Give it an empty `[workspace]` so `cargo` in that
directory does not join the 93-crate workspace.

**Announcements / updater tests.** These integrations are retargeted to
`frontend/apps/thanh-desktop`:

- `crates/codegen/xai-grok-announcements/generate.sh` `DESKTOP_DIR`
- `crates/codegen/xai-grok-update/tests/test_install_sh.rs`
  `desktop_install_sh_path()`

---

## 5. UX map (TUI → desktop)

Do not clone TUI keybindings 1:1. Desktop is mouse + Command palette.

### v1

1. Welcome: folder pick, trust prompt, recent workspaces
   (`x.ai/workspaces/list`).
2. Chat: composer, slash palette, streaming text, cancel, queue.
3. Tool cards: bash (collapsed), read_file, search_replace (diff), grep,
   web_*, image preview.
4. Permissions: allow once / always / deny; YOLO toggle.
5. Sessions: list, search, resume (including TUI-created sessions), rename,
   delete.
6. Models: `x.ai/models/list`; BYOK entries in `~/.thanh/config.toml` appear
   automatically.
7. Settings: narrow surface (default model, always-approve). Do **not** write
   a second TOML merger; deep edits stay in the file / CLI.
8. Ask-user and plan-mode banners (agent already emits them).
9. Status: model, cwd, turn tokens.

### v1.1

File-tree preview (CodeMirror, not an IDE), full-file diffs, dashboard /
tasks / subagent cards, MCP / skills / plugins / hooks, image drop into the
composer.

### v2

Embedded PTY (`xterm.js` + `x.ai/terminal/pty/*`), worktree UI, voice,
Windows, Tauri updater for the app shell.

Theme: dark-first. Map colors from `xai-grok-pager-render` appearance. Sync
with TUI user themes is not required in v1.

---

## 6. Auth, config, BYOK

This fork is BYOK. Desktop must not assume an xAI subscription.

- Credentials live in `~/.thanh` (`xai-grok-login`, `config.toml`).
- UI collects an API key / points at `env_key`; prefer `x.ai/setApiKey` over
  the renderer writing files.
- OIDC/device-code: reuse the CLI flow; host opens the browser. Optional in
  v1 if API keys suffice.
- Settings should warn when `config.toml` is world-readable.

See [`docs/byok-models.md`](byok-models.md).

---

## 7. Packaging

Match `scripts/publish_release.sh`: local build, GitHub Releases, no CI.

| Artifact | Platform |
|---|---|
| `thanh-desktop-<ver>-linux-x86_64.AppImage` (`.deb` if cheap) | Linux |
| `thanh-desktop-<ver>-macos-aarch64.dmg` | macOS |

- **Alpha:** require `~/.thanh/bin/thanh` (or `THANH_BIN`). Do not bundle a
  second copy.
- **Stable:** optional sidecar `src-tauri/binaries/thanh-<target-triple>`.
- The app must not overwrite `~/.thanh/bin/thanh`.
- Linux runtime deps: `webkit2gtk-4.1` (and tray libs only if tray is added).
- macOS signing is a follow-up; unsigned dmg is acceptable for this fork,
  same as the CLI.

---

## 8. Testing

| Layer | How |
|---|---|
| ACP host (Rust) | Fake child writing NDJSON; crash/restart; id mapping |
| Session reducer (TS) | Pure tests: `session/update` → transcript blocks |
| UI | Playwright against Vite preview + mock ACP (no LLM) |
| Local E2E | Real `thanh agent stdio` + `--always-approve` |
| Linux WebView | Manual markdown / stream / scroll on Ubuntu |

Do not add desktop tests to `xai-grok-pager-pty-harness`.

---

## 9. Implementation PRs

Each PR is independently reviewable.

| PR | Title | What | Depends |
|---|---|---|---|
| 0 | Desktop spec | This file + README / ARCHITECTURE links | — |
| 1 | Scaffold | Tauri 2 + Vite + React + TS + Tailwind; empty window; `src-tauri` isolated from workspace | 0 |
| 2 | ACP host | Resolve `thanh`, spawn `agent stdio`, JSON-RPC mux, `acp_start` / `acp_stop` / `acp_send` | 1 |
| 3 | First turn | `initialize` + `session/new` + `session/prompt` streaming + cancel + folder dialog | 2 |
| 4 | Tools + permissions | Tool cards; permission modal | 3 |
| 5 | Sessions | list / search / load / load_history / rename / delete | 3 |
| 6 | Models + BYOK | `x.ai/models/list`, `session/set_model`, API key UI, `thanh-desktop` client-id alias | 3 |
| 7 | Slash / plan / questions | `x.ai/commands/list`, plan banner, ask-user | 4 |
| 8 | Markdown / diff / images | Shiki, mermaid fallback, image blobs, host-side coalesce | 4 |
| 9 | Alpha packaging | AppImage + install notes; retarget `generate.sh` + updater test path | 3 (prefer 5+6) |
| 10+ | v1.1 / v2 | File preview, dashboard, MCP UI, xterm, macOS dmg, updater | 9 |

Do not start PR 3 until the host round-trips `initialize` reliably.

---

## 10. Key decisions

1. Desktop is an ACP client, not a new agent. Reuse `thanh agent stdio` and
   `~/.thanh`.
2. Tauri 2 + React + Vite + TypeScript.
3. Chat-first product, not an IDE. Editor / PTY are later phases.
4. `clientIdentifier: grok-desktop` from day one; `thanh-desktop` is an alias.
5. Path is `frontend/apps/thanh-desktop/` so a future upstream
   `grok-desktop` tree does not collide.
6. `src-tauri` stays out of the Cargo workspace.
7. Alpha requires the CLI binary; stable may bundle a sidecar.
8. No second `config.toml` merger.
9. Electron is an escape hatch if WebKitGTK fails, not the default.

---

## 11. Current repo state

- Spec: this file, linked from `README.md` and `ARCHITECTURE.md`.
- Application: `frontend/apps/thanh-desktop/` (see that directory’s README).
- The v1 Tauri host, ACP client, chat/session/settings UI, tests, and alpha
  packaging path are implemented. v1.1/v2 items remain intentionally deferred
  as listed above.

## 12. Dev loop

```sh
# CLI agent (already installed by ./build.sh)
thanh --version

# Desktop UI
cd frontend/apps/thanh-desktop
pnpm install
pnpm tauri dev
```

Linux packages typically needed: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`librsvg2-dev`, `patchelf`, `libssl-dev`.

Environment:

| Var | Meaning |
|---|---|
| `THANH_BIN` | Override path to the `thanh` executable |
| `THANH_HOME` / existing grok-home resolution | Must stay `~/.thanh`, never `~/.grok` |
