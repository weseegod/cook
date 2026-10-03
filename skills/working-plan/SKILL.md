---
name: working-plan
description: Create and maintain an evidence-based plan for repository work before editing. Use for code changes and investigations.
---

After loading this skill, understand the requested outcome and constraints. Inspect the relevant implementation, tests, call sites, and compatibility behavior before deciding what to change. State any necessary assumptions in the plan and proceed.

Before the first edit, call `save_working_plan` once with the complete Markdown plan in `body`. Continue the task in the same turn; do not enter plan mode, ask for approval, or stop after saving.

Use this structure and keep it proportional to the work:

```markdown
# Plan: <short title>

## Goals
- <One user outcome per bullet.>

## Acceptance criteria
- <An observable result or check for each goal, including relevant compatibility and boundary behavior.>

## Task checklist
- [ ] <Step and relevant file or area>. Done when: <observable result>.
- [ ] Verify acceptance criteria. Done when: <check and passing result>.
```

Keep `## Task checklist` last. Use checks that exist. Each checklist item must have an observable completion condition.

The saved plan is a working document. Update that same file when evidence changes the likely cause, scope, or acceptance criteria. Add, remove, split, or reorder steps as needed. Mark a step complete only after its check passes. Before finishing, review every criterion; if a required check fails or cannot run, leave it open and state the evidence and blocker in the final response. Continue unless blocked.

If a check fails, fix the cause. Do not weaken expected results or delete or skip a case to make the check pass.

Use the `run-checks` skill when you need help selecting and running checks.
