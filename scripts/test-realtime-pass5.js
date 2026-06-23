#!/usr/bin/env node
/**
 * Regression test — real-time wiring pass 5 (notifications).
 *
 * The notification module already had a working push pipeline (lifecycle
 * afterCreate emits `notification` + `notification_count`, mark-as-read
 * controllers emit fresh counts). The audit found two CLIENT-side gaps:
 *
 *   1. layout.tsx navbar bell started at 0 with no mount-time REST
 *      backstop. Until a fresh notification fired the badge showed the
 *      wrong value, and a mark-all-read in tab B never propagated to
 *      tab A because the layout ignored `notification_count` events.
 *
 *   2. notifications/page.tsx derived unreadCount from the visible
 *      20-row page (`filter(n => !n.isRead).length`), undercounting
 *      when unread sat on later pages.
 *
 *   Plus a SERVER gap:
 *   3. controller had `getUnreadCount` but the routes file never
 *      exposed it.
 *
 * Pass 5 closes all three.
 *
 * Run: cd serpbays_server && node scripts/test-realtime-pass5.js
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

const N_ROUTES = read('src/api/notification/routes/notification.js');
const N_CTRL   = read('src/api/notification/controllers/notification.js');

const CLIENT = (rel) => read(`/var/www/serpbays/serpbays_client/${rel}`);
const C_LAYOUT = CLIENT('app/(dashboard)/layout.tsx');
const C_NPAGE  = CLIENT('app/(dashboard)/notifications/page.tsx');
const C_NSVC   = CLIENT('lib/services/notificationService.ts');

out('\n=== 1) Server: /notifications/unread-count route exposed ===');
assert(/path:\s*['"]\/notifications\/unread-count['"]/.test(N_ROUTES),
  'route registered');
assert(/handler:\s*['"]notification\.getUnreadCount['"]/.test(N_ROUTES),
  'wired to getUnreadCount controller');
assert(/async\s+getUnreadCount\s*\(\s*ctx/.test(N_CTRL),
  'controller method exists (unchanged from pre-pass-5)');

out('\n=== 2) Client: notificationService.getUnreadCount helper ===');
assert(/async\s+getUnreadCount\s*\(\)\s*:\s*Promise<number>/.test(C_NSVC),
  'getUnreadCount returns Promise<number>');
assert(/\/api\/notifications\/unread-count/.test(C_NSVC),
  'hits the new endpoint');
assert(/Number\.isFinite\(count\)\s*&&\s*count\s*>=\s*0\s*\?\s*count\s*:\s*0/.test(C_NSVC),
  'response coerced + bounded (no NaN / negative leak into state)');

out('\n=== 3) Client: layout.tsx mount-time fetch + count event handler ===');
assert(/notificationService\.getUnreadCount\(\)[\s\S]{0,80}setUnreadNotifications/.test(C_LAYOUT),
  'cold-load fetch seeds the navbar bell on mount');
assert(/data\.type === ['"]notification_count['"]/.test(C_LAYOUT),
  'layout branches on notification_count events (was: ignored)');
assert(/setUnreadNotifications\(next\)/.test(C_LAYOUT),
  'overwrites local state with server-authoritative count (multi-tab sync)');

out('\n=== 4) Client: notifications/page.tsx uses authoritative count ===');
assert(/notificationService\.getUnreadCount\(\)/.test(C_NPAGE),
  'page calls /unread-count on initial load');
assert(/setUnreadCount\(authoritativeCount\)/.test(C_NPAGE),
  'page seeds count from the endpoint, not the visible-page filter');
assert(!/setUnreadCount\(\s*notificationsData\.filter\(n\s*=>\s*!n\.isRead\)\.length\s*\)/.test(C_NPAGE),
  'old undercount logic (visible-page filter) removed from loadInitialData');

out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
