# Let Cook

Chat-first Tauri 2 + React ACP client for the existing Cook agent. It runs
`cook agent stdio`, shares `~/.cook` with the CLI, and never calls models or
tools from the renderer.

Architecture: [`docs/desktop-app.md`](../../../docs/desktop-app.md).  
Client-layering fold: [`docs/desktop-app-client-implement.md`](../../../docs/desktop-app-client-implement.md).  
Production plan (providers, Claude Desktop–class features):
[`docs/desktop-app-implement.md`](../../../docs/desktop-app-implement.md).  
Wire map: [`docs/desktop-tui-capability-map.md`](../../../docs/desktop-tui-capability-map.md).  
Self-build / updater artifacts: [`docs/desktop-release.md`](../../../docs/desktop-release.md).

## Develop

Prerequisites: pnpm, Rust, an installed `~/.cook/bin/cook` (or
`COOK_BIN`), and the Tauri Linux packages listed in the architecture doc.

```sh
pnpm install
pnpm test
pnpm tauri dev
```

Desktop diagnostics are written to `~/.cook/logs/desktop.log`. To include ACP
method/response tracing and sanitized agent stderr, run:

```sh
COOK_DESKTOP_TRACE=1 pnpm tauri dev
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

The host resolves `cook` in this order (`src-tauri/src/bin_resolve.rs`):

1. `COOK_BIN`
2. `~/.cook/bin/cook` (or `$COOK_HOME/bin/cook`)
3. Optional bundled sidecar `cook-<target-triple>` next to the app

Alpha packages discover the existing CLI and do not bundle or overwrite it.
Stable builds may ship a sidecar by placing
`src-tauri/binaries/cook-<triple>` and adding
`"externalBin": ["binaries/cook"]` under `bundle` in `tauri.conf.json`.

### App updater (shell only)

`tauri-plugin-updater` updates the **desktop app binary** only. It must never
write `~/.cook/bin/cook`. Dev/`pnpm tauri dev` keeps
`bundle.createUpdaterArtifacts: false`, a placeholder `pubkey`, and empty
`endpoints`. Release builds (tag `v*` → `.github/workflows/release.yml`) overlay
`src-tauri/tauri.release.conf.json` with the committed minisign pubkey,
`https://download.letcook.dev/latest.json`, and `VITE_COOK_UPDATER=1` so
Settings → About can check / install.

First-time key (private key stays at `~/.tauri/let-cook.key`, never git):

```sh
pnpm tauri signer generate -w ~/.tauri/let-cook.key
```

The public half is `src-tauri/updater.pubkey`. macOS packages for this fork
are unsigned for Apple codesign (same policy as the CLI); updater signatures
are minisign and required.

See [`docs/desktop-release.md`](../../../docs/desktop-release.md). One-click
install (CLI + desktop):

```sh
curl -fsSL https://download.letcook.dev/install.sh | bash
```

Advanced BYOK model configuration remains in `~/.cook/config.toml`; the API
key form uses `x.ai/setApiKey` rather than implementing another TOML writer.
