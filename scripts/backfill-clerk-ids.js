#!/usr/bin/env node
'use strict';

/**
 * Backfill clerk_id on orphan up_users rows.
 *
 * An "orphan" is a row created during the buggy Clerk-sync window where the
 * row landed in Strapi but clerk_id never got persisted. The current hardened
 * sync controller refuses to auto-link these (returns 409), so we backfill
 * clerk_id manually by looking the email up in Clerk's Backend API.
 *
 * Modes:
 *   --audit     Read-only. Lists orphan rows + duplicate-email groupings + per-row
 *               business-data counts. Writes a CSV. No DB writes, no Clerk calls.
 *   --dry-run   Looks each orphan up in Clerk Backend API. Prints the plan
 *               (which row gets which clerk_id) but does NOT write to the DB.
 *   --apply     Same as --dry-run, but commits one transaction per email.
 *   --resume    Reads the prior log file and skips emails already marked
 *               'applied'. Useful if --apply was interrupted.
 *
 * Required env (read from ../.env via dotenv):
 *   DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USERNAME, DATABASE_PASSWORD
 *   CLERK_SECRET_KEY                      (NOT needed for --audit)
 *
 * Output files (in this scripts/ directory):
 *   backfill-clerk-audit-YYYY-MM-DD.csv   from --audit
 *   backfill-clerk-YYYY-MM-DD.log         JSON-lines log of every action
 *
 * Safety properties:
 *   - Never touches rows where password or provider are set (defensive WHERE
 *     clause on every UPDATE plus pre-filter on the SELECT)
 *   - Per-email transaction: a single email's UPDATE is atomic; an error mid-run
 *     does not partially mutate that email's rows
 *   - Idempotent: UPDATE includes `AND clerk_id IS NULL`, so re-running --apply
 *     is a no-op for already-backfilled rows
 *   - Never deletes any row. Duplicates (multiple orphan rows per email) get
 *     backfilled on ONE canonical row; the rest are left alone and flagged.
 *   - Rate-limited: 500ms between Clerk API calls in test mode (sk_test_*),
 *     100ms in live mode (sk_live_*). Configurable via CLERK_RATE_MS env var.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const VALID_MODES = ['--audit', '--dry-run', '--apply', '--resume'];
const MODE = process.argv[2];
const TODAY = new Date().toISOString().slice(0, 10);
const LOG_FILE = path.join(__dirname, `backfill-clerk-${TODAY}.log`);
const CSV_FILE = path.join(__dirname, `backfill-clerk-audit-${TODAY}.csv`);

// Tables that indicate "this row is in active use" — used to pick the canonical
// row when an email has multiple orphan duplicates. Add more if you want a
// stricter signal of liveness; these 13 cover real business data well.
const BUSINESS_TABLES = [
  'user_wallets_users_permissions_user_lnk',
  'orders_advertiser_lnk',
  'orders_publisher_lnk',
  'transactions_users_permissions_user_lnk',
  'publisher_websites_current_publisher_id_lnk',
  'publisher_websites_original_publisher_id_lnk',
  'invoices_user_lnk',
  'withdrawal_requests_publisher_lnk',
  'marketplaces_publisher_lnk',
  'projects_owner_lnk',
  'carts_user_lnk',
  'shortlists_owner_lnk',
  'saved_filters_users_permissions_user_lnk',
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function usage() {
  console.error(`Usage: node ${path.basename(__filename)} ${VALID_MODES.join('|')}`);
  process.exit(2);
}

function log(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRateLimitMs() {
  const explicit = process.env.CLERK_RATE_MS;
  if (explicit) return parseInt(explicit, 10);
  const key = process.env.CLERK_SECRET_KEY || '';
  return key.startsWith('sk_test_') ? 500 : 100;
}

async function getOrphans(client) {
  const { rows } = await client.query(`
    SELECT id, email, username, created_at, updated_at
    FROM up_users
    WHERE clerk_id IS NULL
      AND password IS NULL
      AND provider IS NULL
    ORDER BY email, id
  `);
  return rows;
}

async function getRelationCount(client, userId) {
  // Issue one COUNT per business table. With ~5 prod orphans this is cheap
  // (~65 queries total). For larger backfills you could UNION ALL these.
  let total = 0;
  for (const tbl of BUSINESS_TABLES) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM ${tbl} WHERE user_id = $1`,
      [userId]
    );
    total += rows[0].c;
  }
  return total;
}

function groupByEmail(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.email)) map.set(r.email, []);
    map.get(r.email).push(r);
  }
  return map;
}

async function lookupClerkUsersByEmail(email) {
  const url = `https://api.clerk.com/v1/users?email_address[]=${encodeURIComponent(email)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clerk API ${res.status}: ${body.slice(0, 200)}`);
  }
  return await res.json();
}

function readProcessedEmailsFromLog() {
  // Used by --resume: emails that have an 'applied' log line are skipped.
  if (!fs.existsSync(LOG_FILE)) return new Set();
  const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
  const done = new Set();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.event === 'applied' && obj.email) done.add(obj.email);
    } catch (_) {
      // ignore non-JSON lines
    }
  }
  return done;
}

// ─────────────────────────────────────────────────────────────────────────────
// Modes
// ─────────────────────────────────────────────────────────────────────────────

async function runAudit(client) {
  log({ event: 'audit_start' });
  const orphans = await getOrphans(client);
  log({ event: 'orphan_count', count: orphans.length });

  if (orphans.length === 0) {
    log({ event: 'audit_complete', csv: null, reason: 'no_orphans' });
    console.log('\n✅ No orphan rows found. Nothing to backfill.');
    return;
  }

  const byEmail = groupByEmail(orphans);
  const csv = [['email', 'row_count', 'row_ids', 'rows_with_relations', 'rels_per_id'].join(',')];

  for (const [email, rows] of byEmail) {
    const counts = [];
    let withRels = 0;
    for (const r of rows) {
      const c = await getRelationCount(client, r.id);
      counts.push(`${r.id}:${c}`);
      if (c > 0) withRels++;
    }
    csv.push([email, rows.length, rows.map((r) => r.id).join('|'), withRels, counts.join('|')].join(','));
  }

  fs.writeFileSync(CSV_FILE, csv.join('\n'));
  log({ event: 'audit_complete', csv: CSV_FILE, total_emails: byEmail.size, total_rows: orphans.length });
  console.log(`\n✅ Audit complete. CSV: ${CSV_FILE}`);
  console.log(`   ${byEmail.size} distinct email(s), ${orphans.length} orphan row(s).`);
}

async function buildPlan(client) {
  if (!process.env.CLERK_SECRET_KEY) {
    throw new Error('CLERK_SECRET_KEY is not set in env. Required for Clerk lookups.');
  }

  const orphans = await getOrphans(client);
  if (orphans.length === 0) {
    log({ event: 'no_orphans' });
    return [];
  }
  const byEmail = groupByEmail(orphans);
  const rateLimitMs = getRateLimitMs();
  log({ event: 'plan_start', emails: byEmail.size, rows: orphans.length, rate_limit_ms: rateLimitMs });

  const actions = [];
  for (const [email, rows] of byEmail) {
    try {
      const clerkUsers = await lookupClerkUsersByEmail(email);
      await sleep(rateLimitMs);

      if (clerkUsers.length === 0) {
        actions.push({
          email,
          decision: 'skip_no_clerk_user',
          row_ids: rows.map((r) => r.id),
          note: 'No Clerk user found for this email. Manual review needed.',
        });
        log({ event: 'plan_skip', reason: 'no_clerk_user', email, row_ids: rows.map((r) => r.id) });
        continue;
      }
      if (clerkUsers.length > 1) {
        actions.push({
          email,
          decision: 'skip_multiple_clerk_users',
          clerk_ids: clerkUsers.map((u) => u.id),
          row_ids: rows.map((r) => r.id),
          note: 'Clerk returned multiple users for this email. Manual review needed.',
        });
        log({ event: 'plan_skip', reason: 'multiple_clerk_users', email, clerk_ids: clerkUsers.map((u) => u.id) });
        continue;
      }

      // Pick canonical row: most business-data, then lowest id
      const withRels = [];
      for (const r of rows) {
        withRels.push({ ...r, rels: await getRelationCount(client, r.id) });
      }
      withRels.sort((a, b) => b.rels - a.rels || a.id - b.id);
      const canonical = withRels[0];
      const others = withRels.slice(1);

      actions.push({
        email,
        decision: 'backfill',
        canonical_id: canonical.id,
        canonical_rels: canonical.rels,
        clerk_id: clerkUsers[0].id,
        other_orphan_rows: others.map((r) => ({ id: r.id, rels: r.rels })),
      });
      log({
        event: 'plan_backfill',
        email,
        canonical_id: canonical.id,
        canonical_rels: canonical.rels,
        clerk_id: clerkUsers[0].id,
        other_rows: others.map((r) => r.id),
      });
    } catch (err) {
      actions.push({ email, decision: 'error', error: err.message });
      log({ event: 'plan_error', email, error: err.message });
    }
  }

  log({ event: 'plan_complete', total: actions.length });
  return actions;
}

function printPlan(actions) {
  console.log('\n=== PLAN ===');
  const buckets = { backfill: 0, skip_no_clerk_user: 0, skip_multiple_clerk_users: 0, error: 0 };
  for (const a of actions) buckets[a.decision] = (buckets[a.decision] || 0) + 1;
  console.log(JSON.stringify(buckets, null, 2));
  console.log('\nDetails:');
  for (const a of actions) {
    if (a.decision === 'backfill') {
      const otherNote = a.other_orphan_rows.length
        ? ` (${a.other_orphan_rows.length} other orphan row(s) left alone: ${a.other_orphan_rows.map((r) => r.id).join(', ')})`
        : '';
      console.log(`  ${a.email}: row ${a.canonical_id} ← clerk_id=${a.clerk_id}${otherNote}`);
    } else {
      console.log(`  ${a.email}: ${a.decision}${a.note ? ' — ' + a.note : ''}`);
    }
  }
}

async function runApply(client, actions, processedEmails) {
  let applied = 0;
  let skipped = 0;
  for (const action of actions) {
    if (action.decision !== 'backfill') continue;
    if (processedEmails && processedEmails.has(action.email)) {
      log({ event: 'resume_skip', email: action.email, reason: 'already_applied_in_log' });
      skipped++;
      continue;
    }
    try {
      await client.query('BEGIN');
      // Defensive WHERE clause: refuse to touch a row with auth attached,
      // and refuse to overwrite an existing clerk_id (idempotency).
      const { rowCount } = await client.query(
        `UPDATE up_users
           SET clerk_id = $1
         WHERE id = $2
           AND clerk_id IS NULL
           AND password IS NULL
           AND provider IS NULL`,
        [action.clerk_id, action.canonical_id]
      );
      if (rowCount !== 1) {
        await client.query('ROLLBACK');
        log({
          event: 'apply_unexpected_rowcount',
          email: action.email,
          row_id: action.canonical_id,
          row_count: rowCount,
          note: 'UPDATE matched 0 rows — row may have been modified outside this script. Skipped.',
        });
        skipped++;
        continue;
      }
      await client.query('COMMIT');
      log({
        event: 'applied',
        email: action.email,
        row_id: action.canonical_id,
        clerk_id: action.clerk_id,
      });
      applied++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      log({ event: 'apply_error', email: action.email, error: err.message });
    }
  }
  log({ event: 'apply_complete', applied, skipped });
  console.log(`\n✅ Apply complete. Backfilled: ${applied}. Skipped: ${skipped}.`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  if (!VALID_MODES.includes(MODE)) usage();

  for (const v of ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USERNAME', 'DATABASE_PASSWORD']) {
    if (!process.env[v]) {
      console.error(`Missing required env var: ${v}`);
      process.exit(2);
    }
  }

  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT, 10),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
  });
  await client.connect();
  log({ event: 'connected', db: process.env.DATABASE_NAME, host: process.env.DATABASE_HOST, mode: MODE });

  try {
    if (MODE === '--audit') {
      await runAudit(client);
    } else if (MODE === '--dry-run') {
      const actions = await buildPlan(client);
      printPlan(actions);
      console.log('\nℹ️  Dry-run only. No DB writes. Re-run with --apply to commit.');
    } else if (MODE === '--apply') {
      const actions = await buildPlan(client);
      printPlan(actions);
      await runApply(client, actions, null);
    } else if (MODE === '--resume') {
      const processed = readProcessedEmailsFromLog();
      log({ event: 'resume_start', already_processed: processed.size });
      const actions = await buildPlan(client);
      printPlan(actions);
      await runApply(client, actions, processed);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  log({ event: 'fatal', error: err.message, stack: err.stack });
  console.error('FATAL:', err.message);
  process.exit(1);
});
