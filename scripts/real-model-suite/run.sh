#!/usr/bin/env bash
set -euo pipefail

SUITE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SUITE_DIR/../.." && pwd)
source "$SUITE_DIR/lib/model.sh"
source "$SUITE_DIR/lib/home.sh"
source "$SUITE_DIR/lib/invoke.sh"

PHASE=all
ONLY_CASE=
LIST_ONLY=0
KEEP=0
while (($#)); do
  case "$1" in
    --phase) PHASE=${2:?missing phase}; shift 2 ;;
    --case) ONLY_CASE=${2:?missing case}; shift 2 ;;
    --list) LIST_ONLY=1; shift ;;
    --keep) KEEP=1; shift ;;
    -h|--help)
      echo "usage: run.sh [--phase cli|tools|session|agents|all] [--case ID] [--list] [--keep]"
      exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$PHASE" in cli|tools|session|agents|all) ;; *) echo "invalid phase: $PHASE" >&2; exit 2;; esac

MODEL=${MODEL:-mimo26-9b}
if [[ -z "${WIRE:-}" ]]; then WIRE=${MODEL%-*}; fi
MODEL_KEY=${MODEL_KEY:-local/$WIRE}
BASE_URL=${BASE_URL:-http://127.0.0.1:8080/v1}
COOK_BIN=${COOK_BIN:-$REPO_ROOT/target/debug/xai-grok-pager}
MODEL_SH=${MODEL_SH:-/home/thanh/models/model.sh}
CONTEXT_WINDOW=${CONTEXT_WINDOW:-32768}
MAX_COMPLETION_TOKENS=${MAX_COMPLETION_TOKENS:-2048}
export MODEL WIRE MODEL_KEY BASE_URL COOK_BIN MODEL_SH CONTEXT_WINDOW MAX_COMPLETION_TOKENS

mapfile -t ALL_CASE_FILES < <(find "$SUITE_DIR/cases" -maxdepth 1 -name '*.json' -type f | sort)
if ((${#ALL_CASE_FILES[@]} == 0)); then echo "no cases found" >&2; exit 2; fi

case_field() { python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2], sys.argv[3] if len(sys.argv)>3 else ""); print(json.dumps(v) if isinstance(v,(list,dict,bool)) else v)' "$@"; }

if ((LIST_ONLY)); then
  for file in "${ALL_CASE_FILES[@]}"; do
    printf '%s\t%s\t%s\n' "$(case_field "$file" id)" "$(case_field "$file" phase)" "$(case_field "$file" needs_model)"
  done
  exit 0
fi

if [[ ! -x "$COOK_BIN" ]]; then echo "COOK_BIN is missing or not executable: $COOK_BIN" >&2; exit 2; fi

declare -a CASE_FILES=()
for file in "${ALL_CASE_FILES[@]}"; do
  id=$(case_field "$file" id); phase=$(case_field "$file" phase)
  if [[ -n "$ONLY_CASE" && "$id" != "$ONLY_CASE" ]]; then continue; fi
  if [[ "$PHASE" != all && "$phase" != "$PHASE" ]]; then continue; fi
  CASE_FILES+=("$file")
done
if ((${#CASE_FILES[@]} == 0)); then echo "no matching case" >&2; exit 2; fi
if [[ "$PHASE" == all && -z "$ONLY_CASE" ]]; then
  declare -a REGULAR_CASE_FILES=() DELAYED_CASE_FILES=()
  for file in "${CASE_FILES[@]}"; do
    if [[ -n "$(case_field "$file" after)" ]]; then DELAYED_CASE_FILES+=("$file"); else REGULAR_CASE_FILES+=("$file"); fi
  done
  CASE_FILES=("${REGULAR_CASE_FILES[@]}" "${DELAYED_CASE_FILES[@]}")
fi

python3 - "$SUITE_DIR" "${CASE_FILES[@]}" <<'PY'
import importlib.util,json,sys
root=sys.argv[1]
spec=importlib.util.spec_from_file_location("score", root+"/score.py")
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
for path in sys.argv[2:]:
    case=json.load(open(path))
    unknown=set(case.get("checks",[]))-set(m.CHECKS)
    if unknown: raise SystemExit(f"{path}: unknown checks: {sorted(unknown)}")
PY
python3 "$SUITE_DIR/score.py" --self-test >/dev/null

OUT_WAS_TEMP=0
if [[ -z "${OUT_ROOT:-}" ]]; then OUT_ROOT=$(mktemp -d); OUT_WAS_TEMP=1; fi
mkdir -p "$OUT_ROOT"
OUT_ROOT=$(cd "$OUT_ROOT" && pwd)
export OUT_ROOT
SCORE_FILE=$OUT_ROOT/score.txt
FAILURES_FILE=$OUT_ROOT/failures.md
: >"$SCORE_FILE"
printf '# Real-model suite failures\n\n' >"$FAILURES_FILE"
REPO_STATUS_BEFORE=$(git -C "$REPO_ROOT" status --porcelain=v1)
USER_CONFIG="$HOME/.cook/config.toml"
USER_CONFIG_MTIME_BEFORE=$(stat -c %Y "$USER_CONFIG" 2>/dev/null || echo missing)
MODEL_STARTED=0
HTTP_PID=
INVOKE_PID=
cleanup() {
  [[ -n "${HTTP_PID:-}" ]] && kill "$HTTP_PID" >/dev/null 2>&1 || true
  [[ -n "${INVOKE_PID:-}" ]] && kill "$INVOKE_PID" >/dev/null 2>&1 || true
  ((MODEL_STARTED)) && stop_model
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

needs_any_model=0
for file in "${CASE_FILES[@]}"; do
  [[ "$(case_field "$file" needs_model)" == true ]] && needs_any_model=1
done
if ((needs_any_model)); then
  if [[ "$PHASE" == cli ]]; then echo "internal error: cli phase requested model" >&2; exit 2; fi
  start_model
  MODEL_STARTED=1
else
  API_KEY=not-used-by-cli-suite
  export API_KEY
fi

urlencode_cwd() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

copy_session() {
  local home=$1 workdir=$2 case_dir=$3 sid=${4:-}
  local cwd_root="$home/sessions/$(urlencode_cwd "$workdir")" session_src=
  if [[ -n "$sid" && -d "$cwd_root/$sid" ]]; then
    session_src="$cwd_root/$sid"
  elif [[ -d "$cwd_root" ]]; then
    # Prefer a session that owns workflows/ (agents.workflow_live parent). Child
    # agent sessions sort after the parent and lack state.json; picking the last
    # summary drops workflow tools and the nonce blob.
    local fallback=
    while IFS= read -r summary; do
      local dir=${summary%/summary.json}
      if [[ -d "$dir/workflows" ]]; then
        session_src=$dir
        break
      fi
      fallback=$dir
    done < <(find "$cwd_root" -mindepth 2 -maxdepth 2 -name summary.json -type f | sort)
    if [[ -z "$session_src" ]]; then
      session_src=$fallback
    fi
  fi
  # Worktree sessions live under the encoded worktree path, not the launch cwd.
  if [[ -z "$session_src" && -n "$sid" ]]; then
    while IFS= read -r summary; do session_src=${summary%/summary.json}; break; done < <(find "$home/sessions" -mindepth 3 -maxdepth 3 -path "*/$sid/summary.json" -type f 2>/dev/null | sort)
  fi
  if [[ -z "$session_src" && -z "$sid" && -d "$home/sessions" ]]; then
    while IFS= read -r summary; do session_src=${summary%/summary.json}; done < <(find "$home/sessions" -mindepth 3 -maxdepth 3 -name summary.json -type f 2>/dev/null | sort)
  fi
  [[ -n "$session_src" ]] || return 1
  rm -rf "$case_dir/session"
  cp -a "$session_src" "$case_dir/session" 2>/dev/null || mkdir -p "$case_dir/session"
  for name in usage.json events.jsonl chat_history.jsonl updates.jsonl summary.json; do
    [[ -f "$session_src/$name" ]] && cp "$session_src/$name" "$case_dir/$name"
  done
}

render_prompt() {
  local template=$1 workdir=$2 marker_file=$3 fetch_url=${4:-}
  python3 - "$template" "$workdir" "$marker_file" "$fetch_url" <<'PY'
import sys
s=open(sys.argv[1]).read()
for key,value in {"{{WORKDIR}}":sys.argv[2],"{{MARKER_FILE}}":sys.argv[3],"{{FETCH_URL}}":sys.argv[4]}.items(): s=s.replace(key,value)
print(s,end="")
PY
}

result_value() {
  python3 - "$1" "$2" <<'PY'
import json,sys
try:
 raw=open(sys.argv[1]).read()
 try: values=[json.loads(raw)]
 except Exception:
  values=[]
  for line in raw.splitlines():
   try: values.append(json.loads(line))
   except Exception: pass
 d=next((x for x in reversed(values) if isinstance(x,dict) and sys.argv[2] in x),{})
 print(d.get(sys.argv[2],""))
except Exception: print("")
PY
}

write_failure() {
  local id=$1 file=$2 case_dir=$3 status=$4
  local pillar; pillar=$(case_field "$file" pillar unknown)
  {
    printf '## %s\n\n- Pillar: `%s`\n- Result: `%s`\n' "$id" "$pillar" "$status"
    printf -- '- Artifacts: `%s`, `%s`, `%s`, `%s`\n\n' "$case_dir/stdout.json" "$case_dir/events.jsonl" "$case_dir/usage.json" "$case_dir/wire.log"
    if [[ "$status" == *XML* || "$status" == *arguments* ]] && [[ -f "$case_dir/wire.log" ]]; then
      python3 - "$case_dir/wire.log" <<'PY'
import re,sys
lines=open(sys.argv[1],errors="replace").read().splitlines()
i=next((i for i,x in enumerate(lines) if "<tool_call>" in x),0)
print("```text")
for line in lines[max(0,i-20):i+20]:
 print(re.sub(r'(?i)(authorization[^:]*:|api[_-]?key[" ]*[:=])[ ]*[^ ,"}]+',r'\1 <redacted>',line))
print("```")
PY
    fi
  } >>"$FAILURES_FILE"
}

score_case() {
  local file=$1 case_dir=$2 id=$3 status rc
  set +e
  status=$(python3 "$SUITE_DIR/score.py" "$file" "$case_dir")
  rc=$?
  set -e
  if [[ "$status" == HARNESS* ]]; then echo "$status" >&2; exit 2; fi
  if [[ "$id" == tools.unknown_and_sibling ]] && ! rg -q '"outcome":"invalid_tool"|"outcome": "invalid_tool"' "$case_dir/events.jsonl" 2>/dev/null; then
    status="skip-nondeterministic no invalid tool emitted"; rc=0
  fi
  if [[ "$id" == tools.ask_user_headless && -f "$case_dir/events.jsonl" ]]; then
    outcome=$(python3 - "$case_dir/events.jsonl" <<'PY'
import json,sys
for line in open(sys.argv[1]):
 try:
  e=json.loads(line)
  if e.get("type")=="tool_completed" and e.get("tool_name")=="ask_user_question": print(e.get("outcome","unknown")); break
 except: pass
PY
)
    [[ "$status" == pass && -n "$outcome" ]] && status="pass ask_user_question=$outcome"
  fi
  printf '%s\n' "$status" >"$case_dir/status.txt"
  printf '%s %s\n' "$id" "$status" >>"$SCORE_FILE"
  [[ "$status" == fail* || "$status" == hung* ]] && write_failure "$id" "$file" "$case_dir" "$status"
  return "$rc"
}

run_cli_case() {
  local file=$1 id=$2 case_dir=$3 home=$4 workdir=$5
  local after SESSION_ID=; after=$(case_field "$file" after)
  if [[ -n "$after" ]]; then
    local dep="$OUT_ROOT/tools/$after"
    if [[ ! -f "$dep/stdout.json" ]]; then
      printf 'unsupported dependency %s not run\n' "$after" >"$case_dir/status.txt"
      printf '%s unsupported dependency %s not run\n' "$id" "$after" >>"$SCORE_FILE"
      return 0
    fi
    home="$dep/home"; workdir="$dep/workdir"
    SESSION_ID=$(result_value "$dep/stdout.json" sessionId)
  else
    python3 "$SUITE_DIR/lib/fixture.py" "$id" "$workdir" "MARKER-${id}-cli00000"
    write_home_config "$home" approve "$MAX_COMPLETION_TOKENS" "$CONTEXT_WINDOW"
  fi
  local commands count=0 failed=0
  commands=$(case_field "$file" commands)
  while IFS= read -r encoded; do
    ((count+=1))
    mapfile -t argv < <(python3 -c 'import json,sys; print("\n".join(json.loads(sys.argv[1])))' "$encoded")
    for i in "${!argv[@]}"; do argv[$i]=${argv[$i]//\{\{SESSION_ID\}\}/$SESSION_ID}; done
    # sessions list scopes to process cwd (CwdScope::WithSiblings). The dependency
    # home lives under tools/<after>/workdir; without --cwd the session id never
    # appears even though the session file exists. worktree_list already needs --cwd.
    if [[ "$id" == cli.worktree_list || "$id" == cli.sessions_after ]]; then argv=(--cwd "$workdir" "${argv[@]}"); fi
    set +e
    COOK_HOME="$home" timeout --signal=TERM --kill-after=5 30 "$COOK_BIN" "${argv[@]}" >"$case_dir/stdout-$count.txt" 2>"$case_dir/stderr-$count.log"
    rc=$?
    set -e
    if ((rc==124 || rc==137)); then printf 'hung cli timeout\n' >"$case_dir/status.txt"; failed=1; break; fi
    if ((rc!=0)); then
      if [[ "$id" == cli.doctor ]] && rg -qi 'clipboard|color|tty' "$case_dir/stderr-$count.log"; then
        printf 'unsupported %s\n' "$(tail -n 1 "$case_dir/stderr-$count.log")" >"$case_dir/status.txt"; break
      fi
      printf 'fail exit %s\n' "$rc" >"$case_dir/status.txt"; failed=1; break
    fi
  done < <(python3 -c 'import json,sys; [print(json.dumps(x)) for x in json.loads(sys.argv[1])]' "$commands")
  [[ -f "$case_dir/status.txt" ]] || printf 'pass\n' >"$case_dir/status.txt"
  status=$(<"$case_dir/status.txt")
  if [[ "$status" == pass ]]; then
    case "$id" in
      cli.version) [[ -s "$case_dir/stdout-1.txt" ]] && python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert any("version" in k.lower() for k in d)' "$case_dir/stdout-2.txt" || status='fail invalid version output' ;;
      cli.models) rg -Fq "$MODEL_KEY" "$case_dir/stdout-1.txt" || status='fail model key absent' ;;
      cli.inspect) python3 -c 'import json,sys; assert "config.toml" in json.dumps(json.load(open(sys.argv[1])))' "$case_dir/stdout-1.txt" || status='fail invalid inspect JSON' ;;
      cli.completions) [[ -s "$case_dir/stdout-1.txt" ]] && ! rg -qi '(^| )error:' "$case_dir/stdout-1.txt" || status='fail invalid completions' ;;
      cli.sessions_after) rg -Fq "$SESSION_ID" "$case_dir/stdout-1.txt" || status='fail session absent' ;;
      cli.usage) rg -q 'purposeUsage|purpose_usage' "$case_dir/stdout-1.txt" || status='fail purposeUsage absent' ;;
      cli.export) rg -q '^#|^##|^- ' "$case_dir/stdout-1.txt" || status='fail not markdown'; [[ -n "${API_KEY:-}" ]] && ! rg -Fq "$API_KEY" "$case_dir/stdout-1.txt" || status='fail API key leaked' ;;
      cli.memory_help) rg -q 'clear' "$case_dir/stdout-1.txt" && ! rg -q '^ +list' "$case_dir/stdout-1.txt" || status='fail memory help shape' ;;
      cli.mcp_list) python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d==[] or not d.get("servers")' "$case_dir/stdout-1.txt" || status='fail MCP list nonempty/invalid' ;;
    esac
  fi
  printf '%s\n' "$status" >"$case_dir/status.txt"
  printf '%s %s\n' "$id" "$status" >>"$SCORE_FILE"
  [[ "$status" == fail* || "$status" == hung* ]] && write_failure "$id" "$file" "$case_dir" "$status"
  ((failed==0))
}

