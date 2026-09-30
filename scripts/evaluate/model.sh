#!/usr/bin/env bash
# Resolve a model from Cook's provider config or use the local llama.cpp setup.

resolve_cook_model() {
python3 - "$MODEL" <<'PY'
import os
import json
import sys
import tomllib
from pathlib import Path

requested = sys.argv[1]
launcher_alias = requested.rsplit("-", 1)[0] if "-" in requested else requested
config_path = Path.home() / ".cook" / "config.toml"
try:
    config = tomllib.loads(config_path.read_text())
except (OSError, tomllib.TOMLDecodeError):
    config = {}

models = config.get("model", {})
model = models.get(requested)
if not isinstance(model, dict):
    matches = [value for value in models.values()
               if isinstance(value, dict) and value.get("model") == requested]
    if len(matches) == 1:
        model = matches[0]
    else:
        model = models.get(launcher_alias, {})
        if not isinstance(model, dict):
            model = {}
        if not model:
            matches = [value for value in models.values()
                       if isinstance(value, dict) and value.get("model") == launcher_alias]
            model = matches[0] if len(matches) == 1 else {}
provider = config.get("model_providers", {}).get(model.get("model_provider"), {})
if not isinstance(provider, dict):
    provider = {}
try:
    legacy = json.loads(Path(os.environ.get("MODEL_CONFIG", "/home/thanh/models/config.json")).read_text())
    legacy_model = legacy.get("models", {}).get(requested, {})
except (OSError, ValueError, TypeError):
    legacy = {}
    legacy_model = {}

def first(*values):
    return next((value for value in values if value not in (None, "")), "")

api_key = first(model.get("api_key"), provider.get("api_key"))
env_keys = first(model.get("env_key"), provider.get("env_key"))
if not api_key:
    for name in ([env_keys] if isinstance(env_keys, str) else env_keys or []):
        if isinstance(name, str) and os.environ.get(name):
            api_key = os.environ[name]
            break

fields = [
    first(model.get("base_url"), provider.get("base_url")),
    first(model.get("model"), requested),
    api_key if isinstance(api_key, str) else "",
    str(first(model.get("context_window"), legacy_model.get("context"), legacy.get("context_default"), 32768)),
    str(first(model.get("parallel"), provider.get("parallel"), legacy_model.get("parallel"), legacy.get("parallel_default"), 1)),
    first(model.get("api_backend"), provider.get("api_backend"), "chat_completions"),
    "true" if model else "false",
]
sys.stdout.buffer.write(b"\0".join(value.encode() for value in fields) + b"\0")
PY
}

is_loopback_url() {
python3 - "$1" <<'PY'
import sys
from urllib.parse import urlparse
host = (urlparse(sys.argv[1]).hostname or "").lower()
raise SystemExit(0 if host in ("localhost", "127.0.0.1", "::1") else 1)
PY
}

