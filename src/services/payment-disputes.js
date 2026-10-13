'use strict';

/**
 * Payment disputes / chargebacks (2026-10-14).
 *
 * Until now a buyer who charged back a deposit kept the wallet balance. Now:
 *   - dispute opened  → the disputed amount is taken from the wallet (main,
 *     then promo). What the wallet cannot cover is recorded as `shortfall`;
 *     the user cannot place orders or withdraw while any shortfall is owed,
 *     and the next time they try, the shortfall is recovered from whatever
 *     balance they have by then. The owner is emailed.
 *   - dispute won     → everything taken is given back.
 *   - dispute lost    → nothing more happens to the wallet; the money is gone.
 *   - a "won" dispute can come back (pre-arbitration) → it is debited again.
 * Wallet balances can never go negative (DB CHECK constraints), hence the
 * shortfall design. Every change is a `transactions` row (type 'refund',
 * gateway = the processor, metadata.chargeback = true) so wallet history and
 * the admin ledger stay complete.
 *
 * The affiliate service (if present) is told about every state change so it
 * can freeze / reverse commission on orders funded by the disputed deposit.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ALERT_TO = () => (process.env.DISPUTE_ALERT_TO || process.env.USER_DELETE_ALERT_TO || 'vinayak@wordscloud.in').split(',').map((s) => s.trim()).filter(Boolean);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let ready = null;
function ensure() {
  if (!ready) {
    ready = strapi.db.connection.raw(`create table if not exists payment_disputes (
        id serial primary key, gateway text not null, gateway_dispute_id text not null,
        deposit_tx_id int, user_id int, wallet_id int,
        amount numeric(12,2) not null default 0, currency text, reason text, phase text,
        status text not null default 'open',
        debited_main numeric(12,2) not null default 0, debited_promo numeric(12,2) not null default 0,
        shortfall numeric(12,2) not null default 0, recovered numeric(12,2) not null default 0,
        opened_at timestamptz not null default now(), closed_at timestamptz, raw jsonb, notes text,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        unique (gateway, gateway_dispute_id))`)
      .then(() => strapi.db.connection.raw(`create index if not exists idx_payment_disputes_user on payment_disputes (user_id) where shortfall > 0`))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function affiliate() {
  try { return require('./affiliate'); } catch { return null; }
}

/** Find the deposit transaction a gateway object refers to, with user and wallet ids. */
async function findDepositTx({ gatewayTransactionIds = [], externalIds = [] }) {
  const knex = strapi.db.connection;
  const g = gatewayTransactionIds.filter(Boolean); const e = externalIds.filter(Boolean);
  if (!g.length && !e.length) return null;
  const conds = []; const binds = [];
  if (g.length) { conds.push(`t.gateway_transaction_id in (${g.map(() => '?').join(',')})`); binds.push(...g); }
  if (e.length) { conds.push(`t.external_transaction_id in (${e.map(() => '?').join(',')})`); binds.push(...e); }
  const r = await knex.raw(`select t.id, t.type, t.amount, t.gateway, t.transaction_status, ul.user_id, wl.user_wallet_id as wallet_id
      from transactions t
      left join transactions_users_permissions_user_lnk ul on ul.transaction_id = t.id
      left join transactions_user_wallet_lnk wl on wl.transaction_id = t.id
      where t.type = 'deposit' and (${conds.join(' or ')}) order by t.id desc limit 1`, binds);
  return r.rows[0] || null;
}

async function walletFor(userId, walletId) {
  const where = walletId ? { id: walletId } : { users_permissions_user: userId };
  return strapi.db.query('api::user-wallet.user-wallet').findOne({ where });
}

async function txRow({ type, amount, gateway, ref, description, walletId, userId, metadata }) {
  return strapi.entityService.create('api::transaction.transaction', {
    data: {
      type, amount: r2(amount), netAmount: r2(amount), fee: 0, transactionStatus: 'success', gateway,
      gatewayTransactionId: ref, description, fund_source: 'main_fund',
      user_wallet: walletId || null, users_permissions_user: userId || null,
      metadata: { chargeback: true, ...metadata }, publishedAt: new Date(),
    },
  });
}

