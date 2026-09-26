#!/usr/bin/env bash
# Local model discovery and isolated authentication.

ensure_model() {
if [[ -n "${LLAMA_API_KEY:-}" ]]; then
  API_KEY=$LLAMA_API_KEY
elif [[ -r "$HOME/.config/llama/api_key" ]]; then
  API_KEY=$(<"$HOME/.config/llama/api_key")
elif [[ -r "$HOME/.cook/bonsai_api_key" ]]; then
  API_KEY=$(<"$HOME/.cook/bonsai_api_key")
else
  echo "No llama API key found" >&2; exit 2
fi
export LLAMA_API_KEY="$API_KEY"

model_ids() {
  curl -fsS --max-time 3 -H "Authorization: Bearer $API_KEY" "$BASE_URL/models" 2>/dev/null |
    python3 -c 'import json,sys; print("\n".join(x["id"] for x in json.load(sys.stdin).get("data",[]) if isinstance(x.get("id"),str)))' 2>/dev/null || true
}
EXPECTED=${MODEL%-*}
[[ "$EXPECTED" != "$MODEL" ]] || EXPECTED=$MODEL
IDS=$(model_ids)
if [[ "$IDS" != "$MODEL" && "$IDS" != "$EXPECTED" ]]; then
  echo "Starting $MODEL via model.sh (port 8080 may switch models)" >&2
  "$MODEL_SH" start "$MODEL" >&2
  for ((attempt=0; attempt<180; attempt++)); do
    IDS=$(model_ids)
    [[ -n "$IDS" ]] && break
    sleep 2
  done
fi
WIRE=$(python3 - "$MODEL" "$EXPECTED" "$IDS" <<'PY'
import sys
model, expected, raw = sys.argv[1:]
ids = raw.splitlines()
if len(ids) == 1 and ids[0] in (model, expected):
    print(ids[0])
elif model in ids:
    print(model)
elif expected in ids:
    print(expected)
else:
    raise SystemExit("requested model is not served on port 8080: " + repr(ids))
PY
)
echo "Using wire model $WIRE" >&2
}

model_context_window() {
python3 - "$MODEL" <<'PY'
import json,sys
try:
    data=json.load(open('/home/thanh/models/config.json'))
    model=data['models'][sys.argv[1]]
    print(int(model.get('context',data.get('context_default',32768))))
except (OSError,KeyError,ValueError,TypeError):
    print(32768)
PY
}
