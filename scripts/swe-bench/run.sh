#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat <<'EOF'
Usage: scripts/swe-bench/run.sh --model NAME [options]
Run one pinned SWE-bench Verified instance per level with each selected agent.
--model NAME       same model configuration as scripts/evaluate.sh
--seed N           reproducible selection (default: 1)
--agents LIST      cook,cook-main,opencode,pi (default: cook,opencode,pi)
--timeout SECONDS  easy-task time budget, minimum 600 (default: 600);
                   medium=2x, hard=4x, very-hard=6x for every agent
--thinking BOOL    reasoning enabled (default: true)
--parallel N       shared pool, 1 to 3 (default: 1); uses N model slots unless
                   EVAL_PARALLEL_SLOTS is set
--output-root DIR  bundle parent (default: docs/audits)
--dry-run          print four IDs without starting a model or loading datasets
--no-grade         skip Docker grading; grading is enabled by default
--task-repo DIR    clean swe-bench-tasks checkout (default: temp/swe-bench/swe-bench-tasks)

The local temp/swe-bench/venv is used when present. The task repo is cloned
automatically when missing. Before a long graded run, validate Docker yourself:
  temp/swe-bench/venv/bin/swebench eval verified --gold -i sympy__sympy-20590 \
    --task-repo temp/swe-bench/swe-bench-tasks
API overrides: EVAL_BASE_URL, EVAL_API_KEY, EVAL_CONTEXT_WINDOW, EVAL_PARALLEL_SLOTS.
EOF
}
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
if [[ -z "${SWE_PYTHON:-}" && -x "$ROOT/temp/swe-bench/venv/bin/python" ]]; then
  PYTHON="$ROOT/temp/swe-bench/venv/bin/python"
else
  PYTHON=${SWE_PYTHON:-python3}
fi
if [[ -z "${SWE_BIN:-}" && -x "$ROOT/temp/swe-bench/venv/bin/swebench" ]]; then
  SWE_BIN="$ROOT/temp/swe-bench/venv/bin/swebench"
else
  SWE_BIN=${SWE_BIN:-swebench}
fi
SUITE="$ROOT/scripts/swe-bench/suite.py"
MODEL= SEED=1 TIMEOUT=600 AGENTS=cook,opencode,pi THINKING=true PARALLEL=1 OUTPUT_ROOT="$ROOT/docs/audits" DRY_RUN=false NO_GRADE=false TASK_REPO=${SWE_TASK_REPO:-"$ROOT/temp/swe-bench/swe-bench-tasks"}
while (($#)); do
  case "$1" in
    --model|--seed|--timeout|--agents|--thinking|--parallel|--output-root|--task-repo)
      (($# >= 2)) || { echo "missing value for $1" >&2; exit 2; }
      case "$1" in
        --model) MODEL=$2 ;; --seed) SEED=$2 ;; --timeout) TIMEOUT=$2 ;;
        --agents) AGENTS=$2 ;; --thinking) THINKING=$2 ;; --parallel) PARALLEL=$2 ;;
        --output-root) OUTPUT_ROOT=$2 ;; --task-repo) TASK_REPO=$2 ;;
      esac
      shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;; --no-grade) NO_GRADE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$SEED" =~ ^-?[0-9]+$ ]] || { echo 'seed must be an integer' >&2; exit 2; }
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo 'timeout must be positive' >&2; exit 2; }
(( TIMEOUT >= 600 && TIMEOUT <= 2147483647 / 6 )) || { echo '--timeout must be at least 600 seconds and fit the level multipliers' >&2; exit 2; }
[[ "$PARALLEL" =~ ^[1-3]$ ]] || { echo 'parallel must be 1, 2, or 3' >&2; exit 2; }
[[ "$THINKING" == true || "$THINKING" == false ]] || { echo 'thinking must be true or false' >&2; exit 2; }
AGENTS=${AGENTS//[[:space:]]/}
[[ -n "$AGENTS" && "$AGENTS" != ,* && "$AGENTS" != *, && "$AGENTS" != *,,* ]] || { echo 'invalid agents list' >&2; exit 2; }
IFS=, read -r -a SELECTED <<<"$AGENTS"
SEEN=' '
for agent in "${SELECTED[@]}"; do
  case "$agent" in cook|cook-main|opencode|pi) ;; *) echo "invalid agent: $agent" >&2; exit 2 ;; esac
  [[ "$SEEN" != *" $agent "* ]] || { echo "duplicate agent: $agent" >&2; exit 2; }
  SEEN+="$agent "
done
if [[ "$DRY_RUN" == true ]]; then
  "$PYTHON" "$SUITE" sample --seed "$SEED"
  exit 0
