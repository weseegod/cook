# Core agent token optimization, experiment v3

Date: **2026-09-25**.

Upstream pin: `xai-org/grok-build` `upstream/main` at `f0e3be11` (`Synced from monorepo`). Fork base: this repo's `main` at `00262d8a`.

Core design, which stays: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md). What v2 already shipped and measured: [core-agent-token-optimization-experiment-v2.md](core-agent-token-optimization-experiment-v2.md). The 2026-09-24 suite notes stay where they are, as history: [audits/2026-09-24-core-agent-flow-and-safeguards.md](audits/2026-09-24-core-agent-flow-and-safeguards.md) and [real-model-suite-run-order.md](real-model-suite-run-order.md).

This document is the best-practice follow-up after the real-model suite. The suite produced scores. It also surfaced three problems: a large file the agent does not finish, the fork-only 16-round read-only stop that tells the user the agent stopped mid-walk, and other safeguard stops that end a turn without saying why. That stop and those extra guards are fork additions. grok-build already continues a large file with `offset` and `limit`, and it already stops a loop only when the same call repeats. v3 uses those paths. It does not add a reader, a stop, or a truncation style.

No phase below has been executed. v2's token tables are not copied here. Task correctness is the gate. A change that drops the file, the failure, or the edit is a failed phase.

## 1. Recommendation

Use grok-build's read recipe and grok-build's identical-call stationarity. Delete the four fork-only stops in `crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs`. Do not replace the round counter with a larger number, and do not invent a fingerprint stop to stand in for it.

The core design file stays the design. Section 6.6 of that file currently invites a stationarity extension ("same path / range / hash"). The 16-round counter is what that sentence became, and the counter does not implement it. Phase 4 below replaces that paragraph. The rest of the design stays: opt-in pruning, no Batch API on the coding loop, do not lower the read caps, do not copy another harness's 50KB or 2,000-line numbers.

v2's opt-in token work stays as it shipped. Pins, `read_file_max_output_bytes` default `0`, the hit/miss ledger, and `supports_batch_api` kept off the coding loop are not these stops. This plan does not re-run those phases and does not turn those knobs on.

Code phases, when they run, start from `00262d8a` on `experiment/core-agent-token-optimization` after that branch is based on this `main`. One phase, one commit. Each commit can be reverted without touching the upstream import. This document does not rebase or delete code.

## 2. What grok-build already does

Checked on `upstream/main` at `f0e3be11`. The same read constants and the same identical-call thresholds are on this fork. The rows in the last column are not.

