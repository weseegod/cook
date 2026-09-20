#!/usr/bin/env bash
# Load Let Cook updater signing env for a self-build.
#
# Usage: source scripts/desktop-signing-env.sh
#
# Private key (never commit):
#   TAURI_SIGNING_PRIVATE_KEY        string, or
#   TAURI_SIGNING_PRIVATE_KEY_PATH   default ~/.tauri/let-cook.key
# Public key (committed at frontend/apps/let-cook/src-tauri/updater.pubkey):
#   COOK_UPDATER_PUBLIC_KEY
# Endpoint (R2 pointer the running app polls):
#   COOK_UPDATER_ENDPOINT            default
#     https://download.letcook.dev/latest.json

_cook_repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
_cook_pubkey_file="${COOK_UPDATER_PUBKEY_FILE:-$_cook_repo_dir/frontend/apps/let-cook/src-tauri/updater.pubkey}"
_cook_key_path="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/let-cook.key}"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$_cook_key_path" ]]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$_cook_key_path")"
  export TAURI_SIGNING_PRIVATE_KEY
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$_cook_key_path"
fi

if [[ -z "${COOK_UPDATER_PUBLIC_KEY:-}" && -f "$_cook_pubkey_file" ]]; then
  COOK_UPDATER_PUBLIC_KEY="$(tr -d '\r\n' < "$_cook_pubkey_file")"
  export COOK_UPDATER_PUBLIC_KEY
fi

export COOK_UPDATER_ENDPOINT="${COOK_UPDATER_ENDPOINT:-https://download.letcook.dev/latest.json}"

unset _cook_repo_dir _cook_pubkey_file _cook_key_path
