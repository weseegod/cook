---
name: statusline
description: Configure the Grok Build status line.
---

# Status line

Edit the user's status-line config. Do the write. Do not only describe it.

## Where to write

Resolve the config file as `$GROK_HOME/config.toml` when `GROK_HOME` is set, otherwise `~/.grok/config.toml`. If that path is a symlink, edit the target. Create the file if it is missing. Keep every other key.

Write `[ui.status_line]` only in that user file. A repository `.grok/config.toml` cannot set this row, and campaign or version-override patches strip it.

Read the current `[ui.status_line]` table first. If the user already said what they want, do that. Otherwise ask once: built-in segments, a custom script, or off.

## What to write

Built-in, when they want the row and did not ask for a script:

```toml
[ui.status_line]
type = "builtin"
items = ["cwd", "model", "context"]
```

`items` are `cwd`, `model`, `context`, `cost`, `turn-timer`, `session-name`, in the order listed. Omitting `items` means `cwd`, `model`, `context`. Keep at least one.

Custom script, when they asked for one or for something the built-in items cannot show:

```toml
[ui.status_line]
type = "command"
command = "~/.grok/statusline.sh"
```

Save the script under the same home as the config file, then `chmod +x` it. Set `command` to that path. The block above is the default home; substitute the resolved home when `GROK_HOME` is set. A `~/` prefix expands to the home directory. `command` may be a shell line.

`refresh_interval` is seconds from 1 to 86400, and only with `type = "command"`. Set it when the row must update while idle. A timer run sets `trigger` to `refresh_interval`; any other run sets it to `state`. Call the network on `refresh_interval` and read a cache on `state`.

`padding` is 0 to 16 on either type. It insets the row. It does not move it. The row's place is fixed: bottom of the full screen, under the prompt info row in minimal mode. A script prints text. It does not place or align that text.

Off:

```toml
[ui.status_line]
type = "disabled"
```

`off`, `none`, and `hidden` mean the same as `disabled`.

## Script contract

Grok writes one JSON object to the script's stdin and shows stdout: at most 5 lines, 1024 characters each. The run times out at 10 seconds. Stderr is not shown. Empty stdout on success hides the row. A missing field is omitted, not zero. `jq` prints the text `null` for a missing key, so use `//`.

Read fields that are on the stdin object. Common ones: `cwd`, `session_id`, `session_name`, `transcript_path`, `model.display_name`, `workspace.current_dir`, `workspace.repo_root`, `workspace.branch`, `context_window.used_percentage`, `cost.total_cost_usd`, `turn.started_at_ms`, `trigger`. There is no `project_dir`, dirty-file count, rate limit, or editor mode. Call `git` for dirty state.

`transcript_path` is the session transcript when present. Read it for a URL the user or the agent already wrote in full. Do not build a URL from a bare number. Cache that read so a busy turn does not rescan the file on every run.

ANSI color is kept. An OSC 8 hyperlink is kept for an `http`, `https`, or `mailto` target, and any other target is plain text. Write it as `ESC ] 8 ; ; url BEL label ESC ] 8 ; ; BEL`. The 1024-character cut counts those escapes. Test the script with mock stdin before setting `command`.

## After the edit

A change to this table is read at startup, so they must restart. A change to the script file applies on the next run. The row is absent on the welcome screen and in a fullscreen subagent view. A row that begins `[ui.status_line]` names a key Grok could not use; fix that key. `grok inspect` lists the same problems.
