#!/usr/bin/env node
'use strict';
process.chdir('/var/www/serpbays/serpbays_server');
require('dotenv').config();
const { Client } = require('pg');

(async () => {
  const c = new Client({
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });
  await c.connect();

  // 1. Discover columns
  const cols = await c.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name='invoices' ORDER BY ordinal_position
  `);
  console.log('invoices columns:', cols.rows.map(r => r.column_name).join(', '));

  const lnk = await c.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_name LIKE 'transactions%lnk' OR table_name LIKE 'invoices%lnk'
    ORDER BY table_name
  `);
  console.log('invoice/transaction link tables:', lnk.rows.map(r => r.table_name).join(', '));

  // 2. Does an invoice exist for the latest Razorpay deposits?
  const r3 = await c.query(`
    SELECT id, invoice_number, transaction_id, invoice_date, created_at
    FROM invoices
    WHERE transaction_id IN ('603', '598', '366')
    ORDER BY id DESC
  `);
  console.log('\n=== Invoices for txns 603/598/366 ===');
  console.table(r3.rows);

  // 3. Tx → linked invoice via the link table
  const r4 = await c.query(`
    SELECT t.id, t.type, t.transaction_status AS status, t.gateway,
           t.created_at, t.updated_at,
           tl.invoice_id AS linked_invoice
    FROM transactions t
    LEFT JOIN transactions_invoice_lnk tl ON tl.transaction_id = t.id
    WHERE t.id IN (603, 598, 366)
    ORDER BY t.id DESC
  `);
  console.log('\n=== Tx 603/598/366 + linked invoice id ===');
  console.table(r4.rows);

  // 4. Show tx 603 metadata in full
  const r5 = await c.query(`SELECT id, metadata FROM transactions WHERE id = 603`);
  if (r5.rows[0]) {
    console.log('\n=== Tx 603 metadata ===');
    console.log(JSON.stringify(r5.rows[0].metadata, null, 2));
  }

  // 5. Show ALL invoices created since pm2 restart (~05:11 UTC)
  const r6 = await c.query(`
    SELECT id, invoice_number, transaction_id, created_at
    FROM invoices
    WHERE created_at > NOW() - INTERVAL '3 hours'
    ORDER BY id DESC
  `);
  console.log('\n=== Invoices created in last 3 hours ===');
  console.table(r6.rows);

  await c.end();
})().catch(e => { console.error('DB error:', e.message); process.exit(1); });
