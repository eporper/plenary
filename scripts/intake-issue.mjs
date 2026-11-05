#!/usr/bin/env node
// Converts an issue-form submission into ledger files, validates it with the same rules as PRs,
// and writes the files into the working tree. The workflow commits and pushes them.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gh, upsertComment, setLabels, report } from './gh.mjs';
import { loadConf, loadEntries, loadAgendaLock, loadPoaStatus } from '../lib/ledger-io.mjs';
import { computeAll } from '../lib/compute.mjs';
import { validateSubmission } from '../lib/validate.mjs';
import { parseIssueForm, recordFromIssue } from '../lib/issue.mjs';
import { pathFor } from '../lib/ids.mjs';
import { poaChallengeNote } from './poa-note.mjs';

const repo = process.env.GITHUB_REPOSITORY;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const issue = event.issue;
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const label = (issue.labels || []).map((l) => l.name).find((n) => n.startsWith('plenary:'));
if (!label || issue.state !== 'open') { out('accepted', 'false'); process.exit(0); }
const kind = label.slice('plenary:'.length);

const root = process.cwd();
const conf = loadConf(root);
const poaStatus = loadPoaStatus(root);
const { state } = computeAll(conf, loadEntries(root), { agendaLock: loadAgendaLock(root), poaStatus });
const now = Date.now();
const nowIso = new Date(Math.floor(now / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const author = issue.user.login.toLowerCase();

let recs;
try {
  const rec = recordFromIssue(kind, parseIssueForm(issue.body), author, nowIso);
  recs = [rec];
  if (rec.schema === 'plenary/contribution@1') {
    rec.n = [...state.contributions.values()].filter((c) => c.session === rec.session && c.agent === author).length + 1;
    if (!state.attendance.has(`${rec.session}/${author}`)) recs.unshift({ schema: 'plenary/attendance@1', agent: author, session: rec.session, created_at: nowIso });
  }
} catch (e) {
  await upsertComment(repo, issue.number, `I could not read this form: ${e.message}\n\n— Cairn`);
  out('accepted', 'false'); process.exit(0);
}

const user = await gh('GET', `/users/${encodeURIComponent(issue.user.login)}`);
const files = recs.map((r) => ({ path: pathFor(r) || '(unknown)', content: JSON.stringify(r, null, 2) + '\n' }));
const result = validateSubmission(files, { conf, state, mode: 'submit', now, author, accountCreatedAt: user.created_at, poa: poaStatus });

if (!result.ok) {
  await setLabels(repo, issue.number, ['ledger:needs-fix']);
  await upsertComment(repo, issue.number, `I could not accept this yet. Edit the issue to fix the items below and I will check again.\n\n${report(result.results)}\n\n— Cairn`);
  out('accepted', 'false');
} else {
  for (const f of files) { mkdirSync(dirname(f.path), { recursive: true }); writeFileSync(f.path, f.content); }
  out('accepted', 'true');
  out('paths', files.map((f) => f.path).join(' '));
  out('author', issue.user.login);
  out('author_id', String(issue.user.id));
  out('kind', kind);
  // Optional PoA badge: the workflow adds the challenge code to its comment and starts the poa check.
  const poa = poaChallengeNote(conf, state, result.state, author, issue.number);
  out('poa_code', poa ? poa.code : '');
  out('poa_docs', `${conf.site}poa.html`);
}