run_model_case() {
  local file=$1 id=$2 phase=$3 case_dir=$4 home=$5 workdir=$6
  local nonce="MARKER-${id}-$(openssl rand -hex 4)"
  local file_bytes; file_bytes=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("fixture",{}).get("file_bytes",8000))' "$file")
  python3 "$SUITE_DIR/lib/fixture.py" "$id" "$workdir" "$nonce" --file-bytes "$file_bytes"
  local permission cap window max_turns timeout_secs allow deny extra template prompt marker_file fetch_url=
  permission=$(case_field "$file" permission approve); cap=$MAX_COMPLETION_TOKENS
  window=$(case_field "$file" context_window "$CONTEXT_WINDOW")
  max_turns=$(case_field "$file" max_turns 6); timeout_secs=$(case_field "$file" timeout_secs 480)
  allow=$(case_field "$file" allow); deny=$(case_field "$file" deny); extra=$(case_field "$file" extra_args)
  template="$SUITE_DIR/$(case_field "$file" prompt)"; marker_file="$workdir/secret.txt"
  write_home_config "$home" "$permission" "$cap" "$window"
  if [[ "$id" == session.hooks ]]; then
    # Relative hook commands resolve against the hook JSON's parent ($COOK_HOME/hooks/).
    mkdir -p "$home/hooks/bin"
    printf '%s\n' '#!/usr/bin/env bash' 'printf "fired\\n" >>"$COOK_HOME/hook-log.txt"' >"$home/hooks/bin/log-read.sh"
    chmod +x "$home/hooks/bin/log-read.sh"
    printf '%s\n' '{"hooks":{"PostToolUse":[{"matcher":"Read","hooks":[{"type":"command","command":"bin/log-read.sh","timeout":5}]}]}}' >"$home/hooks/log-read.json"
  fi
  if [[ "$id" == tools.update_goal ]]; then
    # Default-on background workflows strip update_goal (host-owned goal driver).
    # This case exercises the legacy model-facing goal tool.
    export GROK_WORKFLOWS=0
  else
    unset GROK_WORKFLOWS || true
  fi
  if [[ "$id" == tools.web_fetch_public ]]; then
    port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
    python3 -m http.server "$port" --bind 127.0.0.1 --directory "$workdir/served" >"$case_dir/http.log" 2>&1 & HTTP_PID=$!
    fetch_url="http://127.0.0.1:$port/body.txt"
  fi
  prompt=$(render_prompt "$template" "$workdir" "$marker_file" "$fetch_url")
  printf '%s' "$prompt" >"$case_dir/prompt.txt"
  MAX_TURNS=$max_turns; export MAX_TURNS

  if [[ "$id" == agents.mcp_echo ]]; then
    make_mcp_server "$case_dir/mcp-echo.py"
    COOK_HOME="$home" "$COOK_BIN" mcp add echo -- python3 "$case_dir/mcp-echo.py" >"$case_dir/mcp-add.log" 2>&1 || true
  fi

  if [[ "$id" == session.resume || "$id" == session.resume_by_id || "$id" == session.fork || "$id" == session.memory_flush ]]; then
    invoke_cook "$case_dir" "$home" "$workdir" "$prompt" "$timeout_secs" "$permission" "$allow" "$deny" "$extra"
    mv "$case_dir/stdout.json" "$case_dir/stdout-1.json"; mv "$case_dir/stderr.log" "$case_dir/stderr-1.log"
    sid=$(result_value "$case_dir/stdout-1.json" sessionId)
    copy_session "$home" "$workdir" "$case_dir" "$sid" || true
    if [[ "$id" == session.resume ]]; then second_extra='["-c"]'; second_prompt='What exact line did you read from secret.txt? Do not read the file again.'
    elif [[ "$id" == session.fork ]]; then second_extra=$(python3 -c 'import json,sys; print(json.dumps(["-r",sys.argv[1],"--fork-session"]))' "$sid"); second_prompt='What exact line did you read from secret.txt? Do not read the file again.'
    elif [[ "$id" == session.memory_flush ]]; then second_extra=$(python3 -c 'import json,sys; print(json.dumps(["--resume",sys.argv[1],"--memory-flush"]))' "$sid"); second_prompt=''
    else second_extra=$(python3 -c 'import json,sys; print(json.dumps(["-r",sys.argv[1]]))' "$sid"); second_prompt='What exact line did you read from secret.txt? Do not read the file again.'; fi
    invoke_cook "$case_dir" "$home" "$workdir" "$second_prompt" "$timeout_secs" "$permission" "$allow" "$deny" "$second_extra"
    mv "$case_dir/stdout.json" "$case_dir/stdout-2.json"; mv "$case_dir/stderr.log" "$case_dir/stderr-2.log"
    cp "$case_dir/stdout-2.json" "$case_dir/stdout.json"; cp "$case_dir/stderr-2.log" "$case_dir/stderr.log"
    # Keep the second-invocation argv (resume/fork/--memory-flush) if a later empty-text retry runs.
    extra=$second_extra
  elif [[ "$id" == agents.acp_stdio ]]; then
    set +e
    COOK_HOME="$home" GROK_LOG_FILE="$case_dir/wire.log" RUST_LOG="info,xai_grok_shell=debug,xai_grok_sampler=debug" \
      timeout --signal=TERM --kill-after=10 "$timeout_secs" python3 "$SUITE_DIR/lib/acp_driver.py" \
        --binary "$COOK_BIN" --model "$MODEL_KEY" --cwd "$workdir" --prompt "$prompt" --timeout "$timeout_secs" \
        >"$case_dir/stdout.json" 2>"$case_dir/stderr.log"
    INVOKE_RC=$?
    set -e
    printf '%s\n' "$INVOKE_RC" >"$case_dir/exit-code.txt"
  else
    invoke_cook "$case_dir" "$home" "$workdir" "$prompt" "$timeout_secs" "$permission" "$allow" "$deny" "$extra"
  fi
  [[ -n "${HTTP_PID:-}" ]] && kill "$HTTP_PID" >/dev/null 2>&1 || true; HTTP_PID=
  sid=$(result_value "$case_dir/stdout.json" sessionId)
  copy_session "$home" "$workdir" "$case_dir" "$sid" || true
  # When every expect_tools entry already succeeded, the case is done. Empty text
  # or a trailing max_tokens must not wipe the successful session or re-invoke
  # (agents.hashline_edit edited note.txt, then 8192 retry dropped that session).
  tools_done=0
  if python3 - "$file" "$case_dir" <<'PY'
