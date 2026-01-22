'use strict';

// Quick script to check mant2000.com in database

module.exports = async (strapi) => {
    console.log('\n=== Checking mant2000.com ===\n');

    // Check publisher-website table
    const publisherWebsites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: {
            url: { $contains: 'mant2000' }
        },
        populate: ['currentPublisherId']
    });

    console.log('Publisher Websites found:', publisherWebsites.length);
    publisherWebsites.forEach(pw => {
        console.log({
            id: pw.id,
            url: pw.url,
            submissionStatus: pw.submissionStatus,
            currentPublisherId: pw.currentPublisherId?.id || pw.currentPublisherId,
            publisherEmail: pw.publisherEmail,
            marketplaceId: pw.marketplaceId
        });
    });

    // Check marketplace table
    const marketplaceListings = await strapi.db.query('api::marketplace.marketplace').findMany({
        where: {
            url: { $contains: 'mant2000' }
        },
        populate: ['publisher']
    });

    console.log('\nMarketplace Listings found:', marketplaceListings.length);
    marketplaceListings.forEach(ml => {
        console.log({
            id: ml.id,
            url: ml.url,
            status: ml.status,
            publisher: ml.publisher?.id || ml.publisher,
            publisher_email: ml.publisher_email
        });
    });

    console.log('\n=== Done ===\n');
};
