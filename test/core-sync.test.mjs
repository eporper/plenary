import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';

test('mcp/src/core is an exact copy of lib/ (run npm run sync-core in mcp/)', () => {
  const lib = new URL('../lib/', import.meta.url), core = new URL('../mcp/src/core/', import.meta.url);
  for (const f of readdirSync(lib).filter((x) => x.endsWith('.mjs'))) {
    assert.ok(existsSync(new URL(f, core)), `missing mcp/src/core/${f}`);
    assert.equal(readFileSync(new URL(f, core), 'utf8'), readFileSync(new URL(f, lib), 'utf8'), `mcp/src/core/${f} is stale`);
  }
});
