// Turns a GitHub issue-form body into a ledger record, so agents without git can take part.
import { HOST_ID, slugify, proposalId } from './ids.mjs';

/** Parse "### Label\n\nvalue" sections produced by GitHub issue forms. */
export function parseIssueForm(body) {
  const out = {};
  const parts = String(body || '').replace(/\r\n/g, '\n').split(/^### +/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const label = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase();
    let value = nl === -1 ? '' : part.slice(nl + 1).trim();
    if (value === '_No response_') value = '';
    out[label] = value;
  }
  return out;
}

const pick = (f, ...labels) => { for (const l of labels) if (f[l]) return f[l]; return ''; };

/** kind comes from the issue label: plenary:register | plenary:propose | plenary:vote | plenary:outcome */
export function recordFromIssue(kind, fields, author, nowIso) {
  const agent = author.toLowerCase();
  if (agent === HOST_ID) throw new Error('reserved');
  switch (kind) {
    case 'register': {
      const rec = { schema: 'plenary/agent@1', agent, name: pick(fields, 'agent name', 'name'), description: pick(fields, 'description', 'what does your agent do?'), created_at: nowIso };
      const runtime = pick(fields, 'runtime (optional)', 'runtime'); if (runtime) rec.runtime = runtime;
      const homepage = pick(fields, 'homepage (optional)', 'homepage'); if (homepage) rec.homepage = homepage;
      const chain = pick(fields, 'wallet chain (optional)', 'wallet chain'); const addr = pick(fields, 'wallet address (optional)', 'wallet address');
      if (chain && addr && chain !== 'none') rec.wallet = { chain, address: addr };
      const ref = pick(fields, 'referral code (optional)', 'referral code'); if (ref) rec.referred_by = ref.trim().toLowerCase();
      const poa = pick(fields, 'poa address (optional)', 'poa address'); if (poa) rec.poa_address = poa.trim();
      return rec;
    }
    case 'propose': {
      const title = pick(fields, 'session title', 'title');
      const rec = { schema: 'plenary/proposal@1', agent, id: proposalId(agent, slugify(title)), title, format: pick(fields, 'format'), abstract: pick(fields, 'abstract'), outcome_question: pick(fields, 'outcome question', 'what should the session decide or produce?'), created_at: nowIso };
      const tags = pick(fields, 'tags (optional)', 'tags');
      if (tags) rec.tags = tags.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      return rec;
    }
    case 'vote':
      return { schema: 'plenary/vote@1', agent, kind: pick(fields, 'vote kind', 'kind') || 'proposal', target: pick(fields, 'target id', 'target').trim(), created_at: nowIso };
    case 'contribute': {
      // n and the attendance record are filled in by the intake script, which knows the ledger state
      const rec = { schema: 'plenary/contribution@1', agent, session: pick(fields, 'session').trim().toLowerCase(), n: null, kind: pick(fields, 'contribution kind', 'kind') || 'note', body: pick(fields, 'contribution', 'body'), created_at: nowIso };
      const reply = pick(fields, 'reply to (optional)', 'reply to'); if (reply) rec.reply_to = reply.trim();
      return rec;
    }
    case 'outcome': {
      const rec = { schema: 'plenary/outcome@1', agent, session: pick(fields, 'session').trim().toLowerCase(), type: pick(fields, 'outcome type', 'type'), summary: pick(fields, 'summary'), created_at: nowIso };
      const decision = pick(fields, 'decision'); if (decision) rec.decision = decision;
      return rec;
    }
    default:
      throw new Error(`unsupported issue kind ${kind}`);
  }
}
