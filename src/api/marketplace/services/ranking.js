'use strict';

/**
 * Marketplace ranking (2026-09-27). Writes rank_score / value_score /
 * rank_badges on every active, priced listing. Nightly cron + admin "run now".
 *
 * score (0–100) =
 *   W.authority · authority · authenticity      authority = 0.7·DR + 0.3·DA
 * + W.organic   · organic                       0.6·log10(traffic)/6 + 0.4·log10(keywords)/5
 * + W.market    · market                        EN + US/UK/CA/AU = 1; one of them = 0.7; South-Asia-only "English" = 0.5; else 0.3
 * + W.value     · value                         price vs credible peers (same DR band × traffic band): ¼ of peer price → 1, at peer price → 0.5, 4× → 0
 * + W.trust     · trust                         spam score
 * + W.verified  · gsc_verified                  Google Search Console verified owner
 * + W.fresh     · price confirmed < 90 days
 * + W.reliability · publisher completion rate (Bayesian, m = 5)
 * × 0.88 when nofollow · − 3 per extra site of the same root domain (max −12)
 * authenticity: DR ≥ 40 with < 100 visits or < 200 keywords → ×0.35; < 2,000 visits or < 1,000 keywords → ×0.65; spam > 30 → ×0.6; > 60 → ×0.3
 * value_score: the value term alone, only for sites passing the quality floor (DR ≥ 40, ≥ 10k visits, ≥ 3k keywords, EN/major market, dofollow, credible).
 * Weights live in Global Config `rankingWeights` (JSON) so they can be tuned without a deploy.
 */

const DEFAULT_WEIGHTS = { authority: 32, organic: 24, market: 8, value: 15, trust: 8, verified: 5, fresh: 4, reliability: 4, nofollowMultiplier: 0.88, networkDecayPerSite: 3, networkDecayMax: 12 };

