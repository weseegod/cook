#!/usr/bin/env bash
# Cook 1-click install: CLI (`cook`) + Let Cook desktop.
# Landing / download host:
#   curl -fsSL https://download.letcook.dev/install.sh | bash
# Install only the CLI on macOS/Linux:
#   curl -fsSL https://download.letcook.dev/install.sh | CLI_ONLY=1 bash
# Install only Let Cook Desktop on macOS/Linux:
#   curl -fsSL https://download.letcook.dev/install.sh | DESKTOP_ONLY=1 bash
# Later same-origin from the site:
#   curl -fsSL https://letcook.dev/install.sh | bash
set -euo pipefail

INSTALL_ORIGIN="${COOK_INSTALL_ORIGIN:-@COOK_INSTALL_ORIGIN@}"
if [[ "${INSTALL_ORIGIN}" == *"@"* || -z "${INSTALL_ORIGIN}" ]]; then
  INSTALL_ORIGIN="https://download.letcook.dev"
fi
INSTALL_ORIGIN="${INSTALL_ORIGIN%/}"
LATEST_URL="${COOK_LATEST_URL:-${INSTALL_ORIGIN}/latest.json}"
STABLE_URL="${COOK_STABLE_URL:-${INSTALL_ORIGIN}/stable}"

os="${COOK_INSTALL_UNAME:-$(uname -s)}"
arch="${COOK_INSTALL_ARCH:-$(uname -m)}"
dry_run="${COOK_INSTALL_DRY_RUN:-0}"
skip_desktop="${CLI_ONLY:-${COOK_INSTALL_CLI_ONLY:-0}}"
skip_cli="${DESKTOP_ONLY:-${COOK_INSTALL_DESKTOP_ONLY:-0}}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: python3 is required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 1
fi

case "$os-$arch" in
  Linux-x86_64|Linux-amd64) cli_plat="linux-x86_64" ;;
  Darwin-arm64|Darwin-aarch64) cli_plat="macos-aarch64" ;;
  Darwin-x86_64) cli_plat="macos-x86_64" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT-*|Windows-*)
    echo "error: this curl installer is for macOS and Linux." >&2
    echo "On Windows, download Let Cook from ${INSTALL_ORIGIN} (let-cook-*-windows-x86_64-setup.exe)." >&2
    echo "The cook CLI is the matching cook-*-windows-x86_64 asset." >&2
    exit 1
    ;;
  *)
    echo "error: this installer supports Linux x86_64 and macOS (Apple Silicon + Intel). Got $os/$arch" >&2
    exit 1
    ;;
esac

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cook-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

echo "==> Cook: reading ${STABLE_URL}"
curl -fsSL "$STABLE_URL" -o "$tmp/stable"
version="$(tr -d '[:space:]' < "$tmp/stable")"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: invalid stable pointer: $version" >&2
  exit 1
fi

if [[ "$skip_cli" != "1" ]]; then
  cli_url="${INSTALL_ORIGIN}/cook-${version}-${cli_plat}"
  echo "==> Installing cook CLI v${version} (${cli_plat})"
  if [[ "$dry_run" == "1" ]]; then
    echo "dry-run: would download ${cli_url}"
  else
    curl -fL --progress-bar "$cli_url" -o "$tmp/cook"
    chmod +x "$tmp/cook"
    if ! "$tmp/cook" --version >/dev/null 2>&1; then
      echo "error: downloaded cook failed --version" >&2
      exit 1
    fi
    grok_home="${GROK_HOME:-${COOK_HOME:-$HOME/.cook}}"
    bin_dir="$grok_home/bin"
    path_dir="${INSTALL_DIR:-$HOME/.local/bin}"
    mkdir -p "$bin_dir" "$path_dir"
    install -m 755 "$tmp/cook" "$bin_dir/cook"
    ln -sfn "$bin_dir/cook" "$path_dir/cook"
    echo "cook ${version} -> $path_dir/cook"
  fi
fi

if [[ "$skip_desktop" == "1" ]]; then
  exit 0
fi

