'use strict';

/**
 * User delete guard (2026-10-13).
 *
 * Deleting a user removes the link rows that tie their sites, listings, orders
 * and wallet to them, and leaves those records ownerless (this is how
 * scoopearth.in lost its publisher). So:
 *   - a user that owns any data cannot be deleted by any app path (panel API,
 *     users-permissions API, content manager): block them instead;
 *   - a trigger on up_users refuses the same deletes at database level too;
 *   - every deletion, including raw SQL ones, is recorded in deleted_users_log
 *     by a database trigger, and emailed to USER_DELETE_ALERT_TO
 *     (default vinayak@wordscloud.in) straight away; a 1-minute cron picks up
 *     anything the request path did not email.
 */
const ALERT_TO = () => (process.env.USER_DELETE_ALERT_TO || 'vinayak@wordscloud.in').split(',').map((s) => s.trim()).filter(Boolean);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const LABELS = {
  sites: 'publisher sites', listings: 'marketplace listings', buyerOrders: 'orders as buyer', publisherOrders: 'orders as publisher',
  transactions: 'transactions', walletBalance: 'wallet balance ($)', withdrawals: 'withdrawals', projects: 'projects', resellerCodes: 'reseller codes',
};

let ensured = false;
async function ensure(knex) {
  if (ensured) return;
  await knex.raw(`create table if not exists deleted_users_log (
      id serial primary key, user_id int, email text, username text, user_row jsonb, footprint jsonb,
      deleted_by text, via text, emailed_at timestamptz, created_at timestamptz not null default now())`);
  await knex.raw(`create or replace function log_user_delete() returns trigger language plpgsql as $f$
    begin
      -- Hard stop for users who own data, even for raw SQL. Deliberate maintenance can
      -- run "set local serpbays.allow_user_delete = 'on'" in the same transaction.
      if coalesce(current_setting('serpbays.allow_user_delete', true), '') <> 'on' and (
           exists (select 1 from publisher_websites_current_publisher_id_lnk where user_id = old.id)
        or exists (select 1 from publisher_websites_original_publisher_id_lnk where user_id = old.id)
        or exists (select 1 from marketplaces_publisher_lnk where user_id = old.id)
        or exists (select 1 from orders_advertiser_lnk where user_id = old.id)
        or exists (select 1 from orders_publisher_lnk where user_id = old.id)
        or exists (select 1 from transactions_users_permissions_user_lnk where user_id = old.id)
        or exists (select 1 from withdrawal_requests_publisher_lnk where user_id = old.id)
        or exists (select 1 from user_wallets w join user_wallets_users_permissions_user_lnk l on l.user_wallet_id = w.id
                    where l.user_id = old.id and coalesce(w.balance,0) + coalesce(w.escrow_balance,0) + coalesce(w.pending_withdrawal_balance,0) <> 0)
      ) then
        raise exception 'User % owns sites, orders, transactions or money and cannot be deleted. Block the user instead.', old.id;
      end if;
      insert into deleted_users_log (user_id, email, username, user_row, via)
        values (old.id, old.email, old.username, to_jsonb(old) - 'password' - 'reset_password_token' - 'confirmation_token', 'database');
      return old;
    end $f$`);
  await knex.raw(`drop trigger if exists trg_log_user_delete on up_users`);
  await knex.raw(`create trigger trg_log_user_delete before delete on up_users for each row execute function log_user_delete()`);
  ensured = true;
}

async function footprint(knex, userId) {
  const id = parseInt(userId, 10);
  const r = (await knex.raw(`select
      (select count(distinct x.publisher_website_id) from (
         select publisher_website_id from publisher_websites_current_publisher_id_lnk where user_id = ?
         union select publisher_website_id from publisher_websites_original_publisher_id_lnk where user_id = ?) x)::int sites,
      (select count(*) from marketplaces_publisher_lnk where user_id = ?)::int listings,
      (select count(*) from orders_advertiser_lnk where user_id = ?)::int buyer_orders,
      (select count(*) from orders_publisher_lnk where user_id = ?)::int publisher_orders,
      (select count(*) from transactions_users_permissions_user_lnk where user_id = ?)::int transactions,
      coalesce((select sum(coalesce(w.balance,0) + coalesce(w.escrow_balance,0) + coalesce(w.pending_withdrawal_balance,0))
         from user_wallets w join user_wallets_users_permissions_user_lnk l on l.user_wallet_id = w.id where l.user_id = ?), 0)::float wallet,
      (select count(*) from withdrawal_requests_publisher_lnk where user_id = ?)::int withdrawals,
      (select count(*) from projects_owner_lnk where user_id = ?)::int projects,
      (select count(*) from reseller_codes_assigned_to_lnk where user_id = ?)::int reseller_codes`, Array(10).fill(id))).rows[0];
  return {
    sites: r.sites, listings: r.listings, buyerOrders: r.buyer_orders, publisherOrders: r.publisher_orders, transactions: r.transactions,
    walletBalance: Math.round(Number(r.wallet) * 100) / 100, withdrawals: r.withdrawals, projects: r.projects, resellerCodes: r.reseller_codes,
  };
}

