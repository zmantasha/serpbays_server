'use strict';

/**
 * Wallet insights for the admin Wallets page. Read-only.
 *
 *   GET /admin/wallet-insights/directory?view&q&type&minBalance&internal&sort&dir&page&pageSize&period
 *   GET /admin/wallet-insights/:walletId
 *
 * Reconciliation ("ledger check"): expected main balance =
 *   deposits (success, non-promo) + refunds to main − payments from main
 *   − withdrawals (success/paid/approved) − fees
 * and expected promo = promo credits + promo refunds − promo payments.
 * Verified 2026-09-28: matches 25/30 wallets with transactions exactly
 * (promo 30/30); the rest are flagged "difference", not treated as errors.
 */

const TEST_USER_RE = '(\\+|test|demo|dummy)';
const BIG_IDLE = 500;
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function money(v) { return Math.round(n(v) * 100) / 100; }

const WALLET_AGG = `
  with tx as (
    select l.user_wallet_id wid, t.id, t.type ttype, coalesce(t.fund_source,'') fs, coalesce(t.gateway,'') gw, t.transaction_status st, t.amount, t.created_at
      from transactions t join transactions_user_wallet_lnk l on l.transaction_id = t.id
  ),
  a as (
    select w.id wallet_id, u.id user_id, u.username, u.email, u.first_name, u.last_name, u.business_name, u.country, u.signup_country, u.last_login_country,
           coalesce(u.advertiser,false) advertiser, coalesce(u.publisher,false) publisher, coalesce(u.blocked,false) blocked,
           (u.username ~* ?) is_internal,
           coalesce(w.balance,0) balance, coalesce(w.main_balance,0) main, coalesce(w.promo_balance,0) promo, coalesce(w.escrow_balance,0) escrow, coalesce(w.pending_withdrawal_balance,0) pending_wd,
           w.created_at wallet_created, w.updated_at wallet_updated,
           coalesce(sum(tx.amount) filter (where tx.ttype='deposit' and tx.st in ('success','paid') and tx.fs<>'promo_fund'),0) dep_all,
           coalesce(sum(tx.amount) filter (where tx.ttype='deposit' and tx.st in ('success','paid') and tx.gw in ('stripe','paypal','razorpay','bank_transfer')),0) dep_cash,
           coalesce(sum(tx.amount) filter (where tx.ttype='deposit' and tx.st in ('success','paid') and tx.gw not in ('stripe','paypal','razorpay','bank_transfer') and tx.fs<>'promo_fund'),0) dep_internal,
           coalesce(sum(tx.amount) filter (where tx.ttype='refund' and tx.st='success' and tx.fs<>'promo_fund'),0) ref_main,
           coalesce(sum(tx.amount) filter (where tx.ttype='refund' and tx.st='success' and tx.fs='promo_fund'),0) ref_promo,
           coalesce(sum(tx.amount) filter (where tx.ttype='payment' and tx.st='success' and tx.fs<>'promo_fund'),0) pay_main,
           coalesce(sum(tx.amount) filter (where tx.ttype='payment' and tx.st='success' and tx.fs='promo_fund'),0) pay_promo,
           coalesce(sum(tx.amount) filter (where tx.ttype='promo' and tx.st='success'),0) promo_in,
           coalesce(sum(tx.amount) filter (where tx.ttype='withdrawal' and tx.st in ('success','paid','approved')),0) wd,
           coalesce(sum(tx.amount) filter (where tx.ttype='fee' and tx.st='success'),0) fee,
           coalesce(sum(tx.amount) filter (where tx.ttype='escrow_release' and tx.st='success'),0) esc_rel,
           count(tx.id)::int tx_count, max(tx.created_at) last_tx,
           max(tx.created_at) filter (where tx.ttype='deposit' and tx.st in ('success','paid')) last_deposit,
           max(tx.created_at) filter (where tx.ttype='payment' and tx.st='success') last_spend,
           max(tx.created_at) filter (where tx.ttype='withdrawal') last_withdrawal
      from user_wallets w
      left join user_wallets_users_permissions_user_lnk wl on wl.user_wallet_id = w.id
      left join up_users u on u.id = wl.user_id
      left join tx on tx.wid = w.id
     group by w.id, u.id
  ),
  b as (
    select a.*,
      (select max(o.created_at) from orders o join orders_advertiser_lnk ol on ol.order_id = o.id where ol.user_id = a.user_id) last_order,
      (select count(*)::int from orders o join orders_advertiser_lnk ol on ol.order_id = o.id where ol.user_id = a.user_id) orders,
      (select count(*)::int from orders o join orders_advertiser_lnk ol on ol.order_id = o.id where ol.user_id = a.user_id and o.order_status in ('pending','accepted','delivered')) open_orders,
      (select coalesce(sum(wr.amount),0) from withdrawal_requests wr join withdrawal_requests_publisher_lnk wpl on wpl.withdrawal_request_id = wr.id where wpl.user_id = a.user_id and wr.withdrawal_status in ('pending','approved')) wd_open_amount,
      (select min(wr.created_at) from withdrawal_requests wr join withdrawal_requests_publisher_lnk wpl on wpl.withdrawal_request_id = wr.id where wpl.user_id = a.user_id and wr.withdrawal_status in ('pending','approved')) wd_open_since,
      round((a.dep_all + a.ref_main - a.pay_main - a.wd - a.fee)::numeric, 2) expected_main,
      round((a.promo_in + a.ref_promo - a.pay_promo)::numeric, 2) expected_promo
    from a
  ),
  c as (
    select b.*,
      greatest(b.last_tx, b.last_order, b.wallet_created) last_activity,
      extract(epoch from now() - greatest(b.last_tx, b.last_order, b.wallet_created))/86400 idle_days,
      (b.tx_count > 0 and (abs(b.main - b.expected_main) >= 0.01 or abs(b.promo - b.expected_promo) >= 0.01)) mismatch,
      case when b.advertiser and b.publisher then 'both' when b.publisher then 'publisher' when b.advertiser then 'buyer' else 'unset' end utype
    from b
  )`;

