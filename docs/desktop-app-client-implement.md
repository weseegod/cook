# Let Cook — Client layering implementation

Fold the live ACP client onto the architecture contract in
[`desktop-app.md`](desktop-app.md). This is the **protocol/client track**,
not product features and not Chat UI.

**This file does not ship code.** Each PR below is independently reviewable
and cites capability-map row ids. Do not invent method names.

| Doc | Role |
|---|---|
| [`desktop-app.md`](desktop-app.md) | Architecture contract (honesty, router, host roles) |
| [`desktop-tui-capability-map.md`](desktop-tui-capability-map.md) | Live wire status; row ids |
| This file | How to fold live code onto the contract |
| [`desktop-app-implement.md`](desktop-app-implement.md) | Production product work (starts after C1–C3, or cites them) |
| [`tui-presentation.md`](tui-presentation.md) | Paint; out of scope here |

---

## 1. Why this track exists

The process model is right (Tauri host + `cook agent stdio`). The running
client is a partial ACP client of the same agent the TUI speaks fluently:

- `initialize` advertises `terminal: true` and `mcpApps: true`, then stubs
  or omits the matching reverse (map `H-term`, `H-mcp` — class C / F / A).
- Unknown reverse requests with an `id` return `-32601` (`client.ts`
  `handleMessage`) and can fail the turn (class A).
- Most extension notifications `console.debug` away, so Settings/Chat go
  stale (class B: `N-mcp-*`, `N-queue`, `N-pcomplete`, `N-tdone`).
- Inbound dispatch is a linear if-chain. Adding rewind, tasks, or `sdk_call`
  without a registry repeats those classes.

The architecture contract already forbids those. This doc is the fold.

---

## 2. Current vs target

| Piece | Live | Target ([`desktop-app.md`](desktop-app.md) §4–§6) |
|---|---|---|
| Caps | `client.ts` `CLIENT_META` + hardcoded `terminal: true`, `mcpApps: true` | One `CAPABILITIES` table; `initialize` is a function of it |
| A→C reverse | `handleMessage` if-chain; unknown → `-32601` | Layer 2 registry; typed decline unless advertised-required |
| A→C notifs | `session/update` + `x.ai/session_notification` + `models/update`; rest ignored | Layer 3 registry; unknown → log |
| Host reverse | `acp_host.rs` `handle_host_request`: fs + **terminal stub** | Layer 1: fs only until PTY; no stub while `terminal: false` |
| C→A wrappers | `xai.ts` / `extensions.ts` / `providers.ts` | `acp/methods/` grouped the same way; no behavior change required in C1–C3 |
| Host roles | mux + TOML writer + workspace sidecar in one crate, undocumented | Same files, documented isolation; no dual-write in production |

Do not move `ui/`. Chat UI rebuild is a separate track.

---

## 3. Invariants the PRs must not break

- Renderer never calls the LLM or writes `config.toml`.
- Host ACP `fs/*` keep the sessions-root allow-path (plan files: `<session>/plan.md`, `<session>/plans/<utc>.md`, `<session>/plans/<slug>-<utc>.md`).
- `wireMethod` `_x.ai/` prefix stays (map class E).
- `clientIdentifier: grok-desktop` stays verbatim.
- Production BYOK writes stay on `provider_config.rs`; mock may fall back to
  `x.ai/providers/*`. Do not dual-write in Tauri.
- `src-tauri` stays out of the Cargo workspace.
- No new ACP methods beyond what a PR’s map rows name.
- Every new reverse/notif handler is a registry row that cites a map id.

---

## 4. PR plan

Order is required: honesty before registry consumers, reverse policy before
any SDK MCP, notifications before Settings/Chat surfaces that would otherwise
look fine and stay stale.

| PR | Title | Map rows | Depends |
|---|---|---|---|
| **C1** | Honest `initialize` caps | `H-term`, `H-mcp`, ACP-t-*, §1.1 `mcpApps` | — |
| **C2** | Reverse-request policy + request registry | §3.2 policy; `R-ask`, `R-plan`, `R-elicit`, `R-trust`; latent `R-sdk`, `R-hook` | C1 |
| **C3** | Notification registry (Chat/Settings consumers) | `N-pcomplete`, `N-mcp-srv`, `N-mcp-tools`, `N-mcp-init`, `N-mcp-elic`, `N-queue`, `N-tdone` | C2 |
| **C4** | Module split (thin move) | — (no new wire) | C2, C3 |
| **C5** | Host role isolation (comments + stub reachability) | `H-term`, ACP-fs-r/w, §4.3 | C1 |

