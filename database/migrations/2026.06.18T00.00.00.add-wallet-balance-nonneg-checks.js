'use strict';

/**
 * Add CHECK constraints on user_wallets to defend against application-layer
 * balance races sneaking a negative through. Defense-in-depth alongside the
 * row-lock + CAS rewrite of the withdrawal create flow.
 *
 * Pre-flight: clamp any existing negative values to 0 so the constraint can
 * actually be applied. Any row that's currently negative was already corrupt
 * (no business path should produce negatives); clamping is reconciliation,
 * not data loss.
 *
 * Idempotent: drops existing constraints with the same names before adding
 * (so the migration is re-runnable in the rare case it runs twice).
 */

const CHECK_CONSTRAINTS = [
  { name: 'chk_user_wallets_main_balance_nonneg', column: 'main_balance' },
  { name: 'chk_user_wallets_balance_nonneg', column: 'balance' },
  { name: 'chk_user_wallets_pending_withdrawal_nonneg', column: 'pending_withdrawal_balance' },
  { name: 'chk_user_wallets_promo_balance_nonneg', column: 'promo_balance' },
  { name: 'chk_user_wallets_escrow_balance_nonneg', column: 'escrow_balance' },
];

module.exports = {
  async up(knex) {
    console.log('[MIGRATION wallet-nonneg-checks] starting');

    // Pre-flight: report + clamp any currently-negative rows.
    for (const { column } of CHECK_CONSTRAINTS) {
      const { rows } = await knex.raw(
        `SELECT id, ${column} AS bad_value FROM user_wallets WHERE ${column} < 0`
      );
      if (rows.length > 0) {
        console.warn(
          `[MIGRATION wallet-nonneg-checks] clamping ${rows.length} row(s) with negative ${column}: ` +
          rows.map((r) => `wallet#${r.id}=${r.bad_value}`).join(', ')
        );
        await knex.raw(`UPDATE user_wallets SET ${column} = 0 WHERE ${column} < 0`);
      }
    }

    // Idempotent constraint application.
    for (const { name, column } of CHECK_CONSTRAINTS) {
      await knex.raw(`ALTER TABLE user_wallets DROP CONSTRAINT IF EXISTS ${name}`);
      await knex.raw(
        `ALTER TABLE user_wallets ADD CONSTRAINT ${name} CHECK (${column} >= 0)`
      );
      console.log(`[MIGRATION wallet-nonneg-checks] applied CHECK (${column} >= 0) as ${name}`);
    }

    console.log('[MIGRATION wallet-nonneg-checks] done');
  },
};
