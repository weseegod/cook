# Core Agent Flow: Cook vs. the Pi Coding Agent

Comparison date: **2026-09-22**.

Cook side: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md),
a review and proposal for the Rust runtime in this repository.

Pi side: [`earendil-works/pi`](https://github.com/earendil-works/pi), in
`packages/coding-agent` and `packages/agent`.

Pinned revisions for reproducibility:

| Source | Revision |
|---|---|
| pi | `1a584a7a56eb5e7b4ff8ccbd46430f1533282eed`, `main`, 2026-09-21, `@earendil-works/pi-coding-agent` 0.87.0 |
| Cook (branch head) | `e66c0da9a6f846f0bdbdccf8d24ad4c5d5660c32`, 2026-09-22 |
| Cook (base revision cited by the document) | `a8b1874dd099802bdae334733d2828a5697b05cf` |

This comparison does not change source code, configuration, or defaults. Cook's
figures were checked against the source at branch revision `e66c0da9` on the
same date. Items that remain proposals are labeled as such.

## 1. The two systems are different kinds of work

Cook here is a **design document for a running runtime** (Rust, actors, with
goals, subagents, MCP, and skills). Pi is a **released harness** (TypeScript).
At the pinned revision, the design document for the `agent` package is
`packages/agent/docs/harness.md`; `harness-v2.md` is not present in that tree.

One distinction affects every conclusion below: pi has **two different
execution paths**.

- **Released path:** CLI (`coding-agent` 0.87.0) uses the classic `Agent`
  class from `@earendil-works/pi-agent-core` together with `AgentSession`.
  Interactive, print, and RPC modes share this class. Compaction, branch
  summarization, session JSONL, and `context_edit` belong to this path.
- **Harness v2 path:** `packages/agent/src/harness/` (lanes, durability, and
  deferred calls). It is currently used by `packages/evals` and experimental
  modes in `coding-agent/src/experimental/` (micro, mini, and session-worker),
  **not** by the default path.

Therefore, when pi describes a strong rule (such as append-only context), read
which path the rule applies to. This document identifies the path in each
section.

Comparison labels: **similar**, **different**, or **no direct equivalent in
Cook**.

## 2. Runtime shape and ownership

| Aspect | Cook | pi | Comparison |
|---|---|---|---|
| Language / process | Rust, multiple actors: the session actor runs on its own OS thread with a current-thread Tokio runtime; sampler and chat-state actors handle their respective work | TypeScript, one Node process and one `AgentSession` per session | Different technically, similar purpose: separate session lifecycle from UI |
| Loop | Two nested loops: an outer loop for rounds, goal continuation, queued input, and stop hooks; an inner `process_conversation_turn_inner` loop | One step loop: each step is one assistant message plus the full batch of tools it calls | Different |
| Durable unit of work | Session lifecycle in the shell; the canonical event log is storage, SQLite is a derived index | An *operation* on a *lane* (`run`, `compaction`, `navigation`), accepted before execution and completed with an outcome | No direct equivalent in Cook |
| Parallelism | `FuturesUnordered` within one realtime turn; subagents have separate sessions | Lanes run in parallel within one harness; each lane has one operation | No direct equivalent in Cook (Cook uses subagents/children, not lanes) |
| Subagents | Yes, with goal orchestration | None in the CLI; its README calls subagents an intentional omission. Harness v2 allows a subagent tool on a second lane | Different |
| MCP | Discovery and tool calls; the registry distinguishes built-ins from MCP tools with a name-contains-`__` heuristic, with a TODO to use namespace metadata | No MCP, by design | Different |
| Plan mode, to-do, permission dialogs, background bash | Present (permissions, TodoGate, etc.) | Absent; delegated to extensions | Different |

## 3. Durable sessions and what the model actually sees

| Aspect | Cook | pi | Comparison |
|---|---|---|---|
| Storage | Canonical event log; SQLite is a derived index | Append-only JSONL, tree structure through `id` / `parentId` (session v3), one file per session | Different |
| Branching | Workspace-level checkpoints and worktrees | `/tree`, `/fork`, and `/clone` in the same file; old entries are never changed or deleted | Different |
| Sent prompt and tools | Rebuilt on each turn from the live conversation plus resolvers | The initial system message records **all** prompt sections and tool declarations; later changes are named `sections` patches plus `toolsAdded` / `toolsRemoved` | Different |
| Pruned request | The request-copy pruner's pruned copy is **not persisted**; inspect it through runtime logs. Compaction requests are persisted as `compaction_requests/{request_id}.json` | Omissions are persisted as `context_edit` entries (`replacement: null`) and apply on the branch | Different |
| Reconstructing “what the model saw” | Replay canonical history with the policy in effect. For compaction requests, read the artifact | Read the projection directly from the file | pi has a clear advantage for pruned requests |

Cook separates canonical history from model-visible context and deliberately
does not store the pruned request copy. pi also separates these, but records
the difference with `context_edit`. For Cook, answering “what exactly was in
the seventh request?” requires replaying the policy that applied then, except
for a compaction request with a saved artifact.

## 4. Append-only context: the clearest difference

At the pinned revision, `packages/agent/docs/harness.md` (around line 518)
states this invariant:

> Append-only context invariant. Across one lane's requests, provider context must only grow at the tail: an insertion before the previous request's tail invalidates the provider's KV cache and multiplies cost. This is why mid-run writes defer to checkpoints, where they append at the tail. Compaction is the one deliberate cache invalidation, traded for a smaller context.

This statement belongs to the `agent` package's lane and checkpoint design.
The released CLI describes the storage half of the rule in
`packages/coding-agent/README.md` (around lines 285–289): model context is a
projection of append-only history; an extension hides or replaces an older
message by **appending** a `context_edit`, not by modifying the old entry.
`replacement: null` hides the message from later requests while retaining it
in JSONL.

So “step-aware pruning is forbidden” would overstate the rule. Pi forbids
editing recorded history and inserting before the prior request's tail. The
released CLI **allows** a later appended `context_edit`, and that omission can
still break cache reuse from that point onward, much like Cook's opt-in
step-aware arm. The difference is that pi records the omission while Cook
does not record the pruned request copy.

| Aspect | Cook | pi |
|---|---|---|
| Rule status | Priority 2 in the conclusion: keep the prefix byte-stable, cap output when generated, and limit rewrites within history | Named invariant in `harness.md`; the released CLI describes the storage side in its README |
| Step-aware arm | Opt-in: `keep_last_n_tool_rounds = 6`, `recent_tool_result_char_budget = 64000`; older results become placeholders as the round window moves. Canonical history is unchanged | Recorded history is not modified. Omission is a later appended `context_edit`, not a default setting |
| Cache impact | Accepted when opted in, with a warning that the uncached share may increase | Inserting before the tail is a design error. Omission via `context_edit` is allowed and can still break cache reuse |

Cook's conclusion (“do a sliding rewrite once at a coarse boundary, near
compaction”) remains aligned with pi's compaction exception. Deferring writes
between steps until a checkpoint is a lane mechanism; Cook does not port it
just to reduce tokens.

