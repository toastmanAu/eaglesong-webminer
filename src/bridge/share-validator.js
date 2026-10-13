/**
 * share-validator.js — the bridge's independent verdict on a browser submit.
 *
 * Order of checks (each fails closed):
 *   1. generation known?            else rejected_stale
 *   2. jobId matches snapshot?      else rejected_invalid
 *   3. nonce prefix == session's?   else rejected_invalid
 *   4. not already submitted?       else rejected_duplicate
 *   5. recompute Eaglesong(powHash || nonce) — the browser's hashHex is diagnostic only
 *   6. meets network target → block_candidate; meets share target → share_ok; else rejected_low_diff
 *
 * The caller (session.js) forwards share_ok / block_candidate upstream exactly
 * once and turns the upstream ACK into the final classification.
 */
import { eaglesong, hexToBytes, bytesToHex } from '../hash/eaglesong-core.js';
import { meetsTarget } from '../hash/target.js';

/**
 * @param {ReturnType<import('./job-registry.js').createSessionJobRegistry>} registry
 * @param {{jobId:string, generation:number, nonceHex:string, hashHex?:string}} submit  (already schema-validated)
 */
export function evaluateSubmit(registry, submit) {
  const snapshot = registry.get(submit.generation);
  if (!snapshot) {
    return verdict('rejected_stale', `generation ${submit.generation} is not in the session's job window`, { snapshot: null });
  }
  if (snapshot.jobId !== submit.jobId) {
    return verdict('rejected_invalid', `jobId "${submit.jobId}" does not belong to generation ${submit.generation}`, { snapshot });
  }
  const nonce = hexToBytes(submit.nonceHex);
  if (nonce.length !== 16) return verdict('rejected_invalid', 'nonce must be 16 bytes', { snapshot });
  for (let i = 0; i < 8; i++) {
    if (nonce[8 + i] !== snapshot.prefix8[i]) {
      return verdict('rejected_invalid', 'nonce prefix (bytes 8..15) is not this session\'s prefix', { snapshot });
    }
  }
  if (!registry.markSubmitted(snapshot.jobId, submit.nonceHex)) {
    return verdict('rejected_duplicate', 'this {jobId, nonce} was already submitted in this session', { snapshot });
  }

  const input = new Uint8Array(48);
  input.set(snapshot.powHash, 0);
  input.set(nonce, 32);
  const hash = eaglesong(input);
  const hashHex = bytesToHex(hash);
  const clientHashMismatch = typeof submit.hashHex === 'string' ? submit.hashHex !== hashHex : false;
  const meetsNetwork = snapshot.networkTarget !== null && meetsTarget(hash, snapshot.networkTarget);
  const meetsShare = meetsTarget(hash, snapshot.shareTarget);

  const common = { snapshot, hashHex, meetsShare, meetsNetwork, clientHashMismatch };
  if (meetsNetwork) return verdict('block_candidate', 'recomputed hash meets the network target', common);
  if (meetsShare) return verdict('share_ok', 'recomputed hash meets the share target', common);
  return verdict('rejected_low_diff', 'recomputed hash is above the share target', common);
}

function verdict(classification, reason, extra) {
  return {
    classification, reason,
    hashHex: null, meetsShare: false, meetsNetwork: false, clientHashMismatch: false,
    ...extra,
  };
}
