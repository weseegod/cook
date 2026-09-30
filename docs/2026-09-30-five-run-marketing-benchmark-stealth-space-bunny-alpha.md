# Cook vs OpenCode vs Pi: Five-Run Hard-Suite Benchmark

**Run date:** 2026-09-30 · **Model:** `stealth/space-bunny-alpha` · **Cook build:** `1.1.3 (64cf2155419c)`

## Executive summary

Five sequential runs of the same four Hard-suite browser-app prompts produced 20 task attempts per agent. Under the static completion definition in this report, Cook passed **19/20 (95%)**, OpenCode **16/20 (80%)**, and Pi **14/20 (70%)**.

Across the 20 attempts, Cook used **70.7% fewer total processed tokens than OpenCode** when cache-read tokens are included. Excluding cache reads and counting uncached input plus generated output, Cook used **38.5% fewer tokens**. Cook's mean reported task wall time was **7m 26s**, compared with **12m 56s** for OpenCode. Pi's mean was **6m 04s**, but it passed fewer tasks than Cook.

These are benchmark completion and artifact results. The audit reports check process exit status, required file paths, and broken local HTML references; they do **not** execute the apps or verify all requested behaviors. Do not present these figures as a claim that 95% of the generated apps were functionally correct.

## Benchmark setup

The command was run five times, sequentially:

```sh
./scripts/evaluate.sh --model stealth/space-bunny-alpha --suite hard --parallel 3
```

The script defaults for this command were:

- Agents: Cook, OpenCode, and Pi.
- Thinking: enabled for the Hard suite.
- Shared concurrency limit: three agent harnesses.
- Per-agent timeout: 1,800 seconds (30 minutes).
- Identical four prompts in each run: Format Converter, Kanban Board, Flappy Bird, and Vector Flowchart Editor.

This yielded 20 attempts per agent, or 60 agent-task attempts total. The five suite runs took approximately **3h 55m** end to end. Individual suite durations were about 38m 26s, 44m 27s, 41m 37s, 49m 37s, and 1h 00m 24s.

### Completion definitions

- **Runner exit:** whether the agent process returned exit code `0`; timeout exits are failures for this measure.
- **Static artifact pass:** all prompt-required files were present and the static scan found no broken local HTML references.
- **Completed task (the pass rate used above):** both runner exit `0` and static artifact pass.

Extra files do not count as failures. Static artifact checks do not establish that JavaScript runs, UI controls work, or acceptance criteria are satisfied.

## Aggregate results

### Completion, calls, and time

| Agent | Completed tasks | Static artifact passes | Exit 0 | Timeouts | Model calls | Sum of task wall time | Mean task wall time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Cook | **19/20 (95%)** | 19/20 (95%) | 20/20 | 0 | 982 | 2h 28m 33s | **7m 26s** |
| OpenCode | 16/20 (80%) | 20/20 (100%) | 16/20 | 4 | 1,808 | 4h 18m 32s | 12m 56s |
| Pi | 14/20 (70%) | 16/20 (80%) | 18/20 | 2 | 614 | 2h 01m 10s | 6m 04s |

The sum of task wall times adds together individual task durations, even though tasks ran through a shared concurrent pool. It is useful for comparing these runs, but it is not the total time a user waits for one task. The suite wall time above is the end-to-end time for each complete three-agent run.

Compared with OpenCode, Cook had **20 percentage points higher** completion, **45.7% fewer model calls**, and **42.5% lower summed task wall time** in this benchmark. Pi had shorter task wall time than Cook, partly because some tasks produced incomplete output or timed out.

### Token accounting

| Agent | Uncached input | Cache read | Output | Total processed tokens | Uncached input + output | Cache-read share of input |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cook | 644,357 | 36,627,382 | 700,991 | **37,972,730** | **1,345,348** | 98.27% |
| OpenCode | 1,015,652 | 127,401,522 | 1,170,683 | **129,587,857** | **2,186,335** | 99.21% |
| Pi | 739,098 | 20,418,069 | 611,276 | **21,768,443** | **1,350,374** | 96.51% |

`Total processed tokens` is `uncached input + cache read + output`. The audit reports zero cache-write tokens for all three agents. `Uncached input` is the input not reported as a cache read; cache accounting and billing are provider-specific. Cache-read tokens still count as processed tokens, but they should not be treated as equal to uncached tokens for a cost estimate. Therefore, the 70.7% token-volume reduction versus OpenCode is **not** a claim of 70.7% lower API cost.

Across the five individual runs, Cook's total token volume was lower than OpenCode's in every run. The per-run reduction ranged from approximately **59% to 81%**; the aggregate reduction was **70.7%**. On uncached input plus output, the aggregate reduction was **38.5%**.

