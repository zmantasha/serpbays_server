'use strict';

const { createCoreController } = require('@strapi/strapi').factories;
const bcrypt = require('bcryptjs');
const { randomBytes } = require('crypto');

// Slug helpers — Yup validation runs before content-type lifecycles, so we
// must generate the slug here rather than in beforeCreate.
const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const generateSlug = (name) => {
  const base = slugify(name) || 'list';
  const suffix = randomBytes(6).toString('base64url').slice(0, 8);
  return `${base}-${suffix}`;
};

// Whitelist of body fields the admin endpoints accept. Anything else is
// silently dropped to keep update payloads tight and prevent accidentally
// writing system fields like viewCount or slug from the client.
const EDITABLE_FIELDS = [
  'name', 'description', 'accessMode', 'sharedWith', 'websites',
  'visibleColumns', 'customRules', 'pricingMode', 'markupValue',
  'markupType', 'priceOverrides', 'currency',
  'allowSearch', 'allowFilter', 'allowDownload',
  'expiresAt', 'snapshotEnabled',
];

function pickEditable(body = {}) {
  const out = {};
  for (const key of EDITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

const POPULATE_FULL = {
  websites: { fields: ['id', 'url', 'price', 'moz_da', 'ahrefs_dr', 'ahrefs_traffic', 'language'] },
  sharedWith: { fields: ['id', 'username', 'email'] },
};

module.exports = createCoreController('api::shared-list.shared-list', ({ strapi }) => ({

  async find(ctx) {
    const { page = 1, pageSize = 25, search = '', archived = 'false' } = ctx.query;
    const filters = {};
    filters.archived = archived === 'true';
    if (search) {
      filters.$or = [
        { name: { $containsi: String(search) } },
        { slug: { $containsi: String(search) } },
        { description: { $containsi: String(search) } },
      ];
    }

    const [data, total] = await Promise.all([
      strapi.entityService.findMany('api::shared-list.shared-list', {
        filters,
        sort: { createdAt: 'desc' },
        page: parseInt(page, 10),
        pageSize: parseInt(pageSize, 10),
        populate: {
          sharedWith: { fields: ['id', 'username', 'email'] },
          websites: { fields: ['id'] },
        },
      }),
      strapi.entityService.count('api::shared-list.shared-list', { filters }),
    ]);

    // Hide passwordHash; surface a hasPassword boolean instead.
    const sanitized = (data || []).map((row) => {
      const { passwordHash, ...rest } = row;
      return { ...rest, hasPassword: !!passwordHash, websiteCount: rest.websites?.length || 0 };
    });

    ctx.send({
      data: sanitized,
      meta: {
        pagination: {
          page: parseInt(page, 10),
          pageSize: parseInt(pageSize, 10),
          total,
          pageCount: Math.ceil(total / parseInt(pageSize, 10)),
        },
      },
    });
  },

  async findOne(ctx) {
    const { id } = ctx.params;
    const list = await strapi.entityService.findOne('api::shared-list.shared-list', id, {
      populate: POPULATE_FULL,
    });
    if (!list) return ctx.notFound('List not found');
    const { passwordHash, ...rest } = list;
    ctx.send({ data: { ...rest, hasPassword: !!passwordHash } });
  },

  async create(ctx) {
    const adminId = ctx.state.user?.id;
    const body = ctx.request.body?.data || ctx.request.body || {};

    if (!body.name || !String(body.name).trim()) {
      return ctx.badRequest('name is required');
    }

    const data = pickEditable(body);
    data.createdByAdminId = adminId;
    data.slug = generateSlug(data.name);

    // Optional plaintext password is hashed before storage.
    if (body.password && String(body.password).trim()) {
      data.passwordHash = await bcrypt.hash(String(body.password).trim(), 10);
    }

    const created = await strapi.entityService.create('api::shared-list.shared-list', {
      data,
      populate: POPULATE_FULL,
    });

    console.log(`[ADMIN ACTION] Admin ${adminId} created shared-list ${created.id} (${created.slug})`);
    const { passwordHash, ...rest } = created;
    ctx.send({ data: { ...rest, hasPassword: !!passwordHash } });
  },

  async update(ctx) {
    const adminId = ctx.state.user?.id;
    const { id } = ctx.params;
    const body = ctx.request.body?.data || ctx.request.body || {};

    const existing = await strapi.entityService.findOne('api::shared-list.shared-list', id);
    if (!existing) return ctx.notFound('List not found');

    const data = pickEditable(body);

    // Password handling:
    //   { password: 'foo' } -> hash and set
    //   { password: '' }    -> clear (explicit removal)
    //   no `password` key   -> unchanged
    if (body.password !== undefined) {
      const trimmed = String(body.password || '').trim();
      data.passwordHash = trimmed ? await bcrypt.hash(trimmed, 10) : null;
    }

    const updated = await strapi.entityService.update('api::shared-list.shared-list', id, {
      data,
      populate: POPULATE_FULL,
    });

    console.log(`[ADMIN ACTION] Admin ${adminId} updated shared-list ${id}`);
    const { passwordHash, ...rest } = updated;
    ctx.send({ data: { ...rest, hasPassword: !!passwordHash } });
  },

  async archive(ctx) {
    const adminId = ctx.state.user?.id;
    const { id } = ctx.params;
    const updated = await strapi.entityService.update('api::shared-list.shared-list', id, {
      data: { archived: true },
    });
    console.log(`[ADMIN ACTION] Admin ${adminId} archived shared-list ${id}`);
    ctx.send({ data: updated });
  },

  async duplicate(ctx) {
    const adminId = ctx.state.user?.id;
    const { id } = ctx.params;
    const original = await strapi.entityService.findOne('api::shared-list.shared-list', id, {
      populate: { websites: { fields: ['id'] }, sharedWith: { fields: ['id'] } },
    });
    if (!original) return ctx.notFound('List not found');

    const copyName = `${original.name} (copy)`;
    const copy = await strapi.entityService.create('api::shared-list.shared-list', {
      data: {
        name: copyName,
        slug: generateSlug(copyName),
        description: original.description,
        accessMode: original.accessMode,
        sharedWith: (original.sharedWith || []).map((u) => u.id),
        websites: (original.websites || []).map((w) => w.id),
        visibleColumns: original.visibleColumns,
        customRules: original.customRules,
        pricingMode: original.pricingMode,
        markupValue: original.markupValue,
        markupType: original.markupType,
        priceOverrides: original.priceOverrides,
        currency: original.currency,
        allowSearch: original.allowSearch,
        allowFilter: original.allowFilter,
        allowDownload: original.allowDownload,
        expiresAt: original.expiresAt,
        // Password and slug are not carried over.
        createdByAdminId: adminId,
      },
      populate: POPULATE_FULL,
    });

    console.log(`[ADMIN ACTION] Admin ${adminId} duplicated shared-list ${id} -> ${copy.id}`);
    const { passwordHash, ...rest } = copy;
    ctx.send({ data: { ...rest, hasPassword: !!passwordHash } });
  },

  /**
   * Bulk-add websites to a list.
   * Body: { ids?: number[], domains?: string[] }
   * Resolves domains to marketplace IDs and merges with the existing set.
   * Returns the new website set + a `notFound` array of domains that didn't match.
   */
  async bulkAddWebsites(ctx) {
    const adminId = ctx.state.user?.id;
    const { id } = ctx.params;
    const body = ctx.request.body?.data || ctx.request.body || {};
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
    const rawDomains = Array.isArray(body.domains) ? body.domains : [];
    const domains = rawDomains
      .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter(Boolean);

    const existing = await strapi.entityService.findOne('api::shared-list.shared-list', id, {
      populate: { websites: { fields: ['id'] } },
    });
    if (!existing) return ctx.notFound('List not found');

    let resolvedIds = [...ids];
    let notFound = [];
    if (domains.length) {
      const matches = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: { url: { $in: domains } },
        select: ['id', 'url'],
      });
      const matchedDomains = new Set(matches.map((m) => m.url.toLowerCase()));
      notFound = domains.filter((d) => !matchedDomains.has(d));
      resolvedIds = resolvedIds.concat(matches.map((m) => m.id));
    }

    const currentIds = new Set((existing.websites || []).map((w) => w.id));
    resolvedIds.forEach((wid) => currentIds.add(wid));
    const finalIds = Array.from(currentIds);

    const updated = await strapi.entityService.update('api::shared-list.shared-list', id, {
      data: { websites: finalIds },
      populate: POPULATE_FULL,
    });

    console.log(`[ADMIN ACTION] Admin ${adminId} added ${finalIds.length - currentIds.size + resolvedIds.length} websites to shared-list ${id}`);
    const { passwordHash, ...rest } = updated;
    ctx.send({ data: { ...rest, hasPassword: !!passwordHash }, notFound });
  },

  /**
   * Email a shareable link to one or more recipients.
   * Body: { recipients: string[]; note?: string; clientUrl?: string }
   */
  async shareEmail(ctx) {
    const adminId = ctx.state.user?.id;
    const { id } = ctx.params;
    const body = ctx.request.body?.data || ctx.request.body || {};
    const recipients = Array.isArray(body.recipients)
      ? body.recipients.map((r) => String(r || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const note = String(body.note || '').trim();
    const clientUrl = String(body.clientUrl || '').replace(/\/$/, '');

    if (recipients.length === 0) {
      return ctx.badRequest('At least one recipient email is required');
    }
    // Lightweight email validation — full RFC validation is overkill here.
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalid = recipients.filter((e) => !emailRe.test(e));
    if (invalid.length) {
      return ctx.badRequest(`Invalid email${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}`);
    }
    if (!clientUrl) {
      return ctx.badRequest('clientUrl is required (origin where /lists/<slug> is hosted)');
    }

    const list = await strapi.entityService.findOne('api::shared-list.shared-list', id);
    if (!list) return ctx.notFound('List not found');

    const shareUrl = `${clientUrl}/lists/${list.slug}`;
    const subject = `${list.name} — curated website list`;
    const safeNote = note
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
    const html = `
      <p>Hi,</p>
      <p>Here is the curated website list <strong>${list.name}</strong> we put together for you.</p>
      ${safeNote ? `<blockquote style="border-left:3px solid #ddd;padding:6px 12px;margin:12px 0;color:#444">${safeNote}</blockquote>` : ''}
      <p>
        <a href="${shareUrl}" style="display:inline-block;padding:10px 18px;background:#FFB088;color:#1a1a1a;text-decoration:none;border-radius:6px;font-weight:600">Open the list</a>
      </p>
      <p style="color:#888;font-size:12px;word-break:break-all">${shareUrl}</p>
      <p style="color:#888;font-size:12px">— SerpBays</p>
    `;
    const text = [
      `Hi,`,
      `Here is the curated website list "${list.name}" we put together for you.`,
      note ? `\n${note}\n` : '',
      `Open the list: ${shareUrl}`,
      `— SerpBays`,
    ].filter(Boolean).join('\n\n');

    const autosend = strapi.service('api::global.autosend-service');
    const results = [];
    for (const to of recipients) {
      try {
        const r = await autosend.send({ to, subject, html, text });
        results.push({ to, ok: true, info: r });
      } catch (err) {
        console.error(`[ADMIN ACTION] email-share failed for ${to}:`, err?.message || err);
        results.push({ to, ok: false, error: err?.message || 'send failed' });
      }
    }

    console.log(`[ADMIN ACTION] Admin ${adminId} emailed shared-list ${id} to ${recipients.join(', ')}`);
    ctx.send({ data: { sent: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), shareUrl } });
  },

  /**
   * Take (or refresh) the snapshot. Re-runs the public projection logic
   * over the current websites + pricing config and stores it on the list.
   */
  async refreshSnapshot(ctx) {
    const adminId = ctx.state.user?.id;
    const { id } = ctx.params;

    const list = await strapi.entityService.findOne('api::shared-list.shared-list', id, {
      populate: { websites: true },
    });
    if (!list) return ctx.notFound('List not found');

    // Re-use the same projection logic as the public controller so the
    // snapshot row shape is identical to a live read.
    const { projectWebsite } = require('../../shared-list/utils/projection');
    const snapshot = (list.websites || []).map((mp) => projectWebsite(list, mp));

    const updated = await strapi.entityService.update('api::shared-list.shared-list', id, {
      data: {
        snapshotEnabled: true,
        snapshotData: snapshot,
        snapshotTakenAt: new Date(),
      },
      populate: POPULATE_FULL,
    });

    console.log(`[ADMIN ACTION] Admin ${adminId} refreshed snapshot for shared-list ${id} (${snapshot.length} rows)`);
    const { passwordHash, snapshotData, ...rest } = updated;
    ctx.send({ data: { ...rest, hasPassword: !!passwordHash, snapshotRowCount: snapshot.length } });
  },

  async removeWebsite(ctx) {
    const adminId = ctx.state.user?.id;
    const { id, websiteId } = ctx.params;
    const existing = await strapi.entityService.findOne('api::shared-list.shared-list', id, {
      populate: { websites: { fields: ['id'] } },
    });
    if (!existing) return ctx.notFound('List not found');

    const remaining = (existing.websites || [])
      .map((w) => w.id)
      .filter((wid) => wid !== Number(websiteId));

    const updated = await strapi.entityService.update('api::shared-list.shared-list', id, {
      data: { websites: remaining },
      populate: POPULATE_FULL,
    });

    console.log(`[ADMIN ACTION] Admin ${adminId} removed website ${websiteId} from shared-list ${id}`);
    const { passwordHash, ...rest } = updated;
    ctx.send({ data: { ...rest, hasPassword: !!passwordHash } });
  },

}));
