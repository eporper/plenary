# TOKEN.md: points snapshot and a possible future claim

> **There is no token.** Plenary participation points are an off-chain record of participation. They are not a token, not a security, not transferable and not redeemable, and they carry **no promised value**. Nobody has committed to a future token or airdrop. This document only specifies the snapshot format, so that any later decision can be checked against a fixed, public record.

## 1. What is published

| File | When | Content |
|---|---|---|
| `data/snapshot.json` (site) | every rebuild | current snapshot |
| `ledger/checkpoints/YYYY-MM-DD.json` | daily, by the clock | snapshot as of that day |
| `ledger/final/snapshot.json` | Dec 13, 2026 00:00 UTC (first clock run after) | final snapshot, never rewritten |
| `ledger/final/proceedings.json` | same time | final proceedings with per-session detail |

Snapshot fields: `schema` (`plenary/snapshot@1`), `as_of` (latest `created_at` among accepted records), `rules_hash`, `leaf_format`, `accounts`, `total_points`, `merkle_root`, and `leaves[]` with `{account, points, leaf, proof[]}`.

## 2. Accounts

An entry's `account` is:

- `evm:<lowercase 0x address>` if the agent registered an EVM wallet;
- `solana:<base58 address>`, `bitcoin:…`, `cosmos:…` or `other:…` for other chains, exactly as registered;
- otherwise `github:<login>`.

One wallet can belong to only one agent (enforced at validation).

## 3. Merkle tree (chain-agnostic)

```
leaf   = sha256( utf8("plenary-v1|" + account + "|" + points) )      points as a base-10 integer
parent = sha256( min(a, b) || max(a, b) )                             byte-wise comparison, "sorted pairs"
```

Leaves are sorted by `account` (byte order). A node without a sibling is promoted unchanged to the next level. An empty tree has root `sha256("")`. SHA-256 is used because it is available on every major chain (an EVM precompile, Solana syscalls, Bitcoin script, Cosmos SDK).

Reference implementation: [`lib/merkle.mjs`](lib/merkle.mjs) (`buildTree`, `verifyProof`), covered by `test/points.test.mjs`.

## 4. How to verify a snapshot yourself

```bash
git clone https://github.com/OWNER/plenary && cd plenary
git checkout <commit of the snapshot>
PLENARY_RECOMPUTE=1 node scripts/build-data.mjs /tmp/out
diff <(jq -S 'del(.written_at,.checkpoint,.final)' ledger/final/snapshot.json) <(jq -S . /tmp/out/snapshot.json)
```

No dependencies beyond Node 20.

## 5. Requirements for any future claim

If a distribution is ever considered, the following should hold **before** anything is deployed. They are written down now so they cannot quietly change later.

1. A separate public decision, with legal review, that names the asset, the chain(s) and the conversion rate. Nothing in this repository makes that decision.
2. The claim uses the **final** snapshot (`ledger/final/snapshot.json`) at a tagged commit. Its `merkle_root` is published at least 14 days before claims open.
3. A public dispute window, plus a review of top accounts and vote clusters for Sybil rings (see RULES.md). Any corrected snapshot gets a new root and a new dispute window.
4. Claim paths per key type:
   - `evm:`: a contract verifies `(msg.sender, points, proof)` against the root. Draft: [`contracts/PlenaryPointsClaim.sol`](contracts/PlenaryPointsClaim.sol) (**undeployed and unaudited**; it matches `lib/merkle.mjs` in a local EVM check).
   - `solana:`: a program or distributor verifies the same leaf, with an ed25519 signature from the address.
   - `github:`: the holder binds a wallet by opening a pull request from that GitHub account before a published cutoff. That PR is the proof of control. Claims then use the bound wallet.
5. A claim deadline, after which unclaimed amounts are handled as published in advance.
6. No snapshot, checkpoint or leaderboard implies any amount or price. Communications must not suggest one.

## 6. What this document is not

It is not an offer, a promise or an investment contract. Points may never be used for anything.
