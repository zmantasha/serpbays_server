'use strict';

const { createCoreService } = require('@strapi/strapi').factories;

const FEE_USD = 10;
const MAX_ROWS = 2000;
const MAX_CSV_CHARS = 300000;
const COOLDOWN_DAYS = 30;

// Minimal RFC-4180 CSV parser (quotes, escaped quotes, CRLF). No dependency.
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

const normDomain = (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const docId = () => Array.from({ length: 24 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');

module.exports = createCoreService('api::reseller-application.reseller-application', ({ strapi }) => ({
  FEE_USD,
  COOLDOWN_DAYS,

  /** CSV text -> [{domain, gp, li}], deduped. Throws a user-facing Error on bad input. */
  parseInventory(csvText) {
    if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('Inventory CSV is required.');
    if (csvText.length > MAX_CSV_CHARS) throw new Error('Inventory CSV is too large (max 300 KB).');
    const rows = parseCsv(csvText);
    if (rows.length < 2) throw new Error('Inventory CSV needs a header row and at least one site.');
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const find = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const dCol = find('domain', 'website', 'url', 'site');
    if (dCol < 0) throw new Error('Inventory CSV needs a "domain" (or website/url) column.');
    const gpCol = find('guest', 'gp', 'article', 'price');
    const liCol = find('insertion', 'li', 'link');
    const seen = new Set(); const out = [];
    for (const r of rows.slice(1)) {
      const d = normDomain(r[dCol]);
      if (!d || !d.includes('.') || seen.has(d)) continue;
      seen.add(d);
      out.push({ domain: d, gp: gpCol >= 0 ? num(r[gpCol]) : null, li: liCol >= 0 && liCol !== gpCol ? num(r[liCol]) : null });
      if (out.length > MAX_ROWS) throw new Error(`Inventory CSV has more than ${MAX_ROWS} sites; send your top ${MAX_ROWS}.`);
    }
    if (out.length === 0) throw new Error('No valid domains found in the inventory CSV.');
    return out;
  },

  /**
   * Charge the review fee from MAIN balance only (promo credit is never used),
   * under a row lock, and write the fee transaction in the same DB transaction.
   * Returns the transaction id. Throws Error('INSUFFICIENT_FUNDS') when short.
   */
  async chargeFee(userId, description) {
    const knex = strapi.db.connection;
    let txId = null;
    await strapi.db.transaction(async ({ trx }) => {
      const link = await knex('user_wallets_users_permissions_user_lnk').where('user_id', userId).first().transacting(trx);
      if (!link) throw new Error('INSUFFICIENT_FUNDS');
      const wallet = await knex('user_wallets').where('id', link.user_wallet_id).forUpdate().first().transacting(trx);
      const main = Number(wallet.main_balance || 0);
      if (main < FEE_USD) throw new Error('INSUFFICIENT_FUNDS');
      const newMain = Number((main - FEE_USD).toFixed(2));
      const promo = Number(wallet.promo_balance || 0);
      await knex('user_wallets').where('id', wallet.id).update({ main_balance: newMain, balance: Number((newMain + promo).toFixed(2)), updated_at: new Date() }).transacting(trx);
      const now = new Date();
      const [tx] = await knex('transactions').insert({
        document_id: docId(), type: 'fee', amount: FEE_USD, net_amount: FEE_USD, fee: 0, transaction_status: 'success', gateway: 'system',
        gateway_transaction_id: `reseller_fee_${userId}_${Date.now()}`, description, fund_source: 'main_fund',
        metadata: JSON.stringify({ kind: 'reseller_application_fee', nonRefundable: true }), created_at: now, updated_at: now, published_at: now,
      }).returning('id').transacting(trx);
      txId = typeof tx === 'object' ? tx.id : tx;
      await knex('transactions_users_permissions_user_lnk').insert({ transaction_id: txId, user_id: userId }).transacting(trx);
      await knex('transactions_user_wallet_lnk').insert({ transaction_id: txId, user_wallet_id: wallet.id }).transacting(trx);
    });
    return txId;
  },

  /** Reverse a fee charge (only used if the application row could not be created after charging). */
  async refundFee(userId, txId) {
    const knex = strapi.db.connection;
    await strapi.db.transaction(async ({ trx }) => {
      const link = await knex('user_wallets_users_permissions_user_lnk').where('user_id', userId).first().transacting(trx);
      const wallet = await knex('user_wallets').where('id', link.user_wallet_id).forUpdate().first().transacting(trx);
      const newMain = Number((Number(wallet.main_balance || 0) + FEE_USD).toFixed(2));
      await knex('user_wallets').where('id', wallet.id).update({ main_balance: newMain, balance: Number((newMain + Number(wallet.promo_balance || 0)).toFixed(2)), updated_at: new Date() }).transacting(trx);
      await knex('transactions').where('id', txId).update({ transaction_status: 'refunded', description: knex.raw("description || ' (reversed: application could not be saved)'"), updated_at: new Date() }).transacting(trx);
    });
  },

  /** Compare an applicant's domains with our marketplace: already listed? our price vs theirs, DR. */
  async autoCheck(rows) {
    const knex = strapi.db.connection;
    const domains = (rows || []).map((r) => r.domain).filter(Boolean);
    if (!domains.length) return { total: 0, alreadyListed: 0, cheaperThanUs: 0, pricierThanUs: 0, matches: [] };
    const found = await knex('marketplaces').whereIn('url', domains).whereNotNull('published_at').select('id', 'url', 'price', 'link_insertion_price', 'ahrefs_dr', 'ahrefs_traffic');
    const byDomain = new Map(found.map((m) => [m.url.toLowerCase(), m]));
    let cheaper = 0, pricier = 0;
    const matches = [];
    for (const r of rows) {
      const m = byDomain.get(r.domain);
      if (!m) continue;
      const cmp = r.gp && m.price ? (r.gp < m.price ? 'cheaper' : r.gp > m.price ? 'pricier' : 'same') : null;
      if (cmp === 'cheaper') cheaper++; if (cmp === 'pricier') pricier++;
      matches.push({ domain: r.domain, theirGp: r.gp, theirLi: r.li, ourGp: m.price, ourLi: m.link_insertion_price, dr: m.ahrefs_dr, traffic: m.ahrefs_traffic, compare: cmp, marketplaceId: m.id });
    }
    const drs = rows.map((r) => byDomain.get(r.domain)?.ahrefs_dr).filter((d) => d != null).map(Number);
    return { total: rows.length, alreadyListed: matches.length, newToUs: rows.length - matches.length, cheaperThanUs: cheaper, pricierThanUs: pricier, avgDrOfKnown: drs.length ? Math.round(drs.reduce((a, b) => a + b, 0) / drs.length) : null, matches: matches.slice(0, 500) };
  },
}));
