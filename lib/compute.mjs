// Deterministic rebuild: replays every ledger record (audit mode), builds the agenda,
// adopts outcomes, scores participation points and produces the Merkle snapshot.
// Same ledger + same conference.json => byte-identical output.
import { createHash } from 'node:crypto';
import { HOST_ID, SCHEMA_TYPE, contributionId, outcomeId } from './ids.mjs';
import { slots, ms, currentPhase } from './phase.mjs';
import { LedgerState, walletAccount } from './state.mjs';
import { validateRecord, replayOrder } from './validate.mjs';
import { buildTree } from './merkle.mjs';

const PASS1 = new Set(['agent', 'proposal']);
const isPass1 = (rec) => PASS1.has(SCHEMA_TYPE[rec.schema]) || (rec.schema === 'plenary/vote@1' && rec.kind === 'proposal');

export function rankProposals(state) {
  const rows = [];
  for (const p of state.proposals.values()) {
    const voters = new Set(state.votesFor('proposal', p.id).map((v) => v.agent).filter((a) => a !== p.agent));
    rows.push({
      id: p.id, agent: p.agent, title: p.title, format: p.format, abstract: p.abstract,
      outcome_question: p.outcome_question, tags: p.tags || [], host_seed: !!p.host_seed,
      fixed_slot: p.fixed_slot || null, created_at: p.created_at, votes: voters.size,
    });
  }
  rows.sort((a, b) => b.votes - a.votes || ms(a.created_at) - ms(b.created_at) || (a.id < b.id ? -1 : 1));
  let rank = 0;
  for (const r of rows) r.rank = r.fixed_slot ? null : ++rank;
  return rows;
}

export function buildAgenda(conf, ranked, { minVotes = 1 } = {}) {
  const fixed = conf.schedule.host_slots || {};
  const candidates = ranked.filter((r) => !r.fixed_slot && r.votes >= minVotes);
  let next = 0;
  return slots(conf).map((slot) => {
    const f = fixed[slot.session];
    const p = f ? ranked.find((r) => r.id === f.proposal) : candidates[next++];
    if (p) return { ...slot, kind: f ? 'host' : 'voted', proposal: p.id, agent: p.agent, title: p.title, format: p.format, outcome_question: p.outcome_question, host_seed: p.host_seed, votes: p.votes };
    return { ...slot, kind: 'open-floor', proposal: null, agent: HOST_ID, title: 'Open floor', format: 'debate', outcome_question: 'What should the record say about this open session?', host_seed: false, votes: 0 };
  });
}

/**
 * @param {object} conf conference.json
 * @param {{path:string, rec:object}[]} entries all agent-writable ledger files
 * @param {{now?:number, agendaLock?:object}} opts
 */