/** Take up to `amount` from the wallet (main first, then promo). Returns what was taken. */
async function debitWallet(wallet, amount) {
  const main = r2(wallet.mainBalance); const promo = r2(wallet.promoBalance);
  const fromMain = r2(Math.min(main, amount));
  const fromPromo = r2(Math.min(promo, r2(amount - fromMain)));
  if (fromMain + fromPromo > 0) {
    await strapi.db.query('api::user-wallet.user-wallet').update({
      where: { id: wallet.id },
      data: { mainBalance: r2(main - fromMain), promoBalance: r2(promo - fromPromo), balance: r2(main - fromMain + promo - fromPromo) },
    });
  }
  return { fromMain, fromPromo, shortfall: r2(amount - fromMain - fromPromo) };
}

async function creditWallet(wallet, main, promo) {
  await strapi.db.query('api::user-wallet.user-wallet').update({
    where: { id: wallet.id },
    data: { mainBalance: r2(r2(wallet.mainBalance) + main), promoBalance: r2(r2(wallet.promoBalance) + promo), balance: r2(r2(wallet.balance) + main + promo) },
  });
}

async function emit(userId, reason, meta) {
  try { if (userId) await strapi.service('api::user-wallet.user-wallet').emitBalanceUpdate(userId, reason, meta); } catch { /* best effort */ }
}

