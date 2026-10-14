'use strict';

/**
 * Admin: affiliate program (2026-10-14). Super admin only.
 *
 *   GET  /admin/affiliates                      partners with balances
 *   POST /admin/affiliates                      create partner
 *   GET  /admin/affiliates/flags                open fraud / invariant flags
 *   PUT  /admin/affiliates/flags/:id            { status: 'open'|'resolved'|'dismissed' }
 *   GET  /admin/affiliates/payouts              payouts (all partners)
 *   POST /admin/affiliates/payouts/run          { period? } → drafts
 *   PUT  /admin/affiliates/payouts/:id          { status: 'approved'|'paid'|'cancelled', reference?, notes? }
 *   POST /admin/affiliates/jobs/:name           release_holds | reconcile
 *   GET  /admin/affiliates/:id                  partner detail (ledger, referrals, pool, flags, payouts)
 *   PUT  /admin/affiliates/:id                  update partner
 *   POST /admin/affiliates/:id/adjust           { amount, reason } manual ledger adjustment
 *   POST /admin/affiliates/:id/referrals        { userId } attach a referral by hand (backfill)
 *   GET  /admin/affiliates/:id/statement        ?period=YYYY-MM → JSON; &format=pdf → PDF
 */
const aff = () => require('../../../services/affiliate');
const isSuper = (u) => u && u.role && u.role.type === 'super_admin';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const audit = (ctx, action, details) => strapi.entityService.create('api::admin-audit-log.admin-audit-log', {
  data: { adminUser: ctx.state.user.id, action, details, ipAddress: ctx.request.ip || null, createdAt: new Date(), updatedAt: new Date() },
}).catch(() => {});
const bad = (ctx, m) => ctx.badRequest(m);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => { const v = r2(n); return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`; };
const jsonOf = (v) => aff().jsonOf(v);
const normPartner = (p) => ({ ...p, tax_profile: jsonOf(p.tax_profile) || {}, payout_details: p.payout_details === undefined ? undefined : jsonOf(p.payout_details), min_payout: r2(p.min_payout), wallet_credit_multiplier: Number(p.wallet_credit_multiplier) });

const PARTNER_FIELDS = ['name', 'email', 'country', 'code', 'rate_bps', 'months', 'hold_days', 'min_payout', 'payout_method', 'payout_details', 'wallet_credit_multiplier', 'status', 'notes', 'tax_profile', 'user_id', 'api_key_id'];
function cleanPartner(b, cur = {}) {
  const A = aff(); const set = {};
  if (b.name !== undefined) set.name = String(b.name).trim().slice(0, 120);
  if (b.email !== undefined) set.email = String(b.email || '').trim().toLowerCase().slice(0, 200) || null;
  if (b.country !== undefined) set.country = String(b.country || '').trim().toUpperCase().slice(0, 2) || null;
  if (b.code !== undefined) set.code = A.slug(b.code);
  const int = (k, lo, hi) => { if (b[k] !== undefined) { const n = parseInt(b[k], 10); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`); set[k] = n; } };
  int('rate_bps', 0, 5000); int('months', 1, 120); int('hold_days', 0, 365);
  if (b.min_payout !== undefined) { const n = Number(b.min_payout); if (!Number.isFinite(n) || n < 0) throw new Error('min_payout must be a number'); set.min_payout = r2(n); }
  if (b.payout_method !== undefined) { if (!['cash', 'wallet_credit'].includes(b.payout_method)) throw new Error('payout_method must be cash or wallet_credit'); set.payout_method = b.payout_method; }
  if (b.payout_details !== undefined) set.payout_details = b.payout_details && typeof b.payout_details === 'object' ? JSON.stringify(b.payout_details) : null;
  if (b.wallet_credit_multiplier !== undefined) { const n = Number(b.wallet_credit_multiplier); if (!(n >= 1 && n <= 2)) throw new Error('wallet_credit_multiplier must be between 1 and 2'); set.wallet_credit_multiplier = n; }
  if (b.status !== undefined) { if (!['pending', 'active', 'paused', 'banned'].includes(b.status)) throw new Error('bad status'); set.status = b.status; }
  if (b.notes !== undefined) set.notes = String(b.notes || '').slice(0, 2000) || null;
  if (b.tax_profile !== undefined) {
    const t = b.tax_profile && typeof b.tax_profile === 'object' ? b.tax_profile : {};
    const curTp = jsonOf(cur.tax_profile) || {};
    const tp = { kind: ['india_gst', 'india_individual', 'us_w9', 'w8ben', 'other'].includes(t.kind) ? t.kind : curTp.kind || 'other',
      gst_number: t.gst_number ? String(t.gst_number).slice(0, 30) : null, pan: t.pan ? String(t.pan).slice(0, 20) : null, tax_id: t.tax_id ? String(t.tax_id).slice(0, 60) : null,
      withholding_bps: Math.max(0, Math.min(5000, parseInt(t.withholding_bps, 10) || 0)), form_received: !!t.form_received, complete: !!t.complete, notes: t.notes ? String(t.notes).slice(0, 500) : null };
    set.tax_profile = JSON.stringify(tp);
  }
  if (b.user_id !== undefined) set.user_id = b.user_id ? parseInt(b.user_id, 10) : null;
  if (b.api_key_id !== undefined) set.api_key_id = b.api_key_id ? parseInt(b.api_key_id, 10) : null;
  return set;
}

