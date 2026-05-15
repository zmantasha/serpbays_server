'use strict';

/**
 * Per-tool profile config for bulk metric refresh.
 *
 * Each profile is the **single source of truth** for what a tool's CSV
 * upload is allowed to do:
 *
 *   - `allowedFields`: hard allow-list. Even if the CSV has a "DA"
 *     column, the Ahrefs profile won't write to `moz_da`. Protects
 *     against admin picking the wrong tool dropdown.
 *
 *   - `headerAliases`: maps human-readable column headers from the
 *     tool's export (e.g. "Domain Rating", "DR") to canonical
 *     marketplace field names. Case-insensitive, trimmed match in
 *     parseCsv.
 *
 *   - `fieldBounds`: validation ranges (mirror MetricsEditModal so
 *     server enforcement matches client preview).
 *
 *   - `refreshTimestampColumn` / `exportTimestampColumn`: which
 *     per-tool clock to advance on commit / export.
 *
 *   - `historySource`: source enum value written to history rows for
 *     this tool's bulk imports.
 *
 *   - `batchCap`: the tool's UI-side bulk-analysis limit. Used as a
 *     soft cap in the export wizard and as the default batch size.
 *
 *   - `siteExplorerHints`: human-readable export instructions surfaced
 *     in the upload wizard so admins remember what columns to tick in
 *     each tool's export dialog.
 */

const PROFILES = {
  ahrefs: {
    label: 'Ahrefs',
    historySource: 'bulk-ahrefs',
    batchCap: 1000,
    refreshTimestampColumn: 'lastAhrefsRefreshAt',
    exportTimestampColumn: 'lastAhrefsExportAt',
    allowedFields: [
      'ahrefs_dr',
      'ahrefs_traffic',
      'ahrefs_rank',
      'ahrefs_keywords',
      'ahrefs_referring_domain',
    ],
    headerAliases: {
      // URL columns — first one wins; everything maps to internal 'url'.
      // The URL column is REQUIRED for row matching; without it every row
      // becomes "unmatched URL" in the preview.
      target: 'url',
      url: 'url',
      'website url': 'url',
      website: 'url',
      'site url': 'url',
      site: 'url',
      domain: 'url',
      'domain name': 'url',
      'root domain': 'url',
      // Ahrefs metric columns
      'domain rating': 'ahrefs_dr',
      dr: 'ahrefs_dr',
      'ahrefs dr': 'ahrefs_dr',
      'organic traffic': 'ahrefs_traffic',
      traffic: 'ahrefs_traffic',
      'total traffic': 'ahrefs_traffic',
      'ahrefs traffic': 'ahrefs_traffic',
      'ahrefs rank': 'ahrefs_rank',
      ar: 'ahrefs_rank',
      rank: 'ahrefs_rank',
      'ref. domains': 'ahrefs_referring_domain',
      'referring domains': 'ahrefs_referring_domain',
      'ref domains': 'ahrefs_referring_domain',
      rd: 'ahrefs_referring_domain',
      'organic keywords': 'ahrefs_keywords',
      keywords: 'ahrefs_keywords',
      'kw': 'ahrefs_keywords',
    },
    fieldBounds: {
      ahrefs_dr: { min: 0, max: 100, integer: false },
      ahrefs_traffic: { min: 0, max: 99_999_999, integer: true },
      ahrefs_rank: { min: 0, max: 99_999_999, integer: true },
      ahrefs_keywords: { min: 0, max: 99_999_999, integer: true },
      ahrefs_referring_domain: { min: 0, max: 99_999_999, integer: true },
    },
    siteExplorerHints: 'Site Explorer → Batch Analysis → paste your domain list → export CSV including Domain Rating, Total Traffic, Ref. domains, Organic keywords.',
  },

  moz: {
    label: 'Moz',
    historySource: 'bulk-moz',
    batchCap: 25,
    refreshTimestampColumn: 'lastMozRefreshAt',
    exportTimestampColumn: 'lastMozExportAt',
    allowedFields: ['moz_da', 'moz_spam_score'],
    headerAliases: {
      target: 'url',
      url: 'url',
      'website url': 'url',
      website: 'url',
      'site url': 'url',
      site: 'url',
      domain: 'url',
      'domain name': 'url',
      'root domain': 'url',
      'domain authority': 'moz_da',
      da: 'moz_da',
      'moz da': 'moz_da',
      'spam score': 'moz_spam_score',
      ss: 'moz_spam_score',
      'moz spam score': 'moz_spam_score',
    },
    fieldBounds: {
      moz_da: { min: 0, max: 100, integer: false },
      moz_spam_score: { min: 0, max: 100, integer: false },
    },
    siteExplorerHints: 'Free Domain Analysis → Compare Link Profiles → paste your domain list → export CSV including DA + Spam Score.',
  },

  semrush: {
    label: 'Semrush',
    historySource: 'bulk-semrush',
    batchCap: 200,
    refreshTimestampColumn: 'lastSemrushRefreshAt',
    exportTimestampColumn: 'lastSemrushExportAt',
    allowedFields: ['semrush_authority_score', 'semrush_traffic'],
    headerAliases: {
      target: 'url',
      url: 'url',
      'website url': 'url',
      website: 'url',
      'site url': 'url',
      site: 'url',
      domain: 'url',
      'domain name': 'url',
      'root domain': 'url',
      'authority score': 'semrush_authority_score',
      as: 'semrush_authority_score',
      'semrush authority score': 'semrush_authority_score',
      'search traffic': 'semrush_traffic',
      'organic traffic': 'semrush_traffic',
      traffic: 'semrush_traffic',
      'semrush traffic': 'semrush_traffic',
    },
    fieldBounds: {
      semrush_authority_score: { min: 0, max: 100, integer: false },
      semrush_traffic: { min: 0, max: 99_999_999, integer: true },
    },
    siteExplorerHints: 'Bulk Analysis → paste your domain list → export CSV including Authority Score + Organic Search Traffic.',
  },
};

function getProfile(tool) {
  return PROFILES[tool] || null;
}

function listTools() {
  return Object.keys(PROFILES);
}

module.exports = { PROFILES, getProfile, listTools };
