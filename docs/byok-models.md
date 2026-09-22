# BYOK: thêm / xóa custom model trong Grok

Hướng dẫn tự quản lý model mang API key riêng (Bring Your Own Key).  
Grok **đã hỗ trợ sẵn** — không cần build lại source.

| Mục | Giá trị |
|-----|---------|
| File config | `~/.cook/config.toml` |
| Xem danh sách | `cook models` hoặc trong TUI: `/model` |
| Đổi model | `/model <id>` hoặc `/m <id>` |
| Docs chính thức | `~/.cook/docs/user-guide/11-custom-models.md` |

> **Lưu ý bảo mật:** `config.toml` có thể chứa API key. Không commit file này lên git.  
> Nên `chmod 600 ~/.cook/config.toml`. Prefer `env_key` thay vì ghi key thẳng vào file.

---

## 1. Cấu trúc trong `config.toml`

Có 2 lớp:

1. **`[model_providers.<provider>]`** — URL + key dùng chung cho cả provider  
2. **`[model.<id>]`** — từng model; trỏ `model_provider` để kế thừa URL/key

```toml
# Provider (shared)
[model_providers.my-provider]
base_url = "https://api.example.com/v1"
api_key = "sk-..."                    # hoặc dùng env_key bên dưới
# env_key = "MY_PROVIDER_API_KEY"     # an toàn hơn api_key inline
api_backend = "chat_completions"      # chat_completions | responses | messages

# Một model thuộc provider đó
[model.my-model-id]
model = "my-model-id"                 # id gửi lên API
model_provider = "my-provider"        # khớp tên section provider
name = "Display Name"                 # hiện trong /model
context_window = 128000
max_completion_tokens = 8192
supports_reasoning_effort = true      # optional
supports_batch_api = false            # optional: Batch API eligibility, default false
input = ["text", "image"]             # optional: ["text"] | ["text", "image"]
```

### Field quan trọng

| Field | Ý nghĩa |
|-------|---------|
| Tên section `[model.<id>]` | **Catalog key** — dùng với `/model <id>` |
| `model` | Id gửi lên API (có thể khác catalog key) |
| `model_provider` | Kế thừa `base_url` / `api_key` / `api_backend` |
| `base_url` | Có thể set trực tiếp trên model nếu không dùng provider |
| `api_key` / `env_key` | Credential; `api_key` thắng `env_key` |
| `api_backend` | `chat_completions` (OpenAI-compatible, default), `responses`, `messages` (Anthropic) |
| `name` | Tên hiển thị trong picker |
| `context_window` | Dùng cho auto-compact; nên set đúng provider |
| `max_completion_tokens` | Max tokens mỗi response |
| `supports_batch_api` | Opt-in model chấp nhận Batch API (dành cho eval harness). Default `false`; không backend nào tự bật. Loop tương tác không bao giờ đọc flag này và không bao giờ gọi `/v1/batches` |
| `input` | Input model nhận được: `["text"]` (chỉ text) hoặc `["text", "image"]` (đọc được ảnh). Không khai báo = chưa biết → xử lý như nhận ảnh (an toàn, không regression). Xem mục 2.1 |

### Key có dấu chấm (`.`)

Bọc tên section bằng quotes:

```toml
[model."mimo-v2.5-pro"]
model = "mimo-v2.5-pro"
model_provider = "xiaomi"
name = "MiMo-V2.5-Pro"
```

### API backend

| `api_backend` | Protocol |
|---------------|----------|
| `chat_completions` | OpenAI Chat Completions (`/v1/chat/completions`) — đa số third-party |
| `responses` | OpenAI Responses (`/v1/responses`) |
| `messages` | Anthropic Messages (`/v1/messages`) — thường kèm `extra_headers` |

Ví dụ Anthropic:

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

(Anthropic dùng header `x-api-key`; có thể set qua `extra_headers` hoặc theo docs Grok hiện tại.)

---

## 2. Thêm model mới

### 2.1 Model nào đọc được ảnh? (field `input`)

Mỗi model khai báo input modalities qua field `input` trong `[model.<id>]`:

```toml
[model."mimo-v2.5-pro"]                # vision — đọc được ảnh
model = "mimo-v2.5-pro"
model_provider = "xiaomi"
input = ["text", "image"]

[model."deepseek/deepseek-v4-flash"]  # text-only
model = "deepseek-v4-flash"
model_provider = "deepseek"
input = ["text"]
```

| Giá trị | Ý nghĩa |
|---------|---------|
| không khai báo | chưa biết → xử lý như nhận ảnh (mặc định an toàn) |
| `input = ["text", "image"]` | model đọc được text + ảnh |
| `input = ["text"]` | model chỉ nhận text |

Kiểm tra nhanh bằng `cook models` — mỗi model in kèm modalities, vd.:

```text
Available models:
  * deepseek/deepseek-v4-flash [text] (default)
  - mimo-v2.5-pro [text, image]
```

Trong TUI, khi model text-only, gợi ý dán ảnh từ clipboard sẽ không hiện
(model `inputModalities` thiếu `"image"`).

### Cách A — Thêm vào provider đã có

Ví dụ đã có `[model_providers.deepseek]`, chỉ cần thêm block model:

```toml
[model.deepseek-new-slug]
model = "deepseek-new-slug"
model_provider = "deepseek"
name = "DeepSeek New"
context_window = 1000000
max_completion_tokens = 64000
supports_reasoning_effort = true
supports_batch_api = false            # optional, mặc định false
```

### Cách B — Provider hoàn toàn mới

1. Thêm `[model_providers.<tên>]` (base_url + key).  
2. Thêm một hoặc nhiều `[model.<id>]` với `model_provider = "<tên>"`.

### Cách C — Model standalone (không dùng provider)

```toml
[model.local-llama]
model = "llama-3.1-70b"
base_url = "http://localhost:11434/v1"
name = "Local Llama"
# không cần api_key nếu server local không auth
context_window = 128000
```

### Sau khi sửa

```bash
# Kiểm tra list
thanh models

# Trong TUI đang chạy: Grok hot-reload config.toml;
# nếu model chưa hiện → restart `cook`
```

Chọn model:

```text
/model deepseek-new-slug
/m deepseek-new-slug
```

Đặt default khi mở session:

```toml
[models]
default = "deepseek-new-slug"
```

---

## 3. Xóa model

### Chỉ xóa một model

1. Mở `~/.cook/config.toml`.  
2. Xóa **toàn bộ** block `[model.<id>]` … đến trước section kế tiếp.  
3. Nếu `[models] default = "<id>"` trỏ model vừa xóa → đổi sang model còn tồn tại (vd. `grok-4.5`).  
4. Chạy `cook models` để confirm id đã biến mất.

### Xóa cả provider

1. Xóa mọi `[model.*]` có `model_provider = "xxx"`.  
2. Xóa `[model_providers.xxx]`.  
3. Kiểm tra `default` không còn trỏ model đã xóa.

### Không đụng

- `[cli]`, `[ui]`, `[marketplace]`, … — không liên quan model list.  
- `~/.cook/models_cache.json` — cache model xAI remote, **không** phải nơi thêm BYOK.

---

## 4. Checklist nhanh

### Thêm

- [ ] Biết `base_url` + model id API  
- [ ] Chọn `api_backend` đúng protocol  
- [ ] Thêm/reuse `[model_providers.*]` hoặc set `base_url` trên model  
- [ ] Thêm `[model.<id>]` (quote nếu id có `.`)  
- [ ] `cook models` thấy id mới  
- [ ] `/model <id>` + gửi 1 tin nhắn test  

### Xóa

- [ ] Xóa block `[model.<id>]`  
- [ ] Sửa `[models] default` nếu cần  
- [ ] Xóa provider orphan nếu không còn model nào dùng  
- [ ] `cook models` không còn id đó  

---

## 5. Snapshot hiện tại (tham chiếu)

Import từ `~/.pi/agent/models.json` (2026-07-31).  
Chỉ liệt kê **id** — key nằm trong `config.toml`, không copy vào doc này.

| Provider section | Model catalog id | Ghi chú |
|------------------|------------------|---------|
| `deepseek` | `deepseek-v4-flash` | OpenAI-compatible |
| `deepseek` | `deepseek-v4-pro` | |
| `xiaomi` | `mimo-v2.5-pro` | section: `[model."mimo-v2.5-pro"]` |
| `xiaomi` | `mimo-v2.5` | section: `[model."mimo-v2.5"]` |
| `moonshot` | `kimi-k2.6` | section: `[model."kimi-k2.6"]` |
| `moonshot` | `kimi-k3` | |

Provider URLs (không secret):

| Provider | `base_url` |
|----------|------------|
| deepseek | `https://api.deepseek.com` |
| xiaomi | `https://api.xiaomimimo.com/v1` |
| moonshot | `https://api.moonshot.ai/v1` |

Backup lúc import: `~/.cook/config.toml.bak-20260731-221150`

---

## 6. Override native Grok models

Native xAI models (`grok-4.5`, v.v.) có sẵn trong catalog (từ `default_models.json`
hoặc remote `/models-v2`). Bạn có thể **ghi đè** `context_window` và `input` mà
không cần khai báo `base_url` / `api_key` — các field khác giữ nguyên từ catalog.

```toml
# Catalog key phải khớp id dùng với /model (quote nếu có dấu chấm)
[model."grok-4.5"]
context_window = 300000
input = ["text", "image"]   # hoặc ["text"] cho text-only

# Tùy chọn: đặt làm default
[models]
default = "grok-4.5"
```

