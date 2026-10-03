---
name: run-checks
description: Choose and run focused checks for a code change, and diagnose failures.
---

Use the smallest set of checks that covers the intended outcomes. One integration check may cover related outcomes. Add a focused check only for an uncovered outcome. Do not require one script to drive the whole product to its end state.

Run a check when the change it covers is ready, not after every edit. If other work can continue, run it in the background and do that work. Do not sleep-loop or ask for that run's status again. Read the result once when it arrives, before relying on it. If nothing else can continue, run it in the foreground. Do not start another run of a suite that is already running.

Rerun only checks that failed. After the last edit, verify the acceptance criteria. A check already run on the unchanged tree counts for the outcomes it covers. Widen the run only when the project's practice requires it or the change reaches behavior those checks miss. Stop when a rerun shows the same failure and diagnosis; a reworded error is the same failure.

When a check fails, decide whether the failure is in the product, test or harness, or environment:

- Product: fix the product.
- Test or harness: fix the test or harness. Do not change the expected result to match the bug, delete the case, or skip it.
- Environment: say why the check cannot run and verify what you can. Do not build a stand-in for a missing tool. If no check covers a required outcome, observe it or add one check that drives the shipped behavior.
