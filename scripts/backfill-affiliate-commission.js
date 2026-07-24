'use strict';

/**
 * Backfill an affiliate commission for a deposit that already succeeded
 * before the awardOnDeposit hook was working.
 *
 * Usage:
 *   node scripts/backfill-affiliate-commission.js <depositTxId>
 *
 * Fully idempotent — if a ledger row already exists for the deposit, the
 * service short-circuits and returns the existing row.
 */

const { createStrapi } = require('@strapi/strapi');

async function main() {
  const depositTxId = Number(process.argv[2]);
  if (!Number.isFinite(depositTxId) || depositTxId <= 0) {
    console.error('Usage: node scripts/backfill-affiliate-commission.js <depositTxId>');
    process.exit(1);
  }

  const app = await createStrapi();
  await app.load();
  try {
    const result = await app.service('api::affiliate-commission.affiliate-commission')
      .awardOnDeposit({ depositTransactionId: depositTxId });
    if (result) {
      console.log(`✅ Commission accrued for deposit ${depositTxId}:`);
      console.log(`   id=${result.id}  amount=$${result.commissionAmount}  rate=${result.ratePercent}%`);
    } else {
      console.log(`ℹ️  Deposit ${depositTxId} did not qualify for a commission (guard rejection — see backend log).`);
    }
  } catch (err) {
    console.error(`❌ Backfill failed for deposit ${depositTxId}:`, err.message);
    process.exitCode = 2;
  } finally {
    await app.destroy();
  }
}

main().catch((e) => { console.error(e); process.exit(3); });
