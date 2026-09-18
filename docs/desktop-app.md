# Thanh Desktop — Architecture

Thanh Desktop is a **chat-first ACP client** for the existing `thanh` agent.
It does not reimplement sampling, tools, or session storage.

**Code:** `frontend/apps/thanh-desktop/` (Tauri 2 + React, shipped as v1).  
**Agent:** `thanh agent stdio` (`xai-grok-shell` / `MvpAgent`).  
**Home:** `~/.thanh`, shared with the CLI.

Production work (providers, Claude Desktop–class features, packaging) lives in
[`docs/desktop-app-implement.md`](desktop-app-implement.md). BYOK TOML:
[`docs/byok-models.md`](byok-models.md). Runtime map: [`ARCHITECTURE.md`](../ARCHITECTURE.md).
TUI presentation (screens, realtime, timers, tool rows — source of truth to copy, not §5.4):
[`docs/tui-presentation.md`](tui-presentation.md).
Method-level TUI ↔ Desktop protocol map (ACP, `x.ai/*`, tools, slash, MCP):
[`docs/desktop-tui-capability-map.md`](desktop-tui-capability-map.md).

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
- A `config.toml` writer in the renderer. The renderer holds no credentials: it
  hands the typed credential to the Rust host, which owns the write, or lets the
  agent write through `x.ai/providers/*`.

**Allowed in the Rust host**

- Spawn/restart the sidecar, stdio, JSON-RPC id map, notification coalescing.
- Native folder dialog, notifications, window state, app updater, OIDC deep link.
- Locked, atomic `~/.thanh/config.toml` edits for providers and models
  (`provider_config.rs`), and the credential-carrying `/models` probe.

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
`xai-grok-workspace` (`permission/types.rs`). The client sends that identifier
as-is, so the agent needs no fork-side alias: permission prompts, MCP apps, and
folder trust all come from the upstream mapping.

`terminal: true` is advertised even when the UI stubs PTY, so the agent can
emit terminal methods.

### 5.2 Standard ACP