**Unverified:** `harness.md` says that writes between steps are deferred until
a checkpoint. The README and `agent-session.ts` confirm that the CLI appends
`context_edit` and does not alter old entries. The source was not checked to
confirm that `AgentSession` defers every between-step write by the lane's
checkpoint mechanism.

## 5. Compaction and summarization

| Aspect | Cook | pi | Comparison |
|---|---|---|---|
| Threshold | Auto-compaction baseline is 85%, with resolver overrides | `contextTokens > contextWindow − reserveTokens`; `reserveTokens` defaults to 16384 | Different representation, similar purpose |
| Prefire | Yes: `DEFAULT_PREFIRE_LEAD_PERCENT = 10` in `session/compaction.rs`, or about 75% when the threshold is 85%. Pass 1 runs in the background | No background pass. `shouldCompact` in `compaction.ts` uses `contextTokens > contextWindow − reserveTokens`. The README calls it “proactive”; it is a reserve threshold, not a pass ten points early | Different |
| Recent context retained | Not “three turns.” Three is `keep_last_n_turns` for **request-copy pruning** (`memory.rs`, default 3). Compaction keeps the tail after a 95% split (`TWO_PASS_DEFAULT_SPLIT_FRACTION` in `two_pass.rs`), plus `CompactionStateContext` (messages since the anchor, edited paths, tasks, MCP, and to-dos) | `keepRecentTokens` defaults to 20000 and splits at a turn boundary | Different mechanisms |
| Splitting a turn | No two-summary turn split. `two_pass.rs` refuses to break a tool-call/result pair | Has a “split turn”: generate two summaries (history and turn prefix), then combine them; never split at a tool result | Different |
| Summary format | `CompactionStateContext` injects edited paths, tasks, MCP, and to-dos. The proposed schema adds objective/constraints, decisions, checks, unresolved failures, artifacts, and next steps | Fixed schema: Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context, plus `<read-files>` and `<modified-files>`; `fileOps` accumulates details from the previous compaction | Different; pi is more specific about read-file lists |
| Trimming before summary | `compaction_verbatim_input` is enabled by default and prefers verbatim history | `serializeConversation` truncates each tool result to 2,000 characters before summarization | Different |
| Summary cache | Keeps the prefix aligned with the parent turn: `generate_session_compact` sends the parent session ID and **retains the tool list**. A comment in `session_compact.rs` says dropping tools shifts the prefix and forces a full prefill. Cook does not copy pi's `cacheRetention: "none"` | `completeSummarization` sets `cacheRetention: "none"`. Without a session ID, it creates a new one because the summary is a one-off transcript | Deliberate difference; Cook does not disable caching |
| Reserve | 32,768 tokens for the compaction prompt, summary, and reasoning (`SUMMARY_BUDGET_RESERVE_TOKENS`) | `maxTokens = min(floor(0.8 × reserveTokens), model.maxTokens)` in `generateSummaryWithUsage`. Branch summaries use `min(4096, model.maxTokens)` with the same wrapper that disables caching | Source-checked; different formulas |
| Truncated summary | Outcome is recorded as `Truncated`, and `compaction.complete` still runs (`compaction.rs`) | `getSummarizationFailure` rejects a checkpoint when a summary stops with `length` | Different; Cook's behavior is unchanged |
| Two passes | Pass 1 snapshots a prefix, summarizes it in the background, and saves NOTE₁ with a fingerprint. A changed prefix or model invalidates the note. Feature registry default is `true`; portable `CompactionPolicy::default()` is `false` | No two-pass flow; `session_before_compact` lets extensions provide a summary. Later summaries use `UPDATE_SUMMARIZATION_PROMPT` to merge a prior summary, not a prefire pass | Different |
| Per-model settings | Context window is per model; no retuning here | `compaction.modelOverrides` sets `reserveTokens` / `keepRecentTokens` by `provider/modelId` | pi has this; Cook does not |

