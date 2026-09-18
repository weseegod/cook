<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://media.x.ai/v1/website/spacexai-symbol-white-transparent-0c31957f.png">
    <source media="(prefers-color-scheme: light)" srcset="https://media.x.ai/v1/website/spacexai-symbol-black-transparent-6435cf42.png">
    <img alt="SpaceXAI logo" src="https://media.x.ai/v1/website/spacexai-symbol-black-transparent-6435cf42.png" width="96">
  </picture>
  <br>
  Cook (<code>cook</code>) / Let Cook
</h1>

**Grok Build** is SpaceXAI's terminal-based AI coding agent. It runs as a
full-screen TUI that understands your codebase, edits files, executes shell
commands, searches the web, and manages long-running tasks — interactively,
headlessly for scripting/CI, or embedded in editors via the Agent Client
Protocol (ACP).

![Grok Build TUI](https://media.x.ai/v1/website/universe-tui-screenshot-6f7a0837.png)

**Learn more at [x.ai/cli](https://x.ai/cli)**

</div>

## About this fork (Cook)

This repository is a **BYOK-focused fork** of upstream
[Grok Build](https://github.com/xai-org/grok-build), synced periodically from
the SpaceXAI monorepo. It keeps the upstream agent/TUI core unchanged and
customizes only what third-party models need — DeepSeek, OpenRouter, or any
OpenAI-compatible API.

The fork ships as a command named **`cook`** (not `grok`) with its own home
directory **`~/.cook`** (config, auth, sessions, binaries, caches), completely
separate from `~/.grok`, so both can run side by side.

| Topic | Link |
|-------|------|
| How the repo is organized (for engineers/AI) | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Desktop app architecture | [`docs/desktop-app.md`](docs/desktop-app.md) |
| Desktop client-layering fold (honesty, registry) | [`docs/desktop-app-client-implement.md`](docs/desktop-app-client-implement.md) |
| Desktop production plan (providers, Claude Desktop–class) | [`docs/desktop-app-implement.md`](docs/desktop-app-implement.md) |
| Desktop ↔ TUI capability map | [`docs/desktop-tui-capability-map.md`](docs/desktop-tui-capability-map.md) |
| BYOK model setup | [`docs/byok-models.md`](docs/byok-models.md) |
| Syncing upstream | [`UPSTREAM-MERGE.md`](UPSTREAM-MERGE.md) |
| Restore core surfaces after a sync (implement + test) | [`docs/post-merge-core-fix.md`](docs/post-merge-core-fix.md) |

## Installing & updating

Prebuilt binaries are published on this fork's
[GitHub Releases](https://github.com/weseegod/thanh/releases) for **macOS
(Apple Silicon)** and **Linux (x86_64)**, built locally by
`scripts/publish_release.sh` (there is no CI).

```sh
# Pick the latest version from the releases page:
curl -fsSL -o ~/.local/bin/cook \
  https://github.com/weseegod/thanh/releases/latest/download/cook-<version>-macos-aarch64
chmod +x ~/.local/bin/cook
# Linux (x86_64): replace the asset name with cook-<version>-linux-x86_64
```

A background updater keeps the binary fresh — the welcome screen shows
`Update: vX available — press ctrl+u to restart`, or run `cook update`
manually. It only manages `~/.cook/bin/cook` and never touches `~/.grok`.

## Building from source

Requirements: **Rust** (toolchain pinned by
[`rust-toolchain.toml`](rust-toolchain.toml)) and
**[DotSlash](https://dotslash-cli.com)** on `PATH` (needed so the hermetic
[`bin/protoc`](bin/protoc) wrapper can download and run `protoc`).

```sh
./build.sh                              # builds and installs `cook` into ~/.cook/bin (+ ~/.local/bin symlink)
cargo run -p xai-grok-pager-bin         # build + launch the TUI in one go
cargo check -p xai-grok-pager-bin       # fast validation
```

## Development

```sh
cargo check -p <crate>        # always target specific crates; full-workspace builds are slow
cargo test -p xai-grok-config # per-crate tests
cargo clippy -p <crate>       # lint config: clippy.toml at the repo root
cargo fmt --all               # rustfmt.toml at the repo root
```

> [!IMPORTANT]
> The root `Cargo.toml` (workspace members, dependency versions, lints,
> profiles) is **generated** — treat it as read-only. Prefer editing per-crate
> `Cargo.toml` files.

## Documentation

User-facing docs ship with the pager crate:
[`crates/codegen/xai-grok-pager/docs/user-guide/`](crates/codegen/xai-grok-pager/docs/user-guide/)
— getting started, keyboard shortcuts, slash commands, configuration, theming,
MCP servers, skills, plugins, hooks, headless mode, and more. Full online
documentation: [docs.x.ai/build/overview](https://docs.x.ai/build/overview).

## Contributing

External contributions are not accepted. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

First-party code in this repository is licensed under the **Apache License,
Version 2.0** — see [`LICENSE`](LICENSE). Third-party and vendored code
remains under its original licenses — see
[`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) and
[`third_party/NOTICE`](third_party/NOTICE).