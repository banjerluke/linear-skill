import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function findConfigPath(cwd = process.cwd()) {
  const currentDir = resolve(cwd);
  const localPath = join(currentDir, '.linear.toml');
  if (existsSync(localPath)) return localPath;

  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: currentDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const rootPath = join(root, '.linear.toml');
    if (root !== currentDir && existsSync(rootPath)) return rootPath;
  } catch {
    // Commands outside a Git worktree simply have no repository config.
  }

  return undefined;
}

export function readProjectConfig(cwd = process.cwd()) {
  const path = findConfigPath(cwd);
  if (!path) return {};
  const content = readFileSync(path, 'utf8');
  return {
    team: content.match(/^team_id\s*=\s*"(.+?)"/m)?.[1],
    workspace: content.match(/^workspace\s*=\s*"(.+?)"/m)?.[1],
  };
}
