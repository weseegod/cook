#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/evaluate.sh --model NAME --task TEXT [--timeout SECONDS] [--agents cook,opencode,pi] [--thinking true|false]

Compare installed agents sequentially against the local llama-server on port 8080.
Results: temp/evaluate/ (workdirs and logs), docs/audits/ (markdown report).
--model    model.sh launcher name, for example mimo26-9b (required)
--task     identical task text sent to each agent (required)
--timeout  seconds allowed per agent (default: 1800)
--agents   comma-separated subset in execution order (default: cook,opencode,pi)
--thinking enable model reasoning for every agent (default: false)
EOF
}

MODEL= TASK= TIMEOUT=1800 AGENTS=cook,opencode,pi THINKING=false
while (($#)); do
  case "$1" in
    --model|--task|--timeout|--agents|--thinking)
      (($# >= 2)) || { echo "missing value for $1" >&2; exit 2; }
      case "$1" in
        --model) MODEL=$2 ;; --task) TASK=$2 ;; --timeout) TIMEOUT=$2 ;; --agents) AGENTS=$2 ;; --thinking) THINKING=$2 ;;
      esac
      shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODEL" && -n "$TASK" ]] || { usage >&2; exit 2; }
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "--timeout must be positive seconds" >&2; exit 2; }
[[ "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid model name" >&2; exit 2; }
[[ "$THINKING" == true || "$THINKING" == false ]] || { echo "--thinking must be true or false" >&2; exit 2; }
IFS=, read -r -a SELECTED <<<"$AGENTS"
((${#SELECTED[@]} > 0)) || { echo "--agents is empty" >&2; exit 2; }
declare -A SEEN=()
for agent in "${SELECTED[@]}"; do
  case "$agent" in cook|opencode|pi) ;; *) echo "invalid agent: $agent" >&2; exit 2 ;; esac
  [[ -z "${SEEN[$agent]:-}" ]] || { echo "duplicate agent: $agent" >&2; exit 2; }
  SEEN[$agent]=1
done

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MODEL_SH=${MODEL_SH:-/home/thanh/models/model.sh}
BASE_URL=http://127.0.0.1:8080/v1
COOK_BIN=${COOK_BIN:-cook}
OPENCODE_BIN=${OPENCODE_BIN:-opencode}
PI_BIN=${PI_BIN:-pi}


source "$ROOT/scripts/evaluate/model.sh"
source "$ROOT/scripts/evaluate/agent.sh"
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

for agent in "${SELECTED[@]}"; do run_agent "$agent"; done

DATE=$(date -u +%Y-%m-%d)
REPORT_BASE="$ROOT/docs/audits/$DATE-agent-compare-$MODEL"
REPORT="$REPORT_BASE.md"
if [[ -e "$REPORT" ]]; then
  REPORT="$REPORT_BASE-$(date -u +%H%M%S).md"
  suffix=2
  while [[ -e "$REPORT" ]]; do
    REPORT="$REPORT_BASE-$(date -u +%H%M%S)-$suffix.md"
    ((suffix += 1))
  done
fi
python3 "$ROOT/scripts/evaluate/summarize.py" --run-dir "$RUN_DIR" --model "$MODEL" --wire "$WIRE" --task "$TASK" --agents "$AGENTS" --thinking "$THINKING" --report "$REPORT"
