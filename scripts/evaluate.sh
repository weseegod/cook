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
--suite hard       run the 4 fixed evaluation prompts
--timeout SECONDS  per-agent timeout (default: 1800)
--agents LIST      comma-separated subset of cook,opencode,pi (default: cook,opencode,pi)
--thinking BOOL    enable reasoning for every agent (default: false for --task, true for --suite hard)
--parallel N        concurrent agent harnesses: 1, 2, or 3 (default: 1); suite runs share one pool
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

# Background harnesses do not receive Ctrl-C; track them and tear them down on
# cancel so agent processes cannot keep running after the script exits.
EVAL_CLEANING_UP=0
kill_tree() {
  local pid=$1 child
  # Recurse into children first so timeout wrappers can forward SIGTERM into
  # agent sessions created with start_new_session before we force-kill them.
  while read -r child; do
    [[ -n "$child" ]] && kill_tree "$child"
  done < <(pgrep -P "$pid" 2>/dev/null || true)
  kill "$pid" 2>/dev/null || true
}
cleanup_eval_children() {
  (( EVAL_CLEANING_UP )) && return 0
  EVAL_CLEANING_UP=1
  local pid
  local -a pids=()
  while read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(jobs -pr 2>/dev/null || true)
  ((${#pids[@]})) || return 0
  for pid in "${pids[@]}"; do
    kill_tree "$pid"
  done
  sleep 0.3
  for pid in "${pids[@]}"; do
    while read -r child; do
      [[ -n "$child" ]] && kill -9 "$child" 2>/dev/null || true
    done < <(pgrep -P "$pid" 2>/dev/null || true)
    kill -9 "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup_eval_children EXIT
trap 'exit 130' INT TERM HUP

source "$ROOT/scripts/evaluate/model.sh"
source "$ROOT/scripts/evaluate/agent.sh"
if [[ "$SUITE" == hard ]]; then
  if [[ -z "${EVAL_PARALLEL_SLOTS:-}" ]]; then
    EVAL_PARALLEL_SLOTS=$PARALLEL
    export EVAL_PARALLEL_SLOTS
  fi
fi
ensure_model
CONTEXT_WINDOW=$(model_context_window)
validate_parallel_slots() {
  local available_harnesses=$1
  (( PARALLEL > 1 )) || return 0
  MODEL_SLOTS=$(model_parallel_slots)
  REQUIRED_SLOTS=$PARALLEL
  (( REQUIRED_SLOTS <= available_harnesses )) || REQUIRED_SLOTS=$available_harnesses
  (( REQUIRED_SLOTS <= MODEL_SLOTS )) || {
    echo "--parallel requires $REQUIRED_SLOTS model slots; $MODEL has $MODEL_SLOTS" >&2
    exit 2
  }
}

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
EVAL_TASKS=(
  'Easy: Format converter across 3 files: index.html, style.css, app.js.
Main feature: paste data in one format and see it converted to the other formats, with a live rendered table.
Files: index.html holds the two panes and buttons, style.css the layout, app.js the parsing, conversion, and rendering.
Must run by opening index.html directly (file://) with no server and no build step. Plain scripts only: no type="module", no import/export, no npm, no CDN, no third-party libraries.
Must work:
- Left input pane with source format CSV, JSON, or Markdown table; right output pane with target format Markdown, CSV, JSON, or HTML.
- Typing or pasting re-parses and updates the output immediately.
- The HTML target shows a rendered table in the page, not markup text.
- Malformed input shows an inline error banner and keeps the last good output instead of crashing.
Buttons: Copy output, Clear, Load sample (sales table with date, product, quantity, price).
This is an automated run: implement the whole app and finish the task. Do not ask questions or wait for confirmation.'

  'Medium: Task kanban board across 4 files: index.html, style.css, app.js, storage.js.
Main feature: tasks sit in Backlog, In Progress, or Done, move between columns by drag-and-drop or keyboard, and the board survives a reload.
Files: index.html markup and task modal, style.css columns and cards, app.js UI and interaction, storage.js load, save, and sample-data fallback.
Must run by opening index.html directly (file://) with no server and no build step. Plain scripts only: no type="module", no import/export, no npm, no CDN, no third-party libraries.
Must work:
- Create a task in a modal: title required, description, category tag, priority Low/Medium/High, due date.
- Three columns with live card counts and an empty state each.
- Drag a card to another column and drop it; the target column highlights while dragging.
- Keyboard move: focus a card and press ArrowLeft or ArrowRight to change column.
- Text search plus a priority filter narrow the visible cards.
Nice to have: storage.js restores sample tasks when stored data is missing or corrupt.
This is an automated run: implement and test the whole app and finish the task. Do not ask questions or wait for confirmation.'

  'Hard: Flappy Bird canvas game across 5 files: index.html, css/style.css, js/entities.js, js/engine.js, js/main.js.
Main feature: a playable one-button canvas game: flap to stay alive, pass pipes for score, a crash ends the run, restart and try again.
Files: index.html screens and canvas, css/style.css layout, js/entities.js bird and pipe, js/engine.js loop, physics, collision, score, js/main.js DOM wiring and input.
Must run by opening index.html directly (file://) with no server and no build step. Plain scripts loaded in order entities.js, engine.js, main.js: no type="module", no import/export, no npm, no CDN, no third-party libraries.
Must work:
- Spacebar and click flap; a touch tap flaps and does not scroll the page.
- Bird falls with gravity, jumps on flap, and tilts with vertical velocity.
- Pipes scroll in from the right with a random gap; passing a pipe adds 1 to the score.
- Hitting a pipe or the ground ends the run and shows game over with the score.
- Start screen with a play button; restart from game over; top-10 high scores kept in localStorage with a safe fallback.
Nice to have: pause overlay.
This is an automated run: implement and test the whole app and finish the task. Do not ask questions or wait for confirmation'

  'Very hard: Vector flowchart editor across 8 files: index.html, css/main.css, css/toolbar.css, js/shapes.js, js/history.js, js/canvas.js, js/export.js, js/app.js.
Main feature: build a small diagram on a canvas: insert shapes, connect them with lines, drag to rearrange, undo mistakes, export the result.
Files: index.html editor shell and dialogs, css/main.css canvas and inspector, css/toolbar.css toolbar, js/shapes.js shape geometry and hit testing, js/history.js undo and redo stack, js/canvas.js rendering, pan, zoom, pointer events, js/export.js PNG and SVG export, js/app.js toolbar, inspector, dialogs, keyboard, theme, autosave.
Must run by opening index.html directly (file://) with no server and no build step. Plain scripts loaded in order shapes.js, history.js, canvas.js, export.js, app.js: no type="module", no import/export, no npm, no CDN, no third-party libraries.
Must work:
- Insert rectangle, diamond, ellipse, and text nodes from the toolbar; drag to move, handles to resize, Delete key to remove.
- Connector lines snap between node connection points and stay attached when nodes move.
- Inspector edits stroke color, fill color, line width, and font size of the selected node.
- Undo and redo cover insert, move, resize, delete, and connector changes across multiple steps.
- Pan by dragging empty canvas, zoom with buttons or Ctrl+wheel, grid snapping toggle.
- Export the diagram as PNG and as SVG.
Nice to have: localStorage autosave with recovery from malformed data, visible keyboard focus.
This is an automated run: implement and test the whole app and finish the task. Do not ask questions or wait for confirmation'
)
  ((${#EVAL_TASKS[@]} > 0)) || { echo "hard suite has no prompts" >&2; exit 2; }
  validate_parallel_slots "$(( ${#EVAL_TASKS[@]} * ${#SELECTED[@]} ))"

  # Use the task's short title as its output folder name so the prompt list is
  # the only per-prompt structure that needs editing when the suite changes.
  task_label() {
    local title=$1 label
    title=${title#*: }
    title=${title#Build a polished, responsive }
    title=${title#Build a polished responsive }
    title=${title#Build a responsive }
    title=${title#Build }
    title=${title%% app as *}
    title=${title%% as *}
    title=${title%% across *}
    title=${title%% using *}
    label=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-|-$//g; s/-+/-/g')
    [[ -n "$label" ]] || label=prompt
    printf '%s' "$label"
  }
  HARD_LABELS=()
  HARD_LABELS_SEEN='|'
  for index in "${!EVAL_TASKS[@]}"; do
    label=$(task_label "${EVAL_TASKS[$index]}")
    # Keep output folders distinct even when two prompts share a title.
    base_label=$label
    suffix=$((index + 1))
    while [[ "$HARD_LABELS_SEEN" == *"|$label|"* ]]; do
      label="$base_label-$suffix"
      ((suffix += 1))
    done
    HARD_LABELS+=("$label")
    HARD_LABELS_SEEN+="$label|"
  done

  run_hard_harness() (
    local label=$1 task=$2 agent=$3
    RUN_DIR="$BUNDLE_DIR/$label"
    PROMPT="$task

Work only in the current directory. Create the files needed for the task. Do not ask questions."
    run_agent "$agent"
  )

  run_hard_suite() {
    local prompt_index agent_index next=0 active_count=0 completed
    local label task agent run_dir report pid slot
    local -a queue_prompts=() queue_agents=() active_pids=()
    local total=$(( ${#HARD_LABELS[@]} * ${#SELECTED[@]} ))

    # Prepare every prompt directory before any harness starts.
    for prompt_index in "${!HARD_LABELS[@]}"; do
      label=${HARD_LABELS[$prompt_index]}
      task=${EVAL_TASKS[$prompt_index]}
      run_dir="$BUNDLE_DIR/$label"
      mkdir -p "$run_dir"
      chmod 700 "$run_dir"
      printf '%s\n' "$task"$'\n\n'"Work only in the current directory. Create the files needed for the task. Do not ask questions." >"$run_dir/prompt.txt"
      for agent_index in "${!SELECTED[@]}"; do
        queue_prompts+=("$prompt_index")
        queue_agents+=("$agent_index")
      done
    done

    # Keep the pool full across prompt boundaries: each completed harness frees
    # a slot for the next queued prompt-agent pair immediately.
    while (( next < total || active_count > 0 )); do
      while (( next < total && active_count < PARALLEL )); do
        prompt_index=${queue_prompts[$next]}
        agent_index=${queue_agents[$next]}
        label=${HARD_LABELS[$prompt_index]}
        task=${EVAL_TASKS[$prompt_index]}
        agent=${SELECTED[$agent_index]}
        echo "Running hard prompt: $label ($agent)" >&2
        run_hard_harness "$label" "$task" "$agent" &
        active_pids[$next]=$!
        ((active_count += 1))
        ((next += 1))
      done

      if (( active_count > 0 )); then
        completed=false
        for slot in "${!active_pids[@]}"; do
          pid=${active_pids[$slot]}
          if ! kill -0 "$pid" 2>/dev/null; then
            if ! wait "$pid"; then
              echo "agent runner $pid failed before recording its result" >&2
            fi
            unset "active_pids[$slot]"
            active_count=$((active_count - 1))
            completed=true
            break
          fi
        done
        [[ "$completed" == true ]] || sleep 0.1
      fi
    done

    # Reports need all selected agents for a prompt, so summarize after the
    # shared pool drains while retaining per-prompt reports and artifacts.
    for prompt_index in "${!HARD_LABELS[@]}"; do
      label=${HARD_LABELS[$prompt_index]}
      task=${EVAL_TASKS[$prompt_index]}
      run_dir="$BUNDLE_DIR/$label"
      report="$run_dir/report.md"
      python3 "$ROOT/scripts/evaluate/summarize.py" --run-dir "$run_dir" --model "$MODEL" --wire "$WIRE" --task "$task" --agents "$AGENTS" --thinking "$THINKING" --parallel "$PARALLEL" --report "$report"
    done
  }

  AUDIT_ROOT=${OUTPUT_ROOT:-"$ROOT/docs/audits"}
  BUNDLE_STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  BUNDLE_DIR="$AUDIT_ROOT/$DATE-agent-compare-$REPORT_MODEL-hard-$BUNDLE_STAMP"
  if [[ -e "$BUNDLE_DIR" ]]; then BUNDLE_DIR="$BUNDLE_DIR-$$"; fi
  mkdir -p "$BUNDLE_DIR"
  chmod 700 "$BUNDLE_DIR"
  run_hard_suite
  python3 - "$BUNDLE_DIR" "$MODEL" "$WIRE" "$AGENTS" "$THINKING" "$PARALLEL" "${HARD_LABELS[@]}" <<'PY'
import os
import sys
from pathlib import Path

bundle = Path(sys.argv[1])
model, wire, agents, thinking, parallel = sys.argv[2:7]
prompt_slugs = sys.argv[7:]
agent_names = agents.split(",")
prompts = [(slug, slug.replace("-", " ").title()) for slug in prompt_slugs]
lines = [
    f"# Hard prompt evaluation: {model}",
    "",
    f"Model: `{wire}` via OpenRouter/configured OpenAI-compatible endpoint  ",
    f"Agents: {', '.join(agent_names)}  ",
    f"Reasoning: `{thinking}`; shared parallel harness limit across prompts: `{parallel}`; per-agent timeout applies.",
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
  validate_parallel_slots "${#SELECTED[@]}"
  run_task single "$TASK"
fi
