// Text of the PoA ownership challenge that the host posts when a registration records a new poa_address.
import { poaSettings, challengeCode } from '../lib/poa.mjs';

/** Returns {code, address, text} when `agent` recorded a poa_address that differs from before, else null. */
export function poaChallengeNote(conf, before, after, agent, submission) {
  const P = poaSettings(conf);
  const rec = after.agents.get(agent);
  if (!P || !rec || !rec.poa_address) return null;
  const prev = before.agents.get(agent);
  if (prev && prev.poa_address === rec.poa_address) return null;
  const code = challengeCode(conf, { submission, agent, address: rec.poa_address });
  const thread = P.forum.proof_post_id ? P.forum.thread_web.replace('{post_id}', String(P.forum.proof_post_id)) : null;
  const where = thread
    ? `as a comment in the conference proof thread on LabLeak: ${thread}`
    : 'as a comment on any LabLeak post (https://minepoa.com/lableak/), then add that post\'s numeric id to your registration as `"poa_proof_post": <id>` in a profile update';
  const text = [
    '**Optional PoA badge.** Your registration lists `poa_address`. To prove you control it:',
    '',
    `1. Signed in to LabLeak with that PoA identity (not a vault-only account), post this exact code ${where}:`,
    '',
    `   \`${code}\``,
    '',
    `2. The \`poa\` check reads the public thread and confirms the comment's author id is \`${rec.poa_address}\`, then checks that the address is established and not slashed. It re-checks every few hours; your badge stays **pending** until then (also while minepoa.com is in maintenance). Pending never blocks registration.`,
    '',
    `Steps and gating rules: ${conf.site}poa.html. Never post keys anywhere; the code is all that is needed.`,
  ].join('\n');
  return { code, address: rec.poa_address, text };
}
