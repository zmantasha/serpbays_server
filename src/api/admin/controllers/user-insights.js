'use strict';

/**
 * User insights for the admin panel Users pages.
 *
 *   GET  /admin/users/directory?q&type&stage&country&funded&hasOrders&signedUp&internal&view&sort&dir&page&pageSize
 *   GET  /admin/users/:id/profile
 *   POST /admin/users/:id/notes      { note }
 *   PUT  /admin/users/:id/tags       { tags: string[] }
 *   PUT  /admin/users/:id/type       { advertiser: bool, publisher: bool }
 *
 * Notes and tags are stored as admin-audit-log rows (action 'user_note' /
 * 'user_tags', targetUser = the user) so no schema change is needed; the
 * latest 'user_tags' row is the current tag set.
 */

const REAL_GATEWAYS = ['stripe', 'paypal', 'razorpay', 'bank_transfer'];
const TEST_USER_RE = '(\\+|test|demo|dummy)';
const STAGES = ['signed_up', 'onboarding_skipped', 'site_added', 'site_approved', 'funded', 'ordered', 'repeat', 'sold'];
const SORTS = { spend: 'spend', balance: 'wallet', lastActive: 'last_active', createdAt: 'created_at', orders: 'orders', earned: 'earned', sites: 'sites' };

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function money(v) { return Math.round(n(v) * 100) / 100; }
function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : null; }

/** Per-user aggregate CTE. `where` is applied to up_users before aggregation. */
function aggSql(where = 'true') {
  return `
    with base as (
      select u.id, u.username, u.email, u.first_name, u.last_name, u.business_name, u.country, u.phone_number,
             coalesce(u.advertiser,false) advertiser, coalesce(u.publisher,false) publisher, coalesce(u.confirmed,false) confirmed, coalesce(u.blocked,false) blocked,
             u.marketplace_unlocked, u.marketplace_unlock_reason, u.created_at, u.onboarding_state,
             coalesce(w.balance,0) wallet, coalesce(w.main_balance,0) main_balance, coalesce(w.promo_balance,0) promo, coalesce(w.escrow_balance,0) escrow, coalesce(w.pending_withdrawal_balance,0) pending_wd,
             coalesce(o.orders,0) orders, coalesce(o.completed,0) completed, coalesce(o.spend,0) spend, o.last_order,
             coalesce(d.deposits,0) deposits, coalesce(d.deposit_count,0) deposit_count, d.last_deposit,
             coalesce(s.sites,0) sites, coalesce(s.approved_sites,0) approved_sites, s.last_site,
             coalesce(p.received,0) received, coalesce(p.sold,0) sold, coalesce(p.earned,0) earned, p.last_sale,
             t.tags,
             greatest(u.created_at, o.last_order, d.last_deposit, p.last_sale, s.last_site) last_active,
             (u.username ~* ?) or coalesce(t.tags @> '["internal"]'::jsonb, false) as is_internal
      from up_users u
      left join lateral (select w.* from user_wallets w join user_wallets_users_permissions_user_lnk l on l.user_wallet_id = w.id where l.user_id = u.id limit 1) w on true
      left join lateral (select count(*)::int orders, count(*) filter (where o.order_status='completed')::int completed, coalesce(sum(o.total_amount),0) spend, max(o.created_at) last_order
                           from orders o join orders_advertiser_lnk l on l.order_id = o.id where l.user_id = u.id) o on true
      left join lateral (select coalesce(sum(t.amount),0) deposits, count(*)::int deposit_count, max(t.created_at) last_deposit
                           from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id = t.id
                          where l.user_id = u.id and t.type='deposit' and t.transaction_status in ('success','paid') and t.gateway = any(?)) d on true
      left join lateral (select count(*)::int sites, count(*) filter (where p.submission_status='approved')::int approved_sites, max(p.created_at) last_site
                           from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id = p.id where l.user_id = u.id) s on true
      left join lateral (select count(*)::int received, count(*) filter (where o.order_status='completed')::int sold, coalesce(sum(o.total_amount) filter (where o.order_status='completed'),0) earned, max(o.created_at) last_sale
                           from orders o join orders_publisher_lnk l on l.order_id = o.id where l.user_id = u.id) p on true
      left join lateral (select a.details->'tags' tags from admin_audit_logs a join admin_audit_logs_target_user_lnk tl on tl.admin_audit_log_id = a.id
                          where tl.user_id = u.id and a.action = 'user_tags' order by a.created_at desc limit 1) t on true
      where ${where}
    ),
    agg as (
      select b.*,
        case when advertiser and publisher then 'both' when publisher then 'publisher' when advertiser then 'buyer' else 'unset' end as type,
        case
          when orders > 1 then 'repeat'
          when orders > 0 then 'ordered'
          when sold > 0 then 'sold'
          when deposits > 0 or wallet > 0 then 'funded'
          when approved_sites > 0 then 'site_approved'
          when sites > 0 then 'site_added'
          when coalesce((onboarding_state->'marketplace'->>'skipped')::boolean, false) then 'onboarding_skipped'
          else 'signed_up'
        end as stage
      from base b
    )`;
}
const AGG_BINDINGS = [TEST_USER_RE, REAL_GATEWAYS];

