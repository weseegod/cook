//! Resolve the `thanh` agent binary for ACP stdio.
//!
//! Preference order (the desktop app updater never writes these paths):
//! 1. `THANH_BIN` — explicit override
//! 2. `$THANH_HOME/bin/thanh` or `~/.thanh/bin/thanh` — CLI install
//! 3. Optional bundled sidecar `thanh-<target-triple>` next to the app / under
//!    `Resources/binaries` / AppImage `usr/bin` (stable bundles only)
//!
//! Enable the sidecar by placing `binaries/thanh-<triple>` and setting
//! `bundle.externalBin` in `tauri.conf.json` (see README). Alpha builds leave
//! that unset and expect the CLI. The Tauri updater updates the app shell only
//! and must never overwrite `~/.thanh/bin/thanh`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ResolveError {
    #[error("THANH_BIN points to a missing or non-file path: {0}")]
    InvalidOverride(PathBuf),
    #[error("could not find thanh; install it at ~/.thanh/bin/thanh or set THANH_BIN")]
    NotFound,
    #[error("failed to run {path}: {source}")]
    VersionIo {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{path} --version failed: {stderr}")]
    VersionFailed { path: PathBuf, stderr: String },
    #[error("could not parse a semantic version from: {0}")]
    InvalidVersion(String),
    #[error("incompatible versions: Thanh Desktop {app} requires thanh major {expected}, found {actual}")]
    MajorMismatch {
        app: String,
        expected: u64,
        actual: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBinary {
    pub path: PathBuf,
    pub version: String,
}

fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn canonical_file(path: &Path) -> Option<PathBuf> {
    is_executable_file(path)
        .then(|| path.canonicalize().ok())
        .flatten()
}

pub fn resolve_binary() -> Result<PathBuf, ResolveError> {
    if let Some(path) = std::env::var_os("THANH_BIN").map(PathBuf::from) {
        return canonical_file(&path).ok_or(ResolveError::InvalidOverride(path));
    }

    let thanh_home = std::env::var_os("THANH_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".thanh")));
    if let Some(home) = thanh_home {
        let installed = home
            .join("bin")
            .join(if cfg!(windows) { "thanh.exe" } else { "thanh" });
        if let Some(installed) = canonical_file(&installed) {
            return Ok(installed);
        }
    }

    let target = target_triple();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join(format!("thanh-{target}")),
                dir.join("binaries").join(format!("thanh-{target}")),
                dir.join("../Resources/binaries")
                    .join(format!("thanh-{target}")),
            ] {
                if let Some(candidate) = canonical_file(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }

    if let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from) {
        let bundled = appdir.join("usr/bin").join(format!("thanh-{target}"));
        if let Some(bundled) = canonical_file(&bundled) {
            return Ok(bundled);
        }
    }

    Err(ResolveError::NotFound)
}

fn target_triple() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    return "x86_64-unknown-linux-gnu";
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return "aarch64-apple-darwin";
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    return "x86_64-apple-darwin";
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return "x86_64-pc-windows-msvc";
    #[allow(unreachable_code)]
    std::env::consts::ARCH
}

pub fn resolve_and_gate() -> Result<ResolvedBinary, ResolveError> {
    let path = resolve_binary()?;
    let output = Command::new(&path)
        .arg("--version")
        .output()
        .map_err(|source| ResolveError::VersionIo {
            path: path.clone(),
            source,
        })?;
    if !output.status.success() {
        return Err(ResolveError::VersionFailed {
            path,
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        });
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let version = raw
        .split_whitespace()
        .find(|part| part.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .map(|part| part.trim_start_matches('v').to_owned())
        .ok_or_else(|| ResolveError::InvalidVersion(raw.clone()))?;
    let actual_major = version
        .split('.')
        .next()
        .and_then(|part| part.parse::<u64>().ok())
        .ok_or_else(|| ResolveError::InvalidVersion(raw))?;
    let app = env!("CARGO_PKG_VERSION").to_owned();
    let expected = app
        .split('.')
        .next()
        .and_then(|part| part.parse().ok())
        .unwrap_or(0);
    if actual_major != expected {
        return Err(ResolveError::MajorMismatch {
            app,
            expected,
            actual: version,
        });
    }
    Ok(ResolvedBinary { path, version })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_name_contains_target() {
        let target = target_triple();
        assert!(!target.is_empty());
    }
}
