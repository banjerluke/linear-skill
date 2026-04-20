#!/usr/bin/env -S node --experimental-strip-types
// Linear API CLI — wraps @linear/sdk for ergonomic JSON access
// Usage: <this-file> <resource> <action> [options]

import { LinearClient } from '@linear/sdk';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

// ═══════════════════════════════ Helpers ═══════════════════════════════

type Opts = Record<string, string | string[] | true>;
type Config = { team?: string; workspace?: string };

function die(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

function out(data: unknown, compact = false): void {
  console.log(compact ? JSON.stringify(data) : JSON.stringify(data, null, 2));
}

function stripEmpty(obj: Record<string, any>): Record<string, any> {
  const r: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    r[k] = v;
  }
  return r;
}

function outList(nodes: any[], pageInfo: any) {
  if (pageInfo?.hasNextPage) out({ nodes, pageInfo: { endCursor: pageInfo.endCursor } }, true);
  else out(nodes, true);
}

async function safe<T>(fn: () => T | Promise<T>): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

const isUUID = (s: string) => /^[0-9a-f]{8}-/.test(s);

// ═══════════════════════════════ Hashline ═══════════════════════════════

const HASH_ALPHA = 'ZPMQVRWSNKTXJBYH';

function lineHash(line: string, idx: number): string {
  let input = line.trimEnd();
  if (!/\S/.test(input)) input = `\0${idx}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const byte = (h >>> 0) & 0xff;
  return HASH_ALPHA[byte >> 4] + HASH_ALPHA[byte & 0xf];
}

function formatHashlines(text: string): string {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines.map((line, i) => {
    const num = String(i + 1).padStart(width);
    const hash = lineHash(line, i);
    return `${num}#${hash}:${line}`;
  }).join('\n');
}

type EditOp = {
  op: 'replace' | 'append' | 'prepend' | 'delete';
  lineNum: number;
  hash: string;
  lines: string[];
};

