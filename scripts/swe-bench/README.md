# SWE-bench comparison

This runner selects one SWE-bench Verified instance per level and gives the same
four issues and base checkouts to Cook, OpenCode, and Pi. Levels are quartiles of
`(gold patch file count, patch length, instance ID)`, not measured solve rates.
`levels.json` pins the dataset revision; runs never rebuild the quartiles.

```bash
python3 -m venv temp/swe-bench/venv
temp/swe-bench/venv/bin/pip install -r scripts/swe-bench/requirements.txt
scripts/swe-bench/run.sh --dry-run --seed 1
scripts/swe-bench/run.sh --model stealth/space-bunny-alpha --parallel 3 --seed 1
scripts/swe-bench/run.sh --model stealth/space-bunny-alpha --agents cook --parallel 3 --seeds 1,2,3,4,5,6,7,8,9,10 --grade true
scripts/swe-bench/run.sh --model deepseek/deepseek-v4.1-flash:relace --agents cook --parallel 3 --seeds 1-10 --grade true
scripts/swe-bench/run.sh --model local/spark25-4b --agents cook --parallel 1 --levels easy,medium --seeds 1-10 --grade true
```

`--model org/model:provider` pins OpenRouter routing to that provider only
(`provider.only=[provider]`, `allow_fallbacks=false`) through a local proxy in
`scripts/swe-bench/provider_pin_proxy.py`. OpenRouter's `:free`, `:nitro`, and
`:floor` suffixes are left on the wire model and are not treated as provider pins.
When
`:provider` is used and `EVAL_BASE_URL` is unset, the harness reads the
`openrouter` provider (or matching `[model.*]` entry) from `~/.cook/config.toml`.

`--seed N` selects one seed. `--seeds` accepts comma-separated integers and
ascending ranges such as `1-10`; each seed still selects one task per requested
level. `--levels easy,medium` (or any subset of `easy,medium,hard,very-hard`)
limits which difficulty quartiles run; default is all four. Seeds 1–10 reproduce
the task selections used in the existing ten-seed audits.

The local `temp/swe-bench/venv` is used automatically when present. Grading is
enabled by default; on first run, the task environments are cloned to
`temp/swe-bench/swe-bench-tasks`. Use `--no-grade` to collect patches without
running Docker tests, or pass `--grade false`. `--grade true` enables grading explicitly.
Model resolution, credentials, agent configuration, and
API overrides come from `scripts/evaluate/model.sh` and `scripts/evaluate/agent.sh`.
The default timeout is 900 seconds for easy, 1800 for medium, 3600 for hard,
and 5400 for very-hard.
`--timeout` changes the easy-task budget (minimum 600 seconds); other levels
receive 2, 4, and 6 times that budget. Each agent gets the same budget for a level.
`--parallel` defaults to 3 and has a ceiling of 3. One shared pool covers all
seed/level/agent tasks: each slot runs an agent, grades its patch immediately
with one grader worker, then takes the next queued task. With ten seeds and
Cook only, the 40 tasks share at most three slots. Seeds can overlap; there
is no barrier between seeds or a separate batch of grading after agent work.
Model slots also use this value unless `EVAL_PARALLEL_SLOTS` is set.
The grader rebuilds the selected images from the task repo for each agent, so
reusing a seed does not skip image builds. Agent exit 124 means
its timeout expired. Smoke results labelled `not graded` do not establish that
an issue was resolved.

The run records the task repo commit in its bundle. To use another clean checkout,
pass `--task-repo DIR`. Validate Docker before a long graded run:

```bash
temp/swe-bench/venv/bin/swebench eval verified --gold \
  -i sympy__sympy-20590 --task-repo temp/swe-bench/swe-bench-tasks
```

Bundles live under `docs/audits/` with mode 700. They contain the selection,
exact prompts, agent artifacts, patches, predictions, configuration, and a
root comparison index and one detailed `report.md` per level. Each seed writes
its `report.md` as soon as that seed's tasks finish; multi-seed runs add a root
aggregate `report.md` and `run-status.json` after the pool drains, with each
seed's artifacts under `seed-N/`. Detailed reports
include the complete problem statement, exit and wall time, token and tool
usage, changed-file counts and sizes, output speed, SWE-bench result, and
non-gating static artifact checks. Graded runs also retain grader logs and the task repo commit.
Each seed/task/agent gets a unique grader run ID; empty patches skip Docker. Upstream mirrors
live under `temp/swe-bench/mirrors/`; local clones hardlink objects without using
`--shared`. Working trees still consume disk space.

Offline checks:

```bash
bash scripts/evaluate/agent.sh --self-test
python3 scripts/swe-bench/suite.py --self-test
python3 scripts/swe-bench/provider_pin_proxy.py self-test
python3 scripts/swe-bench/test_runner.py
python3 scripts/evaluate/summarize.py --self-test
bash -n scripts/evaluate.sh scripts/evaluate/agent.sh scripts/swe-bench/run.sh
MODEL_SH=/bin/false scripts/swe-bench/run.sh --dry-run --seed 1
```

Rebuilding the checked-in levels requires `datasets` and network access:

```bash
temp/swe-bench/venv/bin/python scripts/swe-bench/suite.py build-levels
```
