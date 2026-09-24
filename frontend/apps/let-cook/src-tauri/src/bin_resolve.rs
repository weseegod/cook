//! Resolve the `cook` agent binary for ACP stdio.
//!
//! Preference order (the desktop app updater never writes these paths):
//! 1. `COOK_BIN` — explicit override
//! 2. `$COOK_HOME/bin/cook` or `~/.cook/bin/cook` — CLI install
//! 3. Optional bundled sidecar `cook-<target-triple>` next to the app / under
//!    `Resources/binaries` / AppImage `usr/bin` (stable bundles only)
//!
//! Enable the sidecar by placing `binaries/cook-<triple>` and setting
//! `bundle.externalBin` in `tauri.conf.json` (see README). Alpha builds leave
//! that unset and expect the CLI. The Tauri updater updates the app shell only
//! and must never overwrite `~/.cook/bin/cook`.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ResolveError {
    #[error("COOK_BIN points to a missing or non-file path: {0}")]
    InvalidOverride(PathBuf),
    #[error("could not find cook; install it at ~/.cook/bin/cook or set COOK_BIN")]
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
    #[error(
        "incompatible versions: Let Cook {app} requires cook major {expected}, found {actual}"
    )]
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

fn first_nonempty_env(keys: &[&str]) -> Option<PathBuf> {
    keys.iter().find_map(|key| {
        std::env::var_os(key).and_then(|v| {
            if v.is_empty() {
                None
            } else {
                Some(PathBuf::from(v))
            }
        })
    })
}

/// Desktop home: `$COOK_HOME`, else `$GROK_HOME`, else `~/.cook`.
///
/// An override equal to the real `~/.grok` or `~/.thanh` is ignored. `$THANH_HOME`
/// is not consulted. Matches `xai-dirs` (this crate cannot depend on it).
pub fn cook_home() -> PathBuf {
    cook_home_from(
        std::env::var_os("COOK_HOME").as_deref(),
        std::env::var_os("GROK_HOME").as_deref(),
        dirs::home_dir().as_deref(),
    )
}

pub(crate) fn cook_home_from(
    cook_home: Option<&std::ffi::OsStr>,
    grok_home: Option<&std::ffi::OsStr>,
    os_home: Option<&Path>,
) -> PathBuf {
    let canonical_home =
        os_home.map(|home| dunce::canonicalize(home).unwrap_or_else(|_| home.to_path_buf()));
    for value in [cook_home, grok_home].into_iter().flatten() {
        if value.is_empty() {
            continue;
        }
        let path = PathBuf::from(value);
        if let Some(home) = os_home {
            if [home, canonical_home.as_deref().unwrap_or(home)]
                .into_iter()
                .any(|base| path == base.join(".grok") || path == base.join(".thanh"))
            {
                continue;
            }
        }
        return path;
    }
    os_home
        .map(|home| home.join(".cook"))
        .unwrap_or_else(|| PathBuf::from(".cook"))
}

pub fn resolve_binary() -> Result<PathBuf, ResolveError> {
    if let Some(path) = first_nonempty_env(&["COOK_BIN"]) {
        return canonical_file(&path).ok_or(ResolveError::InvalidOverride(path));
    }

    let installed = cook_home()
        .join("bin")
        .join(if cfg!(windows) { "cook.exe" } else { "cook" });
    if let Some(installed) = canonical_file(&installed) {
        return Ok(installed);
    }

    let target = target_triple();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for candidate in [
                dir.join(format!("cook-{target}")),
                dir.join("binaries").join(format!("cook-{target}")),
                dir.join("../Resources/binaries")
                    .join(format!("cook-{target}")),
            ] {
                if let Some(candidate) = canonical_file(&candidate) {
                    return Ok(candidate);
                }
            }
        }
    }

    if let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from) {
        let bundled = appdir.join("usr/bin").join(format!("cook-{target}"));
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
    use std::ffi::OsStr;

    use super::*;

    #[test]
    fn bundled_name_contains_target() {
        let target = target_triple();
        assert!(!target.is_empty());
    }

    #[test]
    fn cook_home_prefers_cook_then_grok_and_rejects_legacy_dirs() {
        let os_home = Path::new("/home/u");
        assert_eq!(
            cook_home_from(
                Some(OsStr::new("/custom/cook")),
                Some(OsStr::new("/custom/grok")),
                Some(os_home),
            ),
            PathBuf::from("/custom/cook")
        );
        assert_eq!(
            cook_home_from(None, Some(OsStr::new("/custom/grok")), Some(os_home)),
            PathBuf::from("/custom/grok")
        );
        assert_eq!(
            cook_home_from(
                Some(OsStr::new("/home/u/.grok")),
                Some(OsStr::new("/custom/grok")),
                Some(os_home),
            ),
            PathBuf::from("/custom/grok")
        );
        assert_eq!(
            cook_home_from(
                Some(OsStr::new("/home/u/.thanh")),
                Some(OsStr::new("/home/u/.grok")),
                Some(os_home),
            ),
            os_home.join(".cook")
        );
        assert_eq!(
            cook_home_from(None, None, Some(os_home)),
            os_home.join(".cook")
        );

        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir(temp.path().join("alias")).unwrap();
        std::fs::create_dir(temp.path().join("real")).unwrap();
        let spelled_home = temp.path().join("alias").join("..").join("real");
        let canonical_home = dunce::canonicalize(&spelled_home).unwrap();
        for legacy in [".grok", ".thanh"] {
            let legacy_path = canonical_home.join(legacy);
            assert_eq!(
                cook_home_from(Some(legacy_path.as_os_str()), None, Some(&spelled_home)),
                spelled_home.join(".cook")
            );
        }
        assert_eq!(
            cook_home_from(
                Some(OsStr::new("/custom/cook")),
                Some(canonical_home.join(".grok").as_os_str()),
                Some(&spelled_home),
            ),
            PathBuf::from("/custom/cook")
        );
    }
}
