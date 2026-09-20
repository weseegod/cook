#!/usr/bin/env bash
# Build Let Cook desktop installers + Tauri updater artifacts for THIS machine.
# Local smoke only. Four-platform releases go through
# scripts/release-platform.sh + .github/workflows/release.yml.
#
# Usage:
#   scripts/desktop_release.sh                 # current package.json version
#   scripts/desktop_release.sh 1.0.37          # assert version matches
#
# Env:
#   COOK_REQUIRE_UPDATER=1          default; fail if signing key / pubkey missing
#   COOK_DESKTOP_ALLOW_UNSIGNED=1   skip updater signing (local smoke only)
#   COOK_DESKTOP_SKIP_SIDECAR=1     do not bundle cook
#   COOK_UPDATER_ENDPOINT           default https://download.letcook.dev/latest.json
#   TAURI_SIGNING_PRIVATE_KEY(_PATH) default ~/.tauri/let-cook.key
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$REPO_DIR/frontend/apps/let-cook"
OUT_DIR="$REPO_DIR/dist/desktop"
PUBLIC_BASE="${COOK_RELEASES_PUBLIC_BASE_URL:-https://download.letcook.dev}"
PUBLIC_BASE="${PUBLIC_BASE%/}"

# shellcheck source=desktop-signing-env.sh
source "$REPO_DIR/scripts/desktop-signing-env.sh"

version="${1:-}"
package_version="$(node -p "require('$DESKTOP_DIR/package.json').version")"
if [[ -n "$version" ]]; then
  if [[ "$package_version" != "$version" ]]; then
    echo "ERROR: desktop package.json is $package_version, expected $version" >&2
    exit 1
  fi
else
  version="$package_version"
fi

if ! echo "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "ERROR: '$version' is not semver" >&2
  exit 1
fi

os="$(uname -s)"
arch="$(uname -m)"
case "$os-$arch" in
  Linux-x86_64) platform="linux-x86_64"; triple="x86_64-unknown-linux-gnu" ;;
  Darwin-arm64|Darwin-aarch64) platform="macos-aarch64"; triple="aarch64-apple-darwin" ;;
  Darwin-x86_64) platform="macos-x86_64"; triple="x86_64-apple-darwin" ;;
  *)
    echo "ERROR: Let Cook v1 self-build supports Linux x86_64 and macOS aarch64/x86_64 (got $os-$arch)" >&2
    exit 1
    ;;
esac

require_updater=1
if [[ "${COOK_DESKTOP_ALLOW_UNSIGNED:-}" == "1" ]]; then
  require_updater=0
fi
if [[ "${COOK_REQUIRE_UPDATER:-1}" != "1" ]]; then
  require_updater=0
fi

if [[ "$require_updater" == "1" ]]; then
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    echo "ERROR: desktop updater signing key missing." >&2
    echo "  Generate once (keep the private key off git):" >&2
    echo "    cd $DESKTOP_DIR && pnpm tauri signer generate -w ~/.tauri/let-cook.key" >&2
    echo "  Then copy ~/.tauri/let-cook.key.pub to src-tauri/updater.pubkey and commit it." >&2
    exit 1
  fi
  if [[ -z "${COOK_UPDATER_PUBLIC_KEY:-}" ]]; then
    echo "ERROR: COOK_UPDATER_PUBLIC_KEY / src-tauri/updater.pubkey missing." >&2
    exit 1
  fi
  export COOK_REQUIRE_UPDATER=1
fi

echo "==> Let Cook desktop self-build v$version ($platform)"

