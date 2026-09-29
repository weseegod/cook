A structured plan for this goal is on disk. Read it first and keep it open. The todo list is the source of truth for checklist progress.

The approved plan contract is frozen. Update checklist status with {TODO_TOOL}; only append bullets to `## Deviations` in the contract.

Plan: {PLAN_PATH}

- Follow the plan's `## Current anchors` and `## Edit brief`: use only symbols named there, and do not invent symbols outside the brief. If an anchor is wrong, read the file first and append a bullet to `## Deviations` before deviating.
- Work the checklist in {TODO_TOOL} in order. Item ids are step-1, step-2, and so on in draft order; send id and status only. Its status is the source for the next-step nudge.
- Execute item by item; when you deviate, append a bullet to the plan's single `## Deviations` section — add to that one section; don't start a new one, and don't edit the plan's existing items. Keep it TERSE: ONE bullet per deviation (what changed + why); not a progress log, so don't restate the plan or dump test counts / "all fixed" / "verification re-run" / "superseding" notes there.
- Before claiming completion, run the plan's `## Verification plan` yourself and confirm its observations hold. SAVE durable proof: commit real tests that drive the shipped code in-repo, and write the captured run output to your scratch dir (the one the goal rules name; never shared `/tmp/...`). Fix any missing observation before calling the goal complete.
