#!/usr/bin/env bash
# Bump the lockstepped Cook + Let Cook version, commit, tag, and push.
# GitHub Actions (tag `v*`) builds four platforms and publishes to R2:
#   https://download.letcook.dev
#
# Usage:
#   scripts/publish_release.sh            # bump patch: 1.0.0 -> 1.0.1
#   scripts/publish_release.sh 1.1.0      # explicit version
#
# Do not build locally. The self-hosted runners (same as quac) do that.
# See docs/desktop-release.md.
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
REPO="weseegod/cook"

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

echo "==> Pushing main + tag v$new (Actions builds 4 platforms → R2)"
git push origin main
git push origin "v$new"

echo "==> Tagged v$new. Watch: gh run watch --repo $REPO"
echo "    Install: curl -fsSL https://download.letcook.dev/install.sh | bash"
echo "    CLI feed: https://download.letcook.dev/stable"
echo "    Desktop:  https://download.letcook.dev/latest.json"
