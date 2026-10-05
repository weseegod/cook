# /learn output format

Two files in the run directory. `report.md` is for the user. `actions.json` is for the apply step. Every action in `actions.json` must appear in `report.md`, and every claim in sections 1–3 of `report.md` must be backed by a verifier's Kept list.

## report.md

Write short sentences with one meaning each. No hedged summaries: a count is a number, a path is a path.

```markdown
# /learn report — <today>

## Overview
Problem: <2–4 sentences: what the traces show the user repeating, correcting, or never using>
Proposed change: <2–4 sentences: the smallest set of harness edits that removes that repetition>
Actions: <N> total — <a> new skills, <b> skill updates, <c> enables, <d> deletes/disables, <e> need a decision

## 1. Repeated phrases -> skills
| # | Phrase (quoted) | Sessions | Owner | Action |
Owner is an existing skill (name, path) or NEW <name>. Action is the action id from actions.json.

## 2. Skills to update
| # | Skill (path) | Stale line (quoted) | Evidence (session ids) | Replacement | Action |

## 3. Unused -> delete or disable
| # | Name | Kind | Count | Last used | Why safe | Action |
Kind is skill, plugin, mcp, workflow, or hook. "Why safe" names what still does the job, or says `only copy — ask`, or `referenced by <names> — ask`. A grouped action is one row that names the group and lists its members in the Name cell.

## 4. Gaps
Recurring needs with no owner. No action ids; these are for the user to decide.

## Unverified claims
Only present when a verifier section failed: the claims from that section, listed but not acted on unless the user asks; any action emitted for them carries `requires_confirmation: true`.

## Dropped claims
Bullet list: claim, reason it was dropped (which verifier, what failed). Include "previously rejected by the user" items here.

## Coverage
- sessions seen / kept / dropped by reason (from manifest.json)
- human turns read; sessions read by mappers vs total
- map or reduce slots lost; verifier sections that failed
- window and filters used (params from manifest.json)
- what this run could not see: headless sessions unless included, hook use, managed MCP servers, anything outside this machine's GROK_HOME
```

## actions.json

```json
{
  "run_dir": "<run_dir>",
  "generated_at": "<today>",
  "actions": [
    {
      "id": "A1",
      "kind": "skill | plugin | mcp | workflow | hook | config",
      "action": "create | edit | enable | disable | delete | propose | ask",
      "target": "<name>",
      "path": "<absolute path of the file or directory the action touches>",
      "protected": "plugin | bundled | git-tracked | null",
      "referenced_by": ["<loaded skill names that mention this skill>"],
      "reversible": true,
      "requires_confirmation": false,
      "evidence": {
        "sessions": ["<session id>", "..."],
        "count": 0,
        "quote": "<exact phrase or stale line, at most 300 chars>"
      },
      "reason": "<one sentence>",
      "edit": {
        "anchor": "<exact substring of the current file, or \"\" for create>",
        "replacement": "<full replacement text, or full file content for create>",
        "mode": "replace | insert_after | append"
      }
    }
  ]
}
```

Rules for the fields:

- `id` is `A1`, `A2`, … in report order.
- `path` is exact. For `plugin` and `mcp` actions it is the config file (`<GROK_HOME>/config.toml` or `settings.json`), and `edit.anchor` is the exact list or table header line to change. Never include config values other than names.
- `reversible` is `true` for edits with an anchor, enables/disables, and deletes (the apply step moves deleted files to `<GROK_HOME>/learn/trash/<run name>/`). It is `false` only when the apply step cannot undo the change from the trash directory or the anchor.
- `protected` and `referenced_by` are copied from `surfaces.json`. A protected skill is never edited or deleted in place: the action is `propose`, with `requires_confirmation: true` and a `reason` that says where the fix belongs — a user-skill override with the same name for `plugin` and `bundled`, a pull request for `git-tracked`. `propose` carries an `edit` block so the apply step can write the override or the patch.
- A `delete` whose `referenced_by` is non-empty is emitted as `ask`, and `reason` names the referrers.
- `requires_confirmation` is `true` for `ask`, `propose`, any `delete` of the only copy of a job, and any unverified claim.
- **Narrow windows prove nothing.** `manifest.json` → `disuse_evidence.sufficient` is `false` when the run was scoped to one working directory or listed sessions, kept fewer than 20 sessions, or spans under 7 days. In that case section 3 is titled `## 3. Not seen in this window`, lists the zero-use surfaces as information only, emits **no** `delete`, `disable`, `ask`, or `group` action for them, and the Overview's deletes/disables count is 0 with `disuse_evidence.reason` quoted ("window too narrow to judge disuse: scoped to one working directory; only 3 sessions kept"). A skill unused in three sessions from one folder may be the user's most-used skill everywhere else.
- **Grouping.** Unused surfaces that share a kind and a disposition (for example "12 zero-use bundled skills → propose overrides" or "9 zero-use plugin skills → ask") are one action with `kind: group`, `action` set to the shared disposition, `target` a short label, and an `items` array of `{name, kind, path, protected, referenced_by, count, last_used}`. One decision is worth one row; 40 rows that each say "ask" are not 40 decisions. Never group across dispositions and never group anything with evidence of use (`count > 0`). A referenced zero-use skill is never a `delete`; its disposition is `ask`, so it joins the `ask` group of its kind with `referenced_by` filled in its item — it does not get its own row. The Overview's action count counts a group as one.
- `edit` is required for `create`, `edit`, and `propose`; omit it for enable, disable, delete, ask.
- `create` writes `<user skills dir>/<name>/SKILL.md`. The `replacement` is the whole file: `---` frontmatter with `name`, `description` (what it does plus the trigger phrases), `user-invocable: true`, `origin: learn` (provenance the client reports as `skill_origin`; never omit it, never another value), then a body of imperative steps. Use the quoted phrases as the trigger list and the body.
