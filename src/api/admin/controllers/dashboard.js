'use strict';

/**
 * Super-admin dashboard overview.
 *
 * One endpoint, one round trip: every block of the admin dashboard
 * (money, transactions, orders, queues, users, supply, applications,
 * marketplace activity, system, feed) computed with raw SQL on the
 * shared Postgres via knex. All queries run in parallel; a failing
 * block returns `null` for that block instead of failing the page.
 *
 *   GET /api/admin/dashboard/overview?period=7d|30d|all
 *
 * Definitions (these matter — the old /dashboard/stats "revenue" tile
 * summed deposits + payments, which double-counts wallet top-ups):
 *   - GMV            = sum(orders.total_amount) placed in the period
 *   - cash in        = successful deposits whose gateway is a real gateway
 *                      (stripe / paypal / razorpay / bank_transfer).
 *                      gateway = 'system' rows are internal credits.
 *   - net revenue    = fee transactions + 20% platform fee realised on
 *                      paid withdrawals (wallet is debited amount/0.8, so
 *                      the fee on a paid amount A is A/0.8 - A = A/4).
 *   - wallet liability = main + promo + escrow + pending_withdrawal.
 */

const PLATFORM_FEE_RATE = 0.2;
const REAL_GATEWAYS = ['stripe', 'paypal', 'razorpay', 'bank_transfer'];
const SUCCESS = ['success', 'paid'];

function windowFor(period) {
  if (period === '7d') return { days: 7 };
  if (period === '30d') return { days: 30 };
  return { days: null };
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}
function money(v) {
  return Math.round(n(v) * 100) / 100;
}

