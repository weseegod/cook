# Core agent token optimization, experiment v4

Date: **2026-09-28**.

Core design: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md). What v2 shipped and measured: [core-agent-token-optimization-experiment-v2.md](core-agent-token-optimization-experiment-v2.md). What v3 shipped: [core-agent-token-optimization-experiment-v3.md](core-agent-token-optimization-experiment-v3.md).

Audits this file follows:

- [spark25-4b-061517](audits/2026-09-27-agent-compare-spark25-4b-061517.md)
- [stealth easy 004852](audits/2026-09-28-agent-compare-stealth-space-bunny-alpha-004852.md)
- [stealth medium 005554](audits/2026-09-28-agent-compare-stealth-space-bunny-alpha-005554.md)
- [Minesweeper](audits/2026-09-28-agent-compare-stealth-space-bunny-alpha.md)
- [Kanban 013111](audits/2026-09-28-agent-compare-stealth-space-bunny-alpha-013111.md)
- [calendar 020424](audits/2026-09-28-agent-compare-stealth-space-bunny-alpha-020424.md)
- [finance 024232](audits/2026-09-28-agent-compare-stealth-space-bunny-alpha-024232.md)
- [batch summary](audits/2026-09-28-agent-compare-stealth-space-bunny-alpha-batch-summary.md)

This document is the follow-up to those `scripts/evaluate.sh` runs of cook, opencode, and pi. Cook’s written files were often on disk when the process exited 1, and cache read was high on the runs that finished many rounds. v4 records why, corrects the design sentences v3 left stale, and sequences the next measured changes. It does not copy v2’s token tables. Phase 1 is the design-doc correction in the same change as this file. Phases 2 and 3 were implemented after that correction.

Task correctness is the gate. A shorter prompt, a raised byte ceiling, or an exit code flipped because some file exists is a failed phase.

## 1. Recommendation

Correct the stale design sentences and record the audit mechanisms in section 8.5 of the design doc. Do not change pruning defaults, the 32×1024 ceiling, catalog size, side-call gates, or the evaluate exit code in that same edit.

Product work, in order, and only as its own phase:

1. An oversized tool-call argument becomes a model-visible error, and the attempt is not ended as a fatal ACP internal error.
2. The evaluate report lists regular files in the workdir and, when `stdout.json` has no usage, reads the session `usage.json` without inventing zeros. Process exit stays the process exit.
3. Confirm which runtime flag produced the 15-second background on the medium transcript before any wait change. Phase 4 records the resolved flag below.

A catalog cut of about 1–2k, a compaction-policy change, and side-call gates stay later. They are not opened in this file. Named skills still have to surface. The exit-0 audits still have to pass. Estimated tool-schema tokens on the medium run were 475,107 against 1,092,279 main-loop cache-read tokens, so schema size is not that gap. Reminders are 118 tokens per measured request. The session-title call is one stealth request and 140 cache-read tokens.

## 2. What the audits show

Cells are cook / opencode / pi, taken from the linked reports. Spark is local `spark25-4b`. The other rows are OpenRouter `stealth/space-bunny-alpha` with thinking on. The same table is section 8.5 of the design doc.

| Run | Task | Exit | Reported files | Model calls | Cache read |
|---|---|---|---|---|---|
| spark25-4b-061517 | spark | 0/0/0 | 3/3/3 | 6/13/7 | 94,339 / 243,670 / 115,083 |
| 004852 | stealth easy | 0/0/0 | 1/1/2 | 36/20/9 | 865,273 / 248,014 / 59,820 |
| 005554 | stealth medium | 0/0/0 | 3/3/3 | 43/42/5 | 1,092,279 / 863,626 / 21,665 |
| Minesweeper | minesweeper | 1/0/0 | 0/4/0 | unreported / 54 / 2 | unreported / 1,569,236 / 1,961 |
| 013111 | stealth Kanban | 0/0/0 | 3/3/3 | 27/138/30 | 684,584 / 7,982,825 / 587,792 |
| 020424 | calendar | 1/0/0 | 2/3/3 | 4/103/71 | 46,406 / 7,352,358 / 4,168,712 |
| 024232 | finance dashboard | 1/0/0 | 3/3/3 | 80/39/65 | 3,641,362 / 1,178,556 / 4,992,086 |

An earlier extraction left calendar’s opencode and pi cache-read cells blank and left finance out of a six-row table. The audit files have both. Finance is `temp/evaluate/20260928T020433Z`.

