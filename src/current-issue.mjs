import { execFileSync } from 'node:child_process';

const ISSUE_IDENTIFIER = /\b([a-zA-Z0-9]+)-([1-9][0-9]*)\b/;

export function getCurrentIssue(cwd = process.cwd()) {
  let branch;
  try {
    branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error('Cannot determine the current issue outside a Git worktree');
  }

  if (!branch) throw new Error('Cannot determine the current issue from a detached HEAD');
  const match = branch.match(ISSUE_IDENTIFIER);
  if (!match) throw new Error(`Current branch does not contain a Linear issue identifier: ${branch}`);

  return {
    identifier: `${match[1].toUpperCase()}-${match[2]}`,
    branch,
    source: 'git-branch',
  };
}

export function resolveIssueReference(reference, cwd = process.cwd()) {
  return reference.toLowerCase() === 'current'
    ? getCurrentIssue(cwd).identifier
    : reference;
}
