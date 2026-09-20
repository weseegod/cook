use super::*;

fn words(cmd: &str) -> Vec<String> {
    cmd.split_whitespace().map(str::to_owned).collect()
}

#[test]
fn discards_and_unrecognized_shapes_are_not_routine() {
    for cmd in [
        "git checkout HEAD -- src/schema.rs src/config.rs src/connections.rs Cargo.toml",
        "git checkout -- app.py",
        "git checkout -- .",
        "git checkout --",
        "git checkout -f main",
        "git checkout --force main",
        "git checkout --fo main",
        "git checkout -qf main",
        "git checkout -p HEAD~1",
        "git checkout --ours src/lib.rs",
        "git checkout main src/lib.rs",
        "git checkout main Makefile",
        "git checkout HEAD~3 -- src/",
        "git checkout --pathspec-from-file=paths.txt",
        "git checkout --pathspec-from-file paths.txt",
        "git checkout src/",
        "git checkout .gitignore",
        "git checkout src/.gitignore",
        "git checkout src/foo.lock",
        "git checkout a..b",
        "git checkout Cargo.toml",
        "git switch --discard-changes main",
        "git switch -f main",
        "git switch --disc main",
        "git stash drop",
        "git stash -q drop",
        "git stash clear",
        "git stash drop stash@{2}",
        "Git checkout main",
        "/usr/bin/git checkout main",
        "git worktree remove ../x",
        "git push origin main",
        "git reset --hard",
        "git clean -fd",
        "git restore .",
    ] {
        assert!(!git_words_are_routine(&words(cmd)), "{cmd}");
    }
    // The shell dequotes `"My Folder"` into one word, which the whitespace splitter above cannot express
    let quoted = [
        "git".to_owned(),
        "checkout".to_owned(),
        "My Folder".to_owned(),
    ];
    assert!(!git_words_are_routine(&quoted));
}

#[test]
fn branch_switching_and_local_workflow_are_routine() {
    for cmd in [
        "git checkout main",
        "git checkout",
        "git checkout -",
        "git checkout -q main",
        "git checkout --detach main",
        "git checkout -b feature/x",
        "git checkout -B feature/x origin/feature/x",
        "git checkout --orphan gh-pages",
        "git checkout release-1.0.3",
        "git checkout 2.x",
        "git checkout 1.2.x",
        "git checkout release/3.x",
        "git checkout release/1.2.x",
        "git checkout user/name/PROJ-123-topic-guard",
        "git switch feature/x",
        "git switch -",
        "git switch -c feature/y",
        "git stash",
        "git stash -m wip",
        "git stash push -m wip",
        "git stash pop",
        "git stash apply",
        "git stash list",
        "git stash show -p",
        "git add -A",
        "git commit -m x",
        "git pull",
        "git fetch origin",
        "git worktree list",
        "git status",
        "git diff HEAD",
        // `/commit-and-push` and the conflict-resolution path it can hand back to the model
        "git push",
        "git push -u origin HEAD",
        "git push origin HEAD",
        "git push --quiet",
        "git rebase --continue",
    ] {
        assert!(git_words_are_routine(&words(cmd)), "{cmd}");
    }
}

#[test]
fn pushes_to_other_refs_and_non_continue_rebase_stay_non_routine() {
    for cmd in [
        "git push origin main",
        "git push origin",
        "git push -f origin HEAD",
        "git push --force",
        "git push --force-with-lease",
        "git push --delete origin feature",
        "git push origin HEAD:main",
        "git push upstream HEAD",
        "git push --mirror",
        "git push --no-verify origin HEAD",
        "git rebase --abort",
        "git rebase main",
        "git rebase",
        "git rebase -i HEAD~3",
    ] {
        assert!(!git_words_are_routine(&words(cmd)), "{cmd}");
    }
}
