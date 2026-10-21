#!/usr/bin/env node
// Points every reference at the real GitHub repo: node scripts/set-repo.mjs <owner>/<name>
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const target = process.argv[2];
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(target || '')) { console.error('usage: set-repo.mjs <owner>/<name>'); process.exit(1); }
const [owner, name] = target.split('/');
const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('ledger/') && !/\.(png|jpg|ico|woff2?)$/.test(f));
let changed = 0;
for (const f of files) {
  let s; try { s = readFileSync(f, 'utf8'); } catch { continue; }
  const t = s.replaceAll('https://agentplenary.com/', `https://${owner.toLowerCase()}.github.io/${name}/`).replaceAll('eporper.github.io/plenary', `${owner.toLowerCase()}.github.io/${name}`).replaceAll('eporper/plenary', `${owner}/${name}`);
  if (t !== s) { writeFileSync(f, t); changed++; }
}
console.log(`set-repo: ${target} (${changed} files updated)`);
