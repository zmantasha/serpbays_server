#!/usr/bin/env node

/**
 * Reconcile stuck `pending` transactions against the upstream gateway state.
 *
 * Audits every pending transaction in the SQLite DB whose gateway is one of
 * stripe / razorpay / paypal, classifies each via the gateway API, and
 * (in dry-run by default) prints what would happen.
 *
 * Usage:
 *   node scripts/reconcile-pending-payments.js          # dry run, READ-ONLY
 *   node scripts/reconcile-pending-payments.js --apply  # perform writes
 *
 * In dry-run mode the SQLite handle is opened READ-ONLY, so accidental
 * UPDATE/INSERT statements would throw at the driver level.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const Database = require('better-sqlite3');
const Stripe = require('stripe');
const Razorpay = require('razorpay');

// ---------- CLI flags ----------
const APPLY = process.argv.includes('--apply');

// ---------- Classification constants ----------
const CLASS = {
  REAL_CHARGE_TO_CREDIT: 'REAL_CHARGE_TO_CREDIT',
  ORPHAN_TO_CANCEL:      'ORPHAN_TO_CANCEL',
  STILL_PROCESSING:      'STILL_PROCESSING',
  MANUAL_REVIEW:         'MANUAL_REVIEW',
  UNKNOWN:               'UNKNOWN',
};

// ---------- Init clients ----------
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY missing from env'); process.exit(1);
}
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error('RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing from env'); process.exit(1);
}
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ---------- Open DB ----------
const dbPath = path.join(__dirname, '..', '.tmp', 'data.db');
const db = new Database(dbPath, { readonly: !APPLY });
console.log(`[mode] ${APPLY ? 'APPLY (read/write)' : 'DRY-RUN (read-only)'} :: db=${dbPath}\n`);

// ---------- Fetch pending rows ----------
const rows = db.prepare(`
  SELECT id, gateway, gateway_transaction_id, amount, transaction_status,
         datetime(created_at/1000, 'unixepoch') as created_iso,
         created_at as created_at_ms,
         metadata
  FROM transactions
  WHERE transaction_status = 'pending'
    AND gateway IN ('stripe','razorpay','paypal')
  ORDER BY id DESC
`).all();

console.log(`Found ${rows.length} pending transaction(s) to reconcile.\n`);

// ---------- Classifier helpers ----------
async function classifyStripe(row) {
  const id = row.gateway_transaction_id;
  if (!id) {
    return { classification: CLASS.UNKNOWN, gateway_status: 'no-id', notes: 'gateway_transaction_id is null' };
  }
  try {
    const pi = await stripe.paymentIntents.retrieve(id);
    const status = pi.status;
    const note =
      pi.amount_received != null ? `received=${pi.amount_received/100} ${pi.currency}` :
      pi.last_payment_error ? `err=${pi.last_payment_error.code || pi.last_payment_error.type}` :
      '';
    if (status === 'succeeded') {
      return { classification: CLASS.REAL_CHARGE_TO_CREDIT, gateway_status: status, notes: note, raw: pi };
    }
    if (['requires_payment_method', 'canceled', 'requires_confirmation'].includes(status)) {
      return { classification: CLASS.ORPHAN_TO_CANCEL, gateway_status: status, notes: note, raw: pi };
    }
    if (['processing', 'requires_action'].includes(status)) {
      return { classification: CLASS.STILL_PROCESSING, gateway_status: status, notes: note, raw: pi };
    }
    return { classification: CLASS.UNKNOWN, gateway_status: status, notes: `unmapped status: ${status}`, raw: pi };
  } catch (err) {
    return { classification: CLASS.UNKNOWN, gateway_status: 'api-error', notes: err.message };
  }
}

async function classifyRazorpay(row) {
  const id = row.gateway_transaction_id;
  if (!id) {
    return { classification: CLASS.UNKNOWN, gateway_status: 'no-id', notes: 'gateway_transaction_id is null' };
  }
  try {
    const resp = await razorpay.orders.fetchPayments(id);
    const items = (resp && resp.items) || [];
    const captured  = items.find(p => p.status === 'captured');
    const authorized = items.find(p => p.status === 'authorized');
    if (captured) {
      return {
        classification: CLASS.REAL_CHARGE_TO_CREDIT,
        gateway_status: 'captured',
        notes: `payment=${captured.id} amount=${captured.amount/100} ${captured.currency}`,
        raw: { capturedPayment: captured, all: items },
      };
    }
    if (authorized) {
      return {
        classification: CLASS.STILL_PROCESSING,
        gateway_status: 'authorized',
        notes: `payment=${authorized.id} (authorized but not captured)`,
        raw: { authorizedPayment: authorized, all: items },
      };
    }
    if (items.length === 0) {
      return { classification: CLASS.ORPHAN_TO_CANCEL, gateway_status: 'no-payments', notes: 'order has no payment attempts' };
    }
    const statuses = items.map(p => p.status).join(',');
    return { classification: CLASS.ORPHAN_TO_CANCEL, gateway_status: statuses, notes: `${items.length} non-captured payment(s)` };
  } catch (err) {
    return { classification: CLASS.UNKNOWN, gateway_status: 'api-error', notes: err.error?.description || err.message };
  }
}

function classifyPaypal(row) {
  return {
    classification: CLASS.MANUAL_REVIEW,
    gateway_status: 'n/a',
    notes: 'PayPal SDK not wired into this script — verify in PayPal dashboard',
  };
}

function ageString(createdMs) {
  if (!createdMs) return '?';
  const days = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
  if (days < 1) return `${(days * 24).toFixed(1)}h`;
  return `${days.toFixed(1)}d`;
}

// ---------- Apply helpers (only used when --apply) ----------
function loadWalletForTx(txId) {
  return db.prepare(`
    SELECT w.id as wallet_id, w.main_balance, w.promo_balance, w.balance, w.currency
    FROM transactions_user_wallet_lnk lnk
    JOIN user_wallets w ON w.id = lnk.user_wallet_id
    WHERE lnk.transaction_id = ?
  `).get(txId);
}

function applyRealCharge(row, decision) {
  // Description-only when called from dry-run; here we actually run it.
  const wallet = loadWalletForTx(row.id);
  if (!wallet) {
    console.log(`  [WARN] tx ${row.id}: no linked wallet — skipping credit`);
    return;
  }
  const nowIso = new Date().toISOString();
  const externalId = decision.raw?.capturedPayment?.id || row.gateway_transaction_id;
  const txn = db.transaction(() => {
    db.prepare(`
      UPDATE transactions
      SET transaction_status = 'success',
          updated_at = ?,
          external_transaction_id = COALESCE(external_transaction_id, ?),
          metadata = json_patch(COALESCE(metadata, '{}'), json_object('reconciled', json('true'), 'reconciledAt', ?))
      WHERE id = ?
    `).run(Date.now(), externalId, nowIso, row.id);
    db.prepare(`
      UPDATE user_wallets
      SET main_balance = COALESCE(main_balance, 0) + ?,
          balance      = (COALESCE(main_balance, 0) + ?) + COALESCE(promo_balance, 0),
          updated_at   = ?
      WHERE id = ?
    `).run(row.amount, row.amount, Date.now(), wallet.wallet_id);
  });
  const before = { main: wallet.main_balance, promo: wallet.promo_balance, balance: wallet.balance };
  txn();
  const after = db.prepare(`SELECT main_balance, promo_balance, balance FROM user_wallets WHERE id = ?`).get(wallet.wallet_id);
  console.log(`  [APPLIED] tx ${row.id} -> success | wallet ${wallet.wallet_id}: main ${before.main} -> ${after.main_balance}, balance ${before.balance} -> ${after.balance}`);
}

function applyOrphanCancel(row) {
  const stmt = db.prepare(`
    UPDATE transactions
    SET transaction_status = 'cancelled',
        updated_at = ?,
        payment_notes = COALESCE(payment_notes, '') || ' [reconciled: not charged at gateway]'
    WHERE id = ?
  `);
  const txn = db.transaction(() => stmt.run(Date.now(), row.id));
  txn();
  console.log(`  [APPLIED] tx ${row.id} -> cancelled`);
}

// ---------- Main ----------
(async () => {
  const results = [];

  for (const row of rows) {
    let decision;
    if (row.gateway === 'stripe')        decision = await classifyStripe(row);
    else if (row.gateway === 'razorpay') decision = await classifyRazorpay(row);
    else if (row.gateway === 'paypal')   decision = classifyPaypal(row);
    else                                  decision = { classification: CLASS.UNKNOWN, gateway_status: 'n/a', notes: `unsupported gateway: ${row.gateway}` };

    results.push({
      id: row.id,
      gateway: row.gateway,
      age: ageString(row.created_at_ms),
      amount: row.amount,
      gtxn_id: row.gateway_transaction_id,
      classification: decision.classification,
      gateway_status: decision.gateway_status,
      notes: decision.notes,
      _decision: decision,
      _row: row,
    });
  }

  // ---------- Pretty print table ----------
  console.log('\n=== Classification ===');
  const header = ['id','gateway','age','amount','classification','gateway_status','notes'];
  const widths = { id:5, gateway:9, age:6, amount:8, classification:24, gateway_status:24, notes:60 };
  function fmt(cells) {
    return cells.map((c, i) => String(c == null ? '' : c).padEnd(Object.values(widths)[i])).join(' | ');
  }
  console.log(fmt(header));
  console.log(header.map((_, i) => '-'.repeat(Object.values(widths)[i])).join('-+-'));
  for (const r of results) {
    console.log(fmt([r.id, r.gateway, r.age, r.amount, r.classification, r.gateway_status, (r.notes||'').slice(0, widths.notes)]));
  }

  // Also include the gateway transaction id list so it's easy to cross-reference
  console.log('\n=== Gateway transaction ids ===');
  for (const r of results) {
    console.log(`  ${String(r.id).padEnd(4)} ${r.gateway.padEnd(9)} ${r.gtxn_id || '(null)'}  -> ${r.classification}`);
  }

  // ---------- Summary ----------
  const summary = {
    REAL_CHARGE_TO_CREDIT: results.filter(r => r.classification === CLASS.REAL_CHARGE_TO_CREDIT),
    ORPHAN_TO_CANCEL:      results.filter(r => r.classification === CLASS.ORPHAN_TO_CANCEL),
    STILL_PROCESSING:      results.filter(r => r.classification === CLASS.STILL_PROCESSING),
    MANUAL_REVIEW:         results.filter(r => r.classification === CLASS.MANUAL_REVIEW),
    UNKNOWN:               results.filter(r => r.classification === CLASS.UNKNOWN),
  };
  const totalToCredit = summary.REAL_CHARGE_TO_CREDIT.reduce((s, r) => s + (r.amount || 0), 0);

  console.log('\n=== Summary ===');
  console.log(`  Total to credit            : $${totalToCredit.toFixed(2)} across ${summary.REAL_CHARGE_TO_CREDIT.length} tx`);
  console.log(`  Total to cancel (orphan)   : ${summary.ORPHAN_TO_CANCEL.length}`);
  console.log(`  Still processing (skip)    : ${summary.STILL_PROCESSING.length}`);
  console.log(`  Manual review (paypal etc.): ${summary.MANUAL_REVIEW.length}`);
  console.log(`  Unknown / error            : ${summary.UNKNOWN.length}`);

  if (summary.UNKNOWN.length) {
    console.log('\n  UNKNOWN details:');
    for (const r of summary.UNKNOWN) {
      console.log(`    tx ${r.id} (${r.gateway} ${r.gtxn_id}): ${r.notes}`);
    }
  }

  // ---------- Apply (only when flag set) ----------
  if (!APPLY) {
    console.log('\nDRY-RUN complete. No DB writes performed.');
    console.log('Re-run with --apply to perform writes.');
    db.close();
    return;
  }

  console.log('\n=== Applying writes ===');
  for (const r of results) {
    try {
      if (r.classification === CLASS.REAL_CHARGE_TO_CREDIT) {
        applyRealCharge(r._row, r._decision);
      } else if (r.classification === CLASS.ORPHAN_TO_CANCEL) {
        applyOrphanCancel(r._row);
      } else {
        console.log(`  [SKIP]    tx ${r.id} (${r.classification}) — manual handling required`);
      }
    } catch (err) {
      console.log(`  [ERROR]   tx ${r.id}: ${err.message} (this row rolled back, others unaffected)`);
    }
  }

  console.log('\nApply phase complete.');
  db.close();
})().catch(err => {
  console.error('Fatal error:', err);
  try { db.close(); } catch (_) {}
  process.exit(1);
});
