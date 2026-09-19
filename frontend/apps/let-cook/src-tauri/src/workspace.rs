//! Read-only workspace sidecar (C5): git review vs HEAD, file tree/preview, native open.
//! Paths stay confined to the workspace root. No write, commit, or LSP — this is not a git GUI.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output};

use serde::Serialize;

const MAX_TREE_ENTRIES: usize = 5_000;
const MAX_PREVIEW_BYTES: usize = 512 * 1024;
const MAX_DIFF_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    pub name: String,
    pub path: String,
    pub kind: &'static str,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub truncated: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFile {
    pub path: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSnapshot {
    pub base: &'static str,
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub files: Vec<ReviewFile>,
    pub additions: usize,
    pub deletions: usize,
}

pub fn list(root: PathBuf, relative: String) -> Result<Vec<WorkspaceEntry>, String> {
    let directory = resolve_existing(&root, &relative)?;
    if !directory.is_dir() {
        return Err(format!("{} is not a directory", display_path(&relative)));
    }

    let mut entries = Vec::new();
    for item in
        fs::read_dir(&directory).map_err(|error| format!("could not list workspace: {error}"))?
    {
        if entries.len() >= MAX_TREE_ENTRIES {
            break;
        }
        let item = item.map_err(|error| format!("could not read workspace entry: {error}"))?;
        let file_type = item
            .file_type()
            .map_err(|error| format!("could not inspect workspace entry: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let path = relative_path(&root, &item.path())?;
        let metadata = item.metadata().ok();
        entries.push(WorkspaceEntry {
            name,
            path,
            kind: if file_type.is_dir() {
                "directory"
            } else {
                "file"
            },
            size: metadata
                .filter(|value| value.is_file())
                .map(|value| value.len()),
        });
    }

    entries.sort_by(|left, right| {
        (left.kind != "directory", left.name.to_ascii_lowercase())
            .cmp(&(right.kind != "directory", right.name.to_ascii_lowercase()))
    });
    Ok(entries)
}

pub fn read_file(root: PathBuf, relative: String) -> Result<FilePreview, String> {
    let path = resolve_existing(&root, &relative)?;
    let metadata =
        fs::metadata(&path).map_err(|error| format!("could not inspect file: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", display_path(&relative)));
    }

    let mut file = File::open(&path).map_err(|error| format!("could not open file: {error}"))?;
    let mut bytes = Vec::with_capacity(MAX_PREVIEW_BYTES.min(metadata.len() as usize));
    file.by_ref()
        .take((MAX_PREVIEW_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read file: {error}"))?;
    let truncated = bytes.len() > MAX_PREVIEW_BYTES;
    if truncated {
        bytes.truncate(MAX_PREVIEW_BYTES);
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FilePreview {
            path: relative_path(&root, &path)?,
            content,
            size: metadata.len(),
            truncated,
            binary: false,
        }),
        Err(_) => Ok(FilePreview {
            path: relative_path(&root, &path)?,
            content: String::new(),
            size: metadata.len(),
            truncated,
            binary: true,
        }),
    }
}

pub fn open(root: PathBuf, relative: String) -> Result<(), String> {
    let path = resolve_existing(&root, &relative)?;
    open_external(&path)
}

/// Cheap dirty-tree probe behind the header's git chip: one `git status` plus one `--numstat`
/// diff, no per-file patches. The full `review` snapshot stays on demand for the Review panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusSummary {
    pub is_git_repo: bool,
    pub branch: Option<String>,
    pub changed_files: usize,
    pub additions: usize,
    pub deletions: usize,
    /// A merge, rebase, cherry-pick, or bisect is in progress: committing now would stack on it.
    pub operation_in_progress: bool,
}

pub fn git_status(root: PathBuf) -> Result<GitStatusSummary, String> {
    let not_a_repo = GitStatusSummary {
        is_git_repo: false,
        branch: None,
        changed_files: 0,
        additions: 0,
        deletions: 0,
        operation_in_progress: false,
    };
    let probe = git(&root, &["rev-parse", "--is-inside-work-tree"])?;
    if !probe.status.success() || String::from_utf8_lossy(&probe.stdout).trim() != "true" {
        return Ok(not_a_repo);
    }

    let status = git(&root, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])?;
    if !status.status.success() {
        return Err(git_error("git status", &status));
    }
    let changed_files = parse_status(&status.stdout).len();
    let branch = git(&root, &["branch", "--show-current"])
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty());
    let (additions, deletions) = numstat_totals(&root)?;
    let operation_in_progress = git(&root, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .map(|output| output.status.success())
        .unwrap_or(false)
        || [
            "rebase-merge",
            "rebase-apply",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "BISECT_LOG",
        ]
        .iter()
        .any(|marker| {
            git(&root, &["rev-parse", "--git-path", marker])
                .ok()
                .filter(|output| output.status.success())
                .is_some_and(|output| {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_owned();
                    !path.is_empty() && root.join(path).exists()
                })
        });

    Ok(GitStatusSummary {
        is_git_repo: true,
        branch,
        changed_files,
        additions,
        deletions,
        operation_in_progress,
    })
}

