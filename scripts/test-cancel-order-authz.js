#!/usr/bin/env node
/**
 * Regression test for the cancelOrder authorization fix (audit M1).
 *
 * Pre-fix: cancelOrder read cancelledBy from ctx.request.body and passed it
 * to validateCancellation, which short-circuited to "allowed: true" when
 * cancelledBy === 'system'. An attacker (any caller able to reach the
 * route) could cancel any order, drain its escrow to the advertiser's main
 * balance, and have the cancellation record show cancelledBy='system' —
 * masking the actor's identity.
 *
 * Route-level mitigation: the cancelOrder route grants only the super_admin
 * role, so a normal authenticated user already gets 403 at the route gate.
 * However, the controller bug remained: a super_admin could bypass the
 * business-rule branches (advertiser 7-day rule, publisher accepted-status
 * rule) by setting cancelledBy='system', and the audit trail lost the
 * actor identity.
 *
 * Fix: controller derives cancelledBy server-side from caller's role +
 * relationship to the order. Service defense-in-depth rejects 'system'
 * when a userId is present (controller path must never reach 'system').
 *
 * This test asserts:
 *   1. Unauthorized caller (not advertiser, not publisher, not admin) →
 *      403 forbidden, no state mutation. (Even if route gate were widened.)
 *   2. Advertiser of the order → derived cancelledBy='advertiser'; 7-day
 *      rule still enforced (recent acceptedDate → rejected).
 *   3. Admin caller → derived cancelledBy='admin' (NOT 'system'); cancel
 *      succeeds; escrow refunded; DB records 'admin' not 'system'.
 *   4. Body-supplied cancelledBy='system' is IGNORED by the controller
 *      (server-derived value wins).
 *   5. Direct service call with cancelledBy='system' AND a userId present
 *      → rejected by the defense-in-depth guard.
 *   6. Direct service call with cancelledBy='system' and userId=null (the
 *      cron path) → still allowed (cron jobs unaffected).
 *
 * Run:
 *   cd serpbays_server
 *   node scripts/test-cancel-order-authz.js
 */
'use strict';
process.env.NODE_ENV = 'production';
process.chdir('/var/www/serpbays/serpbays_server');

