'use strict';

/**
 * Bulk price update — server-side core.
 *
 * Parallel of the bulk metric refresh, but for price fields. Mirrors:
 *   - canonicalizeUrl helper
 *   - parseCsv with header aliases + lenient parsing
 *   - lookup-by-canonical-URL across publisher_websites + marketplaces
 *   - preview with classified row statuses
 *   - dual-write commit (publisher_websites first with skip-sync, then
 *     marketplace with _audit so history rows get source='bulk-price'
 *     and bulk_job_id)
 *
 * Differences vs metric refresh:
 *   - 11 price fields (general/copywriting + 4 niches × 2)
 *   - publisher-website is the canonical source; marketplace mirrors a
 *     subset (no copywriting marketplace column)
 *   - publisher commission math (PUBLISHER_COMMISSION_RATE) applied to
 *     derive publisher_price / publisher_link_insertion_price / etc.
 *     when mirroring to marketplace. Same logic as the publisher-website
 *     lifecycle uses for sync.
 *   - Export is filtered by PUBLISHER, not by oldest cohort
 *   - No per-tool refresh clock — price freshness is tracked by the
 *     existing lastPriceUpdateAt (single timestamp)
 */

const crypto = require('crypto');
const { parse: parseCsvSync } = require('csv-parse/sync');
const { getPublisherCommissionRate } = require('../../../constants/commission');
const { canonicalizeUrl } = require('./bulk-refresh');

// ---------------------------------------------------------------------------
// Field config
// ---------------------------------------------------------------------------

// publisher_website columns we'll write. Order = display order in the CSV.
const PRICE_FIELDS = [
  'generalGuestPostPrice',
  'generalLinkInsertionPrice',
  'copywritingPrice',
  'casinoGuestPostPrice',
  'casinoLinkInsertionPrice',
  'cryptoGuestPostPrice',
  'cryptoLinkInsertionPrice',
  'cbdGuestPostPrice',
  'cbdLinkInsertionPrice',
  'datingGuestPostPrice',
  'datingLinkInsertionPrice',
];

// Boolean fields admin can flip via the CSV. Live on publisher_websites
// only; marketplace doesn't have these columns — acceptance is implicit
// from price > 0 there. When admin sets <niche>Accepted = false in the
// CSV, we ALSO null the niche's prices in the same write so marketplace
// stays consistent.
const NICHE_ACCEPT_FIELDS = [
  'casinoAccepted',
  'cryptoAccepted',
  'cbdAccepted',
  'datingAccepted',
];

// Each niche's accept field + its two price fields. Used by the "auto-
// null prices when accept=false" rule.
const NICHE_GROUPS = [
  { accept: 'casinoAccepted', prices: ['casinoGuestPostPrice', 'casinoLinkInsertionPrice'] },
  { accept: 'cryptoAccepted', prices: ['cryptoGuestPostPrice', 'cryptoLinkInsertionPrice'] },
  { accept: 'cbdAccepted', prices: ['cbdGuestPostPrice', 'cbdLinkInsertionPrice'] },
  { accept: 'datingAccepted', prices: ['datingGuestPostPrice', 'datingLinkInsertionPrice'] },
];

// Human-friendly CSV column labels (what the export emits and what the
// upload accepts in its first row). Aliases below let the parser accept
// common variants.
const FIELD_LABELS = {
  generalGuestPostPrice: 'General Guest Post',
  generalLinkInsertionPrice: 'General Link Insertion',
  copywritingPrice: 'Copywriting',
  casinoGuestPostPrice: 'Casino Guest Post',
  casinoLinkInsertionPrice: 'Casino Link Insertion',
  cryptoGuestPostPrice: 'Crypto Guest Post',
  cryptoLinkInsertionPrice: 'Crypto Link Insertion',
  cbdGuestPostPrice: 'CBD Guest Post',
  cbdLinkInsertionPrice: 'CBD Link Insertion',
  datingGuestPostPrice: 'Dating Guest Post',
  datingLinkInsertionPrice: 'Dating Link Insertion',
  casinoAccepted: 'Casino Accepted',
  cryptoAccepted: 'Crypto Accepted',
  cbdAccepted: 'CBD Accepted',
  datingAccepted: 'Dating Accepted',
};

