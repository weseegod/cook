#!/usr/bin/env bash
# Per-agent configuration, invocation, and artifacts.

run_with_timeout() {
  local seconds=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM --kill-after=10 "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout --signal=TERM --kill-after=10 "$seconds" "$@"
  else
    python3 - "$seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

seconds = int(sys.argv[1])
process = subprocess.Popen(sys.argv[2:], start_new_session=True)

def kill_child(sig):
    try:
        os.killpg(process.pid, sig)
    except ProcessLookupError:
        pass

def on_signal(signum, _frame):
    # Forward cancel/timeout signals into the agent session so Ctrl-C on the
    # evaluate harness cannot leave cook/opencode/pi running detached.
    kill_child(signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        kill_child(signal.SIGKILL)
        process.wait()
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)
try:
    result = process.wait(timeout=seconds)
except subprocess.TimeoutExpired:
    kill_child(signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        kill_child(signal.SIGKILL)
        process.wait()
    raise SystemExit(124)
raise SystemExit(result)
PY
  fi
}

prepare_workdir() {
  local dir="$RUN_DIR/$1"
  mkdir -p "$dir/workdir" "$dir/home"
  if [[ ! -e "$dir/workdir/.git" ]]; then
    git -C "$dir/workdir" init -q
  fi
}

# Seed named skills into an isolated COOK_HOME for cook/cook-main eval cells.
# EVAL_SKILLS=working-plan,bug-fix copies only those skill dirs and writes skills.toml
# with inject=true and status.<name>=true. Sources, in order: EVAL_SKILLS_ROOT, $ROOT/skills,
# then ${GROK_HOME:-$HOME/.cook}/skills. Empty/unset EVAL_SKILLS leaves the cell without skills.
seed_eval_skills() {
  local cook_home=$1
  local raw=${EVAL_SKILLS:-} skills_root name src dest status_lines=()
  raw=${raw//[[:space:]]/}
  [[ -n "$raw" ]] || return 0
  if [[ -n "${EVAL_SKILLS_ROOT:-}" ]]; then
    skills_root=$EVAL_SKILLS_ROOT
  elif [[ -n "${ROOT:-}" && -d "$ROOT/skills" ]]; then
    skills_root=$ROOT/skills
  else
    skills_root="${GROK_HOME:-${HOME}/.cook}/skills"
  fi
  [[ -d "$skills_root" ]] || {
    echo "EVAL_SKILLS set but skill root missing: $skills_root" >&2
    return 1
  }
  mkdir -p "$cook_home/skills"
  IFS=, read -r -a names <<<"$raw"
  for name in "${names[@]}"; do
    [[ -n "$name" ]] || continue
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
      echo "invalid EVAL_SKILLS name: $name" >&2
      return 1
    }
    src=$skills_root/$name
    [[ -f "$src/SKILL.md" ]] || {
      echo "EVAL_SKILLS skill not found (need $name/SKILL.md under $skills_root): $name" >&2
      return 1
    }
    dest=$cook_home/skills/$name
    rm -rf "$dest"
    cp -a "$src" "$dest"
    status_lines+=("$name = true")
  done
  {
    printf '%s\n' 'paths = []' 'ignore = []' 'server_skill_dirs = []' 'bundled_skill_dirs = []' 'inject = true' '' '[status]'
    printf '%s\n' "${status_lines[@]}"
  } >"$cook_home/skills.toml"
  printf '%s\n' "${EVAL_SKILLS:-}" >"$cook_home/eval-skills.txt"
}

run_agent() {
  local agent=$1 dir="$RUN_DIR/$1" start end rc effort pi_thinking agent_bin
  if [[ "$THINKING" == true ]]; then effort=medium; pi_thinking=medium; else effort=none; pi_thinking=off; fi
  prepare_workdir "$agent"
  case "$agent" in
    cook|cook-main)
      if [[ "$agent" == cook-main ]]; then agent_bin=${COOK_MAIN_BIN:-cook-main}; else agent_bin=$COOK_BIN; fi
      mkdir -p "$dir/home/cook"
      COOK_HOME="$dir/home/cook"
      export COOK_HOME
      MODEL="$MODEL" WIRE="$WIRE" BASE_URL="$BASE_URL" \
        CONTEXT_WINDOW="$CONTEXT_WINDOW" python3 - <<'PY' >"$dir/home/cook/config.toml"
import json
import os
import uuid

quote = json.dumps
base_url = os.environ["BASE_URL"]
# OpenCode Zen/Go rejects requests without x-opencode-session (routing).
extra_headers = ""
if "opencode.ai/zen" in base_url:
    session = f"cook-eval-{uuid.uuid4()}"
    extra_headers = f'\nextra_headers = {{ "x-opencode-session" = {quote(session)} }}'
print(f'''[model.{quote("local/" + os.environ["MODEL"])}]
model = {quote(os.environ["WIRE"])}
model_provider = "local"
name = "local evaluation"
input = ["text"]
context_window = {os.environ["CONTEXT_WINDOW"]}
max_completion_tokens = 8192
supports_reasoning_effort = true
reasoning_efforts = ["none", "medium"]

[model_providers.local]
base_url = {quote(base_url)}
api_key = {quote(os.environ["LLAMA_API_KEY"])}
api_backend = "chat_completions"{extra_headers}

[privacy]
privacy_banner_acked = "2026-01-01T00:00:00Z"

[consent.answers.aup]
version = 2
account = "evaluate@example.com"

[consent.answers.tos]
version = 2''')
PY
      chmod 600 "$dir/home/cook/config.toml"
      seed_eval_skills "$dir/home/cook"
      if "$agent_bin" --help 2>/dev/null | grep -q -- '--no-auto-update'; then
        cmd=("$agent_bin" -p "$PROMPT" -m "local/$MODEL" --cwd "$dir/workdir" --output-format json --always-approve --reasoning-effort "$effort" --no-auto-update)
      else
        cmd=("$agent_bin" -p "$PROMPT" -m "local/$MODEL" --cwd "$dir/workdir" --output-format json --always-approve --reasoning-effort "$effort")
      fi
      ;;
    opencode)
      mkdir -p "$dir/home/xdg-data" "$dir/home/xdg-state" "$dir/home/xdg-cache"
      OPENCODE_CONFIG_CONTENT=$(python3 - "$WIRE" "$BASE_URL" "$effort" <<'PY'
import json,sys
wire, base, effort=sys.argv[1:]
print(json.dumps({"$schema":"https://opencode.ai/config.json", "provider":{"evaluation":{
  "npm":"@ai-sdk/openai-compatible", "name":"Evaluation API", "options":{"baseURL":base,"apiKey":"{env:LLAMA_API_KEY}"},
  "models":{wire:{"name":wire,"options":{"reasoningEffort":effort}}}}}}))
PY
)
      export OPENCODE_CONFIG_CONTENT OPENCODE_DISABLE_AUTOUPDATE=1
      export XDG_DATA_HOME="$dir/home/xdg-data" XDG_STATE_HOME="$dir/home/xdg-state" XDG_CACHE_HOME="$dir/home/xdg-cache"
      cmd=("$OPENCODE_BIN" run --standalone --auto --format json --model "evaluation/$WIRE" "$PROMPT")
      ;;
    pi)
      mkdir -p "$dir/home/pi"
      PI_CODING_AGENT_DIR="$dir/home/pi"
      export PI_CODING_AGENT_DIR
      python3 - "$WIRE" "$BASE_URL" "$CONTEXT_WINDOW" <<'PY' >"$PI_CODING_AGENT_DIR/models.json"
