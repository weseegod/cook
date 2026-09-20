#!/usr/bin/env bash
# Build Cook CLI + Let Cook desktop for one release platform.
# Used by .github/workflows/release.yml on self-hosted runners.
#
# Usage:
#   scripts/release-platform.sh linux|macos-arm|macos-x64|windows
#
# Writes renamed, signed artifacts to $COOK_RELEASE_OUT (default ./release-artifacts).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_DIR="$ROOT/frontend/apps/let-cook"
OUT="${COOK_RELEASE_OUT:-$ROOT/release-artifacts}"
VERSION="${VERSION:-}"

platform_arg="${1:-}"
case "$platform_arg" in
  linux)
    host_ok="Linux-x86_64"; cli_triple=""; desktop_target=""
    cli_name_os=linux; cli_name_arch=x86_64
    rust_target="x86_64-unknown-linux-gnu"
    sidecar_triple="x86_64-unknown-linux-gnu"
    ;;
  macos-arm)
    host_ok="Darwin-arm64"; cli_triple=""; desktop_target=""
    cli_name_os=macos; cli_name_arch=aarch64
    rust_target="aarch64-apple-darwin"
    sidecar_triple="aarch64-apple-darwin"
    ;;
  macos-x64)
    host_ok="Darwin-arm64"; cli_triple="x86_64-apple-darwin"; desktop_target="x86_64-apple-darwin"
    cli_name_os=macos; cli_name_arch=x86_64
    rust_target="x86_64-apple-darwin"
    sidecar_triple="x86_64-apple-darwin"
    ;;
  windows)
    host_ok="Linux-x86_64"; cli_triple="x86_64-pc-windows-msvc"; desktop_target="x86_64-pc-windows-msvc"
    cli_name_os=windows; cli_name_arch=x86_64
    rust_target="x86_64-pc-windows-msvc"
    sidecar_triple="x86_64-pc-windows-msvc"
    ;;
  *)
    echo "usage: $0 linux|macos-arm|macos-x64|windows" >&2
    exit 1
    ;;
esac

os="$(uname -s)"; arch="$(uname -m)"
case "$os-$arch" in
  Darwin-aarch64) arch=arm64 ;;
esac
if [[ "$platform_arg" == "macos-x64" ]]; then
  [[ "$os" == "Darwin" ]] || { echo "error: macos-x64 cross must run on macOS" >&2; exit 1; }
elif [[ "$platform_arg" == "windows" ]]; then
  [[ "$os" == "Linux" ]] || { echo "error: windows cross must run on Linux" >&2; exit 1; }
else
  [[ "$os-$arch" == "$host_ok" || "$os-$arch" == "${host_ok/arm64/aarch64}" ]] || {
    echo "error: $platform_arg expected host $host_ok (got $os-$arch)" >&2
    exit 1
  }
fi

# shellcheck source=desktop-signing-env.sh
source "$ROOT/scripts/desktop-signing-env.sh"

if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('$DESKTOP_DIR/package.json').version")"
fi
if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "error: invalid VERSION='$VERSION'" >&2
  exit 1
fi
pkg_ver="$(node -p "require('$DESKTOP_DIR/package.json').version")"
[[ "$pkg_ver" == "$VERSION" ]] || {
  echo "error: package.json is $pkg_ver, tag version is $VERSION" >&2
  exit 1
}

export COOK_REQUIRE_UPDATER="${COOK_REQUIRE_UPDATER:-1}"
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" || -z "${COOK_UPDATER_PUBLIC_KEY:-}" ]]; then
  echo "error: TAURI_SIGNING_PRIVATE_KEY and COOK_UPDATER_PUBLIC_KEY are required" >&2
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"
if [[ -x "$ROOT/bin/protoc" ]]; then
  export PROTOC="$ROOT/bin/protoc"
  export PATH="$ROOT/bin:$PATH"
fi

mkdir -p "$OUT" "$DESKTOP_DIR/src-tauri/binaries"
rm -rf "${OUT:?}/"*

echo "==> CLI cook $VERSION ($platform_arg / $rust_target)"
cli_args=(build -p xai-grok-pager-bin --release)
if [[ -n "$cli_triple" ]]; then
  rustup target add "$cli_triple"
  cli_args+=(--target "$cli_triple")
fi
if [[ "$platform_arg" == "windows" ]]; then
  cli_args+=(--no-default-features --features sandbox-enforce)
fi
(cd "$ROOT" && cargo "${cli_args[@]}")

if [[ -n "$cli_triple" ]]; then
  cli_bin="$ROOT/target/${cli_triple}/release/xai-grok-pager"
  [[ "$platform_arg" == "windows" ]] && cli_bin="${cli_bin}.exe"
else
  cli_bin="$ROOT/target/release/xai-grok-pager"
fi
[[ -f "$cli_bin" ]] || { echo "error: missing CLI binary $cli_bin" >&2; exit 1; }