async function partnerSummary(k, where = '', binds = []) {
  return (await k.raw(`select p.*, u.email as user_email, u.username as user_name, ak.label as api_key_label,
      (select count(*) from affiliate_referrals r where r.partner_id = p.id and r.status = 'active')::int referred_active,
      (select count(*) from affiliate_referrals r where r.partner_id = p.id)::int referred_total,
      coalesce((select sum(base_amount) from affiliate_ledger l where l.partner_id = p.id and l.kind = 'commission'), 0) referred_revenue,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = p.id and l.kind = 'commission' and l.status = 'pending'), 0) pending,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = p.id and l.kind = 'commission' and l.status = 'frozen'), 0) frozen,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = p.id and l.payout_id is null and ((l.kind = 'commission' and l.status = 'payable') or l.kind in ('reversal', 'adjustment'))), 0) available,
      coalesce((select sum(gross) from affiliate_payouts y where y.partner_id = p.id and y.status = 'paid'), 0) paid,
      (select count(*) from affiliate_flags f where f.partner_id = p.id and f.status = 'open')::int open_flags,
      (select max(created_at) from affiliate_ledger l where l.partner_id = p.id) last_activity
      from affiliate_partners p left join up_users u on u.id = p.user_id left join api_keys ak on ak.id = p.api_key_id ${where} order by p.status = 'active' desc, p.created_at`, binds)).rows
    .map((p) => ({ ...normPartner(p), referred_revenue: r2(p.referred_revenue), pending: r2(p.pending), frozen: r2(p.frozen), available: r2(p.available), paid: r2(p.paid), payout_details: undefined, has_payout_details: !!p.payout_details }));
}

const statementSvc = () => require('../../../services/affiliate-statement');

