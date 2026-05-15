'use strict';

/**
 * Bulk metric refresh — server-side core.
 *
 * The admin pipeline:
 *   1. EXPORT (Phase 3) — admin downloads a CSV of domains for one tool.
 *      Advances last_<tool>_export_at on the selected marketplace rows.
 *   2. RUN EXTERNALLY — admin pastes that list into Ahrefs / Moz /
 *      Semrush's batch-analysis UI, runs it, downloads the tool's
 *      CSV with metric columns alongside the URL.
 *   3. UPLOAD — admin drops the tool's CSV into the upload wizard.
 *      We parse, canonicalize URLs, look up marketplace rows, validate
 *      values against per-tool bounds, and return a per-row preview
 *      with statuses (will-update / unchanged / out-of-range / unmatched-URL).
 *      NO writes happen here.
 *   4. COMMIT — admin reviews preview, clicks confirm. We open a job
 *      row, walk the parsed rows in chunks, update via entityService
 *      so the marketplace lifecycle fires audit hooks. Advances
 *      last_<tool>_refresh_at on every row we touched (attestation
 *      model — even unchanged rows get their clock advanced because
 *      uploading the CSV is admin's attestation that today's tool
 *      data was looked at).
 *
 * Tool ownership is enforced by the per-tool profile's allowedFields:
 * an Ahrefs CSV can NEVER write to moz_da, even if the CSV has a
 * "Domain Authority" column. That guards against picking the wrong
 * tool dropdown.
 */

const crypto = require('crypto');
const { parse: parseCsvSync } = require('csv-parse/sync');
const { getProfile, listTools } = require('./bulk-refresh-profiles');

// ---------------------------------------------------------------------------
// URL canonicalization
// ---------------------------------------------------------------------------