**Per-call argument ceiling.** `DEFAULT_MAX_PER_CALL_ARGUMENT_BYTES` is `32 * 1024` in `crates/codegen/xai-grok-sampler/src/stream/tool_call_budget.rs`. `guard_tool_call_budget` ends the attempt on the first breach. `SamplingError::ToolCallBudgetExceeded` is fatal in `crates/codegen/xai-grok-sampler/src/retry.rs`. At audit time, the shell persisted that ACP internal error and did not read the workdir. Calendar buffered 32,828 argument bytes and exited 1 with `index.html` and `style.css` on disk and `app.js` absent. The four model calls are that stopped attempt.

**Turn limit.** Minesweeper (`temp/evaluate/20260928T005604Z`) and finance both cancelled with category `max_turns_reached` after 80 main-loop calls, the evaluate `--max-turns` limit. Finance `stderr.log` is `Error: max turns reached`, and `events.jsonl` records `cancellation_context.reason = max_turns_reached` with `limit: 80`. Both workdirs contain `index.html`, `style.css`, and `app.js`. Headless exit follows the cancellation. A directory listing is not an exit code.

**Summarizer.** At audit time, `scripts/evaluate/summarize.py` read Cook usage from `stdout.json` (`num_turns`, `usage`) and counted files with `git ls-files --cached --others --exclude-standard`. Minesweeper Cook `stdout.json` is absent, so those cells stay `unreported`. That workdir has no `.git`, and the parent repo gitignores `/temp/`, so the report’s file count is 0 while the three files exist. Whether `.git` was already missing when summarize ran is not logged. Finance did have stdout usage and git-visible files, and it still exited 1. Do not fill an absent field with zero.

**Single-turn retention.** Pruning runs only when tracked tokens exceed half the context window. `keep_last_n_turns` defaults to 3. Step-round pruning defaults to 0. Auto-compact is 85%. Stealth windows on these runs are 300,000 and spark is 81,920, so neither threshold fired. Later samples resend the transcript. On the medium run the re-sent assistant text and tool results were 293,461 and 101,137 tokens. Pi compacts only above the window minus 16,384, so the same short sessions stay uncompacted there too. Measured Cook usage files show compaction meta at zero and no compact purpose. The gap is extra rounds over a retained transcript.

**Foreground shell.** `FOREGROUND_BLOCK_BUDGET` is 15 seconds in `crates/codegen/xai-grok-tools/src/computer/local/terminal.rs`. A foreground command still running at that limit returns a task id, and the next sample collects it with `get_command_or_subagent_output`. The medium transcript shows a Playwright command moved to the background at that limit. `BashParams::default` sets `auto_background_on_timeout` to false, but `BashToolConfig::to_bash_params_json` resolves the session setting from local config, remote settings, then `true`. The 15-second behavior is the rendered tool schema, the constant, and the session tool result. Phase 4 names the resolved flag and its evidence below.

**What is too small to be the gap.** Injected reminders are 118 tokens per measured request. System tokens per measured request are 2,190. Session title adds one stealth call and 140 cache-read tokens, is absent on the spark success, and sits outside the audit’s model-call column. On one no-tool local session, system prompt plus tool schemas were 12,270 of 15,671 billed input tokens, and schemas alone were 10,956. That is one session and a shape, not a constant. Component buckets are bytes/4 estimates and do not sum to billed input. Compaction, recap, memory, and other side calls fold usage without composition, because components are recorded for main-loop calls only.

No report defines a composite winner. File count is not behavior. Pi’s easy run also wrote `test.js`. OpenCode’s Minesweeper run also wrote `test.headless.js`. Pi’s Minesweeper exit 0 recorded 0 files. Cook is not the high cell on every exit-0 row. Spark, medium, and Kanban are finish-and-file ties. Pi is lower on uncached input and cache read on the runs where all three columns exist. Cook is lower on output tokens and model calls on some of those runs.

## 3. What stays as it is