async function alert(d, kind) {
  try {
    const u = d.user_id ? await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: d.user_id }, select: ['id', 'email', 'username'] }) : null;
    const title = { opened: 'Chargeback opened', updated: 'Chargeback updated', won: 'Chargeback won', lost: 'Chargeback LOST', reopened: 'Chargeback re-opened', warning: 'Early fraud warning' }[kind] || `Chargeback ${kind}`;
    const html = `<p><b>${esc(title)}</b> on ${esc(d.gateway)} dispute <code>${esc(d.gateway_dispute_id)}</code>.</p>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Buyer</td><td>${u ? `#${u.id} · ${esc(u.username)} · ${esc(u.email)}` : 'unknown (deposit not matched)'}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Amount</td><td>$${r2(d.amount).toFixed(2)} ${d.currency && d.currency !== 'USD' ? `(gateway currency ${esc(d.currency)})` : ''}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Reason</td><td>${esc(d.reason || '-')} ${d.phase ? '· ' + esc(d.phase) : ''}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Status</td><td>${esc(d.status)}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Taken from wallet</td><td>$${r2(d.debited_main).toFixed(2)} main + $${r2(d.debited_promo).toFixed(2)} promo; still owed $${r2(d.shortfall).toFixed(2)}</td></tr>
        <tr><td style="padding:3px 10px 3px 0;color:#64748b">Deposit</td><td>${d.deposit_tx_id ? `transaction #${d.deposit_tx_id}` : 'not matched'}</td></tr>
      </table>
      <p style="color:#64748b;font-size:12px">${kind === 'opened' || kind === 'reopened' ? 'Respond with evidence in the gateway dashboard. The buyer cannot order or withdraw while money is owed.' : ''} Admin: ${esc(process.env.ADMIN_PANEL_URL || 'https://prod-panel20.serpbays.com')}/users/${d.user_id || ''}</p>`;
    await strapi.service('api::admin-email.admin-email').sendAdminEmail({ to: ALERT_TO(), subject: `${title}: $${r2(d.amount).toFixed(2)} ${u ? u.email : d.gateway}`, bodyHtml: html, senderAdminId: null, contextType: d.user_id ? 'user' : 'none', contextIds: d.user_id ? [d.user_id] : [] });
  } catch (e) { strapi.log.error(`[disputes] alert failed: ${e.message}`); }
}

async function get(gateway, disputeId) {
  await ensure();
  return (await strapi.db.connection.raw('select * from payment_disputes where gateway = ? and gateway_dispute_id = ?', [gateway, String(disputeId)])).rows[0] || null;
}

/**
 * A dispute was created (or came back after a win). Debits the wallet once.
 * `lookup` = { gatewayTransactionIds, externalIds } to find the deposit.
 */
async function open({ gateway, disputeId, amount, currency, reason, phase, status, raw, lookup, kind = 'dispute' }) {
  await ensure();
  const knex = strapi.db.connection;
  const existing = await get(gateway, disputeId);
  if (existing && !['won', 'closed'].includes(existing.status)) {
    // Already open: just refresh status / phase.
    await knex.raw('update payment_disputes set status = coalesce(?, status), phase = coalesce(?, phase), reason = coalesce(?, reason), raw = coalesce(?::jsonb, raw), updated_at = now() where id = ?',
      [status || null, phase || null, reason || null, raw ? JSON.stringify(raw) : null, existing.id]);
    return { ...existing, status: status || existing.status, changed: false };
  }
  const tx = existing ? { id: existing.deposit_tx_id, user_id: existing.user_id, wallet_id: existing.wallet_id, amount: existing.amount } : await findDepositTx(lookup || {});
  let amt = r2(amount);
  if (tx && (!currency || currency.toUpperCase() !== 'USD')) amt = r2(tx.amount); // Razorpay disputes are in INR: use the deposit's USD amount
  if (tx && amt > r2(tx.amount)) amt = r2(tx.amount);
  const wallet = tx ? await walletFor(tx.user_id, tx.wallet_id) : null;
  let fromMain = 0, fromPromo = 0, shortfall = amt;
  if (wallet && amt > 0) {
    const d = await debitWallet(wallet, amt); fromMain = d.fromMain; fromPromo = d.fromPromo; shortfall = d.shortfall;
    await txRow({ type: 'refund', amount: fromMain + fromPromo, gateway, ref: `chargeback_${disputeId}${existing ? '_' + Date.now() : ''}`,
      description: `${existing ? 'Re-opened' : 'Payment'} dispute ${disputeId}: $${amt.toFixed(2)} disputed, $${(fromMain + fromPromo).toFixed(2)} taken from wallet${shortfall > 0 ? `, $${shortfall.toFixed(2)} still owed` : ''}`,
      walletId: wallet.id, userId: tx.user_id, metadata: { disputeId, depositTxId: tx.id, debitedMain: fromMain, debitedPromo: fromPromo, shortfall } });
    await emit(tx.user_id, 'chargeback', { disputeId, amount: amt });
  }
  let row;
  if (existing) {
    row = (await knex.raw(`update payment_disputes set status = ?, phase = ?, reason = coalesce(?, reason), raw = coalesce(?::jsonb, raw), closed_at = null, opened_at = now(),
        debited_main = ?, debited_promo = ?, shortfall = ?, recovered = 0, updated_at = now() where id = ? returning *`,
      [status || 'open', phase || null, reason || null, raw ? JSON.stringify(raw) : null, fromMain, fromPromo, shortfall, existing.id])).rows[0];
  } else {
    row = (await knex.raw(`insert into payment_disputes (gateway, gateway_dispute_id, deposit_tx_id, user_id, wallet_id, amount, currency, reason, phase, status, debited_main, debited_promo, shortfall, raw)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb) returning *`,
      [gateway, String(disputeId), tx ? tx.id : null, tx ? tx.user_id : null, wallet ? wallet.id : null, amt, currency || null, reason || null, phase || null, status || 'open', fromMain, fromPromo, shortfall, raw ? JSON.stringify(raw) : null])).rows[0];
  }
  strapi.log.warn(`[disputes] ${existing ? 're-opened' : 'opened'} ${gateway} ${disputeId}: $${amt} user=${tx ? tx.user_id : '?'} taken=${fromMain + fromPromo} owed=${shortfall}`);
  const aff = affiliate(); if (aff && row.deposit_tx_id) await aff.onDisputeOpened(row).catch((e) => strapi.log.error(`[disputes] affiliate onDisputeOpened: ${e.message}`));
  await alert(row, existing ? 'reopened' : (kind === 'warning' ? 'warning' : 'opened'));
  return { ...row, changed: true };
}

async function update({ gateway, disputeId, status, phase, reason, raw }) {
  await ensure();
  const existing = await get(gateway, disputeId);
  if (!existing) return null;
  if (['won', 'lost', 'closed'].includes(existing.status) && status && !['won', 'lost', 'closed'].includes(status)) {
    return open({ gateway, disputeId, amount: existing.amount, currency: existing.currency, reason, phase, status, raw });
  }
  return (await strapi.db.connection.raw('update payment_disputes set status = coalesce(?, status), phase = coalesce(?, phase), reason = coalesce(?, reason), raw = coalesce(?::jsonb, raw), updated_at = now() where id = ? returning *',
    [status || null, phase || null, reason || null, raw ? JSON.stringify(raw) : null, existing.id])).rows[0];
}

/** outcome: 'won' (we keep the money: give the wallet back) or 'lost'. */
async function resolve({ gateway, disputeId, outcome, raw }) {
  await ensure();
  const knex = strapi.db.connection;
  const d = await get(gateway, disputeId);
  if (!d) return null;
  if (d.status === outcome) return d;
  if (outcome === 'won') {
    const giveBack = r2(d.debited_main + d.recovered); const promoBack = r2(d.debited_promo);
    const wallet = d.wallet_id ? await walletFor(d.user_id, d.wallet_id) : null;
    if (wallet && giveBack + promoBack > 0) {
      await creditWallet(wallet, giveBack, promoBack);
      await txRow({ type: 'deposit', amount: giveBack + promoBack, gateway, ref: `chargeback_won_${disputeId}_${Date.now()}`,
        description: `Dispute ${disputeId} won: $${(giveBack + promoBack).toFixed(2)} returned to wallet`, walletId: wallet.id, userId: d.user_id, metadata: { disputeId, restoredMain: giveBack, restoredPromo: promoBack } });
      await emit(d.user_id, 'chargeback_won', { disputeId });
    }
  }
  const row = (await knex.raw(`update payment_disputes set status = ?, closed_at = now(), shortfall = case when ? = 'won' then 0 else shortfall end, raw = coalesce(?::jsonb, raw), updated_at = now() where id = ? returning *`,
    [outcome, outcome, raw ? JSON.stringify(raw) : null, d.id])).rows[0];
  strapi.log.warn(`[disputes] ${gateway} ${disputeId} ${outcome}`);
  const aff = affiliate(); if (aff && row.deposit_tx_id) await (outcome === 'won' ? aff.onDisputeWon(row) : aff.onDisputeLost(row)).catch((e) => strapi.log.error(`[disputes] affiliate on ${outcome}: ${e.message}`));
  await alert(row, outcome);
  return row;
}

/** Total still owed by a user across disputes, after trying to recover it from the current balance. */
async function enforceForUser(userId) {
  await ensure();
  const knex = strapi.db.connection;
  const owed = (await knex.raw(`select * from payment_disputes where user_id = ? and shortfall > 0 order by id`, [userId])).rows;
  if (!owed.length) return 0;
  const wallet = await walletFor(userId, null);
  let total = 0;
  for (const d of owed) {
    if (wallet && (r2(wallet.mainBalance) + r2(wallet.promoBalance)) > 0) {
      const fresh = await walletFor(userId, wallet.id);
      const got = await debitWallet(fresh, r2(d.shortfall));
      const taken = r2(got.fromMain + got.fromPromo);
      if (taken > 0) {
        await txRow({ type: 'refund', amount: taken, gateway: d.gateway, ref: `chargeback_recover_${d.gateway_dispute_id}_${Date.now()}`,
          description: `Dispute ${d.gateway_dispute_id}: $${taken.toFixed(2)} recovered from wallet towards $${r2(d.shortfall).toFixed(2)} owed`, walletId: fresh.id, userId, metadata: { disputeId: d.gateway_dispute_id, recovered: taken } });
        await knex.raw('update payment_disputes set recovered = recovered + ?, shortfall = shortfall - ?, updated_at = now() where id = ?', [taken, taken, d.id]);
        d.shortfall = r2(d.shortfall - taken);
        await emit(userId, 'chargeback_recovery', { disputeId: d.gateway_dispute_id, taken });
      }
    }
    total += r2(d.shortfall);
  }
  return r2(total);
}

const BLOCK_MESSAGE = 'Your account has an unresolved payment dispute (chargeback). Please contact support before placing orders or withdrawing.';

// ---- Gateway adapters -------------------------------------------------------

async function stripe(event) {
  const o = event.data && event.data.object;
  if (!o) return;
  if (event.type === 'radar.early_fraud_warning.created') {
    // Warning only: no wallet change, but tell the owner and freeze commission.
    const tx = await findDepositTx({ gatewayTransactionIds: [o.payment_intent, o.charge] });
    const row = { gateway: 'stripe', gateway_dispute_id: `efw_${o.id}`, amount: tx ? tx.amount : 0, currency: 'USD', reason: o.fraud_type, status: 'warning', user_id: tx && tx.user_id, deposit_tx_id: tx && tx.id, debited_main: 0, debited_promo: 0, shortfall: 0 };
    await alert(row, 'warning');
    const aff = affiliate(); if (aff && tx) await aff.onDisputeOpened({ ...row, id: null }).catch(() => {});
    return;
  }
  if (!String(event.type).startsWith('charge.dispute.')) return;
  const base = { gateway: 'stripe', disputeId: o.id, amount: (o.amount || 0) / 100, currency: (o.currency || 'usd').toUpperCase(), reason: o.reason, status: o.status, raw: { type: event.type, status: o.status, reason: o.reason, amount: o.amount, payment_intent: o.payment_intent, charge: o.charge } };
  const lookup = { gatewayTransactionIds: [o.payment_intent, o.charge] };
  switch (event.type) {
    case 'charge.dispute.created': return open({ ...base, lookup });
    case 'charge.dispute.updated': return update(base);
    case 'charge.dispute.funds_withdrawn': return (await get('stripe', o.id)) ? update(base) : open({ ...base, lookup });
    case 'charge.dispute.funds_reinstated': return resolve({ gateway: 'stripe', disputeId: o.id, outcome: 'won', raw: base.raw });
    case 'charge.dispute.closed': {
      if (o.status === 'lost') return resolve({ gateway: 'stripe', disputeId: o.id, outcome: 'lost', raw: base.raw });
      if (o.status === 'won' || o.status === 'warning_closed') return (await get('stripe', o.id)) ? resolve({ gateway: 'stripe', disputeId: o.id, outcome: 'won', raw: base.raw }) : null;
      return update(base);
    }
    default: return null;
  }
}

async function paypalToken() {
  const env = (process.env.PAYPAL_ENVIRONMENT || 'live').toLowerCase();
  const base = env === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  const j = await r.json(); return { base, token: j.access_token };
}

async function paypal(body) {
  const type = body.event_type; const res = body.resource || {};
  if (type === 'PAYMENT.CAPTURE.REVERSED') {
    // PayPal reversed a capture (chargeback / reversal): treat as a lost dispute on that capture.
    const amount = Number(res.amount && res.amount.value) || 0;
    const row = await open({ gateway: 'paypal', disputeId: `reversed_${res.id}`, amount, currency: res.amount && res.amount.currency_code, reason: 'capture_reversed', status: 'open', raw: { type, id: res.id }, lookup: { gatewayTransactionIds: [res.id] } });
    return resolve({ gateway: 'paypal', disputeId: `reversed_${res.id}`, outcome: 'lost', raw: { type, id: res.id, finalized: !!row } });
  }
  if (!String(type).startsWith('CUSTOMER.DISPUTE.')) return;
  const disputeId = res.dispute_id || res.id;
  const txs = Array.isArray(res.disputed_transactions) ? res.disputed_transactions : [];
  const captureIds = txs.map((t) => t.seller_transaction_id).filter(Boolean);
  const amount = Number(res.dispute_amount && res.dispute_amount.value) || 0;
  const base = { gateway: 'paypal', disputeId, amount, currency: res.dispute_amount && res.dispute_amount.currency_code, reason: res.reason, status: res.status, raw: { type, status: res.status, reason: res.reason, outcome: res.dispute_outcome } };
  if (type === 'CUSTOMER.DISPUTE.CREATED') return open({ ...base, lookup: { gatewayTransactionIds: captureIds } });
  if (type === 'CUSTOMER.DISPUTE.UPDATED') return (await get('paypal', disputeId)) ? update(base) : open({ ...base, lookup: { gatewayTransactionIds: captureIds } });
  if (type === 'CUSTOMER.DISPUTE.RESOLVED') {
    let outcome = res.dispute_outcome && res.dispute_outcome.outcome_code;
    if (!outcome) {
      try { const { base: b, token } = await paypalToken(); const r = await fetch(`${b}/v1/customer/disputes/${disputeId}`, { headers: { Authorization: `Bearer ${token}` } }); const j = await r.json(); outcome = j.dispute_outcome && j.dispute_outcome.outcome_code; base.raw.fetched = outcome; } catch (e) { strapi.log.error(`[disputes] paypal outcome fetch failed: ${e.message}`); }
    }
    const won = ['RESOLVED_SELLER_FAVOUR', 'CANCELED_BY_BUYER', 'RESOLVED_WITH_PAYOUT'].includes(String(outcome || '').toUpperCase());
    const lost = ['RESOLVED_BUYER_FAVOUR'].includes(String(outcome || '').toUpperCase());
    if (!(await get('paypal', disputeId))) { if (lost) await open({ ...base, lookup: { gatewayTransactionIds: captureIds } }); else return null; }
    if (won) return resolve({ gateway: 'paypal', disputeId, outcome: 'won', raw: base.raw });
    if (lost) return resolve({ gateway: 'paypal', disputeId, outcome: 'lost', raw: base.raw });
    // Unknown outcome: keep it open and tell the owner.
    const row = await update({ ...base, status: 'closed_unknown' }); if (row) await alert(row, 'updated'); return row;
  }
  return null;
}

async function razorpay(body) {
  const ev = body.event || '';
  if (!ev.startsWith('payment.dispute.')) return;
  const d = body.payload && body.payload.dispute && body.payload.dispute.entity;
  if (!d) return;
  const base = { gateway: 'razorpay', disputeId: d.id, amount: (d.amount || 0) / 100, currency: d.currency || 'INR', reason: d.reason_code || d.reason_description, phase: d.phase, status: d.status, raw: { event: ev, status: d.status, phase: d.phase, payment_id: d.payment_id, amount: d.amount } };
  const lookup = { externalIds: [d.payment_id], gatewayTransactionIds: [d.payment_id] };
  switch (ev) {
    case 'payment.dispute.created': return open({ ...base, lookup });
    case 'payment.dispute.under_review':
    case 'payment.dispute.action_required': return (await get('razorpay', d.id)) ? update(base) : open({ ...base, lookup });
    case 'payment.dispute.won': return (await get('razorpay', d.id)) ? resolve({ gateway: 'razorpay', disputeId: d.id, outcome: 'won', raw: base.raw }) : null;
    case 'payment.dispute.lost': { if (!(await get('razorpay', d.id))) await open({ ...base, lookup }); return resolve({ gateway: 'razorpay', disputeId: d.id, outcome: 'lost', raw: base.raw }); }
    case 'payment.dispute.closed': {
      const st = String(d.status || '').toLowerCase();
      if (st === 'won') return (await get('razorpay', d.id)) ? resolve({ gateway: 'razorpay', disputeId: d.id, outcome: 'won', raw: base.raw }) : null;
      if (st === 'lost') { if (!(await get('razorpay', d.id))) await open({ ...base, lookup }); return resolve({ gateway: 'razorpay', disputeId: d.id, outcome: 'lost', raw: base.raw }); }
      return update(base);
    }
    default: return null;
  }
}

module.exports = { ensure, get, open, update, resolve, enforceForUser, findDepositTx, BLOCK_MESSAGE, stripe, paypal, razorpay };
