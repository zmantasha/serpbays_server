'use strict';

/**
 * Gemini AI Content Generation Service
 * Calls Google Gemini API to generate guest post content
 */

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

/**
 * Call Gemini API and return cleaned HTML
 */
async function callGemini(apiKey, prompt, temperature = 0.8, maxOutputTokens = 8192) {
    const requestBody = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens },
    };

    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        const errorBody = await response.text();
        strapi.log.error(`[AI CONTENT] Gemini API error: ${response.status} - ${errorBody}`);
        throw new Error(`Gemini API request failed with status ${response.status}`);
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
        strapi.log.error('[AI CONTENT] Gemini returned empty content', JSON.stringify(data));
        throw new Error('Gemini API returned empty content');
    }

    let html = text.trim();
    if (html.startsWith('```html')) html = html.slice(7);
    else if (html.startsWith('```')) html = html.slice(3);
    if (html.endsWith('```')) html = html.slice(0, -3);
    return html.trim();
}

/**
 * Count words in an HTML string
 */
function countWords(html) {
    return html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
}

/**
 * Known abbreviations that should NOT be treated as sentence endings.
 */
const ABBREVIATIONS = new Set([
    'e.g', 'i.e', 'etc', 'vs', 'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr',
    'st', 'ave', 'blvd', 'dept', 'est', 'approx', 'inc', 'ltd', 'corp',
    'co', 'no', 'vol', 'fig', 'al', 'govt', 'org', 'dept',
]);

/**
 * Split text into sentences, handling abbreviations correctly.
 */
function splitSentences(text) {
    const sentences = [];
    let current = '';

    // Match periods, question marks, exclamation marks
    const parts = text.split(/([.!?]+)/);

    for (let i = 0; i < parts.length; i++) {
        current += parts[i];

        // If this part is punctuation
        if (/^[.!?]+$/.test(parts[i])) {
            // Check if it's an abbreviation (word before the period)
            const wordBefore = current.replace(/[.!?]+$/, '').trim().split(/\s+/).pop() || '';
            const isAbbreviation = ABBREVIATIONS.has(wordBefore.toLowerCase().replace(/\.$/, ''));

            // Check if next part starts with a lowercase letter (not a new sentence)
            const nextPart = (parts[i + 1] || '').trimStart();
            const nextStartsLower = nextPart.length > 0 && /^[a-z]/.test(nextPart);

            // It's a sentence break if: not an abbreviation AND (next starts uppercase OR is end of text)
            if (!isAbbreviation && !nextStartsLower) {
                const trimmed = current.trim();
                if (trimmed) sentences.push(trimmed);
                current = '';
            }
        }
    }

    // Remaining text
    const trimmed = current.trim();
    if (trimmed) sentences.push(trimmed);

    return sentences;
}

/**
 * Split overly long paragraphs into shorter ones (recursive).
 * Any <p> with more than maxSentences sentences gets split.
 */