/// Tracked-file line totals vs `HEAD`; untracked files are counted as changed files but add no
/// lines, matching what `git diff HEAD` reports.
fn numstat_totals(root: &Path) -> Result<(usize, usize), String> {
    let output = git(root, &["diff", "--numstat", "HEAD"])?;
    if !output.status.success() {
        return Ok((0, 0));
    }
    let (mut additions, mut deletions) = (0, 0);
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut fields = line.split('\t');
        let (Some(added), Some(removed)) = (fields.next(), fields.next()) else {
            continue;
        };
        additions += added.trim().parse::<usize>().unwrap_or(0);
        deletions += removed.trim().parse::<usize>().unwrap_or(0);
    }
    Ok((additions, deletions))
}

pub fn review(root: PathBuf) -> Result<ReviewSnapshot, String> {
    let probe = git(&root, &["rev-parse", "--is-inside-work-tree"])?;
    if !probe.status.success() || String::from_utf8_lossy(&probe.stdout).trim() != "true" {
        return Ok(ReviewSnapshot {
            base: "HEAD",
            is_git_repo: false,
            branch: None,
            files: Vec::new(),
            additions: 0,
            deletions: 0,
        });
    }

    let status = git(
        &root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !status.status.success() {
        return Err(git_error("git status", &status));
    }
    let branch = git(&root, &["branch", "--show-current"])
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty());

    let mut files = parse_status(&status.stdout);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut result = Vec::with_capacity(files.len());
    for (path, status) in files {
        let diff = if status == "untracked" {
            untracked_diff(&root, &path)?
        } else {
            let output = git(
                &root,
                &[
                    "diff",
                    "--no-ext-diff",
                    "--no-color",
                    "--unified=3",
                    "HEAD",
                    "--",
                    &path,
                ],
            )?;
            if !output.status.success() {
                return Err(git_error("git diff", &output));
            }
            truncate_utf8(&output.stdout, MAX_DIFF_BYTES)
        };
        let (additions, deletions) = diff_counts(&diff);
        result.push(ReviewFile {
            path,
            status,
            additions,
            deletions,
            diff,
        });
    }

    let additions = result.iter().map(|file| file.additions).sum();
    let deletions = result.iter().map(|file| file.deletions).sum();
    Ok(ReviewSnapshot {
        base: "HEAD",
        is_git_repo: true,
        branch,
        files: result,
        additions,
        deletions,
    })
}

fn resolve_existing(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("invalid workspace root: {error}"))?;
    let requested = Path::new(relative);
    if requested.is_absolute()
        || requested
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("path must stay inside the workspace".to_owned());
    }
    let mut path = root.clone();
    for component in requested.components() {
        if let Component::Normal(value) = component {
            path.push(value);
            if path
                .symlink_metadata()
                .map_err(|error| format!("invalid workspace path: {error}"))?
                .file_type()
                .is_symlink()
            {
                return Err("symlinks are not supported in the workspace panel".to_owned());
            }
        }
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("invalid workspace path: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("path is outside the workspace".to_owned());
    }
    Ok(canonical)
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("invalid workspace root: {error}"))?;
    path.strip_prefix(root)
        .map_err(|_| "path is outside the workspace".to_owned())
        .map(|value| value.to_string_lossy().replace('\\', "/"))
}

fn display_path(path: &str) -> &str {
    if path.is_empty() {
        "."
    } else {
        path
    }
}

fn git(root: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(args)
        .current_dir(root)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_PAGER", "cat")
        .output()
        .map_err(|error| format!("could not run git: {error}"))
}

fn git_error(command: &str, output: &Output) -> String {
    let message = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if message.is_empty() {
        format!("{command} failed")
    } else {
        format!("{command} failed: {message}")
    }
}

fn parse_status(bytes: &[u8]) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut parts = bytes.split(|byte| *byte == 0);
    while let Some(raw) = parts.next() {
        if raw.len() < 4 {
            continue;
        }
        let record = String::from_utf8_lossy(raw);
        let status_code = &record[..2];
        let path = record[3..].to_owned();
        let status = if status_code.contains('D') {
            "deleted"
        } else if status_code.contains('A') || status_code == "??" {
            "added"
        } else if status_code.contains('R') {
            "renamed"
        } else if status_code.contains('U') {
            "conflicted"
        } else {
            "modified"
        };
        entries.push((
            path,
            if status_code == "??" {
                "untracked".to_owned()
            } else {
                status.to_owned()
            },
        ));
    }
    entries
}

