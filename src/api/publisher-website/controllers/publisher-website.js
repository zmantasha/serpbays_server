'use strict';

/**
 * publisher-website controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { getPublisherCommissionRate } = require('../../../constants/commission');

// Fields the user is allowed to set on POST/PUT /api/publisher-websites.
// SECURITY: Anything not in this set is dropped server-side. Verification
// state, ownership, and audit fields can ONLY be mutated by their dedicated
// flows (GSC OAuth callback, admin approval, reseller-code path, etc.) —
// never by user input. Without this whitelist, a logged-in user can:
//   - POST {gscVerified:true, submissionStatus:'approved'} on create, OR
//   - PUT  {gscVerified:true, submissionStatus:'approved', gscRefreshToken:'x'}
//     on update of their own listing
// and self-promote past the verification pipeline.
// Fields the publisher is allowed to set on POST/PUT /api/publisher-websites.
// Field names match the actual schema (camelCase). SECURITY: anything not in
// this set is dropped server-side. Verification state, ownership, audit fields,
// metrics, and admin-only fields can ONLY be mutated by their dedicated flows
// (GSC OAuth callback, admin approval, reseller-code path, metrics fetcher) —
// never by user input. Without this whitelist, a logged-in user could:
//   - POST { gscVerified: true, submissionStatus: 'approved' } on create, OR
//   - PUT  { gscVerified: true, gscRefreshToken: 'x', reviewedBy: 1 } on update
// and self-promote past the verification pipeline.
const ALLOWED_USER_FIELDS = new Set([
  // Listing identity
  'url', 'protocol',
  // Verification flow — publisher chooses how they want to verify ownership.
  // The actual gscVerified=true assignment happens in the GSC OAuth callback
  // controller, NOT here.
  'verificationMethod',
  // Listing description (publisher writes)
  'description', 'guidelines', 'publicationLocation',
  // Listing metadata
  'category', 'language', 'countries', 'samplePosts',
  // Pricing — general (guest post + link insertion)
  'generalGuestPostPrice', 'generalLinkInsertionPrice',
  // Pricing — niche-specific (each niche has an Accepted flag + 2 prices)
  'casinoAccepted', 'casinoGuestPostPrice', 'casinoLinkInsertionPrice',
  'cryptoAccepted', 'cryptoGuestPostPrice', 'cryptoLinkInsertionPrice',
  'cbdAccepted', 'cbdGuestPostPrice', 'cbdLinkInsertionPrice',
  'datingAccepted', 'datingGuestPostPrice', 'datingLinkInsertionPrice',
  // Link / content characteristics
  'backlinkType', 'allowedLinks', 'backlinkValidity', 'minWordCount',
  'sponsored', 'ugc', 'isPRSite',
  // Copywriting (publisher offers an add-on)
  'doCopywriting', 'copywritingPrice',
  // Turnaround
  'expectedTATHours',
  // Reseller code is read out before the whitelist anyway, but allowed so the
  // spread-through still works.
  'resellerCode',
]);

// Workflow-progression fields the multi-step "add website" flow must advance,
// but which are too sensitive for the blanket whitelist (they gate the
// verification/approval pipeline). They are handled by a controlled transition
// in update() — NOT passed through raw — so a user still can't jump to an
// approved/verified state. Listed here so update() doesn't log them as
// "dropped restricted fields" noise.
const WORKFLOW_FIELDS = new Set(['stepCompleted', 'submissionStatus']);

// submissionStatus values a publisher may move their OWN listing into. These
// are all PRE-approval states the publisher legitimately drives through the
// submission UI. Everything else — 'approved', 'verified_pending_review',
// 'rejected', 'delisted', etc. — is reserved for the admin / GSC pipeline and
// must never be settable by user input.
const PUBLISHER_SETTABLE_STATUSES = new Set([
  'pending_verification',
  'pending_final_submission',
  'approval_pending',
]);

// ============================================================================
// Ownership helper — audit finding #5 fix
// ============================================================================
// Source of truth for row ownership is `currentPublisherId` (a user relation).
// `publisherEmail` is a legacy denormalised cache that pre-dates the relation;
// it's only meaningful when `currentPublisherId` is unset.
//
// The PRE-FIX code at update():513 and find():253/283 used `(currentPubId.id ===
// user.id) || (publisherEmail === user.email)` — the email leg fired even when
// currentPublisherId WAS set. Bad-actor user B could PUT or list rows whose
// publisherEmail happened to equal B's email (email recycle, admin email
// edit, dual-tenant fluke). Reproduced 2026-06-15: row 15, owner=263, leaked
// to / mutable by user 260.
//
// The strict rule: if currentPublisherId is set, only that user is the owner.
// The email leg is ONLY consulted for legacy unlinked rows.
// ============================================================================
function isPublisherWebsiteOwner(row, user) {
  if (!row || !user) return false;
  const rowOwnerId = row.currentPublisherId?.id ?? row.currentPublisherId ?? null;
  if (rowOwnerId != null) {
    return rowOwnerId === user.id;
  }
  // Legacy unlinked rows (no relation populated) fall back to email match.
  return Boolean(row.publisherEmail) && row.publisherEmail === user.email;
}

// $or fragment for find()/findMany Strapi queries. Same semantics:
// rows owned via currentPublisherId, OR legacy unlinked rows matching email.
function ownedByUserFilter(user) {
  return {
    $or: [
      { currentPublisherId: user.id },
      { $and: [
        { currentPublisherId: { $null: true } },
        { publisherEmail: user.email },
      ] },
    ],
  };
}

module.exports = createCoreController('api::publisher-website.publisher-website', ({ strapi }) => ({
  // Create new publisher website submission
  async create(ctx) {
    try {
      const { data } = ctx.request.body;
      const user = ctx.state.user;

      // Validate that user is authenticated
      if (!user) {
        return ctx.unauthorized('You must be logged in to submit a website.');
      }

      // Fail-closed whitelist on caller-supplied fields. Anything outside
      // ALLOWED_USER_FIELDS is silently dropped (with a log).
      const raw = data || {};
      const filteredData = {};
      const droppedKeys = [];
      for (const k of Object.keys(raw)) {
        if (ALLOWED_USER_FIELDS.has(k)) {
          filteredData[k] = raw[k];
        } else {
          droppedKeys.push(k);
        }
      }
      if (droppedKeys.length > 0) {
        strapi.log.warn(`[publisher-website.create] User ${user.id} (${user.email}) tried to set restricted fields, dropped: ${droppedKeys.join(', ')}`);
      }

      // Normalize URL to lowercase to prevent case-sensitive duplicates
      filteredData.url = filteredData.url ? filteredData.url.toLowerCase() : filteredData.url;

      // Pre-validate reseller code WITHOUT consuming it. Consumption happens
      // inside the transaction below (only if we actually take the create
      // path). Pre-validation lets us return ctx.badRequest cleanly without
      // having to throw across the transaction boundary.
      let resellerCodeData = null;
      if (filteredData.resellerCode) {
        try {
          const codeValidation = await strapi.service('api::reseller-code.reseller-code').validateCode(filteredData.resellerCode);
          if (!codeValidation.valid) {
            return ctx.badRequest(`Invalid reseller code: ${codeValidation.reason}`);
          }
          resellerCodeData = codeValidation.codeData;
        } catch (error) {
          strapi.log.error(`[publisher-website.create] reseller code validate failed: ${error && error.message}`);
          return ctx.badRequest('Failed to validate reseller code');
        }
      }

      // Race-safety: the existence-check + create sequence is NOT race-safe by
      // itself — N concurrent POSTs all see an empty findMany before any
      // insert. Audit finding #4 reproduced this with 5 concurrent calls
      // producing 5 duplicate rows. We serialize via a transaction-scoped
      // Postgres advisory lock keyed on hash(`pw_create:<userId>:<url>`).
      // Subsequent contenders wait inside the lock, then find the winner's
      // row and route through the idempotent path. Lock auto-releases at
      // transaction commit/rollback.
      const lockKey = `pw_create:${user.id}:${filteredData.url}`;

      const outcome = await strapi.db.transaction(async ({ trx }) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [lockKey]);

        // Inside the lock: existence check.
        const existingSubmission = await strapi.entityService.findMany('api::publisher-website.publisher-website', {
          filters: { url: filteredData.url, currentPublisherId: user.id },
        });

        if (existingSubmission && existingSubmission.length > 0) {
          const existing = existingSubmission[0];
          const existingStatus = existing.submissionStatus;
          // Reject duplicates against verified / approved / claimed / paused
          // rows — they must NOT be regressed by a re-POST (finding #3).
          if (!PUBLISHER_SETTABLE_STATUSES.has(existingStatus)) {
            return { action: 'conflict', existing, existingStatus };
          }
          // Idempotent return for retries on a pre-approval row.
          return { action: 'idempotent', existing, existingStatus };
        }

        // Create path: consume reseller code now (only on actual create,
        // never on retry, per finding #3). Inside the transaction so that
        // if the create below fails, the use is rolled back.
        if (resellerCodeData) {
          try {
            await strapi.service('api::reseller-code.reseller-code').useCode(filteredData.resellerCode, user.id);
          } catch (e) {
            strapi.log.error(`[publisher-website.create] reseller useCode failed: ${e && e.message}`);
            throw new Error('reseller_use_failed');
          }
        }

        const submissionData = {
          ...filteredData,
          publisherEmail: user.email,
          publisherName: user.username || user.email,
          publishedAt: new Date(),
          // Verification fields — never trust caller input here.
          gscVerified: false,
          gscVerifiedAt: null,
          gscRefreshToken: null,
          gscPermissionLevel: null,
          verificationMethod: null,
          // Ownership relations bound to JWT user.
          originalPublisherId: user.id,
          currentPublisherId: user.id,
        };
        if (resellerCodeData) {
          submissionData.addedByReseller = true;
          submissionData.resellerCode = filteredData.resellerCode;
          submissionData.submissionStatus = 'pending_final_submission';
          submissionData.stepCompleted = 2;
          submissionData.verificationMethod = 'reseller-code';
        } else {
          submissionData.addedByReseller = false;
          submissionData.submissionStatus = 'pending_verification';
        }

        const created = await strapi.entityService.create('api::publisher-website.publisher-website', {
          data: submissionData,
        });
        return { action: 'created', row: created };
      }).catch((err) => {
        if (err && err.message === 'reseller_use_failed') return { action: 'reseller_failed' };
        throw err;
      });

      // Translate the transaction outcome to an HTTP response.
      if (outcome.action === 'reseller_failed') {
        return ctx.badRequest('Failed to apply reseller code');
      }
      if (outcome.action === 'conflict') {
        strapi.log.warn(`[publisher-website.create] User ${user.id} (${user.email}) POSTed duplicate URL for already-progressed row ${outcome.existing.id} url=${filteredData.url} status=${outcome.existingStatus} — refusing 409`);
        ctx.status = 409;
        ctx.body = {
          data: null,
          error: {
            status: 409,
            name: 'ConflictError',
            message: `Website already exists at status '${outcome.existingStatus}'. Use PUT /api/publisher-websites/${outcome.existing.id} to update.`,
            details: { websiteId: outcome.existing.id, submissionStatus: outcome.existingStatus },
          },
        };
        return;
      }
      if (outcome.action === 'idempotent') {
        strapi.log.info(`[publisher-website.create] User ${user.id} POSTed duplicate URL for pre-approval row ${outcome.existing.id} url=${filteredData.url} status=${outcome.existingStatus} — returning existing without changes`);
        return { data: outcome.existing, alreadyExists: true };
      }

      // Moderation email is intentionally not sent here. Adding a website
      // just creates the record (status pending_verification or
      // pending_final_submission). The "Submitted for Moderation" email is
      // fired by the lifecycle hook when the status actually transitions to
      // approval_pending via the client's Submit for Review action.
      return { data: outcome.row };
    } catch (error) {
      console.error('Error creating publisher website submission:', error);
      return ctx.internalServerError('Failed to submit website');
    }
  },

  // Get publisher's website submissions
  async find(ctx) {
    try {
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to view your websites.');
      }

      // Extract pagination and filter parameters
      // Strapi parses nested query params like pagination[page] into ctx.query.pagination.page
      const pagination = ctx.query.pagination || {};
      const page = parseInt(pagination.page) || 1;
      const pageSize = Math.min(parseInt(pagination.pageSize) || 20, 100); // Max 100 per page
      const offset = (page - 1) * pageSize;

      // Strict ownership filter — finding #5 fix. The email leg is gated on
      // currentPublisherId being unset (legacy unlinked rows only). Without
      // this gate, user B could see user A's rows when A's row carried B's
      // email as a denormalised cache.
      const filters = {
        ...ownedByUserFilter(user),
      };

      // Add search filter if provided
      // Strapi parses filters[url][$containsi] into ctx.query.filters.url.$containsi
      if (ctx.query.filters?.url?.$containsi) {
        filters.url = { $containsi: ctx.query.filters.url.$containsi };
      }

      // Add status filter if provided
      // Strapi parses filters[submissionStatus][$eq] into ctx.query.filters.submissionStatus.$eq
      if (ctx.query.filters?.submissionStatus?.$eq) {
        filters.submissionStatus = ctx.query.filters.submissionStatus.$eq;
      }

      // Get sort parameter
      const sortParam = ctx.query.sort || 'updatedAt:desc';
      const [sortField, sortDirection] = sortParam.split(':');
      const sort = { [sortField]: sortDirection === 'asc' ? 'asc' : 'desc' };

      // Get total count for pagination (before fetching data)
      const total = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: filters
      });

      // Get approved count across ALL pages (using base user ownership
      // filters, ignoring search/status filters). Same strict ownership rule
      // as the main `filters` above — finding #5.
      const baseOwnershipFilters = {
        ...ownedByUserFilter(user),
        submissionStatus: 'approved'
      };
      const approvedCount = await strapi.db.query('api::publisher-website.publisher-website').count({
        where: baseOwnershipFilters
      });

      // Fetch paginated submissions using database query API for better performance
      // Pre-fix populated currentPublisherId + originalPublisherId as string-array
      // → full up_users row leak (password hash, withdrawalOtp, paypal_email, ...).
      // Caller is the owner — only the id is needed for downstream checks.
      const submissions = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: filters,
        orderBy: sort,
        limit: pageSize,
        offset: offset,
        populate: {
          currentPublisherId: { select: ['id'] },
          originalPublisherId: { select: ['id'] },
        },
      });

      // Attach the latest open/decided update-request per website so the
      // publisher UI can show "Update pending review" / "Update rejected: <reason>"
      // SEPARATELY from the website's own (live/approved) status. The website's
      // submissionStatus stays 'approved'; this only reflects a requested change
      // to the live listing.
      const submissionIds = submissions.map((w) => w.id);
      const latestUpdateByWebsite = new Map();
      if (submissionIds.length > 0) {
        // Find the absolute latest request per website (any status). We only
        // surface a banner when that latest is 'pending' or 'rejected' — once
        // a newer request is 'approved' or 'superseded', any earlier rejection
        // is no longer the current state and must not stay visible.
        const updateReqs = await strapi.db.query('api::website-update-request.website-update-request').findMany({
          where: { publisherWebsite: { $in: submissionIds } },
          orderBy: { createdAt: 'desc' },
          populate: ['publisherWebsite'],
        });
        for (const r of updateReqs) {
          const wid = r.publisherWebsite?.id;
          // First record per website wins (DESC order → most recent).
          if (wid && !latestUpdateByWebsite.has(wid)) {
            if (r.status === 'pending' || r.status === 'rejected') {
              latestUpdateByWebsite.set(wid, {
                status: r.status,        // 'pending' | 'rejected'
                notes: r.notes || null,  // rejection reason when rejected
                submittedAt: r.submittedAt || null,
                reviewedAt: r.reviewedAt || null,
              });
            } else {
              // Latest is 'approved' or 'superseded' — record a null sentinel
              // so older pending/rejected records for this website are skipped.
              latestUpdateByWebsite.set(wid, null);
            }
          }
        }
      }

      // Optimize order count queries - batch fetch all marketplaces at once
      const websiteUrls = submissions.map(w => w.url);
      const marketplaces = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: {
          url: { $in: websiteUrls },
          $or: [
            { publisher: user.id },
            { publisher_email: user.email }
          ]
        },
        fields: ['id', 'url']
      });

      // Create a map of URL to marketplace ID for quick lookup
      const urlToMarketplaceMap = new Map();
      marketplaces.forEach(m => {
        urlToMarketplaceMap.set(m.url, m.id);
      });

      // Batch fetch all orders for all marketplaces at once
      const marketplaceIds = Array.from(urlToMarketplaceMap.values());
      let allOrders = [];
      if (marketplaceIds.length > 0) {
        allOrders = await strapi.db.query('api::order.order').findMany({
          where: {
            website: { $in: marketplaceIds },
            orderStatus: { $in: ['completed', 'delivered', 'accepted', 'in_progress'] }
          },
          fields: ['id', 'website', 'createdAt']
        });
      }

      // Group orders by marketplace ID
      const ordersByMarketplace = new Map();
      allOrders.forEach(order => {
        const marketplaceId = order.website;
        if (!ordersByMarketplace.has(marketplaceId)) {
          ordersByMarketplace.set(marketplaceId, []);
        }
        ordersByMarketplace.get(marketplaceId).push(order);
      });

      // Process submissions with order counts
      const submissionsWithOrders = submissions.map((website) => {
        try {
          const marketplaceId = urlToMarketplaceMap.get(website.url);

          if (!marketplaceId) {
            return {
              ...website,
              orders: 0,
              resellerOrders: 0,
              originalPublisherOrders: 0
            };
          }

          const orders = ordersByMarketplace.get(marketplaceId) || [];
          const totalOrders = orders.length;

          // Get reseller vs original publisher order split
          let resellerOrders = 0;
          let originalPublisherOrders = 0;

          if (website.ownershipTransferredAt) {
            const transferDate = new Date(website.ownershipTransferredAt);

            orders.forEach(order => {
              const orderDate = new Date(order.createdAt);
              if (orderDate < transferDate) {
                resellerOrders++;
              } else {
                originalPublisherOrders++;
              }
            });
          }

          return {
            ...website,
            orders: totalOrders,
            resellerOrders: website.ownershipTransferredAt ? resellerOrders : 0,
            originalPublisherOrders: website.ownershipTransferredAt ? originalPublisherOrders : 0,
            marketplaceId: marketplaceId
          };
        } catch (error) {
          console.error(`Error processing orders for website ${website.url}:`, error);
          // Return website with zero orders if there's an error
          return {
            ...website,
            orders: 0,
            resellerOrders: 0,
            originalPublisherOrders: 0
          };
        }
      });

      // Attach the latest update-request (pending/rejected) to each website so
      // the publisher sees their requested-change status separately from the
      // live/approved listing status.
      const submissionsWithMeta = submissionsWithOrders.map((w) => ({
        ...w,
        updateRequest: latestUpdateByWebsite.get(w.id) || null,
      }));

      // Calculate pagination metadata
      const pageCount = Math.ceil(total / pageSize);

      return {
        data: submissionsWithMeta,
        meta: {
          pagination: {
            page: page,
            pageSize: pageSize,
            pageCount: pageCount,
            total: total
          },
          approvedCount: approvedCount
        }
      };
    } catch (error) {
      console.error('Error fetching publisher websites:', error);
      return ctx.internalServerError('Failed to fetch websites');
    }
  },

  // Get single publisher website by ID
  async findOne(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to view website details.');
      }

      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId <= 0) {
        return ctx.notFound('Website not found');
      }
      // Populate currentPublisherId with id-only (pre-fix returned the full
      // up_users row — password hash, withdrawalOtp, paypal_email leak).
      const website = await strapi.entityService.findOne('api::publisher-website.publisher-website', numericId, {
        populate: { currentPublisherId: { fields: ['id'] } }
      });

      if (!website) {
        return ctx.notFound('Website not found');
      }

      const isOwner = (website.currentPublisherId && website.currentPublisherId.id === user.id) ||
        (!website.currentPublisherId && website.publisherEmail === user.email);

      if (!isOwner) {
        // 404 not 403 — defeat website-id enumeration.
        return ctx.notFound('Website not found');
      }

      return { data: website };
    } catch (error) {
      console.error('Error fetching publisher website:', error);
      return ctx.internalServerError('Failed to fetch website details');
    }
  },

  // Update existing submission
  async update(ctx) {
    try {
      const { id } = ctx.params;
      const { data } = ctx.request.body;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to update a website.');
      }

      // ===================================================================
      // Audit finding #7 fix — TOCTOU on the publisher-website update path.
      // ===================================================================
      // Acquire row-level lock at the top of a transaction so that:
      //  (a) a concurrent claimOwnership that flips the row to
      //      ownership_claimed/ownership_transferred can't slip between
      //      the ownership check and the entityService.update below;
      //  (b) the "is this an approved/live listing?" decision at L660 reads
      //      FRESH state inside the lock, not the stale findOne from L553
      //      (e.g. a parallel admin pause that clears marketplaceId);
      //  (c) two simultaneous owner edits (double-click save) serialize
      //      cleanly rather than racing on lifecycle side-effects.
      // strapi.entityService calls inside this transaction inherit the trx
      // via AsyncLocalStorage, so all reads/writes below are within the
      // locked transaction.
      const txResult = await strapi.db.transaction(async ({ trx }) => {
        // Row-level exclusive lock (blocks concurrent writers on this row).
        const lockRow = await trx('publisher_websites')
          .where({ id })
          .forUpdate()
          .select('id');
        if (!lockRow || lockRow.length === 0) {
          return { httpKind: 'notFound' };
        }

        // Re-fetch under the lock — this is the FRESH state used by all
        // checks and decisions below.
        const existing = await strapi.entityService.findOne(
          'api::publisher-website.publisher-website',
          id,
          { populate: ['updateRequests', 'currentPublisherId'] }
        );

      // Strict ownership check — finding #5 fix. publisherEmail is ONLY
      // honoured when currentPublisherId is null (legacy unlinked rows).
      // See helper definition near the top of the file.
      if (!existing || !isPublisherWebsiteOwner(existing, user)) {
        return { httpKind: 'forbidden' };
      }

      // SECURITY: fail-closed whitelist on update input. The legacy code
      // only blacklisted a few relation fields, leaving gscVerified,
      // submissionStatus, verificationMethod, gscRefreshToken, etc. wide
      // open for user self-promotion past the verification pipeline.
      const rawUpdate = data || {};
      const filteredUpdate = {};
      const droppedKeys = [];
      for (const k of Object.keys(rawUpdate)) {
        if (ALLOWED_USER_FIELDS.has(k)) {
          filteredUpdate[k] = rawUpdate[k];
        } else if (!WORKFLOW_FIELDS.has(k)) {
          // Workflow fields (stepCompleted, submissionStatus) are handled by a
          // controlled transition below — not "dropped", so don't log them.
          droppedKeys.push(k);
        }
      }
      if (droppedKeys.length > 0) {
        strapi.log.warn(`[publisher-website.update] User ${user.id} (${user.email}) tried to set restricted fields on website ${id}, dropped: ${droppedKeys.join(', ')}`);
      }

      // Handle reseller code if provided in update data
      if (filteredUpdate.resellerCode) {

        // Only process if this is a NEW code (not already used for this website)
        // This prevents double-counting if user updates the website multiple times
        if (!existing.resellerCode || existing.resellerCode !== filteredUpdate.resellerCode) {

          try {
            // Validate the code

            const codeValidation = await strapi.service('api::reseller-code.reseller-code').validateCode(filteredUpdate.resellerCode);

            if (!codeValidation.valid) {
              return { httpKind: 'badRequest', message: `Invalid reseller code: ${codeValidation.reason}` };
            }

            // Use the code (increment counter)

            const useResult = await strapi.service('api::reseller-code.reseller-code').useCode(filteredUpdate.resellerCode, user.id);

          } catch (error) {
            return { httpKind: 'badRequest', message: 'Failed to validate reseller code' };
          }
        }
      }

      // Controlled workflow progression. The multi-step submission flow needs
      // to advance stepCompleted and move submissionStatus through pre-approval
      // states, but these can't be blanket-whitelisted (they gate verification
      // /approval). Apply them here under tight rules:
      //   - stepCompleted: forward-only, clamped to [1, 4] (UI progress marker)
      //   - submissionStatus: only PUBLISHER_SETTABLE_STATUSES (pre-approval);
      //     any other requested value (e.g. 'approved') is ignored + logged.
      const workflow = {};

      if (rawUpdate.stepCompleted !== undefined) {
        const requested = parseInt(rawUpdate.stepCompleted, 10);
        if (Number.isFinite(requested)) {
          const current = parseInt(existing.stepCompleted, 10) || 1;
          // never go backwards, never exceed the 4-step flow
          workflow.stepCompleted = Math.max(current, Math.min(4, Math.max(1, requested)));
        }
      }

      if (rawUpdate.submissionStatus !== undefined &&
          rawUpdate.submissionStatus !== existing.submissionStatus) {
        if (existing.submissionStatus === 'approved') {
          // Editing a LIVE (approved) listing must NOT change its status. The
          // website stays approved/live in the marketplace; the edit is captured
          // as a pending website-update-request (created below) and only goes
          // live when an admin approves that request. This keeps the publisher's
          // own listing showing as "Live" rather than flipping to "under review".
          strapi.log.info(`[publisher-website.update] Website ${id} is approved; ignoring status change to '${rawUpdate.submissionStatus}' — edit tracked as a pending update request.`);
        } else if (PUBLISHER_SETTABLE_STATUSES.has(rawUpdate.submissionStatus)) {
          workflow.submissionStatus = rawUpdate.submissionStatus;
        } else {
          strapi.log.warn(`[publisher-website.update] User ${user.id} attempted disallowed status transition '${existing.submissionStatus}' → '${rawUpdate.submissionStatus}' on website ${id}; ignored.`);
        }
      }

      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          ...filteredUpdate,
          ...workflow,
          // Publisher edits must NEVER live-sync to the marketplace. The
          // afterUpdate lifecycle auto-syncs an approved site's pricing/metrics
          // to the marketplace unless this flag is set (beforeUpdate stashes it
          // to event.state, then strips it before persisting). Without it, a
          // publisher edit would both push changes live AND create the pending
          // request below — defeating admin approval. Admins set the same flag
          // in their own controller and do their own immediate sync.
          _skipMarketplaceSync: true,
        }
      });

      // If this is an approved website being updated, queue a marketplace update request instead of updating live data
      if (existing.submissionStatus === 'approved' && existing.marketplaceId) {
        console.log('Creating pending marketplace update request for approved website...');
        try {
          const marketplaceListing = await strapi.entityService.findOne('api::marketplace.marketplace', existing.marketplaceId);

          if (marketplaceListing) {
            const fieldMap = {
              generalGuestPostPrice: 'price',
              generalLinkInsertionPrice: 'link_insertion_price',
              casinoGuestPostPrice: 'adv_casino_pricing',
              casinoLinkInsertionPrice: 'adv_li_casino_pricing',
              cryptoGuestPostPrice: 'adv_crypto_pricing',
              cryptoLinkInsertionPrice: 'adv_li_crypto_pricing',
              cbdGuestPostPrice: 'adv_cbd_pricing',
              cbdLinkInsertionPrice: 'adv_li_cbd_pricing',
              datingGuestPostPrice: 'adv_dating_pricing',
              datingLinkInsertionPrice: 'adv_li_dating_pricing',
              expectedTATHours: 'tat',
              minWordCount: 'min_word_count',
              backlinkType: 'backlink_type',
              backlinkValidity: 'backlink_validity',
              countries: 'countries',
              language: 'language',
              category: 'category',
              guidelines: 'guidelines',
              description: 'description',
              publicationLocation: 'publication_location',
              sponsored: 'sponsored',
              ugc: 'ugc',
              copywritingPrice: 'publisher_writing_price'
            };

            const changes = {};
            const baseSnapshot = {};

            Object.entries(fieldMap).forEach(([publisherField, marketplaceField]) => {
              const publisherValue = updated[publisherField];
              const liveValue = marketplaceListing[marketplaceField];

              const normalise = (value) => {
                if (Array.isArray(value)) {
                  return JSON.stringify([...value].sort());
                }
                if (typeof value === 'object' && value !== null) {
                  return JSON.stringify(value);
                }
                return value;
              };

              if (normalise(publisherValue) !== normalise(liveValue)) {
                baseSnapshot[marketplaceField] = liveValue;
                changes[marketplaceField] = publisherField === 'expectedTATHours'
                  ? Math.ceil((publisherValue || 0) / 24)
                  : publisherValue;
              }
            });

            if (Object.prototype.hasOwnProperty.call(changes, 'tat')) {
              const tatDays = changes.tat || 0;
              baseSnapshot.placement_speed = marketplaceListing.placement_speed;
              changes.placement_speed = tatDays <= 3 ? 'Fast' : tatDays <= 7 ? 'Normal' : 'Slow';
            }

            if (Object.keys(changes).length > 0) {
              const pendingRequest = await strapi.entityService.create('api::website-update-request.website-update-request', {
                data: {
                  status: 'pending',
                  source: 'publisher',
                  marketplace: marketplaceListing.id,
                  publisherWebsite: updated.id,
                  submittedBy: user.email,
                  submittedAt: new Date(),
                  baseSnapshot,
                  changes,
                  dataVersion: marketplaceListing.dataVersion || 0
                }
              });

              // Supersede any older pending requests for the same marketplace.
              // updateMany can't filter on a relation directly, so resolve the
              // older pending IDs first, then update them by primary key.
              const olderPending = await strapi.db.query('api::website-update-request.website-update-request').findMany({
                where: {
                  marketplace: { id: marketplaceListing.id },
                  status: 'pending',
                  id: { $ne: pendingRequest.id }
                },
                select: ['id']
              });
              if (olderPending.length > 0) {
                await strapi.db.query('api::website-update-request.website-update-request').updateMany({
                  where: { id: { $in: olderPending.map((r) => r.id) } },
                  data: {
                    status: 'superseded',
                    notes: 'Superseded by newer publisher update'
                  }
                });
              }
            } else {
              console.log('No tracked marketplace fields were changed by publisher update.');
            }
          }
        } catch (marketplaceError) {
          console.error('Failed to queue marketplace update request:', marketplaceError);
          // Continue without failing the publisher update
        }
      }

        return { httpKind: 'ok', updated };
      });

      // Translate the transaction outcome into HTTP responses. The lock is
      // released (commit/rollback) before this point.
      if (!txResult || txResult.httpKind === 'notFound') {
        return ctx.notFound('Website not found');
      }
      if (txResult.httpKind === 'forbidden') {
        return ctx.forbidden('You can only update your own website submissions.');
      }
      if (txResult.httpKind === 'badRequest') {
        return ctx.badRequest(txResult.message || 'Update failed');
      }
      return { data: txResult.updated };
    } catch (error) {
      console.error('Error updating publisher website:', error);
      return ctx.internalServerError('Failed to update website');
    }
  },

  // Admin action: Approve website submission
  async approve(ctx) {
    try {
      console.log('=== APPROVAL PROCESS STARTED ===');
      const { id } = ctx.params;
      const user = ctx.state.user;
      console.log('Approving submission ID:', id);
      console.log('User:', user?.email || 'No user found');

      // Check if user is admin (flexible admin role checking)
      console.log('User role structure:', JSON.stringify(user?.role, null, 2));
      const isAdmin = user && user.role && (
        user.role.type === 'admin' ||
        user.role.type === 'super_admin'
      );

      if (!isAdmin) {
        console.log('Access denied. User role:', user?.role);
        return ctx.forbidden('Only administrators can approve websites.');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });
      console.log('Found submission:', submission?.url || 'No submission found');

      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      // CRITICAL: Check if publisher is linked BEFORE approving
      // Get publisher ID from relation or try to look up by email
      let publisherId = submission.currentPublisherId?.id || submission.currentPublisherId;

      if (!publisherId && submission.publisherEmail) {
        // Try to find user by email
        const userByEmail = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { email: submission.publisherEmail }
        });
        if (userByEmail) {
          publisherId = userByEmail.id;
          // Update the submission with the found publisher ID
          await strapi.entityService.update('api::publisher-website.publisher-website', id, {
            data: { currentPublisherId: publisherId }
          });
          console.log(`[Approve] Linked publisher ${publisherId} from email ${submission.publisherEmail}`);
        }
      }

      if (!publisherId) {
        return ctx.badRequest(`Cannot approve website: No valid publisher account found for ${submission.url}. Publisher must register first.`);
      }

      // CRITICAL: Refuse to approve a website with no pricing set.
      // createMarketplaceListing will happily create a listing with all NULL
      // prices (line ~906 — "If price is not provided, keep as null"). A
      // null-price listing is filtered out of the marketplace, so the website
      // would be "approved" but invisible to advertisers — a useless half-state.
      // Require the publisher to set at least one price before approval.
      const priceFields = [
        ['generalGuestPostPrice', submission.generalGuestPostPrice],
        ['generalLinkInsertionPrice', submission.generalLinkInsertionPrice],
        ['casinoGuestPostPrice', submission.casinoGuestPostPrice],
        ['casinoLinkInsertionPrice', submission.casinoLinkInsertionPrice],
        ['cryptoGuestPostPrice', submission.cryptoGuestPostPrice],
        ['cryptoLinkInsertionPrice', submission.cryptoLinkInsertionPrice],
        ['cbdGuestPostPrice', submission.cbdGuestPostPrice],
        ['cbdLinkInsertionPrice', submission.cbdLinkInsertionPrice],
        ['datingGuestPostPrice', submission.datingGuestPostPrice],
        ['datingLinkInsertionPrice', submission.datingLinkInsertionPrice],
      ];
      const presentPrices = priceFields.filter(([_, v]) => Number(v) > 0);
      if (presentPrices.length === 0) {
        strapi.log.warn(
          `[approve] Refused to approve website ${id} (${submission.url}) — no pricing set. Admin: ${user?.email}.`
        );
        return ctx.badRequest(
          `Cannot approve website: at least one price must be set (general / casino / crypto / cbd / dating — guest post or link insertion). Ask the publisher to fill in pricing before approving.`
        );
      }

      // Update submission status to approved
      const approved = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'approved',
          reviewedAt: new Date(),
          reviewedBy: user?.email || 'system',
          reviewNotes: ctx.request.body.reviewNotes || 'Approved by admin',
          approvedAt: new Date()
        }
      });

      // Create marketplace entry
      // Use the original 'submission' which has currentPublisherId populated, not 'approved'
      try {
        const marketplaceListing = await this.createMarketplaceListing(submission);
        console.log(`Website ${submission.url} approved and marketplace listing created (ID: ${marketplaceListing?.id})`);

        // Send approval email notification
        try {
          const emailService = strapi.service('api::global.email-operations');
          await emailService.sendWebsiteStatusEmail({
            publisherEmail: submission.publisherEmail,
            publisherName: submission.publisherName || submission.publisherEmail,
            websiteName: submission.url,
            websiteUrl: submission.url,
            actionType: 'Approved and Live',
            notes: ctx.request.body.reviewNotes || ''
          });
        } catch (emailError) {
          console.error('[EMAIL] Failed to send website approval email:', emailError.message);
        }

        return { data: approved, message: 'Website approved and added to marketplace' };
      } catch (marketplaceError) {
        console.error('Failed to create marketplace listing:', marketplaceError);

        // Revert approval status since marketplace creation failed
        await strapi.entityService.update('api::publisher-website.publisher-website', id, {
          data: {
            submissionStatus: 'verified_pending_review',  // Revert to pending review
            reviewNotes: `Marketplace creation failed: ${marketplaceError.message}`
          }
        });

        return ctx.badRequest(`Website approval failed: ${marketplaceError.message}`);
      }
    } catch (error) {
      console.error('Error approving website:', error);
      console.error('Error details:', error.message);
      console.error('Error stack:', error.stack);
      return ctx.internalServerError('Failed to approve website');
    }
  },

  // Admin action: Reject website submission
  async reject(ctx) {
    try {
      const { id } = ctx.params;
      const { rejectionReason } = ctx.request.body;
      const user = ctx.state.user;

      const isAdmin = user && user.role && (
        user.role.type === 'admin' ||
        user.role.type === 'super_admin'
      );

      if (!isAdmin) {
        return ctx.forbidden('Only administrators can reject websites.');
      }

      if (!rejectionReason) {
        return ctx.badRequest('Rejection reason is required');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);

      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      // GUARD: don't reject an already-approved (LIVE) website — that creates a
      // "rejected-but-live" divergence. Reject a publisher's EDIT via the
      // Pending Updates queue (update-request reject); pause/delist to take a
      // live site down.
      if (submission.submissionStatus === 'approved') {
        return ctx.badRequest(
          'This website is already live (approved). To reject a publisher’s pending edit, use Pending Updates. To take the live listing down, pause or delist it instead.'
        );
      }

      const rejected = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'rejected',
          reviewedAt: new Date(),
          reviewedBy: user.email,
          rejectionReason,
          reviewNotes: ctx.request.body.reviewNotes || ''
        }
      });

      // Send rejection email notification
      try {
        const emailService = strapi.service('api::global.email-operations');
        await emailService.sendWebsiteStatusEmail({
          publisherEmail: submission.publisherEmail,
          publisherName: submission.publisherName || submission.publisherEmail,
          websiteName: submission.url,
          websiteUrl: submission.url,
          actionType: 'Rejected',
          notes: rejectionReason
        });
      } catch (emailError) {
        console.error('[EMAIL] Failed to send website rejection email:', emailError.message);
      }

      return { data: rejected, message: 'Website rejected' };
    } catch (error) {
      console.error('Error rejecting website:', error);
      return ctx.internalServerError('Failed to reject website');
    }
  },

  // Admin action: Request changes to submission
  async requestChanges(ctx) {
    try {
      const { id } = ctx.params;
      const { changeRequests, reviewNotes } = ctx.request.body;
      const user = ctx.state.user;

      const isAdmin = user && user.role && (
        user.role.type === 'admin' ||
        user.role.type === 'super_admin'
      );

      if (!isAdmin) {
        return ctx.forbidden('Only administrators can request changes.');
      }

      if (!changeRequests) {
        return ctx.badRequest('Change requests are required');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);

      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'requires_changes',
          reviewedAt: new Date(),
          reviewedBy: user.email,
          changeRequests,
          reviewNotes: reviewNotes || ''
        }
      });

      // TODO: Send change request email notification

      return { data: updated, message: 'Change requests sent to publisher' };
    } catch (error) {
      console.error('Error requesting changes:', error);
      return ctx.internalServerError('Failed to request changes');
    }
  },

  // Admin action: Mark submission as under review
  async markUnderReview(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      const isAdmin = user && user.role && (
        user.role.type === 'admin' ||
        user.role.type === 'super_admin'
      );

      if (!isAdmin) {
        return ctx.forbidden('Only administrators can update review status.');
      }

      const submission = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);

      if (!submission) {
        return ctx.notFound('Submission not found');
      }

      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'under_review',
          reviewStartedAt: new Date(),
          reviewedBy: user.email,
          reviewNotes: ctx.request.body.reviewNotes || 'Under detailed review'
        }
      });

      return { data: updated, message: 'Submission marked as under review' };
    } catch (error) {
      console.error('Error marking under review:', error);
      return ctx.internalServerError('Failed to update review status');
    }
  },



  // Helper function: Create marketplace listing from approved submission
  async createMarketplaceListing(submission) {
    try {
      console.log('Creating marketplace listing for submission:', submission.url);

      // Check if marketplace listing already exists
      const existingListing = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: {
          url: submission.url
        }
      });

      // Helper function to convert enumeration values to human-readable format
      const convertBacklinkValidity = (value) => {
        const validityMap = {
          'one_year': '1 Year',
          'three_years': '3 Years',
          'five_years': '5 Years',
          'lifetime': 'Lifetime'
        };
        return validityMap[value] || 'Lifetime';
      };

      // Platform commission share — env-configurable via PUBLISHER_COMMISSION_RATE
      // (default 1.0 = publisher gets 100%). The publisher_* payout fields
      // below all multiply the advertiser price by this rate.
      const COMMISSION_RATE = getPublisherCommissionRate();

      // Extract publisher info BEFORE creating the marketplaceData object
      // Handle both populated object and raw ID for currentPublisherId
      const publisherUser = submission.currentPublisherId;
      let publisherId = typeof publisherUser === 'object' && publisherUser !== null
        ? publisherUser.id
        : publisherUser;

      // CRITICAL: Ensure we have a valid publisher ID
      // If no publisherId from currentPublisherId, try to look up by email
      if (!publisherId && submission.publisherEmail) {
        const userByEmail = await strapi.db.query('plugin::users-permissions.user').findOne({
          where: { email: submission.publisherEmail }
        });
        if (userByEmail) {
          publisherId = userByEmail.id;
          console.log(`[createMarketplaceListing] Linked publisher ${publisherId} from email ${submission.publisherEmail}`);
        }
      }

      // If still no publisher ID, reject the listing
      if (!publisherId) {
        throw new Error(`Cannot create marketplace listing: No valid publisher account found for ${submission.url}. Publisher email: ${submission.publisherEmail || 'not provided'}`);
      }

      const publisherEmailValue = (typeof publisherUser === 'object' && publisherUser !== null)
        ? publisherUser.email
        : submission.publisherEmail;
      const publisherNameValue = (typeof publisherUser === 'object' && publisherUser !== null)
        ? publisherUser.username
        : (submission.publisherName || submission.publisherEmail?.split('@')[0]);

      // Map publisher-website fields to marketplace fields.
      // marketplace.price + publisher_price are schema-required (min:0). Storing
      // null on those fails create-validation silently — that's why listings
      // with GP=0 + LI>0 never got a marketplace row. Default required price
      // fields to 0 (visibility filter uses $gt:0, so the row still won't
      // show as a GP option, but LI > 0 still surfaces it via the OR).
      // Optional price columns (link_insertion_price, sensitive categories)
      // remain nullable.
      const marketplaceData = {
        url: submission.url,

        // ADVERTISER PRICING (what publisher entered - this is what advertisers pay)
        price: submission.generalGuestPostPrice > 0 ? submission.generalGuestPostPrice : 0,
        link_insertion_price: submission.generalLinkInsertionPrice > 0 ? submission.generalLinkInsertionPrice : null,
        adv_casino_pricing: submission.casinoGuestPostPrice > 0 ? submission.casinoGuestPostPrice : null,
        adv_li_casino_pricing: submission.casinoLinkInsertionPrice > 0 ? submission.casinoLinkInsertionPrice : null,
        adv_crypto_pricing: submission.cryptoGuestPostPrice > 0 ? submission.cryptoGuestPostPrice : null,
        adv_li_crypto_pricing: submission.cryptoLinkInsertionPrice > 0 ? submission.cryptoLinkInsertionPrice : null,
        adv_cbd_pricing: submission.cbdGuestPostPrice > 0 ? submission.cbdGuestPostPrice : null,
        adv_li_cbd_pricing: submission.cbdLinkInsertionPrice > 0 ? submission.cbdLinkInsertionPrice : null,
        adv_dating_pricing: submission.datingGuestPostPrice > 0 ? submission.datingGuestPostPrice : null,
        adv_li_dating_pricing: submission.datingLinkInsertionPrice > 0 ? submission.datingLinkInsertionPrice : null,

        // PUBLISHER EARNINGS = advertiser price × PUBLISHER_COMMISSION_RATE.
        // publisher_price is schema-required (min:0); default to 0 when neither
        // GP nor LI is positive (rather than null, which would fail validation
        // and abort the marketplace create).
        publisher_price: (submission.generalGuestPostPrice > 0 || submission.generalLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.generalGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.generalLinkInsertionPrice || 0) * COMMISSION_RATE
          )) || 1
          : 0,
        publisher_link_insertion_price: submission.generalLinkInsertionPrice > 0
          ? Math.floor(submission.generalLinkInsertionPrice * COMMISSION_RATE)
          : null,

        // Publisher earnings for sensitive categories
        publisher_casino_pricing: (submission.casinoGuestPostPrice > 0 || submission.casinoLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.casinoGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.casinoLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,
        publisher_crypto_pricing: (submission.cryptoGuestPostPrice > 0 || submission.cryptoLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.cryptoGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.cryptoLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,
        publisher_cbd_pricing: (submission.cbdGuestPostPrice > 0 || submission.cbdLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.cbdGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.cbdLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,
        publisher_dating_pricing: (submission.datingGuestPostPrice > 0 || submission.datingLinkInsertionPrice > 0)
          ? Math.floor(Math.max(
            (submission.datingGuestPostPrice || 0) * COMMISSION_RATE,
            (submission.datingLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
          : null,

        // Publisher earnings for specific Link Insertion sensitive categories
        publisher_li_casino_pricing: submission.casinoLinkInsertionPrice > 0
          ? Math.floor(submission.casinoLinkInsertionPrice * COMMISSION_RATE)
          : null,
        publisher_li_crypto_pricing: submission.cryptoLinkInsertionPrice > 0
          ? Math.floor(submission.cryptoLinkInsertionPrice * COMMISSION_RATE)
          : null,
        publisher_li_cbd_pricing: submission.cbdLinkInsertionPrice > 0
          ? Math.floor(submission.cbdLinkInsertionPrice * COMMISSION_RATE)
          : null,
        publisher_li_dating_pricing: submission.datingLinkInsertionPrice > 0
          ? Math.floor(submission.datingLinkInsertionPrice * COMMISSION_RATE)
          : null,

        min_word_count: submission.minWordCount,
        backlink_type: submission.backlinkType,
        category: Array.isArray(submission.category) ? submission.category : [submission.category].filter(Boolean), // Handle both array and string
        guidelines: submission.guidelines,
        description: submission.description, // Website description
        publication_location: submission.publicationLocation, // Where article will be published
        backlink_validity: convertBacklinkValidity(submission.backlinkValidity),
        // Use the pre-extracted publisher values
        publisher_name: publisherNameValue,
        publisher_email: publisherEmailValue,
        // Map the immutable User ID relation
        publisher: publisherId, // Always required - validation above ensures this exists

        // Map new content options
        sponsored: submission.sponsored,
        ugc: submission.ugc,
        digital_pr: submission.isPRSite,
        publisher_writing_price: submission.copywritingPrice > 0 ? submission.copywritingPrice : null,

        // Map delivery and samples
        tat: Math.ceil(submission.expectedTATHours / 24), // Convert hours to days
        placement_speed: submission.expectedTATHours <= 72 ? 'Fast' : 'Normal',
        sample_links: JSON.stringify(submission.samplePosts || []), // Convert array to JSON string

        // Existing fields
        countries: submission.countries,
        language: Array.isArray(submission.language) ? submission.language : [submission.language].filter(Boolean), // Handle both array and string
        website_status: 'active',
        status: 'active', // Default status for new marketplace listings
        publishedAt: new Date(), // Ensure published when created
        approvalStatus: 'approved', // Ensure approved when created
        gsc_verified: submission.gscVerified || false,
        gsc_verified_at: submission.gscVerifiedAt,
        gsc_permission_level: submission.gscPermissionLevel
      };

      // Clean up undefined values before sending to Strapi
      Object.keys(marketplaceData).forEach(key => {
        if (marketplaceData[key] === undefined) {
          delete marketplaceData[key];
        }
      });

      if (existingListing && existingListing.length > 0) {
        console.log('Updating existing marketplace listing:', existingListing[0].id);
        console.log('New pricing data:', {
          price: marketplaceData.price,
          link_insertion_price: marketplaceData.link_insertion_price,
          adv_casino_pricing: marketplaceData.adv_casino_pricing,
          adv_crypto_pricing: marketplaceData.adv_crypto_pricing,
          publisher_price: marketplaceData.publisher_price,
          publisher_casino_pricing: marketplaceData.publisher_casino_pricing
        });

        // Ensure publishedAt and approvalStatus are set when updating
        marketplaceData.publishedAt = existingListing[0].publishedAt || new Date();
        marketplaceData.approvalStatus = existingListing[0].approvalStatus || 'approved';

        // Update existing listing using database query API for reliability
        const updated = await strapi.db.query('api::marketplace.marketplace').update({
          where: { id: existingListing[0].id },
          data: marketplaceData
        });

        console.log('Marketplace updated successfully with new pricing');
        console.log('Updated marketplace data:', {
          id: updated.id,
          url: updated.url,
          price: updated.price,
          link_insertion_price: updated.link_insertion_price,
          publishedAt: updated.publishedAt,
          approvalStatus: updated.approvalStatus
        });

        // Verify the update was applied
        const verified = await strapi.db.query('api::marketplace.marketplace').findOne({
          where: { id: existingListing[0].id }
        });

        if (verified) {
          console.log('Verification - Marketplace after update:', {
            id: verified.id,
            price: verified.price,
            link_insertion_price: verified.link_insertion_price,
            adv_casino_pricing: verified.adv_casino_pricing,
            adv_crypto_pricing: verified.adv_crypto_pricing,
            adv_cbd_pricing: verified.adv_cbd_pricing
          });

          if (marketplaceData.price !== undefined && verified.price !== marketplaceData.price) {
            console.warn('⚠️ PRICE MISMATCH after update!', {
              expected: marketplaceData.price,
              actual: verified.price,
              marketplaceId: verified.id
            });
          }
        }

        // Store marketplace ID in publisher-website submission
        await strapi.entityService.update('api::publisher-website.publisher-website', submission.id, {
          data: { marketplaceId: updated.id }
        });

        return updated;
      } else {
        console.log('Creating new marketplace listing');
        // Create new marketplace listing
        const created = await strapi.entityService.create('api::marketplace.marketplace', {
          data: marketplaceData
        });

        // Store marketplace ID in publisher-website submission
        await strapi.entityService.update('api::publisher-website.publisher-website', submission.id, {
          data: { marketplaceId: created.id }
        });

        console.log('Successfully created marketplace listing with ID:', created.id);
        return created;
      }
    } catch (error) {
      console.error('Error creating marketplace listing:', error);
      console.error('Error details:', error.message);
      console.error('Submission data:', JSON.stringify(submission, null, 2));
      throw error;
    }
  },

  // NOTE: the canonical async delete() handler lives further down in this
  // module (search for "Delete publisher website" comment block). A duplicate
  // declaration that USED to live here at L1330 was dead code per JS object-
  // literal duplicate-key rules — see audit finding #2 (resolved 2026-06-15).

  // Pause/Resume listing
  async pauseListing(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to manage your listings.');
      }

      // Check if this submission belongs to the user and is approved
      const existing = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });

      // Check ownership: prefer userId, fallback to email for legacy records
      const isOwner = existing && (
        (existing.currentPublisherId && existing.currentPublisherId.id === user.id) ||
        (!existing.currentPublisherId && existing.publisherEmail === user.email)
      );

      if (!existing || !isOwner) {
        return ctx.forbidden('You can only manage your own website listings.');
      }

      if (existing.submissionStatus !== 'approved') {
        return ctx.badRequest('Only approved websites can be paused.');
      }

      // Update to paused status
      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'listing_paused',
          pausedAt: new Date()
        }
      });

      // Also update marketplace listing if it exists
      if (existing.marketplaceId) {
        try {
          await strapi.entityService.update('api::marketplace.marketplace', existing.marketplaceId, {
            data: {
              status: 'paused'
            }
          });
          console.log('✅ Marketplace listing paused successfully');
        } catch (marketplaceError) {
          console.error('⚠️ Failed to pause marketplace listing:', marketplaceError);
          // Don't fail the operation if marketplace update fails
        }
      }

      return {
        data: updated,
        message: 'Listing paused successfully. You will not receive new guest post orders.'
      };
    } catch (error) {
      console.error('Error pausing listing:', error);
      return ctx.internalServerError('Failed to pause listing');
    }
  },

  async resumeListing(ctx) {
    try {
      const { id } = ctx.params;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to manage your listings.');
      }

      // Check if this submission belongs to the user and is paused
      const existing = await strapi.entityService.findOne('api::publisher-website.publisher-website', id, {
        populate: ['currentPublisherId']
      });

      // Check ownership: prefer userId, fallback to email for legacy records
      const isOwner = existing && (
        (existing.currentPublisherId && existing.currentPublisherId.id === user.id) ||
        (!existing.currentPublisherId && existing.publisherEmail === user.email)
      );

      if (!existing || !isOwner) {
        return ctx.forbidden('You can only manage your own website listings.');
      }

      if (existing.submissionStatus !== 'listing_paused') {
        return ctx.badRequest('Only paused listings can be resumed.');
      }

      // Update to approved status (resume)
      const updated = await strapi.entityService.update('api::publisher-website.publisher-website', id, {
        data: {
          submissionStatus: 'approved',
          resumedAt: new Date()
        }
      });

      // Also update marketplace listing if it exists
      if (existing.marketplaceId) {
        try {
          await strapi.entityService.update('api::marketplace.marketplace', existing.marketplaceId, {
            data: {
              status: 'active'
            }
          });
          console.log('✅ Marketplace listing resumed successfully');
        } catch (marketplaceError) {
          console.error('⚠️ Failed to resume marketplace listing:', marketplaceError);
          // Don't fail the operation if marketplace update fails
        }
      }

      return {
        data: updated,
        message: 'Listing resumed successfully. You can now receive new guest post orders.'
      };
    } catch (error) {
      console.error('Error resuming listing:', error);
      return ctx.internalServerError('Failed to resume listing');
    }
  },

  /**
   * Handle ownership claim for existing website
   * POST /api/publisher-websites/claim/:id
   */
  async claimOwnership(ctx) {
    try {
      const { id } = ctx.params;
      const { data } = ctx.request.body;
      const user = ctx.state.user;

      if (!user) {
        return ctx.unauthorized('You must be logged in to claim ownership.');
      }

      // Cheap pre-check (no lock yet) to short-circuit obviously-bad inputs.
      const preCheck = await strapi.entityService.findOne('api::publisher-website.publisher-website', id);
      if (!preCheck) {
        return ctx.notFound('Website not found');
      }

      // Fail-closed whitelist on caller-supplied fields (mirrors create()
      // and update()). Without this, the claimant can splat arbitrary
      // columns — addedByReseller, reviewedBy, ahrefs_*, gscRefreshToken,
      // etc. — into the new row by including them in the POST body.
      const rawClaim = data || {};
      const filteredClaim = {};
      const droppedClaimKeys = [];
      for (const k of Object.keys(rawClaim)) {
        if (ALLOWED_USER_FIELDS.has(k)) {
          filteredClaim[k] = rawClaim[k];
        } else {
          droppedClaimKeys.push(k);
        }
      }
      if (droppedClaimKeys.length > 0) {
        strapi.log.warn(`[publisher-website.claim] User ${user.id} (${user.email}) tried to set restricted fields, dropped: ${droppedClaimKeys.join(', ')}`);
      }

      const gscHelpers = require('../../../utils/gsc-helpers');

      // Track a consumed proof so we can re-record it if the transaction
      // rolls back (closures across the strapi.db.transaction boundary).
      let consumedProofForRollback = null;
      // ===================================================================
      // Audit finding #7 fix — TOCTOU race on the original row.
      // ===================================================================
      // Pre-fix: findOne → idempotency check → ownerHasGscProof check →
      // proof consume → create + update all ran without holding a row-level
      // lock. Two concurrent claimants both passed the "already claimed?"
      // check, both created new rows, both wrote claimedBy/newOwnerWebsiteId
      // → last writer won, the loser's claim row was orphaned (verified
      // 2026-06-15: 2 claims → 2 rows + 1 orphan).
      //
      // Fix: acquire SELECT … FOR UPDATE on the original row at the very
      // top of a single transaction, re-fetch fresh state inside the lock,
      // re-run every state-dependent check on that fresh state, then
      // create + update — all atomically. Concurrent contenders block on
      // the lock; when they wake, they see the post-claim state and route
      // through the idempotency / already-claimed-by-other branches.
      //
      // Proof handling: consume INSIDE the transaction (so it's only
      // consumed when we actually proceed). On transaction failure the
      // catch re-records the proof so the user can retry without redoing
      // Google OAuth. Concurrent same-user double-clicks are handled by
      // the idempotency branch on the second pass through the lock.
      let outcome;
      try {
        outcome = await strapi.db.transaction(async ({ trx }) => {
          // Row-level exclusive lock. Holds until commit/rollback.
          // strapi.entityService.findOne does NOT use this connection
          // (Strapi 5's AsyncLocalStorage tracking IS supposed to thread
          // the trx, but to guarantee the lock we issue an explicit
          // forUpdate select first). Concurrent transactions targeting
          // the same row.id will block here.
          const lockRow = await trx('publisher_websites')
            .where({ id })
            .forUpdate()
            .select('id', 'url', 'submission_status', 'publisher_email');
          if (!lockRow || lockRow.length === 0) {
            return { action: 'notFound' };
          }

          // Re-fetch the full row with relations populated under the lock.
          const existingWebsite = await strapi.entityService.findOne(
            'api::publisher-website.publisher-website',
            id,
            { populate: ['currentPublisherId', 'originalPublisherId', 'claimedBy'] }
          );
          if (!existingWebsite) return { action: 'notFound' };

          // Re-check ownership on the FRESH row state.
          const isAlreadyOwner =
            (existingWebsite.currentPublisherId && existingWebsite.currentPublisherId.id === user.id) ||
            (!existingWebsite.currentPublisherId && existingWebsite.publisherEmail === user.email);
          if (isAlreadyOwner) {
            return { action: 'alreadyOwner' };
          }

          // Idempotency: this user already claimed it (double-click retry).
          const existingClaimerId = existingWebsite.claimedBy?.id ?? existingWebsite.claimedBy ?? null;
          if (existingClaimerId === user.id && existingWebsite.newOwnerWebsiteId) {
            const existingClaim = await strapi.entityService.findOne(
              'api::publisher-website.publisher-website',
              existingWebsite.newOwnerWebsiteId
            );
            if (existingClaim && existingClaim.submissionStatus === 'approval_pending') {
              return { action: 'idempotent', existingWebsite, existingClaim };
            }
          }

          // NEW (finding #7): if the row is already claimed by SOMEONE ELSE,
          // refuse with 409. This is the race-loser branch — the lock made
          // it block until the winner committed; now it sees the post-claim
          // state and bails cleanly.
          if (existingClaimerId && existingClaimerId !== user.id) {
            return { action: 'alreadyClaimedByOther', byUserId: existingClaimerId, existingWebsite };
          }
          if (existingWebsite.submissionStatus === 'ownership_claimed' ||
              existingWebsite.submissionStatus === 'ownership_transferred') {
            return { action: 'alreadyClaimedByOther', byUserId: existingClaimerId, existingWebsite };
          }

          // GSC verification gates (re-checked under the lock so a parallel
          // GSC callback that just stamped gscVerified=true on the original
          // row is observed correctly).
          const sameUserAlreadyVerified =
            existingWebsite.gscVerified === true &&
            existingWebsite.currentPublisherId &&
            existingWebsite.currentPublisherId.id === user.id;
          const ownerHasGscProof =
            existingWebsite.gscVerified === true &&
            existingWebsite.verificationMethod === 'google-search-console' &&
            existingWebsite.currentPublisherId &&
            existingWebsite.currentPublisherId.id !== user.id;
          if (ownerHasGscProof) {
            return { action: 'ownerGscProof', existingWebsite };
          }

          // Consume the cross-account proof. On a transaction rollback the
          // outer catch re-records it. Concurrent same-user double-clicks
          // serialize on the lock; the second pass through the lock hits
          // the idempotency branch above (the first claim is now visible).
          const proof = gscHelpers.consumeCrossAccountProof(user.id, existingWebsite.url);
          if (!proof && !sameUserAlreadyVerified) {
            return { action: 'noProof', existingWebsite };
          }
          if (proof) consumedProofForRollback = { ...proof, websiteUrl: existingWebsite.url };
          const claimPermissionLevel = proof?.gscPermissionLevel
            || existingWebsite.gscPermissionLevel
            || 'siteOwner';
          const gscVerifiedAtStamp = proof?.verifiedAt
            ? new Date(proof.verifiedAt).toISOString()
            : new Date().toISOString();

          const newOwnerWebsiteData = {
            ...filteredClaim,
            url: existingWebsite.url,
            publisherEmail: user.email,
            publisherName: user.username || user.email.split('@')[0],
            originalWebsiteId: existingWebsite.id,
            claimedFrom: existingWebsite.publisherEmail,
            claimedAt: new Date().toISOString(),
            ownershipTransferReason: 'claimed_by_owner',
            originalPublisherId: existingWebsite.currentPublisherId || null,
            currentPublisherId: user.id,
            verificationMethod: 'google-search-console',
            gscVerified: true,
            gscVerifiedAt: gscVerifiedAtStamp,
            gscPermissionLevel: claimPermissionLevel,
            submissionStatus: 'approval_pending',
            stepCompleted: 4,
            submittedForReviewAt: new Date().toISOString(),
          };

          const created = await strapi.entityService.create(
            'api::publisher-website.publisher-website',
            { data: newOwnerWebsiteData }
          );
          await strapi.entityService.update(
            'api::publisher-website.publisher-website',
            id,
            {
              data: {
                submissionStatus: 'ownership_claimed',
                claimedBy: user.id,
                claimedAt: new Date().toISOString(),
                newOwnerWebsiteId: created.id,
              },
            }
          );

          return { action: 'created', proof, created, existingWebsite };
        });
      } catch (txErr) {
        if (consumedProofForRollback) {
          try {
            gscHelpers.recordCrossAccountProof({
              userId: user.id,
              websiteUrl: consumedProofForRollback.websiteUrl,
              gscPermissionLevel: consumedProofForRollback.gscPermissionLevel,
            });
          } catch (_) { /* best-effort */ }
        }
        strapi.log.error(`[publisher-website.claim] transaction failed for user ${user.id} website ${id}: ${txErr && txErr.message}`);
        return ctx.internalServerError('Failed to process ownership claim');
      }

      // Translate the transaction outcome into HTTP responses. The
      // transaction is committed (or rolled back) before this point;
      // no DB state changes happen below this line.
      if (!outcome || outcome.action === 'notFound') {
        return ctx.notFound('Website not found');
      }
      if (outcome.action === 'alreadyOwner') {
        return ctx.badRequest('You already own this website');
      }
      if (outcome.action === 'idempotent') {
        console.log(
          `[CLAIM IDEMPOTENT] User ${user.id} already has an open claim (#${outcome.existingClaim.id}) against website ${id} — returning existing claim instead of creating a duplicate.`
        );
        return ctx.send({
          success: true,
          message: 'Your claim is already submitted and under review.',
          data: {
            newWebsiteId: outcome.existingClaim.id,
            originalWebsiteId: outcome.existingWebsite.id,
            claimedWebsite: outcome.existingClaim,
            alreadySubmitted: true,
          },
        });
      }
      if (outcome.action === 'alreadyClaimedByOther') {
        // Race-loser branch. Lock observed the post-claim state.
        strapi.log.warn(
          `[publisher-website.claim] user ${user.id} lost race for website ${id}; already claimed by user ${outcome.byUserId || '(unknown)'}`
        );
        ctx.status = 409;
        ctx.body = {
          error: {
            status: 409,
            name: 'ConflictError',
            message: 'This website has already been claimed by another user.',
          },
        };
        return;
      }
      if (outcome.action === 'ownerGscProof') {
        return ctx.badRequest(
          'This website has been verified by its current owner via Google Search Console and cannot be claimed.'
        );
      }
      if (outcome.action === 'noProof') {
        return ctx.badRequest(
          'Claim ownership requires Google Search Console verification first. Please complete verification before submitting a claim.'
        );
      }

      // outcome.action === 'created' — success path.
      const newOwnerWebsite = outcome.created;
      const existingWebsite = outcome.existingWebsite;
      console.log('✅ New website entry created for claiming user:', newOwnerWebsite.id);
      console.log('✅ Original website marked as ownership transferred');

      // Send ownership claimed email to original publisher
      try {
        const emailService = strapi.service('api::global.email-operations');
        if (existingWebsite.publisherEmail) {
          await emailService.sendWebsiteStatusEmail({
            publisherEmail: existingWebsite.publisherEmail,
            publisherName: existingWebsite.publisherName || existingWebsite.publisherEmail,
            websiteName: existingWebsite.url,
            websiteUrl: existingWebsite.url,
            actionType: 'Ownership Claimed',
            notes: `Ownership has been claimed by another user. Your listing will be updated accordingly.`
          });
        }
      } catch (emailError) {
        console.error('[EMAIL] Failed to send ownership claimed email:', emailError.message);
      }

      return ctx.send({
        success: true,
        message: 'Ownership claimed successfully! Your website has been submitted for review.',
        data: {
          newWebsiteId: newOwnerWebsite.id,
          originalWebsiteId: existingWebsite.id,
          claimedWebsite: newOwnerWebsite
        }
      });

    } catch (error) {
      console.error('Error processing ownership claim:', error);
      return ctx.internalServerError('Failed to process ownership claim');
    }
  },



  /**
   * Check if a domain can be claimed (public endpoint)
   * GET /api/publisher-websites/check-claimable/:domain
   */
  async checkClaimable(ctx) {
    try {
      const { domain } = ctx.params;

      if (!domain) {
        return ctx.badRequest('Domain is required');
      }

      // Clean the domain and normalize to lowercase
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

      // This endpoint is PUBLIC (anonymous-reachable). It MUST NOT leak
      // publisher PII (email, name) — pre-fix it logged publisherEmail to
      // server logs and returned publisherName in the response, allowing
      // a competitor to scrape domain → publisher mappings.
      // Internal lookup pulls only the fields the claim decision needs.
      const allWebsites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: { url: cleanDomain },
        select: ['id', 'url', 'submissionStatus', 'verificationMethod', 'gscVerified', 'addedByReseller'],
      });

      if (!allWebsites || allWebsites.length === 0) {
        return ctx.send({
          exists: false,
          claimable: false,
        });
      }

      const activeWebsites = allWebsites.filter(w => w.submissionStatus !== 'ownership_transferred');
      const website = activeWebsites.length > 0 ? activeWebsites[0] : allWebsites[0];
      const isGSCVerified = website.verificationMethod === 'google-search-console';

      // Public response: only the booleans + the row id/url needed by the
      // SPA's claim-form pre-fill. NO publisher PII (publisherName /
      // publisherEmail) and NO internal admin state (submissionStatus,
      // addedByReseller) — those would let a competitor scrape domain →
      // publisher mappings + workflow state.
      return ctx.send({
        exists: true,
        claimable: !isGSCVerified,
        isGSCVerified,
        data: {
          id: website.id,
          url: website.url,
        },
      });

    } catch (error) {
      strapi.log?.error?.('[publisher-website] checkClaimable failed', { error: error.message });
      return ctx.internalServerError('Error checking domain');
    }
  },

  /**
   * Delete a publisher_website row owned by the caller.
   *
   * Audit finding #2 (resolved 2026-06-15): a duplicate `async delete` used to
   * live earlier in this file at L1330; per ECMAScript object-literal
   * duplicate-key semantics, the later declaration (this one) was the only one
   * Strapi exposed. The earlier handler — which would have cascaded the
   * marketplace listing and allowed any-status deletes — was dead code. It has
   * been removed; only this canonical handler remains.
   *
   * Policy (intentionally restrictive):
   *   - Only the row's owner (relation, NOT just publisherEmail per finding
   *     #5) can delete.
   *   - Only rows still in step 1 / pending_verification / unverified can be
   *     deleted. Approved or GSC-verified rows go through pause/delist, not
   *     delete. This keeps marketplace listings, orders, and audit history
   *     intact.
   *   - If a row somehow has a stale marketplaceId despite being step 1
   *     (legacy / data-drift), we cascade-delete the marketplace row too so
   *     we don't leave an orphan.
   */
  async delete(ctx) {
    const { id } = ctx.params;
    const user = ctx.state.user;

    try {
      if (!user) {
        return ctx.unauthorized('You must be logged in to delete a website.');
      }

      const website = await strapi.entityService.findOne(
        'api::publisher-website.publisher-website',
        id,
        { populate: { currentPublisherId: { fields: ['id'] } } }
      );

      if (!website) {
        return ctx.notFound('Website not found');
      }

      // Strict ownership check (finding #5 fix shares the same helper).
      if (!isPublisherWebsiteOwner(website, user)) {
        // 404 not 403 — defeat enumeration.
        return ctx.notFound('Website not found');
      }

      // Business Rule: Cannot delete verified websites.
      if (website.gscVerified || website.addedByReseller) {
        return ctx.badRequest({
          error: 'Cannot delete verified website',
          message: 'This website has been verified and cannot be deleted. Please contact support if you need assistance.'
        });
      }
      // Business Rule: Only allow deletion if step 1.
      if (website.stepCompleted > 1) {
        return ctx.badRequest({
          error: 'Cannot delete verified website',
          message: 'This website has completed verification and cannot be deleted.'
        });
      }
      // Business Rule: Only pending_verification rows are deletable.
      if (website.submissionStatus !== 'pending_verification') {
        return ctx.badRequest({
          error: 'Invalid website status',
          message: 'Only websites in pending verification status can be deleted.'
        });
      }

      // Defensive marketplace cascade — should never fire given the
      // business rules above (a step-1 / pending_verification row has no
      // legitimate reason to carry a marketplaceId), but data drift happens.
      // Failing the cascade is non-fatal: log and proceed with the row delete
      // so we don't leave the user wedged.
      let marketplaceCascaded = false;
      if (website.marketplaceId) {
        try {
          await strapi.entityService.delete('api::marketplace.marketplace', website.marketplaceId);
          marketplaceCascaded = true;
          strapi.log.warn(`[publisher-website.delete] defensive marketplace cascade fired for pre-approval row ${id} (marketplaceId=${website.marketplaceId}) — drift?`);
        } catch (mpErr) {
          strapi.log.error(`[publisher-website.delete] marketplace cascade failed for row ${id} marketplaceId=${website.marketplaceId}: ${mpErr && mpErr.message}`);
        }
      }

      await strapi.entityService.delete(
        'api::publisher-website.publisher-website',
        id
      );

      strapi.log.info(`[publisher-website.delete] user=${user.id} websiteId=${id} url=${website.url} priorStatus=${website.submissionStatus} marketplaceCascaded=${marketplaceCascaded}`);

      return ctx.send({
        success: true,
        message: 'Website deleted successfully'
      });

    } catch (error) {
      strapi.log.error('Error deleting website:', error);
      return ctx.internalServerError('An error occurred while deleting the website');
    }
  },

  /**
   * Step 1 of the GSC verification flow. Called by the authenticated
   * publisher (via the Next.js init proxy) right before they're redirected
   * to Google. Generates a random nonce, binds it server-side to the row
   * and user, and returns the nonce to the caller for use as the OAuth
   * `state` parameter. Nothing about the user or website ever leaves the
   * server in the OAuth URL — only the opaque nonce does.
   *
   * Auth: requires a regular publisher JWT (the standard users-permissions
   * auth pipeline runs because this route is auth:true).
   */
  async gscVerifyInit(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Authentication required');

    const { id } = ctx.params;
    const websiteId = parseInt(id, 10);
    if (!Number.isFinite(websiteId)) return ctx.badRequest('Invalid website id');

    const website = await strapi.entityService.findOne(
      'api::publisher-website.publisher-website',
      websiteId,
      { populate: ['currentPublisherId'] }
    );
    if (!website) return ctx.notFound('Website not found');
    if (!website.url) return ctx.badRequest('Website URL not set on this row');

    // GSC verification proves the OAuth'd Google account has ownership of the
    // *domain*, not that the requesting user owns the *row*. We intentionally
    // allow any authenticated user to initiate verification against any row.
    // The URL→record binding and Google permission check at the callback
    // step are the real gates. Verification by itself never changes
    // currentPublisherId / publisherEmail — a separate claim + admin
    // approval is required to actually transfer ownership.
    const rowOwnerId = website.currentPublisherId?.id ?? null;
    const isOwner = rowOwnerId === user.id;

    const gsc = require('../../../utils/gsc-helpers');
    const returnTo = (ctx.request.body && typeof ctx.request.body.returnTo === 'string')
      ? ctx.request.body.returnTo
      : null;
    const safeReturnTo = (returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//'))
      ? returnTo
      : null;

    const nonce = gsc.createNonce({
      userId: user.id,
      websiteId,
      websiteUrl: website.url,
      returnTo: safeReturnTo,
    });

    // Audit line records BOTH the initiator and the row's current owner so
    // cross-account verification attempts are visible in the trail.
    strapi.log.info(
      `[GSC AUDIT] INIT initiator=${user.id} row_owner=${rowOwnerId ?? 'none'} same_user=${isOwner} website=${websiteId} url=${website.url}`
    );

    ctx.send({
      nonce,
      websiteUrl: website.url,
      // Returned for the Next.js init proxy so it can echo it back via cookie.
      returnTo: safeReturnTo,
    });
  },

  /**
   * Step 2 of the GSC verification flow. Called server-to-server from the
   * Next.js OAuth callback after Google has authenticated the user and
   * returned the list of properties their Google account has access to.
   *
   * Trust model: this route is auth:false. The HMAC over
   *   `x-gsc-timestamp` + '.' + canonical(body)
   * is the gate. The Next.js callback signs with GSC_VERIFY_SHARED_SECRET;
   * only that process and Strapi share the secret. Without a valid HMAC,
   * timestamp inside the 5-minute window, and a non-replayed signature,
   * the request is rejected before any state is read.
   *
   * After auth, the body's `nonce` is consumed (one-shot) to recover the
   * server-bound (userId, websiteId, websiteUrl). Properties from Google
   * are then matched against the bound websiteUrl by the strict domain
   * algorithm. Only on a real match do we write gscVerified=true.
   *
   * All audit logs avoid sensitive material — no JWTs, no OAuth tokens,
   * no signatures, no refresh tokens.
   */
  async gscVerifyCallback(ctx) {
    const gsc = require('../../../utils/gsc-helpers');
    const secret = process.env.GSC_VERIFY_SHARED_SECRET;

    // Fail closed on misconfig. Returns the same generic shape as every
    // other failure path so an attacker can't tell what went wrong.
    if (!secret || secret.length < 32) {
      strapi.log.error(
        '[GSC CALLBACK] GSC_VERIFY_SHARED_SECRET is unset or shorter than 32 chars — rejecting all requests'
      );
      return ctx.unauthorized('Verification failed');
    }

    const sigHex = ctx.request.headers['x-gsc-signature'];
    const timestamp = ctx.request.headers['x-gsc-timestamp'];

    if (!sigHex || !timestamp) {
      strapi.log.warn('[GSC AUDIT] FAIL reason=missing_headers');
      return ctx.unauthorized('Verification failed');
    }

    const tsNum = Number(timestamp);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > 5 * 60 * 1000) {
      strapi.log.warn(`[GSC AUDIT] FAIL reason=timestamp_out_of_window`);
      return ctx.unauthorized('Verification failed');
    }

    // We recompute the canonical form from the parsed body. The Next.js
    // sender stringifies the same canonical form when computing its HMAC,
    // so reparsing+recanonicalising here produces an identical input
    // independent of koa-body's whitespace/key-order handling.
    const body = ctx.request.body || {};
    const canonical = gsc.canonicalJson(body);

    if (!gsc.verifyHmac(secret, timestamp, canonical, sigHex)) {
      strapi.log.warn('[GSC AUDIT] FAIL reason=hmac_mismatch');
      return ctx.unauthorized('Verification failed');
    }

    const sigHash = gsc.signatureHash(sigHex);
    if (gsc.isSignatureReplay(sigHash)) {
      strapi.log.warn('[GSC AUDIT] FAIL reason=replay');
      return ctx.unauthorized('Verification failed');
    }
    // Mark the signature as seen BEFORE doing any work — protects against
    // concurrent duplicate posts of the same signed body.
    gsc.markSignatureUsed(sigHash);

    const { nonce, properties } = body;
    if (typeof nonce !== 'string' || !Array.isArray(properties)) {
      strapi.log.warn('[GSC AUDIT] FAIL reason=invalid_body_shape');
      return ctx.unauthorized('Verification failed');
    }

    const entry = gsc.consumeNonce(nonce);
    if (!entry) {
      strapi.log.warn('[GSC AUDIT] FAIL reason=invalid_or_expired_nonce');
      return ctx.unauthorized('Verification failed');
    }

    // Match a Google property against the bound row's URL.
    const match = gsc.findMatchingProperty(entry.websiteUrl, properties);
    if (!match) {
      strapi.log.warn(
        `[GSC AUDIT] FAIL user=${entry.userId} website=${entry.websiteId} url=${entry.websiteUrl} reason=no_matching_property`
      );
      return ctx.forbidden('No matching Google Search Console property covers this website');
    }

    // Two outcomes depending on whether the initiator owns the row:
    //
    //   SAME USER (initiator IS the row's currentPublisherId):
    //     The verifier is the publisher of the row. Stamp the row's
    //     gscVerified / gscVerifiedAt / gscPermissionLevel / verificationMethod
    //     directly. This is the ordinary publisher-verifying-own-site path.
    //
    //   CROSS-ACCOUNT (initiator is NOT the row's current owner):
    //     The verifier is a *third party* — typically a claimant about to
    //     submit an ownership claim. They've genuinely proven Google
    //     ownership of the URL, but writing the proof to the original
    //     publisher's row would overwrite that publisher's history (e.g.
    //     verificationMethod='reseller-code'). Instead we record an
    //     in-memory proof keyed by (initiator userId, websiteUrl) with a
    //     30-min TTL. The claim controller consumes that proof when the
    //     claim is submitted; the original row is NEVER touched.
    //
    // Either way the URL→record binding and Google permission check have
    // already passed; the only difference is WHERE the proof lands.
    let outcome = 'success';
    let rowOwnerIdAtCallback = null;
    let isSameUser = false;
    try {
      await strapi.db.transaction(async () => {
        const row = await strapi.entityService.findOne(
          'api::publisher-website.publisher-website',
          entry.websiteId,
          { populate: ['currentPublisherId'] }
        );
        if (!row) {
          outcome = 'row_missing';
          throw new Error('row_missing');
        }
        rowOwnerIdAtCallback = row.currentPublisherId?.id ?? null;
        isSameUser = rowOwnerIdAtCallback === entry.userId;

        if (!isSameUser) {
          // Cross-account: record the proof, do NOT touch the row.
          gsc.recordCrossAccountProof({
            userId: entry.userId,
            websiteUrl: entry.websiteUrl,
            gscPermissionLevel: match.permissionLevel,
          });
          outcome = 'cross_account_proof_recorded';
          return;
        }

        // Same-user path: the verifier IS the row owner — stamp the row.
        if (row.gscVerified) {
          outcome = 'no_op_already_verified';
          return;
        }
        const updates = {
          gscVerified: true,
          gscVerifiedAt: new Date(),
          gscPermissionLevel: match.permissionLevel,
          verificationMethod: 'google-search-console',
          // _skipMarketplaceSync prevents the publisher-website afterUpdate
          // lifecycle from doing a redundant marketplace sync for what is
          // purely a verification metadata change.
          _skipMarketplaceSync: true,
        };
        // Forward-only stepCompleted; never lower it.
        const currentStep = parseInt(row.stepCompleted, 10) || 1;
        if (currentStep < 2) updates.stepCompleted = 2;

        await strapi.entityService.update(
          'api::publisher-website.publisher-website',
          entry.websiteId,
          { data: updates }
        );
      });
    } catch (e) {
      strapi.log.warn(
        `[GSC AUDIT] FAIL initiator=${entry.userId} website=${entry.websiteId} url=${entry.websiteUrl} reason=${outcome === 'success' ? 'tx_error' : outcome}`
      );
      return ctx.forbidden('Verification could not be completed');
    }

    // One audit line per outcome. Cross-account proofs are explicit so the
    // trail makes the same-user vs claim-prep distinction unambiguous.
    const auditLabel = (() => {
      if (outcome === 'cross_account_proof_recorded') return 'PROOF_RECORDED';
      if (outcome === 'no_op_already_verified') return 'NO_OP';
      return 'SUCCESS';
    })();
    strapi.log.info(
      `[GSC AUDIT] ${auditLabel} initiator=${entry.userId} row_owner=${rowOwnerIdAtCallback ?? 'none'} same_user=${isSameUser} website=${entry.websiteId} url=${entry.websiteUrl} matched_type=${match.type} matched_host=${match.provenHost} permission=${match.permissionLevel}`
    );
    ctx.send({
      ok: true,
      alreadyVerified: outcome === 'no_op_already_verified',
      crossAccountProofRecorded: outcome === 'cross_account_proof_recorded',
    });
  }

}));
