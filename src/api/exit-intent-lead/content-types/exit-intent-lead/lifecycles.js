'use strict';

/**
 * exit-intent-lead lifecycle hooks
 *
 * Two responsibilities:
 *   1. beforeCreate — dedup: if the same email (or same Clerk user ID)
 *      submitted within the last 24 hours, tag the new row as `spam`
 *      so sales doesn't re-contact the same person twice. The row is
 *      still persisted; we just push it out of the active queue.
 *
 *   2. afterCreate — email notification: send a formatted summary of
 *      every new lead (skip duplicates flagged in step 1) to the sales
 *      inbox(es). Fire-and-forget so SMTP latency doesn't slow the
 *      create response.
 *
 * Schema has no components / relations, so the v5 lifecycle-hook caveat
 * (hooks misbehave when combined with components+relations on the same
 * write) doesn't apply here.
 */

const nodemailer = require('nodemailer');

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Notification recipients. Edit this list to change who gets pinged.
// All recipients are CC-aware: TO is the primary; CC list is everyone
// else who should see it. Reply-to is set to the lead's own email so
// hitting "Reply" goes straight to the prospect.
const NOTIFY_TO = 'vinayak@wordscloud.in';
const NOTIFY_CC = ['arusha@wordscloud.in', 'vin+exitintent@serpbays.com'];

const STRAPI_ADMIN_BASE =
    process.env.STRAPI_ADMIN_URL || 'https://prod-cms.serpbays.com';

// ─── Mailer (lazy singleton) ────────────────────────────────────────────────

let _transporter = null;
function getTransporter() {
    if (_transporter) return _transporter;
    const { SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD } = process.env;
    if (!SMTP_HOST || !SMTP_USERNAME || !SMTP_PASSWORD) return null;
    const port = parseInt(SMTP_PORT || '587', 10);
    _transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port,
        secure: port === 465, // true for 465, STARTTLS for 587
        auth: { user: SMTP_USERNAME, pass: SMTP_PASSWORD },
    });
    return _transporter;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(input) {
    return String(input == null ? '' : input)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/\n/g, '<br>');
}

