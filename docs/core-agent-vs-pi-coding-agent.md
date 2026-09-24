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

Tài liệu này không sửa source, config, hay default nào. Các con số của Cook được đối chiếu lại với source trên nhánh tại `e66c0da9` vào cùng ngày; chỗ nào chỉ còn là đề xuất thì ghi là đề xuất.

## 1. Hai thứ được so sánh không cùng loại

Cook ở đây là một **tài liệu thiết kế cho một runtime đang chạy** (Rust, actor, đã có goal, subagent, MCP, skills). pi là **một harness đã phát hành** (TypeScript). Tài liệu thiết kế của package `agent` tại revision đã ghim là `packages/agent/docs/harness.md`. File `harness-v2.md` không có trong cây đó.

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
| Bản request bị tỉa | Bản copy bị tỉa của request-copy pruning **không được persist**; quan sát nó cần log runtime. Request compaction thì có: `compaction_requests/{request_id}.json` | Omission được persist thành entry `context_edit` (`replacement: null`) và có hiệu lực theo nhánh | khác |
| Đọc lại "model đã thấy gì" | Request tỉa: phải replay từ canonical history cộng policy hiện tại. Request compaction: đọc artifact | Đọc thẳng projection của file | pi có lợi thế rõ ở request tỉa |

Điểm đáng chú ý: Cook tách "canonical history" khỏi "model-visible context" và cố ý không ghi lại bản request đã tỉa. pi cũng tách hai thứ đó nhưng **ghi lại** phần khác biệt bằng `context_edit`. Với Cook, việc trả lời "request thứ 7 thực tế gửi gì" cần dựng lại policy tại thời điểm đó, trừ khi đó là một request compaction đã được ghi artifact.

## 4. Luật append-only — khác biệt rõ nhất

`packages/agent/docs/harness.md` (khoảng dòng 518, revision đã ghim) phát biểu thành invariant:

> Append-only context invariant. Across one lane's requests, provider context must only grow at the tail: an insertion before the previous request's tail invalidates the provider's KV cache and multiplies cost. This is why mid-run writes defer to checkpoints, where they append at the tail. Compaction is the one deliberate cache invalidation, traded for a smaller context.

Câu này thuộc tài liệu của package `agent` (lane, checkpoint). CLI đã phát hành nói nửa lưu trữ của cùng luật, trong `packages/coding-agent/README.md` khoảng dòng 285–289: context model là projection của history append-only; extension bỏ hoặc thay một message cũ bằng cách **append** `context_edit`, không sửa entry cũ. `replacement: null` giấu message đó khỏi request sau, nhưng JSONL vẫn giữ nó.

Vì vậy "step-aware bị cấm" là nói quá. pi cấm sửa history đã ghi và cấm chèn trước đuôi của request trước. CLI đã phát hành **cho phép** một `context_edit` append sau, và omission đó có thể làm gãy cache từ điểm đó — cùng kiểu chi phí với nhánh step-aware của Cook. Khác biệt là pi ghi omission lại, Cook không ghi bản request đã tỉa.

| Khía cạnh | Cook | pi |
|---|---|---|
| Trạng thái của luật | Ưu tiên số 2 trong kết luận: giữ prefix byte-stable, cap output lúc sinh trước, hạn chế ghi lại giữa history | Invariant có tên trong `harness.md`. Nửa lưu trữ được CLI phát hành nói trong README |
| Nhánh step-aware | Có, opt-in: `keep_last_n_tool_rounds = 6`, `recent_tool_result_char_budget = 64000`, thay kết quả cũ bằng placeholder khi cửa sổ round trượt. Canonical history không đổi | History đã ghi không bị sửa. Omission là entry `context_edit` append sau, không phải tham số mặc định |
| Vi phạm cache | Chấp nhận được khi opt-in, kèm cảnh báo rằng nó làm tăng phần uncached | Chèn trước đuôi là lỗi thiết kế. Omission qua `context_edit` thì được phép và vẫn có thể gãy cache |

Kết luận của Cook ("sliding rewrite nên bắn một lần ở ranh giới thô, khoảng lúc sắp compact") vẫn cùng hướng với ngoại lệ compaction của pi. Việc hoãn ghi giữa step tới checkpoint là cơ chế lane; Cook không port cơ chế đó chỉ để giảm token.

**Chưa xác minh**: `harness.md` nói ghi giữa step bị hoãn tới checkpoint. README và `agent-session.ts` xác nhận CLI append `context_edit` và không sửa entry cũ. Chưa xác nhận `AgentSession` hoãn ghi giữa step theo đúng cơ chế checkpoint của lane.

