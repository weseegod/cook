# Thanh Desktop — Production Implementation

Bring v1 (`feat: implement Thanh Desktop v1`) to a **Claude Desktop–class**
product: first-run provider connect, attachments, MCP connectors, memory,
skills, polish, and shippable installers.

Architecture and invariants: [`docs/desktop-app.md`](desktop-app.md).  
Do not violate them. The renderer still never calls models or tools.

---

## 1. Where v1 stands

Shipped and usable as a local ACP chat shell:

- Tauri host spawns `thanh agent stdio`, JSON-RPC mux, crash restart
- Folder picker, session sidebar (list / search / rename / delete / resume)
- Streaming chat with turn-scoped coalescing, markdown + deferred Shiki/mermaid,
  TUI-style activity groups, pinned live command rail, inline plans, and copy
  actions
- Permission / ask-user / folder-trust inline decision cards, YOLO, slash
  palette, queue
- Model picker from `x.ai/models/list`, settings panel, `chmod 600` warning
- Alpha AppImage/deb path; CLI still required at runtime

**Not production yet.** Settings “Bring your own key” is a single text field
that does **not** connect third-party providers. Attachments, MCP UI, memory,
skills, command palette, notifications, light theme, macOS/Windows installers,
and auto-update are missing.

### Known v1 bugs to fix first

| Bug | Detail |
|---|---|
| `setApiKey` param mismatch | UI sends `{ apiKey, provider }`; agent reads `params.key` and writes **only** `XAI_API_KEY` / `auth.json`. `provider` is ignored. DeepSeek/OpenRouter keys never land in `[model_providers.*]`. |
| No provider catalog | User must hand-edit `~/.thanh/config.toml` (see [`byok-models.md`](byok-models.md)). Claude Desktop does not make you write JSON to chat. |
| Prompt is text-only | `session/prompt` sends `[{ type: "text" }]`. No image/file parts, so vision models and “drop a PDF” are dead. |
| `mcpServers: []` on every `session/new` | Relies on agent-side config discovery. Fine if that works; still no UI to enable/disable/add connectors. |

---

## 2. Product target

Parity target is **Claude Desktop**, not Cursor.

Claude Desktop is: conversations, projects/files, connectors (MCP), artifacts,
attachments, settings, notifications, a model picker — while the model runs
tools against the user’s world. Thanh already *is* that agent. Desktop must
expose it without a terminal.

| Claude Desktop | Thanh Desktop production |
|---|---|
| Sign in to Anthropic | **Connect a provider** (BYOK wizard + presets). Optional xAI login. |
| Model picker (Opus / Sonnet / Haiku) | Catalog from `x.ai/models/list` grouped by provider |
| Conversation sidebar + search | Already in v1; add pin, export, fork UI |
| Projects | Workspace folder + optional project instructions (`.thanh` / `AGENTS.md` already exist) |
| Attach files / images / screenshots | Composer drop + paste → ACP content parts |
| Connectors / MCP | Settings → Connectors: list, toggle, add stdio/HTTP, OAuth elicit |
| Artifacts | Preview panel: mermaid, HTML, images, diffs |
| Memory | Settings + `/memory` surface via `x.ai/memory/*` |
| Skills / extensions | Skills + plugins + hooks browsers |
| Permissions | v1 modals; persist grants with clearer copy |
| Dark theme | Keep dark; add system / light |
| Auto-update | Tauri updater for the app shell only |
| Voice | Defer (agent has `xai-grok-voice`; v2) |
| Claude.ai cloud sync | **Out of scope** — local-first `~/.thanh` |

Still out of scope: Monaco-as-IDE, debugger, git GUI, Windows until after
Linux+macOS ship.

---

## 3. Provider connections

This is the fork’s product. Users must connect DeepSeek, OpenRouter, OpenAI,
Anthropic, Gemini, Groq, local Ollama, or a custom OpenAI-compatible URL
**without editing TOML**.

