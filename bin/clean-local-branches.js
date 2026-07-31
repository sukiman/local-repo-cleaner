#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const DEFAULTS = {
  prefix: '',
  author: '',
  force: false,
  dryRun: true,
};

function createRl() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

function parseArgs(argv) {
  const result = {
    dir: undefined,
    prefix: undefined,
    author: undefined,
    force: undefined,
    dryRun: undefined,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };

    switch (arg) {
      case '-h':
      case '--help':
        result.help = true;
        break;
      case '-d':
      case '--dir':
      case '--target':
      case '--target-directory':
        result.dir = next();
        break;
      case '-p':
      case '--prefix':
        result.prefix = next() ?? '';
        break;
      case '-a':
      case '--author':
        result.author = next() ?? '';
        break;
      case '-f':
      case '--force':
        result.force = true;
        break;
      case '--no-force':
        result.force = false;
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--no-dry-run':
        result.dryRun = false;
        break;
      default:
        if (arg.startsWith('--dir=') || arg.startsWith('--target=') || arg.startsWith('--target-directory=')) {
          result.dir = arg.slice(arg.indexOf('=') + 1);
        } else if (arg.startsWith('--prefix=')) {
          result.prefix = arg.slice('--prefix='.length);
        } else if (arg.startsWith('--author=')) {
          result.author = arg.slice('--author='.length);
        } else if (arg.startsWith('--force=')) {
          result.force = parseBoolean(arg.slice('--force='.length), true);
        } else if (arg.startsWith('--dry-run=')) {
          result.dryRun = parseBoolean(arg.slice('--dry-run='.length), true);
        } else if (!arg.startsWith('-') && result.dir === undefined) {
          result.dir = arg;
        } else {
          console.error(`Unknown argument: ${arg}`);
          result.help = true;
        }
        break;
    }
  }

  return result;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function printHelp() {
  console.log(`Usage: local-repo-cleaner [options] [target-directory]

Remove local branches that track a remote branch which has already been deleted.

Options:
  -d, --dir, --target <path>   Target directory containing the repository
  -p, --prefix <prefix>        Only match local branches starting with this prefix
  -a, --author <email>         Only match branches created by this author email
  -f, --force                  Force-delete local branches (git branch -D)
      --no-force               Do not force-delete (default)
      --dry-run                Preview only; do not delete (default)
      --no-dry-run             Actually delete confirmed branches
  -h, --help                   Show this help

Missing options are prompted interactively. Defaults:
  prefix   = (empty)
  author   = (empty)
  force    = false
  dry-run  = true

Confirmation answers while deleting:
  y  yes for this branch only
  Y  yes for this and all following branches
  n  no for this branch only
  N  no for this and all following branches (stop)
`);
}

/**
 * Normalize any path convention (\, /, mixed) to an absolute OS-native path.
 */
function normalizeTargetPath(inputPath) {
  if (!inputPath || !String(inputPath).trim()) {
    return process.cwd();
  }

  let raw = String(inputPath).trim();

  // Expand ~
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(2));
  }

  // Normalize separators then resolve to absolute
  const withNativeSeps = raw.replace(/[\\/]+/g, path.sep);
  return path.resolve(withNativeSeps);
}

function runGit(repoRoot, args, options = {}) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });

  return {
    status: result.status ?? 1,
    stdout: (result.stdout || '').trimEnd(),
    stderr: (result.stderr || '').trimEnd(),
    error: result.error,
  };
}

function isGitRepo(dir) {
  const result = runGit(dir, ['rev-parse', '--is-inside-work-tree']);
  return result.status === 0 && result.stdout.trim() === 'true';
}

function findGitRoot(dir) {
  const result = runGit(dir, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) {
    return null;
  }
  // Git always returns forward slashes; normalize for the current OS
  return path.resolve(result.stdout.trim().replace(/[\\/]+/g, path.sep));
}

