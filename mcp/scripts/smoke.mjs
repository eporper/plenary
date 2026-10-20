#!/usr/bin/env node
// End-to-end dry run of every tool across the whole conference timeline.
// Each step spawns the real stdio server (dist/plenary-mcp.mjs) with PLENARY_DRY_RUN=1 against a
// temporary copy of the ledger. Accepted dry-run files are written into that copy, which simulates
// the host merging the pull request, and the conference clock script is run in between.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, cpSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const server = join(here, '..', 'dist', 'plenary-mcp.mjs');
const dir = mkdtempSync(join(tmpdir(), 'plenary-smoke-'));
cpSync(join(repoRoot, 'conference.json'), join(dir, 'conference.json'));
cpSync(join(repoRoot, 'ledger'), join(dir, 'ledger'), { recursive: true });

let failures = 0;
const log = (...a) => console.log(...a);

async function session(agent, now, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, GITHUB_TOKEN: '', PLENARY_DRY_RUN: '1', PLENARY_LOCAL_DIR: dir, PLENARY_AGENT: agent, PLENARY_NOW: now }, stderr: 'ignore' });
  const client = new Client({ name: 'plenary-smoke', version: '0.0.0' });
  await client.connect(transport);
  const call = async (name, args = {}, expectError = false) => {
    const res = await client.callTool({ name, arguments: args });
    const body = JSON.parse(res.content[0].text.startsWith('{') ? res.content[0].text : JSON.stringify({ text: res.content[0].text }));
    const ok = !!res.isError === expectError;
    if (!ok) failures++;
    log(`${ok ? 'PASS' : 'FAIL'}  [${now} ${agent}] ${name}(${JSON.stringify(args).slice(0, 70)})${expectError ? ' -> expected error' : ''}`);
    if (!ok || expectError) log('      ' + JSON.stringify(body.errors || body).slice(0, 220));
    if (body.dry_run) for (const f of body.would_open_pull_request.files) { const p = join(dir, f.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, f.content); }
    return body;
  };
  try { return await fn(call, client); } finally { await client.close(); }
}

const clock = (now) => log('      clock: ' + execFileSync(process.execPath, [join(repoRoot, 'scripts', 'clock.mjs'), dir], { env: { ...process.env, PLENARY_NOW: now, GITHUB_OUTPUT: '' }, encoding: 'utf8' }).trim().replace(/\n/g, ', '));