// Header aliases (case-insensitive after normalizeHeader) → canonical
// publisher_website field name. Each tool exports columns differently —
// we accept the common variants admin might paste back.
const HEADER_ALIASES = {
  // URL
  url: 'url',
  domain: 'url',
  'domain name': 'url',
  target: 'url',
  site: 'url',
  'site url': 'url',
  'website url': 'url',
  'root domain': 'url',
  // General
  'general guest post': 'generalGuestPostPrice',
  'general gp': 'generalGuestPostPrice',
  'guest post': 'generalGuestPostPrice',
  gp: 'generalGuestPostPrice',
  'general link insertion': 'generalLinkInsertionPrice',
  'general li': 'generalLinkInsertionPrice',
  'link insertion': 'generalLinkInsertionPrice',
  li: 'generalLinkInsertionPrice',
  // Copywriting
  copywriting: 'copywritingPrice',
  'copywriting price': 'copywritingPrice',
  // Casino
  'casino guest post': 'casinoGuestPostPrice',
  'casino gp': 'casinoGuestPostPrice',
  'casino link insertion': 'casinoLinkInsertionPrice',
  'casino li': 'casinoLinkInsertionPrice',
  // Crypto
  'crypto guest post': 'cryptoGuestPostPrice',
  'crypto gp': 'cryptoGuestPostPrice',
  'crypto link insertion': 'cryptoLinkInsertionPrice',
  'crypto li': 'cryptoLinkInsertionPrice',
  // CBD
  'cbd guest post': 'cbdGuestPostPrice',
  'cbd gp': 'cbdGuestPostPrice',
  'cbd link insertion': 'cbdLinkInsertionPrice',
  'cbd li': 'cbdLinkInsertionPrice',
  // Dating
  'dating guest post': 'datingGuestPostPrice',
  'dating gp': 'datingGuestPostPrice',
  'dating link insertion': 'datingLinkInsertionPrice',
  'dating li': 'datingLinkInsertionPrice',
  // Niche-accept toggles
  'casino accepted': 'casinoAccepted',
  'casino accept': 'casinoAccepted',
  'accepts casino': 'casinoAccepted',
  'crypto accepted': 'cryptoAccepted',
  'crypto accept': 'cryptoAccepted',
  'accepts crypto': 'cryptoAccepted',
  'cbd accepted': 'cbdAccepted',
  'cbd accept': 'cbdAccepted',
  'accepts cbd': 'cbdAccepted',
  'dating accepted': 'datingAccepted',
  'dating accept': 'datingAccepted',
  'accepts dating': 'datingAccepted',
};

