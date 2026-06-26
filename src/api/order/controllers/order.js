'use strict';

/**
 * order controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

// Audit M2 fix — fail-closed allowlist for the `...orderData` remainder of
// the create() body destructure. The destructure explicitly pulls out
// content/links/anchorText/etc., but everything else previously landed in
// `orderData` and was spread into entityService.create — letting an
// advertiser stamp lifecycle dates, cancellation metadata, admin-on-behalf
// fields (createdByAdminId/adminReason/userConsent*), pre-stamped delivery
// fields, etc. This allowlist is the set of fields an advertiser may
// legitimately supply at create time. Everything else is server-derived
// (escrowHeld, orderStatus, orderDate, advertiser, publisher, all websiteXxx
// snapshot fields) or admin-only and must be ignored when present in the
// body. Drop with a warn-level log so we can spot tampering attempts.
const ALLOWED_ORDER_CREATE_FIELDS = new Set([
  'totalAmount',
  'description',
  'website',
  'specialCategory',
]);

// ─────────────────────────────────────────────────────────────────────────
// Order/marketplace privacy boundary.
//
// `getMyOrders` previously populated `website: true` which returned the
// ENTIRE marketplace row — including publisher_email, publisher_name, the
// publisher_*_pricing intake-price fields, gsc_refresh_token, gsc_permission_
// level, and internal admin/operational state (approvalStatus, blacklist_
// status, dataVersion, bulkRefreshSkipTools, last*RefreshAt/last*ExportAt).
// The marketplace content-type's `privateAttributes` config is bypassed
// when the entity is loaded as a populated relation through
// strapi.entityService.findMany.
//
// Allow-list (not deny-list) by design: new fields added to the marketplace
// schema are NOT exposed automatically — they must be explicitly added here
// before they appear in API responses. Guarantees gsc_refresh_token (and
// any future private field) can never leak via this endpoint.
// ─────────────────────────────────────────────────────────────────────────
const WEBSITE_PUBLIC_FIELDS = [
  // Identity
  'id', 'documentId', 'url',
  // Pricing (the advertiser-facing values — NOT publisher intake/forbidden)
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
  'website_status',
  // Timestamps. `publishedAt` is omitted — marketplace schema has
  // draftAndPublish: false, so the attribute doesn't exist; including
  // it would surface as `ValidationError: Invalid key publishedAt`.
  'createdAt', 'updatedAt',
];

// Snapshot fields captured on the order row at create-time. These mirror
// the publisher's data and are stripped when the caller is NOT the
// publisher of the order. Defense-in-depth in case the marketplace listing
// is later deleted/edited — the snapshot is the only record left.
const ORDER_SNAPSHOT_PUBLISHER_PRIVATE = [
  'websitePublisherEmail',
  'websitePublisherName',
  'websitePublisherPrice',
];

// Order scalar fields the user-facing UI consumes. Verified by grepping
// every `order.<field>` reference across serpbays_client (2026-06-25).
// EXCLUDED from this list — and therefore never returned by user-facing
// list endpoints (find / findOne / getMyOrders / getAvailableOrders):
//   - websitePublisherEmail / websitePublisherName     → publisher PII (typed but never rendered)
//   - websitePublisherPrice                            → publisher intake price (business sensitive)
//   - websiteSnapshot                                  → opaque JSON of marketplace row at order-time
//   - metadata                                         → opaque JSON; gateway/internal use
//   - websitePrice / websiteLinkInsertionPrice         → use totalAmount instead
//   - websiteCategory / websiteLanguage / websiteCountries → JSON blobs, never rendered
//   - websiteBacklinkType / websiteBacklinkValidity / websiteMinWordCount / websiteGuidelines
//   - websiteDofollowLink / websiteFastPlacement
//   - websiteAhrefsDr / websiteAhrefsTraffic / websiteMozDa → exposed via website populate instead
//   - linkInsertionLanguage                            → never rendered
//   - createdByAdminId / adminReason                   → admin-only audit fields
//   - userConsentType / userConsentReference           → audit fields, not user-facing
//   - warningNotificationSentAt / cancellationNotes    → admin-only
//   - disputeDate                                      → not rendered (disputes use a separate flow)
// The 3 PII snapshot fields are also fetched into the DB row for the
// legacy snapshot-publisher auth fallback in `isCallerPublisherOfOrder`,
// then stripped from the response before send.
const ORDER_PUBLIC_FIELDS = [
  'id', 'documentId',
  'orderStatus', 'revisionStatus', 'revisionRequestedAt', 'revisionDeadline',
  'orderDate', 'acceptedDate', 'deliveredDate', 'completedDate', 'rejectedDate',
  'cancelledAt', 'cancelledBy', 'cancellationReason', 'rejectionReason',
  'totalAmount', 'escrowHeld',
  'description', 'deliveryProof', 'deliveryMessage',
  'serviceType', 'specialCategory', 'isOutsourced',
  'anchorText', 'landingPageUrl', 'existingPostUrl', 'linkInsertionDescription',
  'websiteUrl', 'websiteTat',
  // publishedAt removed 2026-06-25 — order schema has draftAndPublish:
  // false, so this field doesn't exist on the entity. Same risk class
  // as `balanceAfter` on the transaction allow-list: Strapi 5 throws
  // ValidationError on unknown query keys.
  'createdAt', 'updatedAt',
];

// What the DB layer fetches — public fields plus the 3 snapshot fields
// the auth-fallback code still needs to read. `stripOrderForResponse()`
// removes the snapshot fields before send so they never reach the wire.
const ORDER_FETCH_FIELDS = [...ORDER_PUBLIC_FIELDS, ...ORDER_SNAPSHOT_PUBLISHER_PRIVATE];

// Nested populate allow-list. Mirrors the order's own field discipline.
// Every relation here is `fields: [...]` not `: true`, so a future schema
// addition (a new PII column on orderContent/project/etc.) doesn't
// silently auto-leak into the response.
const ORDER_LIST_POPULATE = {
  website:           { fields: WEBSITE_PUBLIC_FIELDS },
  // Client reads only `.id` from `order.advertiser` / `order.publisher`
  // (verified by grepping `.advertiser.X` / `.publisher.X` across the
  // client repo, 2026-06-25). Dropping `username` to honor the user's
  // "publisher username is PII" rule — re-add it only if a future UI
  // surface legitimately needs to display the counterparty's handle.
  advertiser:        { fields: ['id'] },
  publisher:         { fields: ['id'] },
  orderContent:      { fields: ['id', 'content', 'title', 'url', 'metaDescription', 'keywords', 'anchorText', 'links', 'minWordCount'] },
  outsourcedContent: { fields: ['id', 'links', 'instructions'] },
  project:           { fields: ['id', 'documentId', 'ProjectName', 'projectUrl', 'startDate', 'archived', 'status'] },
  communications:    { fields: ['id', 'message', 'communicationStatus', 'isUnread', 'createdAt'] },
};

// Strip the snapshot publisher fields from a response row regardless of
// the caller's role. The 3 fields are needed inside the controller for
// the legacy auth fallback, but the UI never renders them — so they
// never leave the server. Replaces the prior per-row `if (!isCallerPublisher)`
// strip which kept the fields visible to the publisher themselves.
function stripOrderForResponse(row) {
  if (!row) return row;
  for (const k of ORDER_SNAPSHOT_PUBLISHER_PRIVATE) {
    if (k in row) delete row[k];
  }
  return row;
}

// Defense-in-depth response shaper. Many state-transition handlers
// (create / accept / reject / deliver / complete / *-revision / cancel)
// build their response by re-fetching the order with `populate:
// ['website', 'advertiser', 'publisher', ...]` (broad form, no field
// allow-list). That returns the FULL marketplace row — including the
// denormalized `publisher_email` / `publisher_name` / `publisher_*`
// intake-pricing columns — plus full user records for advertiser /
// publisher. Rather than refactor every handler, we run every order
// response through this shaper, which:
//   1. Strips the 3 snapshot fields from the order itself
//   2. If `order.website` is populated, replaces it with a whitelisted
//      subset (intersection of WEBSITE_PUBLIC_FIELDS) — drops
//      publisher_email, publisher_name, every publisher_*_pricing,
//      gsc_refresh_token, etc.
//   3. If `order.advertiser` / `order.publisher` is populated, replaces
//      with `{ id }` — drops email, username, phone, password hash, etc.
// This is a belt-and-braces layer on top of the read-endpoint allow-lists
// (find / findOne / getMyOrders / getAvailableOrders); it catches any
// future handler that forgets to allow-list.
const WEBSITE_PUBLIC_FIELD_SET = new Set(WEBSITE_PUBLIC_FIELDS);
function sanitizeOrderResponse(order) {
  if (!order || typeof order !== 'object') return order;
  stripOrderForResponse(order);
  if (order.website && typeof order.website === 'object') {
    for (const k of Object.keys(order.website)) {
      if (!WEBSITE_PUBLIC_FIELD_SET.has(k)) delete order.website[k];
    }
  }
  if (order.advertiser && typeof order.advertiser === 'object') {
    order.advertiser = { id: order.advertiser.id };
  }
  if (order.publisher && typeof order.publisher === 'object') {
    order.publisher = { id: order.publisher.id };
  }
  return order;
}

// Return true if the caller is the publisher of this specific order. Used
// to gate visibility of snapshot publisher fields and (in the future) the
// publisher_* intake-price fields if we ever want to re-expose them on a
// publisher's own listings.
function isCallerPublisherOfOrder(order, user) {
  if (!user || !order) return false;
  const publisherIdOnOrder = order.publisher && order.publisher.id;
  if (publisherIdOnOrder && publisherIdOnOrder === user.id) return true;
  // Legacy path — orders pre-dating the publisher FK still match on
  // the snapshotted email.
  if (!publisherIdOnOrder && order.websitePublisherEmail && user.email
      && order.websitePublisherEmail === user.email) {
    return true;
  }
  return false;
}

// Helper function to check if publisher wallet exists
async function checkPublisherWallet(userId) {
  try {
    // Check if publisher wallet exists
    const publisherWallet = await strapi.db.query('api::user-wallet.user-wallet').findOne({
      where: {
        users_permissions_user: userId,
        type: 'publisher'
      }
    });

    return publisherWallet !== null;
  } catch (error) {
    console.error('Error checking publisher wallet:', error);
    return false;
  }
}

module.exports = createCoreController('api::order.order', ({ strapi }) => {
  // Helper function to format links for storage
  const formatLinks = (links) => {
    // If links is already a JSON string, leave it as is
    if (typeof links === 'string') {
      try {
        // Check if it's valid JSON
        const parsed = JSON.parse(links);
        return links; // It's already a JSON string
      } catch (e) {
        // It's a single link, convert to JSON string array
        return JSON.stringify([links]);
      }
    }

    // If links is an array, stringify it
    if (Array.isArray(links)) {
      return JSON.stringify(links);
    }

    // If links is some other type, convert to empty array
    return JSON.stringify([]);
  };

  // ===== Default core-router overrides — CRITICAL gating ============
  //
  // routes/order.js declares createCoreRouter('api::order.order', ...),
  // which registers GET /api/orders, GET /api/orders/:id, PUT /api/orders/:id,
  // and DELETE /api/orders/:id. The `Authenticated` role has find / findOne /
  // update / delete grants on this content type. Without overrides in the
  // controller, the default Strapi core controllers would be used — they
  // apply NO row-level ownership filter, so any logged-in user could:
  //   - GET /api/orders → list every order on the platform
  //   - GET /api/orders/:N → read any order
  //   - PUT /api/orders/:N → mutate ANY field on any order (orderStatus,
  //     escrowHeld, websitePublisherPrice snapshot, etc.) — direct wallet /
  //     payout manipulation
  //   - DELETE /api/orders/:N → delete any order
  //
  // The handlers below replace those defaults with explicit gating:
  //   - find / findOne use the same allow-list / snapshot-strip / IDOR
  //     filter as getMyOrders (which is the supported listing endpoint).
  //   - update is forbidden via the default route — every legitimate state
  //     transition has its own scoped endpoint (POST /orders/:id/accept,
  //     /reject, /deliver, /complete, /dispute, /cancel, /finalize,
  //     /request-revision, /start-revision, /complete-revision). Force
  //     callers through those gates.
  //   - delete is forbidden outright; an order is a financial audit record.
  function buildOrderOwnershipFilter(user) {
    if (!user || typeof user.id !== 'number') return null;
    const clauses = [
      { advertiser: user.id },
      { publisher: user.id },
    ];
    if (user.email) clauses.push({ websitePublisherEmail: user.email });
    return { $or: clauses };
  }

  return {
    async find(ctx) {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to list orders');
      }
      const ownership = buildOrderOwnershipFilter(ctx.state.user);
      if (!ownership) return ctx.unauthorized();
      const userFilters = ctx.query?.filters;
      ctx.query = {
        ...ctx.query,
        filters: userFilters ? { $and: [userFilters, ownership] } : ownership,
        fields: ORDER_FETCH_FIELDS,
        populate: ORDER_LIST_POPULATE,
      };
      const ps = Number.parseInt(ctx.query?.pagination?.pageSize, 10);
      if (Number.isFinite(ps) && ps > 100) {
        ctx.query.pagination = { ...ctx.query.pagination, pageSize: 100 };
      }
      const result = await super.find(ctx);
      const rows = result?.data;
      if (Array.isArray(rows)) {
        for (const row of rows) sanitizeOrderResponse(row?.attributes || row);
      }
      return result;
    },

    async findOne(ctx) {
      if (!ctx.state.user) {
        return ctx.unauthorized('You must be logged in to view this order');
      }
      const { id } = ctx.params;
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Order not found');
      }
      // Every key below must exist as an actual attribute on the order
       // content type (src/api/order/content-types/order/schema.json).
       // Strapi 5's query-fields validator rejects unknown keys with
       // `ValidationError: Invalid key <name>` — Strapi 4 silently
       // ignored them. Bogus keys observed and removed (2026-06-25):
       //   placementSpeed — lives on marketplace (placement_speed),
       //                    already returned via the website populate
       //   assignedDate   — the actual attribute is `acceptedDate`
       //   totalPrice     — the actual attribute is `totalAmount`
       //   platformFee    — not on schema at all (derived value; if the
       //                    UI ever needs it, compute it in a response
       //                    shaper, don't request it from the DB)
      const order = await strapi.entityService.findOne('api::order.order', numericId, {
        fields: ORDER_FETCH_FIELDS,
        populate: ORDER_LIST_POPULATE,
      });
      if (!order) return ctx.notFound('Order not found');
      const isAdvertiser = order.advertiser?.id === ctx.state.user.id;
      const isPublisherFK = order.publisher?.id === ctx.state.user.id;
      const isSnapshotPublisher = !order.publisher?.id
        && order.websitePublisherEmail
        && ctx.state.user.email
        && order.websitePublisherEmail === ctx.state.user.email;
      if (!isAdvertiser && !isPublisherFK && !isSnapshotPublisher) {
        // 404 not 403 — defeat order-id enumeration.
        return ctx.notFound('Order not found');
      }
      // Always sanitize before responding. The snapshot publisher fields
      // are fetched only for the legacy auth fallback above; populated
      // relations are clipped to their public allow-list as defense-in-depth.
      return { data: sanitizeOrderResponse({ ...order }) };
    },

    async update(ctx) {
      // Every legitimate state transition has its own scoped endpoint
      // (accept / reject / deliver / complete / dispute / cancel /
      // finalize / *-revision). The default PUT /api/orders/:id route
      // would let a caller stamp ANY field (orderStatus → completed
      // triggers wallet release; escrowHeld; websitePublisherPrice
      // snapshot → publisher payout; ...). Disable it.
      return ctx.forbidden(
        'Direct order updates are not allowed. Use the specific action endpoints (accept, deliver, complete, cancel, etc.).'
      );
    },

    async delete(ctx) {
      // Orders are a financial / audit record. They are never deleted
      // by users; cancellation is a state transition handled via
      // POST /orders/:id/cancel.
      return ctx.forbidden('Orders cannot be deleted; use /orders/:id/cancel');
    },

    // Custom create method to handle order creation with content
    async create(ctx) {
      try {
        // Check if user is authenticated
        if (!ctx.state.user) {
          return ctx.unauthorized('You must be logged in to create an order');
        }

        // Get authenticated user
        const user = ctx.state.user;

        // Extract order data and content data from request body
        const {
          content,
          links,
          anchorText,
          metaDescription,
          keywords,
          url,
          title,
          instructions,
          projectName,
          projectUrl,
          projectId,
          outsourceLinks,
          // Link Insertion specific fields
          serviceType,
          existingPostUrl,
          anchorText: linkInsertionAnchorText,
          landingPageUrl,
          linkInsertionLanguage,
          linkInsertionDescription,
          ...orderData
        } = ctx.request.body.data || ctx.request.body;

        // Audit M2 fix — fail-closed allowlist on the leftover orderData.
        // Strip anything the advertiser must not be able to set themselves
        // (lifecycle dates, cancellation metadata, admin-on-behalf fields,
        // delivery pre-stamps, audit timestamps, etc.). Server-derived
        // fields (escrowHeld, orderStatus, orderDate, advertiser, publisher,
        // websiteXxx snapshot fields) are written explicitly below — those
        // get the canonical values regardless. Log dropped keys so attempted
        // tampering shows up in ops logs.
        const droppedOrderKeys = [];
        for (const k of Object.keys(orderData)) {
          if (!ALLOWED_ORDER_CREATE_FIELDS.has(k)) {
            droppedOrderKeys.push(k);
            delete orderData[k];
          }
        }
        if (droppedOrderKeys.length > 0) {
          strapi.log.warn(`[order.create] User ${user.id} (${user.email}) tried to set restricted fields on order create, dropped: ${droppedOrderKeys.join(', ')}`);
        }

        console.log("projectId", projectId)
        console.log(projectName)
        // If projectId is provided, verify it exists and belongs to the user
        if (projectId) {
          const project = await strapi.db.query('api::project.project').findOne({
            where: {
              id: projectId,
              owner: user.id
            }
          });

          if (!project) {
            return ctx.badRequest(`Project with ID ${projectId} not found or does not belong to you`);
          }

          // Check if project is archived
          if (project.archived) {
            return ctx.badRequest(`Cannot create orders in archived project "${project.ProjectName}". Please unarchive the project first or create a new project.`);
          }

          // Add project to orderData
          orderData.project = projectId;
        }
        // If projectName is provided but no projectId, create a new project
        else if (projectName) {
          // Resolve a string projectUrl. Prefer the explicit value from the
          // request; otherwise fall back to the marketplace website URL when
          // `orderData.website` is a domain string (it may still be a numeric
          // ID at this point — that case is handled by the explicit field).
          let resolvedProjectUrl = typeof projectUrl === 'string' ? projectUrl.trim() : '';
          if (!resolvedProjectUrl && typeof orderData.website === 'string' && !/^\d+$/.test(orderData.website)) {
            resolvedProjectUrl = orderData.website;
          }
          if (!resolvedProjectUrl && (typeof orderData.website === 'number' || /^\d+$/.test(String(orderData.website)))) {
            const websiteId = parseInt(orderData.website, 10);
            const mp = await strapi.db.query('api::marketplace.marketplace').findOne({ where: { id: websiteId } });
            if (mp?.url) resolvedProjectUrl = mp.url;
          }
          if (!resolvedProjectUrl) {
            return ctx.badRequest('projectUrl is required when creating a new project');
          }

          const newProject = await strapi.entityService.create('api::project.project', {
            data: {
              ProjectName: projectName,
              startDate: new Date(),
              owner: user.id,
              projectUrl: resolvedProjectUrl
            }
          });

          // Add the new project to orderData
          orderData.project = newProject.id;
        }

        console.log("orderdata", orderData);
        console.log('Creating order with data:1', orderData);

        // Check if this is an outsourced content order
        const isOutsourced = !!instructions;

        // Validate required fields
        if (!orderData.totalAmount || !orderData.description || !orderData.website) {
          return ctx.badRequest('Missing required fields: totalAmount, description and website are required');
        }

        console.log(typeof orderData.website)

        // Variables to store marketplace data and snapshot
        let marketplace = null;
        let websiteSnapshot = null;

        // If website is passed as a string ID, convert it to the proper format
        // Use strict numeric check - parseInt('100test.com') returns 100 which would incorrectly match domains starting with numbers
        if (typeof orderData.website === 'string' && /^\d+$/.test(orderData.website)) {
          console.log(`Website appears to be a string ID: ${orderData.website}, looking up by ID`);
          // Try to find the website by ID
          const websiteId = parseInt(orderData.website);
          marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: websiteId },
            populate: ['publisher']
          });

          if (!marketplace) {
            return ctx.badRequest(`Website with ID ${websiteId} not found in marketplace`);
          }

          console.log(`Found website ID ${marketplace.id} for domain ${marketplace.url}`);
          orderData.website = marketplace.id;
        }
        // If it's a domain name (preferred approach), try to find the corresponding marketplace entry
        else if (typeof orderData.website === 'string') {
          console.log(`Looking up website by domain: ${orderData.website}`);
          marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { url: orderData.website },
            populate: ['publisher']
          });
          console.log("market", marketplace)
          if (!marketplace) {
            return ctx.badRequest(`Website with domain ${orderData.website} not found in marketplace`);
          }

          console.log(`Found website ID ${marketplace.id} for domain ${orderData.website}`);
          orderData.website = marketplace.id;
        }
        // If website is already a number, verify it exists in marketplace
        else if (typeof orderData.website === 'number') {
          console.log(`Verifying website ID: ${orderData.website}`);
          marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
            where: { id: orderData.website },
            populate: ['publisher']
          });

          if (!marketplace) {
            return ctx.badRequest(`Website with ID ${orderData.website} not found in marketplace`);
          }

          console.log(`Verified website ID ${orderData.website} exists`);
        }

        // CRITICAL: Prevent users from ordering their own websites
        // Check if the user is trying to order their own website
        // Check 1: Direct ID match if publisher relation exists
        if (marketplace && marketplace.publisher && marketplace.publisher.id === user.id) {
          console.log(`🚫 Self-order prevented: User ${user.id} tried to order their own website ${marketplace.url} (ID match)`);
          return ctx.badRequest('You cannot place an order on your own website. Please select a different website.');
        }
        // Check 2: Email fallback
        else if (marketplace && (
          (marketplace.publisher && marketplace.publisher.email === user.email) ||
          marketplace.publisher_email === user.email
        )) {
          console.log(`🚫 Self-order prevented: User ${user.email} tried to order their own website ${marketplace.url} (Email match)`);
          return ctx.badRequest('You cannot place an order on your own website. Please select a different website.');
        }

        // Validate existingPostUrl belongs to the same domain (Link Insertion orders)
        if (serviceType === 'link_insertion' && existingPostUrl && marketplace) {
          try {
            const urlToCheck = existingPostUrl.trim().startsWith('http://') || existingPostUrl.trim().startsWith('https://')
              ? existingPostUrl.trim()
              : `https://${existingPostUrl.trim()}`;
            const urlObj = new URL(urlToCheck);
            const urlHostname = urlObj.hostname.replace(/^www\./, '');
            const expectedDomain = marketplace.url.replace(/^www\./, '').replace(/^https?:\/\//, '');
            if (urlHostname !== expectedDomain && !urlHostname.endsWith('.' + expectedDomain)) {
              return ctx.badRequest(`Existing post URL must be from ${marketplace.url}, not ${urlHostname}`);
            }
          } catch (e) {
            return ctx.badRequest('Invalid existing post URL format');
          }
        }

        // Create marketplace snapshot to preserve historical data
        if (marketplace) {
          console.log('Creating marketplace snapshot for order');
          websiteSnapshot = {
            id: marketplace.id,
            url: marketplace.url,
            price: marketplace.price,
            link_insertion_price: marketplace.link_insertion_price,
            min_word_count: marketplace.min_word_count,
            guidelines: marketplace.guidelines,
            backlink_type: marketplace.backlink_type,
            backlink_validity: marketplace.backlink_validity,
            category: marketplace.category,
            other_category: marketplace.other_category,
            publisher_name: marketplace.publisher?.username || marketplace.publisher_name,
            publisher_email: marketplace.publisher?.email || marketplace.publisher_email,
            publisher_price: marketplace.publisher_price,
            tat: marketplace.tat,
            dofollow_link: marketplace.dofollow_link,
            fast_placement_status: marketplace.fast_placement_status,
            ahrefs_dr: marketplace.ahrefs_dr,
            ahrefs_traffic: marketplace.ahrefs_traffic,
            ahrefs_rank: marketplace.ahrefs_rank,
            moz_da: marketplace.moz_da,
            language: marketplace.language,
            countries: marketplace.countries,
            forbidden_gp_price: marketplace.forbidden_gp_price,
            forbidden_li_price: marketplace.forbidden_li_price,
            publisher_forbidden_gp_price: marketplace.publisher_forbidden_gp_price,
            publisher_forbidden_li_price: marketplace.publisher_forbidden_li_price,
            publisher_link_insertion_price: marketplace.publisher_link_insertion_price,
            semrush_authority_score: marketplace.semrush_authority_score,
            semrush_traffic: marketplace.semrush_traffic,
            spam_score: marketplace.spam_score,
            adv_crypto_pricing: marketplace.adv_crypto_pricing,
            adv_casino_pricing: marketplace.adv_casino_pricing,
            adv_cbd_pricing: marketplace.adv_cbd_pricing,
            publisher_crypto_pricing: marketplace.publisher_crypto_pricing,
            publisher_casino_pricing: marketplace.publisher_casino_pricing,
            publisher_cbd_pricing: marketplace.publisher_cbd_pricing,
            similarweb_traffic: marketplace.similarweb_traffic,
            ahrefs_referring_domain: marketplace.ahrefs_referring_domain,
            domain_zone: marketplace.domain_zone,
            only_with_us: marketplace.only_with_us,
            blacklist_status: marketplace.blacklist_status,
            sample_post: marketplace.sample_post,
            capturedAt: new Date().toISOString()
          };

          // Add snapshot fields to order data
          orderData.websiteSnapshot = websiteSnapshot;
          orderData.websiteUrl = marketplace.url;
          orderData.websitePrice = marketplace.price;
          orderData.websiteLinkInsertionPrice = marketplace.link_insertion_price;
          orderData.websiteMinWordCount = marketplace.min_word_count;
          orderData.websiteGuidelines = marketplace.guidelines;
          orderData.websiteBacklinkType = marketplace.backlink_type;
          orderData.websiteBacklinkValidity = marketplace.backlink_validity;
          orderData.websiteCategory = marketplace.category;
          orderData.websitePublisherName = marketplace.publisher?.username || marketplace.publisher_name;
          orderData.websitePublisherEmail = marketplace.publisher?.email || marketplace.publisher_email;
          orderData.websitePublisherPrice = marketplace.publisher_price;
          orderData.websiteTat = marketplace.tat * 24; // Convert days to hours for frontend calculation
          orderData.websiteDofollowLink = marketplace.dofollow_link;
          orderData.websiteFastPlacement = marketplace.fast_placement_status;
          orderData.websiteAhrefsDr = marketplace.ahrefs_dr;
          orderData.websiteAhrefsTraffic = marketplace.ahrefs_traffic;
          orderData.websiteMozDa = marketplace.moz_da;
          orderData.websiteLanguage = marketplace.language;
          orderData.websiteCountries = marketplace.countries;

          console.log('Marketplace snapshot created and added to order data');
        }

        // Remove links from orderData if present to prevent conflicts
        if (orderData.links) {
          delete orderData.links;
        }

        // Check for duplicate recent orders to prevent duplicates
        const recentOrders = await strapi.db.query('api::order.order').findMany({
          where: {
            website: orderData.website,
            advertiser: user.id,
            // Only match orders with the exact same description, which indicates a duplicate
            description: orderData.description,
            // Check orders created in the last 5 minutes
            createdAt: {
              $gt: new Date(Date.now() - 1000)
            }
          },
          limit: 1
        });

        if (recentOrders && recentOrders.length > 0) {
          console.log('Potential duplicate order detected, returning existing order');
          // Return the existing order instead of creating a duplicate
          const existingOrder = await strapi.entityService.findOne('api::order.order', recentOrders[0].id, {
            fields: ORDER_FETCH_FIELDS,
            populate: ORDER_LIST_POPULATE,
          });

          return {
            data: sanitizeOrderResponse(existingOrder),
            meta: {
              message: 'Order already exists'
            }
          };
        }

        // Create the order
        // First prepare order data with proper fields

        // Source-of-truth for publisher routing: the publisher-website
        // record currently in `submissionStatus: 'approved'` for this
        // URL. This stays correct even if the marketplace listing's
        // publisher field has gone stale (e.g. ownership transferred
        // before the marketplace pointer caught up).
        let publisherId = null;
        let activePublisherUser = null;
        if (marketplace?.url) {
          try {
            const activeWebsite = await strapi.db
              .query('api::publisher-website.publisher-website')
              .findOne({
                where: {
                  url: marketplace.url,
                  submissionStatus: 'approved'
                },
                populate: ['currentPublisherId']
              });
            const owner = activeWebsite?.currentPublisherId;
            if (owner?.id) {
              publisherId = owner.id;
              activePublisherUser = owner;
            }
          } catch (resolveErr) {
            console.warn(
              '[Order Create] Failed to resolve active publisher-website:',
              resolveErr?.message
            );
          }
        }

        // Fallback chain: marketplace.publisher → marketplace.publisher_email
        if (!publisherId) {
          if (marketplace && marketplace.publisher && marketplace.publisher.id) {
            publisherId = marketplace.publisher.id;
          } else if (marketplace && marketplace.publisher_email) {
            const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
              where: { email: marketplace.publisher_email }
            });
            if (publisherUser) {
              publisherId = publisherUser.id;
            }
          }
        }

        // If we resolved an active publisher whose email differs from
        // the snapshot we already wrote into orderData earlier, fix
        // the snapshot so directly-assigned-by-snapshot queries route
        // future displays to the right inbox.
        if (
          activePublisherUser?.email &&
          orderData.websitePublisherEmail !== activePublisherUser.email
        ) {
          orderData.websitePublisherEmail = activePublisherUser.email;
          orderData.websitePublisherName =
            activePublisherUser.username || activePublisherUser.email;
        }

        const orderToCreate = {
          ...orderData,
          advertiser: user.id,
          // Assign publisher found via ID or email lookup
          publisher: publisherId,
          orderDate: new Date(),
          isOutsourced: isOutsourced,
          instructions: instructions || null,
          // Add Link Insertion fields if this is a Link Insertion order
          serviceType: serviceType || null,
          existingPostUrl: existingPostUrl || null,
          anchorText: typeof linkInsertionAnchorText === 'string' ? linkInsertionAnchorText : null,
          landingPageUrl: landingPageUrl || null,
          linkInsertionLanguage: linkInsertionLanguage || null,
          linkInsertionDescription: linkInsertionDescription || null
        };

        console.log('Creating order with data:', orderToCreate);
        const order = await strapi.service('api::order.order').create(orderToCreate, user);
        console.log('Order created:', order);

        if (!order || !order.documentId) {
          throw new Error('Failed to create order');
        }

        console.log("orders", order)

        // Get the website/marketplace info to find the publisher (reuse existing marketplace data)
        let marketplaceWithPublisher = marketplace;
        // Marketplace doesn't have a direct publisher relation, so we use the email link we just established

        // Create notification for publisher about new order
        if (publisherId) {
          try {
            await strapi.service('api::notification.notification').createOrderNotification(
              order.id,
              publisherId,
              user.id,
              'new_order'
            );
            console.log(`New order notification created for publisher ${publisherId}`);
          } catch (notificationError) {
            console.error('Failed to create new order notification:', notificationError);
            // Don't fail the order creation if notification fails
          }
        } else {
          console.log('No publisher user found for marketplace email, skipping new order notification');
        }

        // Handle outsourced content details if this is an outsourced order
        if (isOutsourced) {
          try {
            console.log('Creating outsourced content details');
            // Create outsourced content details
            const outsourcedContentData = {
              links: outsourceLinks || links || [],
              instructions: instructions || '',
              order: order.documentId,
              publishedAt: new Date()
            };

            // Format links properly
            if (typeof outsourcedContentData.links !== 'string' && !Array.isArray(outsourcedContentData.links)) {
              outsourcedContentData.links = [];
            }
            if (Array.isArray(outsourcedContentData.links)) {
              outsourcedContentData.links = JSON.stringify(outsourcedContentData.links);
            }

            console.log('Outsourced content data:', outsourcedContentData);

            // Create the outsourced content
            const outsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
              data: outsourcedContentData
            });

            console.log('Outsourced content created:', outsourcedContent);
          } catch (error) {
            console.error('Error creating outsourced content details:', error);
            // Continue even if this fails - we don't want to roll back the order
          }
        }

        // Define default title for content
        const defaultTitle = `Order for ${orderData.description}`;

        // Only create content object for non-outsourced orders and non-Link Insertion orders
        if (!isOutsourced && serviceType !== 'link_insertion') {
          try {
            // Process order content if needed
            let contentData = {
              // Default required fields
              content: orderData.description || '',
              title: defaultTitle,
              // Use website's min word count or default to 0
              minWordCount: orderData.websiteMinWordCount || orderData.minWordCount || 0,
              // Important: establish the relationship with the order
              order: order.documentId
            };

            // If HTML content was provided
            if (content) {
              // If content is a string, treat it as content field
              if (typeof content === 'string') {
                contentData.content = content;
              }
              // If content is an object, merge its properties
              else if (typeof content === 'object') {
                contentData = {
                  ...contentData,
                  ...content,
                  // Ensure the order relation is preserved
                  order: order.documentId
                };
              }
            }

            // Explicitly add each metadata field if they were provided in the request

            // Add links if they were provided - ensure it's stored as JSON
            if (links && (Array.isArray(links) || typeof links === 'string')) {
              // Use our formatLinks helper to ensure proper JSON storage
              contentData.links = formatLinks(links);
              console.log('Adding links to order content:', contentData.links);
            } else if (ctx.request.body.links) {
              // Try to get links directly from the request body
              contentData.links = formatLinks(ctx.request.body.links);
              console.log('Adding links from request body:', contentData.links);
            }

            // Add anchorText if provided - ensure it's stored as JSON
            if (anchorText && (Array.isArray(anchorText) || typeof anchorText === 'string')) {
              // Format anchor text similar to links
              contentData.anchorText = formatLinks(anchorText);
              console.log('Adding anchor text to order content:', contentData.anchorText);
            } else if (ctx.request.body.anchorText) {
              // Try to get anchorText directly from the request body
              contentData.anchorText = formatLinks(ctx.request.body.anchorText);
              console.log('Adding anchor text from request body:', contentData.anchorText);
            }

            // Add metaDescription if provided in the request
            if (metaDescription) {
              contentData.metaDescription = metaDescription;
            }

            // Add keywords if provided in the request
            if (keywords) {
              contentData.keywords = keywords;
            }

            // Add URL if provided in the request
            if (url) {
              contentData.url = url;
            }
            // If URL isn't provided but website is, try to use website URL from snapshot
            else if (!contentData.url && orderData.website) {
              try {
                // Use URL from marketplace snapshot if available
                if (marketplace && marketplace.url) {
                  contentData.url = marketplace.url;
                } else {
                  // Fallback: fetch the website URL 
                  const websiteInfo = await strapi.db.query('api::marketplace.marketplace').findOne({
                    where: { id: orderData.website }
                  });

                  if (websiteInfo && websiteInfo.url) {
                    contentData.url = websiteInfo.url;
                  }
                }
              } catch (err) {
                console.log('Error fetching website URL:', err);
                // Continue even if this fails
              }
            }

            // Add title if provided in the request
            if (title) {
              contentData.title = title;
            }

            console.log('Creating order content with data:', contentData);

            // Create the order content
            const newOrderContent = await strapi.entityService.create('api::order-content.order-content', {
              data: contentData
            });

            console.log('Order content created:', newOrderContent);

            // Update the order to ensure the relation is bidirectional
            await strapi.entityService.update('api::order.order', order.id, {
              data: {
                orderContent: newOrderContent.id
              }
            });

          } catch (contentError) {
            console.error('Error creating order content:', contentError);
            // We don't want to fail the whole operation if just the content creation fails
          }
        }

        // Return the created order with allow-listed relations.
        // The advertiser MUST NOT see publisher PII from the marketplace
        // (`publisher_email`, `publisher_name`, publisher intake pricing) —
        // those are the columns on the marketplace row that a broad
        // `populate: ['website']` would return. ORDER_LIST_POPULATE caps
        // the website populate at WEBSITE_PUBLIC_FIELDS, and the
        // sanitizeOrderResponse() pass below strips any populated
        // user/marketplace fields beyond the allow-list.
        const populatedOrder = await strapi.entityService.findOne('api::order.order', order.id, {
          fields: ORDER_FETCH_FIELDS,
          populate: ORDER_LIST_POPULATE,
        });

        // Create notification for publisher (website owner) using snapshot data
        // NOTE: We already sent the internal notification above. Sending email here.
        try {
          // Use CURRENT publisher email from relation (always up-to-date), fallback to static field for legacy entries
          let publisherEmail = null;

          console.log(`[ORDER ${order.id}] Determining publisher email for website ID: ${orderData.website}`);
          console.log(`[ORDER ${order.id}] Marketplace publisher relation:`, marketplace?.publisher?.email || 'NONE');
          console.log(`[ORDER ${order.id}] Marketplace publisher_email field:`, marketplace?.publisher_email || 'NONE');

          if (marketplace && marketplace.publisher && marketplace.publisher.email) {
            publisherEmail = marketplace.publisher.email;
            console.log(`[ORDER ${order.id}] Using publisher.email: ${publisherEmail}`);
          } else if (marketplace && marketplace.publisher_email) {
            publisherEmail = marketplace.publisher_email;
            console.log(`[ORDER ${order.id}] Using publisher_email field: ${publisherEmail}`);
          }

          if (publisherEmail) {
            // Send email notification for new order
            try {
              console.log(`[ORDER ${order.id}] Sending order creation email to: ${publisherEmail}`);
              const emailService = strapi.service('api::global.email-operations');
              await emailService.sendOrderCreationEmail(
                populatedOrder,
                publisherEmail,
                user.email
              );
              console.log(`Order creation emails sent for order ${order.id}`);
            } catch (emailError) {
              console.error('Failed to send order creation emails:', emailError);
              // Don't fail order creation if email fails
            }
          } else {
            console.log(`Website not found or missing publisher_email for website ID: ${orderData.website}`);
          }

          // Send order confirmation email to advertiser
          try {
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendOrderConfirmationAdvertiserEmail(populatedOrder, user.email);
            console.log(`[ORDER ${order.id}] Order confirmation email sent to advertiser: ${user.email}`);
          } catch (emailError) {
            console.error(`[ORDER ${order.id}] Failed to send advertiser confirmation email:`, emailError.message);
          }
        } catch (notificationError) {
          console.error('Failed to create new order notification:', notificationError);
          // Don't fail the order creation if notification fails
        }

        // ========== AUTOSEND: REMOVE FROM CONVERSION LISTS ==========
        try {
          const autoSendService = strapi.service('api::global.autosend-service');
          if (autoSendService && user.email) {
            // Remove from "wallet funded, no order" list — they just placed an order
            const walletNoOrderListId = process.env.AUTOSEND_WALLET_NO_ORDER_LIST_ID;
            if (walletNoOrderListId) {
              autoSendService.removeFromList({ email: user.email, listId: walletNoOrderListId })
                .catch(err => console.error('[Order] AutoSend removeFromList (wallet) error:', err.message));
            }

            // Remove from "abandoned cart" list — they completed checkout
            const abandonedCartListId = process.env.AUTOSEND_ABANDONED_CART_LIST_ID;
            if (abandonedCartListId) {
              autoSendService.removeFromList({ email: user.email, listId: abandonedCartListId })
                .catch(err => console.error('[Order] AutoSend removeFromList (cart) error:', err.message));
            }

            // Remove from "inactive signup" list — they finally converted
            const inactiveSignupListId = process.env.AUTOSEND_INACTIVE_SIGNUP_LIST_ID;
            if (inactiveSignupListId) {
              autoSendService.removeFromList({ email: user.email, listId: inactiveSignupListId })
                .catch(err => console.error('[Order] AutoSend removeFromList (inactive) error:', err.message));
            }

            // Remove from "win-back" list — they came back!
            const winbackListId = process.env.AUTOSEND_WINBACK_LIST_ID;
            if (winbackListId) {
              autoSendService.removeFromList({ email: user.email, listId: winbackListId })
                .catch(err => console.error('[Order] AutoSend removeFromList (winback) error:', err.message));
            }

            // Remove ordered item from favorites & clean up favorite reminder list
            const favoriteListId = process.env.AUTOSEND_FAVORITE_REMINDER_LIST_ID;
            if (orderData.website) {
              try {
                // Find and delete the shortlisted item for this marketplace + user
                const shortlistedItem = await strapi.db.query('api::shortlist.shortlist').findOne({
                  where: {
                    marketplace: orderData.website,
                    owner: user.id,
                  },
                });

                if (shortlistedItem) {
                  await strapi.entityService.delete('api::shortlist.shortlist', shortlistedItem.id);
                  console.log(`[Order] Removed marketplace ${orderData.website} from user ${user.id} shortlist`);

                  // Check if user has any remaining favorites
                  if (favoriteListId) {
                    const remainingCount = await strapi.db.query('api::shortlist.shortlist').count({
                      where: { owner: user.id },
                    });

                    if (remainingCount === 0) {
                      autoSendService.removeFromList({ email: user.email, listId: favoriteListId })
                        .catch(err => console.error('[Order] AutoSend removeFromList (favorite) error:', err.message));
                      console.log(`[Order] Removed ${user.email} from favorite reminder list (no favorites left)`);
                    }
                  }
                }
              } catch (shortlistErr) {
                console.error('[Order] Shortlist cleanup error (non-blocking):', shortlistErr.message);
              }
            }
          }
        } catch (autoSendErr) {
          console.error('[Order] AutoSend sync error (non-blocking):', autoSendErr.message);
        }
        // ========== END AUTOSEND ==========

        return {
          data: sanitizeOrderResponse(populatedOrder),
          meta: {
            message: 'Order created successfully with escrow hold'
          }
        };
      } catch (error) {
        // Handle common errors with appropriate responses
        if (error.message === 'Insufficient funds') {
          return ctx.badRequest('Insufficient funds in your wallet');
        }
        if (error.message === 'Advertiser wallet not found') {
          return ctx.badRequest('No advertiser wallet found for your account');
        }
        if (error.message === 'Authentication required') {
          return ctx.unauthorized('Authentication required');
        }

        // Log and return any other errors
        console.error('Error creating order:', error);
        return ctx.badRequest(error.message || 'Error creating order');
      }
    },

    // Fix links in all existing order content records
    async fixLinks(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can fix links');
        }

        let fixed = 0;
        let errors = 0;

        // Find all order-contents
        const orderContents = await strapi.db.query('api::order-content.order-content').findMany();

        for (const content of orderContents) {
          try {
            // Check if links needs to be fixed
            if (content.links !== null) {
              let updatedLinks;

              // If links is already a string but not JSON, format it
              if (typeof content.links === 'string' && !content.links.startsWith('[')) {
                updatedLinks = JSON.stringify([content.links]);
              }
              // If links is an array, stringify it
              else if (Array.isArray(content.links)) {
                updatedLinks = JSON.stringify(content.links);
              }
              // If we need to update the links
              if (updatedLinks) {
                await strapi.entityService.update('api::order-content.order-content', content.id, {
                  data: {
                    links: updatedLinks
                  }
                });
                fixed++;
                console.log(`Fixed links for content ${content.id}`);
              }
            } else if (content.links === null && ctx.query.createEmpty) {
              // Create empty links array if requested
              await strapi.entityService.update('api::order-content.order-content', content.id, {
                data: {
                  links: JSON.stringify([])
                }
              });
              fixed++;
              console.log(`Created empty links array for content ${content.id}`);
            }
          } catch (err) {
            console.error(`Error fixing links for content ${content.id}:`, err);
            errors++;
          }
        }

        return {
          data: {
            fixed,
            errors,
            message: `Fixed links for ${fixed} records, encountered ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error fixing links:', error);
        return ctx.internalServerError('An error occurred while fixing links');
      }
    },

    // Get current user's orders with pagination and search
    async getMyOrders(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Extract query parameters
        const {
          type = 'all',
          page = 1,
          pageSize = 10,
          search = '',
          status = '',
          sortBy = 'orderDate',
          sortOrder = 'desc'
        } = ctx.query;

        // Convert page and pageSize to numbers
        const currentPage = Math.max(1, parseInt(page));
        const limit = Math.min(50, Math.max(1, parseInt(pageSize))); // Max 50 per page
        const start = (currentPage - 1) * limit;

        // Build base filters for user access
        const baseFilters = {};

        if (type === 'advertiser') {
          // Include only orders where user is advertiser
          baseFilters.advertiser = user.id;
        } else if (type === 'publisher') {
          // Use ORDER's snapshot data, NOT live marketplace data
          // This ensures orders stay with the publisher who was owner at order creation time
          // 1. Direct publisher assignment (set when order was created)
          // 2. Order's snapshotted publisher email (captured at order creation)
          baseFilters.$or = [
            { publisher: user.id },
            { websitePublisherEmail: user.email }
          ];

          // Exclude orders where user is the advertiser (to prevent self-acceptance)
          baseFilters.advertiser = { $ne: user.id };

          console.log(`[Order Filter] Publisher ${user.id} - filtering by direct publisher OR order snapshot email`);
        } else if (type === 'all') {
          // Include orders where user is advertiser OR publisher
          // Use ORDER's snapshot data for publisher matching
          baseFilters.$or = [
            { advertiser: user.id },
            { publisher: user.id },
            { websitePublisherEmail: user.email }
          ];

          console.log(`[Order Filter] User ${user.id} - filtering by direct relationships and order snapshot`);
        }

        // Add search filters
        const searchFilters = {};
        if (search && search.trim()) {
          const searchTerm = search.trim();
          searchFilters.$or = [];

          // Search by order ID (exact match if it's a number)
          if (!isNaN(searchTerm)) {
            searchFilters.$or.push({ id: parseInt(searchTerm) });
          }

          // Search by description
          // searchFilters.$or.push({
          //   description: { $containsi: searchTerm }
          // });

          // Search by website URL
          searchFilters.$or.push({
            website: {
              url: { $containsi: searchTerm }
            }
          });

          // Search by project name
          searchFilters.$or.push({
            project: {
              ProjectName: { $containsi: searchTerm }
            }
          });

          // Search by order content title
          //   searchFilters.$or.push({
          //     orderContent: {
          //       title: { $containsi: searchTerm }
          //     }
          //   });
        }

        // Add status filter
        const statusFilter = {};
        if (status && status.trim()) {
          // Handle multiple statuses (comma-separated)
          const statuses = status.split(',').map(s => s.trim()).filter(s => s);
          if (statuses.length === 1) {
            statusFilter.orderStatus = statuses[0];
          } else if (statuses.length > 1) {
            statusFilter.orderStatus = { $in: statuses };
          }
        }

        // Combine all filters
        const combinedFilters = {
          $and: [
            baseFilters,
            ...(Object.keys(searchFilters).length ? [searchFilters] : []),
            ...(Object.keys(statusFilter).length ? [statusFilter] : [])
          ]
        };

        // Build sort object
        const sortOptions = {};
        const validSortFields = ['orderDate', 'id', 'orderStatus', 'totalAmount', 'deliveredDate', 'acceptedDate', 'updatedAt'];
        const validSortOrders = ['asc', 'desc'];

        if (validSortFields.includes(sortBy) && validSortOrders.includes(sortOrder.toLowerCase())) {
          sortOptions[sortBy] = sortOrder.toLowerCase();
        } else {
          // Default sort by most recent activity (updatedAt)
          sortOptions.updatedAt = 'desc';
        }

        console.log(`Fetching orders for user ID ${user.id}, page: ${currentPage}, limit: ${limit}`);
        console.log('Combined Filters:', JSON.stringify(combinedFilters, null, 2));
        console.log('Sort Options:', sortOptions);

        // Get total count for pagination
        const totalCount = await strapi.entityService.count('api::order.order', {
          filters: combinedFilters
        });

        // Allow-list both the order's own scalars (`fields`) and every
        // nested relation. This is the primary PII defense — no
        // denormalized `websitePublisher*` snapshot, no opaque
        // `websiteSnapshot` JSON, no `metadata` blob, no admin-only audit
        // columns (`createdByAdminId`, `adminReason`, `cancellationNotes`,
        // user-consent fields), and no auto-populating of newly-added
        // PII columns on nested types in the future.
        const orders = await strapi.entityService.findMany('api::order.order', {
          filters: combinedFilters,
          fields: ORDER_FETCH_FIELDS,
          populate: ORDER_LIST_POPULATE,
          sort: sortOptions,
          start,
          limit
        });

        // Always sanitize each order before responding — strips the 3
        // snapshot fields AND clips any populated `website`/`advertiser`/
        // `publisher` relations to their public allow-list. Defense in
        // depth in case a future schema change reintroduces a PII column
        // that the populate would otherwise auto-expose.
        for (const order of orders) sanitizeOrderResponse(order);

        // Calculate pagination info
        const totalPages = Math.ceil(totalCount / limit);
        const hasNextPage = currentPage < totalPages;
        const hasPrevPage = currentPage > 1;

        console.log(`Found ${orders.length} orders out of ${totalCount} total for user ID ${user.id}`);

        return {
          data: orders,
          meta: {
            pagination: {
              page: currentPage,
              pageSize: limit,
              pageCount: totalPages,
              total: totalCount,
              hasNextPage,
              hasPrevPage
            },
            search: {
              query: search,
              status: status,
              type: type
            },
            sort: {
              field: sortBy,
              order: sortOrder
            }
          }
        };
      } catch (error) {
        console.error('Error fetching user orders:', error);
        return ctx.internalServerError('An error occurred while fetching orders');
      }
    },

    // Lightweight endpoint: Get only counts for layout navbar badges
    // Returns available orders count + in-progress orders count
    // This replaces the need to call getAvailableOrders + getMyOrders just for badge numbers
    async getCounts(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // --- Available orders count ---
        // Get publisher's active marketplace websites
        const publisherWebsites = await strapi.db.query('api::marketplace.marketplace').findMany({
          where: {
            $or: [
              { publisher: user.id },
              { publisher_email: user.email }
            ],
            status: { $in: ['active', 'delisted'] }
          },
          select: ['id']
        });

        const websiteIds = publisherWebsites.map(w => w.id);

        let availableCount = 0;
        if (websiteIds.length > 0) {
          // Count pending orders for publisher's websites
          availableCount = await strapi.db.query('api::order.order').count({
            where: {
              $and: [
                { website: { $in: websiteIds } },
                { orderStatus: 'pending' },
                { advertiser: { $ne: user.id } },
                {
                  $or: [
                    { publisher: null },
                    { publisher: user.id }
                  ]
                }
              ]
            }
          });
        }

        // Also count orders assigned via snapshot email
        const snapshotCount = await strapi.db.query('api::order.order').count({
          where: {
            $and: [
              { websitePublisherEmail: user.email },
              { orderStatus: 'pending' },
              { advertiser: { $ne: user.id } },
              {
                $or: [
                  { publisher: null },
                  { publisher: user.id }
                ]
              },
              // Exclude orders already counted via websiteIds
              ...(websiteIds.length > 0 ? [{ website: { $notIn: websiteIds } }] : [])
            ]
          }
        });

        const totalAvailableCount = availableCount + snapshotCount;

        // --- In-progress orders count ---
        // Count orders where publisher has accepted but not completed
        const inProgressCount = await strapi.db.query('api::order.order').count({
          where: {
            $and: [
              {
                $or: [
                  { publisher: user.id },
                  { websitePublisherEmail: user.email }
                ]
              },
              { advertiser: { $ne: user.id } },
              {
                $or: [
                  { orderStatus: 'accepted' },
                  {
                    $and: [
                      { orderStatus: 'delivered' },
                      { revisionStatus: 'requested' }
                    ]
                  }
                ]
              }
            ]
          }
        });

        return {
          data: {
            availableCount: totalAvailableCount,
            inProgressCount: inProgressCount
          }
        };
      } catch (error) {
        console.error('Error fetching order counts:', error);
        return ctx.internalServerError('An error occurred while fetching order counts');
      }
    },

    // Get orders available for publishers to accept
    async getAvailableOrders(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Get publisher's websites by matching ID or fallback to email
        // For available orders, we ONLY want active websites they currently own
        const publisherWebsites = await strapi.db.query('api::marketplace.marketplace').findMany({
          where: {
            $or: [
              { publisher: user.id },
              { publisher_email: user.email }
            ],
            status: { $in: ['active', 'delisted'] } // Include delisted websites so pending orders remain visible after admin rejection
          }
        });

        console.log(`[Available Orders] User ${user.id} (${user.email}) found ${publisherWebsites.length} websites:`);
        publisherWebsites.forEach(website => {
          console.log(`  - Website ${website.id}: ${website.url} (status: ${website.status}, delisted reason: ${website.delistedReason || 'N/A'})`);
        });


        let orders = [];

        // Don't early-return on zero marketplaces. The snapshot-based
        // source below (source #3) still needs to run so that users
        // who became active publishers via ownership transfer — but
        // whose marketplace.publisher pointer hasn't caught up yet —
        // can still see orders that were correctly snapshotted to
        // their email at creation time.
        const websiteIds = publisherWebsites.map(website => website.id);
        if (websiteIds.length > 0) {
          console.log(`[Available Orders] Looking for orders in websites: [${websiteIds.join(', ')}]`);
        }

        // Get orders for currently owned websites
        let currentWebsiteOrders = [];
        if (websiteIds.length > 0) {
          currentWebsiteOrders = await strapi.entityService.findMany('api::order.order', {
            filters: {
              $and: [
                { website: { id: { $in: websiteIds } } },
                { orderStatus: 'pending' },
                { advertiser: { id: { $ne: user.id } } }, // Exclude orders placed by this user as advertiser
                // Show orders that are unassigned OR assigned to this user
                {
                  $or: [
                    { publisher: { $null: true } },
                    { publisher: { id: user.id } }
                  ]
                }
              ]
            },
            fields: ORDER_FETCH_FIELDS,
            populate: ORDER_LIST_POPULATE,
            sort: { orderDate: 'desc' }
          });
        }

        // ALSO get orders for websites that were transferred FROM this user
        // These are orders that were already visible to them before the transfer
        const transferredWebsites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
          where: {
            publisherEmail: user.email,
            submissionStatus: 'ownership_transferred'
          }
        });

        console.log(`[Debug] User ${user.email} has ${transferredWebsites.length} transferred websites`);

        let historicalOrders = [];
        if (transferredWebsites.length > 0) {
          console.log(`[Available Orders] Found ${transferredWebsites.length} transferred websites for user ${user.id}`);

          for (const transferredWebsite of transferredWebsites) {
            // Find the current marketplace listing for this URL
            const currentMarketplaceListing = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { url: transferredWebsite.url, status: 'active' }
            });

            if (currentMarketplaceListing && transferredWebsite.ownershipTransferredAt) {
              // Get pending orders placed BEFORE the transfer date.
              // Match orders that were either unassigned OR already
              // assigned to this user — the previous owner. The order
              // create flow stamps the active publisher onto the order
              // when it's placed, so pre-transfer orders for this URL
              // typically carry publisher = user.id, not null. The old
              // restriction (publisher: null) silently dropped them.
              const preTransferOrders = await strapi.entityService.findMany('api::order.order', {
                filters: {
                  $and: [
                    { website: { id: currentMarketplaceListing.id } },
                    { orderStatus: 'pending' },
                    { orderDate: { $lt: transferredWebsite.ownershipTransferredAt } },
                    { advertiser: { id: { $ne: user.id } } },
                    {
                      $or: [
                        { publisher: { $null: true } },
                        { publisher: { id: user.id } }
                      ]
                    }
                  ]
                },
                fields: ORDER_FETCH_FIELDS,
                populate: ORDER_LIST_POPULATE,
                sort: { orderDate: 'desc' }
              });

              console.log(`[Available Orders] Found ${preTransferOrders.length} pre-transfer orders for ${transferredWebsite.url}`);
              historicalOrders = historicalOrders.concat(preTransferOrders);
            }
          }
        }

        // ALSO get pending orders where user is directly assigned via snapshot email
        // This catches orders for websites where ownership transferred but order was placed when user owned it
        const directlyAssignedRaw = await strapi.entityService.findMany('api::order.order', {
          filters: {
            $and: [
              { websitePublisherEmail: user.email },
              { orderStatus: 'pending' },
              { advertiser: { id: { $ne: user.id } } },
              {
                $or: [
                  { publisher: { $null: true } },
                  { publisher: { id: user.id } }
                ]
              }
            ]
          },
          fields: ORDER_FETCH_FIELDS,
          populate: ORDER_LIST_POPULATE,
          sort: { orderDate: 'desc' }
        });

        // Active-publisher safety filter: if a website's ownership has
        // been transferred to someone else since this order was placed,
        // do NOT surface it to the previous owner via the snapshot
        // route. The active publisher-website record (status='approved')
        // for the URL is the source of truth. Pre-transfer pending
        // orders are already handled by the historicalOrders branch
        // above with an explicit orderDate < ownershipTransferredAt
        // bound, so dropping them here doesn't lose any legitimate
        // visibility.
        const directlyAssignedOrders = [];
        const activeOwnerCacheByUrl = new Map();
        for (const order of directlyAssignedRaw) {
          const url = order.website?.url;
          if (!url) {
            // No URL to resolve against — keep original behavior.
            directlyAssignedOrders.push(order);
            continue;
          }
          let activeOwnerId = activeOwnerCacheByUrl.get(url);
          if (activeOwnerId === undefined) {
            const activeWebsite = await strapi.db
              .query('api::publisher-website.publisher-website')
              .findOne({
                where: { url, submissionStatus: 'approved' },
                populate: ['currentPublisherId']
              });
            activeOwnerId = activeWebsite?.currentPublisherId?.id || null;
            activeOwnerCacheByUrl.set(url, activeOwnerId);
          }
          // If there's no active record at all (rare), fall back to
          // showing the order — legacy/unmanaged URLs should still work.
          if (!activeOwnerId || activeOwnerId === user.id) {
            directlyAssignedOrders.push(order);
          }
        }
        console.log(`[Available Orders] Found ${directlyAssignedOrders.length} orders via snapshot email ${user.email} (filtered by active publisher match)`);

        // Combine all sources: current + historical + directly assigned via snapshot
        const combinedOrders = [...currentWebsiteOrders, ...historicalOrders, ...directlyAssignedOrders];

        // Remove duplicates (in case of any overlap)
        orders = combinedOrders.filter((order, index, self) =>
          index === self.findIndex(o => o.id === order.id)
        );

        console.log(`Retrieved ${orders.length} available orders for user ID ${user.id} (${currentWebsiteOrders.length} current + ${historicalOrders.length} historical + ${directlyAssignedOrders.length} via snapshot)`);

        // Log all order IDs for debugging
        console.log('Available order IDs:', orders.map(order => order.id).join(', '));

        // Sanitize each order before responding — strips snapshot
        // publisher fields AND clips populated relations to their
        // public allow-list.
        for (const order of orders) sanitizeOrderResponse(order);

        return {
          data: orders,
          meta: {
            count: orders.length
          }
        };
      } catch (error) {
        console.error('Error fetching available orders:', error);
        return ctx.internalServerError('An error occurred while fetching available orders');
      }
    },

    // Accept an order (for publishers)
    async acceptOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;

        // Use the order service to handle order acceptance
        const updatedOrder = await strapi.service('api::order.order').acceptOrder(id, user);

        // Check if user has a publisher wallet, create if not exists
        await checkPublisherWallet(user.id);

        // Create notification for advertiser
        try {
          console.log(`[OrderController] About to create order_accepted notification for order ${updatedOrder.id}`);
          console.log(`[OrderController] Publisher (current user): ${user.id}, Advertiser: ${updatedOrder.advertiser?.id || updatedOrder.advertiser}`);
          console.log(`[OrderController] Full updatedOrder.advertiser object:`, JSON.stringify(updatedOrder.advertiser, null, 2));

          const advertiserId = updatedOrder.advertiser?.id || updatedOrder.advertiser;
          if (!advertiserId) {
            console.error(`[OrderController] ERROR: No advertiser ID found in updatedOrder!`);
            console.error(`[OrderController] updatedOrder:`, JSON.stringify(updatedOrder, null, 2));
            throw new Error('No advertiser ID found in order');
          }

          await strapi.service('api::notification.notification').createOrderNotification(
            updatedOrder.id,
            user.id,
            advertiserId,
            'order_accepted'
          );

          console.log(`[OrderController] Order accepted notification created successfully for advertiser ${advertiserId}`);
        } catch (notificationError) {
          console.error('Failed to create order accepted notification:', notificationError);
          // Don't fail the order acceptance if notification fails
        }

        // Send email notification for order acceptance
        try {
          // Get the updated order with full data for email
          const fullOrder = await strapi.entityService.findOne('api::order.order', id, {
            populate: ['website', 'advertiser', 'publisher']
          });

          // Get advertiser user data
          const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: updatedOrder.advertiser?.id || updatedOrder.advertiser }
          });

          if (advertiserUser && advertiserUser.email) {
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendOrderAcceptanceEmail(
              fullOrder,
              advertiserUser.email,
              user.email
            );
            console.log(`Order acceptance emails sent for order ${id}`);
          }
        } catch (emailError) {
          console.error('Failed to send order acceptance emails:', emailError);
          // Don't fail the acceptance if email fails
        }

        return {
          data: sanitizeOrderResponse(updatedOrder),
          meta: {
            message: 'Order accepted successfully'
          }
        };
      } catch (error) {
        console.error('Error accepting order:', error);

        // Handle specific service errors
        if (error.message === 'Order not found') {
          return ctx.notFound('Order not found');
        }
        if (error.message === 'Order is already accepted or not available') {
          return ctx.badRequest('Order is already accepted or not available');
        }
        if (error.message === 'You do not have permission to accept this order') {
          return ctx.forbidden('You do not have permission to accept this order');
        }

        return ctx.internalServerError('An error occurred while accepting the order');
      }
    },

    // Reject an order (for publishers)
    async rejectOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        const { body } = ctx.request;

        if (!body.reason || body.reason.trim().length === 0) {
          return ctx.badRequest('Rejection reason is required');
        }

        // Get the order
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['website', 'advertiser', 'publisher']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if order is in pending status
        if (order.orderStatus !== 'pending') {
          return ctx.badRequest('Only pending orders can be rejected');
        }

        // Verify the publisher can reject this order using ORDER's snapshot data
        // NOT live marketplace data (which may have changed due to ownership transfer)
        // This matches the approach used in acceptOrder
        if (order.advertiser !== user.id) {
          const isDirectPublisher = order.publisher && (order.publisher.id === user.id || order.publisher === user.id);
          const isSnapshotPublisher = order.websitePublisherEmail === user.email;

          if (!isDirectPublisher && !isSnapshotPublisher) {
            console.log(`[Reject Order] User ${user.id} (${user.email}) denied access to order ${id}`);
            console.log(`[Reject Order] Order publisher: ${order.publisher?.id}, Snapshot email: ${order.websitePublisherEmail}`);
            return ctx.forbidden('You do not have permission to reject this order');
          }
        }

        // Audit M3 fix — service now performs refund + status flip atomically
        // in one transaction (with SELECT ... FOR UPDATE on the order row).
        // Pass the rejection reason via a non-enumerable user property; the
        // service writes it inside the transaction. Idempotent: a second
        // reject on an already-rejected order returns { alreadyTerminal }
        // and does NOT issue a second refund.
        const rejectionReason = body.reason.trim();
        const rejectResult = await strapi.service('api::order.order').rejectOrder(
          id,
          Object.assign({}, user, { __rejectionReason: rejectionReason })
        );
        if (rejectResult && rejectResult.alreadyTerminal) {
          return ctx.badRequest(`Order is already ${rejectResult.currentStatus}`);
        }
        const updatedOrder = await strapi.db.query('api::order.order').findOne({ where: { id } });

        // Create notification for advertiser about the rejection
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            order.id,
            user.id,
            order.advertiser?.id || order.advertiser,
            'order_rejected',
            { reason: body.reason.trim() }
          );
        } catch (notificationError) {
          console.error('Failed to create order rejected notification:', notificationError);
          // Don't fail the order rejection if notification fails
        }

        // Send email notification for order rejection
        try {
          // Get the updated order with full data for email
          const fullOrder = await strapi.entityService.findOne('api::order.order', id, {
            populate: ['website', 'advertiser', 'publisher']
          });

          // Get advertiser user data
          const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: order.advertiser?.id || order.advertiser }
          });

          if (advertiserUser && advertiserUser.email) {
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendOrderRejectionEmail(
              { ...fullOrder, rejectionReason: body.reason.trim() },
              advertiserUser.email,
              user.email
            );
            console.log(`Order rejection emails sent for order ${id}`);
          }
        } catch (emailError) {
          console.error('Failed to send order rejection emails:', emailError);
          // Don't fail the rejection if email fails
        }

        return {
          data: sanitizeOrderResponse(updatedOrder),
          meta: {
            message: 'Order rejected successfully'
          }
        };
      } catch (error) {
        console.error('Error rejecting order:', error);
        return ctx.internalServerError('An error occurred while rejecting the order');
      }
    },

    // Mark order as delivered (for publishers)
    async deliverOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        const { body } = ctx.request;
        console.log("user", user);
        console.log(id);

        // Get the order - make sure we populate the publisher field
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['website', 'advertiser', 'publisher', 'outsourcedContent']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }
        console.log("order", order);

        // Initialize a flag to track if we need to update publisher
        let publisherNeedsUpdate = false;

        // Check if the order doesn't have a publisher yet
        if (!order.publisher || !order.publisher.id) {
          console.log(`Order ${id} has no publisher assigned. Assigning current user as publisher.`);
          publisherNeedsUpdate = true;

          // First check if this user is allowed to deliver this order
          let canDeliver = false;

          // If the order is for a website owned by this user
          if (order.website && order.website.id) {
            const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: {
                id: order.website.id,
                $or: [
                  { publisher: user.id },
                  { publisher_email: user.email }
                ]
              }
            });

            if (isWebsiteOwner) {
              console.log('User owns this website. Assigning as publisher.');
              canDeliver = true;
            }
          }

          // Or if they are the advertiser for their own order
          if (order.advertiser && order.advertiser.id === user.id) {
            console.log('User is the advertiser for this order. Assigning as publisher too.');
            canDeliver = true;
          }

          if (!canDeliver) {
            return ctx.forbidden('You do not have permission to deliver this order.');
          }

          // Update the order to set the user as the publisher
          await strapi.db.query('api::order.order').update({
            where: { id },
            data: {
              publisher: user.id
            }
          });

          // Set the publisher value in our order object
          if (!order.publisher) {
            order.publisher = { id: user.id };
          } else {
            order.publisher.id = user.id;
          }

          // Ensure publisher wallet exists
          await checkPublisherWallet(user.id);
        }

        // Check for publisher mismatch (should only happen if publisherNeedsUpdate is false)
        if (!publisherNeedsUpdate && order.publisher && order.publisher.id !== user.id) {
          console.log('Publisher mismatch:', {
            orderId: id,
            orderPublisher: order.publisher.id,
            currentUser: user.id
          });

          // Check if this is the advertiser's own order
          if (order.advertiser && order.advertiser.id === user.id) {
            console.log('User is the advertiser for this order. Fixing publisher association...');
            publisherNeedsUpdate = true;
          }
          // Special case: Check if the website belongs to this user
          else if (order.website && order.website.id) {
            // Check if user is the current website owner for NEW orders only
            // For historical orders, only the originally assigned publisher can deliver
            const isWebsiteOwner = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: {
                id: order.website.id,
                $or: [
                  { publisher: user.id },
                  { publisher_email: user.email }
                ]
              }
            });

            if (isWebsiteOwner) {
              // Only allow website owner to take over if this is a very recent order (within 24 hours)
              // This prevents ownership transfers from stealing old orders
              const orderAge = new Date() - new Date(order.orderDate);
              const maxAgeForOwnerTakeover = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

              if (orderAge <= maxAgeForOwnerTakeover) {
                console.log('User owns this website and order is recent. Allowing publisher association...');
                publisherNeedsUpdate = true;
              } else {
                console.log(`Order is too old (${Math.round(orderAge / (1000 * 60 * 60))} hours) for automatic publisher assignment.`);
                return ctx.forbidden('This order was placed before your ownership. Only the originally assigned publisher can deliver it.');
              }
            } else {
              return ctx.forbidden('You do not have permission to update this order. You are neither the publisher nor the website owner.');
            }
          } else {
            return ctx.forbidden('You do not have permission to update this order. Publisher ID does not match your user ID.');
          }

          // Update the publisher if needed
          if (publisherNeedsUpdate) {
            await strapi.db.query('api::order.order').update({
              where: { id },
              data: {
                publisher: user.id
              }
            });

            // Update our order object
            if (!order.publisher) {
              order.publisher = { id: user.id };
            } else {
              order.publisher.id = user.id;
            }
          }
        }

        // Check if the order is in pending status
        let statusNeedsUpdate = false;

        if (order.orderStatus === 'pending') {
          console.log(`Order ${id} is in pending status. Updating to accepted first.`);
          statusNeedsUpdate = true;

          // Update to accepted
          await strapi.db.query('api::order.order').update({
            where: { id },
            data: {
              orderStatus: 'accepted',
              acceptedDate: new Date()
            }
          });

          // Update our order object
          order.orderStatus = 'accepted';
        } else if (order.orderStatus !== 'accepted') {
          return ctx.badRequest(`Order must be in "accepted" or "pending" status to be marked as delivered (current status: ${order.orderStatus})`);
        }

        // For outsourced orders, check if we need to link outsourced content
        if (order.isOutsourced) {
          // Check if outsourced content exists for this order
          const outsourcedContent = await strapi.db.query('api::outsourced-content.outsourced-content').findOne({
            where: { order: id }
          });

          // If outsourced content exists but is not linked to order, update the association
          if (outsourcedContent && !order.outsourcedContent) {
            console.log(`Found outsourced content (${outsourcedContent.id}) not linked to order. Linking now.`);
            await strapi.db.query('api::order.order').update({
              where: { id },
              data: {
                outsourcedContent: outsourcedContent.id
              }
            });
          }
          // If outsourced content doesn't exist, create it
          else if (!outsourcedContent) {
            console.log(`No outsourced content found for order ${id}. Creating now.`);
            // Get website details for the project name
            let projectName = `Order for ${order.description}`;
            if (order.website && order.website.url) {
              projectName = order.website.url;
            }

            // Create new outsourced content
            const newOutsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
              data: {
                projectName,
                instructions: order.instructions || 'No specific instructions provided',
                order: id,
                publishedAt: new Date()
              }
            });

            // Link the outsourced content to the order
            await strapi.db.query('api::order.order').update({
              where: { id },
              data: {
                outsourcedContent: newOutsourcedContent.id
              }
            });
          }
          // If outsourced content exists but doesn't have instructions, update it
          else if (outsourcedContent && !outsourcedContent.instructions && order.instructions) {
            console.log(`Updating instructions for outsourced content ${outsourcedContent.id}`);
            await strapi.entityService.update('api::outsourced-content.outsourced-content', outsourcedContent.id, {
              data: {
                instructions: order.instructions
              }
            });
          }
        }

        // Now mark as delivered
        console.log(`Marking order ${id} as delivered.`);
        const updatedOrder = await strapi.db.query('api::order.order').update({
          where: { id },
          data: {
            orderStatus: 'delivered',
            deliveredDate: new Date(),
            deliveryProof: body.proof || '',
            deliveryMessage: body.message || '',
            // Only update revision status if it was in progress
            ...(order.revisionStatus === 'in_progress' && {
              revisionStatus: 'completed'
            })
          }
        });

        // Create notification for advertiser about delivery
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            order.id,
            user.id,
            order.advertiser.id,
            'order_delivered',
            { orderId: order.id }
          );

          // Send email notification for order delivery
          try {
            // Get the updated order with full data for email
            const fullOrder = await strapi.entityService.findOne('api::order.order', id, {
              populate: ['website', 'advertiser', 'publisher']
            });

            // Get advertiser user data
            const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
              where: { id: order.advertiser?.id || order.advertiser }
            });

            if (advertiserUser && advertiserUser.email) {
              const emailService = strapi.service('api::global.email-operations');
              console.log("emailService", emailService)
              await emailService.sendOrderDeliveryEmail(
                fullOrder,
                advertiserUser.email,
                user.email
              );
              console.log(`Order delivery emails sent for order ${id}`);
            }
          } catch (emailError) {
            console.error('Failed to send order delivery emails:', emailError);
            // Don't fail delivery if email fails
          }
        } catch (error) {
          console.error('Failed to create delivery notification:', error);
        }

        // Return the updated order
        return {
          data: sanitizeOrderResponse(updatedOrder)
        };
      } catch (error) {
        console.error('Error delivering order:', error);
        return ctx.internalServerError('An error occurred while updating the order');
      }
    },

    // Complete order and release escrow (for advertisers)
    async completeOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        console.log(`Attempting to complete order ${id} by user ${user.id}`);

        // Get the order with related data
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['publisher', 'advertiser']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if user is the advertiser for this order
        if (!order.advertiser || (order.advertiser.id !== user.id && order.advertiser !== user.id)) {
          console.log('Permission denied:', {
            orderId: id,
            orderAdvertiser: order.advertiser?.id || order.advertiser,
            currentUser: user.id
          });
          return ctx.forbidden('You do not have permission to complete this order');
        }

        // Check if order is in 'delivered' status
        if (order.orderStatus !== 'delivered') {
          return ctx.badRequest('Order must be in "delivered" status to be completed');
        }

        try {
          console.log(`Processing completion of order ${id}`);
          // Complete the order and release escrow using the order service
          const completedOrder = await strapi.service('api::order.order').completeOrder(order.id, user);

          // Create notification for publisher about completion
          try {
            await strapi.service('api::notification.notification').createOrderNotification(
              order.id,
              order.publisher?.id || order.publisher,
              user.id,
              'order_completed'
            );
          } catch (notificationError) {
            console.error('Failed to create order completed notification:', notificationError);
            // Don't fail the order completion if notification fails
          }

          // Create payment notification for publisher
          try {
            await strapi.service('api::notification.notification').createPaymentNotification(
              order.publisher?.id || order.publisher,
              'payment_received',
              order.totalAmount
            );

            // Send email notification for order completion with payment
            try {
              const publisherId = order.publisher?.id || order.publisher;
              const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
                where: { id: publisherId }
              });

              if (publisherUser && publisherUser.email) {
                const emailService = strapi.service('api::global.email-operations');
                await emailService.sendOrderCompletionEmail(
                  completedOrder,
                  publisherUser.email,
                  order.totalAmount
                );
                console.log(`Order completion email sent for order ${order.id}`);

                // Earnings transaction email (separate from the order-completion
                // notification above). completeOrder() credits the publisher
                // via addMainFunds, which creates a transaction tagged with
                // description "Earnings from order #X" and linked to the order.
                // sendPaymentConfirmationEmail uses transaction.order to flip
                // the universal template into earning mode.
                try {
                  const earningTransaction = await strapi.db.query('api::transaction.transaction').findOne({
                    where: {
                      users_permissions_user: publisherId,
                      order: order.id,
                      description: { $contains: 'Earnings from order' },
                    },
                    populate: { order: { populate: ['website'] } },
                    orderBy: { createdAt: 'desc' },
                  });

                  if (earningTransaction) {
                    await emailService.sendPaymentConfirmationEmail(
                      earningTransaction,
                      publisherUser.email
                    );
                    console.log(`Earnings transaction email sent for order ${order.id} (tx ${earningTransaction.id})`);
                  } else {
                    console.warn(`No earnings transaction found for order ${order.id}; earnings email not sent`);
                  }
                } catch (earningEmailError) {
                  console.error('Failed to send earnings transaction email:', earningEmailError);
                }
              }
            } catch (emailError) {
              console.error('Failed to send order completion email:', emailError);
              // Don't fail completion if email fails
            }
          } catch (notificationError) {
            console.error('Failed to create payment received notification:', notificationError);
            // Don't fail the order completion if notification fails
          }

          return {
            data: sanitizeOrderResponse(completedOrder),
            meta: {
              message: 'Order completed successfully and marked for payment'
            }
          };
        } catch (serviceError) {
          console.error('Service error completing order:', serviceError);
          return ctx.badRequest(serviceError.message || 'Error processing order completion');
        }
      } catch (error) {
        console.error('Error completing order:', error);
        return ctx.internalServerError('An error occurred while completing the order');
      }
    },

    // Dispute an order (for advertisers)
    async disputeOrder(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        const { id } = ctx.params;
        const { body } = ctx.request;

        if (!body.reason) {
          return ctx.badRequest('Dispute reason is required');
        }

        // Get the order
        const order = await strapi.db.query('api::order.order').findOne({
          where: { id },
          populate: ['advertiser']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Check if user is the advertiser for this order
        // Handle the case where advertiser could be an object or just an ID
        const advertiserId = typeof order.advertiser === 'object' && order.advertiser !== null
          ? order.advertiser.id
          : order.advertiser;

        if (advertiserId !== user.id) {
          return ctx.forbidden('You do not have permission to dispute this order');
        }

        // Check if order is in 'delivered' status
        if (order.orderStatus !== 'delivered') {
          return ctx.badRequest('Only delivered orders can be disputed');
        }

        // Update the order
        const updatedOrder = await strapi.db.query('api::order.order').update({
          where: { id },
          data: {
            orderStatus: 'disputed',
            disputeDate: new Date(),
            disputeReason: body.reason || 'No reason provided'
          }
        });

        // Here you might also want to notify admins about the dispute

        return {
          data: updatedOrder,
          meta: {
            message: 'Order has been marked as disputed'
          }
        };
      } catch (error) {
        console.error('Error disputing order:', error);
        return ctx.internalServerError('An error occurred while disputing the order');
      }
    },

    // Fix missing relations between orders and orderContent
    async fixRelations(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can fix relations');
        }

        let fixed = 0;
        let errors = 0;

        // Find order-contents that have order relation but the order doesn't point back
        const orderContents = await strapi.db.query('api::order-content.order-content').findMany({
          populate: ['order']
        });

        for (const content of orderContents) {
          if (content.order && content.order.id) {
            try {
              // Get the order
              const order = await strapi.db.query('api::order.order').findOne({
                where: { id: content.order.id },
                populate: ['orderContent']
              });

              if (order && !order.orderContent) {
                // Fix the order by adding the missing relation
                await strapi.entityService.update('api::order.order', order.id, {
                  data: {
                    orderContent: content.id
                  }
                });
                fixed++;
                console.log(`Fixed relation for order ${order.id} and content ${content.id}`);
              }
            } catch (err) {
              console.error(`Error fixing relation for content ${content.id}:`, err);
              errors++;
            }
          }
        }

        // Find orders that have missing titles/content
        const ordersWithNoContent = await strapi.db.query('api::order.order').findMany({
          populate: ['orderContent']
        });

        for (const order of ordersWithNoContent) {
          // If order has no orderContent, create one
          if (!order.orderContent) {
            try {
              // Create default content
              const newContent = await strapi.entityService.create('api::order-content.order-content', {
                data: {
                  title: `Order for ${order.description}`,
                  content: order.description || 'Order content',
                  minWordCount: 1000,
                  order: order.id
                }
              });

              // Update the order to point to the new content
              await strapi.entityService.update('api::order.order', order.id, {
                data: {
                  orderContent: newContent.id
                }
              });

              fixed++;
              console.log(`Created missing content for order ${order.id}`);
            } catch (err) {
              console.error(`Error creating content for order ${order.id}:`, err);
              errors++;
            }
          }
        }

        return {
          data: {
            fixed,
            errors,
            message: `Fixed ${fixed} relations, encountered ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error fixing relations:', error);
        return ctx.internalServerError('An error occurred while fixing relations');
      }
    },

    // Migrate instructions from orders to outsourced content
    async migrateInstructions(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can migrate instructions');
        }

        let fixed = 0;
        let created = 0;
        let errors = 0;

        // Find outsourced orders with instructions
        const outsourcedOrders = await strapi.db.query('api::order.order').findMany({
          where: { isOutsourced: true },
          populate: ['outsourcedContent']
        });

        console.log(`Found ${outsourcedOrders.length} outsourced orders to process`);

        for (const order of outsourcedOrders) {
          try {
            // If order has instructions
            if (order.instructions) {
              // If order has linked outsourced content, update it
              if (order.outsourcedContent) {
                await strapi.entityService.update('api::outsourced-content.outsourced-content', order.outsourcedContent.id, {
                  data: {
                    instructions: order.instructions
                  }
                });
                fixed++;
                console.log(`Updated instructions for outsourced content ${order.outsourcedContent.id}`);
              }
              // If order doesn't have linked outsourced content, create one
              else {
                // Get website details for the project name
                let projectName = `Order for ${order.description}`;
                if (order.website) {
                  const website = await strapi.db.query('api::marketplace.marketplace').findOne({
                    where: { id: order.website }
                  });
                  if (website && website.url) {
                    projectName = website.url;
                  }
                }

                // Create new outsourced content
                const newOutsourcedContent = await strapi.entityService.create('api::outsourced-content.outsourced-content', {
                  data: {
                    projectName,
                    instructions: order.instructions,
                    order: order.id,
                    publishedAt: new Date()
                  }
                });

                // Link the outsourced content to the order
                await strapi.entityService.update('api::order.order', order.id, {
                  data: {
                    outsourcedContent: newOutsourcedContent.id
                  }
                });

                created++;
                console.log(`Created new outsourced content for order ${order.id}`);
              }
            }
          } catch (err) {
            console.error(`Error migrating instructions for order ${order.id}:`, err);
            errors++;
          }
        }

        return {
          data: {
            fixed,
            created,
            errors,
            message: `Updated ${fixed} existing outsourced content entries, created ${created} new entries, encountered ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error migrating instructions:', error);
        return ctx.internalServerError('An error occurred while migrating instructions');
      }
    },

    // Request a revision for an order
    async requestRevision(ctx) {
      const { orderId } = ctx.params;
      const { message } = ctx.request.body;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to request a revision');
        }

        // Audit M5 fix — wrap the read-then-write critical section in a
        // transaction with SELECT … FOR UPDATE on the order row. The
        // previous flow had a window where a concurrent completeOrder
        // could read the same 'delivered' row, drain escrow, and credit
        // the publisher before this update committed the
        // revisionStatus='requested' flip. The lock now serializes:
        // whichever transaction commits first wins, the other observes
        // the post-commit state and bails.
        let updated = null;
        let serviceError = null;
        try {
          await strapi.db.transaction(async ({ trx }) => {
            const lockRow = await trx('orders').where({ id: orderId }).forUpdate().select('id');
            if (!lockRow || lockRow.length === 0) {
              serviceError = { code: 404, msg: 'Order not found' };
              return;
            }

            // Re-fetch under the lock so the validation reflects the
            // post-commit state of any concurrent writer.
            const order = await strapi.entityService.findOne('api::order.order', orderId, {
              populate: ['advertiser', 'publisher'],
            });
            if (!order) {
              serviceError = { code: 404, msg: 'Order not found' };
              return;
            }

            if (order.advertiser?.id !== user.id) {
              serviceError = { code: 403, msg: 'Only the advertiser can request revisions' };
              return;
            }

            // Cannot request a revision once the order is terminal (a
            // concurrent completeOrder may have committed first).
            const TERMINAL = ['completed', 'cancelled', 'rejected', 'refunded'];
            if (TERMINAL.includes(order.orderStatus)) {
              serviceError = { code: 400, msg: `Cannot request revision; order is already ${order.orderStatus}.` };
              return;
            }
            // Revisions only apply to delivered work.
            if (order.orderStatus !== 'delivered') {
              serviceError = { code: 400, msg: `Revision can only be requested on a delivered order (current status: ${order.orderStatus})` };
              return;
            }

            // 5-day window from delivery.
            if (order.deliveredDate) {
              const deliveredDate = new Date(order.deliveredDate);
              const daysDifference = Math.floor((new Date() - deliveredDate) / (1000 * 60 * 60 * 24));
              if (daysDifference > 5) {
                serviceError = { code: 400, msg: 'Revision can only be requested within 5 working days of delivery' };
                return;
              }
            } else {
              serviceError = { code: 400, msg: 'Order has not been delivered yet' };
              return;
            }

            updated = await strapi.entityService.update('api::order.order', orderId, {
              data: {
                orderStatus: 'accepted',
                revisionRequestedAt: new Date(),
                revisionDeadline: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
                revisionStatus: 'requested',
              },
            });
          });
        } catch (txErr) {
          console.error('requestRevision transaction failed:', txErr);
          return ctx.internalServerError(txErr.message || 'An error occurred while requesting revision');
        }

        if (serviceError) {
          if (serviceError.code === 404) return ctx.notFound(serviceError.msg);
          if (serviceError.code === 403) return ctx.forbidden(serviceError.msg);
          return ctx.badRequest(serviceError.msg);
        }

        // Re-fetch the order for downstream side-effects (notifications, emails)
        // which expect populated relations.
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['advertiser', 'publisher'],
        });

        // Create a communication record for the revision request
        await strapi.entityService.create('api::communication.communication', {
          data: {
            message: `Revision requested: ${message}`,
            sender: user.id,
            order: orderId,
            communicationStatus: 'requested',
          }
        });

        // Create notification for publisher about revision request
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            orderId,
            order.publisher?.id,
            user.id,
            'revision_requested',
            { reason: message }
          );
        } catch (notificationError) {
          console.error('Failed to create revision requested notification:', notificationError);
          // Don't fail the revision request if notification fails
        }

        // Send email notification for revision request
        try {
          // Get the updated order with full data for email
          const fullOrder = await strapi.entityService.findOne('api::order.order', orderId, {
            populate: ['website', 'advertiser', 'publisher']
          });

          // Get publisher and advertiser user data
          const publisherUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: order.publisher?.id || order.publisher }
          });

          const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: order.advertiser?.id || order.advertiser }
          });

          if (publisherUser && advertiserUser) {
            const emailService = strapi.service('api::global.email-operations');
            await emailService.sendRevisionRequestEmail(
              { ...fullOrder, revisionMessage: message },
              publisherUser.email,
              advertiserUser.email
            );
            console.log(`Revision request emails sent for order ${orderId}`);
          }
        } catch (emailError) {
          console.error('Failed to send revision request emails:', emailError);
          // Don't fail the revision request if email fails
        }

        return {
          success: true,
          data: sanitizeOrderResponse(updated)
        };
      } catch (error) {
        console.error('Error requesting revision:', error);
        return ctx.internalServerError('An error occurred while requesting revision');
      }
    },

    // Start working on a revision (for publishers)
    async startRevision(ctx) {
      const { orderId } = ctx.params;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to start a revision');
        }

        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['publisher', 'advertiser'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Ensure user is the publisher for this order
        if (order.publisher?.id !== user.id) {
          return ctx.forbidden('Only the publisher can start working on revisions');
        }

        // Update order revision status
        const updated = await strapi.entityService.update('api::order.order', orderId, {
          data: { revisionStatus: 'in_progress' }
        });

        // Create a communication record
        await strapi.entityService.create('api::communication.communication', {
          data: {
            message: 'Working on revision',
            sender: user.id,
            order: orderId,
            communicationStatus: 'in_progress',
          }
        });

        // Create notification for advertiser about revision start
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            orderId,
            user.id,
            order.advertiser?.id,
            'revision_in_progress',
            { message: 'Publisher has started working on the revision' }
          );
        } catch (notificationError) {
          console.error('Failed to create revision in progress notification:', notificationError);
          // Don't fail the revision start if notification fails
        }

        return {
          success: true,
          data: sanitizeOrderResponse(updated)
        };
      } catch (error) {
        console.error('Error starting revision:', error);
        return ctx.internalServerError('An error occurred while starting revision');
      }
    },

    // Mark a revision as completed (for publishers)
    async completeRevision(ctx) {
      const { orderId } = ctx.params;
      const { message, deliveryProof } = ctx.request.body;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to complete a revision');
        }

        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['publisher', 'advertiser'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Ensure user is the publisher for this order
        if (order.publisher?.id !== user.id) {
          return ctx.forbidden('Only the publisher can complete revisions');
        }

        // Prepare update data
        const updateData = {
          revisionStatus: 'completed',
          orderStatus: 'delivered',
          deliveredDate: new Date()
        };

        // Add delivery proof if provided
        if (deliveryProof) {
          updateData.deliveryProof = deliveryProof;
        }

        // Add delivery message if provided
        if (message) {
          updateData.deliveryMessage = message;
        }

        // Update order revision status and order status
        const updated = await strapi.entityService.update('api::order.order', orderId, {
          data: updateData
        });

        // Create a communication record (only if the publisher wrote a message)
        const isRevision = order.orderStatus === 'delivered' || order.revisionStatus === 'requested';
        const commMessage = message
          ? `${isRevision ? 'Revision completed' : 'Delivery submitted'}: ${message}`
          : (isRevision ? 'Revision completed' : 'Delivery submitted');
        await strapi.entityService.create('api::communication.communication', {
          data: {
            message: commMessage,
            sender: user.id,
            order: orderId,
            communicationStatus: 'acceptance',
          }
        });

        // Create notification for advertiser about revision completion
        try {
          await strapi.service('api::notification.notification').createOrderNotification(
            orderId,
            user.id,
            order.advertiser?.id,
            'revision_completed'
          );
        } catch (notificationError) {
          console.error('Failed to create revision completed notification:', notificationError);
          // Don't fail the revision completion if notification fails
        }

        // Send delivery email to advertiser
        try {
          const fullOrder = await strapi.entityService.findOne('api::order.order', orderId, {
            populate: ['advertiser', 'publisher', 'website']
          });

          const advertiserUser = await strapi.db.query('plugin::users-permissions.user').findOne({
            where: { id: order.advertiser?.id || order.advertiser }
          });

          if (advertiserUser && advertiserUser.email) {
            const emailService = strapi.service('api::global.email-operations');
            console.log(`[Revision Complete] Sending delivery email to ${advertiserUser.email}`);

            // Update fullOrder with the latest delivery info
            fullOrder.deliveryProofUrl = deliveryProof;
            fullOrder.deliveryMessage = message;

            await emailService.sendOrderDeliveryEmail(
              fullOrder,
              advertiserUser.email,
              user.email
            );
            console.log(`Revision completion delivery email sent for order ${orderId}`);
          }
        } catch (emailError) {
          console.error('Failed to send revision completion delivery email:', emailError);
          // Don't fail the revision completion if email fails
        }

        return {
          success: true,
          data: sanitizeOrderResponse(updated)
        };
      } catch (error) {
        console.error('Error completing revision:', error);
        return ctx.internalServerError('An error occurred while completing revision');
      }
    },

    // Migrate existing orders to populate marketplace snapshot data
    async migrateSnapshots(ctx) {
      try {
        const user = ctx.state.user;

        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        // Check if user is an admin
        if (user.role && user.role.type !== 'admin') {
          return ctx.forbidden('Only administrators can migrate snapshots');
        }

        let migrated = 0;
        let errors = 0;
        let skipped = 0;

        console.log('Starting marketplace snapshot migration for existing orders...');

        // Find orders that don't have snapshot data yet
        const ordersToMigrate = await strapi.db.query('api::order.order').findMany({
          where: {
            websiteSnapshot: null
          },
          populate: ['website']
        });

        console.log(`Found ${ordersToMigrate.length} orders to migrate`);

        for (const order of ordersToMigrate) {
          try {
            if (!order.website || !order.website.id) {
              console.log(`Order ${order.id} has no website relation, skipping`);
              skipped++;
              continue;
            }

            // Get the current marketplace data (this is the best we can do for historical data)
            const marketplace = await strapi.db.query('api::marketplace.marketplace').findOne({
              where: { id: order.website.id }
            });

            if (!marketplace) {
              console.log(`Marketplace not found for order ${order.id}, skipping`);
              skipped++;
              continue;
            }

            // Create snapshot data
            const websiteSnapshot = {
              id: marketplace.id,
              url: marketplace.url,
              price: marketplace.price,
              link_insertion_price: marketplace.link_insertion_price,
              min_word_count: marketplace.min_word_count,
              guidelines: marketplace.guidelines,
              backlink_type: marketplace.backlink_type,
              backlink_validity: marketplace.backlink_validity,
              category: marketplace.category,
              other_category: marketplace.other_category,
              publisher_name: marketplace.publisher_name,
              publisher_email: marketplace.publisher_email,
              publisher_price: marketplace.publisher_price,
              tat: marketplace.tat,
              dofollow_link: marketplace.dofollow_link,
              fast_placement_status: marketplace.fast_placement_status,
              ahrefs_dr: marketplace.ahrefs_dr,
              ahrefs_traffic: marketplace.ahrefs_traffic,
              ahrefs_rank: marketplace.ahrefs_rank,
              moz_da: marketplace.moz_da,
              language: marketplace.language,
              countries: marketplace.countries,
              forbidden_gp_price: marketplace.forbidden_gp_price,
              forbidden_li_price: marketplace.forbidden_li_price,
              publisher_forbidden_gp_price: marketplace.publisher_forbidden_gp_price,
              publisher_forbidden_li_price: marketplace.publisher_forbidden_li_price,
              publisher_link_insertion_price: marketplace.publisher_link_insertion_price,
              semrush_authority_score: marketplace.semrush_authority_score,
              semrush_traffic: marketplace.semrush_traffic,
              spam_score: marketplace.spam_score,
              adv_crypto_pricing: marketplace.adv_crypto_pricing,
              adv_casino_pricing: marketplace.adv_casino_pricing,
              adv_cbd_pricing: marketplace.adv_cbd_pricing,
              publisher_crypto_pricing: marketplace.publisher_crypto_pricing,
              publisher_casino_pricing: marketplace.publisher_casino_pricing,
              publisher_cbd_pricing: marketplace.publisher_cbd_pricing,
              similarweb_traffic: marketplace.similarweb_traffic,
              ahrefs_referring_domain: marketplace.ahrefs_referring_domain,
              domain_zone: marketplace.domain_zone,
              only_with_us: marketplace.only_with_us,
              blacklist_status: marketplace.blacklist_status,
              sample_post: marketplace.sample_post,
              migratedAt: new Date().toISOString()
            };

            // Update the order with snapshot data
            await strapi.entityService.update('api::order.order', order.id, {
              data: {
                websiteSnapshot: websiteSnapshot,
                websiteUrl: marketplace.url,
                websitePrice: marketplace.price,
                websiteLinkInsertionPrice: marketplace.link_insertion_price,
                websiteMinWordCount: marketplace.min_word_count,
                websiteGuidelines: marketplace.guidelines,
                websiteBacklinkType: marketplace.backlink_type,
                websiteBacklinkValidity: marketplace.backlink_validity,
                websiteCategory: marketplace.category,
                websitePublisherName: marketplace.publisher_name,
                websitePublisherEmail: marketplace.publisher_email,
                websitePublisherPrice: marketplace.publisher_price,
                websiteTat: marketplace.tat,
                websiteDofollowLink: marketplace.dofollow_link,
                websiteFastPlacement: marketplace.fast_placement_status,
                websiteAhrefsDr: marketplace.ahrefs_dr,
                websiteAhrefsTraffic: marketplace.ahrefs_traffic,
                websiteMozDa: marketplace.moz_da,
                websiteLanguage: marketplace.language,
                websiteCountries: marketplace.countries
              }
            });

            migrated++;
            console.log(`Migrated snapshot data for order ${order.id}`);
          } catch (err) {
            console.error(`Error migrating snapshot for order ${order.id}:`, err);
            errors++;
          }
        }

        return {
          data: {
            migrated,
            skipped,
            errors,
            message: `Migration completed: ${migrated} orders migrated, ${skipped} skipped, ${errors} errors`
          }
        };
      } catch (error) {
        console.error('Error migrating snapshots:', error);
        return ctx.internalServerError('An error occurred while migrating snapshots');
      }
    },

    // Accept an order as complete (for advertisers)
    async finalizeOrder(ctx) {
      const { orderId } = ctx.params;

      try {
        // Get current user
        const user = ctx.state.user;
        if (!user) {
          return ctx.unauthorized('You must be logged in to accept an order');
        }

        // Check if the order exists
        const order = await strapi.entityService.findOne('api::order.order', orderId, {
          populate: ['advertiser', 'publisher'],
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Ensure user is the advertiser for this order
        if (order.advertiser?.id !== user.id) {
          return ctx.forbidden('Only the advertiser can finalize the order');
        }

        // Check if order is in a state that can be finalized
        const validStates = ['delivered'];
        if (!validStates.includes(order.orderStatus)) {
          return ctx.badRequest(`Order must be in 'delivered' status to be finalized (current status: ${order.orderStatus})`);
        }

        // Check if revision was completed (if there was a revision)
        if (order.revisionRequestedAt && order.revisionStatus && order.revisionStatus !== 'completed') {
          return ctx.badRequest('Cannot finalize order - revision is not completed yet');
        }

        try {
          // Use the order service to complete the order and handle payments
          const completedOrder = await strapi.service('api::order.order').completeOrder(orderId, user);

          // Create a final communication record
          await strapi.entityService.create('api::communication.communication', {
            data: {
              message: 'Order accepted and completed by advertiser',
              sender: user.id,
              order: orderId,
              communicationStatus: 'acceptance',
            }
          });

          // Create notification for publisher about delivery acceptance
          try {
            await strapi.service('api::notification.notification').createOrderNotification(
              orderId,
              order.publisher?.id,
              user.id,
              'delivery_accepted_by_advertiser'
            );
          } catch (notificationError) {
            console.error('Failed to create delivery accepted notification:', notificationError);
            // Don't fail the order finalization if notification fails
          }

          return {
            success: true,
            data: completedOrder,
            meta: {
              message: 'Order finalized successfully and payment processed'
            }
          };
        } catch (serviceError) {
          console.error('Service error finalizing order:', serviceError);
          return ctx.badRequest(serviceError.message || 'Error processing order finalization');
        }
      } catch (error) {
        console.error('Error finalizing order:', error);
        return ctx.internalServerError('An error occurred while finalizing the order');
      }
    },
    // Cancel an order
    async cancelOrder(ctx) {
      const { id } = ctx.params;
      const { reason } = ctx.request.body;
      const user = ctx.state.user;

      try {
        if (!user) {
          return ctx.unauthorized('Authentication required');
        }

        console.log(`[CancelOrder] User ${user.id} requesting cancellation for order ${id}`);

        // 1. Fetch order with relations
        const order = await strapi.entityService.findOne('api::order.order', id, {
          populate: ['advertiser', 'publisher', 'website']
        });

        if (!order) {
          return ctx.notFound('Order not found');
        }

        // Audit M1 fix — derive cancelledBy SERVER-SIDE from the caller's
        // identity, not from the request body. The previous code trusted
        // ctx.request.body.cancelledBy and the validateCancellation service
        // short-circuited to "allowed: true" when cancelledBy === 'system' —
        // letting any authorized caller bypass the 7-day-window /
        // ownership / status-stage rules and mask their identity in the
        // cancellation record. The 'system' value must NEVER be reachable
        // from a controller — it is reserved for cron-only direct service
        // calls.
        const isAdmin = user && user.role && (
          user.role.type === 'admin' ||
          user.role.type === 'super_admin' ||
          user.role.name === 'Admin' ||
          user.role.name === 'Administrator'
        );
        let cancelledBy;
        if (isAdmin) {
          cancelledBy = 'admin';
        } else if (order.advertiser && order.advertiser.id === user.id) {
          cancelledBy = 'advertiser';
        } else if (order.publisher && order.publisher.id === user.id) {
          cancelledBy = 'publisher';
        } else {
          return ctx.forbidden('You are not authorized to cancel this order.');
        }

        // 2. Validate cancellation permission (server-derived cancelledBy)
        const canCancel = await strapi.service('api::order.order').validateCancellation(order, user.id, cancelledBy);
        if (!canCancel.allowed) {
          return ctx.badRequest(canCancel.reason);
        }

        // Audit M7 fix — refund + status flip + audit log run in a single
        // transaction with SELECT ... FOR UPDATE on the order row. A
        // concurrent cancel/cron retry sees the post-commit state via the
        // idempotency check and returns alreadyTerminal without refunding.
        const result = await strapi.service('api::order.order').cancelOrderAtomic(id, {
          cancelledBy,
          reason,
          actorUserId: user.id,
        });

        if (result.alreadyTerminal) {
          return ctx.badRequest(`Order is already ${result.currentStatus}`);
        }

        // Side-effects AFTER the transaction commits — a notification
        // failure must not roll back the refund.
        try {
          await strapi.service('api::order.order').sendCancellationNotifications(order, cancelledBy, reason);
        } catch (e) {
          console.error('Cancellation notification failed:', e.message);
        }

        return {
          data: {
            order: sanitizeOrderResponse(result.order),
            refundAmount: result.refundAmount,
            refundedTo: result.refundedTo,
          }
        };
      } catch (error) {
        console.error('Error cancelling order:', error);
        return ctx.badRequest('Failed to cancel order');
      }
    },
  };
});
