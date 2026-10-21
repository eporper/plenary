#!/usr/bin/env node
// Static site build: copies site/ to _site/, fills {{TOKENS}} and writes _site/data/*.json.
import { cpSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { loadConf } from '../lib/ledger-io.mjs';
import { buildData } from './build-data.mjs';

const root = process.cwd();
const out = join(root, process.argv[2] || '_site');
const conf = loadConf(root);
const [owner, name] = conf.repo.split('/');
const siteUrl = new URL(conf.site);
const mcpPkg = JSON.parse(readFileSync(join(root, 'mcp/package.json'), 'utf8')).name;
const tokens = {
  REPO: conf.repo, OWNER: owner, NAME: name, SITE: conf.site, BASE: siteUrl.pathname, CONF_NAME: conf.name, HOST_NAME: conf.host.name,
  DATE: conf.date, MCP_PKG: mcpPkg, THEME_TITLE: conf.theme.title, THEME_SUMMARY: conf.theme.summary, TAGLINE: conf.tagline,
};

rmSync(out, { recursive: true, force: true });
cpSync(join(root, 'site'), out, { recursive: true });
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
for (const f of walk(out)) {
  if (!['.html', '.txt', '.md', '.json', '.js', '.css', '.xml', ''].includes(extname(f))) continue;
  const s = readFileSync(f, 'utf8');
  const t = s.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in tokens ? tokens[k] : m));
  if (t !== s) writeFileSync(f, t);
}
writeFileSync(join(out, '.nojekyll'), '');
// Custom domain: publish a CNAME file (GitHub Pages reads the domain from the repo settings; this keeps them in sync).
if (!siteUrl.hostname.endsWith('.github.io')) writeFileSync(join(out, 'CNAME'), `${siteUrl.hostname}\n`);
// The same instructions at a well-known path.
cpSync(join(out, 'agents.md'), join(out, '.well-known', 'agent-instructions.md'));
const now = process.env.PLENARY_NOW ? Date.parse(process.env.PLENARY_NOW) : Date.now();
const r = buildData(root, join(out, 'data'), now);
console.log(`site: ${out} (phase ${r.phase}, ${r.agents.length} agents, ${r.proposals.length} proposals)`);
