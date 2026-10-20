#!/usr/bin/env node
// The conference clock, run by cron. Idempotent: it only writes records that are due and missing.
//  - Dec 4 00:00 UTC: freezes the agenda into ledger/agenda-lock.json
//  - Dec 10: opens and closes ledger/sessions/sNN.json on the hour
//  - daily: writes a points checkpoint ledger/checkpoints/YYYY-MM-DD.json (Merkle root + leaves)
//  - Dec 13 00:00 UTC: writes ledger/final/proceedings.json and ledger/final/snapshot.json
// PLENARY_NOW=<iso> simulates another time (used in tests and dry runs).
import { existsSync, writeFileSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConf, loadEntries, loadAgendaLock } from '../lib/ledger-io.mjs';
import { computeAll } from '../lib/compute.mjs';
import { ms } from '../lib/phase.mjs';

const root = process.argv[2] || process.cwd();
const now = process.env.PLENARY_NOW ? Date.parse(process.env.PLENARY_NOW) : Date.now();
const nowIso = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
const conf = loadConf(root);
const written = [];
const write = (rel, obj) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); written.push(rel); };
const read = (rel) => (existsSync(join(root, rel)) ? JSON.parse(readFileSync(join(root, rel), 'utf8')) : null);

let lock = loadAgendaLock(root);
let r = computeAll(conf, loadEntries(root), { now, agendaLock: lock });

if (!lock && now >= ms(conf.windows.vote.to)) {
  lock = {
    schema: 'plenary/agenda-lock@1',
    locked_at: conf.windows.vote.to,
    written_at: nowIso,
    note: 'Frozen by the host clock at the end of agenda voting. Ranked by distinct peer votes; ties go to the earlier proposal.',
    sessions: r.agenda.sessions.map(({ attendees, contributions, outcomes, adopted, ...s }) => s),
  };
  write('ledger/agenda-lock.json', lock);
  r = computeAll(conf, loadEntries(root), { now, agendaLock: lock });
}

if (lock) {
  for (const s of r.sessions) {
    const rel = `ledger/sessions/${s.session}.json`;
    const cur = read(rel);
    if (now >= ms(s.start) && !cur) {
      write(rel, { schema: 'plenary/session@1', session: s.session, proposal: s.proposal, title: s.title, outcome_question: s.outcome_question, status: now >= ms(s.end) ? 'closed' : 'open', opens: s.start, closes: s.end, opened_at: nowIso, ...(now >= ms(s.end) ? { closed_at: nowIso, attendees: s.attendees.length, contributions: s.contributions.length } : {}) });
    } else if (cur && cur.status === 'open' && now >= ms(s.end)) {
      write(rel, { ...cur, status: 'closed', closed_at: nowIso, attendees: s.attendees.length, contributions: s.contributions.length });
    }
  }
}

const day = nowIso.slice(0, 10);
if (now >= ms(conf.windows.register.from) && !read(`ledger/checkpoints/${day}.json`) && now < ms(conf.windows.ratify.to) + 86_400_000) {
  write(`ledger/checkpoints/${day}.json`, { ...r.snapshot, checkpoint: day, written_at: nowIso });
}

if (now >= ms(conf.windows.ratify.to) && !read('ledger/final/snapshot.json')) {
  write('ledger/final/snapshot.json', { ...r.snapshot, final: true, written_at: nowIso });
  write('ledger/final/proceedings.json', { ...r.proceedings, final: true, written_at: nowIso, sessions_detail: r.sessions });
}

console.log(written.length ? `clock wrote:\n${written.join('\n')}` : 'clock: nothing due');
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${written.length ? 'true' : 'false'}\n`);
