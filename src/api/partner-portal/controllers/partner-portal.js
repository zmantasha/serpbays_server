'use strict';

/**
 * Partner portal (customer app side), 2026-10-14. Users-permissions JWT.
 *
 *   GET  /partner-portal/me             my partner record, stats, ledger (no buyer identities), payouts
 *   PUT  /partner-portal/me             payout details, country, tax details (never rate / status / complete)
 *   POST /partner-portal/me/document    multipart `file`: tax form (PDF/JPG/PNG, 5 MB), stored privately
 *   GET  /partner-portal/statement      ?period=YYYY-MM&format=pdf|html
 *   POST /partner-portal/apply          become a partner (creates a pending partner for this account)
 *   POST /partner-portal/apply-public   from serpbays.com/affiliates (no login; rate limited)
 */
const aff = () => require('../../../services/affiliate');
const statement = () => require('../../../services/affiliate-statement');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const APP_URL = () => process.env.APP_PUBLIC_URL || 'https://app.serpbays.com';
const ALERT_TO = () => (process.env.AFFILIATE_ALERT_TO || process.env.USER_DELETE_ALERT_TO || 'vinayak@wordscloud.in').split(',').map((s) => s.trim()).filter(Boolean);
const PUBLIC_FIELDS = ['id', 'name', 'code', 'status', 'rate_bps', 'months', 'hold_days', 'min_payout', 'payout_method', 'wallet_credit_multiplier', 'country', 'created_at', 'email'];

const one = async (sql, b = []) => (await strapi.db.connection.raw(sql, b)).rows[0] || null;
const rows = async (sql, b = []) => (await strapi.db.connection.raw(sql, b)).rows;

/** The partner row for this user: by user_id, or by email for a public application (links it). */
async function myPartner(user) {
  let p = await one('select * from affiliate_partners where user_id = ?', [user.id]);
  if (!p && user.email) {
    p = await one('select * from affiliate_partners where user_id is null and lower(email) = lower(?) order by id limit 1', [user.email]);
    if (p) { await strapi.db.connection.raw('update affiliate_partners set user_id = ?, updated_at = now() where id = ?', [user.id, p.id]); p.user_id = user.id; }
  }
  return p;
}

function publicPartner(p) {
  const out = {}; for (const k of PUBLIC_FIELDS) out[k] = p[k];
  out.min_payout = r2(p.min_payout); out.wallet_credit_multiplier = Number(p.wallet_credit_multiplier);
  const tp = aff().jsonOf(p.tax_profile) || {};
  out.tax_profile = { kind: tp.kind || null, gst_number: tp.gst_number || null, pan: tp.pan || null, tax_id: tp.tax_id || null, withholding_bps: tp.withholding_bps || 0, form_received: !!tp.form_received, complete: !!tp.complete, document: tp.document ? { name: tp.document.name, uploaded_at: tp.document.uploaded_at } : null };
  out.payout_details = aff().jsonOf(p.payout_details) || null;
  return out;
}

async function alertAdmins(subject, html, partnerId) {
  try { await strapi.service('api::admin-email.admin-email').sendAdminEmail({ to: ALERT_TO(), subject, bodyHtml: html + `<p style="color:#64748b;font-size:12px">Review: ${esc(process.env.ADMIN_PANEL_URL || 'https://prod-panel20.serpbays.com')}/affiliates${partnerId ? '/' + partnerId : ''}</p>`, senderAdminId: null, contextType: 'none' }); }
  catch (e) { strapi.log.error(`[partner-portal] alert: ${e.message}`); }
}

async function uniqueCode(base) {
  const A = aff(); let code = A.slug(base) || 'partner'; if (/^api-\d+$/.test(code)) code = `p-${code}`;
  let c = code; for (let i = 2; i < 50; i += 1) { if (!(await A.partnerByCode(c))) return c; c = `${code}-${i}`; }
  return `${code}-${Date.now().toString(36)}`;
}