function parseEdits(text: string): EditOp[] {
  const edits: EditOp[] = [];
  const raw = text.split('\n');
  let i = 0;
  while (i < raw.length) {
    const line = raw[i];
    if (!line.trim()) { i++; continue; }
    const m = line.match(/^(replace|append|prepend|delete)\s+(\d+)#([A-Z]{2})(?::(.*))?$/);
    if (!m) die(`Invalid edit line ${i + 1}: ${JSON.stringify(line)}`);
    const [, op, num, hash, rest] = m;
    const lineNum = parseInt(num);
    let lines: string[];
    if (rest === '<<<') {
      // Heredoc: collect until closing >>>
      const start = i + 1;
      i++;
      while (i < raw.length && raw[i] !== '>>>') i++;
      if (i >= raw.length) die(`Unclosed heredoc starting at line ${start}`);
      lines = raw.slice(start, i);
    } else if (rest != null) {
      lines = [rest];
    } else {
      lines = [];
    }
    if (op !== 'delete' && lines.length === 0) die(`"${op}" at ${num}#${hash} requires content after :`);
    edits.push({ op: op as EditOp['op'], lineNum, hash, lines });
    i++;
  }
  if (edits.length === 0) die('No edit operations found');
  return edits;
}

function applyEdits(content: string, edits: EditOp[]): string {
  const lines = content.split('\n');

  // Validate all anchors before applying any edits
  for (const edit of edits) {
    const idx = edit.lineNum - 1;
    if (idx < 0 || idx >= lines.length) die(`Line ${edit.lineNum} out of range (content has ${lines.length} lines)`);
    const actual = lineHash(lines[idx], idx);
    if (actual !== edit.hash) die(`Hash mismatch at line ${edit.lineNum}: expected #${edit.hash} but got #${actual}. Current content: ${JSON.stringify(lines[idx])}`);
  }

  // Sort by line number descending so index shifts don't affect later edits
  const sorted = [...edits].sort((a, b) => b.lineNum - a.lineNum);

  for (const edit of sorted) {
    const idx = edit.lineNum - 1;
    switch (edit.op) {
      case 'replace':
        lines.splice(idx, 1, ...edit.lines);
        break;
      case 'append':
        lines.splice(idx + 1, 0, ...edit.lines);
        break;
      case 'prepend':
        lines.splice(idx, 0, ...edit.lines);
        break;
      case 'delete':
        lines.splice(idx, 1);
        break;
    }
  }

  return lines.join('\n');
}

function o(opts: Opts, key: string): string | undefined {
  const v = opts[key]; return typeof v === 'string' ? v : undefined;
}
function oArr(opts: Opts, key: string): string[] {
  const v = opts[key];
  return Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
}
function oBool(opts: Opts, key: string): boolean {
  return opts[key] === true || opts[key] === 'true';
}
function oInt(opts: Opts, key: string): number | undefined {
  const v = o(opts, key); return v ? parseInt(v) : undefined;
}

// ═══════════════════════════════ Auth & Config ═══════════════════════════════

type Auth = { apiKey: string } | { accessToken: string };

const CREDENTIALS_PATH = join(homedir(), '.config', 'linear', 'credentials.toml');

function readSection(content: string, name: string): Record<string, string> {
  const start = content.indexOf(`[${name}]`);
  if (start === -1) return {};
  const afterHeader = content.indexOf('\n', start);
  if (afterHeader === -1) return {};
  const nextSection = content.indexOf('\n[', afterHeader);
  const block = nextSection === -1 ? content.slice(afterHeader) : content.slice(afterHeader, nextSection);
  const kv: Record<string, string> = {};
  for (const m of block.matchAll(/^(\w+)\s*=\s*"(.+?)"/gm)) kv[m[1]] = m[2];
  return kv;
}

function writeCredentials(workspace: string, fields: Record<string, string>): void {
  const dir = join(homedir(), '.config', 'linear');
  mkdirSync(dir, { recursive: true });
  const lines = [`default = "${workspace}"`, '', `[${workspace}]`];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k} = "${v}"`);
  writeFileSync(CREDENTIALS_PATH, lines.join('\n') + '\n');
}

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  if (!res.ok) die(`Token refresh failed: ${res.status} ${await res.text()}`);
  return res.json() as any;
}

function looksLikeOAuthToken(token: string): boolean {
  return token.startsWith('lin_oaut');
}

function getEnvAuth(): Auth | null {
  const accessToken = process.env.LINEAR_ACCESS_TOKEN?.trim();
  if (accessToken) return { accessToken };

  const token = process.env.LINEAR_API_KEY?.trim();
  if (!token) return null;
  if (looksLikeOAuthToken(token)) return { accessToken: token };
  return { apiKey: token };
}

function getAuth(): Auth {
  const envAuth = getEnvAuth();
  if (envAuth) return envAuth;

  if (!existsSync(CREDENTIALS_PATH)) die('Not authenticated. Run `linear auth login --client-id <id> --client-secret <secret>` or set LINEAR_API_KEY / LINEAR_ACCESS_TOKEN.');
  const c = readFileSync(CREDENTIALS_PATH, 'utf-8');
  const ws = c.match(/^default\s*=\s*"(.+?)"/m)?.[1];
  if (!ws) die('Cannot parse default workspace from credentials.toml');
  const section = readSection(c, ws);
  // Section-based OAuth credentials
  if (section.access_token) {
    return { accessToken: section.access_token };
  }
  // Legacy flat format: workspace = "token"
  const token = c.match(new RegExp(`^${ws}\\s*=\\s*"(.+?)"`, 'm'))?.[1];
  if (!token) die(`No credentials for workspace "${ws}"`);
  if (looksLikeOAuthToken(token)) return { accessToken: token };
  return { apiKey: token };
}

async function getAuthWithRefresh(): Promise<Auth> {
  const envAuth = getEnvAuth();
  if (envAuth) return envAuth;

  const auth = getAuth();
  if ('apiKey' in auth) return auth;
  // Check if OAuth token needs refresh
  const c = readFileSync(CREDENTIALS_PATH, 'utf-8');
  const ws = c.match(/^default\s*=\s*"(.+?)"/m)?.[1]!;
  const section = readSection(c, ws);
  if (section.token_expiry) {
    const expiry = new Date(section.token_expiry);
    // Refresh if token expires within 5 minutes
    if (expiry.getTime() - Date.now() < 5 * 60 * 1000) {
      if (!section.refresh_token || !section.client_id || !section.client_secret) die('Cannot refresh token: missing refresh_token, client_id, or client_secret in credentials');
      const tokens = await refreshAccessToken(section.refresh_token, section.client_id, section.client_secret);
      const newExpiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
      writeCredentials(ws, { ...section, access_token: tokens.access_token, refresh_token: tokens.refresh_token, token_expiry: newExpiry });
      return { accessToken: tokens.access_token };
    }
  }
  return auth;
}

function getConfig(): Config {
  const p = join(process.cwd(), '.linear.toml');
  if (!existsSync(p)) return {};
  const c = readFileSync(p, 'utf-8');
  return {
    team: c.match(/^team_id\s*=\s*"(.+?)"/m)?.[1],
    workspace: c.match(/^workspace\s*=\s*"(.+?)"/m)?.[1],
  };
}

// ═══════════════════════════════ CLI Parser ═══════════════════════════════

function parseArgs(): { resource: string; action: string; pos: string[]; opts: Opts } {
  const [resource, action, ...rest] = process.argv.slice(2);
  if (!resource || !action) die('Usage: linear <resource> <action> [options]\nResources: issue comment label project project-update document initiative initiative-update milestone team user cycle status attachment relation graphql auth');
  const pos: string[] = [];
  const opts: Opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) {
      const key = rest[i].slice(2);
      if (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
        const ex = opts[key];
        opts[key] = ex ? (Array.isArray(ex) ? [...ex, rest[++i]] : [ex as string, rest[++i]]) : rest[++i];
      } else opts[key] = true;
    } else pos.push(rest[i]);
  }
  return { resource, action, pos, opts };
}

function pagVars(opts: Opts) {
  return {
    first: oInt(opts, 'limit') ?? 50,
    ...(o(opts, 'cursor') && { after: o(opts, 'cursor') }),
    ...(oBool(opts, 'include-archived') && { includeArchived: true }),
  };
}

// ═══════════════════════════════ Resolvers ═══════════════════════════════

const _c = new Map<string, string>();

async function rTeam(client: LinearClient, ref: string | undefined, config: Config): Promise<string | undefined> {
  const key = ref || config.team;
  if (!key) return undefined;
  const ck = `t:${key}`;
  if (_c.has(ck)) return _c.get(ck)!;
  if (isUUID(key)) { _c.set(ck, key); return key; }
  const teams = await client.teams();
  const t = teams.nodes.find(t => t.key === key || t.name.toLowerCase() === key.toLowerCase());
  if (!t) die(`Team not found: ${key}`);
  _c.set(ck, t.id); return t.id;
}

async function rUser(client: LinearClient, ref: string): Promise<string> {
  const ck = `u:${ref}`;
  if (_c.has(ck)) return _c.get(ck)!;
  if (ref === 'me') { const me = await client.viewer; _c.set(ck, me.id); return me.id; }
  if (isUUID(ref)) { _c.set(ck, ref); return ref; }
  const users = await client.users({ filter: { or: [{ name: { containsIgnoreCase: ref } }, { email: { eq: ref } }] } });
  if (!users.nodes.length) die(`User not found: ${ref}`);
  _c.set(ck, users.nodes[0].id); return users.nodes[0].id;
}

async function rIssue(client: LinearClient, ref: string): Promise<string> {
  const ck = `i:${ref}`;
  if (_c.has(ck)) return _c.get(ck)!;
  if (isUUID(ref)) { _c.set(ck, ref); return ref; }
  if (/^[A-Z]+-\d+$/i.test(ref)) {
    const found = await client.issueVcsBranchSearch(ref);
    if (found) { _c.set(ck, found.id); return found.id; }
  }
  die(`Issue not found: ${ref}`);
}

async function rProject(client: LinearClient, ref: string): Promise<string> {
  const ck = `p:${ref}`;
  if (_c.has(ck)) return _c.get(ck)!;
  if (isUUID(ref)) { _c.set(ck, ref); return ref; }
  const ps = await client.projects({ filter: { or: [{ name: { eq: ref } }, { name: { containsIgnoreCase: ref } }, { slugId: { eq: ref } }] } });
  if (!ps.nodes.length) die(`Project not found: ${ref}`);
  _c.set(ck, ps.nodes[0].id); return ps.nodes[0].id;
}

const STATE_TYPES = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'];

async function rState(client: LinearClient, ref: string, teamId: string): Promise<string> {
  const ck = `s:${teamId}:${ref}`;
  if (_c.has(ck)) return _c.get(ck)!;
  if (isUUID(ref)) { _c.set(ck, ref); return ref; }
  const isType = STATE_TYPES.includes(ref.toLowerCase());
  const ss = await client.workflowStates({
    filter: { team: { id: { eq: teamId } }, ...(isType ? { type: { eq: ref.toLowerCase() } } : { name: { containsIgnoreCase: ref } }) },
  });
  if (!ss.nodes.length) die(`State not found: ${ref}`);
  _c.set(ck, ss.nodes[0].id); return ss.nodes[0].id;
}

async function rLabels(client: LinearClient, refs: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    if (isUUID(ref)) { ids.push(ref); continue; }
    const ck = `l:${ref}`;
    if (_c.has(ck)) { ids.push(_c.get(ck)!); continue; }
    const ls = await client.issueLabels({ filter: { name: { eqIgnoreCase: ref } } });
    if (!ls.nodes.length) die(`Label not found: ${ref}`);
    _c.set(ck, ls.nodes[0].id); ids.push(ls.nodes[0].id);
  }
  return ids;
}

async function rCycle(client: LinearClient, ref: string, teamId: string): Promise<string> {
  if (isUUID(ref)) return ref;
  const filter: Record<string, unknown> = { team: { id: { eq: teamId } } };
  if (ref === 'current') (filter as any).isActive = { eq: true };
  else if (ref === 'next') (filter as any).isNext = { eq: true };
  else if (ref === 'previous') (filter as any).isPrevious = { eq: true };
  else if (/^\d+$/.test(ref)) (filter as any).number = { eq: parseInt(ref) };
  else (filter as any).name = { containsIgnoreCase: ref };
  const cs = await client.cycles({ filter });
  if (!cs.nodes.length) die(`Cycle not found: ${ref}`);
  return cs.nodes[0].id;
}

async function rInitiative(client: LinearClient, ref: string): Promise<string> {
  if (isUUID(ref)) return ref;
  const is = await client.initiatives({ filter: { name: { containsIgnoreCase: ref } } });
  if (!is.nodes.length) die(`Initiative not found: ${ref}`);
  return is.nodes[0].id;
}

async function rMilestone(client: LinearClient, ref: string, projectId?: string): Promise<string> {
  if (isUUID(ref)) return ref;
  const ms = await client.projectMilestones({
    filter: { name: { containsIgnoreCase: ref }, ...(projectId && { project: { id: { eq: projectId } } }) },
  });
  if (!ms.nodes.length) die(`Milestone not found: ${ref}`);
  return ms.nodes[0].id;
}

// Helper: get teamId from an issue (for updates where team isn't specified)
async function teamIdFromIssue(client: LinearClient, issueId: string, opts: Opts, config: Config): Promise<string> {
  const explicit = await rTeam(client, o(opts, 'team'), config);
  if (explicit) return explicit;
  const issue = await client.issue(issueId);
  const team = await issue.team;
  if (!team) die('Could not determine team for issue');
  return team.id;
}

// ═══════════════════════════════ Formatters ═══════════════════════════════

async function fIssue(n: any, full = false) {
  const [state, assignee, team, project, lblC, parent] = await Promise.all([
    safe(() => n.state), safe(() => n.assignee), safe(() => n.team),
    safe(() => n.project), safe(() => n.labels()), safe(() => n.parent),
  ]);
  const labels = ((lblC as any)?.nodes || []).map((l: any) => l.name);
  if (!full) {
    return stripEmpty({
      identifier: n.identifier, title: n.title,
      priority: n.priority || undefined,
      state: state ? { name: (state as any).name, type: (state as any).type } : null,
      assignee: assignee ? (assignee as any).name : null,
      labels,
      dueDate: n.dueDate,
    });
  }
  return stripEmpty({
    id: n.id, identifier: n.identifier, title: n.title,
    priority: n.priority || undefined,
    state: state ? { name: (state as any).name, type: (state as any).type } : null,
    assignee: assignee ? (assignee as any).name : null,
    labels, dueDate: n.dueDate, estimate: n.estimate || undefined,
    description: n.description, branchName: n.branchName,
    parent: parent ? { identifier: (parent as any).identifier, title: (parent as any).title } : null,
    team: team ? (team as any).key : null,
    project: project ? (project as any).name : null,
    url: n.url,
    createdAt: n.createdAt, updatedAt: n.updatedAt,
  });
}

async function fProject(n: any, full = false) {
  const [lead, status] = await Promise.all([safe(() => n.lead), safe(() => n.status)]);
  if (!full) {
    return stripEmpty({
      name: n.name, priority: n.priority || undefined,
      status: status ? (status as any).name : null,
      lead: lead ? (lead as any).name : null,
      startDate: n.startDate, targetDate: n.targetDate,
    });
  }
  return stripEmpty({
    id: n.id, name: n.name, priority: n.priority || undefined,
    status: status ? { name: (status as any).name, type: (status as any).type } : null,
    lead: lead ? (lead as any).name : null,
    description: n.description, content: n.content,
    startDate: n.startDate, targetDate: n.targetDate,
    url: n.url, slugId: n.slugId,
    createdAt: n.createdAt, updatedAt: n.updatedAt,
  });
}

async function fDoc(n: any, full = false) {
  const [project, creator] = await Promise.all([safe(() => n.project), safe(() => n.creator)]);
  if (!full) {
    return stripEmpty({
      title: n.title, icon: n.icon,
      project: project ? (project as any).name : null,
      updatedAt: n.updatedAt,
    });
  }
  return stripEmpty({
    id: n.id, title: n.title, icon: n.icon,
    project: project ? (project as any).name : null,
    creator: creator ? (creator as any).name : null,
    content: n.content, slugId: n.slugId,
    url: n.url, createdAt: n.createdAt,
  });
}

async function fInit(n: any, full = false) {
  const owner = await safe(() => n.owner);
  if (!full) {
    return stripEmpty({
      name: n.name, status: n.status,
      owner: owner ? (owner as any).name : null,
      targetDate: n.targetDate,
    });
  }
  return stripEmpty({
    id: n.id, name: n.name, status: n.status,
    owner: owner ? (owner as any).name : null,
    description: n.description,
    targetDate: n.targetDate,
    url: n.url, createdAt: n.createdAt, updatedAt: n.updatedAt,
  });
}

const fComment = async (n: any) => {
  const parent = await safe(() => n.parent);
  return stripEmpty({ id: n.id, parentId: parent ? (parent as any).id : null, body: n.body, createdAt: n.createdAt, url: n.url });
};
const fLabel = async (n: any) => { const parent = await safe(() => n.parent); return stripEmpty({ name: n.name, color: n.color, description: n.description, parent: parent?.name ?? null }); };
const fTeam = (n: any) => stripEmpty({ key: n.key, name: n.name, description: n.description });
const fUser = (n: any) => stripEmpty({ name: n.name, displayName: n.displayName, email: n.email, active: n.active });
const fMilestone = (n: any) => stripEmpty({ id: n.id, name: n.name, description: n.description, targetDate: n.targetDate });
const fCycle = (n: any) => stripEmpty({ id: n.id, name: n.name, number: n.number, startsAt: n.startsAt, endsAt: n.endsAt });
const fState = (n: any, full = false) => full
  ? { name: n.name, type: n.type, color: n.color, position: n.position }
  : { name: n.name, type: n.type };
const fPUpdate = (n: any) => stripEmpty({ id: n.id, body: n.body, health: n.health, createdAt: n.createdAt, url: n.url });
const fAttach = (n: any) => stripEmpty({ id: n.id, title: n.title, subtitle: n.subtitle, url: n.url, createdAt: n.createdAt });

// ═══════════════════════════════ Markdown Output ═══════════════════════════════

const shortDate = (d: any) => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : undefined;

function yamlVal(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(yamlVal).join(', ')}]`;
  const s = String(v);
  if (/[:#\[\]{}&*!|>'"%@`,\n]/.test(s) || /^\s|\s$/.test(s)) return JSON.stringify(s);
  return s;
}

function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function outMd(fm: Record<string, any>, body?: string | null, extra?: string): void {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`${k}: ${yamlVal(v)}`);
  }
  lines.push('---');
  if (body) lines.push('', body);
  if (extra) lines.push('', extra);
  console.log(lines.join('\n'));
}

