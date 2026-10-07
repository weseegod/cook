---
name: create-workflow
description: >
  Create a Grok Build workflow: author a Rhai orchestration script (agents,
  phases, bounded parallel fan-out, verification panels), smoke-check one path
  with the workflow tool, save it as a named workflow, and offer a real run.
  Also the complete Rhai reference for workflow scripts: script shape, host API,
  dialect rules, and journal semantics. Use when the user wants to
  create/author/write a workflow, automate a multi-agent pipeline, or runs
  /create-workflow.
metadata:
  short-description: "Author a new multi-agent workflow"
---

# Create Workflow

Workflows are deterministic Rhai scripts that orchestrate subagents — `agent()`, `parallel()`, `phase()`, `complete()` — run by the `workflow` tool. This file is both the authoring procedure and the complete language reference. The reference sections (Script shape onward) are what the `workflow` tool's description points at, and they apply to any script, whether or not it came from this procedure.

When you talk to the user about these `.rhai` files, call them "workflows," not "Rhai."

## Procedure

1. **Gather intent**, conversationally: what should it do, what fans out in parallel, what gets verified, what's the final artifact (a report? a structured result?), and roughly how many agents the user is comfortable spawning per run.
2. **Pick a name and scope** (same convention as skills):
   - Project: `<repo-root>/.grok/workflows/<name>.rhai` — this repo, shareable with teammates (the default inside a git repo).
   - User: `~/.grok/workflows/<name>.rhai` — all projects.
   - Name it with lowercase letters, digits, and hyphens (e.g. `review-changes`).
3. **Author the script.** Start from the example below and follow the reference sections that make up the rest of this file. The shape is: `let meta` header (pure literal) → schemas as constants → one section per phase. Keep agent prompts imperative and self-contained (see Pitfalls).
4. **Smoke-check one path.** Call the `workflow` tool with `{ script: "<rhai>", validate_only: true }` and representative `args`, and iterate until metadata, compilation, and that canned-host path all pass. This does not cover every branch or live dependency — see Iterating.
5. **Save** the smoke-checked script to the chosen path, creating the directory if needed. It's now runnable as `/<name>` or `/workflow <name> ...`. Note that `/workflows` is a run dashboard, not a catalog of saved definitions — the name shows up there once a run starts.
6. **Offer a real run** with representative args. It runs in the background and the user can watch it in `/workflows`. If they decline, stop here and say that only the path-specific smoke check ran.
7. **Report**: the file path, the smoke-check output and its limits, how to run it, and the maximum agent fan-out per run.

## Example: fan-out → adversarial verify → structured result

```rhai
let meta = #{
    name: "review-changes",
    description: "Review a diff across dimensions, adversarially verify each finding",
    phases: [
        #{ title: "Review", detail: "one reviewer per dimension" },
        #{ title: "Verify", detail: "one skeptic per finding" },
    ],
};

let findings_schema = #{
    "type": "object", "required": ["findings"],
    "properties": #{
        "findings": #{ "type": "array", "maxItems": 8, "items": #{
            "type": "object", "required": ["file", "issue"],
            "properties": #{
                "file": #{ "type": "string" },
                "issue": #{ "type": "string" },
            },
        }},
    },
};
let verdict_schema = #{
    "type": "object", "required": ["real", "reason", "evidence"],
    "properties": #{
        "real": #{ "type": "boolean" },
        "reason": #{ "type": "string" },
        "evidence": #{ "type": "string" },
    },
};

// Guard `args` itself first: property access on unit (`args.target` when no
// args were passed) is a runtime error, so the pause would never be reached.
let target = if args == () { () } else { args.target };
if target == () { pause("verification", "Pass args.target — the diff, branch, or path to review."); }

phase("Review");
let dimensions = ["correctness bugs", "error handling gaps", "performance problems"];
let jobs = [];
for d in dimensions {
    jobs.push(#{
        prompt: "Review " + target + " for " + d + ". Use read-only tools (read_file, grep, git diff) "
            + "to inspect the actual code — do not answer from memory. Report at most 8 concrete "
            + "findings as {file, issue}; an empty list is a valid answer only after you have read the code.",
        label: "review:" + d,
        capability_mode: "read-only",
        output_schema: findings_schema,
    });
}
let results = parallel(jobs);

let findings = [];
for r in results {
    if r != () && r.success && r.output.findings != () {
        for f in r.output.findings { findings.push(f); }
    }
}
if findings.len() == 0 { complete(#{ summary: "No findings.", confirmed: [] }); }

phase("Verify");
let vjobs = [];
for f in findings {
    vjobs.push(#{
        prompt: "Adversarially verify this review finding by reading the shipped code: \""
            + f.issue + "\" in " + f.file + ". Set real=true only with concrete evidence you "
            + "independently inspected. Otherwise default real=false.",
        label: "verify:" + f.file,
        capability_mode: "read-only",
        output_schema: verdict_schema,
    });
}
let verdicts = parallel(vjobs);

let confirmed = [];
let i = 0;
for v in verdicts {
    if v != () && v.success && v.output.real == true
        && v.output.evidence != () && v.output.evidence != "" {
        confirmed.push(findings[i]);
    }
    i += 1;
}
log(confirmed.len().to_string() + "/" + findings.len().to_string() + " findings survived verification");
complete(#{ summary: confirmed.len().to_string() + " confirmed findings", confirmed: confirmed });
```