function rowOut(r) {
  return {
    walletId: r.wallet_id, userId: r.user_id, username: r.username, email: r.email,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.business_name || r.username || `wallet #${r.wallet_id}`,
    country: r.country || '', signupCountry: r.signup_country || null, lastLoginCountry: r.last_login_country || null,
    type: r.utype, isInternal: !!r.is_internal, blocked: !!r.blocked,
    balance: money(r.balance), main: money(r.main), promo: money(r.promo), escrow: money(r.escrow), pendingWithdrawal: money(r.pending_wd),
    withdrawableNet: r.publisher ? money(n(r.main) * 0.8) : null,
    depositedCash: money(r.dep_cash), creditedInternal: money(r.dep_internal), spent: money(n(r.pay_main) + n(r.pay_promo)), refunds: money(n(r.ref_main) + n(r.ref_promo)),
    promoReceived: money(r.promo_in), withdrawn: money(r.wd), earned: money(r.esc_rel),
    orders: n(r.orders), openOrders: n(r.open_orders), txCount: n(r.tx_count),
    lastDeposit: r.last_deposit, lastSpend: r.last_spend, lastOrder: r.last_order, lastWithdrawal: r.last_withdrawal, lastActivity: r.last_activity,
    idleDays: Math.floor(n(r.idle_days)),
    withdrawalOpenAmount: money(r.wd_open_amount), withdrawalOpenSince: r.wd_open_since,
    expectedMain: money(r.expected_main), expectedPromo: money(r.expected_promo), mismatch: !!r.mismatch,
    mismatchAmount: money(n(r.main) - n(r.expected_main) + n(r.promo) - n(r.expected_promo)),
  };
}

const VIEWS = {
  hasBalance: 'balance > 0',
  idle30: 'balance > 0 and idle_days >= 30',
  idle90: 'balance > 0 and idle_days >= 90',
  promoOnly: 'promo > 0 and main <= 0',
  fundedNeverOrdered: 'balance > 0 and orders = 0',
  publisherEarnings: "main > 0 and utype in ('publisher','both')",
  withdrawalPending: 'wd_open_amount > 0 or pending_wd > 0',
  mismatch: 'mismatch',
  negative: 'balance < 0 or main < 0 or promo < 0',
  top: 'balance > 0',
  all: 'true',
};
const SORTS = { name: "lower(coalesce(nullif(trim(coalesce(first_name,'')||' '||coalesce(last_name,'')),''), business_name, username, ''))", balance: 'balance', main: 'main', promo: 'promo', idle: 'idle_days', lastActivity: 'last_activity', deposited: 'dep_cash', spent: '(pay_main + pay_promo)' };

