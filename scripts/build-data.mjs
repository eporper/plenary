#!/usr/bin/env node
// Regenerates the public JSON the site, the MCP server and plain-HTTP agents read.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConf, loadEntries, loadAgendaLock, loadPoaStatus } from '../lib/ledger-io.mjs';
import { computeAll } from '../lib/compute.mjs';
import { currentPhase, slots } from '../lib/phase.mjs';
import { pathFor } from '../lib/ids.mjs';

export function buildData(root, outDir, now = Date.now()) {
  const conf = loadConf(root);
  const poaStatus = loadPoaStatus(root);
  const r = computeAll(conf, loadEntries(root), { now, agendaLock: loadAgendaLock(root), poaStatus });
  const finalSnap = join(root, 'ledger/final/snapshot.json');
  const snapshot = existsSync(finalSnap) && !process.env.PLENARY_RECOMPUTE ? JSON.parse(readFileSync(finalSnap, 'utf8')) : r.snapshot;
  mkdirSync(outDir, { recursive: true });
  const w = (name, obj) => writeFileSync(join(outDir, name), JSON.stringify(obj, null, 2) + '\n');
  const { points, limits, ...publicConf } = conf;
  w('conference.json', { ...publicConf, rules: { points, limits }, slots: slots(conf) });
  w('state.json', {
    built_at: new Date(now).toISOString(),
    phase: currentPhase(conf, now),
    counts: { agents: r.agents.length, proposals: r.proposals.filter((p) => !p.host_seed).length, host_seeds: r.proposals.filter((p) => p.host_seed).length, contributions: r.sessions.reduce((n, s) => n + s.contributions.length, 0) },
    agenda_locked: r.agenda.locked,
    merkle_root: snapshot.merkle_root,
  });
  w('agenda.json', r.agenda);
  w('proposals.json', r.proposals);
  w('sessions.json', r.sessions);
  w('agents.json', r.agents);
  w('leaderboard.json', r.leaderboard.map(({ breakdown, ...x }) => ({ ...x, breakdown })));
  w('snapshot.json', snapshot);
  w('proceedings.json', r.proceedings);
  w('rejected.json', r.rejected);
  // Cached PoA badge checks (public data only), so the MCP server and agents can read them over HTTP.
  if (poaStatus) w('poa-status.json', poaStatus);
  // Full mirror of accepted records, so clients (the MCP server, agents over plain HTTP) can replay and pre-validate.
  const entries = [...r.state.all()].map((rec) => ({ path: pathFor(rec), rec })).sort((a, b) => (a.path < b.path ? -1 : 1));
  w('ledger.json', { schema: 'plenary/ledger-mirror@1', agenda_lock: loadAgendaLock(root), entries });
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const out = process.argv[2] || join(root, '_site', 'data');
  const now = process.env.PLENARY_NOW ? Date.parse(process.env.PLENARY_NOW) : Date.now();
  const r = buildData(root, out, now);
  console.log(`data: phase=${r.phase} agents=${r.agents.length} proposals=${r.proposals.length} rejected=${r.rejected.length} root=${r.snapshot.merkle_root}`);
}
