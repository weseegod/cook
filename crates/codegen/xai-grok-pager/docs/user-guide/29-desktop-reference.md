# Let Cook Desktop

Let Cook is Cook's desktop app for Windows, macOS, and Ubuntu. It gives you a
chat window for working in a local project, with a session list, model settings,
file tools, and review panels. This guide covers the desktop app; for terminal
use, see [Getting Started](01-getting-started.md).

## Install

On macOS or Linux, install Let Cook without the CLI by running:

```bash
curl -fsSL https://download.letcook.dev/install.sh | DESKTOP_ONLY=1 bash
```

The command supports macOS and Linux x86_64. Windows users can download the
desktop installer from the [Cook download page](https://letcook.dev/#install).

Some desktop packages include the Cook agent. If Let Cook asks for the agent,
install the [Cook CLI](01-getting-started.md#installation) too. Ubuntu users can
choose the `.deb` package; other Linux users can try the AppImage.

## First launch

1. Open Let Cook and choose **Open workspace**.
2. Pick the project folder you want Cook to work in. Let Cook opens the folder
   on your computer and starts a session for it.
3. If Cook needs a model connection, choose **Connect a provider**. Sign in or
   enter the provider's API key, then choose the model for new chats. You can
   change providers and models later in **Settings → Models**.
4. Type a request and send it. Cook shows its replies and tool activity in the
   chat. Depending on your permission settings, it may ask before running a
   command or editing files. Use **Stop** to stop a running turn.

## Chats and search

The left sidebar lists conversations for the current workspace. Start a new
chat, reopen a conversation, rename it, or use **Search everything** to find a
session. Search also finds models, app actions, and commands that are available
in the current session.

Press `Ctrl+K` on Windows or Linux, or `⌘K` on macOS, to open Search everything.
Choose a result or type `/` in the message box to find a command.

## Search actions

Search everything includes these app actions. Some need an open chat or a
feature supported by the connected agent.

| Action | What it does |
|---|---|
| New chat | Start a new conversation. |
| Fork conversation | Create a new chat from the current conversation. |
| Export transcript | Save the current chat's user and Cook messages as Markdown. |
| Open folder | Choose another project folder. |
| Open settings | Change app and model settings. |
| View plan | Open the current plan, when one exists. |
| Show activity | Open the Activity panel. |
| Rewind conversation | Return to an earlier point, when the connected agent supports rewind. |
| Recap session | Ask Cook for a recap, when the connected agent supports recaps. |
| Connect a provider | Open the model setup screen. |
| Show keyboard shortcuts | Open the shortcuts sheet. |

## Slash commands

Let Cook handles some commands in the app and sends other commands to the Cook
agent. The command menu shows commands available to the current session, so its
contents can change with the connected agent and enabled features.

| Command | What it does |
|---|---|
| `/new` | Start a new conversation. |
| `/plan` | Enter plan mode before making changes. |
| `/model <name>` | Switch the active model. |
| `/always-approve on\|off` | Turn command and edit approval prompts on or off. |
| `/view-plan` | Open the current plan. Aliases: `/show-plan`, `/plan-view`. |
| `/context` | Show the model, session, and context usage when reported. |
| `/fork` | Create a new chat from this conversation. |
| `/export` | Save the current conversation as Markdown. |
| `/tasks` | Open background tasks and subagents. |
| `/dashboard` | Open the Activity panel. Aliases: `/agents-dashboard`, `/sessions`. |
| `/memory` | Open memory settings and ask Cook to refresh memory. Alias: `/mem`. |
| `/rewind` | Return to an earlier turn when supported. Alias: `/undo`. |
| `/recap` | Summarize the current session when supported. Alias: `/summarize`. |

Commands such as `/goal`, `/compact`, `/workflow`, and skill commands come from
the connected agent. They appear when that agent and your settings make them
available. For the full Cook CLI command list, see [Slash Commands](04-slash-commands.md).

## Workspace tools

Open the **Tools** panel from the top bar:

| Tool | What it does |
|---|---|
| Review | Compare workspace changes with the Git `HEAD` version. |
| Files | Browse project files and preview supported text files. |
| Activity | Check background work and subagents. |
| Preview | View files or other outputs that Cook opens for review. |

## Settings

Open **Settings** from the sidebar. The app has pages for appearance, models,
connectors, memory and project instructions, skills, hooks, stored data, and
app information. Use **Data Controls** to review or erase data stored by the
app.

Let Cook uses Cook's local settings and session storage. Your selected model
provider receives the prompt and project context needed to answer it.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` / `⌘K` | Open Search everything. |
| `⌘,` | Open Settings on macOS. On Windows and Linux, use the Settings button. |
| `Ctrl+Shift+G` | Open Review. |
| `Ctrl+G` | Show or hide background tasks. |
| `Ctrl+P` / `⌘P` | Open Files. |
| `?` | Open the shortcuts sheet when you are not typing in a text field. |
| `Esc` | Close the active picker or dialog, or return from a tool view. |

To stop a running turn, use the **Stop** button in the message box. The
shortcuts sheet also lists useful commands such as `/new`, `/plan`, and
`/always-approve`.

## How desktop differs from the terminal app

- Let Cook has a chat window and app panels. It does not have the terminal
  app's full-screen layout or navigation keys.
- The app's **Tools** panel and **Search everything** replace some terminal
  menus and overlays. Cook can still run commands as part of a task and show
  the results in chat.
- Some commands and shortcuts are specific to one app. The terminal commands
  `/minimal`, `/fullscreen`, `/find`, `/jump`, and `/timeline` control the
  terminal interface and are not desktop view controls.
- The agent can expose commands, skills, and workflows in both apps. What is
  available depends on the connected agent and your settings.
