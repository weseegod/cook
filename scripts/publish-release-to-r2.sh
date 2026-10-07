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

# Classify a release artifact basename into the slot variables below.
# When stage_src is set, also copy the local file into version_dir.
classify_artifact() {
  local name="$1"
  local stage_src="${2:-}"
  local dest="$name"
  stage_if_needed() {
    if [[ -n "$stage_src" ]]; then
      copy_into_version "$stage_src" "$1"
    fi
  }
  case "$name" in
    "cook-${version}-linux-x86_64"|"cook-${version}-linux-x86_64.sha256")
      stage_if_needed "$name"
      [[ "$name" == *.sha256 ]] || cli_linux="$name"
      ;;
    "cook-${version}-macos-aarch64"|"cook-${version}-macos-aarch64.sha256")
      stage_if_needed "$name"
      [[ "$name" == *.sha256 ]] || cli_mac_arm="$name"
      ;;
    "cook-${version}-macos-x86_64"|"cook-${version}-macos-x86_64.sha256")
      stage_if_needed "$name"
      [[ "$name" == *.sha256 ]] || cli_mac_intel="$name"
      ;;
    "cook-${version}-windows-x86_64"|"cook-${version}-windows-x86_64.exe"|"cook-${version}-windows-x86_64.sha256")
      [[ "$name" == *.exe || "$name" == *.sha256 ]] || dest="cook-${version}-windows-x86_64"
      stage_if_needed "$dest"
      [[ "$dest" == *.sha256 ]] || cli_windows="$dest"
      ;;
    "let-cook-${version}-linux-x86_64.AppImage")
      appimage="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-linux-x86_64.AppImage.sig")
      appimage_sig="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-linux-x86_64.deb")
      deb="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-linux-x86_64.deb.sig")
      deb_sig="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-macos-aarch64.dmg")
      dmg_arm="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-macos-aarch64.app.tar.gz")
      archive_arm="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-macos-aarch64.app.tar.gz.sig")
      archive_arm_sig="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-macos-x86_64.dmg")
      dmg_intel="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-macos-x86_64.app.tar.gz")
      archive_intel="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-macos-x86_64.app.tar.gz.sig")
      archive_intel_sig="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-windows-x86_64-setup.exe")
      nsis="$name"; stage_if_needed "$name" ;;
    "let-cook-${version}-windows-x86_64-setup.exe.sig")
      nsis_sig="$name"; stage_if_needed "$name" ;;
    latest.json|install.sh|stable|alpha|assets.list)
      echo "warning: skipping pointer/meta file: $name" >&2
      ;;
    *)
      echo "warning: skipping unrecognized file: $name" >&2
      ;;
  esac
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
# Newline-separated basenames from R2 (finalize). Avoid `declare -A` — macOS
# Actions runners use /bin/bash 3.2 which has no associative arrays.
remote_names=""

remote_has() {
  case $'\n'"${remote_names}" in
    *$'\n'"$1"$'\n'*) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ "$mode" == "finalize" ]]; then
  # Do not download the whole version prefix (GB of installers). List keys and
  # pull only tiny .sig files for latest.json.
  echo "==> Listing v${version}/ on R2"
  # Avoid `mapfile` (bash 4+); macOS ships bash 3.2 as /bin/bash.
  remote_keys=()
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    remote_keys+=("$key")
  done < <("${R2_CP[@]}" list "v${version}/")
  [[ "${#remote_keys[@]}" -ge 1 ]] || {
    echo "error: R2 prefix v${version}/ is empty" >&2
    exit 1
  }
  echo "==> Fetching signatures for latest.json"
  for key in "${remote_keys[@]}"; do
    [[ "$key" == */ ]] && continue
    name="$(basename "$key")"
    remote_names="${remote_names}${name}"$'\n'
    classify_artifact "$name"
    if [[ "$name" == *.sig ]]; then
      echo "  fetching $name"
      "${R2_CP[@]}" get "$key" "$version_dir/$name"
    fi
  done
else
  for file in "$@"; do
    [[ -f "$file" ]] || { echo "error: not a file: $file" >&2; exit 1; }
    [[ -s "$file" ]] || { echo "error: empty file: $file" >&2; exit 1; }
    classify_artifact "$(basename "$file")" "$file"
  done
fi

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

