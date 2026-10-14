'use strict';

/**
 * Affiliate program ledger (2026-10-14). Spec: Serpbays-Affiliate-Program-Spec.pdf.
 *
 * A partner earns `rate_bps` (default 5%) of every COMPLETED order that a
 * buyer they referred paid for with their OWN real deposits:
 *   - referral: written once at signup from first-touch attribution, never
 *     re-attributed; expires `months` after signup;
 *   - deposit pool: one row per real-money deposit of a referred buyer
 *     (derived from `transactions`, so no gateway code needs hooks);
 *     withdrawals reduce it; publisher earnings and promo credit never enter it;
 *   - funding: when an order is placed, its main-balance spend is allocated
 *     FIFO against the pool; the part no pool covers is earnings -> no commission;
 *   - commission: on completion, one append-only ledger row per funding row,
 *     pending for `hold_days`, then payable; disputes freeze; refunds and lost
 *     chargebacks write reversal rows (negative) that carry forward;
 *   - payout: monthly draft per partner (gross - 1% fee - tax), or wallet
 *     credit at 1.25x as promo balance.
 * Everything is idempotent: unique keys on referrals, pool rows, funding,
 * commission-per-funding and (event_source, event_id).
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const REAL_GATEWAYS = ['stripe', 'paypal', 'razorpay', 'phonepe', 'bank_transfer'];
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com', 'mail.com', 'yandex.com', 'zoho.com']);
const PAYOUT_FEE_BPS = () => parseInt(process.env.AFFILIATE_PAYOUT_FEE_BPS || '100', 10);
// pg can hand jsonb back as a string depending on the client's type parsers
const jsonOf = (v) => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };

function knexOf(trx) {
  if (trx) return trx;
  try { const t = require('@strapi/database/dist/transaction-context.js').transactionCtx.get(); if (t) return t; } catch { /* not in a transaction */ }
  return strapi.db.connection;
}
const rows = async (k, sql, b = []) => (await k.raw(sql, b)).rows;
const one = async (k, sql, b = []) => (await k.raw(sql, b)).rows[0] || null;

