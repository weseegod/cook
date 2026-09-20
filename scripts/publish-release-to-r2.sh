#!/usr/bin/env bash
# Publish Cook CLI + Let Cook desktop artifacts to Cloudflare R2.
#
# Usage:
#   scripts/publish-release-to-r2.sh --objects-only <semver> <file> [...]
#   scripts/publish-release-to-r2.sh --finalize <semver>
#
# Env: COOK_RELEASES_R2_* (GitHub secrets) or COOK_S3_* (local .env)
#   COOK_RELEASES_PUBLIC_BASE_URL   default https://download.letcook.dev
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
R2_CP=(python3 "${ROOT}/scripts/r2_cp.py")
DESKTOP_DIR="$ROOT/frontend/apps/let-cook"
PUBLIC_BASE="${COOK_RELEASES_PUBLIC_BASE_URL:-https://download.letcook.dev}"
PUBLIC_BASE="${PUBLIC_BASE%/}"

mode="full"
if [[ "${1:-}" == "--objects-only" ]]; then
  mode="objects"
  shift
elif [[ "${1:-}" == "--finalize" ]]; then
  mode="finalize"
  shift
fi

version="${1:-}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "usage: $0 [--objects-only|--finalize] <semver> [<file> ...]" >&2
  exit 1
}
shift || true
if [[ "$mode" != "finalize" && "$#" -lt 1 ]]; then
  echo "error: at least one artifact file is required" >&2
  exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
version_dir="$staging/v${version}"
mkdir -p "$version_dir"

