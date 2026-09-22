#!/usr/bin/env bash
set -euo pipefail

find_api_key() {
  if [[ -n "${LLAMA_API_KEY:-}" ]]; then
    API_KEY=$LLAMA_API_KEY
  elif [[ -r "$HOME/.config/llama/api_key" ]]; then
    API_KEY=$(<"$HOME/.config/llama/api_key")
  elif [[ -r "$HOME/.cook/bonsai_api_key" ]]; then
    API_KEY=$(<"$HOME/.cook/bonsai_api_key")
  else
    echo "No llama API key found (LLAMA_API_KEY, ~/.config/llama/api_key, ~/.cook/bonsai_api_key)" >&2
    return 1
  fi
  export API_KEY
}

start_model() {
  find_api_key
  echo "model.sh start will stop anything else bound to port 8080" >&2
  "$MODEL_SH" start "$MODEL"
  local attempt body
  for attempt in $(seq 1 180); do
    body=$(curl -fsS --max-time 2 -H "Authorization: Bearer $API_KEY" "$BASE_URL/models" 2>/dev/null || true)
    if [[ -n "$body" ]] && python3 -c 'import json,sys; d=json.load(sys.stdin); w=sys.argv[1]; raise SystemExit(0 if any(x.get("id")==w for x in d.get("data",[])) else 1)' "$WIRE" <<<"$body"; then
      echo "model ready: $WIRE" >&2
      return 0
    fi
    sleep 2
  done
  echo "model did not become ready within 360 seconds" >&2
  return 1
}

stop_model() {
  "$MODEL_SH" stop "$MODEL" >/dev/null 2>&1 || true
}