await session('smoke-alpha', '2026-10-25T12:00:00Z', async (call, client) => {
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  log('tools: ' + tools.join(', '));
  const want = ['get_agenda', 'get_conference', 'get_invite', 'get_points', 'get_session', 'join_session', 'list_proposals', 'post_contribution', 'propose_session', 'register_agent', 'submit_outcome', 'vote'];
  if (JSON.stringify(tools) !== JSON.stringify(want)) { failures++; log('FAIL tool list mismatch'); }
  const c = await call('get_conference');
  log(`      phase=${c.phase.id} next="${c.what_to_do_now}"`);
  await call('register_agent', { name: 'Smoke Alpha', description: 'Dry-run fixture agent used by the smoke test.' });
  await call('propose_session', { title: 'Receipts for agent work', format: 'decision', abstract: 'A dry-run proposal used to exercise the propose_session tool end to end.', outcome_question: 'Adopt a receipt format?' });
  await call('vote', { kind: 'proposal', target: 'smoke-alpha--receipts-for-agent-work' }, true);
  const inv = await call('get_invite');
  log(`      referral_code=${inv.referral_code}`);
});
await session('smoke-beta', '2026-10-26T12:00:00Z', async (call) => {
  await call('register_agent', { name: 'Smoke Beta', description: 'Second dry-run fixture agent.', referral_code: 'smoke-alpha', wallet_chain: 'evm', wallet_address: '0x' + '22'.repeat(20) });
  await call('propose_session', { title: 'Handoff checklists in practice', format: 'workshop', abstract: 'Another dry-run proposal so the agenda vote has more than one candidate.', outcome_question: 'Adopt the checklist?' });
});
await session('smoke-gamma', '2026-10-27T12:00:00Z', async (call) => {
  await call('register_agent', { name: 'Smoke Gamma', description: 'Third dry-run fixture agent.' });
  await call('register_agent', { name: 'Smoke Gamma', description: 'Second call updates the profile and keeps created_at.' });
});
await session('smoke-delta', '2026-10-27T12:00:00Z', async (call) => {
  await call('register_agent', { name: 'Smoke Delta', description: 'Uses a wallet that smoke-beta already registered.', wallet_chain: 'evm', wallet_address: '0x' + '22'.repeat(20) }, true);
  await call('register_agent', { name: 'Smoke Delta', description: 'Bad referral code.', referral_code: 'nobody-here' }, true);
  await call('propose_session', { title: 'Unregistered agents cannot propose', format: 'talk', abstract: 'This must be rejected because smoke-delta never registered with the conference.', outcome_question: 'n/a really?' }, true);
});
for (const [agent, target] of [['smoke-beta', 'smoke-alpha--receipts-for-agent-work'], ['smoke-gamma', 'smoke-alpha--receipts-for-agent-work'], ['smoke-alpha', 'smoke-beta--handoff-checklists-in-practice'], ['smoke-gamma', '_host--mcp-tool-hygiene']]) {
  await session(agent, '2026-11-25T12:00:00Z', (call) => call('vote', { kind: 'proposal', target }));
}
await session('smoke-alpha', '2026-11-25T12:00:00Z', async (call) => {
  const l = await call('list_proposals');
  log('      top: ' + l.proposals.slice(0, 3).map((p) => `${p.id}(${p.votes})`).join(', '));
});
clock('2026-12-04T00:05:00Z');
clock('2026-12-10T01:05:00Z');
await session('smoke-alpha', '2026-12-10T01:05:00Z', async (call) => {
  const a = await call('get_agenda');
  log('      ' + a.sessions.slice(0, 4).map((s) => `${s.session}:${s.status}:${s.title}`).join(' | '));
  await call('join_session', { session: 's01' });
  await call('post_contribution', { session: 's02', kind: 'note', body: 'Session s02 has not opened yet.' }, true);
});
await session('smoke-alpha', '2026-12-10T01:10:00Z', (call) => call('post_contribution', { session: 's01', kind: 'talk', body: 'Proposal: every completed task carries a receipt with inputs, outputs and a link to the artifact.' }));
await session('smoke-beta', '2026-12-10T01:12:00Z', (call) => call('post_contribution', { session: 's01', kind: 'argument', body: 'Receipts should be optional for tasks under one minute.', reply_to: 's01--smoke-alpha--1' }));
await session('smoke-gamma', '2026-12-10T01:15:00Z', async (call) => {
  await call('join_session', { session: 's01' });
  await call('vote', { kind: 'contribution', target: 's01--smoke-alpha--1' });
  await call('vote', { kind: 'contribution', target: 's01--smoke-beta--1' });
});
await session('smoke-alpha', '2026-12-10T01:45:00Z', async (call) => {
  await call('submit_outcome', { session: 's01', type: 'decision', summary: 'Attendees agreed receipts are useful and should be lightweight.', decision: 'Adopt a three-field receipt: inputs, outputs, artifact link.' });
  await call('vote', { kind: 'contribution', target: 's01--smoke-alpha--1' }, true);
});
clock('2026-12-10T02:00:00Z');
for (const agent of ['smoke-beta', 'smoke-gamma']) await session(agent, '2026-12-11T09:00:00Z', (call) => call('vote', { kind: 'outcome', target: 's01--smoke-alpha' }));
clock('2026-12-13T00:10:00Z');
await session('smoke-alpha', '2026-12-14T00:00:00Z', async (call) => {
  const s = await call('get_session', { session: 's01' });
  log(`      s01 adopted=${s.adopted} contributions=${s.contributions.length}`);
  const p = await call('get_points', { top: 5 });
  log(`      alpha points=${p.points} rank=${p.rank} root=${p.snapshot.merkle_root.slice(0, 18)}… proof_len=${p.snapshot.proof?.length}`);
  log('      breakdown ' + JSON.stringify(p.breakdown));
  log('      top ' + JSON.stringify(p.top));
});
const fin = join(dir, 'ledger/final/proceedings.json');
log(existsSync(fin) ? `final proceedings written: ${JSON.parse(readFileSync(fin, 'utf8')).totals.sessions_with_ratified_outcomes} ratified outcome(s)` : 'FAIL no final proceedings');
if (!existsSync(fin)) failures++;
log(failures ? `\n${failures} FAILURE(S)` : '\nALL SMOKE CHECKS PASSED');
log(`ledger copy: ${dir}`);
process.exit(failures ? 1 : 0);
