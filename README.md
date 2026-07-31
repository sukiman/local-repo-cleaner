# local-repo-cleaner

CLI tool that removes **local** git branches whose remote counterparts have already been deleted.

Requires **Node.js 18+** and **git**. No third-party dependencies.

## Features

- Deletes only local branches that tracked a remote branch now marked as **gone**
- Never deletes remote branches
- Skips local-only branches (no upstream)
- Skips the currently checked-out branch
- Optional filters: branch name prefix, author email
- Dry-run by default
- Interactive prompts for missing options
- Per-branch confirmation (`y` / `Y` / `n` / `N`)
- Accepts Windows and Unix path styles (`\`, `/`, `~`, mixed separators)

## Usage

```bash
node ./bin/clean-local-branches.js
```

Or:

```bash
npm start
```

### Examples

```bash
# Interactive (prompts for missing options; dry-run by default)
node ./bin/clean-local-branches.js

# Target a repo and preview matches with a prefix
node ./bin/clean-local-branches.js --dir C:\work\my-repo --prefix feature/

# Actually delete, filtered by author
node ./bin/clean-local-branches.js --dir ~/projects/app --author you@example.com --no-dry-run

# Force-delete unmerged local branches (still local-only)
node ./bin/clean-local-branches.js -d ./my-repo --no-dry-run --force
```

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-d`, `--dir`, `--target <path>` | Directory containing the repository | current working directory |
| `-p`, `--prefix <prefix>` | Only match branches whose name starts with this prefix | empty (all) |
| `-a`, `--author <email>` | Only match branches created by this author email | empty (any) |
| `-f`, `--force` / `--no-force` | Force-delete with `git branch -D` | `false` |
| `--dry-run` / `--no-dry-run` | Preview only; do not delete | `true` |
| `-h`, `--help` | Show help | |

You can also pass the target directory as a positional argument:

```bash
node ./bin/clean-local-branches.js C:\work\my-repo
```

Missing options are prompted interactively. Press **Enter** to accept the default.

## How it works

1. Resolves the target path and locates the git repository root (asks for confirmation if the given folder is not the root).
2. Runs `git fetch --all --prune` to refresh remote-tracking refs. This does **not** delete remote branches.
3. Finds local branches whose upstream is marked `[gone]`.
4. Applies optional prefix and author filters.
5. Asks for confirmation before each delete.
6. Prints a summary of deleted branches and remaining matched branches.

Author detection uses the oldest reflog author email for the branch, falling back to the tip commit author.

## Confirmation answers

For each matched branch:

| Answer | Meaning |
|--------|---------|
| `y` | Yes for this branch only |
| `Y` | Yes for this branch and all following matches |
| `n` | No for this branch only |
| `N` | No for this and all following (stop) |

## Safety notes

- Default mode is **dry-run** — nothing is deleted until you pass `--no-dry-run` (or answer `false` when prompted).
- The active branch is never deleted, even if it matches filters.
- With an empty prefix, the tool warns that the current branch cannot be deleted.
- `--force` only affects local delete (`-D` vs `-d`); remotes are never touched.

## Requirements

- Node.js `>= 18`
- `git` available on `PATH`