After C1–C3, production work in [`desktop-app-implement.md`](desktop-app-implement.md)
and remaining map §17 surfaces (rewind, tasks panel, slash) may proceed. Each
of those PRs **must add a registry entry** (or this track has failed).

### C1 — Honest `initialize` caps

**Do**

- Introduce a single `CAPABILITIES` object used by `initialize`.
- Set `clientCapabilities.terminal = false`.
- Set `_meta.mcpApps = false`.
- Keep `fs.readTextFile` / `writeTextFile` true (host implements).
- Keep `plan: {}` and folder-trust interactive.
- Do **not** advertise `incrementalBashOutput`, `hunkTracker`,
  `gitHeadChanged`, `statusLine`, `userMessageEcho`, or client hooks until
  the matching consumer exists (later PRs flip the flag and add the row).
- Stop answering ACP `terminal/*` / `x.ai/terminal/*` with fake
  `exitCode: 0`. With the cap off, Layer 1 must not intercept them; Layer 2
  then declines per C2. Deleting the stub match arms is the honest host
  change; do not leave a silent success path.
- Keep `mcpServers: []` and do not send `_meta["x.ai/mcp/servers"]`.

**Do not**

- Implement a PTY.
- Implement `R-sdk`.
- Consume every `InitializeResponse.meta` field in this PR. Optional in C1:
  keep `availableCommands` from the response if it is already fetched later
  via `x.ai/commands/list` (map §1.2 `partial` is acceptable for C1).

**Files**

- `frontend/apps/let-cook/src/acp/client.ts` (`initialize`, `CLIENT_META`)
- `frontend/apps/let-cook/src-tauri/src/acp_host.rs` (`handle_host_request` terminal arms)
- Tests next to `client.ts` / handshake once extracted

**Tests**

- Advertised `terminal` is false; advertised `mcpApps` is false.
- Advertised keys ⊆ implemented handlers (fs + plan + folder-trust).
- Host does not return stub `exitCode: 0` for `terminal/wait_for_exit`.

### C2 — Reverse-request policy + request registry

**Do**

- Replace `handleMessage`’s unknown-with-id `-32601` with the §5.5 policy:
  typed decline / `{ ok: false }` unless the method was advertised as
  required.
- Extract a Layer 2 registry. Seed it with the handlers that already work:
  `session/request_permission`, `R-ask`, `R-plan`, `R-elicit`, `R-trust`.
- Register `R-sdk` and `R-hook` as **known unimplemented** → typed decline
  (they must not `-32601` if a future session meta accidentally enables
  them). Do not implement the work.
- Keep Layer 1 fs intercept in the host.

**Do not**

- Enable SDK MCP or client hooks.
- Implement elicit-complete notification (that is C3 / `N-mcp-elic`).

**Files**

- `src/acp/client.ts` `handleMessage`
- Target (may land in C2 or C4): `src/acp/reverse/`
- `src/acp/host.ts` `respond`

**Tests**

- Known interaction still parks a card and answers through `respond`.
- Unknown reverse with `id` does **not** return JSON-RPC `-32601`.
- `x.ai/mcp/sdk_call` with `id` returns `{ ok: false }` (or equivalent
  decline), not `-32601`.
- Notifications still never take the request path.

### C3 — Notification registry (Chat/Settings consumers)

Ignored notifs do not crash; they stale the UI. C3 consumes the ones
Settings and Chat already have surfaces for.

| Map id | Wire | Consumer |
|---|---|---|
| `N-pcomplete` | `x.ai/session/prompt_complete` | Finish the turn from the agent signal, not only prompt-RPC return |
| `N-mcp-srv` | `x.ai/mcp/servers_updated` | Connectors list |
| `N-mcp-tools` | `x.ai/mcp/tools_changed` | Connectors tools |
| `N-mcp-init` | `x.ai/mcp/init_progress` / `mcp_initialized` / `server_status` | Connectors status |
| `N-mcp-elic` | `x.ai/mcp/elicit_complete` | Close/refresh elicit |
| `N-queue` | `x.ai/queue/changed` | Queued-prompt count |
| `N-tdone` | `x.ai/task_completed` (and `task_backgrounded` if a compact indicator is trivial) | Do not invent a dashboard; a notice or catalog bump is enough |

