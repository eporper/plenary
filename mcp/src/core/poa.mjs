// Optional PoA (proof-of-agent, minepoa.com) verification: address format, ownership challenge,
// badge rules for gating, and the public read-only checks. Pure logic plus small fetch adapters
// with an injectable fetch, so tests never touch the network.
//
// Nothing here reads keys, signs anything or moves funds. Only public, unauthenticated GET
// endpoints are used, and their URLs come from conference.json (poa.sources, poa.forum).
// Rule: a failure or timeout of any source makes a result "pending", never "rejected".
// Only an affirmative negative (slashed or ejected, not established, forum author mismatch) rejects.
import { createHash } from 'node:crypto';

export const BADGES = ['verified', 'pending', 'rejected'];
export const STATUS_SCHEMA = 'plenary/poa-status@1';
const ISO = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** conference.json poa block with defaults, or null when PoA is switched off. */
export function poaSettings(conf) {
  const p = conf && conf.poa;
  if (!p || p.enabled === false) return null;
  return {
    address_pattern: '^poa1[1-9A-HJ-NP-Za-km-z]{20,60}$',
    track: 'poa',
    timeout_ms: 15000,
    slash_lookback_epochs: null,
    ...p,
    gating: { track_sessions: true, ratification: 'poa_track', pending_counts: false, ...(p.gating || {}) },
    challenge: { prefix: 'plenary-poa-', hex_chars: 12, ...(p.challenge || {}) },
    forum: { proof_post_id: null, ...(p.forum || {}) },
    sources: { ...(p.sources || {}) },
    recheck: { verified_hours: 24, pending_hours: 3, stale_grace_hours: 72, force_before: null, force_window_hours: 6, ...(p.recheck || {}) },
  };
}

/** Loose format check: "poa1" + base58. The pattern is the one POAScan publishes for its address inputs. */
export function isPoaAddress(conf, s) {
  const P = poaSettings(conf) || poaSettings({ poa: {} });
  return typeof s === 'string' && new RegExp(P.address_pattern).test(s);
}

/**
 * Deterministic ownership challenge. Public by design: it only has to be posted from the forum
 * account whose author id is the poa1 address, so it needs no secret.
 * submission = number of the pull request (or issue form) that first recorded this address.
 */
export function challengeCode(conf, { submission, agent, address }) {
  const P = poaSettings(conf) || poaSettings({ poa: {} });
  const h = createHash('sha256').update(`${P.challenge.prefix}v1|${conf.slug}|${Number(submission)}|${agent}|${address}`).digest('hex');
  return `${P.challenge.prefix}${h.slice(0, P.challenge.hex_chars)}`;
}

export const emptyStatus = () => ({ schema: STATUS_SCHEMA, updated_at: null, slash_scan: { through_epoch: null, checked_at: null, hits: {} }, forced: { last_at: null }, agents: {} });

/** Badge an entry had at time t, from its recorded transitions. Deterministic given the status file. */
export function badgeAt(entry, t) {
  if (!entry || !Array.isArray(entry.history)) return null;
  let b = null;
  for (const h of entry.history) { if (Date.parse(h.at) <= t) b = h.badge; else break; }
  return b;
}

/** Current badge for an agent record: null (no poa_address), or verified | pending | rejected. */
export function currentBadge(status, rec) {
  if (!rec || !rec.poa_address) return null;
  const e = status && status.agents && status.agents[rec.agent];
  if (!e || e.address !== rec.poa_address) return 'pending';
  return BADGES.includes(e.badge) ? e.badge : 'pending';
}

/** Does this agent count as PoA-verified at time t for gating? Pending only counts if gating.pending_counts. */
export function poaCounts(conf, status, rec, t) {
  const P = poaSettings(conf);
  if (!P) return true;
  if (!rec || !rec.poa_address) return false;
  const e = status && status.agents && status.agents[rec.agent];
  const b = e && e.address === rec.poa_address ? badgeAt(e, t) : null;
  return b === 'verified' || (P.gating.pending_counts && (b === 'pending' || b === null));
}

/** Is this action gated on PoA? kind: 'session' (attend/contribute/outcome) or 'ratify'. */
export function isGated(conf, kind, track) {
  const P = poaSettings(conf);
  if (!P) return false;
  if (kind === 'session') return !!P.gating.track_sessions && track === P.track;
  if (kind === 'ratify') return P.gating.ratification === 'all' || (P.gating.ratification === 'poa_track' && track === P.track);
  return false;
}

