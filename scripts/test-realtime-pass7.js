#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 7 (multi-pod infra).
 *
 * Addresses two infra gaps the broader audit (wb7lz2yuo) called out as
 * CRITICAL for >1-pod deploys:
 *
 *   INFRA-1: No Socket.IO Redis/cluster adapter. Without one, room emits
 *            stay local to the emitting pod — sockets on other pods never
 *            see the event. Multi-pod silently breaks.
 *
 *   INFRA-2: Per-process in-memory seqByUser counters collide across pods
 *            and reset on Strapi restart. Pod A emits seq=1; pod B for
 *            the same user also emits seq=1 with a different payload;
 *            the client dedup drops the second.
 *
 * Pass 7 makes both gated on REDIS_URL — single-pod dev keeps working
 * unchanged with no Redis dependency, multi-pod production gets the
 * shared adapter + atomic INCR seq.
 *
 *   - package.json adds @socket.io/redis-adapter + ioredis.
 *   - src/bootstrap/websocket.js — adapter init wrapped in if (REDIS_URL)
 *     try/catch with a clean fallback path and ops-friendly logging.
 *   - src/utils/realtime-seq.js (NEW) — centralized seq helper. Tries
 *     Redis INCR via global.strapi.io_redis.pubClient; falls back to
 *     in-memory Map. Exposed factory pattern: realtime-seq(channelName).
 *   - Four emit helpers replaced their per-process Maps with the new
 *     helper.
 *
 * Run: cd serpbays_server && node scripts/test-realtime-pass7.js
 */
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');

const fs = require('fs');
let pass = 0, fail = 0;
const out = (...a) => process.stderr.write(a.join(' ') + '\n');
const assert = (cond, label) => {
  if (cond) { pass++; out('  ✅', label); }
  else      { fail++; out('  ❌', label); }
};
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const PKG = read('package.json');
const WS_BOOT = read('src/bootstrap/websocket.js');
const SEQ = read('src/utils/realtime-seq.js');
const UW = read('src/api/user-wallet/services/user-wallet.js');
const ORDER = read('src/api/order/services/order.js');
const WR = read('src/api/withdrawal-request/services/withdrawal-request.js');
const BTR = read('src/api/bank-transfer-request/services/bank-transfer-request.js');

out('\n=== 1) Deps ===');
assert(/"@socket\.io\/redis-adapter"/.test(PKG),
  '@socket.io/redis-adapter declared');
assert(/"ioredis"/.test(PKG),
  'ioredis declared');

out('\n=== 2) Bootstrap: Redis adapter gated on REDIS_URL ===');
assert(/if\s*\(\s*process\.env\.REDIS_URL\s*\)/.test(WS_BOOT),
  'adapter init is gated on REDIS_URL');
assert(/require\(['"]@socket\.io\/redis-adapter['"]\)/.test(WS_BOOT),
  'imports createAdapter from @socket.io/redis-adapter');
assert(/require\(['"]ioredis['"]\)/.test(WS_BOOT),
  'imports ioredis');
assert(/pubClient\.duplicate\(\)/.test(WS_BOOT),
  'subClient created via pubClient.duplicate()');
assert(/io\.adapter\(createAdapter\(pubClient,\s*subClient\)\)/.test(WS_BOOT),
  'adapter attached via io.adapter()');
assert(/try\s*\{[\s\S]{0,2000}\}\s*catch\s*\(err\)\s*\{[\s\S]{0,400}fall(?:ing|back)/i.test(WS_BOOT),
  'adapter init wrapped in try/catch with documented fallback');
assert(/strapi\.io_redis\s*=\s*\{\s*pubClient,\s*subClient\s*\}/.test(WS_BOOT),
  'redis clients exposed on strapi.io_redis for downstream consumers (seq helper)');
assert(/REDIS_URL not set/.test(WS_BOOT),
  'dev path (REDIS_URL not set) explicitly logged');

out('\n=== 3) Centralized seq helper ===');
assert(/module\.exports\s*=\s*\(channel\)\s*=>/.test(SEQ),
  'factory exports (channel) => { next }');
assert(/global\.strapi\?\.io_redis\?\.pubClient/.test(SEQ),
  'helper reads the pubClient from strapi.io_redis');
assert(/\.incr\(`rt:seq:\$\{channel\}:\$\{userId\}`\)/.test(SEQ),
  'uses Redis INCR keyed by `rt:seq:<channel>:<uid>`');
assert(/nextInMemory/.test(SEQ),
  'in-memory fallback exists');
assert(/inMemorySeqByChannel/.test(SEQ),
  'in-memory store is per-channel (no key collisions)');
assert(/log\?\.warn\?\.\([\s\S]{0,200}redis INCR failed/.test(SEQ),
  'Redis failures log a warning, do not throw');

out('\n=== 4) Four emit helpers use the shared seq ===');
const expectsSeqHelper = [
  { name: 'wallet', code: UW, channel: 'wallet' },
  { name: 'order', code: ORDER, channel: 'order' },
  { name: 'withdrawal', code: WR, channel: 'withdrawal' },
  { name: 'bank-transfer', code: BTR, channel: 'bank_transfer' },
];
for (const { name, code, channel } of expectsSeqHelper) {
  const importOk = new RegExp(`require\\(['"]\\.\\.\\/\\.\\.\\/\\.\\.\\/utils\\/realtime-seq['"]\\)\\(['"]${channel}['"]\\)`).test(code);
  assert(importOk,
    `${name} imports realtime-seq with channel '${channel}'`);
  assert(/await\s+seq\.next\(/.test(code) || /seq\.next\(/.test(code),
    `${name} calls seq.next(userId) for its payload`);
}

out('\n=== 5) Per-process Map seq counters removed ===');
for (const { name, code } of expectsSeqHelper) {
  assert(!/seqByUser\s*=\s*new\s+Map/.test(code) &&
         !/orderSeqByUser\s*=\s*new\s+Map/.test(code) &&
         !/withdrawalSeqByUser\s*=\s*new\s+Map/.test(code) &&
         !/btrSeqByUser\s*=\s*new\s+Map/.test(code) &&
         !/nextSeq\s*=\s*\(userId\)\s*=>/.test(code),
    `${name} no longer has its own per-process seq Map`);
}

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