echo "==> Let Cook: reading ${LATEST_URL}"
curl -fsSL "$LATEST_URL" -o "$tmp/latest.json"

resolved="$(
  python3 -c '
import json, sys
osname, arch, path = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(open(path, encoding="utf-8"))
installers = data.get("installers") or {}
platforms = data.get("platforms") or {}
version = data.get("version") if isinstance(data.get("version"), str) else ""

def https(url):
    return isinstance(url, str) and url.startswith("https://")

def installer_url(key):
    entry = installers.get(key) or {}
    return entry.get("url") if isinstance(entry, dict) else None

def platform_url(key):
    entry = platforms.get(key) or {}
    return entry.get("url") if isinstance(entry, dict) else None

kind = url = None
if osname == "Darwin":
    key = "darwin-aarch64" if arch in ("arm64", "aarch64") else "darwin-x86_64" if arch in ("x86_64", "amd64") else None
    if key:
        url = platform_url(key)
        kind = "app.tar.gz"
elif osname == "Linux":
    if arch not in ("x86_64", "amd64"):
        raise SystemExit("this Linux installer is amd64 only (got %s)" % arch)
    url = installer_url("linux")
    kind = "deb"
    if not https(url):
        url = installer_url("linux-appimage") or platform_url("linux-x86_64")
        kind = "appimage"
else:
    raise SystemExit("this installer supports macOS and Linux (got %s)" % osname)

if not https(url) or not kind:
    raise SystemExit("no desktop installer for %s/%s in latest.json" % (osname, arch))
print(kind)
print(url)
print(version)
' "$os" "$arch" "$tmp/latest.json"
)"

kind="$(printf '%s\n' "$resolved" | sed -n '1p')"
url="$(printf '%s\n' "$resolved" | sed -n '2p')"
desk_version="$(printf '%s\n' "$resolved" | sed -n '3p')"
if [[ -z "$kind" || -z "$url" ]]; then
  echo "error: could not resolve a desktop installer URL" >&2
  exit 1
fi

echo "==> Downloading ${url}"
case "$kind" in
  app.tar.gz)
    archive="$tmp/let-cook.app.tar.gz"
    curl -fL --progress-bar "$url" -o "$archive"
    mkdir -p "$tmp/extract"
    tar -xzf "$archive" -C "$tmp/extract"
    app="$(find "$tmp/extract" -name "Let Cook.app" -o -name "LetCook.app" -o -name "*.app" -type d | head -1)"
    if [[ -z "$app" ]]; then
      echo "error: Let Cook.app not found in archive" >&2
      exit 1
    fi
    dest="/Applications/Let Cook.app"
    echo "==> Installing ${dest}"
    if [[ "$dry_run" == "1" ]]; then
      echo "dry-run: would install ${app} -> ${dest}"
      exit 0
    fi
    rm -rf "$dest"
    ditto "$app" "$dest"
    xattr -cr "$dest" 2>/dev/null || true
    open "$dest"
    echo "Let Cook is installed in ${dest}."
    ;;
  deb)
    pkg="$tmp/let-cook.deb"
    curl -fL --progress-bar "$url" -o "$pkg"
    echo "==> Installing $(basename "$pkg") (sudo)"
    if [[ "$dry_run" == "1" ]]; then
      echo "dry-run: would sudo dpkg -i ${pkg}"
      exit 0
    fi
    if ! sudo dpkg -i "$pkg"; then
      sudo apt-get install -f -y
    fi
    echo "Let Cook ${desk_version} is installed. Open it from the app menu, or run: let-cook"
    ;;
  appimage)
    dest="${HOME}/.local/bin/let-cook"
    echo "==> Installing ${dest}"
    if [[ "$dry_run" == "1" ]]; then
      echo "dry-run: would install AppImage -> ${dest}"
      exit 0
    fi
    mkdir -p "$(dirname "$dest")"
    curl -fL --progress-bar "$url" -o "$dest"
    chmod +x "$dest"
    echo "Let Cook ${desk_version} AppImage is at ${dest}"
    ;;
  *)
    echo "error: unknown installer kind: ${kind}" >&2
    exit 1
    ;;
esac