Versus Pi, Cook used more total processed tokens (**37.97M vs 21.77M**) but nearly the same uncached-input-plus-output volume (**1.345M vs 1.350M**) while passing five more task attempts (**19 vs 14**). That is a more useful comparison than describing Cook as universally more token-efficient than Pi.

## Results by run

Completion cells show `completed tasks / 4`, using the definition above. Token values are total processed tokens, including cache reads.

| Run | Suite wall time | Cook | OpenCode | Pi | Audit report |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 38m 26s | 4/4 · 4.84M | 4/4 · 25.29M | 2/4 · 0.35M | [Run 1](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T040408Z/report.md) |
| 2 | 44m 27s | 4/4 · 8.53M | 3/4 · 20.96M | 3/4 · 0.87M | [Run 2](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T044234Z/report.md) |
| 3 | 41m 37s | 4/4 · 5.65M | 3/4 · 22.28M | 3/4 · 1.86M | [Run 3](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T052701Z/report.md) |
| 4 | 49m 37s | 3/4 · 6.89M | 3/4 · 30.62M | 3/4 · 7.24M | [Run 4](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T060838Z/report.md) |
| 5 | 1h 00m 24s | 4/4 · 12.07M | 3/4 · 30.43M | 3/4 · 11.44M | [Run 5](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T065815Z/report.md) |

## Results by task

Token totals and task wall time below are summed across the five repeats. Task wall time is not suite wall time.

| Task | Agent | Completed | Model calls | Total tokens | Sum of task wall time |
| --- | --- | ---: | ---: | ---: | ---: |
| Format Converter | Cook | 5/5 | 96 | 1.94M | 10m 31s |
|  | OpenCode | 5/5 | 96 | 2.13M | 15m 21s |
|  | Pi | 5/5 | 48 | 0.46M | 6m 36s |
| Kanban Board | Cook | 5/5 | 197 | 5.29M | 29m 15s |
|  | OpenCode | 5/5 | 291 | 12.01M | 38m 42s |
|  | Pi | 5/5 | 164 | 4.00M | 26m 53s |
| Flappy Bird | Cook | 5/5 | 306 | 11.18M | 47m 24s |
|  | OpenCode | 5/5 | 506 | 22.69M | 56m 23s |
|  | Pi | 3/5 | 114 | 2.79M | 16m 20s |
| Vector Flowchart Editor | Cook | 4/5 | 383 | 19.56M | 1h 01m 23s |
|  | OpenCode | 1/5 | 915 | 92.76M | 2h 28m 06s |
|  | Pi | 1/5 | 288 | 14.52M | 1h 11m 21s |

The Vector prompt accounts for most of the separation in completion and token totals:

- Cook passed the static completion definition in four of five Vector attempts. In run 4, the process exited `0` but the output lacked `js/canvas.js`, `js/export.js`, and `js/app.js`, and `index.html` referenced those missing files.
- OpenCode produced all required Vector file paths in all five attempts, but timed out in four. Only one attempt both completed before timeout and passed the static check.
- Pi passed the Vector static completion definition once. Two other attempts timed out despite having the required paths; two attempts had missing files.
- All three agents passed the Format Converter and Kanban Board checks in all five runs. Cook also passed all five Flappy Bird checks. Pi missed the Flappy files in two runs.

## Marketing use

### Suggested benchmark claim

> Across five repeated runs of a four-task browser-app benchmark, Cook completed 19 of 20 task attempts (95%) under a 30-minute per-agent limit, compared with 16 of 20 for OpenCode and 14 of 20 for Pi. Cook processed 70.7% fewer total tokens than OpenCode in this benchmark, including cache-read tokens.

### Required qualification

Define “completed” as a successful process exit plus the required-file and static local-reference checks. State the model and benchmark scope. The results support a benchmark-scoped claim about task completion and token volume; they do not prove general app quality or API-cost savings. For cost claims, apply the provider's uncached-input, cache-read, and output prices to the raw token categories.

The user manually reported that Cook apps worked in a separate earlier audit. This five-run batch did not run behavioral tests on its generated apps, and one Cook Vector output here was incomplete. Do not use this batch alone to claim that every generated app works.

## Audit report links

- [Run 1 detailed report](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T040408Z/report.md)
- [Run 2 detailed report](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T044234Z/report.md)
- [Run 3 detailed report](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T052701Z/report.md)
- [Run 4 detailed report](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T060838Z/report.md)
- [Run 5 detailed report](audits/2026-09-30-agent-compare-stealth-space-bunny-alpha-hard-20260930T065815Z/report.md)