## 6. Prefix-cache policy

| Aspect | Cook | pi | Comparison |
|---|---|---|---|
| Adapter behavior | Responses: `prompt_cache_key` falls back to conversation ID, and `previous_response_id` is currently `None`; Messages: breakpoints in system and transcript; memory-context block is reused to keep the prefix stable | `cacheRetention` short/long, `PI_CACHE_RETENTION=long`, TTL from each model's `promptCache` tier | Similar direction, different detail |
| Hit/miss measurement | `usage.rs` records input/output/cache/reasoning; phase 4 planned `uncachedInputTokens` and `cacheFieldPresent` | Every assistant message's `Usage` separates `input`, `cacheRead`, `cacheWrite` (and `cacheWrite1h`), `reasoning`, and per-bucket `cost` | pi already has fields Cook planned to add |
| Keeping a cache warm | No cache warmer. Cook keeps the prefix stable and records cache reads | `cache-warmer.ts` resends the latest request with `maxTokens: 1` before TTL expiry only when `continuationProbability × missCost − warmCost ≥ $0.05`; it skips unsafe replays and records usage as `kind: "cache_warm"` | No direct equivalent in Cook |
| Display | Session ledger | `footer.ts` shows `CH` for the **latest assistant message's** hit rate, `cacheRead / (input + cacheRead + cacheWrite)`, only when that message has cache reads or writes. It is not a session average | No direct equivalent in Cook |

