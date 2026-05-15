#!/usr/bin/env node

/**
 * Follow-up to scripts/backfill-missing-marketplace-listings.js.
 *
 * That script created the marketplaces rows but skipped the metric-seed step
 * that normally runs in publisher-website afterUpdate (lines 189–237). So
 * those rows have correct prices / publisher info but every metric is NULL,
 * and the public marketplace page renders blank metric cells.
 *
 * This script mirrors that lifecycle metric-seed block exactly: for each
 * target marketplace row, pulls ahrefs/moz/semrush/placement fields from the
 * matching publisher_website (joined by URL) and writes via entityService so
 * the marketplace beforeUpdate lifecycle stamps lastMetricUpdateAt and the
 * update-history row.
 *
 * Default scope: marketplace ids 44838–44859 (the 22 we just backfilled).
 * Override with --ids=1,2,3 or --all-orphan-metrics to widen scope.
 *
 * Usage:
 *   node scripts/backfill-marketplace-metrics-for-recent-listings.js          # dry-run
 *   node scripts/backfill-marketplace-metrics-for-recent-listings.js --apply  # commit
 */

const { createStrapi } = require('@strapi/strapi');

const APPLY = process.argv.includes('--apply');
const ALL_ORPHAN = process.argv.includes('--all-orphan-metrics');
const idsArg = process.argv.find((a) => a.startsWith('--ids='));
const log = (...args) => process.stderr.write('[metrics-backfill] ' + args.join(' ') + '\n');

const DEFAULT_TARGET_IDS = Array.from({ length: 22 }, (_, i) => 44838 + i);

function resolvePlacementSpeed(pw) {
  // publisher_websites doesn't store placement_speed; derive from expectedTATHours
  // using the same buckets as the lifecycle's resolvePlacementSpeed (lines 200-211).
  const tat = typeof pw.expectedTATHours === 'number' ? pw.expectedTATHours : null;
  if (tat != null) {
    if (tat <= 24) return 'Ultra Fast';
    if (tat <= 72) return 'Fast';
    if (tat <= 168) return 'Normal';
    return 'Slow';
  }
  return 'Normal';
}

async function main() {
  log('starting (mode=' + (APPLY ? 'APPLY' : 'DRY-RUN') + ')');
  const app = await createStrapi().load();
  log('strapi loaded.');

  let targetIds;
  if (ALL_ORPHAN) {
    const orphan = await strapi.db.query('api::marketplace.marketplace').findMany({
      where: { ahrefs_dr: { $null: true }, moz_da: { $null: true } },
      select: ['id'],
    });
    targetIds = orphan.map((r) => r.id);
    log(`scope=all-orphan-metrics → ${targetIds.length} rows`);
  } else if (idsArg) {
    targetIds = idsArg
      .replace('--ids=', '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    log(`scope=cli-ids → ${targetIds.length} rows`);
  } else {
    targetIds = DEFAULT_TARGET_IDS;
    log(`scope=default → ids ${targetIds[0]}–${targetIds[targetIds.length - 1]}`);
  }

  const marketplaces = await strapi.db.query('api::marketplace.marketplace').findMany({
    where: { id: { $in: targetIds } },
    select: ['id', 'url', 'ahrefs_dr'],
  });
  log(`found marketplace rows: ${marketplaces.length}`);

  const urls = marketplaces.map((m) => m.url).filter(Boolean);
  const publisherRows = urls.length
    ? await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: { url: { $in: urls }, submissionStatus: 'approved' },
        select: [
          'id', 'url',
          'ahrefs_dr', 'ahrefs_traffic', 'ahrefs_rank',
          'ahrefs_referring_domain', 'ahrefs_keywords',
          'moz_da', 'moz_spam_score',
          'semrush_traffic', 'semrush_authority_score',
          'expectedTATHours',
        ],
      })
    : [];

  const pwByUrl = new Map();
  for (const pw of publisherRows) {
    if (!pwByUrl.has(pw.url)) pwByUrl.set(pw.url, pw);
  }

  const results = { ok: [], skipped: [], failed: [] };

  for (const m of marketplaces) {
    const pw = pwByUrl.get(m.url);
    if (!pw) {
      log(`  skip id=${m.id} url=${m.url} — no approved publisher_website found`);
      results.skipped.push({ id: m.id, url: m.url, reason: 'no_publisher_website' });
      continue;
    }

    const data = {
      ahrefs_dr: pw.ahrefs_dr ?? null,
      ahrefs_traffic: pw.ahrefs_traffic ?? null,
      ahrefs_rank: pw.ahrefs_rank ?? null,
      moz_da: pw.moz_da ?? null,
      spam_score: pw.moz_spam_score ?? null,
      semrush_traffic: pw.semrush_traffic ?? null,
      semrush_authority_score: pw.semrush_authority_score ?? null,
      ahrefs_referring_domain: pw.ahrefs_referring_domain ?? null,
      ahrefs_keywords: pw.ahrefs_keywords ?? null,
      placement_speed: resolvePlacementSpeed(pw),
      metrics_last_updated: new Date(),
      metrics_update_method: 'lifecycle_approved_seed',
    };

    if (!APPLY) {
      log(`  plan id=${m.id} url=${m.url} dr=${data.ahrefs_dr} moz=${data.moz_da} sem=${data.semrush_authority_score} traffic=${data.ahrefs_traffic}`);
      results.ok.push({ id: m.id, url: m.url, dryRun: true });
      continue;
    }

    try {
      await strapi.entityService.update('api::marketplace.marketplace', m.id, { data });
      log(`  ok id=${m.id} url=${m.url} dr=${data.ahrefs_dr} moz=${data.moz_da}`);
      results.ok.push({ id: m.id, url: m.url });
    } catch (err) {
      log(`  FAIL id=${m.id} url=${m.url} — ${err.message}`);
      results.failed.push({ id: m.id, url: m.url, error: err.message });
    }
  }

  log(`summary ok=${results.ok.length} skipped=${results.skipped.length} failed=${results.failed.length}`);
  await app.destroy();
  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write('[metrics-backfill] fatal: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
