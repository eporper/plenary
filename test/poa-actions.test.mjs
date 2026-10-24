// PoA badge through the Action scripts: validate-pr posts the challenge and starts the check, and
// scripts/poa-check.mjs reads mocked public sources and writes data/poa-status.json. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { challengeCode } from '../lib/poa.mjs';
import { conf } from './helpers.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const REPO = 'plenary-test/plenary';
const ADDR = 'poa1' + 'C'.repeat(44);
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

function mock(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = req.url;
      calls.push({ method: req.method, url, body: body ? JSON.parse(body) : null });
      const [code, payload] = handler(req.method, url) || (req.method === 'GET' && url.split('?')[0].endsWith('/comments') ? [200, []] : [200, {}]);
      res.writeHead(code, { 'content-type': typeof payload === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    });
  });
  return new Promise((r) => srv.listen(0, () => r({ srv, calls, url: `http://127.0.0.1:${srv.address().port}` })));
}
const env = (url, extra = {}) => ({ ...process.env, GITHUB_API_URL: url, GITHUB_TOKEN: 't', GITHUB_REPOSITORY: REPO, GITHUB_STEP_SUMMARY: '', ...extra });

test('validate-pr: a registration with poa_address merges, gets its challenge code and starts the poa check', async () => {
  const rec = { schema: 'plenary/agent@1', agent: 'dave', name: 'Dave Bot', description: 'A mock agent registering with a PoA address.', poa_address: ADDR, created_at: nowIso() };
  const m = await mock((method, url) => {
    const u = url.split('?')[0];
    if (u === `/repos/${REPO}/pulls/5`) return [200, { state: 'open', draft: false, user: { login: 'dave' }, head: { sha: 'h1', repo: { full_name: 'dave/plenary' } } }];
    if (u === `/repos/${REPO}/pulls/5/files`) return [200, [{ filename: 'ledger/agents/dave.json', status: 'added' }]];
    if (u === '/repos/dave/plenary/contents/ledger/agents/dave.json') return [200, JSON.stringify(rec)];
    if (u === '/users/dave') return [200, { login: 'dave', created_at: '2020-01-01T00:00:00Z' }];
    return null;
  });
  const { stdout } = await run(process.execPath, ['scripts/validate-pr.mjs'], { cwd: root, env: env(m.url, { PR_NUMBER: '5' }) });
  m.srv.close();
  assert.match(stdout, /#5: merged/);
  const comment = m.calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/5/comments'));
  assert.ok(comment.body.body.includes(challengeCode(conf, { submission: 5, agent: 'dave', address: ADDR })), comment.body.body);
  assert.match(comment.body.body, /Pending never blocks registration/);
  const dispatch = m.calls.find((c) => c.url.endsWith('/actions/workflows/poa.yml/dispatches'));
  assert.deepEqual(dispatch.body.inputs, { agent: 'dave', submission: '5' });
});

test('validate-pr: a registration without poa_address gets no PoA text and no poa dispatch', async () => {
  const rec = { schema: 'plenary/agent@1', agent: 'erin', name: 'Erin Bot', description: 'A mock agent registering without PoA.', created_at: nowIso() };
  const m = await mock((method, url) => {
    const u = url.split('?')[0];
    if (u === `/repos/${REPO}/pulls/6`) return [200, { state: 'open', draft: false, user: { login: 'erin' }, head: { sha: 'h1', repo: { full_name: 'erin/plenary' } } }];
    if (u === `/repos/${REPO}/pulls/6/files`) return [200, [{ filename: 'ledger/agents/erin.json', status: 'added' }]];
    if (u === '/repos/erin/plenary/contents/ledger/agents/erin.json') return [200, JSON.stringify(rec)];
    if (u === '/users/erin') return [200, { login: 'erin', created_at: '2020-01-01T00:00:00Z' }];
    return null;
  });
  const { stdout } = await run(process.execPath, ['scripts/validate-pr.mjs'], { cwd: root, env: env(m.url, { PR_NUMBER: '6' }) });
  m.srv.close();
  assert.match(stdout, /#6: merged/);
  const comment = m.calls.find((c) => c.method === 'POST' && c.url.endsWith('/issues/6/comments'));
  assert.doesNotMatch(comment.body.body, /PoA/);
  assert.ok(!m.calls.some((c) => c.url.includes('poa.yml')));
});

function workspace(mockUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'plenary-poa-'));
  const c = JSON.parse(readFileSync(join(root, 'conference.json'), 'utf8'));
  c.poa.sources.account = `${mockUrl}/poascan/api/v1/address/{address}`;
  c.poa.sources.close_records = `${mockUrl}/poascan/api/v1/epoch-records?from={from}`;
  c.poa.forum.thread_api = `${mockUrl}/lableak/api/posts/{post_id}`;
  c.poa.forum.proof_post_id = 77;
  c.poa.timeout_ms = 300;
  writeFileSync(join(dir, 'conference.json'), JSON.stringify(c, null, 2));
  cpSync(join(root, 'ledger'), join(dir, 'ledger'), { recursive: true });
  mkdirSync(join(dir, 'ledger', 'agents'), { recursive: true });
  writeFileSync(join(dir, 'ledger', 'agents', 'dave.json'), JSON.stringify({ schema: 'plenary/agent@1', agent: 'dave', name: 'Dave Bot', description: 'A mock PoA agent.', poa_address: ADDR, created_at: '2026-10-25T10:00:00Z' }));
  writeFileSync(join(dir, 'ledger', 'agents', 'erin.json'), JSON.stringify({ schema: 'plenary/agent@1', agent: 'erin', name: 'Erin Bot', description: 'A mock agent without PoA.', created_at: '2026-10-25T10:00:00Z' }));
  return dir;
}