## 5. Compaction và tóm tắt

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Ngưỡng | Auto-compaction baseline 85%, có resolver override | `contextTokens > contextWindow − reserveTokens`, `reserveTokens` mặc định 16384 | khác cách biểu diễn, cùng mục đích |
| Prefire | Có: `DEFAULT_PREFIRE_LEAD_PERCENT = 10` trong `session/compaction.rs`, tức khoảng 75% khi ngưỡng là 85%. Pass 1 chạy nền | Không có pass nền. `shouldCompact` trong `compaction.ts` là `contextTokens > contextWindow − reserveTokens`. README gọi đó là "proactive"; đó là ngưỡng reserve, không phải pass sớm 10 điểm | khác |
| Giữ lại gần nhất | Không phải "3 turn". Ba turn là `keep_last_n_turns` của **request-copy pruning** (`memory.rs`, mặc định 3). Compaction giữ đuôi sau split 95% (`TWO_PASS_DEFAULT_SPLIT_FRACTION` trong `two_pass.rs`) cộng `CompactionStateContext` (message từ anchor, path đã sửa, task, MCP, todo) | `keepRecentTokens` mặc định 20000, cắt theo ranh giới turn | khác, và không cùng cơ chế |
| Cắt giữa turn | Không có split-turn hai summary. `two_pass.rs` từ chối cắt đứt một cặp tool | Có "split turn": sinh hai summary (history + turn prefix) rồi gộp; không bao giờ cắt ở tool result | khác |
| Định dạng summary | `CompactionStateContext` đã tiêm path đã sửa, task, MCP, todo. Schema đề xuất thêm objective/constraints, decisions, checks, unresolved failures, artifact, next steps | Schema cố định Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context, kèm `<read-files>` và `<modified-files>`; `fileOps` cộng dồn từ details của lần compact trước | khác, pi cụ thể hơn ở danh sách file đọc |
| Tỉa khi tóm tắt | `compaction_verbatim_input` mặc định bật; ưu tiên verbatim history | `serializeConversation` cắt mọi tool result còn 2000 ký tự trước khi tóm tắt | khác |
| Cache khi tóm tắt | Giữ căn prefix với turn cha: `generate_session_compact` gửi session id của cha và **giữ tool list**. Comment trong `session_compact.rs`: bỏ tool sẽ dịch prefix và bắt prefill lại toàn bộ. Không copy `cacheRetention: "none"` của pi | `completeSummarization` đặt `cacheRetention: "none"`. Không có session id thì sinh id mới, vì summary là transcript một lần | khác có chủ ý; Cook không học vế tắt cache |
| Reserve | 32768 token cho prompt/summary/reasoning của compaction (`SUMMARY_BUDGET_RESERVE_TOKENS`) | `maxTokens = min(floor(0.8 × reserveTokens), model.maxTokens)` trong `generateSummaryWithUsage`. Branch summary dùng `min(4096, model.maxTokens)` rồi cùng wrapper tắt cache | đã đọc source, khác công thức |
| Summary bị cắt giữa chừng | Outcome ghi `Truncated` và `compaction.complete` vẫn chạy (`compaction.rs`) | `getSummarizationFailure` từ chối checkpoint một summary dừng vì `length` | khác; chưa đổi hành vi Cook |
| Hai lượt | Two-pass: pass 1 snapshot prefix, tóm tắt nền, lưu NOTE₁ kèm fingerprint; prefix/model đổi thì invalidate. Feature registry mặc định `true`; `CompactionPolicy::default()` portable là `false` | Không có two-pass; có hook `session_before_compact` cho phép extension cấp summary. Summary sau dùng `UPDATE_SUMMARIZATION_PROMPT` để gộp summary trước, không phải prefire | khác |
| Per-model | Context window là per-model; không retune ở đây | `compaction.modelOverrides` cho `reserveTokens`/`keepRecentTokens` theo `provider/modelId` | pi có, Cook không |

## 6. Chính sách prefix cache

| Khía cạnh | Cook | pi | Đối chiếu |
|---|---|---|---|
| Cơ chế adapter | Responses: `prompt_cache_key` fallback về conversation ID, `previous_response_id` hiện là `None`; Messages: đánh breakpoint ở system và transcript; memory-context block được tái dùng để prefix không đổi | `cacheRetention` short/long, `PI_CACHE_RETENTION=long`, TTL lấy từ tier `promptCache` của từng model | giống về hướng, khác về mức cụ thể |
| Đo hit/miss | `usage.rs` có input/output/cache/reasoning; kế hoạch phase 4 thêm `uncachedInputTokens` và `cacheFieldPresent` | `Usage` của mỗi assistant message đã tách `input`, `cacheRead`, `cacheWrite` (và `cacheWrite1h`), `reasoning`, kèm `cost` theo từng bucket | pi đã có sẵn thứ Cook đang định thêm |
| Giữ cache sống | Không có. Cook chỉ giữ prefix ổn định và ghi nhận cache read | `cache-warmer.ts`: gửi lại request gần nhất với `maxTokens: 1` trước khi hết TTL, chỉ khi `continuationProbability × missCost − warmCost ≥ $0.05`; bỏ qua nếu request không replay an toàn; usage ghi thành entry `kind: "cache_warm"` | Cook không có tương ứng |
| Hiển thị | Ledger phiên | Footer `footer.ts`: `CH` là hit rate của **assistant message mới nhất**, `cacheRead / (input + cacheRead + cacheWrite)`, chỉ hiện khi message đó có cache read hoặc write. Không phải trung bình cả phiên | Cook không có tương ứng |