**Do**

- Layer 3 registry. Unknown notifs stay log-only.
- Keep existing consumers: `session/update`, `x.ai/session_notification`,
  `x.ai/models/update`.
- Wire the table above into `catalog` / session stores so Settings does not
  need a manual refresh to see MCP changes.

**Do not**

- Build the TUI dashboard, task dock, or scheduler UI (map §10 — later
  surface PRs).
- Subscribe every TUI notif (`follow_ups`, `git_head_changed`,
  `scheduled_task_*`, `announcements/update`, `leader/version_mismatch`).
  Those stay log-only until a surface PR adds the row.

**Files**

- `src/acp/client.ts` `handleMessages` / `handleMessage`
- `src/state/catalog.ts`, `src/state/session.ts`
- `src/ui/settings/connectors.tsx` (read from store; no extra ACP poll
  required if the notif lands)

**Tests**

- Injecting `x.ai/mcp/servers_updated` updates the connectors catalog
  without a `x.ai/mcp/list` round trip.
- `prompt_complete` finalizes a running turn.
- An unknown notif does not throw and does not `-32601`.

### C4 — Module split (thin move)

No wire changes. Move the C1–C3 pieces onto the layout in
[`desktop-app.md`](desktop-app.md) §6:

```
src/acp/handshake.ts
src/acp/reverse/
src/acp/notifications/
src/acp/methods/          # optional in C4: xai.ts / extensions.ts can wait
src/acp/client.ts         # lifecycle + dispatch only
```

**Do not** restyle Chat, rewrite the transcript reducer, or merge
`tui-presentation.md` into the client.

**Tests:** existing unit tests keep passing; import paths update.

### C5 — Host role isolation

Docs in code, not a new crate.

- `acp_host.rs`: mux + fs. Terminal stub arms gone (C1). Comment the
  sessions-root allow-path invariant.
- `provider_config.rs`: already the secret writer; comment “only production
  Desktop write path; agent `x.ai/providers/*` is CLI/TUI + mock.”
- `workspace.rs`: comment “read-only sidecar; no write/commit/LSP.”

No behavior change beyond C1’s stub removal.

---

## 5. After this track

Map [`desktop-tui-capability-map.md`](desktop-tui-capability-map.md) §17,
now with a registry to drop into:

1. Done by C1–C2: stop class C and class A.
2. Done by C3: consume the notifs Settings/Chat already need.
3. **Surfaces** (separate PRs, cite map ids, **add a registry row**):
   rewind (`MEM-rew`), compact tasks/subagents panel (map §10, `TK-*`),
   remaining slash `ok-prompt` vs `gap`.
4. **Terminal:** real PTY **or** keep `terminal: false` (C1). Do not
   re-advertise until Layer 1 is a real PTY.

Production sequencing (providers already largely done, MCP UI, memory
browser, packaging) stays in
[`desktop-app-implement.md`](desktop-app-implement.md). MCP connectors UI
must not claim live tools until C3. Tasks/subagents UI must not start
before C3’s `N-tdone`.

---

## 6. Testing

| Layer | What |
|---|---|
| Unit | `CAPABILITIES` ⊆ handlers; unknown reverse with id is not `-32601`; terminal cap false; mcpApps false |
| Unit | Notif registry: MCP servers_updated, prompt_complete, unknown notif |
| Playwright (mock ACP) | Permission / ask-user / plan / elicit / trust still complete a turn after C2 |
| Host | `fs/*` still reads/writes cwd and sessions-root; `terminal/wait_for_exit` is not a fake 0 |

Do not add these to `xai-grok-pager-pty-harness`.

---

## 7. Explicit non-goals

- Implementing any map `gap` that is not named in C1–C3 (no SDK MCP, no
  hooks, no PTY, no rewind UI, no dashboard).
- Chat column layout rebuild.
- Embedding the agent in `src-tauri`.
- Joining the Cargo workspace.
- Credential-proxy rewrite of `provider_config.rs`.
- Waiting for or merging upstream `grok-desktop`.
- Duplicating capability-map tables here.