function splitLongParagraphs(html, maxSentences = 3) {
    // First: if there are no <p> tags, wrap plain text blocks
    if (!/<p[\s>]/i.test(html)) {
        html = html.replace(/(?<=>)\s*([^<]{100,}?)\s*(?=<)/g, (match, text) => {
            return `<p>${text.trim()}</p>`;
        });
    }

    let changed = true;
    let passes = 0;

    // Recursive: keep splitting until all paragraphs are short enough (max 5 passes)
    while (changed && passes < 5) {
        changed = false;
        passes++;

        html = html.replace(/<p>([\s\S]*?)<\/p>/gi, (match, inner) => {
            const content = inner.trim();
            if (!content || content.length < 50) return match; // Skip tiny paragraphs

            // Strip inner HTML tags for sentence splitting, but keep original for output
            const plainText = content.replace(/<[^>]*>/g, '');
            const sentences = splitSentences(plainText);

            if (sentences.length <= maxSentences) {
                return match; // Short enough
            }

            changed = true;

            // Split roughly in half
            const midpoint = Math.ceil(sentences.length / 2);
            const firstSentences = sentences.slice(0, midpoint);
            const secondSentences = sentences.slice(midpoint);

            // Rebuild HTML: find the split point in the original HTML content
            // by locating the end of the last sentence in the first half
            const lastFirstSentence = firstSentences[firstSentences.length - 1];
            // Escape for regex and find in original content
            const escapedEnd = lastFirstSentence.slice(-30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const splitRegex = new RegExp(escapedEnd);
            const splitMatch = splitRegex.exec(content);

            if (splitMatch) {
                const splitIndex = splitMatch.index + splitMatch[0].length;
                const firstHalf = content.slice(0, splitIndex).trim();
                const secondHalf = content.slice(splitIndex).trim();
                if (firstHalf && secondHalf) {
                    return `<p>${firstHalf}</p>\n<p>${secondHalf}</p>`;
                }
            }

            // Fallback: simple text split (no HTML preservation)
            return `<p>${firstSentences.join(' ')}</p>\n<p>${secondSentences.join(' ')}</p>`;
        });
    }

    return html;
}

/**
 * Replace banned AI phrases with natural alternatives.
 * This runs AFTER Gemini generation to guarantee removal.
 */
function removeBannedPhrases(html) {
    // Map of banned phrase/word → replacement
    // Uses [word, replacement, flags] tuples. 'i' = case-insensitive, 'w' = whole word
    const replacements = [
        // Em dashes
        [/\s*—\s*/g, ', '],
        [/\s*–\s*/g, ', '],

        // Multi-word phrases first (order matters — longer matches before shorter)
        [/\bIn today'?s world\b/gi, 'Today'],
        [/\bIt'?s worth noting( that)?\b/gi, ''],
        [/\bIn conclusion\b/gi, 'Overall'],
        [/\bplays a crucial role\b/gi, 'matters greatly'],
        [/\bIt'?s important to note( that)?\b/gi, ''],
        [/\bat the end of the day\b/gi, 'ultimately'],
        [/\bwhen it comes to\b/gi, 'for'],
        [/\bIn this article\b/gi, 'Here'],
        [/\bLet'?s explore\b/gi, 'Consider'],
        [/\bWithout further ado\b/gi, ''],
        [/\bIn an era\b/gi, 'With'],
        [/\btake your .+? to the next level\b/gi, 'improve your results'],
        [/\bunlock the potential\b/gi, 'use the full power'],
        [/\block no further\b/gi, 'consider this'],
        [/\bharness the power\b/gi, 'use the strength'],
        [/\bdeep dive\b/gi, 'close look'],
        [/\bdive into\b/gi, 'look at'],
        [/\bdiving into\b/gi, 'looking at'],
        [/\bemerges as\b/gi, 'becomes'],
        [/\bthought leadership\b/gi, 'expert guidance'],
        [/\bbest-in-class\b/gi, 'top-tier'],
        [/\bworld-class\b/gi, 'excellent'],
        [/\bstate-of-the-art\b/gi, 'modern'],
        [/\bnext-generation\b/gi, 'modern'],
        [/\bever-evolving\b/gi, 'changing'],
        [/\bcutting-edge\b/gi, 'modern'],
        [/\bgame-changer\b/gi, 'major shift'],

        // Single words (case-insensitive, whole word)
        [/\blandscape\b/gi, 'space'],
        [/\bnavigate\b/gi, 'handle'],
        [/\bnavigating\b/gi, 'handling'],
        [/\bunpacking\b/gi, 'examining'],
        [/\bunpack\b/gi, 'examine'],
        [/\bcrafting\b/gi, 'building'],
        [/\bleverage\b/gi, 'use'],
        [/\bleveraging\b/gi, 'using'],
        [/\bdelve\b/gi, 'look into'],
        [/\bdelving\b/gi, 'looking into'],
        [/\btapestry\b/gi, 'mix'],
        [/\brealm\b/gi, 'area'],
        [/\bfostering\b/gi, 'building'],
        [/\bfoster\b/gi, 'build'],
        [/\bempowering\b/gi, 'helping'],
        [/\bempower\b/gi, 'help'],
        [/\bspearhead\b/gi, 'lead'],
        [/\bspearheading\b/gi, 'leading'],
        [/\bbolster\b/gi, 'strengthen'],
        [/\bbolstering\b/gi, 'strengthening'],
        [/\bunderscores\b/gi, 'highlights'],
        [/\bunderpins\b/gi, 'supports'],
        [/\bmultifaceted\b/gi, 'varied'],
        [/\bnuanced\b/gi, 'detailed'],
        [/\bcomprehensive\b/gi, 'complete'],
        [/\bstreamline\b/gi, 'simplify'],
        [/\bstreamlining\b/gi, 'simplifying'],
        [/\bpivotal\b/gi, 'key'],
        [/\bcornerstone\b/gi, 'foundation'],
        [/\blinchpin\b/gi, 'key piece'],
        [/\bseamlessly\b/gi, 'smoothly'],
        [/\brobust\b/gi, 'strong'],
        [/\bholistic\b/gi, 'complete'],
        [/\bparadigm\b/gi, 'model'],
        [/\bsynergy\b/gi, 'teamwork'],
        [/\bFurthermore\b/g, 'Also'],
        [/\bMoreover\b/g, 'Also'],
        [/\bInterestingly\b/g, 'Notably'],
        [/\brevolutionize\b/gi, 'transform'],
        [/\brevolutionizing\b/gi, 'transforming'],
        [/\becosystem\b/gi, 'system'],
        [/\bstakeholders\b/gi, 'people involved'],
        [/\bactionable\b/gi, 'practical'],
        [/\bscalable\b/gi, 'flexible'],
        [/\bimpactful\b/gi, 'effective'],
        [/\bgroundbreaking\b/gi, 'new'],
        [/\btrailblazing\b/gi, 'leading'],
        [/\belevate\b/gi, 'improve'],
        [/\belevating\b/gi, 'improving'],
        [/\bresonate\b/gi, 'connect'],
        [/\bresonating\b/gi, 'connecting'],
    ];

    for (const [pattern, replacement] of replacements) {
        html = html.replace(pattern, replacement);
    }

    // Clean up: fix double spaces and empty tags from removals
    html = html.replace(/  +/g, ' ');
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/,\s*,/g, ',');
    html = html.replace(/\.\s*\./g, '.');

    return html;
}

module.exports = {
    /**
     * Generate guest post content using Gemini API
     * @param {Object} params
     * @param {Array} params.links - Array of { anchorText, url } objects
     * @param {string} params.description - Topic/description to guide content generation
     * @param {string} params.title - Optional suggested title for the article
     * @param {string} params.language - Language for the content (default: English)
     * @param {number} params.minWordCount - Minimum word count (default 800)
     * @returns {Promise<string>} Generated HTML content
     */
    async generateContent({ links, description, title, language = 'English', minWordCount = 800 }) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY environment variable is not configured');
        }

        // Enforce a minimum floor of 800 words regardless of website setting
        const effectiveMinWordCount = Math.max(minWordCount, 800);

        // Build the link placement instructions
        const linkInstructions = links.map((link, i) => {
            const placement = i === 0
                ? 'Place this link in the 2nd or 3rd paragraph of the article, woven into a sentence where it adds context.'
                : `Place this link in a later section, at least 2 paragraphs after the previous link.`;
            return `Link ${i + 1}: anchor text "${link.anchorText}" pointing to ${link.url}\n  HTML: <a href="${link.url}">${link.anchorText}</a>\n  ${placement}`;
        }).join('\n\n');

        const titleInstruction = title
            ? `Use this as the article title in Title Case: "${title}". Wrap it in an <h1> tag as the very first element.`
            : 'Create a compelling, specific article title in Title Case. Wrap it in an <h1> tag as the very first element.';

        const languageInstruction = language !== 'English'
            ? `CRITICAL: Write the entire article in ${language}. Every single word, heading, and sentence must be in ${language}. Do not mix languages.`
            : '';

        const prompt = `You are an experienced journalist writing for a major publication. Write an 850-word article. This is NOT optional. The article MUST be at least 850 words.

${languageInstruction}

${description ? `Topic: ${description}` : `Write an informative article related to: "${links[0].anchorText}"`}

Links to embed naturally:
${linkInstructions}

STRUCTURE — follow this EXACTLY:

${titleInstruction}

<h2>[Descriptive heading about the background/context]</h2>
<p>Paragraph 1: 3-4 sentences</p>
<p>Paragraph 2: 3-4 sentences</p>
<p>Paragraph 3: 3-4 sentences</p>

<h2>[Descriptive heading about core strategies/methods]</h2>
<p>Paragraph 4: 3-4 sentences</p>
<p>Paragraph 5: 3-4 sentences</p>
<p>Paragraph 6: 3-4 sentences</p>

<h2>[Descriptive heading about practical applications]</h2>
<p>Paragraph 7: 3-4 sentences</p>
<p>Paragraph 8: 3-4 sentences</p>
<p>Paragraph 9: 3-4 sentences</p>

<h2>[Descriptive heading about common mistakes or tips]</h2>
<p>Paragraph 10: 3-4 sentences</p>
<p>Paragraph 11: 3-4 sentences</p>
<p>Paragraph 12: 3-4 sentences</p>

<h2>[Descriptive heading about future trends or next steps]</h2>
<p>Paragraph 13: 3-4 sentences</p>
<p>Paragraph 14: 3-4 sentences</p>

<p>Closing paragraph: 3-4 sentences (no heading)</p>

That is 5 sections with <h2> headings, 15 paragraphs total, each 3-4 sentences. Write EVERY single paragraph. Do NOT skip, merge, or shorten any.

Replace the [Descriptive heading...] placeholders with real, specific headings related to the topic. NEVER use "Section 1:" or numbering in headings.

SEO rules:
- Include the primary keyword from the anchor text in the <h1> title.
- Use related keywords naturally throughout.
- Front-load important keywords in the first 100 words.
- Each <h2> should contain a relevant keyword.
- Include specific data, numbers, or real examples.

Writing style:
- Write like a human journalist. Short punchy sentences mixed with medium ones.
- Never use em dashes. Use commas, periods, or semicolons.
- Never start a paragraph with "However," "Additionally," "Furthermore," or "That said,".
- First sentence must deliver value or a fact immediately. No filler intros.
- Use active voice. Be direct.

Format:
- <h1> for article title (Title Case). <h2> for section headings. <p> for paragraphs.
- No code fences, no markdown. Raw HTML only.
- No author bio, disclaimers, or meta info.
- Each link appears exactly once, woven naturally into a sentence.`;

        // Single API call — prompt is structured to reliably produce 800+ words
        let html = await callGemini(apiKey, prompt, 0.8, 8192);
        let wordCount = countWords(html);
        strapi.log.info(`[AI CONTENT] Generated: ~${wordCount} words`);

        // Post-process: wrap any bare text blocks (between tags) in <p> tags
        // This catches cases where Gemini outputs text without <p> wrappers
        html = html.replace(/(<\/h[12]>)\s*([^<]{50,?})\s*(?=<)/g, (match, closingTag, text) => {
            // Text after a heading that isn't wrapped in any tag — wrap each sentence group in <p>
            const trimmed = text.trim();
            if (!trimmed) return match;
            return `${closingTag}\n<p>${trimmed}</p>\n`;
        });
        // Also catch bare text at the very end of the content
        html = html.replace(/(<\/p>)\s*([^<]{50,})\s*$/g, (match, closingTag, text) => {
            const trimmed = text.trim();
            if (!trimmed) return match;
            return `${closingTag}\n<p>${trimmed}</p>`;
        });

        // Post-process: strip "Section X:" prefixes from headings
        html = html.replace(/<h2>(\s*)Section\s*\d+\s*[:.\-]\s*/gi, '<h2>$1');

        // Post-process: replace banned AI phrases with natural alternatives
        html = removeBannedPhrases(html);

        // Post-process: split any paragraphs longer than 3 sentences (recursive)
        const parasBefore = (html.match(/<p>/gi) || []).length;
        html = splitLongParagraphs(html, 3);
        const parasAfter = (html.match(/<p>/gi) || []).length;
        strapi.log.info(`[AI CONTENT] Paragraph split: ${parasBefore} → ${parasAfter}`);

        // Extract the title from the first <h1> tag
        const titleMatch = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
        const generatedTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';

        return { html, title: generatedTitle, wordCount };
    },

    /**
     * Generate SEO meta fields (title, description, slug, keywords) from article content
     * @param {Object} params
     * @param {string} params.content - The HTML article content
     * @returns {Promise<Object>} { title, metaDescription, slug, keywords }
     */
    async generateMeta({ content }) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY environment variable is not configured');
        }

        // Strip HTML tags to send plain text (shorter prompt, better results)
        const plainText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        // Truncate to ~3000 chars to stay within reasonable token limits
        const truncated = plainText.length > 3000 ? plainText.slice(0, 3000) + '...' : plainText;

        const prompt = `Analyze the following article and generate SEO metadata. Return ONLY a valid JSON object with no explanation, no markdown fences.

Article:
${truncated}

Return this exact JSON structure:
{
  "title": "SEO-optimized title under 100 characters",
  "metaDescription": "Compelling meta description under 160 characters that summarizes the article",
  "slug": "url-friendly-slug-3-to-5-words",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]
}

Rules:
- Title: engaging, under 100 chars, includes primary topic
- Meta description: under 160 chars, compelling summary with call to read
- Slug: lowercase, hyphenated, 3-5 words, no special characters
- Keywords: 5-8 relevant SEO keywords as an array of strings
- Return ONLY the JSON object, nothing else`;

        const requestBody = {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.4,
                maxOutputTokens: 512,
            }
        };

        const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            strapi.log.error(`[AI CONTENT] Gemini meta API error: ${response.status} - ${errorBody}`);
            throw new Error(`Gemini API request failed with status ${response.status}`);
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) {
            strapi.log.error('[AI CONTENT] Gemini returned empty meta content', JSON.stringify(data));
            throw new Error('Gemini API returned empty content');
        }

        // Parse JSON - strip code fences if present
        let jsonStr = text.trim();
        if (jsonStr.startsWith('```json')) jsonStr = jsonStr.slice(7);
        else if (jsonStr.startsWith('```')) jsonStr = jsonStr.slice(3);
        if (jsonStr.endsWith('```')) jsonStr = jsonStr.slice(0, -3);
        jsonStr = jsonStr.trim();

        const meta = JSON.parse(jsonStr);

        strapi.log.info(`[AI CONTENT] Generated meta: title="${meta.title}", slug="${meta.slug}"`);

        return {
            title: meta.title || '',
            metaDescription: meta.metaDescription || '',
            slug: meta.slug || '',
            keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
        };
    }
};
