#!/usr/bin/env bash
# Real-task A/B for the step-aware tool-result pruning arm, driven through the agent
# itself rather than the raw OpenAI-compatible endpoint.
#
# scripts/benchmark_step_pruning.sh measures one completion against synthetic trace text,
# so it prices the fixture, not the harness. This script runs the actual agent loop on a
# fixed corpus and reads each arm's persisted usage report, which is what makes the
# question answerable: the report's `requestComponents` is estimated from the request the
# sampler was given, so it shows the tool-result share *after* pruning, and the per-purpose
# rows show what compaction cost while the arm was running.
#
# Both arms run the same corpus, model, prompt, context window, and turn cap. The only
# difference is the `[compaction.pruning]` step-aware pair. Wall clock is reported but is
# not an acceptance criterion.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cook_bin="${COOK_BIN:-$repo_root/target/debug/xai-grok-pager}"
base_url="${BONSAI_BASE_URL:-http://localhost:8080/v1}"
model_key="${MODEL_KEY:-local/spark25}"
# Wire id the llama server advertises (`--alias`). MODEL_WIRE overrides; otherwise strip a `local/` prefix.
model_wire="${MODEL_WIRE:-${MODEL_KEY#local/}}"
runs="${RUNS:-1}"

# Pruning runs only when the last model call's total exceeds half the window, and auto-compaction
# fires at 80% of it, so the window decides which mechanisms are even in play. Neither is chosen
# here: the script runs both arms at the same window and reports what fired, per arm and per run.
# A run whose step-aware column shows zero cleared rounds measured nothing about the arm -- it is
# two identical configurations differing only by model nondeterminism, and must not be read as a
# comparison. WIDENING the window makes the arm a no-op; narrowing it invites compaction.
context_window="${CONTEXT_WINDOW:-40000}"
files="${FILES:-12}"
file_bytes="${FILE_BYTES:-8000}"
step_rounds="${STEP_ROUNDS:-2}"
step_char_budget="${STEP_CHAR_BUDGET:-12000}"
# Extra `[compaction.pruning]` lines for the step-aware home only, so a run can put one opt-in
# setting (e.g. `read_file_max_output_bytes`) in one arm and leave the other arm without it.
pruning_extra="${PRUNING_EXTRA:-}"
max_turns="${MAX_TURNS:-24}"

# The two markers the answer must carry: one from an early round and one from the last one.
early_index=3
late_index=11

: "${BONSAI_API_KEY:=}"
if [[ -z "$BONSAI_API_KEY" && -r "$HOME/.cook/bonsai_api_key" ]]; then
    BONSAI_API_KEY="$(<"$HOME/.cook/bonsai_api_key")"
fi
: "${BONSAI_API_KEY:?set BONSAI_API_KEY, or keep the key in ~/.cook/bonsai_api_key}"

command -v python3 >/dev/null
[[ -x "$cook_bin" ]] || {
    echo "no binary at $cook_bin; build it with: cargo build -p xai-grok-pager-bin --bin xai-grok-pager" >&2
    exit 1
}

out_root="${OUT_ROOT:-$(mktemp -d -t step-pruning-live.XXXXXX)}"
corpus="$out_root/corpus"
mkdir -p "$corpus"

# Corpus: files of near-equal size whose only unique content is one marker line, so the
# answer can only come from reading that file and the marker cannot be guessed from a sibling.
python3 - "$corpus" "$files" "$file_bytes" <<'PY'
import os, sys

