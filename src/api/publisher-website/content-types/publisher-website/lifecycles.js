'use strict';

/**
 * publisher-website lifecycle events
 */

module.exports = {
  async beforeUpdate(event) {
    const { data, where } = event.params;
    
    // Get the current entry to check previous status
    let currentEntry;
    try {
      currentEntry = await strapi.entityService.findOne('api::publisher-website.publisher-website', where.id);
    } catch (error) {
      console.error('Error fetching current entry:', error);
      return; // Allow update to proceed if we can't fetch current entry
    }
    
    // If submissionStatus is being changed to 'approved', trigger the approval workflow
    if (data.submissionStatus === 'approved' && currentEntry && currentEntry.submissionStatus !== 'approved') {
      console.log('🔄 Approval detected through admin panel - triggering approval workflow');
      
      try {
        // Trigger the approval workflow by calling the controller's createMarketplaceListing method
        console.log('Calling approval workflow...');
        
        // First, update the submission with approval metadata
        data.reviewedAt = new Date();
        data.reviewedBy = 'admin-panel';
        data.approvedAt = new Date();
        data.reviewNotes = data.reviewNotes || 'Approved through admin panel';
        
        // After the update, we'll trigger marketplace creation in afterUpdate
        
      } catch (error) {
        console.error('❌ Error in approval workflow:', error);
        // Allow the direct update to proceed as fallback
        console.log('⚠️ Falling back to direct status update');
      }
    }
    
    // If submissionStatus is being changed to 'rejected', allow but log
    if (data.submissionStatus === 'rejected' && currentEntry && currentEntry.submissionStatus !== 'rejected') {
      console.log('⚠️ Direct rejection through admin panel - consider using API endpoint for complete workflow');
      
      // Add rejection metadata
      data.reviewedAt = new Date();
      data.reviewedBy = 'admin-panel';
      data.rejectionReason = data.rejectionReason || 'Rejected through admin panel';
    }
  },

  async afterUpdate(event) {
    const { result, params } = event;
    
    // Log status changes for debugging
    if (params.data.submissionStatus) {
      console.log(`📋 Publisher website ${result.id} status changed to: ${params.data.submissionStatus}`);
      
      // If status was changed to approved, create marketplace listing
      if (params.data.submissionStatus === 'approved') {
        console.log('🚀 Creating marketplace listing for approved website...');
        
        try {
          // Get the full updated entry
          const updatedEntry = await strapi.entityService.findOne('api::publisher-website.publisher-website', result.id);
          
          // Get the controller and call createMarketplaceListing
          const controller = strapi.controller('api::publisher-website.publisher-website');
          
          if (controller && controller.createMarketplaceListing) {
            await controller.createMarketplaceListing(updatedEntry);
            console.log('✅ Marketplace listing created successfully through lifecycle hook');
          } else {
            console.log('⚠️ Controller or createMarketplaceListing method not found');
          }
        } catch (error) {
          console.error('❌ Error creating marketplace listing:', error);
          console.error('This may need manual intervention');
        }
      }
    }
  }
};