| Direction | Methods |
|---|---|
| Client → Agent | `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_model` |
| Agent → Client | `session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, terminal create/output, `x.ai/session_notification` |

`session/update` reasons are reduced by the same path as `x.ai/session_notification`, because both
carry `{ sessionId, update }`: the extension envelope is how the shell ships what ACP has no slot
for, goal orchestration state (`sessionUpdate: "goal_updated"`) above all. An unknown reason is
ignored, never rendered.

Host implements `fs/read_text_file` / `fs/write_text_file` in Rust, restricted
to the session cwd plus one allow-path: the agent's own session store
(`$THANH_HOME/sessions`, else `$GROK_HOME/sessions`, else `~/.thanh/sessions`).
Without it plan mode cannot write `<session>/plan.md`, which lives outside every
workspace.

### 5.3 `x.ai/*` groups

Method-level inventory of every TUI ACP / `x.ai/*` / tool / slash / MCP row
and its live Desktop status lives in
[`docs/desktop-tui-capability-map.md`](desktop-tui-capability-map.md). That
file is the source of truth. Do not duplicate its tables here.

Agent dispatch remains `mvp_agent/acp_agent.rs` and
`xai-grok-mcp/src/wire.rs`; the map was harvested from those plus the pager
handlers and Desktop `handleMessage` / `handle_host_request`. Production work
cites map row ids (`H-term`, `R-sdk`, `N-mcp-tools`, …) instead of inventing
method names — see [`desktop-app-implement.md`](desktop-app-implement.md).

### 5.4 Transcript presentation

Desktop copies the TUI's presentation, catalogued in
[`docs/tui-presentation.md`](tui-presentation.md). That catalog is the source of
truth for the strings, clocks, folds, and flows below; this section only maps
them onto the Desktop client. Do not invent chrome it does not list.

**Streaming machine (catalog §4).** A turn-scoped tracker, not a blinking caret.
`current_agent_msg` / `current_thinking` / `pending_tools` live in
`src/state/session.ts`:

- adjacent `AgentMessageChunk` updates append to the active assistant segment;
  clients must not require a `messageId`, because standard ACP chunks do not
  guarantee one;
- `AgentThoughtChunk` opens a thinking row (`Thinking…`); the first non-empty
  agent text freezes it into `Thought for 1.2s`. Thinking uses its own
  formatter, not the turn formatter;
- a tool call closes the thinking and prose segments, updates in place by
  `toolCallId`, and leaves sibling pending tools alone;
- prompt completion, cancellation, load completion, or failure finalizes every
  running segment before syntax highlighting and Mermaid rendering, and writes
  the turn marker `Worked for {duration}` (catalog §7.3);
- replay and live updates use the same reducer so loading a session cannot
  produce a different transcript shape.

**Live activity is the turn-status row (catalog §6).** One row between the
scrollback and the prompt slot, hidden while idle. It carries the spinner
(braille, ~7.5 fps), the activity label with the exact strings from catalog §6.2
(`Thinking…`, `Responding…`, `Run {cmd}`, `Search {query}`, `Fetch {url}`,
`Waiting for response…`, `Cancelling…`, …), a timer for the current phase on the
left, and the turn timer, optional `⇣12k` tokens and `[stop]` on the right.
Phase and turn clocks use `format_duration` (catalog §5.1) — no spaces, e.g.
`0.5s`, `32s`, `1m20s`, `1h2m`. A permission, question, or trust card swaps the
spinner for the pulsing `◆` and replaces the prompt slot; the composer stays
mounted but hidden so a draft and its attachments survive. A parked plan review
keeps the composer (placeholder `Request changes…`) and uses `◆` on turn-status
instead of an inline card. Question time is netted out of the turn clock. Live
activity is never duplicated into the header.

**Status bar (catalog §3.3).** The Chat column header is cwd on the left (short
path + full-path tooltip) and chips on the right: `plan` (while a review is
parked or already answered), Goal, context `8.5K/1.0M` (with `/compact`), and
the Desktop-only tools toggle. Idle is an empty turn-status (height 0), not a
Ready/Processing label in the header.

**Plans (catalog §3.3, §9.4, §9.8).** The agent's todo tool emits an ACP
`Plan`. Entries stay in session state for GoalDetail `Progress:` and an optional
todo overlay (`src/ui/chat/plan-list.tsx` / `todo-overlay.tsx`) — pending `□`,
in progress `▶` (bold, amber), completed `✓` (green), cancelled `✗` (red,
struck through). ACP has no cancelled status, so a cancelled entry arrives as
`completed` plus `_meta.cancelled`, which the renderer reads. A newer `Plan`
update replaces the entries in place. The todo overlay is **not** auto-shown on
Plan updates (catalog §9.8); toggle it from the header checklist control while
entries exist, or from palette / `/view-plan` when there is no parked `plan.md`
review. Plan entries are **not** transcript rows.

The plan review itself is the popup (`src/ui/chat/plan-dialog.tsx`), auto-opened
on `x.ai/exit_plan_mode`. Reopen it from the header's `plan` chip, or with
`/view-plan` (aliases `/show-plan`, `/plan-view`) and its `View plan` palette
entry when a review exists. The body is rendered as the TUI's line viewer holds
it (`src/ui/chat/plan-lines.tsx`): one row per source line with its 1-based
number, so a comment range is exact. The decision bar is a static footer below
the scroll container, in the TUI's order and with its keys — `a approve` (or
`approve w/ comments`), `g run as goal`, `s request changes`, `c comment` with a
` N ●` badge, `y copy plan`, `q quit plan`. Approve, run as goal, request changes
and quit plan exist only while the review is parked; after the decision the bar
drops to comment / copy / send, so no button is a dead end. Verdicts live only
on this bar — there is no second inline review card.

Comments are line-anchored (`x.ai/exit_plan_mode` carries the whole `plan.md`;
ACP `Plan` updates carry entries only, and this fork emits no `plan_kept`). Drag
across lines — or click one — opens the comment box, `Enter` saves, `Enter` on a
saved comment edits it and `x` deletes it. `s request changes` sends the pager's
own format: `Proposed plan lines 3-4:` with the quoted lines, `Comment:`, and any
freeform note as `Additional feedback:`. Hiding is not a verdict: the `−` control
closes only the surface, the parked review stays parked, and the chip reopens it.
That is why the popup shows a minimize dash rather than a close cross, and why
the plan stays reachable for the rest of the session after a decision.

While the review is parked, the composer stays live under the dialog
(`PlanApprovalFocus::Prompt`): placeholder `Request changes…`, `Enter` on
non-empty text sends `cancelled` with the typed note, and an empty line answers
nothing. Every other interaction (permission / question / elicit / trust) still
swaps the prompt slot out.

**Goals (catalog §3.3, §6.2, §7.3).** Goal state arrives as
`x.ai/session_notification` with `sessionUpdate: "goal_updated"` and lives in
`src/state/goal.ts`, which mirrors the pager's `GoalDisplayState`: the same
status/phase parsing (an unknown status reads as a resumable pause), the same
chip labels, the same live elapsed and token accounting, and the same monotonic
elapsed floor. The header shows the chip
`[Goal: {label}]  {tokens} tokens  {elapsed}` with the TUI's spinner while
active, a warning tone while paused and an error tone when failed or
interrupted; clicking it opens the detail surface: status, `Budget:`/`Tokens:`
with the budget bar, `Progress:` (the session's plan), the active subagent and
its per-model tokens, the completion review, the last event, and the `/goal`
hint. While `verifying_completion` is set the turn-status row reads
`Verifying…` (it outranks stale streaming activity, as in the TUI). The
transition into `complete` writes one `Goal complete in {duration} end-to-end.`
row timed from the goal's own clock; `cleared` drops the chip, and a late update
for the cleared goal id is dropped. Goal state is session-scoped: a new or
loaded session starts with none.

**Transcript rows (catalog §7).** Each block paints its own collapsed one-liner
(`Read path`, `$ cmd`, `Edit path +N/-M`, `Message sent to …`). Tool rows do not
show elapsed time — elapsed exists for stats, and only `SentMessage` surfaces it
(expanded, ≥100 ms). Running rows use an animated accent bullet, not a per-row
spinner. Expansion shows the body, diff, or output.

**Verb-group folding (catalog §8).** Consecutive collapsed foldable tools
(`File`, `Skill`, `Search`, `Dir`, `WebFetch`, `WebSearch`, `MemorySearch`,
`IntegrationSearch`, `Subagent`) collapse under one aggregated header whose
label rebuilds every frame: `Read 2 files, Searched 1 pattern`,
`Reading 1 file, Searching 1 pattern`, `Read 3 files · 2 failed`. `Execute`,
`Edit`, `UseTool`, `Message`, and `Other` keep their own rows.

**Forbidden chrome.** Desktop must not add any of these, because the TUI does
not have them: a pinned live-tool activity rail, per-tool elapsed on collapsed
rows, in-transcript command rerun/Execute, a `Waiting…` row inside the
transcript, a 1 s timer tick, `ProcessStatus` / Ready–Processing header copy,
a `plan-banner`, an in-transcript plan card, an inline plan-review card, or a
header duplicate of turn-status activity. Command output, assistant messages,
paths, commands and queries expose copy actions; opening a path uses the native
desktop opener.

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
4. `clientIdentifier: grok-desktop` — upstream's desktop value, sent verbatim so
   the agent needs no fork-side change.
5. Path `frontend/apps/thanh-desktop/` avoids colliding with upstream
   `grok-desktop` if that tree is ever merged.
6. `src-tauri` stays out of the Cargo workspace.
7. Alpha requires the CLI binary; stable may bundle a sidecar. The app never
   overwrites `~/.thanh/bin/thanh`.
8. Renderer does not merge `config.toml`.

9. The right tools panel uses native, read-only workspace commands for Git
   review and file browsing. Paths are resolved relative to the active workspace;
   symlinks and traversal outside that root are rejected.
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
