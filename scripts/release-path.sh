#!/usr/bin/env bash
# Prepend login-shell tool dirs onto GITHUB_PATH for self-hosted runners.
# bin/protoc is a DotSlash wrapper; rustup/cargo live in ~/.cargo/bin;
# node/pnpm often live under nvm.
set -euo pipefail
{
  echo "${HOME}/.cargo/bin"
  echo "${HOME}/.local/bin"
  echo "${HOME}/bin"
  if [[ -d "${HOME}/.nvm/versions/node" ]]; then
    node_dir="$(find "${HOME}/.nvm/versions/node" -maxdepth 1 -mindepth 1 -type d | sort | tail -1)"
    [[ -n "$node_dir" ]] && echo "${node_dir}/bin"
  fi
} >> "${GITHUB_PATH:?}"
