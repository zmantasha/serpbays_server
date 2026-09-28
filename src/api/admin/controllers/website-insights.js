'use strict';

/**
 * Website insight for the admin panel website detail page.
 *
 *   GET /admin/websites/:id/insight
 *
 * One call: the publisher_websites row, its marketplace listing (matched
 * by url), performance (orders on this url), pricing context (median of
 * the same DR band), the publisher's track record, computed health
 * alerts, a merged history (submission, approval, price/metric changes,
 * publisher edit requests, orders) and the order list.
 */

const STALE_METRIC_DAYS = 90;
const STALE_PRICE_DAYS = 90;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function money(v) { return Math.round(n(v) * 100) / 100; }
function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : null; }
function daysSince(ts) { return ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86400000) : null; }
function pj(v) { if (v == null) return v; if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } } return v; }
function band(dr) { const d = n(dr); return d >= 60 ? '60+' : d >= 40 ? '40–59' : d >= 20 ? '20–39' : '<20'; }
function bandWhere(dr) { const d = n(dr); return d >= 60 ? 'ahrefs_dr >= 60' : d >= 40 ? 'ahrefs_dr >= 40 and ahrefs_dr < 60' : d >= 20 ? 'ahrefs_dr >= 20 and ahrefs_dr < 40' : '(ahrefs_dr < 20 or ahrefs_dr is null)'; }

