# Terminal CLI Reference

Use `cook --help` for the options in your installed version. Use `cook <command> --help` for a command's details. This page lists the main commands and common options.

## Start Cook

```sh
cook
cook "Fix the failing test"
cook --continue
cook --resume <session-id-or-title>
```

`cook` opens the interactive terminal app. Add a prompt to send your first request right away. Use `--continue` for the most recent session in this folder, or `--resume` with a session ID or title.

## Top-level commands

| Command | What it does |
|---|---|
| `cook agent` | Run Cook without the terminal UI or connect a client. Modes: `stdio`, `headless`, `serve`, and `leader`. See [headless mode](14-headless-mode.md) and [agent mode](15-agent-mode.md). |
| `cook completions <shell>` | Print shell completion setup for bash, zsh, fish, or PowerShell. |
| `cook dashboard` | Open the session dashboard at startup, when enabled. |
| `cook doctor` | Check terminal, clipboard, color, and input support. |
| `cook du` | Show how much disk space Cook uses. Alias: `disk-usage`. |
| `cook export <session>` | Save a session transcript as Markdown. |
| `cook help [command]` | Show help for Cook or one command. |
| `cook inspect` | Show the config Cook found for this folder. Add `--json` for JSON output. |
| `cook leader list\|info\|kill` | View or stop shared Cook processes. |
| `cook login` / `cook logout` | Sign in or clear saved sign-in details. |
| `cook mcp <action>` | `list`, `add`, `remove`, `enable`, `disable`, or `doctor` for MCP servers. `add` accepts `--transport stdio\|http\|sse` and `--scope user\|project`. |
| `cook memory clear` | Clear saved memory files. |
| `cook models` | List available models. |
| `cook plugin <action>` | `list`, `install`, `uninstall` (`rm`, `remove`), `update`, `enable`, `disable`, `details`, `validate`, `tag`, or `marketplace`. |
| `cook sessions list\|search\|delete` | Find or delete saved sessions. `list` and `search` accept `--limit <number>` (`-n`, default 20). |
| `cook setup` | Download managed team settings. Add `--json` to print a report without installing files. |
| `cook trace` | Export or upload session trace data. |
| `cook update` | Check for or install an update. Use `--check`, `--version <version>`, `--alpha`, or `--stable` to choose an action. |
| `cook usage <session-id> [turn]` | Show saved token and cost totals. |
| `cook version` | Print the version. Add `--json` for JSON output. Alias: `v`. |
| `cook worktree <action>` | `list` (`ls`), `show`, `rm`, `gc` (`prune`), or `db rebuild\|stats\|path`. |
| `cook wrap <command>` | Run a command in a local terminal that can copy text from a remote session. |

Run `cook <command> --help` to see subcommands and options. For example, `cook mcp --help`, `cook plugin --help`, and `cook sessions --help`.

`cook login` accepts `--oauth` or `--device-auth` (alias: `--device-code`). `cook update --json` prints update information as JSON. `cook update --force-reinstall` downloads the current version again.

## Common options