const FIELD_BOUNDS = { min: 0, max: 999_999 };

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function coercePrice(rawValue) {
  if (rawValue === undefined || rawValue === null) return undefined;
  const s = String(rawValue).trim();
  if (s === '') return undefined;
  const cleaned = s.replace(/,/g, '').replace(/[$₹€£]/g, '').replace(/\s/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n;
}

// Accepts true/false/yes/no/1/0/y/n (case-insensitive). Empty → undefined
// (= "keep current"). Unparseable → null (= sentinel for "invalid").
function coerceBoolean(rawValue) {
  if (rawValue === undefined || rawValue === null) return undefined;
  const s = String(rawValue).trim().toLowerCase();
  if (s === '') return undefined;
  if (['true', 'yes', 'y', '1', 't'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'f'].includes(s)) return false;
  return null;
}

function parseCsv(csvText) {
  let records;
  try {
    records = parseCsvSync(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_records_with_error: true,
    });
  } catch (err) {
    const e = new Error(`Could not parse CSV: ${err.message || err}`);
    e.status = 400;
    throw e;
  }
  if (!Array.isArray(records) || records.length === 0) {
    const e = new Error('CSV is empty or only contains a header row.');
    e.status = 400;
    throw e;
  }

  const headerMap = {};
  const droppedHeaders = new Set();
  for (const header of Object.keys(records[0])) {
    const norm = normalizeHeader(header);
    const target = HEADER_ALIASES[norm];
    if (target) headerMap[header] = target;
    else droppedHeaders.add(header);
  }

  const rows = records.map((rec, index) => {
    const out = { _rowIndex: index + 2 };
    for (const [origKey, target] of Object.entries(headerMap)) {
      const raw = rec[origKey];
      if (target === 'url') {
        out.url = canonicalizeUrl(raw);
        out.urlRaw = raw;
      } else if (NICHE_ACCEPT_FIELDS.includes(target)) {
        const v = coerceBoolean(raw);
        if (v !== undefined) out[target] = v;
      } else {
        const v = coercePrice(raw);
        if (v !== undefined) out[target] = v;
      }
    }

    // Two consistency rules applied in order so the CSV produces a
    // semantically valid publisher_website state:
    //
    // 1) AUTO-ENABLE — if admin sets any of a niche's prices > 0, the
    //    niche must be accepted. Overrides any explicit false in the
    //    same row, since "Casino LI = 20" and "Casino Accepted = false"
    //    is internally inconsistent (admin gets a clear "false → true"
    //    diff in the preview so the resolution is visible).
    //    Most common cause: export emitted `Casino Accepted=false` as
    //    the row's current value; admin set a casino price > 0 but
    //    didn't think to also flip the boolean. System fills it in.
    //
    // 2) AUTO-NULL — if niche-accept is false (after step 1 had a chance
    //    to flip it), zero the niche's prices so the marketplace doesn't
    //    show offerings for a disabled niche.
    for (const group of NICHE_GROUPS) {
      const hasPositivePrice = group.prices.some(
        (f) => typeof out[f] === 'number' && out[f] > 0
      );
      if (hasPositivePrice) {
        out[group.accept] = true;
      }
      if (out[group.accept] === false) {
        for (const priceField of group.prices) {
          out[priceField] = 0;
        }
      }
    }
    return out;
  });

  return { rows, droppedHeaders: Array.from(droppedHeaders) };
}

function validatePrice(value) {
  if (value === null) return 'Not a number';
  if (!Number.isFinite(value)) return 'Not a number';
  if (value < FIELD_BOUNDS.min) return `Must be ≥ ${FIELD_BOUNDS.min}`;
  if (value > FIELD_BOUNDS.max) return `Must be ≤ ${FIELD_BOUNDS.max.toLocaleString()}`;
  return null;
}

function validateBoolean(value) {
  if (value === null) return 'Must be true/false (or yes/no/1/0)';
  if (typeof value !== 'boolean') return 'Must be true/false (or yes/no/1/0)';
  return null;
}

// ---------------------------------------------------------------------------
// Lookup — find publisher_website + marketplace pairs by canonical URL
// ---------------------------------------------------------------------------

async function lookupRowsByCanonicalUrls(canonicalUrls) {
  if (canonicalUrls.length === 0) return new Map();
  const wanted = new Set(canonicalUrls);

  // Find marketplaces (active) and publisher_websites (approved) by URL.
  const marketplaces = [];
  const publisherWebsites = [];
  const pageSize = 1000;

  let page = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await strapi.db.query('api::marketplace.marketplace').findMany({
      where: { status: 'active' },
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    if (rows.length === 0) break;
    marketplaces.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
    if (page > 200) break;
  }

  const matchedMarketplaces = new Map();
  for (const row of marketplaces) {
    const canon = canonicalizeUrl(row.url);
    if (canon && wanted.has(canon)) matchedMarketplaces.set(canon, row);
  }

  if (matchedMarketplaces.size > 0) {
    const matchedUrls = Array.from(matchedMarketplaces.values()).map((m) => m.url);
    page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await strapi.db.query('api::publisher-website.publisher-website').findMany({
        where: {
          url: { $in: matchedUrls },
          submissionStatus: 'approved',
        },
        limit: pageSize,
        offset: (page - 1) * pageSize,
      });
      if (rows.length === 0) break;
      publisherWebsites.push(...rows);
      if (rows.length < pageSize) break;
      page += 1;
      if (page > 200) break;
    }
  }

  const publisherWebsiteByCanon = new Map();
  for (const pw of publisherWebsites) {
    const canon = canonicalizeUrl(pw.url);
    if (!canon) continue;
    const existing = publisherWebsiteByCanon.get(canon);
    if (!existing || new Date(pw.updatedAt) > new Date(existing.updatedAt)) {
      publisherWebsiteByCanon.set(canon, pw);
    }
  }

  const map = new Map();
  for (const [canon, mp] of matchedMarketplaces) {
    const pw = publisherWebsiteByCanon.get(canon);
    if (pw) map.set(canon, { marketplace: mp, publisherWebsite: pw });
  }

  console.log(
    `[BULK-PRICE] lookup: wanted=${wanted.size} marketplaces=${matchedMarketplaces.size} ` +
    `publisher-websites=${publisherWebsiteByCanon.size} writable=${map.size}`
  );
  return map;
}

