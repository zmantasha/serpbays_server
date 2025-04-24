const { Parser } = require('json2csv');

module.exports = {
  async exportFiltered(ctx) {
    try {
      console.log('Export filtered called with query:', ctx.query);
      
      // Get start and end parameters for range export
      const startRecord = Math.max(1, parseInt(ctx.query.startRecord, 10) || 1);
      const endRecord = Math.min(parseInt(ctx.query.endRecord, 10) || 1000, 50000);
      const limit = endRecord - startRecord + 1;
      
      console.log(`Exporting records from ${startRecord} to ${endRecord} (${limit} records)`);
      
      // Handle filters directly from query string
      const publisherEmail = ctx.query['filters[publisher_email][$containsi]'];
      const url = ctx.query['filters[url][$containsi]'];
      const category = ctx.query['filters[category][$containsi]'];
      const otherCategory = ctx.query['filters[other_category][$containsi]'];
      const language = ctx.query['filters[language][$containsi]'];
      const country = ctx.query['filters[countries][$containsi]'];
      const domainZone = ctx.query['filters[url][$endsWith]'];
      const backlinkType = ctx.query['filters[backlink_type][$eq]'];
      const publisherName = ctx.query['filters[publisher_name][$containsi]'];
      const minDR = ctx.query['filters[ahrefs_dr][$gte]'];
      const maxDR = ctx.query['filters[ahrefs_dr][$lte]'];
      const minDA = ctx.query['filters[moz_da][$gte]'];
      const maxDA = ctx.query['filters[moz_da][$lte]'];
      const minPrice = ctx.query['filters[price][$gte]'];
      const maxPrice = ctx.query['filters[price][$lte]'];
      const minWordCount = ctx.query['filters[min_word_count][$gte]'];
      const dofollow = ctx.query['filters[dofollow_link][$eq]'] || ctx.query['filters[dofollow_link]'];
      const fastPlacement = ctx.query['filters[fast_placement_status][$eq]'];
      const minAhrefsTraffic = ctx.query['filters[ahrefs_traffic][$gte]'];
      const maxAhrefsTraffic = ctx.query['filters[ahrefs_traffic][$lte]'];
      const minSemrushTraffic = ctx.query['filters[semrush_traffic][$gte]'];
      const maxSemrushTraffic = ctx.query['filters[semrush_traffic][$lte]'];
      const minSimilarwebTraffic = ctx.query['filters[similarweb_traffic][$gte]'];
      const maxSimilarwebTraffic = ctx.query['filters[similarweb_traffic][$lte]'];
      
      // Build filter object for Strapi
      const filters = {};
      if (publisherEmail && publisherEmail.trim()) {
        filters.publisher_email = { $containsi: publisherEmail.trim() };
      }
      if (url && url.trim()) {
        filters.url = { $containsi: url.trim() };
      }
      if (category && category.trim()) {
        filters.category = { $containsi: category.trim() };
      }
      if (otherCategory && otherCategory.trim()) {
        filters.other_category = { $containsi: otherCategory.trim() };
      }
      if (language && language.trim()) {
        filters.language = { $containsi: language.trim() };
      }
      if (country && country.trim()) {
        // For JSON fields, we need to search differently
        // This will vary depending on how the data is stored (array vs object)
        // Try a more flexible approach for JSON search
        filters.$or = [
          // If stored as string in JSON
          { countries: { $containsi: country.trim() } },
          // If stored as array of strings
          { countries: { $contains: country.trim() } },
        ];
      }
      if (domainZone && domainZone.trim()) {
        filters.url = { ...(filters.url || {}), $endsWith: domainZone.trim() };
      }
      if (backlinkType && backlinkType.trim()) {
        // Ensure backlink_type value matches enumeration in schema (Do follow, No follow)
        filters.backlink_type = { $eq: backlinkType.trim() };
      }
      if (publisherName && publisherName.trim()) {
        filters.publisher_name = { $containsi: publisherName.trim() };
      }
      if (minDR && !isNaN(parseInt(minDR))) {
        filters.ahrefs_dr = { ...(filters.ahrefs_dr || {}), $gte: parseInt(minDR) };
      }
      if (maxDR && !isNaN(parseInt(maxDR))) {
        filters.ahrefs_dr = { ...(filters.ahrefs_dr || {}), $lte: parseInt(maxDR) };
      }
      if (minDA && !isNaN(parseInt(minDA))) {
        filters.moz_da = { ...(filters.moz_da || {}), $gte: parseInt(minDA) };
      }
      if (maxDA && !isNaN(parseInt(maxDA))) {
        filters.moz_da = { ...(filters.moz_da || {}), $lte: parseInt(maxDA) };
      }
      if (minPrice && !isNaN(parseInt(minPrice))) {
        filters.price = { ...(filters.price || {}), $gte: parseInt(minPrice) };
      }
      if (maxPrice && !isNaN(parseInt(maxPrice))) {
        filters.price = { ...(filters.price || {}), $lte: parseInt(maxPrice) };
      }
      if (minWordCount && !isNaN(parseInt(minWordCount))) {
        filters.min_word_count = { $gte: parseInt(minWordCount) };
      }
      if (dofollow && dofollow !== '') {
        // Handle dofollow_link as an integer
        console.log('Filtering by dofollow_link:', dofollow, 'type:', typeof dofollow);
        const dofollowValue = parseInt(dofollow, 10);
        if (!isNaN(dofollowValue)) {
          // Handle dofollow as a direct field without using $or
          filters.dofollow_link = { $eq: dofollowValue };
        }
      }
      if (fastPlacement === 'true' || fastPlacement === true) {
        filters.fast_placement_status = { $eq: true };
      } else if (fastPlacement === 'false' || fastPlacement === false) {
        filters.fast_placement_status = { $eq: false };
      }
      if (minAhrefsTraffic && !isNaN(parseInt(minAhrefsTraffic))) {
        filters.ahrefs_traffic = { ...(filters.ahrefs_traffic || {}), $gte: parseInt(minAhrefsTraffic) };
      }
      if (maxAhrefsTraffic && !isNaN(parseInt(maxAhrefsTraffic))) {
        filters.ahrefs_traffic = { ...(filters.ahrefs_traffic || {}), $lte: parseInt(maxAhrefsTraffic) };
      }
      if (minSemrushTraffic && !isNaN(parseInt(minSemrushTraffic))) {
        filters.semrush_traffic = { ...(filters.semrush_traffic || {}), $gte: parseInt(minSemrushTraffic) };
      }
      if (maxSemrushTraffic && !isNaN(parseInt(maxSemrushTraffic))) {
        filters.semrush_traffic = { ...(filters.semrush_traffic || {}), $lte: parseInt(maxSemrushTraffic) };
      }
      if (minSimilarwebTraffic && !isNaN(parseInt(minSimilarwebTraffic))) {
        filters.similarweb_traffic = { ...(filters.similarweb_traffic || {}), $gte: parseInt(minSimilarwebTraffic) };
      }
      if (maxSimilarwebTraffic && !isNaN(parseInt(maxSimilarwebTraffic))) {
        filters.similarweb_traffic = { ...(filters.similarweb_traffic || {}), $lte: parseInt(maxSimilarwebTraffic) };
      }
      
      console.log(`Exporting up to ${limit} records with filters:`, JSON.stringify(filters));
      
      // Debug: Check database values for dofollow_link
      console.log('Checking database values for dofollow_link');
      const debugEntries = await strapi.entityService.findMany('api::marketplace.marketplace', {
        fields: ['id', 'url', 'dofollow_link'],
        limit: 5,
      });
      console.log('Sample entries from database:', debugEntries);
      
      // After the debug entries, add a specific query for dofollow_link = 2
      console.log('Specifically checking for dofollow_link = 2');
      const dofollow2Entries = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters: { dofollow_link: 2 },
        fields: ['id', 'url', 'dofollow_link'],
        limit: 5,
      });
      console.log('Entries with dofollow_link = 2:', dofollow2Entries);
      
      // Debug the exact query by adding this after the filter creation
      console.log('Full query filters object:', JSON.stringify(filters, null, 2));
      console.log('Looking for dofollow_link value exactly equal to:', typeof filters.dofollow_link === 'object' ? 
        filters.dofollow_link.$eq : filters.dofollow_link);
      
      // After the debug entries code but before the main query
      console.log('Direct query test for dofollow_link = 2');
      try {
        const testQuery = await strapi.db.query('api::marketplace.marketplace').findMany({
          where: { dofollow_link: 2 }
        });
        console.log(`Found ${testQuery.length} records with dofollow_link = 2 in direct query`);
        if (testQuery.length > 0) {
          console.log('Sample record:', testQuery[0]);
        }
      } catch (err) {
        console.error('Error in direct query test:', err);
      }
      
      // Fetch data with filters and pagination to get specific range
      const entries = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters,
        start: startRecord - 1, // Adjust for 0-based index
        limit,
        sort: { updatedAt: 'desc' },
      });
      
      console.log(`Found ${entries.length} entries to export in requested range`);
      
      if (entries.length === 0) {
        return ctx.badRequest('No entries found matching the criteria');
      }
      
      // Format entries to handle category field
      const formattedEntries = entries.map(entry => {
        const formattedEntry = { ...entry };
        
        // Convert category to comma-separated string if it's an array or object
        if (formattedEntry.category) {
          if (Array.isArray(formattedEntry.category)) {
            formattedEntry.category = formattedEntry.category.join(', ');
          } else if (typeof formattedEntry.category === 'object') {
            formattedEntry.category = Object.values(formattedEntry.category).join(', ');
          }
        }
        
        // Convert other_category to comma-separated string if it's an array or object
        if (formattedEntry.other_category) {
          if (Array.isArray(formattedEntry.other_category)) {
            formattedEntry.other_category = formattedEntry.other_category.join(', ');
          } else if (typeof formattedEntry.other_category === 'object') {
            formattedEntry.other_category = Object.values(formattedEntry.other_category).join(', ');
          }
        }
        
        // Remove unwanted fields
        delete formattedEntry.id;
        delete formattedEntry.document;
        
        return formattedEntry;
      });
      
      // Get fields from first entry
      const fields = Object.keys(formattedEntries[0]);
      
      // Convert to CSV
      const json2csvParser = new Parser({ fields });
      const csv = json2csvParser.parse(formattedEntries);
      
      // Set response headers for CSV download
      ctx.type = 'text/csv';
      ctx.attachment(`marketplace_export_${new Date().toISOString().split('T')[0]}.csv`);
      
      // Send CSV data
      return ctx.send(csv);
    } catch (error) {
      console.error('Error in exportFiltered:', error);
      return ctx.badRequest(`Error exporting data: ${error.message}`);
    }
  },
  
  async adminList(ctx) {
    try {
      console.log('Admin list query params:', ctx.query);
      
      // Get pagination params or use defaults
      const page = parseInt(ctx.query.page, 10) || 1;
      const pageSize = parseInt(ctx.query.pageSize, 10) || 100;
      
      // Extract filters from query - handle both formats
      const filters = {};
      
      // Check if filters are provided in the new format (nested object)
      if (ctx.query.filters && typeof ctx.query.filters === 'object') {
        // Direct object format: { filters: { publisher_email: { '$containsi': 'test@gmail.com' } } }
        Object.assign(filters, ctx.query.filters);
      } else {
        // Old format with string keys: 'filters[publisher_email][$containsi]'
        const { 
          'filters[publisher_email][$containsi]': publisherEmail, 
          'filters[url][$containsi]': url,
          'filters[category][$containsi]': category,
          'filters[other_category][$containsi]': otherCategory,
          'filters[language][$containsi]': language,
          'filters[countries][$containsi]': country,
          'filters[url][$endsWith]': domainZone,
          'filters[backlink_type][$eq]': backlinkType,
          'filters[publisher_name][$containsi]': publisherName,
          'filters[ahrefs_dr][$gte]': minDR,
          'filters[ahrefs_dr][$lte]': maxDR,
          'filters[moz_da][$gte]': minDA,
          'filters[moz_da][$lte]': maxDA,
          'filters[price][$gte]': minPrice,
          'filters[price][$lte]': maxPrice,
          'filters[min_word_count][$gte]': minWordCount,
          'filters[dofollow_link][$eq]': dofollow,
          'filters[fast_placement_status][$eq]': fastPlacement,
          'filters[ahrefs_traffic][$gte]': minAhrefsTraffic,
          'filters[ahrefs_traffic][$lte]': maxAhrefsTraffic,
          'filters[semrush_traffic][$gte]': minSemrushTraffic,
          'filters[semrush_traffic][$lte]': maxSemrushTraffic,
          'filters[similarweb_traffic][$gte]': minSimilarwebTraffic,
          'filters[similarweb_traffic][$lte]': maxSimilarwebTraffic
        } = ctx.query;
        
        // Build filter object for Strapi
        if (publisherEmail && publisherEmail.trim().length > 0) {
          filters.publisher_email = { $containsi: publisherEmail.trim() };
        }
        if (url && url.trim().length > 0) {
          filters.url = { $containsi: url.trim() };
        }
        if (category && category.trim().length > 0) {
          filters.category = { $containsi: category.trim() };
        }
        if (otherCategory && otherCategory.trim().length > 0) {
          filters.other_category = { $containsi: otherCategory.trim() };
        }
        if (language && language.trim().length > 0) {
          filters.language = { $containsi: language.trim() };
        }
        if (country && country.trim().length > 0) {
          filters.countries = { $containsi: country.trim() };
        }
        if (domainZone && domainZone.trim().length > 0) {
          filters.url = { ...(filters.url || {}), $endsWith: domainZone.trim() };
        }
        if (backlinkType && backlinkType.trim().length > 0) {
          filters.backlink_type = { $eq: backlinkType.trim() };
        }
        if (publisherName && publisherName.trim().length > 0) {
          filters.publisher_name = { $containsi: publisherName.trim() };
        }
        if (minDR && !isNaN(parseInt(minDR))) {
          filters.ahrefs_dr = { ...(filters.ahrefs_dr || {}), $gte: parseInt(minDR) };
        }
        if (maxDR && !isNaN(parseInt(maxDR))) {
          filters.ahrefs_dr = { ...(filters.ahrefs_dr || {}), $lte: parseInt(maxDR) };
        }
        if (minDA && !isNaN(parseInt(minDA))) {
          filters.moz_da = { ...(filters.moz_da || {}), $gte: parseInt(minDA) };
        }
        if (maxDA && !isNaN(parseInt(maxDA))) {
          filters.moz_da = { ...(filters.moz_da || {}), $lte: parseInt(maxDA) };
        }
        if (minPrice && !isNaN(parseInt(minPrice))) {
          filters.price = { ...(filters.price || {}), $gte: parseInt(minPrice) };
        }
        if (maxPrice && !isNaN(parseInt(maxPrice))) {
          filters.price = { ...(filters.price || {}), $lte: parseInt(maxPrice) };
        }
        if (minWordCount && !isNaN(parseInt(minWordCount))) {
          filters.min_word_count = { $gte: parseInt(minWordCount) };
        }
        if (dofollow && dofollow !== '') {
          // Handle dofollow_link as an integer
          console.log('Filtering by dofollow_link:', dofollow, 'type:', typeof dofollow);
          const dofollowValue = parseInt(dofollow, 10);
          if (!isNaN(dofollowValue)) {
            // Handle dofollow as a direct field without using $or
            filters.dofollow_link = { $eq: dofollowValue };
          }
        }
        if (fastPlacement === 'true' || fastPlacement === true) {
          filters.fast_placement_status = { $eq: true };
        } else if (fastPlacement === 'false' || fastPlacement === false) {
          filters.fast_placement_status = { $eq: false };
        }
        if (minAhrefsTraffic && !isNaN(parseInt(minAhrefsTraffic))) {
          filters.ahrefs_traffic = { ...(filters.ahrefs_traffic || {}), $gte: parseInt(minAhrefsTraffic) };
        }
        if (maxAhrefsTraffic && !isNaN(parseInt(maxAhrefsTraffic))) {
          filters.ahrefs_traffic = { ...(filters.ahrefs_traffic || {}), $lte: parseInt(maxAhrefsTraffic) };
        }
        if (minSemrushTraffic && !isNaN(parseInt(minSemrushTraffic))) {
          filters.semrush_traffic = { ...(filters.semrush_traffic || {}), $gte: parseInt(minSemrushTraffic) };
        }
        if (maxSemrushTraffic && !isNaN(parseInt(maxSemrushTraffic))) {
          filters.semrush_traffic = { ...(filters.semrush_traffic || {}), $lte: parseInt(maxSemrushTraffic) };
        }
        if (minSimilarwebTraffic && !isNaN(parseInt(minSimilarwebTraffic))) {
          filters.similarweb_traffic = { ...(filters.similarweb_traffic || {}), $gte: parseInt(minSimilarwebTraffic) };
        }
        if (maxSimilarwebTraffic && !isNaN(parseInt(maxSimilarwebTraffic))) {
          filters.similarweb_traffic = { ...(filters.similarweb_traffic || {}), $lte: parseInt(maxSimilarwebTraffic) };
        }
      }
      
      console.log('Full query filters object in adminList:', JSON.stringify(filters, null, 2));
      if (filters.dofollow_link) {
        console.log('adminList: Looking for dofollow_link value exactly equal to:', 
          typeof filters.dofollow_link === 'object' ? filters.dofollow_link.$eq : filters.dofollow_link);
      }
      
      // Use consistent method for both count and data retrieval
      const total = await strapi.entityService.count('api::marketplace.marketplace', { filters });
      
      // Fetch paginated data with entityService for consistency
      const entries = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters,
        sort: [{ updatedAt: 'desc' }, { id: 'desc' }], // Added secondary sort by ID to ensure consistent order
        start: (page - 1) * pageSize,
        limit: pageSize,
      });
      
      console.log(`Found ${entries.length} entries of ${total} total matches`);
      
      // Create formatted data array with consistent structure
      const formattedData = entries.map(entry => ({
        id: entry.id,
        url: entry.url || '',
        publisher_name: entry.publisher_name || '',
        publisher_email: entry.publisher_email || '',
        price: entry.price || '',
        category: entry.category || '',
        backlink_type: entry.backlink_type || '',
        ahrefs_dr: entry.ahrefs_dr || '',
        ahrefs_traffic: entry.ahrefs_traffic || '',
        moz_da: entry.moz_da || '',
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt
      }));
      
      // Send response with formatted data and pagination metadata
      ctx.send({
        data: formattedData,
        meta: {
          pagination: {
            page,
            pageSize,
            pageCount: Math.ceil(total / pageSize),
            total,
          }
        }
      });
    } catch (error) {
      console.error('Error in adminList:', error);
      ctx.badRequest(`Error fetching data: ${error.message}`);
    }
  },

  async exportSelected(ctx) {
    try {
      console.log('Export selected called with body:', ctx.request.body);
      
      // Get selected IDs from request body (POST) or query (GET)
      const ids = ctx.request.body?.ids || ctx.query.ids;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return ctx.badRequest('No IDs provided for export');
      }
      
      console.log(`Exporting ${ids.length} selected records with IDs:`, ids);
      
      // Fetch marketplace entries by IDs
      const entries = await strapi.entityService.findMany('api::marketplace.marketplace', {
        filters: { id: { $in: ids } },
      });
      
      console.log(`Found ${entries.length} entries to export`);
      
      if (entries.length === 0) {
        return ctx.badRequest('No entries found with the provided IDs');
      }
      
      // Format entries to handle category field
      const formattedEntries = entries.map(entry => {
        const formattedEntry = { ...entry };
        
        // Convert category to comma-separated string if it's an array or object
        if (formattedEntry.category) {
          if (Array.isArray(formattedEntry.category)) {
            formattedEntry.category = formattedEntry.category.join(', ');
          } else if (typeof formattedEntry.category === 'object') {
            formattedEntry.category = Object.values(formattedEntry.category).join(', ');
          }
        }
        
        // Convert other_category to comma-separated string if it's an array or object
        if (formattedEntry.other_category) {
          if (Array.isArray(formattedEntry.other_category)) {
            formattedEntry.other_category = formattedEntry.other_category.join(', ');
          } else if (typeof formattedEntry.other_category === 'object') {
            formattedEntry.other_category = Object.values(formattedEntry.other_category).join(', ');
          }
        }
        
        // Remove unwanted fields
        delete formattedEntry.id;
        delete formattedEntry.document;
        
        return formattedEntry;
      });
      
      // Get fields from first entry for complete data export
      const fields = Object.keys(formattedEntries[0]);
      
      // Convert to CSV
      const json2csvParser = new Parser({ fields });
      const csv = json2csvParser.parse(formattedEntries);
      
      // Set response headers for CSV download
      ctx.type = 'text/csv';
      ctx.attachment(`marketplace_selected_export_${new Date().toISOString().split('T')[0]}.csv`);
      
      // Send CSV data
      return ctx.send(csv);
    } catch (error) {
      console.error('Error in exportSelected:', error);
      return ctx.badRequest(`Error exporting selected data: ${error.message}`);
    }
  }
};