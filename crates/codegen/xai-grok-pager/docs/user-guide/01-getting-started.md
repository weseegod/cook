# Getting Started

Cook has two apps. The **Cook CLI** runs in your terminal, and **Let Cook** is
the desktop app for Windows, macOS, and Ubuntu. Both work with your local
projects and use the same Cook agent. This page introduces the CLI; see the
[Desktop App Reference](29-desktop-reference.md) for Let Cook.

Use the CLI as an interactive terminal app, run it in scripts and CI, or
connect it to an editor through the Agent Client Protocol (ACP).

---

## Installation

Install the CLI on macOS or Linux:

```bash
curl -fsSL https://download.letcook.dev/install.sh | COOK_INSTALL_CLI_ONLY=1 bash
```

Install only Let Cook Desktop on macOS or Linux:

```bash
curl -fsSL https://download.letcook.dev/install.sh | COOK_INSTALL_DESKTOP_ONLY=1 bash
```

On Windows, download the Let Cook installer and Cook CLI separately from the
[download page](https://letcook.dev/#install). Some desktop packages include
the Cook agent. If Let Cook asks for the agent, install the CLI too.

To build the CLI from source, install Rust and
[DotSlash](https://dotslash-cli.com), then run:

```bash
./build.sh
```

The build installs the `cook` binary under `~/.cook/bin`.

Verify the installation:

```bash
cook --version
```

Update to the latest version at any time:

```bash
cook update
```

To fetch a repository through Grove (NFS on macOS, FUSE on Linux), enable
`cook clone` with `[clone] enabled = true` in Grove config, `GROK_CLONE=1`,
or the enable-both convenience `GROK_GROVE=1` / `[cli] grove = true` in
`~/.cook/config.toml`:

```bash
cook clone <url> [dir]
```

The default is a depth-1 checkout of the selected branch. Pass `--full-history`
for a complete clone. Clone enablement is independent of session / `-w` Grove
worktrees (the convenience above turns both on; the specific knobs still win).
the sign-in flow below — see [clone authentication](27-grok-clone.md#authentication)
and [Configuration reference](26-config-reference.md).

---

## First Launch

Start the terminal app by running:

```bash
cook
```

On first launch, Cook uses the configured provider authentication flow. If you
use a hosted provider, Cook stores credentials in `~/.cook/auth.json`, where
they persist across sessions. Cook refreshes credentials when supported and
prompts you to authenticate again when they expire.

For API-key authentication (for example in CI/CD), configure the provider in
`~/.cook/config.toml` or set the provider's documented environment variable:

```bash
export LOCAL_API_KEY="..."
cook
```

See [Authentication](02-authentication.md) for terminal sign-in, API keys,
OIDC, external auth providers, and device-code flow. In Let Cook, choose a
workspace folder and connect a provider in the app; see the
[Desktop App Reference](29-desktop-reference.md#first-launch).

---

## Basic Interaction

Once authenticated, Cook presents a full-screen TUI with two main areas:

- **Scrollback** -- the conversation history showing your prompts, Cook's responses, tool calls, file edits, and more.
- **Prompt** -- the input area at the bottom where you type messages.

Type a message and press `Enter` to send it. Cook reads files, runs commands, and edits code as needed. Each tool run streams into the scrollback in real time.

Press `Tab` to move focus between the prompt and the scrollback. While a turn is running, `Ctrl+C` cancels it once the composer is empty — with a draft, the first press only clears it. `Esc` never cancels a turn; mid-turn it shows a reminder to use `Ctrl+C`. Idle, press `Esc` twice within 800ms to clear a non-empty prompt, or (with an empty prompt and conversation messages) to open rewind — see [Keyboard Shortcuts](03-keyboard-shortcuts.md#escape). With the scrollback focused, use the arrow keys to select entries and to collapse or expand them. To navigate with `j`/`k` and fold with `h`/`l` instead, enable Vim mode.

### File References

Use `@` in your prompt to attach files:

```
@src/main.rs              # Attach a file
@src/main.rs:10-50        # Attach lines 10-50
@src/                     # Browse a directory
```

The `@` operator opens a fuzzy file picker. By default it respects `.gitignore` and hides dotfiles. Prefix with `!` to search hidden files:

```
@!.github                 # Search hidden files
@!.env                    # Attach a .env file
```

### Permissions

By default, Cook asks for permission before executing shell commands or editing files. You can approve individually or toggle always-approve mode:

- Press `Ctrl+O` to toggle always-approve mode
- Use the `--yolo` flag at launch: `cook --yolo`
- Type `/always-approve` in the prompt to toggle the mode

---

## Key Concepts

### Sessions

Every conversation is a **session**. Sessions are automatically saved to `~/.cook/sessions/` and can be resumed later. Each session tracks the full conversation history, tool calls, file edits, and task state.

- Start a new session: `Ctrl+N` or `/new`
- Resume a previous session: `/resume` in the TUI, or `--resume <ID>` from the CLI
- Continue the most recent session: `cook -c`

### Scrollback

The scrollback is the main display area. It shows:

- **User prompts** -- your messages, rendered as sticky headers
- **Agent messages** -- Cook's responses with full markdown rendering and syntax highlighting
- **Thinking blocks** -- Cook's reasoning process (collapsible)
- **Tool calls** -- file edits (with inline diffs), command executions, search results, and more
- **Task lists** -- TODO items tracking progress

Collapse or expand the selected entry with the `Left`/`Right` arrow keys (or `h`/`l` and `e` in Vim mode). In Vim mode, press `y` to copy its content and `Y` to copy its metadata (for example, the command that ran). Press `Enter` to open it in the fullscreen viewer (in any mode).

### Tools

Cook has built-in tools for:

| Tool | Description |
|------|-------------|
| `read_file` / `search_replace` | Read and edit files with line-precise changes |
| `grep` | Regex search across your codebase (powered by ripgrep) |
| `list_dir` | List directory contents |
| `run_terminal_command` | Execute shell commands |
| `web_search` / `web_fetch` | Search the web and fetch URLs |
| `todo_write` | Create and manage task lists |
| `spawn_subagent` | Spawn parallel subagent sessions |
| `memory_search` | Search cross-session memory |

Tools can be extended with [MCP servers](05-configuration.md#mcp-servers) for integrations like GitHub, databases, and more.

### Slash Commands

Type `/` in the prompt to access commands. These provide quick actions without writing a full prompt:

```
/model grok-4.6                 # Switch model
/compact                          # Compress conversation history
/always-approve                   # Toggle always-approve mode
/new                              # Start a new session
```

See [Slash Commands](04-slash-commands.md) for the complete reference.

---

## Common Launch Options

```bash
# Launch the interactive TUI and submit an initial prompt as the first turn
cook "fix the failing auth test and run it"

# Initial prompt in a new git worktree. Use --worktree=<name> (with `=`) so the
# prompt isn't swallowed as the worktree name — `cook -w "refactor module X"`
# would treat "refactor module X" as the worktree label, not the prompt.
cook --worktree=feat "refactor module X"

# Base the worktree on a specific branch (e.g. main) instead of the current HEAD:
cook -w --ref main "implement feature from main"


# Start in a specific project directory
cook --cwd ~/projects/my-app

# Add project-specific rules
cook --rules "Always use TypeScript. Prefer functional components."

# Auto-approve all tool executions
cook --yolo

# Use a specific model
cook -m grok-build

# Resume a previous session
cook --resume <session-id>

# Continue the most recent session
cook -c

# Experimental scrollback-native render mode. Sticky: plain `cook` reopens in
# the mode last chosen via --minimal/--fullscreen (or /minimal//fullscreen).
cook --minimal

# Back to the standard fullscreen TUI (and make it sticky again)
cook --fullscreen

# Headless mode (for scripts)
cook -p "Explain this codebase"
```

---

## Headless Mode

Run Cook non-interactively for scripting, CI/CD, and automation:

```bash
cook -p "Your prompt here"
```

Output formats:

| Format | Flag | Description |
|--------|------|-------------|
| `plain` | (default) | Human-readable text |
| `json` | `--output-format json` | Single JSON object with `text`, `stopReason`, `sessionId`, and `requestId` |
| `streaming-json` | `--output-format streaming-json` | NDJSON event stream for real-time processing |

Example CI/CD usage:

```bash
cook -p "Review changes for bugs" --output-format json --yolo | jq -r '.text'
```

---

## Project Rules (AGENTS.md)

Add per-project instructions by creating an `AGENTS.md` file in your repository. Cook reads these files and injects their contents as a project-instructions message at the start of the conversation:

```
~/.cook/AGENTS.md           # Global rules (apply to all projects)
<repo-root>/AGENTS.md       # Repository-level rules
<cwd>/AGENTS.md             # Directory-level rules (highest priority)
```

Deeper files take precedence. Cook also reads `CLAUDE.md` files for compatibility.

---

## Where to Go Next

| Document | What You Will Learn |
|----------|-------------------|
| [Authentication](02-authentication.md) | Browser login, API keys, OIDC, external auth, device code flow |
| [Desktop App](29-desktop-reference.md) | Install and use Let Cook on Windows, macOS, and Ubuntu |
| [Keyboard Shortcuts](03-keyboard-shortcuts.md) | Complete reference for all key bindings |
| [Slash Commands](04-slash-commands.md) | All available `/` commands |
| [Configuration](05-configuration.md) | config.toml, pager.toml, environment variables |