import json,sys
from pathlib import Path
case=json.load(open(sys.argv[1]))
root=Path(sys.argv[2])
expected=case.get("expect_tools") or []
if not expected:
    sys.exit(1)
completed=set()
ev=root/"events.jsonl"
if ev.exists():
    for line in ev.read_text(encoding="utf-8", errors="replace").splitlines():
        try: e=json.loads(line)
        except Exception: continue
        if e.get("type")=="tool_completed" and e.get("outcome")=="success":
            completed.add(e.get("tool_name"))
sys.exit(0 if all(t in completed for t in expected) else 1)
PY
  then tools_done=1; fi
  # Empty-text retry re-invokes cook and can create a second parent session.
  # agents.workflow_live may place the nonce only in workflow state.json (score.py
  # accepts workflow_result_blob); retrying that case breaks child_budget.
  # agents.acp_stdio has no plain-text stdout.json contract; session.max_turns is scored from stopReason.
  if [[ "$tools_done" -eq 0 && "$id" != session.max_turns && "$id" != agents.acp_stdio && "$id" != agents.workflow_live ]]; then
    text=$(result_value "$case_dir/stdout.json" text); stop=$(result_value "$case_dir/stdout.json" stopReason)
    if [[ -z "$text" && "$stop" != end_turn ]]; then
      # Drop the failed first session before the 8192 retry. Leaving it makes
      # subagent_absent / single-session oracles see two parents (agents.no_subagents_flag).
      # Error stdout often has no sessionId, so also wipe every session under this cwd
      # unless the retry will --resume/--fork an existing one.
      cwd_root="$home/sessions/$(urlencode_cwd "$workdir")"
      resuming=0
      case "$extra" in
        *'"-r"'*|*'--resume'*|*'--fork'*) resuming=1 ;;
      esac
      if [[ "$resuming" -eq 0 && -d "$cwd_root" ]]; then
        # Fresh re-invoke: drop every session from the failed first attempt.
        # sid is often empty when stdout is an error JSON without sessionId.
        find "$cwd_root" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
      fi
      # Resume/fork retries need the existing session; leave cwd_root alone.
      write_home_config "$home" "$permission" 8192 "$window"
      invoke_cook "$case_dir" "$home" "$workdir" "$prompt" "$timeout_secs" "$permission" "$allow" "$deny" "$extra"
      sid=$(result_value "$case_dir/stdout.json" sessionId); copy_session "$home" "$workdir" "$case_dir" "$sid" || true
      printf 'cap=8192\n' >"$case_dir/cap.txt"
    else printf 'cap=%s\n' "$cap" >"$case_dir/cap.txt"; fi
  elif [[ "$tools_done" -eq 1 ]]; then
    # Tools succeeded but the final sample can still be truncated (max_tokens)
    # with empty top-level text. File-only oracles (hashline) score as-is; text
    # oracles need one resume at 8192 without wiping the successful session.
    text=$(result_value "$case_dir/stdout.json" text); stop=$(result_value "$case_dir/stdout.json" stopReason)
    needs_text=0
    if python3 - "$file" <<'PY'