import json,sys
wire,base,window=sys.argv[1:]
print(json.dumps({"providers":{"local":{"baseUrl":base,"api":"openai-completions","apiKey":"$LLAMA_API_KEY",
  "models":[{"id":wire,"name":wire,"reasoning":True,"thinkingLevelMap":{"off":"none"},
    "compat":{"supportsReasoningEffort":True},"contextWindow":int(window),"maxTokens":8192}]}}}))
PY
      chmod 600 "$PI_CODING_AGENT_DIR/models.json"
      cmd=("$PI_BIN" --mode json -p --provider local --model "$WIRE" --thinking "$pi_thinking" "$PROMPT")
      ;;
  esac
  echo "Running $agent" >&2
  start=$(python3 -c 'import time; print(time.time())')
  set +e
  (cd "$dir/workdir" && run_with_timeout "$TIMEOUT" "${cmd[@]}") >"$dir/stdout.json" 2>"$dir/stderr.log"
  rc=$?
  set -e
  end=$(python3 -c 'import time; print(time.time())')
  python3 - "$start" "$end" <<'PY' >"$dir/elapsed-seconds.txt"
import sys
print(max(0.0,float(sys.argv[2])-float(sys.argv[1])))
PY
  printf '%s\n' "$rc" >"$dir/exit-code.txt"
  echo "$agent exited $rc" >&2
  unset COOK_HOME OPENCODE_CONFIG_CONTENT XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME PI_CODING_AGENT_DIR || true
}

if [[ "${BASH_SOURCE[0]}" == "$0" && "${1:-}" == --self-test ]]; then
  set -euo pipefail
  RUN_DIR=$(mktemp -d)
  trap 'rm -rf "$RUN_DIR"' EXIT
  prepare_workdir existing
  git -C "$RUN_DIR/existing/workdir" -c user.name=test -c user.email=test@example.com commit --allow-empty -qm initial
  head=$(git -C "$RUN_DIR/existing/workdir" rev-parse HEAD)
  prepare_workdir existing
  [[ $(git -C "$RUN_DIR/existing/workdir" rev-parse HEAD) == "$head" ]]
  prepare_workdir empty
  [[ -d "$RUN_DIR/empty/workdir/.git" && -d "$RUN_DIR/empty/home" ]]
  skills_src=$(mktemp -d)
  mkdir -p "$skills_src/working-plan" "$skills_src/bug-fix"
  printf '%s\n' '---' 'name: working-plan' 'description: plan' '---' 'body' >"$skills_src/working-plan/SKILL.md"
  printf '%s\n' '---' 'name: bug-fix' 'description: fix' '---' 'body' >"$skills_src/bug-fix/SKILL.md"
  EVAL_SKILLS=working-plan,bug-fix EVAL_SKILLS_ROOT=$skills_src seed_eval_skills "$RUN_DIR/empty/home/cook"
  [[ -f "$RUN_DIR/empty/home/cook/skills/working-plan/SKILL.md" ]]
  [[ -f "$RUN_DIR/empty/home/cook/skills/bug-fix/SKILL.md" ]]
  grep -q 'working-plan = true' "$RUN_DIR/empty/home/cook/skills.toml"
  grep -q 'bug-fix = true' "$RUN_DIR/empty/home/cook/skills.toml"
  grep -q 'inject = true' "$RUN_DIR/empty/home/cook/skills.toml"
  [[ $(<"$RUN_DIR/empty/home/cook/eval-skills.txt") == working-plan,bug-fix ]]
  unset EVAL_SKILLS EVAL_SKILLS_ROOT
  seed_eval_skills "$RUN_DIR/empty/home/no-skills"
  [[ ! -e "$RUN_DIR/empty/home/no-skills/skills.toml" ]]
  rm -rf "$skills_src"
  echo 'agent self-test passed'
fi