const blockers = (f) => Object.entries(f).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${v} ${LABELS[k] || k}`);

/** Throws when the user owns anything. Message tells the admin to block instead. */
async function assertDeletable(knex, userId) {
  const f = await footprint(knex, userId);
  const b = blockers(f);
  if (b.length) {
    const { errors } = require('@strapi/utils');
    throw new errors.ApplicationError(`User #${userId} cannot be deleted: they have ${b.join(', ')}. Deleting would orphan this data. Block the user instead.`, { footprint: f, deletable: false });
  }
  return f;
}

function who() {
  try {
    const ctx = strapi.requestContext.get();
    if (!ctx) return { by: 'system (no request)', via: 'background job / script' };
    const u = ctx.state && (ctx.state.user || ctx.state.auth?.credentials);
    const by = u ? `${u.username || u.firstname || ''} <${u.email || '?'}> (#${u.id})` : 'unknown';
    return { by, via: `${ctx.method} ${ctx.path} from ${ctx.request.ip}` };
  } catch { return { by: 'unknown', via: 'unknown' }; }
}

async function sendAlert(knex, row) {
  const u = row.user_row || {};
  const f = row.footprint || {};
  const html = `<p><b>A SerpBays user account was deleted.</b></p>
    <table style="border-collapse:collapse;font-size:14px">
      <tr><td style="padding:3px 10px 3px 0;color:#64748b">User</td><td>#${esc(row.user_id)} · ${esc(row.username)} · ${esc(row.email)}</td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#64748b">Name / business</td><td>${esc([u.first_name, u.last_name].filter(Boolean).join(' '))} ${u.business_name ? '· ' + esc(u.business_name) : ''}</td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#64748b">Signed up</td><td>${esc(u.created_at)}</td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#64748b">Deleted at</td><td>${esc(new Date(row.created_at).toISOString())}</td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#64748b">Deleted by</td><td>${esc(row.deleted_by || 'not known (deleted directly in the database)')}</td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#64748b">How</td><td>${esc(row.via)}</td></tr>
      <tr><td style="padding:3px 10px 3px 0;color:#64748b">Data at deletion</td><td>${Object.keys(f).length ? esc(blockers(f).join(', ') || 'none') : 'not checked (direct database delete)'}</td></tr>
    </table>
    <p style="color:#64748b;font-size:12px">The full user record (without password and tokens) is kept in the deleted_users_log table, row ${esc(row.id)}.</p>`;
  await strapi.service('api::admin-email.admin-email').sendAdminEmail({
    to: ALERT_TO(), subject: `User deleted: ${row.email || row.username || '#' + row.user_id}`, bodyHtml: html, senderAdminId: null, contextType: 'none',
  });
  await knex.raw('update deleted_users_log set emailed_at = now() where id = ?', [row.id]);
}

/** Lifecycle hooks for plugin::users-permissions.user, registered in bootstrap. */
function subscribe() {
  const knex = strapi.db.connection;
  const idsFrom = async (where) => {
    if (where && (typeof where.id === 'number' || typeof where.id === 'string')) return [where.id];
    const rows = await strapi.db.query('plugin::users-permissions.user').findMany({ where, select: ['id'], limit: 1000 });
    return rows.map((r) => r.id);
  };
  strapi.db.lifecycles.subscribe({
    models: ['plugin::users-permissions.user'],
    async beforeDelete(event) {
      await ensure(knex);
      const [id] = await idsFrom(event.params.where);
      if (id == null) return;
      event.state.footprints = { [id]: await assertDeletable(knex, id) };
      event.state.who = who();
    },
    async beforeDeleteMany(event) {
      await ensure(knex);
      const ids = await idsFrom(event.params.where);
      event.state.footprints = {};
      for (const id of ids) event.state.footprints[id] = await assertDeletable(knex, id);
      event.state.who = who();
    },
    async afterDelete(event) { await afterAny(event); },
    async afterDeleteMany(event) { await afterAny(event); },
  });
  async function afterAny(event) {
    const fps = event.state.footprints || {};
    const w = event.state.who || who();
    // The delete runs inside Strapi's transaction, so the trigger's log row is
    // only visible to other connections after commit: finish a moment later.
    if (Object.keys(fps).length) setTimeout(() => finish(fps, w).catch(() => {}), 2000);
  }
  async function finish(fps, w) {
    for (const id of Object.keys(fps)) {
      try {
        const row = (await knex.raw(`update deleted_users_log set deleted_by = ?, via = ?, footprint = ?::jsonb
            where id = (select max(id) from deleted_users_log where user_id = ?) returning *`, [w.by, w.via, JSON.stringify(fps[id]), parseInt(id, 10)])).rows[0];
        if (row && !row.emailed_at) await sendAlert(knex, row);
      } catch (e) { strapi.log.error(`[user-delete-guard] alert for #${id} failed: ${e.message}`); }
    }
  }
}

/** Cron: email deletions that did not go through the app (raw SQL, scripts). */
async function sweep() {
  const knex = strapi.db.connection;
  await ensure(knex);
  const rows = (await knex.raw(`select * from deleted_users_log where emailed_at is null and created_at < now() - interval '30 seconds' order by id limit 20`)).rows;
  for (const row of rows) await sendAlert(knex, row);
}

module.exports = { ensure, footprint, blockers, assertDeletable, subscribe, sweep, LABELS };
