'use strict';

/**
 * marketplace controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { normalizeUrl } = require('../../../utils/normalize-url');

// ============================================================================
// PII / IDOR allow-list for marketplace responses (hotfix-v2, 2026-06-26)
// ============================================================================
// `sanitizePublisherData` previously used a deny-list — any new column added
// to the marketplace schema would leak by default until someone remembered to
// add it to the deny list. Worse, the deny-list matched `publisher_*` but
// NOT the populated `publisher` relation, so the full up_users row (email,
// clerkId, password=null, resetPasswordToken=null, confirmationToken=null,
// blocked, confirmed) was returned for every entry in /api/marketplaces to
// every authenticated user — straightforward IDOR.
//
// New approach: explicit allow-list. Anything not in MARKETPLACE_PUBLIC_FIELDS
// is dropped before sending. Owner gets a superset that adds intake pricing
// + their own contact info. Both lists are derived from the schema and the
// client UI's actual consumption (grep-verified 2026-06-26).
const MARKETPLACE_PUBLIC_FIELDS = [
  // Identity
  'id', 'documentId', 'url',
  // Advertiser-facing pricing — never publisher intake prices
  'price', 'link_insertion_price',
  'adv_casino_pricing', 'adv_cbd_pricing', 'adv_crypto_pricing', 'adv_dating_pricing',
  'adv_li_casino_pricing', 'adv_li_cbd_pricing', 'adv_li_crypto_pricing', 'adv_li_dating_pricing',
  // Site spec / content requirements
  'tat', 'placement_speed', 'min_word_count',
  'backlink_type', 'backlink_validity', 'dofollow_link',
  'category', 'other_category', 'language', 'countries',
  'guidelines', 'sample_post', 'sample_links',
  'description', 'publication_location', 'domain_zone',
  // Public SEO metrics
  'ahrefs_dr', 'ahrefs_traffic', 'ahrefs_rank', 'ahrefs_referring_domain', 'ahrefs_keywords',
  'moz_da', 'semrush_authority_score', 'semrush_traffic', 'spam_score', 'similarweb_traffic',
  // Trust + feature flags
  'gsc_verified',
  'sponsored', 'ugc', 'digital_pr', 'only_with_us', 'fast_placement_status',
  'isFeatured', 'isFeaturedGuestPost', 'isFeaturedLinkInsertion',
  'website_status', 'status',
  // Timestamps (marketplace draftAndPublish: false → no publishedAt)
  'createdAt', 'updatedAt',
];

// Fields ONLY the owning publisher sees on their own listings.
// Includes publisher PII (their own email/name), intake pricing (their cost
// before our markup), and internal metric-refresh timestamps the publisher
// dashboard surfaces. Non-owners NEVER see any of these.
const MARKETPLACE_OWNER_EXTRA_FIELDS = [
  // Publisher identity (their own — they're looking at their own listing)
  'publisher_email', 'publisher_name',
  // Intake pricing — what the publisher gets, before our markup. Business secret.
  'publisher_price',
  'publisher_link_insertion_price', 'publisher_writing_price',
  'publisher_casino_pricing', 'publisher_cbd_pricing',
  'publisher_crypto_pricing', 'publisher_dating_pricing',
  'publisher_li_casino_pricing', 'publisher_li_cbd_pricing',
  'publisher_li_crypto_pricing', 'publisher_li_dating_pricing',
  'publisher_forbidden_gp_price', 'publisher_forbidden_li_price',
  // GSC posture — useful for the owner, not for anyone else.
  'gsc_permission_level',
  // Internal operational state — owner's dashboard reads these for badges.
  // Non-owners get NO view of moderation pipeline or third-party refresh cadence.
  'approvalStatus', 'blacklist_status',
  'delistedReason', 'delistedAt',
  'dataVersion', 'bulkRefreshSkipTools',
  'lastAhrefsRefreshAt', 'lastAhrefsExportAt',
  'lastMozRefreshAt', 'lastMozExportAt',
  'lastSemrushRefreshAt', 'lastSemrushExportAt',
  'lastPriceUpdateAt', 'lastMetricUpdateAt',
];

// Fields that NEVER leave the server, even for owners or admins via this
// sanitizer. gsc_refresh_token is a Google OAuth refresh token — its
// exposure would let any holder impersonate the publisher against the
// Search Console API indefinitely.
const MARKETPLACE_NEVER_EXPOSE = ['gsc_refresh_token'];

// ============================================================================
// Anti-scraping caps for /api/marketplaces (hotfix-v2, 2026-06-30)
// ============================================================================
// The paywall gate above (MARKETPLACE_UNLOCK_MIN_USD, default $10) restricts
// users below the deposit threshold to 10 curated preview rows. ANY user
// past that threshold previously could:
//   - request `?pagination[pageSize]=10000` → full-catalog dump in one call
//   - paginate `?page=N` indefinitely → enumerate the whole inventory
// $10 is a trivial barrier for a competitor wanting to scrape the
// marketplace. These hard caps bound per-request and per-session
// extraction even for unlocked accounts:
//   - pageSize ≤ MARKETPLACE_MAX_PAGE_SIZE (default 50): forces N/50 calls
//     to extract N entries — combined with the 30/min route rate limit,
//     ~1000 calls / 33 min minimum for a 50K catalog
//   - page ≤ MARKETPLACE_MAX_PAGE (default 100): only the first
//     pageSize × max-page = 5000 entries reachable via direct pagination;
//     deeper rows require filtered queries (also rate-limited)
//
// Legit UI users typically paginate <10 pages — the caps are well above
// real browsing usage. Both values are env-tunable so ops can adjust
// without a code deploy.
const MARKETPLACE_MAX_PAGE_SIZE = (() => {
  const v = parseInt(process.env.MARKETPLACE_MAX_PAGE_SIZE, 10);
  return Number.isFinite(v) && v >= 1 && v <= 200 ? v : 50;
})();
const MARKETPLACE_MAX_PAGE = (() => {
  const v = parseInt(process.env.MARKETPLACE_MAX_PAGE, 10);
  return Number.isFinite(v) && v >= 1 && v <= 1000 ? v : 100;
})();

// Single source of truth for paginating /api/marketplaces. Clamps the
// caller's pagination.page + pagination.pageSize into the safe range,
// defaulting to {1, 25} on missing/invalid input. Used in BOTH the
// Knex-metric-sort path and the standard db.query path so a request
// that takes either branch lands in the same bounds.
function clampMarketplacePagination(ctx) {
  const rawPage = parseInt(ctx.query.pagination?.page, 10);
  const rawPageSize = parseInt(ctx.query.pagination?.pageSize, 10);
  const page = Math.min(
    Math.max(Number.isFinite(rawPage) ? rawPage : 1, 1),
    MARKETPLACE_MAX_PAGE
  );
  const pageSize = Math.min(
    Math.max(Number.isFinite(rawPageSize) ? rawPageSize : 25, 1),
    MARKETPLACE_MAX_PAGE_SIZE
  );
  return { page, pageSize };
}

// Price-like columns. When sorting by any of these, both NULL and 0 are
// treated as "no price" so they fall to the bottom of an ascending sort.
const PRICE_LIKE_FIELDS = new Set([
  'price',
  'link_insertion_price',
  'adv_casino_pricing',
  'adv_crypto_pricing',
  'adv_cbd_pricing',
  'adv_dating_pricing',
  'adv_li_casino_pricing',
  'adv_li_crypto_pricing',
  'adv_li_cbd_pricing',
  'adv_li_dating_pricing',
]);

// "Settled" deposit transaction statuses — these are the rows where money
// actually landed in the user's wallet. Mirrors transactions getStats.
const SETTLED_DEPOSIT_STATUSES = ['success', 'paid'];

function getMarketplaceUnlockMin() {
  const v = parseFloat(process.env.MARKETPLACE_UNLOCK_MIN_USD || '10');
  return Number.isFinite(v) && v > 0 ? v : 10;
}

async function getLifetimeDeposits(strapi, userId) {
  if (!userId) return 0;
  const rows = await strapi.db.query('api::transaction.transaction').findMany({
    where: {
      users_permissions_user: userId,
      type: 'deposit',
      transactionStatus: { $in: SETTLED_DEPOSIT_STATUSES },
    },
    select: ['amount'],
  });
  return rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
}

// Required fields that must be present in CSV
const REQUIRED_FIELDS = [
  'url',
  'price',
  'publisher_name',
  'publisher_email',
  'publisher_price',
  'category',
  'backlink_validity',
  'backlink_type',
  'min_word_count'
];

// Strict type validation
const validateType = (value, type, fieldName, schema) => {
  if (value === null || value === undefined || value === '') {
    return { isValid: false, error: 'Value is empty' };
  }

  switch (type) {
    case 'integer': {
      // Remove any commas and spaces
      const cleanValue = String(value).replace(/,/g, '').trim();
      const num = Number(cleanValue);
      if (!Number.isInteger(num) || isNaN(num)) {
        return { isValid: false, error: `Value '${value}' is not a valid integer` };
      }

      // Apply schema-based min/max validation
      const fieldSchema = schema[fieldName];
      if (fieldSchema) {
        // Check minimum value
        if (fieldSchema.min !== undefined && num < fieldSchema.min) {
          return { isValid: false, error: `Value ${num} is below minimum allowed value of ${fieldSchema.min}` };
        }

        // Check maximum value
        if (fieldSchema.max !== undefined && num > fieldSchema.max) {
          return { isValid: false, error: `Value ${num} exceeds maximum allowed value of ${fieldSchema.max}` };
        }
      }

      // Apply specific field validations based on our requirements
      switch (fieldName) {
        case 'moz_da':
        case 'ahrefs_dr':
          if (num < 0 || num > 100) {
            return { isValid: false, error: `${fieldName} must be between 0 and 100, got ${num}` };
          }
          break;
        case 'spam_score':
        case 'semrush_authority_score':
          if (num < 0 || num > 100) {
            return { isValid: false, error: `${fieldName} must be between 0 and 100, got ${num}` };
          }
          break;
        case 'price':
        case 'publisher_price':
        case 'adv_crypto_pricing':
        case 'adv_casino_pricing':
        case 'adv_cbd_pricing':
        case 'publisher_crypto_pricing':
        case 'publisher_casino_pricing':
        case 'publisher_cbd_pricing':
        case 'link_insertion_price':
        case 'forbidden_gp_price':
        case 'forbidden_li_price':
        case 'publisher_forbidden_gp_price':
        case 'publisher_forbidden_li_price':
        case 'publisher_link_insertion_price':
          if (num < 0) {
            return { isValid: false, error: `${fieldName} cannot be negative, got ${num}` };
          }
          break;
        case 'ahrefs_traffic':
        case 'semrush_traffic':
        case 'similarweb_traffic':
        case 'ahrefs_rank':
        case 'ahrefs_referring_domain':
        case 'min_word_count':
        case 'dofollow_link':
          if (num < 0) {
            return { isValid: false, error: `${fieldName} cannot be negative, got ${num}` };
          }
          break;
      }

      return { isValid: true, value: num };
    }
    case 'string':
    case 'text':
      return { isValid: true, value: String(value).trim() };
    case 'boolean': {
      const strValue = String(value).toLowerCase().trim();
      if (!['true', 'false', '1', '0', 'yes', 'no'].includes(strValue)) {
        return { isValid: false, error: `Value '${value}' is not a valid boolean` };
      }
      return { isValid: true, value: ['true', '1', 'yes'].includes(strValue) };
    }
    case 'json': {
      if (typeof value === 'string') {
        // If it looks like a JSON array
        if (value.trim().startsWith('[') && value.trim().endsWith(']')) {
          try {
            return { isValid: true, value: JSON.parse(value) };
          } catch {
            return { isValid: false, error: `Value '${value}' is not valid JSON` };
          }
        }
        // Split by comma if it's a comma-separated string
        if (value.includes(',')) {
          return { isValid: true, value: value.split(',').map(v => v.trim()).filter(Boolean) };
        }
        // Single value
        return { isValid: true, value: [value.trim()] };
      }
      if (Array.isArray(value)) {
        return { isValid: true, value };
      }
      return { isValid: false, error: `Value '${value}' is not a valid array or JSON` };
    }
    case 'enumeration': {
      const strValue = String(value).trim();
      return { isValid: true, value: strValue };
    }
    default:
      return { isValid: true, value };
  }
};


module.exports = createCoreController('api::marketplace.marketplace', ({ strapi }) => ({

  // ============================================================
  // SAFE POST-FETCH SORTING HELPER
  // This function is applied AFTER fetching data to guarantee 
  // that NULL values always appear at the bottom for metric fields.
  // This is the SINGLE source of truth for metric sorting.
  // ============================================================
  applyPostFetchSorting(entries, sortField, sortDirection, isDefaultSort = true) {
    // Only apply to metric fields that have the NULL issue
    const metricFields = [
      'ahrefs_dr', 'moz_da', 'semrush_authority_score',
      'ahrefs_traffic', 'semrush_traffic', 'similarweb_traffic',
      'price', 'link_insertion_price', 'spam_score',
      'adv_casino_pricing', 'adv_crypto_pricing', 'adv_cbd_pricing', 'adv_dating_pricing',
      'adv_li_casino_pricing', 'adv_li_crypto_pricing', 'adv_li_cbd_pricing', 'adv_li_dating_pricing'
    ];

    // Virtual "_any" fields: COALESCE of GP + LI prices (used on All-tab)
    const virtualPriceFields = {
      'price_any': ['price', 'link_insertion_price'],
      'adv_casino_pricing_any': ['adv_casino_pricing', 'adv_li_casino_pricing'],
      'adv_crypto_pricing_any': ['adv_crypto_pricing', 'adv_li_crypto_pricing'],
      'adv_cbd_pricing_any': ['adv_cbd_pricing', 'adv_li_cbd_pricing'],
      'adv_dating_pricing_any': ['adv_dating_pricing', 'adv_li_dating_pricing'],
    };

    const isVirtual = Object.prototype.hasOwnProperty.call(virtualPriceFields, sortField);

    // If not a metric field or no entries, return as-is
    if (!isVirtual && !metricFields.includes(sortField)) return entries;
    if (!Array.isArray(entries) || entries.length === 0) return entries;

    // Create a copy to avoid mutating original
    const sorted = [...entries];

    sorted.sort((a, b) => {
      // Featured websites float to the top ONLY in the default view.
      // When the user picks any explicit sort, featured must not influence ordering.
      // Generic: featured if featured for ANY service type (GP or LI).
      // Client-side re-sorts based on the active service type filter.
      // Raw Knex results use snake_case; Strapi ORM uses camelCase.
      if (isDefaultSort) {
        const aFeatured = (a.isFeaturedGuestPost || a.is_featured_guest_post || false) || (a.isFeaturedLinkInsertion || a.is_featured_link_insertion || false);
        const bFeatured = (b.isFeaturedGuestPost || b.is_featured_guest_post || false) || (b.isFeaturedLinkInsertion || b.is_featured_link_insertion || false);
        if (aFeatured !== bFeatured) {
          return bFeatured ? 1 : -1;
        }
      }

      // Treat 0 as "no price" for any price-like column so it falls to the
      // bottom alongside NULLs (matches the SQL-side NULLIF(col, 0)).
      const zeroAsNull = (v) => (v === 0 || v === '0' ? null : v);
      // Lowest VALID price between two columns; NULL/0 are skipped, returns
      // NULL only when both are NULL/0.
      const minValid = (x, y) => {
        const xv = zeroAsNull(x);
        const yv = zeroAsNull(y);
        if (xv == null) return yv;
        if (yv == null) return xv;
        return Number(xv) <= Number(yv) ? xv : yv;
      };

      let valA, valB;
      if (isVirtual) {
        const [f1, f2] = virtualPriceFields[sortField];
        valA = minValid(a[f1], a[f2]);
        valB = minValid(b[f1], b[f2]);
      } else if (PRICE_LIKE_FIELDS.has(sortField)) {
        valA = zeroAsNull(a[sortField]);
        valB = zeroAsNull(b[sortField]);
      } else {
        valA = a[sortField];
        valB = b[sortField];
      }

      // Handle NULL/undefined - always push to bottom
      const aIsEmpty = valA === null || valA === undefined;
      const bIsEmpty = valB === null || valB === undefined;

      // If both are empty, maintain order
      if (aIsEmpty && bIsEmpty) return 0;
      // If only A is empty, push A to bottom
      if (aIsEmpty) return 1;
      // If only B is empty, push B to bottom
      if (bIsEmpty) return -1;

      // Both have values - sort normally
      const numA = Number(valA) || 0;
      const numB = Number(valB) || 0;
      const diff = numA - numB;
      if (diff !== 0) {
        return sortDirection === 'desc' ? -diff : diff;
      }

      // Tie-breaker for virtual _any sorts: GP price ASC so the lower GP
      // wins within rows tied on the lowest valid price (matches the SQL
      // secondary ORDER BY on f1).
      if (isVirtual) {
        const [gpField] = virtualPriceFields[sortField];
        const gpA = zeroAsNull(a[gpField]);
        const gpB = zeroAsNull(b[gpField]);
        if (gpA == null && gpB == null) return 0;
        if (gpA == null) return 1;
        if (gpB == null) return -1;
        return (Number(gpA) || 0) - (Number(gpB) || 0);
      }

      return 0;
    });

    return sorted;
  },

  // Helper: shape a marketplace entry for the response using the
  // allow-list constants defined at the top of this file.
  //
  // For non-owners: return MARKETPLACE_PUBLIC_FIELDS only.
  // For the owning publisher: return PUBLIC + OWNER_EXTRA (their own
  //                            intake pricing, contact info, refresh ts).
  // For all: never include MARKETPLACE_NEVER_EXPOSE (gsc_refresh_token).
  // The `publisher` relation field is dropped from the response — only
  // its id is needed for the ownership check, and that's done in this
  // function before the entry is shaped.
  sanitizePublisherData(entries, user) {
    const sanitize = (entry) => {
      if (!entry) return entry;

      // Determine ownership BEFORE shaping the response.
      // publisher may arrive as a number (FK), as { id: N } (populated
      // with fields:['id']), or as a full row (legacy code paths).
      const publisherId = entry.publisher && typeof entry.publisher === 'object'
        ? entry.publisher.id
        : entry.publisher;

      const isOwnWebsite = !!(user && (
        (publisherId && publisherId == user.id) ||  // == handles string/number mismatch
        (!publisherId && entry.publisher_email && entry.publisher_email === user.email)
      ));

      const allowedFields = isOwnWebsite
        ? [...MARKETPLACE_PUBLIC_FIELDS, ...MARKETPLACE_OWNER_EXTRA_FIELDS]
        : MARKETPLACE_PUBLIC_FIELDS;

      // Build the response object explicitly from the allow-list. Anything
      // not in the list — including the populated `publisher` user record,
      // any future schema column, and the gsc_refresh_token — is dropped.
      const out = {};
      for (const k of allowedFields) {
        if (entry[k] !== undefined) out[k] = entry[k];
      }

      // Defense in depth: if a future allow-list update accidentally
      // includes a NEVER_EXPOSE field, strip it here.
      for (const k of MARKETPLACE_NEVER_EXPOSE) {
        if (k in out) delete out[k];
      }

      // Computed flag — safe to expose; doesn't reveal publisher identity,
      // just lets the UI render owner-only controls.
      out.isOwnWebsite = isOwnWebsite;

      return out;
    };

    // Handle both single entry and array of entries
    if (Array.isArray(entries)) {
      return entries.map(sanitize);
    }

    return sanitize(entries);
  },

  // Helper function to calculate placement speed based on TAT
  calculatePlacementSpeed(tat) {
    if (!tat || tat < 0) return 'Normal';

    if (tat >= 0 && tat <= 2) return 'Ultra Fast';
    if (tat >= 3 && tat <= 5) return 'Fast';
    if (tat >= 6 && tat <= 8) return 'Normal';
    if (tat >= 9 && tat <= 20) return 'Slow';

    // For TAT > 20 days, consider it Slow
    return 'Slow';
  },

  // Validation helper function
  validateMarketplaceData(data) {
    const schema = strapi.contentTypes['api::marketplace.marketplace'].attributes;
    const errors = [];

    for (const [field, value] of Object.entries(data)) {
      if (schema[field] && value !== null && value !== undefined) {
        const validation = validateType(value, schema[field].type, field, schema);
        if (!validation.isValid) {
          errors.push(`${field}: ${validation.error}`);
        }
      }
    }

    return errors;
  },

  // Enhanced create with validation
  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    // Pre-fix: an advertiser (user.Advertiser === true) could POST
    // /api/marketplaces with publisher_email = victim and the handler at
    // L413-422 would auto-link the victim's user record as the publisher
    // — letting any logged-in advertiser create marketplace listings in
    // someone else's name with arbitrary prices. The admin panel uses
    // /admin/marketplace; the publisher app creates listings via the
    // publisher-website lifecycle, not this endpoint. So /api/marketplaces
    // POST has no legitimate non-admin / non-publisher consumer.
    const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
    const isPublisher = user.Advertiser === false || user.Publisher === true;
    if (!isAdmin && !isPublisher) {
      return ctx.forbidden('Marketplace listings can only be created by publishers or admins');
    }

    // Calculate placement speed if TAT is provided
    if (ctx.request.body.data && ctx.request.body.data.tat !== undefined) {
      ctx.request.body.data.placement_speed = this.calculatePlacementSpeed(ctx.request.body.data.tat);
    }

    // Validate input data
    const validationErrors = this.validateMarketplaceData(ctx.request.body.data || {});
    if (validationErrors.length > 0) {
      return ctx.badRequest(`Validation failed: ${validationErrors.join(', ')}`);
    }

    // Publisher: force publisher_email + publisher FK to themselves. Strip
    // any caller-supplied values so a non-admin publisher cannot create a
    // listing in someone else's name.
    if (!isAdmin) {
      if (!ctx.request.body.data) ctx.request.body.data = {};
      ctx.request.body.data.publisher_email = user.email;
      ctx.request.body.data.publisher = user.id;
    }

    // CRITICAL: Ensure publisher user ID is always linked
    const data = ctx.request.body.data || {};

    // If publisher ID is already provided, verify it exists
    if (data.publisher) {
      const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { id: data.publisher }
      });
      if (!publisherUser) {
        return ctx.badRequest('Invalid publisher ID: User does not exist');
      }
    }
    // If no publisher ID but email is provided, look up user and set publisher
    else if (data.publisher_email) {
      const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: data.publisher_email }
      });
      if (publisherUser) {
        ctx.request.body.data.publisher = publisherUser.id;
        console.log(`[Marketplace Create] Linked publisher ${publisherUser.id} from email ${data.publisher_email}`);
      } else {
        return ctx.badRequest(`Cannot create listing: No user account found for email ${data.publisher_email}. Publisher must register first.`);
      }
    }
    // If logged-in publisher is creating, link their user ID
    else if (user && user.Advertiser === false) {
      ctx.request.body.data.publisher = user.id;
      console.log(`[Marketplace Create] Linked publisher ${user.id} (current user)`);
    }
    // No publisher info at all - reject
    else {
      return ctx.badRequest('Cannot create listing: Publisher information is required');
    }

    return await super.create(ctx);
  },

  // Enhanced update with validation
  async update(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    // Pre-fix: the ownership check only ran for publishers
    // (user.Advertiser === false). Advertisers / plain users skipped the
    // check entirely and proceeded to super.update — letting any logged-in
    // user tamper with ANY marketplace listing's fields (prices, status,
    // metrics, is_featured). Now fail-CLOSED: admin OR matching publisher.
    const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
    const isPublisher = user.Advertiser === false || user.Publisher === true;
    if (!isAdmin && !isPublisher) {
      return ctx.forbidden('Marketplace listings can only be updated by their publisher or an admin');
    }

    if (!isAdmin) {
      const entry = await strapi.entityService.findOne('api::marketplace.marketplace', ctx.params.id, {
        fields: ['publisher_email'],
        populate: { publisher: { fields: ['id'] } },
      });
      const isOwner = entry && (
        (entry.publisher && entry.publisher.id === user.id) ||
        (!entry.publisher && entry.publisher_email === user.email)
      );
      if (!entry || !isOwner) {
        // 404 not 401 — defeat enumeration.
        return ctx.notFound('Marketplace listing not found');
      }
    }

    // Calculate placement speed if TAT is provided
    if (ctx.request.body.data && ctx.request.body.data.tat !== undefined) {
      ctx.request.body.data.placement_speed = this.calculatePlacementSpeed(ctx.request.body.data.tat);
    }

    // Validate input data
    const validationErrors = this.validateMarketplaceData(ctx.request.body.data || {});
    if (validationErrors.length > 0) {
      return ctx.badRequest(`Validation failed: ${validationErrors.join(', ')}`);
    }

    // CRITICAL: Ensure publisher user ID is linked on updates
    const data = ctx.request.body.data || {};

    // If updating publisher ID, verify it exists
    if (data.publisher) {
      const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { id: data.publisher }
      });
      if (!publisherUser) {
        return ctx.badRequest('Invalid publisher ID: User does not exist');
      }
    }
    // If updating publisher_email and no publisher ID, try to link
    else if (data.publisher_email && !data.publisher) {
      const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
        where: { email: data.publisher_email }
      });
      if (publisherUser) {
        ctx.request.body.data.publisher = publisherUser.id;
        console.log(`[Marketplace Update] Linked publisher ${publisherUser.id} from email ${data.publisher_email}`);
      }
    }
    // If entry has no publisher but has email, fix it during update
    else {
      const existingEntry = await strapi.entityService.findOne('api::marketplace.marketplace', ctx.params.id, {
        fields: ['publisher_email'],
        // Only need to know whether publisher FK is set — populate id only.
        populate: { publisher: { fields: ['id'] } }
      });
      if (existingEntry && !existingEntry.publisher && existingEntry.publisher_email) {
        const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { email: existingEntry.publisher_email }
        });
        if (publisherUser) {
          ctx.request.body.data.publisher = publisherUser.id;
          console.log(`[Marketplace Update] Fixed orphan: Linked publisher ${publisherUser.id} from email ${existingEntry.publisher_email}`);
        }
      }
    }

    return await super.update(ctx);
  },

  // Enhanced delete with authorization. Pre-fix advertisers/plain users
  // bypassed the ownership check (it only ran for `user.Advertiser ===
  // false`) → delete IDOR on any marketplace listing. Now fail-CLOSED.
  async delete(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
    const isPublisher = user.Advertiser === false || user.Publisher === true;
    if (!isAdmin && !isPublisher) {
      return ctx.forbidden('Marketplace listings can only be deleted by their publisher or an admin');
    }

    if (!isAdmin) {
      const entry = await strapi.entityService.findOne('api::marketplace.marketplace', ctx.params.id, {
        fields: ['publisher_email'],
        populate: { publisher: { fields: ['id'] } },
      });
      const isOwner = entry && (
        (entry.publisher && entry.publisher.id === user.id) ||
        (!entry.publisher && entry.publisher_email === user.email)
      );
      if (!entry || !isOwner) {
        return ctx.notFound('Marketplace listing not found');
      }
    }

    return await super.delete(ctx);
  },

  // Publisher filtering: Only allow publishers to see their own listings
  async find(ctx) {
    // Get authenticated user from context
    const user = ctx.state.user;
    console.log(user)

    // Initialize query filters if they don't exist
    if (!ctx.query) ctx.query = {};
    if (!ctx.query.filters) ctx.query.filters = {};

    // Strip caller-supplied filters on private fields. Non-admin users
    // could otherwise enumerate publisher_email existence via the
    // meta.pagination.total count, e.g. ?filters[publisher_email][$eq]=...
    // confirms whether an email has any listings on the platform.
    // Admins keep filter access (panel20 needs it for moderation views).
    // The publisher self-listing filter (publisher_email: user.email) is
    // added by this controller *after* this sanitization runs, so it
    // continues to work.
    const isAdmin = user && user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
    if (!isAdmin) {
      const PRIVATE_FILTER_KEYS = new Set([
        'publisher_email',
        'publisher_name',
        'gsc_refresh_token',
        'gsc_permission_level',
      ]);
      const stripPrivateFilters = (node) => {
        if (!node || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map(stripPrivateFilters);
        const cleaned = {};
        for (const [key, value] of Object.entries(node)) {
          if (PRIVATE_FILTER_KEYS.has(key)) continue;
          cleaned[key] = stripPrivateFilters(value);
        }
        return cleaned;
      };
      ctx.query.filters = stripPrivateFilters(ctx.query.filters);
    }

    // Deposit-gate: advertisers and anonymous users only see the first
    // MARKETPLACE_UNLOCK_MIN_USD-worth of listings (capped at 10 rows) until
    // they've deposited the minimum. Publishers see only their own and are
    // never gated. Super admins can manually unlock a specific user via
    // marketplaceUnlocked on the user record (see admin users page).
    const minDepositRequired = getMarketplaceUnlockMin();
    const isPublisherUser =
      user && user.Advertiser === false && user.Publisher === true;
    const lifetimeDeposits =
      !isPublisherUser && user ? await getLifetimeDeposits(strapi, user.id) : 0;
    const manuallyUnlocked = !!(user && user.marketplaceUnlocked);
    const gated =
      !isPublisherUser && !manuallyUnlocked && lifetimeDeposits < minDepositRequired;

    if (gated) {
      if (!ctx.query.pagination) ctx.query.pagination = {};
      ctx.query.pagination.page = 1;
      ctx.query.pagination.pageSize = 10;
      // Curated preview: ignore the user's sort selection and always show
      // featured listings first, then highest-traffic rows. The 'default'
      // sort branch below already implements featured-first +
      // ahrefs_traffic DESC NULLS LAST.
      ctx.query.sort = 'default';
    }

    // Per-user daily uniqueness quota. Applied to advertisers/regular
    // users only — admins and publishers viewing their own listings
    // are bypassed. The quota is the layer that actually prevents bulk
    // catalog extraction: pageSize cap + rate limit bound the rate;
    // this bounds the TOTAL unique listings any one user can see in
    // 24h, regardless of how slowly they request.
    const marketplaceQuota = require('../../../utils/marketplace-quota');
    const isAdminUser = !!(user && user.role && (
      user.role.type === 'admin' || user.role.type === 'super_admin'
    ));
    const quotaApplies = !!user && !isAdminUser && !isPublisherUser;

    // Wrap every response path. Added `await` to existing return sites
    // since the quota check is async (Redis SCARD/SADD round-trip).
    const withGateMeta = async (result) => {
      if (!result || typeof result !== 'object') return result;

      let quotaMeta = {};
      if (quotaApplies && Array.isArray(result.data) && result.data.length > 0) {
        const ids = result.data.map((e) => (e && (e.id || e.attributes?.id))).filter(Boolean);
        const { allowed, total, atQuota } = await marketplaceQuota.checkAndFilter(user.id, ids);
        // Filter the response to the allowed IDs only. Already-seen
        // IDs always pass through; new IDs over the cap are dropped.
        if (atQuota || allowed.length < ids.length) {
          const allowSet = new Set(allowed);
          result.data = result.data.filter((e) => {
            const id = e && (e.id || e.attributes?.id);
            return id && allowSet.has(id);
          });
        }
        quotaMeta = {
          dailyBrowseUsed: total,
          dailyBrowseCap: marketplaceQuota.getCap(),
          atDailyBrowseCap: atQuota,
        };
      }

      result.meta = {
        ...(result.meta || {}),
        gated,
        minDepositRequired,
        ...quotaMeta,
      };
      return result;
    };

    // Advertiser (user.Advertiser === true) can see all active listings
    // Publisher (user.Advertiser === false) only sees their listings
    if (user && user.Advertiser === false && user.Publisher === true) {
      // Publishers see their own listings (all statuses) - use userId OR email for legacy
      ctx.query.filters.$or = [
        { publisher: user.id },
        { publisher_email: user.email }
      ];
    } else {
      // Advertisers and public users only see active listings (hide paused/delisted listings)
      // Only show marketplace listings that have proper status and are not paused or delisted
      const mandatoryFilters = [
        // Must have proper marketplace status (active or legacy null/empty) - exclude delisted
        {
          $or: [
            { status: 'active' },
            { status: { $null: true } },
            { status: '' }
          ]
        },
        // Must have proper website status (indicating they are approved/live websites)
        {
          $or: [
            { website_status: 'active' },
            { website_status: { $null: true } }, // Legacy records
            { website_status: '' } // Legacy records
          ]
        },
        // MUST have at least one valid price (greater than 0)
        // Websites with no prices should not appear in marketplace
        {
          $or: [
            { price: { $gt: 0 } },
            { link_insertion_price: { $gt: 0 } },
            { adv_casino_pricing: { $gt: 0 } },
            { adv_li_casino_pricing: { $gt: 0 } },
            { adv_crypto_pricing: { $gt: 0 } },
            { adv_li_crypto_pricing: { $gt: 0 } },
            { adv_cbd_pricing: { $gt: 0 } },
            { adv_li_cbd_pricing: { $gt: 0 } },
            { adv_dating_pricing: { $gt: 0 } },
            { adv_li_dating_pricing: { $gt: 0 } }
          ]
        }
      ];

      // Merge with existing $and filters if any (don't overwrite client filters!)
      if (ctx.query.filters.$and) {
        if (Array.isArray(ctx.query.filters.$and)) {
          ctx.query.filters.$and.push(...mandatoryFilters);
        } else {
          // Should be array, but if structure is weird, convert
          ctx.query.filters.$and = [ctx.query.filters.$and, ...mandatoryFilters];
        }
      } else {
        ctx.query.filters.$and = mandatoryFilters;
      }

      console.log('🔍 Marketplace filters for public/advertisers:', JSON.stringify(ctx.query.filters, null, 2));
    }

    // Handle sensitive category price-based filtering
    // Convert sensitive category filters to price-based filters
    const sensitivePriceMapping = {
      'Casino': ['adv_casino_pricing', 'adv_li_casino_pricing'],
      'Casino/Sports Betting': ['adv_casino_pricing', 'adv_li_casino_pricing'],
      'Crypto': ['adv_crypto_pricing', 'adv_li_crypto_pricing'],
      'CBD': ['adv_cbd_pricing', 'adv_li_cbd_pricing'],
      'Dating': ['adv_dating_pricing', 'adv_li_dating_pricing'],
      'Dating/Adult': ['adv_dating_pricing', 'adv_li_dating_pricing'],
    };

    // Check for sensitive_price_category filter parameter
    const sensitivePriceCategories = [];
    const queryParams = ctx.query;

    // Handle array format: sensitive_price_category[0]=Casino&sensitive_price_category[1]=CBD
    if (queryParams.sensitive_price_category) {
      if (Array.isArray(queryParams.sensitive_price_category)) {
        sensitivePriceCategories.push(...queryParams.sensitive_price_category);
      } else {
        sensitivePriceCategories.push(queryParams.sensitive_price_category);
      }
    }

    // Also check for indexed format: sensitive_price_category_0=Casino&sensitive_price_category_1=CBD
    Object.keys(queryParams).forEach(key => {
      if (key.startsWith('sensitive_price_category_') || key.match(/^sensitive_price_category\[\d+\]$/)) {
        const value = queryParams[key];
        if (value && !sensitivePriceCategories.includes(value)) {
          sensitivePriceCategories.push(value);
        }
      }
    });

    // Apply sensitive category price-based filters
    if (sensitivePriceCategories.length > 0) {
      console.log('🔍 Sensitive price categories to filter:', sensitivePriceCategories);

      if (!ctx.query.filters.$and) {
        ctx.query.filters.$and = [];
      }

      // For each selected sensitive category, website must have at least one of the related prices > 0
      sensitivePriceCategories.forEach(category => {
        const priceFields = sensitivePriceMapping[category];
        if (priceFields) {
          const categoryFilter = {
            $or: priceFields.map(field => ({ [field]: { $gt: 0 } }))
          };
          ctx.query.filters.$and.push(categoryFilter);
          console.log(`🔍 Added price filter for ${category}:`, JSON.stringify(categoryFilter));
        }
      });
    }

    // Handle sorting with database-level NULL-safe ordering (production-ready for 100k+ websites)
    // Uses Knex raw SQL for proper NULL handling that works on both PostgreSQL and SQLite

    // All numeric metric fields that need NULL-safe sorting
    // These will push NULL/0 values to the bottom (desc) or top (asc) automatically
    const metricFields = [
      // Authority metrics (currently sortable in UI)
      'ahrefs_dr',
      'moz_da',
      'semrush_authority_score',

      // Traffic metrics (currently sortable in UI)
      'ahrefs_traffic',

      // Price (currently sortable in UI)
      'price',

      // Additional metrics (not currently sortable, but future-proof)
      'spam_score',
      'ahrefs_rank',
      'ahrefs_keywords',
      'ahrefs_referring_domain',
      'semrush_traffic',
      'similarweb_traffic',
      'link_insertion_price',

      // Specialized pricing (sensitive categories)
      'adv_casino_pricing',
      'adv_crypto_pricing',
      'adv_cbd_pricing',
      'adv_dating_pricing',
      'adv_li_casino_pricing',
      'adv_li_crypto_pricing',
      'adv_li_cbd_pricing',
      'adv_li_dating_pricing'
    ];

    let useRawSorting = false;
    let rawSortField = null;
    let rawSortDirection = null;
    // When true: featured items float to the top. When false (any explicit sort
    // chosen by the user): featured has no effect on ordering.
    const isDefaultSort = !ctx.query.sort || ctx.query.sort === 'default';

    if (ctx.query.sort && ctx.query.sort !== 'default') {
      // Map frontend sort fields to backend database fields
      const sortMapping = {
        'url': 'url',
        'category': 'category',
        'ahrefs_traffic': 'ahrefs_traffic',
        'moz_da': 'moz_da',
        'ahrefs_dr': 'ahrefs_dr',
        'semrush_authority_score': 'semrush_authority_score',
        'price': 'price',
        'link_insertion_price': 'link_insertion_price',
        'adv_casino_pricing': 'adv_casino_pricing',
        'adv_crypto_pricing': 'adv_crypto_pricing',
        'adv_cbd_pricing': 'adv_cbd_pricing',
        'adv_dating_pricing': 'adv_dating_pricing',
        'adv_li_casino_pricing': 'adv_li_casino_pricing',
        'adv_li_crypto_pricing': 'adv_li_crypto_pricing',
        'adv_li_cbd_pricing': 'adv_li_cbd_pricing',
        'adv_li_dating_pricing': 'adv_li_dating_pricing',
        // Virtual "_any" fields resolve to COALESCE(GP, LI) of the matching category
        'price_any': 'price_any',
        'adv_casino_pricing_any': 'adv_casino_pricing_any',
        'adv_crypto_pricing_any': 'adv_crypto_pricing_any',
        'adv_cbd_pricing_any': 'adv_cbd_pricing_any',
        'adv_dating_pricing_any': 'adv_dating_pricing_any',
        'createdAt': 'createdAt',
        'updatedAt': 'updatedAt'
      };

      // Parse sort parameter (e.g., "price:desc" or "url:asc")
      const [field, direction] = ctx.query.sort.split(':');
      const mappedField = sortMapping[field] || field;
      const sortDirection = direction === 'asc' ? 'asc' : 'desc';

      // Route ALL sort fields through raw SQL for NULL-safe featured sorting.
      // PostgreSQL puts NULLs FIRST in DESC order by default, which buries
      // featured websites behind thousands of NULL records on large datasets.
      // The raw SQL path uses COALESCE(is_featured, false) DESC to fix this.
      useRawSorting = true;
      rawSortField = mappedField;
      rawSortDirection = sortDirection;

      // Don't set ctx.query.sort - we'll handle it with raw SQL
      delete ctx.query.sort;

      console.log(`🔍 Will apply NULL-safe raw SQL sorting: ${mappedField}:${sortDirection}`);
    } else {
      // Default sort: featured first, then ahrefs_traffic descending (NULL-safe via raw SQL)
      useRawSorting = true;
      rawSortField = 'ahrefs_traffic';
      rawSortDirection = 'desc';
      // Strip the 'default' sentinel so downstream code paths that read
      // ctx.query.sort don't try to use it as a real column name.
      if (ctx.query.sort === 'default') delete ctx.query.sort;
    }

    // For metric field sorting, use Knex with NULLS LAST for proper NULL/0 handling
    if (useRawSorting && rawSortField && rawSortDirection) {
      const { filters, pagination } = ctx.query;
      // Anti-scraping clamp: see clampMarketplacePagination definition.
      // Pre-clamp this read was `ctx.query.pagination?.pageSize || 25`
      // with no upper bound — `?pageSize=10000` would dump 10k rows.
      const { page, pageSize } = clampMarketplacePagination(ctx);

      try {
        // Get Strapi's Knex connection
        const knex = strapi.db.connection;

        // Build base query
        let query = knex('marketplaces');

        // Apply filters using Strapi's filter conversion
        // Convert Strapi filters to Knex where clauses
        const applyFilters = (query, filters) => {
          if (!filters) return query;

          Object.entries(filters).forEach(([key, value]) => {
            if (key === '$and' && Array.isArray(value)) {
              // Handle $and operator
              value.forEach(condition => {
                query.where(builder => {
                  Object.entries(condition).forEach(([field, fieldValue]) => {
                    if (field === '$or' && Array.isArray(fieldValue)) {
                      // Nested $or inside $and
                      builder.where(orBuilder => {
                        fieldValue.forEach(orCondition => {
                          Object.entries(orCondition).forEach(([orField, orValue]) => {
                            if (typeof orValue === 'object' && orValue !== null) {
                              Object.entries(orValue).forEach(([operator, opValue]) => {
                                if (operator === '$gt') orBuilder.orWhere(orField, '>', opValue);
                                else if (operator === '$gte') orBuilder.orWhere(orField, '>=', opValue);
                                else if (operator === '$lt') orBuilder.orWhere(orField, '<', opValue);
                                else if (operator === '$lte') orBuilder.orWhere(orField, '<=', opValue);
                                else if (operator === '$eq') orBuilder.orWhere(orField, '=', opValue);
                                else if (operator === '$ne') orBuilder.orWhere(orField, '!=', opValue);
                                else if (operator === '$null') orBuilder.orWhereNull(orField);
                                else if (operator === '$notNull') orBuilder.orWhereNotNull(orField);
                                else if (operator === '$contains') orBuilder.orWhere(orField, 'like', `%${opValue}%`);
                                else if (operator === '$containsi') orBuilder.orWhereRaw('LOWER(??) LIKE ?', [orField, `%${String(opValue).toLowerCase()}%`]);
                              });
                            } else {
                              orBuilder.orWhere(orField, orValue);
                            }
                          });
                        });
                      });
                    } else if (typeof fieldValue === 'object' && fieldValue !== null) {
                      // Handle operators for regular fields
                      Object.entries(fieldValue).forEach(([operator, opValue]) => {
                        if (operator === '$gt') builder.where(field, '>', opValue);
                        else if (operator === '$gte') builder.where(field, '>=', opValue);
                        else if (operator === '$lt') builder.where(field, '<', opValue);
                        else if (operator === '$lte') builder.where(field, '<=', opValue);
                        else if (operator === '$eq') builder.where(field, '=', opValue);
                        else if (operator === '$ne') builder.where(field, '!=', opValue);
                        else if (operator === '$null') builder.whereNull(field);
                        else if (operator === '$notNull') builder.whereNotNull(field);
                        else if (operator === '$contains') builder.where(field, 'like', `%${opValue}%`);
                        else if (operator === '$containsi') builder.whereRaw('LOWER(??) LIKE ?', [field, `%${String(opValue).toLowerCase()}%`]);
                      });
                    } else {
                      builder.where(field, fieldValue);
                    }
                  });
                });
              });
            } else if (key === '$or' && Array.isArray(value)) {
              // Handle root-level $or operator (used by bulk domain search)
              query.where(builder => {
                value.forEach(orCondition => {
                  Object.entries(orCondition).forEach(([orField, orValue]) => {
                    if (typeof orValue === 'object' && orValue !== null) {
                      Object.entries(orValue).forEach(([operator, opVal]) => {
                        if (operator === '$containsi') builder.orWhereRaw('LOWER(??) LIKE ?', [orField, `%${String(opVal).toLowerCase()}%`]);
                        else if (operator === '$contains') builder.orWhere(orField, 'like', `%${opVal}%`);
                        else if (operator === '$eq') builder.orWhere(orField, '=', opVal);
                        else if (operator === '$gt') builder.orWhere(orField, '>', opVal);
                        else if (operator === '$gte') builder.orWhere(orField, '>=', opVal);
                        else if (operator === '$lt') builder.orWhere(orField, '<', opVal);
                        else if (operator === '$lte') builder.orWhere(orField, '<=', opVal);
                        else if (operator === '$ne') builder.orWhere(orField, '!=', opVal);
                        else if (operator === '$startsWith') builder.orWhere(orField, 'like', `${opVal}%`);
                        else if (operator === '$endsWith') builder.orWhere(orField, 'like', `%${opVal}`);
                        else if (operator === '$in' && Array.isArray(opVal)) builder.orWhereIn(orField, opVal);
                      });
                    } else {
                      builder.orWhere(orField, orValue);
                    }
                  });
                });
              });
            } else if (typeof value === 'object' && value !== null) {
              // Handle operators for top-level fields
              Object.entries(value).forEach(([operator, opValue]) => {
                if (operator === '$gt') query.where(key, '>', opValue);
                else if (operator === '$gte') query.where(key, '>=', opValue);
                else if (operator === '$lt') query.where(key, '<', opValue);
                else if (operator === '$lte') query.where(key, '<=', opValue);
                else if (operator === '$eq') query.where(key, '=', opValue);
                else if (operator === '$ne') query.where(key, '!=', opValue);
                else if (operator === '$null') query.whereNull(key);
                else if (operator === '$notNull') query.whereNotNull(key);
                else if (operator === '$contains') query.where(key, 'like', `%${opValue}%`);
                else if (operator === '$containsi') query.whereRaw('LOWER(??) LIKE ?', [key, `%${String(opValue).toLowerCase()}%`]);
                else if (operator === '$endsWith') query.where(key, 'like', `%${opValue}`);
                else if (operator === '$startsWith') query.where(key, 'like', `${opValue}%`);
                else if (operator === '$in' && Array.isArray(opValue)) query.whereIn(key, opValue);
              });
            } else {
              query.where(key, value);
            }
          });

          return query;
        };

        // Apply filters
        query = applyFilters(query, ctx.query.filters);

        // Apply NULL-safe sorting with NULLS LAST
        // Featured websites always appear first, then sort by the requested metric field
        // NOTE: Use snake_case because Knex raw SQL bypasses Strapi's ORM column name mapping
        // Featured = site is featured for ANY service type (GP or LI)
        // Client-side re-sorts based on the active service type filter after receiving data
        const virtualSortMap = {
          'price_any': ['price', 'link_insertion_price'],
          'adv_casino_pricing_any': ['adv_casino_pricing', 'adv_li_casino_pricing'],
          'adv_crypto_pricing_any': ['adv_crypto_pricing', 'adv_li_crypto_pricing'],
          'adv_cbd_pricing_any': ['adv_cbd_pricing', 'adv_li_cbd_pricing'],
          'adv_dating_pricing_any': ['adv_dating_pricing', 'adv_li_dating_pricing'],
        };

        if (isDefaultSort) {
          query = query.orderByRaw('(COALESCE(is_featured_guest_post, false) OR COALESCE(is_featured_link_insertion, false)) DESC');
        }

        if (virtualSortMap[rawSortField]) {
          // Sort key = lowest VALID price between GP and LI (NULL/0 treated as
          // "no price"). CASE expression instead of LEAST/min for portability
          // across PostgreSQL and SQLite (SQLite has no LEAST; its min(a,b)
          // propagates NULL). Column names come from a fixed map → safe to
          // interpolate. If both are NULL/0 the expression yields NULL and
          // NULLS LAST pushes the row to the bottom.
          // Tie-breaker: GP price ASC so within rows tied on the lowest valid
          // price, the listing with the lower GP price appears first
          // (regardless of the primary direction).
          const [f1, f2] = virtualSortMap[rawSortField];
          const minExpr = `CASE
            WHEN NULLIF(${f1}, 0) IS NULL THEN NULLIF(${f2}, 0)
            WHEN NULLIF(${f2}, 0) IS NULL THEN NULLIF(${f1}, 0)
            WHEN NULLIF(${f1}, 0) <= NULLIF(${f2}, 0) THEN NULLIF(${f1}, 0)
            ELSE NULLIF(${f2}, 0)
          END`;
          query = query
            .orderByRaw(`(${minExpr}) ${rawSortDirection} NULLS LAST`)
            .orderByRaw(`NULLIF(${f1}, 0) ASC NULLS LAST`);
        } else if (PRICE_LIKE_FIELDS.has(rawSortField)) {
          // Single price column: 0 → NULL → bottom of ASC sort.
          query = query.orderByRaw(`NULLIF(??, 0) ${rawSortDirection} NULLS LAST`, [rawSortField]);
        } else {
          query = query.orderByRaw(`?? ${rawSortDirection} NULLS LAST`, [rawSortField]);
        }

        // Clone query for count (before pagination)
        // clearOrder() removes ORDER BY clauses which are invalid on aggregate COUNT queries in PostgreSQL
        const countQuery = query.clone().clearOrder().count('* as count');

        // Apply pagination
        query = query.limit(pageSize).offset((page - 1) * pageSize);

        // Execute queries
        const [results, countResult] = await Promise.all([
          query,
          countQuery
        ]);

        const total = parseInt(countResult[0]?.count || 0);

        // Sanitize publisher data
        const sanitizedResults = this.sanitizePublisherData(results, user);

        // Apply post-fetch sorting as final guarantee
        const sortedResults = this.applyPostFetchSorting(sanitizedResults, rawSortField, rawSortDirection, isDefaultSort);

        // Return in Strapi v4 format
        return await withGateMeta({
          data: sortedResults,
          meta: {
            pagination: {
              page,
              pageSize,
              pageCount: Math.ceil(total / pageSize),
              total
            }
          }
        });
      } catch (error) {
        console.error('❌ Knex sorting failed, falling back to default:', error.message);
        // Fallback to Strapi's default entityService (without NULLS LAST fix)
        // Virtual _any fields aren't real columns; degrade to the GP-side price.
        const virtualSortFallback = {
          'price_any': 'price',
          'adv_casino_pricing_any': 'adv_casino_pricing',
          'adv_crypto_pricing_any': 'adv_crypto_pricing',
          'adv_cbd_pricing_any': 'adv_cbd_pricing',
          'adv_dating_pricing_any': 'adv_dating_pricing',
        };
        const fallbackField = virtualSortFallback[rawSortField] || rawSortField;
        try {
          const results = await strapi.entityService.findPage('api::marketplace.marketplace', {
            filters: ctx.query.filters,
            // Defense in depth: pre-fix this was
            //   `populate: ctx.query.populate || '*'`
            // which (a) accepted caller-controlled populate from the
            // query string (`?populate=publisher` would pull the full
            // up_users row) and (b) defaulted to `'*'` which populates
            // EVERY relation. The sanitizer's new allow-list catches
            // the response leak, but in-memory data is still amplified.
            // Locking to the same publisher-id-only populate used in the
            // primary path above.
            populate: { publisher: { fields: ['id'] } },
            page,
            pageSize,
            orderBy: {
              [fallbackField]: rawSortDirection
            }
          });

          if (results && results.results) {
            results.results = this.sanitizePublisherData(results.results, user);
            // Apply post-fetch sorting as final guarantee
            results.results = this.applyPostFetchSorting(results.results, rawSortField, rawSortDirection, isDefaultSort);
          }

          return await withGateMeta({
            data: results.results,
            meta: {
              pagination: results.pagination
            }
          });
        } catch (fallbackError) {
          console.error('❌ Fallback also failed:', fallbackError);
          // Ultimate fallback
          const result = await super.find(ctx);
          if (result && result.data) {
            result.data = this.sanitizePublisherData(result.data, user);
            // Apply post-fetch sorting as final guarantee
            result.data = this.applyPostFetchSorting(result.data, rawSortField, rawSortDirection, isDefaultSort);
          }
          return await withGateMeta(result);
        }
      }
    }

    // Standard Strapi query for non-metric fields
    // IMPORTANT: We need to fetch WITH private fields (publisher_email) for ownership checks
    // Then sanitize them ourselves in sanitizePublisherData
    try {
      // Anti-scraping clamp — same bounds as the Knex path above.
      const { page, pageSize } = clampMarketplacePagination(ctx);

      // Use db.query to get ALL fields including private ones
      // IMPORTANT: Populate publisher relation for ownership check in sanitizePublisherData
      const sortParts = (ctx.query.sort || 'updatedAt:desc').split(',');
      const orderByArray = sortParts.map(part => {
        const [field, dir] = part.split(':');
        return { [field]: dir || 'asc' };
      });
      // Always ensure featured fields are the first sort criteria
      // Sites featured for any service type appear first
      const hasIsFeatured = orderByArray.some(obj => 'isFeaturedGuestPost' in obj || 'isFeaturedLinkInsertion' in obj);
      if (isDefaultSort && !hasIsFeatured) {
        orderByArray.unshift({ isFeaturedGuestPost: 'desc' }, { isFeaturedLinkInsertion: 'desc' });
      }
      const entries = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: ctx.query.filters,
        orderBy: orderByArray,
        limit: pageSize,
        offset: (page - 1) * pageSize,
        // Only the publisher's id is needed for the isOwnWebsite check
        // performed in sanitizePublisherData. Pre-fix this used the
        // string-form `populate: ['publisher']` which returned the full
        // up_users row (email, clerkId, password, resetPasswordToken,
        // confirmationToken, blocked, confirmed) per entry — that's the
        // IDOR / PII leak this hotfix closes.
        populate: { publisher: { select: ['id'] } },
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::marketplace.marketplace').count({
        where: ctx.query.filters
      });

      // Sanitize publisher data (this removes private fields for non-owners)
      const sanitizedEntries = this.sanitizePublisherData(entries, user);

      // Apply post-fetch sorting if sorting by a metric field
      const postSortParts = (ctx.query.sort || 'updatedAt:desc').split(':');
      const sortField = postSortParts[0];
      const sortDirection = postSortParts[1] || 'desc';
      const sortedEntries = this.applyPostFetchSorting(sanitizedEntries, sortField, sortDirection, isDefaultSort);

      return await withGateMeta({
        data: sortedEntries,
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: Math.ceil(total / pageSize),
            total
          }
        }
      });
    } catch (error) {
      console.error('❌ Error fetching marketplace data:', error);
      // Fallback to super.find if db query fails
      const result = await super.find(ctx);
      if (result && result.data) {
        result.data = this.sanitizePublisherData(result.data, user);
        // Apply post-fetch sorting for fallback too
        const sortParts = (ctx.query.sort || 'updatedAt:desc').split(':');
        result.data = this.applyPostFetchSorting(result.data, sortParts[0], sortParts[1] || 'desc', isDefaultSort);
      }
      return await withGateMeta(result);
    }
  },

  async findOne(ctx) {
    try {
      // Get authenticated user from context
      const user = ctx.state.user;
      console.log('🔍 findOne - User:', user ? { id: user.id, email: user.email, Advertiser: user.Advertiser, Publisher: user.Publisher } : 'No user');
      console.log('🔍 Requesting entry ID:', ctx.params.id);

      // Fetch entry WITH private fields for ownership check
      // Using db.query instead of entityService to bypass private field filtering
      const entry = await strapi.db.query('api::marketplace.marketplace').findOne({
        where: { id: ctx.params.id }
      });
      console.log('🔍 Direct entry lookup:', entry ? 'Found' : 'Not found');

      if (!entry) {
        return ctx.notFound('Marketplace entry not found');
      }

      // Check user permissions
      if (user && user.Advertiser === false && user.Publisher === true) {
        console.log('🔍 User is a Publisher, checking ownership...');
        // Check ownership: prefer userId (publisher relation), fallback to email for legacy
        const isOwner = (entry.publisher && entry.publisher === user.id) ||
          (!entry.publisher && entry.publisher_email === user.email);
        if (!isOwner) {
          console.log('🔍 Publisher not authorized - Entry publisher:', entry.publisher, 'User ID:', user.id);
          return ctx.unauthorized('You are not allowed to view this listing.');
        }
        console.log('🔍 Publisher authorized to view their own listing');
      } else {
        console.log('🔍 User is Advertiser or public user, allowing access to all listings');
      }

      // Sanitize publisher data for advertisers
      const sanitizedEntry = this.sanitizePublisherData(entry, user);

      // Return the entry directly
      return { data: sanitizedEntry };
    } catch (error) {
      console.error('🔍 Error in findOne:', error.message);
      throw error;
    }
  },

  // Check if domain exists in marketplace
  async checkDomainExists(ctx) {
    const { domain } = ctx.params;

    if (!domain) {
      return ctx.badRequest('Domain parameter is required');
    }

    try {
      const cleanDomain = normalizeUrl(domain);

      // Skip delisted rows — duplicates we soft-removed during dedup share the
      // same canonical url as their keeper; we want to return the keeper's id.
      const existingEntry = await strapi.db.query('api::marketplace.marketplace').findOne({
        where: { url: cleanDomain, status: { $ne: 'delisted' } },
        select: ['id', 'url']
      });

      if (existingEntry) {
        return ctx.send({
          exists: true,
          message: `This domain "${cleanDomain}" is already listed in the marketplace`,
          data: {
            id: existingEntry.id,
            url: existingEntry.url
          }
        });
      } else {
        return ctx.send({
          exists: false,
          message: 'Domain is available'
        });
      }
    } catch (error) {
      console.error('Error checking domain existence:', error);
      return ctx.internalServerError('Failed to check domain existence');
    }
  },

  async uploadCSV(ctx) {
    try {
      // Check if this is a direct file upload or a confirmation of duplicates
      const { confirmDuplicates } = ctx.request.body;
      let csvContent;

      if (ctx.request.files && ctx.request.files.file) {
        // Direct file upload
        const file = ctx.request.files.file;
        csvContent = fs.readFileSync(file.path, 'utf8');
      } else if (ctx.request.body.fileId) {
        // File ID provided (legacy support)
        const fileId = ctx.request.body.fileId;
        const uploadedFile = await strapi.plugins.upload.services.upload.findOne(fileId);

        if (!uploadedFile) {
          return ctx.badRequest('File not found');
        }

        const filePath = uploadedFile.url.startsWith('/')
          ? `./public${uploadedFile.url}`
          : uploadedFile.url;

        csvContent = fs.readFileSync(filePath, 'utf8');
      } else if (confirmDuplicates) {
        // Just handling duplicate confirmations, no new file
      } else {
        return ctx.badRequest('No file provided');
      }

      // Get the schema to validate against
      const schema = strapi.contentTypes['api::marketplace.marketplace'].attributes;
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true
      });

      // Validate CSV headers for required fields
      const headers = Object.keys(records[0] || {});
      const missingRequiredFields = REQUIRED_FIELDS.filter(field => !headers.includes(field));

      if (missingRequiredFields.length > 0) {
        return ctx.badRequest(
          `Missing required fields in CSV: ${missingRequiredFields.join(', ')}. ` +
          `Required fields are: ${REQUIRED_FIELDS.join(', ')}`
        );
      }

      // Create entries from CSV data
      const createdEntries = [];
      const errors = [];
      const duplicates = [];
      const confirmedDuplicates = confirmDuplicates || [];

      // Process all records
      for (const [index, record] of records.entries()) {
        try {
          const convertedData = {};
          const rowErrors = [];

          // First, validate required fields
          for (const field of REQUIRED_FIELDS) {
            if (!record[field] && record[field] !== 0) {
              rowErrors.push(`${field} is required`);
              continue;
            }
          }

          // Then validate and convert all fields present in the record
          for (const [field, value] of Object.entries(record)) {
            // Skip empty optional fields
            if (!value && !REQUIRED_FIELDS.includes(field)) {
              continue;
            }

            // Check if field exists in schema
            if (schema[field]) {
              const validation = validateType(value, schema[field].type, field, schema);
              if (!validation.isValid) {
                rowErrors.push(`${field}: ${validation.error}`);
              } else {
                convertedData[field] = validation.value;
              }
            } else {
              console.warn(`Unknown field in CSV: ${field}`);
            }
          }

          // Special handling for JSON fields that might be missing
          if (!convertedData.countries && record.country) {
            // If 'countries' is missing but 'country' is present, use that
            convertedData.countries = [record.country.trim()];
          } else if (!convertedData.countries) {
            // Ensure countries is properly initialized as an empty array, not defaulting to anything
            convertedData.countries = [];
          }

          // Calculate placement speed based on TAT if TAT is provided
          if (convertedData.tat !== undefined) {
            convertedData.placement_speed = this.calculatePlacementSpeed(convertedData.tat);
          }

          if (rowErrors.length > 0) {
            throw new Error(rowErrors.join(', '));
          }

          // Check for duplicate URLs
          if (convertedData.url) {
            convertedData.url = normalizeUrl(convertedData.url);
            const existingEntry = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { url: convertedData.url }
            });

            if (existingEntry) {
              // If we have confirmed duplicates and this URL is in the list, update it
              if (confirmedDuplicates.includes(convertedData.url)) {
                const updatedEntry = await strapi.entityService.update('api::marketplace.marketplace', existingEntry.id, {
                  data: {
                    ...convertedData,
                  }
                });
                createdEntries.push(updatedEntry);
              } else {
                // Otherwise, add to duplicates list for confirmation
                duplicates.push({
                  url: convertedData.url,
                  existingData: existingEntry,
                  newData: convertedData
                });
              }
              continue;
            }
          }

          // Create new entry if no duplicates
          const entry = await strapi.entityService.create('api::marketplace.marketplace', {
            data: {
              ...convertedData,
              publishedAt: new Date()
            },
          });
          createdEntries.push(entry);
        } catch (error) {
          errors.push(`Row ${index + 1}: ${error.message}`);
        }
      }

      // If this is just a confirmation request without a new file upload  
      if (!csvContent && confirmDuplicates && confirmDuplicates.length > 0) {
        // Process already detected duplicates that user has confirmed to update
        // We'll need to fetch them from the database again
        const confirmedEntries = [];

        for (const url of confirmDuplicates) {
          try {
            // Find the existing entry by URL
            const existingEntry = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { url: url }
            });

            if (existingEntry) {
              // We would normally update with data from the CSV, but since we don't have it anymore,
              // just mark it as processed
              confirmedEntries.push(existingEntry);
            }
          } catch (error) {
            console.error(`Error processing confirmed duplicate ${url}:`, error);
          }
        }

        return {
          message: `Successfully processed ${confirmedEntries.length} duplicate entries`,
          confirmedCount: confirmedEntries.length
        };
      }

      // If we have duplicates and no confirmation was provided, return them for user decision
      if (duplicates.length > 0 && !confirmDuplicates) {
        return {
          needsConfirmation: true,
          duplicates,
          createdCount: createdEntries.length,
          errorCount: errors.length,
          errors: errors.length ? errors : undefined
        };
      }

      // Return response with results and any errors
      return {
        message: `Successfully imported ${createdEntries.length} records${errors.length ? ` with ${errors.length} errors` : ''}`,
        created: createdEntries.length,
        entries: createdEntries,
        errors: errors.length ? errors : undefined,
        duplicatesUpdated: confirmDuplicates ? confirmedDuplicates.length : 0
      };
    } catch (error) {
      console.error('CSV Upload Error:', error);
      return ctx.badRequest(error.message);
    }
  },

  /**
   * Update TAT for a specific website based on completed orders
   */
  async updateTAT(ctx) {
    try {
      const user = ctx.state.user;
      const { id } = ctx.params;
      const { minOrderCount, lookbackDays, useWeightedAverage } = ctx.query;

      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // SECURITY (pre-fix): the ownership check only ran for publishers
      // (user.Advertiser === false). Advertisers / plain users skipped the
      // check and proceeded to the TAT update service → write IDOR on any
      // marketplace listing's placement_speed (downstream affects pricing
      // recommendations). Now fail-CLOSED: admin OR matching publisher only.
      const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
      const isPublisher = user.Advertiser === false || user.Publisher === true;
      if (!isAdmin && !isPublisher) {
        return ctx.forbidden('TAT updates require admin or matching-publisher access');
      }
      if (!isAdmin) {
        const website = await strapi.entityService.findOne('api::marketplace.marketplace', id, {
          fields: ['publisher_email'],
          populate: { publisher: { fields: ['id'] } },
        });
        const ownsIt = website && (
          (website.publisher && website.publisher.id === user.id) ||
          (!website.publisher && website.publisher_email === user.email)
        );
        if (!website || !ownsIt) {
          // 404 — defeat enumeration via the differential.
          return ctx.notFound('Marketplace listing not found');
        }
      }

      // Validate website exists
      const website = await strapi.entityService.findOne('api::marketplace.marketplace', id);
      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Prepare options
      const options = {};
      if (minOrderCount) options.minOrderCount = parseInt(minOrderCount);
      if (lookbackDays) options.lookbackDays = parseInt(lookbackDays);
      if (useWeightedAverage !== undefined) options.useWeightedAverage = useWeightedAverage === 'true';

      // Update TAT
      const result = await strapi.service('api::marketplace.marketplace').updateTATFromCompletedOrders(id, options);

      if (!result) {
        return {
          message: 'Insufficient order history to calculate TAT',
          websiteId: id,
          url: website.url
        };
      }

      return {
        message: 'TAT updated successfully',
        websiteId: id,
        url: website.url,
        ...result
      };

    } catch (error) {
      console.error('Error updating TAT:', error);
      return ctx.badRequest('Failed to update TAT');
    }
  },

  /**
   * Get marketplace statistics for advertiser dashboard
   */
  async getStats(ctx) {
    try {
      const user = ctx.state.user;

      // Calculate date 15 days ago
      const fifteenDaysAgo = new Date();
      fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

      // 1. New Sites Count (last 15 days)
      const newSitesCount = await strapi.db.query('api::marketplace.marketplace').count({
        where: {
          createdAt: { $gte: fifteenDaysAgo },
          $or: [
            { status: 'active' },
            { status: { $null: true } },
            { status: '' }
          ]
        }
      });

      // 2. Guest Post Sites (price > 0)
      const gpSitesCount = await strapi.db.query('api::marketplace.marketplace').count({
        where: {
          price: { $gt: 0 },
          $or: [
            { status: 'active' },
            { status: { $null: true } },
            { status: '' }
          ]
        }
      });

      // 3. Link Insertion Sites (link_insertion_price > 0)
      const liSitesCount = await strapi.db.query('api::marketplace.marketplace').count({
        where: {
          link_insertion_price: { $gt: 0 },
          $or: [
            { status: 'active' },
            { status: { $null: true } },
            { status: '' }
          ]
        }
      });

      // 4. High Traffic Sites (ahrefs_traffic > 10000)
      const highTrafficCount = await strapi.db.query('api::marketplace.marketplace').count({
        where: {
          ahrefs_traffic: { $gt: 10000 },
          $or: [
            { status: 'active' },
            { status: { $null: true } },
            { status: '' }
          ]
        }
      });

      // 5. Sensitive Niche Sites (Any sensitive price > 0)
      const sensitiveSitesCount = await strapi.db.query('api::marketplace.marketplace').count({
        where: {
          $or: [
            { adv_casino_pricing: { $gt: 0 } },
            { adv_li_casino_pricing: { $gt: 0 } },
            { adv_crypto_pricing: { $gt: 0 } },
            { adv_li_crypto_pricing: { $gt: 0 } },
            { adv_cbd_pricing: { $gt: 0 } },
            { adv_li_cbd_pricing: { $gt: 0 } },
            { adv_dating_pricing: { $gt: 0 } },
            { adv_li_dating_pricing: { $gt: 0 } }
          ],
          $and: [
            {
              $or: [
                { status: 'active' },
                { status: { $null: true } },
                { status: '' }
              ]
            }
          ]
        }
      });

      return {
        newSites: newSitesCount,
        guestPostSites: gpSitesCount,
        linkInsertionSites: liSitesCount,
        highTrafficSites: highTrafficCount,
        sensitiveSites: sensitiveSitesCount
      };

    } catch (error) {
      console.error('Error fetching marketplace stats:', error);
      return ctx.internalServerError('Failed to fetch marketplace stats');
    }
  },

  /**
   * Bulk update TAT for all websites (admin only)
   */
  async bulkUpdateTAT(ctx) {
    try {
      const user = ctx.state.user;

      // Check authentication and admin privileges
      if (!user || !user.role || user.role.type !== 'admin') {
        return ctx.forbidden('Only administrators can perform bulk TAT updates');
      }

      const {
        batchSize,
        minOrderCount,
        lookbackDays,
        useWeightedAverage,
        delayBetweenBatches
      } = ctx.query;

      // Prepare options
      const options = {};
      if (batchSize) options.batchSize = parseInt(batchSize);
      if (minOrderCount) options.minOrderCount = parseInt(minOrderCount);
      if (lookbackDays) options.lookbackDays = parseInt(lookbackDays);
      if (useWeightedAverage !== undefined) options.useWeightedAverage = useWeightedAverage === 'true';
      if (delayBetweenBatches) options.delayBetweenBatches = parseInt(delayBetweenBatches);

      // Perform bulk update
      const result = await strapi.service('api::marketplace.marketplace').bulkUpdateTAT(options);

      return {
        message: 'Bulk TAT update completed',
        ...result
      };

    } catch (error) {
      console.error('Error in bulk TAT update:', error);
      return ctx.badRequest(error.message);
    }
  },

  /**
   * GET /marketplaces/:id/history
   * Returns the immutable update audit trail for a single marketplace listing.
   * Query params:
   *   - days: filter to entries within the last N days (older rows still
   *           live in the DB, just hidden by this query). Omit for full history.
   *   - field: filter to entries that touched this exact field name.
   *   - page, pageSize: paginate.
   */
  async getUpdateHistory(ctx) {
    try {
      // SECURITY (pre-fix): no auth check, no ownership check. Any
      // authenticated user could read the full audit trail (who/what/when
      // changed) for any marketplace listing. Competitor-reconnaissance
      // vector — reveals admin moderation history, pricing changes, etc.
      // Now: admin OR matching publisher only.
      const user = ctx.state.user;
      if (!user) return ctx.unauthorized('Authentication required');

      const id = parseInt(ctx.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return ctx.badRequest('Invalid marketplace id');
      }

      const isAdmin = user.role && (user.role.type === 'admin' || user.role.type === 'super_admin');
      if (!isAdmin) {
        const listing = await strapi.entityService.findOne('api::marketplace.marketplace', id, {
          fields: ['publisher_email'],
          populate: { publisher: { fields: ['id'] } },
        });
        const ownsIt = listing && (
          (listing.publisher && listing.publisher.id === user.id) ||
          (!listing.publisher && listing.publisher_email === user.email)
        );
        if (!listing || !ownsIt) {
          // 404 — defeat enumeration.
          return ctx.notFound('Marketplace listing not found');
        }
      }

      const page = Math.max(1, parseInt(ctx.query.page, 10) || 1);
      const pageSize = Math.min(
        200,
        Math.max(1, parseInt(ctx.query.pageSize, 10) || 50)
      );
      const days = parseInt(ctx.query.days, 10);
      const field = typeof ctx.query.field === 'string' ? ctx.query.field : null;

      const where = { marketplace: id };
      if (Number.isFinite(days) && days > 0) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        where.changedAt = { $gte: since.toISOString() };
      }
      if (field) {
        // JSON `changedFields` is an array — use $contains for substring match
        // (covers SQLite and Postgres JSON column behavior).
        where.changedFields = { $contains: field };
      }

      const histQuery = strapi.db.query(
        'api::marketplace-update-history.marketplace-update-history'
      );
      const [rows, total] = await Promise.all([
        histQuery.findMany({
          where,
          orderBy: { changedAt: 'desc' },
          offset: (page - 1) * pageSize,
          limit: pageSize,
        }),
        histQuery.count({ where }),
      ]);

      return {
        data: rows,
        meta: {
          pagination: {
            page,
            pageSize,
            total,
            pageCount: Math.ceil(total / pageSize),
          },
          filters: {
            days: Number.isFinite(days) && days > 0 ? days : null,
            field: field || null,
          },
        },
      };
    } catch (error) {
      console.error('[marketplace.getUpdateHistory]', error);
      return ctx.internalServerError('Failed to fetch update history');
    }
  },
}));
