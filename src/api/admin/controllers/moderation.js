'use strict';

/**
 * Moderation inbox API (see services/moderation.js).
 *
 *   GET  /admin/moderation/summary            tab counts, oldest items, 7-day stats, settings
 *   GET  /admin/moderation/edits              pending edit requests, normalised + risk + groups
 *   POST /admin/moderation/edits/decide       { ids[], action: approve|reject|ask_changes|close_noise, reasonCode, note, publisherMessage }
 *   GET  /admin/moderation/sites              ?view=new|verification|live_pending&bucket=&q=&limit=&offset=
 *   GET  /admin/moderation/sites/:id          full review detail
 *   POST /admin/moderation/sites/:id/checks   { paid } re-run automatic checks
 *   POST /admin/moderation/sites/decide       { ids[], action: approve|reject|ask_changes, reasonCode, note, publisherMessage, checklist, override }
 *   POST /admin/moderation/triage/run         { onlyUnchecked } background checks over the whole backlog (free checks)
 *   GET  /admin/moderation/triage/status
 *   GET  /admin/moderation/flags              ?status=open
 *   POST /admin/moderation/flags/scan         { days }
 *   POST /admin/moderation/flags/:id/resolve  { resolution: keep|pause, note }
 *   POST /admin/moderation/lock | /unlock     { key }
 *   GET  /admin/moderation/stats
 *   PUT  /admin/moderation/settings           super admin only
 *
 * Decisions call the existing approve/reject handlers, so marketplace writes,
 * publisher-website reverts and history stay exactly as before.
 */

const svc = require('../services/moderation');

const knex = () => strapi.db.connection;
const rows = (r) => r.rows || r;
const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const isSuper = (ctx) => ctx.state.user && ctx.state.user.role && ctx.state.user.role.type === 'super_admin';
const adminName = (u) => (u && (u.username || u.email)) || 'admin';

const REASONS = {
  price_too_high: 'Price is far above similar sites',
  price_invalid: 'Prices are missing or inconsistent',
  site_dead: 'The site does not load or is parked',
  low_quality: 'Site quality or authority is too low for the marketplace',
  fake_metrics: 'Metrics do not match what we measured',
  traffic_country: 'Traffic comes mostly from a country the listing does not mention',
  duplicate: 'This site is already listed',
  no_ownership: 'We could not confirm you own this site',
  policy: 'The change is against marketplace policy',
  other: 'Other',
};

function fail(ctx, e) {
  ctx.status = e.status || 500;
  ctx.body = { error: { status: ctx.status, message: e.message } };
  if (ctx.status >= 500) strapi.log.error(`[MODERATION] ${e.stack || e.message}`);
}

async function publisherOfPw(pwId) {
  const r = rows(await knex().raw('select user_id from publisher_websites_current_publisher_id_lnk where publisher_website_id=? limit 1', [pwId]))[0];
  return r ? r.user_id : null;
}

// ───────────────────────── background triage job ─────────────────────────
let triage = null;
async function runTriage(opts, adminId) {
  const list = rows(await knex().raw(`select p.id, p.url from publisher_websites p
      ${opts.onlyUnchecked ? 'left join (select distinct pw_id from moderation_checks) c on c.pw_id=p.id' : ''}
      where p.submission_status in ('approval_pending','pending_verification') ${opts.onlyUnchecked ? 'and c.pw_id is null' : ''} order by p.id`));
  triage = { status: 'running', stage: opts.paid ? 'fetching traffic' : 'checking', startedAt: Date.now(), total: list.length, done: 0, failed: 0, by: adminId };
  if (opts.paid) {
    // One bulk traffic pass first (Apify 50/run, DataForSEO 100/call), then every check reads the cache.
    const r = await svc.fetchTraffic(list.map((x) => x.url), { paid: true }).catch((e) => { strapi.log.error(`[MODERATION] traffic prefetch failed: ${e.stack || e.message}`); return { byDomain: {}, apifyNote: e.message }; });
    triage.traffic = { measured: Object.keys(r.byDomain).length, ahrefs: Object.values(r.byDomain).filter((v) => v.source === 'ahrefs').length, dataforseo: Object.values(r.byDomain).filter((v) => v.source === 'dataforseo').length, apifyNote: r.apifyNote || null };
    triage.stage = 'checking';
  }
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const id = list[i++].id;
      try { await svc.runSiteChecks(id, { paid: false }); } catch (e) { triage.failed += 1; triage.lastError = e.message; }
      triage.done += 1;
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  triage.status = 'done';
  triage.finishedAt = Date.now();
}

