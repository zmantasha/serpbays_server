'use strict';

/**
 * Migration: Add unique constraint trigger to prevent duplicate promo code redemptions.
 *
 * Strapi 5 stores relations in link tables (promo_redemptions_promo_code_lnk and
 * promo_redemptions_user_lnk), so a simple composite unique index isn't possible.
 * Instead we create a BEFORE INSERT trigger on promo_redemptions_promo_code_lnk that
 * cross-checks the user link table and raises an exception on duplicates.
 *
 * NOTE: This migration only runs on PostgreSQL. SQLite does not support PL/pgSQL triggers.
 */

module.exports = {
  async up(knex) {
    console.log('Starting promo redemption unique constraint migration...');

    // Only run on PostgreSQL - SQLite does not support PL/pgSQL triggers
    const dbClient = knex.client.config.client;
    if (dbClient === 'sqlite' || dbClient === 'sqlite3' || dbClient === 'better-sqlite3') {
      console.log('Skipping migration: SQLite does not support PL/pgSQL triggers.');
      return;
    }

    try {
      // Create the check function
      // Strapi 5 keeps draft + published rows with the same document_id but different id values.
      // We must match by document_id to catch redemptions against either row.
      await knex.raw(`
        CREATE OR REPLACE FUNCTION check_duplicate_promo_redemption()
        RETURNS TRIGGER AS $$
        DECLARE
          v_user_id BIGINT;
          v_doc_id VARCHAR(255);
          v_all_promo_ids INT[];
          v_duplicate_count INT;
        BEGIN
          -- Look up the user_id for this promo_redemption_id
          SELECT user_lnk.user_id INTO v_user_id
          FROM promo_redemptions_user_lnk AS user_lnk
          WHERE user_lnk.promo_redemption_id = NEW.promo_redemption_id;

          -- If no user link exists yet, allow the insert (user link may be inserted after)
          IF v_user_id IS NULL THEN
            RETURN NEW;
          END IF;

          -- Get the document_id for the promo code being redeemed
          SELECT document_id INTO v_doc_id
          FROM promo_codes
          WHERE id = NEW.promo_code_id;

          -- Get ALL row ids that share this document_id (draft + published)
          SELECT ARRAY_AGG(id) INTO v_all_promo_ids
          FROM promo_codes
          WHERE document_id = v_doc_id;

          -- Check if any OTHER redemption already has the same (document, user) combo
          SELECT COUNT(*) INTO v_duplicate_count
          FROM promo_redemptions_promo_code_lnk AS pc_lnk
          INNER JOIN promo_redemptions_user_lnk AS u_lnk
            ON pc_lnk.promo_redemption_id = u_lnk.promo_redemption_id
          WHERE pc_lnk.promo_code_id = ANY(v_all_promo_ids)
            AND u_lnk.user_id = v_user_id
            AND pc_lnk.promo_redemption_id != NEW.promo_redemption_id;

          IF v_duplicate_count > 0 THEN
            RAISE EXCEPTION 'Duplicate promo redemption: user % has already redeemed promo code %',
              v_user_id, v_doc_id;
          END IF;

          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      // Create the trigger (drop first if it exists from a previous partial run)
      await knex.raw(`
        DROP TRIGGER IF EXISTS trg_check_duplicate_promo_redemption
        ON promo_redemptions_promo_code_lnk;
      `);
      await knex.raw(`
        CREATE TRIGGER trg_check_duplicate_promo_redemption
        BEFORE INSERT ON promo_redemptions_promo_code_lnk
        FOR EACH ROW
        EXECUTE FUNCTION check_duplicate_promo_redemption();
      `);

      console.log('Added duplicate promo redemption trigger successfully');
    } catch (error) {
      console.error('Migration error details:', error.message || error);
      throw error;
    }
  },

  async down(knex) {
    console.log('Rolling back promo redemption unique constraint migration...');

    const dbClient = knex.client.config.client;
    if (dbClient === 'sqlite' || dbClient === 'sqlite3' || dbClient === 'better-sqlite3') {
      console.log('Skipping rollback: SQLite does not support PL/pgSQL triggers.');
      return;
    }

    await knex.raw(`
      DROP TRIGGER IF EXISTS trg_check_duplicate_promo_redemption
      ON promo_redemptions_promo_code_lnk;
    `);

    await knex.raw(`
      DROP FUNCTION IF EXISTS check_duplicate_promo_redemption();
    `);

    console.log('Removed duplicate promo redemption trigger successfully');
  }
};