(async () => {
  const { createStrapi } = require('/var/www/serpbays/serpbays_server/node_modules/@strapi/strapi');
  const strapi = await createStrapi({ appDir: '/var/www/serpbays/serpbays_server' });
  await strapi.load();
  const Q = (uid) => strapi.db.query(uid);
  const ctrl = strapi.controller('api::order.order');
  const svc  = strapi.service('api::order.order');

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  const stamp = Date.now();
  const authRole = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const superRole = await Q('plugin::users-permissions.role').findOne({ where: { type: 'super_admin' } });

  const advertiser = await Q('plugin::users-permissions.user').create({
    data: { username: `cancel-adv-${stamp}`, email: `cancel-adv-${stamp}@example.test`, provider: 'local', confirmed: true, role: authRole.id },
  });
  const attacker = await Q('plugin::users-permissions.user').create({
    data: { username: `cancel-att-${stamp}`, email: `cancel-att-${stamp}@example.test`, provider: 'local', confirmed: true, role: authRole.id },
  });
  const adminUser = await Q('plugin::users-permissions.user').create({
    data: { username: `cancel-adm-${stamp}`, email: `cancel-adm-${stamp}@example.test`, provider: 'local', confirmed: true, role: superRole.id },
  });

  // Provide the role.type on the user object as the controller reads it
  // from ctx.state.user.role. Populate it for our mock ctx.
  const advLoaded   = await Q('plugin::users-permissions.user').findOne({ where: { id: advertiser.id }, populate: ['role'] });
  const attLoaded   = await Q('plugin::users-permissions.user').findOne({ where: { id: attacker.id }, populate: ['role'] });
  const adminLoaded = await Q('plugin::users-permissions.user').findOne({ where: { id: adminUser.id }, populate: ['role'] });

  const seedOrderAndWallet = async (suffix, acceptedDaysAgo = 0) => {
    const wallet = await Q('api::user-wallet.user-wallet').create({
      data: { balance: 50, mainBalance: 0, promoBalance: 0, escrowBalance: 50,
        users_permissions_user: advertiser.id, publishedAt: new Date() },
    });
    await strapi.db.connection('user_wallets_users_permissions_user_lnk')
      .insert({ user_wallet_id: wallet.id, user_id: advertiser.id }).onConflict().ignore();
    const accepted = new Date(Date.now() - acceptedDaysAgo * 24 * 3600 * 1000);
    const order = await Q('api::order.order').create({
      data: { orderStatus: 'accepted', paymentStatus: 'paid', totalAmount: 50, currency: 'USD',
        acceptedDate: accepted, publishedAt: new Date() },
    });
    await strapi.db.connection('orders_advertiser_lnk').insert({ order_id: order.id, user_id: advertiser.id });
    return { wallet, order };
  };

  const mkCtx = (orderId, user, body) => {
    const c = {
      params: { id: String(orderId) }, state: { user }, request: { body: body || {} },
      _body: null, _err: null, _status: 200,
      send(b) { c._body = b; return b; },
      badRequest(m) { c._err = { code: 400, msg: m }; return c._err; },
      unauthorized(m) { c._err = { code: 401, msg: m }; return c._err; },
      forbidden(m) { c._err = { code: 403, msg: m }; return c._err; },
      notFound(m) { c._err = { code: 404, msg: m }; return c._err; },
      internalServerError(m) { c._err = { code: 500, msg: m }; return c._err; },
    };
    return c;
  };

  const cleanupRow = async (wallet, order) => {
    try {
      const txs = await Q('api::transaction.transaction').findMany({ where: { order: order.id } });
      for (const t of txs) {
        await strapi.db.connection('transactions_user_wallet_lnk').where({ transaction_id: t.id }).delete();
        await strapi.db.connection('transactions_users_permissions_user_lnk').where({ transaction_id: t.id }).delete();
        await strapi.db.connection('transactions_order_lnk').where({ transaction_id: t.id }).delete();
        await Q('api::transaction.transaction').delete({ where: { id: t.id } });
      }
      await strapi.db.connection('orders_advertiser_lnk').where({ order_id: order.id }).delete();
      await Q('api::order.order').delete({ where: { id: order.id } });
      await strapi.db.connection('user_wallets_users_permissions_user_lnk').where({ user_wallet_id: wallet.id }).delete();
      await Q('api::user-wallet.user-wallet').delete({ where: { id: wallet.id } });
    } catch {}
  };

  try {
    out('\n=== 1) Unauthorized caller → 403, no state mutation ===');
    {
      const { wallet, order } = await seedOrderAndWallet('a');
      const ctx = mkCtx(order.id, attLoaded, { cancelledBy: 'system', reason: 'exploit' });
      await ctrl.cancelOrder(ctx);
      assert(ctx._err?.code === 403, `403 forbidden (got ${ctx._err?.code})`);
      const after = await Q('api::order.order').findOne({ where: { id: order.id } });
      const w     = await Q('api::user-wallet.user-wallet').findOne({ where: { id: wallet.id } });
      assert(after.orderStatus === 'accepted', `order status unchanged (got ${after.orderStatus})`);
      assert(Number(w.escrowBalance) === 50, `escrow unchanged (got $${w.escrowBalance})`);
      assert(after.cancelledBy == null, `cancelledBy unchanged (got ${after.cancelledBy})`);
      const refunds = await Q('api::transaction.transaction').findMany({ where: { order: order.id, type: 'refund' } });
      assert(refunds.length === 0, `no refund tx written (got ${refunds.length})`);
      await cleanupRow(wallet, order);
    }

    out('\n=== 2) Advertiser, recent acceptedDate → derived "advertiser", 7-day rule blocks ===');
    {
      const { wallet, order } = await seedOrderAndWallet('b', 1); // accepted 1 day ago
      const ctx = mkCtx(order.id, advLoaded, { cancelledBy: 'system', reason: 'i am the advertiser' });
      await ctrl.cancelOrder(ctx);
      assert(ctx._err?.code === 400 && /7 days/i.test(JSON.stringify(ctx._err.msg)), '7-day rule enforced (advertiser branch)');
      const after = await Q('api::order.order').findOne({ where: { id: order.id } });
      assert(after.orderStatus === 'accepted', 'order status unchanged');
      assert(after.cancelledBy == null, "cancelledBy NOT set to 'system' from body");
      await cleanupRow(wallet, order);
    }

    out('\n=== 3) Admin → derived "admin" (NOT "system"), cancel + refund succeed ===');
    {
      const { wallet, order } = await seedOrderAndWallet('c', 1);
      const ctx = mkCtx(order.id, adminLoaded, { cancelledBy: 'system', reason: 'admin override' });
      await ctrl.cancelOrder(ctx);
      assert(!ctx._err, `no error path (admin can cancel; got err: ${JSON.stringify(ctx._err)})`);
      const after = await Q('api::order.order').findOne({ where: { id: order.id } });
      const w     = await Q('api::user-wallet.user-wallet').findOne({ where: { id: wallet.id } });
      const refunds = await Q('api::transaction.transaction').findMany({ where: { order: order.id, type: 'refund' } });
      assert(after.orderStatus === 'cancelled', `order cancelled (got ${after.orderStatus})`);
      assert(after.cancelledBy === 'admin', `cancelledBy='admin' written, NOT body value (got '${after.cancelledBy}')`);
      assert(after.cancelledBy !== 'system', `cancelledBy is NOT the user-supplied 'system'`);
      assert(Number(w.escrowBalance) === 0, `escrow drained to $0 (got $${w.escrowBalance})`);
      assert(Number(w.mainBalance) === 50, `mainBalance credited $50 (got $${w.mainBalance})`);
      assert(refunds.length === 1, `1 refund tx created (got ${refunds.length})`);
      await cleanupRow(wallet, order);
    }

    out('\n=== 4) Service-level defense in depth: cancelledBy=system + userId set → REJECTED ===');
    {
      const { wallet, order } = await seedOrderAndWallet('d');
      const orderLoaded = await Q('api::order.order').findOne({ where: { id: order.id }, populate: ['advertiser', 'publisher', 'website'] });
      const result = await svc.validateCancellation(orderLoaded, attacker.id, 'system');
      assert(result.allowed === false, "service rejects 'system' when userId set");
      assert(/cron/i.test(result.reason || ''), 'rejection message mentions cron');
      await cleanupRow(wallet, order);
    }

    out('\n=== 5) Cron path (cancelledBy=system, userId=null) → still allowed ===');
    {
      const { wallet, order } = await seedOrderAndWallet('e');
      const orderLoaded = await Q('api::order.order').findOne({ where: { id: order.id }, populate: ['advertiser', 'publisher', 'website'] });
      const result = await svc.validateCancellation(orderLoaded, null, 'system');
      assert(result.allowed === true, 'cron-style call (userId=null) still permitted');
      await cleanupRow(wallet, order);
    }

  } finally {
    try { await Q('plugin::users-permissions.user').delete({ where: { id: advertiser.id } }); } catch {}
    try { await Q('plugin::users-permissions.user').delete({ where: { id: attacker.id } }); } catch {}
    try { await Q('plugin::users-permissions.user').delete({ where: { id: adminUser.id } }); } catch {}
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n');
  process.exit(1);
});
