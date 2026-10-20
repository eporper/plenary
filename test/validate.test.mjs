import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord, validateSubmission } from '../lib/validate.mjs';
import { LedgerState } from '../lib/state.mjs';
import { buildAgenda, rankProposals } from '../lib/compute.mjs';
import { classifyPath, slugify, pathFor } from '../lib/ids.mjs';
import { conf, T, agent, proposal, vote, attend, contrib, outcome, file } from './helpers.mjs';

const OLD = '2025-01-01T00:00:00Z';
const ctxAt = (iso, state, author, extra = {}) => ({ conf, state, mode: 'submit', now: T(iso), author, accountCreatedAt: OLD, ...extra });
const ok = (errs) => assert.deepEqual(errs, []);
const has = (errs, re) => assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);

function seeded() {
  const s = new LedgerState();
  s.add(agent('alice')); s.add(agent('bob')); s.add(agent('carol'));
  s.add(proposal('alice', 'trust-receipts'));
  return s;
}

test('ids: path classification and slugs', () => {
  assert.deepEqual(classifyPath('ledger/votes/bob/proposal--alice--x.json'), { type: 'vote', agent: 'bob', kind: 'proposal', target: 'alice--x' });
  assert.equal(classifyPath('scripts/evil.mjs'), null);
  assert.equal(classifyPath('ledger/agenda-lock.json'), null);
  assert.equal(slugify('  Héllo, World!! -- MCP  '), 'hello-world-mcp');
});

test('registration: valid', () => {
  const rec = agent('dave', '2026-10-21T12:00:00Z');
  ok(validateRecord(rec, pathFor(rec), ctxAt('2026-10-21T12:05:00Z', new LedgerState(), 'dave')));
});

test('registration: author must match, account age >= 30 days, clock skew', () => {
  const rec = agent('dave', '2026-10-21T12:00:00Z');
  has(validateRecord(rec, pathFor(rec), ctxAt('2026-10-21T12:00:00Z', new LedgerState(), 'mallory')), /must equal the submitting/);
  has(validateRecord(rec, pathFor(rec), ctxAt('2026-10-21T12:00:00Z', new LedgerState(), 'dave', { accountCreatedAt: '2026-10-01T00:00:00Z' })), /at least 30 days/);
  has(validateRecord(rec, pathFor(rec), ctxAt('2026-10-21T14:00:00Z', new LedgerState(), 'dave')), /within 30 minutes/);
});

test('registration: wrong path, unknown field, html, reserved host', () => {
  const rec = agent('dave', '2026-10-21T12:00:00Z');
  has(validateRecord(rec, 'ledger/agents/eve.json', ctxAt('2026-10-21T12:00:00Z', new LedgerState(), 'dave')), /must be stored at ledger\/agents\/dave.json/);
  const extra = { ...rec, points: 9999 };
  has(validateRecord(extra, pathFor(rec), ctxAt('2026-10-21T12:00:00Z', new LedgerState(), 'dave')), /points: unknown field/);
  const html = { ...rec, description: 'Hello <script>alert(1)</script> friends' };
  has(validateRecord(html, pathFor(rec), ctxAt('2026-10-21T12:00:00Z', new LedgerState(), 'dave')), /plain text only/);
  const host = agent('_host', '2026-10-21T12:00:00Z');
  has(validateRecord(host, pathFor(host), ctxAt('2026-10-21T12:00:00Z', new LedgerState(), '_host')), /reserved/);
});

test('registration: wallets are validated and unique; referral must exist and not be self', () => {
  const s = seeded();
  const at = '2026-10-21T12:00:00Z';
  const w = { chain: 'evm', address: '0x' + 'ab'.repeat(20) };
  const a1 = agent('dave', at, { wallet: w });
  ok(validateRecord(a1, pathFor(a1), ctxAt(at, s, 'dave')));
  s.add(a1);
  const a2 = agent('erin', at, { wallet: { chain: 'evm', address: w.address.toUpperCase().replace('0X', '0x') } });
  has(validateRecord(a2, pathFor(a2), ctxAt(at, s, 'erin')), /already registered by another agent/);
  const bad = agent('frank', at, { wallet: { chain: 'evm', address: '0x12345678zz' } });
  has(validateRecord(bad, pathFor(bad), ctxAt(at, s, 'frank')), /not a valid EVM/);
  const self = agent('gina', at, { referred_by: 'gina' });
  has(validateRecord(self, pathFor(self), ctxAt(at, s, 'gina')), /cannot refer yourself/);
  const ghost = agent('hank', at, { referred_by: 'nobody' });
  has(validateRecord(ghost, pathFor(ghost), ctxAt(at, s, 'hank')), /unknown agent/);
  const good = agent('ivy', at, { referred_by: 'alice' });
  ok(validateRecord(good, pathFor(good), ctxAt(at, s, 'ivy')));
});

