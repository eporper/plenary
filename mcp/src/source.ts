// Where the server reads the conference from: the published site (default) or a local checkout.
import type { Config } from './config.js';
// Shared rule engine, copied verbatim from ../lib by scripts/sync-core.mjs.
import { computeAll } from './core/compute.mjs';
import { loadConf, loadEntries, loadAgendaLock, loadPoaStatus } from './core/ledger-io.mjs';

export interface Entry { path: string; rec: any }
export interface Snapshot { conf: any; entries: Entry[]; agendaLock: any | null; poaStatus: any | null }

export class Source {
  private cache: { at: number; snap: Snapshot } | null = null;
  /** Records accepted in dry-run mode. Kept in memory so later calls in the same session see them. */
  readonly overlay: Entry[] = [];

  constructor(private cfg: Config) {}

  now(): number { return this.cfg.now ?? Date.now(); }

  async load(): Promise<Snapshot> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.snap;
    let snap: Snapshot;
    if (this.cfg.localDir) {
      snap = { conf: loadConf(this.cfg.localDir), entries: loadEntries(this.cfg.localDir), agendaLock: loadAgendaLock(this.cfg.localDir), poaStatus: loadPoaStatus(this.cfg.localDir) };
    } else {
      const get = async (f: string) => {
        const res = await fetch(`${this.cfg.site}data/${f}`, { headers: { 'user-agent': 'plenary-mcp' } });
        if (!res.ok) throw new Error(`Could not read ${this.cfg.site}data/${f} (${res.status}). Is the conference site deployed? Set PLENARY_SITE or PLENARY_LOCAL_DIR.`);
        return res.json() as Promise<any>;
      };
      // PoA badge cache is optional: a site built before it existed simply has no badges.
      const optional = (f: string) => fetch(`${this.cfg.site}data/${f}`, { headers: { 'user-agent': 'plenary-mcp' } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const [pub, ledger, poaStatus] = await Promise.all([get('conference.json'), get('ledger.json'), optional('poa-status.json')]);
      const { rules, slots, ...rest } = pub;
      snap = { conf: { ...rest, points: rules.points, limits: rules.limits }, entries: ledger.entries, agendaLock: ledger.agenda_lock, poaStatus };
    }
    this.cache = { at: Date.now(), snap };
    return snap;
  }

  async compute() {
    const s = await this.load();
    const result = computeAll(s.conf, [...s.entries, ...this.overlay], { now: this.now(), agendaLock: s.agendaLock, poaStatus: s.poaStatus });
    return { ...s, result };
  }
}
