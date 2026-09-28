#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/evaluate.sh --model NAME --task TEXT [options]
  ./scripts/evaluate.sh --model NAME --suite hard [options]

Compare Cook, OpenCode, and Pi against a local llama-server or an OpenAI-compatible API.
Single-task results: temp/evaluate/ plus docs/audits/.
Hard-suite results: one folder under docs/audits/ with all prompts, agent outputs, and reports.

--model NAME       model launcher name or model ID from ~/.cook/config.toml (required)
--task TEXT        identical task text sent to every selected agent
--suite hard       run the 3 fixed hard prompts
--timeout SECONDS  per-agent timeout (default: 1800)
--agents LIST      comma-separated subset of cook,opencode,pi (default: cook,opencode,pi)
--thinking BOOL    enable reasoning for every agent (default: false for --task, true for --suite hard)
--parallel N        concurrent agent harnesses per prompt: 1, 2, or 3 (default: 1)
--output-root DIR  suite folder parent (default: docs/audits/; useful for isolated smoke tests)

API settings: EVAL_BASE_URL and EVAL_API_KEY override provider settings from
~/.cook/config.toml. EVAL_PARALLEL_SLOTS sets the API concurrency limit.
EOF
}

MODEL= TASK= SUITE= OUTPUT_ROOT= TIMEOUT=1800 AGENTS=cook,opencode,pi THINKING= PARALLEL=1
while (($#)); do
  case "$1" in
    --model|--task|--suite|--timeout|--agents|--thinking|--parallel|--output-root)
      (($# >= 2)) || { echo "missing value for $1" >&2; exit 2; }
      case "$1" in
        --model) MODEL=$2 ;; --task) TASK=$2 ;; --suite) SUITE=$2 ;; --timeout) TIMEOUT=$2 ;;
        --agents) AGENTS=$2 ;; --thinking) THINKING=$2 ;; --parallel) PARALLEL=$2 ;;
        --output-root) OUTPUT_ROOT=$2 ;;
      esac
      shift 2 ;;
    --parallel=*) PARALLEL=${1#*=}; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$MODEL" ]] || { usage >&2; exit 2; }
case "$SUITE" in
  "") [[ -n "$TASK" ]] || { echo "--task is required unless --suite hard is selected" >&2; exit 2; } ;;
  hard) [[ -z "$TASK" ]] || { echo "--task and --suite cannot be combined" >&2; exit 2; } ;;
  *) echo "invalid suite: $SUITE" >&2; exit 2 ;;
esac
if [[ -z "$THINKING" ]]; then
  if [[ "$SUITE" == hard ]]; then THINKING=true; else THINKING=false; fi
