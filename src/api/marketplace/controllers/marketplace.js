'use strict';

/**
 * marketplace controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { parse } = require('csv-parse/sync');
const fs = require('fs');

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
  applyPostFetchSorting(entries, sortField, sortDirection) {
    // Only apply to metric fields that have the NULL issue
    const metricFields = [
      'ahrefs_dr', 'moz_da', 'semrush_authority_score',
      'ahrefs_traffic', 'semrush_traffic', 'similarweb_traffic',
      'price', 'link_insertion_price', 'spam_score'
    ];

    // If not a metric field or no entries, return as-is
    if (!metricFields.includes(sortField) || !Array.isArray(entries) || entries.length === 0) {
      return entries;
    }

    // Create a copy to avoid mutating original
    const sorted = [...entries];

    sorted.sort((a, b) => {
      const valA = a[sortField];
      const valB = b[sortField];

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
      if (sortDirection === 'desc') {
        return (Number(valB) || 0) - (Number(valA) || 0);
      } else {
        return (Number(valA) || 0) - (Number(valB) || 0);
      }
    });

    return sorted;
  },

  // Helper function to sanitize publisher data for advertisers
  sanitizePublisherData(entries, user) {
    // For advertisers and public users, hide sensitive publisher information
    const sanitize = (entry) => {
      if (!entry) return entry;

      const sanitized = { ...entry };

      // Check if this is the user's own website
      // Check by userId (publisher relation) or email for legacy records
      // Handle both cases: publisher might be just ID (number) or populated object
      const publisherId = typeof entry.publisher === 'object' && entry.publisher !== null
        ? entry.publisher.id
        : entry.publisher;

      const isOwnWebsite = user && (
        (publisherId && publisherId == user.id) ||  // Use == to handle string/number mismatch
        (!publisherId && entry.publisher_email === user.email)
      );

      // Add ownership flag (safe to expose, doesn't reveal publisher identity)
      sanitized.isOwnWebsite = isOwnWebsite;

      // If user is a publisher viewing their own listing, keep publisher data
      if (isOwnWebsite) {
        return sanitized;
      }

      // For advertisers and public users, remove ALL publisher-related fields
      Object.keys(sanitized).forEach(key => {
        if (key.startsWith('publisher_') || key === 'publisher_email' || key === 'publisher_name') {
          delete sanitized[key];
        }
      });

      return sanitized;
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

    // Calculate placement speed if TAT is provided
    if (ctx.request.body.data && ctx.request.body.data.tat !== undefined) {
      ctx.request.body.data.placement_speed = this.calculatePlacementSpeed(ctx.request.body.data.tat);
    }

    // Validate input data
    const validationErrors = this.validateMarketplaceData(ctx.request.body.data || {});
    if (validationErrors.length > 0) {
      return ctx.badRequest(`Validation failed: ${validationErrors.join(', ')}`);
    }

    // Publisher filtering: Publishers can only create listings with their own email
    if (user && user.Advertiser === false) {
      if (!ctx.request.body.data) ctx.request.body.data = {};
      ctx.request.body.data.publisher_email = user.email;
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

    // Calculate placement speed if TAT is provided
    if (ctx.request.body.data && ctx.request.body.data.tat !== undefined) {
      ctx.request.body.data.placement_speed = this.calculatePlacementSpeed(ctx.request.body.data.tat);
    }

    // Validate input data
    const validationErrors = this.validateMarketplaceData(ctx.request.body.data || {});
    if (validationErrors.length > 0) {
      return ctx.badRequest(`Validation failed: ${validationErrors.join(', ')}`);
    }

    // Publisher filtering: Publishers can only update their own listings
    if (user && user.Advertiser === false) {
      const entry = await strapi.entityService.findOne('api::marketplace.marketplace', ctx.params.id, {
        fields: ['publisher_email'],
        populate: ['publisher']
      });
      // Check ownership: prefer userId (publisher relation), fallback to email for legacy
      const isOwner = entry && (
        (entry.publisher && entry.publisher.id === user.id) ||
        (!entry.publisher && entry.publisher_email === user.email)
      );
      if (!entry || !isOwner) {
        return ctx.unauthorized('You are not allowed to update this listing.');
      }
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
        populate: ['publisher']
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

  // Enhanced delete with authorization
  async delete(ctx) {
    const user = ctx.state.user;

    // Publisher filtering: Publishers can only delete their own listings
    if (user && user.Advertiser === false) {
      const entry = await strapi.entityService.findOne('api::marketplace.marketplace', ctx.params.id, {
        fields: ['publisher_email'],
        populate: ['publisher']
      });
      // Check ownership: prefer userId (publisher relation), fallback to email for legacy
      const isOwner = entry && (
        (entry.publisher && entry.publisher.id === user.id) ||
        (!entry.publisher && entry.publisher_email === user.email)
      );
      if (!entry || !isOwner) {
        return ctx.unauthorized('You are not allowed to delete this listing.');
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

    if (ctx.query.sort) {
      // Map frontend sort fields to backend database fields
      const sortMapping = {
        'url': 'url',
        'category': 'category',
        'ahrefs_traffic': 'ahrefs_traffic',
        'moz_da': 'moz_da',
        'ahrefs_dr': 'ahrefs_dr',
        'semrush_authority_score': 'semrush_authority_score',
        'price': 'price',
        'createdAt': 'createdAt',
        'updatedAt': 'updatedAt'
      };

      // Parse sort parameter (e.g., "price:desc" or "url:asc")
      const [field, direction] = ctx.query.sort.split(':');
      const mappedField = sortMapping[field] || field;
      const sortDirection = direction === 'asc' ? 'asc' : 'desc';

      // Check if this is a metric field that needs NULL-safe sorting
      if (metricFields.includes(mappedField)) {
        // Flag for raw SQL sorting (handled after Strapi's default find)
        useRawSorting = true;
        rawSortField = mappedField;
        rawSortDirection = sortDirection;

        // Don't set ctx.query.sort - we'll handle it with raw SQL
        delete ctx.query.sort;

        console.log(`🔍 Will apply NULL-safe raw SQL sorting: ${mappedField}:${sortDirection}`);
      } else {
        // Standard fields can use Strapi's default sorting
        ctx.query.sort = `${mappedField}:${sortDirection}`;
        console.log(`🔍 Applied standard sorting: ${mappedField}:${sortDirection}`);
      }
    } else {
      // Default sort if none provided
      ctx.query.sort = 'updatedAt:desc';
    }

    // For metric field sorting, use a TWO-PHASE approach:
    // Phase 1: Let Strapi handle ALL filtering (supports all operators natively)
    // Phase 2: Use Knex only for NULL-safe sorting with NULLS LAST
    // This is more maintainable than maintaining a custom filter parser
    if (useRawSorting && rawSortField && rawSortDirection) {
      const page = ctx.query.pagination?.page || 1;
      const pageSize = ctx.query.pagination?.pageSize || 25;

      try {
        console.log('🔍 Using two-phase approach: Strapi filter → Knex sort');

        // PHASE 1: Use Strapi's entityService to get filtered IDs
        // This properly handles ALL Strapi operators ($containsi, $or, $and, etc.)
        const filteredEntries = await strapi.entityService.findMany('api::marketplace.marketplace', {
          filters: ctx.query.filters,
          fields: ['id', rawSortField], // Only fetch ID and sort field for efficiency
          populate: ['publisher'], // Need publisher for ownership check
        });

        if (!filteredEntries || filteredEntries.length === 0) {
          return {
            data: [],
            meta: {
              pagination: {
                page,
                pageSize,
                pageCount: 0,
                total: 0
              }
            }
          };
        }

        // Get the IDs from filtered results
        const filteredIds = filteredEntries.map(e => e.id);
        const total = filteredIds.length;

        console.log(`🔍 Phase 1 complete: ${total} entries matched filters`);

        // PHASE 2: Use Knex to fetch full data with NULL-safe sorting
        const knex = strapi.db.connection;

        const results = await knex('marketplaces')
          .whereIn('id', filteredIds)
          .orderByRaw(`?? ${rawSortDirection} NULLS LAST`, [rawSortField])
          .limit(pageSize)
          .offset((page - 1) * pageSize);

        console.log(`🔍 Phase 2 complete: Sorted ${results.length} entries with NULLS LAST`);

        // Sanitize publisher data
        const sanitizedResults = this.sanitizePublisherData(results, user);

        // Apply post-fetch sorting as final guarantee
        const sortedResults = this.applyPostFetchSorting(sanitizedResults, rawSortField, rawSortDirection);

        // Return in Strapi v4 format
        return {
          data: sortedResults,
          meta: {
            pagination: {
              page,
              pageSize,
              pageCount: Math.ceil(total / pageSize),
              total
            }
          }
        };
      } catch (error) {
        console.error('❌ Two-phase sorting failed, falling back to entityService:', error.message);
        // Fallback to Strapi's default entityService (without NULLS LAST fix)
        try {
          const page = ctx.query.pagination?.page || 1;
          const pageSize = ctx.query.pagination?.pageSize || 25;

          const results = await strapi.entityService.findPage('api::marketplace.marketplace', {
            filters: ctx.query.filters,
            populate: ctx.query.populate || '*',
            page,
            pageSize,
            orderBy: {
              [rawSortField]: rawSortDirection
            }
          });

          if (results && results.results) {
            results.results = this.sanitizePublisherData(results.results, user);
            // Apply post-fetch sorting as final guarantee
            results.results = this.applyPostFetchSorting(results.results, rawSortField, rawSortDirection);
          }

          return {
            data: results.results,
            meta: {
              pagination: results.pagination
            }
          };
        } catch (fallbackError) {
          console.error('❌ Fallback also failed:', fallbackError);
          // Ultimate fallback
          const result = await super.find(ctx);
          if (result && result.data) {
            result.data = this.sanitizePublisherData(result.data, user);
            // Apply post-fetch sorting as final guarantee
            result.data = this.applyPostFetchSorting(result.data, rawSortField, rawSortDirection);
          }
          return result;
        }
      }
    }

    // Standard Strapi query for non-metric fields
    // IMPORTANT: We need to fetch WITH private fields (publisher_email) for ownership checks
    // Then sanitize them ourselves in sanitizePublisherData
    try {
      // Get pagination params
      const page = ctx.query.pagination?.page || 1;
      const pageSize = ctx.query.pagination?.pageSize || 25;

      // Use db.query to get ALL fields including private ones
      // IMPORTANT: Populate publisher relation for ownership check in sanitizePublisherData
      const entries = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: ctx.query.filters,
        orderBy: ctx.query.sort ? { [ctx.query.sort.split(':')[0]]: ctx.query.sort.split(':')[1] || 'asc' } : { updatedAt: 'desc' },
        limit: pageSize,
        offset: (page - 1) * pageSize,
        populate: ['publisher'],  // Required for isOwnWebsite check
      });

      // Get total count for pagination
      const total = await strapi.db.query('api::marketplace.marketplace').count({
        where: ctx.query.filters
      });

      // Sanitize publisher data (this removes private fields for non-owners)
      const sanitizedEntries = this.sanitizePublisherData(entries, user);

      // Apply post-fetch sorting if sorting by a metric field
      const sortParts = (ctx.query.sort || 'updatedAt:desc').split(':');
      const sortField = sortParts[0];
      const sortDirection = sortParts[1] || 'desc';
      const sortedEntries = this.applyPostFetchSorting(sanitizedEntries, sortField, sortDirection);

      return {
        data: sortedEntries,
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: Math.ceil(total / pageSize),
            total
          }
        }
      };
    } catch (error) {
      console.error('❌ Error fetching marketplace data:', error);
      // Fallback to super.find if db query fails
      const result = await super.find(ctx);
      if (result && result.data) {
        result.data = this.sanitizePublisherData(result.data, user);
        // Apply post-fetch sorting for fallback too
        const sortParts = (ctx.query.sort || 'updatedAt:desc').split(':');
        result.data = this.applyPostFetchSorting(result.data, sortParts[0], sortParts[1] || 'desc');
      }
      return result;
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
      // Clean the domain (remove protocol and trailing slashes)
      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

      // Check if domain exists in marketplace
      const existingEntry = await strapi.db.query('api::marketplace.marketplace').findOne({
        where: { url: cleanDomain },
        select: ['id', 'url']
      });

      if (existingEntry) {
        return ctx.send({
          exists: true,
          message: `This domain "${cleanDomain}" is already listed in the marketplace`,
          data: {
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

      // Check authentication
      if (!user) {
        return ctx.unauthorized('Authentication required');
      }

      // Publishers can only update TAT for their own websites
      if (user.Advertiser === false) {
        const website = await strapi.entityService.findOne('api::marketplace.marketplace', id, {
          fields: ['publisher_email']
        });

        if (!website || website.publisher_email !== user.email) {
          return ctx.unauthorized('You are not allowed to update TAT for this website.');
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
  }
}));