let ready = null;
function ensure() {
  if (ready) return ready;
  const k = strapi.db.connection;
  ready = (async () => {
    await k.raw(`create table if not exists affiliate_partners (
      id serial primary key, user_id int, api_key_id int, name text not null, email text, country text, tax_profile jsonb not null default '{}',
      code text not null unique, rate_bps int not null default 500, months int not null default 12, hold_days int not null default 30,
      min_payout numeric(12,2) not null default 50, payout_method text not null default 'cash', payout_details jsonb, wallet_credit_multiplier numeric(6,3) not null default 1.25,
      status text not null default 'active', notes text, created_by int, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`);
    await k.raw(`create table if not exists affiliate_referrals (
      id serial primary key, user_id int not null unique, partner_id int not null, code text, touch_ts timestamptz, landing text, utm jsonb,
      ip text, device_hash text, status text not null default 'active', void_reason text, expires_at timestamptz not null, created_at timestamptz not null default now())`);
    await k.raw(`create table if not exists affiliate_deposit_pool (
      id serial primary key, user_id int not null, deposit_tx_id int not null unique, amount numeric(12,2) not null, remaining numeric(12,2) not null,
      source text, status text not null default 'ok', created_at timestamptz not null default now(), tx_at timestamptz)`);
    await k.raw(`create table if not exists affiliate_pool_debits (
      id serial primary key, user_id int not null, tx_id int not null unique, kind text not null, amount numeric(12,2) not null, created_at timestamptz not null default now())`);
    await k.raw(`create table if not exists affiliate_order_funding (
      id serial primary key, order_id int not null, deposit_tx_id int not null, amount numeric(12,2) not null, created_at timestamptz not null default now(), unique (order_id, deposit_tx_id))`);
    await k.raw(`create table if not exists affiliate_ledger (
      id serial primary key, partner_id int not null, user_id int, order_id int, deposit_tx_id int, payout_id int,
      kind text not null, amount numeric(12,2) not null, base_amount numeric(12,2), rate_bps int, status text not null,
      hold_until timestamptz, event_source text, event_id text, reason text, created_by int, created_at timestamptz not null default now(),
      unique (event_source, event_id))`);
    await k.raw(`create unique index if not exists uq_aff_ledger_commission on affiliate_ledger (order_id, deposit_tx_id) where kind = 'commission'`);
    await k.raw(`create index if not exists idx_aff_ledger_partner on affiliate_ledger (partner_id, status)`);
    await k.raw(`create table if not exists affiliate_payouts (
      id serial primary key, partner_id int not null, period text not null, gross numeric(12,2) not null, fee numeric(12,2) not null default 0, tax numeric(12,2) not null default 0,
      net numeric(12,2) not null, method text not null, reference text, status text not null default 'draft', approved_by int, approved_at timestamptz, paid_by int, paid_at timestamptz,
      notes text, created_at timestamptz not null default now(), unique (partner_id, period))`);
    await k.raw(`create table if not exists affiliate_clicks (
      id serial primary key, partner_id int not null, code text, visitor_hash text not null, day date not null default current_date,
      landing text, referrer text, ip text, country text, user_agent text, created_at timestamptz not null default now(), unique (partner_id, visitor_hash, day))`);
    await k.raw(`create index if not exists idx_aff_clicks_partner_day on affiliate_clicks (partner_id, day)`);
    await k.raw(`create table if not exists affiliate_flags (
      id serial primary key, partner_id int, user_id int, order_id int, kind text not null, detail text, status text not null default 'open', created_at timestamptz not null default now())`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ---- partners & referrals ---------------------------------------------------

const slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

async function partnerByCode(code, k = knexOf()) {
  const c = slug(code); if (!c) return null;
  const m = /^api-(\d+)$/.exec(c);
  if (m) { const p = await one(k, `select * from affiliate_partners where api_key_id = ? limit 1`, [parseInt(m[1], 10)]); if (p) return p; }
  return one(k, `select * from affiliate_partners where code = ? limit 1`, [c]);
}

function emailDomain(e) { const m = /@([^@]+)$/.exec(String(e || '').toLowerCase()); return m ? m[1] : null; }

/** Called from Clerk sync for every new signup. Writes the referral once. */
async function resolveReferral(user, { attribution, isNewSignup, ip, userAgent } = {}) {
  await ensure();
  if (!user || !user.id || !isNewSignup) return null;
  const k = knexOf();
  if (await one(k, 'select id from affiliate_referrals where user_id = ?', [user.id])) return null;
  const attr = (attribution && (attribution.first || attribution.last)) ? attribution : (user.signupAttribution || {});
  const touch = attr.first || attr.last || null;
  if (!touch) return null;
  const code = touch.ref || touch.utm_source || null;
  if (!code) return null;
  const partner = await partnerByCode(code, k);
  if (!partner) return null;
  const ageMs = user.createdAt ? Date.now() - new Date(user.createdAt).getTime() : 0;
  let status = partner.status === 'active' ? 'active' : 'void'; let why = partner.status === 'active' ? null : `partner ${partner.status}`;
  if (ageMs > 60 * 60 * 1000) { status = 'void'; why = 'account older than 1 hour at attribution'; }
  if (partner.user_id && Number(partner.user_id) === Number(user.id)) { status = 'void'; why = 'partner referred their own account'; }
  if (partner.email && String(partner.email).toLowerCase() === String(user.email || '').toLowerCase()) { status = 'void'; why = 'same email as partner'; }
  const pd = emailDomain(partner.email); const ud = emailDomain(user.email);
  if (status === 'active' && pd && ud && pd === ud && !PUBLIC_DOMAINS.has(pd)) { status = 'void'; why = `same email domain as partner (${pd})`; }
  if (status === 'active' && partner.user_id && ip) {
    const pu = await one(k, 'select signup_ip, last_login_at from up_users where id = ?', [partner.user_id]);
    if (pu && pu.signup_ip && pu.signup_ip === ip) { status = 'void'; why = 'same IP as partner account'; }
  }
  const crypto = require('crypto');
  const deviceHash = userAgent ? crypto.createHash('sha256').update(String(userAgent)).digest('hex').slice(0, 32) : null;
  const expires = new Date(new Date(user.createdAt || Date.now()).getTime() + (partner.months || 12) * 30.4375 * 86400000);
  const row = await one(k, `insert into affiliate_referrals (user_id, partner_id, code, touch_ts, landing, utm, ip, device_hash, status, void_reason, expires_at)
      values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?) on conflict (user_id) do nothing returning *`,
    [user.id, partner.id, slug(code), touch.ts ? new Date(Number(touch.ts)) : null, touch.landing || null, JSON.stringify({ utm_source: touch.utm_source || null, utm_medium: touch.utm_medium || null, utm_campaign: touch.utm_campaign || null, ref: touch.ref || null }), ip || null, deviceHash, status, why, expires]);
  if (row && status === 'void') await flag(k, { partner_id: partner.id, user_id: user.id, kind: 'self_referral', detail: why });
  strapi.log.info(`[affiliate] referral user ${user.id} -> partner ${partner.code} (${status}${why ? ': ' + why : ''})`);
  return row;
}

async function activeReferral(userId, k = knexOf()) {
  const r = await one(k, `select r.*, p.rate_bps, p.hold_days, p.status as partner_status, p.user_id as partner_user_id, p.code as partner_code
      from affiliate_referrals r join affiliate_partners p on p.id = r.partner_id where r.user_id = ? and r.status = 'active'`, [userId]);
  if (!r) return null;
  if (new Date(r.expires_at).getTime() < Date.now()) { await k.raw(`update affiliate_referrals set status = 'expired' where id = ?`, [r.id]); return null; }
  return r;
}

async function flag(k, f) {
  await k.raw(`insert into affiliate_flags (partner_id, user_id, order_id, kind, detail) values (?, ?, ?, ?, ?)`, [f.partner_id || null, f.user_id || null, f.order_id || null, f.kind, String(f.detail || '').slice(0, 500)]);
}

/** A visitor landed on a ?ref= link. One row per visitor per partner per day; bots ignored. */
async function recordClick({ code, landing, referrer, ip, userAgent, country }) {
  await ensure();
  const ua = String(userAgent || '').slice(0, 300);
  if (!ua || /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl\/|python-requests|wget/i.test(ua)) return { ok: false, why: 'bot' };
  const partner = await partnerByCode(code);
  if (!partner || !['active', 'paused'].includes(partner.status)) return { ok: false, why: 'no partner' };
  const crypto = require('crypto');
  const day = new Date().toISOString().slice(0, 10);
  const hash = crypto.createHash('sha256').update(`${ip || ''}|${ua}|${day}|${process.env.ADMIN_JWT_SECRET || 'sb'}`).digest('hex').slice(0, 32);
  const r = await knexOf().raw(`insert into affiliate_clicks (partner_id, code, visitor_hash, landing, referrer, ip, country, user_agent) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (partner_id, visitor_hash, day) do nothing returning id`,
    [partner.id, slug(code), hash, String(landing || '').slice(0, 500) || null, String(referrer || '').slice(0, 500) || null, ip ? String(ip).slice(0, 64) : null, country ? String(country).slice(0, 2) : null, ua]);
  return { ok: true, recorded: r.rows.length > 0, partnerId: partner.id };
}

/** Click / signup / conversion figures for a partner (all-time and last 30 days). */
async function clickStats(partnerId, k = knexOf()) {
  const r = await one(k, `select
      (select count(*) from affiliate_clicks c where c.partner_id = ?)::int clicks_total,
      (select count(*) from affiliate_clicks c where c.partner_id = ? and c.day >= current_date - 29)::int clicks_30d,
      (select count(distinct c.visitor_hash) from affiliate_clicks c where c.partner_id = ? and c.day >= current_date - 29)::int unique_30d,
      (select count(*) from affiliate_referrals r where r.partner_id = ? and r.status <> 'void')::int signups_total,
      (select count(*) from affiliate_referrals r where r.partner_id = ? and r.status <> 'void' and r.created_at >= current_date - 29)::int signups_30d`, Array(5).fill(partnerId));
  const conv = r.clicks_total > 0 ? Math.round((r.signups_total / r.clicks_total) * 1000) / 10 : null;
  return { ...r, conversion_pct: conv };
}

async function clickSeries(partnerId, days = 30, k = knexOf()) {
  return rows(k, `select to_char(d.day, 'YYYY-MM-DD') as day,
      coalesce((select count(*) from affiliate_clicks c where c.partner_id = ? and c.day = d.day::date), 0)::int clicks,
      coalesce((select count(*) from affiliate_referrals r where r.partner_id = ? and r.created_at::date = d.day::date and r.status <> 'void'), 0)::int signups
      from generate_series(current_date - (? || ' days')::interval, current_date, interval '1 day') d(day) order by 1`, [partnerId, partnerId, String(days - 1)]);
}

// ---- deposit pool -----------------------------------------------------------

/**
 * Bring the pool in line with the transactions table: add new real-money
 * deposits, apply withdrawals FIFO, undo withdrawals that were denied.
 */
async function syncPool(userId, k = knexOf()) {
  // Only money that moved after the referral exists counts (a referral is written at
  // signup, so normally everything; a manually attached referral starts from that day).
  const ref = await one(k, `select created_at from affiliate_referrals where user_id = ?`, [userId]);
  if (!ref) return;
  const since = ref.created_at;
  await k.raw(`insert into affiliate_deposit_pool (user_id, deposit_tx_id, amount, remaining, source, tx_at)
      select ?, t.id, t.amount, t.amount, t.gateway, t.created_at from transactions t
      join transactions_users_permissions_user_lnk l on l.transaction_id = t.id
      where l.user_id = ? and t.type = 'deposit' and t.transaction_status = 'success' and t.gateway in (${REAL_GATEWAYS.map(() => '?').join(',')})
        and coalesce(t.metadata->>'chargeback', '') <> 'true' and t.amount > 0 and t.created_at >= ?
      on conflict (deposit_tx_id) do nothing`, [userId, userId, ...REAL_GATEWAYS, since]);
  // withdrawals that left the platform (pending/approved/paid) reduce what can still fund orders
  const wds = await rows(k, `select t.id, t.amount from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id = t.id
      where l.user_id = ? and t.type = 'withdrawal' and t.transaction_status not in ('failed', 'denied', 'cancelled') and t.created_at >= ?
        and not exists (select 1 from affiliate_pool_debits d where d.tx_id = t.id) order by t.id`, [userId, since]);
  for (const w of wds) {
    let left = r2(w.amount);
    const pool = await rows(k, `select id, remaining from affiliate_deposit_pool where user_id = ? and remaining > 0 order by tx_at nulls last, id for update`, [userId]);
    for (const p of pool) { if (left <= 0) break; const take = r2(Math.min(left, p.remaining)); await k.raw('update affiliate_deposit_pool set remaining = remaining - ? where id = ?', [take, p.id]); left = r2(left - take); }
    await k.raw(`insert into affiliate_pool_debits (user_id, tx_id, kind, amount) values (?, ?, 'withdrawal', ?) on conflict do nothing`, [userId, w.id, r2(w.amount) - left]);
  }
  // withdrawals that were denied after we applied them: give the pool back
  const undo = await rows(k, `select d.id, d.amount from affiliate_pool_debits d join transactions t on t.id = d.tx_id
      where d.user_id = ? and d.kind = 'withdrawal' and t.transaction_status in ('failed', 'denied', 'cancelled')`, [userId]);
  for (const u of undo) {
    let left = r2(u.amount);
    const pool = await rows(k, `select id, amount, remaining from affiliate_deposit_pool where user_id = ? and remaining < amount order by tx_at desc nulls last, id desc for update`, [userId]);
    for (const p of pool) { if (left <= 0) break; const give = r2(Math.min(left, r2(p.amount - p.remaining))); await k.raw('update affiliate_deposit_pool set remaining = remaining + ? where id = ?', [give, p.id]); left = r2(left - give); }
    await k.raw('delete from affiliate_pool_debits where id = ?', [u.id]);
  }
}

// ---- orders -----------------------------------------------------------------

async function orderParties(orderId, k) {
  return one(k, `select o.id, o.total_amount, o.created_at, a.user_id as advertiser_id, p.user_id as publisher_id, w.marketplace_id as website_id
      from orders o left join orders_advertiser_lnk a on a.order_id = o.id left join orders_publisher_lnk p on p.order_id = o.id left join orders_website_lnk w on w.order_id = o.id where o.id = ?`, [orderId]);
}

/** Order placed: allocate the main-balance spend against the buyer's deposit pool (FIFO). */
async function onOrderFunded(orderId, advertiserId, mainSpent, trx) {
  await ensure();
  const k = knexOf(trx);
  const spend = r2(mainSpent);
  if (!(spend > 0)) return { funded: 0 };
  const ref = await activeReferral(advertiserId, k);
  if (!ref) return { funded: 0 };
  await syncPool(advertiserId, k);
  let left = spend; let funded = 0;
  const pool = await rows(k, `select id, deposit_tx_id, remaining from affiliate_deposit_pool where user_id = ? and remaining > 0 and status in ('ok', 'partial') order by tx_at nulls last, id for update`, [advertiserId]);
  for (const p of pool) {
    if (left <= 0) break;
    const take = r2(Math.min(left, p.remaining));
    await k.raw('update affiliate_deposit_pool set remaining = remaining - ? where id = ?', [take, p.id]);
    await k.raw(`insert into affiliate_order_funding (order_id, deposit_tx_id, amount) values (?, ?, ?) on conflict (order_id, deposit_tx_id) do update set amount = affiliate_order_funding.amount + excluded.amount`, [orderId, p.deposit_tx_id, take]);
    left = r2(left - take); funded = r2(funded + take);
  }
  // collusion check: the partner's own publisher account fulfilling a referred order
  const parties = await orderParties(orderId, k);
  if (parties && ref.partner_user_id && Number(parties.publisher_id) === Number(ref.partner_user_id)) {
    await flag(k, { partner_id: ref.partner_id, user_id: advertiserId, order_id: orderId, kind: 'collusion', detail: `order ${orderId}: publisher is the partner's own account` });
  }
  return { funded, earningsPart: left };
}

/** Order cancelled / rejected before completion: the money went back to the wallet, so it goes back to the pool. */
async function onOrderUnfunded(orderId, trx) {
  await ensure();
  const k = knexOf(trx);
  const hasCommission = await one(k, `select 1 from affiliate_ledger where order_id = ? and kind = 'commission' limit 1`, [orderId]);
  if (hasCommission) return; // completed earlier: handled by reversals, not give-back
  const f = await rows(k, `select id, deposit_tx_id, amount from affiliate_order_funding where order_id = ?`, [orderId]);
  for (const row of f) {
    await k.raw(`update affiliate_deposit_pool set remaining = least(amount, remaining + ?) where deposit_tx_id = ?`, [row.amount, row.deposit_tx_id]);
    await k.raw('delete from affiliate_order_funding where id = ?', [row.id]);
  }
}

/**
 * Order completed: one commission row per funding row. `baseRatio` < 1 for a
 * dispute split (publisher keeps only part); the rest returns to the pool.
 */
async function onOrderCompleted(orderId, trx, { baseRatio = 1 } = {}) {
  await ensure();
  const k = knexOf(trx);
  const parties = await orderParties(orderId, k);
  if (!parties) return { rows: 0 };
  const ref = await one(k, `select r.*, p.rate_bps, p.hold_days, p.status as partner_status, p.user_id as partner_user_id from affiliate_referrals r join affiliate_partners p on p.id = r.partner_id where r.user_id = ?`, [parties.advertiser_id]);
  if (!ref) return { rows: 0 };
  const funding = await rows(k, `select deposit_tx_id, amount from affiliate_order_funding where order_id = ?`, [orderId]);
  if (!funding.length) return { rows: 0 };
  // commission only if the referral was live when the order was placed
  const eligible = ref.status === 'active' && new Date(ref.expires_at).getTime() >= new Date(parties.created_at).getTime();
  const collusion = await one(k, `select 1 from affiliate_flags where order_id = ? and kind = 'collusion' and status = 'open'`, [orderId]);
  let n = 0;
  for (const f of funding) {
    const base = r2(f.amount * baseRatio);
    if (baseRatio < 1) await k.raw(`update affiliate_deposit_pool set remaining = least(amount, remaining + ?) where deposit_tx_id = ?`, [r2(f.amount - base), f.deposit_tx_id]);
    if (!eligible || base <= 0) continue;
    const disputed = await one(k, `select 1 from payment_disputes where deposit_tx_id = ? and status in ('open', 'under_review', 'needs_response', 'warning_needs_response', 'action_required')`, [f.deposit_tx_id]);
    const status = (ref.partner_status !== 'active' || collusion || disputed) ? 'frozen' : 'pending';
    const reason = collusion ? 'collusion check' : disputed ? 'deposit under dispute' : ref.partner_status !== 'active' ? `partner ${ref.partner_status}` : null;
    const r = await one(k, `insert into affiliate_ledger (partner_id, user_id, order_id, deposit_tx_id, kind, amount, base_amount, rate_bps, status, hold_until, event_source, event_id, reason)
        values (?, ?, ?, ?, 'commission', ?, ?, ?, ?, now() + (? || ' days')::interval, 'order', ?, ?) on conflict do nothing returning id`,
      [ref.partner_id, parties.advertiser_id, orderId, f.deposit_tx_id, r2(base * ref.rate_bps / 10000), base, ref.rate_bps, status, String(ref.hold_days || 30), `commission:${orderId}:${f.deposit_tx_id}`, reason]);
    if (r) n += 1;
  }
  return { rows: n };
}

// ---- refunds, disputes, reversals ------------------------------------------

/**
 * Part of a deposit left the platform (gateway refund or lost chargeback).
 * Unspent part: pool shrinks. Spent part: reverse commission on the orders it funded.
 */
async function applyDepositReduction(depositTxId, amount, kind, eventSource, eventId, trx) {
  await ensure();
  const k = knexOf(trx);
  const pool = await one(k, `select * from affiliate_deposit_pool where deposit_tx_id = ? for update`, [depositTxId]);
  if (!pool) return null;
  let left = r2(Math.min(amount, pool.amount));
  const fromRemaining = r2(Math.min(left, pool.remaining));
  if (fromRemaining > 0) { await k.raw('update affiliate_deposit_pool set remaining = remaining - ? where id = ?', [fromRemaining, pool.id]); left = r2(left - fromRemaining); }
  await k.raw(`update affiliate_deposit_pool set status = ? where id = ?`, [r2(amount) >= r2(pool.amount) ? 'reversed' : 'partial', pool.id]);
  await k.raw(`insert into affiliate_pool_debits (user_id, tx_id, kind, amount) values (?, ?, ?, ?) on conflict (tx_id) do nothing`, [pool.user_id, -Math.abs(Date.now() % 2000000000), kind, r2(amount)]).catch(() => {});
  if (left <= 0) return { reversed: 0 };
  // spent part: reverse commission proportionally, newest funding first
  const funding = await rows(k, `select f.order_id, f.amount, l.id as ledger_id, l.partner_id, l.amount as commission, l.base_amount, l.rate_bps, l.status
      from affiliate_order_funding f join affiliate_ledger l on l.order_id = f.order_id and l.deposit_tx_id = f.deposit_tx_id and l.kind = 'commission'
      where f.deposit_tx_id = ? order by f.id desc`, [depositTxId]);
  let reversed = 0;
  for (const f of funding) {
    if (left <= 0) break;
    const part = r2(Math.min(left, f.base_amount));
    const already = (await one(k, `select coalesce(sum(-amount),0) s from affiliate_ledger where order_id = ? and deposit_tx_id = ? and kind = 'reversal'`, [f.order_id, depositTxId])).s;
    const maxRev = r2(f.commission - Number(already));
    const rev = r2(Math.min(maxRev, part * f.rate_bps / 10000));
    if (rev > 0) {
      const r = await one(k, `insert into affiliate_ledger (partner_id, user_id, order_id, deposit_tx_id, kind, amount, base_amount, rate_bps, status, event_source, event_id, reason)
          values (?, ?, ?, ?, 'reversal', ?, ?, ?, 'reversed', ?, ?, ?) on conflict do nothing returning id`,
        [f.partner_id, pool.user_id, f.order_id, depositTxId, -rev, part, f.rate_bps, eventSource, `${eventId}:${f.order_id}`, `${kind}: $${part.toFixed(2)} of the funding deposit left the platform`]);
      if (r) { reversed = r2(reversed + rev); if (rev >= maxRev) await k.raw(`update affiliate_ledger set status = 'reversed' where id = ? and status in ('pending', 'payable', 'frozen')`, [f.ledger_id]); }
    }
    left = r2(left - part);
  }
  return { reversed };
}

async function onDepositRefunded(depositTxId, amount, gateway) {
  return applyDepositReduction(depositTxId, amount, 'refund', `refund:${gateway}`, `${depositTxId}:${Date.now()}`);
}

async function onDisputeOpened(d) {
  await ensure();
  const k = knexOf();
  if (!d.deposit_tx_id) return;
  await k.raw(`update affiliate_ledger set status = 'frozen', reason = coalesce(reason, '') || case when reason is null or reason = '' then '' else '; ' end || ('frozen:' || status || ':dispute ' || ?) where deposit_tx_id = ? and kind = 'commission' and status in ('pending', 'payable')`, [String(d.gateway_dispute_id), d.deposit_tx_id]);
  await k.raw(`update affiliate_deposit_pool set status = 'disputed' where deposit_tx_id = ? and status in ('ok', 'partial')`, [d.deposit_tx_id]);
}

async function onDisputeWon(d) {
  await ensure();
  const k = knexOf();
  if (!d.deposit_tx_id) return;
  // unfreeze: back to pending or payable depending on the hold
  await k.raw(`update affiliate_ledger set status = case when hold_until <= now() then 'payable' else 'pending' end, reason = nullif(regexp_replace(coalesce(reason,''), ';{0,1} {0,1}frozen:[^;]*', ''), '')
      where deposit_tx_id = ? and kind = 'commission' and status = 'frozen' and payout_id is null`, [d.deposit_tx_id]);
  await k.raw(`update affiliate_deposit_pool set status = case when remaining < amount and remaining > 0 then 'partial' else 'ok' end where deposit_tx_id = ? and status = 'disputed'`, [d.deposit_tx_id]);
}

async function onDisputeLost(d) {
  if (!d.deposit_tx_id) return;
  return applyDepositReduction(d.deposit_tx_id, d.amount, 'chargeback', 'dispute', `${d.gateway}:${d.gateway_dispute_id}`);
}

// ---- jobs -------------------------------------------------------------------

async function releaseHolds() {
  await ensure();
  const k = knexOf();
  const r = await k.raw(`update affiliate_ledger l set status = 'payable' where l.kind = 'commission' and l.status = 'pending' and l.hold_until <= now()
      and not exists (select 1 from payment_disputes d where d.deposit_tx_id = l.deposit_tx_id and d.status not in ('won', 'lost', 'closed'))`);
  const expired = await k.raw(`update affiliate_referrals set status = 'expired' where status = 'active' and expires_at < now()`);
  return { released: r.rowCount, expired: expired.rowCount };
}

/** Nightly: backfill anything a hook missed and check the invariants. */
async function reconcile() {
  await ensure();
  const k = knexOf();
  const out = { backfilledFunding: 0, backfilledCommission: 0, poolFixed: 0, flags: 0 };
  const referred = await rows(k, `select user_id from affiliate_referrals where status in ('active', 'expired')`);
  for (const { user_id } of referred) {
    await syncPool(user_id, k);
    // orders by this buyer with main spend but no funding rows (hook failed or order predates the program)
    const missing = await rows(k, `select o.id, (o.metadata->'spendingBreakdown'->>'mainSpent')::numeric main_spent, o.order_status, o.created_at from orders o join orders_advertiser_lnk a on a.order_id = o.id
        where a.user_id = ? and o.order_status not in ('cancelled', 'rejected') and coalesce((o.metadata->'spendingBreakdown'->>'mainSpent')::numeric, 0) > 0
          and not exists (select 1 from affiliate_order_funding f where f.order_id = o.id) and o.created_at >= (select created_at from affiliate_referrals where user_id = ?) order by o.id`, [user_id, user_id]);
    for (const o of missing) {
      const r = await onOrderFunded(o.id, user_id, o.main_spent, k); if (r.funded > 0) out.backfilledFunding += 1;
      if (o.order_status === 'completed') { const c = await onOrderCompleted(o.id, k); out.backfilledCommission += c.rows; }
    }
    // completed orders with funding but no commission
    const noComm = await rows(k, `select distinct f.order_id from affiliate_order_funding f join orders o on o.id = f.order_id where o.order_status = 'completed'
        and not exists (select 1 from affiliate_ledger l where l.order_id = f.order_id and l.kind = 'commission') and exists (select 1 from orders_advertiser_lnk a where a.order_id = o.id and a.user_id = ?)`, [user_id]);
    for (const { order_id } of noComm) { const c = await onOrderCompleted(order_id, k); out.backfilledCommission += c.rows; }
    // pool invariant: remaining = amount - funding(non-cancelled) - debits applied, never negative
    const bad = await rows(k, `select p.id, p.amount, p.remaining, coalesce((select sum(f.amount) from affiliate_order_funding f join orders o on o.id = f.order_id where f.deposit_tx_id = p.deposit_tx_id and o.order_status not in ('cancelled','rejected')),0) funded
        from affiliate_deposit_pool p where p.user_id = ?`, [user_id]);
    for (const p of bad) { if (r2(p.remaining) < 0 || r2(p.remaining) > r2(p.amount - p.funded)) { await k.raw('update affiliate_deposit_pool set remaining = ? where id = ?', [Math.max(0, r2(p.amount - p.funded)), p.id]); out.poolFixed += 1; } }
  }
  // ledger invariants
  const dup = await rows(k, `select order_id, deposit_tx_id, count(*) from affiliate_ledger where kind = 'commission' group by 1,2 having count(*) > 1`);
  for (const d of dup) { await flag(k, { order_id: d.order_id, kind: 'invariant', detail: `duplicate commission rows for order ${d.order_id}` }); out.flags += 1; }
  const over = await rows(k, `select l.user_id, sum(l.amount) commission, (select coalesce(sum(amount),0) from affiliate_deposit_pool p where p.user_id = l.user_id) deposits, max(l.rate_bps) rate
      from affiliate_ledger l where l.kind in ('commission','reversal') group by l.user_id having sum(l.amount) > (select coalesce(sum(amount),0) from affiliate_deposit_pool p where p.user_id = l.user_id) * max(l.rate_bps) / 10000.0 + 0.01`);
  for (const o of over) { await flag(k, { user_id: o.user_id, kind: 'invariant', detail: `commission $${r2(o.commission)} exceeds ${o.rate / 100}% of deposits $${r2(o.deposits)}` }); out.flags += 1; }
  return out;
}

// ---- payouts ----------------------------------------------------------------

async function partnerBalance(partnerId, k = knexOf()) {
  const b = await one(k, `select
      coalesce(sum(amount) filter (where kind = 'commission' and status = 'pending'), 0) pending,
      coalesce(sum(amount) filter (where kind = 'commission' and status = 'frozen'), 0) frozen,
      coalesce(sum(amount) filter (where kind = 'commission' and status = 'payable' and payout_id is null), 0) payable,
      coalesce(sum(amount) filter (where kind in ('reversal', 'adjustment') and payout_id is null), 0) adjustments,
      coalesce(sum(amount) filter (where kind in ('commission', 'reversal', 'adjustment') and status = 'paid'), 0) paid_gross,
      coalesce(sum(amount) filter (where kind in ('payout', 'payout_fee', 'tax_withheld')), 0) paid_out
      from affiliate_ledger where partner_id = ?`, [partnerId]);
  const o = {}; for (const [kk, v] of Object.entries(b)) o[kk] = r2(v);
  o.available = r2(o.payable + o.adjustments); // may be negative: carried forward
  return o;
}

/** Monthly: one draft payout per partner with enough available balance. Returns the drafts. */
async function payoutRun(period = new Date().toISOString().slice(0, 7), k0) {
  await ensure();
  const k = knexOf(k0);
  const partners = await rows(k, `select * from affiliate_partners where status = 'active'`);
  const drafts = [];
  for (const p of partners) {
    if (await one(k, `select id from affiliate_payouts where partner_id = ? and period = ?`, [p.id, period])) continue;
    const bal = await partnerBalance(p.id, k);
    if (bal.available < Number(p.min_payout || 50)) continue;
    const tp = jsonOf(p.tax_profile) || {};
    const tax = Number(tp.withholding_bps) || 0;
    const taxOk = tp.complete === true;
    if (!taxOk) { await flag(k, { partner_id: p.id, kind: 'payout_blocked', detail: `payout of $${bal.available} skipped: tax profile incomplete` }); continue; }
    let gross = bal.available, fee = 0, taxAmt = 0, net = gross, method = p.payout_method || 'cash';
    if (method === 'wallet_credit' && p.user_id) { net = r2(gross * Number(p.wallet_credit_multiplier || 1.25)); }
    else { method = 'cash'; fee = r2(gross * PAYOUT_FEE_BPS() / 10000); taxAmt = r2(gross * tax / 10000); net = r2(gross - fee - taxAmt); }
    const d = await one(k, `insert into affiliate_payouts (partner_id, period, gross, fee, tax, net, method, status) values (?, ?, ?, ?, ?, ?, ?, 'draft') returning *`, [p.id, period, gross, fee, taxAmt, net, method]);
    await k.raw(`update affiliate_ledger set payout_id = ? where partner_id = ? and payout_id is null and ((kind = 'commission' and status = 'payable') or kind in ('reversal', 'adjustment'))`, [d.id, p.id]);
    drafts.push(d);
  }
  return drafts;
}

/** Admin marked the payout as paid (or applied the wallet credit). Writes the closing ledger rows. */
async function markPaid(payoutId, adminId, reference, k0) {
  await ensure();
  const k = knexOf(k0);
  const d = await one(k, `select * from affiliate_payouts where id = ? for update`, [payoutId]);
  if (!d) throw new Error('Payout not found');
  if (d.status === 'paid') return d;
  const p = await one(k, `select * from affiliate_partners where id = ?`, [d.partner_id]);
  const ev = (kind) => [`payout:${d.id}`, `${kind}:${d.id}`];
  if (d.method === 'wallet_credit') {
    const wallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({ where: { users_permissions_user: p.user_id } });
    if (!wallet) throw new Error('Partner has no wallet for the credit');
    await strapi.db.query('api::user-wallet.user-wallet').update({ where: { id: wallet.id }, data: { promoBalance: r2(Number(wallet.promoBalance) + Number(d.net)), balance: r2(Number(wallet.balance) + Number(d.net)) } });
    await strapi.entityService.create('api::transaction.transaction', { data: { type: 'promo', amount: d.net, netAmount: d.net, fee: 0, transactionStatus: 'success', gateway: 'system', gatewayTransactionId: `affiliate_credit_${d.id}`, fund_source: 'promo_fund', description: `Affiliate commission ${d.period} as wallet credit ($${r2(d.gross)} × ${p.wallet_credit_multiplier})`, user_wallet: wallet.id, users_permissions_user: p.user_id, metadata: { affiliatePayoutId: d.id }, publishedAt: new Date() } });
  }
  await k.raw(`insert into affiliate_ledger (partner_id, kind, amount, status, event_source, event_id, reason, created_by, payout_id) values (?, 'payout', ?, 'paid', ?, ?, ?, ?, ?) on conflict do nothing`, [d.partner_id, -r2(d.gross), ...ev('payout'), `${d.method} payout ${d.period}${reference ? ' · ' + reference : ''}`, adminId || null, d.id]);
  if (Number(d.fee) > 0) await k.raw(`insert into affiliate_ledger (partner_id, kind, amount, status, event_source, event_id, reason, created_by, payout_id) values (?, 'payout_fee', 0, 'paid', ?, ?, ?, ?, ?) on conflict do nothing`, [d.partner_id, ...ev('fee'), `gateway fee ${PAYOUT_FEE_BPS() / 100}% = $${r2(d.fee)} deducted from the payout`, adminId || null, d.id]);
  if (Number(d.tax) > 0) await k.raw(`insert into affiliate_ledger (partner_id, kind, amount, status, event_source, event_id, reason, created_by, payout_id) values (?, 'tax_withheld', 0, 'paid', ?, ?, ?, ?, ?) on conflict do nothing`, [d.partner_id, ...ev('tax'), `tax withheld $${r2(d.tax)} (${(((jsonOf(p.tax_profile) || {}).withholding_bps) || 0) / 100}%)`, adminId || null, d.id]);
  await k.raw(`update affiliate_ledger set status = 'paid' where payout_id = ? and kind in ('commission', 'reversal', 'adjustment')`, [d.id]);
  return one(k, `update affiliate_payouts set status = 'paid', paid_by = ?, paid_at = now(), reference = coalesce(?, reference) where id = ? returning *`, [adminId || null, reference || null, d.id]);
}

module.exports = {
  jsonOf, ensure, slug, partnerByCode, recordClick, clickStats, clickSeries, resolveReferral, activeReferral, syncPool,
  onOrderFunded, onOrderUnfunded, onOrderCompleted, onDepositRefunded, onDisputeOpened, onDisputeWon, onDisputeLost,
  releaseHolds, reconcile, partnerBalance, payoutRun, markPaid, applyDepositReduction, flag, knexOf, r2,
};
