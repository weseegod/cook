# SWE-bench comparison

This runner selects one SWE-bench Verified instance per level and gives the same
four issues and base checkouts to Cook, OpenCode, and Pi. Levels are quartiles of
`(gold patch file count, patch length, instance ID)`, not measured solve rates.
`levels.json` pins the dataset revision; runs never rebuild the quartiles.

```bash
python3 -m venv temp/swe-bench/venv
temp/swe-bench/venv/bin/pip install -r scripts/swe-bench/requirements.txt
scripts/swe-bench/run.sh --dry-run --seed 1

SWE_PYTHON="$PWD/temp/swe-bench/venv/bin/python" EVAL_PARALLEL_SLOTS=3 \
  scripts/swe-bench/run.sh --model stealth/space-bunny-alpha \
  --seed 1 --parallel 3 --no-grade
```

Model resolution, credentials, agent configuration, and API overrides come from
`scripts/evaluate/model.sh` and `scripts/evaluate/agent.sh`. The default timeout
is 600 seconds for easy, 1200 for medium, 2400 for hard, and 3600 for very-hard.
`--timeout` changes the easy-task budget (minimum 600 seconds); other levels
receive 2, 4, and 6 times that budget. Each agent gets the same budget for a level.
`--parallel` defaults to 1,
has a ceiling of 3, and must fit `model_parallel_slots`. Agent exit 124 means
its timeout expired. Smoke results labelled `not graded` do not establish that
an issue was resolved.

For grading, use the pinned SWE-bench CLI and a clean checkout of
[SWE-bench/swe-bench-tasks](https://github.com/SWE-bench/swe-bench-tasks) at your
chosen commit. Validate Docker before a long run:

```bash
temp/swe-bench/venv/bin/swebench eval verified --gold \
  -i sympy__sympy-20590 --task-repo /path/to/swe-bench-tasks

SWE_PYTHON="$PWD/temp/swe-bench/venv/bin/python" \
SWE_BIN="$PWD/temp/swe-bench/venv/bin/swebench" \
  scripts/swe-bench/run.sh --model stealth/space-bunny-alpha \
  --seed 1 --task-repo /path/to/swe-bench-tasks
```

Bundles live under `docs/audits/` with mode 700. They contain the selection,
exact prompts, agent artifacts, patches, predictions, configuration, and a
comparison report. Graded runs also retain grader logs and the task repo commit.
Each agent gets a unique run ID; empty patches skip Docker. Upstream mirrors
live under `temp/swe-bench/mirrors/`; local clones hardlink objects without using
`--shared`. Working trees still consume disk space.

Offline checks:

```bash
bash scripts/evaluate/agent.sh --self-test
python3 scripts/swe-bench/suite.py --self-test
python3 scripts/evaluate/summarize.py --self-test
bash -n scripts/evaluate.sh scripts/evaluate/agent.sh scripts/swe-bench/run.sh
MODEL_SH=/bin/false scripts/swe-bench/run.sh --dry-run --seed 1
```

Rebuilding the checked-in levels requires `datasets` and network access:

```bash
temp/swe-bench/venv/bin/python scripts/swe-bench/suite.py build-levels
```
