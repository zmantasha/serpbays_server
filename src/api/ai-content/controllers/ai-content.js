'use strict';

/**
 * AI Content Generation Controller
 * POST /api/ai-content/generate
 * POST /api/ai-content/generate-meta
 * GET  /api/ai-content/status
 */

const geminiService = require('../services/gemini');

const FREE_GENERATION_LIMIT = 5;
const COST_PER_GENERATION = 0.05;

/**
 * Extract and verify userId from JWT token in Authorization header.
 * Returns userId or sends an error response and returns null.
 */
async function authenticateUser(ctx) {
    const authHeader = ctx.request.header.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        ctx.unauthorized('Authentication token is required');
        return null;
    }

    const token = authHeader.replace('Bearer ', '');
    try {
        const decoded = await strapi.plugins['users-permissions'].services.jwt.verify(token);
        return decoded.id;
    } catch (err) {
        ctx.unauthorized('Invalid or expired token');
        return null;
    }
}

module.exports = {
    async generate(ctx) {
        try {
            const userId = await authenticateUser(ctx);
            if (!userId) return;

            const { links, anchorText, url, description, title, language, minWordCount, websiteDomain } = ctx.request.body;

            // Support both new multi-link format and legacy single-link format
            const linkEntries = links || [{ anchorText: anchorText?.trim(), url: url?.trim() }];

            // Validate at least one link with both fields
            if (!linkEntries.length || !linkEntries[0]?.anchorText || !linkEntries[0]?.url) {
                return ctx.badRequest('At least one link with anchor text and URL is required');
            }
            for (const link of linkEntries) {
                if (!link.anchorText?.trim() || !link.url?.trim()) {
                    return ctx.badRequest('Each link must have both anchor text and URL');
                }
            }

            // --- Billing check ---
            const user = await strapi.query('plugin::users-permissions.user').findOne({
                where: { id: userId },
                select: ['id', 'aiGenerationCount'],
            });

            const generationCount = user?.aiGenerationCount || 0;
            const isFree = generationCount < FREE_GENERATION_LIMIT;

            if (!isFree) {
                // Check wallet balance and charge $0.20
                const walletController = strapi.controller('api::user-wallet.user-wallet');
                const wallet = await walletController.getOrCreateWallet(userId);
                const totalAvailable = parseFloat(wallet.mainBalance || 0) + parseFloat(wallet.promoBalance || 0);

                if (totalAvailable < COST_PER_GENERATION) {
                    return ctx.send({
                        success: false,
                        error: 'insufficient_balance',
                        message: `Insufficient balance. You need $${COST_PER_GENERATION.toFixed(2)} to generate AI content. Please add funds to your wallet.`,
                        walletBalance: totalAvailable,
                        costPerGeneration: COST_PER_GENERATION,
                    }, 402);
                }

                // Deduct from wallet
                const topicLabel = description?.trim()
                    ? description.trim().substring(0, 80)
                    : linkEntries[0]?.anchorText || 'Untitled';
                const siteLabel = websiteDomain || 'Unknown site';

                await walletController.spendFunds(userId, COST_PER_GENERATION, null, {
                    description: `AI Content Generated — "${topicLabel}" for ${siteLabel}`,
                    metadata: {
                        feature: 'ai_content',
                        generationNumber: generationCount + 1,
                        websiteDomain: siteLabel,
                        topic: topicLabel,
                    },
                });

                strapi.log.info(`[AI CONTENT] Charged $${COST_PER_GENERATION} from user ${userId} (generation #${generationCount + 1})`);
            } else {
                strapi.log.info(`[AI CONTENT] Free generation for user ${userId} (${generationCount + 1}/${FREE_GENERATION_LIMIT})`);
            }

            // --- Generate content ---
            strapi.log.info(`[AI CONTENT] Generate request from user ${userId}: ${linkEntries.length} link(s), lang=${language || 'English'}`);

            const result = await geminiService.generateContent({
                links: linkEntries.map(l => ({ anchorText: l.anchorText.trim(), url: l.url.trim() })),
                description: description?.trim() || '',
                title: title?.trim() || '',
                language: language || 'English',
                minWordCount: minWordCount || 800,
            });

            // Increment generation count after successful generation
            await strapi.query('plugin::users-permissions.user').update({
                where: { id: userId },
                data: { aiGenerationCount: generationCount + 1 },
            });

            return ctx.send({
                success: true,
                content: result.html,
                title: result.title,
                wordCount: result.wordCount,
                generationCount: generationCount + 1,
                freeRemaining: Math.max(0, FREE_GENERATION_LIMIT - (generationCount + 1)),
            });
        } catch (error) {
            strapi.log.error('[AI CONTENT] Generation error:', error);
            return ctx.internalServerError(error.message || 'Failed to generate AI content');
        }
    },

    async generateMeta(ctx) {
        try {
            const userId = await authenticateUser(ctx);
            if (!userId) return;

            const { content } = ctx.request.body;

            if (!content || !content.trim()) {
                return ctx.badRequest('Article content is required to generate meta fields');
            }

            strapi.log.info(`[AI CONTENT] Meta generation request from user ${userId}`);

            const meta = await geminiService.generateMeta({ content: content.trim() });

            return ctx.send({ success: true, ...meta });
        } catch (error) {
            strapi.log.error('[AI CONTENT] Meta generation error:', error);
            return ctx.internalServerError(error.message || 'Failed to generate meta fields');
        }
    },

    async status(ctx) {
        try {
            const userId = await authenticateUser(ctx);
            if (!userId) return;

            const user = await strapi.query('plugin::users-permissions.user').findOne({
                where: { id: userId },
                select: ['id', 'aiGenerationCount'],
            });

            const generationCount = user?.aiGenerationCount || 0;
            const isFree = generationCount < FREE_GENERATION_LIMIT;

            // Get wallet balance
            let walletBalance = 0;
            try {
                const walletController = strapi.controller('api::user-wallet.user-wallet');
                const wallet = await walletController.getOrCreateWallet(userId);
                walletBalance = parseFloat(wallet.mainBalance || 0) + parseFloat(wallet.promoBalance || 0);
            } catch (e) {
                // Wallet may not exist yet, that's fine
            }

            return ctx.send({
                generationCount,
                freeRemaining: Math.max(0, FREE_GENERATION_LIMIT - generationCount),
                freeLimit: FREE_GENERATION_LIMIT,
                costPerGeneration: COST_PER_GENERATION,
                isFree,
                walletBalance: Math.round(walletBalance * 100) / 100,
            });
        } catch (error) {
            strapi.log.error('[AI CONTENT] Status error:', error);
            return ctx.internalServerError('Failed to fetch AI content status');
        }
    },
};