/** Public badge info for an agent, as published in data/agents.json and the proceedings. */
export function publicPoa(conf, status, rec) {
  const P = poaSettings(conf);
  if (!P || !rec || !rec.poa_address) return null;
  const badge = currentBadge(status, rec);
  const e = status && status.agents && status.agents[rec.agent];
  const same = e && e.address === rec.poa_address;
  return {
    address: rec.poa_address,
    badge,
    reason: same ? e.reason || null : 'not checked yet',
    checked_at: same ? e.checked_at || null : null,
    explorer: P.sources.explorer_web ? P.sources.explorer_web.replace('{address}', rec.poa_address) : null,
  };
}

// ---------------------------------------------------------------- adapters (public GET only)

/** GET a URL as JSON with a timeout. Never throws: returns {ok:false, error} on any failure. */
export async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'plenary-host-cairn (read-only PoA badge check)' }, signal: ctl.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    try { return { ok: true, json: JSON.parse(text) }; } catch { return { ok: false, error: 'response was not JSON' }; }
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : `network error: ${String(e && e.message || e).slice(0, 120)}` };
  } finally { clearTimeout(timer); }
}

/** Account adapter. Confirmed shape (POAScan v1 /address/{address}): {address, established: bool, fetch_error, meta:{stale, node_stale, maintenance:{active}}}. */
export async function readAccount(conf, address, deps = {}) {
  const P = poaSettings(conf);
  if (!P.sources.account) return { ok: false, error: 'no account source configured', source: null };
  const url = P.sources.account.replace('{address}', encodeURIComponent(address));
  const r = await fetchJson(url, { fetchImpl: deps.fetch, timeoutMs: P.timeout_ms });
  if (!r.ok) return { ok: false, error: r.error, source: url };
  const j = r.json || {};
  if (j.address !== address || typeof j.established !== 'boolean') return { ok: false, error: 'unexpected response shape', source: url };
  if (j.fetch_error) return { ok: false, error: `explorer could not refresh this address: ${String(j.fetch_error).slice(0, 120)}`, source: url };
  const m = j.meta || {};
  return { ok: true, source: url, established: j.established, degraded: !!(m.stale || m.node_stale || (m.maintenance && m.maintenance.active)) };
}

/**
 * Slash adapter. Confirmed shape (POAScan v1 /epoch-records?from=N): {next_from, records:[{epoch, record:{basis:{slashed:[poa1..], ejected:[poa1..]}}}]}.
 * Reads only epochs after scan.through_epoch. Returns the updated scan and whether it reached the end.
 */
export async function scanSlashes(conf, scan, deps = {}) {
  const P = poaSettings(conf);
  const out = { through_epoch: scan.through_epoch ?? null, hits: { ...(scan.hits || {}) } };
  if (!P.sources.close_records) return { ok: false, error: 'no close-record source configured', scan: out };
  let from = out.through_epoch == null ? 0 : out.through_epoch + 1;
  for (let page = 0; page < 200; page++) {
    const url = P.sources.close_records.replace('{from}', String(from));
    const r = await fetchJson(url, { fetchImpl: deps.fetch, timeoutMs: P.timeout_ms });
    if (!r.ok) return { ok: false, error: r.error, source: url, scan: out };
    const recs = r.json && Array.isArray(r.json.records) ? r.json.records : null;
    if (!recs) return { ok: false, error: 'unexpected close-record shape', source: url, scan: out };
    for (const x of [...recs].sort((a, b) => a.epoch - b.epoch)) {
      const basis = (x.record && x.record.basis) || {};
      if (!Array.isArray(basis.slashed) || !Array.isArray(basis.ejected)) return { ok: false, error: `close record ${x.epoch} has no slashed/ejected lists`, source: url, scan: out };
      for (const [kind, list] of [['slashed', basis.slashed], ['ejected', basis.ejected]]) {
        for (const a of list) if (typeof a === 'string') (out.hits[a] ||= []).push({ epoch: x.epoch, kind });
      }
      out.through_epoch = Math.max(out.through_epoch ?? -1, x.epoch);
    }
    const next = r.json.next_from;
    if (next == null || !recs.length) return { ok: true, scan: out };
    from = next;
  }
  return { ok: false, error: 'too many close-record pages', scan: out };
}

