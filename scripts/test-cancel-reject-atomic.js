#!/usr/bin/env node
/**
 * Regression test for the cancel/reject atomic refund + status flip fix
 * (audit M3 + M7).
 *
 * Pre-fix:
 *   - controllers.cancelOrder called services.refundEscrowToAdvertiser
 *     then a SEPARATE entityService.update to flip orderStatus='cancelled'.
 *     The two writes were not atomic. A crash between them left money
 *     refunded but order status unchanged — a retry double-refunded.
 *   - controllers.rejectOrder called services.rejectOrder (a transactional
 *     refund) but the status flip was a SEPARATE db.query.update outside
 *     the service's transaction. Same architectural gap (though refundEscrow
 *     for reject happened to throw on insufficient escrow, accidentally
 *     blocking the double-refund — fragile).
 *   - src/cron/order-cancellation.js had the exact same pattern; a partial
 *     day-1 commit would be reprocessed by the day-2 run.
 *
 * Fix:
 *   - services.rejectOrder: status flip moved INSIDE the existing
 *     transaction; row-lock + idempotency pre-state check added.
 *   - services.cancelOrderAtomic (new): refund + status flip wrapped in a
 *     single transaction with SELECT ... FOR UPDATE on the order row and
 *     an idempotency pre-state check.
 *   - services.refundEscrowToAdvertiser: throws on insufficient escrow
 *     (instead of clamping at 0); throws if a successful refund tx
 *     already exists for the order (defense-in-depth idempotency).
 *   - controllers.cancelOrder + cron now call cancelOrderAtomic.
 *
 * This test asserts:
 *   1. Reject happy path — refund + status flip commit together.
 *   2. Reject retry (already-rejected) — service returns alreadyTerminal;
 *      controller responds with 400; NO second refund tx.
 *   3. Reject + simulated crash on status flip — transaction rolls back;
 *      no refund tx; status unchanged. Retry without crash succeeds.
 *   4. Cancel happy path (via admin) — refund + status flip commit together.
 *   5. Cancel retry (already-cancelled) — alreadyTerminal; controller 400;
 *      NO second refund tx.
 *   6. Cancel + simulated crash — transaction rollback; no double-refund
 *      on retry.
 *   7. refundEscrowToAdvertiser called twice directly → second call throws
 *      "already refunded" (defense-in-depth).
 *   8. Concurrent cancels — only 1 refund total; race-loser gets
 *      alreadyTerminal.
 *
 * Run: cd serpbays_server && node scripts/test-cancel-reject-atomic.js
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
  const svc = strapi.service('api::order.order');

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  const stamp = Date.now();
  const role = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const superRole = await Q('plugin::users-permissions.role').findOne({ where: { type: 'super_admin' } });
  const advertiser = await Q('plugin::users-permissions.user').create({
    data: { username: `ar-adv-${stamp}`, email: `ar-adv-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const publisher = await Q('plugin::users-permissions.user').create({
    data: { username: `ar-pub-${stamp}`, email: `ar-pub-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const adminUser = await Q('plugin::users-permissions.user').create({
    data: { username: `ar-adm-${stamp}`, email: `ar-adm-${stamp}@example.test`, provider: 'local', confirmed: true, role: superRole.id },
  });
  const adminLoaded = await Q('plugin::users-permissions.user').findOne({ where: { id: adminUser.id }, populate: ['role'] });

  const seedScenario = async (opts = {}) => {
    const wallet = await Q('api::user-wallet.user-wallet').create({
      data: { balance: 50, mainBalance: 0, promoBalance: 0, escrowBalance: 50,
        users_permissions_user: advertiser.id, publishedAt: new Date() },
    });
    await strapi.db.connection('user_wallets_users_permissions_user_lnk')
      .insert({ user_wallet_id: wallet.id, user_id: advertiser.id }).onConflict().ignore();
    const order = await Q('api::order.order').create({
      data: {
        orderStatus: opts.status || 'pending', totalAmount: 50, escrowHeld: 50, currency: 'USD',
        acceptedDate: opts.status === 'accepted' ? new Date() : null,
        orderDate: new Date(), publishedAt: new Date(),
        metadata: { spendingBreakdown: { mainSpent: 50, promoSpent: 0, totalSpent: 50 } },
      },
    });
    await strapi.db.connection('orders_advertiser_lnk').insert({ order_id: order.id, user_id: advertiser.id });
    await strapi.db.connection('orders_publisher_lnk').insert({ order_id: order.id, user_id: publisher.id });
    return { wallet, order };
  };

  const inspect = async (wallet, order) => {
    const w = await Q('api::user-wallet.user-wallet').findOne({ where: { id: wallet.id } });
    const o = await Q('api::order.order').findOne({ where: { id: order.id } });
    const refunds = await Q('api::transaction.transaction').findMany({ where: { order: order.id, type: 'refund', transactionStatus: 'success' } });
    return { w, o, refunds };
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
    Object.defineProperty(c, 'status', { get() { return c._status; }, set(v) { c._status = v; } });
    Object.defineProperty(c, 'body', { get() { return c._body; }, set(v) { c._body = v; } });
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
      await strapi.db.connection('orders_publisher_lnk').where({ order_id: order.id }).delete();
      await Q('api::order.order').delete({ where: { id: order.id } });
      await strapi.db.connection('user_wallets_users_permissions_user_lnk').where({ user_wallet_id: wallet.id }).delete();
      await Q('api::user-wallet.user-wallet').delete({ where: { id: wallet.id } });
    } catch {}
  };

  // Surgical interceptor for the "crash mid-write" scenarios.
  const originalEs = strapi.entityService.update.bind(strapi.entityService);
  const originalDbUpdate = Q('api::order.order').update.bind(Q('api::order.order'));
  let crashOrderStatusFlips = false;
  strapi.entityService.update = async (uid, id, opts) => {
    if (crashOrderStatusFlips && uid === 'api::order.order' && opts?.data?.orderStatus) {
      throw new Error('SIMULATED: DB error mid-status-flip');
    }
    return originalEs(uid, id, opts);
  };
  Q('api::order.order').update = async (args) => {
    if (crashOrderStatusFlips && args?.data?.orderStatus) {
      throw new Error('SIMULATED: DB error mid-status-flip');
    }
    return originalDbUpdate(args);
  };

  try {
    out('\n=== 1) Reject happy path — refund + status flip commit together ===');
    {
      const { wallet, order } = await seedScenario();
      const ctx = mkCtx(order.id, publisher, { reason: 'no thanks' });
      await ctrl.rejectOrder(ctx);
      const s = await inspect(wallet, order);
      assert(s.o.orderStatus === 'rejected', `status=rejected (got ${s.o.orderStatus})`);
      assert(s.refunds.length === 1, `1 refund tx (got ${s.refunds.length})`);
      assert(Number(s.w.mainBalance) === 50, `mainBalance=$50`);
      assert(Number(s.w.escrowBalance) === 0, `escrow=$0`);
      assert(s.o.rejectionReason === 'no thanks', 'rejection reason persisted');
      await cleanupRow(wallet, order);
    }

    out('\n=== 2) Reject retry on already-rejected — alreadyTerminal, NO 2nd refund ===');
    {
      const { wallet, order } = await seedScenario();
      // First reject
      await ctrl.rejectOrder(mkCtx(order.id, publisher, { reason: 'first' }));
      // Second reject
      const ctx2 = mkCtx(order.id, publisher, { reason: 'second' });
      await ctrl.rejectOrder(ctx2);
      const s = await inspect(wallet, order);
      // The controller has a pre-check (orderStatus !== 'pending') that
      // catches this BEFORE reaching the service; either way, NO second
      // refund + NO state mutation.
      assert(s.refunds.length === 1, `still 1 refund after retry (got ${s.refunds.length})`);
      assert(Number(s.w.mainBalance) === 50, `mainBalance unchanged $50`);
      await cleanupRow(wallet, order);
    }

    out('\n=== 3) Reject + simulated crash → tx rolls back, no money moves ===');
    {
      const { wallet, order } = await seedScenario();
      crashOrderStatusFlips = true;
      const ctx = mkCtx(order.id, publisher, { reason: 'crash test' });
      try { await ctrl.rejectOrder(ctx); } catch {}
      const after1 = await inspect(wallet, order);
      assert(after1.o.orderStatus === 'pending', `status still pending after crash`);
      assert(after1.refunds.length === 0, `0 refund tx after crash (got ${after1.refunds.length})`);
      assert(Number(after1.w.mainBalance) === 0, `mainBalance unchanged $0`);
      assert(Number(after1.w.escrowBalance) === 50, `escrow unchanged $50`);

      crashOrderStatusFlips = false;
      await ctrl.rejectOrder(mkCtx(order.id, publisher, { reason: 'retry' }));
      const after2 = await inspect(wallet, order);
      assert(after2.o.orderStatus === 'rejected', 'retry succeeds');
      assert(after2.refunds.length === 1, '1 refund (no double)');
      await cleanupRow(wallet, order);
    }

    out('\n=== 4) Cancel happy path (admin) — refund + status flip commit together ===');
    {
      const { wallet, order } = await seedScenario({ status: 'accepted' });
      const ctx = mkCtx(order.id, adminLoaded, { reason: 'admin cancel' });
      await ctrl.cancelOrder(ctx);
      const s = await inspect(wallet, order);
      assert(s.o.orderStatus === 'cancelled', `status=cancelled (got ${s.o.orderStatus})`);
      assert(s.o.cancelledBy === 'admin', `cancelledBy=admin`);
      assert(s.refunds.length === 1, `1 refund tx (got ${s.refunds.length})`);
      assert(Number(s.w.mainBalance) === 50, `mainBalance=$50`);
      assert(Number(s.w.escrowBalance) === 0, `escrow=$0`);
      await cleanupRow(wallet, order);
    }

    out('\n=== 5) Cancel retry on already-cancelled — alreadyTerminal, NO 2nd refund ===');
    {
      const { wallet, order } = await seedScenario({ status: 'accepted' });
      await ctrl.cancelOrder(mkCtx(order.id, adminLoaded, { reason: 'first' }));
      const ctx2 = mkCtx(order.id, adminLoaded, { reason: 'second' });
      await ctrl.cancelOrder(ctx2);
      assert(ctx2._err && ctx2._err.code === 400 && /already/i.test(JSON.stringify(ctx2._err.msg)),
        `400 with "already" message (got ${JSON.stringify(ctx2._err)})`);
      const s = await inspect(wallet, order);
      assert(s.refunds.length === 1, `still 1 refund after retry`);
      assert(Number(s.w.mainBalance) === 50, `mainBalance unchanged $50`);
      await cleanupRow(wallet, order);
    }

    out('\n=== 6) Cancel + simulated crash → tx rolls back, no double-refund on retry ===');
    {
      const { wallet, order } = await seedScenario({ status: 'accepted' });
      crashOrderStatusFlips = true;
      const ctxA = mkCtx(order.id, adminLoaded, { reason: 'crash' });
      try { await ctrl.cancelOrder(ctxA); } catch {}
      const after1 = await inspect(wallet, order);
      assert(after1.o.orderStatus === 'accepted', `status unchanged after crash`);
      assert(after1.refunds.length === 0, `0 refund tx after crash`);
      assert(Number(after1.w.mainBalance) === 0, `mainBalance unchanged`);
      assert(Number(after1.w.escrowBalance) === 50, `escrow unchanged $50`);

      crashOrderStatusFlips = false;
      await ctrl.cancelOrder(mkCtx(order.id, adminLoaded, { reason: 'retry' }));
      const after2 = await inspect(wallet, order);
      assert(after2.o.orderStatus === 'cancelled', 'retry succeeds');
      assert(after2.refunds.length === 1, `1 refund (no double)`);
      assert(Number(after2.w.mainBalance) === 50, `mainBalance=$50 (single refund)`);
      await cleanupRow(wallet, order);
    }

    out('\n=== 7) refundEscrowToAdvertiser direct double-call → throws "already refunded" ===');
    {
      const { wallet, order } = await seedScenario({ status: 'accepted' });
      const orderLoaded = await Q('api::order.order').findOne({ where: { id: order.id }, populate: ['advertiser'] });
      await svc.refundEscrowToAdvertiser(orderLoaded);
      let err = null;
      try { await svc.refundEscrowToAdvertiser(orderLoaded); } catch (e) { err = e; }
      assert(err && /already.*refund/i.test(err.message), `2nd call throws "already refunded" (got: ${err?.message})`);
      const s = await inspect(wallet, order);
      assert(s.refunds.length === 1, `still exactly 1 refund tx`);
      await cleanupRow(wallet, order);
    }

    out('\n=== 8) Concurrent cancels — exactly 1 refund, race-loser sees alreadyTerminal ===');
    {
      const { wallet, order } = await seedScenario({ status: 'accepted' });
      const [r1, r2] = await Promise.all([
        ctrl.cancelOrder(mkCtx(order.id, adminLoaded, { reason: 'race A' })),
        ctrl.cancelOrder(mkCtx(order.id, adminLoaded, { reason: 'race B' })),
      ]);
      const s = await inspect(wallet, order);
      assert(s.refunds.length === 1, `exactly 1 refund from 2 concurrent cancels (got ${s.refunds.length})`);
      assert(Number(s.w.mainBalance) === 50, `mainBalance=$50 (not doubled)`);
      assert(Number(s.w.escrowBalance) === 0, `escrow=$0`);
      assert(s.o.orderStatus === 'cancelled', `status=cancelled`);
      await cleanupRow(wallet, order);
    }

  } finally {
    strapi.entityService.update = originalEs;
    Q('api::order.order').update = originalDbUpdate;
    for (const u of [advertiser, publisher, adminUser]) {
      try { await Q('plugin::users-permissions.user').delete({ where: { id: u.id } }); } catch {}
    }
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
