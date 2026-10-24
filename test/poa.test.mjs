// Optional PoA badge: address format, challenge, public-source checks (verified / pending / rejected),
// gating of the PoA track and ratification, and badges in the published data. No network: every
// source is a mock fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRecord } from '../lib/validate.mjs';
import { LedgerState } from '../lib/state.mjs';
import { buildAgenda, rankProposals, computeAll } from '../lib/compute.mjs';
import { pathFor } from '../lib/ids.mjs';
import {
  isPoaAddress, challengeCode, recheckAll, emptyStatus, poaCounts, badgeAt, forceDue, fetchJson, currentBadge,
} from '../lib/poa.mjs';
import { conf, T, agent, proposal, vote, attend, contrib, outcome, entry } from './helpers.mjs';

const OLD = '2025-01-01T00:00:00Z';
const ctxAt = (iso, state, author, extra = {}) => ({ conf, state, mode: 'submit', now: T(iso), author, accountCreatedAt: OLD, ...extra });
const ok = (errs) => assert.deepEqual(errs, []);
const has = (errs, re) => assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);

const ADDR = 'poa1' + 'A'.repeat(44);
const OTHER = 'poa1' + 'B'.repeat(44);
const NOW = T('2026-11-01T12:00:00Z');
const H = 3_600_000;

// Mock of the three public sources, shaped like the confirmed responses (see POA.md).
function sources({ established = true, maintenance = false, slashed = [], ejected = [], comments = [], down = [] } = {}) {
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const fetch = async (url, opts = {}) => {
    calls.push(url);
    for (const d of down) if (d === 'timeout' || url.includes(d)) { if (d === 'timeout') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))); throw new Error('connect ECONNREFUSED'); }
    if (url.includes('/api/v1/address/')) {
      const address = decodeURIComponent(url.split('/address/')[1]);
      return json({ address, established, fetch_error: null, meta: { stale: false, node_stale: false, maintenance: { active: maintenance } } });
    }
    if (url.includes('/epoch-records')) {
      const from = Number(new URL(url).searchParams.get('from'));
      if (from > 1) return json({ from, next_from: null, records: [] });
      return json({ from, next_from: null, records: [{ epoch: 0, record: { basis: { slashed: [], ejected: [] } } }, { epoch: 1, record: { basis: { slashed, ejected } } }] });
    }
    if (url.includes('/lableak/api/posts/')) return json({ id: 77, author_public_id: 'abc123', body: 'Proof thread', comments });
    return json({ error: 'not found' }, 404);
  };
  return { fetch, calls };
}

const rec = (extra = {}) => agent('dave', '2026-10-25T10:00:00Z', { poa_address: ADDR, poa_proof_post: 77, ...extra });
const code = () => challengeCode(conf, { submission: 12, agent: 'dave', address: ADDR });
const run = (src, opts = {}) => recheckAll(conf, { agents: [opts.rec || rec()], status: opts.status || emptyStatus(), now: opts.now ?? NOW, force: opts.force ?? false, submissions: { dave: { number: 12, source: 'pr' } } }, { fetch: src.fetch });

test('poa: address format is checked loosely (poa1 + base58)', () => {
  assert.ok(isPoaAddress(conf, ADDR));
  assert.ok(isPoaAddress(conf, 'poa1pDjEUfb49rqX3okgZBhUGpTnwDsmw2jwFA9EfXvqRQGu'));
  for (const bad of ['poa2' + 'A'.repeat(44), 'poa1' + '0'.repeat(44), 'poa1short', 'POA1' + 'A'.repeat(44), 'poa1' + 'A'.repeat(44) + ' ', 42, null]) assert.ok(!isPoaAddress(conf, bad), String(bad));
});

test('poa: registration without poa_address still works; with one it is validated and unique', () => {
  const at = '2026-10-21T12:00:00Z';
  const plain = agent('erin', at);
  ok(validateRecord(plain, pathFor(plain), ctxAt(at, new LedgerState(), 'erin')));
  const s = new LedgerState();
  const withPoa = agent('dave', at, { poa_address: ADDR });
  ok(validateRecord(withPoa, pathFor(withPoa), ctxAt(at, s, 'dave')));
  s.add(withPoa);
  const dup = agent('frank', at, { poa_address: ADDR });
  has(validateRecord(dup, pathFor(dup), ctxAt(at, s, 'frank')), /already registered by another agent/);
  const bad = agent('gina', at, { poa_address: '0xabc' });
  has(validateRecord(bad, pathFor(bad), ctxAt(at, s, 'gina')), /poa_address: must be a PoA public id/);
  const proofOnly = agent('hank', at, { poa_proof_post: 5 });
  has(validateRecord(proofOnly, pathFor(proofOnly), ctxAt(at, s, 'hank')), /needs poa_address/);
  const off = { ...conf, poa: { ...conf.poa, enabled: false } };
  has(validateRecord(withPoa, pathFor(withPoa), { ...ctxAt(at, new LedgerState(), 'dave'), conf: off }), /switched off/);
});

