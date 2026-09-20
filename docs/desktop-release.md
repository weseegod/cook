# Cook + Let Cook release (self-hosted → R2)

Trigger: **push tag** `v*` (via `scripts/publish_release.sh`). Self-hosted
Mac mini + Ubuntu (same machines as quac). No Apple notarization.

| Job | Runner | Artifacts |
|-----|--------|-----------|
| macOS arm64 | `macos-arm64` | `cook-<ver>-macos-aarch64`, `let-cook-<ver>-macos-aarch64.dmg` + `.app.tar.gz` + `.sig` |
| macOS Intel | `macos-arm64` (cross) | `cook-<ver>-macos-x86_64`, `let-cook-<ver>-macos-x86_64.dmg` + `.app.tar.gz` + `.sig` |
| Windows | `linux-x64` (xwin) | `cook-<ver>-windows-x86_64`, `let-cook-<ver>-windows-x86_64-setup.exe` + `.sig` |
| Linux Ubuntu | `linux-x64` (native) | `cook-<ver>-linux-x86_64`, `.AppImage` + `.sig`, `.deb` + `.sig` |

Public host: **https://download.letcook.dev** (Cloudflare R2 bucket `cook-releases`).

```
latest.json / stable / alpha / install.sh     (pointers, rewritten last)
v{ver}/   cook-*  let-cook-*                  (immutable objects)
cook-{ver}-{os}-{arch}                        (CLI copies at bucket root)
```

```bash
# Ship
scripts/publish_release.sh            # bump patch, tag vX.Y.Z, push
scripts/publish_release.sh 1.1.0      # explicit version

# Install (CLI + desktop)
curl -fsSL https://download.letcook.dev/install.sh | bash
```

Updater endpoints baked into release binaries:

- CLI (`cook update`): `https://download.letcook.dev/stable` + `cook-<ver>-<os>-<arch>`
- Desktop: `https://download.letcook.dev/latest.json`

Signing: `~/.tauri/let-cook.key` (private, GitHub secret `TAURI_SIGNING_PRIVATE_KEY`)
and committed `frontend/apps/let-cook/src-tauri/updater.pubkey`.

R2 credentials live in GitHub Actions secrets (`COOK_RELEASES_R2_*`). Local
`.env` may use `COOK_S3_*` aliases (never commit `.env`).

### Self-hosted runners (same machines as quac)

GitHub runners are repo-scoped. Register a **second** runner on each machine
to `weseegod/cook` with the same labels quac uses:

| Machine | Label | Name |
|---------|-------|------|
| thanhpc (Ubuntu) | `linux-x64` | `thanhpc` |
| Mac mini | `macos-arm64` | `Buis-Mac-mini` |

```bash
# Linux example (do not reuse the quac runner directory)
mkdir -p ~/actions-runner-cook && cd ~/actions-runner-cook
# extract GitHub Actions runner, then:
gh api -X POST repos/weseegod/cook/actions/runners/registration-token --jq .token
./config.sh --unattended --url https://github.com/weseegod/cook \
  --token TOKEN --name thanhpc --labels linux-x64
```

### GitHub secrets

| Secret | Source |
|--------|--------|
| `COOK_RELEASES_R2_ENDPOINT` | `.env` `COOK_S3_ENDPOINT` |
| `COOK_RELEASES_R2_ACCESS_KEY_ID` | `.env` `COOK_S3_ACCESS_KEY` |
| `COOK_RELEASES_R2_SECRET_ACCESS_KEY` | `.env` `COOK_S3_SECRET_KEY` |
| `COOK_RELEASES_R2_BUCKET` | `cook-releases` |
| `COOK_RELEASES_PUBLIC_BASE_URL` | `https://download.letcook.dev` |
| `COOK_UPDATER_PUBLIC_KEY` | `frontend/apps/let-cook/src-tauri/updater.pubkey` |
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/let-cook.key` |