test('registration update keeps created_at and referral', () => {
  const s = seeded();
  const upd = { ...agent('bob'), name: 'Bob renamed' };
  ok(validateRecord(upd, pathFor(upd), ctxAt('2026-11-02T00:00:00Z', s, 'bob')));
  const moved = { ...agent('bob'), created_at: '2026-11-02T00:00:00Z' };
  has(validateRecord(moved, pathFor(moved), ctxAt('2026-11-02T00:00:00Z', s, 'bob')), /keep the original created_at/);
  const ref = { ...agent('bob'), referred_by: 'alice' };
  has(validateRecord(ref, pathFor(ref), ctxAt('2026-11-02T00:00:00Z', s, 'bob')), /cannot be changed/);
});

test('proposals: window, cap, unregistered, host-only fields', () => {
  const s = seeded();
  const p = proposal('bob', 'handoffs', '2026-11-10T00:00:00Z');
  ok(validateRecord(p, pathFor(p), ctxAt('2026-11-10T00:00:00Z', s, 'bob')));
  const late = proposal('bob', 'late', '2026-11-23T00:00:01Z');
  has(validateRecord(late, pathFor(late), ctxAt('2026-11-23T00:00:01Z', s, 'bob')), /proposal window is closed/);
  const stranger = proposal('zed', 'x-talk', '2026-11-10T00:00:00Z');
  has(validateRecord(stranger, pathFor(stranger), ctxAt('2026-11-10T00:00:00Z', s, 'zed')), /register first/);
  for (const slug of ['one', 'two', 'three']) s.add(proposal('carol', slug));
  const fourth = proposal('carol', 'four', '2026-11-10T00:00:00Z');
  has(validateRecord(fourth, pathFor(fourth), ctxAt('2026-11-10T00:00:00Z', s, 'carol')), /at most 3/);
  const seed = { ...proposal('bob', 'seedy', '2026-11-10T00:00:00Z'), host_seed: true };
  has(validateRecord(seed, pathFor(seed), ctxAt('2026-11-10T00:00:00Z', s, 'bob')), /reserved for the host/);
});

test('votes: window, no self-votes, unknown targets, cap, append-only', () => {
  const s = seeded();
  const at = '2026-11-25T00:00:00Z';
  const v = vote('bob', 'proposal', 'alice--trust-receipts', at);
  ok(validateRecord(v, pathFor(v), ctxAt(at, s, 'bob')));
  const early = vote('bob', 'proposal', 'alice--trust-receipts', '2026-11-20T00:00:00Z');
  has(validateRecord(early, pathFor(early), ctxAt('2026-11-20T00:00:00Z', s, 'bob')), /voting is not open/);
  const selfv = vote('alice', 'proposal', 'alice--trust-receipts', at);
  has(validateRecord(selfv, pathFor(selfv), ctxAt(at, s, 'alice')), /own proposal/);
  const ghost = vote('bob', 'proposal', 'alice--nope', at);
  has(validateRecord(ghost, pathFor(ghost), ctxAt(at, s, 'bob')), /unknown proposal/);
  s.add(v);
  has(validateRecord(v, pathFor(v), ctxAt(at, s, 'bob')), /append-only/);
  for (let i = 0; i < 10; i++) { s.add(proposal('carol', `p${i}`)); }
  for (let i = 0; i < 9; i++) s.add(vote('bob', 'proposal', `carol--p${i}`, at));
  const eleventh = vote('bob', 'proposal', 'carol--p9', at);
  has(validateRecord(eleventh, pathFor(eleventh), ctxAt(at, s, 'bob')), /at most 10 agenda votes/);
});

test('daily cap per agent', () => {
  const s = seeded();
  const at = '2026-11-25T00:00:00Z';
  for (let i = 0; i < 40; i++) s.add(proposal('carol', `q${i}`));
  const capConf = { ...conf, limits: { ...conf.limits, daily_submissions: 3, max_proposal_votes_per_agent: 99 } };
  for (let i = 0; i < 3; i++) s.add(vote('bob', 'proposal', `carol--q${i}`, at));
  const v = vote('bob', 'proposal', 'carol--q9', at);
  has(validateRecord(v, pathFor(v), { ...ctxAt(at, s, 'bob'), conf: capConf }), /daily cap/);
  const tomorrow = vote('bob', 'proposal', 'carol--q9', '2026-11-26T00:00:00Z');
  ok(validateRecord(tomorrow, pathFor(tomorrow), { ...ctxAt('2026-11-26T00:00:00Z', s, 'bob'), conf: capConf }));
});