// ---------------------------------------------------------------------------
// Marketplace pricing mirror — replicates the publisher-website lifecycle's
// price-sync logic so we can dual-write with _audit context. Returns the
// data payload to pass to entityService.update('api::marketplace.marketplace').
// ---------------------------------------------------------------------------

function buildMarketplacePricingPayload(merged) {
  const COMMISSION_RATE = getPublisherCommissionRate();

  const data = {
    // Advertiser pricing (what the marketplace charges advertisers)
    price: merged.generalGuestPostPrice ?? null,
    link_insertion_price: merged.generalLinkInsertionPrice ?? null,
    adv_casino_pricing: merged.casinoGuestPostPrice ?? null,
    adv_li_casino_pricing: merged.casinoLinkInsertionPrice ?? null,
    adv_crypto_pricing: merged.cryptoGuestPostPrice ?? null,
    adv_li_crypto_pricing: merged.cryptoLinkInsertionPrice ?? null,
    adv_cbd_pricing: merged.cbdGuestPostPrice ?? null,
    adv_li_cbd_pricing: merged.cbdLinkInsertionPrice ?? null,
    adv_dating_pricing: merged.datingGuestPostPrice ?? null,
    adv_li_dating_pricing: merged.datingLinkInsertionPrice ?? null,

    // Publisher payouts — commission rate applied to the higher of
    // GP/LI in each niche. Matches the lifecycle's existing logic.
    publisher_price:
      (merged.generalGuestPostPrice > 0 || merged.generalLinkInsertionPrice > 0)
        ? Math.floor(Math.max(
            (merged.generalGuestPostPrice || 0) * COMMISSION_RATE,
            (merged.generalLinkInsertionPrice || 0) * COMMISSION_RATE
          )) || 1
        : null,
    publisher_link_insertion_price: merged.generalLinkInsertionPrice > 0
      ? Math.floor(merged.generalLinkInsertionPrice * COMMISSION_RATE)
      : null,
    publisher_casino_pricing:
      (merged.casinoGuestPostPrice > 0 || merged.casinoLinkInsertionPrice > 0)
        ? Math.floor(Math.max(
            (merged.casinoGuestPostPrice || 0) * COMMISSION_RATE,
            (merged.casinoLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
        : null,
    publisher_li_casino_pricing: merged.casinoLinkInsertionPrice > 0
      ? Math.floor(merged.casinoLinkInsertionPrice * COMMISSION_RATE)
      : null,
    publisher_crypto_pricing:
      (merged.cryptoGuestPostPrice > 0 || merged.cryptoLinkInsertionPrice > 0)
        ? Math.floor(Math.max(
            (merged.cryptoGuestPostPrice || 0) * COMMISSION_RATE,
            (merged.cryptoLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
        : null,
    publisher_li_crypto_pricing: merged.cryptoLinkInsertionPrice > 0
      ? Math.floor(merged.cryptoLinkInsertionPrice * COMMISSION_RATE)
      : null,
    publisher_cbd_pricing:
      (merged.cbdGuestPostPrice > 0 || merged.cbdLinkInsertionPrice > 0)
        ? Math.floor(Math.max(
            (merged.cbdGuestPostPrice || 0) * COMMISSION_RATE,
            (merged.cbdLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
        : null,
    publisher_li_cbd_pricing: merged.cbdLinkInsertionPrice > 0
      ? Math.floor(merged.cbdLinkInsertionPrice * COMMISSION_RATE)
      : null,
    publisher_dating_pricing:
      (merged.datingGuestPostPrice > 0 || merged.datingLinkInsertionPrice > 0)
        ? Math.floor(Math.max(
            (merged.datingGuestPostPrice || 0) * COMMISSION_RATE,
            (merged.datingLinkInsertionPrice || 0) * COMMISSION_RATE
          ))
        : null,
    publisher_li_dating_pricing: merged.datingLinkInsertionPrice > 0
      ? Math.floor(merged.datingLinkInsertionPrice * COMMISSION_RATE)
      : null,
  };

  // Drop niche fields whose source fields are NOT in the original
  // bulk-price patch — prevents wholesale-rebuild noise in history.
  // (Same defensive trim the publisher-website lifecycle does.)
  return data;
}

// ---------------------------------------------------------------------------
// Preview — pure read, NO writes
// ---------------------------------------------------------------------------

async function buildPreview({ csvText, csvFilename = null }) {
  const csvHash = crypto.createHash('sha256').update(csvText, 'utf8').digest('hex');
  const parsed = parseCsv(csvText);

  // Duplicate-upload detection (last 7 days for price jobs).
  let duplicateWarning = null;
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const dupRows = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').findMany({
      where: {
        csvFileHash: csvHash,
        status: 'complete',
        jobType: 'upload',
        tool: 'price',
        createdAt: { $gte: sevenDaysAgo },
      },
      limit: 1,
      orderBy: { createdAt: 'desc' },
    });
    if (dupRows.length > 0) {
      duplicateWarning = {
        previousJobId: dupRows[0].id,
        previousCreatedAt: dupRows[0].createdAt,
      };
    }
  } catch (err) {
    console.warn('[BULK-PRICE] duplicate check failed:', err.message);
  }

  const canonicalUrls = parsed.rows.map((r) => r.url).filter(Boolean);
  const rowMap = await lookupRowsByCanonicalUrls(canonicalUrls);

  let willUpdate = 0;
  let unchanged = 0;
  let outOfRange = 0;
  let unmatchedUrl = 0;

  const previewRows = parsed.rows.map((row) => {
    if (!row.url) {
      unmatchedUrl += 1;
      return {
        rowIndex: row._rowIndex,
        urlRaw: row.urlRaw || '',
        url: null,
        status: 'unmatched-url',
        reason: 'Missing or unparseable URL',
        current: null,
        next: {},
        changes: {},
        errors: {},
      };
    }
    const pair = rowMap.get(row.url);
    if (!pair) {
      unmatchedUrl += 1;
      return {
        rowIndex: row._rowIndex,
        urlRaw: row.urlRaw || row.url,
        url: row.url,
        status: 'unmatched-url',
        reason: 'No active marketplace + approved publisher-website for this domain',
        current: null,
        next: {},
        changes: {},
        errors: {},
      };
    }
    const { marketplace: mp, publisherWebsite: pw } = pair;

    const next = {};
    const errors = {};
    const changes = {};
    let anyError = false;
    let anyChange = false;

    for (const field of PRICE_FIELDS) {
      if (!(field in row)) continue;
      const incoming = row[field];
      const err = validatePrice(incoming);
      if (err) {
        errors[field] = err;
        anyError = true;
        continue;
      }
      next[field] = incoming;
      const currentRaw = pw[field];
      const current =
        currentRaw === null || currentRaw === undefined
          ? null
          : typeof currentRaw === 'number'
          ? currentRaw
          : parseFloat(currentRaw);
      if (current !== incoming) {
        changes[field] = { from: current, to: incoming };
        anyChange = true;
      }
    }

    // Niche-accept booleans — diff against current publisher_website value.
    for (const field of NICHE_ACCEPT_FIELDS) {
      if (!(field in row)) continue;
      const incoming = row[field];
      const err = validateBoolean(incoming);
      if (err) {
        errors[field] = err;
        anyError = true;
        continue;
      }
      next[field] = incoming;
      const current = !!pw[field];
      if (current !== incoming) {
        changes[field] = { from: current, to: incoming };
        anyChange = true;
      }
    }

    let status;
    if (anyError) {
      outOfRange += 1;
      status = 'out-of-range';
    } else if (anyChange) {
      willUpdate += 1;
      status = 'will-update';
    } else {
      unchanged += 1;
      status = 'unchanged';
    }

    return {
      rowIndex: row._rowIndex,
      urlRaw: row.urlRaw || row.url,
      url: row.url,
      marketplaceId: mp.id,
      publisherWebsiteId: pw.id,
      status,
      current: {
        ...Object.fromEntries(PRICE_FIELDS.map((f) => [f, pw[f] ?? null])),
        ...Object.fromEntries(NICHE_ACCEPT_FIELDS.map((f) => [f, !!pw[f]])),
      },
      next,
      changes,
      errors,
    };
  });

  return {
    profile: {
      label: 'Bulk price update',
      allowedFields: [...PRICE_FIELDS, ...NICHE_ACCEPT_FIELDS],
      fieldLabels: FIELD_LABELS,
      historySource: 'bulk-price',
    },
    csvHash,
    csvFilename,
    duplicateWarning,
    droppedHeaders: parsed.droppedHeaders,
    summary: {
      total: previewRows.length,
      willUpdate,
      unchanged,
      outOfRange,
      unmatchedUrl,
    },
    rows: previewRows,
  };
}

// ---------------------------------------------------------------------------
// Commit — dual-write to publisher_website + marketplace
// ---------------------------------------------------------------------------

const COMMIT_CHUNK_SIZE = 50;

async function commitCsv({ csvText, csvFilename = null, label = null, actor = null }) {
  const preview = await buildPreview({ csvText, csvFilename });

  const job = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').create({
    data: {
      tool: 'price',
      jobType: 'upload',
      status: 'processing',
      rowCount: preview.summary.total,
      updatedCount: 0,
      unchangedCount: 0,
      outOfRangeCount: preview.summary.outOfRange,
      unmatchedUrlCount: preview.summary.unmatchedUrl,
      csvFileHash: preview.csvHash,
      csvFilename: csvFilename ? String(csvFilename).slice(0, 500) : null,
      label: label ? String(label).slice(0, 250) : null,
      createdByUserId: actor?.id || null,
      createdByEmail: actor?.email || actor?.username || null,
    },
  });

  let updatedCount = 0;
  let unchangedCount = 0;

  const targets = preview.rows.filter(
    (r) => r.status === 'will-update' || r.status === 'unchanged'
  );

  try {
    for (let i = 0; i < targets.length; i += COMMIT_CHUNK_SIZE) {
      const chunk = targets.slice(i, i + COMMIT_CHUNK_SIZE);
      for (const row of chunk) {
        // 1) Publisher_website is the source of truth. Skip the
        //    lifecycle's auto-sync so we own the marketplace write.
        await strapi.entityService.update(
          'api::publisher-website.publisher-website',
          row.publisherWebsiteId,
          {
            data: {
              ...row.next,
              _skipMarketplaceSync: true,
            },
          }
        );

        // 2) Mirror to marketplace with audit context. Build the
        //    pricing payload using the same commission math the
        //    lifecycle uses. We pass the *merged* publisher-website
        //    state (current + new) so commission fields stay consistent
        //    when only one niche changes.
        const merged = { ...row.current, ...row.next };
        const mpData = buildMarketplacePricingPayload(merged);

        // Trim mpData to only price groups that actually changed in this
        // upload — otherwise marketplace lifecycle writes spurious "0 ↔ 0"
        // history entries for untouched niches.
        const changedKeys = new Set(Object.keys(row.next));
        const PRICE_SYNC_GROUPS = [
          { triggers: ['generalGuestPostPrice', 'generalLinkInsertionPrice'], fields: ['price', 'link_insertion_price', 'publisher_price', 'publisher_link_insertion_price'] },
          { triggers: ['casinoGuestPostPrice', 'casinoLinkInsertionPrice'], fields: ['adv_casino_pricing', 'adv_li_casino_pricing', 'publisher_casino_pricing', 'publisher_li_casino_pricing'] },
          { triggers: ['cryptoGuestPostPrice', 'cryptoLinkInsertionPrice'], fields: ['adv_crypto_pricing', 'adv_li_crypto_pricing', 'publisher_crypto_pricing', 'publisher_li_crypto_pricing'] },
          { triggers: ['cbdGuestPostPrice', 'cbdLinkInsertionPrice'], fields: ['adv_cbd_pricing', 'adv_li_cbd_pricing', 'publisher_cbd_pricing', 'publisher_li_cbd_pricing'] },
          { triggers: ['datingGuestPostPrice', 'datingLinkInsertionPrice'], fields: ['adv_dating_pricing', 'adv_li_dating_pricing', 'publisher_dating_pricing', 'publisher_li_dating_pricing'] },
        ];
        for (const group of PRICE_SYNC_GROUPS) {
          if (!group.triggers.some((t) => changedKeys.has(t))) {
            for (const f of group.fields) delete mpData[f];
          }
        }

        mpData._audit = {
          source: 'bulk-price',
          userId: actor?.id || null,
          changedBy: actor?.email || actor?.username || null,
          bulkJobId: job.id,
        };

        await strapi.entityService.update(
          'api::marketplace.marketplace',
          row.marketplaceId,
          { data: mpData }
        );

        if (row.status === 'will-update') updatedCount += 1;
        else unchangedCount += 1;
      }
    }

    await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').update({
      where: { id: job.id },
      data: {
        status: 'complete',
        updatedCount,
        unchangedCount,
      },
    });
  } catch (err) {
    console.error('[BULK-PRICE] commit failed:', err);
    await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').update({
      where: { id: job.id },
      data: {
        status: 'failed',
        errorMessage: String(err.message || err).slice(0, 4000),
        updatedCount,
        unchangedCount,
      },
    });
    throw err;
  }

  return {
    jobId: job.id,
    summary: {
      ...preview.summary,
      updated: updatedCount,
      unchanged: unchangedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Export by publisher
// ---------------------------------------------------------------------------

function buildCsvFromRows(publisherWebsites) {
  const orderedFields = [...PRICE_FIELDS, ...NICHE_ACCEPT_FIELDS];
  const headers = ['URL', ...orderedFields.map((f) => FIELD_LABELS[f])];
  const lines = [headers.join(',')];
  for (const pw of publisherWebsites) {
    const row = [pw.url || ''];
    for (const f of orderedFields) {
      const v = pw[f];
      if (NICHE_ACCEPT_FIELDS.includes(f)) {
        row.push(v === true ? 'true' : v === false ? 'false' : '');
      } else {
        row.push(v === null || v === undefined ? '' : String(v));
      }
    }
    lines.push(row.map((c) => csvEscape(c)).join(','));
  }
  return lines.join('\n') + '\n';
}

function csvEscape(s) {
  const str = String(s);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// Returns approved publisher-website rows whose currentPublisherId matches.
// Optionally restrict to a niche where that niche is accepted.
async function findPublisherSites({ publisherId, niche = null, limit = 5000 }) {
  const where = {
    submissionStatus: 'approved',
    currentPublisherId: { id: publisherId },
  };
  if (niche === 'casino') where.casinoAccepted = true;
  else if (niche === 'crypto') where.cryptoAccepted = true;
  else if (niche === 'cbd') where.cbdAccepted = true;
  else if (niche === 'dating') where.datingAccepted = true;

  return strapi.db.query('api::publisher-website.publisher-website').findMany({
    where,
    orderBy: { url: 'asc' },
    limit,
  });
}

async function exportByPublisher({ publisherId, niche = null, actor = null }) {
  if (!publisherId) {
    const e = new Error('publisherId is required');
    e.status = 400;
    throw e;
  }
  const sites = await findPublisherSites({ publisherId, niche });

  if (sites.length === 0) {
    const job = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').create({
      data: {
        tool: 'price',
        jobType: 'export',
        status: 'complete',
        rowCount: 0,
        createdByUserId: actor?.id || null,
        createdByEmail: actor?.email || actor?.username || null,
        label: `Price export · publisher ${publisherId}${niche ? ` · ${niche}` : ''} · 0 sites`,
      },
    });
    return {
      jobId: job.id,
      count: 0,
      csvText: ['URL', ...PRICE_FIELDS.map((f) => FIELD_LABELS[f])].join(',') + '\n',
      filename: `prices-publisher-${publisherId}-empty.csv`,
    };
  }

  const csvText = buildCsvFromRows(sites);

  const job = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').create({
    data: {
      tool: 'price',
      jobType: 'export',
      status: 'complete',
      rowCount: sites.length,
      createdByUserId: actor?.id || null,
      createdByEmail: actor?.email || actor?.username || null,
      label: `Price export · publisher ${publisherId}${niche ? ` · ${niche}` : ''} · ${sites.length} sites`,
    },
  });

  const filename = `prices-publisher-${publisherId}-${new Date().toISOString().slice(0, 10)}.csv`;
  return { jobId: job.id, count: sites.length, csvText, filename };
}

