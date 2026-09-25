# Let Cook — Architecture contract

Let Cook is a **chat-first ACP client** for the existing `cook` agent.
It does not reimplement sampling, tools, or session storage.

This file is the **contract**: product boundary, process model, capability
honesty, inbound routing, and host roles. Where to edit the app is
[`frontend/apps/let-cook/ARCHITECTURE.md`](../frontend/apps/let-cook/ARCHITECTURE.md).
Live wire status (which methods the running app actually speaks) lives in
the capability map.

**Code:** `frontend/apps/let-cook/` (Tauri 2 + React, shipped as v1).
**Agent:** `cook agent stdio` (`xai-grok-shell` / `MvpAgent`).
**Home:** `~/.cook`, shared with the CLI.

| Doc | Role |
|---|---|
| This file | Architecture contract |
| [`../frontend/apps/let-cook/ARCHITECTURE.md`](../frontend/apps/let-cook/ARCHITECTURE.md) | Module map — where to edit |
| [`desktop-tui-capability-map.md`](desktop-tui-capability-map.md) | Method-level TUI ↔ Desktop status (cite row ids) |
| [`desktop-app-client-implement.md`](desktop-app-client-implement.md) | Fold live client onto this contract (honesty, registry, host roles) |
| [`desktop-app-implement.md`](desktop-app-implement.md) | Production product work (providers, Claude Desktop–class, packaging) |
| [`desktop-release.md`](desktop-release.md) | Self-build installers, minisign, `latest.json` |
| [`tui-presentation.md`](tui-presentation.md) | How the TUI paints — Desktop copies this, does not invent chrome |
| [`let-cook-color-contrast.md`](let-cook-color-contrast.md) | Workbench color contrast: floors, token roles, checks |
| [`byok-models.md`](byok-models.md) | BYOK TOML |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | Repo runtime map |
| [`UPSTREAM-MERGE.md`](../UPSTREAM-MERGE.md) | Desktop is a fork-owned leaf |

---

## 1. Product boundary

Desktop is a presentation client, not an IDE and not a second agent.

| Is | Is not |
|---|---|
| Streaming chat over ACP | Cursor / VS Code feature clone |
| Tool cards, diffs, permissions | Debugger, git GUI, LSP IDE |
| Shared `~/.cook` with CLI | Separate auth/config/session store |
| Linux + macOS first | Electron Chromium bundle |

The upstream implementation already used this shape (`frontend/apps/grok-desktop`,
`clientIdentifier: grok-desktop`). This fork does not ship that tree. Thanh
Desktop is a new app on the **same ACP contract**. If upstream lands
`grok-desktop`, do not rename this tree; cherry-pick protocol patterns.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2 | Rust host, small installer, capability allowlist, Linux-first |
| UI | React 19 + Vite + TypeScript | Chat/markdown/diff ecosystem |
| Agent | Discovered `cook agent stdio` | One runtime with TUI/headless |
| Protocol | ACP v1 + typed `x.ai/*` | Same wire as pager / IDE clients |
| State | Zustand + TanStack Query | Transcript vs catalogs |
| CSS | Tailwind v4 + semantic CSS tokens | VS Code visual density with TUI transcript semantics |
| Packages | pnpm | Matches announcements `generate.sh` |

`src-tauri` is **not** a member of the generated root Cargo workspace. It has
an empty `[workspace]` so `cargo` in that directory does not join the 93-crate
tree. Never add a path dependency on `xai-grok-shell`, pager, or tools.

Electron remains an escape hatch only if WebKitGTK fails streaming or a future
xterm embed. Native GUI (egui/GPUI) would invent a third markdown stack.
In-process agent, leader-socket attach, and WASM-sharing the pager reducer
are rejected: they either join the workspace or add a second compile target
for no user value.

---

## 3. Process model

