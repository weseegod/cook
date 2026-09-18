#!/usr/bin/env bash
# Bump the fork version, build `cook` locally, and publish a GitHub Release
# with the local binary — NO GitHub Actions / CI.
#
# The updater (`cook update` / Ctrl+U) reads from a GitHub Release:
#   releases/latest/download/stable          (plain-text channel pointer)
#   releases/latest/download/cook-<ver>-<os>-<arch>  (the binary)
#   releases/latest/download/cook-<ver>-<os>-<arch>.sha256
#
# Usage:
#   scripts/publish_release.sh            # bump patch: 1.0.0 -> 1.0.1
#   scripts/publish_release.sh 1.1.0      # explicit version
#
# Prereqs / notes:
#   - Binary is built LOCALLY via ./build.sh for the CURRENT platform only.
#     To ship other platforms, build on each machine and upload the assets to
#     the release yourself (e.g. `gh release upload vX.Y.Z cook-...-macos-aarch64`).
#   - The final publish uses `gh`; install it (brew install gh / apt install gh)
#     and authenticate once (gh auth login). If `gh` is missing the script
#     bumps/tags/pushes and prints the exact `gh release create` command to run.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

VERSION_FILE="crates/codegen/xai-grok-version/Cargo.toml"
PAGER_FILE="crates/codegen/xai-grok-pager-bin/Cargo.toml"
LOCK_FILE="Cargo.lock"
DESKTOP_DIR="frontend/apps/let-cook"
DESKTOP_PACKAGE="$DESKTOP_DIR/package.json"
DESKTOP_CARGO="$DESKTOP_DIR/src-tauri/Cargo.toml"
DESKTOP_LOCK="$DESKTOP_DIR/src-tauri/Cargo.lock"
DESKTOP_CONFIG="$DESKTOP_DIR/src-tauri/tauri.conf.json"
APP="cook"
REPO="weseegod/thanh"

if [ ! -f "$VERSION_FILE" ] || [ ! -f "$PAGER_FILE" ] || [ ! -f "$DESKTOP_PACKAGE" ]; then
  echo "ERROR: lockstepped Cargo.toml files not found" >&2
  exit 1
fi

current="$(grep -m1 '^version = ' "$VERSION_FILE" | sed -E 's/^version = "([^"]+)"/\1/')"
echo "==> Current version: $current"

if [ $# -ge 1 ]; then
  new="$1"
  echo "==> Bumping to requested version: $new"
else
  major="$(echo "$current" | cut -d. -f1)"
  minor="$(echo "$current" | cut -d. -f2)"
  patch="$(echo "$current" | cut -d. -f3)"
  new="$major.$minor.$((patch + 1))"
  echo "==> Bumping patch to: $new"
fi

# Plain 3-part semver, strictly increasing — the stable channel rejects pre-releases.
if ! echo "$new" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ERROR: '$new' is not plain 3-part semver (e.g. 1.0.1)" >&2
  exit 1
fi

# Bump the two lockstepped version crates.
for f in "$VERSION_FILE" "$PAGER_FILE"; do
  sed -i -E "s/^version = \"[^\"]+\"/version = \"$new\"/" "$f"
done

# Keep the desktop shell in the same major/version train as the CLI gate.
sed -i -E "0,/\"version\": \"[^\"]+\"/s//\"version\": \"$new\"/" "$DESKTOP_PACKAGE"
sed -i -E "0,/^version = \"[^\"]+\"/s//version = \"$new\"/" "$DESKTOP_CARGO"
sed -i -E "0,/\"version\": \"[^\"]+\"/s//\"version\": \"$new\"/" "$DESKTOP_CONFIG"
cargo metadata --manifest-path "$DESKTOP_CARGO" --format-version 1 --no-deps >/dev/null

# Bump the same two entries in Cargo.lock (portable via awk).
awk -v new="$new" '
  /^name = "xai-grok-version"$/ || /^name = "xai-grok-pager-bin"$/ { name=1 }
  name && /^version = / { sub(/^version = ".*"/, "version = \"" new "\""); name=0 }
  { print }
' "$LOCK_FILE" > "$LOCK_FILE.tmp" && mv "$LOCK_FILE.tmp" "$LOCK_FILE"

git add "$VERSION_FILE" "$PAGER_FILE" "$LOCK_FILE" \
  "$DESKTOP_PACKAGE" "$DESKTOP_CARGO" "$DESKTOP_LOCK" "$DESKTOP_CONFIG"
git commit -m "Release v$new"
git tag "v$new"

echo "==> Building $APP locally (./build.sh)..."
./build.sh

# Stage the binary asset for the current platform.
os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Linux-x86_64)             platform="linux-x86_64" ;;
  Darwin-arm64|Darwin-aarch64) platform="macos-aarch64" ;;
  Darwin-x86_64)            platform="macos-x86_64" ;;
  *) platform="$(echo "$os" | tr '[:upper:]' '[:lower:]')-$(echo "$arch" | tr '[:upper:]' '[:lower:]')" ;;
esac
asset="$APP-$new-$platform"
cp "target/release/xai-grok-pager" "$asset"
chmod +x "$asset"
shasum -a 256 "$asset" > "$asset.sha256"
printf '%s\n' "$new" > stable
printf '%s\n' "$new" > alpha

# Build the native desktop artifact locally on supported v1 release hosts.
desktop_assets=()
case "$platform" in
  linux-x86_64)
    (cd "$DESKTOP_DIR" && pnpm install --frozen-lockfile && pnpm tauri build --bundles appimage,deb)
    desktop_built="$(find "$DESKTOP_DIR/src-tauri/target/release/bundle/appimage" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
    if [ -n "$desktop_built" ]; then
      desktop_asset="let-cook-$new-linux-x86_64.AppImage"
      cp "$desktop_built" "$desktop_asset"
      desktop_assets+=("$desktop_asset")
    fi
    deb_built="$(find "$DESKTOP_DIR/src-tauri/target/release/bundle/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)"
    if [ -n "$deb_built" ]; then
      deb_asset="let-cook-$new-linux-x86_64.deb"
      cp "$deb_built" "$deb_asset"
      desktop_assets+=("$deb_asset")
    fi
    ;;
  macos-aarch64)
    (cd "$DESKTOP_DIR" && pnpm install --frozen-lockfile && pnpm tauri build --bundles dmg)
    desktop_built="$(find "$DESKTOP_DIR/src-tauri/target/release/bundle/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
    if [ -n "$desktop_built" ]; then
      desktop_asset="let-cook-$new-macos-aarch64.dmg"
      cp "$desktop_built" "$desktop_asset"
      desktop_assets+=("$desktop_asset")
    fi
    ;;
esac

release_assets=("$asset" "$asset.sha256" stable alpha "${desktop_assets[@]}")

git push origin main
git push origin "v$new"

cleanup() {
  rm -f "${release_assets[@]}"
}

if ! command -v gh >/dev/null 2>&1; then
  echo "==> v$new tagged & pushed; asset built: $asset"
  echo "==> 'gh' not found. Install + authenticate, then run:"
  echo "      gh auth login"
  echo "      gh release create v$new ${release_assets[*]} \\"
  echo "          --repo $REPO --title v$new --generate-notes"
  echo "    (then: rm -f $asset $asset.sha256 stable alpha)"
  exit 0
fi

gh release create "v$new" "${release_assets[@]}" \
  --repo "$REPO" --title "v$new" --generate-notes
cleanup
echo "==> Released v$new. Users get it via \`cook update\` (Ctrl+U)."
