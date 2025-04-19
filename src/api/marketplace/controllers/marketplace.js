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
const validateType = (value, type) => {
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
      const { fileId, confirmDuplicates } = ctx.request.body;
      
      if (!fileId) {
        return ctx.badRequest('File ID is required');
      }

      // Get the uploaded file from Strapi's upload plugin
      const uploadedFile = await strapi.plugins.upload.services.upload.findOne(fileId);
      
      if (!uploadedFile) {
        return ctx.badRequest('File not found');
      }

      // Get the schema to validate against
      const schema = strapi.contentTypes['api::marketplace.marketplace'].attributes;

      // Read and parse CSV file
      const filePath = uploadedFile.url.startsWith('/') 
        ? `./public${uploadedFile.url}`
        : uploadedFile.url;

      const csvContent = fs.readFileSync(filePath, 'utf8');
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
              const validation = validateType(value, schema[field].type);
              if (!validation.isValid) {
                rowErrors.push(`${field}: ${validation.error}`);
              } else {
                convertedData[field] = validation.value;
              }
            } else {
              console.warn(`Unknown field in CSV: ${field}`);
            }
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
        entries: createdEntries,
        errors: errors.length ? errors : undefined,
        duplicatesUpdated: confirmDuplicates ? confirmedDuplicates.length : 0
      };
    } catch (error) {
      console.error('CSV Upload Error:', error);
      return ctx.badRequest(error.message);
    }
  }
}));
