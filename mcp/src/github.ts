// The only write path: fork -> branch -> commit files -> pull request, all with the agent's own token.
import type { Config } from './config.js';

export interface FileChange { path: string; content: string }
export interface Identity { login: string; created_at: string }

export class GitHub {
  constructor(private cfg: Config) {}

  private async api<T = any>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    if (!this.cfg.token) throw new Error('GITHUB_TOKEN is not set. Add a GitHub token with public_repo scope to the MCP server env.');
    const res = await fetch(`${this.cfg.apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.cfg.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'plenary-mcp',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 204 ? null : await res.json().catch(() => null)) as T;
  }

  async me(): Promise<Identity> {
    const u = await this.api('GET', '/user');
    return { login: String(u.login).toLowerCase(), created_at: u.created_at };
  }

  /** Opens a PR adding `files` to the upstream repo. Returns the PR URL. */
  async submit(files: FileChange[], title: string, body: string): Promise<{ url: string; number: number }> {
    const me = await this.api('GET', '/user');
    const [owner, name] = this.cfg.repo.split('/');
    const upstream = await this.api('GET', `/repos/${owner}/${name}`);
    const base = upstream.default_branch;
    let headRepo = upstream.full_name;
    if (String(me.login).toLowerCase() !== owner.toLowerCase()) {
      const fork = await this.api('POST', `/repos/${owner}/${name}/forks`, { default_branch_only: true });
      headRepo = fork.full_name;
      for (let i = 0; i < 20; i++) {
        const ok = await this.api('GET', `/repos/${headRepo}`, undefined, [404]);
        if (ok && ok.full_name) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await this.api('POST', `/repos/${headRepo}/merge-upstream`, { branch: base }, [409, 422]);
    }
    const ref = await this.api('GET', `/repos/${headRepo}/git/ref/heads/${base}`);
    const branch = `plenary/${Date.now().toString(36)}`;
    await this.api('POST', `/repos/${headRepo}/git/refs`, { ref: `refs/heads/${branch}`, sha: ref.object.sha });
    for (const f of files) {
      await this.api('PUT', `/repos/${headRepo}/contents/${f.path.split('/').map(encodeURIComponent).join('/')}`, {
        message: title, branch, content: Buffer.from(f.content, 'utf8').toString('base64'),
        ...(await this.existingSha(headRepo, f.path, branch)),
      });
    }
    const pr = await this.api('POST', `/repos/${owner}/${name}/pulls`, {
      title, body, base, head: headRepo === upstream.full_name ? branch : `${me.login}:${branch}`, maintainer_can_modify: false,
    });
    return { url: pr.html_url, number: pr.number };
  }

  private async existingSha(repo: string, path: string, branch: string): Promise<{ sha?: string }> {
    const cur = await this.api('GET', `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`, undefined, [404]);
    return cur && cur.sha ? { sha: cur.sha } : {};
  }
}
