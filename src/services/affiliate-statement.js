'use strict';

/**
 * Affiliate statement: data, HTML and PDF (2026-10-14). Shared by the admin
 * API and the partner portal. Counts and amounts only, never buyer identities.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => { const v = r2(n); return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`; };
const KIND_LABEL = { commission: 'Commission', reversal: 'Reversal (refund / chargeback)', adjustment: 'Adjustment', payout: 'Payout', payout_fee: 'Gateway fee', tax_withheld: 'Tax withheld' };

async function data(k, partnerId, period) {
  const start = `${period}-01`;
  const q = async (sql, b) => (await k.raw(sql, b)).rows;
  const one = async (sql, b) => (await k.raw(sql, b)).rows[0] || {};
  const [a] = await q(`select
      (select count(*) from affiliate_referrals r where r.partner_id = ? and date_trunc('month', r.created_at) = ?::date)::int signups,
      (select count(distinct order_id) from affiliate_ledger l where l.partner_id = ? and l.kind = 'commission' and date_trunc('month', l.created_at) = ?::date)::int orders,
      coalesce((select sum(base_amount) from affiliate_ledger l where l.partner_id = ? and l.kind = 'commission' and date_trunc('month', l.created_at) = ?::date), 0) base,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = ? and l.kind = 'commission' and date_trunc('month', l.created_at) = ?::date), 0) earned,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = ? and l.kind = 'reversal' and date_trunc('month', l.created_at) = ?::date), 0) reversals,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = ? and l.kind = 'adjustment' and date_trunc('month', l.created_at) = ?::date), 0) adjustments,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = ? and l.kind = 'commission' and l.status in ('payable', 'paid') and date_trunc('month', l.hold_until) = ?::date), 0) released,
      coalesce((select sum(amount) from affiliate_ledger l where l.partner_id = ? and l.kind = 'commission' and l.status = 'pending'), 0) pending_end`,
    [...Array(7).fill([partnerId, start]).flat(), partnerId]);
  const payout = await one(`select * from affiliate_payouts where partner_id = ? and period = ?`, [partnerId, period]);
  const carried = await one(`select coalesce(sum(amount) filter (where created_at < ?::date), 0) before_sum, coalesce(sum(amount), 0) total
      from affiliate_ledger where partner_id = ? and ((kind = 'commission' and status in ('payable', 'paid')) or kind in ('reversal', 'adjustment', 'payout'))`, [start, partnerId]);
  const rows = await q(`select id, created_at, kind, order_id, base_amount, amount, status, hold_until from affiliate_ledger where partner_id = ? and date_trunc('month', created_at) = ?::date order by created_at, id`, [partnerId, start]);
  return { period, signups: a.signups, orders: a.orders, base: r2(a.base), earned: r2(a.earned), reversals: r2(a.reversals), adjustments: r2(a.adjustments), released: r2(a.released), pending_end: r2(a.pending_end),
    payout: payout.id ? payout : null, carried_in: r2(carried.before_sum), carried_out: r2(carried.total), rows };
}

function html(p, period, s) {
  const row = (l) => `<tr><td>${esc(new Date(l.created_at).toISOString().slice(0, 10))}</td><td>${esc(KIND_LABEL[l.kind] || l.kind)}</td><td>${l.order_id ? '#' + l.order_id : ''}</td><td style="text-align:right">${l.base_amount != null ? money(l.base_amount) : ''}</td><td style="text-align:right">${money(l.amount)}</td><td>${esc(l.status)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Serpbays affiliate statement ${esc(period)}</title>
<style>@page{size:A4;margin:16mm} body{font-family:Outfit,Inter,Arial,sans-serif;color:#364153;font-size:11pt} h1{font-size:22pt;color:#101828;margin:0 0 4px} .mark{font-weight:700;font-size:16pt;color:#101828} .mark b{color:#FE6E00}
.top{display:flex;justify-content:space-between;border-bottom:2px solid #FE6E00;padding-bottom:8px;margin-bottom:16px} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0} .tile{border:1px solid #E5E7EB;border-radius:8px;padding:10px} .tile .k{font-size:9pt;color:#99A1AF} .tile .v{font-size:15pt;font-weight:600;color:#101828}
table{width:100%;border-collapse:collapse;font-size:9.5pt} th{text-align:left;color:#99A1AF;font-weight:500;font-size:8.5pt;text-transform:uppercase;border-bottom:1px solid #E5E7EB;padding:5px} td{border-bottom:1px solid #F3F4F6;padding:5px} .ink{background:#101828;color:#fff;border-radius:10px;padding:14px 16px;margin:14px 0} .ink td{color:#fff;border-color:#2a3344} .muted{color:#99A1AF;font-size:9pt}</style></head><body>
<div class="top"><div class="mark"><b>S</b>erpbays</div><div class="muted">Affiliate statement · ${esc(period)}</div></div>
<h1>${esc(p.name)}</h1><div class="muted">Partner code <b>${esc(p.code)}</b> · ${esc(p.email || '')} · rate ${p.rate_bps / 100}% · hold ${p.hold_days} days</div>
<div class="grid"><div class="tile"><div class="k">New referred signups</div><div class="v">${s.signups}</div></div><div class="tile"><div class="k">Orders completed</div><div class="v">${s.orders}</div></div><div class="tile"><div class="k">Commissionable base</div><div class="v">${money(s.base)}</div></div><div class="tile"><div class="k">Commission earned</div><div class="v">${money(s.earned)}</div></div></div>
<div class="ink"><table><tr><td>Balance carried in</td><td style="text-align:right">${money(s.carried_in)}</td></tr><tr><td>Earned this period</td><td style="text-align:right">${money(s.earned)}</td></tr><tr><td>Reversals (refunds / chargebacks)</td><td style="text-align:right">${money(s.reversals)}</td></tr><tr><td>Adjustments</td><td style="text-align:right">${money(s.adjustments)}</td></tr><tr><td>Became payable this period</td><td style="text-align:right">${money(s.released)}</td></tr>
${s.payout ? `<tr><td>Payout ${esc(s.payout.method === 'wallet_credit' ? 'as wallet credit' : 'cash')} ${esc(s.payout.status)}: gross ${money(s.payout.gross)}${Number(s.payout.fee) ? ' − fee ' + money(s.payout.fee) : ''}${Number(s.payout.tax) ? ' − tax ' + money(s.payout.tax) : ''}</td><td style="text-align:right"><b>${money(s.payout.net)}</b>${s.payout.reference ? ' · ' + esc(s.payout.reference) : ''}</td></tr>` : '<tr><td>Payout this period</td><td style="text-align:right">none (below minimum or nothing payable)</td></tr>'}
<tr><td>Still pending (in hold) at period end</td><td style="text-align:right">${money(s.pending_end)}</td></tr><tr><td><b>Balance carried forward</b></td><td style="text-align:right"><b>${money(s.carried_out)}</b></td></tr></table></div>
<h3 style="color:#101828">Ledger entries this period</h3>
<table><thead><tr><th>Date</th><th>Kind</th><th>Order</th><th style="text-align:right">Base</th><th style="text-align:right">Amount</th><th>Status</th></tr></thead><tbody>${s.rows.map(row).join('') || '<tr><td colspan="6" class="muted">No entries</td></tr>'}</tbody></table>
<p class="muted">Commission is ${p.rate_bps / 100}% of completed orders paid from referred buyers' own deposits, payable ${p.hold_days} days after completion. Refunds and chargebacks are reversed. Counts and amounts only; buyer identities are not shared. Serpbays · serpbays.com</p>
</body></html>`;
}

async function pdf(htmlString) {
  const fs = require('fs'); const os = require('os'); const path = require('path'); const { execFile } = require('child_process');
  // the snap-packaged chromium can only write under $HOME (non-hidden dirs), not under arbitrary /tmp subdirs
  const base = process.env.AFFILIATE_PDF_DIR || path.join(os.homedir(), 'serpbays-statements'); fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'stmt-')); const inFile = path.join(dir, 'statement.html'); const out = path.join(dir, 'statement.pdf');
  fs.writeFileSync(inFile, htmlString);
  const bin = process.env.CHROMIUM_BIN || '/snap/bin/chromium';
  await new Promise((res, rej) => execFile(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, `file://${inFile}`], { timeout: 60000 }, (e) => (e ? rej(e) : res())));
  const buf = fs.readFileSync(out); fs.rmSync(dir, { recursive: true, force: true }); return buf;
}

/** Sends the statement as PDF (HTML fallback) on a Koa ctx. */
async function send(ctx, partner, period, format) {
  const s = await data(strapi.db.connection, partner.id, period);
  const h = html(partner, period, s);
  if (format === 'html') { ctx.type = 'text/html; charset=utf-8'; ctx.body = h; return; }
  try { const buf = await pdf(h); ctx.type = 'application/pdf'; ctx.set('Content-Disposition', `attachment; filename="serpbays-affiliate-${partner.code}-${period}.pdf"`); ctx.body = buf; }
  catch (e) { strapi.log.error(`[affiliate-statement] pdf: ${e.message}`); ctx.type = 'text/html; charset=utf-8'; ctx.body = h; }
}

module.exports = { data, html, pdf, send, money, KIND_LABEL };
