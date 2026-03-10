module.exports = {
    async afterCreate(event) {
        const { result } = event;

        console.log('[Auto-Claim DEBUG] afterCreate triggered for user:', result?.email, result?.id);

        // Safety check: Ensure we have a valid user result with email and id
        if (!result || !result.email || !result.id) {
            console.log('[Auto-Claim DEBUG] Missing result/email/id, skipping');
            return;
        }

        const userEmail = result.email;
        const userId = result.id;

        try {
            // Use raw database query to find orphaned websites
            // Strapi's $null operator doesn't work correctly for relations stored in link tables
            const knex = strapi.db.connection;

            const orphanedSites = await knex('publisher_websites AS pw')
                .leftJoin('publisher_websites_current_publisher_id_lnk AS lnk', 'pw.id', 'lnk.publisher_website_id')
                .whereNull('lnk.user_id')
                .where('pw.publisher_email', userEmail)
                .select('pw.id', 'pw.url', 'pw.publisher_email');

            console.log(`[Auto-Claim DEBUG] Found ${orphanedSites.length} orphaned sites for ${userEmail}:`, orphanedSites.map(s => s.url));

            if (orphanedSites.length > 0) {
                strapi.log.info(`[Auto-Claim] Found ${orphanedSites.length} orphaned websites for new user ${userEmail} (ID: ${userId}). Linking now...`);

                // Update each website individually using entityService
                let linkedCount = 0;
                for (const site of orphanedSites) {
                    try {
                        console.log(`[Auto-Claim DEBUG] Linking website ${site.id} (${site.url}) to user ${userId}`);
                        await strapi.entityService.update('api::publisher-website.publisher-website', site.id, {
                            data: {
                                currentPublisherId: userId,
                                originalPublisherId: userId
                            }
                        });
                        linkedCount++;
                        console.log(`[Auto-Claim DEBUG] Successfully linked website ${site.id}`);
                    } catch (updateErr) {
                        console.error(`[Auto-Claim ERROR] Failed to link website ${site.id} (${site.url}):`, updateErr.message);
                        strapi.log.error(`[Auto-Claim] Failed to link website ${site.id} (${site.url}):`, updateErr.message);
                    }
                }

                strapi.log.info(`[Auto-Claim] Successfully linked ${linkedCount}/${orphanedSites.length} websites to user ID ${userId}.`);
                console.log(`[Auto-Claim DEBUG] Finished: linked ${linkedCount}/${orphanedSites.length} websites`);
            } else {
                console.log(`[Auto-Claim DEBUG] No orphaned sites found for ${userEmail}`);
            }
        } catch (error) {
            // Log error but DO NOT throw, to prevent blocking the user registration flow
            console.error('[Auto-Claim ERROR] Failed to link orphaned websites:', error);
        }
    }
};

