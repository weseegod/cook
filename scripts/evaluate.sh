#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/evaluate.sh --model NAME --task TEXT [--timeout SECONDS] [--agents cook,opencode,pi] [--thinking true|false] [--parallel=true|false]

Compare installed agents against a local llama-server or an OpenAI-compatible API.
Results: temp/evaluate/ (workdirs and logs), docs/audits/ (markdown report).
--model    model launcher name or model ID from ~/.cook/config.toml (required)
--task     identical task text sent to each agent (required)
--timeout  seconds allowed per agent (default: 1800)
--agents   comma-separated subset in execution order (default: cook,opencode,pi)
--thinking enable model reasoning for every agent (default: false)
--parallel run selected agents together when the model has enough slots (default: false)

API settings: EVAL_BASE_URL and EVAL_API_KEY override provider settings from
~/.cook/config.toml. EVAL_PARALLEL_SLOTS sets the API concurrency limit.
EOF
}

MODEL= TASK= TIMEOUT=1800 AGENTS=cook,opencode,pi THINKING=false PARALLEL=false
while (($#)); do
  case "$1" in
    --model|--task|--timeout|--agents|--thinking|--parallel)
      (($# >= 2)) || { echo "missing value for $1" >&2; exit 2; }
      case "$1" in
        --model) MODEL=$2 ;; --task) TASK=$2 ;; --timeout) TIMEOUT=$2 ;; --agents) AGENTS=$2 ;; --thinking) THINKING=$2 ;; --parallel) PARALLEL=$2 ;;
      esac
      shift 2 ;;
    --parallel=*) PARALLEL=${1#*=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODEL" && -n "$TASK" ]] || { usage >&2; exit 2; }
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "--timeout must be positive seconds" >&2; exit 2; }
[[ "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$MODEL" != *..* && "$MODEL" != *//* ]] || { echo "invalid model name" >&2; exit 2; }
[[ "$THINKING" == true || "$THINKING" == false ]] || { echo "--thinking must be true or false" >&2; exit 2; }
[[ "$PARALLEL" == true || "$PARALLEL" == false ]] || { echo "--parallel must be true or false" >&2; exit 2; }
IFS=, read -r -a SELECTED <<<"$AGENTS"
((${#SELECTED[@]} > 0)) || { echo "--agents is empty" >&2; exit 2; }
SEEN=" "
for agent in "${SELECTED[@]}"; do
  case "$agent" in cook|opencode|pi) ;; *) echo "invalid agent: $agent" >&2; exit 2 ;; esac
  case "$SEEN" in *" $agent "*) echo "duplicate agent: $agent" >&2; exit 2 ;; esac
  SEEN+="$agent "
done

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MODEL_SH=${MODEL_SH:-/home/thanh/models/model.sh}
BASE_URL=${EVAL_BASE_URL:-${BASE_URL:-}}
COOK_BIN=${COOK_BIN:-cook}
OPENCODE_BIN=${OPENCODE_BIN:-opencode}
PI_BIN=${PI_BIN:-pi}


source "$ROOT/scripts/evaluate/model.sh"
source "$ROOT/scripts/evaluate/agent.sh"
if [[ "$PARALLEL" == true ]]; then
  MODEL_SLOTS=$(model_parallel_slots)
  ((${#SELECTED[@]} <= MODEL_SLOTS)) || {
    echo "--parallel requires ${#SELECTED[@]} model slots; $MODEL has $MODEL_SLOTS" >&2
    exit 2
  }
fi
ensure_model
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="$ROOT/temp/evaluate/$STAMP"
if [[ -e "$RUN_DIR" ]]; then RUN_DIR="$RUN_DIR-$$"; fi
mkdir -p "$RUN_DIR"
chmod 700 "$RUN_DIR"
PROMPT="$TASK

Work only in the current directory. Create the files needed for the task. Do not ask questions."
printf '%s\n' "$PROMPT" >"$RUN_DIR/prompt.txt"

CONTEXT_WINDOW=$(model_context_window)

if [[ "$PARALLEL" == true ]]; then
  pids=()
  for agent in "${SELECTED[@]}"; do
    run_agent "$agent" &
    pids+=("$!")
  done
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then echo "agent runner $pid failed before recording its result" >&2; fi
  done
else
  for agent in "${SELECTED[@]}"; do run_agent "$agent"; done
fi

DATE=$(date -u +%Y-%m-%d)
REPORT_MODEL=${MODEL//\//-}
REPORT_BASE="$ROOT/docs/audits/$DATE-agent-compare-$REPORT_MODEL"
REPORT="$REPORT_BASE.md"
if [[ -e "$REPORT" ]]; then
  REPORT="$REPORT_BASE-$(date -u +%H%M%S).md"
  suffix=2
  while [[ -e "$REPORT" ]]; do
    REPORT="$REPORT_BASE-$(date -u +%H%M%S)-$suffix.md"
    ((suffix += 1))
  done
fi
python3 "$ROOT/scripts/evaluate/summarize.py" --run-dir "$RUN_DIR" --model "$MODEL" --wire "$WIRE" --task "$TASK" --agents "$AGENTS" --thinking "$THINKING" --parallel "$PARALLEL" --report "$REPORT"