## Script shape

The first statement must be a pure-literal meta map — no variables, no function calls, nothing computed:

```rhai
let meta = #{
    name: "find-flaky-tests",
    description: "Find flaky tests and propose fixes",
    phases: [ #{ title: "Scan", detail: "grep CI logs" }, #{ title: "Fix" } ],
};
phase("Scan");
let r = agent("Find retry markers in CI logs; list the flaky tests.",
    #{ label: "scanner", capability_mode: "read-only" });
if r.success { complete(r.output); }
```

`meta.name` is lowercase letters, digits, and hyphens. `meta.phases` is optional, but any titles you list there should match the `phase()` calls in the body so the `/workflows` phase rail lines up (nothing enforces the match, so a typo just leaves the rail out of step). `when_to_use` is an optional string shown when workflows are listed.

## The dialect

- Maps are `#{ ... }`. Unit `()` is the null value, and `x != ()` is the existence check for anything optional.
- Quote JSON-Schema keys inside maps, because `type` is a Rhai keyword: `#{ "type": "object", "required": [...], "properties": #{ ... } }`.
- Reserved-but-unused identifiers fail with `'X' is a reserved keyword`: `shared`, `sync`, `async`, `await`, `spawn`, `go`, `thread`, `new`, `match`, `case`, `default`, `void`, `null`, `nil`, `exit`, `static`, `var`. Rename them (`shared` → `has_shared`).
- Every call blocks. `parallel()` is the only concurrency: it takes an array of option maps (no closures) and acts as a barrier — nothing downstream runs until the slowest job finishes. A run defaults to 128 logical agent calls, and callers may set `agent_budget` from 1 through 1,024. There's no lower concurrency throttle. Admission is atomic, so a panel that would cross the run cap launches none of its new jobs; leave headroom for later synthesis or verification when you size earlier panels. There's no way to race, stream, or time out a call.
- Build long strings (prompts) with `+=` statements. A single chained `+` expression eventually trips `Expression exceeds maximum complexity` once it gets long enough (a couple hundred `+` terms is plenty), so split it. Numbers need `.to_string()` when concatenated.
- `s[i]` yields a `char`, and field access on a `char` fails with `getter is not registered for type 'char'` — usually a sign you're treating a string as parsed JSON. Check `type_of(x)`, and slice with `s.sub_string(start, len)`.
- String mutators like `s.trim()` change `s` in place and return `()`, not the new string. So `x.trim() != ""` is always true, and `"p" + x.trim()` drops the text (a shipped workflow rendered rows of empty `"... uncertainty: "` exactly this way). Trim on its own line and then use `x`, or write a helper: `fn trimmed(s) { if type_of(s) == "string" { s.trim(); s } else { "" } }`.
- No regex — hand-roll the few string ops you need, or simplify (e.g. index-based labels).
- Functions take arguments by value, so return values instead of mutating across calls. `const X = 5;` works; maps and arrays stay mutable. Use plain `for` loops instead of `.map`/`.filter`.