function canonicalizeUrl(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^https?:\/\//, '');
  s = s.replace(/^www\./, '');
  s = s.replace(/\/+$/, '');
  s = s.replace(/[?#].*$/, ''); // strip query + fragment
  s = s.trim();
  if (!s || s.includes(' ')) return null;
  return s;
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function coerceMetric(rawValue) {
  if (rawValue === undefined || rawValue === null) return undefined;
  const s = String(rawValue).trim();
  if (s === '') return undefined;
  // Strip common thousands separators (Ahrefs CSVs sometimes export "1,234").
  const cleaned = s.replace(/,/g, '').replace(/\s/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null; // sentinel for "present but unparseable"
  return n;
}

function parseCsv(csvText, tool) {
  const profile = getProfile(tool);
  if (!profile) throw new Error(`Unknown tool: ${tool}`);

  // csv-parse defaults are strict and reject any unbalanced quote or
  // unexpected quote char (Ahrefs / Moz / Semrush exports frequently
  // include literal hash, ampersand, or quote characters in titles).
  // Relax the parser so legitimate exports don't 500. If the CSV is
  // genuinely malformed past the point of recovery, we still throw with
  // a useful message that the controller surfaces as 400.
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
    const msg = err && err.message ? err.message : 'Failed to parse CSV';
    const parseErr = new Error(`Could not parse CSV: ${msg}`);
    parseErr.status = 400;
    throw parseErr;
  }
  if (!Array.isArray(records) || records.length === 0) {
    const parseErr = new Error(
      'CSV is empty or only contains a header row. Make sure your file has at least one data row.'
    );
    parseErr.status = 400;
    throw parseErr;
  }

  // Build a lowercase header → canonical-field-name map for this CSV.
  // Headers we don't recognize get dropped (and reported) — they can't
  // be written under any tool profile.
  const headerMap = {};
  const droppedHeaders = new Set();
  if (records.length > 0) {
    for (const header of Object.keys(records[0])) {
      const norm = normalizeHeader(header);
      const target = profile.headerAliases[norm];
      if (target) headerMap[header] = target;
      else droppedHeaders.add(header);
    }
  }

  // Reshape every record into { url, ...allowedFieldValues }.
  const rows = records.map((rec, index) => {
    const out = { _rowIndex: index + 2 /* +2 = +1 header, +1 1-indexed */ };
    for (const [origKey, target] of Object.entries(headerMap)) {
      const raw = rec[origKey];
      if (target === 'url') {
        out.url = canonicalizeUrl(raw);
        out.urlRaw = raw;
      } else if (profile.allowedFields.includes(target)) {
        const v = coerceMetric(raw);
        if (v !== undefined) out[target] = v;
      }
    }
    return out;
  });

  return { rows, droppedHeaders: Array.from(droppedHeaders) };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateField(profile, field, value) {
  const def = profile.fieldBounds[field];
  if (!def) return 'Field not allowed';
  if (value === null) return 'Not a number';
  if (!Number.isFinite(value)) return 'Not a number';
  if (value < def.min) return `Must be ≥ ${def.min}`;
  if (value > def.max) return `Must be ≤ ${def.max.toLocaleString()}`;
  if (def.integer && !Number.isInteger(value)) return 'Must be a whole number';
  return null;
}

// ---------------------------------------------------------------------------
// Preview — pure read, NO writes
// ---------------------------------------------------------------------------

// Returns Map<canonicalUrl, { marketplace, publisherWebsite }>. Both must
// exist for the row to be writable — bulk-refresh only refreshes sites
// that are LIVE on the marketplace AND have an approved publisher-website
// source row to write back to. If either is missing the CSV row will be
// reported as unmatched.
async function lookupRowsByCanonicalUrls(canonicalUrls) {
  if (canonicalUrls.length === 0) return new Map();

  const wanted = new Set(canonicalUrls);

  // Scan all active marketplaces, then for the URLs that matched, scan
  // the matching publisher-websites with submissionStatus='approved'.
  // At ~hundreds of active rows this is a one-page scan. When the
  // dataset grows we can add a generated canonical_url column + index.
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

  // Match marketplaces to wanted canonical URLs.
  const matchedMarketplaces = new Map(); // canon → marketplace row
  for (const row of marketplaces) {
    const canon = canonicalizeUrl(row.url);
    if (canon && wanted.has(canon)) matchedMarketplaces.set(canon, row);
  }

  // Find publisher-websites for the matched URLs. We search by raw URL
  // first; if that misses we'd need a broader scan. The bulk import path
  // here originally added publisher-websites via the same canonical
  // input, so direct match works for most cases.
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

  // Build canon → publisher-website map. If multiple publisher-websites
  // share a URL (ownership transfer history), prefer the one with the
  // most recent updatedAt — that's the active record.
  const publisherWebsiteByCanon = new Map();
  for (const pw of publisherWebsites) {
    const canon = canonicalizeUrl(pw.url);
    if (!canon) continue;
    const existing = publisherWebsiteByCanon.get(canon);
    if (!existing || new Date(pw.updatedAt) > new Date(existing.updatedAt)) {
      publisherWebsiteByCanon.set(canon, pw);
    }
  }

  // Final map: only canon URLs that have BOTH a marketplace and a
  // publisher-website. Missing publisher-website → not writable.
  const map = new Map();
  for (const [canon, mp] of matchedMarketplaces) {
    const pw = publisherWebsiteByCanon.get(canon);
    if (pw) map.set(canon, { marketplace: mp, publisherWebsite: pw });
  }

  console.log(
    `[BULK-REFRESH] lookup: wanted=${wanted.size} marketplaces=${matchedMarketplaces.size} ` +
    `publisher-websites=${publisherWebsiteByCanon.size} writable=${map.size}`
  );
  return map;
}

async function buildPreview({ tool, csvText, csvFilename = null }) {
  const profile = getProfile(tool);
  if (!profile) throw new Error(`Unknown tool: ${tool}`);

  const csvHash = crypto.createHash('sha256').update(csvText, 'utf8').digest('hex');
  const parsed = parseCsv(csvText, tool);

  // Check for recent identical uploads (last 7 days, status='complete').
  let duplicateWarning = null;
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const dupRows = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').findMany({
      where: {
        csvFileHash: csvHash,
        status: 'complete',
        jobType: 'upload',
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
    console.warn('[BULK-REFRESH] duplicate check failed (continuing):', err.message);
  }

  // Resolve URLs → { marketplace, publisherWebsite } pairs.
  const canonicalUrls = parsed.rows.map((r) => r.url).filter(Boolean);
  const rowMap = await lookupRowsByCanonicalUrls(canonicalUrls);

  // Per-row classification.
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
        reason: 'No active marketplace listing + approved publisher-website for this domain',
        current: null,
        next: {},
        changes: {},
        errors: {},
      };
    }

    const { marketplace: mp, publisherWebsite: pw } = pair;

    // Field-level validation + diff. We compare against the
    // publisher_website value (the canonical source of truth that
    // /websites displays). Marketplace mirrors this via the lifecycle.
    const next = {};
    const errors = {};
    const changes = {};
    let anyError = false;
    let anyChange = false;

    for (const field of profile.allowedFields) {
      if (!(field in row)) continue;
      const incoming = row[field];
      const err = validateField(profile, field, incoming);
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
      current: Object.fromEntries(
        profile.allowedFields.map((f) => [f, pw[f] ?? null])
      ),
      next,
      changes,
      errors,
    };
  });

  return {
    tool,
    profile: {
      label: profile.label,
      allowedFields: profile.allowedFields,
      historySource: profile.historySource,
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
// Commit — writes
// ---------------------------------------------------------------------------

const COMMIT_CHUNK_SIZE = 50;

async function commitCsv({ tool, csvText, csvFilename = null, label = null, actor = null }) {
  const profile = getProfile(tool);
  if (!profile) throw new Error(`Unknown tool: ${tool}`);

  // Build preview fresh — gives us the same classification logic and
  // the up-to-date current values. We rerun it here so a stale client
  // can't sneak past validation by editing its local preview state.
  const preview = await buildPreview({ tool, csvText, csvFilename });

  // Pre-create the job row in 'processing' state so failures still leave
  // a job-history row pointing to the error.
  const job = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').create({
    data: {
      tool,
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

  // Filter to rows we'd actually touch (will-update or unchanged with a
  // marketplace match; out-of-range and unmatched-url are skipped).
  const targets = preview.rows.filter(
    (r) => r.status === 'will-update' || r.status === 'unchanged'
  );

  // publisher_websites uses moz_spam_score while the marketplace table
  // uses spam_score. Translate when mirroring writes to marketplace.
  const PW_TO_MP_FIELD = {
    moz_spam_score: 'spam_score',
  };
  const mapFieldsForMarketplace = (pwData) => {
    const out = {};
    for (const [k, v] of Object.entries(pwData)) {
      out[PW_TO_MP_FIELD[k] || k] = v;
    }
    return out;
  };

  try {
    const now = new Date();
    for (let i = 0; i < targets.length; i += COMMIT_CHUNK_SIZE) {
      const chunk = targets.slice(i, i + COMMIT_CHUNK_SIZE);
      // No transaction wrapper: a failure mid-chunk should not roll back
      // rows we already wrote. The job row stays in 'processing' and
      // gets to 'failed' if we throw out of the loop.
      for (const row of chunk) {
        // 1) Write to publisher_websites (source of truth that /websites
        //    displays). Pass _skipMarketplaceSync so the lifecycle's
        //    auto-sync doesn't write to marketplace WITHOUT our audit
        //    context — we do that ourselves in step 2.
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

        // 2) Write to marketplace directly with audit context so the
        //    marketplace_update_history row gets source='bulk-<tool>'
        //    and bulkJobId. Also stamp the per-tool refresh clock here
        //    (the lifecycle's diff logic doesn't track per-tool stamps).
        //    Attestation model — clock advances even on no-op rows.
        const mpData = mapFieldsForMarketplace(row.next);
        mpData[profile.refreshTimestampColumn] = now;
        mpData._audit = {
          source: profile.historySource,
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

    // Mark the job complete.
    await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').update({
      where: { id: job.id },
      data: {
        status: 'complete',
        updatedCount,
        unchangedCount,
      },
    });
  } catch (err) {
    console.error('[BULK-REFRESH] commit failed:', err);
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
// Export cohort — generates a CSV of domains for one tool
// ---------------------------------------------------------------------------

// Translates a tool id to its snake_case column names for raw SQL. Done
// here (not from the profile) because raw SQL doesn't go through Strapi's
// attribute-name → column-name mapping.
const TOOL_COLUMNS = {
  ahrefs: { refresh: 'last_ahrefs_refresh_at', export: 'last_ahrefs_export_at' },
  moz: { refresh: 'last_moz_refresh_at', export: 'last_moz_export_at' },
  semrush: { refresh: 'last_semrush_refresh_at', export: 'last_semrush_export_at' },
};

async function exportCohort({ tool, limit = null, recentExportThresholdDays = 7, actor = null }) {
  const profile = getProfile(tool);
  if (!profile) throw new Error(`Unknown tool: ${tool}`);
  const cols = TOOL_COLUMNS[tool];
  if (!cols) throw new Error(`No column map for tool: ${tool}`);

  const knex = strapi.db.connection;

  // Default limit to the tool's batchCap; cap absolute upper bound at 5x
  // batchCap to prevent accidental "export 80k" requests.
  const requestedLimit = Number.isFinite(parseInt(limit, 10))
    ? Math.max(1, parseInt(limit, 10))
    : profile.batchCap;
  const effectiveLimit = Math.min(requestedLimit, profile.batchCap * 5);

  const thresholdDays = Number.isFinite(parseInt(recentExportThresholdDays, 10))
    ? Math.max(0, parseInt(recentExportThresholdDays, 10))
    : 7;
  const exportCutoff = thresholdDays > 0
    ? new Date(Date.now() - thresholdDays * 86400000).toISOString()
    : null;

  // Cohort selection — hits the partial index on (last_<tool>_refresh_at)
  // WHERE status='active'. NULLS FIRST so rows that have never been
  // refreshed surface at the top of the queue. Recently-exported rows are
  // excluded so admin doesn't re-export domains they haven't refreshed
  // back yet. Skip-flagged sites are excluded entirely.
  const filterParts = [`status = 'active'`];
  if (exportCutoff) {
    filterParts.push(`(${cols.export} IS NULL OR ${cols.export} < ?)`);
  }
  // bulkRefreshSkipTools is a jsonb array; exclude rows where this tool
  // is in it. @> is the "contains" operator.
  filterParts.push(`NOT (bulk_refresh_skip_tools @> ?::jsonb)`);

  const bindings = [];
  if (exportCutoff) bindings.push(exportCutoff);
  bindings.push(JSON.stringify([tool]));

  // First do a quick count for the live "eligible" preview (cheap with
  // index) — admin can call this without paying the SELECT cost.
  // (Used by the dry-run path; the actual export does SELECT in one shot.)
  const selectSql = `
    SELECT id, url, ${cols.refresh} AS refresh_at, ${cols.export} AS export_at
    FROM marketplaces
    WHERE ${filterParts.join(' AND ')}
    ORDER BY ${cols.refresh} ASC NULLS FIRST, id ASC
    LIMIT ${effectiveLimit}
  `;

  const { rows: cohort } = await knex.raw(selectSql, bindings);

  if (cohort.length === 0) {
    // Empty cohort still gets a job row so the audit trail shows the
    // attempt — useful for debugging.
    const emptyJob = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').create({
      data: {
        tool,
        jobType: 'export',
        status: 'complete',
        rowCount: 0,
        createdByUserId: actor?.id || null,
        createdByEmail: actor?.email || actor?.username || null,
        label: `Export · ${profile.label} · 0 sites (no eligible cohort)`,
      },
    });
    return {
      jobId: emptyJob.id,
      count: 0,
      csvText: 'url\n',
      filename: `${tool}-domains-${new Date().toISOString().slice(0, 10)}-empty.csv`,
    };
  }

  // Bulk update last_<tool>_export_at on the cohort in ONE round-trip.
  const ids = cohort.map((r) => r.id);
  const now = new Date();
  await knex.raw(
    `UPDATE marketplaces SET ${cols.export} = ? WHERE id = ANY(?::int[])`,
    [now.toISOString(), ids]
  );

  // CSV: just a URL column. Every tool's batch-analysis UI accepts a
  // single-column list of domains, one per line.
  const csvText = 'url\n' + cohort.map((r) => r.url).join('\n') + '\n';

  // Create a job row for the audit trail.
  const job = await strapi.db.query('api::bulk-refresh-job.bulk-refresh-job').create({
    data: {
      tool,
      jobType: 'export',
      status: 'complete',
      rowCount: cohort.length,
      createdByUserId: actor?.id || null,
      createdByEmail: actor?.email || actor?.username || null,
      label: `Export · ${profile.label} · ${cohort.length} sites`,
    },
  });

  const filename = `${tool}-domains-${new Date().toISOString().slice(0, 10)}.csv`;
  return { jobId: job.id, count: cohort.length, csvText, filename };
}

// Count-only variant — used by the UI to show a live "X eligible sites"
// preview without committing the export.
async function countEligibleForExport({ tool, recentExportThresholdDays = 7 }) {
  const profile = getProfile(tool);
  if (!profile) throw new Error(`Unknown tool: ${tool}`);
  const cols = TOOL_COLUMNS[tool];
  if (!cols) throw new Error(`No column map for tool: ${tool}`);

  const knex = strapi.db.connection;
  const thresholdDays = Number.isFinite(parseInt(recentExportThresholdDays, 10))
    ? Math.max(0, parseInt(recentExportThresholdDays, 10))
    : 7;
  const exportCutoff = thresholdDays > 0
    ? new Date(Date.now() - thresholdDays * 86400000).toISOString()
    : null;

  const filterParts = [`status = 'active'`];
  if (exportCutoff) filterParts.push(`(${cols.export} IS NULL OR ${cols.export} < ?)`);
  filterParts.push(`NOT (bulk_refresh_skip_tools @> ?::jsonb)`);
  const bindings = [];
  if (exportCutoff) bindings.push(exportCutoff);
  bindings.push(JSON.stringify([tool]));

  const { rows } = await knex.raw(
    `SELECT COUNT(*)::int AS c FROM marketplaces WHERE ${filterParts.join(' AND ')}`,
    bindings
  );
  return rows[0]?.c || 0;
}

// ---------------------------------------------------------------------------
// Status overview
// ---------------------------------------------------------------------------

async function computeStatus() {
  const out = {};
  for (const tool of listTools()) {
    const profile = getProfile(tool);
    const col = profile.refreshTimestampColumn;
    // Strapi findMany doesn't give us percentile / aggregate cleanly,
    // so we drop to a raw knex query for the tool stats. Postgres
    // percentile_cont gives an honest median across active rows.
    const knex = strapi.db.connection;
    let lastRefreshAt = null;
    let oldestRefreshAt = null;
    let medianAgeDays = null;
    let eligibleCount = 0;

    try {
      const colSnake = col
        .replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()); // lastAhrefsRefreshAt -> last_ahrefs_refresh_at
      // We want stats only on active marketplace rows that aren't
      // explicitly skipped for this tool.
      const filter = `WHERE status = 'active' AND NOT (bulk_refresh_skip_tools @> '["${tool}"]'::jsonb)`;
      const { rows } = await knex.raw(`
        SELECT
          MAX(${colSnake}) AS last_refresh,
          MIN(${colSnake}) AS oldest_refresh,
          PERCENTILE_CONT(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (now() - ${colSnake})) / 86400
          ) AS median_age_days,
          COUNT(*) AS eligible
        FROM marketplaces
        ${filter}
      `);
      const r = rows[0] || {};
      lastRefreshAt = r.last_refresh ? new Date(r.last_refresh).toISOString() : null;
      oldestRefreshAt = r.oldest_refresh ? new Date(r.oldest_refresh).toISOString() : null;
      medianAgeDays = r.median_age_days !== null ? Number(r.median_age_days) : null;
      eligibleCount = Number(r.eligible || 0);
    } catch (err) {
      console.warn(`[BULK-REFRESH] status query for ${tool} failed:`, err.message);
    }

    out[tool] = {
      label: profile.label,
      batchCap: profile.batchCap,
      lastRefreshAt,
      oldestRefreshAt,
      medianAgeDays: medianAgeDays !== null ? Math.round(medianAgeDays * 10) / 10 : null,
      eligibleCount,
    };
  }
  return out;
}

module.exports = {
  canonicalizeUrl,
  parseCsv,
  buildPreview,
  commitCsv,
  computeStatus,
  exportCohort,
  countEligibleForExport,
};