corpus, files, file_bytes = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
for i in range(1, files + 1):
    marker = f"MARKER-{i:02d}-QK7"
    header = f"# artifact {i}\n# {marker}\n\n"
    line = f"step {i} handler: parse the payload, validate the shape, forward the result\n"
    pad = max(0, file_bytes - len(header) - 80)
    body = (line * (pad // len(line) + 1))[:pad]
    with open(os.path.join(corpus, f"a{i:02d}.txt"), "w") as handle:
        handle.write(f"{header}{body}\n# {marker}\n")
PY

marker_of() { printf 'MARKER-%02d-QK7' "$1"; }
early_marker="$(marker_of "$early_index")"
late_marker="$(marker_of "$late_index")"
first_file="a01.txt"
late_file="$(printf 'a%02d.txt' "$late_index")"
early_file="$(printf 'a%02d.txt' "$early_index")"

task_prompt="Use the read tool to read every file in $corpus in order, one read per file, from $first_file through $late_file. Then reply with exactly two lines and nothing else: the marker line of $early_file and the marker line of $late_file."

# Each arm gets its own home so config, sessions, and reports cannot leak between arms.
write_home() {
    local home="$1" step_settings="$2"
    mkdir -p "$home"
    {
        cat <<EOF
[ui]
permission_mode = "always-approve"

[model."$model_key"]
model = "$model_wire"
model_provider = "local"
name = "Step pruning benchmark model"
input = ["text"]
context_window = $context_window
max_completion_tokens = 8000
supports_reasoning_effort = false

[model_providers.local]
base_url = "$base_url"
api_key = "$BONSAI_API_KEY"
api_backend = "chat_completions"

[compaction.pruning]
enabled = true
keep_last_n_turns = 3
$step_settings
EOF
        # Only exists to clear the first-run gate in a fresh home; it records no credentials.
        cat <<'EOF'

[privacy]
privacy_banner_acked = "2026-01-01T00:00:00Z"

[consent.answers.aup]
version = 2
account = "bench@example.com"

[consent.answers.tos]
version = 2
EOF
    } >"$home/config.toml"
}

run_arm() {
    local arm="$1" home="$2" workdir="$3" run="$4"
    mkdir -p "$home" "$workdir"
    local started_s="$SECONDS"
    (
        cd "$workdir" &&
            COOK_HOME="$home" timeout 1800 "$cook_bin" \
                -p "$task_prompt" -m "$model_key" \
                --allow 'Read(*)' --max-turns "$max_turns" \
                --debug-file "$workdir/debug.log" \
                --output-format json >"$workdir/out.json" 2>"$workdir/err.log"
    ) || echo "arm $arm run $run: agent exited non-zero" >&2
    local elapsed_s=$((SECONDS - started_s))

    REQUEST_COMPONENTS_ARM="$arm" \
        REQUEST_COMPONENTS_RUN="$run" \
        REQUEST_COMPONENTS_HOME="$home" \
        REQUEST_COMPONENTS_WORKDIR="$workdir" \
        REQUEST_COMPONENTS_ELAPSED="$elapsed_s" \
        REQUEST_COMPONENTS_EARLY="$early_marker" \
        REQUEST_COMPONENTS_LATE="$late_marker" \
        python3 - <<'PY'
import glob, json, os, re

arm = os.environ["REQUEST_COMPONENTS_ARM"]
run = os.environ["REQUEST_COMPONENTS_RUN"]
home = os.environ["REQUEST_COMPONENTS_HOME"]
workdir = os.environ["REQUEST_COMPONENTS_WORKDIR"]
elapsed = os.environ["REQUEST_COMPONENTS_ELAPSED"]
early, late = os.environ["REQUEST_COMPONENTS_EARLY"], os.environ["REQUEST_COMPONENTS_LATE"]


def blank(reason):
    print("\t".join([arm, run, reason] + ["-"] * 15))
    raise SystemExit(0)


# The step-aware policy logs one line per request it rewrote. Zero events means the arm never
# engaged, whatever the token columns say.
prune_events = 0
prune_rounds = 0
prune_chars = 0
log_path = os.path.join(workdir, "debug.log")
if os.path.exists(log_path):
    with open(log_path, errors="replace") as handle:
        for line in handle:
            if "step-aware tool result pruning" not in line:
                continue
            prune_events += 1
            match = re.search(r"rounds_cleared_by_step_budget=(\d+)", line)
            if match:
                prune_rounds += int(match.group(1))
            match = re.search(r"chars_reclaimed=(\d+)", line)
            if match:
                prune_chars += int(match.group(1))


try:
    answer = json.load(open(os.path.join(workdir, "out.json")))
except Exception as exc:  # noqa: BLE001 - reported as a row, not a crash
    blank(f"no-json({type(exc).__name__})")

# What this arm's home actually configured for the opt-in read generation cap. "-" means the key
# was absent, which must leave the read tool's own caps as its only size limits.
read_cap = "-"
home_config = os.path.join(home, "config.toml")
if os.path.exists(home_config):
    with open(home_config) as handle:
        match = re.search(r"read_file_max_output_bytes\s*=\s*(\d+)", handle.read())
    if match:
        read_cap = match.group(1)

session_id = answer.get("sessionId", "")
reports = glob.glob(os.path.join(home, "sessions", "*", session_id, "usage.json"))
if not reports:
    blank("no-report")

report = json.load(open(reports[0]))
session = report.get("session", {})
purposes = session.get("purposeUsage", {})
components = session.get("requestComponents") or {}
compaction_calls = sum(
    row.get("modelCalls", 0) for name, row in purposes.items() if name.startswith("compact_")
)
compaction_tokens = sum(
    row.get("totalTokens", 0) for name, row in purposes.items() if name.startswith("compact_")
)
text = answer.get("text", "")
found = sum(1 for marker in (early, late) if marker in text)
fidelity = {0: "both-markers-lost", 1: "one-marker", 2: "both-markers"}[found]

print(
    "\t".join(
        [
            arm,
            run,
            "",
            str(answer.get("num_turns", "-")),
            str(purposes.get("main_loop", {}).get("inputTokens", "-")),
            str(purposes.get("main_loop", {}).get("cachedReadTokens", "-")),
            str(purposes.get("main_loop", {}).get("outputTokens", "-")),
            str(components.get("requestsMeasured", "-")),
            str(components.get("systemTokens", "-")),
            str(components.get("toolSchemaTokens", "-")),
            str(components.get("toolResultTokens", "-")),
            str(compaction_calls),
            str(compaction_tokens),
            str(prune_events),
            str(prune_rounds),
            str(prune_chars),
            read_cap,
            f"{elapsed}s/{fidelity}",
        ]
    )
)
PY
}

write_home "$out_root/home-baseline" ""
write_home "$out_root/home-stepaware" \
    "keep_last_n_tool_rounds = $step_rounds
recent_tool_result_char_budget = $step_char_budget
$pruning_extra"

printf 'arm\trun\tnote\tloop_calls\tloop_input\tloop_cache_read\tloop_output\trequests_measured\tsystem_tokens\ttool_schema_tokens\ttool_result_tokens\tcompaction_calls\tcompaction_tokens\tprune_events\tprune_rounds\tprune_chars\tread_cap_bytes\twall/fidelity\n'
for run in $(seq 1 "$runs"); do
    for arm in baseline stepaware; do
        run_arm "$arm" "$out_root/home-$arm" "$out_root/work-$arm-$run" "$run"
    done
done

echo
echo "corpus: $corpus"
echo "homes and reports: $out_root"
echo "fidelity: both markers must appear in the answer for the arm to count as correct"
echo "compaction_calls above zero means the window was crossed: widen CONTEXT_WINDOW, but note the arm needs the last call over half the window to fire at all"
echo "prune_events zero in the stepaware arm means the arm never engaged and the run compared nothing"