## Host API

- `agent(prompt)` / `agent(prompt, opts)` → `#{ agent_id, success, output, cancelled, tokens_used, duration_ms }`. `output` is the agent's final text, or the schema-validated object when you set `output_schema` (a JSON Schema map). Opts: `label`, `phase`, `capability_mode` (`"read-only"` | `"read-write"` | `"execute"` | `"all"`), `output_schema`, `agent_type`, `model` (omit to inherit the session model), `isolation_worktree` (bool — gives the agent a private worktree but does not merge its edits back into the parent workspace), and `resume_from` (a prior `agent_id`). `fork_context` is for embedded built-ins only; inline, project, user, and saved scripts are rejected if they request it, so authored workflows must use self-contained prompts rather than lean on the parent conversation. Use isolation only when parallel agents need separate edits, and add an explicit select-and-apply step if any edit should reach the parent. Agent-level failure is data (`success: false`); infrastructure failure throws. Verification should fail closed on missing evidence, while optional advisory panels may fail open.
- `parallel([#{ prompt: "...", label: "..." }, ...])` → results in input order, with a failed slot as `()` — filter before use. The whole panel is admitted as one unit against the run's `agent_budget`; if it would exceed the cap, it fails before any new child launches.
- `phase(title)` groups the agents that follow it in the UI. `log(message)` emits a progress line to the user.
- `complete(value)` ends the run as a success, and the value becomes the run result (e.g. `complete(#{ path: p, report: text })`).
- `await_user(kind, message)` pauses for the user; on resume the script continues past the gate (reset any streak counters right after it). Before adding one, reason about the user's intended level of autonomy and whether interrupting the workflow there is necessary; prefer fewer, meaningful gates, and ask one concise question if ambiguity would materially change the workflow's behavior.
- `pause(kind, message)` is like `await_user` but re-fires on every resume, so reserve it for conditions a resume can't change (e.g. missing `args`). A pause whose branch derives from journaled results re-fires forever — use `await_user` for "stop until the user resumes" gates.
- Pause kinds: `user`, `back_off`, `no_progress`, `verification`, `infra` (`verification` also accepts `blocked`, and `back_off` accepts `backoff`). None of `complete` / `await_user` / `pause` can be caught by try/catch.
- `budget()` → `#{ total, spent, reserved, remaining }`. `total` is the absolute logical-agent cap (default 128; explicit 1–1,024). Every live `agent()` and every item in a `parallel()` increments `spent` before launch; schema-correction retries and journal-replayed calls don't. A parallel panel is admitted atomically, so one that would cross the cap launches no new children. `reserved` is always `0`, and `remaining = total - spent`.
- `write_scratch_file(name, content)` → a stable run-relative artifact ID such as `scratch/report.md`; `read_scratch_file(name)` reads that flat per-run scratch entry back by its single-component `name`. The workflow UI/session owns resolving it to the stored file. Write reports here and `complete(#{ path: p, report: text })` so the pager renders the report.
- `git_diff_since(commit)` → diff text. `fingerprint(text)` → a stable hash (for stall detection). `json_encode(value)` → deterministic JSON text for quoting untrusted prompt data. `render_template(name, map)` → a built-in prompt template. Template substitution is plain replacement, so JSON-encode every untrusted objective, report, diff, gap, or source field before you interpolate it.
- `args` is the tool's `args` value, verbatim (`()` if absent). Prefer object fields (`args.query`).
- Workflows can't launch other workflows — inline the child's logic, or split into separate workflows.

## Determinism and journal resume

Control flow must derive only from `args` and host results. Wall-clock time and randomness aren't available and throw (`timestamp()`, `sleep()`, `exit()`), so pass timestamps in through `args` and vary parallel prompts by index rather than by chance.

