import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = new URL('../skills/linear/bin/linear.mjs', import.meta.url).pathname;
const CLEAN_HOME = join(tmpdir(), `linear-auth-clean-${process.pid}`);
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
  'CLAUDE_LINEAR_API_KEY',
  'CLAUDE_LINEAR_OAUTH_CLIENT_ID',
  'CODEX_LINEAR_ACCESS_TOKEN',
  'CODEX_LINEAR_API_KEY',
  'CODEX_LINEAR_OAUTH_CLIENT_ID',
  'CURSOR_LINEAR_ACCESS_TOKEN',
  'CURSOR_LINEAR_API_KEY',
  'CURSOR_LINEAR_OAUTH_CLIENT_ID',
  'LINEAR_OAUTH_CLIENT_ID',
];

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of HARNESS_KEYS) delete env[key];
  return { ...env, HOME: CLEAN_HOME, ...extra };
}

async function run(args, env, cwd) {
  const child = spawn(CLI, args, { env, cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  return { code, stdout, stderr };
}

test('auth login --help explains assisted login without starting OAuth', async () => {
  const result = await run(['auth', 'login', '--help'], cleanEnv());
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Keep the\s+process running/);
  assert.match(result.stdout, /full localhost callback URL/);
  assert.match(result.stdout, /--all/);
  assert.match(result.stdout, /Cancel and Manage/);
  assert.match(result.stdout, /Never ask the user.*password, API key, or access token/);
  assert.doesNotMatch(result.stderr, /linear\.app\/oauth\/authorize/);
});

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

test('auth login --all skips configured identities that already have credentials', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'linear-all-config-test-'));
  const home = await mkdtemp(join(tmpdir(), 'linear-all-home-test-'));
  t.after(() => Promise.all([
    rm(cwd, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]));
  await writeFile(join(cwd, '.linear.toml'), `[oauth.codex]
client_id = "codex-public-id"

[oauth.claude]
client_id = "claude-public-id"
`);
  const configDir = join(home, '.config', 'linear');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'credentials.toml'), `version = "2"

[identity.codex]
access_token = "lin_oauth_stored"
refresh_token = "refresh-stored"
token_expiry = "2999-01-01T00:00:00.000Z"
`);

  const result = await run(['auth', 'login', '--all'], cleanEnv({
    HOME: home,
    CLAUDE_LINEAR_ACCESS_TOKEN: 'lin_oauth_claude',
  }), cwd);
  const expectedConfigPath = await realpath(join(cwd, '.linear.toml'));
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    success: true,
    configPath: expectedConfigPath,
    authenticated: [],
    skipped: [
      { identity: 'codex', source: 'stored profile' },
      { identity: 'claude', source: 'CLAUDE_LINEAR_ACCESS_TOKEN' },
    ],
    failed: [],
  });
  assert.match(result.stderr, new RegExp(`Using Linear configuration: ${expectedConfigPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(result.stderr, /linear\.app\/oauth\/authorize/);
});

test('auth login --all rejects per-identity options', async () => {
  const result = await run(['auth', 'login', '--all', '--identity', 'codex'], cleanEnv());
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot be combined with --identity/);
});

test('auth login rejects --force without --all', async () => {
  const result = await run(['auth', 'login', '--force', '--identity', 'codex'], cleanEnv());
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--force is valid only with --all/);
});

test('does not silently fall back to the bundled generic app', async () => {
  const result = await run(['auth', 'login', '--identity', 'other'], cleanEnv());
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No OAuth client ID configured.*other/);
  assert.match(result.stderr, /--use-generic-app/);
  assert.doesNotMatch(result.stderr, /linear\.app\/oauth\/authorize/);
});

test('uses the bundled public client ID only when explicitly requested', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'linear-public-client-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const child = spawn(CLI, ['auth', 'login', '--identity', 'other', '--use-generic-app', '--port', String(port)], { cwd, env: cleanEnv() });
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
      if (!match || (!stderr.includes('Waiting for callback') && !stderr.includes('Callback URL:'))) return;
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
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.deepEqual(url.searchParams.get('scope').split(','), [
    'read',
    'write',
    'app:assignable',
    'app:mentionable',
    'customer:read',
    'customer:write',
    'initiative:read',
    'initiative:write',
  ]);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.has('client_secret'), false);
});

test('login accepts a pasted callback while waiting on localhost', async t => {
  const port = 45000 + Math.floor(Math.random() * 1000);
  const child = spawn(CLI, ['auth', 'login', '--identity', 'test', '--client-id', 'public-client-id', '--port', String(port)], {
    env: cleanEnv(),
  });
  t.after(() => child.kill('SIGTERM'));

  const url = await readLoginUrl(child);
  assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:${port}/callback`);

  child.stdin.write(`http://localhost:${port}/callback?code=test-code&state=wrong-state\n`);
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});

test('login still accepts an HTTP callback on localhost', async t => {
  const port = 46000 + Math.floor(Math.random() * 1000);
  const child = spawn(CLI, ['auth', 'login', '--identity', 'test', '--client-id', 'public-client-id', '--port', String(port)], {
    env: cleanEnv(),
  });
  t.after(() => child.kill('SIGTERM'));

  await readLoginUrl(child);
  const response = await fetch(`http://localhost:${port}/callback?code=test-code&state=wrong-state`);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), 'State mismatch');
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
});
