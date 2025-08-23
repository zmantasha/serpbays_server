module.exports = {
  /**
   * After updating a website, handle marketplace creation/updates for approved websites
   */
  async afterUpdate(event) {
    const { result, params } = event;
    
    // PREVENT INFINITE LOOP: Only process if status JUST changed to 'approved' AND no marketplaceId exists yet
    // This means it's a new approval, not an update to existing approved website
    const wasJustApproved = result.submissionStatus === 'approved' && !result.marketplaceId;
    
    if (wasJustApproved) {
      const updatedWebsiteUrl = result.url;
      const updatedWebsiteId = result.id;
      
      console.log(`🎉 Website ${updatedWebsiteId} (${updatedWebsiteUrl}) was approved for the first time.`);
      
      // STEP 1: Create marketplace listing for the newly approved website
      console.log(`📝 Creating marketplace listing for approved website ${updatedWebsiteId}`);
      try {
        const controller = strapi.controller('api::publisher-website.publisher-website');
        if (controller && controller.createMarketplaceListing) {
          await controller.createMarketplaceListing(result);
          console.log(`✅ Marketplace listing created for website ${updatedWebsiteId}`);
        } else {
          console.error('❌ createMarketplaceListing method not found');
        }
      } catch (marketplaceError) {
        console.error('❌ Failed to create marketplace listing:', marketplaceError);
      }
      
      // STEP 2: Find all other approved websites with the same URL and transfer ownership
      const otherApprovedWebsites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: {
          url: updatedWebsiteUrl,
          submissionStatus: 'approved',
          id: { $ne: updatedWebsiteId } // Exclude the currently approved website
        },
        populate: ['marketplaceId'] // Populate marketplaceId to delist
      });
      
      if (otherApprovedWebsites.length > 0) {
        console.log(`🔄 Found ${otherApprovedWebsites.length} other approved websites with URL ${updatedWebsiteUrl}.`);
        
        for (const oldWebsite of otherApprovedWebsites) {
          console.log(`🔄 Transferring ownership for old website ${oldWebsite.id} (${oldWebsite.url}).`);
          
          // Update the old website to 'ownership_transferred'
          await strapi.entityService.update('api::publisher-website.publisher-website', oldWebsite.id, {
            data: {
              submissionStatus: 'ownership_transferred',
              ownershipTransferredAt: new Date().toISOString(),
              ownershipTransferReason: 'claimed_by_owner',
              newOwnerWebsiteId: updatedWebsiteId,
              // Keep other data intact for historical purposes
            }
          });
          console.log(`✅ Old website ${oldWebsite.id} status updated to 'ownership_transferred'.`);
          
          // Delist from marketplace if it had an entry
          if (oldWebsite.marketplaceId) {
            await strapi.entityService.update('api::marketplace.marketplace', oldWebsite.marketplaceId.id, {
              data: {
                status: 'delisted',
                delistedReason: 'ownership_transferred',
                delistedAt: new Date().toISOString()
              }
            });
            console.log(`📤 Marketplace listing ${oldWebsite.marketplaceId.id} delisted.`);
          }
        }
      }
      
      console.log(`✅ Ownership transfer process completed for URL: ${updatedWebsiteUrl}`);
    }
  },

  /**
   * Before creating a website, log the action for debugging
   */
  async beforeCreate(event) {
    const { data } = event.params;
    console.log(`🆕 Creating new website entry for URL: ${data.url} by ${data.publisherEmail}`);
  }
};