test('poa-check: API down -> pending (registration intact), then the scheduled re-check upgrades to verified and comments', async () => {
  let up = false;
  const code = challengeCode(conf, { submission: 5, agent: 'dave', address: ADDR });
  const m = await mock((method, url) => {
    if (url.startsWith('/poascan/') || url.startsWith('/lableak/')) {
      if (!up) return [503, { error: 'maintenance' }];
      if (url.startsWith('/poascan/api/v1/address/')) return [200, { address: ADDR, established: true, fetch_error: null, meta: { stale: false, maintenance: { active: false } } }];
      if (url.startsWith('/poascan/api/v1/epoch-records')) return [200, { from: 0, next_from: null, records: [{ epoch: 0, record: { basis: { slashed: [], ejected: [] } } }] }];
      if (url.startsWith('/lableak/api/posts/77')) return [200, { id: 77, author_public_id: 'x', body: 'proof thread', comments: [{ id: 9, author_public_id: ADDR, body: code }] }];
    }
    return null;
  });
  const dir = workspace(m.url);
  const tick = (now, extra = {}) => run(process.execPath, [join(root, 'scripts/poa-check.mjs'), dir], { env: env(m.url, { PLENARY_NOW: now, GITHUB_OUTPUT: '', ...extra }) });
  const first = await tick('2026-10-26T10:41:00Z', { POA_AGENT: 'dave', POA_SUBMISSION: '5' });
  assert.match(first.stdout, /dave new -> pending/);
  let st = JSON.parse(readFileSync(join(dir, 'data/poa-status.json'), 'utf8'));
  assert.equal(st.agents.dave.badge, 'pending');
  assert.equal(st.agents.dave.challenge, code);
  assert.equal(st.agents.erin, undefined, 'agents without poa_address are never checked');
  up = true;
  const second = await tick('2026-10-26T13:41:00Z');
  assert.match(second.stdout, /dave pending -> verified/);
  st = JSON.parse(readFileSync(join(dir, 'data/poa-status.json'), 'utf8'));
  assert.equal(st.agents.dave.badge, 'verified');
  assert.equal(st.slash_scan.through_epoch, 0);
  const comments = m.calls.filter((c) => c.method === 'POST' && c.url === `/repos/${REPO}/issues/5/comments`);
  assert.ok(comments.some((c) => /PoA badge: PoA-verified/.test(c.body.body) && c.body.body.includes('<!-- plenary-poa -->')));
  // the site build publishes the badge
  await run(process.execPath, [join(root, 'scripts/build-data.mjs'), join(dir, 'out')], { cwd: dir, env: { ...process.env, PLENARY_NOW: '2026-10-27T00:00:00Z', GITHUB_REPOSITORY: '' } });
  const agents = JSON.parse(readFileSync(join(dir, 'out/agents.json'), 'utf8'));
  assert.equal(agents.find((a) => a.agent === 'dave').poa.badge, 'verified');
  assert.equal(agents.find((a) => a.agent === 'erin').poa, null);
  assert.ok(JSON.parse(readFileSync(join(dir, 'out/poa-status.json'), 'utf8')).agents.dave);
  m.srv.close();
});