module.exports = {
  async insight(ctx) {
    const started = Date.now();
    const id = parseInt(ctx.params.id, 10);
    if (!id) return ctx.badRequest('Invalid website id');
    const knex = strapi.db.connection;
    const q = async (sql, b = []) => { const r = await knex.raw(sql, b); return r.rows || r; };
    const one = async (sql, b) => (await q(sql, b))[0] || null;

    const site = await one(`
      select p.*, pl.user_id as publisher_user_id, u.username as publisher_username, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) as publisher_name, u.country as publisher_country
        from publisher_websites p
        left join publisher_websites_current_publisher_id_lnk pl on pl.publisher_website_id = p.id
        left join up_users u on u.id = pl.user_id
       where p.id = ?`, [id]);
    if (!site) return ctx.notFound('Website not found');
    const url = site.url;

    const [listing, perf, orders, pubStats, updReq, shortlists, mkHist] = await Promise.all([
      one(`select m.*, (select count(*)::int + 1 from marketplaces x where x.status='active' and x.rank_score > m.rank_score) as rank_position,
                  (select count(*)::int from marketplaces x where x.status='active') as active_total
             from marketplaces m where m.url = ? order by (m.status='active') desc, m.id desc limit 1`, [url]),
      one(`select count(*)::int received, count(*) filter (where accepted_date is not null)::int accepted, count(*) filter (where order_status='completed')::int completed,
                  count(*) filter (where order_status='rejected')::int rejected, count(*) filter (where order_status='cancelled' and cancelled_by='system')::int ignored,
                  count(*) filter (where order_status='cancelled' and cancelled_by<>'system')::int cancelled, count(*) filter (where order_status in ('pending','accepted','delivered'))::int open,
                  coalesce(sum(total_amount) filter (where order_status='completed'),0) revenue, coalesce(sum(total_amount),0) gmv,
                  avg(extract(epoch from delivered_date-accepted_date)/86400) deliver_days, avg(extract(epoch from accepted_date-order_date)/86400) accept_days,
                  max(created_at) last_order, min(created_at) first_order
             from orders where website_url = ?`, [url]),
      q(`select o.id, o.order_status status, o.total_amount amount, coalesce(nullif(o.service_type,''),'guest_post') service, o.created_at, o.accepted_date, o.delivered_date, o.completed_date, o.cancelled_at, o.rejected_date, o.cancelled_by, left(coalesce(o.cancellation_reason, o.rejection_reason, ''),80) reason,
                u.id advertiser_id, coalesce(nullif(u.business_name,''), u.username) advertiser
           from orders o left join orders_advertiser_lnk l on l.order_id=o.id left join up_users u on u.id=l.user_id where o.website_url = ? order by o.created_at desc limit 50`, [url]),
      site.publisher_user_id ? one(`select count(*)::int received, count(*) filter (where o.accepted_date is not null)::int accepted, count(*) filter (where o.order_status='completed')::int completed,
                  count(*) filter (where o.order_status='cancelled' and o.cancelled_by='system')::int ignored, avg(extract(epoch from o.delivered_date-o.accepted_date)/86400) deliver_days,
                  coalesce(sum(o.total_amount) filter (where o.order_status='completed'),0) earned,
                  (select count(*)::int from publisher_websites_current_publisher_id_lnk l2 where l2.user_id = ?) sites,
                  (select count(*)::int from publisher_websites p2 join publisher_websites_current_publisher_id_lnk l2 on l2.publisher_website_id=p2.id where l2.user_id = ? and p2.submission_status='approved') approved_sites
             from orders o join orders_publisher_lnk l on l.order_id=o.id where l.user_id = ?`, [site.publisher_user_id, site.publisher_user_id, site.publisher_user_id]) : Promise.resolve(null),
      q(`select w.id, w.status, w.source, w.submitted_at, w.reviewed_at, w.created_at, w.changes, w.notes from website_update_requests w join website_update_requests_publisher_website_lnk l on l.website_update_request_id = w.id where l.publisher_website_id = ? order by w.created_at desc limit 50`, [id]),
      Promise.resolve(null),
      q(`select h.changed_at, h.source, h.changed_by, h.changed_fields, h.changes from marketplace_update_histories h join marketplace_update_histories_marketplace_lnk l on l.marketplace_update_history_id = h.id
          where l.marketplace_id = (select m.id from marketplaces m where m.url = ? order by (m.status='active') desc, m.id desc limit 1) order by h.changed_at desc limit 100`, [url]),
    ]);
    const shortlistCount = listing ? n((await one(`select count(*)::int c from shortlists_marketplace_lnk where marketplace_id = ?`, [listing.id]) || {}).c) : 0;

    // Pricing context: same DR band, active listings with a price
    const dr = listing ? listing.ahrefs_dr : site.ahrefs_dr;
    const bandRow = await one(`select count(*)::int listings, percentile_cont(0.5) within group (order by price) med_price, percentile_cont(0.25) within group (order by price) p25, percentile_cont(0.75) within group (order by price) p75,
                                      percentile_cont(0.5) within group (order by link_insertion_price) filter (where link_insertion_price > 0) med_li
                                 from marketplaces where status='active' and price > 0 and ${bandWhere(dr)}`);
    const bandOrders = await one(`select count(*)::int orders, avg(total_amount) avg_paid from orders where ${bandWhere(dr).replace(/ahrefs_dr/g, 'website_ahrefs_dr')}`);

    // ── alerts ──
    const alerts = [];
    const metricAge = daysSince(listing ? listing.last_metric_update_at || site.metrics_last_updated : site.metrics_last_updated);
    const priceAge = daysSince(listing ? listing.last_price_update_at : null);
    const price = listing ? n(listing.price) : n(site.general_guest_post_price);
    const liPrice = listing ? n(listing.link_insertion_price) : n(site.general_link_insertion_price);
    if (site.submission_status === 'approved' && !listing) alerts.push({ key: 'no_listing', sev: 'crit', title: 'Approved but not in the marketplace', detail: 'No marketplace listing exists for this URL, so buyers cannot see it.', action: 'edit' });
    if (listing && listing.status !== 'active') alerts.push({ key: 'listing_inactive', sev: 'crit', title: `Listing is ${listing.status}`, detail: listing.delisted_reason ? `Reason: ${listing.delisted_reason}` : 'Buyers cannot order it until it is active again.', action: 'edit' });
    if (site.submission_status === 'approved' && price <= 0 && liPrice <= 0) alerts.push({ key: 'no_price', sev: 'crit', title: 'No price set', detail: 'A listing without a guest-post or link-insertion price never shows in the marketplace.', action: 'edit' });
    if (metricAge == null) alerts.push({ key: 'no_metrics', sev: 'warn', title: 'Metrics never recorded', detail: 'DR / traffic have never been saved for this site.', action: 'metrics' });
    else if (metricAge > STALE_METRIC_DAYS) alerts.push({ key: 'stale_metrics', sev: 'warn', title: `Metrics are ${metricAge} days old`, detail: 'Buyers choose by DR and traffic; refresh so the listing is honest.', action: 'metrics' });
    if (listing && priceAge == null) alerts.push({ key: 'price_unconfirmed', sev: 'info', title: 'Price never confirmed', detail: 'Nobody has confirmed this price since listing. Confirm it or update it.', action: 'confirm_price' });
    else if (priceAge != null && priceAge > STALE_PRICE_DAYS) alerts.push({ key: 'price_stale', sev: 'info', title: `Price last checked ${priceAge} days ago`, detail: 'Confirm the price is still what the publisher charges.', action: 'confirm_price' });
    if (price > 0 && liPrice <= 0) alerts.push({ key: 'no_li', sev: 'info', title: 'Link insertion not offered', detail: 'Cheaper link insertions sell well; ask the publisher for a price.', action: 'email' });
    if (!site.gsc_verified) alerts.push({ key: 'no_gsc', sev: 'info', title: 'Ownership not verified via Search Console', detail: 'Verified sites earn more buyer trust.', action: null });
    const pendingUpd = (updReq || []).filter((r) => r.status === 'pending');
    if (pendingUpd.length) alerts.push({ key: 'pending_update', sev: 'warn', title: `${pendingUpd.length} publisher edit${pendingUpd.length > 1 ? 's' : ''} waiting for review`, detail: 'The publisher changed something; the live listing stays old until you approve.', action: 'updates' });
    if (site.submission_status === 'approved' && n(perf.received) === 0 && daysSince(site.approved_at) > 60) alerts.push({ key: 'never_ordered', sev: 'info', title: `No orders in ${daysSince(site.approved_at)} days since approval`, detail: `Median price in this DR band is ${money(bandRow && bandRow.med_price)}; check price and category.`, action: null });
    if (n(perf.received) >= 3 && pct(n(perf.accepted), n(perf.received)) < 60) alerts.push({ key: 'low_acceptance', sev: 'crit', title: `Publisher accepts only ${pct(n(perf.accepted), n(perf.received))}% of orders here`, detail: 'Buyers pay and get ignored. Warn the publisher or pause the listing.', action: 'email' });
    if (!site.description) alerts.push({ key: 'no_description', sev: 'info', title: 'No description', detail: 'Buyers see an empty card.', action: 'edit' });
    if (/reseller/i.test(String(site.verification_method || '')) && !site.reseller_code) alerts.push({ key: 'reseller_mismatch', sev: 'info', title: 'Marked as added via reseller code, but no code stored', detail: 'Data inconsistency; harmless for buyers.', action: null });
    const sevRank = { crit: 0, warn: 1, info: 2 };
    alerts.sort((a, b) => sevRank[a.sev] - sevRank[b.sev]);

    // ── history (merged) ──
    const events = [];
    const push = (kind, ts, title, detail, ref) => { if (ts) events.push({ kind, ts, title, detail: detail || null, ref: ref || null }); };
    push('submitted', site.created_at, 'Site submitted', site.reseller_code ? `via reseller code ${site.reseller_code}` : null);
    push('approved', site.approved_at, 'Approved', null);
    if (site.submission_status === 'rejected') push('rejected', site.reviewed_at, 'Rejected', site.rejection_reason);
    push('paused', site.paused_at, 'Listing paused', null);
    push('resumed', site.resumed_at, 'Listing resumed', null);
    push('claimed', site.claimed_at, 'Ownership claimed', null);
    push('transferred', site.ownership_transferred_at, 'Ownership transferred', site.ownership_transfer_reason);
    if (listing) push('delisted', listing.delisted_at, 'Delisted from marketplace', listing.delisted_reason);
    (mkHist || []).forEach((h) => {
      const cf = pj(h.changed_fields); const fields = Array.isArray(cf) ? cf : [];
      const ch = pj(h.changes) || {};
      const isPrice = fields.some((f) => /price|pricing/.test(f));
      const isMetric = fields.some((f) => /ahrefs|moz|semrush|spam/.test(f));
      const parts = [];
      if (ch.price) parts.push(`price ${money(ch.price.from)} → ${money(ch.price.to)}`);
      if (ch.link_insertion_price) parts.push(`link insertion ${money(ch.link_insertion_price.from)} → ${money(ch.link_insertion_price.to)}`);
      if (ch.ahrefs_dr) parts.push(`DR ${n(ch.ahrefs_dr.from)} → ${n(ch.ahrefs_dr.to)}`);
      if (ch.ahrefs_traffic) parts.push(`traffic ${n(ch.ahrefs_traffic.from)} → ${n(ch.ahrefs_traffic.to)}`);
      if (ch.moz_da) parts.push(`DA ${n(ch.moz_da.from)} → ${n(ch.moz_da.to)}`);
      if (ch.url) parts.push(`url ${ch.url.from} → ${ch.url.to}`);
      const title = h.source === 'admin-confirm' ? 'Price confirmed unchanged' : isPrice && !isMetric ? 'Price updated' : isMetric && !isPrice ? 'Metrics updated' : `${fields.length} fields updated`;
      push(h.source === 'admin-confirm' ? 'price_confirm' : isPrice ? 'price' : isMetric ? 'metrics' : 'edit', h.changed_at, title, `${parts.join(' · ') || fields.slice(0, 6).join(', ')}${h.source ? ` · ${h.source}${h.changed_by ? ` by ${h.changed_by}` : ''}` : ''}`);
    });
    (updReq || []).forEach((r) => {
      const rc = pj(r.changes); const fields = rc && typeof rc === 'object' ? Object.keys(rc) : [];
      push('edit_request', r.submitted_at || r.created_at, `Publisher edit request ${r.status}`, fields.length ? fields.slice(0, 8).join(', ') : null, r.id);
      if (r.reviewed_at && r.status !== 'pending') push('edit_reviewed', r.reviewed_at, `Edit request ${r.status}`, r.notes || null, r.id);
    });
    (orders || []).forEach((o) => {
      push('order', o.created_at, `Order #${o.id} placed`, `${money(o.amount)} by ${o.advertiser || 'buyer'}`, o.id);
      push('order_done', o.completed_date, `Order #${o.id} completed`, money(o.amount), o.id);
      push('order_lost', o.cancelled_at || o.rejected_date, `Order #${o.id} ${o.status === 'rejected' ? 'rejected' : 'cancelled'}`, [o.cancelled_by, o.reason].filter(Boolean).join(': ') || null, o.id);
    });
    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));

    const publisherTake = listing ? n(listing.publisher_price) : n(site.general_guest_post_price);
    ctx.send({
      site: {
        id: site.id, url, protocol: site.protocol || 'https', status: site.submission_status, createdAt: site.created_at, approvedAt: site.approved_at, reviewedAt: site.reviewed_at, rejectionReason: site.rejection_reason,
        category: pj(site.category), countries: pj(site.countries), language: pj(site.language), tatHours: n(site.expected_tat_hours), description: site.description, guidelines: site.guidelines,
        minWords: n(site.min_word_count), allowedLinks: n(site.allowed_links), backlinkType: site.backlink_type, backlinkValidity: site.backlink_validity, sponsored: !!site.sponsored, ugc: !!site.ugc, isPr: !!site.is_pr_site, samplePosts: pj(site.sample_posts),
        gscVerified: !!site.gsc_verified, verificationMethod: site.verification_method, resellerCode: site.reseller_code,
        metrics: { dr: site.ahrefs_dr, traffic: site.ahrefs_traffic, rank: site.ahrefs_rank, keywords: site.ahrefs_keywords, topCountry: site.ahrefs_top_country || null, topCountryShare: site.ahrefs_top_country_share != null ? Number(site.ahrefs_top_country_share) : null, refDomains: site.ahrefs_referring_domain, da: site.moz_da, spam: site.moz_spam_score, semrushAs: site.semrush_authority_score, semrushTraffic: site.semrush_traffic, updatedAt: site.metrics_last_updated, ageDays: daysSince(site.metrics_last_updated) },
        prices: { guestPost: n(site.general_guest_post_price), linkInsertion: n(site.general_link_insertion_price),
          casino: { accepted: !!site.casino_accepted, gp: n(site.casino_guest_post_price), li: n(site.casino_link_insertion_price) }, crypto: { accepted: !!site.crypto_accepted, gp: n(site.crypto_guest_post_price), li: n(site.crypto_link_insertion_price) },
          cbd: { accepted: !!site.cbd_accepted, gp: n(site.cbd_guest_post_price), li: n(site.cbd_link_insertion_price) }, dating: { accepted: !!site.dating_accepted, gp: n(site.dating_guest_post_price), li: n(site.dating_link_insertion_price) },
          copywriting: site.do_copywriting ? n(site.copywriting_price) : null },
      },
      listing: listing ? {
        id: listing.id, status: listing.status, visible: listing.status === 'active' && (n(listing.price) > 0 || n(listing.link_insertion_price) > 0), price: n(listing.price), linkInsertionPrice: n(listing.link_insertion_price),
        publisherPrice: n(listing.publisher_price), publisherLiPrice: n(listing.publisher_link_insertion_price), marginPct: n(listing.price) ? pct(n(listing.price) - n(listing.publisher_price), n(listing.price)) : null,
        rankScore: money(listing.rank_score), rankPosition: n(listing.rank_position), activeTotal: n(listing.active_total), featured: !!listing.is_featured,
        dr: listing.ahrefs_dr, traffic: listing.ahrefs_traffic, da: listing.moz_da, spam: listing.spam_score, category: pj(listing.category), dofollow: listing.dofollow_link, tat: listing.tat, placementSpeed: listing.placement_speed,
        lastPriceUpdateAt: listing.last_price_update_at, priceAgeDays: priceAge, lastMetricUpdateAt: listing.last_metric_update_at, metricAgeDays: metricAge, delistedAt: listing.delisted_at, delistedReason: listing.delisted_reason, gscVerified: !!listing.gsc_verified,
        shortlists: shortlistCount,
      } : null,
      performance: {
        received: n(perf.received), accepted: n(perf.accepted), completed: n(perf.completed), rejected: n(perf.rejected), ignored: n(perf.ignored), cancelled: n(perf.cancelled), open: n(perf.open),
        revenue: money(perf.revenue), gmv: money(perf.gmv), acceptancePct: pct(n(perf.accepted), n(perf.received)), completionPct: pct(n(perf.completed), n(perf.received)),
        deliverDays: money(perf.deliver_days), acceptDays: money(perf.accept_days), lastOrder: perf.last_order, firstOrder: perf.first_order, daysSinceApproval: daysSince(site.approved_at),
      },
      pricingContext: { band: band(dr), bandListings: n(bandRow && bandRow.listings), medPrice: money(bandRow && bandRow.med_price), p25: money(bandRow && bandRow.p25), p75: money(bandRow && bandRow.p75), medLi: money(bandRow && bandRow.med_li), bandOrders: n(bandOrders && bandOrders.orders), bandAvgPaid: money(bandOrders && bandOrders.avg_paid),
        price, publisherTake, platformMargin: money(price - publisherTake), platformMarginPct: price ? pct(price - publisherTake, price) : null },
      publisher: site.publisher_user_id ? { id: site.publisher_user_id, username: site.publisher_username, name: site.publisher_name, country: site.publisher_country, email: site.publisher_email,
        received: n(pubStats && pubStats.received), accepted: n(pubStats && pubStats.accepted), completed: n(pubStats && pubStats.completed), ignored: n(pubStats && pubStats.ignored), acceptancePct: pct(n(pubStats && pubStats.accepted), n(pubStats && pubStats.received)),
        deliverDays: money(pubStats && pubStats.deliver_days), earned: money(pubStats && pubStats.earned), sites: n(pubStats && pubStats.sites), approvedSites: n(pubStats && pubStats.approved_sites) } : null,
      alerts,
      history: events.slice(0, 300),
      orders: (orders || []).map((o) => ({ id: o.id, status: o.status, amount: money(o.amount), service: o.service, createdAt: o.created_at, completedAt: o.completed_date, advertiserId: o.advertiser_id, advertiser: o.advertiser, reason: o.reason || null })),
      pendingUpdates: pendingUpd.map((r) => { const rc = pj(r.changes); return { id: r.id, submittedAt: r.submitted_at || r.created_at, fields: rc && typeof rc === 'object' ? Object.keys(rc) : [] }; }),
      tookMs: Date.now() - started,
    });
  },
};