async function renderCommentsXml(nodes: any[]): Promise<string> {
  const data = await Promise.all(nodes.map(async (n: any) => {
    const [user, parent] = await Promise.all([safe(() => n.user), safe(() => n.parent)]);
    return {
      id: n.id as string, parentId: parent ? (parent as any).id as string : null,
      author: user ? (user as any).name as string : 'Unknown',
      date: shortDate(n.createdAt) || '', body: n.body || '', children: [] as any[],
    };
  }));
  const byId = new Map(data.map(c => [c.id, c]));
  const roots: typeof data = [];
  for (const c of data) {
    if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.children.push(c);
    else roots.push(c);
  }
  function render(c: typeof data[0], tag: string): string {
    const replies = c.children.map(ch => render(ch, 'reply')).join('\n\n');
    const inner = replies ? `${c.body}\n\n${replies}` : c.body;
    return `<${tag} author="${escAttr(c.author)}" date="${c.date}">\n${inner}\n</${tag}>`;
  }
  return roots.map(c => render(c, 'comment')).join('\n\n');
}

// ═══════════════════════════════ Commands ═══════════════════════════════

type H = (client: LinearClient, pos: string[], opts: Opts, config: Config) => Promise<void>;
const cmd: Record<string, H> = {};

// ─── Issues ───

async function resolveIssueMeta(issue: any) {
  const [state, assignee, team, project, lblC, parent] = await Promise.all([
    safe(() => issue.state), safe(() => issue.assignee), safe(() => issue.team),
    safe(() => issue.project), safe(() => issue.labels()), safe(() => issue.parent),
  ]);
  const labels = ((lblC as any)?.nodes || []).map((l: any) => l.name);
  return { state, assignee, team, project, labels, parent };
}

