import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = new URL('../skills/linear/bin/linear.mjs', import.meta.url).pathname;
const HARNESS_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_CI',
  'CODEX_HOME',
  'CODEX_THREAD_ID',
  'CURSOR_AGENT',
  'LINEAR_AGENT_IDENTITY',
  'LINEAR_ACCESS_TOKEN',
  'LINEAR_API_KEY',
  'CLAUDE_LINEAR_ACCESS_TOKEN',
  'CODEX_LINEAR_ACCESS_TOKEN',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of HARNESS_KEYS) delete env[key];
  return { ...env, ...extra };
}

async function run(args, env) {
  const child = spawn(CLI, args, { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('detects Codex and uses its identity-specific token', async () => {
  const result = await run(['auth', 'status'], cleanEnv({ CODEX_THREAD_ID: 'test-thread', CODEX_LINEAR_ACCESS_TOKEN: 'lin_oauth_test' }));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    identity: 'codex',
    identitySource: 'Codex runtime',
    type: 'oauth',
    source: 'CODEX_LINEAR_ACCESS_TOKEN',
    hasRefreshToken: false,
  });
});

test('detects Claude Code and uses its identity-specific token', async () => {
  const result = await run(['auth', 'status'], cleanEnv({ CLAUDECODE: '1', CLAUDE_LINEAR_ACCESS_TOKEN: 'lin_oauth_test' }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).identity, 'claude');
});

test('detects Cursor Agent and uses its identity-specific token', async () => {
  const result = await run(['auth', 'status'], cleanEnv({ CURSOR_AGENT: '1', CURSOR_LINEAR_ACCESS_TOKEN: 'lin_oauth_test' }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).identity, 'cursor');
});

test('explicit identity wins over runtime detection', async () => {
  const result = await run(['auth', 'status', '--identity', 'reviewer'], cleanEnv({
    CODEX_THREAD_ID: 'test-thread',
    REVIEWER_LINEAR_ACCESS_TOKEN: 'lin_oauth_test',
  }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).identity, 'reviewer');
});

test('stored identity profile wins over an inherited identity token', async t => {
  const home = await mkdtemp(join(tmpdir(), 'linear-auth-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configDir = join(home, '.config', 'linear');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'credentials.toml'), `version = "2"

[identity.codex]
workspace = "test"
actor = "app"
access_token = "lin_oauth_stored"
refresh_token = "refresh-stored"
token_expiry = "2999-01-01T00:00:00.000Z"
`);

  const result = await run(['auth', 'status'], cleanEnv({
    HOME: home,
    CODEX_THREAD_ID: 'test-thread',
    CODEX_LINEAR_ACCESS_TOKEN: 'lin_oauth_inherited',
  }));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).hasRefreshToken, true);
});

test('mixed harness markers fail closed', async () => {
  const result = await run(['auth', 'status'], cleanEnv({ CODEX_THREAD_ID: 'test-thread', CLAUDECODE: '1' }));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /multiple harness markers/);
});

test('reads the detected identity client ID from .linear.toml', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'linear-config-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, '.linear.toml'), `[oauth.cursor]\nclient_id = "cursor-public-id"\n`);
  const port = 43000 + Math.floor(Math.random() * 1000);
  const child = spawn(CLI, ['auth', 'login', '--port', String(port)], { cwd, env: cleanEnv({ CURSOR_AGENT: '1' }) });
  t.after(() => child.kill('SIGTERM'));
  const url = await readLoginUrl(child);
  assert.equal(url.searchParams.get('client_id'), 'cursor-public-id');
});

test('uses the bundled public client ID as the final fallback', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'linear-public-client-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const child = spawn(CLI, ['auth', 'login', '--identity', 'other', '--port', String(port)], { cwd, env: cleanEnv() });
  t.after(() => child.kill('SIGTERM'));
  const url = await readLoginUrl(child);
  assert.equal(url.searchParams.get('client_id'), '797741a4d504939df7d793838d4160d4');
});

function readLoginUrl(child) {
  let stderr = '';
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for login URL: ${stderr}`)), 5000);
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/https:\/\/linear\.app\/oauth\/authorize\?\S+/);
      if (!match || !stderr.includes('Waiting for callback')) return;
      clearTimeout(timeout);
      resolve(new URL(match[0]));
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== null && code !== 0) reject(new Error(`Login process exited ${code}: ${stderr}`));
    });
  });
}

test('PKCE login URL uses an app actor and no client secret', async t => {
  const port = 42000 + Math.floor(Math.random() * 1000);
  const child = spawn(CLI, ['auth', 'login', '--identity', 'test', '--client-id', 'public-client-id', '--port', String(port)], {
    env: cleanEnv(),
  });
  t.after(() => child.kill('SIGTERM'));

  const url = await readLoginUrl(child);

  assert.equal(url.searchParams.get('client_id'), 'public-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${port}/callback`);
  assert.equal(url.searchParams.get('actor'), 'app');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.has('client_secret'), false);
});
