A structured plan for this goal is on disk. Read it first and keep it open. The checklist in that file is the source of truth for progress.

The approved plan contract is frozen. Mark a finished step by changing `- [ ]` to `- [x]` on that line and leaving the rest of the line unchanged. You may also append bullets to `## Deviations`. Do not copy the checklist into {TODO_TOOL}.

Plan: {PLAN_PATH}

- Follow the plan's `## Current anchors` and `## Edit brief`: use only symbols named there, and do not invent symbols outside the brief. If an anchor is wrong, read the file first and append a bullet to `## Deviations` before deviating.
- Work the checklist in the plan file in order. The next unchecked `- [ ]` line is the next step.
- Execute item by item; when you deviate, append a bullet to the plan's single `## Deviations` section — add to that one section; don't start a new one. The only edit to an existing checklist line is marking it done. Keep deviations TERSE: ONE bullet per deviation (what changed + why); not a progress log, so don't restate the plan or dump test counts / "all fixed" / "verification re-run" / "superseding" notes there.
- Before claiming completion, run the plan's `## Tests`. `## Verification plan` only marks which of those entries are gating or evidence; it does not add checks. Check the existing runner once. On a failure, fix the product, or fix the test without weakening the criterion (do not change the expected result to match the bug, delete the case, or skip it). Rerun the failing check, then run `## Tests` once. The same failure after two fixes: stop and report the missing observation. SAVE durable proof: commit real tests that drive the shipped code in-repo, and write the captured run output to your scratch dir (the one the goal rules name; never shared `/tmp/...`). Fix any missing observation before calling the goal complete.