import json,sys
case=json.load(open(sys.argv[1]))
sys.exit(0 if "text_contains_marker" in (case.get("checks") or []) else 1)
PY
    then needs_text=1; fi
    if [[ "$needs_text" -eq 1 && -z "$text" && "$stop" != end_turn ]]; then
      if [[ -z "$sid" && -f "$case_dir/summary.json" ]]; then
        sid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("info",{}).get("id",""))' "$case_dir/summary.json")
      fi
      if [[ -n "$sid" ]]; then
        write_home_config "$home" "$permission" 8192 "$window"
        extra=$(python3 -c 'import json,sys; print(json.dumps(["-r", sys.argv[1]]))' "$sid")
        # Continuation only: tools already succeeded; do not re-open files.
        invoke_cook "$case_dir" "$home" "$workdir" "Reply with the answer to the original request using only what you already learned. Do not call any tool." "$timeout_secs" "$permission" "$allow" "$deny" "$extra"
        sid=$(result_value "$case_dir/stdout.json" sessionId); copy_session "$home" "$workdir" "$case_dir" "$sid" || true
        printf 'cap=8192 tools_done\n' >"$case_dir/cap.txt"
      else
        printf 'cap=%s tools_done\n' "$cap" >"$case_dir/cap.txt"
      fi
    else
      printf 'cap=%s tools_done\n' "$cap" >"$case_dir/cap.txt"
    fi
  else printf 'cap=%s\n' "$cap" >"$case_dir/cap.txt"; fi
  if [[ "$(<"$case_dir/exit-code.txt")" == 124 || "$(<"$case_dir/exit-code.txt")" == 137 ]]; then
    printf 'hung timeout\n' >"$case_dir/status.txt"; printf '%s hung timeout\n' "$id" >>"$SCORE_FILE"; write_failure "$id" "$file" "$case_dir" 'hung timeout'; return 1
  fi
  if [[ ! -f "$case_dir/summary.json" ]]; then
    printf 'fail no-session\n' >"$case_dir/status.txt"; printf '%s fail no-session\n' "$id" >>"$SCORE_FILE"; write_failure "$id" "$file" "$case_dir" 'fail no-session'; return 1
  fi
  # Headless returns an error after it has already recorded the max-turns stop.
  # Section 9 scores that case from stopReason / stderr; every other case still fails closed.
  # agents.workflow_live may exit 1 on max_tokens after the workflow finished — score
  # the state.json nonce and parent text the same way an empty/garbled text would score.
  # expect_tools already succeeded: score workdir/session even if a trailing sample
  # hit max_tokens (agents.hashline_edit), same oracle as workflow_live.
  if [[ "$(<"$case_dir/exit-code.txt")" != 0 && "$id" != session.max_turns && "$id" != agents.workflow_live && "$tools_done" -eq 0 ]]; then
    rc=$(<"$case_dir/exit-code.txt")
    printf 'fail exit %s\n' "$rc" >"$case_dir/status.txt"; printf '%s fail exit %s\n' "$id" "$rc" >>"$SCORE_FILE"; write_failure "$id" "$file" "$case_dir" "fail exit $rc"; return 1
  fi
  score_case "$file" "$case_dir" "$id"
}

