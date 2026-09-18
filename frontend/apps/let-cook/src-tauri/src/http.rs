//! One shared HTTP client for provider probes.
//!
//! Providers are probed by the native process, never the renderer: the webview would need the
//! provider's own CORS headers, and the credential only ever exists here.

use std::sync::OnceLock;
use std::time::Duration;

/// A probe may not hang the settings panel; the agent uses the same bound for provider calls.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(PROBE_TIMEOUT)
            .user_agent(concat!("let-cook/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}