function rowOut(r) {
  return {
    id: r.id, username: r.username, email: r.email,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.business_name || r.username,
    business: r.business_name || '', country: r.country || '', phone: r.phone_number || '',
    type: r.type, stage: r.stage, confirmed: !!r.confirmed, blocked: !!r.blocked, marketplaceUnlocked: r.marketplace_unlocked === true, marketplaceUnlockReason: r.marketplace_unlock_reason || null,
    wallet: money(r.wallet), mainBalance: money(r.main_balance), promo: money(r.promo), escrow: money(r.escrow), pendingWithdrawal: money(r.pending_wd),
    orders: n(r.orders), completed: n(r.completed), spend: money(r.spend), lastOrder: r.last_order,
    deposits: money(r.deposits), depositCount: n(r.deposit_count), lastDeposit: r.last_deposit,
    sites: n(r.sites), approvedSites: n(r.approved_sites), received: n(r.received), sold: n(r.sold), earned: money(r.earned), lastSale: r.last_sale,
    tags: Array.isArray(r.tags) ? r.tags : [], isInternal: !!r.is_internal,
    lastActive: r.last_active, createdAt: r.created_at,
  };
}

async function audit(ctx, action, targetUserId, details) {
  return strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
    data: {
      adminUser: ctx.state.user.id, action, targetUser: targetUserId, details: details || {},
      ipAddress: ctx.request.ip || ctx.request.headers['x-forwarded-for'] || null,
      userAgent: ctx.request.headers['user-agent'] || null,
      createdAt: new Date(), updatedAt: new Date(),
    },
  });
}