async function promptMissingOptions(rl, args) {
  const options = { ...args };

  if (options.dir === undefined) {
    const answer = await ask(rl, `Target directory [${process.cwd()}]: `);
    options.dir = answer.trim() === '' ? process.cwd() : answer.trim();
  }

  if (options.prefix === undefined) {
    const answer = await ask(rl, 'Branch name prefix (empty = all matching) []: ');
    options.prefix = answer.trim();
    console.warn(
      'Note: the currently checked-out branch cannot be deleted and will be skipped if matched.'
    );
  }

  if (options.author === undefined) {
    const answer = await ask(rl, 'Author email filter (empty = any) []: ');
    options.author = answer.trim();
  }

  if (options.force === undefined) {
    const answer = await ask(rl, 'Force delete? (true/false) [false]: ');
    options.force = answer.trim() === '' ? DEFAULTS.force : parseBoolean(answer, DEFAULTS.force);
  }

  if (options.dryRun === undefined) {
    const answer = await ask(rl, 'Dry run? (true/false) [true]: ');
    options.dryRun = answer.trim() === '' ? DEFAULTS.dryRun : parseBoolean(answer, DEFAULTS.dryRun);
  }

  return options;
}

/**
 * Resolve author email used as "branch creator".
 * Prefer oldest reflog entry author; fall back to tip commit author.
 */
function getBranchCreatorEmail(repoRoot, branchName) {
  const reflog = runGit(repoRoot, [
    'reflog',
    'show',
    '--format=%ae',
    branchName,
  ]);

  if (reflog.status === 0 && reflog.stdout.trim()) {
    const lines = reflog.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) {
      return lines[lines.length - 1].trim().toLowerCase();
    }
  }

  const tip = runGit(repoRoot, ['log', '-1', '--format=%ae', branchName]);
  if (tip.status === 0 && tip.stdout.trim()) {
    return tip.stdout.trim().toLowerCase();
  }

  return '';
}

/**
 * Local branches that have an upstream configured and that upstream is gone.
 * Never includes local-only branches (no upstream).
 */
function findGoneRemoteLocalBranches(repoRoot) {
  // Refresh remote-tracking refs so ": gone" is accurate.
  // This does NOT delete any remote branches — only stale local remote-tracking refs.
  const fetch = runGit(repoRoot, ['fetch', '--all', '--prune']);
  if (fetch.status !== 0) {
    console.warn(
      `Warning: git fetch --prune failed; detection may be stale.\n${fetch.stderr || fetch.error || ''}`
    );
  }

  const listed = runGit(repoRoot, [
    'for-each-ref',
    '--format=%(refname:short)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)',
    'refs/heads',
  ]);

  if (listed.status !== 0) {
    throw new Error(`Failed to list local branches:\n${listed.stderr || listed.error}`);
  }

  const branches = [];
  const lines = listed.stdout ? listed.stdout.split(/\r?\n/).filter(Boolean) : [];

  for (const line of lines) {
    const [name, upstream, track, tip] = line.split('\0');
    if (!name) continue;

    // Must have (or have had) an upstream configured
    if (!upstream) continue;

    // Only branches whose remote tracking ref is gone
    const trackStatus = (track || '').toLowerCase();
    if (!trackStatus.includes('gone')) continue;

    branches.push({
      name,
      upstream,
      tip: tip || '',
    });
  }

  return branches;
}

