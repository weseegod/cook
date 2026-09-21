#!/usr/bin/env bash
set -euo pipefail

: "${BONSAI_API_KEY:?set BONSAI_API_KEY for the local OpenAI-compatible server}"

base_url="${BONSAI_BASE_URL:-http://127.0.0.1:8080/v1}"
model="${BONSAI_MODEL:-bonsai2}"
runs="${RUNS:-3}"
max_tokens="${MAX_TOKENS:-160}"
reasoning_effort="${REASONING_EFFORT:-none}"

command -v curl >/dev/null
command -v jq >/dev/null

make_prompt() {
    local arm="$1"
    jq -nr --arg arm "$arm" '
        def noise($round):
            "TOOL ROUND \($round): stale successful build output\n"
            + ("dependency compiled; no actionable failure here. " * 180);
        def omitted($round):
            "TOOL ROUND \($round): [Tool result omitted — outside recent step budget]";
        [range(1; 7) as $round |
            if $arm == "baseline" then noise($round) else omitted($round) end]
        + [
            "TOOL ROUND 7: failing test response_without_usage_preserves_context_and_marks_ledgers_incomplete; expected prompt.incomplete=true and session.incomplete=true, actual both false.",
            "TOOL ROUND 8 (active): patch changes the usage=None fallback to call mark_usage_incomplete_nowait(true, true); the focused regression test passes."
        ]
        | "Review this coding-agent trace. Ignore stale successful output and use the newest failure and patch evidence. Return exactly one JSON object with keys verdict, test, expected, actual. verdict is PASS only if the patch directly addresses the failure.\n\n"
          + join("\n\n")
    '
}

printf 'arm\trun\tprompt_tokens\tcompletion_tokens\ttotal_tokens\tlatency_s\tanswer\n'
for arm in baseline optimized; do
    prompt="$(make_prompt "$arm")"
    for run in $(seq 1 "$runs"); do
        payload="$(jq -cn \
            --arg model "$model" \
            --arg prompt "$prompt" \
            --arg reasoning_effort "$reasoning_effort" \
            --argjson max_tokens "$max_tokens" \
            '{
                model: $model,
                temperature: 0,
                reasoning_effort: $reasoning_effort,
                chat_template_kwargs: {reasoning_effort: $reasoning_effort},
                max_tokens: $max_tokens,
                messages: [{role: "user", content: $prompt}]
            }')"
        started_s="$SECONDS"
        response="$(curl --fail-with-body --silent --show-error \
            --connect-timeout 5 \
            --max-time 300 \
            -H "Authorization: Bearer ${BONSAI_API_KEY}" \
            -H 'Content-Type: application/json' \
            --data-binary "$payload" \
            "${base_url%/}/chat/completions")"
        finished_s="$SECONDS"
        jq -r \
            --arg arm "$arm" \
            --arg run "$run" \
            --arg latency_s "$((finished_s - started_s))" \
            '[
                $arm,
                $run,
                (.usage.prompt_tokens // "missing"),
                (.usage.completion_tokens // "missing"),
                (.usage.total_tokens // "missing"),
                $latency_s,
                ((.choices[0].message.content // "") | gsub("[\\t\\r\\n]+"; " "))
            ] | @tsv' <<<"$response"
    done
done