function issueFullJson(issue: any, meta: Awaited<ReturnType<typeof resolveIssueMeta>>) {
  const { state, assignee, team, project, labels, parent } = meta;
  return stripEmpty({
    id: issue.id, identifier: issue.identifier, title: issue.title,
    priority: issue.priority || undefined,
    state: state ? { name: (state as any).name, type: (state as any).type } : null,
    assignee: assignee ? (assignee as any).name : null,
    labels, dueDate: issue.dueDate, estimate: issue.estimate || undefined,
    description: issue.description, branchName: issue.branchName,
    parent: parent ? { identifier: (parent as any).identifier, title: (parent as any).title } : null,
    team: team ? (team as any).key : null,
    project: project ? (project as any).name : null,
    url: issue.url, createdAt: issue.createdAt, updatedAt: issue.updatedAt,
  });
}

function issueFrontmatter(issue: any, meta: Awaited<ReturnType<typeof resolveIssueMeta>>) {
  const { state, assignee, team, project, labels, parent } = meta;
  return stripEmpty({
    identifier: issue.identifier, title: issue.title,
    priority: issue.priority || undefined,
    state: state ? (state as any).name : null,
    assignee: assignee ? (assignee as any).name : null,
    labels, dueDate: issue.dueDate, estimate: issue.estimate || undefined,
    branch: issue.branchName,
    parent: parent ? (parent as any).identifier : null,
    team: team ? (team as any).key : null,
    project: project ? (project as any).name : null,
    created: shortDate(issue.createdAt),
    updated: shortDate(issue.updatedAt),
  });
}

async function fetchComments(client: LinearClient, issueId: string): Promise<string> {
  const cs = await client.comments({ filter: { issue: { id: { eq: issueId } } } });
  return cs.nodes.length ? await renderCommentsXml(cs.nodes) : '';
}

cmd['issue.list'] = async (client, _pos, opts, config) => {
  const filter: any = {};
  const teamKey = o(opts, 'team') || config.team;
  if (teamKey) filter.team = { key: { eq: teamKey } };
  if (o(opts, 'assignee')) filter.assignee = { id: { eq: await rUser(client, o(opts, 'assignee')!) } };
  if (o(opts, 'state')) {
    const s = o(opts, 'state')!;
    filter.state = STATE_TYPES.includes(s.toLowerCase()) ? { type: { eq: s.toLowerCase() } } : { name: { containsIgnoreCase: s } };
  }
  if (o(opts, 'project')) filter.project = { name: { containsIgnoreCase: o(opts, 'project') } };
  if (o(opts, 'label')) filter.labels = { some: { name: { eqIgnoreCase: o(opts, 'label') } } };
  if (o(opts, 'query')) filter.title = { containsIgnoreCase: o(opts, 'query') };
  if (o(opts, 'parent')) filter.parent = { id: { eq: await rIssue(client, o(opts, 'parent')!) } };
  if (o(opts, 'created-after')) filter.createdAt = { gte: new Date(o(opts, 'created-after')!).toISOString() };
  if (o(opts, 'updated-after')) filter.updatedAt = { gte: new Date(o(opts, 'updated-after')!).toISOString() };
  if (o(opts, 'cycle')) {
    const tid = await rTeam(client, o(opts, 'team'), config);
    if (!tid) die('--team required to filter by cycle');
    filter.cycle = { id: { eq: await rCycle(client, o(opts, 'cycle')!, tid) } };
  }
  const r = await client.issues({ filter, ...pagVars(opts) });
  outList(await Promise.all(r.nodes.map(n => fIssue(n))), r.pageInfo);
};

cmd['issue.get'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear issue get <identifier>');
  const id = await rIssue(client, pos[0]);
  const issue = await client.issue(id);
  const meta = await resolveIssueMeta(issue);

  if (oBool(opts, 'json')) {
    const r: any = issueFullJson(issue, meta);
    if (!oBool(opts, 'no-comments')) {
      const comments = await client.comments({ filter: { issue: { id: { eq: id } } } });
      r.comments = await Promise.all(comments.nodes.map(fComment));
    }
    if (oBool(opts, 'include-relations')) {
      const gql = await client.client.rawRequest(
        `query($id:String!){issue(id:$id){relations{nodes{type relatedIssue{id identifier title}}}inverseRelations{nodes{type issue{id identifier title}}}}}`,
        { id },
      );
      r.relations = (gql as any).data?.issue?.relations?.nodes || [];
      r.inverseRelations = (gql as any).data?.issue?.inverseRelations?.nodes || [];
    }
    out(r, true);
    return;
  }

  const fm = issueFrontmatter(issue, meta);
  const comments = oBool(opts, 'no-comments') ? '' : await fetchComments(client, id);
  outMd(fm, issue.description, comments);
};

cmd['issue.read'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear issue read <identifier> [--no-comments]');
  const id = await rIssue(client, pos[0]);
  const issue = await client.issue(id);
  const fm = issueFrontmatter(issue, await resolveIssueMeta(issue));
  const comments = oBool(opts, 'no-comments') ? '' : await fetchComments(client, id);
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`${k}: ${yamlVal(v)}`);
  }
  lines.push('---', '');
  if (issue.description) lines.push(formatHashlines(issue.description));
  else lines.push('(empty description)');
  if (comments) lines.push('', comments);
  console.log(lines.join('\n'));
};

cmd['issue.edit'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear issue edit <identifier> --edits $\'replace 6#JB:new text\\ndelete 4#KT\'');
  const editsText = o(opts, 'edits');
  if (!editsText) die('--edits required (text edit commands)');
  const edits = parseEdits(editsText);

  const id = await rIssue(client, pos[0]);
  const issue = await client.issue(id);
  if (!issue.description) die('Issue has no description to edit');

  const newDescription = applyEdits(issue.description, edits);
  const p = await client.updateIssue(id, { description: newDescription });
  if (!p.success) die('Failed to update issue');

  console.log(formatHashlines(newDescription));
};

cmd['issue.create'] = async (client, _pos, opts, config) => {
  if (!o(opts, 'title')) die('--title required');
  const teamId = await rTeam(client, o(opts, 'team'), config);
  if (!teamId) die('--team required (or set team_id in .linear.toml)');
  const input: any = { title: o(opts, 'title'), teamId };
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'priority')) input.priority = parseInt(o(opts, 'priority')!);
  if (o(opts, 'estimate')) input.estimate = parseInt(o(opts, 'estimate')!);
  if (o(opts, 'due-date')) input.dueDate = o(opts, 'due-date');
  if (o(opts, 'assignee')) input.assigneeId = await rUser(client, o(opts, 'assignee')!);
  if (o(opts, 'state')) input.stateId = await rState(client, o(opts, 'state')!, teamId);
  if (o(opts, 'project')) input.projectId = await rProject(client, o(opts, 'project')!);
  if (o(opts, 'parent')) input.parentId = await rIssue(client, o(opts, 'parent')!);
  if (o(opts, 'cycle')) input.cycleId = await rCycle(client, o(opts, 'cycle')!, teamId);
  if (o(opts, 'milestone')) input.projectMilestoneId = await rMilestone(client, o(opts, 'milestone')!);
  const lbls = oArr(opts, 'label');
  if (lbls.length) input.labelIds = await rLabels(client, lbls);
  const p = await client.createIssue(input);
  if (!p.success) die('Failed to create issue');
  const iss = await p.issue;
  out({ success: true, identifier: iss?.identifier, url: iss?.url }, true);
};