module.exports = {
  async me(ctx) {
    await aff().ensure();
    const user = ctx.state.user;
    const p = await myPartner(user);
    if (!p) return ctx.send({ data: { partner: null } });
    const [balance, ledger, payouts, counts] = await Promise.all([
      aff().partnerBalance(p.id),
      rows(`select id, created_at, kind, order_id, base_amount, amount, status, hold_until, payout_id from affiliate_ledger where partner_id = ? order by created_at desc, id desc limit 200`, [p.id]),
      rows(`select id, period, gross, fee, tax, net, method, status, reference, paid_at, created_at from affiliate_payouts where partner_id = ? and status <> 'cancelled' order by period desc`, [p.id]),
      one(`select (select count(*) from affiliate_referrals r where r.partner_id = ? and r.status = 'active')::int referred_active,
                  (select count(*) from affiliate_referrals r where r.partner_id = ?)::int referred_total,
                  coalesce((select sum(base_amount) from affiliate_ledger l where l.partner_id = ? and l.kind = 'commission'), 0) referred_revenue,
                  (select count(*) from affiliate_referrals r where r.partner_id = ? and r.created_at >= date_trunc('month', now()))::int signups_this_month`, [p.id, p.id, p.id, p.id]),
    ]);
    const periods = (await rows(`select distinct to_char(created_at, 'YYYY-MM') period from affiliate_ledger where partner_id = ? order by 1 desc limit 24`, [p.id])).map((r) => r.period);
    ctx.send({ data: { partner: publicPartner(p), link: `${APP_URL()}/register?ref=${p.code}`,
      stats: { ...balance, referred_active: counts.referred_active, referred_total: counts.referred_total, referred_revenue: r2(counts.referred_revenue), signups_this_month: counts.signups_this_month },
      ledger: ledger.map((l) => ({ ...l, amount: r2(l.amount), base_amount: l.base_amount == null ? null : r2(l.base_amount), label: statement().KIND_LABEL[l.kind] || l.kind })),
      payouts, statement_periods: periods } });
  },

  async update(ctx) {
    await aff().ensure();
    const p = await myPartner(ctx.state.user);
    if (!p) return ctx.notFound('You are not a partner yet');
    const b = ctx.request.body || {}; const set = {};
    if (b.payout_method !== undefined) { if (!['cash', 'wallet_credit'].includes(b.payout_method)) return ctx.badRequest('payout_method must be cash or wallet_credit'); set.payout_method = b.payout_method; }
    if (b.payout_details !== undefined) {
      const d = b.payout_details && typeof b.payout_details === 'object' ? b.payout_details : {};
      const clean = {}; for (const k of ['method', 'to', 'account_name', 'bank', 'iban_or_account', 'swift_or_ifsc', 'notes']) if (d[k] != null) clean[k] = String(d[k]).slice(0, 200);
      set.payout_details = JSON.stringify(clean);
    }
    if (b.country !== undefined) set.country = String(b.country || '').trim().toUpperCase().slice(0, 2) || null;
    if (b.name !== undefined && String(b.name).trim().length >= 2) set.name = String(b.name).trim().slice(0, 120);
    if (b.tax !== undefined && b.tax && typeof b.tax === 'object') {
      const cur = aff().jsonOf(p.tax_profile) || {};
      const t = b.tax; const kind = ['india_gst', 'india_individual', 'us_w9', 'w8ben', 'other'].includes(t.kind) ? t.kind : cur.kind || 'other';
      // partners can fill their details; `complete` and the withholding rate are set by Serpbays after checking them
      set.tax_profile = JSON.stringify({ ...cur, kind, gst_number: t.gst_number ? String(t.gst_number).slice(0, 30) : cur.gst_number || null, pan: t.pan ? String(t.pan).slice(0, 20) : cur.pan || null, tax_id: t.tax_id ? String(t.tax_id).slice(0, 60) : cur.tax_id || null, legal_name: t.legal_name ? String(t.legal_name).slice(0, 160) : cur.legal_name || null, address: t.address ? String(t.address).slice(0, 300) : cur.address || null, partner_updated_at: new Date().toISOString() });
    }
    if (!Object.keys(set).length) return ctx.badRequest('Nothing to change');
    const cols = Object.keys(set);
    await strapi.db.connection.raw(`update affiliate_partners set ${cols.map((c) => `${c} = ${(c === 'tax_profile' || c === 'payout_details') ? '?::jsonb' : '?'}`).join(', ')}, updated_at = now() where id = ?`, [...cols.map((c) => set[c]), p.id]);
    ctx.send({ ok: true, data: publicPartner(await one('select * from affiliate_partners where id = ?', [p.id])) });
  },

  async uploadDocument(ctx) {
    await aff().ensure();
    const p = await myPartner(ctx.state.user);
    if (!p) return ctx.notFound('You are not a partner yet');
    const f = ctx.request.files && (ctx.request.files.file || Object.values(ctx.request.files)[0]);
    if (!f) return ctx.badRequest('Attach the file as "file"');
    const file = Array.isArray(f) ? f[0] : f;
    const size = file.size; const name = String(file.originalFilename || file.name || 'document'); const type = String(file.mimetype || file.type || '');
    if (size > 5 * 1024 * 1024) return ctx.badRequest('File must be 5 MB or smaller');
    if (!['application/pdf', 'image/jpeg', 'image/png'].includes(type)) return ctx.badRequest('Upload a PDF, JPG or PNG');
    const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
    const dir = process.env.AFFILIATE_DOCS_DIR || path.join(process.cwd(), 'private', 'affiliate-docs'); fs.mkdirSync(dir, { recursive: true });
    const ext = type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg';
    const stored = `${p.id}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
    fs.copyFileSync(file.filepath || file.path, path.join(dir, stored));
    const cur = aff().jsonOf(p.tax_profile) || {};
    const tp = { ...cur, form_received: true, document: { name: name.slice(0, 120), stored, type, size, uploaded_at: new Date().toISOString() } };
    await strapi.db.connection.raw('update affiliate_partners set tax_profile = ?::jsonb, updated_at = now() where id = ?', [JSON.stringify(tp), p.id]);
    await alertAdmins(`Affiliate ${p.name} uploaded a tax document`, `<p><b>${esc(p.name)}</b> (${esc(p.code)}) uploaded <b>${esc(name)}</b>. Check it and mark the tax profile complete to allow payouts.</p>`, p.id);
    ctx.send({ ok: true, document: { name: tp.document.name, uploaded_at: tp.document.uploaded_at } });
  },

  async statement(ctx) {
    await aff().ensure();
    const p = await myPartner(ctx.state.user);
    if (!p) return ctx.notFound('You are not a partner yet');
    const period = /^\d{4}-\d{2}$/.test(ctx.query.period || '') ? ctx.query.period : new Date().toISOString().slice(0, 7);
    await statement().send(ctx, p, period, ctx.query.format === 'html' ? 'html' : 'pdf');
  },

  async apply(ctx) {
    await aff().ensure();
    const user = ctx.state.user;
    const existing = await myPartner(user);
    if (existing) return ctx.send({ data: publicPartner(existing), existing: true });
    const b = ctx.request.body || {};
    const name = String(b.name || user.business_name || user.username || user.email.split('@')[0]).trim().slice(0, 120);
    if (name.length < 2) return ctx.badRequest('Tell us your name or company');
    const website = String(b.website || '').trim().slice(0, 200); const how = String(b.how || '').trim().slice(0, 1000);
    const code = await uniqueCode(name);
    const p = await one(`insert into affiliate_partners (user_id, name, email, country, code, status, notes, tax_profile) values (?, ?, ?, ?, ?, 'pending', ?, '{"complete": false}'::jsonb) returning *`,
      [user.id, name, user.email, (user.country || user.signupCountry || '').toString().toUpperCase().slice(0, 2) || null, code, `Applied from the app on ${new Date().toISOString().slice(0, 10)}.${website ? ` Website: ${website}.` : ''}${how ? ` How they will promote: ${how}` : ''}`]);
    await alertAdmins(`Affiliate application: ${name}`, `<p><b>${esc(name)}</b> (${esc(user.email)}, user #${user.id}) applied to the partner program from the app.</p><p>${website ? 'Website: ' + esc(website) + '<br>' : ''}${how ? 'How: ' + esc(how) : ''}</p><p>Approve by setting the partner to Active.</p>`, p.id);
    ctx.send({ data: publicPartner(p) });
  },

  async applyPublic(ctx) {
    await aff().ensure();
    const b = ctx.request.body || {};
    const name = String(b.name || '').trim().slice(0, 120); const email = String(b.email || '').trim().toLowerCase().slice(0, 200);
    const website = String(b.website || '').trim().slice(0, 200); const audience = String(b.audience || '').trim().slice(0, 200); const message = String(b.message || '').trim().slice(0, 1000);
    if (name.length < 2) return ctx.badRequest('Name is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return ctx.badRequest('A valid email is required');
    if (b.company_url) return ctx.send({ ok: true }); // honeypot
    const dupe = await one('select id from affiliate_partners where lower(email) = ?', [email]);
    if (dupe) return ctx.send({ ok: true }); // do not reveal
    const user = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { email }, select: ['id'] });
    const code = await uniqueCode(name);
    const p = await one(`insert into affiliate_partners (user_id, name, email, code, status, notes, tax_profile) values (?, ?, ?, ?, 'pending', ?, '{"complete": false}'::jsonb) returning *`,
      [user ? user.id : null, name, email, code, `Applied from serpbays.com/affiliates on ${new Date().toISOString().slice(0, 10)}.${website ? ` Website: ${website}.` : ''}${audience ? ` Audience: ${audience}.` : ''}${message ? ` Message: ${message}` : ''}`]);
    await alertAdmins(`Affiliate application: ${name}`, `<p><b>${esc(name)}</b> (${esc(email)}${user ? ', existing user #' + user.id : ', no Serpbays account yet'}) applied from serpbays.com/affiliates.</p><p>${website ? 'Website: ' + esc(website) + '<br>' : ''}${audience ? 'Audience: ' + esc(audience) + '<br>' : ''}${message ? 'Message: ' + esc(message) : ''}</p><p>Approve by setting the partner to Active; they manage everything at ${esc(APP_URL())}/partner once they sign in with this email.</p>`, p.id);
    ctx.send({ ok: true });
  },
};