| What showed up | grok-build | This fork, and only this fork |
|---|---|---|
| A large file | `read_file` caps a window at `MAX_LINES_READ = 1000` lines and refuses a window over `READ_FILE_MAX_TOKENS = 25000` estimated tokens. The tool description says the default read is up to `{max_lines_read}` lines. The `offset` and `limit` schema text says to pass them when the file is too large to read at once. See section 3 for the four cases. | `split_trailing_continuation_marker` in `read_file/mod.rs`, so a hashline reformat can keep a marker that `run_read_file` already attached. It does not create a new notice. `ReadOnlyExplorationRun` then cuts the walk off at 16 rounds, so the model often never gets to use `offset`. |
| The fork-only 16-round read-only stop | The string is absent. `ReadOnlyExplorationRun` is absent. Distinct reads, searches, and lists do not end the turn. | `MAX_CONSECUTIVE_READ_ONLY_ROUNDS = 16`. Read, search, list, web, lsp, and a shell that is only `git log` or `rg` all increment it. Different paths and offsets still count (`differing_read_arguments_still_accumulate`). An edit is the only reset. There is no nudge. Round 16 sends the 16-round stop message and returns `TurnOutcome::StationarityEnded`. The unit test `multi_file_corpus_reads_do_not_stop_early` only protects 13 rounds (one list plus 12 files). |
| A repeated identical call | Identical-call stationarity, already the product behavior. Nudge after `NUDGE_AFTER_IDENTICAL_PROBLEMATIC_TOOL_CALLS = 4` for `Read` and `Plan`, or after `NUDGE_AFTER_IDENTICAL_TOOL_CALLS = 8` for anything else. Halt at `MAX_CONSECUTIVE_IDENTICAL_PROBLEMATIC_TOOL_CALLS = 8` or `MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 12`. A `true` keepalive halts at `MAX_CONSECUTIVE_TRUE_NOOPS = 4` and is not nudged. The nudge text starts `You have called the same tool (`${{ tool_name }}`) with the exact same arguments ${{ run_len }} times in a row`. | Nothing extra is required. Keep these constants. |
| Other stops that look like an error | `StationarityEnded` exists for the identical-call halt. There is no terminal-fanout guard and no argument-error cycle stop. | `TerminalFanoutGuard`: more than `MAX_TERMINAL_CALLS_BEFORE_REMINDER = 4` terminal commands in one response, and none of them run. The reminder starts `Your last response proposed more than four terminal commands in parallel, so none were run.` `TerminalObservationRun` nudges, then stops, on repeated status checks. `ToolArgumentErrorRun` nudges at `NUDGE_AFTER_TOOL_ARGUMENT_ERROR_CYCLES = 2` and stops at `MAX_CONSECUTIVE_TOOL_ARGUMENT_ERROR_CYCLES = 4`. Those three return `StationarityEnded` with no sentence like the 16-round one, so the turn just ends. |
| Top-level `max_tokens` reported as an internal error | `LengthSalvage` in `acp_session_impl/length_salvage.rs`. | A classifier, `classify_top_level_max_tokens`, calls that salvage for a top-level stop and still fails a budgeted workflow child. About 71 lines. It does not define a second salvage policy. Keep it. |

`prompt_offload.rs` is on both trees. A user message bigger than one read is written to `prompts/prompt_{n}.txt`. The notice lists up to `MAX_NOTICE_WINDOWS = 6` concrete `offset`/`limit` pairs, then says to continue from the next listed line in windows of up to `{max_lines}` lines. That is the large-input path. It is not a second implementation of `read_file`.

## 3. How to read a large file

This is grok-build's recipe. Both trees already implement it. A prompt, a suite case, or a later phase uses this recipe. It does not grow a new one.

The default 1,000-line clip does not print `rerun with offset`. On both trees that sentence is appended only inside `apply_byte_budget`, and `apply_byte_budget` runs only when an opt-in byte budget is set (`read_file_max_output_bytes`, default `0`). A whole-file read of a long source file returns the first 1,000 lines and stops the window there. The next call passes `offset`. That is the designed way to continue, not a missing marker.

1. **The file is longer than 1,000 lines, and the lines are ordinary.** Call `read_file` with `offset` and `limit`. The description already says the default read is up to `{max_lines_read}` lines, and the schema says to pass `offset` and `limit` when the file is too large to read at once. `offset` is the 1-based line to start at. Walk forward by the window you asked for. `safeguard.large_read` already allows this: its prompt says that if there is no continuation notice, continue from the line after the last line shown. A 1,201-line file does not need a new marker to reach `-HEAD` and `-TAIL`.

2. **The window is still over 25,000 estimated tokens.** `run_read_file` returns `ReadFileOutput::FileTooLarge`. It does not compute a next offset. The text is the one grok-build ships. Braces below are the names the active tool registered (`offset` and `limit` on `read_file`; `grep` is the search tool). When the caller passed a range:

   ```text
   The requested line range ({offset}={off}, {limit}={lim}) contains {token_count} tokens, which exceeds the maximum allowed tokens (25000 tokens).
   Try a smaller `{limit}`, a different starting `{offset}`, or use the '{grep}' tool to search for specific content.
   ```

   When the caller did not, the message does not add the word "tool" after the search tool's name:

   ```text
   File content ({token_count} tokens) exceeds maximum allowed tokens (25000 tokens).
   Please use {offset} and {limit} parameters to read a shorter range, or use the '{grep}' to search for specific content.
   ```

   The next call uses a smaller `limit`, or grep. Do not teach the tool to invent the next offset. Design §6.2 and grok-build agree: this refusal stays a refusal.

