import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { getCurrentIssue, resolveIssueReference } from '../src/current-issue.mjs';

async function issueRepo(t, branch = 'feature/eng-123-login') {
  const root = await mkdtemp(join(tmpdir(), 'linear-current-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['checkout', '--quiet', '-b', branch], { cwd: root });
  return root;
}

test('resolves the current issue from the Git branch', async t => {
  const root = await issueRepo(t);
  assert.deepEqual(getCurrentIssue(root), {
    identifier: 'ENG-123',
    branch: 'feature/eng-123-login',
    source: 'git-branch',
  });
  assert.equal(resolveIssueReference('current', root), 'ENG-123');
  assert.equal(resolveIssueReference('SM-42', root), 'SM-42');
});

test('fails when the branch has no issue identifier', async t => {
  const root = await issueRepo(t, 'feature/no-ticket');
  assert.throws(() => getCurrentIssue(root), /does not contain a Linear issue identifier/);
});

test('issue current does not require Linear authentication', async t => {
  const root = await issueRepo(t, 'fix/ops-77-timeout');
  const cli = new URL('../skills/linear/bin/linear.mjs', import.meta.url).pathname;
  const stdout = execFileSync(cli, ['issue', 'current'], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.deepEqual(JSON.parse(stdout), {
    identifier: 'OPS-77',
    branch: 'fix/ops-77-timeout',
    source: 'git-branch',
  });
});
