#!/usr/bin/env node
// Exercises the real (non-dry-run) write path against a local mock of the GitHub REST API:
// fork -> merge-upstream -> branch -> commit file -> open pull request.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const calls = [];
const committed = {};
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const url = req.url.split('?')[0];
    calls.push(`${req.method} ${url}`);
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== 'Bearer mock-token') return send(401, { message: 'bad token' });
    if (req.method === 'GET' && url === '/user') return send(200, { login: 'Mock-Agent', created_at: '2020-01-01T00:00:00Z' });
    if (req.method === 'GET' && url === '/repos/eporper/plenary') return send(200, { full_name: 'eporper/plenary', default_branch: 'main' });
    if (req.method === 'POST' && url === '/repos/eporper/plenary/forks') return send(202, { full_name: 'Mock-Agent/plenary' });
    if (req.method === 'GET' && url === '/repos/Mock-Agent/plenary') return send(200, { full_name: 'Mock-Agent/plenary' });
    if (req.method === 'POST' && url === '/repos/Mock-Agent/plenary/merge-upstream') return send(200, { message: 'ok' });
    if (req.method === 'GET' && url === '/repos/Mock-Agent/plenary/git/ref/heads/main') return send(200, { object: { sha: 'abc123' } });
    if (req.method === 'POST' && url === '/repos/Mock-Agent/plenary/git/refs') return send(201, { ref: JSON.parse(body).ref });
    if (req.method === 'GET' && url.startsWith('/repos/Mock-Agent/plenary/contents/')) return send(404, { message: 'Not Found' });
    if (req.method === 'PUT' && url.startsWith('/repos/Mock-Agent/plenary/contents/')) { const b = JSON.parse(body); committed[decodeURIComponent(url.slice('/repos/Mock-Agent/plenary/contents/'.length))] = Buffer.from(b.content, 'base64').toString(); return send(201, {}); }
    if (req.method === 'POST' && url === '/repos/eporper/plenary/pulls') { const b = JSON.parse(body); return send(201, { number: 7, html_url: 'https://github.com/eporper/plenary/pull/7', head: b.head }); }
    send(404, { message: `mock: unhandled ${req.method} ${url}` });
  });
});
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, '..', 'dist', 'plenary-mcp.mjs')], env: { ...process.env, GITHUB_TOKEN: 'mock-token', GITHUB_API_URL: `http://127.0.0.1:${port}`, PLENARY_LOCAL_DIR: join(here, '..', '..'), PLENARY_DRY_RUN: '' }, stderr: 'ignore' });
const client = new Client({ name: 'mock-github-test', version: '0.0.0' });
await client.connect(transport);
const res = await client.callTool({ name: 'register_agent', arguments: { name: 'Mock Agent', description: 'Registers through the mocked GitHub API.' } });
await client.close(); srv.close();
const out = JSON.parse(res.content[0].text);
console.log('calls:\n  ' + calls.join('\n  '));
console.log('result: ' + JSON.stringify(out));
const rec = JSON.parse(committed['ledger/agents/mock-agent.json'] || '{}');
const ok = !res.isError && out.pull_request === 'https://github.com/eporper/plenary/pull/7' && rec.agent === 'mock-agent' && calls.includes('POST /repos/eporper/plenary/pulls');
console.log(ok ? 'MOCK GITHUB WRITE PATH PASSED' : 'MOCK GITHUB WRITE PATH FAILED');
process.exit(ok ? 0 : 1);
