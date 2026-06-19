#!/usr/bin/env node
/**
 * Regression test for the order create() mass-assignment allowlist
 * (audit M2).
 *
 * Pre-fix: ctx.request.body destructure pulled out content/links/projectName/etc.
 * but caught the rest in `...orderData` and spread it into entityService.create
 * via { ...data, advertiser: user.id, escrowHeld, orderDate, orderStatus: 'pending' }.
 * Only those 4 fields were forced server-side; everything else the caller
 * supplied (lifecycle dates, cancellation metadata, admin-on-behalf fields,
 * delivery pre-stamps, audit timestamps, etc.) was persisted as-is.
 *
 * The audit's specific HIGH claims (injecting orderStatus, escrowHeld,
 * paymentStatus, advertiser, publisher) turned out to be FALSE POSITIVES —
 * those are properly guarded. But ~14 lifecycle/audit/admin-only fields WERE
 * injectable:
 *   - createdByAdminId, adminReason, userConsentType, userConsentReference
 *   - acceptedDate, completedDate, rejectedDate, warningNotificationSentAt
 *   - cancelledBy, cancelledAt, cancellationReason, cancellationNotes
 *   - revisionStatus, deliveryProof, deliveryMessage, rejectionReason
 *
 * Fix: fail-closed ALLOWED_ORDER_CREATE_FIELDS allowlist applied to the
 * leftover orderData immediately after the destructure. Dropped keys are
 * logged at warn level.
 *
 * This test asserts (using direct controller invocation):
 *   1. Every audit-claimed-injectable field remains BLOCKED (as it always was —
 *      proving the controller still works correctly for the false-positive
 *      claims).
 *   2. Every truly-injectable lifecycle/audit/admin-only field is now
 *      BLOCKED by the new allowlist.
 *   3. Legitimate order creation still works (totalAmount, description,
 *      website all persist normally; escrow is held; advertiser/publisher
 *      are set correctly).
 *
 * Run:
 *   cd serpbays_server
 *   node scripts/test-order-create-allowlist.js
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
    data: { username: `m2t-adv-${stamp}`, email: `m2t-adv-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const publisher = await Q('plugin::users-permissions.user').create({
    data: { username: `m2t-pub-${stamp}`, email: `m2t-pub-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });
  const bystander = await Q('plugin::users-permissions.user').create({
    data: { username: `m2t-byst-${stamp}`, email: `m2t-byst-${stamp}@example.test`, provider: 'local', confirmed: true, role: role.id },
  });

  const wallet = await Q('api::user-wallet.user-wallet').create({
    data: { balance: 1000, mainBalance: 1000, promoBalance: 0, escrowBalance: 0,
      users_permissions_user: advertiser.id, publishedAt: new Date() },
  });
  await strapi.db.connection('user_wallets_users_permissions_user_lnk')
    .insert({ user_wallet_id: wallet.id, user_id: advertiser.id }).onConflict().ignore();

  const mp = await Q('api::marketplace.marketplace').create({
    data: { url: `m2t-target-${stamp}.example.com`, price: 50, link_insertion_price: 25,
      publisher_email: publisher.email, status: 'active', publishedAt: new Date() },
  });
  await strapi.db.connection('marketplaces_publisher_lnk').insert({ marketplace_id: mp.id, user_id: publisher.id });

  const mkCtx = (body) => {
    const c = {
      state: { user: advertiser }, request: { body: { data: body } }, params: {},
      _body: null, _err: null, _status: 200,
      send(b, s) { c._body = b; if (s) c._status = s; return b; },
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

  const cleanupOrder = async (id) => {
    if (!id) return;
    try {
      await strapi.db.connection('orders_advertiser_lnk').where({ order_id: id }).delete();
      await strapi.db.connection('orders_publisher_lnk').where({ order_id: id }).delete();
      await strapi.db.connection('orders_website_lnk').where({ order_id: id }).delete();
      const txs = await Q('api::transaction.transaction').findMany({ where: { order: id } });
      for (const t of txs) {
        await strapi.db.connection('transactions_user_wallet_lnk').where({ transaction_id: t.id }).delete();
        await strapi.db.connection('transactions_users_permissions_user_lnk').where({ transaction_id: t.id }).delete();
        await strapi.db.connection('transactions_order_lnk').where({ transaction_id: t.id }).delete();
        await Q('api::transaction.transaction').delete({ where: { id: t.id } });
      }
      await Q('api::order.order').delete({ where: { id } });
    } catch {}
  };

  try {
    out('\n=== 1) Mass-assignment of every lifecycle/audit/admin field is dropped ===');
    const evilPayload = {
      totalAmount: 50, description: 'm2 regression', website: mp.id,
      // Audit's specific HIGH claims — must remain blocked
      orderStatus: 'completed', escrowHeld: 0, paymentStatus: 'paid',
      advertiser: bystander.id, publisher: bystander.id,
      // Lifecycle dates
      acceptedDate: new Date(Date.now() - 8*86400000),
      completedDate: new Date(), rejectedDate: new Date(),
      deliveredDate: new Date(), disputeDate: new Date(),
      // Cancellation pre-stamping
      cancelledBy: 'system', cancelledAt: new Date(),
      cancellationReason: 'evil', cancellationNotes: 'evil',
      // Admin-on-behalf forgery
      createdByAdminId: 1, adminReason: 'evil',
      userConsentType: 'ticket', userConsentReference: 'FAKE',
      // Delivery pre-stamping
      deliveryProof: 'https://evil/p.pdf', deliveryMessage: 'fake',
      // Revision pre-stamping
      revisionStatus: 'completed',
      revisionRequestedAt: new Date(), revisionDeadline: new Date(),
      // Audit timestamp suppression
      warningNotificationSentAt: new Date(),
      rejectionReason: 'evil',
      // Snapshot tamper attempts
      websitePrice: 999, websitePublisherPrice: 1, websiteAhrefsDr: 99,
    };
    const ctx = mkCtx(evilPayload);
    const result = await ctrl.create(ctx);
    const orderId = result?.data?.id || ctx._body?.data?.id;
    const order = await Q('api::order.order').findOne({
      where: { id: orderId }, populate: ['advertiser', 'publisher'],
    });

    // 5 audit-claimed-injectable fields — should remain blocked
    assert(order.orderStatus === 'pending', `orderStatus='pending' (got ${order.orderStatus})`);
    assert(Number(order.escrowHeld) === 50, `escrowHeld=50 (got ${order.escrowHeld})`);
    assert(order.paymentStatus == null, 'paymentStatus null (field not on schema)');
    assert(order.advertiser?.id === advertiser.id, `advertiser is attacker, not bystander`);
    assert(order.publisher?.id === publisher.id, `publisher is marketplace owner, not bystander`);

    // Lifecycle dates blocked
    assert(order.acceptedDate == null, 'acceptedDate null');
    assert(order.completedDate == null, 'completedDate null');
    assert(order.rejectedDate == null, 'rejectedDate null');
    assert(order.deliveredDate == null, 'deliveredDate null');
    assert(order.disputeDate == null, 'disputeDate null');

    // Cancellation fields blocked
    assert(order.cancelledBy == null, 'cancelledBy null');
    assert(order.cancelledAt == null, 'cancelledAt null');
    assert(order.cancellationReason == null, 'cancellationReason null');
    assert(order.cancellationNotes == null, 'cancellationNotes null');

    // Admin-on-behalf forgery blocked
    assert(order.createdByAdminId == null, 'createdByAdminId null');
    assert(order.adminReason == null, 'adminReason null');
    assert(order.userConsentType == null, 'userConsentType null');
    assert(order.userConsentReference == null, 'userConsentReference null');

    // Delivery / revision / rejection / audit-timestamp suppression blocked
    assert(order.deliveryProof == null, 'deliveryProof null');
    assert(order.deliveryMessage == null, 'deliveryMessage null');
    assert(order.revisionStatus == null, 'revisionStatus null');
    assert(order.warningNotificationSentAt == null, 'warningNotificationSentAt null');
    assert(order.rejectionReason == null, 'rejectionReason null');

    // Snapshot fields from marketplace, not attacker payload
    assert(Number(order.websitePrice) === 50, `websitePrice from marketplace=50 (got ${order.websitePrice})`);
    assert(order.websiteAhrefsDr == null || Number(order.websiteAhrefsDr) !== 99,
      `websiteAhrefsDr NOT 99 (got ${order.websiteAhrefsDr})`);

    await cleanupOrder(orderId);

    out('\n=== 2) Legitimate create with only allowlisted fields still works ===');
    // Top up wallet
    await Q('api::user-wallet.user-wallet').update({
      where: { id: wallet.id }, data: { balance: 1000, mainBalance: 1000, escrowBalance: 0 },
    });
    const cleanCtx = mkCtx({
      totalAmount: 50, description: 'legit order', website: mp.id,
      specialCategory: '',
    });
    const r2 = await ctrl.create(cleanCtx);
    const r2id = r2?.data?.id || cleanCtx._body?.data?.id;
    const o2 = await Q('api::order.order').findOne({
      where: { id: r2id }, populate: ['advertiser', 'publisher'],
    });
    assert(o2 && Number(o2.totalAmount) === 50, 'order created with totalAmount=50');
    assert(o2.orderStatus === 'pending', 'orderStatus=pending');
    assert(Number(o2.escrowHeld) === 50, 'escrowHeld=50');
    assert(o2.advertiser?.id === advertiser.id, 'advertiser set');
    assert(o2.publisher?.id === publisher.id, 'publisher set from marketplace');
    const w2 = await Q('api::user-wallet.user-wallet').findOne({ where: { id: wallet.id } });
    assert(Number(w2.escrowBalance) === 50, `escrow held in wallet (got $${w2.escrowBalance})`);
    await cleanupOrder(r2id);

    out('\n=== 3) Drop-keys log fires on tamper attempt (smoke check) ===');
    // We can't capture strapi.log in this harness, but the assertion is that
    // the order is still created successfully despite the extra fields —
    // proving the allowlist scrubs without blocking the legitimate request.
    await Q('api::user-wallet.user-wallet').update({
      where: { id: wallet.id }, data: { balance: 1000, mainBalance: 1000, escrowBalance: 0 },
    });
    const noisyCtx = mkCtx({
      totalAmount: 50, description: 'noisy', website: mp.id,
      // Just one tamper-attempt field
      createdByAdminId: 999,
    });
    const r3 = await ctrl.create(noisyCtx);
    const r3id = r3?.data?.id || noisyCtx._body?.data?.id;
    const o3 = await Q('api::order.order').findOne({ where: { id: r3id } });
    assert(o3 && o3.createdByAdminId == null, 'tamper attempt dropped; order still created');
    await cleanupOrder(r3id);

  } finally {
    try { await strapi.db.connection('marketplaces_publisher_lnk').where({ marketplace_id: mp.id }).delete(); } catch {}
    try { await Q('api::marketplace.marketplace').delete({ where: { id: mp.id } }); } catch {}
    try { await strapi.db.connection('user_wallets_users_permissions_user_lnk').where({ user_wallet_id: wallet.id }).delete(); } catch {}
    try { await Q('api::user-wallet.user-wallet').delete({ where: { id: wallet.id } }); } catch {}
    for (const u of [advertiser, publisher, bystander]) {
      try { await Q('plugin::users-permissions.user').delete({ where: { id: u.id } }); } catch {}
    }
  }

  out(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
  await strapi.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { process.stderr.write('FATAL: ' + (e && e.stack || e) + '\n'); process.exit(1); });
