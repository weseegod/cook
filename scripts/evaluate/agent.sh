#!/usr/bin/env bash
# Per-agent configuration, invocation, and artifacts.

run_agent() {
  local agent=$1 dir="$RUN_DIR/$1" start end rc
  mkdir -p "$dir/workdir" "$dir/home"
  git -C "$dir/workdir" init -q
  case "$agent" in
    cook)
      mkdir -p "$dir/home/cook"
      COOK_HOME="$dir/home/cook"
      export COOK_HOME
      MODEL="$MODEL" WIRE="$WIRE" BASE_URL="$BASE_URL" \
        CONTEXT_WINDOW="$CONTEXT_WINDOW" python3 - <<'PY' >"$dir/home/cook/config.toml"
import os
print(f'''[model."local/{os.environ["MODEL"]}"]
model = "{os.environ["WIRE"]}"
model_provider = "local"
name = "local evaluation"
input = ["text"]
context_window = {os.environ["CONTEXT_WINDOW"]}
max_completion_tokens = 8192
supports_reasoning_effort = false

[model_providers.local]
base_url = "{os.environ["BASE_URL"]}"
api_key = "{os.environ["LLAMA_API_KEY"]}"
api_backend = "chat_completions"

[privacy]
privacy_banner_acked = "2026-01-01T00:00:00Z"

[consent.answers.aup]
version = 2
account = "evaluate@example.com"

[consent.answers.tos]
version = 2''')
PY
      chmod 600 "$dir/home/cook/config.toml"
      local -a cook_flags=()
      if "$COOK_BIN" --help 2>/dev/null | grep -q -- '--no-auto-update'; then cook_flags+=(--no-auto-update); fi
      cmd=("$COOK_BIN" -p "$PROMPT" -m "local/$MODEL" --cwd "$dir/workdir" --output-format json --always-approve --max-turns 80 "${cook_flags[@]}")
      ;;
    opencode)
      mkdir -p "$dir/home/xdg-data" "$dir/home/xdg-state" "$dir/home/xdg-cache"
      OPENCODE_CONFIG_CONTENT=$(python3 - "$WIRE" "$BASE_URL" <<'PY'
import json,sys
wire, base=sys.argv[1:]
print(json.dumps({"$schema":"https://opencode.ai/config.json", "provider":{"llama.cpp":{
  "npm":"@ai-sdk/openai-compatible", "name":"Local llama.cpp", "options":{"baseURL":base,"apiKey":"{env:LLAMA_API_KEY}"},
  "models":{wire:{"name":wire}}}}}))
PY
)
      export OPENCODE_CONFIG_CONTENT OPENCODE_DISABLE_AUTOUPDATE=1
      export XDG_DATA_HOME="$dir/home/xdg-data" XDG_STATE_HOME="$dir/home/xdg-state" XDG_CACHE_HOME="$dir/home/xdg-cache"
      cmd=("$OPENCODE_BIN" run --standalone --auto --format json --model "llama.cpp/$WIRE" "$PROMPT")
      ;;
    pi)
      mkdir -p "$dir/home/pi"
      PI_CODING_AGENT_DIR="$dir/home/pi"
      export PI_CODING_AGENT_DIR
      python3 - "$WIRE" "$BASE_URL" <<'PY' >"$PI_CODING_AGENT_DIR/models.json"
import json,sys
wire,base=sys.argv[1:]
print(json.dumps({"providers":{"local":{"baseUrl":base,"api":"openai-completions","apiKey":"$LLAMA_API_KEY",
  "models":[{"id":wire,"name":wire,"contextWindow":32768,"maxTokens":8192}]}}}))
PY
      chmod 600 "$PI_CODING_AGENT_DIR/models.json"
      cmd=("$PI_BIN" --mode json -p --provider local --model "$WIRE" "$PROMPT")
      ;;
  esac
  echo "Running $agent" >&2
  start=$(date +%s.%N)
  set +e
  (cd "$dir/workdir" && timeout --signal=TERM --kill-after=10 "$TIMEOUT" "${cmd[@]}") >"$dir/stdout.json" 2>"$dir/stderr.log"
  rc=$?
  set -e
  end=$(date +%s.%N)
  python3 - "$start" "$end" <<'PY' >"$dir/elapsed-seconds.txt"
import sys
print(max(0.0,float(sys.argv[2])-float(sys.argv[1])))
PY
  printf '%s\n' "$rc" >"$dir/exit-code.txt"
  echo "$agent exited $rc" >&2
  unset COOK_HOME OPENCODE_CONFIG_CONTENT XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME PI_CODING_AGENT_DIR || true
}
