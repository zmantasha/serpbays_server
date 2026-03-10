'use strict';

/**
 * One-time migration script to fix marketplace entries with NULL publisher relation
 * This script links marketplace entries to their corresponding user IDs based on publisher_email
 *
 * Run with: node scripts/fix-marketplace-publisher.js
 */

const { createStrapi } = require('@strapi/strapi');

async function fixMarketplacePublisher() {
    let strapi;
    try {
        console.log('Starting Strapi...');
        strapi = await createStrapi().load();
        await strapi.start();

        console.log('\n=== Fixing Marketplace Publisher Relations ===\n');

        // Find all marketplace entries with NULL publisher but valid publisher_email
        const marketplaceEntries = await strapi.db.query('api::marketplace.marketplace').findMany({
            where: {
                publisher: { $null: true },
                publisher_email: { $notNull: true }
            }
        });

        console.log(`Found ${marketplaceEntries.length} marketplace entries with NULL publisher\n`);

        let fixed = 0;
        let notFound = 0;
        let errors = 0;

        for (const entry of marketplaceEntries) {
            console.log(`Processing: ${entry.url} (email: ${entry.publisher_email})`);

            try {
                // Find user by email
                const user = await strapi.db.query('plugin::users-permissions.user').findOne({
                    where: { email: entry.publisher_email }
                });

                if (user) {
                    // Update marketplace entry with the user ID
                    await strapi.db.query('api::marketplace.marketplace').update({
                        where: { id: entry.id },
                        data: { publisher: user.id }
                    });
                    console.log(`  ✅ Linked to user ID: ${user.id}`);
                    fixed++;
                } else {
                    // Try to find in publisher-website by URL and get the currentPublisherId
                    const publisherWebsite = await strapi.db.query('api::publisher-website.publisher-website').findOne({
                        where: {
                            url: entry.url,
                            submissionStatus: 'approved'
                        },
                        populate: ['currentPublisherId']
                    });

                    if (publisherWebsite && publisherWebsite.currentPublisherId) {
                        const publisherId = typeof publisherWebsite.currentPublisherId === 'object'
                            ? publisherWebsite.currentPublisherId.id
                            : publisherWebsite.currentPublisherId;

                        await strapi.db.query('api::marketplace.marketplace').update({
                            where: { id: entry.id },
                            data: { publisher: publisherId }
                        });
                        console.log(`  ✅ Linked via publisher-website to user ID: ${publisherId}`);
                        fixed++;
                    } else {
                        console.log(`  ⚠️ User not found for email: ${entry.publisher_email}`);
                        notFound++;
                    }
                }
            } catch (error) {
                console.log(`  ❌ Error: ${error.message}`);
                errors++;
            }
        }

        console.log('\n=== Summary ===');
        console.log(`Total processed: ${marketplaceEntries.length}`);
        console.log(`Fixed: ${fixed}`);
        console.log(`User not found: ${notFound}`);
        console.log(`Errors: ${errors}`);
        console.log('===============\n');

    } catch (error) {
        console.error('Migration failed:', error);
    } finally {
        if (strapi) {
            await strapi.destroy();
        }
        process.exit(0);
    }
}

fixMarketplacePublisher();
