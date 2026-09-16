# thanh-desktop

Folder layout for **Thanh Desktop**. **Not implemented yet** — no Tauri/React
code, no `package.json`, no Cargo crate.

Canonical spec: [`docs/desktop-app.md`](../../../docs/desktop-app.md).

```
thanh-desktop/
  scripts/                 # install.sh (packaging PR)
  src/
    acp/                   # ACP client + x.ai/* types
      generated/           # ts-rs bindings (do not edit)
    state/                 # session + catalog stores
    ui/
      chat/
      permissions/
      sessions/
      settings/
      welcome/
    theme/                 # tokens mapped from TUI appearance
  src-tauri/
    binaries/              # optional thanh sidecar (stable, not alpha)
    capabilities/          # Tauri 2 allowlist
    src/                   # Rust host: spawn agent stdio, ACP mux
```

When implementation starts, follow the PR sequence in the spec (scaffold →
ACP host → first turn). Do not add `src-tauri` to the root Cargo workspace.