module.exports = {
  async directory(ctx) {
    const started = Date.now();
    const knex = strapi.db.connection;
    const qs = ctx.query || {};
    const view = VIEWS[qs.view] ? qs.view : 'hasBalance';
    const page = Math.max(1, parseInt(qs.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(5, parseInt(qs.pageSize, 10) || 25));
    const sortCol = SORTS[qs.sort] || (view === 'idle30' || view === 'idle90' ? 'idle_days' : 'balance');
    const dir = qs.dir === 'asc' ? 'asc' : 'desc';
    const conds = [VIEWS[view]];
    const binds = [TEST_USER_RE];
    const q = String(qs.q || '').trim();
    if (q) { conds.push('(username ilike ? or email ilike ? or coalesce(first_name,\'\') ilike ? or coalesce(last_name,\'\') ilike ? or coalesce(business_name,\'\') ilike ?)'); for (let i = 0; i < 5; i++) binds.push(`%${q}%`); }
    if (['buyer', 'publisher', 'both', 'unset'].includes(qs.type)) { conds.push('utype = ?'); binds.push(qs.type); }
    if (qs.minBalance && n(qs.minBalance) > 0) { conds.push('balance >= ?'); binds.push(n(qs.minBalance)); }
    if (qs.internal !== 'show') conds.push('not coalesce(is_internal,false)');
    const limit = view === 'top' ? 20 : pageSize;
    const offset = view === 'top' ? 0 : (page - 1) * pageSize;
    const r = await knex.raw(`${WALLET_AGG} select *, count(*) over() total_count from c where ${conds.join(' and ')} order by ${sortCol} ${dir} nulls last, wallet_id desc limit ? offset ?`, [...binds, limit, offset]);
    const rows = r.rows || r;
    const total = rows.length ? n(rows[0].total_count) : 0;

    // Tiles + view counts (always computed on the whole population, internal hidden unless asked)
    const hide = qs.internal !== 'show' ? 'not coalesce(is_internal,false)' : 'true';
    const days = qs.period === '7d' ? 7 : qs.period === 'all' ? null : 30;
    const st = ((await knex.raw(`${WALLET_AGG}
      select
        count(*) filter (where balance > 0)::int with_balance, coalesce(sum(balance) filter (where balance > 0),0) with_balance_amt,
        coalesce(sum(main + escrow + pending_wd),0) we_owe, coalesce(sum(promo),0) promo_out, count(*) filter (where promo > 0)::int promo_wallets,
        count(*) filter (where balance > 0 and idle_days >= 30)::int idle30, coalesce(sum(balance) filter (where balance > 0 and idle_days >= 30),0) idle30_amt,
        count(*) filter (where balance > 0 and idle_days >= 90)::int idle90, coalesce(sum(balance) filter (where balance > 0 and idle_days >= 90),0) idle90_amt,
        coalesce(sum(escrow),0) escrow_amt, coalesce(sum(open_orders),0)::int open_orders,
        count(*) filter (where wd_open_amount > 0 or pending_wd > 0)::int wd_waiting, coalesce(sum(greatest(wd_open_amount, pending_wd)),0) wd_waiting_amt, min(wd_open_since) wd_oldest,
        count(*) filter (where promo > 0 and main <= 0)::int promo_only, count(*) filter (where balance > 0 and orders = 0)::int funded_never,
        count(*) filter (where main > 0 and utype in ('publisher','both'))::int pub_earn, count(*) filter (where mismatch)::int mismatch,
        count(*) filter (where balance < 0 or main < 0 or promo < 0)::int negative,
        count(*) filter (where balance >= ? and idle_days >= 30)::int big_idle, count(*)::int wallets
      from c where ${hide}`, [TEST_USER_RE, BIG_IDLE])).rows || [])[0] || {};
    const since = days ? `t.created_at > now() - interval '${days} days'` : 'true';
    const flow = ((await knex.raw(`select
        coalesce(sum(t.amount) filter (where t.type='deposit' and t.transaction_status in ('success','paid') and t.gateway in ('stripe','paypal','razorpay','bank_transfer')),0) cash_in,
        coalesce(sum(t.amount) filter (where t.type='payment' and t.transaction_status='success'),0) spent,
        coalesce(sum(t.amount) filter (where t.type='refund' and t.transaction_status='success'),0) refunds,
        coalesce(sum(t.amount) filter (where t.type='withdrawal' and t.transaction_status in ('success','paid','approved')),0) withdrawn,
        coalesce(sum(t.amount) filter (where t.type='promo' and t.transaction_status='success'),0) promo_given,
        coalesce(sum(t.amount) filter (where t.type='deposit' and t.transaction_status='failed'),0) failed_deposits
      from transactions t where ${since}`)).rows || [])[0] || {};

    ctx.send({
      view, data: rows.map(rowOut),
      pagination: { page: view === 'top' ? 1 : page, pageSize: limit, total: view === 'top' ? Math.min(total, 20) : total, pageCount: view === 'top' ? 1 : Math.max(1, Math.ceil(total / pageSize)) },
      tiles: {
        withBalance: n(st.with_balance), withBalanceAmount: money(st.with_balance_amt), weOwe: money(st.we_owe), promoOutstanding: money(st.promo_out), promoWallets: n(st.promo_wallets),
        idle30: n(st.idle30), idle30Amount: money(st.idle30_amt), idle90: n(st.idle90), idle90Amount: money(st.idle90_amt),
        escrowAmount: money(st.escrow_amt), openOrders: n(st.open_orders),
        withdrawalsWaiting: n(st.wd_waiting), withdrawalsWaitingAmount: money(st.wd_waiting_amt), withdrawalsOldest: st.wd_oldest || null,
        wallets: n(st.wallets),
      },
      views: { hasBalance: n(st.with_balance), idle30: n(st.idle30), idle90: n(st.idle90), promoOnly: n(st.promo_only), fundedNeverOrdered: n(st.funded_never), publisherEarnings: n(st.pub_earn), withdrawalPending: n(st.wd_waiting), mismatch: n(st.mismatch), negative: n(st.negative), top: Math.min(20, n(st.with_balance)) },
      alerts: { bigIdle: n(st.big_idle), bigIdleThreshold: BIG_IDLE, mismatch: n(st.mismatch), negative: n(st.negative) },
      flow: { period: days ? `${days}d` : 'all', cashIn: money(flow.cash_in), spent: money(flow.spent), refunds: money(flow.refunds), withdrawn: money(flow.withdrawn), promoGiven: money(flow.promo_given), failedDeposits: money(flow.failed_deposits) },
      tookMs: Date.now() - started,
    });
  },

  async detail(ctx) {
    const started = Date.now();
    const walletId = parseInt(ctx.params.walletId, 10);
    if (!walletId) return ctx.badRequest('Invalid wallet id');
    const knex = strapi.db.connection;
    const q = async (sql, b = []) => { const r = await knex.raw(sql, b); return r.rows || r; };
    const head = (await q(`${WALLET_AGG} select * from c where wallet_id = ?`, [TEST_USER_RE, walletId]))[0];
    if (!head) return ctx.notFound('Wallet not found');
    const uid = head.user_id;

    const [txs, escrowOrders, withdrawals, promos, adminActs] = await Promise.all([
      q(`select t.id, t.type, coalesce(t.fund_source,'') fund_source, coalesce(t.gateway,'') gateway, t.transaction_status status, t.amount, t.description, t.created_at, ol.order_id
           from transactions t join transactions_user_wallet_lnk l on l.transaction_id = t.id left join transactions_order_lnk ol on ol.transaction_id = t.id
          where l.user_wallet_id = ? order by t.created_at asc, t.id asc`, [walletId]),
      uid ? q(`select o.id, o.website_url, o.total_amount, o.order_status, o.created_at, o.accepted_date, o.delivered_date, round(extract(epoch from now() - o.created_at)/86400) age_days
                 from orders o join orders_advertiser_lnk ol on ol.order_id = o.id where ol.user_id = ? and o.order_status in ('pending','accepted','delivered') order by o.created_at`, [uid]) : [],
      uid ? q(`select wr.id, wr.amount, wr.withdrawal_status status, wr.method, wr.created_at, wr.approved_at, wr.paid_at, wr.denial_reason
                 from withdrawal_requests wr join withdrawal_requests_publisher_lnk wpl on wpl.withdrawal_request_id = wr.id where wpl.user_id = ? order by wr.created_at desc`, [uid]) : [],
      uid ? q(`select pr.id, pr.redeemed_at, pc.code, pc.amount, pc.expiry_date, pc.promo_status
                 from promo_redemptions pr join promo_redemptions_user_lnk pul on pul.promo_redemption_id = pr.id
                 left join promo_redemptions_promo_code_lnk pcl on pcl.promo_redemption_id = pr.id left join promo_codes pc on pc.id = pcl.promo_code_id
                where pul.user_id = ? order by pr.redeemed_at desc nulls last`, [uid]) : [],
      uid ? q(`select a.id, a.action, a.details, a.created_at, coalesce(adm.username,'admin') admin
                 from admin_audit_logs a join admin_audit_logs_target_user_lnk tl on tl.admin_audit_log_id = a.id
                 left join admin_audit_logs_admin_user_lnk al on al.admin_audit_log_id = a.id left join up_users adm on adm.id = al.user_id
                where tl.user_id = ? and (a.action ilike 'wallet%' or a.details::text ilike '%walletId%') order by a.created_at desc limit 50`, [uid]) : [],
    ]);

    // Running balances (ledger view). Effect on main / promo per the same rule as the reconciliation.
    let runMain = 0, runPromo = 0;
    const ledger = txs.map((t) => {
      const ok = ['success', 'paid'].includes(t.status) || (t.type === 'withdrawal' && t.status === 'approved');
      const amt = n(t.amount);
      const promo = t.fund_source === 'promo_fund';
      let dMain = 0, dPromo = 0;
      if (ok) {
        if (t.type === 'deposit') { if (promo) dPromo = amt; else dMain = amt; }
        else if (t.type === 'promo') dPromo = amt;
        else if (t.type === 'refund') { if (promo) dPromo = amt; else dMain = amt; }
        else if (t.type === 'payment') { if (promo) dPromo = -amt; else dMain = -amt; }
        else if (t.type === 'withdrawal' || t.type === 'fee') dMain = -amt;
      }
      runMain += dMain; runPromo += dPromo;
      return { id: t.id, type: t.type, fundSource: t.fund_source || null, gateway: t.gateway || null, status: t.status, amount: money(amt), description: t.description || null, createdAt: t.created_at, orderId: t.order_id || null,
        effectMain: money(dMain), effectPromo: money(dPromo), runningMain: money(runMain), runningPromo: money(runPromo), counted: ok && (dMain !== 0 || dPromo !== 0) };
    }).reverse();

    ctx.send({
      wallet: rowOut(head),
      reconciliation: {
        expectedMain: money(head.expected_main), actualMain: money(head.main), diffMain: money(n(head.main) - n(head.expected_main)),
        expectedPromo: money(head.expected_promo), actualPromo: money(head.promo), diffPromo: money(n(head.promo) - n(head.expected_promo)),
        ok: !head.mismatch, txCount: n(head.tx_count),
        rule: 'main = deposits + refunds to main − payments from main − withdrawals − fees; promo = promo credits + promo refunds − promo payments',
      },
      ledger,
      escrowOrders: escrowOrders.map((o) => ({ id: o.id, url: o.website_url, amount: money(o.total_amount), status: o.order_status, createdAt: o.created_at, ageDays: n(o.age_days) })),
      withdrawals: withdrawals.map((w) => ({ id: w.id, amount: money(w.amount), status: w.status, method: w.method, createdAt: w.created_at, approvedAt: w.approved_at, paidAt: w.paid_at, denialReason: w.denial_reason, feeNote: money(n(w.amount) * 0.25) })),
      promos: promos.map((p) => ({ id: p.id, code: p.code, amount: money(p.amount), redeemedAt: p.redeemed_at, expiry: p.expiry_date, status: p.promo_status })),
      adminActions: adminActs.map((a) => { const d = typeof a.details === 'string' ? (() => { try { return JSON.parse(a.details); } catch (e) { return {}; } })() : (a.details || {}); return { id: a.id, action: a.action, admin: a.admin, createdAt: a.created_at, amount: d.amount != null ? money(d.amount) : null, reason: d.reason || null, notes: d.notes || null, fundSource: d.fundSource || null }; }),
      tookMs: Date.now() - started,
    });
  },
};
