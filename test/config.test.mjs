import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { findConfigPath, readProjectConfig } from '../src/config.mjs';

test('discovers .linear.toml from the Git repository root', async t => {
  const root = await mkdtemp(join(tmpdir(), 'linear-config-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(join(root, '.linear.toml'), 'team_id = "ENG"\nworkspace = "acme"\n');
  const nested = join(root, 'packages', 'app');
  await mkdir(nested, { recursive: true });

  assert.equal(findConfigPath(nested), join(await realpath(root), '.linear.toml'));
  assert.deepEqual(readProjectConfig(nested), { team: 'ENG', workspace: 'acme' });
});

test('prefers a config in the current directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'linear-config-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  await writeFile(join(root, '.linear.toml'), 'team_id = "ROOT"\n');
  const nested = join(root, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, '.linear.toml'), 'team_id = "LOCAL"\n');

  assert.deepEqual(readProjectConfig(nested), { team: 'LOCAL', workspace: undefined });
});