ensure_model() {
  local configured_base= configured_wire=$MODEL configured_key=
  local configured_context=32768 configured_slots=1
  local configured_backend=chat_completions model_was_configured=false
  local config_index=0 config_value
  while IFS= read -r -d '' config_value; do
    case "$config_index" in
      0) configured_base=$config_value ;;
      1) configured_wire=$config_value ;;
      2) configured_key=$config_value ;;
      3) configured_context=$config_value ;;
      4) configured_slots=$config_value ;;
      5) configured_backend=$config_value ;;
      6) model_was_configured=$config_value ;;
    esac
    config_index=$((config_index + 1))
  done < <(resolve_cook_model)

  if [[ -n "${EVAL_API_KEY:-}" ]]; then
    API_KEY=$EVAL_API_KEY
  elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
    API_KEY=$OPENAI_API_KEY
  elif [[ -n "$configured_key" ]]; then
    API_KEY=$configured_key
  elif [[ -n "${LLAMA_API_KEY:-}" ]]; then
    API_KEY=$LLAMA_API_KEY
  elif [[ -r "$HOME/.config/llama/api_key" ]]; then
    API_KEY=$(<"$HOME/.config/llama/api_key")
  elif [[ -r "$HOME/.cook/bonsai_api_key" ]]; then
    API_KEY=$(<"$HOME/.cook/bonsai_api_key")
  else
    API_KEY=
  fi
  export LLAMA_API_KEY="$API_KEY"

  if [[ -z "$BASE_URL" ]]; then
    BASE_URL=${configured_base:-http://127.0.0.1:8080/v1}
  fi
  WIRE=${EVAL_WIRE_MODEL:-$configured_wire}
  MODEL_CONTEXT_WINDOW=${EVAL_CONTEXT_WINDOW:-$configured_context}
  MODEL_SLOTS=${EVAL_PARALLEL_SLOTS:-$configured_slots}

  [[ "$configured_backend" == chat_completions ]] || {
    echo "evaluation agents currently require an OpenAI chat_completions provider (got $configured_backend)" >&2
    exit 2
  }
  [[ "$MODEL_CONTEXT_WINDOW" =~ ^[1-9][0-9]*$ ]] || {
    echo "EVAL_CONTEXT_WINDOW must be a positive integer" >&2
    exit 2
  }
  [[ "$MODEL_SLOTS" =~ ^[1-9][0-9]*$ ]] || {
    echo "EVAL_PARALLEL_SLOTS must be a positive integer" >&2
    exit 2
  }

  if is_loopback_url "$BASE_URL"; then
    local ids expected
    ids=$(curl -fsS --max-time 3 -H "Authorization: Bearer $API_KEY" "${BASE_URL%/}/models" 2>/dev/null |
      python3 -c 'import json,sys; print("\n".join(x["id"] for x in json.load(sys.stdin).get("data",[]) if isinstance(x.get("id"),str)))' 2>/dev/null || true)
    expected=${MODEL%-*}
    [[ "$expected" != "$MODEL" ]] || expected=$MODEL
    if [[ "$ids" != "$WIRE" && "$ids" != "$MODEL" && "$ids" != "$expected" ]]; then
      if [[ -x "$MODEL_SH" ]]; then
        echo "Starting $MODEL via model.sh (port 8080 may switch models)" >&2
        "$MODEL_SH" start "$MODEL" >&2
        for ((attempt=0; attempt<180; attempt++)); do
          ids=$(curl -fsS --max-time 3 -H "Authorization: Bearer $API_KEY" "${BASE_URL%/}/models" 2>/dev/null |
            python3 -c 'import json,sys; print("\n".join(x["id"] for x in json.load(sys.stdin).get("data",[]) if isinstance(x.get("id"),str)))' 2>/dev/null || true)
          [[ -n "$ids" ]] && break
          sleep 2
        done
      fi
      [[ "$ids" == "$WIRE" || "$ids" == "$MODEL" || "$ids" == "$expected" ]] || {
        echo "local API at $BASE_URL does not serve $WIRE" >&2
        [[ -x "$MODEL_SH" ]] || echo "MODEL_SH is not executable: $MODEL_SH" >&2
        exit 2
      }
    fi
    if [[ "$ids" == "$MODEL" || "$ids" == "$expected" ]]; then WIRE=$ids; fi
  elif [[ "$model_was_configured" != true && -z "$API_KEY" ]]; then
    echo "No API key resolved; set EVAL_API_KEY or configure api_key/env_key for $MODEL" >&2
    exit 2
  fi

  echo "Using model $WIRE at $BASE_URL" >&2
}

model_context_window() {
  local slots=${MODEL_SLOTS:-1}
  local per_agent=$((MODEL_CONTEXT_WINDOW / slots))
  echo $((per_agent > 0 ? per_agent : 1))
}

model_parallel_slots() {
  echo "${MODEL_SLOTS:-1}"
}
