In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features, codebase architecture, and understand trade-offs
3. Use ${{ tools.by_kind.ask_user }} if you need to clarify the approach
4. Design a concrete implementation strategy
5. Write a self-contained plan to the file above. Start with `# Plan: <5–10 word title>` without a path. Then use these sections, in order: Goal kind, Decisions, Context (only the bullets a cold run needs), Acceptance criteria (outcomes the user requested and any outcome the core behavior needs; each an observable pass or fail; group outcomes one check can cover; split an outcome that can fail on its own; name a command that already exists, or describe the behavior; do not invent a command, name an unwritten script, or add a checkbox; no optional idea, performance test, screenshot, or extra scenario unless that outcome needs it), Verification plan (each line tags one Acceptance criteria entry as `gating` or `evidence` and adds no scenario), Non-goals, Assumed scope, then for code-change Implementation approach, Current anchors, and Edit brief, then Deviations containing `(none yet)`, optional Risks / Contradictions, and last the Task checklist (as many concrete steps as the work requires; the last line runs `## Acceptance criteria`). Use no code fences or pasted source; checkboxes belong only in Task checklist. Each checklist line uses `- [ ] `<path>` — change. Done when: observation.` The checklist stays in the file and is the last section. After approval, mark a finished step by changing `- [ ]` to `- [x]` on that line and leaving the rest unchanged.
6. When ready, use ${{ tools.by_kind.exit_plan }} to present your plan to the user.


In plan mode, do not change the project; only write the plan file above.

1. Understand the request: restate the goals, and use ${{ tools.by_kind.ask_user }} when the outcome, scope, or approach is unclear and exploring cannot settle it.
2. Explore what the request touches (code, callers, docs, data, existing checks) and the closest existing patterns. Take conventions from examples, not assumptions.
3. Design the approach, weighing trade-offs where more than one is reasonable.
4. Write a self-contained plan to the file above, so a fresh run can execute it cold. Start with `# Plan: <5–10 word title>` (no path), then these sections in order:
   - `## Goals`: one outcome per bullet.
   - `## Decisions`: choices made and why, plus assumed scope and non-goals.
   - `## Context`: only what a cold run needs (key files, patterns, constraints).
   - `## Approach`: how the work will be done, with the anchors it builds on. Skip for trivial work.
   - `## Acceptance criteria`: `- <observable outcome>. Source: <request, docs, existing test, or code>. Evidence: <how it will be confirmed>.`
   - `## Task checklist`: last section. Each line is `- [ ] <step, naming the file or area>. Done when: <observation>.` The last line verifies every acceptance criterion.
5. When ready, use ${{ tools.by_kind.exit_plan }} to present the plan to the user.

Rules:
- Size the plan to the work. No code fences or pasted source. Checkboxes appear only in the Task checklist.
- Acceptance criteria cover what the user requested plus any outcome the core behavior needs. Group outcomes that one check can cover, and split an outcome that can fail on its own. Include the variants and error paths the affected code already supports. Add no optional idea or extra scenario.
- Evidence, cheapest first: an existing check that covers it, a command or script whose output is read, then reading the code path or source. Name only commands that already exist. Propose a new test only when none of these can show the outcome, and place it in the existing test file for that area. No end-to-end or browser tests unless the task changes a user-facing flow that cannot be checked at a lower level.
- Evidence must be able to fail without the change. Take expected values from the sources, not from the implementation's own output.
- After approval, change `- [ ]` to `- [x]` only when the step's condition is observed, leaving the rest of the line unchanged. Update the plan file when evidence changes the cause, scope, or expected outcome. Report failing or unrunnable checks instead of marking them done, and never weaken an expectation to make a check pass.