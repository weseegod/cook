# Cook

Cook is a local-first AI coding workspace for developers who want control over
their models, keys, and source code.

- **Cook CLI** — a full-screen terminal agent, headless runner, and ACP server.
- **Let Cook** — a chat-first desktop client built with Tauri and React.
- **BYOK by default** — connect OpenAI-compatible APIs, Anthropic, DeepSeek,
  OpenRouter, or another provider from `~/.cook/config.toml`.
- **One home directory** — configuration, authentication, sessions, memory,
  plugins, and updates live under `~/.cook`.

Project website: **[letcook.dev](https://letcook.dev)**

> Cook began as a focused fork of **Grok Build**. The product, documentation,
> and public direction of this repository are maintained as Cook.

## What Cook can do

Cook understands a codebase, reads and edits files, runs shell commands,
searches the web, manages sessions, and handles long-running tasks. Use the
same agent runtime through any of these entry points:

- interactive TUI: `cook`
- headless scripting and CI: `cook -p "<prompt>"`
- editor integrations: `cook agent stdio`
- desktop chat: the Let Cook app in `frontend/apps/let-cook/`

## Install

Prebuilt downloads and release notes are published on
[letcook.dev](https://letcook.dev). To build the CLI locally, install Rust and
[DotSlash](https://dotslash-cli.com), then run:

```sh
./build.sh
```

The build installs `cook` into `~/.cook/bin` and creates a user-local command
link when the platform supports it. Run `cook --version` to verify the install.

## Configure a model

Cook reads user configuration from `~/.cook/config.toml`. A minimal
OpenAI-compatible setup looks like this:

```toml
[model_providers.local]
name = "Local provider"
base_url = "https://api.example.com/v1"
env_key = "LOCAL_API_KEY"

[model.coding]
model = "your-model-id"
model_provider = "local"
```

See [`docs/byok-models.md`](docs/byok-models.md) for provider examples,
capability notes, and troubleshooting.

## Develop

Requirements: Rust (the toolchain is pinned in
[`rust-toolchain.toml`](rust-toolchain.toml)), Node.js, pnpm, and DotSlash.

```sh
cargo check -p xai-grok-pager-bin
cargo test -p xai-grok-config
cargo clippy -p <crate>
cargo fmt --all
```

To work on the desktop client:

```sh
cd frontend/apps/let-cook
pnpm install
pnpm test
pnpm tauri dev
```

## Documentation

- [Architecture](ARCHITECTURE.md) — workspace layout and runtime boundaries
- [Desktop app](docs/desktop-app.md) — Let Cook architecture
- [BYOK models](docs/byok-models.md) — model and provider configuration
- [User guide](crates/codegen/xai-grok-pager/docs/user-guide/) — CLI usage,
  configuration, permissions, MCP, plugins, and integrations
- [Upstream sync playbook](UPSTREAM-MERGE.md) — maintainer-only merge notes

## Contributing

The public tree is available for transparency, local builds, and evaluation.
External pull requests are not currently accepted; see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for the current policy.

Please report security issues privately according to
[`SECURITY.md`](SECURITY.md), never in a public issue.

## License

First-party code is licensed under the **Apache License, Version 2.0** — see
[`LICENSE`](LICENSE). Third-party and vendored code retains its original
license; see [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) and
[`third_party/NOTICE`](third_party/NOTICE).