if [[ "$mode" == "finalize" ]]; then
  echo "==> Downloading v${version}/ from R2"
  "${R2_CP[@]}" get-prefix "v${version}/" "$version_dir"
  shopt -s nullglob
  set -- "$version_dir"/*
  shopt -u nullglob
  [[ "$#" -ge 1 ]] || {
    echo "error: R2 prefix v${version}/ is empty" >&2
    exit 1
  }
fi

copy_into_version() {
  local src="$1" dest_name="$2"
  local src_abs dest_abs
  src_abs="$(cd "$(dirname "$src")" && pwd)/$(basename "$src")"
  dest_abs="$(cd "$version_dir" && pwd)/$dest_name"
  if [[ "$src_abs" != "$dest_abs" ]]; then
    cp -f "$src" "$version_dir/$dest_name"
  fi
  echo "  staged $dest_name"
}

cli_linux=""
cli_mac_arm=""
cli_mac_intel=""
cli_windows=""
appimage=""
appimage_sig=""
deb=""
deb_sig=""
dmg_arm=""
dmg_intel=""
archive_arm=""
archive_arm_sig=""
archive_intel=""
archive_intel_sig=""
nsis=""
nsis_sig=""

for file in "$@"; do
  [[ -f "$file" ]] || { echo "error: not a file: $file" >&2; exit 1; }
  [[ -s "$file" ]] || { echo "error: empty file: $file" >&2; exit 1; }
  name="$(basename "$file")"
  case "$name" in
    "cook-${version}-linux-x86_64"|"cook-${version}-linux-x86_64.sha256")
      copy_into_version "$file" "$name"
      [[ "$name" == *.sha256 ]] || cli_linux="$name"
      ;;
    "cook-${version}-macos-aarch64"|"cook-${version}-macos-aarch64.sha256")
      copy_into_version "$file" "$name"
      [[ "$name" == *.sha256 ]] || cli_mac_arm="$name"
      ;;
    "cook-${version}-macos-x86_64"|"cook-${version}-macos-x86_64.sha256")
      copy_into_version "$file" "$name"
      [[ "$name" == *.sha256 ]] || cli_mac_intel="$name"
      ;;
    "cook-${version}-windows-x86_64"|"cook-${version}-windows-x86_64.exe"|"cook-${version}-windows-x86_64.sha256")
      dest="$name"
      [[ "$name" == *.exe || "$name" == *.sha256 ]] || dest="cook-${version}-windows-x86_64"
      copy_into_version "$file" "$dest"
      [[ "$dest" == *.sha256 ]] || cli_windows="$dest"
      ;;
    "let-cook-${version}-linux-x86_64.AppImage")
      appimage="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-linux-x86_64.AppImage.sig")
      appimage_sig="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-linux-x86_64.deb")
      deb="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-linux-x86_64.deb.sig")
      deb_sig="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-macos-aarch64.dmg")
      dmg_arm="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-macos-aarch64.app.tar.gz")
      archive_arm="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-macos-aarch64.app.tar.gz.sig")
      archive_arm_sig="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-macos-x86_64.dmg")
      dmg_intel="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-macos-x86_64.app.tar.gz")
      archive_intel="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-macos-x86_64.app.tar.gz.sig")
      archive_intel_sig="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-windows-x86_64-setup.exe")
      nsis="$name"; copy_into_version "$file" "$name" ;;
    "let-cook-${version}-windows-x86_64-setup.exe.sig")
      nsis_sig="$name"; copy_into_version "$file" "$name" ;;
    latest.json|install.sh|stable|alpha|assets.list)
      echo "warning: skipping pointer/meta file in objects upload: $name" >&2
      ;;
    *)
      echo "warning: skipping unrecognized file: $name" >&2
      ;;
  esac
done

content_type_for() {
  case "$1" in
    *.dmg) echo "application/x-apple-diskimage" ;;
    *.exe) echo "application/vnd.microsoft.portable-executable" ;;
    *.deb) echo "application/vnd.debian.binary-package" ;;
    *.AppImage) echo "application/vnd.appimage" ;;
    *.tar.gz) echo "application/gzip" ;;
    *.sig|*.sha256) echo "text/plain" ;;
    *.json) echo "application/json; charset=utf-8" ;;
    *.md) echo "text/markdown; charset=utf-8" ;;
    install.sh|stable|alpha) echo "text/plain; charset=utf-8" ;;
    *) echo "application/octet-stream" ;;
  esac
}

r2_put() {
  local file="$1" key="$2"
  local ct cc
  ct="$(content_type_for "$(basename "$file")")"
  cc="${3:-public, max-age=31536000, immutable}"
  "${R2_CP[@]}" put "$file" "$key" --content-type "$ct" --cache-control "$cc"
}

upload_version_objects() {
  local f name
  echo "==> Uploading v${version}/"
  while IFS= read -r -d '' f; do
    name="$(basename "$f")"
    r2_put "$f" "v${version}/${name}"
  done < <(find "$version_dir" -type f -print0)
}

if [[ "$mode" == "objects" ]]; then
  [[ -n "$(find "$version_dir" -type f -print -quit)" ]] || {
    echo "error: no recognized release files to upload" >&2
    exit 1
  }
  upload_version_objects
  echo "Uploaded platform objects for v${version} (latest.json not flipped)"
  echo "  objects: ${PUBLIC_BASE}/v${version}/"
  exit 0
fi

if [[ "$mode" != "finalize" ]]; then
  upload_version_objects
fi

missing=()
[[ -n "$cli_linux" ]] || missing+=("cook-${version}-linux-x86_64")
[[ -n "$cli_mac_arm" ]] || missing+=("cook-${version}-macos-aarch64")
[[ -n "$cli_mac_intel" ]] || missing+=("cook-${version}-macos-x86_64")
[[ -n "$cli_windows" ]] || missing+=("cook-${version}-windows-x86_64")
[[ -n "$appimage" ]] || missing+=("let-cook-${version}-linux-x86_64.AppImage")
[[ -n "$appimage_sig" ]] || missing+=("let-cook-${version}-linux-x86_64.AppImage.sig")
[[ -n "$deb" ]] || missing+=("let-cook-${version}-linux-x86_64.deb")
[[ -n "$dmg_arm" ]] || missing+=("let-cook-${version}-macos-aarch64.dmg")
[[ -n "$archive_arm" ]] || missing+=("let-cook-${version}-macos-aarch64.app.tar.gz")
[[ -n "$archive_arm_sig" ]] || missing+=("let-cook-${version}-macos-aarch64.app.tar.gz.sig")
[[ -n "$dmg_intel" ]] || missing+=("let-cook-${version}-macos-x86_64.dmg")
[[ -n "$archive_intel" ]] || missing+=("let-cook-${version}-macos-x86_64.app.tar.gz")
[[ -n "$archive_intel_sig" ]] || missing+=("let-cook-${version}-macos-x86_64.app.tar.gz.sig")
[[ -n "$nsis" ]] || missing+=("let-cook-${version}-windows-x86_64-setup.exe")
[[ -n "$nsis_sig" ]] || missing+=("let-cook-${version}-windows-x86_64-setup.exe.sig")
if [[ "${#missing[@]}" -gt 0 ]]; then
  echo "error: incomplete release v${version}: ${missing[*]}" >&2
  exit 1
fi

latest_args=(
  --version "$version"
  --base-url "${PUBLIC_BASE}/v${version}"
  --notes "Let Cook ${version}"
  --out "$staging/latest.json"
  --platform "linux-x86_64:$version_dir/$appimage_sig:$appimage"
  --platform "darwin-aarch64:$version_dir/$archive_arm_sig:$archive_arm"
  --platform "darwin-x86_64:$version_dir/$archive_intel_sig:$archive_intel"
  --platform "windows-x86_64:$version_dir/$nsis_sig:$nsis"
  --installer "linux-appimage:$appimage"
  --installer "mac-arm:$dmg_arm"
  --installer "mac-intel:$dmg_intel"
  --installer "windows:$nsis"
)
if [[ -n "$deb_sig" ]]; then
  latest_args+=(--installer "linux:$version_dir/$deb_sig:$deb")
else
  latest_args+=(--installer "linux:$deb")
fi

(cd "$DESKTOP_DIR" && node scripts/generate-latest-json.mjs "${latest_args[@]}")

printf '%s\n' "$version" > "$staging/stable"
printf '%s\n' "$version" > "$staging/alpha"

echo "==> Flipping pointers + CLI copies at bucket root"
r2_put "$staging/latest.json" "latest.json" "public, max-age=60, must-revalidate"
r2_put "$staging/stable" "stable" "public, max-age=60, must-revalidate"
r2_put "$staging/alpha" "alpha" "public, max-age=60, must-revalidate"
r2_put "$ROOT/scripts/install.sh" "install.sh" "public, max-age=60, must-revalidate"

for cli in "$cli_linux" "$cli_mac_arm" "$cli_mac_intel" "$cli_windows"; do
  r2_put "$version_dir/$cli" "$cli"
  if [[ -f "$version_dir/${cli}.sha256" ]]; then
    r2_put "$version_dir/${cli}.sha256" "${cli}.sha256"
  fi
done

echo
echo "Published cook v${version} to R2"
echo "  latest:  ${PUBLIC_BASE}/latest.json"
echo "  cli:     ${PUBLIC_BASE}/stable"
echo "  install: ${PUBLIC_BASE}/install.sh"
echo "  objects: ${PUBLIC_BASE}/v${version}/"
echo "Verify: curl -fsS ${PUBLIC_BASE}/latest.json | head"