cmd['issue.update'] = async (client, pos, opts, config) => {
  if (!pos[0]) die('Usage: linear issue update <identifier> [options]');
  const id = await rIssue(client, pos[0]);
  const input: any = {};
  if (o(opts, 'title')) input.title = o(opts, 'title');
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'priority')) input.priority = parseInt(o(opts, 'priority')!);
  if (o(opts, 'estimate')) input.estimate = parseInt(o(opts, 'estimate')!);
  if (o(opts, 'due-date')) input.dueDate = o(opts, 'due-date');
  if (o(opts, 'assignee')) input.assigneeId = o(opts, 'assignee') === 'none' ? null : await rUser(client, o(opts, 'assignee')!);
  if (o(opts, 'state')) {
    const tid = await teamIdFromIssue(client, id, opts, config);
    input.stateId = await rState(client, o(opts, 'state')!, tid);
  }
  if (o(opts, 'project')) input.projectId = o(opts, 'project') === 'none' ? null : await rProject(client, o(opts, 'project')!);
  if (o(opts, 'parent')) input.parentId = o(opts, 'parent') === 'none' ? null : await rIssue(client, o(opts, 'parent')!);
  if (o(opts, 'cycle')) {
    const tid = await teamIdFromIssue(client, id, opts, config);
    input.cycleId = await rCycle(client, o(opts, 'cycle')!, tid);
  }
  if (o(opts, 'milestone')) input.projectMilestoneId = await rMilestone(client, o(opts, 'milestone')!);
  const lbls = oArr(opts, 'label');
  if (lbls.length) input.labelIds = await rLabels(client, lbls);
  const addLbls = oArr(opts, 'add-label');
  if (addLbls.length) input.addedLabelIds = await rLabels(client, addLbls);
  const rmLbls = oArr(opts, 'remove-label');
  if (rmLbls.length) input.removedLabelIds = await rLabels(client, rmLbls);
  const p = await client.updateIssue(id, input);
  if (!p.success) die('Failed to update issue');
  const iss = await p.issue;
  out({ success: true, identifier: iss?.identifier, url: iss?.url }, true);
};

cmd['issue.delete'] = async (client, pos) => {
  if (!pos[0]) die('Usage: linear issue delete <identifier>');
  const id = await rIssue(client, pos[0]);
  const p = await client.deleteIssue(id);
  out({ success: p.success }, true);
};

cmd['issue.search'] = async (client, _pos, opts) => {
  const term = o(opts, 'query');
  if (!term) die('--query required');
  const r = await client.searchIssues(term, { ...pagVars(opts) });
  outList(await Promise.all(r.nodes.map(n => fIssue(n as any))), (r as any).pageInfo);
};

// ─── Comments ───

cmd['comment.list'] = async (client, _pos, opts) => {
  if (!o(opts, 'issue')) die('--issue required');
  const issueId = await rIssue(client, o(opts, 'issue')!);
  const r = await client.comments({ filter: { issue: { id: { eq: issueId } } }, ...pagVars(opts) });
  outList(await Promise.all(r.nodes.map(fComment)), r.pageInfo);
};

cmd['comment.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'issue') || !o(opts, 'body')) die('--issue and --body required');
  const issueId = await rIssue(client, o(opts, 'issue')!);
  const input: any = { issueId, body: o(opts, 'body') };
  if (o(opts, 'parent')) input.parentId = o(opts, 'parent');
  const p = await client.createComment(input);
  if (!p.success) die('Failed to create comment');
  const c = await p.comment;
  out({ success: true, id: c?.id, url: c?.url }, true);
};

// ─── Labels ───

cmd['label.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'team')) filter.team = { key: { eq: o(opts, 'team') } };
  if (o(opts, 'name')) filter.name = { containsIgnoreCase: o(opts, 'name') };
  const r = await client.issueLabels({ filter, ...pagVars(opts) });
  const nodes = await Promise.all(r.nodes.map(fLabel));
  outList(nodes, r.pageInfo);
};

cmd['label.create'] = async (client, _pos, opts, config) => {
  if (!o(opts, 'name')) die('--name required');
  const input: any = { name: o(opts, 'name') };
  if (o(opts, 'color')) input.color = o(opts, 'color');
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'team') || config.team) input.teamId = await rTeam(client, o(opts, 'team'), config);
  if (o(opts, 'parent')) input.parentId = o(opts, 'parent');
  const p = await client.createIssueLabel(input);
  if (!p.success) die('Failed to create label');
  const l = await p.issueLabel;
  out({ success: true, name: l?.name }, true);
};

// ─── Projects ───

cmd['project.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'team')) {
    const tid = await rTeam(client, o(opts, 'team'), { team: undefined });
    if (tid) filter.accessibleTeams = { some: { id: { eq: tid } } };
  }
  if (o(opts, 'status')) filter.status = { name: { containsIgnoreCase: o(opts, 'status') } };
  if (o(opts, 'member')) filter.members = { some: { id: { eq: await rUser(client, o(opts, 'member')!) } } };
  if (o(opts, 'query')) filter.name = { containsIgnoreCase: o(opts, 'query') };
  if (o(opts, 'initiative')) filter.initiatives = { some: { id: { eq: await rInitiative(client, o(opts, 'initiative')!) } } };
  const r = await client.projects({ filter, ...pagVars(opts) });
  outList(await Promise.all(r.nodes.map(n => fProject(n))), r.pageInfo);
};

cmd['project.get'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear project get <name-or-id>');
  const id = await rProject(client, pos[0]);
  const p = await client.project(id);
  const [lead, status] = await Promise.all([safe(() => p.lead), safe(() => p.status)]);

  if (oBool(opts, 'json')) {
    const r: any = await fProject(p, true);
    if (oBool(opts, 'include-milestones')) {
      const ms = await client.projectMilestones({ filter: { project: { id: { eq: id } } } });
      r.milestones = ms.nodes.map(fMilestone);
    }
    out(r, true);
    return;
  }

  const fm = stripEmpty({
    name: p.name, priority: p.priority || undefined,
    status: status ? (status as any).name : null,
    lead: lead ? (lead as any).name : null,
    description: p.description,
    startDate: p.startDate, targetDate: p.targetDate,
    created: shortDate(p.createdAt),
    updated: shortDate(p.updatedAt),
  });
  let milestones = '';
  if (oBool(opts, 'include-milestones')) {
    const ms = await client.projectMilestones({ filter: { project: { id: { eq: id } } } });
    if (ms.nodes.length) {
      milestones = '## Milestones\n\n' + ms.nodes.map((m: any) => {
        let line = `- **${m.name}**`;
        if (m.targetDate) line += ` (${String(m.targetDate).slice(0, 10)})`;
        if (m.description) line += ` — ${m.description}`;
        return line;
      }).join('\n');
    }
  }
  outMd(fm, p.content, milestones);
};

cmd['project.create'] = async (client, _pos, opts, config) => {
  if (!o(opts, 'name')) die('--name required');
  const teamId = await rTeam(client, o(opts, 'team'), config);
  if (!teamId) die('--team required');
  const input: any = { name: o(opts, 'name'), teamIds: [teamId] };
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'content')) input.content = o(opts, 'content');
  if (o(opts, 'color')) input.color = o(opts, 'color');
  if (o(opts, 'icon')) input.icon = o(opts, 'icon');
  if (o(opts, 'lead')) input.leadId = await rUser(client, o(opts, 'lead')!);
  if (o(opts, 'priority')) input.priority = parseInt(o(opts, 'priority')!);
  if (o(opts, 'start-date')) input.startDate = o(opts, 'start-date');
  if (o(opts, 'target-date')) input.targetDate = o(opts, 'target-date');
  if (o(opts, 'state')) input.state = o(opts, 'state');
  const p = await client.createProject(input);
  if (!p.success) die('Failed to create project');
  const proj = await p.project;
  out({ success: true, name: proj?.name, url: proj?.url }, true);
};

