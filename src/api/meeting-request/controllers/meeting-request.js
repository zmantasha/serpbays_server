'use strict';

/**
 * A signed-in user asking to meet the team.
 *
 * They are already authenticated, so there is nothing to fill in but the
 * message itself - name, email and whether they buy or sell are taken from the
 * account and attached for context. Goes straight to the inbox that books the
 * meetings, with Reply-To set to the user so a reply reaches them directly.
 */
const MEETING_INBOX = process.env.MEETING_REQUEST_TO || 'vin@serpbays.com';

const esc = (v) =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = {
  async submit(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('You must be signed in to send a meeting request.');

    const body = ctx.request.body?.data || ctx.request.body || {};
    const message = String(body.message || '').trim();
    const context = String(body.context || 'brightonSEO 2026').trim().slice(0, 80);

    if (message.length < 10) {
      return ctx.badRequest('Please write a line or two about what you would like to discuss.');
    }
    if (message.length > 2000) {
      return ctx.badRequest('Please keep the message under 2000 characters.');
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || 'A user';
    const side = user.Advertiser ? 'Advertiser' : user.Publisher ? 'Publisher' : 'User';

    const rows = [
      ['Name', name],
      ['Email', user.email],
      ['Account', `#${user.id} · ${side}`],
      ['Country', user.country || '—'],
      ['Phone', user.phoneNumber || '—'],
      ['About', context],
    ];

    const html =
      `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937;max-width:600px;">` +
      `<h2 style="margin:0 0 4px;font-size:18px;">Meeting request</h2>` +
      `<p style="margin:0 0 18px;color:#6b7280;font-size:13px;">Sent from the dashboard by a signed-in user.</p>` +
      `<table cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse;margin-bottom:18px;">` +
      rows.map(([k, v]) =>
        `<tr><td style="padding:4px 14px 4px 0;color:#6b7280;">${esc(k)}</td>` +
        `<td style="padding:4px 0;color:#111827;font-weight:600;">${esc(v)}</td></tr>`).join('') +
      `</table>` +
      `<div style="padding:14px 16px;background:#f9fafb;border-left:3px solid #FE6E00;border-radius:4px;` +
      `font-size:14px;line-height:1.6;white-space:pre-wrap;">${esc(message)}</div>` +
      `<p style="margin:18px 0 0;font-size:13px;color:#6b7280;">Reply to this email to answer ${esc(user.email)} directly.</p>` +
      `</div>`;

    const text =
      `Meeting request (from the dashboard)\n\n` +
      rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
      `\n\n${message}\n`;

    try {
      await strapi.service('api::global.autosend-service').send({
        to: MEETING_INBOX,
        subject: `Meeting request — ${name} (${side})`,
        html,
        text,
        replyTo: user.email,
        tags: ['meeting-request'],
      });
    } catch (err) {
      strapi.log.error(`[meeting-request] failed to email ${MEETING_INBOX}: ${err.message}`);
      return ctx.internalServerError("We couldn't send that just now. Please email vin@serpbays.com directly.");
    }

    strapi.log.info(`[meeting-request] user ${user.id} (${user.email}) asked to meet — ${context}`);
    return { data: { ok: true } };
  },
};
