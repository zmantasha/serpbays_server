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
        fields: ['publisher_email']
      });
      if (!entry || entry.publisher_email !== user.email) {
        return ctx.unauthorized('You are not allowed to update this listing.');
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
        fields: ['publisher_email']
      });
      if (!entry || entry.publisher_email !== user.email) {
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
    
    // Advertiser (user.Advertiser === true) can see all listings
    // Publisher (user.Advertiser === false) only sees their listings
    if (user && user.Advertiser === false) {
      if (!ctx.query) ctx.query = {};
      if (!ctx.query.filters) ctx.query.filters = {};
      ctx.query.filters.publisher_email = user.email;
    }
    
    // Handle sorting - ensure proper field mapping and default sort
    if (ctx.query.sort) {
      // Map frontend sort fields to backend database fields if needed
      const sortMapping = {
        'url': 'url',
        'category': 'category',
        'ahrefs_traffic': 'ahrefs_traffic',
        'moz_da': 'moz_da',
        'ahrefs_dr': 'ahrefs_dr',
        'price': 'price',
        'createdAt': 'createdAt',
        'updatedAt': 'updatedAt'
      };
      
      // Parse sort parameter (e.g., "price:desc" or "url:asc")
      const [field, direction] = ctx.query.sort.split(':');
      const mappedField = sortMapping[field] || field;
      
      // Validate direction
      const sortDirection = direction === 'asc' ? 'asc' : 'desc';
      
      // Set the properly formatted sort
      ctx.query.sort = `${mappedField}:${sortDirection}`;
    } else {
      // Default sort if none provided
      ctx.query.sort = 'updatedAt:desc';
    }
    
    // Call the default core action
    return await super.find(ctx);
  },

  async findOne(ctx) {
    // Get authenticated user from context
    const user = ctx.state.user;
    // console.log(user)
    // Advertiser (user.Advertiser === true) can see all listings
    // Publisher (user.Advertiser === false) can only access their own listings
    if (user && user.Advertiser === false) {
      const entry = await strapi.entityService.findOne('api::marketplace.marketplace', ctx.params.id, {
        fields: ['publisher_email']
      });
      if (!entry || entry.publisher_email !== user.email) {
        return ctx.unauthorized('You are not allowed to view this listing.');
      }
    }
    // Call the default core action
    return await super.findOne(ctx);
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
      return ctx.badRequest(error.message);
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
