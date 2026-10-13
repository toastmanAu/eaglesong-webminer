import net from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Only a local tunnel peer may supply the configured client-address header. */
export function clientIpFromRequest(req, trustedHeader = null) {
  const peer = req.socket?.remoteAddress;
  if (typeof peer !== 'string' || net.isIP(peer) === 0) return null;
  if (trustedHeader === null) return peer;
  if (!LOOPBACK.has(peer)) return null;
  const forwarded = req.headers?.[trustedHeader];
  return typeof forwarded === 'string' && net.isIP(forwarded) !== 0 ? forwarded : null;
}

export function connectionCountForIp(sessions, clientIp) {
  let count = 0;
  for (const session of sessions.values()) if (session.clientIp === clientIp) count++;
  return count;
}
