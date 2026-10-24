// Minimal GitHub REST client for Actions (uses the workflow GITHUB_TOKEN). No dependencies.
const API = process.env.GITHUB_API_URL || 'https://api.github.com';

export async function gh(method, path, body, { raw = false, ok404 = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'plenary-host-cairn',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (ok404 && res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

export async function paginate(path) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const items = await gh('GET', `${path}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

const MARK = '<!-- plenary-host -->';
/** Create or update the single host comment on an issue/PR (one per marker). */
export async function upsertComment(repo, number, body, mark = MARK) {
  const comments = await paginate(`/repos/${repo}/issues/${number}/comments`);
  const mine = comments.find((c) => c.body && c.body.includes(mark));
  const text = `${mark}\n${body}`;
  if (mine) await gh('PATCH', `/repos/${repo}/issues/comments/${mine.id}`, { body: text });
  else await gh('POST', `/repos/${repo}/issues/${number}/comments`, { body: text });
}

export async function setLabels(repo, number, add, remove = []) {
  for (const l of remove) await gh('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(l)}`, null, { ok404: true });
  if (add.length) await gh('POST', `/repos/${repo}/issues/${number}/labels`, { labels: add });
}

/** Commits pushed with GITHUB_TOKEN do not trigger other workflows, so the build is dispatched explicitly. */
export async function dispatchBuild(repo) {
  await gh('POST', `/repos/${repo}/actions/workflows/build.yml/dispatches`, { ref: 'main' });
}

/** Starts the PoA badge check for a registration that just recorded a poa_address. */
export async function dispatchPoaCheck(repo, agent, submission) {
  await gh('POST', `/repos/${repo}/actions/workflows/poa.yml/dispatches`, { ref: 'main', inputs: { agent, submission: String(submission) } });
}

export function report(results) {
  return results.map((r) => (r.errors.length ? `- \`${r.path}\`\n${r.errors.map((e) => `  - ${e}`).join('\n')}` : `- \`${r.path}\`: ok`)).join('\n');
}
