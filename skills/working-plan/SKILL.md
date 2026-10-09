---
name: working-plan
description: "Use before starting work that has several dependent steps, spans multiple files or sources, or has an unclear cause or scope (features, refactors, investigations, analysis, non-trivial fixes). Skip when the change is small and already clear."
---

Understand the request first, then inspect what it touches (code, callers, docs, data, existing checks) before planning. Take conventions from existing examples; state only unavoidable assumptions.

Before the first edit, call `save_working_plan` once with the full Markdown plan as `body`, then continue in the same turn (no approval, don't stop).

# Plan: <short title>

## Goals
- <One outcome per bullet.>

## Acceptance criteria
- <Observable outcome>. Source: <request, existing test, docs, or code>. Evidence: <how it will be confirmed>. Cover the variants and error paths the affected code already supports.

## Task checklist
- [ ] <Step>. Done when: <observable result>.
- [ ] Verify every criterion. Done when: its evidence is observed, or the blocker is noted.

Rules:
- Size the plan to the work: a small task gets a few lines. The checklist stays last, ending with the verify step.
- Evidence, cheapest first: (1) an existing check that already covers it, (2) running a command or script and reading its output, (3) reading the code path or source. Add a new test only when none of these can show the outcome, and put it in the existing test file for that area. Do not write end-to-end or browser tests unless the task changes a user-facing flow that cannot be checked at a lower level.
- Evidence must be able to fail without the change. Take expected values from the sources, not from your own implementation's output.
- Update the plan when evidence changes the cause, scope, or expected outcome. Mark a step done only when its condition is observed. Report failing or unrunnable checks instead of marking them done. Never weaken an expectation to make a check pass.