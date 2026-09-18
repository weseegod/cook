//! Home-directory resolution generally: USERPROFILE-first `home_dir`, plus
//! grok-home (`$GROK_HOME` / `$COOK_HOME` / `$THANH_HOME` or `<home>/.cook`). Shared by `xai-grok-config`
//! and `xai-fast-worktree`.
//!
//! This fork uses `~/.cook` instead of the official grok client's `~/.grok`
//! so BYOK config and session data stay isolated from a co-installed grok.com
//! binary. A one-shot rename migrates an existing `~/.thanh` home.
//!
//! Which function to call:
//! - [`grok_home`]: the usual choice, a cached, created path to build on.
//! - [`user_grok_home`]: `None` instead of a cwd fallback when no home resolves.
//! - [`default_grok_home`]: the `<home>/.cook` default, ignoring env overrides, so callers can detect an override.
//! - [`resolve_grok_home`]: a fresh, uncached resolve.
//! - [`resolve_grok_home_with_source`]: [`resolve_grok_home`] plus where the path came from.
//! - [`home_dir`]: the home directory itself, for sibling dot dirs (`~/.claude`, `~/.agents`, ...).
//!
//! TODO: collapse these getters by threading the path through config as an
//! explicit value.

#![deny(clippy::indexing_slicing)]

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Where a resolved grok home came from, so "why did grok pick this
/// directory?" is answerable in diagnostics without re-reading the
/// environment at the asking site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrokHomeSource {
    /// A non-empty `$GROK_HOME` override.
    EnvOverride,
    /// `<home>/.cook` derived from the home directory.
    HomeDefault,
}

/// The user's home directory via [`std::env::home_dir`]: `HOME` on Unix (with
/// a passwd fallback), `USERPROFILE` on Windows.
///
/// Deliberately not `dirs::home_dir()`: on Windows `dirs` asks the
/// known-folder API and ignores a redirected `USERPROFILE`, while this crate
/// resolves `~/.cook` from the profile variable — mixing the two sources puts
/// the grok directory and other home-anchored dot directories in different
/// trees. Every home-anchored path must come from this one function.
#[allow(deprecated, clippy::disallowed_methods)] // the one sanctioned std::env::home_dir call
pub fn home_dir() -> Option<PathBuf> {
    std::env::home_dir()
}

/// `<home>/.cook`, canonicalized via `dunce` (not `std::fs::canonicalize`,
/// which yields Windows `\\?\` verbatim paths).
fn grok_home_in(home: &Path) -> PathBuf {
    dunce::canonicalize(home)
        .unwrap_or_else(|_| home.to_path_buf())
        .join(".cook")
}

