#!/usr/bin/env bash
# fix-appimage.sh — Remove infra libs from a Tauri-produced AppImage that crash
# on Mesa 25+ / GLib 2.88 distros (Ubuntu 26.04, Fedora 42+, etc.).
#
# Usage: fix-appimage.sh <path-to.AppImage>
#
# Set TAURI_SIGNING_PRIVATE_KEY / TAURI_SIGNING_PRIVATE_KEY_PASSWORD to
# re-sign after repacking (release builds). Without them the script
# repacks but skips signing, which is fine for local testing.
#
# Set APPIMAGETOOL_RUNTIME_FILE to a pre-downloaded AppImage type2 runtime to
# avoid appimagetool fetching one from its mutable `continuous` tag.
#
# Ported from quac/apps/desktop/scripts/fix-appimage.sh. Root cause is
# upstream: https://github.com/tauri-apps/tauri/issues/15665

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: fix-appimage.sh <path-to.AppImage>" >&2
  exit 1
fi

if [[ ! -f "$1" ]]; then
  echo "Error: file not found: $1" >&2
  exit 1
fi

APPIMAGE_ABS="$(realpath "$1")"
APPIMAGE_DIR="$(dirname "$APPIMAGE_ABS")"
APPIMAGE_NAME="$(basename "$APPIMAGE_ABS")"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "==> Extracting $APPIMAGE_NAME"
(cd "$WORKDIR" && APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGE_ABS" --appimage-extract)

LIBDIR="$WORKDIR/squashfs-root/usr/lib"

if ! compgen -G "$LIBDIR/libwayland-client.so*" > /dev/null; then
  echo "Error: libwayland-client not found in $LIBDIR — bundler layout changed; update fix-appimage.sh" >&2
  exit 1
fi

echo "==> Removing infra libs that conflict with system Mesa / GLib / GStreamer / systemd"
rm -f \
  "$LIBDIR"/libwayland-client.so* \
  "$LIBDIR"/libwayland-cursor.so* \
  "$LIBDIR"/libwayland-egl.so* \
  "$LIBDIR"/libwayland-server.so* \
  "$LIBDIR"/libglib-2.0.so* \
  "$LIBDIR"/libgio-2.0.so* \
  "$LIBDIR"/libgobject-2.0.so* \
  "$LIBDIR"/libgmodule-2.0.so* \
  "$LIBDIR"/libmount.so* \
  "$LIBDIR"/libblkid.so* \
  "$LIBDIR"/libselinux.so* \
  "$LIBDIR"/libsystemd.so* \
  "$LIBDIR"/libpcre2-8.so* \
  "$LIBDIR"/libgst*.so* \
  "$LIBDIR"/libzstd.so* \
  "$LIBDIR"/libelf.so* \
  "$LIBDIR"/libffi.so*

echo "==> Installing GStreamer launcher shim on the app binary"
APPRUN_WRAPPED="$WORKDIR/squashfs-root/AppRun.wrapped"
if ! grep -aq "GST_PLUGIN_SYSTEM_PATH_1_0" "$APPRUN_WRAPPED"; then
  echo "Error: AppRun.wrapped is missing or no longer references GST_PLUGIN_SYSTEM_PATH_1_0 — GStreamer path injection changed; re-verify fix-appimage.sh" >&2
  exit 1
fi

APP_BIN=""
APP_BIN_NAME=""
for candidate in let-cook "Let Cook"; do
  if [[ -f "$WORKDIR/squashfs-root/usr/bin/$candidate" ]]; then
    APP_BIN="$WORKDIR/squashfs-root/usr/bin/$candidate"
    APP_BIN_NAME="$candidate"
    break
  fi
done
if [[ -z "$APP_BIN" ]]; then
  echo "Error: app binary usr/bin/let-cook not found — bundler layout changed; update fix-appimage.sh" >&2
  exit 1
fi
if [[ -e "$APP_BIN.bin" ]]; then
  echo "Error: usr/bin/${APP_BIN_NAME}.bin already exists — shim already installed?" >&2
  exit 1
fi

mv "$APP_BIN" "$APP_BIN.bin"
cat > "$APP_BIN" <<SHIM
#!/usr/bin/env bash
# GStreamer shim installed by scripts/fix-appimage.sh.
here="\$(dirname "\$(readlink -f "\$0")")"
appdir="\$(readlink -f "\$here/../..")"
for var in GST_PLUGIN_SYSTEM_PATH_1_0 GST_PLUGIN_SYSTEM_PATH \\
           GST_PLUGIN_PATH_1_0 GST_PLUGIN_PATH \\
           GST_PLUGIN_SCANNER GST_PLUGIN_SCANNER_1_0; do
  val="\${!var-}"
  if [[ -n "\$val" && "\$val" == *"\$appdir/"* ]]; then
    unset "\$var"
  fi
done
exec -a "${APP_BIN_NAME}" "\$here/${APP_BIN_NAME}.bin" "\$@"
SHIM
chmod +x "$APP_BIN"

echo "==> Repacking AppImage"
if ! command -v appimagetool >/dev/null 2>&1; then
  echo "Error: appimagetool is required to repack the AppImage" >&2
  exit 1
fi
RUNTIME_ARGS=()
if [[ -n "${APPIMAGETOOL_RUNTIME_FILE:-}" ]]; then
  RUNTIME_ARGS=(--runtime-file "$APPIMAGETOOL_RUNTIME_FILE")
fi
APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$(uname -m)" appimagetool \
  "${RUNTIME_ARGS[@]}" \
  "$WORKDIR/squashfs-root" "$APPIMAGE_ABS"

if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "==> Re-signing AppImage"
  (cd "$DESKTOP_DIR" && pnpm tauri signer sign "$APPIMAGE_ABS")

  TARBALL="$APPIMAGE_ABS.tar.gz"
  if [[ -f "$TARBALL" ]]; then
    echo "==> Recreating updater archive $TARBALL"
    tar -czf "$TARBALL" -C "$APPIMAGE_DIR" "$APPIMAGE_NAME"
    echo "==> Re-signing updater archive"
    (cd "$DESKTOP_DIR" && pnpm tauri signer sign "$TARBALL")
  fi
else
  echo "==> TAURI_SIGNING_PRIVATE_KEY not set — skipping signing (local build)"
fi

echo "==> Done: $APPIMAGE_ABS"