module.exports = {
  // ───────────────────────── directory ─────────────────────────
  async directory(ctx) {
    const started = Date.now();
    const knex = strapi.db.connection;
    const qs = ctx.query || {};
    const page = Math.max(1, parseInt(qs.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(5, parseInt(qs.pageSize, 10) || 25));
    const sortCol = SORTS[qs.sort] || 'created_at';
    const dir = qs.dir === 'asc' ? 'asc' : 'desc';

    const conds = [];
    const binds = [...AGG_BINDINGS];
    const q = String(qs.q || '').trim();
    if (q) { conds.push(`(username ilike ? or email ilike ? or coalesce(first_name,'') ilike ? or coalesce(last_name,'') ilike ? or coalesce(business_name,'') ilike ?)`); for (let i = 0; i < 5; i++) binds.push(`%${q}%`); }
    if (['buyer', 'publisher', 'both', 'unset'].includes(qs.type)) { conds.push('type = ?'); binds.push(qs.type); }
    if (STAGES.includes(qs.stage)) { conds.push('stage = ?'); binds.push(qs.stage); }
    if (qs.country) { conds.push('coalesce(country,\'\') = ?'); binds.push(qs.country === 'unknown' ? '' : qs.country); }
    if (qs.funded === '1') conds.push('wallet > 0');
    if (qs.hasOrders === '1') conds.push('orders > 0');
    if (['7', '30', '90'].includes(String(qs.signedUp))) { conds.push(`created_at > now() - (? || ' days')::interval`); binds.push(String(qs.signedUp)); }
    if (qs.internal === 'hide') conds.push('not is_internal');
    if (qs.internal === 'only') conds.push('is_internal');
    if (qs.blocked === '1') conds.push('blocked');
    // Saved views
    switch (qs.view) {
      case 'callToday': conds.push(`stage in ('signed_up','onboarding_skipped') and type <> 'publisher' and not is_internal and not blocked`); break;
      case 'idleWallets': conds.push(`wallet > 0 and (last_order is null or last_order < now() - interval '30 days') and not is_internal`); break;
      case 'topBuyers': conds.push('orders > 0'); break;
      case 'unsoldPublishers': conds.push('approved_sites > 0 and sold = 0'); break;
      case 'newPublishers': conds.push(`type in ('publisher','both') and created_at > now() - interval '30 days'`); break;
      default: break;
    }
    const where = conds.length ? conds.join(' and ') : 'true';
    const orderBy = qs.view === 'topBuyers' && !qs.sort ? 'spend desc' : qs.view === 'idleWallets' && !qs.sort ? 'wallet desc' : `${sortCol} ${dir} nulls last`;

    const sql = `${aggSql('true')}
      select *, count(*) over() as total_count from agg where ${where} order by ${orderBy}, id desc limit ? offset ?`;
    const rowsR = await knex.raw(sql, [...binds, pageSize, (page - 1) * pageSize]);
    const rows = rowsR.rows || rowsR;
    const total = rows.length ? n(rows[0].total_count) : 0;

    // Tiles + saved-view counts + countries (whole population, independent of filters)
    const statsR = await knex.raw(`${aggSql('true')}
      select
        count(*) filter (where orders > 0)::int buyers_ever,
        count(*) filter (where sold > 0)::int publishers_sold,
        count(*) filter (where wallet > 0 and orders = 0)::int funded_never_ordered,
        coalesce(sum(wallet) filter (where wallet > 0 and orders = 0),0) funded_never_ordered_amount,
        count(*) filter (where created_at > now() - interval '7 days')::int signed_up_7d,
        count(*) filter (where stage in ('signed_up','onboarding_skipped') and type <> 'publisher' and not is_internal and not blocked)::int v_call_today,
        count(*) filter (where wallet > 0 and (last_order is null or last_order < now() - interval '30 days') and not is_internal)::int v_idle_wallets,
        coalesce(sum(wallet) filter (where wallet > 0 and (last_order is null or last_order < now() - interval '30 days') and not is_internal),0) v_idle_wallets_amount,
        count(*) filter (where orders > 0)::int v_top_buyers,
        count(*) filter (where approved_sites > 0 and sold = 0)::int v_unsold_publishers,
        count(*) filter (where type in ('publisher','both') and created_at > now() - interval '30 days')::int v_new_publishers,
        count(*) filter (where is_internal)::int internal_count,
        count(*)::int total
      from agg`, AGG_BINDINGS);
    const st = (statsR.rows || statsR)[0] || {};
    const countriesR = await knex.raw(`select coalesce(nullif(country,''),'unknown') country, count(*)::int count from up_users group by 1 order by 2 desc limit 30`);

    ctx.send({
      data: rows.map(rowOut),
      pagination: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
      tiles: { buyersEver: n(st.buyers_ever), publishersSold: n(st.publishers_sold), fundedNeverOrdered: n(st.funded_never_ordered), fundedNeverOrderedAmount: money(st.funded_never_ordered_amount), signedUp7d: n(st.signed_up_7d), total: n(st.total), internal: n(st.internal_count) },
      views: { callToday: n(st.v_call_today), idleWallets: n(st.v_idle_wallets), idleWalletsAmount: money(st.v_idle_wallets_amount), topBuyers: n(st.v_top_buyers), unsoldPublishers: n(st.v_unsold_publishers), newPublishers: n(st.v_new_publishers) },
      countries: (countriesR.rows || countriesR).map((r) => ({ country: r.country, count: n(r.count) })),
      tookMs: Date.now() - started,
    });
  },

  // ───────────────────────── profile ─────────────────────────
  async profile(ctx) {
    const started = Date.now();
    const id = parseInt(ctx.params.id, 10);
    if (!id) return ctx.badRequest('Invalid user id');
    const knex = strapi.db.connection;
    const q = async (sql, b = []) => { const r = await knex.raw(sql, b); return r.rows || r; };
    const one = async (sql, b) => (await q(sql, b))[0] || {};

    const head = await one(`${aggSql('u.id = ?')} select * from agg`, [...AGG_BINDINGS, id]);
    if (!head.id) return ctx.notFound('User not found');

    const [depByGw, txSums, wd, buyerStatus, buyerCats, buyerDr, buyerSpeed, buyerIntent, pubSites, pubOrders, pubRej, pubCodes, risk, dupes, timeline, notes] = await Promise.all([
      q(`select t.gateway, count(*) filter (where t.transaction_status in ('success','paid'))::int ok, count(*) filter (where t.transaction_status='failed')::int failed, count(*) filter (where t.transaction_status='pending')::int pending,
                coalesce(sum(t.amount) filter (where t.transaction_status in ('success','paid')),0) ok_amount, coalesce(sum(t.amount) filter (where t.transaction_status='failed'),0) failed_amount
           from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id=t.id where l.user_id=? and t.type='deposit' group by 1 order by ok_amount desc`, [id]),
      one(`select coalesce(sum(t.amount) filter (where t.type='payment' and t.transaction_status in ('success','paid')),0) spend,
                  coalesce(sum(t.amount) filter (where t.type='refund' and t.transaction_status in ('success','paid')),0) refunds, count(*) filter (where t.type='refund' and t.transaction_status in ('success','paid'))::int refund_count,
                  coalesce(sum(t.amount) filter (where t.type='promo' and t.transaction_status in ('success','paid')),0) promo_received,
                  coalesce(sum(t.amount) filter (where t.type='fee' and t.transaction_status in ('success','paid')),0) fees,
                  coalesce(sum(t.amount) filter (where t.type='deposit' and t.gateway='system' and t.transaction_status in ('success','paid')),0) internal_credits,
                  coalesce(sum(t.amount) filter (where t.type='escrow_release' and t.transaction_status in ('success','paid')),0) escrow_released,
                  count(*)::int tx_count
             from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id=t.id where l.user_id=?`, [id]),
      one(`select count(*)::int total, coalesce(sum(w.amount) filter (where w.withdrawal_status='paid'),0) paid, coalesce(sum(w.amount) filter (where w.withdrawal_status in ('pending','approved')),0) open_amount, count(*) filter (where w.withdrawal_status in ('pending','approved'))::int open_count
             from withdrawal_requests w join withdrawal_requests_publisher_lnk l on l.withdrawal_request_id=w.id where l.user_id=?`, [id]),
      q(`select o.order_status status, count(*)::int count, coalesce(sum(o.total_amount),0) amount from orders o join orders_advertiser_lnk l on l.order_id=o.id where l.user_id=? group by 1 order by 2 desc`, [id]),
      q(`select c category, count(*)::int count from orders o join orders_advertiser_lnk l on l.order_id=o.id, jsonb_array_elements_text(case when jsonb_typeof(o.website_category)='array' then o.website_category else '[]'::jsonb end) c where l.user_id=? group by 1 order by 2 desc limit 6`, [id]),
      q(`select case when o.website_ahrefs_dr>=60 then '60+' when o.website_ahrefs_dr>=40 then '40–59' when o.website_ahrefs_dr>=20 then '20–39' else '<20' end band, count(*)::int count, coalesce(avg(o.total_amount),0) avg_amount
           from orders o join orders_advertiser_lnk l on l.order_id=o.id where l.user_id=? group by 1`, [id]),
      one(`select avg(extract(epoch from o.accepted_date-o.order_date)/86400) accept_days, avg(extract(epoch from o.completed_date-o.order_date)/86400) complete_days, avg(o.total_amount) aov,
                  count(*) filter (where o.cancelled_by='advertiser')::int cancelled_by_user, count(*) filter (where o.revision_status is not null or o.dispute_date is not null)::int disputes
             from orders o join orders_advertiser_lnk l on l.order_id=o.id where l.user_id=?`, [id]),
      one(`select (select count(*)::int from carts_user_lnk where user_id=?) carts, (select count(*)::int from projects_owner_lnk where user_id=?) projects, (select count(*)::int from shortlists_owner_lnk where user_id=?) shortlists,
                  (select count(*)::int from saved_filters_users_permissions_user_lnk where user_id=?) saved_filters,
                  (select count(*)::int from communications c join communications_sender_lnk l on l.communication_id=c.id where l.user_id=?) messages_sent`, [id, id, id, id, id]),
      q(`select p.submission_status status, count(*)::int count, count(*) filter (where p.gsc_verified)::int gsc, count(*) filter (where coalesce(p.reseller_code,'')<>'')::int via_code
           from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=? group by 1 order by 2 desc`, [id]),
      one(`select count(*)::int received, count(*) filter (where o.accepted_date is not null)::int accepted, count(*) filter (where o.order_status='completed')::int completed,
                  count(*) filter (where o.order_status='rejected')::int rejected, count(*) filter (where o.order_status='cancelled' and o.cancelled_by='system')::int ignored, count(*) filter (where o.order_status='cancelled' and o.cancelled_by='publisher')::int cancelled_by_pub,
                  avg(extract(epoch from o.delivered_date-o.accepted_date)/86400) deliver_days, coalesce(sum(o.total_amount) filter (where o.order_status='completed'),0) earned, max(o.created_at) last_received
             from orders o join orders_publisher_lnk l on l.order_id=o.id where l.user_id=?`, [id]),
      q(`select left(coalesce(nullif(o.rejection_reason,''),'No reason given'),80) reason, count(*)::int count from orders o join orders_publisher_lnk l on l.order_id=o.id where l.user_id=? and o.order_status='rejected' group by 1 order by 2 desc limit 5`, [id]),
      q(`select p.reseller_code code, count(*)::int sites from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=? and coalesce(p.reseller_code,'')<>'' group by 1 order by 2 desc`, [id]),
      one(`select (select count(*)::int from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id=t.id where l.user_id=? and t.type='deposit' and t.transaction_status='failed') failed_deposits,
                  (select coalesce(sum(t.amount),0) from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id=t.id where l.user_id=? and t.type='deposit' and t.transaction_status='failed') failed_deposits_amount,
                  (select count(*)::int from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id=t.id where l.user_id=? and t.type='deposit' and t.transaction_status='pending') pending_deposits,
                  (select count(*)::int from admin_audit_logs a join admin_audit_logs_target_user_lnk l on l.admin_audit_log_id=a.id where l.user_id=? and a.action not in ('user_note','user_tags')) admin_actions`, [id, id, id, id]),
      q(`select u2.id, u2.username, u2.email, case when u2.business_name = u.business_name then 'same business name' else 'same email domain' end why
           from up_users u join up_users u2 on u2.id <> u.id and (
                (coalesce(u.business_name,'') <> '' and u2.business_name = u.business_name)
             or (split_part(u.email,'@',2) not in ('gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','proton.me','protonmail.com') and split_part(u2.email,'@',2) = split_part(u.email,'@',2)))
          where u.id=? limit 8`, [id]),
      q(`
        (select 'signup' kind, u.created_at ts, null::text a, null::text b, null::numeric amount, null::int ref from up_users u where u.id=?)
        union all
        (select 'onboarding', (u.onboarding_state->'marketplace'->>'completedAt')::timestamptz, case when (u.onboarding_state->'marketplace'->>'skipped')::boolean then 'skipped' else 'completed' end, null, null, null
           from up_users u where u.id=? and u.onboarding_state->'marketplace'->>'completedAt' is not null)
        union all
        (select 'transaction', t.created_at, t.type, coalesce(t.gateway,''), t.amount, t.id from transactions t join transactions_users_permissions_user_lnk l on l.transaction_id=t.id where l.user_id=? and t.transaction_status in ('success','paid','failed','pending'))
        union all
        (select 'order_placed', o.created_at, o.website_url, o.order_status, o.total_amount, o.id from orders o join orders_advertiser_lnk l on l.order_id=o.id where l.user_id=?)
        union all
        (select 'order_received', o.created_at, o.website_url, o.order_status, o.total_amount, o.id from orders o join orders_publisher_lnk l on l.order_id=o.id where l.user_id=?)
        union all
        (select 'order_accepted', o.accepted_date, o.website_url, null, o.total_amount, o.id from orders o where o.accepted_date is not null and (exists (select 1 from orders_advertiser_lnk l where l.order_id=o.id and l.user_id=?) or exists (select 1 from orders_publisher_lnk l where l.order_id=o.id and l.user_id=?)))
        union all
        (select 'order_delivered', o.delivered_date, o.website_url, null, o.total_amount, o.id from orders o where o.delivered_date is not null and (exists (select 1 from orders_advertiser_lnk l where l.order_id=o.id and l.user_id=?) or exists (select 1 from orders_publisher_lnk l where l.order_id=o.id and l.user_id=?)))
        union all
        (select 'order_completed', o.completed_date, o.website_url, case when o.auto_approved then 'auto' else 'manual' end, o.total_amount, o.id from orders o where o.completed_date is not null and (exists (select 1 from orders_advertiser_lnk l where l.order_id=o.id and l.user_id=?) or exists (select 1 from orders_publisher_lnk l where l.order_id=o.id and l.user_id=?)))
        union all
        (select 'order_cancelled', o.cancelled_at, o.website_url, coalesce(o.cancelled_by,'') || case when coalesce(o.cancellation_reason,'')<>'' then ': ' || left(o.cancellation_reason,80) else '' end, o.total_amount, o.id from orders o where o.cancelled_at is not null and (exists (select 1 from orders_advertiser_lnk l where l.order_id=o.id and l.user_id=?) or exists (select 1 from orders_publisher_lnk l where l.order_id=o.id and l.user_id=?)))
        union all
        (select 'order_rejected', o.rejected_date, o.website_url, left(coalesce(o.rejection_reason,''),80), o.total_amount, o.id from orders o where o.rejected_date is not null and (exists (select 1 from orders_advertiser_lnk l where l.order_id=o.id and l.user_id=?) or exists (select 1 from orders_publisher_lnk l where l.order_id=o.id and l.user_id=?)))
        union all
        (select 'site_submitted', p.created_at, p.url, p.submission_status, null, p.id from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=?)
        union all
        (select 'site_approved', p.approved_at, p.url, null, null, p.id from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=? and p.approved_at is not null)
        union all
        (select 'site_rejected', p.reviewed_at, p.url, left(coalesce(p.rejection_reason,''),80), null, p.id from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=? and p.submission_status='rejected' and p.reviewed_at is not null)
        union all
        (select 'withdrawal', w.created_at, w.withdrawal_status, coalesce(w.method,''), w.amount, w.id from withdrawal_requests w join withdrawal_requests_publisher_lnk l on l.withdrawal_request_id=w.id where l.user_id=?)
        union all
        (select 'withdrawal_paid', w.paid_at, 'paid', coalesce(w.method,''), w.amount, w.id from withdrawal_requests w join withdrawal_requests_publisher_lnk l on l.withdrawal_request_id=w.id where l.user_id=? and w.paid_at is not null)
        union all
        (select 'admin', a.created_at, a.action, coalesce(adm.username,'admin'), (a.details->>'amount')::numeric, a.id from admin_audit_logs a join admin_audit_logs_target_user_lnk tl on tl.admin_audit_log_id=a.id
            left join admin_audit_logs_admin_user_lnk al on al.admin_audit_log_id=a.id left join up_users adm on adm.id=al.user_id where tl.user_id=? and a.action not in ('user_note','user_tags'))
        union all
        (select 'note', a.created_at, a.details->>'note', coalesce(adm.username,'admin'), null, a.id from admin_audit_logs a join admin_audit_logs_target_user_lnk tl on tl.admin_audit_log_id=a.id
            left join admin_audit_logs_admin_user_lnk al on al.admin_audit_log_id=a.id left join up_users adm on adm.id=al.user_id where tl.user_id=? and a.action='user_note')
        order by ts desc nulls last limit 300`, Array(22).fill(id)),
      q(`select a.id, a.created_at, a.details->>'note' note, coalesce(adm.username,'admin') admin from admin_audit_logs a join admin_audit_logs_target_user_lnk tl on tl.admin_audit_log_id=a.id
            left join admin_audit_logs_admin_user_lnk al on al.admin_audit_log_id=a.id left join up_users adm on adm.id=al.user_id where tl.user_id=? and a.action='user_note' order by a.created_at desc limit 100`, [id]),
    ]);

    const bandOrder = ['60+', '40–59', '20–39', '<20'];
    const h = rowOut(head);
    ctx.send({
      user: h,
      money: {
        depositsByGateway: depByGw.map((g) => ({ gateway: g.gateway, ok: n(g.ok), failed: n(g.failed), pending: n(g.pending), okAmount: money(g.ok_amount), failedAmount: money(g.failed_amount) })),
        deposits: h.deposits, internalCredits: money(txSums.internal_credits), spend: money(txSums.spend), refunds: money(txSums.refunds), refundCount: n(txSums.refund_count),
        promoReceived: money(txSums.promo_received), promoLeft: h.promo, fees: money(txSums.fees), escrowReleased: money(txSums.escrow_released), txCount: n(txSums.tx_count),
        withdrawals: { total: n(wd.total), paid: money(wd.paid), openCount: n(wd.open_count), openAmount: money(wd.open_amount) },
        balances: { main: h.mainBalance, promo: h.promo, escrow: h.escrow, pendingWithdrawal: h.pendingWithdrawal, total: money(h.wallet + h.escrow + h.pendingWithdrawal) },
        weOwe: money(h.mainBalance + h.escrow + h.pendingWithdrawal),
      },
      buyer: {
        byStatus: buyerStatus.map((r) => ({ status: r.status, count: n(r.count), amount: money(r.amount) })),
        orders: h.orders, completed: h.completed, completionPct: pct(h.completed, h.orders), spend: h.spend, aov: money(buyerSpeed.aov),
        acceptDays: money(buyerSpeed.accept_days), completeDays: money(buyerSpeed.complete_days), cancelledByUser: n(buyerSpeed.cancelled_by_user), disputes: n(buyerSpeed.disputes),
        categories: buyerCats.map((r) => ({ category: r.category, count: n(r.count) })),
        drBands: bandOrder.map((b) => { const r = buyerDr.find((x) => x.band === b) || {}; return { band: b, count: n(r.count), avgAmount: money(r.avg_amount) }; }),
        intent: { carts: n(buyerIntent.carts), projects: n(buyerIntent.projects), shortlists: n(buyerIntent.shortlists), savedFilters: n(buyerIntent.saved_filters), messagesSent: n(buyerIntent.messages_sent), cartToOrderPct: pct(h.orders, n(buyerIntent.carts)) },
        lastOrder: h.lastOrder,
      },
      publisher: {
        sites: pubSites.map((r) => ({ status: r.status, count: n(r.count), gsc: n(r.gsc), viaCode: n(r.via_code) })), sitesTotal: h.sites, approvedSites: h.approvedSites,
        received: n(pubOrders.received), accepted: n(pubOrders.accepted), completed: n(pubOrders.completed), rejected: n(pubOrders.rejected), ignored: n(pubOrders.ignored), cancelledByPub: n(pubOrders.cancelled_by_pub),
        acceptancePct: pct(n(pubOrders.accepted), n(pubOrders.received)), completionPct: pct(n(pubOrders.completed), n(pubOrders.received)), deliverDays: money(pubOrders.deliver_days), earned: money(pubOrders.earned), lastReceived: pubOrders.last_received,
        rejectionReasons: pubRej.map((r) => ({ reason: r.reason, count: n(r.count) })),
        resellerCodes: pubCodes.map((r) => ({ code: r.code, sites: n(r.sites) })),
        withdrawals: { total: n(wd.total), paid: money(wd.paid), openCount: n(wd.open_count), openAmount: money(wd.open_amount) },
      },
      risk: {
        failedDeposits: n(risk.failed_deposits), failedDepositsAmount: money(risk.failed_deposits_amount), pendingDeposits: n(risk.pending_deposits), refunds: n(txSums.refund_count),
        disputes: n(buyerSpeed.disputes), cancelledByUser: n(buyerSpeed.cancelled_by_user) + n(pubOrders.cancelled_by_pub), ignoredOrders: n(pubOrders.ignored), adminActions: n(risk.admin_actions),
        isInternal: h.isInternal, blocked: h.blocked, unconfirmed: !h.confirmed,
        relatedAccounts: dupes.map((d) => ({ id: d.id, username: d.username, email: d.email, why: d.why })),
      },
      timeline: timeline.map((e) => ({ kind: e.kind, ts: e.ts, a: e.a, b: e.b, amount: e.amount != null ? money(e.amount) : null, ref: e.ref })),
      notes: notes.map((r) => ({ id: r.id, createdAt: r.created_at, note: r.note, admin: r.admin })),
      tags: h.tags,
      tookMs: Date.now() - started,
    });
  },

  // ───────────────────────── notes / tags / type ─────────────────────────
  async addNote(ctx) {
    const id = parseInt(ctx.params.id, 10);
    const note = String((ctx.request.body || {}).note || '').trim();
    if (!id) return ctx.badRequest('Invalid user id');
    if (!note) return ctx.badRequest('Note is empty');
    if (note.length > 2000) return ctx.badRequest('Note is too long (max 2000 characters)');
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id }, select: ['id'] });
    if (!user) return ctx.notFound('User not found');
    const row = await audit(ctx, 'user_note', id, { note });
    ctx.send({ id: row.id, createdAt: row.createdAt, note, admin: ctx.state.user.username });
  },

  async setTags(ctx) {
    const id = parseInt(ctx.params.id, 10);
    const raw = (ctx.request.body || {}).tags;
    if (!id) return ctx.badRequest('Invalid user id');
    if (!Array.isArray(raw)) return ctx.badRequest('tags must be an array');
    const tags = [...new Set(raw.map((t) => String(t || '').trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 12);
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id }, select: ['id'] });
    if (!user) return ctx.notFound('User not found');
    await audit(ctx, 'user_tags', id, { tags });
    ctx.send({ tags });
  },

  async setType(ctx) {
    const id = parseInt(ctx.params.id, 10);
    const body = ctx.request.body || {};
    if (!id) return ctx.badRequest('Invalid user id');
    if (typeof body.advertiser !== 'boolean' || typeof body.publisher !== 'boolean') return ctx.badRequest('advertiser and publisher must be booleans');
    if (!body.advertiser && !body.publisher) return ctx.badRequest('A user must be a buyer, a publisher, or both');
    const before = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id }, select: ['id', 'advertiser', 'publisher'] });
    if (!before) return ctx.notFound('User not found');
    await strapi.db.query('plugin::users-permissions.user').update({ where: { id }, data: { advertiser: body.advertiser, publisher: body.publisher } });
    await audit(ctx, 'user_type_change', id, { from: { advertiser: !!before.advertiser, publisher: !!before.publisher }, to: { advertiser: body.advertiser, publisher: body.publisher } });
    ctx.send({ advertiser: body.advertiser, publisher: body.publisher });
  },
};
