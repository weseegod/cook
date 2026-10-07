---
name: working-plan
description: "Use before editing when a repository task has several dependent steps, spans multiple files, or has an unclear cause or scope (features, refactors, investigations, non-trivial bug fixes). Skip for a small edit where the file and change are already known."
---

Understand the requested outcome, then inspect the relevant code, callers, docs, and closest existing tests. Check conventions against existing examples in the repository instead of assuming them; state only unavoidable assumptions in the plan.

Before the first edit, call `save_working_plan` once with the full Markdown plan as `body`, then keep working in the same turn (no plan mode, no approval, don't stop after saving).

# Plan: <short title>

## Goals
- <One outcome per bullet.>

## Acceptance criteria
- <Exact observable outcome, its source (the request, an existing test, docs, or existing code), and the check that verifies it. Include the variants and error paths the affected code already supports.>

## Task checklist
- [ ] <Step and area>. Done when: <observable result>.
- [ ] Run focused checks, then broader related ones. Done when: each criterion's check output confirms its outcome.
- [ ] Review the whole change against every criterion. Done when: each criterion is marked met with its evidence, or left open with the blocker.

Keep the plan proportional to the work, with `## Task checklist` last. Keep the two closing steps, adding steps before them as needed.

A check counts only if it would fail without the change. Take expected values from the sources above, not from your own implementation. Read each check's output.

Update the plan file when evidence changes the cause, scope, or expected outcome. Mark a step done only when its stated condition is observed. Report any failing or unrunnable check instead of marking it done. Never weaken an expectation or skip a case to make a check pass.
