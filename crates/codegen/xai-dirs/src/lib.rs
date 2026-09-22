//! Home-directory resolution generally: USERPROFILE-first `home_dir`, plus
//! grok-home (`$COOK_HOME`, else `$GROK_HOME`, else `<home>/.cook`). Shared by
//! `xai-grok-config` and `xai-fast-worktree`.
//!
//! This fork uses `~/.cook` instead of the official grok client's `~/.grok`
//! so BYOK config and session data stay isolated from a co-installed grok.com
//! binary. `~/.grok` and `~/.thanh` are never read, written, or migrated.
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
    /// A non-empty `$COOK_HOME` or `$GROK_HOME` override.
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

/// `$COOK_HOME`, else `$GROK_HOME`, else `<home>/.cook`. Env values are used
/// as-is (not canonicalized) so they stay stable and comparable: callers do
/// literal prefix checks against them, and downstream symlink guards must
/// still see their original components.
///
/// An override equal to the real `<home>/.grok` or `<home>/.thanh` is ignored
/// so a co-installed grok (or the old fork name) cannot redirect this process.
/// `$THANH_HOME` is not consulted.
fn resolve_grok_home_from(
    grok_home_env: Option<&OsStr>,
    os_home: Option<&Path>,
) -> Option<(PathBuf, GrokHomeSource)> {
    if let Some(env) = grok_home_env.filter(|env| !env.is_empty()) {
        return Some((PathBuf::from(env), GrokHomeSource::EnvOverride));
    }
    os_home.map(|home| (grok_home_in(home), GrokHomeSource::HomeDefault))
}

fn is_legacy_user_home(path: &OsStr, os_home: Option<&Path>) -> bool {
    let Some(home) = os_home else {
        return false;
    };
    let path = Path::new(path);
    let canonical = dunce::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    path == home.join(".grok")
        || path == home.join(".thanh")
        || path == canonical.join(".grok")
        || path == canonical.join(".thanh")
}

fn select_override<'a>(
    cook_home: Option<&'a OsStr>,
    grok_home: Option<&'a OsStr>,
    os_home: Option<&Path>,
) -> Option<&'a OsStr> {
    [cook_home, grok_home]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty() && !is_legacy_user_home(value, os_home))
}

fn resolve_grok_home_with_source_from(
    cook_home: Option<&OsStr>,
    grok_home: Option<&OsStr>,
    os_home: Option<&Path>,
) -> Option<(PathBuf, GrokHomeSource)> {
    let override_env = select_override(cook_home, grok_home, os_home);
    resolve_grok_home_from(override_env, os_home)
}

/// Resolve the grok home from the environment (fresh, no cache); `None` if neither resolves.
pub fn resolve_grok_home() -> Option<PathBuf> {
    resolve_grok_home_with_source().map(|(home, _)| home)
}

/// [`resolve_grok_home`] plus the [`GrokHomeSource`] the path came from.
pub fn resolve_grok_home_with_source() -> Option<(PathBuf, GrokHomeSource)> {
    let os_home = home_dir();
    resolve_grok_home_with_source_from(
        std::env::var_os("COOK_HOME").as_deref(),
        std::env::var_os("GROK_HOME").as_deref(),
        os_home.as_deref(),
    )
}

/// The default `<home>/.cook`, used when env overrides are unset.
pub fn default_grok_home() -> PathBuf {
    grok_home_in(&home_dir().unwrap_or_else(|| PathBuf::from(".")))
}

/// The grok home, created if missing and cached for the process; falls back to
/// [`default_grok_home`] when neither an env override nor a home resolves.
///
/// Does not read, copy, or rename `~/.thanh` or `~/.grok`.
pub fn grok_home() -> PathBuf {
    static GROK_HOME: OnceLock<PathBuf> = OnceLock::new();
    GROK_HOME
        .get_or_init(|| {
            let home = resolve_grok_home().unwrap_or_else(default_grok_home);
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

    fn expected_default(home: &Path) -> PathBuf {
        dunce::canonicalize(home).unwrap().join(".cook")
    }

    #[test]
    fn cook_home_wins_over_grok_home() {
        let tmp = tempfile::tempdir().unwrap();
        let resolved = resolve_grok_home_with_source_from(
            Some(OsStr::new("/custom/cook")),
            Some(OsStr::new("/custom/grok")),
            Some(tmp.path()),
        );
        assert_eq!(
            resolved,
            Some((PathBuf::from("/custom/cook"), GrokHomeSource::EnvOverride))
        );
    }

    #[test]
    fn override_pointing_at_real_dot_grok_or_dot_thanh_falls_through() {
        let tmp = tempfile::tempdir().unwrap();
        let expected = expected_default(tmp.path());
        let grok = tmp.path().join(".grok");
        let thanh = tmp.path().join(".thanh");
        assert_eq!(
            resolve_grok_home_with_source_from(Some(grok.as_os_str()), None, Some(tmp.path())),
            Some((expected.clone(), GrokHomeSource::HomeDefault))
        );
        assert_eq!(
            resolve_grok_home_with_source_from(None, Some(thanh.as_os_str()), Some(tmp.path())),
            Some((expected, GrokHomeSource::HomeDefault))
        );
    }

    #[test]
    fn temp_grok_home_is_used_verbatim() {
        let tmp = tempfile::tempdir().unwrap();
        let custom = tmp.path().join("isolated");
        let resolved =
            resolve_grok_home_with_source_from(None, Some(custom.as_os_str()), Some(tmp.path()));
        assert_eq!(resolved, Some((custom, GrokHomeSource::EnvOverride)));
    }

    #[test]
    fn unset_overrides_use_dot_cook_and_leave_sibling_thanh() {
        let tmp = tempfile::tempdir().unwrap();
        let thanh = tmp.path().join(".thanh");
        std::fs::create_dir_all(thanh.join("bin")).unwrap();
        std::fs::write(thanh.join("config.toml"), "old = true").unwrap();

        let resolved = resolve_grok_home_with_source_from(None, None, Some(tmp.path()));

        assert_eq!(
            resolved,
            Some((expected_default(tmp.path()), GrokHomeSource::HomeDefault))
        );
        assert!(thanh.join("config.toml").is_file());
        assert!(!tmp.path().join(".cook").exists());
    }
}