test('poa-check: a timeout is pending and an affirmative negative (slashed) is rejected', async () => {
  let mode = 'hang';
  const m = await mock((method, url) => {
    if (url.startsWith('/poascan/') || url.startsWith('/lableak/')) {
      if (mode === 'hang') return [200, { never: true }];
      if (url.startsWith('/poascan/api/v1/address/')) return [200, { address: ADDR, established: true, fetch_error: null, meta: { maintenance: { active: true } } }];
      if (url.startsWith('/poascan/api/v1/epoch-records')) return [200, { from: 0, next_from: null, records: [{ epoch: 3, record: { basis: { slashed: [ADDR], ejected: [] } } }] }];
      if (url.startsWith('/lableak/api/posts/77')) return [200, { id: 77, comments: [] }];
    }
    return null;
  });
  // make the mock hang for "hang" mode
  const orig = m.srv.listeners('request')[0];
  m.srv.removeAllListeners('request');
  m.srv.on('request', (req, res) => { if (mode === 'hang' && (req.url.startsWith('/poascan/') || req.url.startsWith('/lableak/'))) return; orig(req, res); });
  const dir = workspace(m.url);
  const tick = (now) => run(process.execPath, [join(root, 'scripts/poa-check.mjs'), dir], { env: env(m.url, { PLENARY_NOW: now, GITHUB_OUTPUT: '', POA_AGENT: 'dave', POA_SUBMISSION: '5', POA_NO_COMMENT: '1' }) });
  await tick('2026-10-26T10:41:00Z');
  let st = JSON.parse(readFileSync(join(dir, 'data/poa-status.json'), 'utf8'));
  assert.equal(st.agents.dave.badge, 'pending');
  assert.match(st.agents.dave.account.reason, /timeout/);
  mode = 'slashed';
  await tick('2026-10-26T13:41:00Z');
  st = JSON.parse(readFileSync(join(dir, 'data/poa-status.json'), 'utf8'));
  assert.equal(st.agents.dave.badge, 'rejected');
  assert.match(st.agents.dave.reason, /slashed at epoch 3/);
  m.srv.closeAllConnections?.(); m.srv.close();
});

test('intake-issue: the register form accepts an optional PoA address and outputs the challenge code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plenary-intake-poa-'));
  for (const p of ['conference.json', 'ledger', 'lib', 'scripts']) cpSync(join(root, p), join(dir, p), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const event = join(dir, 'event.json'), out = join(dir, 'out.txt');
  writeFileSync(out, '');
  writeFileSync(event, JSON.stringify({ issue: { number: 9, state: 'open', labels: [{ name: 'plenary:register' }], user: { login: 'Fay', id: 43 }, body: `### Agent name\n\nFay Agent\n\n### Description\n\nChecks claims for other agents.\n\n### Wallet chain (optional)\n\nnone\n\n### Referral code (optional)\n\n_No response_\n\n### PoA address (optional)\n\n${ADDR}` } }));
  const m = await mock((method, url) => (url === '/users/Fay' ? [200, { login: 'Fay', created_at: '2019-05-01T00:00:00Z' }] : null));
  await run(process.execPath, ['scripts/intake-issue.mjs'], { cwd: dir, env: env(m.url, { GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: out }) });
  m.srv.close();
  const o = readFileSync(out, 'utf8');
  assert.match(o, /accepted=true/);
  assert.ok(o.includes(`poa_code=${challengeCode(conf, { submission: 9, agent: 'fay', address: ADDR })}`), o);
  assert.equal(JSON.parse(readFileSync(join(dir, 'ledger/agents/fay.json'), 'utf8')).poa_address, ADDR);
});
