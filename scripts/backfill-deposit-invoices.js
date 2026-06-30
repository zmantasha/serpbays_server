#!/usr/bin/env node
/**
 * One-time backfill — create invoices for successful wallet-deposit
 * transactions that completed BEFORE the verify-path wiring fix landed.
 *
 * Targets every `type=deposit` × `transactionStatus=success` transaction
 * that has no linked invoice yet. The invoice service is idempotent on
 * transactionId, so re-running this is safe.
 *
 * Usage:
 *   node scripts/backfill-deposit-invoices.js --dry-run     # show what would happen
 *   node scripts/backfill-deposit-invoices.js --apply       # actually create
 *
 * Strapi bootstraps the same as a real boot — slow first invocation
 * (~10s); fine for a one-off.
 */
'use strict';

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const DRY_RUN = !process.argv.includes('--apply');

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const app = await createStrapi({ distDir: 'dist' }).load();
  global.strapi = app;

  const txs = await app.db.query('api::transaction.transaction').findMany({
    where: {
      type: 'deposit',
      transactionStatus: 'success',
      gateway: { $in: ['stripe', 'paypal', 'razorpay'] },
    },
    populate: { users_permissions_user: true, invoice: true },
    orderBy: { id: 'desc' },
    limit: 1000,
  });

  console.log(`Found ${txs.length} successful deposit transactions in scope.`);

  const orphans = txs.filter((tx) => !tx.invoice);
  console.log(`${orphans.length} have NO linked invoice — these would be backfilled.\n`);

  if (orphans.length === 0) {
    console.log('Nothing to do.');
    await app.destroy();
    process.exit(0);
  }

  console.table(orphans.map((t) => ({
    id: t.id,
    gateway: t.gateway,
    amount: t.amount,
    created: t.createdAt,
    user: t.users_permissions_user?.id || '(no user)',
  })));

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] No changes made. Re-run with --apply to create invoices.');
    await app.destroy();
    process.exit(0);
  }

  console.log('\nRunning backfill...');
  let created = 0, skipped = 0, failed = 0;
  for (const tx of orphans) {
    const user = tx.users_permissions_user;
    if (!user) {
      console.warn(`  SKIP tx ${tx.id} — no user`);
      skipped++;
      continue;
    }
    try {
      const inv = await app.service('api::invoice.invoice').createInvoiceForTransaction(tx, user);
      if (inv) {
        console.log(`  CREATED tx ${tx.id} → invoice ${inv.invoiceNumber}`);
        created++;
      } else {
        console.warn(`  SKIP tx ${tx.id} — service returned null`);
        skipped++;
      }
    } catch (err) {
      console.error(`  FAILED tx ${tx.id} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nSummary — created: ${created}, skipped: ${skipped}, failed: ${failed}`);
  await app.destroy();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