test('poa: challenge code is short, deterministic and bound to submission, agent and address', () => {
  const c = code();
  assert.match(c, /^plenary-poa-[0-9a-f]{12}$/);
  assert.equal(c, code());
  assert.notEqual(c, challengeCode(conf, { submission: 13, agent: 'dave', address: ADDR }));
  assert.notEqual(c, challengeCode(conf, { submission: 12, agent: 'erin', address: ADDR }));
  assert.notEqual(c, challengeCode(conf, { submission: 12, agent: 'dave', address: OTHER }));
});

test('poa: verified when the forum comment author is the address, it is established and not slashed', async () => {
  const src = sources({ comments: [{ id: 501, author_public_id: ADDR, body: `my code: ${code()}` }] });
  const { status, transitions } = await run(src);
  const e = status.agents.dave;
  assert.equal(e.badge, 'verified', e.reason);
  assert.equal(e.ownership.comment_id, 501);
  assert.equal(e.challenge, code());
  assert.deepEqual(transitions.map((t) => t.to), ['verified']);
  assert.ok(src.calls.every((u) => !/key=|token=|pk_/.test(u)), 'only public URLs, no keys');
});

test('poa: API down or timing out marks pending, never rejected; a later re-check upgrades it', async () => {
  for (const down of [['poascan.io'], ['minepoa.com'], ['epoch-records'], ['timeout']]) {
    const src = sources({ down, comments: [{ id: 1, author_public_id: ADDR, body: code() }] });
    const P = { ...conf, poa: { ...conf.poa, timeout_ms: 50 } };
    const { status } = await recheckAll(P, { agents: [rec()], status: emptyStatus(), now: NOW, submissions: { dave: { number: 12 } } }, { fetch: src.fetch });
    assert.equal(status.agents.dave.badge, 'pending', `${down}: ${status.agents.dave.reason}`);
  }
  // network maintenance: not established is not an affirmative negative while the explorer reports maintenance
  const maint = await run(sources({ established: false, maintenance: true, comments: [{ id: 1, author_public_id: ADDR, body: code() }] }));
  assert.equal(maint.status.agents.dave.badge, 'pending');
  // re-check after the outage
  const up = await run(sources({ comments: [{ id: 1, author_public_id: ADDR, body: code() }] }), { status: maint.status, now: NOW + 4 * H });
  assert.equal(up.status.agents.dave.badge, 'verified');
  assert.deepEqual(up.status.agents.dave.history.map((h) => h.badge), ['pending', 'verified']);
});

test('poa: code not posted yet or no thread yet is pending', async () => {
  assert.equal((await run(sources({ comments: [] }))).status.agents.dave.badge, 'pending');
  const noThread = await run(sources(), { rec: rec({ poa_proof_post: undefined }) });
  assert.match(noThread.status.agents.dave.reason, /no forum thread/);
  assert.equal(noThread.status.agents.dave.badge, 'pending');
});

test('poa: affirmative negatives reject: slashed, ejected, not established, author mismatch', async () => {
  const mine = [{ id: 1, author_public_id: ADDR, body: code() }];
  const slashed = await run(sources({ slashed: [ADDR], comments: mine }));
  assert.equal(slashed.status.agents.dave.badge, 'rejected');
  assert.match(slashed.status.agents.dave.reason, /slashed at epoch 1/);
  assert.equal((await run(sources({ ejected: [ADDR], comments: mine }))).status.agents.dave.badge, 'rejected');
  const notEst = await run(sources({ established: false, comments: mine }));
  assert.equal(notEst.status.agents.dave.badge, 'rejected');
  assert.match(notEst.status.agents.dave.reason, /not established/);
  const mismatch = await run(sources({ comments: [{ id: 2, author_public_id: OTHER, body: code() }] }));
  assert.equal(mismatch.status.agents.dave.badge, 'rejected');
  assert.match(mismatch.status.agents.dave.reason, /author mismatch/);
  // a mismatch is re-checked: once the real owner posts the code, the badge upgrades
  const fixed = await run(sources({ comments: [{ id: 2, author_public_id: OTHER, body: code() }, { id: 3, author_public_id: ADDR, body: code() }] }), { status: mismatch.status, now: NOW + 4 * H });
  assert.equal(fixed.status.agents.dave.badge, 'verified');
});