Pi goes one meaningful step beyond Cook here: it **prices** keeping a cache
warm and does it only when the expected savings exceed the threshold, rather
than only avoiding cache invalidation. Cook currently focuses on avoiding
invalidation.

## 7. Tool output size

| Tool | Cook | pi | Comparison |
|---|---|---|---|
| read | Cap of 25,000 **estimated tokens** (`READ_FILE_MAX_TOKENS`) and `MAX_LINES_READ = 1000`. At the line cap, the marker gives the number of truncated bytes, total lines, displayed range, and next `offset` (`read_file/mod.rs`). At the token cap (`FileTooLarge`), it only suggests `offset` / `limit` and does not calculate the next offset | `truncateHead` uses `DEFAULT_MAX_LINES = 2000` or `DEFAULT_MAX_BYTES = 50KB`, whichever comes first; the notice gives the next `offset` and total lines | Similar line cap behavior; different token cap |
| bash | Default model output cap is 20,000 characters; truncated output includes a path to the full log | `truncateTail` uses 2,000 lines / 50KB; full output is saved to a temporary file and its path is included in the notice; executor caps raw collection at 100KB | Different |
| grep/find/ls | Limits are defined per tool in the registry | Result limits: grep 100, find 1,000, ls 500; also 50KB total, with matching lines capped at `GREP_MAX_LINE_LENGTH = 500` characters | Different |
| Oversized prompt | `prompt_offload.rs` writes a file and sends the model a head/tail excerpt; threshold is `READ_FILE_MAX_TOKENS × BYTES_PER_TOKEN = 100000` bytes | No corresponding mechanism; relies on `@file` and reads with offsets | No equivalent in pi |
| When truncation occurs | Bash truncates at generation. Read truncates at generation by line and token limits. Request-copy pruning changes a copy, not history. Phase 3, if implemented, reuses the read continuation marker instead of adding head/tail read truncation | Always at output generation: read uses `truncateHead`, bash uses `truncateTail` | Cook is already similar to pi for read line limits |

Units differ: Cook counts **estimated tokens** (bytes/4) and lines (1,000); pi
counts actual **bytes** (50KB) and lines (2,000). These are not directly
comparable values.

## 8. Tool catalog and discovery

| Aspect | Cook | pi | Comparison |
|---|---|---|---|
| Toolset size | Broad registry with MCP, skills, subagents, and goals | Eight built-ins (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `powershell`), four by default | Different |
| Catalog budget | Skill catalog defaults to 50% of context, with a 400,000-character fallback; each description plus `when-to-use` is capped at 400 bytes. Experiment proposal: 1–2k tokens | No comparable budget; reduce tools and load skills on demand | Different |
| Discovery | MCP discovery/call tools; the initial main request does not contain every MCP schema; `__` name heuristic has a TODO | Skills via `/skill:name` or automatically; examples of “deferred tools” activate tools as needed; `--tools` / `--exclude-tools` allowlists | Different |
| Profile selection | Proposed profile-specific toolsets selected deterministically from mode/capability | Selected by CLI flags and extensions; `activeTools` is per lane in the harness | Different |

## 9. Offline, deferred, and batch work

| Aspect | Cook | pi | Comparison |
|---|---|---|---|
| Batch API | Four conditions in §9 of the design document; `supports_batch_api` on `[model."<id>"]`; the coding loop does not use it; at the time of the comparison only the eval harness read the flag | No Batch API path in the coding loop. The design uses another mechanism: deferred requests return a handle immediately, persist an assistant message with `stopReason: "deferred"` and a `DeferredHandle`, suspend the lane, and later append the real result through `fetchDeferred` | Different mechanism, similar conclusion |
| Purpose | Reduce the **price** of frozen work, not token count | Make long runs durable: suspend/resume across processes and avoid timeouts | Clearly different purpose |
| Actual status | Flag was planned for phase 5; it was not yet implemented at the comparison point | Type/contract and harness path exist; only the `faux` test provider implements deferred calls at this revision, with no real provider | Neither had a live provider path at that point |
| Price | Provider prices: Xiaomi MiMo 50% discount, DeepSeek no batch, xAI 20% only on `grok-4.3` and `grok-4.20-0309` | `calculateCost` uses model price tables and has no Batch API discount concept | Different |

