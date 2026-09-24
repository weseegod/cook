# Clone repositories with Grove

`cook clone` fetches a Git repository through Grove and mounts a projected
working tree. It uses NFS on macOS and FUSE on Linux. Windows is not supported.

## Enable cloning

Cloning is off by default. Enable it with one of these options:

```bash
export GROK_CLONE=1
# or set [clone] enabled = true in your Grove config
```

Then clone a repository:

```bash
cook clone <url> [dir] [--branch NAME] [--cone PATH]... [--full-history]
```

By default, Cook downloads only the latest commit from the selected branch.
Use `--full-history` to download its complete history, tags, and other remote
branches.

You can also enable Grove for cloning and session worktrees together with
`GROK_GROVE=1` or `[cli] grove = true` in `~/.cook/config.toml`. The specific
clone and worktree settings still take priority. See the
[configuration reference](26-config-reference.md#cli) for details.

## Fetch more history

After a shallow clone, these commands download more history for the selected
branch:

```bash
git fetch --deepen=N origin
git fetch --unshallow origin
```

To fetch another branch, use an explicit refspec:

```bash
git fetch --depth=1 origin refs/heads/NAME:refs/remotes/origin/NAME
```

## Authentication

Cook sign-in is for model access. It does not sign you in to GitHub or other Git
hosts, and `cook clone` does not read `~/.cook/auth.json` for Git credentials.
Use your Git credential manager or `gh auth` to sign in to the remote.

If Grove reports a credential problem, run `grove status` to see which Git
credential provider it is using. After you update your Git credentials, run:

```bash
grove reload-credentials
```

For Cook model sign-in options, see [Authentication](02-authentication.md).

## Platform requirements

- **macOS:** Grove uses NFS.
- **Linux:** Grove uses FUSE. Make sure `/dev/fuse` is available and your user
  can access it.
- **Windows:** Use `git clone` instead.