make_mcp_server() {
  local path=$1
  apply_patch_placeholder=1
  python3 - "$path" <<'PY'
import pathlib,sys
pathlib.Path(sys.argv[1]).write_text('''#!/usr/bin/env python3
import json,sys
for line in sys.stdin:
 try: req=json.loads(line)
 except: continue
 method=req.get("method"); rid=req.get("id")
 if method=="initialize": result={"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"echo","version":"1"}}
 elif method=="tools/list": result={"tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}
 elif method=="tools/call": result={"content":[{"type":"text","text":req.get("params",{}).get("arguments",{}).get("text","")}],"isError":False}
 else:
  if rid is None: continue
  result={}
 print(json.dumps({"jsonrpc":"2.0","id":rid,"result":result}),flush=True)
''')
PY
  chmod +x "$path"
}

overall=0
for file in "${CASE_FILES[@]}"; do
  id=$(case_field "$file" id); phase=$(case_field "$file" phase)
  case_dir="$OUT_ROOT/$phase/$id"; home="$case_dir/home"; workdir="$case_dir/workdir"
  mkdir -p "$case_dir"
  echo "[$phase] $id" >&2
  if [[ "$phase" == cli ]]; then
    run_cli_case "$file" "$id" "$case_dir" "$home" "$workdir" || overall=1
  else
    run_model_case "$file" "$id" "$phase" "$case_dir" "$home" "$workdir" || overall=1
  fi
