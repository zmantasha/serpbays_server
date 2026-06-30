#!/usr/bin/env node
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');
require('dotenv').config();
const { Client } = require('pg');

const DOMAIN_QUERY = process.argv[2] || 'themarketersoftware.com';

(async () => {
  const c = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });
  await c.connect();

  // Find every marketplace row matching the domain (handle www. / http(s):// variants).
  const r = await c.query(
    `SELECT m.id, m.url, m.publisher_email, m.publisher_name,
            m.created_at, m.updated_at,
            ml.user_id AS publisher_id,
            u.username, u.email, u.first_name, u.last_name, u.business_name
     FROM marketplaces m
     LEFT JOIN marketplaces_publisher_lnk ml ON ml.marketplace_id = m.id
     LEFT JOIN up_users u ON u.id = ml.user_id
     WHERE m.url ILIKE $1
        OR m.url ILIKE $2
        OR m.url ILIKE $3
        OR m.url ILIKE $4
     ORDER BY m.id DESC`,
    [DOMAIN_QUERY, `%${DOMAIN_QUERY}%`, `%www.${DOMAIN_QUERY}%`, `%//${DOMAIN_QUERY}%`]
  );

  if (r.rows.length === 0) {
    console.log(`No marketplace listing found matching "${DOMAIN_QUERY}".`);
    await c.end();
    return;
  }

  console.log(`Found ${r.rows.length} listing(s) for "${DOMAIN_QUERY}":\n`);
  r.rows.forEach((row, i) => {
    console.log(`--- Listing ${i + 1} ---`);
    console.log(`  marketplace.id        : ${row.id}`);
    console.log(`  url                   : ${row.url}`);
    console.log(`  created_at            : ${row.created_at}`);
    console.log(`  updated_at            : ${row.updated_at}`);
    console.log('');
    console.log('  Publisher (linked FK)');
    console.log(`    user.id             : ${row.publisher_id ?? '(no FK)'}`);
    console.log(`    username            : ${row.username ?? '—'}`);
    console.log(`    email               : ${row.email ?? '—'}`);
    console.log(`    first_name          : ${row.first_name ?? '—'}`);
    console.log(`    last_name           : ${row.last_name ?? '—'}`);
    console.log(`    business_name       : ${row.business_name ?? '—'}`);
    console.log('');
    console.log('  Denormalized snapshot (legacy)');
    console.log(`    publisher_email     : ${row.publisher_email ?? '—'}`);
    console.log(`    publisher_name      : ${row.publisher_name ?? '—'}`);
    console.log('');
  });

  await c.end();
})().catch((e) => {
  console.error('DB error:', e.message);
  process.exit(1);
});
