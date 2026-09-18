# TUI Presentation Catalog

Source of truth for **how the current Thanh TUI looks and behaves**. This is a presentation map of `xai-grok-pager`, not a Desktop spec and not an agent-runtime spec.

Desktop is a separate ACP client (`frontend/apps/thanh-desktop/`). Architecture: [`desktop-app.md`](desktop-app.md) §7 (forbidden chrome + pointer here). This catalog is what the TUI actually paints — Desktop copies it and does not invent chrome.

**Runtime map:** [`ARCHITECTURE.md`](../ARCHITECTURE.md).  
**User-facing TUI docs:** `~/.thanh/docs/user-guide/` (shortcuts, status line, dashboard, plan mode, …).

---

## Contents

1. [Scope and crate map](#1-scope-and-crate-map)
2. [Screens](#2-screens)
3. [Main-turn layout](#3-main-turn-layout)
4. [Realtime streaming machine](#4-realtime-streaming-machine)
5. [Timers](#5-timers)
6. [Turn-status row](#6-turn-status-row)
7. [Transcript block catalog](#7-transcript-block-catalog)
8. [Verb-group folding](#8-verb-group-folding)
9. [Interaction surfaces](#9-interaction-surfaces)
10. [Turn lifecycle](#10-turn-lifecycle)
11. [Animation and redraw cadence](#11-animation-and-redraw-cadence)
12. [File:function index](#12-filefunction-index)

Strings, duration formats, and labels below are copied from source. Paths are under `crates/codegen/` unless noted.

---

## 1. Scope and crate map

The product runs four modes against one agent. This document covers only the **interactive TUI**.

| Layer | Path | Role |
|---|---|---|
| App loop | `xai-grok-pager/src/app/{mod,event_loop,app_view}.rs` | crossterm events + ACP + ticks → `AppView` |
| Dispatch | `xai-grok-pager/src/app/dispatch/` | `Action` → state + `Effect`s |
| ACP ingress | `xai-grok-pager/src/app/acp_handler/` | session notifications, permissions, queue, subagents |
| Agent screen | `xai-grok-pager/src/app/agent_view/` | per-session view: input, compose, blocking cards |
| Tracker | `xai-grok-pager/src/acp/tracker.rs` | ACP `SessionUpdate` → scrollback mutations + `TurnActivity` |
| Scrollback | `xai-grok-pager/src/scrollback/` | transcript entries, layout, folds, sticky prompts |
| Views | `xai-grok-pager/src/views/` | turn-status, prompt, permission, panes, welcome, dashboard |
| Draw primitives | `xai-grok-pager-render` | theme, glyphs, `format_duration` |
| Markdown | `xai-grok-markdown` | streaming markdown + checkpoints |

The TUI is an ACP **client**. Sampling, tools, and session storage live in `xai-grok-shell` / `xai-grok-tools` / `~/.thanh`. This catalog is presentation only.

Elm-style loop (ARCHITECTURE §5.4):

```
crossterm + ACP + task results + animation ticks
  → AppView::handle_input
  → ActionRegistry (pane → agent → global)
  → dispatch/ (state + Effects)
  → Presenter coalesces draws
  → pager-render draw_frame on a writer thread
```

---

## 2. Screens

`AppView::draw_inner` (`app/app_view.rs`) switches on `ActiveView`:

| Screen | When | Paint |
|---|---|---|
| `Welcome` | startup / return home | `views/welcome::render_welcome` |
| `Agent(id)` | session open | `AgentView::draw` (`app/agent_view/render.rs`) |
| `AgentDashboard` | Ctrl+\ / dashboard | `views/dashboard::render_dashboard` |

Minimal / hook mode (`ScreenMode::is_minimal`) bypasses this full layout via `minimal_hook`. It is a reduced surface, not the primary map.

### 2.1 Welcome

`views/welcome/mod.rs`. Top to bottom:

- Top bar: `{branch} worktree {cwd}` (`views/location.rs`)
- Centered column or hero box: logo, menu, optional announcement/changelog/tip, prompt
- Menu: New / Resume / Import Claude / New worktree / Changelog / Quit (VS Code-family quit is `Ctrl+D`, otherwise `Ctrl+Q`)
- Overlays: session picker, auth, trust, consent, privacy, workspace-mode picker, toast

The welcome prompt is the same `PromptWidget` as the agent composer.

### 2.2 Dashboard

`views/dashboard/{render,layout,chrome,peek}.rs`. Roster of sessions with live activity columns; optional peek panel (live tail / question / permission); optional full-agent popup overlay. Age columns use `format_time_ago` (`just now`, `5m`, `3h`, …), not the turn-status duration formatter.

### 2.3 Agent (main turn)

The rest of this catalog.

---

## 3. Main-turn layout

Vertical stack from `AgentViewLayout::compute` (`views/agent.rs`). Compose is `AgentView::draw` (`app/agent_view/render.rs`).

```
┌──────────────────────────────────────────────────────────────────┐
│ STATUS BAR  cwd · chips · context 8.5K/1.0M · [Dashboard]        │  1 row
├──────────────────────────────────────────────────────────────────┤
│ [Tasks pane]                                                     │  overlay
│ [Subagent catalog]                                               │  overlay
│ [Todo pane]                                                      │  overlay
├──────────────────────────────────────────────────────────────────┤
│ SCROLLBACK ……………………………………… │ scrollbar OR timeline │  Min ≥ 5
│   [search divider + /bar]                                        │
│   [▼ follow / ▲ response-top]                                    │
├──────────────────────────────────────────────────────────────────┤
│ [/btw panel]                                                     │
│ [Queue pane]          (0 when dock is on)                        │
│ TURN STATUS   ⠧ Run cmd 0.2s            1m20s ⇣12k [↓] [stop]   │  0 when idle*
│ [banner / plugin CTA / follow-up chips]                          │
│ [Dock: Workflows / Subagents / Tasks / Watchers / Queued]        │  remote flag
│ [◉ Recording  [stop]]                                            │  voice
│ PROMPT  or  blocking card (permission / question / …)            │
├──────────────────────────────────────────────────────────────────┤
│ [status_line script row]                                         │  optional
│ SHORTCUTS BAR                                                    │  1 row
└──────────────────────────────────────────────────────────────────┘
```

\*Turn-status shows when non-idle, drain-blocked, session-starting, any watchers, or parked (`turn_status::should_show`).

Short terminals (`≤16` rows, `SHORT_TERMINAL_ROWS`) drop CTA, follow-ups, bottom outer vpad, and the prompt gap. Auto-compact is forced at `≤20` rows (`AUTO_COMPACT_MAX_ROWS`) without writing the user's compact setting back.

### 3.1 Region inventory

| Region | File | Position | Visible when |
|---|---|---|---|
| Status bar (header) | `views/agent_status.rs` + `app/agent_view/render.rs` | top row | always on agent screen |
| Tasks pane | `views/tasks_pane.rs` | below header, above scrollback | overlay on, dock off |
| Subagent catalog | `views/subagent_catalog_pane.rs` | below tasks | overlay on |
| Todo pane | `views/todo_pane.rs` | below catalog | overlay on; **not** auto-shown on plan updates |
| Scrollback | `scrollback/scrollback_pane.rs` | flex middle | always (min 5 rows) |
| Scrollbar / timeline | `views/agent.rs` / `views/timeline.rs` | right gutter of scrollback | rail if `show_timeline` + width ≥ 60 + ≥ 2 turns; else scrollbar |
| Find bar | `views/picker.rs` | last 2 rows of scrollback | `/` search open |
| `/btw` panel | `views/btw_overlay.rs` | between scrollback and queue | `btw_state` set |
| Queue pane | `views/queue_pane.rs` | above turn-status | overlay + non-empty held queue; height 0 when dock on |
| **Turn-status** | `views/turn_status.rs` | above banner/prompt | see §6 |
| Banner | privacy / announcements / tips | above CTA | privacy outranks others |
| Plugin CTA / follow-ups | `app/agent_view/render.rs` | above dock/prompt | suppressed on short terminals |
| Dock | `views/dock/` | directly above prompt | remote `dock_enabled` |
| Voice row | `app/agent_view/render.rs` | immediately above prompt | `voice_listening` |
| Prompt / blocking card | `views/prompt_widget/` or card views | bottom content | replaced by cards in §9 |
| Status line (script) | `views/status_line/` | above shortcuts | `[ui.status_line]` not `disabled` |
| Shortcuts bar | `views/shortcuts_bar.rs` | bottom row | always reserved |

Mouse hit order (`PaneAreas::hit_test`): Tasks → Catalog → Todo → Queue → Dock → Scrollback → Prompt.

Keyboard ownership (`app/agent_view/key_owner.rs`): overlays/modals first, then `BlockingCard` (Permission > CancelTurn > Question > McpElicitation), then plan approval, then panes.

### 3.2 What is *not* a layout region

| Mechanism | File | What it actually is |
|---|---|---|
| `pin_reserve` | `scrollback/state/pin_reserve.rs` | Bottom padding so the last user prompt can sit at the top of the viewport during a turn. Not a live tool rail. |
| Sticky headers | `scrollback/sticky.rs` | iOS-style sticky **user prompts** when scrolling past turns. |
| Live tool activity | `views/turn_status.rs` | The turn-status row between scrollback and prompt. |

The TUI does **not** pin in-progress tools to a dedicated rail inside the transcript.

### 3.3 Header chips

The agent status bar (`views/agent_status.rs`) is left location + right chips, not the generic `views/status_bar.rs` widget.

Typical right-side chips: background-task count, `plan`, goal, MCP init spinner, context `8.5K/1.0M` (hover → bar + %), dashboard overlay `‹ i/n ›`, `[Dashboard]`. Context coloring lives in `views/context_bar.rs`. Credits live on welcome/dashboard/usage (`views/credit_bar.rs`); the agent bar keeps a credits hit slot.

### 3.4 Follow / search / timeline

- Follow mode sticks the viewport to the tail while the turn streams. `⇧G` / jump to last entry / scroll past bottom / send a new prompt resume follow. Expanding a block while following can stop follow when `respect_manual_folds` is on.
- Find (`/` or `/find`): divider + `/query` + `i/n` inside the scrollback rect.
- Timeline rail: 2-col tick marks for turn order (not scroll proportion). Hover shows a turn-preview popup. Replaces the scrollbar when shown.

---

## 4. Realtime streaming machine

`AcpUpdateTracker` (`acp/tracker.rs`) is a turn-scoped streaming machine. It owns:

- `current_agent_msg: Option<EntryId>`
- `current_thinking: Option<EntryId>`
- `pending_tools: HashMap<toolCallId, PendingTool>`
- waiting / hooks / writing-tool-call overrides

There is **no blinking caret** in the markdown. “Streaming cursor” in architecture docs means these active-segment pointers.

`handle_update(update, meta, scrollback) -> bool` mutates scrollback and returns whether a redraw is needed. Replay uses the same reducer; live vs replay only changes whether markdown is rendered per chunk or deferred.

### 4.1 Segment rules

| ACP event | Tracker action |
|---|---|
| `AgentThoughtChunk` | Append to the thinking entry. If none, create `thinking_streaming()` (or `_replay`). Update `last_thinking_elapsed_ms = agentTimestampMs - streamStartMs` when both stamps exist. Gated by `show_thinking_blocks`. |
| `AgentMessageChunk` | Finish thinking. Clear `blocking_waits`. On first non-empty chunk: `scrollback.start_streaming_agent()`, set `current_agent_msg`, `is_running`. Append via `push_chunk_to_agent` (live) or `_deferred` (replay). Whitespace-only first chunk is ignored. No `messageId` is required. |
| `ToolCall` | Finish thinking. Clear `current_agent_msg` (prose segment ends). Create or refine a tool block keyed by `toolCallId`. Eager block is `ToolCallBlock::Other`; timing is stashed on `PendingTool.started_at` so a later kind-refine does not drop the clock. |
| `ToolCallUpdate` | Merge in place. Execute stdout streams through a UTF-8 decoder (`Utf8Decoder`) so split codepoints are not replaced with U+FFFD. Orphan updates that arrive before `ToolCall` are held and applied when the call appears. |
| New `stream_start_ms` | Finish thinking (if it has content) + finish assistant segment. Optionally `pre_create_thinking` so `Thinking…` appears before the first token. |
| `UserMessageChunk` | Render the user echo, unless `skip_next_user_echo` (local send already pushed the row) or `skip_next_skill_body`. |
| Prompt complete / cancel / fail | `finish_turn`: finish thinking + assistant + all pending tools; clear waits, hooks, writing, compaction, retry. |

Empty pre-created thinking is **removed** on finish so the transcript never shows `"Thought for 0.0s"`.

### 4.2 Markdown streaming

`scrollback/blocks/markdown_content.rs` wraps `xai-grok-markdown::StreamingMarkdownRenderer`.

- Live: `push_and_render` each chunk.
- Replay: `push` deferred; render once later.
- `finish()`: full re-render. Image, video, and Mermaid refs are extracted **only at finish**, never per chunk.
- Wrap cache is keyed on `(width, generation, theme)`. Scrolling at the same width is free.
- Checkpoints freeze a stable prefix so only the tail re-renders. Open fences and lists block checkpointing.

Used by `AgentMessageBlock` and `ThinkingBlock`.

### 4.3 `TurnActivity` priority

`AcpUpdateTracker::activity()` (first match wins):

1. `retry_activity`
2. `compaction_activity`
3. Revealed hooks (`HOOK_REVEAL_DELAY` = **300 ms** — faster hooks never flash)
4. Known blocking wait (instant task-output polls with `timeout_ms` 0/missing are excluded)
5. Fresh writing-tool-call (`WRITING_DELTA_STALE_AFTER` = **10 s**)
6. `Thinking` if `current_thinking` is set
7. First `pending_tools` → `ToolRunning { title, description }`
8. `Responding` if `current_agent_msg` is set
9. else `None` — `AgentView::resolve_turn_activity` fills `Waiting(Model | PromptAck | Subagent)` while `TurnRunning`

`is_phase_transition` compares a `PhaseKey`. A new tool **title**, retry attempt/reason, or wait telemetry label starts a new phase (and resets the phase timer). Description churn on the same tool title does **not**.

### 4.4 Suppressed tools

Some tool calls never become scrollback rows while they succeed (todo pane, tasks pane, subagent block, scheduler, workflow, goal). They may still register `blocking_waits` so the spinner names the wait. A Failed terminal status un-suppresses and renders the stashed call.

### 4.5 Writing-tool-call labels

Shown while argument deltas stream, before the tool row materializes (`WritingToolCall::label`):

| Tool kind | Label |
|---|---|
| task / subagent | `Writing subagent prompt…` |
| `use_tool` | `Preparing MCP tool…` |
| `search_tool` | `Searching MCP tools…` |
| Write | `Writing file…` |
| Edit | `Writing edit…` |
| Execute | `Writing command…` |
| Plan | `Updating todo list…` |
| Workflow | `Writing workflow…` |
| AskUser | `Preparing question…` |
| unknown | `Preparing tool call…` or `Preparing {name}…` |

A second concurrent write appends ` (2)`.

---

## 5. Timers

### 5.1 Shared compact formatter

`xai-grok-pager-render/src/util.rs::format_duration`. Re-exported as `format_turn_timer` in `views/turn_status.rs`.

| Range | Format | Examples |
|---|---|---|
| < 10 s | `{:.1}s` | `0.5s`, `5.2s` |
| 10–59 s | `{secs}s` | `10s`, `32s` |
| < 1 h | `{m}m{s}s` | `1m0s`, `1m20s` |
| ≥ 1 h | `{h}h{m}m` | `1h0m`, `1h2m` |

**No spaces.** Used by turn-status (phase + turn clocks), `Worked for`, most session-event markers, subagent / bg-task / workflow / sent-message rows, and the tasks pane.

### 5.2 Thinking header formatter (different)

`ThinkingBlock::format_time`:

- < 60 s: `{:.1}s` (e.g. `3.2s`)
- ≥ 60 s: `{mins}m{secs:.0}s` (e.g. `1m5s`)

Running: `Thinking…`. Done with time: `Thought for {time}`. Done without: `Thought`. Optional dim `  (ctrl+e to expand)` when collapsed and the appearance flag is on.

On finish, the **local** `started_at` wall clock is frozen first. Server `last_thinking_elapsed_ms` is used only when there is no local timer (replay). Replay thinking is created with `streaming_replay()` so a local clock is not started at ~0 ms.

### 5.3 Other formatters (do not mix)

| Surface | Formatter | Notes |
|---|---|---|
| Tab title turn timer | integer seconds, `{n}s` | Hidden if `< 1s` (`notifications/title.rs`) |
| Builtin status-line `turn-timer` | `goal_detail::format_elapsed` | `5s`, `1m05s`, `1h02m`; hidden at 0 s |
| Session picker / dashboard age | `format_time_ago` | `just now`, `5m`, `3h`, `2d` |
| Compaction completed (session event) | `{secs:.1}s` in parentheses | `Context compacted: 12k → 4.1k tokens (1.2s)` |

### 5.4 Where Instant is stored

| Clock | Storage | Starts | Stops | Shown |
|---|---|---|---|---|
| Turn | `AgentView.turn_started_at` (+ wall `turn_start_ms`, pause accumulators) | prompt send / drain | turn end | right side of turn-status |
| Phase | `activity_started_at: Option<Instant>` | `is_phase_transition` | next phase; cleared on turn end | left of turn-status after the label |
| Thinking | `ThinkingBlock.started_at` + optional server ms | block create (live) | frozen in `finish()` | thinking header only |
| Tool | `started_at` / `elapsed_ms` on each tool variant | eager create / `set_started_at` | `finish()` | **not on tool headers** except SentMessage expanded ≥ 100 ms. Used for stats (`tool_usage.rs`) |
| Hooks | `HooksRunning.since` | batch arm (includes the 300 ms pre-reveal) | hook end / model text / turn end | as `Waiting(Hooks)` after reveal |
| Writing tool call | `(WritingToolCall, Instant)` | each args delta | tool/agent output or 10 s stale | activity label only |
| Session starting | `session_starting_since` | create dispatch | id bind / fail | `Starting session…` + phase-style timer |
| Question pause | `QuestionViewState.opened_at` | card open | card close | nets out of `turn_elapsed()` so answering does not inflate the turn clock |

Ask tools (`title` starts with `Ask: ` or `Ask `) **suppress the phase timer** so the user is not time-pressured.

Live elapsed on a still-running tool block is `started_at.elapsed()` until `elapsed_ms` is frozen. The turn-status phase timer is what the user sees ticking next to `Run …`.

---

## 6. Turn-status row

`views/turn_status.rs`. This is the live activity line. Hidden (0 height) when idle unless watchers / parked / session-starting / drain-blocked.

Documented layout in source:

```
⠧ Run command 0.2s              1m20s ⇣12k [stop]
```

### 6.1 Running turn

Left → right:

| Piece | Behavior |
|---|---|
| Spinner | Braille frames (`glyphs::braille_spinner_frames`), `tick / SPINNER_DIVISOR(4)` ≈ **7.5 fps** at 30 fps. Color follows the activity. |
| Waiting on you | Pulsing filled diamond `◆` (`USER_WAITING_PULSE_SPEED = 0.08`) instead of braille. Same cue as drain-blocked and plan-approval. |
| Activity label | Truncates. See §6.2. Tool rows split `Run ` / `Search ` / `Fetch ` (muted prefix) from the yellow/highlighted subject. |
| Phase timer | `" " + format_duration(activity_started_at.elapsed())`. Gray. Never truncates. Hidden for Ask tools. |
| Queued hint | ` · N queued, Enter to send now` (or ` · N queued`) after the phase timer, only on sendable waits. |

Right-aligned:

| Piece | Behavior |
|---|---|
| Turn timer | `format_duration(turn_elapsed)` |
| Tokens | optional `⇣` + `format_tokens_short` (`12k`, `1.23k`, `1.23m`) |
| Bg demote | ` [↓]` / hovered ` [send to bg]` — running execute only, never while cancelling |
| Cancel | `[stop]` (red on hover). Shown in `TurnRunning`, `CommandRunning`, `TurnCancelling`, `CommandCancelling`. Hidden on keyboard-only hosts. |

### 6.2 Activity labels (exact)

From `compute_activity` + `WaitingReason::label` + tool-title special cases:

| Condition | Label |
|---|---|
| Cancelling | `Cancelling…` (error color) |
| Goal verifying | `Verifying…` |
| Thinking | `Thinking…` |
| Responding | `Responding…` |
| Auto-compacting | `Compacting…` |
| Retrying | `Retrying (attempt N)...` (+ optional headline) |
| Bash turn, no activity | `Running…` |
| Fallback | `Waiting…` |
| `Waiting(Model)` | `Waiting for response…` |
| `Waiting(Subagent)` + display | `{clamped}…` |
| `Waiting(Subagent)` empty | `Waiting on subagent…` |
| `Waiting(TaskOutput)` + subject | `{clamped}…` (e.g. `Wait 5 seconds…`) |
| `Waiting(TaskOutput)` empty | `Waiting on task output…` |
| `Waiting(TasksComplete)` | `Waiting on tasks…` |
| `Waiting(Sleep)` | `Sleeping…` |
| `Waiting(Hooks)` | `Running {event} hook…` / `Running {n} {event} hooks…` |
| `Waiting(PromptAck)` | `Waiting for the agent to accept the prompt…` |
| Ask tool | `Waiting on answers for {detail}` |
| Tool + description | `{description}…` via `format_waiting_for_subject` (clamped to 40 chars) |
| Web search title | muted `Search ` + yellow query |
| Fetch title | muted `Fetch ` + yellow URL |
| Other tool | muted `Run ` + syntax-highlighted command (MCP names prettified) |
| Writing tool call | see §4.5 |
| Slash command in flight | `{command.display_name()}…` |
| Session create | `Starting session…` |

Subject clamp: first non-empty trimmed line, max **40** characters (`MAX_ACTIVITY_SUBJECT_CHARS`).

Sendable waits (Enter aborts the wait and sends): `TaskOutput { waits: true }`, `TasksComplete`, `Sleep`, `Subagent`. Model waits are **not** sendable — typing queues behind the streaming turn.

### 6.3 Idle / parked cues

Parked never falls through to spinner/timers/`[stop]` (the wait aborts the moment the user types, so that chrome would lie).

- Watchers: `1 command · 2 monitors · 1 loop · 1 subagent still running` with concentric-circle pulse ○◎◉ (`MONITOR_PULSE_DIVISOR = 8` ≈ **3.75 fps**). Click expands per-watcher detail rows.
- Parked suffixes: ` · send a message to interrupt`, or ` · N queued, Enter to send now`.
- Drain-blocked (user editing the front queued prompt): `◆ agent idle ~ waiting on your edit`.
- Dock-on can suppress idle watcher cues because the dock already lists that work.

`Watchers` counts running background commands, monitors, scheduled `/loop`s, background subagents, and workflows. `awaitable_work` excludes loops and workflows.

---

## 7. Transcript block catalog

Entries live in `scrollback/entry.rs`. Content implements `BlockContent` (`scrollback/block.rs`). Tool variants are `scrollback/blocks/tool/`.

### 7.1 Cross-cutting rules

| Concern | Behavior |
|---|---|
| Fold modes | `DisplayMode::{Collapsed, Truncated, Expanded}` (`scrollback/types.rs`). Most tools default **Collapsed**. |
| Running cue | Animated accent rail and/or bullet (`AccentStyle::animated`). **No per-header spinner glyph.** Thinking is the exception: header text `Thinking…`. |
| Elapsed on tool header | **Almost never.** Tools store `elapsed_ms` for stats. Headers do not show duration except **SentMessage** (expanded, ≥ 100 ms). Duration *is* shown on Thinking, SessionEvent turn markers, Subagent, BgTask, Workflow. |
| Bullet | Configured tool bullet. Failed tools → red (`accent_error`). Many collapsed tools omit a colored bullet. |
| Accent rail | Execute (config), expanded Web\*/MCP/Other, Thinking, Subagent/BgTask/Workflow while running. Collapsed tools usually have no accent. |
| Dense packing | Adjacent collapsed ToolCall + Thinking + Subagent + BgTask + Workflow + Btw have no extra gap. |
| Copy `Y` | Execute → cmd, Read/Edit → path, WebFetch → url, WebSearch → query, Search → pattern. Footer labels: `copy cmd` / `copy path` / `copy url` / `copy query` / `copy pattern`. |
| Viewer | Enter / Ctrl-F. Streaming follow while the block is still running. Edit `y` copies a unified patch. Markdown `r` toggles raw. |
| Rerun | **None.** There is no in-transcript rerun control. |

### 7.2 Tool call variants

#### Execute — `tool/execute.rs`

- Header (Label style): `Run ` + optional `(user) ` if `bash_mode` + description **or** command. Shell style: `$ ` + bash-highlighted command.
- Collapsed with a description: description title only (command hidden). Expand reveals `$ command` and output.
- Agent tools stay **Collapsed** while running (no live stdout in the transcript). User `!` bash defaults to **Truncated** live tail and expands on finish.
- Output: terminal-styled stdout on `bg_dark`. Truncated: first N + `… +{hidden} lines` + last M.
- Error: error accent; error lines after a blank separator.
- Live: `push_output` streams chunks.
- Not verb-folded (label-only `Command` for truncation headers).

#### Read — `tool/read.rs`

- `Read ` + path + optional `(start-end)` / `(range of total)` / `(empty)` / `(image)` / `({n} pages)`.
- Skill definition (`SKILL.md`): `Skill ` + skill name (no path link).
- Default and finish → Collapsed. Fold cycle is Collapsed ↔ Truncated (not full Expanded via fold).
- Body: syntect-highlighted lines with a gutter. Truncated: first 5 + `…` + last 3.
- Verb-folds as File (or Skill / MemorySearch).

#### Edit — `tool/edit.rs`

- `Edit ` / `Creating ` (`write`) / `Editing workflow ` / `Creating workflow ` (`.rhai` under `workflows/`) + path.
- Collapsed trusted suffix: ` +{ins}/-{del}` (diff colors) or ` ({n} edits)`.
- Body: syntax-highlighted diff hunks. Truncated ≡ Expanded. `copy_text` = unified patch.
- Consecutive edits to the same file can be stitched (`tracker` merge of overlapping hunks).
- Not verb-folded unless memory-scoped (then MemorySearch).

#### ListDir — `tool/list_dir.rs`

- `List ` + shortened path + ` ({n} entry|entries)` when it fits.
- Body: indented listing. Verb-folds as Dir.

#### Search (grep/glob) — `tool/search.rs`

- `Search ` + quoted pattern + optional ` in ` glob/path + trailing `(N matches)` / `(N matches in M files)` / `(no matches)` / `(no files)` / `(N files)`.
- Expanded: metadata (`mode`, `type`, `case-insensitive`, `multiline`) + results (path then line-numbered hits, or file list, or `path:N` counts).
- Verb-folds as Search / MemorySearch.

#### WebFetch — `tool/web_fetch.rs`

- `Fetch ` + URL.
- Expanded: status / content-type / size; body up to 10 lines (Truncated: 3); overflow `... (N more lines, press Enter to view)`.
- Verb-folds as WebFetch.

#### WebSearch — `tool/web_search.rs`

- `Web Search ` + query + collapsed ` ({n} site|sites)` (unique domains). X-search can omit the body.
- Expanded: content preview + `Sources: d1, d2, d3 (+N more)`.
- Verb-folds as WebSearch. Distinct citation URLs can override the verb-group count.

#### IntegrationSearch (`search_tool`) — `tool/search_tool.rs`

- `Search Tools ` + query + ` ({n} result|results)`.
- Expanded: numbered `{Action}  {Server}` rows, or `(no results found)`.
- Verb-folds as IntegrationSearch → “MCP tool(s)”.

#### UseTool — `tool/use_tool.rs`

- `{Server} {Action}` (MCP delimiter split, titleized) or a single titleized name.
- Expanded: args as `key: val`; output preview; error line.
- Not verb-folded (truncation label McpCall).

#### MemorySearch — `tool/memory_search.rs`

- `Memory Search ` + query + ` ({n} result|results)`.
- Expanded: `{path}:{start}-{end}  (score: {s:.2}, {source})` + up to 3 snippet lines.

#### SentMessage — `tool/sent_message.rs`

- Collapsed: `Message ` + `sending to {noun}` / `sent to {noun}` / `queued for {noun}` / `interjected to {noun}` / `rejected · {noun}` / `unconfirmed · {noun}`.
- Expanded: optional ` · steer|queue|interject` + ` · {elapsed}` if terminal and ≥ 100 ms.
- Noun: named label, `parent`, or `subagent …{last8}`.

#### Skill / Other — `tool/other.rs`

- Skill: `Skill` + muted summary.
- Other: if `name` contains `": "`, `Label ` + content; else bold name + optional muted summary.
- AskUserQuestion Q&A renders as numbered `q` / `→ a` in the body.
- Media tools: header + dim filepath; `[Open Image]` / `[Open Video]` when inline graphics are off.

### 7.3 Non-tool blocks

#### User — `blocks/user.rs`

- Prefix: prompt arrow / `$ ` (bash) / `↻  ` (cron).
- Band background (`bg_light`). Skill tokens in `accent_skill`.
- Collapsed: max **3** lines + ` …`. Sticky-header capable. Optional timestamps.
- Optimistic local send pushes this row; the ACP user echo is skipped (`expect_user_echo`).

#### Agent — `blocks/agent.rs`

- Streaming markdown. Not foldable. No bullet/accent by default.
- Mermaid (after finish): fence art + `◇ mermaid [Open Image] [Copy Image Path] [Copy Source]` (+ `rendering diagram…` while busy).
- Raw-mode toggle.

#### Thinking — `blocks/thinking.rs`

Covered in §5.2. Default while running: **Truncated** (optional header + `…` + last N lines). Finish → **Collapsed**. Accent rail, or in-body `┃ ` under the bullet in minimal mode. Finished collapsed thoughts can be claimed into a verb-group run (height 0, not labeled).

#### Session event — `blocks/session_event.rs`

Non-interactive, unselectable, no accent. Exact turn strings:

| Variant | Text |
|---|---|
| Turn completed + elapsed | `Worked for {duration}` (no period) |
| Turn completed, no elapsed | `Turn completed.` |
| Cancelled | `{phrase} in {duration}.` |
| Hook-denied | `Turn blocked by a hook in {duration}.` |
| Halted | `Agent was unable to make progress. Turn ended in {duration}.` |
| Failed + elapsed | `Turn failed in {duration}: {error}` |
| Failed, no elapsed | `Turn failed: {error}` |
| Compaction started | `Context {n}% full. Compacting…` |
| Compact started (manual) | `Compacting conversation…` |
| Compact completed | `Compaction completed in {duration}.` |
| Goal complete | `Goal complete in {duration} end-to-end.` |
| Recap | `Recap: {summary}` |
| Re-auth | `Authentication required: … Run /login …` |
| Context too large | `This conversation is too large … Use /new …` |

Cancel phrases (`blocks/cancel_cause.rs::CancelledBy::phrase`):

- `Turn cancelled by user`
- `Turn cancelled because the session closed`
- `Turn cancelled because the session shut down`
- `Turn cancelled after reaching the turn limit`
- `Turn cancelled because a permission was denied`
- `Turn cancelled because a permission prompt was dismissed`
- `Turn cancelled by the agent host`
- `Turn cancelled`

A send-now cancel that only aborts a wait does **not** write a cancel marker (`turn_completion.rs`).

#### Subagent — `blocks/subagent.rs` (always one line)

- Sync running: `Subagent running: "{desc}"{ · activity}{meta}`
- Background start: `Subagent started: "…"`
- Terminal: `Subagent completed in {t}: "…"` / `failed in {t}{ (err)}: "…"` / `cancelled in {t}: "…"`
- Animated bullet while running; green completed; red failed/cancelled. Enter opens the subagent view. Verb-groupable.

#### Workflow — `blocks/workflow.rs`

- `Workflow {name}: {objective}` / `done in {t}:` / `failed in {t}:` / `◌ cancelled after {t}:` / `paused at {t}:`
- Optional phase ticks `[phase ✓|●|○ · …]` and `(N agents)` while running.

#### BgTask — `blocks/bg_task.rs`

- `Task started: {desc|cmd}`
- `Task completed in {t}: …`
- `Task failed|killed in {t}: …{(exit N)|(sig)}`
- Always collapsed. Enter → viewer with stored stdout.

#### Btw — `blocks/btw.rs`

- Collapsed: `/btw {question}`. Expand → markdown answer.

#### System — `blocks/system.rs`

Muted wrapped text. Compact. Not foldable.

### 7.4 Presentation cheat-sheet

| Block | Collapsed one-liner | Running cue | Elapsed in row? |
|---|---|---|---|
| Execute | `Run {desc\|cmd}` or `$ cmd` | Animated accent | No |
| Read | `Read path (range)` / `Skill name` | — | No |
| Edit | `Edit path +N/-M` | — | No |
| List | `List path (N entries)` | — | No |
| Search | `Search "pat" (N matches)` | — | No |
| Fetch | `Fetch url` | Accent when expanded | No |
| Web Search | `Web Search q (N sites)` | Accent when expanded | No |
| Search Tools | `Search Tools q (N results)` | Accent when expanded | No |
| UseTool | `Server Action` | Accent when expanded | No |
| Memory Search | `Memory Search q (N results)` | Accent when expanded | No |
| Message | `Message sent to …` | Animated bullet | Expanded only, ≥ 100 ms |
| Other/Skill | `Name  summary` | Truncated + accent | No |
| Thinking | `Thought for 1.2s` | `Thinking…` + rail | Yes |
| Subagent / Task / Workflow | lifecycle sentence | Animated bullet | Yes (terminal) |
| Turn marker | `Worked for 2.0s` | — | Yes |

---

## 8. Verb-group folding

`scrollback/state/verb_group.rs` + `groups.rs`. One scan owns every grouping decision: verb-group runs first, then truncation (“N more”) over the rest.

### 8.1 Eager verb runs

Consecutive **collapsed** members of foldable kinds collapse under one header. The label rebuilds every frame so tense and counts update in place. Running entries repaint every tick; no per-call detail churns beside the header while the run executes.

Eager fold kinds (`ToolCallBlock::verb_group_kind` returns `Some`): File, Skill, Search, Dir, WebFetch, WebSearch, MemorySearch, IntegrationSearch, Subagent.

Label-only (truncation headers, not eager fold): Command, EditFile, McpCall, Message, OtherTool. Execute / Edit / UseTool / SentMessage / Other therefore stay as their own rows, densely packed.

Gated by appearance `group_tool_verbs`.

### 8.2 Run membership

`run_step`:

| Entry | Step |
|---|---|
| Collapsed verb-groupable tool / subagent | `Member` (counts toward the fold) |
| Finished collapsed thinking without prompt chrome | `ThoughtMember` (claimed, height 0, never labeled) |
| Streaming, user-opened thinking, or manually opened tool | `Transparent` (keeps its own rows, does not break the run) |
| Anything else | `Break` |

A kind-swap (eager `Other` refining into `Read`) marks the entry structurally dirty so the next layout pass recaptures the fold (`verb_group_kind_changed`).

### 8.3 Header vocabulary

| Kind | Running / Done | Noun |
|---|---|---|
| File / Skill | Reading / Read | file(s) / skill(s) |
| Search / WebSearch / MemorySearch / IntegrationSearch | Searching / Searched | pattern(s) / website(s) / memor(y\|ies) / MCP tool(s) |
| Dir | Listing / Listed | dir(s) |
| WebFetch | Fetching / Fetched | website(s) |
| Subagent / Command / OtherTool | Running / Ran | subagent(s) / command(s) / tool(s) |
| EditFile | Editing / Edited | file(s) |
| McpCall | Calling / Called | MCP tool(s) |
| Message | Sending / Sent | message(s) |

Buckets are ordered by first appearance. WebSearch counts distinct citation URLs; subagent rows count distinct child session ids (started + terminal of the same child count once). Failures append ` · N failed`. Mixed subagent states can read `Running N subagents, M completed`.

Examples:

- Done: `Read 2 files, Searched 1 pattern, Listed 1 dir`
- Running: `Reading 1 file, Searching 1 pattern`
- Failures: `Read 3 files · 2 failed`
- Truncation: `Ran 6 commands`

The user can expand a group (keyed by the first entry id in `expanded_groups`). Toggling one member open does not dissolve the group.

---

## 9. Interaction surfaces

Blocking cards **replace the prompt slot**. The composer draft is stashed. They are not centered modals.

### 9.1 Composer

`views/prompt_widget/mod.rs`. Visual:

```
 ❯ type here, text wraps
   continuation of long input...
 grok-3 · yolo
```

Accent `┃` and the selection box are painted by the agent view, not the widget. Info line: model · flags (`plan` / always-approve / yolo) · optional usage warning · `multiline`. Plan mode tints the chrome golden. Bash `!` is yellow. Image/paste chips; `@` file-search; `/` slash dropdown; history search. Voice interim overlays the prompt while dictating.

Enter submits / queues / interjects. Mid-turn typing **queues** unless the wait is sendable. Esc policy: clear draft / rewind / cancel mid-turn, depending on `EscStep`.

### 9.2 Permission

`views/permission_view.rs`. Occupies the prompt slot (`permission_view_h`). Accent bar on the left, `bg_light` fill.

Shows: optional subagent label, bold title, bash command with word highlights (or MCP scope / args), numbered options (Allow once / always / reject / followup / YOLO), scope hint `← → narrow` + `e edit pattern`, optional pattern editor + preview. Long bash/MCP args collapse with a Ctrl-F indicator.

Keys (`BlockingCard::Permission`, outranks other cards): j/k/Tab options; `1–9` select; Enter; ←/→ bash/MCP scope; `e` pattern edit; typing on RejectOnce → followup input (reuses composer); Ctrl-F expand/collapse; Ctrl-O YOLO; Ctrl-C cancel; Esc parks focus to scrollback. Tab/Space from scrollback returns.

Ingress: `app/acp_handler/permissions.rs`. Dispatch: `app/dispatch/permissions.rs`. YOLO can auto-AllowOnce. A queue of permission requests is drained in order.

While the card is open the turn is still `TurnRunning`; the spinner is the pulsing diamond.

### 9.3 Question (`AskUserQuestion`)

`views/question_view.rs`. Prompt-slot overlay + footer. Chrome: label / description / preview, tab counter, option rows, sticky freeform “Other”. Plan-mode bottom panel can offer Chat / Skip.

Local (non-ACP) questions reuse the same view: fork/new-session worktree, credit upsells, doctor fix, delete session, prompt-blocked hook, agent-type mismatch.

Keys (`BlockingCard::Question`): j/k/Tab, Space toggle, Enter, h/l / `[` `]` tabs, `1–9`/`a–f` jump, Ctrl-F fullscreen, Ctrl-Y dismiss, Ctrl-C submit-skip, Esc park. InputMode: Enter commits freeform.

`opened_at` pauses turn-timer accounting. Phase timer is suppressed while the activity title is an Ask tool.

### 9.4 Plan approval

`views/plan_approval_view.rs` + `app/agent_view/plan.rs`. Fullscreen markdown line viewer of `plan.md` + composer for notes/comments.

Status cue: `Waiting on plan approval`, or `No plan written: approve or request changes` when the body is empty (placeholder in `EMPTY_PLAN_PLACEHOLDER`). Header shows a `plan` chip.

Keys (`KeyOwner::PlanApproval`): empty notes → `a` approve, `g` approve-as-goal; Enter = request changes / save comment; Tab toggles plan ↔ prompt; Esc back. `y` copies the plan in Preview.

### 9.5 MCP elicitation

`views/elicitation_view/`. Prompt-slot blocking card (`BlockingCard::McpElicitation`). Form fields or URL consent. `y` Accept / `d` Decline; Esc park/dismiss.

### 9.6 Cancel-turn

`views/modal.rs::render_cancel_turn_panel` in the prompt slot (`BlockingCard::CancelTurn`). Stop vs continue-subagents. State becomes `TurnCancelling` (`Cancelling…` on the status row). `[stop]` while cancelling retries the cancel.

### 9.7 Queue

`views/queue_pane.rs` + `app/agent_view/queue.rs`. Side list `#N` first line + `(+N lines)`; `[Send now]` / `[edit]` / `[cancel]`. Toggle Ctrl-`;` / Ctrl-`'` (Ctrl-`4` on local Mac VS Code). When dock is on, the body moves into the dock.

Empty-composer Enter / send-now chord force-interjects the top held row mid-turn on a sendable wait. Edit mode owns the composer (`PromptMode::EditingQueued`).

### 9.8 Todos

`views/todo_pane.rs`. Checklist glyphs by status (pending / in-progress / completed / cancelled). Empty: `No todo items.` / `All done.` Cap ~10 lines / 15% height. **Not auto-shown**; Ctrl-T toggles. ACP Plan updates replace items in place even while hidden.

### 9.9 Tasks

`views/tasks_pane.rs`. Unified list: Workflows / Subagents / Tasks / Watchers. Spinners, line-count badges, `[stop]` / `[view]`. Status chip `◆ N` running. Ctrl-G, or folded into the dock. Watchers feed the idle turn-status “still running” cue. Live elapsed per row uses `format_duration`.

### 9.10 Dock

`views/dock/`. Experimental, gated by remote `dock_enabled`. Directly above the prompt. Sections: Workflows, Subagents, Tasks, Watchers, Queued. Max **8** rows at rest. Running rows animate a leading-dot spinner (same `SPINNER_DIVISOR` as turn-status). Meta column examples: `grok-4.5 2m14s`, `every 5m (next in 2m)`. `[stop]` on killable rows. Queue body is embedded.

### 9.11 Other overlays (not the prompt slot)

| Overlay | File | Notes |
|---|---|---|
| Line / plan / file viewer | `views/file_search/line_viewer` | ~status-bar → turn-status |
| Block viewer | `views/block_viewer/` | ~95% × 92% popup |
| Command palette / arg picker / session picker / settings / usage / shortcuts help / memory | `views/modal.rs` + feature views | centered `ActiveModal` |
| Agents / Feedback / Extensions | `views/{agents,feedback,extensions}_modal` | centered |
| Image / video | terminal overlay | ~90% centered |
| Subagent fullscreen | `AgentView::draw_subagent_fullscreen` | replaces the whole agent draw |
| File / slash / completion / history dropdowns | various `views/*dropdown*` | floating above the prompt |

### 9.12 Status line vs turn-status

They are different rows.

- **Turn-status** (§6): live spinner + phase/turn timers. Always the operational activity line.
- **Status line** (`views/status_line/`, user-guide `25-status-line.md`): optional bottom row, **disabled by default**. Builtin items `cwd │ model │ 12% ctx` (plus `cost`, `turn-timer`, `session-name`) or a user script. Debounced 300 ms. Builtin `turn-timer` is coarse integer seconds, not the live phase clock.

`app/status_blocks.rs` is the `/queue` `/tasks` `/usage` text dump, not a live row.

### 9.13 Tab title

`notifications/title.rs`. Config-driven items joined with ` - `: action-required, spinner, activity, session-name, grok, model, cwd, turn-timer. Braille spinner advances every 8 ticks. `⚠ Action Required` blinks while unfocused. Parked turns clear activity, turn elapsed, and busy. OSC 9;4 indeterminate progress on Ghostty / WezTerm / iTerm ≥ 3.6, keepalive every 5 s.

---

## 10. Turn lifecycle

As the TUI presents it, not as the shell implements it.

1. **Send.** Enter on the composer → `dispatch_send_prompt` (`app/dispatch/prompt.rs`). Slash/local commands short-circuit. Otherwise enqueue; idle drain → `Effect::SendPrompt`. Optimistic user row. Composer cleared. `expect_user_echo` so the ACP echo is not duplicated.
2. **Turn start.** `AgentState::TurnRunning`. Turn-status appears (spinner + activity). `pre_create_thinking` if thinking blocks are on. `pin_reserve` arms so the prompt can sit at the top of the viewport.
3. **Streaming.** Thought chunks → `Thinking…` in the transcript and on the status row. First agent text finishes thinking (`Thought for Xs`) and starts assistant markdown (`Responding…`). Phase timer resets on each `PhaseKey` change; turn timer keeps running.
4. **Tools.** A tool call closes the prose segment. Status shows `Run {cmd}` / `Search` / `Fetch` / `{description}…` / writing-tool-call / waits. Agent execute stays collapsed (no live stdout). Consecutive collapsed non-destructive tools fold into a verb-group header. Running execute may show `[↓]` demote-to-bg.
5. **Permission / question / plan / elicitation.** Card replaces the composer (draft stashed). Spinner becomes pulsing `◆`. Turn stays `TurnRunning`. Ask suppresses the phase timer; question pause nets out of the turn clock.
6. **Queue.** Mid-turn typing queues. Sendable waits advertise `· N queued, Enter to send now`.
7. **Cancel.** `[stop]` / Esc / Ctrl-C may open the cancel-turn card. Status: `Cancelling…`. Send-now that only aborts a wait does not write a cancel marker.
8. **Complete.** `finish_turn` + `turn_completion::finalize_turn_from_terminal`. Terminal marker `Worked for {duration}` (or cancel/fail/hook). All running segments finalize before Mermaid / image extraction. Turn-status hides, or the idle watcher cue remains. `pin_reserve` notes the turn finished. Queue drains the next held prompt.

`AgentState` (`app/agent.rs`): `Idle` | `TurnRunning` | `TurnCancelling` | `CommandRunning` | `CommandCancelling`.

Terminal rails (`app/turn_completion.rs`): fire-and-forget `x.ai/session/prompt_complete` (compat) and durable `XaiSessionUpdate::TurnCompleted` (persisted, replayed). Both converge on `finalize_turn_from_terminal` so a viewer that re-attaches mid-turn does not stay stuck on `Waiting…`.

---

## 11. Animation and redraw cadence

| Constant | Value | Meaning |
|---|---|---|
| `AnimationConfig.fps` | default **30** (clamp 1–60) | `tick_interval = 1000/fps` ms |
| `TickDemand::Fast` | that interval | Busy / animating |
| `TickDemand::Slow` | **83 ms** (~12 fps) | Welcome shimmer / low-frequency |
| `TickDemand::None` | park | Idle, no wakeups |
| Turn spinner divisor | 4 | ~7.5 fps braille |
| Monitor pulse divisor | 8 | ~3.75 fps idle watchers |
| Title spinner divisor | 8 | ~3.8 fps tab title |
| Finish flash | 400 ms | Accent linger after a tool finishes (`FINISH_FLASH_DURATION_MS`) |
| Hook reveal | 300 ms | Fast hooks never flash on the status row |
| Writing-delta stale | 10 s | Drop a stuck “Writing …” phase |
| Resize debounce | 16 ms | One deferred draw after the size stabilizes |

`ScrollbackState::needs_animation` is true only if a **running entry is in the viewport**. Off-screen running tools do not force 30 fps. `scrollback.tick()` advances `animation_tick` used by turn-status and running accents.

Event loop: `app/event_loop.rs` `schedule_tick`. Config hot-reload can change `tick_interval`.

---

## 12. File:function index

Paths relative to `crates/codegen/xai-grok-pager/src/` unless noted.

| Concern | File | Symbol |
|---|---|---|
| App screen switch | `app/app_view.rs` | `draw_inner`, `TickDemand`, `SLOW_TICK_INTERVAL` |
| Event loop / ticks | `app/event_loop.rs` | `run` loop, `schedule_tick` |
| Agent compose | `app/agent_view/render.rs` | `AgentView::draw` |
| Row geometry | `views/agent.rs` | `AgentViewLayout::compute`, `ActivePane` |
| Key ownership | `app/agent_view/key_owner.rs` | `KeyOwner`, `BlockingCard` |
| Streaming machine | `acp/tracker.rs` | `AcpUpdateTracker::handle_update`, `activity`, `finish_turn`, `WaitingReason`, `TurnActivity` |
| Turn activity enrichment | `app/agent_view/` | `resolve_turn_activity` |
| Turn-status row | `views/turn_status.rs` | `render_turn_status`, `should_show`, `compute_activity`, `format_still_running` |
| Duration format | `xai-grok-pager-render/src/util.rs` | `format_duration`, `format_time_ago` |
| Thinking header | `scrollback/blocks/thinking.rs` | `header_line`, `format_time`, `finish` |
| Markdown stream | `scrollback/blocks/markdown_content.rs` | `MarkdownContent` |
| Agent message | `scrollback/blocks/agent.rs` | `AgentMessageBlock` |
| User prompt | `scrollback/blocks/user.rs` | `UserPromptBlock` |
| Tool enum / verbs | `scrollback/blocks/tool/mod.rs` | `ToolCallBlock`, `VerbGroupKind` |
| Execute | `scrollback/blocks/tool/execute.rs` | `ExecuteToolCallBlock` |
| Read / Edit / Search / … | `scrollback/blocks/tool/{read,edit,search,list_dir,web_fetch,web_search,use_tool,memory_search,sent_message,other,search_tool}.rs` | — |
| Subagent / task / workflow | `scrollback/blocks/{subagent,bg_task,workflow}.rs` | — |
| Turn markers | `scrollback/blocks/session_event.rs` | `SessionEvent::message` |
| Cancel phrases | `scrollback/blocks/cancel_cause.rs` | `CancelledBy::phrase` |
| Turn finalize | `app/turn_completion.rs` | `terminal_marker`, `finalize_turn_from_terminal` |
| Verb-group fold | `scrollback/state/verb_group.rs` | `verb_group_header_label`, `run_step` |
| Group scan | `scrollback/state/groups.rs` | `apply`, `GroupSpan` |
| Sticky prompts | `scrollback/sticky.rs` | `RenderedPrompt` |
| Pin-reserve scroll | `scrollback/state/pin_reserve.rs` | `arm_pin_reserve` |
| Transcript paint | `scrollback/scrollback_pane.rs` | `ScrollbackPane` |
| Composer | `views/prompt_widget/mod.rs` | `PromptWidget` |
| Permission card | `views/permission_view.rs` | `render_permission_view` |
| Question card | `views/question_view.rs` | `QuestionViewState` |
| Plan approval | `views/plan_approval_view.rs`, `app/agent_view/plan.rs` | `plan_approval_status_label` |
| Elicitation | `views/elicitation_view/` | — |
| Queue | `views/queue_pane.rs`, `app/agent_view/queue.rs` | — |
| Todos | `views/todo_pane.rs` | — |
| Tasks | `views/tasks_pane.rs` | — |
| Dock | `views/dock/mod.rs` | `render`, `enabled` |
| Header chips | `views/agent_status.rs` | `AgentStatusBar` |
| Context chip | `views/context_bar.rs` | — |
| Shortcuts | `views/shortcuts_bar.rs` | `ShortcutsBar` |
| Status line (script) | `views/status_line/` | — |
| Timeline | `views/timeline.rs` | `compute_rail`, `render_rail` |
| Welcome | `views/welcome/mod.rs` | `render_welcome` |
| Dashboard | `views/dashboard/render.rs` | `render_dashboard` |
| Block viewer | `views/block_viewer/` | — |
| Tab title | `notifications/title.rs` | — |
| Send prompt | `app/dispatch/prompt.rs` | `dispatch_send_prompt` |
| Permissions ingress | `app/acp_handler/permissions.rs` | `handle_permission_request` |
| Agent state | `app/agent.rs` | `AgentState` |

---

## Appendix: default key bindings (presentation-relevant)

Full table: user-guide `03-keyboard-shortcuts.md`. Defaults live in `actions/defaults.rs`.

| Key | Effect on presentation |
|---|---|
| Enter (prompt) | Send / queue / interject |
| Esc | Card park / cancel / clear, by `EscStep` |
| Ctrl-C | Cancel turn (may open cancel-turn card) |
| `[stop]` click | Same as cancel |
| `[↓]` click | Demote running execute to background |
| Tab / Space (from scrollback) | Return to a parked blocking card |
| h / l (vim) or Left / Right | Collapse / expand selected entry |
| Ctrl-E | Expand/collapse all thinking |
| Enter / Ctrl-F on a block | Fullscreen viewer |
| Y | Copy cmd/path/url/query/pattern |
| Ctrl-T | Toggle todos |
| Ctrl-G | Toggle tasks |
| Ctrl-`;` | Toggle queue |
| / | Find in scrollback |
| Ctrl-\ | Dashboard |