3. **The requested read is a single very long line.** Line `offset` / `limit` cannot narrow it. The same `FileTooLarge` value adds the note grok-build already adds: use the execute tool (`jq`, `python3`, or `cut -c`). Do not add a character-window reader beside that note.

4. **The user's own message is bigger than one read.** This is not a source file the agent opened. `prompt_offload` writes the full message to `prompts/prompt_{n}.txt` and names the windows. Read only the listed lines. The inline excerpt is already in the message. Do not also dump the file through an unbounded `read_file`.

When a byte budget is configured and it binds, the existing marker is enough. `apply_byte_budget` keeps whole lines that fit and appends one line:

```text
... [<n> characters truncated; file has <total> total lines; showing lines <start>-<end>; rerun with offset=<next>] ...
```

The next call uses that `offset`. There is no second notice style, and no head-and-tail split for reads. Bash already keeps its own tail and a path to the full log. Leave that alone.

`read_file_max_output_bytes` stays at default `0`. Turning it on is a v2 knob, not a v3 phase.

One fork test asks for a marker the default clip does not print. `large_file_truncated_to_max_lines` in `grok_build_hashline/read_file.rs` asserts that a 2,000-line read with no `limit` contains `rerun with offset=1001`. Upstream hashline has no such assertion. `run_read_file` attaches that marker only from `apply_byte_budget`. Do not change `read_file` so this test goes green. If the test fails, change the test so it expects grok-build: no marker unless a byte budget is set.

## 4. What stays as it is

- The `model → tools → model` loop.
- Identical-call stationarity, at 4 / 8 nudge and 8 / 12 halt, and the true-noop halt at 4.
- `READ_FILE_MAX_TOKENS = 25000`, `MAX_LINES_READ = 1000`, `FileTooLarge`, and `apply_byte_budget`.
- `prompt_offload`, including `MAX_NOTICE_WINDOWS = 6`.
- The `classify_top_level_max_tokens` call into `LengthSalvage`. A budgeted workflow child stays an error.
- Pruning and `read_file_max_output_bytes` at their defaults (off / `0`).
- The coding loop on realtime chat or responses. `supports_batch_api` does not move it to `/v1/batches`.
- Suite `MAX_COMPLETION_TOKENS = 8192`. That is a completion budget, not a turn cap. Do not raise it to force a pass.
- Per-model context window.
- v2 phases 1–7, as historical results. Do not reopen them here.

## 5. Phase 1 — remove the four fork stops

Delete from `turn.rs`, and delete the tests that exist only to pin them:

- `ReadOnlyExplorationRun` and `MAX_CONSECUTIVE_READ_ONLY_ROUNDS`
- `TerminalFanoutGuard` and `MAX_TERMINAL_CALLS_BEFORE_REMINDER`
- `TerminalObservationRun`
- `ToolArgumentErrorRun` and its nudge / stop constants

After this phase a long read of distinct files, or of one file at new offsets, behaves like grok-build. It continues until the model edits, the model stops, the turn reaches its own turn cap, or one identical call repeats often enough for the upstream thresholds. Do not put a new counter in the hole.

Pass, before any suite re-score:

- A unit walk of 20 distinct `read_file` calls does not stop, and the 16-round stop message is gone from the product tree (`rg` finds no read-only-round stop string).
- The identical-call tests still halt a repeated `Read` at 8 and still nudge it at 4.
- `FileTooLarge` text is unchanged from section 3.
- `cargo test` for the touched `turn.rs` module is green, apart from the pre-existing shell failures already listed in the suite spec.

This phase does not edit `read_file`.