async function countPublisherSites({ publisherId, niche = null }) {
  if (!publisherId) return 0;
  const where = {
    submissionStatus: 'approved',
    currentPublisherId: { id: publisherId },
  };
  if (niche === 'casino') where.casinoAccepted = true;
  else if (niche === 'crypto') where.cryptoAccepted = true;
  else if (niche === 'cbd') where.cbdAccepted = true;
  else if (niche === 'dating') where.datingAccepted = true;
  return strapi.db.query('api::publisher-website.publisher-website').count({ where });
}

// ---------------------------------------------------------------------------
// Publisher list — for the dropdown
// ---------------------------------------------------------------------------

async function listPublishers({ search = '', limit = 50 }) {
  // Find users who have any approved publisher_website rows.
  // Search matches against username + email.
  const knex = strapi.db.connection;
  const q = String(search || '').trim().toLowerCase();
  const like = `%${q}%`;

  const sql = q
    ? `
      SELECT u.id, u.username, u.email,
             COUNT(pw.id)::int AS approved_site_count
      FROM up_users u
      INNER JOIN publisher_websites_current_publisher_id_lnk lnk
        ON lnk.user_id = u.id
      INNER JOIN publisher_websites pw
        ON pw.id = lnk.publisher_website_id AND pw.submission_status = 'approved'
      WHERE LOWER(u.username) LIKE ? OR LOWER(u.email) LIKE ?
      GROUP BY u.id, u.username, u.email
      ORDER BY approved_site_count DESC, u.email ASC
      LIMIT ?
    `
    : `
      SELECT u.id, u.username, u.email,
             COUNT(pw.id)::int AS approved_site_count
      FROM up_users u
      INNER JOIN publisher_websites_current_publisher_id_lnk lnk
        ON lnk.user_id = u.id
      INNER JOIN publisher_websites pw
        ON pw.id = lnk.publisher_website_id AND pw.submission_status = 'approved'
      GROUP BY u.id, u.username, u.email
      ORDER BY approved_site_count DESC, u.email ASC
      LIMIT ?
    `;

  const bindings = q ? [like, like, limit] : [limit];
  const { rows } = await knex.raw(sql, bindings);
  return rows;
}

module.exports = {
  PRICE_FIELDS,
  FIELD_LABELS,
  parseCsv,
  buildPreview,
  commitCsv,
  exportByPublisher,
  countPublisherSites,
  listPublishers,
};
