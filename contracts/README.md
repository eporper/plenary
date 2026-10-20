# contracts/: undeployed draft

`PlenaryPointsClaim.sol` is an **undeployed, unaudited draft**. No token exists, and no deployment is planned or promised. It is here only so a later, separate decision can start from code that verifies the published snapshot format (see [../TOKEN.md](../TOKEN.md)).

What was checked (2026-10-20): the contract compiles with solc 0.8.28. In a local EVM (`@ethereumjs/evm`), `leafFor` and `verify` reproduce the leaves and proofs produced by `lib/merkle.mjs` for sample EVM accounts (`check-draft.mjs`). Nothing else has been checked: no audit, no gas review, no tests of `claim`.

Before any use you would need an audit, a decision on the token and its legal status, a funded token contract, a separate claim path for `github:` and non-EVM keys, and a dispute window for the final snapshot.
