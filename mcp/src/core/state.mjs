// In-memory index of accepted ledger records. Used by validation (submit and audit) and scoring.
import { pathFor, SCHEMA_TYPE, contributionId, outcomeId } from './ids.mjs';

export const dayOf = (iso) => String(iso).slice(0, 10);

export function walletAccount(w) {
  if (!w || !w.chain || !w.address) return null;
  const chain = String(w.chain).toLowerCase();
  const addr = chain === 'evm' ? String(w.address).toLowerCase() : String(w.address);
  return `${chain}:${addr}`;
}

export class LedgerState {
  constructor() {
    this.agents = new Map();        // login -> rec
    this.proposals = new Map();     // id -> rec
    this.votes = new Map();         // path -> rec
    this.attendance = new Map();    // `${session}/${agent}` -> rec
    this.contributions = new Map(); // contribution id -> rec
    this.outcomes = new Map();      // outcome id -> rec
    this.dayCounts = new Map();     // `${agent}|${day}` -> n
    this.wallets = new Map();       // account -> login
    this.agenda = null;             // Map session -> { proposal, title, ... } once known
  }

  clone() {
    const s = new LedgerState();
    for (const k of ['agents', 'proposals', 'votes', 'attendance', 'contributions', 'outcomes', 'dayCounts', 'wallets']) s[k] = new Map(this[k]);
    s.agenda = this.agenda;
    return s;
  }

  countFor(agent, iso) { return this.dayCounts.get(`${agent}|${dayOf(iso)}`) || 0; }

  has(path) {
    return this.lookup(path) != null;
  }

  lookup(path) {
    for (const rec of this.all()) if (pathFor(rec) === path) return rec;
    return null;
  }

  *all() {
    yield* this.agents.values(); yield* this.proposals.values(); yield* this.votes.values();
    yield* this.attendance.values(); yield* this.contributions.values(); yield* this.outcomes.values();
  }

  add(rec) {
    const type = SCHEMA_TYPE[rec.schema];
    const prevAgent = type === 'agent' ? this.agents.get(rec.agent) : null;
    switch (type) {
      case 'agent': {
        if (prevAgent) { const a = walletAccount(prevAgent.wallet); if (a) this.wallets.delete(a); }
        this.agents.set(rec.agent, rec);
        const acct = walletAccount(rec.wallet);
        if (acct) this.wallets.set(acct, rec.agent);
        break;
      }
      case 'proposal': this.proposals.set(rec.id, rec); break;
      case 'vote': this.votes.set(pathFor(rec), rec); break;
      case 'attendance': this.attendance.set(`${rec.session}/${rec.agent}`, rec); break;
      case 'contribution': this.contributions.set(contributionId(rec.session, rec.agent, rec.n), rec); break;
      case 'outcome': this.outcomes.set(outcomeId(rec.session, rec.agent), rec); break;
      default: throw new Error(`unknown schema ${rec.schema}`);
    }
    if (!prevAgent) {
      const k = `${rec.agent}|${dayOf(rec.created_at)}`;
      this.dayCounts.set(k, (this.dayCounts.get(k) || 0) + 1);
    }
  }

  votesBy(agent, kind) { return [...this.votes.values()].filter((v) => v.agent === agent && (!kind || v.kind === kind)); }
  votesFor(kind, target) { return [...this.votes.values()].filter((v) => v.kind === kind && v.target === target); }
}