| Option | What it does |
|---|---|
| `--cwd <path>` | Start Cook in another folder. |
| `--model <name>` (`-m`) | Choose a model. |
| `--reasoning-effort <level>` (`--effort`) | Set reasoning effort for models that support it. |
| `--always-approve` (`--yolo`) | Run tools without asking first. Use only in a workspace where that is safe. |
| `--allow <rule>` / `--deny <rule>` | Add a permission rule. Older `--allowedTools` and `--disallowedTools` spellings also work. |
| `--permission-mode <mode>` | Choose `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, or `plan`. |
| `--sandbox <profile>` | Choose the filesystem and network sandbox. The `GROK_SANDBOX` environment variable also sets it. |
| `--worktree[=<name>]` (`-w`) | Start in a new Git worktree. |
| `--worktree-ref <branch>` (`--ref`) | Choose what branch or commit the worktree starts from. Use with `--worktree`. |
| `--restore-code` | Restore a saved code snapshot when resuming a session in a worktree. |
| `--no-plan` | Turn off plan mode for this session. |
| `--no-subagents` | Stop Cook from starting subagents. |
| `--minimal` / `--fullscreen` | Choose the terminal display for this session. |
| `--no-alt-screen` | Keep the terminal's alternate screen off. |
| `--oauth` | Use browser sign-in when Cook asks you to log in. |
| `--debug` / `--debug-file <file>` | Turn on debug logs, optionally saving them to a file. |
| `--leader-socket <path>` | Connect to a Cook leader at a custom socket path. |
| `--version` (`-v`, `-V`) | Print the installed version. `cook version --json` prints JSON. |
| `--agent <name>` / `--agents <json>` | Choose an agent, or define agents inline. |
| `--tools <names>` / `--disallowed-tools <names>` | Choose built-in tools to keep or remove. |
| `--max-turns <number>` | Stop after this many turns. |
| `--disable-web-search` | Turn off web search and fetch tools. |
| `--rules <text>` (`--append-system-prompt`) | Add instructions to Cook's system prompt. |
| `--system-prompt-override <text>` (`--system-prompt`) | Replace Cook's system prompt. |
| `--session-id <uuid>` (`-s`) | Set the ID for a new session. |
| `--fork-session` | Resume a session into a new session ID instead of reusing the old one. |

`--help` works at every level, including `cook agent --help` and `cook worktree --help`.

`--always-approve` also accepts the compatibility name `--dangerously-skip-permissions`. Prefer the short `--always-approve` name in new scripts.

## One-shot and scripted use

Use `-p`, `--single`, or the alias `--print` to send one prompt, print the answer, and exit. Use `--prompt-file` or `--prompt-json` to read the request from a file or structured content blocks.

```sh
echo "Summarize this change" | cook -p "$(cat)"
cook -p "Summarize this change" --output-format json
cook -p "Return a short JSON object" --json-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}'
```

Output formats are `plain`, `json`, `streaming-json`, and `streaming-messages-json`. `--include-partial-messages` adds text updates to the last format. `--json-schema <schema>` asks Cook to follow a JSON Schema and selects JSON output. `--verbatim` sends the prompt as written.

## Agent command options

`cook agent` starts a backend for an editor, script, or desktop client. Its modes are:

| Mode | What it does |
|---|---|
| `stdio` | Use the Agent Client Protocol over standard input and output. |
| `headless` | Connect a headless client over the Cook WebSocket relay. |
| `serve` | Start a local WebSocket server. Options include `--bind <address>`, `--secret <key>`, and `--remote <url>`. |
| `leader` | Run a shared agent process for multiple clients. |

Useful options for `cook agent` include `--reauth` (alias: `--reauthenticate`), `--model <name>`, `--reasoning-effort <level>` (alias: `--effort`), `--always-approve` (alias: `--yolo`), `--agent-profile <path>`, repeatable `--plugin-dir <path>`, and `--leader` or `--no-leader`. `serve`, `headless`, and `leader` also accept `--grok-ws-origin` and `--grok-ws-url` endpoint overrides.

For every flag supported by your installed version, run `cook agent --help` or `cook agent <mode> --help`.

Other subcommand options include `cook plugin install --trust`, `cook plugin uninstall --confirm`, and `cook plugin uninstall --keep-data`. `cook plugin tag` accepts `--push`, `--force`, and `--dry-run`. For worktrees, `list` accepts `--repo`, `--type`, `--json`, and `--all`; `rm` and `gc` accept `--force` and `--dry-run`, and `gc` also accepts `--max-age`. Use each command's `--help` page for argument examples.

## More detail

- [Install and start Cook](01-getting-started.md)
- [Authentication](02-authentication.md)
- [Headless mode and scripting](14-headless-mode.md)
- [Agent and IDE integration](15-agent-mode.md)
- [Session management](17-sessions.md)
- [Configuration](05-configuration.md)