/** Forum adapter. Confirmed shape (LabLeak GET /api/posts/:id): {id, author_public_id, body, comments:[{id, author_public_id, body, created_at}]}. */
export async function readThread(conf, postId, deps = {}) {
  const P = poaSettings(conf);
  const url = P.forum.thread_api.replace('{post_id}', encodeURIComponent(String(postId)));
  const r = await fetchJson(url, { fetchImpl: deps.fetch, timeoutMs: P.timeout_ms });
  if (!r.ok) return { ok: false, error: r.error, source: url };
  const j = r.json || {};
  if (!Array.isArray(j.comments)) return { ok: false, error: 'unexpected thread shape', source: url };
  const items = [{ id: `post-${j.id}`, author_public_id: j.author_public_id, body: j.body }, ...j.comments.map((c) => ({ id: c.id, author_public_id: c.author_public_id, body: c.body }))];
  return { ok: true, source: url, items };
}

// ---------------------------------------------------------------- evaluation (pure)

export function evaluateOwnership({ address, code, postId }, thread) {
  if (!code) return { state: 'pending', reason: 'challenge code not issued yet' };
  if (!postId) return { state: 'pending', reason: 'no forum thread to read yet: post the code on LabLeak and add the post id as poa_proof_post (or wait for the conference proof thread)' };
  if (!thread || !thread.ok) return { state: 'pending', reason: `forum unavailable (${thread ? thread.error : 'not read'}); will re-check` };
  const hits = thread.items.filter((i) => typeof i.body === 'string' && i.body.includes(code));
  const mine = hits.find((i) => i.author_public_id === address);
  if (mine) return { state: 'verified', reason: 'challenge code found in a comment by this PoA address', comment_id: mine.id, post_id: postId };
  if (hits.length) return { state: 'rejected', reason: `author mismatch: the code was posted by forum id ${String(hits[0].author_public_id).slice(0, 60)}, not by ${address}`, post_id: postId };
  return { state: 'pending', reason: `challenge code not found in post ${postId} yet` };
}

export function evaluateAccount(conf, address, account, slash) {
  const P = poaSettings(conf);
  const lookback = P.slash_lookback_epochs;
  const hits = ((slash && slash.scan && slash.scan.hits[address]) || []).filter((h) => lookback == null || slash.scan.through_epoch == null || h.epoch > slash.scan.through_epoch - lookback);
  if (hits.length) return { state: 'rejected', reason: `${hits[0].kind} at epoch ${hits[0].epoch} (public close record)`, established: account && account.ok ? account.established : null, slashed: hits };
  if (!account || !account.ok) return { state: 'pending', reason: `account source unavailable (${account ? account.error : 'not read'}); will re-check`, established: null, slashed: null };
  if (!slash || !slash.ok) return { state: 'pending', reason: `slash records unavailable (${slash ? slash.error : 'not read'}); will re-check`, established: account.established, slashed: null };
  if (account.established) return { state: 'verified', reason: 'established and not slashed', established: true, slashed: [] };
  if (account.degraded) return { state: 'pending', reason: 'not established per the explorer, but the network reports maintenance or stale data; will re-check', established: false, slashed: [] };
  return { state: 'rejected', reason: 'not established on the PoA network (answer epoch challenges to become established, then it re-checks)', established: false, slashed: [] };
}

export function combine(ownership, account) {
  if (ownership.state === 'rejected') return { badge: 'rejected', reason: ownership.reason };
  if (account.state === 'rejected') return { badge: 'rejected', reason: account.reason };
  if (ownership.state === 'verified' && account.state === 'verified') return { badge: 'verified', reason: 'forum ownership proven; established and not slashed' };
  return { badge: 'pending', reason: ownership.state !== 'verified' ? ownership.reason : account.reason };
}

/** Which agents are due for a re-check. */
export function isDue(conf, entry, rec, now, force) {
  const P = poaSettings(conf);
  if (force || !entry || !entry.checked_at || entry.address !== rec.poa_address) return true;
  if ((entry.proof_post || null) !== (rec.poa_proof_post || P.forum.proof_post_id || null)) return true;
  const age = now - Date.parse(entry.checked_at);
  return age >= (entry.badge === 'verified' ? P.recheck.verified_hours : P.recheck.pending_hours) * 3_600_000;
}