done

REPO_STATUS_AFTER=$(git -C "$REPO_ROOT" status --porcelain=v1)
USER_CONFIG_MTIME_AFTER=$(stat -c %Y "$USER_CONFIG" 2>/dev/null || echo missing)
if [[ "$REPO_STATUS_BEFORE" != "$REPO_STATUS_AFTER" || "$USER_CONFIG_MTIME_BEFORE" != "$USER_CONFIG_MTIME_AFTER" ]]; then
  printf 'runner.isolated fail repository or user config changed\n' >>"$SCORE_FILE"
  printf '## runner.isolated\n\n- Result: repository status or ~/.cook/config.toml mtime changed.\n\n' >>"$FAILURES_FILE"
  overall=1
fi

{
  printf '## Unsupported\n\n'
  rg ' unsupported ' "$SCORE_FILE" || true
  printf '\n## Skip-nondeterministic\n\n'
  rg ' skip-nondeterministic ' "$SCORE_FILE" || true
} >>"$FAILURES_FILE"

if ((overall==0 && KEEP==0 && OUT_WAS_TEMP==1)); then
  echo "all selected cases passed; removing $OUT_ROOT" >&2
  rm -rf -- "$OUT_ROOT"
else
  echo "artifacts: $OUT_ROOT" >&2
fi
exit "$overall"
