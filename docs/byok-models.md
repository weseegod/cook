# BYOK: Add or Remove a Custom Model in Cook

A guide to configuring models with your own API key (Bring Your Own Key). Cook
supports this already; no source build is needed.

| Item | Value |
|---|---|
| Config file | `~/.cook/config.toml` |
| List models | `cook models` or `/model` in the TUI |
| Change model | `/model <id>` or `/m <id>` |
| Official guide | `~/.cook/docs/user-guide/11-custom-models.md` |

> **Security:** `config.toml` may contain API keys. Do not commit it. Set its
> permissions with `chmod 600 ~/.cook/config.toml`. Prefer `env_key` to storing
> a key directly in the file.

---

## 1. `config.toml` structure

There are two layers:

1. **`[model_providers.<provider>]`** — a shared URL and key for a provider.
2. **`[model.<id>]`** — an individual model that can inherit the provider URL
   and key through `model_provider`.

```toml
# Shared provider settings
[model_providers.my-provider]
base_url = "https://api.example.com/v1"
api_key = "sk-..."                    # or use env_key below
# env_key = "MY_PROVIDER_API_KEY"     # safer than an inline api_key
api_backend = "chat_completions"      # chat_completions | responses | messages

# A model using that provider
[model.my-model-id]
model = "my-model-id"                 # ID sent to the API
model_provider = "my-provider"        # must match the provider section name
name = "Display Name"                 # shown in /model
context_window = 128000
max_completion_tokens = 8192
supports_reasoning_effort = true       # optional
supports_batch_api = false             # optional; Batch API eligibility, default false
input = ["text", "image"]             # optional: ["text"] or ["text", "image"]
```

### Important fields

| Field | Meaning |
|---|---|
| Section name `[model.<id>]` | **Catalog key** used with `/model <id>` |
| `model` | ID sent to the API; it can differ from the catalog key |
| `model_provider` | Inherits `base_url`, `api_key`, and `api_backend` |
| `base_url` | Can be set directly on a model without a provider section |
| `api_key` / `env_key` | Credentials; `api_key` takes precedence over `env_key` |
| `api_backend` | `chat_completions` (OpenAI-compatible, default), `responses`, or `messages` (Anthropic) |
| `name` | Display name in the model picker |
| `context_window` | Used for automatic compaction; set it to the provider's actual limit |
| `max_completion_tokens` | Maximum tokens per response |
| `supports_batch_api` | Opt in to `/goal_batch` for models that support an OpenAI-compatible Batch API. Defaults to `false`; `/goal` and regular chat remain realtime |
| `input` | Accepted modalities: `["text"]` or `["text", "image"]`. If omitted, image support is treated as unknown and the model is handled as image-capable for compatibility. See §2.1. |

### `/goal_batch` (experimental)

`/goal_batch <objective>` sends **the main agent's model turns** through the
Batch API. Each turn submits a job, waits for the result, handles tool calls,
and then submits the next job. The planner, verifier, and subagents may still
use realtime requests. Regular `/goal <objective>` is unchanged.

Use only a model with `supports_batch_api = true`,
`api_backend = "chat_completions"`, its own API key, and a compatible Batch
API with `/v1/files` and `/v1/batches` endpoints. OpenAI uses
`https://api.openai.com/v1` automatically. Other providers require their
official Batch API URL:

```text
/goal_batch fix the login bug --base-url https://batch-api-<region>.xiaomimimo.com/v1
```

