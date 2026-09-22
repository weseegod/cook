# So sánh luồng core agent của Cook với pi

Ngày đối chiếu: **2026-09-22**.

Phía Cook: [core-agent-flow-and-token-optimization.md](core-agent-flow-and-token-optimization.md) (bản review/đề xuất cho runtime Rust trong repo này).

Phía pi: [`earendil-works/pi`](https://github.com/earendil-works/pi) tại `packages/coding-agent` và `packages/agent`.

Revision đã ghim, để so sánh này tái lập được:

| Nguồn | Revision |
|---|---|
| pi | `1a584a7a56eb5e7b4ff8ccbd46430f1533282eed`, nhánh `main`, 2026-09-21, `@earendil-works/pi-coding-agent` 0.87.0 |
| Cook (đầu nhánh) | `e66c0da9a6f846f0bdbdccf8d24ad4c5d5660c32`, 2026-09-22 |
| Cook (base revision mà tài liệu tự khai) | `a8b1874dd099802bdae334733d2828a5697b05cf` |

Tài liệu này không sửa source, config, hay default nào. Mọi con số của Cook lấy từ tài liệu nói trên và các đường dẫn source mà nó đã nêu, không đo lại.

## 1. Hai thứ được so sánh không cùng loại

Cook ở đây là một **tài liệu thiết kế cho một runtime đang chạy** (Rust, actor, đã có goal, subagent, MCP, skills). pi là **một harness đã phát hành** (TypeScript) với tài liệu thiết kế riêng ở `packages/agent/docs/harness.md` và `harness-v2.md`.

Một chi tiết ảnh hưởng tới mọi kết luận bên dưới: pi có **hai đường chạy khác nhau**.

- **Đường đã phát hành**: CLI (`coding-agent` 0.87.0) dùng class `Agent` cổ điển của `@earendil-works/pi-agent-core` cộng `AgentSession`; interactive, print, và RPC dùng chung class này. Compaction, branch summarization, session JSONL, và `context_edit` đều thuộc đường này.
- **Đường harness v2**: `packages/agent/src/harness/` (lane, durability, deferred). Hiện được dùng bởi `packages/evals` và các mode thử nghiệm trong `coding-agent/src/experimental/` (micro, mini, session-worker), **không** phải đường mặc định.

Vì vậy khi thấy pi mô tả một luật mạnh (ví dụ luật append-only), cần đọc kèm nó thuộc đường nào. Tài liệu này ghi rõ ở từng mục.

Quy ước cột đối chiếu: **giống**, **khác**, hoặc **Cook không có tương ứng**.

## 2. Hình dạng runtime và quyền sở hữu

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Ngôn ngữ / tiến trình | Rust, nhiều actor: session actor chạy trên OS thread riêng với Tokio current-thread runtime, thêm actor cho sampler và chat-state | TypeScript, một tiến trình Node, một `AgentSession` cho mỗi phiên | khác về kỹ thuật, giống về mục đích: tách vòng đời phiên khỏi UI |
| Vòng lặp | Hai vòng lồng nhau: vòng ngoài (round, goal continuation, input xếp hàng, stop-hook) và vòng trong `process_conversation_turn_inner` | Một vòng step: mỗi step = một assistant message + toàn bộ batch tool mà message đó gọi | khác |
| Đơn vị công việc bền | Session lifecycle trong shell; canonical event log là storage, SQLite là index dẫn xuất | *Operation* trên một *lane* (`run`, `compaction`, `navigation`), được chấp nhận trước khi thực thi và kết thúc bằng một outcome | Cook không có tương ứng trực tiếp |
| Song song | `FuturesUnordered` trong một lượt realtime; subagent có phiên riêng | Lane chạy song song trong một harness; mỗi lane một operation | Cook không có tương ứng (Cook dùng subagent/child thay lane) |
| Subagent | Có, cùng goal orchestration | Không có trong CLI; README xếp sub-agent vào nhóm "từ chối có chủ ý". Harness v2 cho phép một tool subagent chạy trên lane thứ hai | khác |
| MCP | Có discovery + call tool; registry phân biệt built-in với MCP bằng heuristic tên chứa `__`, có TODO chuyển sang namespace metadata | Không có MCP, cũng là lựa chọn có chủ ý | khác |
| Plan mode, to-do, permission popup, background bash | Có (permission, TodoGate, v.v.) | Không có, đẩy hết sang extension | khác |

## 3. Biểu diễn phiên bền và thứ model thật sự thấy

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Lưu trữ | Canonical event log; SQLite là index dẫn xuất | JSONL append-only, cấu trúc cây qua `id`/`parentId` (session v3), một file cho một phiên | khác |
| Phân nhánh | Checkpoint/worktree ở tầng workspace | `/tree`, `/fork`, `/clone` trên chính file đó; entry cũ không bao giờ bị sửa hay xoá | khác |
| Prompt và tool đã gửi | Dựng lại mỗi lượt từ hội thoại sống cộng resolver | System message đầu tiên ghi **mọi** prompt section và tool declaration; thay đổi sau đó là các patch `sections` theo tên cộng `toolsAdded`/`toolsRemoved` | khác |
| Bản request bị tỉa | Bản copy bị tỉa **không bao giờ được persist**; quan sát nó cần log runtime | Omission được persist thành entry `context_edit` (`replacement: null`) và có hiệu lực theo nhánh | khác |
| Đọc lại "model đã thấy gì" | Phải replay từ canonical history cộng policy hiện tại | Đọc thẳng projection của file | pi có lợi thế rõ ở khả năng audit |

Điểm đáng chú ý: Cook tách "canonical history" khỏi "model-visible context" và cố ý không ghi lại bản đã tỉa. pi cũng tách hai thứ đó nhưng **ghi lại** phần khác biệt. Với Cook, việc trả lời "request thứ 7 thực tế gửi gì" cần dựng lại policy tại thời điểm đó; với pi thì đó là dữ liệu.

## 4. Luật append-only — khác biệt rõ nhất

`packages/agent/docs/harness-v2.md` phát biểu thành invariant:

> Across the requests of a lane, provider context only grows at the tail. An insertion before the previous request's tail invalidates the provider's KV cache from that point on and multiplies token cost.

Hệ quả trong thiết kế pi: ghi giữa step bị hoãn tới checkpoint để append ở cuối; compaction được nêu tên là **ngoại lệ có chủ ý duy nhất**, đánh đổi một lần mất cache để lấy context nhỏ hơn.

| Khía cạnh | Cook | pi |
|---|---|---|
| Trạng thái của luật | Ưu tiên số 2 trong kết luận: giữ prefix byte-stable, cap output lúc sinh trước, hạn chế ghi lại giữa history | Invariant được phát biểu và có cơ chế cưỡng chế (hoãn ghi tới checkpoint) |
| Nhánh step-aware | Có, opt-in: `keep_last_n_tool_rounds = 6`, `recent_tool_result_char_budget = 64000`, thay kết quả cũ bằng placeholder khi cửa sổ round trượt | Bị luật cấm về mặt thiết kế |
| Vi phạm | Chấp nhận được khi opt-in, kèm cảnh báo rằng nó làm tăng phần uncached | Là lỗi thiết kế, không phải một tham số |

Đây là chỗ hai thiết kế bất đồng **có chủ ý**, không phải Cook thiếu một tính năng. Đáng lưu ý: kết luận của Cook ("sliding rewrite nên bắn một lần ở ranh giới thô, khoảng lúc sắp compact") thực chất là tiến tới cùng kết luận với pi bằng đường khác.

**Chưa xác minh**: luật tail-append trên được phát biểu cho harness v2. Đường CLI đã phát hành (`AgentSession`) có persist `context_edit` và có boundary `turn_end`/`agent_before_settle`, nhưng tôi chưa xác nhận nó cưỡng chế luật tương tự cho ghi giữa step.

## 5. Compaction và tóm tắt

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Ngưỡng | Auto-compaction baseline 85%, có resolver override | `contextTokens > contextWindow − reserveTokens`, `reserveTokens` mặc định 16384 | khác cách biểu diễn, cùng mục đích |
| Prefire | Có: khởi động trước ngưỡng khoảng 10 điểm phần trăm (≈75%) | Không có; compaction chạy khi tới ngưỡng, hoặc do lỗi overflow/length, hoặc `/compact` | khác |
| Giữ lại gần nhất | Tool-result age đếm lùi qua `ConversationItem::User`, giữ 3 turn cuối | `keepRecentTokens` mặc định 20000, cắt theo ranh giới turn | khác |
| Cắt giữa turn | Không mô tả | Có "split turn": sinh hai summary (history + turn prefix) rồi gộp; không bao giờ cắt ở tool result | Cook không có tương ứng |
| Định dạng summary | Đề xuất schema: objective/constraints, repo state, decisions, checks, unresolved failures, task/process ID, artifact, next steps | Schema cố định Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context, kèm `<read-files>` và `<modified-files>`; file tracking **tích luỹ** qua nhiều lần compact | khác, pi cụ thể hơn |
| Tỉa khi tóm tắt | `compaction_verbatim_input` mặc định bật; ưu tiên verbatim history | `serializeConversation` cắt mọi tool result còn 2000 ký tự trước khi tóm tắt | khác |
| Cache khi tóm tắt | Không nêu | Summary request dùng routing session id mới và **tắt prompt-cache write**, vì đây là request một lần | Cook không có tương ứng |
| Reserve | 32768 token cho prompt/summary/reasoning của compaction | `reserveTokens` cũng chi phối giới hạn output của summary | khác |
| Hai lượt | Two-pass: pass 1 snapshot prefix, tóm tắt nền, lưu NOTE₁ kèm fingerprint; prefix/model đổi thì invalidate; feature registry mặc định `true` | Không có two-pass; có hook `session_before_compact` cho phép extension cấp summary | khác |
| Per-model | Context window là per-model; không retune ở đây | `compaction.modelOverrides` cho `reserveTokens`/`keepRecentTokens` theo `provider/modelId` | pi có, Cook không |

## 6. Chính sách prefix cache

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Cơ chế adapter | Responses: `prompt_cache_key` fallback về conversation ID, `previous_response_id` hiện là `None`; Messages: đánh breakpoint ở system và transcript; memory-context block được tái dùng để prefix không đổi | `cacheRetention` short/long, `PI_CACHE_RETENTION=long`, TTL lấy từ tier `promptCache` của từng model | giống về hướng, khác về mức cụ thể |
| Đo hit/miss | `usage.rs` có input/output/cache/reasoning; kế hoạch phase 4 thêm `uncachedInputTokens` và `cacheFieldPresent` | `Usage` của mỗi assistant message đã tách `input`, `cacheRead`, `cacheWrite` (và `cacheWrite1h`), `reasoning`, kèm `cost` theo từng bucket | pi đã có sẵn thứ Cook đang định thêm |
| Giữ cache sống | Không có. Cook chỉ giữ prefix ổn định và ghi nhận cache read | `cache-warmer.ts`: gửi lại request gần nhất với `maxTokens: 1` trước khi hết TTL, chỉ khi `continuationProbability × missCost − warmCost ≥ $0.05`; bỏ qua nếu request không replay an toàn; usage ghi thành entry `kind: "cache_warm"` | Cook không có tương ứng |
| Hiển thị | Ledger phiên | Footer hiện `↑` `↓` `R` `W` `CH` (cache hit rate) cộng cost và context usage | Cook không có tương ứng |

Đây là mảng pi đi xa hơn Cook một bước có ý nghĩa: pi **định giá** việc giữ cache sống và chỉ làm khi kỳ vọng tiết kiệm vượt ngưỡng, thay vì chỉ tránh làm hỏng nó. Cook hiện dừng ở vế "tránh làm hỏng".

## 7. Kích thước output của tool

| Tool | Cook | pi | Đối chiếu |
|---|---|---|---|
| read | Cap 25000 **estimated** token và `MAX_LINES_READ = 1000`; có thể gợi ý đọc hẹp hơn | `truncateHead` với `DEFAULT_MAX_LINES = 2000` hoặc `DEFAULT_MAX_BYTES = 50KB`, cái nào tới trước; thông báo nêu rõ `offset` kế tiếp và tổng số dòng | khác |
| bash | Mặc định 20000 ký tự cho model; log đầy đủ có đường dẫn khi bị cắt | `truncateTail` cùng ngưỡng 2000 dòng / 50KB; output đầy đủ lưu file tạm và đường dẫn nằm trong thông báo; executor cap phần thu thập thô ở 100KB | khác |
| grep/find/ls | Theo registry/tool riêng | Giới hạn số kết quả: grep 100, find 1000, ls 500; cộng trần 50KB; dòng match dài cắt ở `GREP_MAX_LINE_LENGTH = 500` ký tự | khác |
| Prompt quá lớn | `prompt_offload.rs`: ghi file, model nhận head/tail; ngưỡng `READ_FILE_MAX_TOKENS × BYTES_PER_TOKEN = 100000` byte | Không có cơ chế tương ứng; dựa vào `@file` và read có offset | Cook không có tương ứng ở phía pi |
| Thời điểm cắt | Hiện tại: lúc sinh output (bash) và lúc prune request copy; kế hoạch phase 3 thêm cap append-only lúc sinh cho read | Luôn lúc sinh output, tức append-only theo cấu trúc | Cook đang đi tới chỗ pi đứng |

Lưu ý đơn vị: Cook đếm **estimated token** (bytes/4) và số dòng (1000); pi đếm **byte thật** (50KB) và số dòng (2000). Không so trực tiếp hai con số như cùng đơn vị.

## 8. Catalog tool và discovery

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Kích thước toolset | Registry rộng, có MCP, skills, subagent, goal | 8 built-in (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `powershell`), mặc định 4 | khác |
| Ngân sách catalog | Skill catalog mặc định 50% context, fallback 400000 ký tự, mỗi description+when-to-use cap 400 byte; kế hoạch thí nghiệm 1–2k token | Không có ngân sách kiểu này; giảm bằng cách bớt tool và để skill load theo nhu cầu | khác |
| Discovery | MCP discovery/call tool; main request ban đầu không chứa mọi MCP schema; heuristic `__` có TODO | Skill qua `/skill:name` hoặc tự động; có ví dụ "deferred tools" kích hoạt tool theo nhu cầu; allowlist `--tools` / `--exclude-tools` | khác |
| Chọn theo profile | Đề xuất profile-specific toolset, chọn tất định từ mode/capability | Chọn theo cờ CLI và extension; `activeTools` là per-lane trong harness | khác |

## 9. Việc offline, deferred, và batch

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Batch API | Bốn điều kiện ở §9; cờ `supports_batch_api` trên `[model."<id>"]`; vòng coding không bao giờ dùng; chỉ eval harness đọc cờ | Không có đường batch cho vòng coding. Thiết kế chọn cơ chế khác: request deferred trả handle ngay, assistant message persist với `stopReason: "deferred"` kèm `DeferredHandle`, lane chuyển sang *suspended*, `fetchDeferred` sau đó append kết quả thật | khác về cơ chế, gần nhau về kết luận |
| Mục đích | Giảm **giá** cho việc đã đóng băng; không giảm token | Bền hoá run dài: suspend/resume qua nhiều tiến trình, tránh timeout | khác rõ về mục tiêu |
| Trạng thái thực tế | Cờ là kế hoạch (phase 5), chưa implement | Type/contract và đường harness có thật; **chỉ provider `faux` (provider giả để test) implement deferred**; không provider thật nào implement tại revision này | cả hai đều chưa có gì chạy thật |
| Giá | Bảng giá theo provider: Xiaomi MiMo 50%, DeepSeek không có batch, xAI 20% chỉ trên `grok-4.3` và `grok-4.20-0309` | Chỉ có `calculateCost` theo bảng giá model, không có khái niệm discount batch | khác |

## 10. Side call và suy luận phụ

| Khía cạnh | Cook | pi |
|---|---|---|
| Các call phụ có thật | dream, memory capture, flush, laziness classifier, prompt suggestion, goal roles (planner/verifier/strategist/summarizer/continuation), recap, `/btw`, turn summary, title refresh | Chỉ có: request của step, summary của compaction, summary của branch, và cache warm |
| Phase 7 | Giữ nguyên tất cả, chỉ thêm hàng vào ledger | Không có gì để giữ: pi không ship các call đó |
| Ai gánh phần đó | Cook tự ship rồi đo | Extension của người dùng |

Cook có bề mặt suy luận phụ lớn hơn hẳn, và đây là lý do tài liệu Cook dành hẳn phase 7 để đo thay vì tắt.

## 11. Kế toán chi phí và usage

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Ledger | `usage.rs`: `purposeUsage`, `requestComponents`, per-model ledger, missing-cost, semantics "incomplete" | `usage.json`/JSONL: `Usage` trên mỗi assistant message (bucket + cost), cộng `UsageEntry` có `kind` cho phần không phải message | khác về hình dạng |
| Usage ngoài hội thoại | Kế hoạch phân loại purpose cho mọi call, retry là một chiều riêng | `UsageEntry` với `kind` (ví dụ `cache_warm`) tính vào tổng phiên nhưng **không** vào context model | giống về ý tưởng |
| Usage bị thiếu | Thiết kế then chốt: response thành công mà `usage=None` đánh dấu cả hai ledger là incomplete, **không** bịa ra zero | Không tìm thấy semantics tương ứng. Chỗ xử lý là fallback (`usage ?? DEFAULT_USAGE` ở provider `faux`, `assistant?.usage ?? usageRecord(entry)` ở experimental micro) | pi yếu hơn hẳn ở điểm này |
| Tổng phiên gồm gì | Purpose rows cộng phần chưa tới | Footer nói tổng gồm cả assistant response, usage do tool báo, và summary generation | giống về nguyên tắc |

## 12. Văn hoá đo lường

| Khía cạnh | Cook | pi |
|---|---|---|
| Bộ task | Đề xuất 30–50 task cố định, chia theo lớp (fix một file, fix có test fail, khám phá repo, refactor nhiều file, vượt context, interjection/resume, MCP/skill, goal có child), gồm cả payload tiếng Việt/Unicode | `packages/evals`: vitest-evals, hai arm `with_docs`/`without_docs` chạy trong container tách biệt, báo cáo "lift"; host evals là suite thường |
| Đơn vị quyết định | **Cost per accepted task**, kèm success rate, raw/uncached input, p95 latency; mục tiêu ≥20% giảm với mất mát dưới 2 điểm phần trăm | "Lift" của tài liệu so với không tài liệu; không thấy kế toán cost-per-task |
| Ma trận quyết định | Một phase, một matrix, một commit; quality cell là cổng chặn; ba model local | Không có matrix kiểu đó trong tài liệu; dựa vào eval suite |
| Chia sẻ dữ liệu | Chưa có | Chủ động: công bố session lên Hugging Face để cải thiện model/prompt/eval |

Đây là mảng **Cook đang đi trước**: Cook có giao thức quyết định bằng số (matrix, quality gate, cost per accepted task) mà pi không mô tả. pi mạnh hơn ở chỗ có eval suite chạy được trong CI và có dữ liệu session thật để đối chiếu.

## 13. Cook nên học gì, và nên từ chối gì

### Nên học

1. **Phát biểu luật append-only thành invariant có tên và có ngoại lệ** — gắn vào **P1b / phase 2–3**. Cook đã đi đúng hướng ("cap lúc sinh trước, ghi lại giữa history sau, và chỉ một lần ở ranh giới thô"). pi cho thấy bước tiếp: đặt tên luật, nêu ngoại lệ duy nhất là compaction, và cưỡng chế bằng cách hoãn ghi tới checkpoint. Việc này không cần code mới ngay, nhưng cần một dòng trong tài liệu thiết kế cộng một test khẳng định nó, để nhánh step-aware không âm thầm trở thành mặc định sau này.
2. **Ghi lại phần khác biệt giữa canonical history và context model thấy** — gắn vào **P0 / phase 4**. pi persist `context_edit`; Cook cố ý không. Cái Cook đang thiếu không phải cơ chế mà là khả năng audit: tài liệu Cook tự nêu khó khăn "biết request thứ n thật sự gửi gì". Ghi omission vào event log (không ghi vào canonical history) là một thay đổi nhỏ ở tầng storage và trả lại khả năng replay chính xác.
3. **Ghi delta của prompt thay vì chỉ dựng lại toàn bộ** — gắn vào **P0**. pi ghi system message đầu tiên chứa mọi section và tool declaration, sau đó ghi patch `sections` cộng `toolsAdded`/`toolsRemoved`. Cook phân biệt "inject một lần" với "bị tính mỗi lượt" nhưng phải suy ra từ resolver. Ghi delta làm phân biệt đó thành dữ liệu, đúng thứ P0 muốn.
4. **Thông báo khi cắt output phải nêu bước tiếp theo cụ thể** — gắn vào **P1a / phase 3**. pi in ra `offset` kế tiếp, tổng số dòng, và đường dẫn file log; Cook mới ở mức "có thể gợi ý đọc hẹp hơn". Đây là thay đổi rẻ và trực tiếp giảm số vòng đọc lại.
5. **Cân nhắc warming cache như một tính năng có giá** — **chỉ sau phase 4**, và chỉ khi có TTL per-model. pi chỉ warm khi kỳ vọng tiết kiệm ≥ $0.05 và bỏ qua khi request không replay an toàn. Cook chưa có metadata TTL của provider, nên đây là một phase riêng cần đo, không phải việc làm ngay. Nếu làm, nó phải chịu đúng quality gate như mọi phase khác.

### Nên từ chối, và lý do

1. **Cắt về 4 tool / bỏ MCP / bỏ subagent / bỏ goal để tiết kiệm token.** Đó là lựa chọn sản phẩm của pi, không phải kết quả tối ưu token. Chính tài liệu Cook nói một skill bị ẩn đi là quality failure chứ không phải tiết kiệm.
2. **Đưa vòng coding lên Batch API.** pi cũng không làm, nhưng đừng đọc pi như bằng chứng: cơ chế deferred của pi phục vụ **độ bền của run** (suspend/resume qua tiến trình), không phải giảm token, và tại revision này chỉ provider giả implement nó. Bốn điều kiện ở §9 của tài liệu Cook vẫn nguyên giá trị.
3. **Port lane/durability vào Cook để giảm token.** Lane giải bài toán crash-recovery và nhiều danh tính song song trên một history, không giải bài toán token. Tài liệu Cook đã nói rõ: bố cục tiến trình không làm prompt ngắn đi.
4. **Bắt chước fallback usage của pi.** Chỗ này pi yếu hơn: không có dấu hiệu phân biệt "usage thiếu" với "call zero token", trong khi Cook coi đó là điểm mấu chốt. Giữ semantics incomplete của Cook.
5. **Bỏ hai-pass prefire vì pi không có.** pi không có prefire không chứng minh prefire là lãng phí; Cook đã có cách đo consumed/discarded và điều kiện dừng. Giữ, nhưng thêm cooldown và điều kiện tăng token tối thiểu như tài liệu đã đề xuất.

## 14. Điểm chưa xác minh

Các điểm sau chưa đủ căn cứ để khẳng định, ghi lại để không bị đọc như sự thật:

- **Luật tail-append trên đường CLI đã phát hành.** `harness-v2.md` phát biểu luật cho harness v2. Đường `AgentSession` cổ điển có `context_edit` và các boundary, nhưng tôi chưa xác nhận nó cưỡng chế luật tương tự cho ghi giữa step.
- **Deferred cho provider thật.** Tại revision này chỉ `packages/ai/src/providers/faux.ts` implement. Kết luận "pi đã cân nhắc Batch API rồi chọn background mode" đến từ một bản tóm tắt tìm kiếm trỏ tới PR #7339, không phải tôi đọc trực tiếp PR đó. Không dùng câu này như trích dẫn.
- **Hành vi của pi khi provider không trả usage.** Không tìm thấy cờ "incomplete" hay tương đương trong `coding-agent/src` và `ai/src`; các chỗ xử lý tìm được là fallback trong `faux` và experimental micro. Chưa loại trừ được còn đường khác.
- **Ngân sách token cho summary của compaction trong pi.** `reserveTokens` được mô tả là cũng chi phối giới hạn output của summary, nhưng công thức cụ thể chưa đọc trong source.
- **`CH` trên footer** nhiều khả năng tính từ cache read do provider báo (dựa trên shape của `Usage`), nhưng tôi chưa đọc đoạn code tính nó.
- **Đường harness v2 có phải tương lai của CLI hay không.** Hiện `coding-agent` import `Agent` cổ điển cho mọi mode, còn harness v2 phục vụ evals và experimental. Chưa rõ ý định migration.

Phần đã xác minh bằng đọc source tại revision đã ghim: giới hạn cắt output của tool (`truncate.ts`, `bash-executor.ts`, `read.ts`, `bash.ts`), luật append-only và deferred trong `harness-v2.md`, chính sách warming cache (`cache-warmer.ts`), shape `Usage` và các entry type (`session-format.md`), nội dung `compaction.md`, danh sách tool built-in và các lựa chọn bị từ chối (README), và việc harness v2 không được CLI dùng làm đường mặc định.
