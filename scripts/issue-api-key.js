'use strict';

/**
 * Issue (or rotate) an external API key for a selected user.
 *
 * Usage:
 *   node scripts/issue-api-key.js <email>            # issue / rotate key
 *   node scripts/issue-api-key.js <email> --revoke   # revoke access
 *
 * Sets apiKey + apiAccess=true + apiAccessAt on the matching user.
 * Prints the generated key ONCE — apiKey is private and never returned by the API.
 */

const crypto = require('crypto');
const path = require('path');

// Load .env so DB creds are available when run standalone.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');

async function main() {
  const email = process.argv[2];
  const revoke = process.argv.includes('--revoke');
  if (!email) {
    console.error('Usage: node scripts/issue-api-key.js <email> [--revoke]');
    process.exit(1);
  }

  const client = new Client({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  try {
    const found = await client.query('select id, email from up_users where lower(email) = lower($1)', [email]);
    if (found.rows.length === 0) {
      console.error(`No user found with email: ${email}`);
      process.exit(2);
    }
    const userId = found.rows[0].id;

    if (revoke) {
      await client.query('update up_users set api_access = false, api_key = null where id = $1', [userId]);
      console.log(`Revoked API access for ${email} (user id ${userId}).`);
      return;
    }

    const key = 'sb_live_' + crypto.randomBytes(24).toString('hex');
    await client.query(
      'update up_users set api_key = $1, api_access = true, api_access_at = now() where id = $2',
      [key, userId]
    );
    console.log('API key issued for', email, '(user id', userId + ')');
    console.log('--------------------------------------------------------------');
    console.log('API KEY (store securely, shown once):');
    console.log(key);
    console.log('--------------------------------------------------------------');
    console.log('Client usage:');
    console.log(`  curl -H "Authorization: Bearer ${key}" \\`);
    console.log('       "https://<api-host>/api/external/v1/sites?pagination[pageSize]=25"');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