**Result (2026-09-25).** The four stops, their constants, helpers, loop branches, reminders, telemetry, and pinning tests are deleted from `turn.rs`. Identical-call stationarity is unchanged. The unit walk `twenty_distinct_read_file_calls_do_not_stop` feeds 20 distinct `read_file` calls (new paths and new offsets) through `IdenticalToolCallRun` and asserts no nudge and no halt. The nine `identical_tool_call_run_tests` are green, including nudge at 4 / 8 and halt at 8 / 12 and the true-noop halt at 4. `rg` finds no read-only-round stop string and none of the four fork identifiers in `crates/`. The phase-1 product diff is `turn.rs` only; `read_file` is untouched.

## 6. Phase 2 — confirm the read recipe, no product diff

No change to `read_file`, `prompt_offload`, or the caps. The work is to read the four cases in section 3 against the tree and record that they still match `upstream/main`.

Pass:

- `apply_byte_budget` is still the only writer of `rerun with offset` in `read_file/mod.rs`.
- `FileTooLarge` still does not name a computed next offset.
- `prompt_offload.rs` still lists at most six windows.
- The hashline test in section 3 either already matches that, or is updated to match it. Updating the test is allowed. Updating `run_read_file` to emit a new marker is not.

A model run is not required for this phase.

**Result (2026-09-25).** No product change. `apply_byte_budget` remains the only writer of the `rerun with offset` marker. `FileTooLarge` still names no computed next offset. `prompt_offload` still pins `MAX_NOTICE_WINDOWS = 6`. `large_file_truncated_to_max_lines` and the sibling `explicit_large_limit_capped_to_max_lines` now assert a `MAX_LINES_READ` clip with no continuation marker. The byte-budget tests (`max_output_bytes_truncates_to_whole_lines_with_marker`, `max_output_bytes_marker_uses_requested_offset_and_renamed_param`) still show `apply_byte_budget` writing the marker. Hashline (22) and `grok_build::read_file` (123) tests are green. The phase-2 diff is test-only.

## 7. Phase 3 — score the suite against grok-build

The safeguard cases were written while the fork stops existed. Two of them will force those stops back if they stay as they are.

| Case | What it encodes today | After phase 1 |
|---|---|---|
| `safeguard.offset_walk` | `max_tool_success` is 16, the same number as `MAX_CONSECUTIVE_READ_ONLY_ROUNDS`. The prompt walks `pages.txt` in 50-line pages with no edits. | Drop the ceiling of 16. Keep the real checks: the walk uses `read_file`, the file is unchanged, and the answer can be `DONE`. A walk that continues past 16 new offsets is a pass. A walk that stops because of the deleted sentence is a fail. |
| `safeguard.terminal_fanout` | The prompt asks for five terminal calls in one response (`cat`, `head`, `tail`, `wc`, `sha256sum`). That is the fork guard's trigger: more than four, and none run. The score checks `tool_called` and that the answer contains `real-model suite fixture`. It does not check for the reminder sentence. | Leave the score checks. Five parallel inspects of one file are allowed, which is grok-build. Do not add an oracle that the fanout reminder appeared. |
| `safeguard.identical_reread` | `min_tool_success` 4, `max_tool_success` 12, category `action_stationarity`, no edit. | Keep it. Those bounds are the upstream Read thresholds. Do not loosen the oracle when the model emits no `read_file` and stops on `max_tokens`. That cell stays a measurement gap, not a reason to add a stop. |
| `safeguard.large_read` | 1,201 lines, markers `-HEAD` and `-TAIL`, follow `rerun with offset=N` when the tool prints it, otherwise continue from the next line. | Keep it. It already matches section 3. It is not a demand that the default 1,000-line clip grow a marker. |

Re-score on spark25-4b with `scripts/real-model-suite/run-audit.sh` (safeguard, then session) into a fresh `OUT_ROOT`. One model on port 8080. The binary is `target/debug/xai-grok-pager` built from this phase's commit. Do not commit `OUT_ROOT`, wire logs, or a suite `config.toml` that contains an `api_key`.

Pass:

- The 16-round stop message appears in no case log.
- `safeguard.identical_reread` still stops inside 4–12 identical `read_file` calls with category `action_stationarity`, when the model actually emits that loop. A `max_tokens` stop with zero tool calls is recorded and is not "fixed" by a new guard.
- `safeguard.large_read` still reports both markers.
- Session stays at the checks it already has. A new failure is a failed phase, not a new stop.