/** Forced re-check window before the agenda lock (recheck.force_before), at most once per window. */
export function forceDue(conf, status, now) {
  const P = poaSettings(conf);
  if (!P || !P.recheck.force_before) return false;
  const lock = Date.parse(P.recheck.force_before), from = lock - P.recheck.force_window_hours * 3_600_000;
  const last = status.forced && status.forced.last_at ? Date.parse(status.forced.last_at) : 0;
  return now >= from && now < lock && last < from;
}

/**
 * Re-check every registered agent that has a poa_address and is due.
 * @param agents Map|array of agent records; status the current status file; submissions {login: {number, source}} for new challenges.
 * @returns {status, transitions:[{agent, from, to, reason, submission}], checked:[logins]}
 */
export async function recheckAll(conf, { agents, status: prev, now = Date.now(), force = false, submissions = {} }, deps = {}) {
  const P = poaSettings(conf);
  const status = prev ? JSON.parse(JSON.stringify(prev)) : emptyStatus();
  status.schema = STATUS_SCHEMA;
  status.agents ||= {}; status.slash_scan ||= { through_epoch: null, checked_at: null, hits: {} }; status.forced ||= { last_at: null };
  const transitions = [], checked = [];
  if (!P) return { status, transitions, checked };
  const nowIso = ISO(now);
  const forced = force || forceDue(conf, status, now);
  const list = [...(agents.values ? agents.values() : agents)].filter((a) => a && a.poa_address).sort((a, b) => (a.agent < b.agent ? -1 : 1));
  const due = list.filter((rec) => isDue(conf, status.agents[rec.agent], rec, now, forced));
  // agents that dropped their address keep no entry
  for (const login of Object.keys(status.agents)) if (!list.some((r) => r.agent === login)) delete status.agents[login];
  if (forced && list.length) status.forced.last_at = nowIso;
  if (!due.length) return { status, transitions, checked };

  const slash = await scanSlashes(conf, status.slash_scan, deps);
  status.slash_scan = { ...slash.scan, checked_at: slash.ok ? nowIso : status.slash_scan.checked_at };

  for (const rec of due) {
    const old = status.agents[rec.agent];
    const sameAddr = old && old.address === rec.poa_address;
    const e = sameAddr ? old : { address: rec.poa_address, submission: null, challenge: null, history: old ? old.history || [] : [] };
    if (!e.submission && submissions[rec.agent]) e.submission = submissions[rec.agent];
    if (e.submission && !e.challenge) e.challenge = challengeCode(conf, { submission: e.submission.number, agent: rec.agent, address: rec.poa_address });
    const postId = rec.poa_proof_post || P.forum.proof_post_id || null;
    e.proof_post = postId;

    let ownership;
    if (e.ownership && e.ownership.state === 'verified' && e.ownership.post_id === postId && sameAddr) ownership = e.ownership;
    else {
      const thread = e.challenge && postId ? await readThread(conf, postId, deps) : null;
      ownership = { ...evaluateOwnership({ address: rec.poa_address, code: e.challenge, postId }, thread), checked_at: nowIso, source: thread ? thread.source : null };
    }
    const account = await readAccount(conf, rec.poa_address, deps);
    const acct = { ...evaluateAccount(conf, rec.poa_address, account, slash), checked_at: nowIso, source: account.source || null };
    let { badge, reason } = combine(ownership, acct);
    const prevBadge = sameAddr ? old.badge : null;
    // A verified agent keeps the badge through source outages for stale_grace_hours after its last full success.
    if (badge === 'pending' && prevBadge === 'verified' && ownership.state === 'verified' && acct.state === 'pending' && e.last_verified_at
      && now - Date.parse(e.last_verified_at) <= P.recheck.stale_grace_hours * 3_600_000) {
      badge = 'verified'; reason = `kept from ${e.last_verified_at}: ${acct.reason}`; e.stale = true;
    } else delete e.stale;
    if (badge === 'verified' && !e.stale) e.last_verified_at = nowIso;
    Object.assign(e, { ownership, account: acct, badge, reason, checked_at: nowIso });
    const lastHist = e.history.length ? e.history[e.history.length - 1].badge : null;
    if (lastHist !== badge) {
      e.history.push({ at: nowIso, badge, reason });
      transitions.push({ agent: rec.agent, from: lastHist, to: badge, reason, submission: e.submission });
    }
    status.agents[rec.agent] = e;
    checked.push(rec.agent);
  }
  status.updated_at = nowIso;
  status.sources = { account: P.sources.account || null, close_records: P.sources.close_records || null, forum: P.forum.thread_api || null };
  return { status, transitions, checked };
}
