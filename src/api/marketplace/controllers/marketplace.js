'use strict';

/**
 * marketplace controller
 */

const { createCoreController } = require('@strapi/strapi').factories;
const { parse } = require('csv-parse/sync');
const fs = require('fs');

module.exports = createCoreController('api::marketplace.marketplace', ({ strapi }) => ({
  async uploadCSV(ctx) {
    try {
      const { fileId } = ctx.request.body;
      
      if (!fileId) {
        return ctx.badRequest('File ID is required');
      }

      // Get the uploaded file from Strapi's upload plugin
      const uploadedFile = await strapi.plugins.upload.services.upload.findOne(fileId);
      
      if (!uploadedFile) {
        return ctx.badRequest('File not found');
      }

      // Read and parse CSV file
      const filePath = uploadedFile.url.startsWith('/') 
        ? `./public${uploadedFile.url}`
        : uploadedFile.url;

      const csvContent = fs.readFileSync(filePath, 'utf8');
      const records = parse(csvContent, {
        columns: true,
        skip_empty_lines: true
      });

      // Create entries from CSV data
      const createdEntries = [];
      for (const record of records) {
        try {
          // Parse category if it's a JSON string, or convert string to array
          let categoryValue;
          if (record.category) {
            try {
              categoryValue = JSON.parse(record.category);
            } catch {
              // If not valid JSON, treat it as a single category
              categoryValue = [record.category];
            }
          } else {
            categoryValue = [];
          }

          const entry = await strapi.entityService.create('api::marketplace.marketplace', {
            data: {
              url: record.url || '',
              price: parseFloat(record.price) || 0,
              title: record.title || '',
              description: record.description || '',
              category: categoryValue,
              publishedAt: new Date()
            },
          });
          createdEntries.push(entry);
        } catch (error) {
          console.error('Error creating entry:', error, 'Record:', record);
          throw new Error(`Failed to create entry: ${error.message}`);
        }
      }

      // Return success response
      return {
        message: `Successfully imported ${createdEntries.length} records`,
        entries: createdEntries,
      };
    } catch (error) {
      console.error('CSV Upload Error:', error);
      return ctx.badRequest(error.message);
    }
  }
}));