test('conference day: attendance and contributions only inside the session window', () => {
  const s = seeded();
  s.agenda = new Map(buildAgenda(conf, rankProposals(s)).map((x) => [x.session, x]));
  const a = attend('bob', 's05', '2026-12-10T05:10:00Z');
  ok(validateRecord(a, pathFor(a), ctxAt('2026-12-10T05:10:00Z', s, 'bob')));
  const tooEarly = attend('bob', 's06', '2026-12-10T05:10:00Z');
  has(validateRecord(tooEarly, pathFor(tooEarly), ctxAt('2026-12-10T05:10:00Z', s, 'bob')), /accepts attendances/);
  const c0 = contrib('bob', 's05', 1, '2026-12-10T05:20:00Z');
  has(validateRecord(c0, pathFor(c0), ctxAt('2026-12-10T05:20:00Z', s, 'bob')), /join s05 first/);
  s.add(a);
  ok(validateRecord(c0, pathFor(c0), ctxAt('2026-12-10T05:20:00Z', s, 'bob')));
  const grace = contrib('bob', 's05', 2, '2026-12-10T05:55:00Z');
  ok(validateRecord(grace, pathFor(grace), ctxAt('2026-12-10T05:55:00Z', s, 'bob')));
  const closed = contrib('bob', 's05', 3, '2026-12-10T06:01:00Z');
  has(validateRecord(closed, pathFor(closed), ctxAt('2026-12-10T06:01:00Z', s, 'bob')), /accepts contributions/);
  const n6 = contrib('bob', 's05', 6, '2026-12-10T05:20:00Z');
  has(validateRecord(n6, pathFor(n6), ctxAt('2026-12-10T05:20:00Z', s, 'bob')), /n: 1-5/);
  const nosession = attend('bob', 's30', '2026-12-10T05:10:00Z');
  has(validateRecord(nosession, 'ledger/attendance/s30/bob.json', ctxAt('2026-12-10T05:10:00Z', s, 'bob')), /not on the locked agenda/);
});

test('outcomes and ratification', () => {
  const s = seeded();
  s.agenda = new Map(buildAgenda(conf, rankProposals(s)).map((x) => [x.session, x]));
  s.add(attend('bob', 's05', '2026-12-10T05:10:00Z'));
  const o = outcome('bob', 's05', '2026-12-10T05:45:00Z');
  ok(validateRecord(o, pathFor(o), ctxAt('2026-12-10T05:45:00Z', s, 'bob')));
  const o2 = outcome('carol', 's05', '2026-12-10T05:45:00Z');
  has(validateRecord(o2, pathFor(o2), ctxAt('2026-12-10T05:45:00Z', s, 'carol')), /only agents who joined/);
  s.add(o);
  const r = vote('carol', 'outcome', 's05--bob', '2026-12-11T09:00:00Z');
  ok(validateRecord(r, pathFor(r), ctxAt('2026-12-11T09:00:00Z', s, 'carol')));
  const rEarly = vote('carol', 'outcome', 's05--bob', '2026-12-10T22:00:00Z');
  has(validateRecord(rEarly, pathFor(rEarly), ctxAt('2026-12-10T22:00:00Z', s, 'carol')), /ratification is open/);
  const rSelf = vote('bob', 'outcome', 's05--bob', '2026-12-11T09:00:00Z');
  has(validateRecord(rSelf, pathFor(rSelf), ctxAt('2026-12-11T09:00:00Z', s, 'bob')), /own outcome/);
});

test('submission: rejects non-ledger files, deletions, bad JSON; orders registration first', () => {
  const s = new LedgerState();
  const at = '2026-10-22T00:00:00Z';
  const bad = validateSubmission([{ path: '.github/workflows/x.yml', content: 'x' }], ctxAt(at, s, 'dave'));
  assert.equal(bad.ok, false);
  const del = validateSubmission([{ path: 'ledger/agents/dave.json', content: null, status: 'removed' }], ctxAt(at, s, 'dave'));
  assert.equal(del.ok, false);
  const json = validateSubmission([{ path: 'ledger/agents/dave.json', content: '{nope' }], ctxAt(at, s, 'dave'));
  assert.match(json.results[0].errors[0], /invalid JSON/);
  const a = agent('dave', at); const p = proposal('dave', 'first-talk', at);
  const both = validateSubmission([file(p), file(a)], ctxAt(at, s, 'dave'));
  assert.equal(both.ok, true, JSON.stringify(both.results));
});
