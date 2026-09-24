# Cook User Guide

Cook has two apps: the Cook CLI for the terminal and Let Cook for the desktop.
Both use Cook's local agent and settings. These guides cover both apps;
terminal-only shortcuts and commands are labeled as such. See
[letcook.dev](https://letcook.dev) for the project website.

## Get started

| Guide | Use it for |
|---|---|
| [Getting Started](01-getting-started.md) | Install the CLI and desktop app, then start a session. |
| [Desktop App](29-desktop-reference.md) | Set up Let Cook, use its tools, and find desktop shortcuts. |
| [Authentication](02-authentication.md) | Terminal sign-in, API keys, OIDC/SSO, external providers, and device code. |
| [Keyboard Shortcuts](03-keyboard-shortcuts.md) | Keyboard and mouse controls in the terminal app. |
| [Slash Commands](04-slash-commands.md) | Terminal commands, aliases, and feature requirements. |
| [Configuration](05-configuration.md) | `config.toml`, `pager.toml`, environment variables, and file locations. |

## Configure and extend Cook

| Guide | Use it for |
|---|---|
| [Theming and Appearance](06-theming.md) | Terminal themes, layout, animation, and colors. |
| [MCP Servers](07-mcp-servers.md) | Connect external tools through the Model Context Protocol. |
| [Skills](08-skills.md) | Create reusable instructions in the `SKILL.md` format. |
| [Plugins](09-plugins.md) | Install and create bundles of skills, commands, agents, hooks, and MCP servers. |
| [Hooks](10-hooks.md) | Run scripts and HTTP callbacks during a session. |
| [Custom Models](11-custom-models.md) | Connect API-compatible services and self-hosted models. |
| [Project Rules](12-project-rules.md) | Add `AGENTS.md` instructions for a project or directory. |
| [Memory](13-memory.md) | Save and find useful information across sessions. |

## Workflows and reference

| Guide | Use it for |
|---|---|
| [Headless Mode and Scripting](14-headless-mode.md) | Run Cook from scripts and CI. |
| [Agent Mode and IDE Integration](15-agent-mode.md) | Connect editors and other clients over ACP. |
| [Subagents and Personas](16-subagents.md) | Run parallel child sessions and define agent personas. |
| [Session Management](17-sessions.md) | Save, resume, rewind, and compact sessions. |
| [Sandbox Mode](18-sandbox.md) | Limit filesystem and network access. |
| [Plan Mode](19-plan-mode.md) | Review a plan before Cook changes files. |
| [Background Tasks and Monitoring](20-background-tasks.md) | Run and monitor long-running work. |
| [Terminal Support and Troubleshooting](21-terminal-support.md) | Set up terminal colors, clipboard, SSH, and tmux. |
| [Permissions and Safety](22-permissions-and-safety.md) | Control what Cook can read, run, and change. |
| [Agent Dashboard](23-dashboard.md) | View sessions and child agents in the terminal app. |
| [Monitoring Usage](24-monitoring-usage.md) | Export usage data with OpenTelemetry. |
| [Status Line](25-status-line.md) | Configure the terminal app's status row. |
| [Configuration Reference](26-config-reference.md) | Find every supported config field. |
| [Grove Clone](27-grok-clone.md) | Fetch a repository through Grove. |
| [Terminal CLI Reference](28-cli-reference.md) | Look up CLI commands and options. |
| [Common Workflows](30-workflows.md) | Use goals, plan mode, compaction, and continuing sessions. |