function getCurrentBranch(repoRoot) {
  const result = runGit(repoRoot, ['branch', '--show-current']);
  if (result.status === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  // Detached HEAD
  return '';
}

function filterBranches(branches, { prefix, author, repoRoot, currentBranch }) {
  const matched = [];
  const skipped = [];

  for (const branch of branches) {
    if (prefix && !branch.name.startsWith(prefix)) {
      continue;
    }

    if (author) {
      const creator = getBranchCreatorEmail(repoRoot, branch.name);
      if (creator !== author.trim().toLowerCase()) {
        continue;
      }
      branch.author = creator;
    } else {
      branch.author = getBranchCreatorEmail(repoRoot, branch.name);
    }

    if (currentBranch && branch.name === currentBranch) {
      skipped.push({ ...branch, reason: 'currently checked out (cannot delete active branch)' });
      continue;
    }

    matched.push(branch);
  }

  return { matched, skipped };
}

async function confirmDelete(rl, branch, autoYes, autoNo) {
  if (autoYes) return { action: 'yes', autoYes: true, autoNo: false };
  if (autoNo) return { action: 'no', autoYes: false, autoNo: true };

  while (true) {
    const answer = await ask(
      rl,
      `Delete local branch "${branch.name}" (upstream ${branch.upstream} is gone)? [y/Y/n/N]: `
    );
    const trimmed = answer.trim();

    if (trimmed === 'y') return { action: 'yes', autoYes: false, autoNo: false };
    if (trimmed === 'Y') return { action: 'yes', autoYes: true, autoNo: false };
    if (trimmed === 'n') return { action: 'no', autoYes: false, autoNo: false };
    if (trimmed === 'N') return { action: 'no', autoYes: false, autoNo: true };

    console.log('Please answer with y, Y, n, or N.');
  }
}

function deleteLocalBranch(repoRoot, branchName, force) {
  const flag = force ? '-D' : '-d';
  const result = runGit(repoRoot, ['branch', flag, branchName]);
  return {
    ok: result.status === 0,
    message: result.stdout || result.stderr || (result.error && result.error.message) || '',
  };
}

function printSummary({ deleted, remaining, skippedActive, dryRun }) {
  console.log('');
  console.log('='.repeat(60));
  console.log(dryRun ? 'Dry-run summary' : 'Summary');
  console.log('='.repeat(60));

  console.log('');
  console.log(dryRun ? `Would delete (${deleted.length}):` : `Deleted (${deleted.length}):`);
  if (deleted.length === 0) {
    console.log('  (none)');
  } else {
    for (const b of deleted) {
      console.log(`  - ${b.name}  (was tracking ${b.upstream})`);
    }
  }

  console.log('');
  console.log(`Remaining matched branches (${remaining.length}):`);
  if (remaining.length === 0) {
    console.log('  (none)');
  } else {
    for (const b of remaining) {
      const reason = b.reason ? ` — ${b.reason}` : '';
      console.log(`  - ${b.name}  (was tracking ${b.upstream})${reason}`);
    }
  }

  if (skippedActive.length > 0) {
    console.log('');
    console.log(`Skipped (active branch) (${skippedActive.length}):`);
    for (const b of skippedActive) {
      console.log(`  - ${b.name}  — ${b.reason}`);
    }
  }

  console.log('');
}

function ensureGitAvailable() {
  const result = spawnSync('git', ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error
      ? result.error.message
      : result.stderr || 'git --version failed';
    throw new Error(`git is required but was not found or failed to run.\n${detail}`);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  ensureGitAvailable();

  const rl = createRl();

  try {
    const options = await promptMissingOptions(rl, parsed);
    const targetDir = normalizeTargetPath(options.dir);

    if (!fs.existsSync(targetDir)) {
      console.error(`Target directory does not exist: ${targetDir}`);
      process.exitCode = 1;
      return;
    }

    if (!fs.statSync(targetDir).isDirectory()) {
      console.error(`Target path is not a directory: ${targetDir}`);
      process.exitCode = 1;
      return;
    }

    let repoRoot = null;

    if (isGitRepo(targetDir)) {
      repoRoot = findGitRoot(targetDir);
      if (!repoRoot) {
        console.error(`Unable to determine git root for: ${targetDir}`);
        process.exitCode = 1;
        return;
      }

      const normalizedTarget = path.resolve(targetDir);
      if (path.resolve(repoRoot) !== normalizedTarget) {
        console.log(`Given path is inside a repository.`);
        console.log(`  Given : ${normalizedTarget}`);
        console.log(`  Root  : ${repoRoot}`);
        const confirm = await ask(rl, 'Use the repository root folder? [Y/n]: ');
        const answer = confirm.trim();
        if (answer !== '' && !['y', 'Y', 'yes', 'YES'].includes(answer)) {
          console.error('Aborted by user.');
          process.exitCode = 1;
          return;
        }
      }
    } else {
      // Try walking up / asking git from parent context — git rev-parse from a
      // non-repo folder fails, so attempt parents manually.
      let probe = targetDir;
      let found = null;
      while (true) {
        if (isGitRepo(probe)) {
          found = findGitRoot(probe);
          break;
        }
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }

      if (!found) {
        console.error(
          `The target folder is not a git repository, and no repository root could be found:\n  ${targetDir}`
        );
        process.exitCode = 1;
        return;
      }

      console.log(`Target folder is not a repo root. Found repository root:`);
      console.log(`  ${found}`);
      const confirm = await ask(rl, 'Use this repository root? [Y/n]: ');
      const answer = confirm.trim();
      if (answer !== '' && !['y', 'Y', 'yes', 'YES'].includes(answer)) {
        console.error('Aborted by user.');
        process.exitCode = 1;
        return;
      }
      repoRoot = found;
    }

    console.log('');
    console.log(`Repository : ${repoRoot}`);
    console.log(`Prefix     : ${options.prefix === '' ? '(none)' : options.prefix}`);
    console.log(`Author     : ${options.author === '' ? '(any)' : options.author}`);
    console.log(`Force      : ${options.force}`);
    console.log(`Dry run    : ${options.dryRun}`);
    console.log('');

    if (!options.prefix) {
      console.warn(
        'Warning: no branch prefix set. Matching all gone-remote local branches. The active branch cannot be deleted.'
      );
      console.log('');
    }

    const currentBranch = getCurrentBranch(repoRoot);
    if (currentBranch) {
      console.log(`Current branch: ${currentBranch}`);
    } else {
      console.log('Current branch: (detached HEAD)');
    }
    console.log('Looking for local branches whose remote is gone...');
    console.log('');

    const goneBranches = findGoneRemoteLocalBranches(repoRoot);
    const { matched, skipped: skippedActive } = filterBranches(goneBranches, {
      prefix: options.prefix,
      author: options.author,
      repoRoot,
      currentBranch,
    });

    if (matched.length === 0) {
      console.log('No matching local branches with a deleted remote were found.');
      printSummary({
        deleted: [],
        remaining: [],
        skippedActive,
        dryRun: options.dryRun,
      });
      return;
    }

    console.log(`Found ${matched.length} matching branch(es):`);
    for (const b of matched) {
      const authorInfo = b.author ? `, author ${b.author}` : '';
      console.log(`  - ${b.name}  [tracking ${b.upstream}: gone]${authorInfo}`);
    }
    console.log('');

    const deleted = [];
    const remaining = [];
    let autoYes = false;
    let autoNo = false;

    for (const branch of matched) {
      if (autoNo) {
        remaining.push({ ...branch, reason: 'skipped (N — stop all)' });
        continue;
      }

      const decision = await confirmDelete(rl, branch, autoYes, autoNo);
      autoYes = decision.autoYes;
      autoNo = decision.autoNo;

      if (decision.action === 'no') {
        remaining.push({
          ...branch,
          reason: autoNo ? 'skipped (N — stop all)' : 'skipped by user (n)',
        });
        if (autoNo) {
          // Mark any not-yet-processed branches as remaining when we break early
          // (handled by autoNo on subsequent iterations)
        }
        continue;
      }

      if (options.dryRun) {
        console.log(`[dry-run] Would delete local branch: ${branch.name}`);
        deleted.push(branch);
        continue;
      }

      const result = deleteLocalBranch(repoRoot, branch.name, options.force);
      if (result.ok) {
        console.log(`Deleted local branch: ${branch.name}`);
        deleted.push(branch);
      } else {
        console.error(`Failed to delete "${branch.name}": ${result.message}`);
        remaining.push({ ...branch, reason: `delete failed: ${result.message}` });
      }
    }

    printSummary({
      deleted,
      remaining,
      skippedActive,
      dryRun: options.dryRun,
    });
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