function buildEmail(lead) {
    const isBuyer = lead.role === 'buyer';
    const subject = `[Exit Intent] ${isBuyer ? 'New buyer lead' : 'New publisher lead'}: ${lead.name}`;
    const adminUrl =
        `${STRAPI_ADMIN_BASE}/admin/content-manager/collection-types/` +
        `api::exit-intent-lead.exit-intent-lead/${lead.id}`;

    const phone = `${lead.countryCode || ''} ${lead.whatsapp || ''}`.trim();
    const wabUrl =
        lead.whatsapp && lead.countryCode
            ? `https://wa.me/${(lead.countryCode + lead.whatsapp).replace(/\D/g, '')}`
            : null;

    const accountBlock = lead.clerkUserId
        ? `
        <tr><td colspan="2" style="padding-top:14px;border-top:1px solid #e5e7eb;font-weight:bold;color:#374151;">
          🟢 Existing Serpbays account
        </td></tr>
        <tr><td style="padding:4px 8px;color:#6b7280;">Account name</td><td style="padding:4px 8px;">${escapeHtml(lead.userName || '-')}</td></tr>
        <tr><td style="padding:4px 8px;color:#6b7280;">Account email</td><td style="padding:4px 8px;">${escapeHtml(lead.userEmail || '-')}</td></tr>
        <tr><td style="padding:4px 8px;color:#6b7280;">Clerk user ID</td><td style="padding:4px 8px;"><code>${escapeHtml(lead.clerkUserId)}</code></td></tr>
        `
        : `
        <tr><td colspan="2" style="padding-top:14px;border-top:1px solid #e5e7eb;color:#9ca3af;font-style:italic;">
          Anonymous browser (not signed in)
        </td></tr>
        `;

    const intentBlock = isBuyer
        ? `<tr><td style="padding:4px 8px;color:#6b7280;vertical-align:top;">Requirements</td><td style="padding:4px 8px;white-space:pre-wrap;">${escapeHtml(lead.requirements || '-')}</td></tr>`
        : `
        <tr><td style="padding:4px 8px;color:#6b7280;">Website</td><td style="padding:4px 8px;">${escapeHtml(lead.websiteUrl || '-')}</td></tr>
        <tr><td style="padding:4px 8px;color:#6b7280;vertical-align:top;">Details</td><td style="padding:4px 8px;white-space:pre-wrap;">${escapeHtml(lead.details || '-')}</td></tr>
        `;

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#111827;">
  <p style="font-size:16px;margin:0 0 18px;">
    <strong>${escapeHtml(lead.name)}</strong> just submitted the exit-intent popup as a
    <strong>${isBuyer ? 'buyer' : 'publisher'}</strong>.
  </p>

  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;line-height:1.5;width:100%;">
    <tr><td style="padding:4px 8px;color:#6b7280;width:160px;">Email</td><td style="padding:4px 8px;"><a href="mailto:${escapeHtml(lead.email)}" style="color:#ea580c;">${escapeHtml(lead.email)}</a></td></tr>
    <tr><td style="padding:4px 8px;color:#6b7280;">WhatsApp</td><td style="padding:4px 8px;">${escapeHtml(phone)}${wabUrl ? ` &middot; <a href="${wabUrl}" style="color:#ea580c;">Open in WhatsApp →</a>` : ''}</td></tr>
    ${intentBlock}
    ${accountBlock}
    <tr><td colspan="2" style="padding-top:14px;border-top:1px solid #e5e7eb;font-weight:bold;color:#374151;">Context</td></tr>
    <tr><td style="padding:4px 8px;color:#6b7280;">Page</td><td style="padding:4px 8px;"><code>${escapeHtml(lead.path || '-')}</code></td></tr>
    <tr><td style="padding:4px 8px;color:#6b7280;">Time on site</td><td style="padding:4px 8px;">${lead.timeOnSiteSec || 0}s</td></tr>
    <tr><td style="padding:4px 8px;color:#6b7280;">Referrer</td><td style="padding:4px 8px;">${escapeHtml(lead.referrer || '(none)')}</td></tr>
  </table>

  <p style="margin:24px 0 0;">
    <a href="${adminUrl}" style="display:inline-block;background:linear-gradient(90deg,#f97316,#dc2626);color:white;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;">
      Open in Strapi admin →
    </a>
  </p>

  <p style="font-size:12px;color:#9ca3af;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:12px;">
    Lead #${lead.id} · ${new Date().toISOString()}
  </p>
</div>`.trim();

    const text = [
        `${isBuyer ? 'New buyer lead' : 'New publisher lead'}: ${lead.name}`,
        ``,
        `Email:    ${lead.email}`,
        `WhatsApp: ${phone}`,
        isBuyer ? `Wants:    ${lead.requirements || ''}` : `Site:     ${lead.websiteUrl || ''}\nDetails:  ${lead.details || ''}`,
        ``,
        lead.clerkUserId
            ? `Account:  ${lead.userName || ''} <${lead.userEmail || ''}> (clerk:${lead.clerkUserId})`
            : `Account:  (anonymous)`,
        ``,
        `Page:     ${lead.path || ''}`,
        `Time:     ${lead.timeOnSiteSec || 0}s on site`,
        ``,
        `Open in admin: ${adminUrl}`,
    ].join('\n');

    return {
        from: process.env.EMAIL_FROM || process.env.SMTP_USERNAME,
        to: NOTIFY_TO,
        cc: NOTIFY_CC,
        replyTo: lead.email,
        subject,
        html,
        text,
    };
}

function sendNotificationEmail(lead) {
    try {
        const transporter = getTransporter();
        if (!transporter) {
            strapi.log.warn(
                '[exit-intent-lead] SMTP not configured (need SMTP_HOST/USERNAME/PASSWORD); skipping email'
            );
            return;
        }
        transporter
            .sendMail(buildEmail(lead))
            .then((info) => {
                strapi.log.info(
                    `[exit-intent-lead] notification email sent for lead #${lead.id} (msg ${info.messageId})`
                );
            })
            .catch((err) => {
                strapi.log.warn(
                    `[exit-intent-lead] notification email failed for lead #${lead.id}: ${err.message}`
                );
            });
    } catch (err) {
        strapi.log.warn(`[exit-intent-lead] notification email setup failed: ${err.message}`);
    }
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

module.exports = {
    async beforeCreate(event) {
        const { data } = event.params;
        if (!data) return;

        // Don't override an explicitly-set status (e.g. an admin
        // creating a row by hand and tagging it).
        if (data.status && data.status !== 'new') return;

        const sinceIso = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();

        const filters = [];
        if (data.email) filters.push({ email: data.email });
        if (data.clerkUserId) filters.push({ clerkUserId: data.clerkUserId });
        if (filters.length === 0) return;

        try {
            const existing = await strapi.db
                .query('api::exit-intent-lead.exit-intent-lead')
                .findOne({
                    where: {
                        $or: filters,
                        createdAt: { $gt: sinceIso },
                    },
                    select: ['id'],
                });

            if (existing) {
                data.status = 'spam';
                data.internalNotes =
                    `Auto-flagged: duplicate submission within 24h of lead #${existing.id}.` +
                    (data.internalNotes ? `\n\n${data.internalNotes}` : '');
                strapi.log.info(
                    `[exit-intent-lead] dedup: tagged new submission as spam (matches lead #${existing.id})`
                );
            }
        } catch (err) {
            strapi.log.warn(`[exit-intent-lead] dedup check failed: ${err.message}`);
        }
    },

    async afterCreate(event) {
        const { result } = event;
        if (!result) return;

        // Don't email for duplicates the dedup hook already flagged —
        // sales already saw the original lead within the last 24h.
        if (result.status === 'spam') return;

        // Fire-and-forget. setImmediate yields control so the create
        // response goes out without waiting on SMTP roundtrip.
        setImmediate(() => sendNotificationEmail(result));
    },
};
