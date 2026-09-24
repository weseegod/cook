//! Small, dependency-free desktop logger.
//!
//! Native logs are always appended to `$COOK_HOME/logs/desktop.log` (or the default
//! `~/.cook/logs/desktop.log`). Verbose ACP tracing is opt-in with
//! `COOK_DESKTOP_TRACE=1`; agent stderr is captured and sanitized into the same log.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::bin_resolve::cook_home;

struct Logger {
    trace: bool,
    file: Mutex<File>,
}

static LOGGER: OnceLock<Logger> = OnceLock::new();

pub fn init() {
    if LOGGER.get().is_some() {
        return;
    }

    let trace = env_truthy("COOK_DESKTOP_TRACE");
    let path = log_path();
    let file = match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(file) => file,
        Err(error) => {
            eprintln!(
                "[let-cook][error] cannot open log {}: {error}",
                path.display()
            );
            return;
        }
    };
    secure_file(&file);

    let _ = LOGGER.set(Logger {
        trace,
        file: Mutex::new(file),
    });
    info(
        "desktop.start",
        format!("trace={trace} log={}", path.display()),
    );
}

pub fn log_path() -> PathBuf {
    if let Some(path) = std::env::var_os("COOK_DESKTOP_LOG_FILE") {
        return PathBuf::from(path);
    }
    cook_home().join("logs").join("desktop.log")
}

pub fn info(event: &str, detail: impl AsRef<str>) {
    write_line("INFO", event, detail.as_ref(), false);
}

pub fn warn(event: &str, detail: impl AsRef<str>) {
    write_line("WARN", event, detail.as_ref(), false);
}

pub fn error(event: &str, detail: impl AsRef<str>) {
    write_line("ERROR", event, detail.as_ref(), false);
}

pub fn trace(event: &str, detail: impl AsRef<str>) {
    write_line("TRACE", event, detail.as_ref(), true);
}

/// Keep stderr/config errors useful while preventing accidental credential dumps in logs.
pub fn sanitize(value: &str) -> String {
    let value = value.trim().replace(['\n', '\r'], "\\n");
    let lower = value.to_ascii_lowercase();
    if [
        "api_key",
        "authorization",
        "access_token",
        "password",
        "secret",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return "[redacted sensitive diagnostic]".to_owned();
    }
    value.chars().take(2_000).collect()
}

fn write_line(level: &str, event: &str, detail: &str, trace_only: bool) {
    let detail = sanitize(detail);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "unknown-time".to_owned());
    let line = format!("{timestamp} [{level}] {event} {detail}\n");

    let Some(logger) = LOGGER.get() else {
        eprintln!("[let-cook] {}", line.trim_end());
        return;
    };
    if let Ok(mut file) = logger.file.lock() {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
    if logger.trace && (trace_only || level == "WARN" || level == "ERROR") {
        eprintln!("[let-cook] {}", line.trim_end());
    }
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn secure_file(file: &File) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
}
