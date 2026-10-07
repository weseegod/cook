---
name: bug-fix
description: "Use when asked to fix a reported bug: an issue report, failing test, wrong output, error or stack trace, or regression. Not for new features or refactors."
---

Before editing, inspect the reported behavior and examples, relevant implementation and callers, and the closest tests. Save one concise plan with the goal and ordered steps to reproduce, fix, and verify the issue.

Turn each distinct behavior and edge case in the request or failing tests into an explicit expected result. Preserve unusual input values and nested or compatibility cases; do not replace them with only a generic happy path. Map every acceptance check to a specific existing test or a regression test to add.

After editing, run each focused test that covers a planned check and inspect its result. A broad suite or nearby passing test does not complete an uncovered check. Run broader related tests after the focused cases pass. Use the project's configured test environment; record missing dependencies, fixtures, or other blockers precisely.

Review the complete diff against the plan. Mark checks complete only when their corresponding evidence passes, and report any unresolved check accurately.