cmd['project.update'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear project update <name-or-id> [options]');
  const id = await rProject(client, pos[0]);
  const input: any = {};
  if (o(opts, 'name')) input.name = o(opts, 'name');
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'content')) input.content = o(opts, 'content');
  if (o(opts, 'color')) input.color = o(opts, 'color');
  if (o(opts, 'icon')) input.icon = o(opts, 'icon');
  if (o(opts, 'lead')) input.leadId = o(opts, 'lead') === 'none' ? null : await rUser(client, o(opts, 'lead')!);
  if (o(opts, 'priority')) input.priority = parseInt(o(opts, 'priority')!);
  if (o(opts, 'start-date')) input.startDate = o(opts, 'start-date');
  if (o(opts, 'target-date')) input.targetDate = o(opts, 'target-date');
  if (o(opts, 'state')) input.state = o(opts, 'state');
  const p = await client.updateProject(id, input);
  if (!p.success) die('Failed to update project');
  out({ success: true }, true);
};

// ─── Documents ───

cmd['document.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'project')) filter.project = { name: { containsIgnoreCase: o(opts, 'project') } };
  if (o(opts, 'query')) filter.title = { containsIgnoreCase: o(opts, 'query') };
  if (o(opts, 'initiative')) filter.initiative = { name: { containsIgnoreCase: o(opts, 'initiative') } };
  const r = await client.documents({ filter, ...pagVars(opts) });
  outList(await Promise.all(r.nodes.map(n => fDoc(n))), r.pageInfo);
};

cmd['document.get'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear document get <id>');
  const doc = await client.document(pos[0]);

  if (oBool(opts, 'json')) {
    out(await fDoc(doc, true), true);
    return;
  }

  const [project, creator] = await Promise.all([safe(() => doc.project), safe(() => doc.creator)]);
  const fm = stripEmpty({
    title: doc.title, icon: doc.icon,
    project: project ? (project as any).name : null,
    creator: creator ? (creator as any).name : null,
    created: shortDate(doc.createdAt),
  });
  outMd(fm, doc.content);
};

cmd['document.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'title')) die('--title required');
  const input: any = { title: o(opts, 'title') };
  if (o(opts, 'content')) input.content = o(opts, 'content');
  if (o(opts, 'project')) input.projectId = await rProject(client, o(opts, 'project')!);
  if (o(opts, 'color')) input.color = o(opts, 'color');
  if (o(opts, 'icon')) input.icon = o(opts, 'icon');
  const p = await client.createDocument(input);
  if (!p.success) die('Failed to create document');
  const doc = await p.document;
  out({ success: true, title: doc?.title, url: doc?.url }, true);
};

cmd['document.update'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear document update <id> [options]');
  const input: any = {};
  if (o(opts, 'title')) input.title = o(opts, 'title');
  if (o(opts, 'content')) input.content = o(opts, 'content');
  if (o(opts, 'project')) input.projectId = await rProject(client, o(opts, 'project')!);
  if (o(opts, 'color')) input.color = o(opts, 'color');
  if (o(opts, 'icon')) input.icon = o(opts, 'icon');
  const p = await client.updateDocument(pos[0], input);
  if (!p.success) die('Failed to update document');
  out({ success: true }, true);
};

cmd['document.read'] = async (client, pos, _opts) => {
  if (!pos[0]) die('Usage: linear document read <id>');
  const doc = await client.document(pos[0]);
  const [project, creator] = await Promise.all([safe(() => doc.project), safe(() => doc.creator)]);
  const fm = stripEmpty({
    title: doc.title, icon: doc.icon,
    project: project ? (project as any).name : null,
    creator: creator ? (creator as any).name : null,
    created: shortDate(doc.createdAt),
  });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`${k}: ${yamlVal(v)}`);
  }
  lines.push('---', '');
  if (doc.content) lines.push(formatHashlines(doc.content));
  else lines.push('(empty content)');
  console.log(lines.join('\n'));
};

cmd['document.edit'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear document edit <id> --edits $\'replace 3#VR:new text\\ndelete 2#MQ\'');
  const editsText = o(opts, 'edits');
  if (!editsText) die('--edits required (text edit commands)');
  const edits = parseEdits(editsText);

  const doc = await client.document(pos[0]);
  if (!doc.content) die('Document has no content to edit');

  const newContent = applyEdits(doc.content, edits);
  const p = await client.updateDocument(pos[0], { content: newContent });
  if (!p.success) die('Failed to update document');

  console.log(formatHashlines(newContent));
};

// ─── Initiatives ───

cmd['initiative.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'query')) filter.name = { containsIgnoreCase: o(opts, 'query') };
  if (o(opts, 'status')) filter.status = { eq: o(opts, 'status') };
  const r = await client.initiatives({ filter, ...pagVars(opts) });
  outList(await Promise.all(r.nodes.map(n => fInit(n))), r.pageInfo);
};

cmd['initiative.get'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear initiative get <name-or-id>');
  const id = await rInitiative(client, pos[0]);
  const init = await client.initiative(id);

  if (oBool(opts, 'json')) {
    const r: any = await fInit(init, true);
    if (oBool(opts, 'include-projects')) {
      const gql = await client.client.rawRequest(
        `query($id:String!){initiative(id:$id){projects{nodes{id name status{name}}}}}`,
        { id },
      );
      r.projects = (gql as any).data?.initiative?.projects?.nodes || [];
    }
    out(r, true);
    return;
  }

  const owner = await safe(() => init.owner);
  const fm = stripEmpty({
    name: init.name, status: init.status,
    owner: owner ? (owner as any).name : null,
    targetDate: init.targetDate,
    created: shortDate(init.createdAt),
    updated: shortDate(init.updatedAt),
  });
  let projects = '';
  if (oBool(opts, 'include-projects')) {
    const gql = await client.client.rawRequest(
      `query($id:String!){initiative(id:$id){projects{nodes{id name status{name}}}}}`,
      { id },
    );
    const pNodes = (gql as any).data?.initiative?.projects?.nodes || [];
    if (pNodes.length) {
      projects = '## Projects\n\n' + pNodes.map((p: any) =>
        `- **${p.name}** (${p.status?.name || 'unknown'})`
      ).join('\n');
    }
  }
  outMd(fm, init.description, projects);
};

cmd['initiative.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'name')) die('--name required');
  const input: any = { name: o(opts, 'name') };
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'content')) input.content = o(opts, 'content');
  if (o(opts, 'status')) input.status = o(opts, 'status');
  if (o(opts, 'owner')) input.ownerId = await rUser(client, o(opts, 'owner')!);
  if (o(opts, 'target-date')) input.targetDate = o(opts, 'target-date');
  if (o(opts, 'color')) input.color = o(opts, 'color');
  if (o(opts, 'icon')) input.icon = o(opts, 'icon');
  const p = await client.createInitiative(input);
  if (!p.success) die('Failed to create initiative');
  out({ success: true }, true);
};

cmd['initiative.update'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear initiative update <name-or-id> [options]');
  const id = await rInitiative(client, pos[0]);
  const input: any = {};
  if (o(opts, 'name')) input.name = o(opts, 'name');
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'content')) input.content = o(opts, 'content');
  if (o(opts, 'status')) input.status = o(opts, 'status');
  if (o(opts, 'owner')) input.ownerId = o(opts, 'owner') === 'none' ? null : await rUser(client, o(opts, 'owner')!);
  if (o(opts, 'target-date')) input.targetDate = o(opts, 'target-date');
  if (o(opts, 'color')) input.color = o(opts, 'color');
  if (o(opts, 'icon')) input.icon = o(opts, 'icon');
  const p = await client.updateInitiative(id, input);
  if (!p.success) die('Failed to update initiative');
  out({ success: true }, true);
};

// ─── Initiative Updates ───

