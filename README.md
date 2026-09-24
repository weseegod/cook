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

The website and product docs live in [`website/`](website/README.md). The site
renders the user guide directly from
[`crates/codegen/xai-grok-pager/docs/user-guide/`](crates/codegen/xai-grok-pager/docs/user-guide/).

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

Prebuilt CLI and desktop installers are published to
[download.letcook.dev](https://download.letcook.dev) (Cloudflare R2) for
**macOS (Apple Silicon + Intel)**, **Linux x86_64**, and **Windows x86_64**.
A tag `v*` starts the self-hosted GitHub Actions pipeline
([`docs/desktop-release.md`](docs/desktop-release.md)).

Install the CLI only on macOS or Linux:

```sh
curl -fsSL https://download.letcook.dev/install.sh | COOK_INSTALL_CLI_ONLY=1 bash
```

Install Let Cook Desktop only on macOS or Linux:

```sh
curl -fsSL https://download.letcook.dev/install.sh | COOK_INSTALL_DESKTOP_ONLY=1 bash
```

On Windows, download the CLI and desktop installer separately from
[letcook.dev](https://letcook.dev/#install). Some desktop packages include the
Cook agent. If Let Cook asks for it, install the CLI too.

A background updater keeps the binary fresh — the welcome screen shows
`Update: vX available — press ctrl+u to restart`, or run `cook update`
manually. It only manages `~/.cook/bin/cook` and never touches `~/.grok`.

To build the CLI locally, install Rust and
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
[`rust-toolchain.toml`](rust-toolchain.toml)), Node.js, pnpm, and DotSlash on
`PATH` (needed so the hermetic [`bin/protoc`](bin/protoc) wrapper can download
and run `protoc`).

```sh
cargo run -p xai-grok-pager-bin   # build + launch the TUI in one go
cargo check -p xai-grok-pager-bin # fast validation
cargo test -p xai-grok-config     # per-crate tests
cargo clippy -p <crate>           # always target a specific crate: full-workspace builds are slow
cargo fmt --all
```

> [!IMPORTANT]
> The root `Cargo.toml` (workspace members, dependency versions, lints,
> profiles) is **generated** — treat it as read-only. Prefer editing per-crate
> `Cargo.toml` files.

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
- [Desktop ↔ TUI capability map](docs/desktop-tui-capability-map.md) — what the
  desktop covers of the TUI, and what it deliberately does not
- [Desktop production plan](docs/desktop-app-implement.md) and
  [client layering](docs/desktop-app-client-implement.md) — providers and the
  honesty/registry fold
- [Desktop release](docs/desktop-release.md) — self-build and updater artifacts
- [BYOK models](docs/byok-models.md) — model and provider configuration
- [User guide](crates/codegen/xai-grok-pager/docs/user-guide/) — CLI usage,
  configuration, permissions, MCP, plugins, and integrations
- [Upstream sync playbook](UPSTREAM-MERGE.md) — maintainer-only merge notes
- [Restore core surfaces after a sync](docs/post-merge-core-fix.md) — implement
  and test the fork-only surfaces a sync can drop

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
