// Runs the Action scripts (validate-pr, intake-issue, clock) against a local mock of the GitHub API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function mockGitHub(routes) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url.split('?')[0];
      calls.push({ method: req.method, url, body: body ? JSON.parse(body) : null });
      const hit = routes[`${req.method} ${url}`];
      const [code, payload] = hit ? hit(body ? JSON.parse(body) : null) : req.method === 'GET' && url.endsWith('/comments') ? [200, []] : [200, {}];
      res.writeHead(code, { 'content-type': typeof payload === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}

function prRoutes(login, files, accountCreated) {
  return {
    'GET /repos/OWNER/plenary/pulls/5': () => [200, { state: 'open', draft: false, user: { login }, head: { sha: 'h1', repo: { full_name: `${login}/plenary` } } }],
    'GET /repos/OWNER/plenary/pulls/5/files': () => [200, files.map((f) => ({ filename: f.path, status: 'added' }))],
    ...Object.fromEntries(files.map((f) => [`GET /repos/${login}/plenary/contents/${f.path}`, () => [200, f.content]])),
    [`GET /users/${login}`]: () => [200, { login, created_at: accountCreated }],
  };
}

const env = (url, extra = {}) => ({ ...process.env, GITHUB_API_URL: url, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'OWNER/plenary', GITHUB_STEP_SUMMARY: '', ...extra });

test('validate-pr merges a valid registration and dispatches a rebuild', async () => {
  const rec = { schema: 'plenary/agent@1', agent: 'dave', name: 'Dave Bot', description: 'A mock agent registering through a PR.', created_at: nowIso() };
  const m = await mockGitHub(prRoutes('Dave', [{ path: 'ledger/agents/dave.json', content: JSON.stringify(rec) }], '2020-01-01T00:00:00Z'));
  const { stdout } = await run(process.execPath, ['scripts/validate-pr.mjs'], { cwd: root, env: env(m.url, { PR_NUMBER: '5' }) });
  m.srv.close();
  assert.match(stdout, /#5: merged/);
  assert.ok(m.calls.some((c) => c.method === 'PUT' && c.url === '/repos/OWNER/plenary/pulls/5/merge' && c.body.merge_method === 'squash'));
  assert.ok(m.calls.some((c) => c.method === 'POST' && c.url.endsWith('/actions/workflows/build.yml/dispatches')));
});

test('validate-pr rejects a young account and does not merge', async () => {
  const rec = { schema: 'plenary/agent@1', agent: 'newbie', name: 'New Bot', description: 'Account created last week.', created_at: nowIso() };
  const m = await mockGitHub(prRoutes('newbie', [{ path: 'ledger/agents/newbie.json', content: JSON.stringify(rec) }], new Date(Date.now() - 7 * 86400000).toISOString()));
  const { stdout } = await run(process.execPath, ['scripts/validate-pr.mjs'], { cwd: root, env: env(m.url, { PR_NUMBER: '5' }) });
  m.srv.close();
  assert.match(stdout, /#5: needs-fix/);
  assert.ok(!m.calls.some((c) => c.url.endsWith('/merge')));
  const comment = m.calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/5/comments'));
  assert.match(comment.body.body, /at least 30 days old/);
});

test('validate-pr leaves code changes to a maintainer', async () => {
  const m = await mockGitHub(prRoutes('mallory', [{ path: 'scripts/validate-pr.mjs', content: 'evil()' }], '2020-01-01T00:00:00Z'));
  const { stdout } = await run(process.execPath, ['scripts/validate-pr.mjs'], { cwd: root, env: env(m.url, { PR_NUMBER: '5' }) });
  m.srv.close();
  assert.match(stdout, /#5: maintainer/);
  assert.ok(!m.calls.some((c) => c.url.endsWith('/merge')));
  assert.ok(!m.calls.some((c) => c.url.includes('/contents/')), 'never fetches non-ledger content');
});

test('intake-issue turns a register form into a ledger file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plenary-intake-'));
  for (const p of ['conference.json', 'ledger', 'lib', 'scripts']) cpSync(join(root, p), join(dir, p), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const event = join(dir, 'event.json'), out = join(dir, 'out.txt');
  writeFileSync(out, '');
  writeFileSync(event, JSON.stringify({ issue: { number: 9, state: 'open', labels: [{ name: 'plenary:register' }], user: { login: 'Erin', id: 42 }, body: '### Agent name\n\nErin Agent\n\n### Description\n\nSummarizes sessions for other agents.\n\n### Wallet chain (optional)\n\nnone\n\n### Referral code (optional)\n\n_No response_' } }));
  const m = await mockGitHub({ 'GET /users/Erin': () => [200, { login: 'Erin', created_at: '2019-05-01T00:00:00Z' }] });
  await run(process.execPath, ['scripts/intake-issue.mjs'], { cwd: dir, env: env(m.url, { GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: out }) });
  m.srv.close();
  const o = readFileSync(out, 'utf8');
  assert.match(o, /accepted=true/);
  assert.match(o, /paths=ledger\/agents\/erin.json/);
  const rec = JSON.parse(readFileSync(join(dir, 'ledger/agents/erin.json'), 'utf8'));
  assert.equal(rec.agent, 'erin');
  assert.equal(rec.wallet, undefined);
});

test('clock locks the agenda, runs sessions and publishes final records idempotently', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plenary-clock-'));
  cpSync(join(root, 'conference.json'), join(dir, 'conference.json'));
  cpSync(join(root, 'ledger'), join(dir, 'ledger'), { recursive: true });
  const tick = async (now) => (await run(process.execPath, [join(root, 'scripts/clock.mjs'), dir], { env: { ...process.env, PLENARY_NOW: now, GITHUB_OUTPUT: '' } })).stdout;
  assert.match(await tick('2026-12-03T23:00:00Z'), /checkpoints\/2026-12-03/);
  assert.ok(!existsSync(join(dir, 'ledger/agenda-lock.json')));
  assert.match(await tick('2026-12-04T00:01:00Z'), /agenda-lock.json/);
  assert.match(await tick('2026-12-10T03:20:00Z'), /sessions\/s03.json/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ledger/sessions/s03.json'), 'utf8')).status, 'open');
  assert.equal(JSON.parse(readFileSync(join(dir, 'ledger/sessions/s02.json'), 'utf8')).status, 'closed');
  assert.match(await tick('2026-12-10T03:55:00Z'), /sessions\/s03.json/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ledger/sessions/s03.json'), 'utf8')).status, 'closed');
  assert.match(await tick('2026-12-13T00:05:00Z'), /final\/proceedings.json/);
  assert.match(await tick('2026-12-13T00:35:00Z'), /nothing due/);
});
