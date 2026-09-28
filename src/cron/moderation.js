'use strict';

// Moderation background work (see src/api/admin/services/moderation.js). Single instance only.
//   - moderationChecks: automatic checks for newly submitted sites (one paid traffic lookup each, budget-guarded)
//   - moderationAutoApprove: Phase 4 rules; does nothing unless an admin turned them on
//   - moderationFlags: open re-check flags for live listings whose DR/traffic fell sharply
const AUTO_USER = { id: null, email: 'auto-moderation', username: 'auto-moderation', role: { type: 'super_admin' } };

module.exports = {
  moderationChecks: {
    task: async ({ strapi }) => {
      try {
        const svc = require('../api/admin/services/moderation');
        await svc.ensureTables();
        const r = await strapi.db.connection.raw(`select p.id from publisher_websites p left join (select distinct pw_id from moderation_checks) c on c.pw_id=p.id
            where p.submission_status in ('approval_pending','pending_verification') and c.pw_id is null and p.created_at > now() - interval '60 days' order by p.created_at desc limit 20`);
        let done = 0;
        for (const { id } of (r.rows || r)) { try { await svc.runSiteChecks(id, { paid: true }); done += 1; } catch (e) { console.warn(`[Moderation Cron] checks ${id} failed: ${e.message}`); } }
        if (done) console.log(`[Moderation Cron] checked ${done} new submission(s)`);
      } catch (e) { console.error('[Moderation Cron] checks failed:', e.message); }
    },
    options: { rule: '*/15 * * * *' },
  },

  moderationAutoApprove: {
    task: async ({ strapi }) => {
      try {
        const svc = require('../api/admin/services/moderation');
        const s = await svc.getSettings();
        if (!s.autoApproveEnabled && !s.autoApproveNoiseOnly) return;
        const items = await svc.listEdits();
        let approved = 0, closed = 0;
        for (const it of items) {
          const noiseOnly = it.real.length === 0;
          const lowRisk = !noiseOnly && s.autoApproveEnabled && !it.conflicts.length && it.real.every((x) => svc.LEVEL[x.risk.level] <= svc.LEVEL[s.autoApproveMaxRisk])
            && it.publisher && it.publisher.trust && it.publisher.trust.score >= s.autoApproveMinTrust;
          if (!(noiseOnly && s.autoApproveNoiseOnly) && !lowRisk) continue;
          const locks = await svc.locks();
          if (locks[it.key]) continue; // a human has it open
          try {
            await svc.callController('api::website-update-request.website-update-request', 'approve', { id: it.id, user: AUTO_USER });
            await svc.logDecision({ itemType: 'edit', itemId: it.id, pwId: it.pwId, marketplaceId: it.marketplaceId, action: noiseOnly ? 'close_noise' : 'approve', note: noiseOnly ? 'No real change' : `Auto: ${it.risk} risk, trust ${it.publisher.trust.score}`,
              snapshot: { real: it.real, risk: it.risk }, adminName: 'auto', auto: true, submittedAt: it.submittedAt });
            if (noiseOnly) closed += 1; else approved += 1;
          } catch (e) { console.warn(`[Moderation Cron] auto-approve ${it.id} failed: ${e.message}`); }
        }
        if (approved || closed) console.log(`[Moderation Cron] auto-approved ${approved}, closed ${closed} no-change request(s)`);
      } catch (e) { console.error('[Moderation Cron] auto-approve failed:', e.message); }
    },
    options: { rule: '*/10 * * * *' },
  },

  moderationFlags: {
    task: async () => {
      try { const r = await require('../api/admin/services/moderation').scanFlags(2); if (r.dr || r.traffic) console.log(`[Moderation Cron] flags opened: DR ${r.dr}, traffic ${r.traffic}`); }
      catch (e) { console.error('[Moderation Cron] flags failed:', e.message); }
    },
    options: { rule: '30 4 * * *' }, // daily 04:30 UTC, after the ranking recompute
  },
};
