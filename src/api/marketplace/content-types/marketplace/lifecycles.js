// Fields whose changes are recorded into marketplace-update-history.
// Two groups so future reads can filter "price-only" or "metric-only" updates.
const TRACKED_PRICE_FIELDS = [
  'price',
  'link_insertion_price',
  'publisher_price',
  'publisher_link_insertion_price',
  'publisher_writing_price',
  'publisher_forbidden_gp_price',
  'publisher_forbidden_li_price',
  'adv_crypto_pricing',
  'adv_casino_pricing',
  'adv_cbd_pricing',
  'adv_dating_pricing',
  'adv_li_crypto_pricing',
  'adv_li_casino_pricing',
  'adv_li_cbd_pricing',
  'adv_li_dating_pricing',
  'publisher_crypto_pricing',
  'publisher_casino_pricing',
  'publisher_cbd_pricing',
  'publisher_dating_pricing',
  'publisher_li_crypto_pricing',
  'publisher_li_casino_pricing',
  'publisher_li_cbd_pricing',
  'publisher_li_dating_pricing',
];

const TRACKED_METRIC_FIELDS = [
  'ahrefs_dr',
  'ahrefs_traffic',
  'ahrefs_rank',
  'ahrefs_keywords',
  'ahrefs_referring_domain',
  'moz_da',
  'semrush_authority_score',
  'semrush_traffic',
  'similarweb_traffic',
  'spam_score',
];

const TRACKED_FIELDS = [...TRACKED_PRICE_FIELDS, ...TRACKED_METRIC_FIELDS];

// Helper function to calculate placement speed based on TAT
function calculatePlacementSpeed(tat) {
  if (!tat || tat < 0) return 'Normal';

  if (tat >= 0 && tat <= 2) return 'Ultra Fast';
  if (tat >= 3 && tat <= 5) return 'Fast';
  if (tat >= 6 && tat <= 8) return 'Normal';
  if (tat >= 9 && tat <= 20) return 'Slow';

  // For TAT > 20 days, consider it Slow
  return 'Slow';
}

// Coerce two values to a comparable form. The DB returns numerics as either
// numbers or numeric strings depending on driver; treat "10" and 10 as equal.
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const na = typeof a === 'number' ? a : parseFloat(a);
  const nb = typeof b === 'number' ? b : parseFloat(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

module.exports = {
  // Before creating a new marketplace entry
  beforeCreate(event) {
    const { data } = event.params;

    // Calculate placement speed if TAT is provided
    if (data.tat !== undefined) {
      data.placement_speed = calculatePlacementSpeed(data.tat);
    }

    // Seed the "last updated" timestamps so a freshly-created listing isn't
    // immediately flagged as overdue. They'll be advanced on every later
    // change by beforeUpdate.
    const now = new Date();
    if (data.lastPriceUpdateAt === undefined) data.lastPriceUpdateAt = now;
    if (data.lastMetricUpdateAt === undefined) data.lastMetricUpdateAt = now;
  },

  // Before updating a marketplace entry — capture previous values of tracked
  // fields so afterUpdate can diff, then strip the _audit hint off `data`
  // (Strapi would otherwise fail trying to persist an unknown attribute).
  async beforeUpdate(event) {
    const { data, where } = event.params;

    // Recalculate placement speed if TAT is being updated
    if (data.tat !== undefined) {
      data.placement_speed = calculatePlacementSpeed(data.tat);
    }

    // Stash audit context for afterUpdate, then remove from the persisted row.
    if (data && data._audit) {
      event.state = event.state || {};
      event.state.audit = data._audit;
      delete data._audit;
    }

    // Capture the previous row's tracked fields for diffing.
    if (where && (where.id || where.$or)) {
      try {
        const previous = await strapi.db
          .query('api::marketplace.marketplace')
          .findOne({ where, select: ['id', ...TRACKED_FIELDS] });
        if (previous) {
          event.state = event.state || {};
          event.state.previous = previous;

          // While we still have both prev and the incoming patch, stamp
          // lastPriceUpdateAt / lastMetricUpdateAt on `data` so they get
          // persisted in the same UPDATE statement (no recursive lifecycle).
          // We compare against the prev row to skip no-op writes.
          const now = new Date();
          let priceChanged = false;
          let metricChanged = false;
          for (const key of Object.keys(data)) {
            if (
              TRACKED_PRICE_FIELDS.includes(key) &&
              !valuesEqual(previous[key], data[key])
            ) {
              priceChanged = true;
            }
            if (
              TRACKED_METRIC_FIELDS.includes(key) &&
              !valuesEqual(previous[key], data[key])
            ) {
              metricChanged = true;
            }
          }
          if (priceChanged) data.lastPriceUpdateAt = now;
          if (metricChanged) data.lastMetricUpdateAt = now;
        }
      } catch (err) {
        console.warn('[marketplace lifecycle] previous-state fetch failed:', err.message);
      }
    }
  },

  // After creating - log for debugging (optional)
  afterCreate(event) {
    const { result } = event;
    console.log(`Marketplace created: ${result.url} - TAT: ${result.tat} days, Placement Speed: ${result.placement_speed}`);
  },

  // After updating: write a history row if any tracked field actually changed.
  async afterUpdate(event) {
    const { result } = event;
    if (result && result.tat !== undefined) {
      console.log(`Marketplace updated: ${result.url} - TAT: ${result.tat} days, Placement Speed: ${result.placement_speed}`);
    }

    const previous = event.state?.previous;
    if (!previous || !result) return;

    const changes = {};
    const changedFields = [];
    for (const field of TRACKED_FIELDS) {
      const prev = previous[field];
      const next = result[field];
      if (valuesEqual(prev, next)) continue;
      // Don't record an update if the new payload didn't touch this field
      // (Strapi sometimes round-trips unchanged columns; we still skip them
      // since `valuesEqual` already returned false, meaning the DB value
      // truly differs — i.e. an external write).
      changes[field] = { from: prev ?? null, to: next ?? null };
      changedFields.push(field);
    }

    if (changedFields.length === 0) return;

    const audit = event.state?.audit || {};
    try {
      await strapi.db
        .query('api::marketplace-update-history.marketplace-update-history')
        .create({
          data: {
            marketplace: result.id,
            changes,
            changedFields,
            source: audit.source || 'api',
            changedBy: audit.changedBy || null,
            userId: audit.userId || null,
            changedAt: new Date(),
          },
        });
    } catch (err) {
      // Audit writes must never break the primary update.
      console.error('[marketplace lifecycle] failed to write update history:', err.message);
    }
  },
};
