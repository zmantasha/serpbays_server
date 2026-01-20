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
                // console.log intentionally used here (if not suppressed) for audit trail, 
                // or rely on console.error if needed. But standard log is fine as we handled suppression globally.
                // We can use strapi.log.info if available, but console.log is standard.
                // Given we just suppressed console.log in prod, maybe we should use strapi.log.info? 
                // Strapi v5 logger: strapi.log.info(...)

                strapi.log.info(`[Auto-Claim] Found ${orphanedSites.length} orphaned websites for new user ${userEmail} (ID: ${userId}). Linking now...`);

                // 2. Bulk update them to set the new owner
                const updateResult = await strapi.db.query('api::publisher-website.publisher-website').updateMany({
                    where: {
                        id: {
                            $in: orphanedSites.map(site => site.id)
                        }
                    },
                    data: {
                        currentPublisherId: userId
                    }
                });

                strapi.log.info(`[Auto-Claim] Successfully linked ${updateResult.count || orphanedSites.length} websites to user ID ${userId}.`);
            }
        } catch (error) {
            // Log error but DO NOT throw, to prevent blocking the user registration flow
            console.error('[Auto-Claim] Failed to link orphaned websites:', error);
        }
    }
};