- The `model → tools → model` loop.
- v2 phases 1–7 and v3 phases 1–4. Pins stay opt-in. `read_file_max_output_bytes` stays at default `0`. Identical-call stationarity stays at the v3 constants. `supports_batch_api` stays off the coding loop.
- `DEFAULT_MAX_PER_CALL_ARGUMENT_BYTES = 32 * 1024` until phase 2’s pass bar. Phase 2 does not raise it.
- The prune gate at half the window, `keep_last_n_turns = 3`, step-round pruning off, and auto-compact at 85%.
- `FOREGROUND_BLOCK_BUDGET` at 15 seconds. Phase 4 names the flag; no wait change is included.
- Evaluate process exit. A workdir that contains `index.html` does not become exit 0. Calendar was missing `app.js`. Finance had all three files and still exited 1.
- Section 6.6 of the design doc.
- The per-model context window. No Batch API on the coding loop.

## 4. Phase 1 — correct the design doc

Edit [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md) only:

- Section 1 priority 5 names `uncachedInputTokens` and `cacheFieldPresent` as shipped in v2 phase 4. A missing cache field stays absent.
- Section 3.7 records the 32×1024 ceiling and `max_turns_reached` as turn failures persisted without a workdir check.
- Section 4’s read-file row matches v3 section 3: the default 1,000-line clip does not print `rerun with offset`. New rows cover the per-call argument budget and the 15-second foreground block. The pruning and auto-compact rows say that one user turn under those thresholds resends its transcript.
- Section 5.2 gains the single-turn retention finding, the budget-stop finding, and the git-visible file-count finding.
- Section 6.2 no longer says the line cap already names the next offset. Section 6.6 is not edited.
- Section 7’s P0 cell no longer calls hit versus miss remaining work. The recommended order points here for the next phases.
- Section 8.5 is the audit table and the non-claims.
- Section 11 no longer says hit versus miss is unreported. The closing decision keeps v2’s opt-in defaults and accepts the next change only when its phase here passes.

Pass: those sentences match this file’s table; section 6.6 still begins `The shipped loop stop is grok-build's identical-call stationarity`; v2 and v3 are untouched. No model run.

**Result (2026-09-28).** The design doc now has those corrections, including section 8.5. The table there matches the table in section 2, calendar cache read included for all three agents, and finance `024232` included as the published report of `20260928T020433Z`. Section 6.6 was not edited.

## 5. Phase 2 — budget error stays inside the turn

Before this phase, `guard_tool_call_budget` ended the attempt; `SamplingError::ToolCallBudgetExceeded` was fatal in `retry.rs`; the shell persisted the ACP internal error and did not inspect the workdir. The sampler still stops the oversized attempt and retains the same byte ceiling. The shell now treats that failure as a recoverable step: it marks the missing sample usage as incomplete, puts the byte-count diagnostic and split-write instruction into the model's next request, and stays in the current turn. It permits three such recoveries. A final model answer without a later successfully executed tool call remains a non-zero turn error.

Pass, before any live replay:

- A unit stream of one call whose arguments exceed 32,768 bytes (the calendar case was 32,828) does not finish the turn as a fatal internal error.
- The model-visible result contains the budget message and tells the model to split the write.
- A later tool call in that same turn still runs.
- The ceiling constant is unchanged.
- Headless still exits non-zero when the turn has no further successful call and the requested file is absent. Calendar missing `app.js` must not become a pass by ignoring the missing file.

A spark25 calendar replay is recorded when it is run. A model that still fails to write `app.js` is a failed cell, not a reason to raise the ceiling. Do not combine this phase with the summarizer change.

**Result (2026-09-28).** The `32 * 1024` constant is unchanged. `cargo check -p xai-grok-shell -p xai-grok-sampler` passed. The sampler unit stream with a 32,828-byte call passed, and the shell recovery tests passed for feedback, requiring a later successful tool call, and stopping after three breaches. `cargo test -p xai-grok-shell --features test-support --test tool_call_budget_recovery` passed both mock-API ACP cases: an oversized `write` produced model-visible byte and split-write feedback, followed by a smaller `write` that created `app.js` in the same turn; an oversized `write` followed only by final text returned a turn error and left `app.js` absent. No live calendar replay was run because this host has neither the `spark25-4b` launcher nor `llama-server`. The replay cell remains unreported.

## 6. Phase 3 — evaluate report separates exit from files

Implemented in `scripts/evaluate/summarize.py`.

- `files_and_bytes` walks the workdir for regular files. It does not use `git ls-files`. It skips `.git` and `node_modules`. The report footer stops saying the count is git-visible once that is true.
- `usage_cook` keeps reading `stdout.json`. When `num_turns` or `usage` is absent, it may read the session `usage.json` and label that source. Absent fields stay `unreported`. A missing `stdout.json`, as on Minesweeper now, stays unreported.
- `exit-code.txt` is still the Exit column. A non-empty file list does not change the exit code. Finance already shows three files and exit 1. That pair stays.

