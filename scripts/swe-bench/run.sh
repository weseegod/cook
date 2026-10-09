#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat <<'EOF'
Usage: scripts/swe-bench/run.sh --model NAME [options]
Run one pinned SWE-bench Verified instance per level with each selected agent.
--model NAME       same model configuration as scripts/evaluate.sh;
                   optional OpenRouter pin: org/model:provider
                   (e.g. deepseek/deepseek-v4.1-flash:relace forces provider.only);
                   :free/:nitro/:floor stay on the wire model slug
--seed N           reproducible selection (default: 1)
--seeds LIST       multiple seeds, comma-separated or ranges (e.g. 1,2,3 or 1-10)
--agents LIST      cook,cook-main,opencode,pi (default: cook,opencode,pi)
--timeout SECONDS  easy-task time budget, minimum 600 (default: 900);
                   medium=2x, hard=4x, very-hard=6x for every agent
--thinking LEVEL   reasoning level: off, minimal, low, medium, high, max
                   (true=medium, false=off; default: true)
--levels LIST      comma-separated subset of easy,medium,hard,very-hard
                   (default: all four); order is always easy→very-hard
--parallel N       global task pool across all seeds/agents, 1 to 3 (default: 3);
                   each slot runs an agent then grades its patch before reuse; model
                   slots use N unless EVAL_PARALLEL_SLOTS is set
--output-root DIR  bundle parent (default: docs/audits)
--dry-run          print four IDs without starting a model or loading datasets
--no-grade         skip Docker grading; grading is enabled by default
--grade BOOL       enable or disable Docker grading (default: true)
--task-repo DIR    clean swe-bench-tasks checkout (default: temp/swe-bench/swe-bench-tasks)

The local temp/swe-bench/venv is used when present. The task repo is cloned
automatically when missing. Before a long graded run, validate Docker yourself:
  temp/swe-bench/venv/bin/swebench eval verified --gold -i sympy__sympy-20590 \
    --task-repo temp/swe-bench/swe-bench-tasks
API overrides: EVAL_BASE_URL, EVAL_API_KEY, EVAL_CONTEXT_WINDOW, EVAL_PARALLEL_SLOTS.
Cook skills: EVAL_SKILLS=working-plan,bug-fix seeds those skill dirs into each
cook cell COOK_HOME (from EVAL_SKILLS_ROOT, else <repo>/skills, else ~/.cook/skills).
A trailing :provider (except OpenRouter :free/:nitro/:floor variants) starts a
local proxy that injects OpenRouter provider.only with allow_fallbacks=false.
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
MODEL= SEED_LIST=1 SEED_OPTION= TIMEOUT=900 AGENTS=cook,opencode,pi THINKING=true PARALLEL=3 OUTPUT_ROOT="$ROOT/docs/audits" DRY_RUN=false NO_GRADE=false LEVELS_LIST=easy,medium,hard,very-hard TASK_REPO=${SWE_TASK_REPO:-"$ROOT/temp/swe-bench/swe-bench-tasks"}
while (($#)); do
  case "$1" in
    --model|--seed|--seeds|--grade|--timeout|--agents|--thinking|--levels|--parallel|--output-root|--task-repo)
      (($# >= 2)) || { echo "missing value for $1" >&2; exit 2; }
      case "$1" in
        --model) MODEL=$2 ;;
        --seed|--seeds)
          [[ -z "$SEED_OPTION" ]] || { echo 'use --seed or --seeds once, not both' >&2; exit 2; }
          SEED_OPTION=$1; SEED_LIST=$2
          if [[ "$1" == --seed && ! "$2" =~ ^-?[0-9]+$ ]]; then
            echo '--seed must be an integer' >&2; exit 2
          fi ;;
        --grade)
          case "$2" in true) NO_GRADE=false ;; false) NO_GRADE=true ;;
            *) echo 'grade must be true or false' >&2; exit 2 ;; esac ;;
        --timeout) TIMEOUT=$2 ;;
        --agents) AGENTS=$2 ;; --thinking) THINKING=$2 ;; --levels) LEVELS_LIST=$2 ;; --parallel) PARALLEL=$2 ;;
        --output-root) OUTPUT_ROOT=$2 ;; --task-repo) TASK_REPO=$2 ;;
      esac
      shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;; --no-grade) NO_GRADE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
