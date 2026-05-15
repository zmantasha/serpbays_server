#!/usr/bin/env node

/**
 * One-shot: backfill `marketplaces` rows for publisher_websites that were
 * left in submissionStatus='approved' but never got a corresponding
 * marketplace listing (root-caused to the 2026-04-17 batch where the
 * approve controller silently swallowed errors from createMarketplaceListing).
 *
 * Strategy: reuse the exact helper the admin approve endpoint calls:
 *   publisher-website controller → createMarketplaceListing(publisher_website)
 * then write the resulting marketplaceId back onto the publisher_website row.
 *
 * Usage:
 *   node scripts/backfill-missing-marketplace-listings.js          # dry-run
 *   node scripts/backfill-missing-marketplace-listings.js --apply  # commit
 */

const { createStrapi } = require('@strapi/strapi');

const APPLY = process.argv.includes('--apply');
const log = (...args) => process.stderr.write('[backfill] ' + args.join(' ') + '\n');

async function main() {
  log('starting (mode=' + (APPLY ? 'APPLY' : 'DRY-RUN') + ')');
  const app = await createStrapi().load();
  log('strapi loaded.');

  const approved = await strapi.db
    .query('api::publisher-website.publisher-website')
    .findMany({
      where: { submissionStatus: 'approved' },
      select: ['id', 'url', 'publisherEmail', 'publisherName', 'submissionStatus'],
      populate: ['currentPublisherId', 'originalPublisherId'],
    });
  log('approved count=' + approved.length);

  const approvedUrls = approved.map((w) => w.url).filter(Boolean);
  const existingMarketplace = approvedUrls.length
    ? await strapi.db
        .query('api::marketplace.marketplace')
        .findMany({
          where: { url: { $in: approvedUrls } },
          select: ['url'],
        })
    : [];
  const hasMarketplace = new Set(existingMarketplace.map((r) => r.url));
  const missing = approved.filter((w) => w.url && !hasMarketplace.has(w.url));

  log(
    `summary approved=${approved.length} ` +
      `withMarketplace=${existingMarketplace.length} ` +
      `missingMarketplace=${missing.length}`
  );
  for (const w of missing) {
    log(`  - id=${w.id} url=${w.url} email=${w.publisherEmail || 'n/a'}`);
  }

  if (!APPLY || missing.length === 0) {
    log('done (no writes performed).');
    await app.destroy();
    return;
  }

  const controller = strapi.controller('api::publisher-website.publisher-website');
  if (!controller || typeof controller.createMarketplaceListing !== 'function') {
    log('ERROR createMarketplaceListing helper not found.');
    await app.destroy();
    process.exit(1);
  }

  const results = { ok: [], failed: [] };
  for (const w of missing) {
    const full = await strapi.entityService.findOne(
      'api::publisher-website.publisher-website',
      w.id,
      { populate: ['currentPublisherId', 'originalPublisherId'] }
    );
    try {
      const listing = await controller.createMarketplaceListing(full);
      if (!listing || !listing.id) {
        throw new Error('createMarketplaceListing returned no id');
      }
      await strapi.entityService.update(
        'api::publisher-website.publisher-website',
        w.id,
        { data: { marketplaceId: listing.id } }
      );
      log(`  ok id=${w.id} url=${w.url} → marketplace ${listing.id}`);
      results.ok.push({ id: w.id, url: w.url, marketplaceId: listing.id });
    } catch (err) {
      log(`  FAIL id=${w.id} url=${w.url} — ${err.message}`);
      results.failed.push({ id: w.id, url: w.url, error: err.message });
    }
  }

  log(`applied: ok=${results.ok.length} failed=${results.failed.length}`);
  await app.destroy();
  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write('[backfill] fatal: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
