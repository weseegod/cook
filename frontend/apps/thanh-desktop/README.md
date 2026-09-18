# Thanh Desktop

Chat-first Tauri 2 + React ACP client for the existing Thanh agent. It runs
`thanh agent stdio`, shares `~/.thanh` with the CLI, and never calls models or
tools from the renderer.

Architecture: [`docs/desktop-app.md`](../../../docs/desktop-app.md).  
Client-layering fold: [`docs/desktop-app-client-implement.md`](../../../docs/desktop-app-client-implement.md).  
Production plan (providers, Claude Desktop–class features):
[`docs/desktop-app-implement.md`](../../../docs/desktop-app-implement.md).  
Wire map: [`docs/desktop-tui-capability-map.md`](../../../docs/desktop-tui-capability-map.md).

## Develop

Prerequisites: pnpm, Rust, an installed `~/.thanh/bin/thanh` (or
`THANH_BIN`), and the Tauri Linux packages listed in the architecture doc.

```sh
pnpm install
pnpm test
pnpm tauri dev
```

The app and CLI major versions must match. `src-tauri` deliberately contains
an empty `[workspace]` and is not a member of the generated root workspace.

## Test and package

```sh
pnpm build
pnpm test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --bundles appimage,deb   # Linux
```

Alpha packages discover the existing CLI and do not bundle or overwrite it.
See [`scripts/install.sh`](scripts/install.sh) for local artifact installation.

Advanced BYOK model configuration remains in `~/.thanh/config.toml`; the API
key form uses `x.ai/setApiKey` rather than implementing another TOML writer.
