#!/usr/bin/env bash
set -euo pipefail

write_home_config() {
  local home=$1 permission=$2 cap=$3 window=$4
  mkdir -p "$home"
  # Preserve MCP registration across the empty-text 8192 rewrite; agents.mcp_echo
  # re-adds the server before the first invoke only.
  local existing_mcp=""
  if [[ -f "$home/config.toml" ]]; then
    existing_mcp=$(awk '
      /^\[mcp_servers\./ { p = 1 }
      /^\[/ && !/^\[mcp_servers\./ { p = 0 }
      p { print }
    ' "$home/config.toml" || true)
    if grep -q '^disabled_mcp_servers' "$home/config.toml" 2>/dev/null; then
      existing_mcp=$(grep '^disabled_mcp_servers' "$home/config.toml")$'\n'"$existing_mcp"
    fi
  fi
  {
    if [[ "$permission" == approve ]]; then
      printf '[ui]\npermission_mode = "always-approve"\n\n'
    fi
    printf '[model."%s"]\n' "$MODEL_KEY"
    printf 'model = "%s"\nmodel_provider = "local"\nname = "real-suite %s"\n' "$WIRE" "$WIRE"
    printf 'input = ["text"]\ncontext_window = %s\nmax_completion_tokens = %s\n' "$window" "$cap"
    printf 'supports_reasoning_effort = false\nsupports_batch_api = true\n\n'
    printf '[model_providers.local]\nbase_url = "%s"\napi_key = "%s"\napi_backend = "chat_completions"\n\n' "$BASE_URL" "$API_KEY"
    printf '[privacy]\nprivacy_banner_acked = "2026-01-01T00:00:00Z"\n\n'
    printf '[consent.answers.aup]\nversion = 2\naccount = "suite@example.com"\n\n'
    printf '[consent.answers.tos]\nversion = 2\n'
    # Feature-gated tools the tools phase expects: memory backend (default off)
    # and web_fetch (Feature::WebFetch default off).
    printf '\n[memory]\nenabled = true\n'
    printf '\n[features]\nweb_fetch = true\n'
    # Public fetch case serves 127.0.0.1; SSRF still blocks private/metadata.
    printf '\n[toolset.web_fetch]\nallow_local = true\n'
    if [[ -n "$existing_mcp" ]]; then
      printf '\n%s\n' "$existing_mcp"
    fi
  } >"$home/config.toml"
  chmod 0600 "$home/config.toml"
  sed '/^api_key = /d' "$home/config.toml" >"$home/config.redacted.toml"
  chmod 0600 "$home/config.redacted.toml"
}