The picture — renderer, host roles, and which file is which — is the module
map, [`frontend/apps/let-cook/ARCHITECTURE.md`](../frontend/apps/let-cook/ARCHITECTURE.md) §1.
This section is the lifecycle that picture has to keep.

**Lifecycle**

1. Resolve binary: `COOK_BIN` → `~/.cook/bin/cook` → bundled sidecar (stable).
2. Major-version gate against `xai-grok-version`.
3. Spawn `cook agent stdio` with the workspace cwd. Resolve the home from
   `COOK_HOME`, then `GROK_HOME`, then `~/.cook`, ignoring overrides that name
   the real `~/.grok` or `~/.thanh`. Pin both `COOK_HOME` and `GROK_HOME` to
   that directory so Settings and the child use the same home.
4. `initialize` **once per agent process**, from the capabilities table (§5.1).
5. `session/new` or `session/load` per conversation.
6. Crash → host restart + client `session/load` replay.
7. Quit → cancel in-flight turn, kill the child process group.

v1: one window ↔ one agent process. Multi-conversation is `session/new` /
`session/load` on that process. Do not spawn N agents. Leader attach is out
unless TUI and Desktop must share one live agent.

---

## 4. Invariants

### 4.1 Forbidden

- Calling the LLM or tools from React or from a Tauri command.
- Workspace FS via `@tauri-apps/plugin-fs` except folder pick / reveal-in-finder.
- A second session store. Canonical records stay `events.jsonl` + agent SQLite.
- A `config.toml` writer in the renderer. The renderer holds no credentials.
- Advertising a capability the host+renderer cannot honour (class C).
- `-32601` on an unknown reverse **request** the client did not advertise
  (class A). See §5.5.
- Dual-writing `config.toml` in production (host upsert **and**
  `x.ai/providers/upsert` for the same edit).
- Linking `src-tauri` into the root Cargo workspace.
- Patching `xai-grok-shell` / pager for Desktop-only behaviour, except the
  existing BYOK `providers/*` layer and the upstream `grok-desktop`
  `clientIdentifier`.

### 4.2 Capability honesty

`initialize` is a function of a single capabilities table. A cap is `true`
only when both of these hold:

1. The matching reverse method or notification is implemented (or hosted
   natively, for `fs/*`).
2. A test asserts advertised keys ⊆ implemented handlers.

| Cap | Contract | Until |
|---|---|---|
| `fs.readTextFile` / `writeTextFile` | `true` | host implements; Always approve off uses cwd + sessions-root allow-path, on mirrors TUI `LocalFs` |
| `terminal` | `false` | a real PTY exists (map `H-term`) |
| `plan` | `{}` | already honoured |
| `_meta["x.ai/folderTrust"].interactive` | `true` | reverse `x.ai/folder_trust/request` is implemented |
| `_meta.mcpApps` | `false` | `H-mcp` + `R-sdk` both exist |
| `x.ai/incrementalBashOutput`, `hunkTracker`, `bashOutputNoColor`, `gitHeadChanged`, `statusLine`, `userMessageEcho`, client `x.ai/hooks` | advertise only when the matching notif/reverse is consumed | map §1.1 |

Do not register SDK MCP (`session/new` `_meta["x.ai/mcp/servers"]`) until
`x.ai/mcp/sdk_call` is implemented. Keep `mcpServers: []` until then; agent-
hosted servers still attach via `x.ai/mcp/*`.

Live code sends `terminal: false` and `mcpApps: false` (C1). Advertising
`terminal: true` or `mcpApps: true` without a real PTY / `sdk_call` is a
documented lie (map `H-term`, `H-mcp`), not this contract. Fold in
[`desktop-app-client-implement.md`](desktop-app-client-implement.md).

### 4.3 Host roles (three, isolated)

