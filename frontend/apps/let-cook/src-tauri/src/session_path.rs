//! Resolve a conversation's on-disk session directory under `{cook home}/sessions`.

use std::path::{Path, PathBuf};

use crate::bin_resolve::cook_home;

/// Percent-encode a CWD the way the agent's short-path `encode_cwd_dirname` does
/// (`urlencoding` crate: everything outside `A-Za-z0-9-_.~`).
fn encode_cwd_dirname(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for &byte in cwd.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(byte));
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Session record directory: `{cook_home}/sessions/{encoded-cwd}/{session_id}`.
///
/// Prefers the encoded-CWD bucket when `cwd` is known, then scans every bucket for
/// `{session_id}/summary.json` (the agent's `find_session_dir_by_id` rule).
pub fn find_session_dir(session_id: &str, cwd: Option<&str>) -> Result<PathBuf, String> {
    find_session_dir_in(&cook_home().join("sessions"), session_id, cwd)
}

pub(crate) fn find_session_dir_in(
    sessions_root: &Path,
    session_id: &str,
    cwd: Option<&str>,
) -> Result<PathBuf, String> {
    if session_id.trim().is_empty() {
        return Err("session id is empty".to_string());
    }
    if let Some(cwd) = cwd.filter(|value| !value.is_empty()) {
        let preferred = sessions_root.join(encode_cwd_dirname(cwd)).join(session_id);
        if preferred.join("summary.json").is_file() {
            return Ok(preferred);
        }
    }

    let entries = match std::fs::read_dir(sessions_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("session {session_id} is not on disk yet"));
        }
        Err(error) => return Err(format!("read session store: {error}")),
    };

    let mut matches = Vec::new();
    for entry in entries.flatten() {
        let bucket = entry.path();
        if !bucket.is_dir() {
            continue;
        }
        let candidate = bucket.join(session_id);
        if candidate.join("summary.json").is_file() {
            matches.push(candidate);
        }
    }

    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err(format!("session {session_id} is not on disk yet")),
        _ => Err(format!("session {session_id} is stored in more than one place")),
    }
}

#[cfg(test)]
mod tests {
    use super::find_session_dir_in;
    use std::fs;

    #[test]
    fn prefers_the_encoded_cwd_bucket_when_summary_exists() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let preferred = root
            .join("%2Ftmp%2Fcook-demo")
            .join("s-alternate")
            .join("summary.json");
        let other = root.join("other-cwd").join("s-alternate").join("summary.json");
        fs::create_dir_all(preferred.parent().unwrap()).unwrap();
        fs::write(&preferred, "{}").unwrap();
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, "{}").unwrap();

        let found =
            find_session_dir_in(root, "s-alternate", Some("/tmp/cook-demo")).expect("preferred");
        assert_eq!(found, preferred.parent().unwrap());
    }

    #[test]
    fn finds_a_session_by_scanning_when_the_cwd_hint_is_missing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let dir = root.join("%2Fwork%2Frepo").join("s-1");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("summary.json"), "{}").unwrap();

        let found = find_session_dir_in(root, "s-1", None).expect("scan");
        assert_eq!(found, dir);
    }

    #[test]
    fn reports_a_session_that_is_not_on_disk() {
        let temp = tempfile::tempdir().unwrap();
        let error = find_session_dir_in(temp.path(), "missing", Some("/tmp")).unwrap_err();
        assert!(error.contains("missing"));
        assert!(error.contains("not on disk"));
    }

    #[test]
    fn rejects_an_empty_session_id() {
        let temp = tempfile::tempdir().unwrap();
        let error = find_session_dir_in(temp.path(), "  ", None).unwrap_err();
        assert!(error.contains("empty"));
    }

    #[test]
    fn errors_when_the_id_sits_in_two_buckets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for bucket in ["one", "two"] {
            let dir = root.join(bucket).join("dup");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("summary.json"), "{}").unwrap();
        }
        let error = find_session_dir_in(root, "dup", None).unwrap_err();
        assert!(error.contains("more than one place"));
    }
}