module.exports = {
  async list(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    ctx.send({ data: await partnerSummary(strapi.db.connection) });
  },

  async create(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    let set; try { set = cleanPartner(ctx.request.body || {}); } catch (e) { return bad(ctx, e.message); }
    if (!set.name || set.name.length < 2) return bad(ctx, 'Name is required');
    if (!set.code || set.code.length < 2) return bad(ctx, 'Code is required (letters, numbers, dashes)');
    if (/^api-\d+$/.test(set.code)) return bad(ctx, 'Codes like api-7 are reserved; link the API key with api_key_id instead');
    if (await aff().partnerByCode(set.code)) return bad(ctx, `Code "${set.code}" is already used`);
    const cols = Object.keys(set); const vals = cols.map((c) => set[c]);
    const sqlCols = cols.map((c) => (c === 'tax_profile' || c === 'payout_details') && set[c] != null ? `?::jsonb` : '?');
    const row = (await strapi.db.connection.raw(`insert into affiliate_partners (${cols.join(',')}, created_by) values (${sqlCols.join(',')}, ?) returning *`, [...vals, ctx.state.user.id])).rows[0];
    await audit(ctx, 'affiliate.partner.create', { id: row.id, code: row.code, name: row.name });
    ctx.send({ data: normPartner(row) });
  },

  async detail(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    const id = parseInt(ctx.params.id, 10); const k = strapi.db.connection;
    const [p] = await partnerSummary(k, 'where p.id = ?', [id]);
    if (!p) return ctx.notFound('Partner not found');
    const q = async (sql, b) => (await k.raw(sql, b)).rows;
    const [ledger, referrals, pool, flags, payouts, balance] = await Promise.all([
      q(`select l.*, o.total_amount as order_total from affiliate_ledger l left join orders o on o.id = l.order_id where l.partner_id = ? order by l.created_at desc, l.id desc limit 300`, [id]),
      q(`select r.*, u.email, u.username, u.created_at as signup_at,
          coalesce((select sum(amount) from affiliate_deposit_pool d where d.user_id = r.user_id), 0) deposits,
          coalesce((select sum(base_amount) from affiliate_ledger l where l.user_id = r.user_id and l.kind = 'commission'), 0) commissionable,
          coalesce((select sum(amount) from affiliate_ledger l where l.user_id = r.user_id and l.kind in ('commission', 'reversal')), 0) commission
          from affiliate_referrals r left join up_users u on u.id = r.user_id where r.partner_id = ? order by r.created_at desc limit 500`, [id]),
      q(`select d.user_id, count(*)::int deposits, sum(d.amount) total, sum(d.remaining) remaining, count(*) filter (where d.status in ('disputed', 'reversed', 'partial'))::int troubled
          from affiliate_deposit_pool d join affiliate_referrals r on r.user_id = d.user_id where r.partner_id = ? group by d.user_id`, [id]),
      q(`select * from affiliate_flags where partner_id = ? order by status = 'open' desc, created_at desc limit 100`, [id]),
      q(`select * from affiliate_payouts where partner_id = ? order by period desc`, [id]),
      aff().partnerBalance(id, k),
    ]);
    const details = (await k.raw('select payout_details from affiliate_partners where id = ?', [id])).rows[0];
    ctx.send({ data: { partner: { ...p, payout_details: jsonOf(details && details.payout_details) }, balance, ledger, referrals: referrals.map((r) => ({ ...r, utm: jsonOf(r.utm) })), pool, flags, payouts } });
  },

  async update(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    const id = parseInt(ctx.params.id, 10); const k = strapi.db.connection;
    const cur = (await k.raw('select * from affiliate_partners where id = ?', [id])).rows[0];
    if (!cur) return ctx.notFound('Partner not found');
    let set; try { set = cleanPartner(ctx.request.body || {}, cur); } catch (e) { return bad(ctx, e.message); }
    if (set.code && set.code !== cur.code && await aff().partnerByCode(set.code)) return bad(ctx, `Code "${set.code}" is already used`);
    if (!Object.keys(set).length) return bad(ctx, 'Nothing to change');
    const cols = Object.keys(set);
    await k.raw(`update affiliate_partners set ${cols.map((c) => `${c} = ${(c === 'tax_profile' || c === 'payout_details') && set[c] != null ? '?::jsonb' : '?'}`).join(', ')}, updated_at = now() where id = ?`, [...cols.map((c) => set[c]), id]);
    if (set.status === 'active' && cur.status !== 'active') await k.raw(`update affiliate_ledger set status = case when hold_until <= now() then 'payable' else 'pending' end where partner_id = ? and kind = 'commission' and status = 'frozen' and payout_id is null and coalesce(reason, '') like 'partner %'`, [id]);
    await audit(ctx, 'affiliate.partner.update', { id, changes: cols, rate_changed: set.rate_bps !== undefined && set.rate_bps !== cur.rate_bps ? [cur.rate_bps, set.rate_bps] : undefined });
    ctx.send({ ok: true });
  },

  async adjust(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    const id = parseInt(ctx.params.id, 10); const b = ctx.request.body || {};
    const amount = r2(b.amount); const reason = String(b.reason || '').trim();
    if (!amount) return bad(ctx, 'amount must be a non-zero number');
    if (reason.length < 5) return bad(ctx, 'Give a reason (at least 5 characters)');
    const row = (await strapi.db.connection.raw(`insert into affiliate_ledger (partner_id, kind, amount, status, event_source, event_id, reason, created_by) values (?, 'adjustment', ?, 'payable', 'admin', ?, ?, ?) returning *`,
      [id, amount, `adjust:${id}:${Date.now()}`, reason, ctx.state.user.id])).rows[0];
    await audit(ctx, 'affiliate.adjust', { partnerId: id, amount, reason, ledgerId: row.id });
    ctx.send({ data: row });
  },

  async attachReferral(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    const id = parseInt(ctx.params.id, 10); const userId = parseInt((ctx.request.body || {}).userId, 10); const k = strapi.db.connection;
    const p = (await k.raw('select * from affiliate_partners where id = ?', [id])).rows[0];
    if (!p) return ctx.notFound('Partner not found');
    const u = await strapi.db.query('plugin::users-permissions.user').findOne({ where: { id: userId }, select: ['id', 'email', 'createdAt', 'signupAttribution'] });
    if (!u) return bad(ctx, 'User not found');
    if (p.user_id && Number(p.user_id) === userId) return bad(ctx, 'A partner cannot refer their own account');
    const exists = (await k.raw('select * from affiliate_referrals where user_id = ?', [userId])).rows[0];
    if (exists) return bad(ctx, `User already has a referral (partner #${exists.partner_id}, ${exists.status})`);
    const expires = new Date(new Date(u.createdAt).getTime() + (p.months || 12) * 30.4375 * 86400000);
    // created_at = the user's signup, so every deposit since then counts (backfill)
    const row = (await k.raw(`insert into affiliate_referrals (user_id, partner_id, code, landing, status, expires_at, created_at) values (?, ?, ?, ?, 'active', ?, ?) returning *`, [userId, id, p.code, 'manual:admin', expires, new Date(u.createdAt)])).rows[0];
    await audit(ctx, 'affiliate.referral.attach', { partnerId: id, userId });
    ctx.send({ data: row });
  },

  async flags(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    const status = ['open', 'resolved', 'dismissed'].includes(ctx.query.status) ? ctx.query.status : 'open';
    ctx.send({ data: (await strapi.db.connection.raw(`select f.*, p.name as partner_name, p.code as partner_code, u.email as user_email from affiliate_flags f left join affiliate_partners p on p.id = f.partner_id left join up_users u on u.id = f.user_id where f.status = ? order by f.created_at desc limit 300`, [status])).rows });
  },

  async updateFlag(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    const id = parseInt(ctx.params.id, 10); const status = (ctx.request.body || {}).status;
    if (!['open', 'resolved', 'dismissed'].includes(status)) return bad(ctx, 'status must be open, resolved or dismissed');
    const k = strapi.db.connection;
    const f = (await k.raw('update affiliate_flags set status = ? where id = ? returning *', [status, id])).rows[0];
    if (!f) return ctx.notFound('Flag not found');
    if (f.kind === 'collusion' && f.order_id && status === 'dismissed') await k.raw(`update affiliate_ledger set status = case when hold_until <= now() then 'payable' else 'pending' end where order_id = ? and kind = 'commission' and status = 'frozen' and reason = 'collusion check'`, [f.order_id]);
    await audit(ctx, 'affiliate.flag.update', { id, status, kind: f.kind });
    ctx.send({ data: f });
  },

  async payouts(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    ctx.send({ data: (await strapi.db.connection.raw(`select y.*, p.name as partner_name, p.code as partner_code, p.payout_method as partner_method from affiliate_payouts y join affiliate_partners p on p.id = y.partner_id order by y.period desc, y.id desc limit 300`)).rows });
  },

  async runPayouts(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    const period = /^\d{4}-\d{2}$/.test((ctx.request.body || {}).period || '') ? ctx.request.body.period : new Date().toISOString().slice(0, 7);
    const drafts = await aff().payoutRun(period);
    await audit(ctx, 'affiliate.payout.run', { period, drafts: drafts.map((d) => d.id) });
    ctx.send({ data: drafts, period });
  },

  async updatePayout(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    const id = parseInt(ctx.params.id, 10); const b = ctx.request.body || {}; const k = strapi.db.connection;
    const d = (await k.raw('select * from affiliate_payouts where id = ?', [id])).rows[0];
    if (!d) return ctx.notFound('Payout not found');
    if (d.status === 'paid') return bad(ctx, 'Already paid');
    if (b.status === 'approved') { if (d.status !== 'draft') return bad(ctx, `Cannot approve a ${d.status} payout`); await k.raw(`update affiliate_payouts set status = 'approved', approved_by = ?, approved_at = now(), notes = coalesce(?, notes) where id = ?`, [ctx.state.user.id, b.notes || null, id]); }
    else if (b.status === 'paid') {
      if (d.status !== 'approved') return bad(ctx, 'Approve the payout first');
      if (d.method === 'cash' && !String(b.reference || '').trim()) return bad(ctx, 'Enter the payment reference (transfer id)');
      await aff().markPaid(id, ctx.state.user.id, String(b.reference || '').trim() || null);
    } else if (b.status === 'cancelled') {
      await k.raw(`update affiliate_ledger set payout_id = null where payout_id = ?`, [id]);
      await k.raw(`update affiliate_payouts set status = 'cancelled', notes = coalesce(?, notes) where id = ?`, [b.notes || null, id]);
    } else return bad(ctx, 'status must be approved, paid or cancelled');
    await audit(ctx, `affiliate.payout.${b.status}`, { id, partnerId: d.partner_id, net: d.net, reference: b.reference });
    ctx.send({ data: (await k.raw('select * from affiliate_payouts where id = ?', [id])).rows[0] });
  },

  async runJob(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    const name = ctx.params.name;
    let result;
    if (name === 'release_holds') result = await aff().releaseHolds();
    else if (name === 'reconcile') result = await aff().reconcile();
    else return bad(ctx, 'job must be release_holds or reconcile');
    await audit(ctx, 'affiliate.job', { name, result });
    ctx.send({ data: result });
  },

  async statement(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    await aff().ensure();
    const id = parseInt(ctx.params.id, 10); const k = strapi.db.connection;
    const period = /^\d{4}-\d{2}$/.test(ctx.query.period || '') ? ctx.query.period : new Date().toISOString().slice(0, 7);
    const p = (await k.raw('select * from affiliate_partners where id = ?', [id])).rows[0];
    if (!p) return ctx.notFound('Partner not found');
    if (ctx.query.format === 'pdf' || ctx.query.format === 'html') return statementSvc().send(ctx, p, period, ctx.query.format);
    const s = await statementSvc().data(k, id, period);
    ctx.send({ data: { partner: { id: p.id, name: p.name, code: p.code }, ...s } });
  },

  /** The tax document a partner uploaded (stored outside the public dir). */
  async document(ctx) {
    if (!isSuper(ctx.state.user)) return ctx.forbidden('Super admin only');
    const id = parseInt(ctx.params.id, 10);
    const p = (await strapi.db.connection.raw('select tax_profile from affiliate_partners where id = ?', [id])).rows[0];
    const tp = p && (aff().jsonOf(p.tax_profile) || {});
    if (!tp || !tp.document || !tp.document.stored) return ctx.notFound('No document uploaded');
    const fs = require('fs'); const path = require('path');
    const dir = process.env.AFFILIATE_DOCS_DIR || path.join(process.cwd(), 'private', 'affiliate-docs');
    const file = path.join(dir, path.basename(tp.document.stored));
    if (!fs.existsSync(file)) return ctx.notFound('File missing on disk');
    await audit(ctx, 'affiliate.document.view', { partnerId: id });
    ctx.type = tp.document.type || 'application/octet-stream'; ctx.set('Content-Disposition', `inline; filename="${String(tp.document.name || 'document').replace(/"/g, '')}"`); ctx.body = fs.createReadStream(file);
  },
};
