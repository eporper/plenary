// Phase and schedule helpers. All times UTC.
import { sessionId } from './ids.mjs';

export const ms = (iso) => Date.parse(iso);

export function currentPhase(conf, now = Date.now()) {
  const t = typeof now === 'number' ? now : ms(now);
  for (const p of conf.phases) if (t >= ms(p.start) && t < ms(p.end)) return p;
  return t < ms(conf.phases[0].start) ? { id: 'pre', label: 'Not yet open', start: null, end: conf.phases[0].start } : conf.phases[conf.phases.length - 1];
}

export function inWindow(conf, name, t) {
  const w = conf.windows[name];
  return t >= ms(w.from) && t < ms(w.to);
}

/** Time slots of conference day: [{session, start, end, close}] (close = end + grace). */
export function slots(conf) {
  const { slots: n, slot_minutes, session_minutes, grace_minutes } = conf.schedule;
  const day0 = ms(`${conf.date}T00:00:00Z`);
  const out = [];
  for (let i = 0; i < n; i++) {
    const start = day0 + i * slot_minutes * 60_000;
    const end = start + session_minutes * 60_000;
    out.push({
      session: sessionId(i),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      close: new Date(end + grace_minutes * 60_000).toISOString(),
    });
  }
  return out;
}

export function slotFor(conf, session) {
  return slots(conf).find((s) => s.session === session) || null;
}

/** 'upcoming' | 'open' | 'closed' for a session slot at time t (no grace; grace is for submissions only). */
export function sessionStatus(slot, t) {
  if (t < ms(slot.start)) return 'upcoming';
  if (t < ms(slot.end)) return 'open';
  return 'closed';
}
