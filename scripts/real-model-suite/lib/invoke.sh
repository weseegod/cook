#!/usr/bin/env bash
set -euo pipefail

invoke_cook() {
  local case_dir=$1 home=$2 workdir=$3 prompt=$4 timeout_secs=$5 permission=$6 allow_json=$7 deny_json=$8 extra_json=$9
  shift 9
  local -a cmd=("$COOK_BIN")
  if [[ -n "$prompt" ]]; then cmd+=(-p "$prompt"); fi
  cmd+=(-m "$MODEL_KEY")
  while IFS= read -r item; do [[ -n "$item" ]] && cmd+=(--allow "$item"); done < <(python3 -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "$allow_json")
  while IFS= read -r item; do [[ -n "$item" ]] && cmd+=(--deny "$item"); done < <(python3 -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "$deny_json")
  if [[ "$permission" == approve ]]; then cmd+=(--always-approve); else cmd+=(--permission-mode dontAsk); fi
  while IFS= read -r item; do [[ -n "$item" ]] && cmd+=("$item"); done < <(python3 -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "$extra_json")
  cmd+=(--cwd "$workdir")
  if [[ ! " ${cmd[*]} " =~ " --max-turns " ]]; then cmd+=(--max-turns "$MAX_TURNS"); fi
  if [[ ! " ${cmd[*]} " =~ " --output-format " ]]; then cmd+=(--output-format json); fi
  set +e
  # GROK_WORKFLOWS=0 keeps the legacy model-facing update_goal tool (default-on
  # workflows strip GoalUpdate). Other cases keep their default driver.
  COOK_HOME="$home" GROK_LOG_FILE="$case_dir/wire.log" RUST_LOG="info,xai_grok_shell=debug,xai_grok_sampler=debug" \
    timeout --signal=TERM --kill-after=10 "$timeout_secs" "${cmd[@]}" >"$case_dir/stdout.json" 2>"$case_dir/stderr.log" &
  INVOKE_PID=$!
  wait "$INVOKE_PID"
  INVOKE_RC=$?
  INVOKE_PID=
  set -e
  printf '%s\n' "$INVOKE_RC" >"$case_dir/exit-code.txt"
  return 0
}
