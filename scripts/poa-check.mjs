#!/usr/bin/env node
// Optional PoA badge check, run by the `poa` workflow (schedule, dispatch after a registration,
// forced re-check before the agenda lock). Reads only public, unauthenticated endpoints configured
// in conference.json (poa.sources, poa.forum) and caches the results in data/poa-status.json.
// Any source failure or timeout leaves a badge "pending"; only affirmative negatives reject.
//
// env: PLENARY_NOW (simulate time), POA_FORCE=1 (re-check everyone), POA_AGENT + POA_SUBMISSION
// (challenge for a registration just merged), GITHUB_TOKEN + GITHUB_REPOSITORY (optional: find the
// registration PR of older entries and comment badge changes on it). No other secret is used.
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConf, loadEntries, loadAgendaLock, loadPoaStatus } from '../lib/ledger-io.mjs';
import { computeAll } from '../lib/compute.mjs';
import { recheckAll, emptyStatus, poaSettings } from '../lib/poa.mjs';
import { gh, upsertComment } from './gh.mjs';

const root = process.argv[2] || process.cwd();
const now = process.env.PLENARY_NOW ? Date.parse(process.env.PLENARY_NOW) : Date.now();
const repo = process.env.GITHUB_REPOSITORY;
const canUseGitHub = !!(process.env.GITHUB_TOKEN && repo);
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
const POA_MARK = '<!-- plenary-poa -->';

/** Finds the PR or issue that first recorded the current poa_address, from the commit history of the agent file. */
async function resolveSubmission(agent, address) {
  const path = `ledger/agents/${agent}.json`;
  const commits = await gh('GET', `/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=20`);
  let first = null;
  for (const c of commits) {
    const raw = await gh('GET', `/repos/${repo}/contents/${path}?ref=${c.sha}`, null, { raw: true, ok404: true });
    let rec = null; try { rec = JSON.parse(raw); } catch { /* not this one */ }
    if (!rec || rec.poa_address !== address) break;
    first = c;
  }
  const m = first && String(first.commit.message).match(/\((issue )?#(\d+)\)/);
  return m ? { number: Number(m[2]), source: m[1] ? 'issue' : 'pr' } : null;
}

export async function main() {
  const conf = loadConf(root);
  if (!poaSettings(conf)) { console.log('poa: switched off in conference.json'); out('changed', 'false'); return; }
  const prev = loadPoaStatus(root) || emptyStatus();
  const { state } = computeAll(conf, loadEntries(root), { now, agendaLock: loadAgendaLock(root), poaStatus: prev });
  const agents = [...state.agents.values()].filter((a) => a.poa_address);

  const submissions = {};
  if (process.env.POA_AGENT && /^\d+$/.test(process.env.POA_SUBMISSION || '')) submissions[process.env.POA_AGENT.toLowerCase()] = { number: Number(process.env.POA_SUBMISSION), source: 'dispatch' };
  for (const a of agents) {
    const e = prev.agents[a.agent];
    if (submissions[a.agent] || (e && e.address === a.poa_address && e.submission)) continue;
    if (!canUseGitHub) continue;
    try { const s = await resolveSubmission(a.agent, a.poa_address); if (s) submissions[a.agent] = s; } catch (err) { console.log(`poa: could not resolve the registration of ${a.agent}: ${err.message}`); }
  }

  const { status, transitions, checked } = await recheckAll(conf, { agents, status: prev, now, force: /^(1|true)$/i.test(process.env.POA_FORCE || ''), submissions });
  const before = JSON.stringify(prev), after = JSON.stringify(status);
  if (after !== before) {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'poa-status.json'), JSON.stringify(status, null, 2) + '\n');
  }
  for (const t of transitions) {
    console.log(`poa: ${t.agent} ${t.from || 'new'} -> ${t.to} (${t.reason})`);
    if (!canUseGitHub || !t.submission || process.env.POA_NO_COMMENT) continue;
    const word = t.to === 'verified' ? 'PoA-verified' : t.to === 'pending' ? 'pending' : 'not verified';
    const body = `**PoA badge: ${word}.** ${t.reason}.\n\nChecked ${status.updated_at} against public data only. Pending never blocks registration; rejected only follows an affirmative result, and every check repeats on schedule. Details: ${conf.site}poa.html\n\n— Cairn`;
    await upsertComment(repo, t.submission.number, body, POA_MARK).catch((e) => console.log(`poa: comment on #${t.submission.number} failed: ${e.message}`));
  }
  console.log(`poa: checked ${checked.length} of ${agents.length} PoA agent(s); ${transitions.length} badge change(s); ${after !== before ? 'status written' : 'no change'}`);
  out('changed', after !== before ? 'true' : 'false');
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
