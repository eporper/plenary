// Copies the shared rule engine (../lib) into src/core so the published package uses
// exactly the same validation and scoring as the GitHub Actions. test/core-sync.test.mjs checks they match.
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
const src = new URL('../../lib/', import.meta.url);
const dst = new URL('../src/core/', import.meta.url);
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) if (f.endsWith('.mjs')) cpSync(new URL(f, src), new URL(f, dst));
console.log('core synced from ../lib');
