#!/usr/bin/env node
'use strict';

/**
 * Exercises the rewritten completeOrder service across:
 *   1. Happy path     — wallets move, audit rows exist, status flips.
 *   2. Idempotency    — second call no-ops, no double credit/debit.
 *   3. Failure path   — make an inner step throw; verify FULL rollback.
 *   4. Drift handling — pre-drift the advertiser escrow below escrowHeld;
 *                       verify completion floors at 0 (no negative).
 *
 * Each scenario sets up a fresh synthetic order between two synthetic users
 * + wallets, runs the scenario, asserts, then deletes the synthetic rows.
 */

(async () => {
  const { createStrapi } = require('@strapi/strapi');
  const strapi = await createStrapi();
  await strapi.load();
  const log = (...a) => process.stdout.write(a.join(' ') + '\n');

  // --- helpers ------------------------------------------------------------
  const Q = (uid) => strapi.db.query(uid);
  let scenarioPass = true;
  let totalPass = 0;
  let totalFail = 0;
  const assert = (cond, label) => {
    if (cond) { log(`  ✅ ${label}`); totalPass++; }
    else { log(`  ❌ ${label}`); totalFail++; scenarioPass = false; }
  };

  // Each setup creates two ephemeral users with marker emails so cleanup is safe.
  let counter = 0;
  const setup = async ({ depositMain = 100, depositEscrow = 10, totalAmount = 10 } = {}) => {
    counter += 1;
    const stamp = `${Date.now()}-${counter}`;
    const adv = await Q('plugin::users-permissions.user').create({
      data: { username: `t-adv-${stamp}`, email: `t-adv-${stamp}@example.test`, provider: 'local', confirmed: true },
    });
    const pub = await Q('plugin::users-permissions.user').create({
      data: { username: `t-pub-${stamp}`, email: `t-pub-${stamp}@example.test`, provider: 'local', confirmed: true },
    });
    const advWallet = await Q('api::user-wallet.user-wallet').create({
      data: {
        type: 'unified', currency: 'USD',
        balance: depositMain, mainBalance: depositMain,
        promoBalance: 0, escrowBalance: depositEscrow, pendingWithdrawalBalance: 0,
        users_permissions_user: adv.id, publishedAt: new Date(),
      },
    });
    const pubWallet = await Q('api::user-wallet.user-wallet').create({
      data: {
        type: 'unified', currency: 'USD',
        balance: 0, mainBalance: 0, promoBalance: 0, escrowBalance: 0, pendingWithdrawalBalance: 0,
        users_permissions_user: pub.id, publishedAt: new Date(),
      },
    });
    // Use a real marketplace row so populate works; we recycle marketplace 680.
    const order = await Q('api::order.order').create({
      data: {
        orderStatus: 'delivered', totalAmount, escrowHeld: totalAmount,
        advertiser: adv.id, publisher: pub.id, publishedAt: new Date(),
      },
    });
    return { adv, pub, advWallet, pubWallet, order };
  };

  const cleanup = async ({ adv, pub, advWallet, pubWallet, order }) => {
    try {
      await Q('api::transaction.transaction').deleteMany({ where: { order: order.id } });
      await Q('api::order.order').delete({ where: { id: order.id } });
      await Q('api::user-wallet.user-wallet').delete({ where: { id: advWallet.id } });
      await Q('api::user-wallet.user-wallet').delete({ where: { id: pubWallet.id } });
      await Q('plugin::users-permissions.user').delete({ where: { id: adv.id } });
      await Q('plugin::users-permissions.user').delete({ where: { id: pub.id } });
    } catch (e) { log('cleanup warn:', e.message); }
  };

  const orderSvc = strapi.service('api::order.order');

  // --- 1) Happy path ------------------------------------------------------
  log('\n=== 1) HAPPY PATH ===');
  scenarioPass = true;
  {
    const ctx = await setup({ totalAmount: 10 });
    await orderSvc.completeOrder(ctx.order.id);
    const adv = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.advWallet.id } });
    const pub = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.pubWallet.id } });
    const ord = await Q('api::order.order').findOne({ where: { id: ctx.order.id } });
    const txs = await Q('api::transaction.transaction').findMany({ where: { order: ctx.order.id }, orderBy: { id: 'asc' } });

    assert(adv.escrowBalance == 0, `advertiser escrow 10 → 0 (got ${adv.escrowBalance})`);
    assert(Number(pub.mainBalance) == 10, `publisher mainBalance 0 → 10 (got ${pub.mainBalance})`);
    assert(Number(pub.balance) == 10, `publisher balance 0 → 10 (got ${pub.balance})`);
    assert(ord.orderStatus === 'completed', `order status delivered → completed (got ${ord.orderStatus})`);
    const txTypes = txs.map(t => t.type).sort();
    assert(JSON.stringify(txTypes) === JSON.stringify(['deposit', 'escrow_release', 'fee']), `audit txs created: ${txTypes.join(',')}`);
    const advTx = txs.find(t => t.type === 'escrow_release');
    const pubTx = txs.find(t => t.type === 'deposit');
    assert(advTx && Number(advTx.amount) == 10, 'escrow_release amount = 10');
    assert(pubTx && Number(pubTx.amount) == 10, 'deposit (publisher earnings) amount = 10');
    await cleanup(ctx);
  }
  log(scenarioPass ? '  → PASS' : '  → FAIL');

  // --- 2) Idempotency -----------------------------------------------------
  log('\n=== 2) IDEMPOTENCY (double call) ===');
  scenarioPass = true;
  {
    // Set escrow deposit exactly equal to escrowHeld so the first run drains
    // it to 0 — then a second call (if idempotency were broken) would push
    // escrow negative or trigger drift, which is the failure mode we care about.
    const ctx = await setup({ totalAmount: 7, depositEscrow: 7 });
    await orderSvc.completeOrder(ctx.order.id);
    await orderSvc.completeOrder(ctx.order.id); // second call must no-op
    const adv = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.advWallet.id } });
    const pub = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.pubWallet.id } });
    const txs = await Q('api::transaction.transaction').findMany({ where: { order: ctx.order.id } });

    assert(Number(adv.escrowBalance) === 0, `advertiser escrow exactly 0 (got ${adv.escrowBalance})`);
    assert(Number(pub.mainBalance) == 7, 'publisher mainBalance == 7 (no double-credit)');
    const releases = txs.filter(t => t.type === 'escrow_release').length;
    const deposits = txs.filter(t => t.type === 'deposit').length;
    assert(releases === 1, `exactly 1 escrow_release tx (got ${releases})`);
    assert(deposits === 1, `exactly 1 deposit tx (got ${deposits})`);
    await cleanup(ctx);
  }
  log(scenarioPass ? '  → PASS' : '  → FAIL');

  // --- 3) Failure path (rollback) ----------------------------------------
  log('\n=== 3) FAILURE PATH (mid-transaction throw → full rollback) ===');
  scenarioPass = true;
  {
    const ctx = await setup({ totalAmount: 5 });
    // Monkey-patch entityService.create so the 2nd creation (the publisher
    // deposit, after the advertiser escrow_release row) throws. The
    // transaction must roll back everything written before it.
    const realCreate = strapi.entityService.create.bind(strapi.entityService);
    let createCalls = 0;
    strapi.entityService.create = async (uid, opts) => {
      if (uid === 'api::transaction.transaction') {
        createCalls += 1;
        if (createCalls === 2) throw new Error('INJECTED-FAILURE');
      }
      return realCreate(uid, opts);
    };

    let thrown = false;
    try { await orderSvc.completeOrder(ctx.order.id); }
    catch (e) { thrown = e.message.includes('INJECTED-FAILURE'); }
    strapi.entityService.create = realCreate;

    const adv = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.advWallet.id } });
    const pub = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.pubWallet.id } });
    const ord = await Q('api::order.order').findOne({ where: { id: ctx.order.id } });
    const txs = await Q('api::transaction.transaction').findMany({ where: { order: ctx.order.id } });

    assert(thrown, 'completeOrder threw INJECTED-FAILURE');
    assert(adv.escrowBalance == 10, `advertiser escrow rolled back to 10 (got ${adv.escrowBalance})`);
    assert(Number(pub.mainBalance) == 0, 'publisher mainBalance still 0 (rolled back)');
    assert(ord.orderStatus === 'delivered', `order status still delivered (got ${ord.orderStatus})`);
    assert(txs.length === 0, `no audit txs persisted (got ${txs.length})`);
    await cleanup(ctx);
  }
  log(scenarioPass ? '  → PASS' : '  → FAIL');

  // --- 4) Drift handling (escrow < escrowHeld) ---------------------------
  log('\n=== 4) DRIFT (advertiser escrow < order.escrowHeld → floor at 0) ===');
  scenarioPass = true;
  {
    const ctx = await setup({ totalAmount: 5, depositEscrow: 2 }); // wallet has 2, order needs 5 — drift
    await orderSvc.completeOrder(ctx.order.id);
    const adv = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.advWallet.id } });
    const pub = await Q('api::user-wallet.user-wallet').findOne({ where: { id: ctx.pubWallet.id } });
    const ord = await Q('api::order.order').findOne({ where: { id: ctx.order.id } });
    assert(adv.escrowBalance == 0, `escrow floored at 0 (got ${adv.escrowBalance}, not negative)`);
    assert(Number(pub.mainBalance) == 5, `publisher still credited full $5 (got ${pub.mainBalance})`);
    assert(ord.orderStatus === 'completed', 'order still completes despite drift');
    await cleanup(ctx);
  }
  log(scenarioPass ? '  → PASS' : '  → FAIL');

  log(`\n=== SUMMARY: ${totalPass} passed, ${totalFail} failed ===`);
  await strapi.destroy();
  process.exit(totalFail === 0 ? 0 : 1);
})();
