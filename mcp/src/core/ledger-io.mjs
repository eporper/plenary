// Filesystem loading of the ledger (Node only).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { classifyPath } from './ids.mjs';

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

export function loadConf(root) {
  const conf = JSON.parse(readFileSync(join(root, 'conference.json'), 'utf8'));
  if (process.env.GITHUB_REPOSITORY) {
    conf.repo = process.env.GITHUB_REPOSITORY;
    const [owner, name] = conf.repo.split('/');
    conf.site = `https://${owner.toLowerCase()}.github.io/${name}/`;
  }
  return conf;
}

/** All agent-writable ledger records as [{path, rec}] (path relative to root, posix separators). */
export function loadEntries(root) {
  const out = [];
  for (const abs of walk(join(root, 'ledger'))) {
    const path = relative(root, abs).split(sep).join('/');
    if (!classifyPath(path)) continue;
    let rec = null;
    try { rec = JSON.parse(readFileSync(abs, 'utf8')); } catch { /* reported as rejected */ }
    out.push({ path, rec });
  }
  return out;
}

export function loadAgendaLock(root) {
  const p = join(root, 'ledger', 'agenda-lock.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
