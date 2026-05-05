'use strict';

/**
 * exit-intent-lead lifecycle hooks
 *
 * Dedup policy: if the same email (or same Clerk user ID) submitted in
 * the last 24 hours, mark the new submission as `spam` so sales doesn't
 * re-contact the same person twice. We still persist the row — the
 * submission text might differ and could be useful context — we just
 * push it out of the active queue via status.
 *
 * The check runs in beforeCreate so the new row is tagged before insert,
 * keeping a single round trip and avoiding any visible state for sales.
 *
 * Schema has no components or relations on this collection, so lifecycle
 * hooks are safe here (they're known to misbehave when combined with
 * components + relations on the same write — see the Strapi v5 caveat).
 */

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

module.exports = {
    async beforeCreate(event) {
        const { data } = event.params;
        if (!data) return;

        // Don't override an explicitly-set status (e.g. an admin
        // creating a row by hand and tagging it).
        if (data.status && data.status !== 'new') return;

        const sinceIso = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();

        const filters = [];
        if (data.email) filters.push({ email: data.email });
        if (data.clerkUserId) filters.push({ clerkUserId: data.clerkUserId });
        if (filters.length === 0) return;

        try {
            const existing = await strapi.db
                .query('api::exit-intent-lead.exit-intent-lead')
                .findOne({
                    where: {
                        $or: filters,
                        createdAt: { $gt: sinceIso },
                    },
                    select: ['id'],
                });

            if (existing) {
                data.status = 'spam';
                data.internalNotes =
                    `Auto-flagged: duplicate submission within 24h of lead #${existing.id}.` +
                    (data.internalNotes ? `\n\n${data.internalNotes}` : '');
                strapi.log.info(
                    `[exit-intent-lead] dedup: tagged new submission as spam (matches lead #${existing.id})`
                );
            }
        } catch (err) {
            // Don't block the create on a dedup-check failure. Worst case
            // we get a duplicate row and sales notices manually.
            strapi.log.warn(`[exit-intent-lead] dedup check failed: ${err.message}`);
        }
    },
};