### 3.1 Do not use `x.ai/setApiKey` for BYOK

That method is xAI-session keyed (`store_api_key` / `XAI_API_KEY`). Production
adds **fork-owned** ACP extensions. The agent remains the only writer of
`~/.thanh/config.toml`.

| Method | Role |
|---|---|
| `x.ai/providers/list` | Return configured `[model_providers.*]` (redact keys; `hasKey`, `envKey`, `baseUrl`, `apiBackend`, linked model ids) |
| `x.ai/providers/presets` | Built-in cards (below). No secrets. |
| `x.ai/providers/upsert` | Create/update provider + seed models. Params: `id`, `base_url`, `api_backend`, `api_key` **or** `env_key`, `extra_headers`, `models[]` |
| `x.ai/providers/delete` | Remove provider and its `[model.*]` rows; refuse if it is the last default without a replacement |
| `x.ai/providers/test` | One cheap completion (or `GET /models`) with the saved credential; return ok / HTTP status / truncated error |
| `x.ai/providers/discover_models` | For OpenAI-compatible `/v1/models`, merge into catalog with sane defaults |
| `x.ai/models/set_default` | Persist `[models] default = "…"` (today default is only `localStorage`) |

Hot-reload already exists for `config.toml`. After upsert, emit
`x.ai/models/update` so the picker refreshes.

Prefer `env_key` when the user checks “use environment variable”. Inline
`api_key` is allowed; after write, `chmod 600` the file (host already reports
world-readable).

### 3.2 Preset catalog (UI cards)

Curated in the desktop app (and mirrored in `x.ai/providers/presets` so TUI
could reuse later). User can still pick **Custom**.

| Id | Label | `base_url` | `api_backend` | Seed models (catalog key → API id) |
|---|---|---|---|---|
| `openai` | OpenAI | `https://api.openai.com/v1` | `chat_completions` | `gpt-5`, `gpt-4.1`, `o4-mini` (keep list data-driven; don’t hardcode stale ids in more than one place) |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1` | `messages` | Claude family; `extra_headers = { "anthropic-version" = "2023-06-01" }` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `chat_completions` | Discover via `/models` or seed a few (`anthropic/claude-sonnet-4.6`, `deepseek/deepseek-chat`) |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `chat_completions` | `deepseek-chat`, `deepseek-reasoner` |
| `zai` | Z.ai | `https://api.z.ai/api/paas/v4/` | `chat_completions` | `glm-5.1`, `glm-5`, `glm-4.7` |
| `xai` | xAI | native login **or** `https://api.x.ai/v1` | `chat_completions` / session | Grok catalog; optional `x.ai/auth/*` device-code |
| `google` | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/` | `chat_completions` | `gemini-2.5-pro`, `gemini-2.5-flash` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `chat_completions` | discover |
| `mistral` | Mistral | `https://api.mistral.ai/v1` | `chat_completions` | discover |
| `moonshot` | Moonshot / Kimi | `https://api.moonshot.ai/v1` | `chat_completions` | `kimi-k2.6`, `kimi-k3` |
| `together` | Together | `https://api.together.xyz/v1` | `chat_completions` | discover |
| `fireworks` | Fireworks | `https://api.fireworks.ai/inference/v1` | `chat_completions` | discover |
| `ollama` | Ollama (local) | `http://127.0.0.1:11434/v1` | `chat_completions` | discover; key optional |
| `custom` | OpenAI-compatible | user URL | user backend | user model id |

Keep DeepSeek / Xiaomi / Moonshot seeds compatible with [`byok-models.md`](byok-models.md).

Each card: logo, short help (“create a key at …”), API key field, optional
“Use env var name”, Test button, then model multi-select + **Set as default**.

### 3.3 First-run flow

If `x.ai/providers/list` is empty **and** `x.ai/models/list` has no selectable
BYOK/default the user can actually call:

