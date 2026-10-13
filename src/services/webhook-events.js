'use strict';

/**
 * Gateway webhook idempotency (2026-10-14).
 *
 * Every Stripe / PayPal / Razorpay event is claimed here before it is
 * processed. A second delivery of the same event id is acknowledged with 200
 * and skipped. If processing throws, the claim is released so the gateway's
 * retry can run it again.
 */
let ready = null;
function ensure() {
  if (!ready) {
    ready = strapi.db.connection.raw(`create table if not exists webhook_events (
        id serial primary key, gateway text not null, event_id text not null, type text,
        received_at timestamptz not null default now(), processed_at timestamptz, result text,
        unique (gateway, event_id))`)
      .then(() => strapi.db.connection.raw(`delete from webhook_events where received_at < now() - interval '90 days'`))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Returns { ok: true, id } when this delivery should be processed, { ok: false } for a duplicate. */
async function claim(gateway, eventId, type) {
  await ensure();
  if (!eventId) return { ok: true, id: null }; // no id: cannot dedupe, process
  const r = await strapi.db.connection.raw(
    `insert into webhook_events (gateway, event_id, type) values (?, ?, ?) on conflict (gateway, event_id) do nothing returning id`,
    [gateway, String(eventId).slice(0, 200), type ? String(type).slice(0, 100) : null],
  );
  if (r.rows.length) return { ok: true, id: r.rows[0].id };
  strapi.log.info(`[webhook-events] duplicate ${gateway} event ${eventId} (${type || '?'}) skipped`);
  return { ok: false, id: null };
}

async function done(id, result) {
  if (!id) return;
  await strapi.db.connection.raw('update webhook_events set processed_at = now(), result = ? where id = ?', [String(result || 'ok').slice(0, 500), id]).catch(() => {});
}

/** Processing failed: release the claim so the gateway retry is accepted. */
async function release(id, err) {
  if (!id) return;
  strapi.log.warn(`[webhook-events] released claim ${id}: ${(err && err.message) || err}`);
  await strapi.db.connection.raw('delete from webhook_events where id = ?', [id]).catch(() => {});
}

module.exports = { ensure, claim, done, release };