Never put an API key in the command. For Xiaomi, use the URL for the account's
region from the Batch Inference console; the realtime URL does not work here.
According to the [OpenAI Batch API guide](https://developers.openai.com/api/docs/guides/batch),
a job can take up to 24 hours. Since each turn depends on the previous result,
the full task can take much longer. Keep the session running while it waits.
Use `/goal status`, `/goal pause`, `/goal resume`, and `/goal clear` to manage
the goal. Batch jobs cannot currently be resumed after the application exits.
Cancelling a running turn asks the provider to cancel the job when possible.

### Section names containing a period (`.`)

Quote the section name:

```toml
[model."mimo-v2.5-pro"]
model = "mimo-v2.5-pro"
model_provider = "xiaomi"
name = "MiMo-V2.5-Pro"
```

### API backends

| `api_backend` | Protocol |
|---|---|
| `chat_completions` | OpenAI Chat Completions (`/v1/chat/completions`), used by most third-party providers |
| `responses` | OpenAI Responses (`/v1/responses`) |
| `messages` | Anthropic Messages (`/v1/messages`), usually with `extra_headers` |

Anthropic example:

```toml
[model.claude-opus]
model = "claude-opus-4-6"
base_url = "https://api.anthropic.com/v1"
name = "Claude Opus"
api_backend = "messages"
env_key = "ANTHROPIC_API_KEY"
context_window = 200000
extra_headers = { "anthropic-version" = "2023-06-01" }
```

Anthropic uses the `x-api-key` header. It can be set through `extra_headers`
or configured according to the current Cook guide.

---

## 2. Add a model

### 2.1 Does the model accept images? (`input` field)

Declare each model's input modalities in the `input` field under
`[model.<id>]`:

```toml
[model."mimo-v2.5-pro"]                # vision model
model = "mimo-v2.5-pro"
model_provider = "xiaomi"
input = ["text", "image"]

[model."deepseek/deepseek-v4-flash"]  # text-only model
model = "deepseek-v4-flash"
model_provider = "deepseek"
input = ["text"]
```

| Value | Meaning |
|---|---|
| Not set | Unknown; treated as image-capable by default |
| `input = ["text", "image"]` | Accepts text and images |
| `input = ["text"]` | Accepts text only |

Check with `cook models`; each model is listed with its modalities, for example:

```text
Available models:
  * deepseek/deepseek-v4-flash [text] (default)
  - mimo-v2.5-pro [text, image]
```

For a text-only model, the TUI does not show the clipboard image-paste
suggestion because the model's `inputModalities` does not include `"image"`.

### Option A — Add to an existing provider

If `[model_providers.deepseek]` already exists, add a model block:

```toml
[model.deepseek-new-slug]
model = "deepseek-new-slug"
model_provider = "deepseek"
name = "DeepSeek New"
context_window = 1000000
max_completion_tokens = 64000
supports_reasoning_effort = true
supports_batch_api = false             # optional; defaults to false
```

### Option B — Add a new provider

1. Add `[model_providers.<name>]` with its `base_url` and key.
2. Add one or more `[model.<id>]` blocks with
   `model_provider = "<name>"`.

### Option C — Add a standalone model

```toml
[model.local-llama]
model = "llama-3.1-70b"
base_url = "http://localhost:11434/v1"
name = "Local Llama"
# An API key is not required if the local server does not use authentication.
context_window = 128000
```

### After editing

```bash
# List configured models
cook models

# The TUI hot-reloads config.toml. Restart `cook` if the model does not appear.
```

Select a model:

```text
/model deepseek-new-slug
/m deepseek-new-slug
```

Set the default for new sessions:

```toml
[models]
default = "deepseek-new-slug"
```

---

## 3. Remove a model

### Remove one model

1. Open `~/.cook/config.toml`.
2. Remove the entire `[model.<id>]` block, through the line before the next section.
3. If `[models] default = "<id>"` points to the removed model, change it to an existing model (for example, `grok-4.5`).
4. Run `cook models` to confirm that the ID is gone.

### Remove a provider

1. Remove every `[model.*]` block whose `model_provider` is `"xxx"`.
2. Remove `[model_providers.xxx]`.
3. Check that `default` does not point to a removed model.

### Leave these alone

- `[cli]`, `[ui]`, `[marketplace]`, and unrelated sections do not control the model list.
- `~/.cook/models_cache.json` is the remote xAI model cache, **not** where BYOK models are added.

---

## 4. Quick checklist

### Add

- [ ] Know the provider `base_url` and API model ID.
- [ ] Choose the correct `api_backend` protocol.
- [ ] Add or reuse `[model_providers.*]`, or set `base_url` on the model.
- [ ] Add `[model.<id>]`; quote the section name if the ID contains `.`.
- [ ] Confirm the ID appears in `cook models`.
- [ ] Select `/model <id>` and send a test message.

### Remove

- [ ] Remove the `[model.<id>]` block.
- [ ] Update `[models] default` if needed.
- [ ] Remove the provider if no models use it.
- [ ] Confirm the ID no longer appears in `cook models`.

---

## 5. Current snapshot (reference)

Imported from `~/.pi/agent/models.json` on 2026-07-31. Only model **IDs** are
listed here; keys belong in `config.toml` and must not be copied into this
document.

| Provider section | Model catalog ID | Notes |
|---|---|---|
| `deepseek` | `deepseek-v4-flash` | OpenAI-compatible |
| `deepseek` | `deepseek-v4-pro` | |
| `xiaomi` | `mimo-v2.5-pro` | Section: `[model."mimo-v2.5-pro"]` |
| `xiaomi` | `mimo-v2.5` | Section: `[model."mimo-v2.5"]` |
| `moonshot` | `kimi-k2.6` | Section: `[model."kimi-k2.6"]` |
| `moonshot` | `kimi-k3` | |

Provider URLs (no secrets):

| Provider | `base_url` |
|---|---|
| deepseek | `https://api.deepseek.com` |
| xiaomi | `https://api.xiaomimimo.com/v1` |
| moonshot | `https://api.moonshot.ai/v1` |

Models using `model_provider = "xiaomi"` automatically send requests in MiMo's
format: `thinking`, `max_completion_tokens`, and `reasoning_content` in
assistant history. `chat_completions_adapter` is not needed; remove it if an
older config still has that key. For a custom provider pointing to MiMo, set
`chat_completions_request_format = "deepseek_thinking"` in
`[model_providers.<id>]` if needed.

Backup created during import: `~/.cook/config.toml.bak-20260731-221150`

---

## 6. Override native Grok models

Native xAI models such as `grok-4.5` are already in the catalog (from
`default_models.json` or remote `/models-v2`). You can override
`context_window` and `input` without setting `base_url` or `api_key`; all
other fields retain their catalog values.

```toml
# The catalog key must match the ID used with /model (quote IDs containing a period).
[model."grok-4.5"]
context_window = 300000
input = ["text", "image"]   # or ["text"] for a text-only model

# Optional: make this the default
[models]
default = "grok-4.5"
```

| Field | Meaning |
|---|---|
| `context_window` | Automatic compaction threshold, in tokens; overrides the catalog or remote value. |
| `input` | Accepted modalities: `["text"]` or `["text", "image"]`. Alias: `input_modalities`. |

**Catalog key vs. routing slug:** The section name `[model.<id>]` is the
catalog key used with `/model <id>`. Set `model = "..."` only when the routing
slug differs from the catalog key. If managed config uses another key (for
example, `[model.grok-build]` with `model = "grok-4.5"`), `context_window` may
propagate to the entry with the same slug. The safest option is to override
the exact catalog key selected in `/model`.

**Check:**

```bash
cook models    # Each model includes modalities, e.g. grok-4.5 [text, image]
```

In the TUI, select `/model grok-4.5`. The catalog hot-reloads after
`config.toml` changes; restart `cook` if the list does not update.

For the complete field list, see `~/.cook/docs/user-guide/11-custom-models.md`.

---

## 7. Native Grok and BYOK providers

Cook is designed first for native xAI models. BYOK entries (DeepSeek,
OpenAI-compatible providers, and others) receive automatic tuning:

| Feature | Native Grok | BYOK (automatic) |
|---|---|---|
| `/goal` role models | Multi-model skeptics (3 by default) | Same model for every role; 1 skeptic |
| Auxiliary models (summary, evaluator) | May use internal slugs | Falls back to the active session model, avoiding a 404 from the BYOK URL |
| Images | Full vision support | An undeclared custom `base_url` is treated as text-only; set `input = ["text", "image"]` to opt in |
| Web search | Hosted backend search | Client tool only; configure `[model.<web_search>]` or use native Grok |
| Compaction | Uses the session model | Optional `[compactions] model = "<catalog-id>"` |

Override BYOK `/goal` defaults explicitly:

```toml
[goal]
use_current_model_only = false   # Allow multiple models for goal roles.
verifier_count = 3
```

Or force single-model mode with native Grok:

```toml
[goal]
use_current_model_only = true
verifier_count = 1
```

Optional lower-cost compaction model:

```toml
[compactions]
model = "deepseek-v4-flash"
```

---

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| `cook models` does not show a model | Is the TOML section name misspelled? Is an ID containing `.` quoted? Restart `cook`. |
| 401 / unauthorized | Check `api_key` / `env_key` and confirm the environment variable is set. |
| 404 model | `model` must match the provider's API model ID. |
| Request goes to xAI by mistake | Set `base_url` or point `model_provider` to the correct provider. |
| Tool or reasoning error | The provider may need special headers or compatibility settings; see `11-custom-models.md`. |
| `400 unknown variant image_url, expected text` | The model is configured with `input = ["text"]`, but the request still contains an image (for example, an image pasted earlier in the session). Cook strips images from requests to text-only models and replaces them with placeholder text; any file path is retained for `read_file`. If the error continues, confirm `input = ["text"]` is set and `cook models` shows `[text]`. |
| Hide an xAI model | Use `[models] allowed_models`, `hidden_models`, or `disabled_models` (glob patterns) as described in the official guide. |

```bash
# List available models
cook models

# Back up the config before editing it by hand
cp ~/.cook/config.toml ~/.cook/config.toml.bak-$(date +%Y%m%d)

# The file contains credentials
chmod 600 ~/.cook/config.toml
```

---

## 9. Credentials: `api_key` vs. `env_key`

```toml
# Inline; convenient, but less safe if the file is copied
[model_providers.deepseek]
api_key = "sk-..."

# Environment variable; recommended
[model_providers.deepseek]
env_key = "DEEPSEEK_API_KEY"
```

```bash
export DEEPSEEK_API_KEY="sk-..."
# Or add it to ~/.zshrc.
```

Resolution order, in brief: model `api_key` → model `env_key` → provider
defaults → session / `XAI_API_KEY`, depending on context.

---

## 10. Related guides

- Official model configuration: `~/.cook/docs/user-guide/11-custom-models.md`
- Slash commands: `~/.cook/docs/user-guide/04-slash-commands.md` (`/model`, `/effort`)
- General configuration: `~/.cook/docs/user-guide/05-configuration.md`
