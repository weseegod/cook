A structured plan for this goal is on disk — the source of truth for "done". Read it first and keep it open.

The approved plan contract is frozen. Only flip Task checklist boxes and append bullets to `## Deviations`; the harness rejects other edits.

Plan: {PLAN_PATH}

- Seed todos from the plan's acceptance criteria via {TODO_TOOL} before executing.
- Follow the plan's `## Current anchors` and `## Edit brief`: use only symbols named there, and do not invent symbols outside the brief. If an anchor is wrong, read the file first and append a bullet to `## Deviations` before deviating.
- If the plan has a `## Task checklist`, work it in order and flip each `- [ ]` to `- [x]` in the plan file as you complete it — the harness mines the first unchecked box as your next-step nudge, so a stale checklist produces stale nudges.
- Execute item by item; when you deviate, append a bullet to the plan's single `## Deviations` section — add to that one section; don't start a new one, and don't edit the plan's existing items. Keep it TERSE: ONE bullet per deviation (what changed + why); not a progress log, so don't restate the plan or dump test counts / "all fixed" / "verification re-run" / "superseding" notes there.
- Before claiming completion, run the plan's `## Verification plan` yourself and confirm its observations hold. SAVE durable proof: commit real tests that drive the shipped code in-repo, and write the captured run output to your scratch dir (the one the goal rules name; never shared `/tmp/...`). Fix any missing observation before calling the goal complete.
