# Common Workflows

Use a goal for a long task, plan mode when you want to review steps before code changes, and compaction when the conversation is getting large.

## Work on a long task with `/goal`

Goals let Cook keep working over multiple rounds. Describe the result you want, then check progress with `/goal status`.

```text
/goal Move the settings page to the new component system
/goal status
/goal pause
/goal resume
```

You can set a token budget with `--budget`, start from a plan file with `--plan path`, or use the current plan with `--from-plan`:

```text
/goal Update the API client --budget 500000
/goal Update the API client --plan docs/migration-plan.md
/goal Update the API client --from-plan
```

Use `/goal clear` to clear a finished or failed goal before starting another. Goals are available only when goal mode is enabled for the session. See [Plan Mode](19-plan-mode.md) and [Slash Commands](04-slash-commands.md#goal) for details.

## Review a plan before coding

Tell Cook to plan first, or run `/plan` to switch the current session to plan mode. Cook will inspect the work and write a plan before making code changes. Review it, then approve it to continue.

```text
/plan
/plan Add retries to the payment client
/view-plan
```

Use `/view-plan` to reopen the current plan. `/show-plan` and `/plan-view` are aliases. Plan mode is also available with `--no-plan` to turn it off for a session. See [Plan Mode](19-plan-mode.md).

## Make room with `/compact`

When a session uses much of its context, run `/compact` to shorten older conversation details and make room for the next steps. Add a note if Cook should keep something in view:

```text
/compact
/compact keep the migration decisions and test results
```

Before compaction, use `/flush` to save useful information to memory when memory is enabled. Cook also compacts automatically when context use reaches its configured limit. See [Session Management](17-sessions.md#the-compact-command) and [Memory](13-memory.md).

## Continue a session later

Cook saves sessions automatically. Use `/resume` in the terminal app, or `cook --continue` in a terminal to pick up your latest session in the current folder. Use `cook --resume <session-id-or-title>` to select a specific one. The desktop app lists your recent sessions in the sidebar.

See [Session Management](17-sessions.md) for forks, exports, and other session actions.