r2_copy() {
  local src_key="$1" dest_key="$2"
  local ct cc
  ct="$(content_type_for "$(basename "$dest_key")")"
  cc="${3:-public, max-age=31536000, immutable}"
  "${R2_CP[@]}" copy "$src_key" "$dest_key" --content-type "$ct" --cache-control "$cc"
}

upload_version_objects() {
  local f name
  echo "==> Uploading v${version}/"
  while IFS= read -r -d '' f; do
    name="$(basename "$f")"
    r2_put "$f" "v${version}/${name}"
  done < <(find "$version_dir" -type f -print0)
}

pack_skills() {
  echo "==> Packing skills/"
  if [[ ! -f "$ROOT/skills/default-skills.toml" ]]; then
    echo "error: missing skills/default-skills.toml" >&2
    exit 1
  fi
  # Top-level archive entries are the skill directories and default-skills.toml.
  tar -C "$ROOT/skills" -czf "$version_dir/skills.tar.gz" .
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
  pack_skills
  upload_version_objects
fi

# Required platforms for the current release matrix: Linux + Apple Silicon.
# macOS Intel and Windows jobs are disabled in .github/workflows/release.yml;
# their artifacts remain optional when present.
missing=()
[[ -n "$cli_linux" ]] || missing+=("cook-${version}-linux-x86_64")
[[ -n "$cli_mac_arm" ]] || missing+=("cook-${version}-macos-aarch64")
[[ -n "$appimage" ]] || missing+=("let-cook-${version}-linux-x86_64.AppImage")
[[ -n "$appimage_sig" ]] || missing+=("let-cook-${version}-linux-x86_64.AppImage.sig")
[[ -n "$deb" ]] || missing+=("let-cook-${version}-linux-x86_64.deb")
[[ -n "$dmg_arm" ]] || missing+=("let-cook-${version}-macos-aarch64.dmg")
[[ -n "$archive_arm" ]] || missing+=("let-cook-${version}-macos-aarch64.app.tar.gz")
[[ -n "$archive_arm_sig" ]] || missing+=("let-cook-${version}-macos-aarch64.app.tar.gz.sig")
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
  --installer "linux-appimage:$appimage"
  --installer "mac-arm:$dmg_arm"
)
if [[ -n "$archive_intel" && -n "$archive_intel_sig" ]]; then
  latest_args+=(--platform "darwin-x86_64:$version_dir/$archive_intel_sig:$archive_intel")
fi
if [[ -n "$nsis" && -n "$nsis_sig" ]]; then
  latest_args+=(--platform "windows-x86_64:$version_dir/$nsis_sig:$nsis")
fi
if [[ -n "$dmg_intel" ]]; then
  latest_args+=(--installer "mac-intel:$dmg_intel")
fi
if [[ -n "$nsis" ]]; then
  latest_args+=(--installer "windows:$nsis")
fi
if [[ -n "$deb_sig" ]]; then
  latest_args+=(--installer "linux:$version_dir/$deb_sig:$deb")
else
  latest_args+=(--installer "linux:$deb")
fi

(cd "$DESKTOP_DIR" && node scripts/generate-latest-json.mjs "${latest_args[@]}")

printf '%s\n' "$version" > "$staging/stable"
printf '%s\n' "$version" > "$staging/alpha"

echo "==> Flipping release pointers at bucket root"
r2_put "$staging/latest.json" "latest.json" "public, max-age=60, must-revalidate"
r2_put "$staging/stable" "stable" "public, max-age=60, must-revalidate"
r2_put "$staging/alpha" "alpha" "public, max-age=60, must-revalidate"
r2_put "$ROOT/scripts/install.sh" "install.sh" "public, max-age=60, must-revalidate"
# Publish the skills archive once at finalize (platform jobs use --objects-only).
if [[ "$mode" == "finalize" ]]; then
  pack_skills
  r2_put "$version_dir/skills.tar.gz" "v${version}/skills.tar.gz"
fi

echo
echo "Published cook v${version} to R2"
echo "  latest:  ${PUBLIC_BASE}/latest.json"
echo "  stable:  ${PUBLIC_BASE}/stable"
echo "  install: ${PUBLIC_BASE}/install.sh"
echo "  release: ${PUBLIC_BASE}/v${version}/"
echo "Verify: curl -fsS ${PUBLIC_BASE}/latest.json | head"
