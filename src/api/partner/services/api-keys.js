'use strict';

/**
 * Customer API keys (2026-10-13).
 *
 * Keys look like `sbk_live_<32 chars>`. Only a SHA-256 hash is stored; the full
 * key is shown once when an admin creates it. Each key has a per-minute and a
 * per-day request limit; daily usage is counted in api_usage_daily.
 */
const crypto = require('crypto');

let ready = null;
function ensure() {
  if (!ready) {
    const knex = strapi.db.connection;
    ready = knex.raw(`create table if not exists api_keys (
        id serial primary key, user_id int, label text not null, key_prefix text not null, key_hash text not null unique,
        scopes jsonb not null default '["catalog:read"]', per_minute int not null default 60, per_day int not null default 10000,
        status text not null default 'active', expires_at timestamptz, notes text,
        created_by int, created_at timestamptz not null default now(), revoked_at timestamptz, revoked_by int,
        last_used_at timestamptz, last_used_ip text)`)
      .then(() => knex.raw(`create table if not exists api_usage_daily (
        key_id int not null, day date not null, requests int not null default 0, errors int not null default 0, rows_returned int not null default 0,
        primary key (key_id, day))`))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
function newKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(32);
  return 'sbk_live_' + Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

const cache = new Map(); // hash -> { row, at }
const minute = new Map(); // keyId -> { start, count }
const lastSeen = new Map(); // keyId -> ms

async function findByKey(key) {
  if (!/^sbk_live_[A-Za-z0-9]{20,64}$/.test(String(key || ''))) return null;
  await ensure();
  const h = hash(key);
  const c = cache.get(h);
  if (c && Date.now() - c.at < 60 * 1000) return c.row;
  const row = (await strapi.db.connection.raw('select * from api_keys where key_hash = ?', [h])).rows[0] || null;
  cache.set(h, { row, at: Date.now() });
  return row;
}
function invalidate() { cache.clear(); }

/** Returns { ok, status, code, message, headers }. Counts the request. */
async function admit(row, ip) {
  const now = Date.now();
  if (row.status !== 'active') return { ok: false, status: 401, code: 'key_revoked', message: 'This API key has been revoked.' };
  if (row.expires_at && new Date(row.expires_at).getTime() < now) return { ok: false, status: 401, code: 'key_expired', message: 'This API key has expired.' };
  const w = minute.get(row.id);
  const win = w && now - w.start < 60000 ? w : { start: now, count: 0 };
  win.count += 1; minute.set(row.id, win);
  const knex = strapi.db.connection;
  const today = (await knex.raw(`insert into api_usage_daily (key_id, day, requests) values (?, current_date, 1)
      on conflict (key_id, day) do update set requests = api_usage_daily.requests + 1 returning requests`, [row.id])).rows[0].requests;
  const headers = {
    'X-RateLimit-Limit': String(row.per_minute), 'X-RateLimit-Remaining': String(Math.max(0, row.per_minute - win.count)),
    'X-RateLimit-Reset': String(Math.ceil((win.start + 60000) / 1000)), 'X-Daily-Limit': String(row.per_day), 'X-Daily-Remaining': String(Math.max(0, row.per_day - today)),
  };
  if (!lastSeen.get(row.id) || now - lastSeen.get(row.id) > 60000) {
    lastSeen.set(row.id, now);
    knex.raw('update api_keys set last_used_at = now(), last_used_ip = ? where id = ?', [ip || null, row.id]).catch(() => {});
  }
  if (win.count > row.per_minute) return { ok: false, status: 429, code: 'rate_limited', message: `More than ${row.per_minute} requests in a minute. Wait and retry.`, headers };
  if (today > row.per_day) return { ok: false, status: 429, code: 'daily_limit', message: `Daily limit of ${row.per_day} requests reached. It resets at 00:00 UTC.`, headers };
  return { ok: true, headers };
}

async function countResult(keyId, rows, isError) {
  try {
    await strapi.db.connection.raw(`update api_usage_daily set rows_returned = rows_returned + ?, errors = errors + ? where key_id = ? and day = current_date`, [rows || 0, isError ? 1 : 0, keyId]);
  } catch (_) { /* usage is best effort */ }
}

module.exports = { ensure, hash, newKey, findByKey, invalidate, admit, countResult };
