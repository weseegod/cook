# Prompts

Cook injects a set of model-facing prompt templates: the plan-mode reminders, the goal
templates, and the built-in subagent bodies. Each one ships as the default in the `prompts/`
directory of the Cook source, compiled into the binary. You can override any of them with a copy
under your Cook home, without rebuilding Cook, and reset it to the shipped text when you are done.

---

## Where prompts live

| Location | Role |
|----------|------|
| `prompts/` in the Cook source tree | The shipped defaults. Compiled into the binary with `include_str!`; editing one requires rebuilding. |
| `~/.cook/prompts/` | Your copies. Same relative layout as `prompts/`; a file here overrides the matching default at the next turn. |
| `<workspace>/.cook/prompts/` | Project copies. Outrank `~/.cook/prompts/` for sessions in that workspace. |

Precedence for a given template: project `.cook/prompts/`, then `~/.cook/prompts/`, then the
compiled default.

The relative paths are:

```text
prompts/
  plan/full.md                     plan-mode activation reminder
  plan/sparse.md                   per-turn plan-mode reminder
  plan/reentry.md                  reminder after re-entering plan mode
  plan/exit.md                     reminder when plan mode ends
  plan/edit-rejected.md            message when a plan-mode edit is refused
  goal/goal_rules.md               goal rules block
  goal/goal_rules_legacy.md        goal rules block (legacy)
  goal/goal_plan_block.md          plan block shown to a goal
  goal/goal_task_discipline.md     task-tracking discipline block
  goal/goal_continuation_directive.md        continuation directive
  goal/goal_continuation_directive_legacy.md continuation directive (legacy)
  goal/goal_planner_prompt.md      goal planner prompt
  goal/goal_strategist_prompt.md   goal strategist prompt
  goal/goal_summarizer_prompt.md   goal summarizer prompt
  goal/goal_verifier_prompt.md     goal verifier prompt
  goal/goal_verifier_resume_prompt.md  goal verifier resume prompt
  goal/goal_verifier_kind_lens_*.md    per-kind verifier lens
  subagent/plan.md                 built-in plan subagent body
  subagent/explore.md              built-in explore subagent body
  subagent/general-purpose.md      built-in general-purpose subagent body
```

---

## Editing a prompt

### Desktop app

Open **Settings → Prompts**. The panel lists every editable template with a state:

| State | Meaning |
|-------|---------|
| No copy | The shipped default is in use; no file exists under your Cook home yet. |
| Unmodified | A copy exists and still matches the shipped default. |
| Modified | A copy exists and differs; it overrides the default. |

Select a template, press **Edit**, and save. Editing a template with no copy seeds the editor
with the shipped text. **Reset** discards your copy and writes the shipped default back, byte for
byte. Resetting is the only way to start receiving changes to that prompt from Cook updates; a
file you edited is left alone.

### Terminal app

Create the file yourself under `~/.cook/prompts/`, mirroring the relative path:

```bash
mkdir -p ~/.cook/prompts/plan
cp prompts/plan/full.md ~/.cook/prompts/plan/full.md   # from a Cook checkout
$EDITOR ~/.cook/prompts/plan/full.md
```

Cook picks up the change on the next turn; no restart is needed. Delete the file to fall back to
the shipped default.

---

## Things to know

- An override applies to every session on the machine, not just the current one.
- Keep the `${...}` placeholders (for example `${plan_path}` and `${TODO_TOOL}`) exactly as they
  are. They are filled in when the template is rendered; a template that fails to render falls
  back to the shipped default and logs a warning.
- The plan-mode reminders are a gate: they tell the model to write the plan file before making
  edits. Rewriting one carelessly can weaken that gate.
- Your copies are never overwritten by Cook updates. The panel's **Reset** button is how you
  return to the shipped text.
- `~/.cook/prompts/manifest.json` records the shipped defaults' checksums. Cook manages this file;
  you do not need to edit it.

---

## Related

- [Plan Mode](19-plan-mode.md)
- [Subagents and Personas](16-subagents.md)
- [Skills](08-skills.md)