module.exports = {
  async overview(ctx) {
    const started = Date.now();
    const period = ['7d', '30d', 'all'].includes(ctx.query.period) ? ctx.query.period : '7d';
    const { days } = windowFor(period);
    const knex = strapi.db.connection;

    // Period predicate helpers (SQL fragments, bound safely).
    // cur: rows in the current window; prev: the window immediately before it.
    const cur = (col) => (days ? knex.raw(`${col} > now() - (? || ' days')::interval`, [String(days)]) : knex.raw('true'));
    const prev = (col) => (days
      ? knex.raw(`${col} > now() - (? || ' days')::interval AND ${col} <= now() - (? || ' days')::interval`, [String(days * 2), String(days)])
      : knex.raw('false'));

    const q = async (sql, bindings = []) => {
      const r = await knex.raw(sql, bindings);
      return r.rows || r;
    };
    const one = async (sql, bindings) => (await q(sql, bindings))[0] || {};

    const safe = (label, fn) => fn().catch((err) => {
      strapi.log.error(`[DASHBOARD OVERVIEW] block "${label}" failed: ${err.message}`);
      return null;
    });

    const curOrders = cur('created_at');
    const prevOrders = prev('created_at');

    // ───────────────────────── MONEY ─────────────────────────
    const moneyP = safe('money', async () => {
      const [gmv, gmvPrev, fees, wdFees, cash, cashByGw, refunds, liability, payouts, promo, avgs] = await Promise.all([
        one(`select count(*)::int as count, coalesce(sum(total_amount),0) as amount from orders where ${curOrders.toQuery()}`),
        one(`select count(*)::int as count, coalesce(sum(total_amount),0) as amount from orders where ${prevOrders.toQuery()}`),
        one(`select coalesce(sum(amount),0) as amount, count(*)::int as count from transactions where type='fee' and transaction_status in ('success','paid') and ${curOrders.toQuery()}`),
        one(`select coalesce(sum(amount),0) as paid from withdrawal_requests where withdrawal_status='paid' and ${cur('coalesce(paid_at, updated_at)').toQuery()}`),
        one(`select count(*)::int as count, coalesce(sum(amount),0) as amount from transactions where type='deposit' and transaction_status in ('success','paid') and gateway = any(?) and ${curOrders.toQuery()}`, [REAL_GATEWAYS]),
        q(`select gateway,
                  count(*) filter (where transaction_status in ('success','paid'))::int as ok,
                  count(*) filter (where transaction_status = 'failed')::int as failed,
                  count(*) filter (where transaction_status = 'pending')::int as pending,
                  coalesce(sum(amount) filter (where transaction_status in ('success','paid')),0) as ok_amount,
                  coalesce(sum(amount) filter (where transaction_status = 'failed'),0) as failed_amount,
                  coalesce(sum(amount) filter (where transaction_status = 'pending'),0) as pending_amount
             from transactions where type='deposit' and gateway = any(?) and ${curOrders.toQuery()}
             group by gateway order by ok desc`, [REAL_GATEWAYS]),
        one(`select count(*)::int as count, coalesce(sum(amount),0) as amount from transactions where type='refund' and transaction_status in ('success','paid') and ${curOrders.toQuery()}`),
        one(`select coalesce(sum(main_balance),0) as main, coalesce(sum(promo_balance),0) as promo, coalesce(sum(escrow_balance),0) as escrow, coalesce(sum(pending_withdrawal_balance),0) as pending_withdrawal from user_wallets`),
        one(`select count(*) filter (where withdrawal_status='paid')::int as paid_count,
                    coalesce(sum(amount) filter (where withdrawal_status='paid'),0) as paid_amount,
                    count(*) filter (where withdrawal_status='approved')::int as approved_count,
                    coalesce(sum(amount) filter (where withdrawal_status='approved'),0) as approved_amount,
                    coalesce(max(extract(epoch from now()-created_at)/86400) filter (where withdrawal_status='approved'),0) as approved_oldest_days
             from withdrawal_requests`),
        one(`select (select coalesce(sum(amount),0) from transactions where type='promo' and transaction_status in ('success','paid')) as issued,
                    (select count(*)::int from promo_redemptions) as redemptions,
                    (select count(*)::int from promo_redemptions where created_at > now() - interval '30 days') as redemptions_30d`),
        one(`select (select coalesce(avg(amount),0) from transactions where type='deposit' and transaction_status in ('success','paid') and gateway = any(?)) as avg_deposit,
                    (select coalesce(avg(total_amount),0) from orders) as avg_order`, [REAL_GATEWAYS]),
      ]);
      const withdrawalFees = money(n(wdFees.paid) * (PLATFORM_FEE_RATE / (1 - PLATFORM_FEE_RATE)));
      const liab = {
        main: money(liability.main), promo: money(liability.promo), escrow: money(liability.escrow), pendingWithdrawal: money(liability.pending_withdrawal),
      };
      liab.total = money(liab.main + liab.promo + liab.escrow + liab.pendingWithdrawal);
      liab.cashExposure = money(liab.main + liab.escrow + liab.pendingWithdrawal);
      return {
        gmv: { count: n(gmv.count), amount: money(gmv.amount) },
        gmvPrev: days ? { count: n(gmvPrev.count), amount: money(gmvPrev.amount) } : null,
        netRevenue: { fees: money(fees.amount), feeCount: n(fees.count), withdrawalFees, total: money(n(fees.amount) + withdrawalFees) },
        cashIn: { count: n(cash.count), amount: money(cash.amount) },
        byGateway: cashByGw.map((g) => ({
          gateway: g.gateway, ok: n(g.ok), failed: n(g.failed), pending: n(g.pending),
          okAmount: money(g.ok_amount), failedAmount: money(g.failed_amount), pendingAmount: money(g.pending_amount),
        })),
        refunds: { count: n(refunds.count), amount: money(refunds.amount) },
        liability: liab,
        payouts: {
          paidCount: n(payouts.paid_count), paidAmount: money(payouts.paid_amount),
          approvedUnpaidCount: n(payouts.approved_count), approvedUnpaidAmount: money(payouts.approved_amount),
          approvedOldestDays: Math.round(n(payouts.approved_oldest_days)),
          feeAccrued: money(n(payouts.approved_amount) * (PLATFORM_FEE_RATE / (1 - PLATFORM_FEE_RATE))),
        },
        promo: { issued: money(promo.issued), redemptions: n(promo.redemptions), redemptions30d: n(promo.redemptions_30d), unspent: liab.promo },
        avgDeposit: money(avgs.avg_deposit), avgOrder: money(avgs.avg_order),
      };
    });

    // ───────────────────── TRANSACTIONS ─────────────────────
    const txP = safe('transactions', async () => {
      const [byType, daily, largest, adminActions] = await Promise.all([
        q(`select case when type='deposit' and gateway='system' then 'internal_credit' else type end as type,
                  count(*)::int as count, coalesce(sum(amount),0) as amount
             from transactions where transaction_status in ('success','paid','approved') and ${curOrders.toQuery()}
             group by 1 order by count desc`),
        q(`select to_char(created_at,'YYYY-MM-DD') as day,
                  coalesce(sum(amount) filter (where type='deposit' and gateway <> 'system'),0) as deposit,
                  coalesce(sum(amount) filter (where type='deposit' and gateway = 'system'),0) as internal,
                  coalesce(sum(amount) filter (where type='payment'),0) as payment,
                  coalesce(sum(amount) filter (where type='refund'),0) as refund
             from transactions where transaction_status in ('success','paid') and created_at > now() - interval '30 days'
             group by 1 order by 1`),
        q(`select t.id, t.type, t.gateway, t.amount, t.transaction_status as status, t.created_at, l.order_id
             from transactions t left join transactions_order_lnk l on l.transaction_id = t.id
            where ${cur('t.created_at').toQuery()} order by t.amount desc limit 6`),
        q(`select a.action, a.details, a.created_at, u.username as admin
             from admin_audit_logs a
             left join admin_audit_logs_admin_user_lnk l on l.admin_audit_log_id = a.id
             left join up_users u on u.id = l.user_id
            order by a.created_at desc limit 6`),
      ]);
      return {
        byType: byType.map((r) => ({ type: r.type, count: n(r.count), amount: money(r.amount) })),
        daily: daily.map((r) => ({ day: r.day, deposit: money(r.deposit), internal: money(r.internal), payment: money(r.payment), refund: money(r.refund) })),
        largest: largest.map((r) => ({ id: r.id, type: r.type, gateway: r.gateway, amount: money(r.amount), status: r.status, createdAt: r.created_at, orderId: r.order_id })),
        adminActions: adminActions.map((r) => ({ action: r.action, admin: r.admin, createdAt: r.created_at, amount: r.details && r.details.amount != null ? money(r.details.amount) : null })),
      };
    });

    // ───────────────────────── ORDERS ─────────────────────────
    const ordersP = safe('orders', async () => {
      const [cnt, prevCnt, mix, cancelledBy, cycle, auto, byService, monthly, stuck, latest] = await Promise.all([
        one(`select count(*)::int as count, coalesce(sum(total_amount),0) as amount,
                    count(*) filter (where order_status='completed')::int as completed, coalesce(sum(total_amount) filter (where order_status='completed'),0) as completed_amount,
                    count(*) filter (where order_status='cancelled')::int as cancelled, count(*) filter (where order_status='rejected')::int as rejected,
                    coalesce(sum(total_amount) filter (where order_status in ('cancelled','rejected')),0) as lost_amount,
                    count(*) filter (where ${cur('completed_date').toQuery()})::int as completed_in_period
             from orders where ${curOrders.toQuery()}`),
        one(`select count(*)::int as count from orders where ${prevOrders.toQuery()}`),
        q(`select order_status as status, count(*)::int as count, coalesce(sum(total_amount),0) as amount from orders group by 1 order by count desc`),
        q(`select coalesce(nullif(cancelled_by,''),'unknown') as by, count(*)::int as count from orders where order_status='cancelled' group by 1 order by count desc`),
        one(`select avg(extract(epoch from accepted_date-order_date)/86400) as accept_days,
                    avg(extract(epoch from delivered_date-accepted_date)/86400) as deliver_days,
                    avg(extract(epoch from completed_date-delivered_date)/86400) as approve_days
             from orders where order_status='completed'`),
        one(`select count(*) filter (where auto_approved)::int as auto, count(*) filter (where auto_approved is not true)::int as manual from orders where order_status='completed'`),
        q(`select coalesce(nullif(service_type,''),'guest_post') as service, count(*)::int as count, coalesce(sum(total_amount),0) as amount from orders group by 1 order by count desc`),
        q(`select to_char(date_trunc('month',created_at),'YYYY-MM') as month, count(*)::int as count, coalesce(sum(total_amount),0) as amount,
                  count(*) filter (where order_status='completed')::int as completed,
                  count(*) filter (where order_status in ('cancelled','rejected'))::int as lost
             from orders where created_at > now() - interval '12 months' group by 1 order by 1`),
        q(`select id, website_url as url, total_amount as amount, order_status as status,
                  round(extract(epoch from now()-coalesce(accepted_date, delivered_date, created_at))/86400) as age_days
             from orders
            where (order_status='pending' and created_at < now() - interval '2 days')
               or (order_status='accepted' and accepted_date < now() - interval '3 days')
               or (order_status='delivered' and delivered_date < now() - interval '5 days')
               or order_status in ('disputed','revision_requested')
            order by age_days desc limit 8`),
        q(`select o.id, o.website_url as url, o.total_amount as amount, o.order_status as status, coalesce(nullif(o.service_type,''),'guest_post') as service, o.created_at,
                  u.username as advertiser
             from orders o left join orders_advertiser_lnk l on l.order_id=o.id left join up_users u on u.id=l.user_id
            order by o.created_at desc limit 8`),
      ]);
      return {
        new: { count: n(cnt.count), amount: money(cnt.amount) },
        newPrev: days ? n(prevCnt.count) : null,
        completed: { count: n(cnt.completed), amount: money(cnt.completed_amount), inPeriod: n(cnt.completed_in_period) },
        lost: { count: n(cnt.cancelled) + n(cnt.rejected), cancelled: n(cnt.cancelled), rejected: n(cnt.rejected), amount: money(cnt.lost_amount) },
        statusMix: mix.map((r) => ({ status: r.status, count: n(r.count), amount: money(r.amount) })),
        cancelledBy: cancelledBy.map((r) => ({ by: r.by, count: n(r.count) })),
        cycle: { acceptDays: money(cycle.accept_days), deliverDays: money(cycle.deliver_days), approveDays: money(cycle.approve_days) },
        autoApproved: { auto: n(auto.auto), manual: n(auto.manual) },
        byService: byService.map((r) => ({ service: r.service, count: n(r.count), amount: money(r.amount) })),
        monthly: monthly.map((r) => ({ month: r.month, count: n(r.count), amount: money(r.amount), completed: n(r.completed), lost: n(r.lost) })),
        stuck: stuck.map((r) => ({ id: r.id, url: r.url, amount: money(r.amount), status: r.status, ageDays: n(r.age_days) })),
        latest: latest.map((r) => ({ id: r.id, url: r.url, amount: money(r.amount), status: r.status, service: r.service, createdAt: r.created_at, advertiser: r.advertiser })),
      };
    });

    // ───────────────────────── QUEUES ─────────────────────────
    const queuesP = safe('queues', async () => {
      const r = await one(`select
        (select count(*)::int from publisher_websites where submission_status='approval_pending') as approvals,
        (select coalesce(max(extract(epoch from now()-created_at)/86400),0) from publisher_websites where submission_status='approval_pending') as approvals_oldest,
        (select coalesce(avg(extract(epoch from now()-created_at)/86400),0) from publisher_websites where submission_status='approval_pending') as approvals_avg,
        (select count(*)::int from publisher_websites where submission_status='pending_verification') as verification,
        (select coalesce(max(extract(epoch from now()-created_at)/86400),0) from publisher_websites where submission_status='pending_verification') as verification_oldest,
        (select count(*)::int from publisher_websites where submission_status='pending_verification' and created_at > now() - interval '1 day') as verification_today,
        (select count(*)::int from withdrawal_requests where withdrawal_status='approved') as payouts_unpaid,
        (select coalesce(sum(amount),0) from withdrawal_requests where withdrawal_status='approved') as payouts_unpaid_amount,
        (select coalesce(max(extract(epoch from now()-created_at)/86400),0) from withdrawal_requests where withdrawal_status='approved') as payouts_unpaid_oldest,
        (select count(*)::int from withdrawal_requests where withdrawal_status='pending') as withdrawals_pending,
        (select coalesce(sum(amount),0) from withdrawal_requests where withdrawal_status='pending') as withdrawals_pending_amount,
        (select count(*)::int from bank_transfer_requests where coalesce(status,'pending') in ('pending','submitted')) as bank_transfers,
        (select count(*)::int from reseller_applications where status in ('submitted','in_review')) as reseller_apps,
        (select coalesce(max(extract(epoch from now()-created_at)/86400),0) from reseller_applications where status in ('submitted','in_review')) as reseller_apps_oldest,
        (select count(*)::int from orders where order_status='delivered') as delivered_awaiting,
        (select coalesce(max(extract(epoch from now()-delivered_date)/86400),0) from orders where order_status='delivered') as delivered_oldest,
        (select count(*)::int from orders where order_status='accepted') as accepted_not_delivered,
        (select coalesce(max(extract(epoch from now()-accepted_date)/86400),0) from orders where order_status='accepted') as accepted_oldest,
        (select count(*)::int from orders where order_status='pending') as pending_orders,
        (select count(*)::int from orders where order_status in ('disputed','revision_requested') or revision_status in ('requested','pending')) as disputes,
        (select count(*)::int from website_update_requests where status='pending') as update_requests,
        (select coalesce(max(extract(epoch from now()-created_at)/86400),0) from website_update_requests where status='pending') as update_requests_oldest,
        (select count(*)::int from communications where is_unread) as unread_comms,
        (select count(*)::int from transactions where type='deposit' and transaction_status='failed' and created_at > now() - interval '30 days') as failed_deposits,
        (select coalesce(sum(amount),0) from transactions where type='deposit' and transaction_status='failed' and created_at > now() - interval '30 days') as failed_deposits_amount,
        (select count(*)::int from transactions where type='deposit' and transaction_status='pending') as pending_deposits,
        (select coalesce(sum(amount),0) from transactions where type='deposit' and transaction_status='pending') as pending_deposits_amount,
        (select count(*)::int from chatrooms where last_activity > now() - interval '7 days') as active_chats,
        (select count(*)::int from chatrooms) as total_chats`);
      const d = (v) => Math.round(n(v));
      return {
        websiteApprovals: { count: n(r.approvals), oldestDays: d(r.approvals_oldest), avgDays: d(r.approvals_avg) },
        pendingVerification: { count: n(r.verification), oldestDays: d(r.verification_oldest), today: n(r.verification_today) },
        payoutsUnpaid: { count: n(r.payouts_unpaid), amount: money(r.payouts_unpaid_amount), oldestDays: d(r.payouts_unpaid_oldest) },
        withdrawalsPending: { count: n(r.withdrawals_pending), amount: money(r.withdrawals_pending_amount) },
        bankTransfers: { count: n(r.bank_transfers) },
        resellerApplications: { count: n(r.reseller_apps), oldestDays: d(r.reseller_apps_oldest) },
        deliveredAwaiting: { count: n(r.delivered_awaiting), oldestDays: d(r.delivered_oldest) },
        acceptedNotDelivered: { count: n(r.accepted_not_delivered), oldestDays: d(r.accepted_oldest) },
        pendingOrders: { count: n(r.pending_orders) },
        disputes: { count: n(r.disputes) },
        updateRequests: { count: n(r.update_requests), oldestDays: d(r.update_requests_oldest) },
        unreadComms: { count: n(r.unread_comms) },
        failedDeposits30d: { count: n(r.failed_deposits), amount: money(r.failed_deposits_amount) },
        pendingDeposits: { count: n(r.pending_deposits), amount: money(r.pending_deposits_amount) },
        activeChats: { count: n(r.active_chats), total: n(r.total_chats) },
      };
    });

    // ───────────────────────── USERS ─────────────────────────
    const usersP = safe('users', async () => {
      const [su, suPrev, weekly, funnel, top, topPubs, countries, latest] = await Promise.all([
        one(`select count(*)::int as count, count(*) filter (where publisher)::int as pub, count(*) filter (where advertiser)::int as adv from up_users where ${curOrders.toQuery()}`),
        one(`select count(*)::int as count from up_users where ${prevOrders.toQuery()}`),
        q(`select to_char(date_trunc('week',created_at),'YYYY-MM-DD') as week, count(*)::int as total, count(*) filter (where publisher)::int as pub
             from up_users where created_at > date_trunc('week', now()) - interval '11 weeks' group by 1 order by 1`),
        one(`select
          (select count(*)::int from up_users) as signups,
          (select count(*)::int from up_users where confirmed) as confirmed,
          (select count(*)::int from up_users where marketplace_unlocked) as unlocked,
          (select count(*)::int from up_users where marketplace_unlocked = false) as locked,
          (select count(*)::int from up_users where onboarding_state is not null and (onboarding_state->'marketplace'->>'completed')::boolean is not true and (onboarding_state->'marketplace'->>'skipped')::boolean is not true) as onboarding_incomplete,
          (select count(distinct l.user_id)::int from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id=t.id where t.type='deposit' and t.transaction_status in ('success','paid') and t.gateway = any(?)) as depositors,
          (select count(distinct user_id)::int from orders_advertiser_lnk) as buyers,
          (select count(*)::int from (select user_id from orders_advertiser_lnk group by 1 having count(*)>1) r) as repeat_buyers,
          (select count(distinct l.user_id)::int from orders o join orders_advertiser_lnk l on l.order_id=o.id where o.created_at > now() - interval '30 days') as active_buyers_30d,
          (select count(distinct l.user_id)::int from orders o join orders_publisher_lnk l on l.order_id=o.id where o.created_at > now() - interval '30 days') as active_publishers_30d,
          (select count(*)::int from up_users where blocked) as blocked,
          (select count(*)::int from up_users where not confirmed) as unconfirmed,
          (select count(*)::int from up_users where coalesce(country,'')='') as no_country`, [REAL_GATEWAYS]),
        q(`select u.id, u.username, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) as name, u.country, count(*)::int as orders, coalesce(sum(o.total_amount),0) as spend
             from orders o join orders_advertiser_lnk l on l.order_id=o.id join up_users u on u.id=l.user_id
            where ${cur('o.created_at').toQuery()} group by 1,2,3,4 order by spend desc limit 5`),
        q(`select u.id, u.username, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) as name, u.country, count(*)::int as orders, coalesce(sum(o.total_amount),0) as earned
             from orders o join orders_publisher_lnk l on l.order_id=o.id join up_users u on u.id=l.user_id
            where o.order_status='completed' and ${cur('o.created_at').toQuery()} group by 1,2,3,4 order by earned desc limit 5`),
        q(`select coalesce(nullif(country,''),'unknown') as country, count(*)::int as count from up_users group by 1 order by count desc limit 8`),
        q(`select u.id, u.username, u.email, coalesce(nullif(u.first_name,''),'') as first_name, coalesce(nullif(u.business_name,''),'') as business,
                  u.publisher, u.advertiser, coalesce(nullif(u.country,''),'') as country, u.confirmed, u.marketplace_unlocked, u.onboarding_state, u.created_at,
                  coalesce((select w.balance from user_wallets w join user_wallets_users_permissions_user_lnk wl on wl.user_wallet_id=w.id where wl.user_id=u.id limit 1),0) as wallet,
                  (select count(*)::int from orders_advertiser_lnk l where l.user_id=u.id) as orders,
                  (select count(*)::int from publisher_websites_current_publisher_id_lnk l where l.user_id=u.id) as sites,
                  (select count(*)::int from transactions t join transactions_users_permissions_user_lnk tl on tl.transaction_id=t.id where tl.user_id=u.id and t.type='deposit' and t.transaction_status in ('success','paid')) as deposits
             from up_users u order by u.created_at desc limit 12`),
      ]);
      const onboarding = (raw) => {
        let s = raw;
        if (typeof s === 'string') { try { s = JSON.parse(s); } catch (e) { s = null; } }
        if (!s || !s.marketplace) return 'not started';
        if (s.marketplace.completed) return 'completed';
        if (s.marketplace.skipped) return 'skipped';
        return 'in progress';
      };
      return {
        signups: { count: n(su.count), publishers: n(su.pub), advertisers: n(su.adv) },
        signupsPrev: days ? n(suPrev.count) : null,
        weekly: weekly.map((r) => ({ week: r.week, total: n(r.total), publishers: n(r.pub) })),
        funnel: {
          signups: n(funnel.signups), confirmed: n(funnel.confirmed), unlocked: n(funnel.unlocked), locked: n(funnel.locked), onboardingIncomplete: n(funnel.onboarding_incomplete),
          depositors: n(funnel.depositors), buyers: n(funnel.buyers), repeatBuyers: n(funnel.repeat_buyers),
        },
        activeBuyers30d: n(funnel.active_buyers_30d), activePublishers30d: n(funnel.active_publishers_30d),
        blocked: n(funnel.blocked), unconfirmed: n(funnel.unconfirmed), noCountry: n(funnel.no_country),
        topBuyers: top.map((r) => ({ id: r.id, username: r.username, name: r.name, country: r.country, orders: n(r.orders), spend: money(r.spend) })),
        topPublishers: topPubs.map((r) => ({ id: r.id, username: r.username, name: r.name, country: r.country, orders: n(r.orders), earned: money(r.earned) })),
        countries: countries.map((r) => ({ country: r.country, count: n(r.count) })),
        latest: latest.map((r) => ({
          id: r.id, username: r.username, email: r.email, firstName: r.first_name, business: r.business,
          role: r.publisher && !r.advertiser ? 'publisher' : r.advertiser && !r.publisher ? 'advertiser' : r.publisher ? 'both' : 'unset',
          country: r.country, confirmed: !!r.confirmed, marketplaceUnlocked: r.marketplace_unlocked === true,
          onboarding: onboarding(r.onboarding_state), createdAt: r.created_at,
          wallet: money(r.wallet), orders: n(r.orders), sites: n(r.sites), deposits: n(r.deposits),
        })),
      };
    });

    // ───────────────────────── SUPPLY ─────────────────────────
    const supplyP = safe('supply', async () => {
      const [sites, sitesPrev, daily, listings, bands, submission, cats, lastJob] = await Promise.all([
        one(`select count(*)::int as count, count(*) filter (where coalesce(reseller_code,'')<>'')::int as via_reseller,
                    count(*) filter (where submission_status='approved')::int as approved, count(*) filter (where submission_status='rejected')::int as rejected
             from publisher_websites where ${curOrders.toQuery()}`),
        one(`select count(*)::int as count from publisher_websites where ${prevOrders.toQuery()}`),
        q(`select to_char(created_at,'YYYY-MM-DD') as day, count(*)::int as count from publisher_websites where created_at > now() - interval '30 days' group by 1 order by 1`),
        one(`select count(*) filter (where status='active')::int as active, count(*) filter (where status='paused')::int as paused, count(*) filter (where status='delisted')::int as delisted,
                    count(*) filter (where status='active' and gsc_verified)::int as gsc_verified,
                    count(*) filter (where status='active' and (last_metric_update_at is null or last_metric_update_at < now() - interval '90 days'))::int as stale_90,
                    count(*) filter (where status='active' and last_price_update_at > now() - interval '30 days')::int as price_updated_30d,
                    count(*) filter (where status='active' and is_featured)::int as featured,
                    (select count(distinct website_url)::int from orders) as ever_sold,
                    (select coalesce(avg(extract(epoch from approved_at-created_at)/86400),0) from publisher_websites where approved_at > now() - interval '90 days') as avg_review_days,
                    (select count(*)::int from publisher_websites where approved_at > now() - interval '90 days') as approved_90d
             from marketplaces`),
        q(`select case when ahrefs_dr>=60 then '60+' when ahrefs_dr>=40 then '40-59' when ahrefs_dr>=20 then '20-39' else '<20' end as band,
                  count(*)::int as count, coalesce(avg(price),0) as avg_price
             from marketplaces where status='active' group by 1 order by 1`),
        q(`select submission_status as status, count(*)::int as count from publisher_websites group by 1 order by count desc`),
        q(`select category::text as category, count(*)::int as count from marketplaces where status='active' group by 1 order by count desc limit 8`),
        one(`select tool, job_type, status, row_count, updated_count, created_at from bulk_refresh_jobs order by created_at desc limit 1`),
      ]);
      const bandOrder = ['60+', '40-59', '20-39', '<20'];
      return {
        newSites: { count: n(sites.count), viaReseller: n(sites.via_reseller), approved: n(sites.approved), rejected: n(sites.rejected) },
        newSitesPrev: days ? n(sitesPrev.count) : null,
        daily: daily.map((r) => ({ day: r.day, count: n(r.count) })),
        listings: {
          active: n(listings.active), paused: n(listings.paused), delisted: n(listings.delisted), gscVerified: n(listings.gsc_verified),
          stale90: n(listings.stale_90), priceUpdated30d: n(listings.price_updated_30d), featured: n(listings.featured), everSold: n(listings.ever_sold),
          avgReviewDays: money(listings.avg_review_days), approved90d: n(listings.approved_90d),
        },
        drBands: bandOrder.map((b) => { const r = bands.find((x) => x.band === b) || {}; return { band: b, count: n(r.count), avgPrice: Math.round(n(r.avg_price)) }; }),
        submission: submission.map((r) => ({ status: r.status, count: n(r.count) })),
        categories: cats.map((r) => ({ category: r.category, count: n(r.count) })),
        lastBulkJob: lastJob.created_at ? { tool: lastJob.tool, type: lastJob.job_type, status: lastJob.status, rows: n(lastJob.row_count), updated: n(lastJob.updated_count), createdAt: lastJob.created_at } : null,
      };
    });

    // ─────────────────── APPLICATIONS & CODES ───────────────────
    const appsP = safe('applications', async () => {
      const [ra, raAll, cfg, codes, topCodes, promo] = await Promise.all([
        q(`select status, count(*)::int as count from reseller_applications where ${curOrders.toQuery()} group by 1`),
        one(`select count(*)::int as total, coalesce(sum(fee_amount) filter (where status <> 'refunded'),0) as fees,
                    coalesce(avg(extract(epoch from reviewed_at-created_at)/86400) filter (where reviewed_at is not null),0) as avg_decision_days,
                    count(*) filter (where status='rejected' and reviewed_at > now() - interval '30 days')::int as cooldowns
             from reseller_applications`),
        one(`select reseller_applications_enabled, auto_approve_days, auto_release_days, min_payout_amount, payment_gateways from global_configs order by id limit 1`),
        one(`select count(*)::int as total, count(*) filter (where is_active)::int as active, coalesce(sum(used_count),0)::int as used, coalesce(sum(usage_limit),0)::int as "limit",
                    count(*) filter (where is_active and usage_limit > 0 and used_count >= usage_limit)::int as full,
                    (select count(*)::int from publisher_websites where coalesce(reseller_code,'')<>'' and created_at > now() - interval '30 days') as used_30d
             from reseller_codes`),
        q(`select code, assigned_to_name, used_count::int, usage_limit::int, is_active, last_used_at, expires_at from reseller_codes order by used_count desc, created_at desc limit 6`),
        one(`select count(*)::int as total, count(*) filter (where promo_status='active')::int as active, coalesce(sum(current_redemptions),0)::int as redemptions,
                    (select count(*)::int from promo_redemptions where created_at > now() - interval '30 days') as redemptions_30d,
                    (select coalesce(sum(amount),0) from transactions where type='promo' and transaction_status in ('success','paid')) as issued,
                    (select coalesce(sum(promo_balance),0) from user_wallets) as unspent
             from promo_codes`),
      ]);
      const byStatus = {};
      ra.forEach((r) => { byStatus[r.status] = n(r.count); });
      return {
        reseller: { byStatus, total: n(raAll.total), feesCollected: money(raAll.fees), avgDecisionDays: money(raAll.avg_decision_days), cooldowns: n(raAll.cooldowns), enabled: cfg.reseller_applications_enabled !== false },
        codes: { total: n(codes.total), active: n(codes.active), used: n(codes.used), limit: n(codes.limit), full: n(codes.full), used30d: n(codes.used_30d),
          top: topCodes.map((c) => ({ code: c.code, assignedTo: c.assigned_to_name, used: n(c.used_count), limit: n(c.usage_limit), active: !!c.is_active, lastUsedAt: c.last_used_at, expiresAt: c.expires_at })) },
        promo: { total: n(promo.total), active: n(promo.active), redemptions: n(promo.redemptions), redemptions30d: n(promo.redemptions_30d), issued: money(promo.issued), unspent: money(promo.unspent) },
        config: { autoApproveDays: n(cfg.auto_approve_days), autoReleaseDays: n(cfg.auto_release_days), minPayout: money(cfg.min_payout_amount), gateways: cfg.payment_gateways || null },
      };
    });

    // ─────────────────── MARKETPLACE ACTIVITY ───────────────────
    const activityP = safe('activity', async () => {
      const r = await one(`select
        (select count(*)::int from projects) as projects, (select count(*)::int from projects where ${curOrders.toQuery()}) as projects_p,
        (select count(*)::int from shortlists) as shortlists, (select count(*)::int from shortlists where ${curOrders.toQuery()}) as shortlists_p,
        (select count(*)::int from saved_filters) as saved_filters,
        (select count(*)::int from carts) as carts, (select count(*)::int from carts where ${curOrders.toQuery()}) as carts_p,
        (select count(*)::int from shared_lists) as shared_lists,
        (select count(*)::int from orders) as orders_total,
        (select count(*)::int from website_update_requests) as wur, (select count(*)::int from website_update_requests where ${curOrders.toQuery()}) as wur_p,
        (select count(*)::int from website_update_requests where status='approved') as wur_approved,
        (select count(*)::int from website_update_requests where status='superseded') as wur_superseded,
        (select count(*)::int from website_update_requests where status='pending') as wur_pending,
        (select count(*)::int from website_update_requests where status='rejected') as wur_rejected,
        (select count(*)::int from website_update_requests where reviewed_at > now() - interval '90 days') as wur_reviewed_90d,
        (select count(*)::int from bulk_refresh_jobs) as bulk_jobs,
        (select count(*)::int from marketplaces where status='active' and last_price_update_at > now() - interval '30 days') as repriced_30d,
        (select count(*)::int from marketplaces where status='active' and is_featured) as featured`);
      return {
        projects: { total: n(r.projects), inPeriod: n(r.projects_p) },
        shortlists: { total: n(r.shortlists), inPeriod: n(r.shortlists_p) },
        savedFilters: n(r.saved_filters),
        carts: { total: n(r.carts), inPeriod: n(r.carts_p) },
        sharedLists: n(r.shared_lists),
        cartToOrderPct: n(r.carts) ? Math.round(n(r.orders_total) / n(r.carts) * 100) : null,
        updateRequests: { total: n(r.wur), inPeriod: n(r.wur_p), approved: n(r.wur_approved), superseded: n(r.wur_superseded), pending: n(r.wur_pending), rejected: n(r.wur_rejected), reviewed90d: n(r.wur_reviewed_90d) },
        bulkJobs: n(r.bulk_jobs), repriced30d: n(r.repriced_30d), featured: n(r.featured),
      };
    });

    // ───────────────────────── SYSTEM ─────────────────────────
    const systemP = safe('system', async () => {
      const [gw, autoApprove, cron] = await Promise.all([
        q(`select gateway, count(*) filter (where transaction_status in ('success','paid'))::int as ok, count(*) filter (where transaction_status='failed')::int as failed,
                  count(*) filter (where transaction_status='pending')::int as pending, coalesce(sum(amount) filter (where transaction_status='pending'),0) as pending_amount
             from transactions where type='deposit' and gateway = any(?) and created_at > now() - interval '90 days' group by 1`, [REAL_GATEWAYS]),
        one(`select max(completed_date) as last_auto_approved, count(*)::int as total from orders where auto_approved`),
        one(`select max(created_at) as last_email from transactions where email_sent_at is not null`),
      ]);
      const mem = process.memoryUsage();
      return {
        api: { uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(mem.rss / 1048576), node: process.version, pid: process.pid },
        gateways90d: gw.map((g) => ({ gateway: g.gateway, ok: n(g.ok), failed: n(g.failed), pending: n(g.pending), pendingAmount: money(g.pending_amount),
          successPct: (n(g.ok) + n(g.failed)) ? Math.round(n(g.ok) / (n(g.ok) + n(g.failed)) * 100) : null })),
        autoApprove: { lastRun: autoApprove.last_auto_approved, totalAutoApproved: n(autoApprove.total) },
        lastEmailSentAt: cron.last_email || null,
      };
    });

    // ───────────────────────── FEED ─────────────────────────
    const feedP = safe('feed', async () => {
      const rows = await q(`
        (select 'user' as kind, u.created_at as ts, u.id as ref, u.username as a, case when u.publisher and not coalesce(u.advertiser,false) then 'publisher' when u.advertiser then 'advertiser' else 'user' end as b, null::numeric as amount, null as c
           from up_users u order by u.created_at desc limit 8)
        union all
        (select 'order', o.created_at, o.id, o.website_url, o.order_status, o.total_amount, u.username
           from orders o left join orders_advertiser_lnk l on l.order_id=o.id left join up_users u on u.id=l.user_id order by o.created_at desc limit 8)
        union all
        (select 'money', t.created_at, t.id, case when t.type='deposit' and t.gateway='system' then 'internal_credit' else t.type end, t.gateway, t.amount, t.transaction_status
           from transactions t where t.type in ('deposit','withdrawal','refund','escrow_release','fee','payment') and not (t.type='fee' and coalesce(t.amount,0)=0) order by t.created_at desc limit 10)
        union all
        (select 'site', p.created_at, p.id, p.url, p.submission_status, null, null
           from publisher_websites p order by p.created_at desc limit 8)
        union all
        (select 'admin', a.created_at, a.id, a.action, u.username, (a.details->>'amount')::numeric, null
           from admin_audit_logs a left join admin_audit_logs_admin_user_lnk l on l.admin_audit_log_id=a.id left join up_users u on u.id=l.user_id order by a.created_at desc limit 6)
        union all
        (select 'application', r.created_at, r.id, r.agency_url, r.status, r.fee_amount, null
           from reseller_applications r order by r.created_at desc limit 4)
        order by ts desc limit 30`);
      return rows.map((r) => ({ kind: r.kind, ts: r.ts, ref: r.ref, a: r.a, b: r.b, amount: r.amount != null ? money(r.amount) : null, c: r.c }));
    });

    const [money_, transactions, orders, queues, users, supply, applications, activity, system, feed] = await Promise.all([
      moneyP, txP, ordersP, queuesP, usersP, supplyP, appsP, activityP, systemP, feedP,
    ]);

    ctx.send({
      period,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      money: money_, transactions, orders, queues, users, supply, applications, activity, system, feed,
    });
  },
};