/// One-shot migrate `~/.thanh` → `~/.cook` before the default home is created.
///
/// Skipped when the caller already set an env override (`$GROK_HOME` /
/// `$COOK_HOME` / `$THANH_HOME`). Dual-read forever is forbidden: if both
/// exist, prefer `~/.cook` and leave `~/.thanh` alone.
fn migrate_thanh_home_if_needed(cook_home: &Path) {
    let Some(parent) = cook_home.parent() else {
        return;
    };
    let thanh_home = parent.join(".thanh");

    if cook_home.exists() {
        if thanh_home.exists() {
            static BOTH_HINT: OnceLock<()> = OnceLock::new();
            let _ = BOTH_HINT.get_or_init(|| {
                eprintln!("Found both ~/.cook and ~/.thanh; using ~/.cook");
            });
        }
        return;
    }

    if !thanh_home.exists() {
        return;
    }

    match std::fs::rename(&thanh_home, cook_home) {
        Ok(()) => {
            tracing::info!(
                from = %thanh_home.display(),
                to = %cook_home.display(),
                "migrated home directory from ~/.thanh to ~/.cook"
            );
        }
        Err(err) => {
            tracing::warn!(
                from = %thanh_home.display(),
                to = %cook_home.display(),
                %err,
                "rename ~/.thanh → ~/.cook failed; attempting copy"
            );
            if let Err(copy_err) = copy_dir_recursive(&thanh_home, cook_home) {
                tracing::warn!(
                    from = %thanh_home.display(),
                    to = %cook_home.display(),
                    %copy_err,
                    "copy ~/.thanh → ~/.cook failed; leaving ~/.thanh in place"
                );
            } else {
                tracing::warn!(
                    from = %thanh_home.display(),
                    to = %cook_home.display(),
                    "copied ~/.thanh → ~/.cook after rename failed; old directory left in place"
                );
            }
        }
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn first_nonempty_env(keys: &[&str]) -> Option<std::ffi::OsString> {
    keys.iter().find_map(|key| {
        std::env::var_os(key).and_then(|v| if v.is_empty() { None } else { Some(v) })
    })
}

/// `$GROK_HOME` / `$COOK_HOME` / `$THANH_HOME` (deprecated) when non-empty,
/// else `<home>/.cook`. Env values are used as-is (not canonicalized) so they
/// stay stable and comparable: callers do literal prefix checks against them,
/// and downstream symlink guards must still see their original components.
fn resolve_grok_home_from(
    grok_home_env: Option<&OsStr>,
    os_home: Option<&Path>,
) -> Option<(PathBuf, GrokHomeSource)> {
    if let Some(env) = grok_home_env.filter(|env| !env.is_empty()) {
        return Some((PathBuf::from(env), GrokHomeSource::EnvOverride));
    }
    os_home.map(|home| (grok_home_in(home), GrokHomeSource::HomeDefault))
}

/// Resolve the grok home from the environment (fresh, no cache); `None` if neither resolves.
pub fn resolve_grok_home() -> Option<PathBuf> {
    resolve_grok_home_with_source().map(|(home, _)| home)
}

/// [`resolve_grok_home`] plus the [`GrokHomeSource`] the path came from.
pub fn resolve_grok_home_with_source() -> Option<(PathBuf, GrokHomeSource)> {
    let override_env = first_nonempty_env(&["GROK_HOME", "COOK_HOME", "THANH_HOME"]);
    resolve_grok_home_from(override_env.as_deref(), home_dir().as_deref())
}

/// The default `<home>/.cook`, used when env overrides are unset.
pub fn default_grok_home() -> PathBuf {
    grok_home_in(&home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

/// The grok home, created if missing and cached for the process; falls back to
/// [`default_grok_home`] when neither an env override nor a home resolves.
///
/// When resolving the default home, migrates `~/.thanh` → `~/.cook` once
/// before `create_dir_all`. Env overrides never trigger migration.
pub fn grok_home() -> PathBuf {
    static GROK_HOME: OnceLock<PathBuf> = OnceLock::new();
    GROK_HOME
        .get_or_init(|| {
            let (home, source) = resolve_grok_home_with_source()
                .unwrap_or_else(|| (default_grok_home(), GrokHomeSource::HomeDefault));
            if source == GrokHomeSource::HomeDefault {
                migrate_thanh_home_if_needed(&home);
            }
            if let Err(err) = std::fs::create_dir_all(&home) {
                tracing::warn!(path = %home.display(), %err, "failed to create grok home");
            }
            home
        })
        .clone()
}

/// Like [`grok_home`], but `None` when no home resolves (no cwd fallback).
pub fn user_grok_home() -> Option<PathBuf> {
    resolve_grok_home().is_some().then(grok_home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::ffi::OsString;

    #[test]
    fn env_wins_over_os_home() {
        let resolved =
            resolve_grok_home_from(Some(OsStr::new("/custom/home")), Some(Path::new("/home/u")));
        assert_eq!(
            resolved,
            Some((PathBuf::from("/custom/home"), GrokHomeSource::EnvOverride))
        );
    }

    #[test]
    fn env_used_verbatim_even_when_it_exists() {
        // A real, existing dir whose canonical form differs (macOS symlinks
        // `/var` -> `/private/var`): the env value must come back unchanged.
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_grok_home_from(Some(tmp.path().as_os_str()), None);
        assert_eq!(
            resolved,
            Some((tmp.path().to_path_buf(), GrokHomeSource::EnvOverride))
        );
    }

    #[test]
    fn empty_env_falls_through_to_os_home() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_grok_home_from(Some(&OsString::new()), Some(tmp.path()));
        assert_eq!(
            resolved,
            Some((
                dunce::canonicalize(tmp.path()).unwrap().join(".cook"),
                GrokHomeSource::HomeDefault
            ))
        );
    }

    #[test]
    fn default_grok_home_has_no_verbatim_prefix() {
        // The reason we canonicalize via dunce: std::fs::canonicalize yields
        // `\\?\` verbatim paths on Windows that break git and byte-exact
        // comparisons. No-op assertion on Unix.
        let home = default_grok_home();
        assert!(!home.to_string_lossy().starts_with(r"\\?\"));
        assert!(home.ends_with(".cook"));
    }

    #[test]
    fn none_when_nothing_resolves() {
        assert_eq!(
            resolve_grok_home_from(/* grok_home_env */ None, /* os_home */ None),
            None
        );
    }

    #[test]
    fn migrate_renames_thanh_to_cook() {
        let tmp = tempfile::tempdir().unwrap();
        let thanh = tmp.path().join(".thanh");
        let cook = tmp.path().join(".cook");
        std::fs::create_dir_all(thanh.join("bin")).unwrap();
        std::fs::write(thanh.join("config.toml"), "ok = true").unwrap();

        migrate_thanh_home_if_needed(&cook);

        assert!(cook.join("config.toml").is_file());
        assert!(!thanh.exists());
    }

    #[test]
    fn migrate_skips_when_cook_already_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let thanh = tmp.path().join(".thanh");
        let cook = tmp.path().join(".cook");
        std::fs::create_dir_all(&thanh).unwrap();
        std::fs::create_dir_all(&cook).unwrap();
        std::fs::write(thanh.join("old.txt"), "old").unwrap();
        std::fs::write(cook.join("new.txt"), "new").unwrap();

        migrate_thanh_home_if_needed(&cook);

        assert!(thanh.join("old.txt").is_file());
        assert!(cook.join("new.txt").is_file());
        assert!(!cook.join("old.txt").exists());
    }
}