## 10. Side calls and auxiliary inference

| Aspect | Cook | pi |
|---|---|---|
| Existing auxiliary calls | Dream, memory capture, flush, laziness classifier, prompt suggestion, goal roles (planner/verifier/strategist/summarizer/continuation), recap, `/btw`, turn summary, title refresh | Only the step request, compaction summary, branch summary, and cache warming |
| Phase 7 | Keep all calls and add ledger rows | Nothing to retain; pi does not ship those calls |
| Who provides them | Cook ships them and measures them | User extensions |

Cook has a much larger auxiliary inference surface. That is why its design
uses a dedicated phase to measure it instead of turning the calls off.

## 11. Cost and usage accounting

| Aspect | Cook | pi | Comparison |
|---|---|---|---|
| Ledger | `usage.rs`: `purposeUsage`, `requestComponents`, per-model ledger, missing-cost, and “incomplete” semantics | `usage.json` / JSONL: `Usage` on each assistant message (buckets plus cost), and `UsageEntry` with `kind` for non-message usage | Different shape |
| Usage outside the conversation | Plan to classify every call by purpose, with retries as a separate dimension | `UsageEntry` with a `kind` such as `cache_warm` contributes to the session total but not model context | Similar idea |
| Missing usage | Key design: a successful response with `usage=None` marks both ledgers incomplete; it does **not** invent zero | No equivalent “incomplete” semantics found. Observed fallbacks include `usage ?? DEFAULT_USAGE` in `faux` and `assistant?.usage ?? usageRecord(entry)` in experimental micro | Cook is stronger here |
| What the session total includes | Purpose rows plus work not yet assigned to a purpose | Footer says totals include assistant responses, tool-reported usage, and summary generation | Similar in principle |

## 12. Measurement practices

| Aspect | Cook | pi |
|---|---|---|
| Task set | Proposal for 30–50 fixed tasks by category: one-file fixes, fixes with failing tests, repository exploration, multi-file refactors, context overflow, interjection/resume, MCP/skill, and goals with children. Includes Vietnamese/Unicode payloads | `packages/evals`: vitest-evals with isolated `with_docs` / `without_docs` arms in containers, reporting “lift”; host evals are a regular suite |
| Decision metric | **Cost per accepted task**, with success rate, raw/uncached input, p95 latency; target ≥20% savings with a loss below 2 percentage points | Documentation “lift” versus no documentation; no cost-per-task accounting found |
| Decision matrix | One phase, one matrix, one commit; quality cells gate the change; three local models | No comparable matrix described; relies on an eval suite |
| Data sharing | Not available | Active: publish sessions to Hugging Face to improve models, prompts, and evals |

Cook is ahead in one area: its design has a quantitative decision protocol
(matrix, quality gate, cost per accepted task) that pi does not describe. Pi is
stronger in having an eval suite that runs in CI and real session data for
comparison.

## 13. What Cook should learn and decline

### Learn

These are observations in the design document, not a new phase or a default
change.

1. **Name the append-only rule and its exception.** Keep sent bytes unchanged.
   Compaction is the planned cache break on the hot path. Keep step-aware
   pruning opt-in and disabled by default. Do not port the lane's checkpoint
   deferral mechanism.
2. **If a tool result is omitted later, record the omission as an append-only
   entry instead of changing canonical history.** Pi does this with
   `context_edit`. Cook does not store the pruned request copy. Do not add that
   store in experiment v2; phase 2 already leaves canonical history unchanged.
3. **For reads, keep the start of the file and state the next offset, total
   lines, and displayed range.** Cook already does this at the line cap. The
   token-cap (`FileTooLarge`) path does not calculate the next offset; if phase
   3 adds a cap, reuse the existing marker instead of adding head/tail read
   output. Bash already keeps the tail and a path to the full log. Do not copy
   pi's 50KB or 2,000-line limits, and do not lower `READ_FILE_MAX_TOKENS`.
4. **Build summary file lists from tool provenance and merge them with the
   previous summary's lists.** Pi uses `fileOps` plus prior `readFiles` /
   `modifiedFiles`. Cook already injects `agent_edited_paths`, tasks, MCP, and
   to-dos through `CompactionStateContext`. Do not ask the model to remember
   those paths; this does not need a separate phase.

