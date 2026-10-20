// Deterministic Merkle tree over (account, points) pairs.
// leaf   = sha256(utf8("plenary-v1|" + account + "|" + points))
// parent = sha256(min(a,b) || max(a,b))   (sorted pairs, so proofs need no left/right flags)
// An odd node at the end of a level is promoted unchanged.
import { createHash } from 'node:crypto';

const sha = (buf) => createHash('sha256').update(buf).digest();
export const leafHash = (account, points) => sha(Buffer.from(`plenary-v1|${account}|${points}`, 'utf8'));
const pair = (a, b) => (Buffer.compare(a, b) <= 0 ? sha(Buffer.concat([a, b])) : sha(Buffer.concat([b, a])));

/** @param {{account:string, points:number}[]} entries */
export function buildTree(entries) {
  const sorted = [...entries].sort((x, y) => (x.account < y.account ? -1 : x.account > y.account ? 1 : 0));
  const leaves = sorted.map((e) => leafHash(e.account, e.points));
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const cur = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? pair(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  const root = leaves.length ? levels[levels.length - 1][0] : sha(Buffer.alloc(0));
  const proof = (i) => {
    const out = [];
    for (let l = 0; l < levels.length - 1; l++) {
      const sib = i ^ 1;
      if (sib < levels[l].length) out.push('0x' + levels[l][sib].toString('hex'));
      i = i >> 1;
    }
    return out;
  };
  return {
    root: '0x' + root.toString('hex'),
    leaves: sorted.map((e, i) => ({ ...e, leaf: '0x' + leaves[i].toString('hex'), proof: proof(i) })),
  };
}

export function verifyProof(account, points, proof, root) {
  let h = leafHash(account, points);
  for (const p of proof) h = pair(h, Buffer.from(p.slice(2), 'hex'));
  return '0x' + h.toString('hex') === root;
}
