'use strict';

/**
 * Admin Analytics — trends and distributions (the dashboard answers
 * "what needs me now"; this answers "which direction is the business
 * going, and why").
 *
 *   GET /api/admin/analytics/overview?range=90d|12m|all
 *
 * 90d buckets by ISO week, 12m and all by month. Every series is filled
 * so each bucket appears exactly once (zeros for empty buckets). Blocks
 * run in parallel; a failing block returns null.
 */

const PLATFORM_FEE_RATE = 0.2;
const REAL_GATEWAYS = ['stripe', 'paypal', 'razorpay', 'bank_transfer'];
const TEST_USER_RE = '(\\+|test|demo|dummy)';
const TEST_SITE_RE = '(test|dummy|example)';

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function money(v) { return Math.round(n(v) * 100) / 100; }
function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : null; }

function rangeSpec(range) {
  if (range === '90d') return { key: '90d', grain: 'week', fmt: 'YYYY-MM-DD', sinceSql: "date_trunc('week', now()) - interval '12 weeks'" };
  if (range === 'all') return { key: 'all', grain: 'month', fmt: 'YYYY-MM', sinceSql: null };
  return { key: '12m', grain: 'month', fmt: 'YYYY-MM', sinceSql: "date_trunc('month', now()) - interval '11 months'" };
}

