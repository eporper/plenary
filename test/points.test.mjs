import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAll } from '../lib/compute.mjs';
import { buildTree, verifyProof } from '../lib/merkle.mjs';
import { loadEntries } from '../lib/ledger-io.mjs';
import { fileURLToPath } from 'node:url';
import { conf, agent, proposal, vote, attend, contrib, outcome, entry } from './helpers.mjs';

const SEEDS = loadEntries(fileURLToPath(new URL('..', import.meta.url))).filter((e) => e.rec.agent === '_host');

function scenario() {
  const recs = [
    agent('alice'), agent('bob'), agent('carol'),
    agent('dave', '2026-10-26T00:00:00Z', { referred_by: 'alice', wallet: { chain: 'evm', address: '0x' + '11'.repeat(20) } }),
    agent('erin', '2026-10-26T00:00:00Z', { referred_by: 'alice' }),
    agent('mallory'),
    proposal('alice', 'a-talk', '2026-11-01T00:00:00Z'),
    proposal('bob', 'b-talk', '2026-11-02T00:00:00Z'),
    proposal('mallory', 'm-talk', '2026-11-03T00:00:00Z'),
    vote('bob', 'proposal', 'alice--a-talk'), vote('carol', 'proposal', 'alice--a-talk'),
    vote('dave', 'proposal', 'bob--b-talk'), vote('alice', 'proposal', 'bob--b-talk'),
    // tampered: vote recorded outside the voting window must be ignored by the audit replay
    vote('mallory', 'proposal', 'bob--b-talk', '2026-12-05T00:00:00Z'),
    attend('bob', 's01', '2026-12-10T01:01:00Z'), attend('carol', 's01', '2026-12-10T01:02:00Z'),
    attend('dave', 's01', '2026-12-10T01:03:00Z'), attend('mallory', 's01', '2026-12-10T01:04:00Z'),
    contrib('bob', 's01', 1, '2026-12-10T01:10:00Z'),
    contrib('dave', 's01', 1, '2026-12-10T01:11:00Z'),
    contrib('mallory', 's01', 1, '2026-12-10T01:12:00Z'), contrib('mallory', 's01', 2, '2026-12-10T01:13:00Z'),
    vote('carol', 'contribution', 's01--bob--1', '2026-12-10T01:20:00Z'),
    outcome('bob', 's01', '2026-12-10T01:45:00Z'), outcome('mallory', 's01', '2026-12-10T01:46:00Z'),
    vote('carol', 'outcome', 's01--bob', '2026-12-11T03:00:00Z'), vote('dave', 'outcome', 's01--bob', '2026-12-11T03:01:00Z'),
  ];
  return [...SEEDS, ...recs.map(entry)];
}

const byAgent = (r) => Object.fromEntries(r.leaderboard.map((x) => [x.agent, x]));

test('agenda: ranked by distinct peer votes, ties by earliest proposal, unvoted not scheduled', () => {
  const r = computeAll(conf, scenario(), { now: Date.parse('2026-12-20T00:00:00Z') });
  const s = Object.fromEntries(r.agenda.sessions.map((x) => [x.session, x]));
  assert.equal(s.s00.proposal, '_host--opening-plenary');
  assert.equal(s.s01.proposal, 'alice--a-talk');
  assert.equal(s.s02.proposal, 'bob--b-talk');
  assert.equal(s.s03.kind, 'open-floor');
  assert.equal(s.s23.proposal, '_host--closing-plenary');
  assert.equal(r.proposals.find((p) => p.id === 'bob--b-talk').votes, 2, 'out-of-window vote ignored');
  assert.ok(r.rejected.some((x) => x.path === 'ledger/votes/mallory/proposal--bob--b-talk.json'));
});

test('points: published rules applied exactly', () => {
  const r = computeAll(conf, scenario(), { now: Date.parse('2026-12-20T00:00:00Z') });
  const a = byAgent(r);
  assert.equal(a.alice.points, 5 + 1 + 4 + 40 + 10, JSON.stringify(a.alice.breakdown));
  assert.equal(a.bob.points, 5 + 1 + 4 + 40 + 1 + 2 + 4 + 30, JSON.stringify(a.bob.breakdown));
  assert.equal(a.carol.points, 5 + 1 + 1 + 1);
  assert.equal(a.dave.points, 5 + 1 + 1 + 1);
  assert.equal(a.erin.points, 5, 'referral of an inactive agent earns nothing');
  assert.equal(a.mallory.points, 5 + 1, 'self-dealing without peer endorsement earns little');
  assert.equal(r.leaderboard[0].agent, 'bob');
  assert.equal(a.dave.account, 'evm:0x' + '11'.repeat(20));
  assert.equal(a.alice.account, 'github:alice');
  assert.equal(r.agents.find((x) => x.agent === '_host'), undefined, 'host earns no points');
});

test('outcomes: adoption needs quorum of peer ratifications', () => {
  const r = computeAll(conf, scenario(), { now: Date.parse('2026-12-20T00:00:00Z') });
  const s01 = r.proceedings.sessions.find((s) => s.session === 's01');
  assert.equal(s01.outcome.status, 'ratified');
  assert.equal(s01.outcome.id, 's01--bob');
  assert.equal(r.proceedings.final, true);
  assert.equal(r.proceedings.sessions.find((s) => s.session === 's02').outcome.status, 'none');
});

test('caps: contribution points per item and attendance are capped', () => {
  const recs = [agent('alice'), agent('bob')];
  const peers = Array.from({ length: 6 }, (_, i) => `peer${i}`);
  for (const p of peers) recs.push(agent(p));
  recs.push(proposal('alice', 'capped', '2026-11-01T00:00:00Z'));
  recs.push(vote('bob', 'proposal', 'alice--capped'));
  recs.push(attend('alice', 's01', '2026-12-10T01:00:00Z'), contrib('alice', 's01', 1, '2026-12-10T01:05:00Z'));
  peers.forEach((p, i) => recs.push(vote(p, 'contribution', 's01--alice--1', `2026-12-10T01:1${i}:00Z`)));
  const r = computeAll(conf, recs.map(entry), { now: Date.parse('2026-12-20T00:00:00Z') });
  const a = byAgent(r);
  assert.equal(a.alice.breakdown.contributions, conf.points.contribution_endorsement_cap_per_item);
});

test('snapshot: deterministic and order independent; proofs verify', () => {
  const e = scenario();
  const r1 = computeAll(conf, e, { now: 0 });
  const r2 = computeAll(conf, [...e].reverse(), { now: Date.parse('2027-01-01T00:00:00Z') });
  assert.equal(r1.snapshot.merkle_root, r2.snapshot.merkle_root);
  assert.deepEqual(r1.snapshot, r2.snapshot);
  for (const l of r1.snapshot.leaves) assert.ok(verifyProof(l.account, l.points, l.proof, r1.snapshot.merkle_root));
  assert.equal(r1.snapshot.total_points, r1.leaderboard.reduce((n, x) => n + x.points, 0));
  assert.match(r1.snapshot.notice, /not a token/);
});

test('merkle: tamper detection and edge sizes', () => {
  for (const n of [1, 2, 3, 5, 8, 13]) {
    const entries = Array.from({ length: n }, (_, i) => ({ account: `github:a${i}`, points: i + 1 }));
    const t = buildTree(entries);
    for (const l of t.leaves) assert.ok(verifyProof(l.account, l.points, l.proof, t.root), `n=${n}`);
    assert.equal(verifyProof(t.leaves[0].account, t.leaves[0].points + 1, t.leaves[0].proof, t.root), false);
  }
});