test('poa: a verified badge survives an outage within stale_grace_hours, then drops to pending', async () => {
  const mine = [{ id: 1, author_public_id: ADDR, body: code() }];
  const v = await run(sources({ comments: mine }));
  const out1 = await run(sources({ down: ['poascan.io'] }), { status: v.status, now: NOW + 25 * H });
  assert.equal(out1.status.agents.dave.badge, 'verified');
  assert.equal(out1.status.agents.dave.stale, true);
  const out2 = await run(sources({ down: ['poascan.io'] }), { status: out1.status, now: NOW + 100 * H });
  assert.equal(out2.status.agents.dave.badge, 'pending');
  assert.notEqual(out2.status.agents.dave.badge, 'rejected');
});

test('poa: re-check cadence and the forced re-check before the agenda lock', async () => {
  const v = await run(sources({ comments: [{ id: 1, author_public_id: ADDR, body: code() }] }));
  const src = sources();
  const soon = await run(src, { status: v.status, now: NOW + 2 * H });
  assert.deepEqual(soon.checked, [], 'verified agents are not re-checked within verified_hours');
  assert.equal(src.calls.length, 0);
  assert.equal(forceDue(conf, v.status, T('2026-12-03T20:00:00Z')), true);
  assert.equal(forceDue(conf, v.status, T('2026-12-02T20:00:00Z')), false);
  const forced = await run(sources({ comments: [{ id: 1, author_public_id: ADDR, body: code() }] }), { status: v.status, now: T('2026-12-03T20:00:00Z') });
  assert.deepEqual(forced.checked, ['dave']);
  assert.equal(forced.status.forced.last_at, '2026-12-03T20:00:00Z');
  assert.equal(forceDue(conf, forced.status, T('2026-12-03T23:00:00Z')), false, 'once per window');
});