fi
[[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { echo "--timeout must be positive seconds" >&2; exit 2; }
[[ "$MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$MODEL" != *..* && "$MODEL" != *//* ]] || { echo "invalid model name" >&2; exit 2; }
[[ "$THINKING" == true || "$THINKING" == false ]] || { echo "--thinking must be true or false" >&2; exit 2; }
[[ "$PARALLEL" =~ ^[1-3]$ ]] || { echo "--parallel must be 1, 2, or 3" >&2; exit 2; }
IFS=, read -r -a SELECTED <<<"$AGENTS"
((${#SELECTED[@]} > 0)) || { echo "--agents is empty" >&2; exit 2; }
SEEN=" "
for agent in "${SELECTED[@]}"; do
  case "$agent" in cook|opencode|pi) ;; *) echo "invalid agent: $agent" >&2; exit 2 ;; esac
  case "$SEEN" in *" $agent "*) echo "duplicate agent: $agent" >&2; exit 2 ;; esac
  SEEN+="$agent "
done
if [[ -n "$OUTPUT_ROOT" && "$SUITE" != hard ]]; then
  echo "--output-root is only valid with --suite hard" >&2
  exit 2
fi

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MODEL_SH=${MODEL_SH:-/home/thanh/models/model.sh}
BASE_URL=${EVAL_BASE_URL:-${BASE_URL:-}}
COOK_MANAGED_BIN="${GROK_HOME:-${COOK_HOME:-$HOME/.cook}}/bin/cook"
if [[ -z "${COOK_BIN:-}" ]]; then
  if [[ -x "$COOK_MANAGED_BIN" ]]; then COOK_BIN=$COOK_MANAGED_BIN; else COOK_BIN=cook; fi
fi
OPENCODE_BIN=${OPENCODE_BIN:-opencode}
PI_BIN=${PI_BIN:-pi}

source "$ROOT/scripts/evaluate/model.sh"
source "$ROOT/scripts/evaluate/agent.sh"
if [[ "$SUITE" == hard ]]; then
  if [[ -z "${EVAL_PARALLEL_SLOTS:-}" ]]; then
    EVAL_PARALLEL_SLOTS=$PARALLEL
    (( EVAL_PARALLEL_SLOTS <= ${#SELECTED[@]} )) || EVAL_PARALLEL_SLOTS=${#SELECTED[@]}
    export EVAL_PARALLEL_SLOTS
  fi
fi
ensure_model
CONTEXT_WINDOW=$(model_context_window)
if (( PARALLEL > 1 )); then
  MODEL_SLOTS=$(model_parallel_slots)
  REQUIRED_SLOTS=$PARALLEL
  (( REQUIRED_SLOTS <= ${#SELECTED[@]} )) || REQUIRED_SLOTS=${#SELECTED[@]}
  (( REQUIRED_SLOTS <= MODEL_SLOTS )) || {
    echo "--parallel requires $REQUIRED_SLOTS model slots; $MODEL has $MODEL_SLOTS" >&2
    exit 2
  }
fi

DATE=$(date -u +%Y-%m-%d)
REPORT_MODEL=${MODEL//\//-}
run_task() {
  local label=$1 task=$2 start_stamp run_base suffix
  start_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if [[ "$SUITE" == hard ]]; then
    RUN_DIR="$BUNDLE_DIR/$label"
    REPORT="$RUN_DIR/report.md"
  else
    RUN_DIR="$ROOT/temp/evaluate/$start_stamp"
    if [[ -e "$RUN_DIR" ]]; then RUN_DIR="$RUN_DIR-$$"; fi
    run_base="$ROOT/docs/audits/$DATE-agent-compare-$REPORT_MODEL"
    REPORT="$run_base.md"
    if [[ -e "$REPORT" ]]; then
      REPORT="$run_base-$start_stamp.md"
      suffix=2
      while [[ -e "$REPORT" ]]; do
        REPORT="$run_base-$start_stamp-$suffix.md"
        ((suffix += 1))
      done
    fi
  fi
  mkdir -p "$RUN_DIR"
  chmod 700 "$RUN_DIR"
  PROMPT="$task

Work only in the current directory. Create the files needed for the task. Do not ask questions."
  printf '%s\n' "$PROMPT" >"$RUN_DIR/prompt.txt"

  local index=0
  while (( index < ${#SELECTED[@]} )); do
    local -a pids=()
    local batch_end=$((index + PARALLEL))
    (( batch_end <= ${#SELECTED[@]} )) || batch_end=${#SELECTED[@]}
    for ((; index < batch_end; index++)); do
      if (( PARALLEL == 1 )); then
        run_agent "${SELECTED[$index]}"
      else
        run_agent "${SELECTED[$index]}" &
        pids+=("$!")
      fi
    done
    if (( PARALLEL > 1 )); then
      for pid in "${pids[@]}"; do
        if ! wait "$pid"; then echo "agent runner $pid failed before recording its result" >&2; fi
      done
    fi
  done

  python3 "$ROOT/scripts/evaluate/summarize.py" --run-dir "$RUN_DIR" --model "$MODEL" --wire "$WIRE" --task "$task" --agents "$AGENTS" --thinking "$THINKING" --parallel "$PARALLEL" --report "$REPORT"
}

if [[ "$SUITE" == hard ]]; then
  HARD_LABELS=(kanban-board monthly-event-calendar personal-finance-dashboard)
  HARD_TASKS=(
    'Hard: Build a polished responsive Kanban project board as index.html, style.css, and app.js using vanilla JavaScript only. Start with Backlog, In Progress, and Done columns. Support creating, editing, and deleting cards with title, description, priority, and due date; searching by text; filtering by priority; and moving cards between columns by drag and drop. Provide keyboard-accessible move controls as an alternative to dragging, visible focus styles, empty states, and per-column task counts. Save and restore all board data in localStorage, handle invalid stored data safely, and make the layout usable on a phone. No external dependencies.'
    'Hard: Build a polished, responsive monthly event calendar as index.html, style.css, and app.js using vanilla JavaScript only. Provide previous/next month and Today controls, a seven-column month grid with adjacent-month dates, and a mobile-friendly agenda view. Let users create, edit, and delete events with title, date, start/end time, category, and notes; validate required fields and time ranges. Selecting a date should offer event creation, and selecting an event should open its details for editing. Include category filters, clear empty states, keyboard navigation for calendar dates, accessible dialogs and labels, visible focus styles, and localStorage persistence with safe recovery from invalid stored data. No external dependencies.'
    'Hard: Build a polished responsive personal finance dashboard as index.html, style.css, and app.js using vanilla JavaScript only. Support income and expense transactions with amount, date, category, and note; create, edit, and delete transactions; and filter/search by month, type, and category. Show monthly income, expenses, and net balance, plus a category spending breakdown and a six-month trend chart rendered with inline SVG or CSS. Let users set monthly spending budgets by category and show progress with clear over-budget states. Include useful empty states, accessible forms and labels, keyboard focus styles, sensible currency/date formatting, and localStorage persistence with safe recovery from invalid stored data. Make the layout usable on a phone. No external dependencies.'
  )
  AUDIT_ROOT=${OUTPUT_ROOT:-"$ROOT/docs/audits"}
  BUNDLE_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  BUNDLE_DIR="$AUDIT_ROOT/$DATE-agent-compare-$REPORT_MODEL-hard-$BUNDLE_STAMP"
  if [[ -e "$BUNDLE_DIR" ]]; then BUNDLE_DIR="$BUNDLE_DIR-$$"; fi
  mkdir -p "$BUNDLE_DIR"
  chmod 700 "$BUNDLE_DIR"
  for index in "${!HARD_LABELS[@]}"; do
    echo "Running hard prompt: ${HARD_LABELS[$index]}" >&2
    run_task "${HARD_LABELS[$index]}" "${HARD_TASKS[$index]}"
  done
  python3 - "$BUNDLE_DIR" "$MODEL" "$WIRE" "$AGENTS" "$THINKING" "$PARALLEL" <<'PY'
import os
import sys
from pathlib import Path

bundle = Path(sys.argv[1])
model, wire, agents, thinking, parallel = sys.argv[2:]
agent_names = agents.split(",")
prompts = [
    ("kanban-board", "Kanban board"),
    ("monthly-event-calendar", "Monthly event calendar"),
    ("personal-finance-dashboard", "Personal finance dashboard"),
]
lines = [
    f"# Hard prompt evaluation: {model}",
    "",
    f"Model: `{wire}` via OpenRouter/configured OpenAI-compatible endpoint  ",
    f"Agents: {', '.join(agent_names)}  ",
    f"Reasoning: `{thinking}`; parallel harness limit per prompt: `{parallel}`; per-agent timeout applies.",
    "",
    "Each prompt folder contains the exact prompt, per-agent workdirs, raw stdout/stderr, and its detailed report.",
    "Exit status and file counts are process/output measures; they do not independently verify feature correctness.",
    "",
    "| Hard prompt | " + " | ".join(agent_names) + " | Detailed report |",
    "| --- | " + " | ".join("---:" for _ in agent_names) + " | --- |",
]
for slug, title in prompts:
    cells = []
    for agent in agent_names:
        directory = bundle / slug / agent
        try:
            exit_code = (directory / "exit-code.txt").read_text().strip()
        except OSError:
            exit_code = "missing"
        workdir = directory / "workdir"
        count = 0
        for parent, dirs, names in os.walk(workdir):
            base = Path(parent)
            dirs[:] = [name for name in dirs if name not in {".git", "node_modules"}
                       and not (base / name).is_symlink()]
            count += sum((base / name).is_file() and not (base / name).is_symlink() for name in names)
        cells.append(f"exit {exit_code} / {count} files")
    lines.append(f"| {title} | " + " | ".join(cells) + f" | [report]({slug}/report.md) |")
lines += ["", "All reports and outputs for this batch are stored in this folder.", ""]
(bundle / "report.md").write_text("\n".join(lines))
print(bundle / "report.md")
PY
else
  run_task single "$TASK"
fi