cmd['initiative-update.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'initiative')) filter.initiative = { id: { eq: await rInitiative(client, o(opts, 'initiative')!) } };
  const gql = await client.client.rawRequest(
    `query($filter:InitiativeUpdateFilter,$first:Int,$after:String){initiativeUpdates(filter:$filter,first:$first,after:$after){nodes{id body health createdAt}pageInfo{hasNextPage endCursor}}}`,
    { filter: Object.keys(filter).length ? filter : undefined, ...pagVars(opts) },
  );
  const data = (gql as any).data?.initiativeUpdates;
  outList(data?.nodes || [], data?.pageInfo);
};

cmd['initiative-update.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'initiative') || !o(opts, 'body')) die('--initiative and --body required');
  const gql = await client.client.rawRequest(
    `mutation($input:InitiativeUpdateCreateInput!){initiativeUpdateCreate(input:$input){success}}`,
    { input: { initiativeId: await rInitiative(client, o(opts, 'initiative')!), body: o(opts, 'body'), ...(o(opts, 'health') && { health: o(opts, 'health') }) } },
  );
  out((gql as any).data?.initiativeUpdateCreate, true);
};

cmd['initiative-update.update'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear initiative-update update <id> [options]');
  const input: any = {};
  if (o(opts, 'body')) input.body = o(opts, 'body');
  if (o(opts, 'health')) input.health = o(opts, 'health');
  const gql = await client.client.rawRequest(
    `mutation($id:String!,$input:InitiativeUpdateUpdateInput!){initiativeUpdateUpdate(id:$id,input:$input){success}}`,
    { id: pos[0], input },
  );
  out((gql as any).data?.initiativeUpdateUpdate, true);
};

cmd['initiative-update.delete'] = async (client, pos) => {
  if (!pos[0]) die('Usage: linear initiative-update delete <id>');
  const gql = await client.client.rawRequest(
    `mutation($id:String!){initiativeUpdateArchive(id:$id){success}}`,
    { id: pos[0] },
  );
  out((gql as any).data?.initiativeUpdateArchive, true);
};

// ─── Project Updates ───

cmd['project-update.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'project')) filter.project = { id: { eq: await rProject(client, o(opts, 'project')!) } };
  const r = await client.projectUpdates({ filter, ...pagVars(opts) });
  outList(r.nodes.map(fPUpdate), r.pageInfo);
};

cmd['project-update.get'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear project-update get <id>');
  const u = await client.projectUpdate(pos[0]);

  if (oBool(opts, 'json')) {
    out(fPUpdate(u), true);
    return;
  }

  const fm = stripEmpty({
    health: u.health,
    created: shortDate(u.createdAt),
  });
  outMd(fm, u.body);
};

cmd['project-update.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'project') || !o(opts, 'body')) die('--project and --body required');
  const input: any = { projectId: await rProject(client, o(opts, 'project')!), body: o(opts, 'body') };
  if (o(opts, 'health')) input.health = o(opts, 'health');
  if (oBool(opts, 'diff-hidden')) input.isDiffHidden = true;
  const p = await client.createProjectUpdate(input);
  if (!p.success) die('Failed to create project update');
  out({ success: true }, true);
};

cmd['project-update.update'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear project-update update <id> [options]');
  const input: any = {};
  if (o(opts, 'body')) input.body = o(opts, 'body');
  if (o(opts, 'health')) input.health = o(opts, 'health');
  if (oBool(opts, 'diff-hidden')) input.isDiffHidden = true;
  const p = await client.updateProjectUpdate(pos[0], input);
  if (!p.success) die('Failed to update project update');
  out({ success: true }, true);
};

// ─── Milestones ───

cmd['milestone.list'] = async (client, _pos, opts) => {
  if (!o(opts, 'project')) die('--project required');
  const pid = await rProject(client, o(opts, 'project')!);
  const r = await client.projectMilestones({ filter: { project: { id: { eq: pid } } }, ...pagVars(opts) });
  outList(r.nodes.map(fMilestone), r.pageInfo);
};

cmd['milestone.get'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear milestone get <name-or-id> [--project <name>]');
  const id = await rMilestone(client, pos[0], o(opts, 'project') ? await rProject(client, o(opts, 'project')!) : undefined);
  const m = await client.projectMilestone(id);

  if (oBool(opts, 'json')) {
    out(fMilestone(m), true);
    return;
  }

  const fm = stripEmpty({ name: m.name, targetDate: m.targetDate });
  outMd(fm, m.description);
};

cmd['milestone.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'project') || !o(opts, 'name')) die('--project and --name required');
  const input: any = { projectId: await rProject(client, o(opts, 'project')!), name: o(opts, 'name') };
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'target-date')) input.targetDate = o(opts, 'target-date');
  const p = await client.createProjectMilestone(input);
  if (!p.success) die('Failed to create milestone');
  out({ success: true, name: o(opts, 'name') }, true);
};

cmd['milestone.update'] = async (client, pos, opts) => {
  if (!pos[0]) die('Usage: linear milestone update <name-or-id> [options]');
  const id = await rMilestone(client, pos[0], o(opts, 'project') ? await rProject(client, o(opts, 'project')!) : undefined);
  const input: any = {};
  if (o(opts, 'name')) input.name = o(opts, 'name');
  if (o(opts, 'description')) input.description = o(opts, 'description');
  if (o(opts, 'target-date')) input.targetDate = o(opts, 'target-date') === 'none' ? null : o(opts, 'target-date');
  const p = await client.updateProjectMilestone(id, input);
  if (!p.success) die('Failed to update milestone');
  out({ success: true }, true);
};

// ─── Teams ───

cmd['team.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'query')) filter.name = { containsIgnoreCase: o(opts, 'query') };
  const r = await client.teams({ filter, ...pagVars(opts) });
  outList(r.nodes.map(fTeam), r.pageInfo);
};

cmd['team.get'] = async (client, pos) => {
  if (!pos[0]) die('Usage: linear team get <key-or-name>');
  const id = await rTeam(client, pos[0], {});
  if (!id) die('Team not found');
  const t = await client.team(id);
  out(fTeam(t), true);
};

// ─── Users ───

cmd['user.list'] = async (client, _pos, opts) => {
  const filter: any = {};
  if (o(opts, 'query')) filter.or = [{ name: { containsIgnoreCase: o(opts, 'query') } }, { email: { containsIgnoreCase: o(opts, 'query') } }];
  const r = await client.users({ filter, ...pagVars(opts) });
  outList(r.nodes.map(fUser), r.pageInfo);
};

cmd['user.get'] = async (client, pos) => {
  if (!pos[0]) die('Usage: linear user get <name-or-email-or-me>');
  if (pos[0] === 'me') { const me = await client.viewer; out(fUser(me), true); return; }
  const id = await rUser(client, pos[0]);
  const u = await client.user(id);
  out(fUser(u), true);
};

// ─── Cycles ───

cmd['cycle.list'] = async (client, _pos, opts, config) => {
  const teamId = await rTeam(client, o(opts, 'team'), config);
  if (!teamId) die('--team required');
  const filter: any = { team: { id: { eq: teamId } } };
  const typ = o(opts, 'type');
  if (typ === 'current') filter.isActive = { eq: true };
  else if (typ === 'next') filter.isNext = { eq: true };
  else if (typ === 'previous') filter.isPrevious = { eq: true };
  const r = await client.cycles({ filter, ...pagVars(opts) });
  outList(r.nodes.map(fCycle), r.pageInfo);
};

// ─── Workflow States ───

cmd['status.list'] = async (client, _pos, opts, config) => {
  const teamId = await rTeam(client, o(opts, 'team'), config);
  if (!teamId) die('--team required');
  const r = await client.workflowStates({ filter: { team: { id: { eq: teamId } } }, ...pagVars(opts) });
  outList(r.nodes.map(n => fState(n)), r.pageInfo);
};