cli_asset="cook-${VERSION}-${cli_name_os}-${cli_name_arch}"
cp -f "$cli_bin" "$OUT/$cli_asset"
chmod +x "$OUT/$cli_asset" || true
(cd "$OUT" && shasum -a 256 "$cli_asset" > "${cli_asset}.sha256")

sidecar="$DESKTOP_DIR/src-tauri/binaries/cook-${sidecar_triple}"
[[ "$platform_arg" == "windows" ]] && sidecar="${sidecar}.exe"
cp -f "$cli_bin" "$sidecar"
chmod +x "$sidecar" || true
export COOK_DESKTOP_SIDECAR=1
export VITE_COOK_UPDATER=1

echo "==> Desktop Let Cook $VERSION"
(cd "$DESKTOP_DIR" && pnpm install --frozen-lockfile)
(cd "$DESKTOP_DIR" && node scripts/build-release-config.mjs)

bundle_dir="$DESKTOP_DIR/src-tauri/target/release/bundle"
tauri_args=(build --config src-tauri/tauri.release.conf.json)
if [[ -n "$desktop_target" ]]; then
  tauri_args+=(--target "$desktop_target")
  bundle_dir="$DESKTOP_DIR/src-tauri/target/${desktop_target}/release/bundle"
fi
case "$platform_arg" in
  linux) tauri_args+=(--bundles appimage,deb) ;;
  macos-arm|macos-x64) tauri_args+=(--bundles dmg --no-sign) ;;
  windows) tauri_args+=(--bundles nsis) ;;
esac
(cd "$DESKTOP_DIR" && pnpm tauri "${tauri_args[@]}")

sign() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  echo "==> Signing $(basename "$file")"
  (cd "$DESKTOP_DIR" && pnpm tauri signer sign "$file")
}

ensure_appimagetool() {
  command -v appimagetool >/dev/null 2>&1 && return 0
  local tool_dir="${HOME}/.local/bin"
  mkdir -p "$tool_dir"
  curl -fsSL -o "$tool_dir/appimagetool" \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x "$tool_dir/appimagetool"
  export PATH="$tool_dir:$PATH"
}

case "$platform_arg" in
  linux)
    ensure_appimagetool
    appimage="$(find "$bundle_dir/appimage" -maxdepth 1 -type f -name '*.AppImage' ! -name '*.sig' -print -quit)"
    deb="$(find "$bundle_dir/deb" -maxdepth 1 -type f -name '*.deb' -print -quit)"
    [[ -n "$appimage" && -n "$deb" ]] || { echo "error: missing AppImage/deb" >&2; exit 1; }
    cp -f "$appimage" "$OUT/let-cook-${VERSION}-linux-x86_64.AppImage"
    cp -f "$deb" "$OUT/let-cook-${VERSION}-linux-x86_64.deb"
    "$DESKTOP_DIR/scripts/fix-appimage.sh" "$OUT/let-cook-${VERSION}-linux-x86_64.AppImage"
    sign "$OUT/let-cook-${VERSION}-linux-x86_64.deb"
    [[ -f "$OUT/let-cook-${VERSION}-linux-x86_64.AppImage.sig" ]] || \
      sign "$OUT/let-cook-${VERSION}-linux-x86_64.AppImage"
    ;;
  macos-arm|macos-x64)
    plat="macos-aarch64"
    [[ "$platform_arg" == "macos-x64" ]] && plat="macos-x86_64"
    dmg="$(find "$bundle_dir/dmg" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
    archive="$(find "$bundle_dir" -type f \( -name '*.app.tar.gz' \) ! -name '*.sig' | head -1)"
    [[ -n "$dmg" && -n "$archive" ]] || { echo "error: missing dmg/app.tar.gz under $bundle_dir" >&2; find "$bundle_dir" -type f | head -40; exit 1; }
    cp -f "$dmg" "$OUT/let-cook-${VERSION}-${plat}.dmg"
    cp -f "$archive" "$OUT/let-cook-${VERSION}-${plat}.app.tar.gz"
    [[ -f "${archive}.sig" ]] && cp -f "${archive}.sig" "$OUT/let-cook-${VERSION}-${plat}.app.tar.gz.sig"
    [[ -f "$OUT/let-cook-${VERSION}-${plat}.app.tar.gz.sig" ]] || \
      sign "$OUT/let-cook-${VERSION}-${plat}.app.tar.gz"
    ;;
  windows)
    exe="$(find "$bundle_dir/nsis" -name '*.exe' -type f ! -name '*.sig' | head -1)"
    [[ -n "$exe" ]] || { echo "error: missing NSIS exe" >&2; find "$bundle_dir" -type f | head -40; exit 1; }
    cp -f "$exe" "$OUT/let-cook-${VERSION}-windows-x86_64-setup.exe"
    if [[ -f "${exe}.sig" ]]; then
      cp -f "${exe}.sig" "$OUT/let-cook-${VERSION}-windows-x86_64-setup.exe.sig"
    else
      sign "$OUT/let-cook-${VERSION}-windows-x86_64-setup.exe"
    fi
    ;;
esac

echo "==> Artifacts"
ls -la "$OUT"