LEVELS_TEXT=$("$PYTHON" -c '
import sys
sys.path.insert(0, "'"$ROOT"'/scripts/swe-bench")
from suite import parse_only_levels
print("\n".join(parse_only_levels(sys.argv[1])))
' "$LEVELS_LIST") || { echo "invalid --levels: $LEVELS_LIST (use easy,medium,hard,very-hard)" >&2; exit 2; }
mapfile -t SELECTED_LEVELS <<<"$LEVELS_TEXT"
LEVELS_CSV=$(IFS=,; echo "${SELECTED_LEVELS[*]}")
SEED_TEXT=$("$PYTHON" - "$SEED_LIST" <<'PY'
import re, sys
seeds = []
for item in sys.argv[1].split(','):
    item = item.strip()
    if re.fullmatch(r'-?\d+', item):
        values = [int(item)]
    else:
        match = re.fullmatch(r'(-?\d+)-(-?\d+)', item)
        if not match or int(match[1]) > int(match[2]):
            sys.exit('invalid seeds: use integers or ascending ranges, e.g. 1,2,3 or 1-10')
        values = range(int(match[1]), int(match[2]) + 1)
    for seed in values:
        if seed in seeds:
            sys.exit(f'duplicate seed: {seed}')
        seeds.append(seed)
print('\n'.join(map(str, seeds)))
PY
) || exit 2
mapfile -t SEEDS <<<"$SEED_TEXT"
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo 'timeout must be positive' >&2; exit 2; }
(( TIMEOUT >= 600 && TIMEOUT <= 2147483647 / 6 )) || { echo '--timeout must be at least 600 seconds and fit the level multipliers' >&2; exit 2; }
[[ "$PARALLEL" =~ ^[1-3]$ ]] || { echo 'parallel must be 1, 2, or 3' >&2; exit 2; }
[[ "$THINKING" =~ ^(true|false|off|none|minimal|low|medium|high|xhigh|max)$ ]] || { echo 'thinking must be true, false, off, none, minimal, low, medium, high, xhigh, or max' >&2; exit 2; }
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
  for seed in "${SEEDS[@]}"; do
    if ((${#SEEDS[@]} > 1)); then echo "Seed $seed"; fi
    "$PYTHON" "$SUITE" sample --seed "$seed" --only "$LEVELS_CSV"
  done
  exit 0
fi
[[ "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9][A-Za-z0-9._-]*)?$ && "$MODEL" != *..* && "$MODEL" != *//* ]] || { echo 'valid --model required' >&2; exit 2; }
# OpenRouter model/routing variants stay on the wire model (:free is a model
# slug suffix; :nitro/:floor are routing variants). Any other :suffix is a
# provider pin handled by scripts/swe-bench/provider_pin_proxy.py.
USER_MODEL=$MODEL
PROVIDER_ONLY=
case "$MODEL" in
  *:free|*:nitro|*:floor) ;;
  *:*)
    PROVIDER_ONLY=${MODEL##*:}
    MODEL=${MODEL%:*}
    [[ -n "$MODEL" && "$PROVIDER_ONLY" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
      echo 'invalid --model provider pin; use org/model:provider' >&2; exit 2; }
    ;;
esac
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
PROVIDER_PIN_PROXY="$ROOT/scripts/swe-bench/provider_pin_proxy.py"
PROVIDER_PIN_PID=
# When the caller did not override the API, resolve OpenRouter from
# ~/.cook/config.toml for provider pins and bare org/model[:free|:nitro|:floor]
# slugs (no dedicated [model.*] block required). Skip local/* launcher names.
NEED_OPENROUTER_RESOLVE=false
if [[ -z "${EVAL_BASE_URL:-}" && -z "${BASE_URL:-}" ]]; then
  if [[ -n "$PROVIDER_ONLY" ]]; then
    NEED_OPENROUTER_RESOLVE=true
  elif [[ "$MODEL" == */* && "$MODEL" != local/* ]]; then
    NEED_OPENROUTER_RESOLVE=true
  fi
fi
if [[ "$NEED_OPENROUTER_RESOLVE" == true ]]; then
  RESOLVE_FILE=$(mktemp)
  if ! "$PYTHON" "$PROVIDER_PIN_PROXY" resolve-openrouter --model "$MODEL" >"$RESOLVE_FILE"; then
    rm -f "$RESOLVE_FILE"
    exit 2
  fi
  RESOLVE_INDEX=0
  while IFS= read -r -d '' RESOLVE_VALUE; do
    case "$RESOLVE_INDEX" in
      0) EVAL_BASE_URL=$RESOLVE_VALUE; export EVAL_BASE_URL; BASE_URL=$RESOLVE_VALUE ;;
      1) EVAL_WIRE_MODEL=$RESOLVE_VALUE; export EVAL_WIRE_MODEL ;;
      2) [[ -n "$RESOLVE_VALUE" ]] && { EVAL_API_KEY=$RESOLVE_VALUE; export EVAL_API_KEY; } ;;
    esac
    RESOLVE_INDEX=$((RESOLVE_INDEX + 1))
  done <"$RESOLVE_FILE"
  rm -f "$RESOLVE_FILE"
  (( RESOLVE_INDEX >= 2 )) || { echo "failed to resolve OpenRouter settings for $MODEL" >&2; exit 2; }
fi
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
REPORT_MODEL=${USER_MODEL//\//-}
REPORT_MODEL=${REPORT_MODEL//:/-}
mkdir -p "$OUTPUT_ROOT"
OUTPUT_ROOT=$(cd "$OUTPUT_ROOT" && pwd)
BUNDLE_DIR="$OUTPUT_ROOT/$DATE-swe-bench-$REPORT_MODEL-$STAMP"
mkdir -m 700 "$BUNDLE_DIR"
# Retain the harness output alongside every other artifact in this bundle.
exec > >(tee -a "$BUNDLE_DIR/harness.log") 2>&1
ensure_model
if [[ -n "$PROVIDER_ONLY" ]]; then
  UPSTREAM_BASE=$BASE_URL
  PROXY_LOG=$BUNDLE_DIR/provider-pin-proxy.log
  rm -f "$BUNDLE_DIR/provider-pin-proxy.ready"
  (
    "$PYTHON" -u "$PROVIDER_PIN_PROXY" serve --upstream "$UPSTREAM_BASE" --only "$PROVIDER_ONLY" \
      --allow-fallbacks false >"$BUNDLE_DIR/provider-pin-proxy.ready" 2>"$PROXY_LOG"
  ) &
  PROVIDER_PIN_PID=$!
  printf '%s\n' "$PROVIDER_PIN_PID" >"$BUNDLE_DIR/provider-pin-proxy.pid"
  PROXY_BASE=
  for ((attempt=0; attempt<100; attempt++)); do
    if [[ -s "$BUNDLE_DIR/provider-pin-proxy.ready" ]]; then
      PROXY_BASE=$(head -n1 "$BUNDLE_DIR/provider-pin-proxy.ready")
      PROXY_BASE=${PROXY_BASE#READY }
      [[ "$PROXY_BASE" == http://* ]] && break
    fi
    kill -0 "$PROVIDER_PIN_PID" 2>/dev/null || {
      echo "provider pin proxy exited early; see $PROXY_LOG" >&2
      exit 2
    }
    sleep 0.05
  done
  [[ "$PROXY_BASE" == http://* ]] || {
    echo "provider pin proxy did not become ready; see $PROXY_LOG" >&2
    exit 2
  }
  BASE_URL=$PROXY_BASE
  echo "OpenRouter provider pin: only=[$PROVIDER_ONLY] allow_fallbacks=false via $BASE_URL (upstream $UPSTREAM_BASE)" >&2
fi
CONTEXT_WINDOW=$(model_context_window)
MODEL_SLOTS=$(model_parallel_slots)
REQUIRED_SLOTS=$PARALLEL
TOTAL=$((${#SELECTED_LEVELS[@]} * ${#SELECTED[@]} * ${#SEEDS[@]}))
(( REQUIRED_SLOTS <= TOTAL )) || REQUIRED_SLOTS=$TOTAL
(( REQUIRED_SLOTS <= MODEL_SLOTS )) || { echo "--parallel requires $REQUIRED_SLOTS model slots; $MODEL has $MODEL_SLOTS" >&2; exit 2; }
"$PYTHON" - "$BUNDLE_DIR" "$USER_MODEL" "$WIRE" "$THINKING" "$PARALLEL" "$TIMEOUT" "${TASK_COMMIT:-}" "$NO_GRADE" "$PROVIDER_ONLY" "$LEVELS_CSV" "${SEEDS[@]}" <<'PY'
import datetime, json, sys
from pathlib import Path
bundle,model,wire,thinking,parallel,timeout,task_commit,no_grade,provider_only,levels_csv,*seeds=sys.argv[1:]
seeds = list(map(int, seeds))
levels = [level for level in levels_csv.split(',') if level]
base=int(timeout)
factors={'easy':1,'medium':2,'hard':4,'very-hard':6}
timeouts={level:base*factors[level] for level in levels}
config = dict(model=model,wire=wire,thinking=thinking,parallel=int(parallel),timeout_base=base,
              levels=levels,timeouts=timeouts,task_repo_commit=task_commit,seeds=seeds,grade=no_grade=='false',
              pool_scope='global across all seeds and agents; grading stays in the task slot',
              started_at_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
if provider_only:
    config['openrouter_provider'] = dict(only=[provider_only], allow_fallbacks=False)
Path(bundle,'config.json').write_text(json.dumps(config,indent=2)+'\n')
if len(seeds) > 1:
    for seed in seeds:
        directory = Path(bundle, f'seed-{seed}')
        directory.mkdir(mode=0o700)
        (directory/'config.json').write_text(json.dumps(dict(config,seeds=[seed]),indent=2)+'\n')
PY
echo "Audit: $BUNDLE_DIR" >&2
# Hydrate and clone serially: parallel jobs never mutate a shared mirror.
queue_dirs=() queue_agents=() queue_levels=() queue_iids=() queue_seeds=() queue_bundles=() seed_bundles=()
declare -A seed_remaining=()
for seed in "${SEEDS[@]}"; do
  seed_bundle=$BUNDLE_DIR
  if ((${#SEEDS[@]} > 1)); then seed_bundle="$BUNDLE_DIR/seed-$seed"; fi
  seed_bundles+=("$seed_bundle")
  seed_remaining[$seed]=0
  "$PYTHON" "$SUITE" sample --seed "$seed" --only "$LEVELS_CSV" --hydrate --output "$seed_bundle/selection.json" >"$seed_bundle/selected.tsv"
  while IFS=$'\t' read -r level iid; do
    RUN_DIR="$seed_bundle/$level-$iid"
    mkdir -p "$RUN_DIR"
    "$PYTHON" "$SUITE" prompt --selection "$seed_bundle/selection.json" --instance-id "$iid" >"$RUN_DIR/prompt.txt"
    for agent in "${SELECTED[@]}"; do
      "$PYTHON" "$SUITE" checkout --selection "$seed_bundle/selection.json" --instance-id "$iid" --destination "$RUN_DIR/$agent/workdir" --mirrors "$ROOT/temp/swe-bench/mirrors"
      queue_dirs+=("$RUN_DIR"); queue_agents+=("$agent"); queue_levels+=("$level")
      queue_iids+=("$iid"); queue_seeds+=("$seed"); queue_bundles+=("$seed_bundle")
      seed_remaining[$seed]=$((seed_remaining[$seed] + 1))
    done
  done <"$seed_bundle/selected.tsv"
  # Initialize immutable per-task grader IDs before any workers start.
  "$PYTHON" "$SUITE" predictions --bundle "$seed_bundle" --agents "$AGENTS" --model "$USER_MODEL" --stamp "$STAMP-seed-$seed" --per-task
  if [[ "$NO_GRADE" == false ]]; then printf '%s\n' "$TASK_COMMIT" >"$seed_bundle/task-repo-commit.txt"; fi
done
kill_tree() {
  local pid=$1 child
  while read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  local pid
  [[ -n "${PROVIDER_PIN_PID:-}" ]] && kill_tree "$PROVIDER_PIN_PID"
  for pid in $(jobs -pr); do kill_tree "$pid"; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
report_args=()
[[ "$NO_GRADE" == false ]] || report_args+=(--no-grade)
report_seed() {
  local seed=$1 seed_bundle=$2
  echo "Reporting seed $seed" >&2
  "$PYTHON" "$SUITE" predictions --bundle "$seed_bundle" --agents "$AGENTS" --model "$USER_MODEL" --stamp "$STAMP-seed-$seed" --per-task
  "$PYTHON" "$SUITE" report --bundle "$seed_bundle" --agents "$AGENTS" --model "$USER_MODEL" "${report_args[@]}"
}
run_one() (
  RUN_DIR=$1
  local agent=$2 level=$3 iid=$4 seed=$5 seed_bundle=$6 factor run_id rc
  case "$level" in easy) factor=1 ;; medium) factor=2 ;; hard) factor=4 ;; very-hard) factor=6 ;; esac
  TIMEOUT=$(( TIMEOUT * factor ))
  printf '%s\n' "$TIMEOUT" >"$RUN_DIR/$agent/timeout-seconds.txt"
  echo "Running seed $seed, $level ($agent), timeout $TIMEOUT seconds" >&2
  PROMPT=$(<"$RUN_DIR/prompt.txt")
  run_agent "$agent"
  "$PYTHON" "$SUITE" patch --workdir "$RUN_DIR/$agent/workdir" >"$RUN_DIR/$agent/patch.diff"
  echo "Agent finished seed $seed, $level ($agent), exit $(<"$RUN_DIR/$agent/exit-code.txt")" >&2
  if [[ "$NO_GRADE" == false && -s "$RUN_DIR/$agent/patch.diff" ]]; then
    run_id=$("$PYTHON" - "$seed_bundle" "$RUN_DIR/$agent" "$agent" "$iid" <<'PY'
import json, sys
from pathlib import Path
bundle, directory, agent, iid = sys.argv[1:]
run = json.loads(Path(bundle, 'grading.json').read_text())[agent]['instances'][iid]
row = dict(instance_id=iid, model_name_or_path=run['model_name_or_path'],
           model_patch=Path(directory, 'patch.diff').read_text())
Path(directory, 'prediction.jsonl').write_text(json.dumps(row)+'\n')
print(run['run_id'])
PY
)
    echo "Grading seed $seed, $level ($agent)" >&2
    set +e
    (cd "$seed_bundle" && "$SWE_BIN" eval verified -p "$RUN_DIR/$agent/prediction.jsonl" \
      --run-id "$run_id" --task-repo "$TASK_REPO" -j 1 -i "$iid") >"$RUN_DIR/$agent/grade.log" 2>&1
    rc=$?
    set -e
    printf '%s\n' "$rc" >"$RUN_DIR/$agent/grade-exit-code.txt"
  else
    rc=0
  fi
  result_args=()
  [[ "$NO_GRADE" == false ]] || result_args+=(--no-grade)
  "$PYTHON" "$SUITE" result --bundle "$seed_bundle" --instance-id "$iid" --agent "$agent" "${result_args[@]}"
  return "$rc"
)
active_pids=()
next=0 active_count=0 failures=0
while (( next < TOTAL || active_count > 0 )); do
  while (( next < TOTAL && active_count < PARALLEL )); do
    run_one "${queue_dirs[$next]}" "${queue_agents[$next]}" "${queue_levels[$next]}" \
      "${queue_iids[$next]}" "${queue_seeds[$next]}" "${queue_bundles[$next]}" &
    active_pids[$next]=$!
    next=$((next + 1)); active_count=$((active_count + 1))
  done
  completed=false
  for slot in "${!active_pids[@]}"; do
    pid=${active_pids[$slot]}
    if ! kill -0 "$pid" 2>/dev/null; then
      if ! wait "$pid"; then failures=$((failures + 1)); fi
      seed=${queue_seeds[$slot]}
      seed_remaining[$seed]=$((seed_remaining[$seed] - 1))
      if (( seed_remaining[$seed] == 0 )); then
        for index in "${!SEEDS[@]}"; do
          if [[ "${SEEDS[$index]}" == "$seed" ]]; then
            report_seed "$seed" "${seed_bundles[$index]}"
            break
          fi
        done
      fi
      unset 'active_pids[slot]'
      active_count=$((active_count - 1)); completed=true
      break
    fi
  done
  [[ "$completed" == true ]] || sleep 0.1
done
if ((${#SEEDS[@]} > 1)); then
  "$PYTHON" "$SUITE" batch-report --bundle "$BUNDLE_DIR" --agents "$AGENTS" --model "$USER_MODEL" "${report_args[@]}"
fi
(( failures == 0 )) || { echo "$failures task workers failed (see agent and grade logs)" >&2; exit 1; }