| Role | Code | Allowed | Forbidden |
|---|---|---|---|
| **ACP mux** | `acp_host.rs` | Spawn/kill sidecar, JSON-RPC id map, notification coalescing, native reverse `fs/*`, future real PTY | Stub a method while the cap is advertised |
| **Secret-bearing TOML writer** | `provider_config.rs` | Locked, atomic `~/.cook/config.toml` edits; credential-carrying `/models` probe; redacted DTOs to the renderer | Echo full keys to the WebView |
| **Read-only workspace sidecar** | `workspace.rs` | Git review vs `HEAD`, file tree/preview, native open; paths confined to the workspace root | Write, commit, LSP, growing into a git GUI |

The TOML writer is the **only production Desktop write path** for
`[model_providers.*]` / `[model.*]`. Agent `x.ai/providers/*` is the CLI/TUI
path and the mock/test fallback (`desktopCommand`). A later credential-proxy
(renderer → host injects the key into ACP params → agent writes) is optional
if the two schemas drift; it is not required to scale the client.

The workspace sidecar is a Claude-Desktop-like “right tools” panel, not ACP.
Git mutation, if ever needed, goes through `x.ai/git/*`.

Other host duties that stay: native folder/file dialog, window state, app
updater, OIDC deep link.

---

## 5. ACP contract

Method-level inventory (every TUI ACP / `x.ai/*` / tool / slash / MCP row and
its live Desktop status) is
[`desktop-tui-capability-map.md`](desktop-tui-capability-map.md). Do not
duplicate its tables here. Production and client-layering PRs cite map row
ids (`H-term`, `R-sdk`, `N-mcp-tools`, …).

### 5.1 `initialize`

Contract (honest):

```json
{
  "protocolVersion": "1",
  "clientCapabilities": {
    "fs": { "readTextFile": true, "writeTextFile": true },
    "terminal": false,
    "plan": {}
  },
  "clientInfo": { "name": "Let Cook", "title": "Let Cook" },
  "_meta": {
    "clientIdentifier": "grok-desktop",
    "clientType": "grok_desktop",
    "mcpApps": false,
    "bufferingSettings": { "minDelayMs": 16, "maxDelayMs": 64, "maxBytes": 65536 }
  }
}
```

`clientCapabilities._meta["x.ai/folderTrust"] = { interactive: true }` is
set because Desktop implements the reverse round-trip.

`grok-desktop` maps to `ClientType::Desktop` in `xai-grok-workspace`
(`permission/types.rs`). Send it verbatim so the agent needs no fork-side
alias.

Consume `InitializeResponse.meta` (`availableCommands`, `sessionRecap`,
`cancelRewind`, `defaultAuthMethodId`, `x.ai/mcp/sdk`). Do not advertise
`mcpApps` because the agent echoes `x.ai/mcp/sdk: true`.

`wireMethod` prefixes C→A `x.ai/*` as `_x.ai/…` (`host.ts`). That envelope
(map class E) is already handled; do not “fix” it twice.

### 5.2 Standard ACP

