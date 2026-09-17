#!/usr/bin/env bash
# Install a released Thanh Desktop shell without modifying the Thanh CLI.
#
# Usage:
#   bash install.sh 1.0.32
#   curl -fsSL https://github.com/weseegod/thanh/raw/main/frontend/apps/thanh-desktop/scripts/install.sh | bash -s 1.0.32
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._]+)?$ ]]; then
  echo "Usage: install.sh X.Y.Z" >&2
  exit 1
fi

# The shared installer security harness supplies these variables. Desktop does
# not consume deployment config, but validates and probes the authenticated
# endpoint so credentials can never be attached to cleartext/userinfo URLs.
if [ -n "${GROK_DEPLOYMENT_KEY:-}" ]; then
  proxy_url="${GROK_PROXY_URL:-https://cli-chat-proxy.grok.com/v1}"
  proxy_authority="${proxy_url#*://}"
  proxy_authority="${proxy_authority%%[/?#]*}"
  proxy_ok=
  case "$proxy_url" in
    [hH][tT][tT][pP][sS]://*)
      case "$proxy_authority" in ""|*@*) ;; *) proxy_ok=1 ;; esac
      ;;
  esac
  if [ -z "$proxy_ok" ]; then
    echo "Error: GROK_PROXY_URL must be an https:// URL." >&2
    exit 1
  fi
  header_file="$(mktemp)"
  trap 'rm -f "${header_file:-}" "${download_tmp:-}"' EXIT
  chmod 600 "$header_file"
  printf 'Authorization: Bearer %s\n' "$GROK_DEPLOYMENT_KEY" > "$header_file"
  curl -fsSL --proto '=https' -H "@$header_file" "${proxy_url}/deployment/config" >/dev/null 2>&1 || true
  : > "$header_file"
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) platform="linux-x86_64"; extension="AppImage" ;;
  Darwin-arm64|Darwin-aarch64) platform="macos-aarch64"; extension="dmg" ;;
  *) echo "Thanh Desktop v1 supports Linux x86_64 and macOS aarch64." >&2; exit 1 ;;
esac

repo="${THANH_GITHUB_REPO:-weseegod/thanh}"
asset="thanh-desktop-${version}-${platform}.${extension}"
url="https://github.com/${repo}/releases/download/v${version}/${asset}"
download_dir="${THANH_DESKTOP_DOWNLOAD_DIR:-$HOME/.thanh/desktop}"
mkdir -p "$download_dir"
download_tmp="$download_dir/.${asset}.tmp.$$"
trap 'rm -f "${header_file:-}" "${download_tmp:-}"' EXIT

echo "Downloading $asset…" >&2
curl -fL --retry 3 -o "$download_tmp" "$url"
[ -s "$download_tmp" ] || { echo "Downloaded artifact is empty." >&2; exit 1; }

if [ "$extension" = "dmg" ]; then
  final="$download_dir/$asset"
  mv -f "$download_tmp" "$final"
  echo "Downloaded $final. Open the DMG and drag Thanh Desktop to Applications." >&2
  exit 0
fi

chmod +x "$download_tmp"
if ! "$download_tmp" --appimage-version >/dev/null 2>&1; then
  echo "Downloaded AppImage failed its executable check; existing install was kept." >&2
  exit 1
fi
final="$download_dir/$asset"
mv -f "$download_tmp" "$final"
bin_dir="${THANH_DESKTOP_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
ln -sfn "$final" "$bin_dir/thanh-desktop"
echo "Installed Thanh Desktop to $final" >&2
echo "Launcher: $bin_dir/thanh-desktop" >&2