fi
[[ "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$MODEL" != *..* && "$MODEL" != *//* ]] || { echo 'valid --model required' >&2; exit 2; }
if [[ "$NO_GRADE" == false ]]; then
  command -v "$SWE_BIN" >/dev/null || { echo 'Install grader: pip install -r scripts/swe-bench/requirements.txt' >&2; exit 2; }
  if [[ ! -e "$TASK_REPO" ]]; then
    mkdir -p "$(dirname "$TASK_REPO")"
    echo "Cloning SWE-bench task environments into $TASK_REPO" >&2
    git clone https://github.com/SWE-bench/swe-bench-tasks.git "$TASK_REPO"
  fi
  [[ -d "$TASK_REPO/.git" ]] || { echo "task repo must be a git checkout: $TASK_REPO" >&2; exit 2; }
  TASK_REPO=$(cd "$TASK_REPO" && pwd)
  TASK_COMMIT=$(git -C "$TASK_REPO" rev-parse HEAD)
  [[ -z $(git -C "$TASK_REPO" status --porcelain) ]] || { echo 'task repo has uncommitted changes' >&2; exit 2; }
  "$SWE_BIN" eval --help >/dev/null
fi
MODEL_SH=${MODEL_SH:-/home/thanh/models/model.sh}
BASE_URL=${EVAL_BASE_URL:-${BASE_URL:-}}
# An explicit --parallel value also opts into that many model slots unless the
# caller or model configuration supplies EVAL_PARALLEL_SLOTS.
if [[ -z "${EVAL_PARALLEL_SLOTS:-}" && "$PARALLEL" -gt 1 ]]; then
  export EVAL_PARALLEL_SLOTS="$PARALLEL"
fi
COOK_MANAGED_BIN="${GROK_HOME:-${COOK_HOME:-$HOME/.cook}}/bin/cook"
if [[ -z "${COOK_BIN:-}" ]]; then
  if [[ -x "$COOK_MANAGED_BIN" ]]; then COOK_BIN=$COOK_MANAGED_BIN; else COOK_BIN=cook; fi
fi
OPENCODE_BIN=${OPENCODE_BIN:-opencode}
PI_BIN=${PI_BIN:-pi}
source "$ROOT/scripts/evaluate/model.sh"
source "$ROOT/scripts/evaluate/agent.sh"
DATE=$(date -u +%Y-%m-%d)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$$
REPORT_MODEL=${MODEL//\//-}
mkdir -p "$OUTPUT_ROOT"
OUTPUT_ROOT=$(cd "$OUTPUT_ROOT" && pwd)
BUNDLE_DIR="$OUTPUT_ROOT/$DATE-swe-bench-$REPORT_MODEL-$STAMP"
mkdir -m 700 "$BUNDLE_DIR"
# Retain the harness output alongside every other artifact in this bundle.
exec > >(tee -a "$BUNDLE_DIR/harness.log") 2>&1
# Hydrate and clone serially: parallel jobs never mutate a shared mirror.
"$PYTHON" "$SUITE" sample --seed "$SEED" --hydrate --output "$BUNDLE_DIR/selection.json" >"$BUNDLE_DIR/selected.tsv"
echo 'Disk usage: four upstream repos per agent; local clones hardlink mirror objects.' >&2
while IFS=$'\t' read -r level iid; do
  RUN_DIR="$BUNDLE_DIR/$level-$iid"
  mkdir -p "$RUN_DIR"
  "$PYTHON" "$SUITE" prompt --selection "$BUNDLE_DIR/selection.json" --instance-id "$iid" >"$RUN_DIR/prompt.txt"
  for agent in "${SELECTED[@]}"; do
    "$PYTHON" "$SUITE" checkout --selection "$BUNDLE_DIR/selection.json" --instance-id "$iid" --destination "$RUN_DIR/$agent/workdir" --mirrors "$ROOT/temp/swe-bench/mirrors"
  done
done <"$BUNDLE_DIR/selected.tsv"
ensure_model
CONTEXT_WINDOW=$(model_context_window)
MODEL_SLOTS=$(model_parallel_slots)
REQUIRED_SLOTS=$PARALLEL
TOTAL=$((4 * ${#SELECTED[@]}))
(( REQUIRED_SLOTS <= TOTAL )) || REQUIRED_SLOTS=$TOTAL
(( REQUIRED_SLOTS <= MODEL_SLOTS )) || { echo "--parallel requires $REQUIRED_SLOTS model slots; $MODEL has $MODEL_SLOTS" >&2; exit 2; }
"$PYTHON" - "$BUNDLE_DIR" "$MODEL" "$WIRE" "$THINKING" "$PARALLEL" "$TIMEOUT" "${TASK_COMMIT:-}" <<'PY'
import json,sys
from pathlib import Path
bundle,model,wire,thinking,parallel,timeout,task_commit=sys.argv[1:]
base=int(timeout)
timeouts={level:base*factor for level,factor in zip(('easy','medium','hard','very-hard'),(1,2,4,6))}
Path(bundle,'config.json').write_text(json.dumps(dict(model=model,wire=wire,thinking=thinking,parallel=int(parallel),timeout_base=base,timeouts=timeouts,task_repo_commit=task_commit),indent=2)+'\n')
PY
kill_tree() {
  local pid=$1 child
  while read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  local pid
  for pid in $(jobs -pr); do kill_tree "$pid"; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
run_one() (
  RUN_DIR=$1
  local agent=$2 level=$3 factor
  case "$level" in easy) factor=1 ;; medium) factor=2 ;; hard) factor=4 ;; very-hard) factor=6 ;; esac
  TIMEOUT=$(( TIMEOUT * factor ))
  printf '%s\n' "$TIMEOUT" >"$RUN_DIR/$agent/timeout-seconds.txt"
  echo "Running $level ($agent), timeout $TIMEOUT seconds" >&2
  PROMPT=$(<"$RUN_DIR/prompt.txt")
  run_agent "$agent"
  "$PYTHON" "$SUITE" patch --workdir "$RUN_DIR/$agent/workdir" >"$RUN_DIR/$agent/patch.diff"
  echo "Completed $level ($agent), exit $(<"$RUN_DIR/$agent/exit-code.txt")" >&2
)
queue_dirs=() queue_agents=() queue_levels=() active_pids=()
while IFS=$'\t' read -r level iid; do
  for agent in "${SELECTED[@]}"; do
    queue_dirs+=("$BUNDLE_DIR/$level-$iid")
    queue_agents+=("$agent")
    queue_levels+=("$level")
  done
done <"$BUNDLE_DIR/selected.tsv"
next=0 active_count=0 failures=0
while (( next < TOTAL || active_count > 0 )); do
  while (( next < TOTAL && active_count < PARALLEL )); do
    run_one "${queue_dirs[$next]}" "${queue_agents[$next]}" "${queue_levels[$next]}" &
    active_pids[$next]=$!
    next=$((next + 1)); active_count=$((active_count + 1))
  done
  completed=false
  for slot in "${!active_pids[@]}"; do
    pid=${active_pids[$slot]}
    if ! kill -0 "$pid" 2>/dev/null; then
      if ! wait "$pid"; then failures=$((failures + 1)); fi
      unset 'active_pids[slot]'
      active_count=$((active_count - 1)); completed=true
      break
    fi
  done
  [[ "$completed" == true ]] || sleep 0.1
done
"$PYTHON" "$SUITE" predictions --bundle "$BUNDLE_DIR" --agents "$AGENTS" --model "$MODEL" --stamp "$STAMP"
if [[ "$NO_GRADE" == false ]]; then
  printf '%s\n' "$TASK_COMMIT" >"$BUNDLE_DIR/task-repo-commit.txt"
  for agent in "${SELECTED[@]}"; do
    # Empty predictions stay in JSONL but are excluded from Docker evaluation.
    grade_args=()
    while read -r iid; do grade_args+=(-i "$iid"); done < <("$PYTHON" - "$BUNDLE_DIR/predictions/$agent.jsonl" <<'PY'
import json,sys
for line in open(sys.argv[1]):
    row=json.loads(line)
    if row['model_patch']: print(row['instance_id'])
PY
)
    if ((${#grade_args[@]})); then
      set +e
      (cd "$BUNDLE_DIR" && "$SWE_BIN" eval verified -p "$BUNDLE_DIR/predictions/$agent.jsonl" --run-id "cook-swe-$STAMP-$agent" --task-repo "$TASK_REPO" -j 1 "${grade_args[@]}") >"$BUNDLE_DIR/grade-$agent.log" 2>&1
      rc=$?
      set -e
      printf '%s\n' "$rc" >"$BUNDLE_DIR/grade-$agent-exit-code.txt"
    fi
  done
fi
report_args=()
[[ "$NO_GRADE" == false ]] || report_args+=(--no-grade)
"$PYTHON" "$SUITE" report --bundle "$BUNDLE_DIR" --agents "$AGENTS" --model "$MODEL" "${report_args[@]}"
(( failures == 0 )) || { echo "$failures harnesses failed before collecting patches" >&2; exit 1; }
