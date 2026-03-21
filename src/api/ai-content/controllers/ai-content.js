'use strict';

/**
 * AI Content Generation Controller
 * POST /api/ai-content/generate
 */

const geminiService = require('../services/gemini');

module.exports = {
    async generate(ctx) {
        try {
            // Manually verify JWT since this is a custom route with auth: false
            const authHeader = ctx.request.header.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return ctx.unauthorized('Authentication token is required');
            }

            const token = authHeader.replace('Bearer ', '');
            let userId;
            try {
                const decoded = await strapi.plugins['users-permissions'].services.jwt.verify(token);
                userId = decoded.id;
            } catch (err) {
                return ctx.unauthorized('Invalid or expired token');
            }

            const { links, anchorText, url, description, title, language, minWordCount } = ctx.request.body;

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

            strapi.log.info(`[AI CONTENT] Generate request from user ${userId}: ${linkEntries.length} link(s), lang=${language || 'English'}`);

            const result = await geminiService.generateContent({
                links: linkEntries.map(l => ({ anchorText: l.anchorText.trim(), url: l.url.trim() })),
                description: description?.trim() || '',
                title: title?.trim() || '',
                language: language || 'English',
                minWordCount: minWordCount || 800,
            });

            return ctx.send({
                success: true,
                content: result.html,
                title: result.title,
                wordCount: result.wordCount,
            });
        } catch (error) {
            strapi.log.error('[AI CONTENT] Generation error:', error);
            return ctx.internalServerError(error.message || 'Failed to generate AI content');
        }
    },

    async generateMeta(ctx) {
        try {
            const authHeader = ctx.request.header.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return ctx.unauthorized('Authentication token is required');
            }

            const token = authHeader.replace('Bearer ', '');
            let userId;
            try {
                const decoded = await strapi.plugins['users-permissions'].services.jwt.verify(token);
                userId = decoded.id;
            } catch (err) {
                return ctx.unauthorized('Invalid or expired token');
            }

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
};