Pass: a fixture workdir with no `.git`, containing `index.html`, `style.css`, and `app.js`, under a parent that gitignores the directory, reports 3 files. A fixture with usage only in session `usage.json` reports those numbers and names the source. A fixture with neither stdout usage nor session usage stays `unreported`, not 0. Existing `self_test` expectations that pin git behavior are updated in this phase. No agent binary change.

**Result (2026-09-28).** `python3 scripts/evaluate/summarize.py --self-test` passed with an ignored workdir containing three app files, usage only in the session file, absent usage, and Exit 1 beside three files. The footer now describes regular files, and a `Usage source` column distinguishes `stdout.json`, session fallback, and `unreported`. On the retained runs, Minesweeper now counts three files while its missing `stdout.json` leaves usage unreported and Exit 1; finance remains three files and Exit 1. The fallback uses `purposeUsage.main_loop` to avoid including the session-title side call, and preserves an absent cache field.

## 7. Phase 4 — name the 15-second shell flag

Completed as an audit. No constant change in this phase.

Read the medium Cook transcript and the tool schema that session was sent. Write into this file which flag caused the Playwright command to background at about 15 seconds. The candidates already separated are `FOREGROUND_BLOCK_BUDGET`, the rendered schema, and `BashParams::default.auto_background_on_timeout = false`. The result paragraph names the one the session used, or says the assignment was not found.

Changing the wait, or setting `GROK_FOREGROUND_BLOCK_BUDGET_MS` for the harness, is a later file. It opens only if this paragraph names the flag and a replay of the medium task still writes the same three files.

**Result (2026-09-28).** The resolved switch was `auto_background_on_timeout = true`, with background execution enabled and no short-budget override in the eval's local `config.toml`. The non-test assignment is [`BashToolConfig::to_bash_params_json`](../crates/codegen/xai-grok-shell/src/tools/config.rs): local `toolset.bash` value, then remote value, then `true`; [`agent_ops.rs`](../crates/codegen/xai-grok-shell/src/agent/mvp_agent/agent_ops.rs) supplies that map to the tool config. The retained `tool_definitions.json` for `temp/evaluate/20260928T004858Z` renders the `run_terminal_command` description with the 15-second auto-background rule, proving the session's effective setting even though the specific remote/default source is not persisted. In `chat_history.jsonl`, the first Playwright `run_terminal_command` has `timeout: 180000` and no `background` field; its tool result reports automatic backgrounding after 15s and returns task id `5bf5d4a0-f9cc-4570-9c53-dd18da9be3ea`. `BashParams::default = false` did not govern that resolved tool. The terminal's `FOREGROUND_BLOCK_BUDGET` supplied the 15-second deadline after the flag enabled this behavior. No medium replay was run, so the later wait-change gate remains closed.

## 8. What is deliberately not a phase

- Raising `32 * 1024` so the calendar call fits.
- Setting exit 0 because any requested file exists.
- Raising evaluate `--max-turns` so Minesweeper’s or finance’s 80th call becomes a pass.
- A marker on the default 1,000-line clip, or a computed next offset on `FileTooLarge`.
- Flipping the half-window prune gate, `keep_last_n_turns`, step-round pruning, or the 85% auto-compact default.
- A catalog cut, including a cut to four tools. A 1–2k cut waits until named skills still surface, and it is not opened here. Hiding a needed skill is a quality failure.
- Disabling two-pass prefire, verbatim compaction input, or side calls. Reminders are 118 tokens. The session-title call is not the gap.
- Treating tool schemas as most of medium cache read. 475,107 estimated schema tokens against 1,092,279 cache-read tokens.
- Filling Minesweeper’s blank Cook usage with zero.
- A cache-warm `maxTokens: 1` call, or Batch API on the coding loop.
- Editing section 6.6, v2, v3, or `UPSTREAM-MERGE.md`.

## 9. Commit rule

One phase, one commit, on `experiment/core-agent-token-optimization`, when that work starts. The original docs change is phase 1. Phase 2 is the budget-recovery change, phase 3 is the evaluate summary change, and phase 4 is the shell-flag audit. If a later pass bar fails, revert that phase. Silence is not a pass. Do not copy another phase’s numbers forward.
