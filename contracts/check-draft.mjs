// Dev check (not run in CI): compiles nothing itself. Usage, from a scratch dir with solc, @ethereumjs/evm, @ethereumjs/util, ethereum-cryptography installed:
//   npx solcjs --bin -o out contracts/PlenaryPointsClaim.sol && node contracts/check-draft.mjs out/<...>_PlenaryPointsClaim.bin
// Confirms the Solidity leaf and proof logic matches lib/merkle.mjs inside a local EVM.
import { createEVM } from '@ethereumjs/evm';
import { createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { readFileSync } from 'node:fs';
import { buildTree } from '../lib/merkle.mjs';
const bin = readFileSync(process.argv[2], 'utf8').trim();
const evm = await createEVM();
const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
const accts = ['0x' + 'ab'.repeat(20), '0x00000000000000000000000000000000000000f1', '0x1234567890abcdef1234567890abcdef12345678'];
const entries = accts.map((a, i) => ({ account: `evm:${a}`, points: [97, 0 + 5, 1234567][i] }));
const tree = buildTree(entries);
const args = pad(tree.root) + pad('0x' + '11'.repeat(20)) + pad('0x1') + pad('0x' + (2n ** 40n).toString(16));
const caller = createAddressFromString('0x' + '99'.repeat(20));
const dep = await evm.runCall({ caller, data: hexToBytes('0x' + bin + args), gasLimit: 10_000_000n });
if (dep.execResult.exceptionError) throw dep.execResult.exceptionError;
const to = dep.createdAddress;
// function selectors
import { keccak256 } from 'ethereum-cryptography/keccak.js';
const sel = (sig) => bytesToHex(keccak256(new TextEncoder().encode(sig))).slice(2, 10);
let ok = true;
for (const l of tree.leaves) {
  const addr = l.account.slice(4), pts = l.points;
  const r = await evm.runCall({ caller, to, data: hexToBytes('0x' + sel('leafFor(address,uint256)') + pad(addr) + pad('0x' + pts.toString(16))), gasLimit: 1_000_000n });
  const leaf = bytesToHex(r.execResult.returnValue);
  // verify(address,uint256,bytes32[])
  const proof = l.proof;
  const data = '0x' + sel('verify(address,uint256,bytes32[])') + pad(addr) + pad('0x' + pts.toString(16)) + pad('0x60') + pad('0x' + proof.length.toString(16)) + proof.map(pad).join('');
  const v = await evm.runCall({ caller, to, data: hexToBytes(data), gasLimit: 1_000_000n });
  const verified = BigInt(bytesToHex(v.execResult.returnValue)) === 1n;
  console.log(l.account, pts, leaf === l.leaf ? 'leaf matches JS' : `LEAF MISMATCH ${leaf} vs ${l.leaf}`, verified ? 'proof verifies on-chain' : 'PROOF FAILS');
  ok = ok && leaf === l.leaf && verified;
}
console.log(ok ? 'SOLIDITY DRAFT MATCHES lib/merkle.mjs' : 'MISMATCH'); process.exit(ok ? 0 : 1);