test('poa: fetchJson turns a hung request into a timeout error instead of throwing', async () => {
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const r = await fetchJson('https://example.invalid/x', { fetchImpl: hang, timeoutMs: 20 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timeout/);
});

// ---- gating
function poaWorld(badge) {
  const s = new LedgerState();
  s.add(agent('alice')); s.add(agent('bob')); s.add(rec());
  const track = { ...proposal('alice', 'poa-receipts'), track: 'poa' };
  s.add(track);
  s.add(proposal('bob', 'plain-session'));
  const agenda = buildAgenda(conf, rankProposals(s), { minVotes: 0 });
  s.agenda = new Map(agenda.map((x) => [x.session, x]));
  const poaSession = agenda.find((x) => x.proposal === track.id).session;
  const status = emptyStatus();
  if (badge) status.agents.dave = { address: ADDR, badge, history: [{ at: '2026-11-01T00:00:00Z', badge }] };
  return { s, status, poaSession, normal: agenda.find((x) => x.kind === 'voted' && x.proposal !== track.id).session };
}
const at = (sess, min) => `2026-12-10T${sess.slice(1)}:${String(min).padStart(2, '0')}:00Z`;

test('gating: PoA track sessions need a verified badge; pending does not count; other sessions stay open', () => {
  for (const [badge, allowed] of [['verified', true], ['pending', false], ['rejected', false], [null, false]]) {
    const { s, status, poaSession } = poaWorld(badge);
    const a = attend('dave', poaSession, at(poaSession, 5));
    const errs = validateRecord(a, pathFor(a), ctxAt(at(poaSession, 5), s, 'dave', { poa: status }));
    if (allowed) ok(errs); else has(errs, /PoA-verified agents only/);
  }
  const { s, status, poaSession, normal } = poaWorld('pending');
  const b = attend('bob', poaSession, at(poaSession, 5));
  has(validateRecord(b, pathFor(b), ctxAt(at(poaSession, 5), s, 'bob', { poa: status })), /no poa_address/);
  const n = attend('bob', normal, at(normal, 5));
  ok(validateRecord(n, pathFor(n), ctxAt(at(normal, 5), s, 'bob', { poa: status })));
  // pending_counts switches the rule
  const lax = { ...conf, poa: { ...conf.poa, gating: { ...conf.poa.gating, pending_counts: true } } };
  const d = attend('dave', poaSession, at(poaSession, 5));
  ok(validateRecord(d, pathFor(d), { ...ctxAt(at(poaSession, 5), s, 'dave', { poa: status }), conf: lax }));
  // switched off entirely
  const off = { ...conf, poa: { ...conf.poa, enabled: false } };
  ok(validateRecord(b, pathFor(b), { ...ctxAt(at(poaSession, 5), s, 'bob', { poa: status }), conf: off }));
});

test('gating: ratification of PoA track outcomes needs the badge ("poa_track"); "all" gates every ratification', () => {
  const { s, status, poaSession, normal } = poaWorld('verified');
  s.agents.set('carol', agent('carol'));
  for (const sess of [poaSession, normal]) { s.add(attend('dave', sess, at(sess, 5))); s.add(outcome('dave', sess, at(sess, 45))); }
  const r1 = vote('bob', 'outcome', `${poaSession}--dave`, '2026-12-11T09:00:00Z');
  has(validateRecord(r1, pathFor(r1), ctxAt('2026-12-11T09:00:00Z', s, 'bob', { poa: status })), /ratification is open to PoA-verified/);
  const r2 = vote('bob', 'outcome', `${normal}--dave`, '2026-12-11T09:00:00Z');
  ok(validateRecord(r2, pathFor(r2), ctxAt('2026-12-11T09:00:00Z', s, 'bob', { poa: status })));
  const all = { ...conf, poa: { ...conf.poa, gating: { ...conf.poa.gating, ratification: 'all' } } };
  has(validateRecord(r2, pathFor(r2), { ...ctxAt('2026-12-11T09:00:00Z', s, 'bob', { poa: status }), conf: all }), /PoA-verified/);
});

test('gating in audit replay uses the badge at the record time; badges appear in agents.json and proceedings', () => {
  const p = { ...proposal('alice', 'poa-receipts', '2026-11-01T10:00:00Z'), track: 'poa' };
  const entries = [agent('alice'), agent('bob'), rec(), p, vote('bob', 'proposal', p.id)].map(entry);
  const base = computeAll(conf, entries, { now: T('2026-12-05T00:00:00Z') });
  const sess = base.agenda.sessions.find((x) => x.proposal === p.id);
  assert.equal(sess.track, 'poa');
  const lock = { sessions: base.agenda.sessions };
  const early = attend('dave', sess.session, at(sess.session, 5));
  const status = emptyStatus();
  // pending until 05:10 on conference day, verified afterwards
  status.agents.dave = { address: ADDR, badge: 'verified', checked_at: at(sess.session, 10), history: [{ at: '2026-11-01T00:00:00Z', badge: 'pending' }, { at: at(sess.session, 10), badge: 'verified' }] };
  assert.equal(badgeAt(status.agents.dave, T(at(sess.session, 5))), 'pending');
  assert.ok(poaCounts(conf, status, rec(), T(at(sess.session, 20))));
  const late = { ...attend('dave', sess.session, at(sess.session, 20)), agent: 'dave' };
  const r1 = computeAll(conf, [...entries, entry(early)], { now: T('2026-12-14T00:00:00Z'), agendaLock: lock, poaStatus: status });
  assert.ok(r1.rejected.some((x) => /PoA-verified/.test(x.errors.join(' '))), 'attendance while pending is not counted');
  const r2 = computeAll(conf, [...entries, entry(late), entry(contrib('dave', sess.session, 1, at(sess.session, 25)))], { now: T('2026-12-14T00:00:00Z'), agendaLock: lock, poaStatus: status });
  assert.deepEqual(r2.rejected, []);
  const d = r2.agents.find((x) => x.agent === 'dave');
  assert.equal(d.poa.badge, 'verified');
  assert.equal(d.poa.address, ADDR);
  assert.equal(r2.agents.find((x) => x.agent === 'bob').poa, null);
  const ps = r2.proceedings.sessions.find((x) => x.session === sess.session);
  assert.equal(ps.track, 'poa');
  assert.equal(ps.attendee_poa.verified, 1);
  assert.equal(r2.proceedings.totals.poa_verified_agents, 1);
  assert.equal(currentBadge(null, rec()), 'pending', 'no check yet = pending');
});