module.exports = ({ strapi }) => ({
  async weights() {
    const cfg = await strapi.db.query('api::global-config.global-config').findOne({});
    const w = { ...DEFAULT_WEIGHTS, ...((cfg && cfg.rankingWeights && typeof cfg.rankingWeights === 'object') ? cfg.rankingWeights : {}) };
    for (const k of Object.keys(w)) { const n = Number(w[k]); w[k] = Number.isFinite(n) ? n : DEFAULT_WEIGHTS[k]; }
    return w;
  },

  async recompute() {
    const knex = strapi.db.connection;
    const w = await this.weights();
    const started = Date.now();
    await knex.transaction(async (trx) => {
      await trx.raw(`
CREATE TEMP TABLE tmp_rank ON COMMIT DROP AS
WITH pub AS (SELECT op.user_id, count(*) AS n, count(*) FILTER (WHERE o.order_status IN ('completed','approved')) AS done FROM orders o JOIN orders_publisher_lnk op ON op.order_id=o.id WHERE o.order_status IN ('completed','approved','rejected','cancelled') GROUP BY 1),
prior AS (SELECT coalesce(sum(done)::numeric/nullif(sum(n),0), 0.5) AS p FROM pub),
base AS (
  SELECT m.id, m.url, m.price, m.ahrefs_dr AS dr, m.moz_da AS da, coalesce(m.ahrefs_traffic,0) AS traffic, coalesce(m.ahrefs_keywords,0) AS kw, m.spam_score AS spam, m.tat, (m.backlink_type='Do follow') AS dofollow,
         m.language::text ILIKE '%english%' AS english,
         m.countries::text ~* '(USA|United States|United Kingdom|Canada|Australia)' AS major,
         (m.countries::text ~* '(India|Pakistan|Bangladesh)' AND m.countries::text !~* '(USA|United|Canada|Australia)') AS south_asia_only,
         coalesce(pw.gsc_verified,false) OR pw.verification_method='google-search-console' AS gsc,
         m.last_price_update_at > now()-interval '90 days' AS price_fresh, l.user_id AS publisher_id,
         (SELECT string_agg(x,'.') FROM unnest((regexp_split_to_array(m.url,'\\.'))[greatest(1, array_length(regexp_split_to_array(m.url,'\\.'),1) - CASE WHEN m.url ~ '\\.(co|com|org|net|gov|edu|ac|ho|in)\\.[a-z]{2}$' THEN 2 ELSE 1 END):]) x) AS root,
         width_bucket(coalesce(m.ahrefs_dr,0), 0, 100, 10) AS dr_band, width_bucket(log(coalesce(m.ahrefs_traffic,0)+1), 0, 7, 7) AS tr_band
  FROM marketplaces m LEFT JOIN publisher_websites pw ON pw.marketplace_id=m.id LEFT JOIN marketplaces_publisher_lnk l ON l.marketplace_id=m.id
  WHERE m.published_at IS NOT NULL AND (m.status='active' OR m.status IS NULL OR m.status='') AND m.price>0),
peers AS (SELECT dr_band, tr_band, count(*) AS n, percentile_cont(0.5) within group (order by price) AS med FROM base WHERE kw>=1000 AND traffic>=1000 AND coalesce(spam,0)<=30 GROUP BY 1,2),
peers_dr AS (SELECT dr_band, percentile_cont(0.5) within group (order by price) AS med FROM base WHERE kw>=1000 AND traffic>=1000 AND coalesce(spam,0)<=30 GROUP BY 1),
terms AS (
  SELECT b.*,
    (CASE WHEN coalesce(dr,0)>=40 AND (traffic<100 OR kw<200) THEN 0.35 WHEN coalesce(dr,0)>=40 AND (traffic<2000 OR kw<1000) THEN 0.65 ELSE 1 END) * (CASE WHEN coalesce(spam,0)>60 THEN 0.3 WHEN coalesce(spam,0)>30 THEN 0.6 ELSE 1 END) AS auth_mult,
    least(1, greatest(0, 0.7*coalesce(dr,0)/100 + 0.3*coalesce(nullif(da,0),dr,0)/100)) AS raw_authority,
    least(1, 0.6*log(traffic+1)/6 + 0.4*log(kw+1)/5) AS t_organic,
    (CASE WHEN english AND major THEN 1 WHEN english AND south_asia_only THEN 0.5 WHEN english OR major THEN 0.7 ELSE 0.3 END) AS t_market,
    least(1, greatest(0, 0.5 + 0.25*log(2, coalesce(CASE WHEN p.n>=30 THEN p.med END, pd.med, price)::numeric / price))) AS t_value,
    (CASE WHEN spam IS NULL THEN 0.6 WHEN spam<=10 THEN 1 WHEN spam<=30 THEN 0.7 ELSE 0.2 END) AS t_trust,
    (CASE WHEN gsc THEN 1 ELSE 0 END) AS t_verified, (CASE WHEN price_fresh THEN 1 ELSE 0.4 END) AS t_fresh,
    (coalesce(pu.done,0) + 5*(SELECT p FROM prior)) / (coalesce(pu.n,0) + 5) AS t_reliability,
    (coalesce(dr,0)>=40 AND (traffic<100 OR kw<200)) OR coalesce(spam,0)>30 AS low_confidence
  FROM base b LEFT JOIN peers p ON p.dr_band=b.dr_band AND p.tr_band=b.tr_band LEFT JOIN peers_dr pd ON pd.dr_band=b.dr_band LEFT JOIN pub pu ON pu.user_id=b.publisher_id),
scored AS (SELECT *, (:authority*raw_authority*auth_mult + :organic*t_organic + :market*t_market + :value*t_value + :trust*t_trust + :verified*t_verified + :fresh*t_fresh + :reliability*t_reliability) * (CASE WHEN dofollow THEN 1 ELSE :nofollowMultiplier END) AS s0 FROM terms),
netdecay AS (SELECT *, row_number() OVER (PARTITION BY root ORDER BY s0 DESC) AS k FROM scored)
SELECT id,
  round(greatest(0, s0 - least(:networkDecayMax, :networkDecayPerSite*(k-1)))::numeric,1) AS score,
  CASE WHEN kw>=3000 AND traffic>=10000 AND coalesce(dr,0)>=40 AND ((english AND NOT south_asia_only) OR major) AND NOT low_confidence AND dofollow THEN round((100*t_value)::numeric,1) END AS value_score,
  to_jsonb(array_remove(ARRAY[CASE WHEN gsc THEN 'verified_owner' END, CASE WHEN t_value>=0.75 AND kw>=1000 AND NOT low_confidence THEN 'great_value' END, CASE WHEN traffic>=10000 THEN 'high_traffic' END, CASE WHEN tat<=3 THEN 'fast_delivery' END, CASE WHEN NOT dofollow THEN 'nofollow' END, CASE WHEN low_confidence THEN 'low_confidence' END], NULL)) AS badges
FROM netdecay`, w);
      await trx.raw(`UPDATE marketplaces m SET rank_score = t.score, value_score = t.value_score, rank_badges = t.badges, rank_computed_at = now() FROM tmp_rank t WHERE m.id = t.id`);
      // listings that are paused / unpriced / unpublished carry no score
      await trx.raw(`UPDATE marketplaces m SET rank_score = NULL, value_score = NULL, rank_badges = NULL WHERE m.rank_score IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tmp_rank t WHERE t.id = m.id)`);
    });
    const [{ rows }] = [await knex.raw(`SELECT count(*) FILTER (WHERE rank_score IS NOT NULL)::int AS scored, count(*) FILTER (WHERE value_score IS NOT NULL)::int AS value_pool, max(rank_score) AS top FROM marketplaces`)];
    const stats = { ...rows[0], ms: Date.now() - started, weights: w };
    strapi.log.info(`[ranking] recomputed: ${stats.scored} scored, ${stats.value_pool} in value pool, top ${stats.top}, ${stats.ms} ms`);
    try { const { marketplaceStatsCache } = require('../controllers/marketplace'); if (marketplaceStatsCache && typeof marketplaceStatsCache.clear === 'function') marketplaceStatsCache.clear(); } catch (e) { /* cache is private; the 10-min TTL handles it */ }
    return stats;
  },
});