| Direction | Methods |
|---|---|
| Client → Agent | `initialize`, `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_model`, `session/set_mode` |
| Agent → Client | `session/update`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file`, `x.ai/session_notification` |
| Agent → Client, **not advertised** | `terminal/*` until a real PTY exists |

`session/update` and `x.ai/session_notification` both carry
`{ sessionId, update }`. The extension envelope is how the shell ships what
ACP has no slot for (`goal_updated` above all). An unknown `sessionUpdate`
tag is ignored, never rendered as a row.

Host implements `fs/read_text_file` / `fs/write_text_file` in Rust. When
Settings → General → Always approve is off, access is restricted to the
session cwd plus one allow-path: the agent's own session store
(`$COOK_HOME/sessions`, else `$GROK_HOME/sessions`, else `~/.cook/sessions`).
When Always approve is on, the host mirrors the CLI/TUI `LocalFs` behavior and
does not add a workspace path restriction. Without the session-store allow-path,
plan mode and goal planning cannot write their plan files
(`<session>/plan.md` as the legacy plan-mode fallback, or
`<session>/plans/<utc>.md` per plan/goal episode, published to
`<slug>-<utc>.md` when complete), which live outside
every workspace. That allow-path is load-bearing.

### 5.3 `x.ai/*` groups

See the capability map. Agent dispatch remains
`mvp_agent/acp_agent.rs` and `xai-grok-mcp/src/wire.rs`.

### 5.4 Three-layer inbound router

Every A→C message takes one of these layers. There is no catch-all
`-32601` for “I have not heard of this.”

```
Agent stdout
  → (pending C→A response?)  complete the renderer promise; stop
  → Layer 1  Host native intercept
             fs/read_text_file, fs/write_text_file
             terminal/* only if advertised (today: not advertised)
  → Layer 2  Renderer reverse-request registry (message has id)
             known interaction → typed UI
             known but unimplemented → typed decline / { ok: false }
             unknown, not advertised → typed decline / { ok: false }
             unknown + advertised-required → -32601
  → Layer 3  Notification registry (no id, or notif methods)
             known → catalog / session / settings store
             unknown → log, never crash, never -32601
```

Each registry entry cites a map row id. A protocol PR is one row + one test,
not a new `if` in `handleMessage`.

Live dispatch is `src/acp/client/messages.ts`: a message with an id goes to
the reverse registry, and the rest to the notification registry. Host
`fs/*` is `acp_host.rs` (no terminal stub while `terminal: false`). Which
file owns which layer: the module map. Remaining C→A file grouping is
[`desktop-app-client-implement.md`](desktop-app-client-implement.md) C4.

### 5.5 Reverse-request policy (class A)

Reverse requests block the agent until the client answers.

1. **Known interaction** (`session/request_permission`, `x.ai/ask_user_question`,
   `x.ai/exit_plan_mode`, `x.ai/mcp/elicit`, `x.ai/folder_trust/request`):
   implement the UI, or answer a typed cancel/decline so the turn continues.
2. **Unknown notifications**: log and ignore. Never `-32601` a notification.
3. **Unknown requests** (`id` present): answer `{ ok: false }` or a typed
   decline. **Do not `-32601`** unless the client advertised that capability
   (or the agent marked the method required). `-32601` means “I claimed this
   and I refuse it” (TUI `WaitForTerminalExit`), not “I never heard of this.”
4. Do not register SDK MCP until `R-sdk` is implemented. Do not advertise
   `terminal: true` until ACP `terminal/*` is real (Desktop already sends
   `false`). Do not stamp
   `_meta["x.ai/hooks"]` until `R-hook` is implemented.

---

## 6. Client layering

The live tree is the module map,
[`frontend/apps/let-cook/ARCHITECTURE.md`](../frontend/apps/let-cook/ARCHITECTURE.md).
This section is the rule that tree has to keep.

Zustand holds the transcript. TanStack Query (or the catalog store) holds
MCP, skills, and model lists. Catalogs subscribe to the notification
registry (`N-mcp-*`, `x.ai/models/update`, and the other rows in the
capability map) or they go stale (class B).

A new reverse method or notification is a registry entry that cites a
capability-map row id. Inbound dispatch is `src/acp/client/messages.ts`.
Grouping the remaining flat C→A wrappers under `acp/methods/` is optional
C4 in [`desktop-app-client-implement.md`](desktop-app-client-implement.md).

---

## 7. Transcript presentation

Desktop copies the TUI's presentation, catalogued in
[`tui-presentation.md`](tui-presentation.md). That catalog is the source of
truth for strings, clocks, folds, and flows. Which file paints which surface
is the module map.

Replay and live updates use the same reducer.

One surface reads a transcript that is not the open conversation's: a subagent
runs its own ACP session, so its updates arrive under the child's session id and
are routed to that child's transcript ahead of the parent's prompt correlation.
A child's updates carry the child's own `promptId`, which no prompt this window
sent would match. The tasks list row's `[view]` then replaces the chat column
with that child's own view: the same transcript rows and a turn-status row
derived from the child's blocks. The takeover has no prompt of its own — the
TUI's does not either, and a child is addressed by the parent's
`send_subagent_message` row, not from inside its view. A long prompt, in either
transcript, folds to three lines. A background command is not a conversation
and keeps the stdout viewer.

Plan files are the one part of plan state that is not in the transcript. A
session's history of them comes from the agent (`x.ai/session/plans`) and the
header chip paints them as a list — newest first by the UTC token in the
filename, each row labeled with the plan H1 (`title`), current episode marked,
each row's three-dot menu offering Copy, Copy file path and Delete
(`x.ai/session/plans/delete`). The chip belongs to the conversation rather
than to a plan: it sits in the header from the moment a workspace is open and
reports an empty list before the first episode is written.
`/goal` planner output and `--plan` seeds use the same episode list without
turning on plan mode; `--from-plan` and approve-as-goal reuse an inactive
published episode. The private verifier snapshot at `goal/plan.baseline.md` is
never listed, and a live or paused goal's contract cannot be deleted.
An agent that predates those methods leaves the list empty too, and keeps its
older single-plan behavior for a parked review, so the feature degrades instead
of erroring.

Erasing conversations is Settings → Data Controls, not a sidebar action. **Data
Controls** holds "Delete all conversations",
which confirms first and then calls `x.ai/sessions/delete_all`. The agent walks
its own session store and deletes each session through the same path as
`x.ai/session/delete`, so a wipe takes the transcripts, the search-index rows,
the plan files inside each session directory, and the cloud copy when writeback
storage makes that authoritative. It reports how many conversations and plan
files went, and how many could not be deleted, rather than assuming success; the
renderer drops the open conversation and its sidebar preferences and reports
those counts. Sessions that exist only in the cloud are outside this scope: the
agent enumerates what its session store holds.

**Forbidden chrome** (the TUI does not have these): a pinned live-tool
activity rail, per-tool elapsed on collapsed rows, in-transcript command
rerun/Execute, a `Waiting…` row inside the transcript, a 1 s timer tick,
`ProcessStatus` / Ready–Processing header copy, a `plan-banner`, an
in-transcript plan card, an inline plan-review card, or a header duplicate
of turn-status activity.

Visual language follows VS Code Dark Modern for density. That does not
change the product boundary.

---

## 8. Key decisions

1. Desktop is an ACP client. Reuse `cook agent stdio` and `~/.cook`.
2. Tauri 2 + React + Vite + TypeScript.
3. Chat-first, not an IDE.
4. `clientIdentifier: grok-desktop` — upstream's desktop value, sent verbatim.
5. Path `frontend/apps/let-cook/` avoids colliding with upstream
   `grok-desktop`.
6. `src-tauri` stays out of the Cargo workspace.
7. Alpha requires the CLI binary; stable may bundle a sidecar. The app never
   overwrites `~/.cook/bin/cook`.
8. Renderer does not merge `config.toml`. Host is the only production Desktop
   writer; agent `x.ai/providers/*` is CLI/TUI + mock fallback.
9. Never advertise a cap the client cannot honour. `terminal: false` until a
   real PTY; `mcpApps: false` until SDK MCP + `sdk_call` exist.
10. Scale the client with a method registry keyed to map row ids, not by
    growing `handleMessage`.
11. The right tools panel is a read-only host sidecar (Git review + file
    browse). Symlinks and traversal outside the workspace root are rejected.
12. This fork is BYOK: no xAI subscription required. Never call
    `x.ai/setApiKey` for BYOK (map `A-setkey`).

---

## 9. Develop

Commands, binary resolution, tracing, and the updater gate are in
[`frontend/apps/let-cook/README.md`](../frontend/apps/let-cook/README.md).
Where tests live is the module map §6. Release packages:
[`desktop-release.md`](desktop-release.md).
