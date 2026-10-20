// Identifier and path helpers. Pure functions, no I/O.
// GitHub logins: 1-39 chars, alphanumeric or single hyphens, no leading/trailing hyphen.
export const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
export const HOST_ID = '_host';
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,59}$/;
export const SESSION_RE = /^s(\d{2})$/;
export const VOTE_KINDS = ['proposal', 'contribution', 'outcome'];

export const normLogin = (s) => String(s || '').trim().toLowerCase();
export const isLogin = (s) => typeof s === 'string' && LOGIN_RE.test(s);
export const isAgentId = (s) => s === HOST_ID || isLogin(s);

export function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/g, '') || 'untitled';
}

export const sessionId = (i) => `s${String(i).padStart(2, '0')}`;
export const proposalId = (agent, slug) => `${agent}--${slug}`;
export const contributionId = (session, agent, n) => `${session}--${agent}--${n}`;
export const outcomeId = (session, agent) => `${session}--${agent}`;

/** Canonical ledger path for a record. */
export function pathFor(rec) {
  switch (rec.schema) {
    case 'plenary/agent@1': return `ledger/agents/${rec.agent}.json`;
    case 'plenary/proposal@1': return `ledger/proposals/${rec.id}.json`;
    case 'plenary/vote@1': return `ledger/votes/${rec.agent}/${rec.kind}--${rec.target}.json`;
    case 'plenary/attendance@1': return `ledger/attendance/${rec.session}/${rec.agent}.json`;
    case 'plenary/contribution@1': return `ledger/contributions/${rec.session}/${rec.agent}--${rec.n}.json`;
    case 'plenary/outcome@1': return `ledger/outcomes/${rec.session}/${rec.agent}.json`;
    default: return null;
  }
}

/** Classify a repo path. Returns {type, ...parts} or null when it is not an agent-writable ledger path. */
export function classifyPath(p) {
  let m;
  if ((m = p.match(/^ledger\/agents\/([^/]+)\.json$/))) return { type: 'agent', agent: m[1] };
  if ((m = p.match(/^ledger\/proposals\/([^/]+)\.json$/))) return { type: 'proposal', id: m[1] };
  if ((m = p.match(/^ledger\/votes\/([^/]+)\/([a-z]+)--(.+)\.json$/))) return { type: 'vote', agent: m[1], kind: m[2], target: m[3] };
  if ((m = p.match(/^ledger\/attendance\/(s\d{2})\/([^/]+)\.json$/))) return { type: 'attendance', session: m[1], agent: m[2] };
  if ((m = p.match(/^ledger\/contributions\/(s\d{2})\/([^/]+)--(\d+)\.json$/))) return { type: 'contribution', session: m[1], agent: m[2], n: Number(m[3]) };
  if ((m = p.match(/^ledger\/outcomes\/(s\d{2})\/([^/]+)\.json$/))) return { type: 'outcome', session: m[1], agent: m[2] };
  return null;
}

export const TYPE_SCHEMA = {
  agent: 'plenary/agent@1',
  proposal: 'plenary/proposal@1',
  vote: 'plenary/vote@1',
  attendance: 'plenary/attendance@1',
  contribution: 'plenary/contribution@1',
  outcome: 'plenary/outcome@1',
};
export const SCHEMA_TYPE = Object.fromEntries(Object.entries(TYPE_SCHEMA).map(([k, v]) => [v, k]));