Đây là mảng pi đi xa hơn Cook một bước có ý nghĩa: pi **định giá** việc giữ cache sống và chỉ làm khi kỳ vọng tiết kiệm vượt ngưỡng, thay vì chỉ tránh làm hỏng nó. Cook hiện dừng ở vế "tránh làm hỏng".

## 7. Kích thước output của tool

| Tool | Cook | pi | Đối chiếu |
|---|---|---|---|
| read | Cap 25000 **estimated** token (`READ_FILE_MAX_TOKENS`) và `MAX_LINES_READ = 1000`. Khi chạm trần dòng, marker đã nêu số byte bị cắt, tổng số dòng, khoảng đang hiện, và `offset` kế (`read_file/mod.rs`). Khi chạm trần token (`FileTooLarge`), chỉ gợi ý dùng offset/limit, không tính offset kế | `truncateHead` với `DEFAULT_MAX_LINES = 2000` hoặc `DEFAULT_MAX_BYTES = 50KB`, cái nào tới trước; thông báo nêu rõ `offset` kế tiếp và tổng số dòng | gần nhau ở trần dòng; khác ở trần token |
| bash | Mặc định 20000 ký tự cho model; log đầy đủ có đường dẫn khi bị cắt | `truncateTail` cùng ngưỡng 2000 dòng / 50KB; output đầy đủ lưu file tạm và đường dẫn nằm trong thông báo; executor cap phần thu thập thô ở 100KB | khác |
| grep/find/ls | Theo registry/tool riêng | Giới hạn số kết quả: grep 100, find 1000, ls 500; cộng trần 50KB; dòng match dài cắt ở `GREP_MAX_LINE_LENGTH = 500` ký tự | khác |
| Prompt quá lớn | `prompt_offload.rs`: ghi file, model nhận head/tail; ngưỡng `READ_FILE_MAX_TOKENS × BYTES_PER_TOKEN = 100000` byte | Không có cơ chế tương ứng; dựa vào `@file` và read có offset | Cook không có tương ứng ở phía pi |
| Thời điểm cắt | Bash cắt lúc sinh. Read cắt lúc sinh theo dòng và theo token. Request-copy pruning sửa bản copy, không sửa history. Phase 3, nếu làm, dùng lại marker offset kế của read, không thêm kiểu head+tail cho read | Luôn lúc sinh output: read là `truncateHead`, bash là `truncateTail` | Cook đã đứng gần pi ở read theo dòng |

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

Chỉ là câu trong tài liệu thiết kế. Không phải phase mới và không phải đổi default.

1. **Đặt tên luật append-only và một ngoại lệ.** Byte đã gửi giữ nguyên. Chỗ gãy cache có kế hoạch trên đường nóng là compaction. Nhánh step-aware giữ opt-in và tắt mặc định. Không port cơ chế hoãn ghi tới checkpoint của lane.
2. **Nếu sau này bỏ một tool result, ghi omission thành bản ghi append, không sửa canonical history.** pi đã làm bằng `context_edit`. Cook chưa làm với bản request tỉa. Không thêm store đó trong thí nghiệm v2. Phase 2 đã nói canonical history không đổi.
3. **Read giữ đầu file và nêu offset kế, tổng số dòng, khoảng đang hiện.** Trần dòng của Cook đã làm vậy. Trần token (`FileTooLarge`) thì chưa tính offset kế; nếu phase 3 thêm cap, dùng lại marker sẵn có, không thêm head+tail cho read. Bash giữ đuôi và đường dẫn log đầy đủ, như hiện tại. Không chép 50KB hay 2000 dòng của pi, và không hạ `READ_FILE_MAX_TOKENS`.
4. **Danh sách file trong summary lấy từ tool provenance và gộp với danh sách của summary trước.** pi làm bằng `fileOps` cộng `readFiles` / `modifiedFiles` của lần compact trước. Cook đã tiêm `agent_edited_paths`, task, MCP, todo qua `CompactionStateContext`. Model không được yêu cầu nhớ các path đó. Không thành phase riêng.