1. Welcome: Open a folder (v1).
2. **Connect a provider** full-screen (not buried in Settings).
3. Test connection.
4. Pick default model.
5. Land on empty chat.

Skip the wizard when a working default already exists (CLI users who already
have `config.toml`). Settings always has **Providers** for add/edit/remove.

### 3.4 Implementation notes

- Patch TOML surgically in the agent (preserve comments/unknown keys). Reuse
  whatever `xai-grok-config` already uses for CLI `mcp` / plugin writes —
  **do not** parse-and-dump from TypeScript.
- After upsert, do not restart the agent if hot-reload covers providers. If
  it doesn’t, document one reconnect from the desktop host.
- Never echo secrets back on `list`. UI shows `sk-…xxxx` last-4 only if the
  agent sends `keyHint`.
- `x.ai/providers/test` must use the provider’s own base URL, never xAI.

**Files (expected)**

- Shell: `crates/codegen/xai-grok-shell/src/extensions/providers.rs` (new) +
  match arms in `acp_agent.rs`
- Config: helpers in `xai-grok-config` to upsert a table without clobbering
- Desktop: `src/ui/settings/providers.tsx`, `src/ui/welcome/connect-provider.tsx`,
  `src/acp/xai.ts`

---

## 4. Claude Desktop–class features

Ship in layers. Each layer is independently reviewable.

### P0 — Connect and talk (blocks “production”)

1. **Transcript parity with TUI:** coalesce ACP chunks without relying on
   `messageId`, group consecutive thought/tools, finalize on turn boundaries,
   and use the same projection for replay.
2. **Fix `setApiKey` mismatch** (or stop calling it from BYOK UI).
3. **Provider ACP + wizard + Settings → Providers** (§3).
4. **Persist default model** via agent, not only `localStorage`.
5. **Onboarding** when no provider works.
6. **Attachments:** composer paperclip + drag-drop + paste image.
   - Images → ACP `image` parts (`mediaType` + base64), gated on
     `inputModalities` containing `image` (same as TUI).
   - Other files → include path text + `read_file` hint, or
     `resource` parts if ACP supports them.
   - PDF/PPTX: rely on agent `read_file` special formats; attach as paths.
7. **Command palette** (`Ctrl/Cmd+K`): sessions, models, slash commands,
   Open folder, Settings, Connect provider.

### P1 — Connectors and project context (Claude Desktop core)

8. **Connectors (MCP)**
   - List from agent (`x.ai/mcp/*` status + config).
   - Toggle enabled, add stdio (`command`, `args`, `env`) or HTTP URL.
   - Surface `x.ai/mcp/elicit` in the existing interaction modal.
   - Do not spawn MCP from Tauri; agent already does.
9. **Project instructions** — show/edit `AGENTS.md` / `.thanh` rules for the
   cwd (read/write through ACP fs or a small `x.ai/project/files` helper).
10. **Memory** — settings panel + transcript “remember this”:
   `x.ai/memory/flush`, `rewrite`, open `MEMORY.md`.
11. **Skills / plugins** — browse `x.ai/skills/*` and `x.ai/plugins/*`;
    enable/disable. Marketplace can stay CLI for this slice.
12. **Export conversation** — Markdown download of the transcript; optional
    `x.ai/share_session` if the agent supports it.

### P2 — Artifacts, tasks, polish

13. **Artifacts / preview dock** — mermaid already inlines; add a right pane
    for HTML preview (sandboxed iframe), image gen output, full-file diffs.
14. **Tasks / subagents** — `x.ai/task/*` + `x.ai/subagent/*` cards (Claude
    Desktop doesn’t have this; Thanh should, because the agent does).
15. **Rewind / compact** buttons wired to existing extensions.
16. **Theme:** system / dark / light. Map TUI tokens.
17. **Desktop notifications** when a turn finishes in background.
18. **Keyboard shortcuts sheet** (Claude-like `?`).
19. **Usage** — `x.ai/session/usage` in the status bar (tokens, not paywall).

