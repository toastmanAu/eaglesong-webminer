/** Browser connection inputs. The payout assertion is a guard, not a payout setter. */
export function normalizeEndpoint(input, pageProtocol = globalThis.location?.protocol) {
  if (typeof input !== 'string' || !input.trim() || input.length > 2048) throw new Error('Enter a bridge WebSocket URL');
  let url;
  try { url = new URL(input.trim()); } catch { throw new Error('Enter a valid bridge WebSocket URL'); }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('Bridge endpoint must use wss://');
  if (url.username || url.password || url.search || url.hash) throw new Error('Bridge endpoint cannot contain credentials, query, or fragment');
  if (url.protocol === 'ws:' && (pageProtocol === 'https:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use wss://; ws:// is only allowed for local development');
  }
  return url.href;
}

export function normalizeMiningAddress(input) {
  if (typeof input !== 'string') throw new Error('Mining address must be text');
  const address = input.trim();
  if (address && !/^ck[bt]1[a-z0-9]{10,1024}$/.test(address)) throw new Error('Enter a CKB address beginning ckb1 or ckt1');
  return address;
}

export function assertExpectedPayout(expected, payout, mode) {
  if (!expected) return;
  if (mode !== 'solo') throw new Error('Address matching is available for solo mining only');
  if (!payout?.verified || !payout.address) throw new Error('Endpoint payout is not verified from its node template');
  if (payout.address !== expected) throw new Error(`Endpoint payout ${payout.address} does not match your mining address ${expected}`);
}