function labelOf(d, grain) {
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0');
  if (grain === 'month') return `${y}-${m}`;
  return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Build the ordered bucket labels from `start` (UTC) up to now. */
function bucketsFrom(start, grain) {
  const out = [];
  const d = new Date(start);
  const now = new Date();
  if (grain === 'month') d.setUTCDate(1); else { const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day); }
  d.setUTCHours(0, 0, 0, 0);
  while (d <= now && out.length < 400) {
    out.push(labelOf(d, grain));
    if (grain === 'month') d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

module.exports = {
  async overview(ctx) {
    const started = Date.now();
    const spec = rangeSpec(ctx.query.range);
    const knex = strapi.db.connection;
    const q = async (sql, b = []) => { const r = await knex.raw(sql, b); return r.rows || r; };
    const one = async (sql, b) => (await q(sql, b))[0] || {};
    const safe = (label, fn) => fn().catch((err) => { strapi.log.error(`[ANALYTICS] block "${label}" failed: ${err.message}`); return null; });

    const B = (col) => `to_char(date_trunc('${spec.grain}', ${col}), '${spec.fmt}')`;
    const since = (col) => (spec.sinceSql ? `${col} >= ${spec.sinceSql}` : 'true');

    // Bucket labels: for 'all', start at the first order/user ever.
    let buckets;
    if (spec.sinceSql) {
      const r = await one(`select ${spec.sinceSql} as s`);
      buckets = bucketsFrom(new Date(r.s), spec.grain);
    } else {
      const r = await one(`select least((select min(created_at) from up_users), (select min(created_at) from orders), (select min(created_at) from transactions)) as s`);
      buckets = bucketsFrom(new Date(r.s || Date.now()), spec.grain);
    }
    const fill = (rows, defaults, key = 'b') => {
      const by = new Map(rows.map((r) => [r[key], r]));
      return buckets.map((b) => { const r = by.get(b) || {}; const o = { period: b }; for (const k of Object.keys(defaults)) o[k] = typeof defaults[k] === 'number' ? money(r[k] != null ? r[k] : defaults[k]) : (r[k] != null ? r[k] : defaults[k]); return o; });
    };

    // ── 1. Money over time ──
    const moneyP = safe('money', async () => {
      const [orders, tx, wd] = await Promise.all([
        q(`select ${B('created_at')} b, count(*)::int orders, coalesce(sum(total_amount),0) gmv, coalesce(sum(total_amount) filter (where order_status='completed'),0) gmv_completed from orders where ${since('created_at')} group by 1`),
        q(`select ${B('created_at')} b,
                  coalesce(sum(amount) filter (where type='deposit' and transaction_status in ('success','paid') and gateway = any(?)),0) cash_in,
                  coalesce(sum(amount) filter (where type='deposit' and transaction_status in ('success','paid') and gateway='system'),0) internal,
                  coalesce(sum(amount) filter (where type='refund' and transaction_status in ('success','paid')),0) refunds,
                  coalesce(sum(amount) filter (where type='fee' and transaction_status in ('success','paid')),0) fees,
                  coalesce(sum(amount) filter (where type='payment' and transaction_status in ('success','paid')),0) spend,
                  coalesce(sum(amount) filter (where type='promo' and transaction_status in ('success','paid')),0) promo
             from transactions where ${since('created_at')} group by 1`, [REAL_GATEWAYS]),
        q(`select ${B('coalesce(paid_at, updated_at)')} b, coalesce(sum(amount),0) paid from withdrawal_requests where withdrawal_status='paid' and ${since('coalesce(paid_at, updated_at)')} group by 1`),
      ]);
      const o = fill(orders, { orders: 0, gmv: 0, gmv_completed: 0 });
      const t = fill(tx, { cash_in: 0, internal: 0, refunds: 0, fees: 0, spend: 0, promo: 0 });
      const w = fill(wd, { paid: 0 });
      const series = buckets.map((b, i) => ({
        period: b, orders: n(o[i].orders), gmv: o[i].gmv, gmvCompleted: o[i].gmv_completed, cashIn: t[i].cash_in, internal: t[i].internal, refunds: t[i].refunds, spend: t[i].spend, promo: t[i].promo,
        payouts: w[i].paid, netRevenue: money(t[i].fees + w[i].paid * (PLATFORM_FEE_RATE / (1 - PLATFORM_FEE_RATE))),
      }));
      const tot = series.reduce((a, s) => ({ gmv: a.gmv + s.gmv, cashIn: a.cashIn + s.cashIn, refunds: a.refunds + s.refunds, netRevenue: a.netRevenue + s.netRevenue, orders: a.orders + s.orders, payouts: a.payouts + s.payouts }), { gmv: 0, cashIn: 0, refunds: 0, netRevenue: 0, orders: 0, payouts: 0 });
      return { series, totals: { gmv: money(tot.gmv), cashIn: money(tot.cashIn), refunds: money(tot.refunds), netRevenue: money(tot.netRevenue), orders: tot.orders, payouts: money(tot.payouts), takeRatePct: pct(tot.netRevenue, tot.gmv), refundRatePct: pct(tot.refunds, tot.gmv) } };
    });

    // ── 2. Order funnel over time ──
    const funnelP = safe('funnel', async () => {
      const [rows, overall] = await Promise.all([
        q(`select ${B('created_at')} b, count(*)::int placed, count(*) filter (where accepted_date is not null)::int accepted, count(*) filter (where delivered_date is not null)::int delivered,
                  count(*) filter (where order_status='completed')::int completed, count(*) filter (where order_status='cancelled')::int cancelled, count(*) filter (where order_status='rejected')::int rejected
             from orders where ${since('created_at')} group by 1`),
        one(`select count(*)::int placed, count(*) filter (where accepted_date is not null)::int accepted, count(*) filter (where delivered_date is not null)::int delivered, count(*) filter (where order_status='completed')::int completed,
                    count(*) filter (where order_status='cancelled')::int cancelled, count(*) filter (where order_status='rejected')::int rejected from orders where ${since('created_at')}`),
      ]);
      const series = fill(rows, { placed: 0, accepted: 0, delivered: 0, completed: 0, cancelled: 0, rejected: 0 }).map((r) => ({ ...r, completionPct: pct(r.completed, r.placed) }));
      return { series, overall: { placed: n(overall.placed), accepted: n(overall.accepted), delivered: n(overall.delivered), completed: n(overall.completed), cancelled: n(overall.cancelled), rejected: n(overall.rejected), completionPct: pct(n(overall.completed), n(overall.placed)) } };
    });

    // ── 3. Why orders die ──
    const lostP = safe('lost', async () => {
      const [by, reasons, rej, pubs] = await Promise.all([
        q(`select coalesce(nullif(cancelled_by,''),'unknown') who, count(*)::int count, coalesce(sum(total_amount),0) amount from orders where order_status='cancelled' and ${since('created_at')} group by 1 order by 2 desc`),
        q(`select case when cancellation_reason ilike 'Auto-cancelled: Not accepted%' then 'Publisher never accepted (auto-cancel)'
                       when cancellation_reason ilike 'Auto-cancelled: Not delivered%' then 'Publisher never delivered (auto-cancel)'
                       when coalesce(cancellation_reason,'')='' then 'No reason given'
                       when cancellation_reason ~* '^(test|rer|na|n/a)' then 'Test / junk'
                       else left(cancellation_reason, 80) end reason, count(*)::int count
             from orders where order_status='cancelled' and ${since('created_at')} group by 1 order by 2 desc limit 10`),
        q(`select case when coalesce(rejection_reason,'')='' or rejection_reason ilike 'Please provide%' then 'No reason given' when rejection_reason ~* '^(test|na)' then 'Test / junk' else left(rejection_reason,80) end reason, count(*)::int count
             from orders where order_status='rejected' and ${since('created_at')} group by 1 order by 2 desc limit 10`),
        q(`select u.id, u.username, count(*)::int orders, count(*) filter (where o.order_status='completed')::int completed, count(*) filter (where o.order_status='rejected')::int rejected,
                  count(*) filter (where o.order_status='cancelled' and o.cancelled_by='system')::int ignored, count(*) filter (where o.order_status='cancelled' and o.cancelled_by='publisher')::int cancelled_by_pub
             from orders o join orders_publisher_lnk l on l.order_id=o.id join up_users u on u.id=l.user_id where ${since('o.created_at')} group by 1,2 having count(*) filter (where o.order_status in ('rejected','cancelled')) > 0 order by (count(*) filter (where o.order_status in ('rejected','cancelled'))) desc limit 8`),
      ]);
      return {
        cancelledBy: by.map((r) => ({ who: r.who, count: n(r.count), amount: money(r.amount) })),
        cancellationReasons: reasons.map((r) => ({ reason: r.reason, count: n(r.count) })),
        rejectionReasons: rej.map((r) => ({ reason: r.reason, count: n(r.count) })),
        publishersLosing: pubs.map((r) => ({ id: r.id, username: r.username, orders: n(r.orders), completed: n(r.completed), rejected: n(r.rejected), ignored: n(r.ignored), cancelledByPub: n(r.cancelled_by_pub), lossPct: pct(n(r.rejected) + n(r.ignored) + n(r.cancelled_by_pub), n(r.orders)) })),
      };
    });

    // ── 4. Speed ──
    const speedP = safe('speed', async () => {
      const bucket = (expr) => `case when ${expr} < 1 then '<1 d' when ${expr} < 3 then '1–3 d' when ${expr} < 7 then '3–7 d' else '7 d+' end`;
      const acc = `extract(epoch from accepted_date-order_date)/86400`, del = `extract(epoch from delivered_date-accepted_date)/86400`, app = `extract(epoch from completed_date-delivered_date)/86400`;
      const [a, d, ap, series] = await Promise.all([
        q(`select ${bucket(acc)} k, count(*)::int c from orders where accepted_date is not null and ${since('created_at')} group by 1`),
        q(`select ${bucket(del)} k, count(*)::int c from orders where delivered_date is not null and accepted_date is not null and ${since('created_at')} group by 1`),
        q(`select ${bucket(app)} k, count(*)::int c from orders where completed_date is not null and delivered_date is not null and ${since('created_at')} group by 1`),
        q(`select ${B('created_at')} b, avg(${acc}) accept_days, avg(${del}) deliver_days, avg(${app}) approve_days from orders where ${since('created_at')} group by 1`),
      ]);
      const order = ['<1 d', '1–3 d', '3–7 d', '7 d+'];
      const dist = (rows) => order.map((k) => ({ bucket: k, count: n((rows.find((r) => r.k === k) || {}).c) }));
      return { accept: dist(a), deliver: dist(d), approve: dist(ap), series: fill(series, { accept_days: 0, deliver_days: 0, approve_days: 0 }).map((r) => ({ period: r.period, acceptDays: r.accept_days, deliverDays: r.deliver_days, approveDays: r.approve_days })) };
    });

    // ── 5. Buyers ──
    const buyersP = safe('buyers', async () => {
      const [cohort, ltv, top, countries, lag] = await Promise.all([
        q(`select to_char(date_trunc('month',u.created_at),'YYYY-MM') m, count(*)::int signups,
                  count(*) filter (where u.advertiser)::int advertisers,
                  count(*) filter (where exists (select 1 from transactions t join transactions_users_permissions_user_lnk tl on tl.transaction_id=t.id where tl.user_id=u.id and t.type='deposit' and t.transaction_status in ('success','paid') and t.gateway = any(?)))::int deposited,
                  count(*) filter (where exists (select 1 from orders_advertiser_lnk l where l.user_id=u.id))::int ordered,
                  count(*) filter (where (select count(*) from orders_advertiser_lnk l where l.user_id=u.id) > 1)::int repeat
             from up_users u where ${since('u.created_at')} group by 1 order by 1`, [REAL_GATEWAYS]),
        q(`select case when s < 50 then '<$50' when s < 200 then '$50–199' when s < 500 then '$200–499' else '$500+' end band, count(*)::int buyers, coalesce(sum(s),0) spend from
             (select l.user_id, sum(o.total_amount) s from orders o join orders_advertiser_lnk l on l.order_id=o.id group by 1) x group by 1 order by min(s)`),
        q(`select u.id, u.username, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) name, u.country, count(*)::int orders, count(*) filter (where o.order_status='completed')::int completed,
                  coalesce(sum(o.total_amount),0) spend, min(o.created_at) first_order, max(o.created_at) last_order,
                  (u.username ~* ?) is_test
             from orders o join orders_advertiser_lnk l on l.order_id=o.id join up_users u on u.id=l.user_id where ${since('o.created_at')} group by 1,2,3,4 order by spend desc limit 10`, [TEST_USER_RE]),
        q(`select coalesce(nullif(u.country,''),'unknown') country, count(distinct u.id)::int buyers, coalesce(sum(o.total_amount),0) spend from orders o join orders_advertiser_lnk l on l.order_id=o.id join up_users u on u.id=l.user_id group by 1 order by 3 desc limit 8`),
        one(`select avg(extract(epoch from o.first_order - d.first_dep)/86400) avg_days, percentile_cont(0.5) within group (order by extract(epoch from o.first_order - d.first_dep)/86400) median_days, count(*)::int buyers from
             (select tl.user_id, min(t.created_at) first_dep from transactions t join transactions_users_permissions_user_lnk tl on tl.transaction_id=t.id where t.type='deposit' and t.transaction_status in ('success','paid') group by 1) d
             join (select l.user_id, min(o.created_at) first_order from orders o join orders_advertiser_lnk l on l.order_id=o.id group by 1) o on o.user_id=d.user_id`),
      ]);
      return {
        cohorts: cohort.map((r) => ({ month: r.m, signups: n(r.signups), advertisers: n(r.advertisers), deposited: n(r.deposited), ordered: n(r.ordered), repeat: n(r.repeat), depositPct: pct(n(r.deposited), n(r.signups)), orderPct: pct(n(r.ordered), n(r.signups)) })),
        ltv: ltv.map((r) => ({ band: r.band, buyers: n(r.buyers), spend: money(r.spend) })),
        top: top.map((r) => ({ id: r.id, username: r.username, name: r.name, country: r.country, orders: n(r.orders), completed: n(r.completed), spend: money(r.spend), firstOrder: r.first_order, lastOrder: r.last_order, isTest: !!r.is_test })),
        countries: countries.map((r) => ({ country: r.country, buyers: n(r.buyers), spend: money(r.spend) })),
        depositToOrder: { avgDays: money(lag.avg_days), medianDays: money(lag.median_days), buyers: n(lag.buyers) },
      };
    });

    // ── 6. Publishers ──
    const publishersP = safe('publishers', async () => {
      const [table, noSales, active] = await Promise.all([
        q(`select u.id, u.username, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) name, u.country,
                  count(*)::int orders, count(*) filter (where o.order_status='completed')::int completed, count(*) filter (where o.order_status='rejected')::int rejected, count(*) filter (where o.order_status='cancelled')::int cancelled,
                  coalesce(sum(o.total_amount) filter (where o.order_status='completed'),0) earned,
                  avg(extract(epoch from o.delivered_date-o.accepted_date)/86400) deliver_days,
                  (select count(*)::int from publisher_websites_current_publisher_id_lnk pl where pl.user_id=u.id) sites,
                  (u.username ~* ?) is_test
             from orders o join orders_publisher_lnk l on l.order_id=o.id join up_users u on u.id=l.user_id where ${since('o.created_at')} group by 1,2,3,4 order by earned desc limit 10`, [TEST_USER_RE]),
        one(`select count(distinct l.user_id)::int pubs, count(*)::int sites from publisher_websites_current_publisher_id_lnk l join publisher_websites p on p.id=l.publisher_website_id where p.submission_status='approved' and l.user_id not in (select user_id from orders_publisher_lnk)`),
        q(`select ${B('o.created_at')} b, count(distinct l.user_id)::int pubs from orders o join orders_publisher_lnk l on l.order_id=o.id where ${since('o.created_at')} group by 1`),
      ]);
      return {
        table: table.map((r) => ({ id: r.id, username: r.username, name: r.name, country: r.country, orders: n(r.orders), completed: n(r.completed), rejected: n(r.rejected), cancelled: n(r.cancelled), earned: money(r.earned), deliverDays: money(r.deliver_days), sites: n(r.sites), completionPct: pct(n(r.completed), n(r.orders)), isTest: !!r.is_test })),
        approvedButNeverSold: { publishers: n(noSales.pubs), sites: n(noSales.sites) },
        activeSeries: fill(active, { pubs: 0 }).map((r) => ({ period: r.period, publishers: n(r.pubs) })),
      };
    });

    // ── 7. What sells ──
    const sellsP = safe('sells', async () => {
      const [cat, dr, price, svc, sites, aov] = await Promise.all([
        q(`select c category, count(*)::int orders, count(*) filter (where o.order_status='completed')::int completed, coalesce(sum(o.total_amount),0) amount
             from orders o, jsonb_array_elements_text(case when jsonb_typeof(o.website_category)='array' then o.website_category else '[]'::jsonb end) c where ${since('o.created_at')} group by 1 order by 2 desc limit 10`),
        q(`select case when website_ahrefs_dr>=60 then '60+' when website_ahrefs_dr>=40 then '40–59' when website_ahrefs_dr>=20 then '20–39' else '<20' end band, count(*)::int orders, count(*) filter (where order_status='completed')::int completed, coalesce(avg(total_amount),0) avg_amount
             from orders where ${since('created_at')} group by 1`),
        q(`select case when total_amount<50 then '<$50' when total_amount<100 then '$50–99' when total_amount<200 then '$100–199' else '$200+' end band, count(*)::int orders, count(*) filter (where order_status='completed')::int completed, coalesce(sum(total_amount),0) amount
             from orders where ${since('created_at')} group by 1 order by min(total_amount)`),
        q(`select coalesce(nullif(service_type,''),'guest_post') service, count(*)::int orders, count(*) filter (where order_status='completed')::int completed, coalesce(sum(total_amount),0) amount from orders where ${since('created_at')} group by 1 order by 2 desc`),
        q(`select website_url url, max(website_ahrefs_dr) dr, count(*)::int orders, count(*) filter (where order_status='completed')::int completed, coalesce(sum(total_amount),0) amount, (website_url ~* ?) is_test
             from orders where ${since('created_at')} group by 1 order by 3 desc, 5 desc limit 10`, [TEST_SITE_RE]),
        q(`select ${B('created_at')} b, avg(total_amount) aov, count(*)::int orders from orders where ${since('created_at')} group by 1`),
      ]);
      const bandOrder = ['60+', '40–59', '20–39', '<20'];
      return {
        byCategory: cat.map((r) => ({ category: r.category, orders: n(r.orders), completed: n(r.completed), amount: money(r.amount) })),
        byDrBand: bandOrder.map((b) => { const r = dr.find((x) => x.band === b) || {}; return { band: b, orders: n(r.orders), completed: n(r.completed), avgAmount: money(r.avg_amount) }; }),
        byPriceBand: price.map((r) => ({ band: r.band, orders: n(r.orders), completed: n(r.completed), amount: money(r.amount) })),
        byService: svc.map((r) => ({ service: r.service, orders: n(r.orders), completed: n(r.completed), amount: money(r.amount) })),
        topSites: sites.map((r) => ({ url: r.url, dr: n(r.dr), orders: n(r.orders), completed: n(r.completed), amount: money(r.amount), isTest: !!r.is_test })),
        aovSeries: fill(aov, { aov: 0, orders: 0 }).map((r) => ({ period: r.period, aov: r.aov, orders: n(r.orders) })),
      };
    });

    // ── 8. Supply vs demand ──
    const supplyDemandP = safe('supplyDemand', async () => {
      const [supplyCat, demandCat, supplyDr, demandDr, never] = await Promise.all([
        q(`select c category, count(*)::int listings, percentile_cont(0.5) within group (order by m.price) med_price from marketplaces m, jsonb_array_elements_text(case when jsonb_typeof(m.category)='array' then m.category else '[]'::jsonb end) c where m.status='active' and m.price>0 group by 1 order by 2 desc limit 14`),
        q(`select c category, count(*)::int orders from orders o, jsonb_array_elements_text(case when jsonb_typeof(o.website_category)='array' then o.website_category else '[]'::jsonb end) c group by 1`),
        q(`select case when ahrefs_dr>=60 then '60+' when ahrefs_dr>=40 then '40–59' when ahrefs_dr>=20 then '20–39' else '<20' end band, count(*)::int listings, percentile_cont(0.5) within group (order by price) med_price, count(*) filter (where price>=500)::int premium from marketplaces where status='active' and price>0 group by 1`),
        q(`select case when website_ahrefs_dr>=60 then '60+' when website_ahrefs_dr>=40 then '40–59' when website_ahrefs_dr>=20 then '20–39' else '<20' end band, count(*)::int orders, coalesce(avg(total_amount),0) avg_paid from orders group by 1`),
        one(`select count(*)::int active, count(*) filter (where url not in (select distinct website_url from orders where website_url is not null))::int never_sold from marketplaces where status='active'`),
      ]);
      const norm = (s) => String(s || '').replace(/&/g, ' & ').replace(/\s+/g, ' ').trim().toLowerCase();
      const demandByCat = new Map(); demandCat.forEach((r) => demandByCat.set(norm(r.category), n(r.orders) + (demandByCat.get(norm(r.category)) || 0)));
      const totalListings = supplyCat.reduce((a, r) => a + n(r.listings), 0) || 1;
      const totalOrders = demandCat.reduce((a, r) => a + n(r.orders), 0) || 1;
      const bandOrder = ['60+', '40–59', '20–39', '<20'];
      return {
        byCategory: supplyCat.map((r) => ({ category: r.category, listings: n(r.listings), medPrice: money(r.med_price), orders: demandByCat.get(norm(r.category)) || 0, supplySharePct: pct(n(r.listings), totalListings), demandSharePct: pct(demandByCat.get(norm(r.category)) || 0, totalOrders) })),
        byDrBand: bandOrder.map((b) => { const s = supplyDr.find((x) => x.band === b) || {}; const d = demandDr.find((x) => x.band === b) || {}; return { band: b, listings: n(s.listings), medPrice: money(s.med_price), premium: n(s.premium), orders: n(d.orders), avgPaid: money(d.avg_paid) }; }),
        neverSold: { active: n(never.active), neverSold: n(never.never_sold), pct: pct(n(never.never_sold), n(never.active)) },
      };
    });

    // ── 9. Payments ──
    const paymentsP = safe('payments', async () => {
      const [series, byGw, stuck] = await Promise.all([
        q(`select ${B('created_at')} b, gateway, count(*) filter (where transaction_status in ('success','paid'))::int ok, count(*) filter (where transaction_status='failed')::int failed,
                  coalesce(sum(amount) filter (where transaction_status in ('success','paid')),0) ok_amount, coalesce(sum(amount) filter (where transaction_status='failed'),0) failed_amount
             from transactions where type='deposit' and gateway = any(?) and ${since('created_at')} group by 1,2`, [REAL_GATEWAYS]),
        q(`select gateway, count(*) filter (where transaction_status in ('success','paid'))::int ok, count(*) filter (where transaction_status='failed')::int failed, count(*) filter (where transaction_status='pending')::int pending,
                  coalesce(avg(amount) filter (where transaction_status in ('success','paid')),0) avg_ok, coalesce(sum(amount) filter (where transaction_status in ('success','paid')),0) ok_amount, coalesce(sum(amount) filter (where transaction_status='failed'),0) failed_amount, coalesce(sum(amount) filter (where transaction_status='pending'),0) pending_amount
             from transactions where type='deposit' and gateway = any(?) and ${since('created_at')} group by 1 order by ok_amount desc`, [REAL_GATEWAYS]),
        q(`select id, gateway, amount, created_at from transactions where type='deposit' and transaction_status='pending' order by created_at desc limit 8`),
      ]);
      const gws = [...new Set(series.map((r) => r.gateway))];
      const perGateway = gws.map((g) => ({ gateway: g, series: fill(series.filter((r) => r.gateway === g), { ok: 0, failed: 0, ok_amount: 0, failed_amount: 0 }).map((r) => ({ period: r.period, ok: n(r.ok), failed: n(r.failed), okAmount: r.ok_amount, failedAmount: r.failed_amount })) }));
      return {
        perGateway,
        byGateway: byGw.map((r) => ({ gateway: r.gateway, ok: n(r.ok), failed: n(r.failed), pending: n(r.pending), successPct: pct(n(r.ok), n(r.ok) + n(r.failed)), avgOk: money(r.avg_ok), okAmount: money(r.ok_amount), failedAmount: money(r.failed_amount), pendingAmount: money(r.pending_amount) })),
        stuckPending: stuck.map((r) => ({ id: r.id, gateway: r.gateway, amount: money(r.amount), createdAt: r.created_at })),
      };
    });

    // ── 10. Wallet economics ──
    const walletP = safe('wallet', async () => {
      const [series, idle, promo] = await Promise.all([
        q(`select ${B('created_at')} b,
                  coalesce(sum(amount) filter (where type='deposit' and transaction_status in ('success','paid') and gateway = any(?)),0) deposits,
                  coalesce(sum(amount) filter (where type='payment' and transaction_status in ('success','paid')),0) spend,
                  coalesce(sum(amount) filter (where type='withdrawal' and transaction_status in ('success','paid','approved')),0) withdrawals,
                  coalesce(sum(amount) filter (where type='promo' and transaction_status in ('success','paid')),0) promo
             from transactions where ${since('created_at')} group by 1`, [REAL_GATEWAYS]),
        q(`select case when w.updated_at < now()-interval '180 days' then 'idle 180 d+' when w.updated_at < now()-interval '90 days' then 'idle 90–180 d' when w.updated_at < now()-interval '30 days' then 'idle 30–90 d' else 'moved in last 30 d' end k,
                  count(*) filter (where w.balance > 0)::int wallets, coalesce(sum(w.balance),0) balance from user_wallets w group by 1`),
        one(`select (select coalesce(sum(amount),0) from transactions where type='promo' and transaction_status in ('success','paid')) issued, (select coalesce(sum(promo_balance),0) from user_wallets) unspent,
                    (select coalesce(sum(main_balance),0) from user_wallets) main, (select coalesce(sum(escrow_balance),0) from user_wallets) escrow, (select coalesce(sum(pending_withdrawal_balance),0) from user_wallets) pending_wd`),
      ]);
      const order = ['moved in last 30 d', 'idle 30–90 d', 'idle 90–180 d', 'idle 180 d+'];
      return {
        series: fill(series, { deposits: 0, spend: 0, withdrawals: 0, promo: 0 }),
        idle: order.map((k) => { const r = idle.find((x) => x.k === k) || {}; return { bucket: k, wallets: n(r.wallets), balance: money(r.balance) }; }),
        promo: { issued: money(promo.issued), unspent: money(promo.unspent), spentPct: pct(n(promo.issued) - n(promo.unspent), n(promo.issued)) },
        liability: { main: money(promo.main), promo: money(promo.unspent), escrow: money(promo.escrow), pendingWithdrawal: money(promo.pending_wd), total: money(n(promo.main) + n(promo.unspent) + n(promo.escrow) + n(promo.pending_wd)) },
      };
    });

    // ── 11. Growth & retention ──
    const growthP = safe('growth', async () => {
      const [signups, retention, comms] = await Promise.all([
        q(`select ${B('created_at')} b, count(*)::int total, count(*) filter (where publisher and not coalesce(advertiser,false))::int publishers, count(*) filter (where advertiser)::int advertisers, count(*) filter (where coalesce(country,'')='')::int no_country from up_users where ${since('created_at')} group by 1`),
        one(`select count(*)::int buyers, count(*) filter (where months >= 2)::int multi_month, count(*) filter (where last_order > now() - interval '90 days')::int active_90d from
             (select l.user_id, count(distinct date_trunc('month', o.created_at)) months, max(o.created_at) last_order from orders o join orders_advertiser_lnk l on l.order_id=o.id group by 1) x`),
        q(`select ${B('created_at')} b, count(*)::int comms, count(*) filter (where is_unread)::int unread from communications where ${since('created_at')} group by 1`),
      ]);
      return {
        signups: fill(signups, { total: 0, publishers: 0, advertisers: 0, no_country: 0 }).map((r) => ({ period: r.period, total: n(r.total), publishers: n(r.publishers), advertisers: n(r.advertisers), noCountry: n(r.no_country) })),
        retention: { buyers: n(retention.buyers), multiMonth: n(retention.multi_month), multiMonthPct: pct(n(retention.multi_month), n(retention.buyers)), active90d: n(retention.active_90d) },
        communications: fill(comms, { comms: 0, unread: 0 }).map((r) => ({ period: r.period, count: n(r.comms), unread: n(r.unread) })),
      };
    });

    // ── 12. Supply pipeline ──
    const pipelineP = safe('pipeline', async () => {
      const [series, backlog, perPub, drNew] = await Promise.all([
        q(`select ${B('created_at')} b, count(*)::int submitted, count(*) filter (where submission_status='approved')::int approved, count(*) filter (where submission_status='rejected')::int rejected,
                  count(*) filter (where coalesce(reseller_code,'')<>'')::int via_reseller, avg(extract(epoch from approved_at-created_at)/86400) filter (where approved_at is not null) review_days
             from publisher_websites where ${since('created_at')} group by 1`),
        q(`select case when age < 7 then '<7 d' when age < 30 then '7–30 d' when age < 90 then '30–90 d' else '90 d+' end k, count(*)::int count from (select extract(epoch from now()-created_at)/86400 age from publisher_websites where submission_status in ('approval_pending','pending_verification')) x group by 1`),
        q(`select case when c=1 then '1 site' when c<=5 then '2–5' when c<=20 then '6–20' else '20+' end k, count(*)::int publishers, sum(c)::int sites from (select user_id, count(*) c from publisher_websites_current_publisher_id_lnk group by 1) x group by 1 order by min(c)`),
        q(`select case when ahrefs_dr>=60 then '60+' when ahrefs_dr>=40 then '40–59' when ahrefs_dr>=20 then '20–39' else '<20' end band, count(*)::int count from publisher_websites where ${since('created_at')} group by 1`),
      ]);
      const ageOrder = ['<7 d', '7–30 d', '30–90 d', '90 d+'];
      const bandOrder = ['60+', '40–59', '20–39', '<20'];
      return {
        series: fill(series, { submitted: 0, approved: 0, rejected: 0, via_reseller: 0, review_days: 0 }).map((r) => ({ period: r.period, submitted: n(r.submitted), approved: n(r.approved), rejected: n(r.rejected), viaReseller: n(r.via_reseller), reviewDays: r.review_days, approvalPct: pct(n(r.approved), n(r.submitted)) })),
        backlogAge: ageOrder.map((k) => ({ bucket: k, count: n((backlog.find((x) => x.k === k) || {}).count) })),
        sitesPerPublisher: perPub.map((r) => ({ bucket: r.k, publishers: n(r.publishers), sites: n(r.sites) })),
        newSitesByDr: bandOrder.map((b) => ({ band: b, count: n((drNew.find((x) => x.band === b) || {}).count) })),
      };
    });

    // ── 13. Data quality ──
    const qualityP = safe('quality', async () => {
      const r = await one(`select
        (select count(*)::int from up_users where coalesce(country,'')='') users_no_country,
        (select count(*)::int from up_users where username ~* ?) test_users,
        (select count(*)::int from orders where website_url ~* ? ) test_orders,
        (select coalesce(sum(total_amount),0) from orders where website_url ~* ?) test_orders_amount,
        (select count(*)::int from orders o join orders_advertiser_lnk l on l.order_id=o.id join up_users u on u.id=l.user_id where u.username ~* ?) orders_by_test_users,
        (select count(*)::int from marketplaces where status='active' and (price is null or price=0)) listings_no_price,
        (select count(*)::int from marketplaces where status='active' and ahrefs_dr is null) listings_no_dr,
        (select count(*)::int from marketplaces where status='active' and (last_metric_update_at is null or last_metric_update_at < now()-interval '90 days')) listings_stale,
        (select count(*)::int from (select url from marketplaces where status='active' group by url having count(*)>1) x) dup_urls,
        (select count(*)::int from marketplaces where status='active' and category::text ilike '%News&Media%') category_variants,
        (select count(*)::int from orders where order_status='cancelled' and coalesce(cancellation_reason,'')='') cancels_no_reason,
        (select count(*)::int from orders where order_status='rejected' and (coalesce(rejection_reason,'')='' or rejection_reason ilike 'Please provide%')) rejects_no_reason,
        (select count(*)::int from transactions where type='deposit' and transaction_status='pending' and created_at < now()-interval '2 days') deposits_stuck`,
        [TEST_USER_RE, TEST_SITE_RE, TEST_SITE_RE, TEST_USER_RE]);
      return {
        usersNoCountry: n(r.users_no_country), testUsers: n(r.test_users), testOrders: n(r.test_orders), testOrdersAmount: money(r.test_orders_amount), ordersByTestUsers: n(r.orders_by_test_users),
        listingsNoPrice: n(r.listings_no_price), listingsNoDr: n(r.listings_no_dr), listingsStale: n(r.listings_stale), dupUrls: n(r.dup_urls), categoryVariants: n(r.category_variants),
        cancelsNoReason: n(r.cancels_no_reason), rejectsNoReason: n(r.rejects_no_reason), depositsStuck: n(r.deposits_stuck),
      };
    });

    const [money_, funnel, lost, speed, buyers, publishers, sells, supplyDemand, payments, wallet, growth, pipeline, quality] = await Promise.all([
      moneyP, funnelP, lostP, speedP, buyersP, publishersP, sellsP, supplyDemandP, paymentsP, walletP, growthP, pipelineP, qualityP,
    ]);

    ctx.send({ range: spec.key, grain: spec.grain, buckets, generatedAt: new Date().toISOString(), tookMs: Date.now() - started,
      money: money_, funnel, lost, speed, buyers, publishers, sells, supplyDemand, payments, wallet, growth, pipeline, quality });
  },
};
