'use strict';

/**
 * Legacy `wallet` controller — most handlers were dead code and have been
 * removed. Only the route `POST /api/wallet/add-promo-funds` was wired to
 * this controller (via routes/wallet.js and routes/custom-wallet.js), and
 * that handler is now disabled (returns 410 Gone — see comment on the
 * stub below).
 *
 * Removed handlers (dead, never routed) and why they were dangerous:
 *
 *   getWallet(ctx):
 *     Had a `NODE_ENV !== 'production'` branch that, when no user was
 *     authenticated, returned an arbitrary wallet from the DB via
 *     `strapi.db.query('api::user-wallet.user-wallet').findOne({})`. If
 *     a production deploy ever ran with NODE_ENV unset or set to
 *     'development' AND someone wired a route to this handler, anonymous
 *     callers would receive a random user's balance + escrow data. Same
 *     class as the Stripe-webhook dev bypass removed in Pass 5. Removed
 *     entirely so the trap cannot be re-armed by a routing change.
 *
 *   createTransaction(ctx):
 *     Took caller-supplied `amount`, `currency`, `gateway`,
 *     `gatewayTransactionId`, and `status` (including 'success') from the
 *     request body and wrote a transaction row directly — another free-
 *     money primitive in the same class as `addFunds` and `addPromoFunds`.
 *
 *   listTransactions(ctx):
 *     Duplicate of user-wallet.getTransactions with no pageSize cap. The
 *     canonical handler is `user-wallet.getTransactions` on route
 *     `/api/wallet/transactions`.
 *
 *   redeemPromoCode(ctx):
 *     Was already a deprecation stub. The canonical handler is
 *     `user-wallet.redeemPromo` on route `/api/wallet/redeem-promo`.
 *
 *   validatePromoCode(_promoCode, _userId):
 *     Internal helper, never called.
 */

module.exports = {
  // PUBLIC HTTP wrapper for adding promo funds — DISABLED.
  //
  // CATASTROPHIC (pre-fix): the handler took {amount} from ctx.request.body
  // and called the internal addPromoFunds(user.id, amount, ...) helper,
  // which directly incremented the user's promoBalance. NO promo-code
  // consumption, NO server-side bonus calculation, NO verification. The
  // Authenticated role has `api::user-wallet.wallet.addPromoFunds`
  // permission (confirmed in up_permissions). Any logged-in user could:
  //   POST /api/wallet/add-promo-funds {amount: 1000000}
  // → promo balance credited $1M. Free promo funds — usable for any
  // wallet spend that draws against mainBalance + promoBalance.
  //
  // Same free-money class as the `addFunds` finding from Pass 8. Disabled.
  //
  // Legitimate promo-balance credit flows:
  //   POST /api/wallet/redeem-promo    → consumes a promo/voucher code,
  //                                     row-locked, idempotent, server-
  //                                     validated amount
  //   offer-engine.applyOffers          → server-side bonus calculation
  //                                     during gateway-verified deposits
  //
  // No frontend consumer of /api/wallet/add-promo-funds exists. Returns
  // HTTP 410 Gone + warn log so any caller surfaces in alerts.
  async addPromoFunds(ctx) {
    strapi.log?.warn?.(
      `[user-wallet] DISABLED /api/wallet/add-promo-funds called by user=${ctx.state?.user?.id ?? 'anon'} ip=${ctx.request.ip}`
    );
    ctx.status = 410;
    ctx.body = {
      error: 'gone',
      message: 'Direct promo credit is not available. Use the redeem-promo or gateway-verified deposit flow.',
    };
    return;
  },
};