module.exports = {
  async summary(ctx) {
    try {
      await svc.ensureTables();
      const [edits, sites, flags, stats, settings, lockMap] = await Promise.all([
        knex().raw(`select count(*)::int c, coalesce(max(extract(epoch from now()-created_at)/3600),0) oldest from website_update_requests where status='pending'`),
        knex().raw(`select count(*) filter (where submission_status='approval_pending' and marketplace_id is null)::int new_sites,
            count(*) filter (where submission_status='approval_pending' and marketplace_id is not null)::int live_pending,
            count(*) filter (where submission_status='pending_verification')::int verification,
            coalesce(max(extract(epoch from now()-created_at)/3600) filter (where submission_status='approval_pending'),0) oldest
          from publisher_websites where submission_status in ('approval_pending','pending_verification')`),
        knex().raw(`select count(*)::int c from moderation_flags where status='open'`),
        knex().raw(`select count(*)::int decisions, count(*) filter (where action='approve' or action='close_noise')::int approved, count(*) filter (where action in ('reject','ask_changes'))::int rejected,
            count(*) filter (where auto)::int auto, percentile_cont(0.5) within group (order by extract(epoch from created_at - submitted_at)/3600) filter (where submitted_at is not null) median_hours
          from moderation_decisions where created_at > now() - interval '7 days'`),
        svc.getSettings(), svc.locks(),
      ]);
      const e = rows(edits)[0], s = rows(sites)[0], st = rows(stats)[0];
      ctx.send({
        tabs: {
          edits: { count: e.c, oldestHours: Math.round(n(e.oldest)) },
          new: { count: s.new_sites, oldestHours: Math.round(n(s.oldest)) },
          live_pending: { count: s.live_pending },
          verification: { count: s.verification },
          flags: { count: rows(flags)[0].c },
        },
        stats7d: { decisions: st.decisions, approved: st.approved, rejected: st.rejected, auto: st.auto, medianHours: st.median_hours != null ? Math.round(n(st.median_hours) * 10) / 10 : null },
        settings, isSuperAdmin: isSuper(ctx), reasons: REASONS, locks: lockMap, triage,
        me: { id: ctx.state.user.id, name: adminName(ctx.state.user) },
      });
    } catch (e) { fail(ctx, e); }
  },

  async edits(ctx) {
    try {
      const [items, lockMap] = await Promise.all([svc.listEdits(), svc.locks()]);
      ctx.send({ items, locks: lockMap, reasons: REASONS });
    } catch (e) { fail(ctx, e); }
  },

  async decideEdits(ctx) {
    try {
      const b = ctx.request.body || {};
      const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 500);
      const action = b.action;
      if (!ids.length) throw Object.assign(new Error('No requests selected'), { status: 400 });
      if (!['approve', 'reject', 'ask_changes', 'close_noise'].includes(action)) throw Object.assign(new Error('Unknown action'), { status: 400 });
      if ((action === 'reject' || action === 'ask_changes') && !b.reasonCode) throw Object.assign(new Error('Pick a reason'), { status: 400 });
      if (b.reasonCode === 'other' && !String(b.note || b.publisherMessage || '').trim()) throw Object.assign(new Error('Write a note for "Other"'), { status: 400 });
      const user = ctx.state.user;
      const all = await svc.listEdits();
      const byId = new Map(all.map((i) => [i.id, i]));
      const results = [];
      for (const id of ids) {
        const item = byId.get(id);
        try {
          if (!item) throw Object.assign(new Error('Not pending any more'), { status: 409 });
          await svc.assertNotLockedByOther(`edit:${id}`, user.id);
          if (action === 'close_noise' && item.real.length) throw Object.assign(new Error('Has real changes; review it instead'), { status: 400 });
          const reasonText = REASONS[b.reasonCode] || '';
          const message = String(b.publisherMessage || '').trim();
          if (action === 'approve' || action === 'close_noise') {
            await svc.callController('api::website-update-request.website-update-request', 'approve', { id, user });
          } else {
            await svc.callController('api::website-update-request.website-update-request', 'reject', { id, user, body: { reason: [action === 'ask_changes' ? 'Changes requested' : 'Rejected', reasonText, message].filter(Boolean).join(': ') } });
          }
          await svc.logDecision({ itemType: 'edit', itemId: id, pwId: item.pwId, marketplaceId: item.marketplaceId, action, reasonCode: b.reasonCode, note: b.note, publisherMessage: message,
            snapshot: { real: item.real, risk: item.risk, conflicts: item.conflicts }, adminId: user.id, adminName: adminName(user), submittedAt: item.submittedAt });
          if (action !== 'close_noise') {
            const what = item.real.slice(0, 3).map((x) => `${x.label} ${x.from} → ${x.to}`).join(', ');
            if (action === 'approve') await svc.notifyPublisher(item.publisher.id, `Update approved: ${item.url}`, `Your changes to ${item.url} are live${what ? ` (${what})` : ''}.`, '/publisher/my-websites');
            else await svc.notifyPublisher(item.publisher.id, action === 'ask_changes' ? `Changes needed: ${item.url}` : `Update not approved: ${item.url}`,
              `${reasonText}${message ? `. ${message}` : ''}${what ? ` (requested: ${what})` : ''}. ${action === 'ask_changes' ? 'Please edit the listing and submit again.' : ''}`.trim(), '/publisher/my-websites');
          }
          await svc.release(`edit:${id}`, user.id);
          results.push({ id, ok: true });
        } catch (e) { results.push({ id, ok: false, error: e.message }); }
      }
      ctx.send({ action, total: ids.length, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
    } catch (e) { fail(ctx, e); }
  },

  async sites(ctx) {
    try {
      await svc.ensureTables();
      const view = ['new', 'verification', 'live_pending'].includes(ctx.query.view) ? ctx.query.view : 'new';
      const where = view === 'verification' ? "p.submission_status='pending_verification'"
        : view === 'live_pending' ? "p.submission_status='approval_pending' and p.marketplace_id is not null"
          : "p.submission_status='approval_pending' and p.marketplace_id is null";
      const q = String(ctx.query.q || '').trim().toLowerCase();
      const list = rows(await knex().raw(`select p.id, p.url, p.submission_status, p.created_at, p.verification_method, p.gsc_verified, p.reseller_code, p.general_guest_post_price gp,
          p.ahrefs_dr, p.ahrefs_traffic, p.marketplace_id, l.user_id publisher_id, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) publisher_name, u.email publisher_email
        from publisher_websites p left join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id left join up_users u on u.id=l.user_id
        where ${where} ${q ? 'and (lower(p.url) like ? or lower(u.email) like ? or lower(u.username) like ?)' : ''} order by p.created_at asc`, q ? [`%${q}%`, `%${q}%`, `%${q}%`] : []));
      const checks = await svc.getSiteChecks(list.map((x) => x.id));
      const lockMap = await svc.locks();
      const settings = await svc.getSettings();
      let items = list.map((x) => {
        const c = checks.get(x.id);
        const ageH = (Date.now() - new Date(x.created_at).getTime()) / 3600000;
        return {
          id: x.id, key: `site:${x.id}`, url: x.url, status: x.submission_status, createdAt: x.created_at, ageHours: Math.round(ageH),
          publisher: { id: x.publisher_id, name: x.publisher_name, email: x.publisher_email }, price: n(x.gp) || null,
          claimed: { dr: x.ahrefs_dr != null ? n(x.ahrefs_dr) : null, traffic: x.ahrefs_traffic != null ? n(x.ahrefs_traffic) : null },
          verification: x.gsc_verified ? 'gsc' : x.verification_method || null, resellerCode: x.reseller_code || null, live: !!x.marketplace_id,
          checks: c ? { fails: c.fails, warns: c.warns, bucket: c.bucket, ranAt: c.ranAt, dr: (c.checks.find((k) => k.key === 'dr') || {}).value, traffic: (c.checks.find((k) => k.key === 'traffic') || {}).value } : null,
          sla: { dueHours: settings.slaHoursSites, overdue: ageH > settings.slaHoursSites },
          lock: lockMap[`site:${x.id}`] || null,
        };
      });
      const buckets = { likely_approve: 0, needs_review: 0, likely_reject: 0, unchecked: 0 };
      items.forEach((i) => { buckets[i.checks ? i.checks.bucket : 'unchecked'] += 1; });
      const bucket = ctx.query.bucket;
      if (bucket) items = items.filter((i) => (i.checks ? i.checks.bucket : 'unchecked') === bucket);
      const sort = ctx.query.sort === 'newest' ? -1 : 1;
      items.sort((a, b) => sort * (new Date(a.createdAt) - new Date(b.createdAt)));
      const limit = Math.min(200, Math.max(1, parseInt(ctx.query.limit, 10) || 50));
      const offset = Math.max(0, parseInt(ctx.query.offset, 10) || 0);
      ctx.send({ view, total: items.length, buckets, items: items.slice(offset, offset + limit), reasons: REASONS });
    } catch (e) { fail(ctx, e); }
  },

  async site(ctx) {
    try {
      await svc.ensureTables();
      const id = parseInt(ctx.params.id, 10);
      const p = rows(await knex().raw(`select p.*, l.user_id publisher_id, u.username publisher_username, u.email publisher_email_acct, coalesce(nullif(u.business_name,''), nullif(u.first_name,''), u.username) publisher_display, u.country publisher_country, u.created_at publisher_since
          from publisher_websites p left join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id left join up_users u on u.id=l.user_id where p.id=?`, [id]))[0];
      if (!p) return ctx.notFound('Website not found');
      const [checks, trust, listing, history, others] = await Promise.all([
        svc.getSiteChecks([id]),
        svc.publisherTrust(p.publisher_id),
        p.marketplace_id ? knex().raw('select id, url, status, price, link_insertion_price, ahrefs_dr, ahrefs_traffic, ahrefs_top_country from marketplaces where id=?', [p.marketplace_id]) : null,
        knex().raw(`select action, reason_code, note, publisher_message, admin_name, auto, created_at from moderation_decisions where pw_id=? order by created_at desc limit 10`, [id]),
        p.publisher_id ? knex().raw(`select p.id, p.url, p.submission_status from publisher_websites p join publisher_websites_current_publisher_id_lnk l on l.publisher_website_id=p.id where l.user_id=? and p.id<>? order by p.id desc limit 12`, [p.publisher_id, id]) : null,
      ]);
      const parse = (v) => { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch (e) { return v; } };
      ctx.send({
        site: {
          id: p.id, url: p.url, protocol: p.protocol || 'https', status: p.submission_status, createdAt: p.created_at, liveListing: listing ? rows(listing)[0] || null : null,
          verification: { method: p.verification_method, gsc: !!p.gsc_verified, resellerCode: p.reseller_code, addedByReseller: !!p.added_by_reseller },
          details: {
            category: parse(p.category), countries: parse(p.countries), language: parse(p.language), description: p.description, guidelines: p.guidelines,
            backlinkType: p.backlink_type, backlinkValidity: p.backlink_validity, allowedLinks: p.allowed_links, minWords: p.min_word_count, tatHours: p.expected_tat_hours,
            sponsored: !!p.sponsored, ugc: !!p.ugc, isPr: !!p.is_pr_site, samples: parse(p.sample_posts), publicationLocation: p.publication_location,
          },
          prices: {
            guestPost: n(p.general_guest_post_price), linkInsertion: n(p.general_link_insertion_price), copywriting: n(p.copywriting_price),
            casino: p.casino_accepted ? [n(p.casino_guest_post_price), n(p.casino_link_insertion_price)] : null, crypto: p.crypto_accepted ? [n(p.crypto_guest_post_price), n(p.crypto_link_insertion_price)] : null,
            cbd: p.cbd_accepted ? [n(p.cbd_guest_post_price), n(p.cbd_link_insertion_price)] : null, dating: p.dating_accepted ? [n(p.dating_guest_post_price), n(p.dating_link_insertion_price)] : null,
          },
          claimedMetrics: { dr: p.ahrefs_dr, traffic: p.ahrefs_traffic, da: p.moz_da },
          reviewNotes: p.review_notes, rejectionReason: p.rejection_reason,
        },
        publisher: { id: p.publisher_id, username: p.publisher_username, name: p.publisher_display, email: p.publisher_email_acct || p.publisher_email, country: p.publisher_country, since: p.publisher_since, trust, otherSites: others ? rows(others) : [] },
        checks: checks.get(id) || null,
        history: rows(history), reasons: REASONS,
      });
    } catch (e) { fail(ctx, e); }
  },

  async runChecks(ctx) {
    try { ctx.send(await svc.runSiteChecks(parseInt(ctx.params.id, 10), { paid: ctx.request.body && ctx.request.body.paid === true })); } catch (e) { fail(ctx, e); }
  },

  async decideSites(ctx) {
    try {
      const b = ctx.request.body || {};
      const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => parseInt(x, 10)).filter(Boolean).slice(0, 200);
      const action = b.action;
      if (!ids.length) throw Object.assign(new Error('No sites selected'), { status: 400 });
      if (!['approve', 'reject', 'ask_changes'].includes(action)) throw Object.assign(new Error('Unknown action'), { status: 400 });
      if (action !== 'approve' && !b.reasonCode) throw Object.assign(new Error('Pick a reason'), { status: 400 });
      if (b.reasonCode === 'other' && !String(b.note || b.publisherMessage || '').trim()) throw Object.assign(new Error('Write a note for "Other"'), { status: 400 });
      const user = ctx.state.user;
      const checks = await svc.getSiteChecks(ids);
      const results = [];
      for (const id of ids) {
        try {
          await svc.assertNotLockedByOther(`site:${id}`, user.id);
          const pw = rows(await knex().raw('select id, url, submission_status, created_at, marketplace_id from publisher_websites where id=?', [id]))[0];
          if (!pw) throw Object.assign(new Error('Not found'), { status: 404 });
          if (!['approval_pending', 'pending_verification'].includes(pw.submission_status)) throw Object.assign(new Error(`Already ${pw.submission_status}`), { status: 409 });
          const c = checks.get(id);
          if (action === 'approve') {
            if (pw.submission_status === 'pending_verification' && !b.override) throw Object.assign(new Error('Ownership is not verified; tick "approve anyway" with a note'), { status: 400 });
            if (c && c.fails.length && !(b.override && String(b.note || '').trim())) throw Object.assign(new Error(`Checks failed (${c.fails.join(', ')}); approve anyway needs a note`), { status: 400 });
          }
          const reasonText = REASONS[b.reasonCode] || '';
          const message = String(b.publisherMessage || '').trim();
          const publisherId = await publisherOfPw(id);
          if (action === 'approve') {
            await svc.callController('api::admin.websites', 'approve', { id, user, body: { adminNotes: b.note || null } });
            await svc.notifyPublisher(publisherId, `Website approved: ${pw.url}`, `${pw.url} is now live on the Serpbays marketplace.`, '/publisher/my-websites');
          } else if (action === 'reject') {
            if (pw.marketplace_id) throw Object.assign(new Error('This site is live; pause the listing instead of rejecting'), { status: 400 });
            await svc.callController('api::admin.websites', 'reject', { id, user, body: { reason: [reasonText, message].filter(Boolean).join(': ') } });
            await svc.notifyPublisher(publisherId, `Website not approved: ${pw.url}`, `${reasonText}${message ? `. ${message}` : ''}.`, '/publisher/my-websites');
          } else {
            // Ask for changes: the site stays in the queue, the publisher is told what to fix.
            await knex().raw('update publisher_websites set review_notes=?, updated_at=now() where id=?', [[reasonText, message].filter(Boolean).join(': '), id]);
            await svc.notifyPublisher(publisherId, `Changes needed: ${pw.url}`, `${reasonText}${message ? `. ${message}` : ''}. Please update the listing so we can approve it.`, '/publisher/my-websites');
          }
          await svc.logDecision({ itemType: 'site', itemId: id, pwId: id, marketplaceId: pw.marketplace_id, action, reasonCode: b.reasonCode, note: b.note, publisherMessage: message,
            checklist: b.checklist || null, snapshot: c ? { fails: c.fails, warns: c.warns, bucket: c.bucket, override: !!b.override } : null, adminId: user.id, adminName: adminName(user), submittedAt: pw.created_at });
          await svc.release(`site:${id}`, user.id);
          results.push({ id, ok: true });
        } catch (e) { results.push({ id, ok: false, error: e.message }); }
      }
      ctx.send({ action, total: ids.length, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
    } catch (e) { fail(ctx, e); }
  },

  async triageRun(ctx) {
    try {
      if (triage && triage.status === 'running') return ctx.send({ triage });
      const body = ctx.request.body || {};
      runTriage({ onlyUnchecked: body.onlyUnchecked !== false, paid: body.paid === true }, ctx.state.user.id)
        .catch((e) => { triage = { ...(triage || {}), status: 'failed', error: e.message }; strapi.log.error(`[MODERATION] triage failed: ${e.message}`); });
      await new Promise((r) => setTimeout(r, 300));
      ctx.send({ triage });
    } catch (e) { fail(ctx, e); }
  },
  async triageStatus(ctx) { ctx.send({ triage }); },

  async flags(ctx) {
    try {
      await svc.ensureTables();
      const status = ctx.query.status === 'resolved' ? 'resolved' : 'open';
      const r = rows(await knex().raw(`select f.*, m.url, m.status listing_status, m.price, m.link_insertion_price, m.ahrefs_dr, m.ahrefs_traffic, m.ahrefs_top_country,
          (select count(*)::int from orders o join orders_website_lnk l on l.order_id=o.id where l.marketplace_id=m.id and o.order_status in ('pending','accepted','delivered')) open_orders,
          (select p.id from publisher_websites p where p.marketplace_id=m.id order by p.id desc limit 1) pw_id
        from moderation_flags f join marketplaces m on m.id=f.marketplace_id where f.status=? order by (f.from_value - f.to_value) / nullif(f.from_value,0) desc nulls last, f.id limit 500`, [status]));
      const counts = rows(await knex().raw(`select kind, count(*)::int c from moderation_flags where status='open' group by 1`));
      ctx.send({ items: r.map((x) => ({ ...x, from_value: n(x.from_value), to_value: n(x.to_value), price: n(x.price) })), counts: Object.fromEntries(counts.map((c) => [c.kind, c.c])) });
    } catch (e) { fail(ctx, e); }
  },
  async flagsScan(ctx) { try { ctx.send(await svc.scanFlags(Math.min(30, Math.max(1, parseInt((ctx.request.body || {}).days, 10) || 2)))); } catch (e) { fail(ctx, e); } },
  async flagResolve(ctx) {
    try {
      const id = parseInt(ctx.params.id, 10);
      const b = ctx.request.body || {};
      if (!['keep', 'pause'].includes(b.resolution)) throw Object.assign(new Error('resolution must be keep or pause'), { status: 400 });
      const f = rows(await knex().raw("select * from moderation_flags where id=? and status='open'", [id]))[0];
      if (!f) throw Object.assign(new Error('Flag not open'), { status: 404 });
      if (b.resolution === 'pause') {
        await strapi.entityService.update('api::marketplace.marketplace', f.marketplace_id, { data: { status: 'paused', _audit: { source: 'moderation', userId: ctx.state.user.id, changedBy: adminName(ctx.state.user) } } });
      }
      // A resolved flag can repeat later; drop an older resolved twin so the unique key holds.
      await knex().raw("delete from moderation_flags where marketplace_id=? and kind=? and status='resolved'", [f.marketplace_id, f.kind]);
      await knex().raw("update moderation_flags set status='resolved', resolved_at=now(), resolved_by=?, resolution=? where id=?", [ctx.state.user.id, `${b.resolution}${b.note ? `: ${String(b.note).slice(0, 300)}` : ''}`, id]);
      await svc.logDecision({ itemType: 'flag', itemId: id, marketplaceId: f.marketplace_id, action: b.resolution === 'pause' ? 'pause' : 'keep', note: b.note, adminId: ctx.state.user.id, adminName: adminName(ctx.state.user), submittedAt: f.created_at });
      ctx.send({ ok: true });
    } catch (e) { fail(ctx, e); }
  },

  async lock(ctx) {
    try { const key = String((ctx.request.body || {}).key || ''); if (!/^(edit|site|flag):\d+$/.test(key)) return ctx.badRequest('Bad key'); ctx.send(await svc.claim(key, ctx.state.user)); } catch (e) { fail(ctx, e); }
  },
  async unlock(ctx) {
    try { const key = String((ctx.request.body || {}).key || ''); await svc.release(key, ctx.state.user.id); ctx.send({ ok: true }); } catch (e) { fail(ctx, e); }
  },

  async stats(ctx) {
    try {
      await svc.ensureTables();
      const [byAdmin, byDay, reasons] = await Promise.all([
        knex().raw(`select coalesce(admin_name, case when auto then 'auto' else '?' end) admin, count(*)::int decisions,
            count(*) filter (where action in ('approve','close_noise','keep'))::int approved, count(*) filter (where action in ('reject','ask_changes','pause'))::int rejected,
            percentile_cont(0.5) within group (order by extract(epoch from created_at - submitted_at)/3600) filter (where submitted_at is not null) median_hours
          from moderation_decisions where created_at > now() - interval '30 days' group by 1 order by 2 desc`),
        knex().raw(`select created_at::date d, item_type, count(*)::int c from moderation_decisions where created_at > now() - interval '14 days' group by 1,2 order by 1`),
        knex().raw(`select reason_code, count(*)::int c from moderation_decisions where reason_code is not null and created_at > now() - interval '30 days' group by 1 order by 2 desc`),
      ]);
      ctx.send({ byAdmin: rows(byAdmin).map((r) => ({ ...r, median_hours: r.median_hours != null ? Math.round(n(r.median_hours) * 10) / 10 : null })), byDay: rows(byDay), reasons: rows(reasons) });
    } catch (e) { fail(ctx, e); }
  },

  async saveSettings(ctx) {
    try {
      if (!isSuper(ctx)) return ctx.forbidden('Super admin only');
      const s = await svc.saveSettings(ctx.request.body || {}, ctx.state.user.id);
      await strapi.entityService.create('api::admin-audit-log.admin-audit-log', { data: { adminUser: ctx.state.user.id, action: 'moderation_settings', details: s, ipAddress: ctx.request.ip || null, createdAt: new Date(), updatedAt: new Date() } }).catch(() => {});
      ctx.send({ settings: s });
    } catch (e) { fail(ctx, e); }
  },
};
