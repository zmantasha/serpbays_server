#!/usr/bin/env node
/**
 * Regression test for the revision-pending → completion guard (audit M5).
 *
 * Pre-fix:
 *   - services.completeOrder only validated orderStatus==='delivered'; no
 *     revisionStatus check. The natural state machine (requestRevision
 *     flips orderStatus to 'accepted') hid the gap on the happy path —
 *     but a row inconsistency (race, admin edit, future regression) that
 *     left orderStatus='delivered' + revisionStatus='requested'/'in_progress'
 *     allowed escrow release against still-pending revision work.
 *   - requestRevision was not in a transaction and didn't take a row lock,
 *     so a concurrent completeOrder could read the same 'delivered' row,
 *     drain escrow, and credit the publisher BEFORE requestRevision
 *     committed its status flip.
 *
 * Fix:
 *   - services.completeOrder: SELECT … FOR UPDATE row lock at top of trx;
 *     defensive revisionStatus guard (`requested` / `in_progress` → throw).
 *   - controllers.requestRevision: wraps the read-then-write critical
 *     section in a db.transaction with the same row lock; re-fetches under
 *     the lock; rejects with 4xx if the order has gone terminal.
 *
 * Asserts:
 *   1. Happy path — deliver → requestRevision → tries to complete: blocked
 *      (orderStatus='accepted' rule).
 *   2. Defense-in-depth — inconsistent row (orderStatus='delivered' +
 *      revisionStatus='requested') → completeOrder explicitly rejects.
 *   3. Same as (2) but with revisionStatus='in_progress'.
 *   4. After completeRevision (publisher re-delivers) → revisionStatus='completed'
 *      → completeOrder succeeds (escrow released, publisher credited).
 *   5. Multiple revision cycles (request → re-deliver → request → re-deliver
 *      → complete) — money moves only on the final complete.
 *   6. Concurrent requestRevision + completeOrder — exactly one wins, the
 *      other gets a 4xx, no inconsistency.
 *   7. completeOrder idempotency on already-completed order — still no-op.
 *
 * Run: cd serpbays_server && node scripts/test-revision-completion-guard.js
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

  let pass = 0, fail = 0;
  const out = (...a) => process.stderr.write(a.join(' ') + '\n');
  const assert = (cond, label) => {
    if (cond) { pass++; out('  ✅', label); }
    else      { fail++; out('  ❌', label); }
  };

  const stamp = Date.now();
  const role = await Q('plugin::users-permissions.role').findOne({ where: { type: 'authenticated' } });
  const advertiser = await Q('plugin::users-permissions.user').create({
    data: { username: `m5t-adv-${stamp}`, email: `m5t-adv-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const publisher = await Q('plugin::users-permissions.user').create({
    data: { username: `m5t-pub-${stamp}`, email: `m5t-pub-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });

  const seedScenario = async (orderStatus = 'delivered', revisionStatus = null) => {
    const advWallet = await Q('api::user-wallet.user-wallet').create({
      data: { balance: 50, mainBalance: 0, promoBalance: 0, escrowBalance: 50,
        users_permissions_user: advertiser.id, publishedAt: new Date() },
    });
    await strapi.db.connection('user_wallets_users_permissions_user_lnk')
      .insert({ user_wallet_id: advWallet.id, user_id: advertiser.id }).onConflict().ignore();
    const pubWallet = await Q('api::user-wallet.user-wallet').create({
      data: { balance: 0, mainBalance: 0, promoBalance: 0, escrowBalance: 0,
        users_permissions_user: publisher.id, publishedAt: new Date() },
    });
    await strapi.db.connection('user_wallets_users_permissions_user_lnk')
      .insert({ user_wallet_id: pubWallet.id, user_id: publisher.id }).onConflict().ignore();
    const order = await Q('api::order.order').create({
      data: {
        orderStatus, revisionStatus, totalAmount: 50, escrowHeld: 50, currency: 'USD',
        acceptedDate: new Date(), deliveredDate: new Date(),
        orderDate: new Date(), publishedAt: new Date(),
        metadata: { spendingBreakdown: { mainSpent: 50, promoSpent: 0, totalSpent: 50 } },
      },
    });
    await strapi.db.connection('orders_advertiser_lnk').insert({ order_id: order.id, user_id: advertiser.id });
    await strapi.db.connection('orders_publisher_lnk').insert({ order_id: order.id, user_id: publisher.id });
    return { advWallet, pubWallet, order };
  };

  const inspect = async (advWallet, pubWallet, order) => {
    const aw = await Q('api::user-wallet.user-wallet').findOne({ where: { id: advWallet.id } });
    const pw = await Q('api::user-wallet.user-wallet').findOne({ where: { id: pubWallet.id } });
    const o = await Q('api::order.order').findOne({ where: { id: order.id } });
    return {
      orderStatus: o.orderStatus,
      revisionStatus: o.revisionStatus,
      advEscrow: Number(aw.escrowBalance),
      pubMain: Number(pw.mainBalance),
    };
  };

  const mkCtx = (orderId, user, body, isOrderIdParam = false) => {
    const params = isOrderIdParam ? { orderId: String(orderId) } : { id: String(orderId) };
    const c = {
      params, state: { user }, request: { body: body || {} },
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

  const cleanupRow = async (advWallet, pubWallet, order) => {
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
      for (const w of [advWallet, pubWallet]) {
        await strapi.db.connection('user_wallets_users_permissions_user_lnk').where({ user_wallet_id: w.id }).delete();
        await Q('api::user-wallet.user-wallet').delete({ where: { id: w.id } });
      }
    } catch {}
  };

  try {
    out('\n=== 1) Happy path: deliver → requestRevision → completeOrder is BLOCKED ===');
    {
      const t = await seedScenario('delivered', null);
      await ctrl.requestRevision(mkCtx(t.order.id, advertiser, { message: 'needs work' }, true));
      const ctxC = mkCtx(t.order.id, advertiser, {});
      await ctrl.completeOrder(ctxC);
      assert(ctxC._err?.code === 400, `400 on complete (got ${ctxC._err?.code})`);
      const s = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(s.orderStatus === 'accepted', `order remains accepted (got ${s.orderStatus})`);
      assert(s.revisionStatus === 'requested', `revisionStatus=requested`);
      assert(s.advEscrow === 50, `escrow held $50`);
      assert(s.pubMain === 0, `publisher NOT credited`);
      await cleanupRow(t.advWallet, t.pubWallet, t.order);
    }

    out('\n=== 2) Defense-in-depth: inconsistent row (delivered + revisionStatus=requested) → REJECTED ===');
    {
      const t = await seedScenario('delivered', 'requested');
      const ctxC = mkCtx(t.order.id, advertiser, {});
      await ctrl.completeOrder(ctxC);
      assert(ctxC._err?.code === 400 && /revision/i.test(JSON.stringify(ctxC._err.msg)),
        `400 with "revision" message (got ${JSON.stringify(ctxC._err)})`);
      const s = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(s.orderStatus === 'delivered', 'order unchanged');
      assert(s.advEscrow === 50, 'escrow held');
      assert(s.pubMain === 0, 'publisher NOT credited');
      await cleanupRow(t.advWallet, t.pubWallet, t.order);
    }

    out('\n=== 3) Inconsistent variant: revisionStatus=in_progress → REJECTED ===');
    {
      const t = await seedScenario('delivered', 'in_progress');
      const ctxC = mkCtx(t.order.id, advertiser, {});
      await ctrl.completeOrder(ctxC);
      assert(ctxC._err?.code === 400 && /in_progress/i.test(JSON.stringify(ctxC._err.msg)),
        `400 mentioning in_progress (got ${JSON.stringify(ctxC._err)})`);
      const s = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(s.orderStatus === 'delivered', 'order unchanged');
      assert(s.pubMain === 0, 'publisher NOT credited');
      await cleanupRow(t.advWallet, t.pubWallet, t.order);
    }

    out('\n=== 4) After completeRevision → revisionStatus=completed → completeOrder SUCCEEDS ===');
    {
      const t = await seedScenario('delivered', null);
      await ctrl.requestRevision(mkCtx(t.order.id, advertiser, { message: 'rev1' }, true));
      // Publisher does completeRevision (which flips status='delivered',
      // revisionStatus='completed').
      await ctrl.completeRevision(mkCtx(t.order.id, publisher, { message: 're-delivered', deliveryProof: 'http://example/v2' }, true));
      const mid = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(mid.orderStatus === 'delivered', `status back to delivered after re-delivery`);
      assert(mid.revisionStatus === 'completed', `revisionStatus=completed`);

      const ctxC = mkCtx(t.order.id, advertiser, {});
      await ctrl.completeOrder(ctxC);
      const final = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(final.orderStatus === 'completed', `status=completed (got ${final.orderStatus})`);
      assert(final.advEscrow === 0, `escrow released to $0`);
      assert(final.pubMain === 50, `publisher credited $50 (got $${final.pubMain})`);
      await cleanupRow(t.advWallet, t.pubWallet, t.order);
    }

    out('\n=== 5) Multiple revision cycles, money only on final complete ===');
    {
      const t = await seedScenario('delivered', null);
      // Round 1
      await ctrl.requestRevision(mkCtx(t.order.id, advertiser, { message: 'r1' }, true));
      let s = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(s.pubMain === 0 && s.advEscrow === 50, `r1: no money moved`);
      await ctrl.completeRevision(mkCtx(t.order.id, publisher, { message: 'redeliver1' }, true));

      // Round 2
      await ctrl.requestRevision(mkCtx(t.order.id, advertiser, { message: 'r2' }, true));
      s = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(s.pubMain === 0 && s.advEscrow === 50, `r2: no money moved`);
      await ctrl.completeRevision(mkCtx(t.order.id, publisher, { message: 'redeliver2' }, true));

      // Final completion
      await ctrl.completeOrder(mkCtx(t.order.id, advertiser, {}));
      const final = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(final.orderStatus === 'completed', 'completed after 2 revision cycles');
      assert(final.pubMain === 50, 'publisher credited exactly $50 (no doubling)');
      assert(final.advEscrow === 0, 'escrow released exactly once');
      await cleanupRow(t.advWallet, t.pubWallet, t.order);
    }

    out('\n=== 6) Concurrent requestRevision + completeOrder — only one wins ===');
    {
      const t = await seedScenario('delivered', null);
      const ctxR = mkCtx(t.order.id, advertiser, { message: 'race revision' }, true);
      const ctxC = mkCtx(t.order.id, advertiser, {});
      await Promise.all([
        ctrl.requestRevision(ctxR).catch(() => {}),
        ctrl.completeOrder(ctxC).catch(() => {}),
      ]);
      const final = await inspect(t.advWallet, t.pubWallet, t.order);
      // Outcome 1: requestRevision committed first → completeOrder sees status='accepted' → 400
      // Outcome 2: completeOrder committed first → requestRevision sees status='completed' → 400
      const reqWon = (final.orderStatus === 'accepted' && final.revisionStatus === 'requested' && final.pubMain === 0);
      const cmpWon = (final.orderStatus === 'completed' && final.pubMain === 50 && final.advEscrow === 0);
      assert(reqWon || cmpWon, `race result is consistent (got ${JSON.stringify(final)})`);
      assert(!(reqWon && cmpWon), `not both winners`);
      // If completeOrder won, pubMain credited exactly once.
      if (cmpWon) {
        assert(final.pubMain === 50, 'publisher credited exactly once');
        const refunds = await Q('api::transaction.transaction').findMany({ where: { order: t.order.id } });
        const earnings = refunds.filter(r => r.type === 'deposit' && r.transactionStatus === 'success');
        assert(earnings.length === 1, `exactly 1 earnings tx (got ${earnings.length})`);
      }
      await cleanupRow(t.advWallet, t.pubWallet, t.order);
    }

    out('\n=== 7) completeOrder on already-completed order — no-op ===');
    {
      const t = await seedScenario('completed', null);
      // Pre-seeded as already-completed; bumping the advertiser wallet to
      // simulate post-completion state.
      await Q('api::user-wallet.user-wallet').update({
        where: { id: t.advWallet.id }, data: { escrowBalance: 0, mainBalance: 0, balance: 0 },
      });
      await Q('api::user-wallet.user-wallet').update({
        where: { id: t.pubWallet.id }, data: { mainBalance: 50, balance: 50 },
      });
      const ctxC = mkCtx(t.order.id, advertiser, {});
      await ctrl.completeOrder(ctxC);
      const s = await inspect(t.advWallet, t.pubWallet, t.order);
      assert(s.orderStatus === 'completed', 'still completed');
      assert(s.pubMain === 50, 'publisher mainBalance unchanged (no double credit)');
      await cleanupRow(t.advWallet, t.pubWallet, t.order);
    }

  } finally {
    for (const u of [advertiser, publisher]) {
      try { await Q('plugin::users-permissions.user').delete({ where: { id: u.id } }); } catch {}
    }
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
