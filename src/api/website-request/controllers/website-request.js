'use strict';

/**
 * website-request controller
 */

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::website-request.website-request', ({ strapi }) => ({
  // Custom create method to handle website request submissions
  async create(ctx) {
    try {
      const { data } = ctx.request.body;
      const user = ctx.state.user;

      // Validate that user is authenticated
      if (!user) {
        return ctx.unauthorized('You must be logged in to submit a website request.');
      }

      // Validate that user is an advertiser
      if (!user.Advertiser) {
        return ctx.forbidden('Only advertisers can submit website requests.');
      }

      // Prepare the data for creation
      const requestData = {
        ...data,
        userEmail: user.email,
        status: 'pending',
        publishedAt: new Date()
      };

      // Create the website request
      const entity = await strapi.entityService.create('api::website-request.website-request', {
        data: requestData,
      });

      // Send email notification to outreach team (if email service is configured)
      try {
        const emailData = {
          to: process.env.OUTREACH_TEAM_EMAIL || 'outreach@serpbays.com',
          subject: `New Website Request - ${entity.requestType === 'specific' ? 'Specific Domains' : 'Criteria Based'}`,
          html: generateEmailTemplate(entity, user)
        };

        // TODO: Send email using your email service
        // await strapi.plugins.email.services.email.send(emailData);
        console.log('Website request email notification queued:', emailData.subject);
      } catch (emailError) {
        console.error('Failed to send email notification:', emailError);
        // Don't fail the request if email fails
      }

      return { data: entity };
    } catch (error) {
      console.error('Error creating website request:', error);
      return ctx.internalServerError('Failed to submit website request');
    }
  },

  // Custom find method to allow users to see their own requests
  async find(ctx) {
    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized('You must be logged in to view website requests.');
    }

    // Advertisers can only see their own requests
    if (user.Advertiser) {
      if (!ctx.query) ctx.query = {};
      if (!ctx.query.filters) ctx.query.filters = {};
      ctx.query.filters.userEmail = user.email;
    }
    // Admin users can see all requests (no filter applied)

    return await super.find(ctx);
  },

  // Custom findOne method with access control
  async findOne(ctx) {
    const user = ctx.state.user;

    if (!user) {
      return ctx.unauthorized('You must be logged in to view website requests.');
    }

    const entity = await strapi.entityService.findOne('api::website-request.website-request', ctx.params.id);

    if (!entity) {
      return ctx.notFound('Website request not found');
    }

    // Advertisers can only see their own requests
    if (user.Advertiser && entity.userEmail !== user.email) {
      return ctx.forbidden('You can only view your own website requests.');
    }

    return { data: entity };
  }
}));

// Helper function to generate email template
function generateEmailTemplate(request, user) {
  const formatValue = (value) => {
    if (value === null || value === undefined || value === '') return 'Not specified';
    return value;
  };

  const requestTypeText = request.requestType === 'specific' ? 'Specific Domains' : 'Website Criteria';
  
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #16a34a; border-bottom: 2px solid #16a34a; padding-bottom: 10px;">
        New Website Request - ${requestTypeText}
      </h2>
      
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #333;">User Information</h3>
        <p><strong>Email:</strong> ${user.email}</p>
        <p><strong>Name:</strong> ${user.username || user.email}</p>
        <p><strong>Request Type:</strong> ${requestTypeText}</p>
        <p><strong>Submitted:</strong> ${new Date().toLocaleString()}</p>
      </div>

      ${request.requestType === 'specific' ? `
        <div style="background-color: #e7f3ff; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #0066cc;">Specific Domains Requested</h3>
          <p style="font-weight: bold; color: #333;">${formatValue(request.specificDomains)}</p>
        </div>
      ` : `
        <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <h3 style="margin-top: 0; color: #856404;">Website Criteria</h3>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
            <p><strong>Category:</strong> ${formatValue(request.category)}</p>
            <p><strong>Content Type:</strong> ${formatValue(request.contentType)}</p>
            <p><strong>Min DR:</strong> ${formatValue(request.minDR)}</p>
            <p><strong>Max DR:</strong> ${formatValue(request.maxDR)}</p>
            <p><strong>Min DA:</strong> ${formatValue(request.minDA)}</p>
            <p><strong>Max DA:</strong> ${formatValue(request.maxDA)}</p>
            <p><strong>Min Traffic:</strong> ${formatValue(request.minTraffic)}</p>
            <p><strong>Max Traffic:</strong> ${formatValue(request.maxTraffic)}</p>
          </div>
        </div>
      `}

      <div style="background-color: #f1f5f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #334155;">Project Details</h3>
        <p><strong>Budget Range:</strong> ${formatValue(request.budgetRange)}</p>
        <p><strong>Timeline:</strong> ${formatValue(request.timeline)}</p>
        <p><strong>Contact Preference:</strong> ${formatValue(request.contactPreference)}</p>
        
        ${request.additionalRequirements ? `
          <div style="margin-top: 15px;">
            <strong>Additional Requirements:</strong>
            <div style="background-color: white; padding: 10px; border-radius: 3px; margin-top: 5px;">
              ${request.additionalRequirements.replace(/\n/g, '<br>')}
            </div>
          </div>
        ` : ''}
      </div>

      <div style="background-color: #fee2e2; border: 1px solid #fecaca; padding: 15px; border-radius: 5px; margin: 20px 0;">
        <h3 style="margin-top: 0; color: #991b1b;">Action Required</h3>
        <p>Please review this request and respond within 24-48 hours. You can view and manage this request in the admin panel.</p>
        <p><strong>Request ID:</strong> ${request.id}</p>
      </div>

      <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px;">
        <p>This is an automated notification from SerpBays Website Request System</p>
      </div>
    </div>
  `;
} 