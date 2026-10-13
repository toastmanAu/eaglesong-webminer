/**
 * fake-ckb-node.js — minimal CKB JSON-RPC stand-in for driving the REAL
 * solo-proxy.js without a chain: serves one get_block_template (a real mainnet
 * block reshaped as a template, compact_target lowered so a CPU can solve it)
 * and records submit_block calls. It validates nothing — tests do.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const EASY_COMPACT = '0x1f040000'; // 0x040000 << 224 = 2^242 → ~16k hashes per block

/** reshape a get_block JSON (proxy test fixture) into get_block_template output */
export function templateFromBlockFixture(proxyDir, { compactTarget = EASY_COMPACT } = {}) {
  const block = JSON.parse(readFileSync(path.join(proxyDir, 'test', 'fixtures', 'mainnet-block-raw.json'), 'utf8'));
  const h = block.header;
  return {
    version: h.version, compact_target: compactTarget, current_time: h.timestamp, number: h.number, epoch: h.epoch,
    parent_hash: h.parent_hash, dao: h.dao, work_id: '0x1', cycles_limit: '0x0', bytes_limit: '0x0', uncles_count_limit: '0x0',
    cellbase: { hash: block.transactions[0].hash, data: block.transactions[0] },
    transactions: block.transactions.slice(1).map(tx => ({ hash: tx.hash, data: tx })),
    proposals: block.proposals,
    uncles: block.uncles.map(u => ({ hash: u.header.hash, header: u.header, proposals: u.proposals })),
    extension: block.extension,
  };
}

export function startFakeCkbNode({ template, host = '127.0.0.1', port = 0 }) {
  const rpcLog = [];
  let current = template;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      let result = null, error = null;
      if (msg.method === 'get_block_template') result = current;
      else if (msg.method === 'submit_block') result = '0x' + '11'.repeat(32);
      else error = { code: -32601, message: `fake node: unsupported ${msg.method}` };
      if (msg.method !== 'get_block_template') rpcLog.push({ ts: Date.now(), method: msg.method, params: msg.params, response: { result, error } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result, error }));
    });
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve({
      port: srv.address().port, rpcLog,
      get template() { return current; },
      setTemplate(t) { current = t; },
      close: () => new Promise(r => srv.close(() => r())),
    }));
  });
}