| Field | Ý nghĩa |
|-------|---------|
| `context_window` | Ngưỡng auto-compact (tokens). Ghi đè giá trị từ catalog/remote. |
| `input` | Modalities model nhận: `["text"]` hoặc `["text", "image"]`. Alias: `input_modalities`. |

**Catalog key vs routing slug:** Tên section `[model.<id>]` là catalog key (dùng với
`/model <id>`). Field `model = "..."` chỉ cần khi routing slug khác catalog key.
Nếu managed config dùng key khác (vd. `[model.grok-build]` với `model = "grok-4.5"`),
`context_window` có thể propagate sang entry cùng slug — nhưng an toàn nhất là override
đúng catalog key bạn chọn trong `/model`.

**Kiểm tra:**

```bash
thanh models    # mỗi model in kèm modalities, vd. grok-4.5 [text, image]
```

Trong TUI: `/model grok-4.5`. Sau khi sửa `config.toml`, catalog hot-reload khi file
đổi; nếu model list chưa cập nhật, restart `cook`.

Danh sách field đầy đủ: `~/.cook/docs/user-guide/11-custom-models.md`.

---

## 7. Dual provider: native Grok + BYOK

Grok is built for native xAI models first, but BYOK entries (DeepSeek, OpenAI-compatible, etc.) get automatic tuning:

| Feature | Native Grok | BYOK (auto) |
|---------|-------------|-------------|
| `/goal` role models | Multi-model skeptics (default 3) | Same model for all roles; 1 skeptic |
| Aux models (summary, evaluator) | May use internal slugs | Falls back to active session model (no 404 on BYOK URL) |
| Images | Full vision | Undeclared custom `base_url` → text-only; set `input = ["text", "image"]` to opt in |
| Web search | Hosted backend search | Client tool only; configure `[model.<web_search>]` or use native Grok |
| Compaction | Uses session model | Optional `[compactions] model = "<catalog-id>"` |

Override BYOK `/goal` defaults explicitly:

```toml
[goal]
use_current_model_only = false   # allow multi-model goal roles
verifier_count = 3
```

Or force single-model mode on native Grok:

```toml
[goal]
use_current_model_only = true
verifier_count = 1
```

Optional cheaper compaction model:

```toml
[compactions]
model = "deepseek-v4-flash"
```

---

## 8. Troubleshooting

| Triệu chứng | Việc kiểm tra |
|-------------|----------------|
| `cook models` không thấy model | Typo section TOML? Id có `.` đã quote chưa? Restart `cook` |
| 401 / unauthorized | Sai `api_key` / `env_key`; env đã export chưa |
| 404 model | Field `model` phải khớp id API của provider |
| Request đi nhầm xAI | Model cần `base_url` hoặc `model_provider` trỏ provider đúng |
| Tool / reasoning lỗi | Provider có thể cần header/compat đặc biệt — xem `11-custom-models.md` |
| `400 unknown variant image_url, expected text` | Model khai báo `input = ["text"]` nhưng request vẫn kèm ảnh (ảnh dán cũ trong session). Kể từ fix này, Grok tự strip ảnh khỏi request khi model text-only — ảnh được thay bằng placeholder text, file path (nếu có) vẫn giữ để đọc qua `read_file`. Không cần làm gì thêm; nếu vẫn lỗi, kiểm tra `input = ["text"]` đã khai báo đúng chưa (`cook models` phải hiện `[text]`) |
| Muốn ẩn model xAI | Dùng `[models] allowed_models` / `hidden_models` / `disabled_models` (glob) trong docs chính thức |

```bash
# Xem model đang available
thanh models

# Backup trước khi sửa tay
cp ~/.cook/config.toml ~/.cook/config.toml.bak-$(date +%Y%m%d)

# Quyền file (có secret)
chmod 600 ~/.cook/config.toml
```

---

## 9. Credential: `api_key` vs `env_key`

```toml
# Inline (tiện, kém an toàn hơn nếu file bị copy)
[model_providers.deepseek]
api_key = "sk-..."

# Qua env (khuyến nghị)
[model_providers.deepseek]
env_key = "DEEPSEEK_API_KEY"
```

```bash
export DEEPSEEK_API_KEY="sk-..."
# hoặc trong ~/.zshrc
```

Thứ tự resolve (tóm tắt): `api_key` model → `env_key` model → provider defaults → session / `XAI_API_KEY` (tùy context).

---

## 10. Liên kết

- Official: `~/.cook/docs/user-guide/11-custom-models.md`
- Slash commands: `~/.cook/docs/user-guide/04-slash-commands.md` (`/model`, `/effort`)
- Config tổng: `~/.cook/docs/user-guide/05-configuration.md`
