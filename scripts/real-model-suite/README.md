# Real-model suite

This headless suite runs the repository's debug `xai-grok-pager` binary against one local llama.cpp model and scores durable artifacts rather than the model's claims. Build the binary first:

```bash
cargo build -p xai-grok-pager-bin --bin xai-grok-pager
scripts/real-model-suite/run.sh --phase cli
scripts/real-model-suite/run.sh --phase tools --keep
scripts/real-model-suite/run.sh --case tools.read_file --keep
```

Run `run.sh --list` to see the case ids. `MODEL=bonsai2-27b` and `MODEL=spark25-4b` select the other supported launchers; the wire id and config key are derived automatically. The default `all` run takes roughly 70–110 minutes on MiMo and holds one model for the run. Failure artifacts and `failures.md` are retained under the printed output root. See [`../../docs/real-model-feature-suite.md`](../../docs/real-model-feature-suite.md) for the full contract.

## Artifact shape

Tool arguments are recovered from `chat_history.jsonl` assistant records. The first real `read_file` run produced this shape (the absolute temporary prefix is redacted), and the scorer is locked to it:

```json
{"type":"assistant","tool_calls":[{"name":"read_file","arguments":"{\"target_file\":\"<OUT_ROOT>/tools/tools.read_file/workdir/secret.txt\"}"}]}
```

The ACP smoke follows the in-tree method constants and uses `initialize`, `session/new`, and `session/prompt`.

The stock agent profile exposes five clearer aliases. Scoring maps them back to the canonical case ids: `run_terminal_command` → `run_terminal_cmd`, `spawn_subagent` → `task`, `get_command_or_subagent_output` → `get_task_output`, `wait_commands_or_subagents` → `wait_tasks`, and `kill_command_or_subagent` → `kill_task`.

## Coverage boundaries

| Surface | In this suite | Why |
|---|---|---|
| Headless one-shot (`-p`) | Yes | The runner. |
| Agent turn loop, sampler, tools, workspace FS, permissions, sessions, memory, compaction, hooks, worktree | Yes | Phases `tools` and `session`. |
| Subagents, workflow, MCP, ACP stdio, Codex / hashline / OpenCode smoke | Yes | Phase `agents`. |
| CLI that stays on the machine | Yes | Phase `cli`. |
| TUI slash commands, key bindings, scrollback, theme, voice, mermaid | No | Headless never enters `pager/src/app/event_loop.rs`. Owner: `xai-grok-pager-pty-harness` and pager unit tests. |
| Desktop `frontend/apps/let-cook` | No | Separate ACP client. It does not reimplement tools. |
| `image_gen`, `image_edit`, `image_to_video`, `reference_to_video` | No | Imagine API, not llama.cpp. A later `CLOUD=1` opt-in can add one case. Default off. |
| `login`, `logout`, `update`, `setup`, `share`, `trace` upload, telemetry | No | Account and release network. |
| Sandbox kernel (Landlock / seccomp) | Opt-in only | Add `session.sandbox_blocks_escape` only if `--sandbox` on this Linux host blocks a read outside the workdir. If it does not block, it is unsupported rather than a pass. |
| Leaf crates (render, fuzzy search, sqlite journal, crash handler, and the rest of the 93) | No | No model behavior. Use `cargo test -p <crate>`. |
| Full parity of concise, Codex, OpenCode, and hashline toolsets | No | Three smokes. Registry tests own the rest. |
| Shared leader session | No | It collides with an interactive user. |