mkdir -p "$OUT_DIR" "$DESKTOP_DIR/src-tauri/binaries"
rm -f "$OUT_DIR"/*

sidecar=0
if [[ "${COOK_DESKTOP_SKIP_SIDECAR:-}" != "1" ]]; then
  cook_bin=""
  if [[ -x "$REPO_DIR/target/release/xai-grok-pager" ]]; then
    cook_bin="$REPO_DIR/target/release/xai-grok-pager"
  elif [[ -x "${COOK_BIN:-}" ]]; then
    cook_bin="$COOK_BIN"
  elif [[ -x "$HOME/.cook/bin/cook" ]]; then
    cook_bin="$HOME/.cook/bin/cook"
  fi
  if [[ -n "$cook_bin" ]]; then
    dest="$DESKTOP_DIR/src-tauri/binaries/cook-$triple"
    cp -f "$cook_bin" "$dest"
    chmod +x "$dest"
    sidecar=1
    export COOK_DESKTOP_SIDECAR=1
    echo "==> Staged cook sidecar: $dest"
  else
    echo "==> No cook binary found; desktop will require ~/.cook/bin/cook at runtime"
  fi
fi

(cd "$DESKTOP_DIR" && pnpm install --frozen-lockfile)
(cd "$DESKTOP_DIR" && node scripts/build-release-config.mjs)

export VITE_COOK_UPDATER=1

bundle_dir="$DESKTOP_DIR/src-tauri/target/release/bundle"
tauri_args=(build --config src-tauri/tauri.release.conf.json)
case "$platform" in
  linux-x86_64)
    tauri_args+=(--bundles appimage,deb)
    ;;
  macos-aarch64|macos-x86_64)
    # --no-sign skips Apple codesign (no Developer ID). Tauri also skips
    # minisign when --no-sign is set; we re-sign updater archives below.
    tauri_args+=(--bundles dmg --no-sign)
    ;;
esac

echo "==> pnpm tauri ${tauri_args[*]}"
(cd "$DESKTOP_DIR" && pnpm tauri "${tauri_args[@]}")

sign() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    return 0
  fi
  if [[ -f "${file}.sig" && "${COOK_FORCE_RESIGN:-}" != "1" ]]; then
    return 0
  fi
  echo "==> Signing $(basename "$file")"
  (cd "$DESKTOP_DIR" && pnpm tauri signer sign "$file")
}

ensure_appimagetool() {
  if command -v appimagetool >/dev/null 2>&1; then
    return 0
  fi
  local tool_dir="${HOME}/.local/bin"
  mkdir -p "$tool_dir"
  local tool="$tool_dir/appimagetool"
  echo "==> Installing appimagetool to $tool"
  curl -fsSL -o "$tool" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$tool"
  export PATH="$tool_dir:$PATH"
}

stage() {
  local src="$1" dest_name="$2"
  cp -f "$src" "$OUT_DIR/$dest_name"
  echo "$OUT_DIR/$dest_name"
}

latest_args=(
  --version "$version"
  --base-url "${PUBLIC_BASE}/v${version}"
  --notes "Let Cook ${version}"
  --out "$OUT_DIR/latest.json"
)

merge_tmp="$(mktemp -d)"
trap 'rm -rf "$merge_tmp"' EXIT
if curl -fsSL "${PUBLIC_BASE}/latest.json" -o "$merge_tmp/latest.json" >/dev/null 2>&1; then
  latest_args+=(--merge "$merge_tmp/latest.json")
  echo "==> Merging existing latest.json from ${PUBLIC_BASE}"
fi

case "$platform" in
  linux-x86_64)
    appimage="$(find "$bundle_dir/appimage" -maxdepth 1 -type f -name '*.AppImage' ! -name '*.sig' -print -quit)"
    deb="$(find "$bundle_dir/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)"
    [[ -n "$appimage" && -n "$deb" ]] || {
      echo "ERROR: missing AppImage or deb under $bundle_dir" >&2
      find "$bundle_dir" -type f | head -50 >&2 || true
      exit 1
    }
    ensure_appimagetool
    appimage_name="let-cook-${version}-linux-x86_64.AppImage"
    deb_name="let-cook-${version}-linux-x86_64.deb"
    stage "$appimage" "$appimage_name"
    stage "$deb" "$deb_name"
    "$DESKTOP_DIR/scripts/fix-appimage.sh" "$OUT_DIR/$appimage_name"
    sign "$OUT_DIR/$deb_name"
    [[ -f "$OUT_DIR/${appimage_name}.sig" ]] || sign "$OUT_DIR/$appimage_name"
    if [[ "$require_updater" == "1" && ! -f "$OUT_DIR/${appimage_name}.sig" ]]; then
      echo "ERROR: missing AppImage signature $OUT_DIR/${appimage_name}.sig" >&2
      exit 1
    fi
    if [[ -f "$OUT_DIR/${appimage_name}.sig" ]]; then
      latest_args+=(
        --platform "linux-x86_64:$OUT_DIR/${appimage_name}.sig:$appimage_name"
        --installer "linux-appimage:$appimage_name"
      )
    fi
    if [[ -f "$OUT_DIR/${deb_name}.sig" ]]; then
      latest_args+=(--installer "linux:$OUT_DIR/${deb_name}.sig:$deb_name")
    else
      latest_args+=(--installer "linux:$deb_name")
    fi
    ;;
  macos-aarch64|macos-x86_64)
    dmg="$(find "$bundle_dir/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
    archive="$(find "$bundle_dir" -type f \( -name '*.app.tar.gz' -o -name '*_aarch64.tar.gz' -o -name '*arm64*.tar.gz' -o -name '*x64*.tar.gz' -o -name '*x86_64*.tar.gz' \) ! -name '*.sig' | head -1)"
    [[ -n "$dmg" ]] || {
      echo "ERROR: no DMG found in $bundle_dir/dmg" >&2
      find "$bundle_dir" -type f | head -50 >&2 || true
      exit 1
    }
    dmg_name="let-cook-${version}-${platform}.dmg"
    archive_name="let-cook-${version}-${platform}.app.tar.gz"
    stage "$dmg" "$dmg_name"
    if [[ -z "$archive" ]]; then
      echo "ERROR: no .app.tar.gz updater archive under $bundle_dir (createUpdaterArtifacts?)" >&2
      find "$bundle_dir" -type f | head -50 >&2 || true
      exit 1
    fi
    stage "$archive" "$archive_name"
    if [[ -f "${archive}.sig" ]]; then
      cp -f "${archive}.sig" "$OUT_DIR/${archive_name}.sig"
    fi
    sign "$OUT_DIR/$archive_name"
    if [[ "$require_updater" == "1" && ! -f "$OUT_DIR/${archive_name}.sig" ]]; then
      echo "ERROR: missing updater signature $OUT_DIR/${archive_name}.sig" >&2
      exit 1
    fi
    updater_key="darwin-aarch64"
    installer_key="mac-arm"
    if [[ "$platform" == "macos-x86_64" ]]; then
      updater_key="darwin-x86_64"
      installer_key="mac-intel"
    fi
    latest_args+=(--installer "$installer_key:$dmg_name")
    if [[ -f "$OUT_DIR/${archive_name}.sig" ]]; then
      latest_args+=(--platform "$updater_key:$OUT_DIR/${archive_name}.sig:$archive_name")
    fi
    ;;
esac

if [[ "$require_updater" == "1" ]]; then
  (cd "$DESKTOP_DIR" && node scripts/generate-latest-json.mjs "${latest_args[@]}")
else
  echo "==> Skipping latest.json (unsigned local smoke)"
fi

{
  find "$OUT_DIR" -maxdepth 1 -type f ! -name assets.list | sort
} > "$OUT_DIR/assets.list"

echo "==> Desktop artifacts in $OUT_DIR"
cat "$OUT_DIR/assets.list"
if [[ "$sidecar" == "1" ]]; then
  echo "==> Bundled cook sidecar for $triple"
fi
