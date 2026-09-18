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

Desktop diagnostics are written to `~/.thanh/logs/desktop.log`. To include ACP
method/response tracing and sanitized agent stderr, run:

```sh
THANH_DESKTOP_TRACE=1 pnpm tauri dev
```

The trace records method names and ids only; credentials and request payloads are
not logged. Agent stderr is included in the same sanitized `desktop.log`.

The app and CLI major versions must match. `src-tauri` deliberately contains
an empty `[workspace]` and is not a member of the generated root workspace.

## Test and package

```sh
pnpm build
pnpm test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm tauri build --bundles appimage,deb   # Linux
pnpm tauri build --bundles dmg            # macOS (unsigned ok for this fork)
```

Bundle targets in `tauri.conf.json` are `appimage`, `deb`, and `dmg`. Windows
installers are deferred until Linux + macOS are boring.

### Agent binary resolution

The host resolves `thanh` in this order (`src-tauri/src/bin_resolve.rs`):

1. `THANH_BIN`
2. `~/.thanh/bin/thanh` (or `$THANH_HOME/bin/thanh`)
3. Optional bundled sidecar `thanh-<target-triple>` next to the app

Alpha packages discover the existing CLI and do not bundle or overwrite it.
Stable builds may ship a sidecar by placing
`src-tauri/binaries/thanh-<triple>` and adding
`"externalBin": ["binaries/thanh"]` under `bundle` in `tauri.conf.json`.

### App updater (shell only)

`tauri-plugin-updater` updates the **desktop app binary** only. It must never
write `~/.thanh/bin/thanh`. Dev/default config keeps
`bundle.createUpdaterArtifacts: false`, a placeholder `pubkey`, and empty
`endpoints` so builds work without signing keys. Before shipping updates:

1. `pnpm tauri signer generate -w ~/.tauri/thanh-desktop.key`
2. Put the public key and HTTPS endpoints in `plugins.updater`
3. Set `createUpdaterArtifacts: true` and export `TAURI_SIGNING_PRIVATE_KEY`
4. Flip `UPDATER_CONFIGURED` in `src/updater.ts` so Settings → About enables
   **Check for updates**

macOS packages for this fork are unsigned (same policy as the CLI).

See [`scripts/install.sh`](scripts/install.sh) for local artifact installation.

Advanced BYOK model configuration remains in `~/.thanh/config.toml`; the API
key form uses `x.ai/setApiKey` rather than implementing another TOML writer.
