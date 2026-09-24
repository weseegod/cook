# Desktop App Reference

Let Cook is Cook's desktop app for Windows, macOS, and Ubuntu. Choose a folder to open a workspace, connect a model provider, then chat with Cook. The desktop app keeps your files and sessions on your computer while using your chosen model provider.

## Find actions and commands

Press `Ctrl+K` on Windows or Linux, or `⌘K` on macOS, to open **Search everything**. Search for sessions, models, commands, and app actions in one place. Select an item to run it. Press `?` outside a text field to open the keyboard shortcuts sheet.

The action list can change when a feature or account setting is off. Commands from the agent appear in the same search results when they are available in the current session.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` / `⌘K` | Search sessions, models, commands, and actions. |
| `⌘,` | Open Settings on macOS. On Windows and Linux, use the Settings button. |
| `Ctrl+Shift+G` | Open Review. |
| `Ctrl+G` | Show or hide background tasks. |
| `Ctrl+P` / `⌘P` | Open Files. |
| `Ctrl+W` / `⌘W` | Close the current dialog or panel. |
| `?` | Show the shortcuts sheet. |
| `Esc` | Close the current picker or cancel editing a queued prompt. |

To stop a running turn, use the **Stop** button in the composer.

The same shortcuts sheet is available from Settings → About. Key labels show both Windows/Linux and macOS where they differ.

## Actions in Search everything

Search everything includes these app actions. It can also show sessions, models, and available slash commands.

| Action | What it does |
|---|---|
| New chat | Start a new session. |
| Fork conversation | Start a new session with the current conversation's history. |
| Export transcript | Save the current conversation. |
| Open folder | Choose a workspace folder. |
| Open settings | Change models and app settings. |
| View plan | Open the current plan. |
| Show activity | See background work. |
| Rewind conversation | Return to an earlier point in the session, when this feature is enabled. |
| Recap session | Ask Cook for a short recap, when this feature is enabled. |
| Connect a provider | Open the model setup screen. |
| Show keyboard shortcuts | Open the shortcuts sheet. |

The right hand **Tools** panel also has **Review**, **Files**, **Activity**, and **Preview**. The shortcuts sheet opens Review with `Ctrl+Shift+G` and Files with `Ctrl+P` or `⌘P`.

## How desktop differs from the terminal app

- Desktop uses **Search everything** for app actions. In the terminal app, `/help` or `Ctrl+P` opens the command palette.
- Desktop has no fullscreen or minimal terminal display modes. `/minimal`, `/fullscreen`, `/find`, `/jump`, `/timeline`, and terminal theme actions belong to the terminal app.
- Desktop has no terminal keyboard or mouse controls. Use the app's buttons, search, and shortcuts instead.
- When a slash command is supported in desktop, Cook shows it in Search everything. What appears depends on the connected agent, account, and enabled features.

For the complete terminal command list, see [Slash Commands](04-slash-commands.md) and [Keyboard Shortcuts](03-keyboard-shortcuts.md). For downloads, see [Getting Started](01-getting-started.md).