### Nên từ chối, và lý do

1. **Cắt về 4 tool / bỏ MCP / bỏ subagent / bỏ goal để tiết kiệm token.** Đó là lựa chọn sản phẩm của pi, không phải kết quả tối ưu token. Chính tài liệu Cook nói một skill bị ẩn đi là quality failure chứ không phải tiết kiệm.
2. **Đưa vòng coding lên Batch API.** pi cũng không làm, nhưng đừng đọc pi như bằng chứng: cơ chế deferred của pi phục vụ **độ bền của run** (suspend/resume qua tiến trình), không phải giảm token, và tại revision này chỉ provider giả implement nó. Bốn điều kiện ở §9 của tài liệu Cook vẫn nguyên giá trị.
3. **Port lane/durability vào Cook để giảm token.** Lane giải bài toán crash-recovery và nhiều danh tính song song trên một history, không giải bài toán token. Tài liệu Cook đã nói rõ: bố cục tiến trình không làm prompt ngắn đi.
4. **Bắt chước fallback usage của pi.** Chỗ này pi yếu hơn: không có dấu hiệu phân biệt "usage thiếu" với "call zero token", trong khi Cook coi đó là điểm mấu chốt. Giữ semantics incomplete của Cook. Không điền zero khi server không báo cache.
5. **Bỏ hai-pass prefire vì pi không có.** "Proactive" của pi là `shouldCompact`: `contextTokens > contextWindow − reserveTokens`, không phải pass nền sớm 10 điểm. Không có prefire không chứng minh prefire là lãng phí.
6. **Đặt `cacheRetention: "none"` lên request compaction của Cook.** pi tắt cache vì summary của họ là transcript một lần. Cook cố ý giữ tool list và session id của cha để prefix không dịch (`session_compact.rs`). Chép vế tắt cache là phá căn prefix đó.
7. **Gọi warm cache (`maxTokens: 1` trước khi hết TTL, ngưỡng $0.05 của pi).** Cook chưa có TTL per-model, và phase 4 chưa báo hit với miss. Không phải phase của v2.
8. **Từ chối summary bị cắt vì `length`, theo `getSummarizationFailure` của pi.** Cook ghi outcome `Truncated` rồi vẫn `compaction.complete`. Đổi việc đó cần một matrix riêng, không phải phase v2. Khi chấm điểm, summary bị cắt không tính là checkpoint sạch.

## 14. Điểm chưa xác minh

Các điểm sau chưa đủ căn cứ để khẳng định, ghi lại để không bị đọc như sự thật:

- **Hoãn ghi giữa step tới checkpoint trên `AgentSession`.** `harness.md` nói việc đó cho lane. README và `agent-session.ts` xác nhận CLI append `context_edit` và không sửa entry cũ. Chưa đọc một đường trong `AgentSession` chứng minh mọi ghi giữa step đều bị hoãn tới checkpoint.
- **Deferred cho provider thật.** Tại revision này `fetchDeferred` trong `packages/ai/src` chỉ được gán implementation ở `providers/faux.ts` (cộng lớp bọc `lazy.ts` / `models.ts`). Kết luận "pi đã cân nhắc Batch API rồi chọn background mode" đến từ một bản tóm tắt tìm kiếm trỏ tới PR #7339, không phải đọc trực tiếp PR đó. Không dùng câu này như trích dẫn.
- **Hành vi của pi khi provider không trả usage.** Không tìm thấy cờ "incomplete" hay tương đương. Chỗ xử lý đã thấy là fallback trong `faux` và experimental micro. Chưa loại trừ được còn đường khác trong từng provider.
- **Đường harness có phải tương lai của CLI hay không.** Hiện `coding-agent` import `Agent` cổ điển cho mọi mode đã phát hành. Chưa rõ ý định migration. `harness-v2.md` không có trong cây đã ghim.

Đã xác minh bằng đọc source tại revision đã ghim, và đã sửa các mục phía trên cho khớp: luật append-only trong `packages/agent/docs/harness.md` (không phải `harness-v2.md`); `context_edit` trong README của coding-agent; `shouldCompact`, `completeSummarization`, `generateSummaryWithUsage` (`floor(0.8 × reserveTokens)`), `getSummarizationFailure`, và `serializeConversation` trong `compaction.ts` / `utils.ts`; `CH` trong `footer.ts`; warming cache trong `cache-warmer.ts`; `fetchDeferred` chỉ ở `faux.ts`. Phía Cook: `prune_conversation` và `keep_last_n_turns`, split 95% trong `two_pass.rs`, prefix alignment trong `session_compact.rs`, outcome `Truncated` trong `compaction.rs`, marker offset kế trong `read_file/mod.rs`, artifact `compaction_requests/{request_id}.json`.