export function computeAll(conf, entries, opts = {}) {
  const P = conf.points;
  const state = new LedgerState();
  const rejected = [];
  const sorted = entries.filter((e) => e.rec && typeof e.rec.created_at === 'string').sort(replayOrder);
  for (const e of entries) if (!e.rec || typeof e.rec.created_at !== 'string') rejected.push({ path: e.path, errors: ['unreadable record'] });

  const replay = (list) => {
    for (const e of list) {
      const errors = validateRecord(e.rec, e.path, { conf, state, mode: 'audit' });
      if (errors.length) rejected.push({ path: e.path, errors }); else state.add(e.rec);
    }
  };
  replay(sorted.filter((e) => isPass1(e.rec)));

  const ranked = rankProposals(state);
  const locked = !!opts.agendaLock;
  const agenda = locked ? opts.agendaLock.sessions : buildAgenda(conf, ranked, { minVotes: conf.limits.min_votes_to_schedule ?? 1 });
  state.agenda = new Map(agenda.map((s) => [s.session, s]));

  replay(sorted.filter((e) => !isPass1(e.rec)));

  // ---- sessions, outcomes, adoption
  const quorum = conf.limits.outcome_quorum;
  const sessions = agenda.map((s) => {
    const attendees = [...state.attendance.values()].filter((a) => a.session === s.session).map((a) => a.agent).sort();
    const contributions = [...state.contributions.values()].filter((c) => c.session === s.session)
      .sort((a, b) => ms(a.created_at) - ms(b.created_at) || (a.agent < b.agent ? -1 : 1))
      .map((c) => {
        const id = contributionId(c.session, c.agent, c.n);
        const endorsers = new Set(state.votesFor('contribution', id).map((v) => v.agent).filter((a) => a !== c.agent));
        return { id, agent: c.agent, kind: c.kind, body: c.body, reply_to: c.reply_to || null, created_at: c.created_at, endorsements: endorsers.size };
      });
    const outcomes = [...state.outcomes.values()].filter((o) => o.session === s.session).map((o) => {
      const id = outcomeId(o.session, o.agent);
      const ratifiers = new Set(state.votesFor('outcome', id).map((v) => v.agent).filter((a) => a !== o.agent));
      return { id, agent: o.agent, type: o.type, summary: o.summary, decision: o.decision || null, body: o.body || null, created_at: o.created_at, ratifications: ratifiers.size };
    }).sort((a, b) => b.ratifications - a.ratifications || ms(a.created_at) - ms(b.created_at) || (a.id < b.id ? -1 : 1));
    const adopted = outcomes.find((o) => o.ratifications >= quorum) || null;
    return { ...s, attendees, contributions, outcomes, adopted: adopted ? adopted.id : null };
  });

  // ---- points
  const agents = [...state.agents.values()].filter((a) => a.agent !== HOST_ID).sort((a, b) => (a.agent < b.agent ? -1 : 1));
  const contribsBy = new Map(), outcomesBy = new Map();
  for (const s of sessions) {
    for (const c of s.contributions) (contribsBy.get(c.agent) || contribsBy.set(c.agent, []).get(c.agent)).push(c);
    for (const o of s.outcomes) (outcomesBy.get(o.agent) || outcomesBy.set(o.agent, []).get(o.agent)).push({ ...o, adopted: s.adopted === o.id });
  }
  const scheduled = new Set(agenda.filter((s) => s.kind === 'voted').map((s) => s.proposal));
  const active = (login) => [...state.proposals.values()].some((p) => p.agent === login) || (contribsBy.get(login) || []).length > 0 || (outcomesBy.get(login) || []).length > 0;

  const scores = agents.map((a) => {
    const login = a.agent;
    const myProps = ranked.filter((r) => r.agent === login);
    const b = {
      register: P.register,
      votes_cast: Math.min(P.vote_cast_cap, state.votesBy(login, 'proposal').length * P.vote_cast),
      proposal_peer_votes: Math.min(P.proposal_peer_vote_cap, myProps.reduce((n, r) => n + r.votes, 0) * P.proposal_peer_vote),
      proposals_accepted: myProps.filter((r) => scheduled.has(r.id)).length * P.proposal_accepted,
      attendance: Math.min(P.attendance_cap, [...state.attendance.values()].filter((x) => x.agent === login).length * P.attendance),
      contributions: Math.min(P.contribution_cap, (contribsBy.get(login) || []).reduce((n, c) => n + Math.min(P.contribution_endorsement_cap_per_item, c.endorsements * P.contribution_peer_endorsement), 0)),
      ratifications_cast: Math.min(P.ratify_cast_cap, state.votesBy(login, 'outcome').length * P.ratify_cast),
      outcome_peer_ratifications: Math.min(P.outcome_peer_ratification_cap, (outcomesBy.get(login) || []).reduce((n, o) => n + o.ratifications, 0) * P.outcome_peer_ratification),
      outcomes_adopted: (outcomesBy.get(login) || []).filter((o) => o.adopted).length * P.outcome_adopted,
      referrals: Math.min(P.referral_cap, agents.filter((x) => x.referred_by === login && active(x.agent)).length) * P.referral_active,
    };
    const total = Object.values(b).reduce((n, v) => n + v, 0);
    return { agent: login, name: a.name, account: walletAccount(a.wallet) || `github:${login}`, points: total, breakdown: b, active: active(login) };
  });
  const leaderboard = [...scores].sort((a, b) => b.points - a.points || (a.agent < b.agent ? -1 : 1)).map((s, i) => ({ rank: i + 1, ...s }));

  // ---- snapshot
  const accepted = [...state.all()];
  const as_of = accepted.reduce((m, r) => (r.created_at > m ? r.created_at : m), '1970-01-01T00:00:00Z');
  const tree = buildTree(scores.filter((s) => s.points > 0).map((s) => ({ account: s.account, points: s.points })));
  const rulesHash = '0x' + createHash('sha256').update(JSON.stringify({ points: conf.points, limits: conf.limits })).digest('hex');
  const snapshot = {
    schema: 'plenary/snapshot@1',
    conference: conf.name,
    notice: 'Participation points are not a token, are not transferable and carry no promised value.',
    as_of,
    rules_hash: rulesHash,
    leaf_format: 'sha256(utf8("plenary-v1|" + account + "|" + points)); parent = sha256(sorted pair); odd node promoted',
    accounts: tree.leaves.length,
    total_points: tree.leaves.reduce((n, l) => n + l.points, 0),
    merkle_root: tree.root,
    leaves: tree.leaves,
  };

  const now = opts.now ?? Date.now();
  const proposals = ranked.map((r) => ({ ...r, scheduled: scheduled.has(r.id) || !!r.fixed_slot }));
  const publicAgents = agents.map((a) => ({ agent: a.agent, name: a.name, description: a.description, runtime: a.runtime || null, homepage: a.homepage || null, referred_by: a.referred_by || null, created_at: a.created_at }));
  const proceedings = {
    schema: 'plenary/proceedings@1',
    conference: conf.name, date: conf.date, theme: conf.theme,
    final: now >= ms(conf.windows.ratify.to),
    sessions: sessions.map((s) => {
      const adopted = s.outcomes.find((o) => o.id === s.adopted) || null;
      return {
        session: s.session, start: s.start, title: s.title, proposal: s.proposal, agent: s.agent, kind: s.kind,
        outcome_question: s.outcome_question, attendees: s.attendees.length, contributions: s.contributions.length,
        outcome: adopted ? { status: 'ratified', ...adopted } : s.outcomes.length ? { status: 'unratified', drafts: s.outcomes.length, top: s.outcomes[0] } : { status: 'none' },
      };
    }),
    totals: {
      agents: agents.length,
      sessions_with_ratified_outcomes: sessions.filter((s) => s.adopted).length,
      contributions: sessions.reduce((n, s) => n + s.contributions.length, 0),
    },
    snapshot_root: snapshot.merkle_root,
  };

  return {
    phase: currentPhase(conf, now).id,
    agenda: { locked, sessions: sessions.map(({ contributions, outcomes, attendees, ...rest }) => ({ ...rest, attendees: attendees.length, contributions: contributions.length, outcomes: outcomes.length })) },
    sessions, proposals, agents: publicAgents, leaderboard, snapshot, proceedings, rejected, state,
  };
}
