module.exports = {
    async afterCreate(event) {
        const { result } = event;

        // Safety check: Ensure we have a valid user result with email and id
        if (!result || !result.email || !result.id) {
            return;
        }

        const userEmail = result.email;
        const userId = result.id;

        try {
            // 1. Find all orphaned websites for this email
            // meaning: publisherEmail matches, but currentPublisherId is NULL
            const orphanedSites = await strapi.db.query('api::publisher-website.publisher-website').findMany({
                where: {
                    publisherEmail: userEmail,
                    currentPublisherId: {
                        $null: true
                    }
                }
            });

            if (orphanedSites.length > 0) {
                strapi.log.info(`[Auto-Claim] Found ${orphanedSites.length} orphaned websites for new user ${userEmail} (ID: ${userId}). Linking now...`);

                // 2. Update each website individually using entityService
                // IMPORTANT: updateMany doesn't work for relations stored in link tables
                // We must use entityService.update() which properly creates relation entries
                let linkedCount = 0;
                for (const site of orphanedSites) {
                    try {
                        await strapi.entityService.update('api::publisher-website.publisher-website', site.id, {
                            data: {
                                currentPublisherId: userId,
                                originalPublisherId: userId
                            }
                        });
                        linkedCount++;
                    } catch (updateErr) {
                        strapi.log.error(`[Auto-Claim] Failed to link website ${site.id} (${site.url}):`, updateErr.message);
                    }
                }

                strapi.log.info(`[Auto-Claim] Successfully linked ${linkedCount}/${orphanedSites.length} websites to user ID ${userId}.`);
            }
        } catch (error) {
            // Log error but DO NOT throw, to prevent blocking the user registration flow
            console.error('[Auto-Claim] Failed to link orphaned websites:', error);
        }
    }
};