The four tools flakes on mimo26-9b (`kill_and_wait`, `monitor_short`, `scheduler_roundtrip`, `search_replace`) stay on the suite handoff. They are not a v3 phase.

**Result (2026-09-25, spark25-4b on port 8080, `OUT_ROOT` under the goal scratch dir).** `safeguard.offset_walk` no longer has a 16-call ceiling and passed (`min_tool_success` 4, `read_file` walk, file unchanged). `safeguard.large_read` reported both `-HEAD` and `-TAIL`. `safeguard.terminal_fanout` kept its score checks and passed with five parallel inspects; no fanout-reminder oracle. `safeguard.identical_reread` scored `measured-nothing`: the model burned `max_tokens` after one successful `read_file` and never emitted the identical loop. That cell stays a measurement gap. `safeguard.pin_failure` failed `text_contains_marker`; it is not a v3 phase. The 16-round stop message appears in no case log.

Session first pass was 10/12. `session.compaction` then passed on retry (`compact_single` present, marker in text); the first attempt hit `max_tokens` before the answer. `session.streaming_json` scored `final record lacks marker` on every attempt: the model's answer is in `chat_history` and in the streaming `data` chunks, while the terminal `end` line's `text` is empty. That gap is in `xai-grok-pager` `headless.rs` `on_text_chunk` (`StreamingJson` emits `AgentMessage` without filling `text_buffer`), present before this experiment and outside v3's phases. `runner.isolated` failed while the work tree held the uncommitted phase 3/4 files.

## 8. Phase 4 — correct section 6.6 of the core design

Edit only that subsection of [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md). Replace the paragraph that begins `Extend stationarity beyond "same tool + args"` with:

> The shipped loop stop is grok-build's identical-call stationarity: the same tool and the same arguments, nudged at 4 (`Read` / `Plan`) or 8 (anything else), halted at 8 or 12, with a `true` keepalive halted at 4. A read of a different file, or of the same file at a new offset, is progress, and it must not end the turn. A fingerprint stop (same path, same range, same content hash, or the same failing test with no edit) is out of scope until grok-build ships one. Do not add a counter of read-only rounds in this fork.

Leave the following paragraph, about polling a live job, as it is. It already matches the upstream nudge, which tells the model to wait on the job instead of polling.

Pass: section 6.6 names the upstream constants and does not ask this fork to add a stationarity mechanism. No other section of the design doc changes in this phase.

## 9. What is deliberately not a phase

- A computed next offset on `FileTooLarge`.
- A marker on the default 1,000-line clip. The byte-budget marker already exists, and it stays opt-in.
- A head-and-tail shape for reads, or another harness's 50KB / 2,000-line caps.
- Raising 16 to a larger blind cap, or any replacement counter.
- A fingerprint / content-hash stationarity stop. That waits for grok-build.
- Loosening `safeguard.identical_reread`, or raising `MAX_COMPLETION_TOKENS` or `max_turns`, to turn a measurement gap into a pass.
- Flipping pruning defaults, disabling side calls, or moving the coding loop onto Batch API.
- Merging the experiment branch to `main` before that phase's pass bar holds.
- Editing `UPSTREAM-MERGE.md`. The upstream import stays the import. These phases only remove fork stops that grok-build does not have.

## 10. Commit rule

For each phase:

1. Implement only that phase, on `experiment/core-agent-token-optimization`, based on `00262d8a`.
2. Meet that phase's pass bar. Phase 2 has no product diff. Phase 3 is the suite re-score. Phase 4 is the one paragraph.
3. If the pass bar fails, revert the commit. Silence is not a pass.
4. If it passes, commit and append the result under that phase in this file. Do not copy another phase's numbers forward.

`main` stays at the imported tree until a later, explicit merge. Reverting a phase commit returns that phase's behavior without reverting the upstream import.
