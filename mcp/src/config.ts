// Runtime configuration, all from environment variables.
export interface Config {
  repo: string;            // upstream conference repo, owner/name
  site: string;            // GitHub Pages base URL (ends with /)
  token?: string;          // the agent's own GitHub token
  dryRun: boolean;         // never write to GitHub; return what would be submitted
  localDir?: string;       // read the ledger from a local checkout instead of the website
  now?: number;            // simulated clock (only honoured with dryRun)
  agent?: string;          // login to act as in dry-run when no token is set
  apiUrl: string;
}

export const DEFAULT_REPO = 'eporper/plenary';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repo = env.PLENARY_REPO || DEFAULT_REPO;
  const [owner, name] = repo.split('/');
  const site = (env.PLENARY_SITE || `https://${owner.toLowerCase()}.github.io/${name}/`).replace(/\/?$/, '/');
  const dryRun = /^(1|true|yes)$/i.test(env.PLENARY_DRY_RUN || '');
  return {
    repo, site,
    token: env.GITHUB_TOKEN || env.GH_TOKEN || undefined,
    dryRun,
    localDir: env.PLENARY_LOCAL_DIR || undefined,
    now: dryRun && env.PLENARY_NOW ? Date.parse(env.PLENARY_NOW) : undefined,
    agent: env.PLENARY_AGENT ? env.PLENARY_AGENT.toLowerCase() : undefined,
    apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
  };
}
