'use strict';

/**
 * Admin email service
 *
 * Sends free-form transactional emails initiated by admins from the admin panel,
 * and persists an audit log row for every send.
 *
 * The `from` address is server-controlled (env: ADMIN_EMAIL_FROM, fallback EMAIL_FROM).
 * Never trust a client-supplied `from` value.
 */

const { createCoreService } = require('@strapi/strapi').factories;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidEmail = (value) =>
  typeof value === 'string' && EMAIL_REGEX.test(value.trim());

const normalizeRecipients = (input) => {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry === 'string') return { email: entry.trim() };
      if (typeof entry === 'object' && entry.email) {
        // Coerce `data` into a flat string-only map. Anything non-string
        // is dropped — we never want a recipient field smuggling objects
        // through into the template renderer.
        const data = {};
        if (entry.data && typeof entry.data === 'object' && !Array.isArray(entry.data)) {
          for (const [k, v] of Object.entries(entry.data)) {
            if (typeof k === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) {
              data[k] = v == null ? '' : String(v);
            }
          }
        }
        return {
          email: String(entry.email).trim(),
          name: entry.name ? String(entry.name).trim() : undefined,
          data,
        };
      }
      return null;
    })
    .filter((r) => r && isValidEmail(r.email));
};

const formatAddress = ({ email, name }) =>
  name ? `"${name.replace(/"/g, '\\"')}" <${email}>` : email;

// Light HTML sanitization. Email clients sanitize aggressively too, but we
// strip the obviously dangerous bits before persisting/sending so the audit
// log stays clean and we don't emit broken markup.
const sanitizeHtml = (html) => {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?<\/embed>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript\s*:/gi, '');
};

const htmlToText = (html) =>
  String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>(\s*)/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const stripHeaderInjection = (value) =>
  String(value || '').replace(/[\r\n]+/g, ' ').trim();

// Per-recipient merge: replaces `{{key}}` (with optional whitespace
// inside the braces) using the recipient's data map. Unknown / missing
// keys collapse to an empty string — never leak the placeholder syntax
// to recipients. `escape` controls whether values get HTML-escaped (use
// true for the body, false for the subject which is plain text).
const TEMPLATE_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderTemplate = (template, data, { escape }) => {
  if (typeof template !== 'string' || template.indexOf('{{') === -1) {
    return template;
  }
  return template.replace(TEMPLATE_RE, (_match, key) => {
    const raw = data && Object.prototype.hasOwnProperty.call(data, key)
      ? data[key]
      : '';
    const value = raw == null ? '' : String(raw);
    return escape ? escapeHtml(value) : value;
  });
};

module.exports = createCoreService('api::admin-email.admin-email', ({ strapi }) => ({

  resolveFrom() {
    const from =
      process.env.ADMIN_EMAIL_FROM ||
      process.env.EMAIL_FROM ||
      'noreply@serpbays.com';
    return from;
  },

  async sendAdminEmail({
    to,
    cc,
    bcc,
    subject,
    bodyHtml,
    senderAdminId,
    contextType = 'none',
    contextIds = [],
  }) {
    const toList = normalizeRecipients(to);
    const ccList = normalizeRecipients(cc);
    const bccList = normalizeRecipients(bcc);

    if (toList.length === 0) {
      throw new Error('At least one valid "to" recipient is required');
    }

    const cleanSubject = stripHeaderInjection(subject);
    if (!cleanSubject) {
      throw new Error('Subject is required');
    }
    if (cleanSubject.length > 255) {
      throw new Error('Subject must be 255 characters or fewer');
    }

    const cleanHtml = sanitizeHtml(bodyHtml);
    if (!htmlToText(cleanHtml)) {
      throw new Error('Email body cannot be empty');
    }

    const from = this.resolveFrom();
    const allowedContextTypes = ['user', 'website', 'order', 'none'];
    const safeContextType = allowedContextTypes.includes(contextType) ? contextType : 'none';
    const safeContextIds = Array.isArray(contextIds)
      ? contextIds.map((v) => Number(v)).filter((n) => Number.isFinite(n))
      : [];

    // Persist a queued log row first so we always have audit trail, even if
    // SMTP throws.
    const logRow = await strapi.entityService.create('api::admin-email.admin-email', {
      data: {
        fromAddress: from,
        toAddresses: toList,
        ccAddresses: ccList,
        bccAddresses: bccList,
        subject: cleanSubject,
        bodyHtml: cleanHtml,
        bodyText: htmlToText(cleanHtml),
        senderAdmin: senderAdminId || undefined,
        contextType: safeContextType,
        contextIds: safeContextIds,
        status: 'queued',
      },
    });

    // AutoSend's adapter accepts a single recipient per call and has no
    // native cc/bcc support, so we fan out: each recipient (to/cc/bcc)
    // gets its own send. This keeps deliverability tracking clean.
    const allRecipients = [
      ...toList.map((r) => ({ ...r, _kind: 'to' })),
      ...ccList.map((r) => ({ ...r, _kind: 'cc' })),
      ...bccList.map((r) => ({ ...r, _kind: 'bcc' })),
    ];

    const messageIds = [];
    const errors = [];

    for (const recipient of allRecipients) {
      // Per-recipient render. Subject is plain text → no escape; body is
      // HTML → escape merge values to neutralise `<script>` / `<` etc.
      // smuggled in via display names. Header injection is also stripped
      // from the rendered subject as a second line of defense.
      const recipientData = recipient.data || {};
      const renderedSubject = stripHeaderInjection(
        renderTemplate(cleanSubject, recipientData, { escape: false })
      );
      const renderedHtml = renderTemplate(cleanHtml, recipientData, { escape: true });
      const renderedText = htmlToText(renderedHtml);

      try {
        const result = await strapi
          .service('api::global.autosend-service')
          .send({
            to: recipient.email,
            subject: renderedSubject,
            html: renderedHtml,
            text: renderedText,
            tags: ['admin-email', `context:${safeContextType}`],
          });
        if (result && result.messageId) {
          messageIds.push(result.messageId);
        }
      } catch (error) {
        const msg =
          (error && (error.message || error.toString())) ||
          'Unknown send failure';
        errors.push({ email: recipient.email, kind: recipient._kind, error: msg });
        strapi.log.error('[admin-email] AutoSend failure', {
          logId: logRow.id,
          recipient: recipient.email,
          error: msg,
        });
      }
    }

    const allFailed = messageIds.length === 0 && errors.length > 0;

    if (allFailed) {
      const errMessage = errors.map((e) => `${e.email}: ${e.error}`).join('; ');
      await strapi.entityService.update(
        'api::admin-email.admin-email',
        logRow.id,
        {
          data: {
            status: 'failed',
            errorMessage: errMessage.slice(0, 4000),
          },
        }
      );
      const wrapped = new Error(errMessage);
      wrapped.code = 'ADMIN_EMAIL_SEND_FAILED';
      wrapped.logId = logRow.id;
      throw wrapped;
    }

    const updated = await strapi.entityService.update(
      'api::admin-email.admin-email',
      logRow.id,
      {
        data: {
          status: 'sent',
          providerMessageId: messageIds.join(',') || null,
          // If some recipients failed, record what failed but still flag sent.
          errorMessage: errors.length
            ? errors.map((e) => `${e.email}: ${e.error}`).join('; ').slice(0, 4000)
            : null,
        },
      }
    );

    return updated;
  },
}));