cmd['status.get'] = async (client, pos, opts, config) => {
  if (!pos[0]) die('Usage: linear status get <name-or-id> --team <key>');
  const teamId = await rTeam(client, o(opts, 'team'), config);
  if (!teamId) die('--team required');
  if (isUUID(pos[0])) { out(fState(await client.workflowState(pos[0]), true), true); return; }
  const id = await rState(client, pos[0], teamId);
  out(fState(await client.workflowState(id), true), true);
};

// ─── Attachments ───

cmd['attachment.get'] = async (client, pos) => {
  if (!pos[0]) die('Usage: linear attachment get <id>');
  const a = await client.attachment(pos[0]);
  out(fAttach(a), true);
};

cmd['attachment.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'issue') || !o(opts, 'url') || !o(opts, 'title')) die('--issue, --url, and --title required');
  const input: any = {
    issueId: await rIssue(client, o(opts, 'issue')!),
    url: o(opts, 'url'),
    title: o(opts, 'title'),
  };
  if (o(opts, 'subtitle')) input.subtitle = o(opts, 'subtitle');
  if (o(opts, 'icon-url')) input.iconUrl = o(opts, 'icon-url');
  const p = await client.createAttachment(input);
  if (!p.success) die('Failed to create attachment');
  out({ success: true }, true);
};

cmd['attachment.delete'] = async (client, pos) => {
  if (!pos[0]) die('Usage: linear attachment delete <id>');
  const p = await client.deleteAttachment(pos[0]);
  out({ success: p.success }, true);
};

// ─── Issue Relations (GraphQL) ───

cmd['relation.create'] = async (client, _pos, opts) => {
  if (!o(opts, 'issue') || !o(opts, 'related') || !o(opts, 'type'))
    die('--issue, --related, and --type (blocks|related|duplicate) required');
  const issueId = await rIssue(client, o(opts, 'issue')!);
  const relatedId = await rIssue(client, o(opts, 'related')!);
  const p = await client.createIssueRelation({ issueId, relatedIssueId: relatedId, type: o(opts, 'type') as any });
  out({ success: p.success }, true);
};

cmd['relation.delete'] = async (client, pos) => {
  if (!pos[0]) die('Usage: linear relation delete <relation-id>');
  const p = await client.deleteIssueRelation(pos[0]);
  out({ success: p.success }, true);
};

// ─── Raw GraphQL ───

cmd['graphql.query'] = async (client, _pos, opts) => {
  const query = o(opts, 'query');
  if (!query) die('--query required (GraphQL query string)');
  const vars = o(opts, 'variables') ? JSON.parse(o(opts, 'variables')!) : undefined;
  const result = await client.client.rawRequest(query, vars);
  out(result, true);
};

// ─── Auth ───

async function authLogin(opts: Opts): Promise<void> {
  const clientId = o(opts, 'client-id');
  const clientSecret = o(opts, 'client-secret');
  if (!clientId || !clientSecret) die('--client-id and --client-secret required');

  const state = randomBytes(16).toString('hex');
  const port = oInt(opts, 'port') ?? 41549;
  const redirectUri = `http://localhost:${port}/callback`;
  const authorizeUrl = `https://linear.app/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=read,write&actor=app&state=${state}`;

  console.error(`\nOpen this URL in your browser to authorize:\n\n  ${authorizeUrl}\n\nWaiting for callback on port ${port}...`);

  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => { srv.close(); reject(new Error('Timed out waiting for authorization (5 min)')); }, 5 * 60 * 1000);
    const srv = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const err = url.searchParams.get('error');
      if (err) { res.writeHead(200); res.end('Authorization denied: ' + err); clearTimeout(timeout); srv.close(); reject(new Error('Authorization denied: ' + err)); return; }
      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) { res.writeHead(400); res.end('State mismatch'); clearTimeout(timeout); srv.close(); reject(new Error('State mismatch')); return; }
      const authCode = url.searchParams.get('code');
      if (!authCode) { res.writeHead(400); res.end('No code'); clearTimeout(timeout); srv.close(); reject(new Error('No authorization code received')); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h2>Authorization successful!</h2><p>You can close this tab.</p>');
      clearTimeout(timeout);
      srv.close();
      resolve(authCode);
    });
    srv.listen(port);
  });

  // Exchange code for tokens
  const tokenRes = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }),
  });
  if (!tokenRes.ok) die(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in: number };

  // Fetch workspace slug
  const gqlRes = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ query: '{ organization { urlKey name } }' }),
  });
  const gql = await gqlRes.json() as any;
  const workspace = gql.data?.organization?.urlKey || 'default';
  const orgName = gql.data?.organization?.name || workspace;

  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const fields: Record<string, string> = { access_token: tokens.access_token, token_expiry: expiry, client_id: clientId, client_secret: clientSecret };
  if (tokens.refresh_token) fields.refresh_token = tokens.refresh_token;
  writeCredentials(workspace, fields);

  console.error(`\nAuthenticated with workspace "${orgName}" (${workspace}).`);
  console.error(`Credentials saved to ${CREDENTIALS_PATH}`);
  out({ success: true, workspace, organization: orgName }, false);
}

function authStatus(): void {
  const accessToken = process.env.LINEAR_ACCESS_TOKEN?.trim();
  if (accessToken) {
    out({ type: 'oauth', source: 'LINEAR_ACCESS_TOKEN env var', hasRefreshToken: false }, false);
    return;
  }

  const envToken = process.env.LINEAR_API_KEY?.trim();
  if (envToken) {
    if (looksLikeOAuthToken(envToken)) out({ type: 'oauth', source: 'LINEAR_API_KEY env var (oauth access token)', hasRefreshToken: false }, false);
    else out({ type: 'api_key', source: 'LINEAR_API_KEY env var' }, false);
    return;
  }

  if (!existsSync(CREDENTIALS_PATH)) die('Not authenticated. Run `linear auth login`.');
  const c = readFileSync(CREDENTIALS_PATH, 'utf-8');
  const ws = c.match(/^default\s*=\s*"(.+?)"/m)?.[1];
  if (!ws) die('Cannot parse credentials.toml');
  const section = readSection(c, ws);
  if (section.access_token) {
    const expiry = section.token_expiry ? new Date(section.token_expiry) : null;
    const expired = expiry ? expiry.getTime() < Date.now() : false;
    out({ type: 'oauth', workspace: ws, tokenExpiry: section.token_expiry || null, expired, hasRefreshToken: !!section.refresh_token }, false);
  } else {
    out({ type: 'api_key', workspace: ws, source: 'credentials.toml (legacy)' }, false);
  }
}

// ═══════════════════════════════ Main ═══════════════════════════════

async function main() {
  const { resource, action, pos, opts } = parseArgs();

  // Auth commands don't need an existing token
  if (resource === 'auth') {
    if (action === 'login') return authLogin(opts);
    if (action === 'status') return authStatus();
    die('Unknown auth action. Available: login, status');
  }

  const auth = await getAuthWithRefresh();
  const config = getConfig();
  const client = new LinearClient(auth);

  const key = `${resource}.${action}`;
  const handler = cmd[key];
  if (!handler) {
    const available = Object.keys(cmd).filter(k => k.startsWith(resource + '.')).map(k => k.split('.')[1]);
    if (available.length) die(`Unknown action: ${action}. Available for ${resource}: ${available.join(', ')}`);
    die(`Unknown resource: ${resource}. Available: ${[...new Set(Object.keys(cmd).map(k => k.split('.')[0]))].join(', ')}`);
  }

  await handler(client, pos, opts, config);
}

main().catch(err => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
});