The journal stores a host-call result only after that call returns. Resuming a same-process paused run with `resume_from_run_id` reuses those committed results and continues with live calls under the run's original immutable agent cap. A budget-limited run resumes only through the `workflow` tool with both `resume_from_run_id` and an `agent_budget` above its admitted count — a bare `/workflow resume <display-name>` can't raise the cap and is rejected. A run that was active when the process exited restores as terminal `Interrupted`, not resumable, because external effects have no stable cross-process invocation identity. And same-process resume is still not exactly-once for external effects: if an agent or tool changed something and the result wasn't committed before the pause, that call can run again — so make effectful steps idempotent, or inspect state before repeating them.

Keep structured run IDs internal in anything user-facing. Users identify a run by the session-unique display name shown in `/workflows` (for example `review-changes-2`). For ordinary pauses they can use `/workflow resume <display-name>`; for budget-limited runs, translate the display name to its run ID and call the `workflow` tool with a raised cap.

## Iterating

Every launch persists an editable script projection and returns `script_path`. To change a script, edit that copy, smoke-check it with `validate_only: true`, and launch the `script_path` as a new run. Resume always uses the original immutable script and args captured for that run, and the tool rejects a resume combined with `name`, `script`, or `script_path`.

`validate_only` checks metadata, compiles the full script, and executes the single path selected by your args and canned host results (`success: true`, with a small fixed output object). It catches errors reached on that path, but it doesn't enumerate branches, exercise live tools, prove schema handling for every agent output, or validate external side effects. So use representative args, guard every optional agent result, and offer a real run once the smoke check passes. Save reusable workflows to `.grok/workflows/<name>.rhai` and they become invocable by name. Remember `/workflows` lists live and retained runs after launch, not saved definitions.

## Patterns that work

- Build the fan-out's work-list the simplest deterministic way that's exactly right — a file walk, a fixed list in `args` — and spend agents on judgment (scanning, verifying), not on deciding scope. If an agent has to discover the work-list, treat its output as untrusted and re-filter it in plain Rhai against the invariant (e.g. keep only paths starting with `args.root`) before sharding. A discovery agent that reaches for `git log --all --name-only` can leak paths far outside the intended root; a plain directory walk can't.
- Plan, parallel fan-out, synthesize.
- Adversarial verification: independent skeptics prompted to refute. Missing, failed, or unusable verification is not a confirming vote — require concrete evidence before accepting a claim (see the bundled deep-research verifier).
- Loop until dry: keep spawning finders until two consecutive rounds surface nothing new, and fingerprint each round's findings to detect stalls.
- Vote panels: N skeptics per item in one flat `parallel()` (items × votes), regrouped by index arithmetic (`i / VOTES`, `i % VOTES`).
- Decide failure policy by purpose. Optional advice may fail open; a panel that's the proof gate must fail closed, so no usable evidence means the claim stays unverified.

## Pitfalls (each has actually happened)

- Terse agent prompts return garbage. A cold subagent told "Count the TODO comments" may answer `{"findings": []}` without running a single tool. Prompts must command tool use ("use grep/read_file", "read the code before answering") and spell out what a valid empty answer requires.
- Guard every agent output: `r != () && r.success && r.output.x != ()`. Failed `parallel()` slots are `()`; for an evidence gate, treat them as unverified rather than quietly dropping them from the denominator.
- meta is a pure literal — no variables or function calls inside `let meta = #{...}`. Keep any `meta.phases` titles in sync with the `phase()` calls so the dashboard rail lines up.
- `pause()` in a result-derived branch re-fires on every resume; use `await_user` for resumable human gates (see Host API above).
- Silent truncation reads as full coverage. When you enforce a cap (`MAX_*`), `log()` whatever got dropped.
- Agents don't enforce your invariants — scripts do. A scanner told "only under crates/codegen" will still report whatever its discovery step fed it. Every scoping rule the run depends on has to be a plain-Rhai check on agent output (a filter, or an assert-and-`log()` on drops), not just prompt text. A live run shipped ~50 out-of-scope findings this way.

## More examples on this machine

Past runs keep an editable script projection and journal under the session's `workflows/` directory; use the `script_path` the workflow tool returns. The `s` (save) action in `/workflows` is hidden for known built-ins and numbered duplicate handles — for those, choose a new unique name and save the edited copy explicitly. The journal holds committed host-call results, which is handy for debugging what came back, but it's not an exactly-once audit of external effects.