fn untracked_diff(root: &Path, relative: &str) -> Result<String, String> {
    let path = resolve_existing(root, relative)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("could not inspect untracked file: {error}"))?;
    if !metadata.is_file() {
        return Err(format!("untracked path is not a file: {relative}"));
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(|error| format!("could not open untracked file: {error}"))?
        .take((MAX_DIFF_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("could not read untracked file: {error}"))?;
    if std::str::from_utf8(&bytes).is_err() {
        return Ok(format!("Binary file /dev/null -> {relative} (untracked)\n"));
    }
    let content = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = content.lines().collect();
    let mut diff = format!(
        "--- /dev/null\n+++ b/{relative}\n@@ -0,0 +1,{} @@\n",
        lines.len()
    );
    for line in lines {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    if bytes.len() > MAX_DIFF_BYTES {
        diff.push_str("\n[diff truncated]\n");
    }
    Ok(truncate_string(diff, MAX_DIFF_BYTES))
}

fn diff_counts(diff: &str) -> (usize, usize) {
    diff.lines().fold((0, 0), |(additions, deletions), line| {
        if line.starts_with("+++") || line.starts_with("---") {
            return (additions, deletions);
        }
        if line.starts_with('+') {
            (additions + 1, deletions)
        } else if line.starts_with('-') {
            (additions, deletions + 1)
        } else {
            (additions, deletions)
        }
    })
}

fn truncate_utf8(bytes: &[u8], max: usize) -> String {
    String::from_utf8_lossy(&bytes[..bytes.len().min(max)]).into_owned()
}

fn truncate_string(mut value: String, max: usize) -> String {
    if value.len() > max {
        value.truncate(max);
    }
    value
}

fn open_external(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(path);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &path.to_string_lossy()]);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_outside_workspace() {
        let root = tempfile::tempdir().unwrap();
        assert!(resolve_existing(root.path(), "../secret").is_err());
        assert!(resolve_existing(root.path(), "/tmp/secret").is_err());
    }

    #[test]
    fn lists_directories_before_files_and_skips_git_and_symlinks() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("README.md"), "readme").unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        let entries = list(root.path().to_path_buf(), String::new()).unwrap();
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["src", "README.md"]
        );
    }

    #[test]
    fn reports_binary_and_truncates_large_text() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("image.bin"), [0, 159, 146, 150]).unwrap();
        let preview = read_file(root.path().to_path_buf(), "image.bin".into()).unwrap();
        assert!(preview.binary);
        fs::write(
            root.path().join("large.txt"),
            "x".repeat(MAX_PREVIEW_BYTES + 1),
        )
        .unwrap();
        let preview = read_file(root.path().to_path_buf(), "large.txt".into()).unwrap();
        assert!(preview.truncated);
        assert_eq!(preview.content.len(), MAX_PREVIEW_BYTES);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_components() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("linked")).unwrap();
        assert!(resolve_existing(root.path(), "linked/secret.txt").is_err());
    }

    #[test]
    fn counts_diff_lines_without_file_headers() {
        assert_eq!(diff_counts("--- a/x\n+++ b/x\n-old\n+new\n"), (1, 1));
    }

    #[test]
    fn review_includes_head_changes_and_untracked_files() {
        let root = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run(&["init"]);
        run(&["config", "user.email", "test@example.com"]);
        run(&["config", "user.name", "Test"]);
        fs::write(root.path().join("tracked.txt"), "before\n").unwrap();
        run(&["add", "tracked.txt"]);
        run(&["commit", "-m", "initial"]);
        fs::write(root.path().join("tracked.txt"), "after\n").unwrap();
        fs::write(root.path().join("new.txt"), "new\n").unwrap();

        let snapshot = review(root.path().to_path_buf()).unwrap();
        assert!(snapshot.is_git_repo);
        assert_eq!(snapshot.base, "HEAD");
        assert_eq!(snapshot.files.len(), 2);
        assert!(snapshot
            .files
            .iter()
            .any(|file| file.path == "tracked.txt" && file.status == "modified"));
        assert!(snapshot
            .files
            .iter()
            .any(|file| file.path == "new.txt" && file.status == "untracked"));
        assert!(snapshot.additions >= 2);
        assert!(snapshot.deletions >= 1);
    }
}