### Decline, and why

1. **Cut down to four tools or remove MCP, subagents, and goals to save tokens.**
   Those are pi's product choices, not evidence of token optimization. In
   Cook's design, hiding a skill the task needs is a quality failure, not a
   saving.
2. **Move the coding loop to Batch API.** Pi does not do this either, but its
   deferred mechanism is not evidence for a token optimization: it targets
   durable suspend/resume across processes, and only a test provider implements
   it at the pinned revision. The four conditions in §9 of Cook's design still
   apply.
3. **Port lanes/durability to Cook to reduce tokens.** Lanes address crash
   recovery and multiple parallel identities on one history; they do not
   shorten prompts. Cook's design says process layout does not reduce prompt
   size.
4. **Copy pi's usage fallback.** It does not distinguish missing usage from a
   zero-token call, while Cook treats that distinction as essential. Preserve
   Cook's incomplete semantics. Do not fill missing cache data with zero.
5. **Disable two-pass prefire because pi lacks it.** Pi's “proactive”
   `shouldCompact` is `contextTokens > contextWindow − reserveTokens`, not a
   background pass ten points early. The lack of prefire does not show that
   prefire is wasteful.
6. **Set `cacheRetention: "none"` on Cook's compaction request.** Pi disables
   caching because its summary is a one-off transcript. Cook deliberately
   retains the tool list and parent session ID to keep the prefix aligned
   (`session_compact.rs`). Copying the cache-off setting would break that
   alignment.
7. **Warm the cache with a `maxTokens: 1` request before TTL expiry, using pi's
   $0.05 threshold.** Cook has no per-model TTL, and phase 4 had not yet
   reported hit versus miss. This is not part of experiment v2.
8. **Reject a summary stopped by `length`, following pi's
   `getSummarizationFailure`.** Cook records `Truncated` and still runs
   `compaction.complete`. Changing this needs its own matrix, not experiment
   v2. A truncated summary does not count as a clean checkpoint in scoring.

## 14. Unverified points

The following claims did not have enough evidence to state as facts:

- **Whether `AgentSession` defers between-step writes until a checkpoint.**
  `harness.md` says that for lanes. The README and `agent-session.ts` confirm
  that the CLI appends `context_edit` and does not change old entries. No
  `AgentSession` path was verified to show that every between-step write is
  deferred by the lane checkpoint mechanism.
- **Deferred requests from real providers.** At this revision,
  `fetchDeferred` under `packages/ai/src` is implemented only by
  `providers/faux.ts` (with `lazy.ts` / `models.ts` wrappers). The claim that
  “pi considered Batch API and chose background mode” came from a search
  summary pointing to PR #7339, not a direct review of that PR. Do not cite it
  as evidence.
- **Pi behavior when a provider omits usage.** No “incomplete” flag or
  equivalent was found. The observed fallbacks were in `faux` and experimental
  micro. Other provider paths were not ruled out.
- **Whether the harness path is intended to replace the CLI.** At the pinned
  revision, released `coding-agent` modes import the classic `Agent`. The
  migration intent is unknown, and `harness-v2.md` is absent from the pinned
  tree.

The comparison was source-checked at the pinned revision and updated to match:
the append-only rule is in `packages/agent/docs/harness.md` (not
`harness-v2.md`); `context_edit` is in the coding-agent README; and
`shouldCompact`, `completeSummarization`, `generateSummaryWithUsage`
(`floor(0.8 × reserveTokens)`), `getSummarizationFailure`, and
`serializeConversation` are in `compaction.ts` / `utils.ts`. `CH` is in
`footer.ts`, cache warming is in `cache-warmer.ts`, and `fetchDeferred` is only
in `faux.ts`. On the Cook side, the inspected paths were `prune_conversation`
and `keep_last_n_turns`, the 95% split in `two_pass.rs`, prefix alignment in
`session_compact.rs`, `Truncated` in `compaction.rs`, the next-offset marker in
`read_file/mod.rs`, and the `compaction_requests/{request_id}.json` artifact.