### P3 — Ship

20. **macOS dmg** (unsigned ok for the fork, same as CLI).
21. **Tauri updater** for the app binary only; never touch `~/.thanh/bin/thanh`.
22. **Stable sidecar optional** — bundle `thanh` for users without CLI.
23. **Windows** after Linux+macOS are boring.
24. Voice, embedded xterm PTY, worktree UI: keep as post-1.0.

---

## 5. UI map (production)

```
┌────────────┬─────────────────────────────────────┬──────────────┐
│ Sidebar    │ Main                                │ Dock (P2)    │
│ New chat   │ Compact title: workspace · actions  │ Artifact /   │
│ Search     │ Flat transcript                     │ diff / HTML  │
│ Sessions   │ Grouped activity · plan · markdown  │              │
│ Workspaces │ Editor-style composer               │              │
│ Connectors │ VS Code-style status bar            │              │
└────────────┴─────────────────────────────────────┴──────────────┘
Settings (modal or route):
  Providers | Models | Connectors | Memory | Skills | Appearance | About
```

First-run replaces main with **Open folder → Connect provider → Test**.

Visual target: VS Code Dark Modern density and controls, while preserving the
chat-first information architecture and macOS-style toggle switches. Tool-heavy
turns follow TUI grouping rather than rendering every ACP update as a card.

---

## 6. PR plan

| PR | Title | Scope | Depends |
|---|---|---|---|
| D1 | Fix BYOK key plumbing | Align `x.ai/setApiKey` params **or** stop using it; no user-visible wizard yet | — |
| D2 | Provider ACP | `x.ai/providers/{list,presets,upsert,delete,test,discover_models}`, `x.ai/models/set_default`; tests; no TS UI | D1 |
| D3 | Provider UI + onboarding | Cards, key/env, test, default model, Settings → Providers | D2 |
| D4 | Attachments | Paste/drop/paperclip → ACP parts; hide image attach on text-only models | — |
| D5 | Command palette | Ctrl/K: sessions, models, commands, settings | D3 |
| D6 | MCP connectors UI | List/toggle/add; elicit reuse | D2 |
| D7 | Memory + skills + project files | Settings surfaces | D2 |
| D8 | Export + usage + shortcuts + theme | Polish | — |
| D9 | Artifacts dock + tasks/subagents | Preview pane | — |
| D10 | Notifications + macOS dmg + updater | Ship | D3 |

Do not start D10 until a new user can: install (or `pnpm tauri dev`), pick a
folder, click DeepSeek/OpenRouter, paste a key, Test, and send a message.

---

## 7. Testing

| Layer | What |
|---|---|
| Agent provider ACP | Temp `GROK_HOME`; upsert DeepSeek-shaped TOML; list redacts secrets; delete; test against a mock HTTP server |
| Desktop unit | Missing-`messageId` chunk coalescing; assistant→tool→assistant ordering; activity grouping; image parts; provider validation |
| Playwright | Mock ACP burst/tool-heavy streams; replay shape; onboarding; attachments; palette; dark/light screenshot audit |
| Manual | Real OpenRouter or DeepSeek key on Linux WebKitGTK; Anthropic `messages` backend; Ollama with no key |

Do not add these to `xai-grok-pager-pty-harness`.

---

## 8. Packaging reminder

- Alpha: keep requiring CLI.
- Production Linux: AppImage + deb (already sketched).
- Production macOS: dmg; signing follow-up.
- App updater ≠ CLI updater.
- Linux runtime: `webkit2gtk-4.1`.

---

## 9. Explicit non-goals

- Reimplementing the agent or sampler in TypeScript
- A second `config.toml` parser in the renderer
- Cursor-like IDE
- Claude.ai account sync / Anthropic OAuth as the only login
- Bundling Chromium (Electron) unless WebKitGTK is a proven blocker
