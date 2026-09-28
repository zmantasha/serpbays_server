'use strict';

/**
 * Integration key store + Apify key pool + DR cache + alerts.
 *
 * Keys edited from the admin panel live in `integration_keys`, AES-256-GCM
 * encrypted with INTEGRATIONS_SECRET_KEY (server .env). A panel key overrides
 * the .env key for the same provider; with no panel key the .env key is used,
 * so nothing breaks if the table is empty.
 *
 * Apify pool: slot 0 = primary, slots 1..7 = backups.
 *   Backups are tried least-recently-used first (never-used first).
 *   - A key Apify REJECTS (401/403: revoked, deleted, expired) → next key, alert.
 *   - Budget guard (90 % of the key's monthly limit) or 402 → switch only to a
 *     backup on a PAID Apify plan; free-plan backups are never used to get past
 *     a spending limit. No paid backup → Apify pauses and an alert is raised.
 *   - The backup that does the work is promoted to primary.
 *
 * DR cache (`integration_dr_cache`): every fetched DR is remembered for 30 days
 * so the same domain is not paid for twice.
 */

const crypto = require('crypto');

const PROVIDERS = { ahrefs: { maxSlots: 1 }, apify: { maxSlots: 8 } };
const BUDGET_GUARD = 0.9;
const CACHE_DAYS = 30;
const ALERT_EMAIL_EVERY_H = 12;

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function money(v) { return Math.round(n(v) * 10000) / 10000; }
const knex = () => strapi.db.connection;
const rows = (r) => r.rows || r;

// ───────────────────────── schema ─────────────────────────
let ready = null;
function ensureTables() {
  if (!ready) {
    ready = (async () => {
      await knex().raw(`create table if not exists integration_keys (
        id serial primary key, provider text not null, slot int not null, label text,
        secret_enc text not null, secret_hash text not null, last4 text,
        account_id text, account_username text, plan text,
        status text not null default 'unchecked', last_error text,
        usage_used numeric, usage_limit numeric, last_checked_at timestamptz, last_used_at timestamptz,
        disabled boolean not null default false, created_by int, updated_by int,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
        unique (provider, slot))`);
      await knex().raw(`create table if not exists integration_dr_cache (
        domain text primary key, dr numeric not null, provider text, fetched_at timestamptz not null default now())`);
      await knex().raw(`create table if not exists integration_alerts (
        id serial primary key, provider text not null, kind text not null, key_id int, message text not null,
        created_at timestamptz not null default now(), resolved_at timestamptz, resolved_by int, emailed_at timestamptz)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ───────────────────────── crypto ─────────────────────────
function encKey() {
  const s = process.env.INTEGRATIONS_SECRET_KEY;
  if (!s) throw new Error('INTEGRATIONS_SECRET_KEY is not set on the API server');
  return crypto.createHash('sha256').update(s).digest();
}
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}
function decrypt(blob) {
  const [iv, tag, data] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
const hashOf = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mask = (s) => (s ? `••••${String(s).slice(-4)}` : null);

// ───────────────────────── http ─────────────────────────
async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { status: r.status, ok: r.ok, body };
  } finally { clearTimeout(t); }
}

// ───────────────────────── validation (live) ─────────────────────────
async function probe(provider, secret) {
  if (provider === 'ahrefs') {
    const r = await fetchJson('https://api.ahrefs.com/v3/public/domain-rating-free?target=ahrefs.com&output=json', { headers: { Authorization: `Bearer ${secret}` } }, 10000);
    if (r.ok && r.body && r.body.domain_rating) return { ok: true, status: 'ok', detail: `Answered: ahrefs.com DR ${r.body.domain_rating.domain_rating}` };
    if (r.status === 401 || r.status === 403) return { ok: false, status: 'invalid', detail: `Ahrefs rejected the key (${r.status}).` };
    return { ok: false, status: 'error', detail: `Ahrefs answered ${r.status}.` };
  }
  const h = { headers: { Authorization: `Bearer ${secret}` } };
  const [me, lim] = await Promise.all([fetchJson('https://api.apify.com/v2/users/me', h), fetchJson('https://api.apify.com/v2/users/me/limits', h)]);
  if (me.status === 401 || me.status === 403) return { ok: false, status: 'invalid', detail: `Apify rejected the token (${me.status}).` };
  if (!me.ok) return { ok: false, status: 'error', detail: `Apify answered ${me.status}.` };
  const d = (me.body && me.body.data) || {};
  const l = (lim.body && lim.body.data) || {};
  const used = n(l.current && l.current.monthlyUsageUsd), cap = n(l.limits && l.limits.maxMonthlyUsageUsd);
  const atGuard = cap > 0 && used >= cap * BUDGET_GUARD;
  return {
    ok: true, status: atGuard ? 'limit' : 'ok',
    detail: `Account ${d.username || '?'} · plan ${(d.plan && d.plan.id) || '?'} · $${money(used)} of ${cap ? '$' + money(cap) : 'no limit'} used this month`,
    accountId: d.id || null, accountUsername: d.username || null, plan: (d.plan && d.plan.id) || null,
    usedUsd: money(used), limitUsd: cap || null,
  };
}

// ───────────────────────── key store ─────────────────────────
async function listKeys(provider) {
  await ensureTables();
  const q = provider ? knex().raw('select * from integration_keys where provider=? order by slot', [provider]) : knex().raw('select * from integration_keys order by provider, slot');
  return rows(await q);
}

function publicKey(k) {
  return {
    id: k.id, provider: k.provider, slot: k.slot, role: k.slot === 0 ? 'primary' : 'backup', label: k.label || null, masked: `••••${k.last4 || ''}`,
    account: k.account_username || null, plan: k.plan || null, status: k.disabled ? 'disabled' : k.status, lastError: k.last_error || null,
    usage: k.usage_limit != null || k.usage_used != null ? { usedUsd: money(k.usage_used), limitUsd: k.usage_limit != null ? money(k.usage_limit) : null } : null,
    lastCheckedAt: k.last_checked_at, lastUsedAt: k.last_used_at, updatedAt: k.updated_at, source: 'panel',
  };
}

async function saveProbe(id, p) {
  await knex().raw(`update integration_keys set status=?, last_error=?, account_id=coalesce(?,account_id), account_username=coalesce(?,account_username), plan=coalesce(?,plan),
      usage_used=?, usage_limit=?, last_checked_at=now() where id=?`,
  [p.status, p.ok && p.status === 'ok' ? null : p.detail, p.accountId || null, p.accountUsername || null, p.plan || null, p.usedUsd != null ? p.usedUsd : null, p.limitUsd != null ? p.limitUsd : null, id]);
}

/** Add or replace a key. `slot` = 0 (primary) or 'backup' (next free backup slot). Validates live first. */
async function upsertKey({ provider, slot, label, secret, adminId }) {
  await ensureTables();
  if (!PROVIDERS[provider]) throw new Error('Unknown provider');
  secret = String(secret || '').trim();
  if (secret.length < 10 || /\s/.test(secret)) throw new Error('That does not look like an API key');
  if (provider === 'apify' && !/^apify_api_[A-Za-z0-9]+$/.test(secret)) throw new Error('Apify tokens start with apify_api_');
  const existing = await listKeys(provider);
  const h = hashOf(secret);
  const dup = existing.find((k) => k.secret_hash === h);
  let target;
  if (slot === 'backup') {
    if (provider !== 'apify') throw new Error('Only Apify has backup keys');
    const used = new Set(existing.map((k) => k.slot));
    target = [1, 2, 3, 4, 5, 6, 7].find((s) => !used.has(s));
    if (!target) throw new Error('All 7 backup slots are full. Remove one first.');
  } else {
    target = parseInt(slot, 10);
    if (!(target >= 0 && target < PROVIDERS[provider].maxSlots)) throw new Error('Bad slot');
  }
  if (dup && dup.slot !== target) throw new Error(`This key is already saved (${dup.slot === 0 ? 'primary' : 'backup ' + dup.slot}).`);

  const p = await probe(provider, secret);
  if (!p.ok) { const e = new Error(`Key not saved: ${p.detail}`); e.status = 422; throw e; }

  const enc = encrypt(secret);
  const r = rows(await knex().raw(`insert into integration_keys (provider, slot, label, secret_enc, secret_hash, last4, created_by, updated_by)
      values (?,?,?,?,?,?,?,?)
      on conflict (provider, slot) do update set label=excluded.label, secret_enc=excluded.secret_enc, secret_hash=excluded.secret_hash, last4=excluded.last4,
        updated_by=excluded.updated_by, updated_at=now(), disabled=false, status='unchecked', last_error=null, account_id=null, account_username=null, plan=null, usage_used=null, usage_limit=null
      returning id`, [provider, target, (label || '').slice(0, 60) || null, enc, h, secret.slice(-4), adminId || null, adminId || null]))[0];
  await saveProbe(r.id, p);
  await resolveAlerts(provider, r.id, adminId);
  return { id: r.id, slot: target, probe: p };
}

async function updateKey(id, { label, disabled, makePrimary, adminId }) {
  await ensureTables();
  const k = rows(await knex().raw('select * from integration_keys where id=?', [id]))[0];
  if (!k) throw new Error('Key not found');
  if (label !== undefined) await knex().raw('update integration_keys set label=?, updated_by=?, updated_at=now() where id=?', [String(label || '').slice(0, 60) || null, adminId || null, id]);
  if (disabled !== undefined) await knex().raw('update integration_keys set disabled=?, updated_by=?, updated_at=now() where id=?', [!!disabled, adminId || null, id]);
  if (makePrimary && k.slot !== 0) {
    await knex().transaction(async (trx) => {
      await trx.raw('update integration_keys set slot=-1 where id=?', [id]);
      await trx.raw('update integration_keys set slot=?, updated_at=now() where provider=? and slot=0', [k.slot, k.provider]);
      await trx.raw('update integration_keys set slot=0, disabled=false, updated_by=?, updated_at=now() where id=?', [adminId || null, id]);
    });
  }
  return rows(await knex().raw('select * from integration_keys where id=?', [id]))[0];
}

async function deleteKey(id) {
  await ensureTables();
  const k = rows(await knex().raw('delete from integration_keys where id=? returning provider, slot, last4', [id]))[0];
  if (!k) throw new Error('Key not found');
  return k;
}

async function testKey(id) {
  const k = rows(await knex().raw('select * from integration_keys where id=?', [id]))[0];
  if (!k) throw new Error('Key not found');
  let secret;
  try { secret = decrypt(k.secret_enc); } catch (e) { const p = { ok: false, status: 'error', detail: 'Cannot decrypt (INTEGRATIONS_SECRET_KEY changed?). Re-enter the key.' }; await saveProbe(id, p); return p; }
  const p = await probe(k.provider, secret);
  await saveProbe(id, p);
  if (p.status === 'ok') await resolveAlerts(k.provider, id, null);
  return p;
}

/** Active secret for a single-key provider (ahrefs): panel key, else .env. */
async function secretFor(provider, envName) {
  try {
    const k = (await listKeys(provider)).find((x) => x.slot === 0 && !x.disabled);
    if (k) return { secret: decrypt(k.secret_enc), id: k.id, source: 'panel' };
  } catch (e) { strapi.log.warn(`[INTEGRATIONS] key store unavailable for ${provider}: ${e.message}`); }
  return process.env[envName] ? { secret: process.env[envName], id: null, source: 'env' } : null;
}

/**
 * Apify pool in failover order: primary first, then backups least-recently-used
 * first (never-used keys before anything else). The .env token stands in as
 * primary when no panel primary exists.
 */
async function apifyPool() {
  let keys = [];
  try { keys = await listKeys('apify'); } catch (e) { strapi.log.warn(`[INTEGRATIONS] key store unavailable: ${e.message}`); }
  const pool = [];
  if (!keys.some((k) => k.slot === 0) && process.env.APIFY_TOKEN) pool.push({ id: null, slot: 0, source: 'env', secret: process.env.APIFY_TOKEN, status: 'unchecked', disabled: false, label: 'server .env (APIFY_TOKEN)', lastUsedAt: null });
  keys.forEach((k) => {
    let secret = null;
    try { secret = decrypt(k.secret_enc); } catch (e) { /* unusable */ }
    pool.push({ id: k.id, slot: k.slot, source: 'panel', secret, status: secret ? k.status : 'error', disabled: k.disabled, label: k.label, lastUsedAt: k.last_used_at ? new Date(k.last_used_at).getTime() : null });
  });
  const primary = pool.filter((k) => k.slot === 0);
  const backups = pool.filter((k) => k.slot > 0).sort((a, b) => (a.lastUsedAt == null ? -1 : a.lastUsedAt) - (b.lastUsedAt == null ? -1 : b.lastUsedAt) || a.slot - b.slot);
  return [...primary, ...backups];
}

function keyName(k) { return k.slot === 0 ? `primary key${k.source === 'env' ? ' (.env)' : ''}` : `backup ${k.slot}${k.label ? ` "${k.label}"` : ''}`; }
const isPaid = (plan) => !!plan && String(plan).toUpperCase() !== 'FREE';

/** Move a backup into slot 0. The old panel primary takes the backup's slot; an .env primary is simply shadowed. */
async function promoteKey(id) {
  await knex().transaction(async (trx) => {
    const k = rows(await trx.raw('select slot, provider from integration_keys where id=? for update', [id]))[0];
    if (!k || k.slot === 0) return;
    await trx.raw('update integration_keys set slot=-1 where id=?', [id]);
    await trx.raw('update integration_keys set slot=?, updated_at=now() where provider=? and slot=0', [k.slot, k.provider]);
    await trx.raw('update integration_keys set slot=0, updated_at=now() where id=?', [id]);
  });
}

/**
 * Run `fn(token, maxChargeUsd)` on the first usable Apify key and return its result.
 *   - key rejected (401/403)             → next key (LRU order), alert
 *   - key at budget guard / 402          → switch only to a backup on a PAID Apify plan;
 *                                          free-plan backups are never used to get past
 *                                          a spending limit (Apify terms: one free account
 *                                          per user). No paid backup → pause + alert.
 * A backup that ends up doing the work is promoted to primary.
 */
async function withApify(estCostUsd, fn) {
  const pool = (await apifyPool()).filter((k) => !k.disabled && k.secret && k.status !== 'invalid');
  if (!pool.length) return { ok: false, reason: 'No usable Apify key (all missing, disabled or rejected).' };
  let limitHit = null;
  const skippedFree = [];
  for (const k of pool) {
    const p = await probe('apify', k.secret);
    if (k.id) await saveProbe(k.id, p);
    if (p.status === 'invalid') {
      await raiseAlert('apify', 'key_invalid', k.id, `Apify rejected the ${keyName(k)}. Replace or remove it on the External APIs page.`);
      continue;
    }
    if (!p.ok) return { ok: false, reason: `Apify check failed on the ${keyName(k)}: ${p.detail}` };
    if (limitHit && !isPaid(p.plan)) { skippedFree.push(keyName(k)); continue; }
    const room = p.limitUsd ? p.limitUsd * BUDGET_GUARD - p.usedUsd : Infinity;
    if (room < estCostUsd) {
      if (!limitHit) limitHit = { key: k, p };
      continue;
    }
    const r = await fn(k.secret, Math.min(estCostUsd + 0.01, room));
    if (r.status === 401 || r.status === 403) {
      if (k.id) await saveProbe(k.id, { ok: false, status: 'invalid', detail: `Apify answered ${r.status} during a run.` });
      await raiseAlert('apify', 'key_invalid', k.id, `Apify rejected the ${keyName(k)} during a run.`);
      continue;
    }
    if (r.status === 402) { if (!limitHit) limitHit = { key: k, p }; continue; }
    const name = keyName(k);
    if (k.id) await knex().raw('update integration_keys set last_used_at=now() where id=?', [k.id]);
    if (k.slot !== 0 && k.id) {
      await promoteKey(k.id);
      await raiseAlert('apify', 'failover', k.id, `${name} (account ${p.accountUsername || '?'}, plan ${p.plan || '?'}) is now the primary Apify key because the previous primary was ${limitHit ? 'at its budget limit' : 'rejected'}.`);
    }
    return { ok: true, result: r, keyUsed: name };
  }
  if (limitHit) {
    const { key, p } = limitHit;
    await raiseAlert('apify', 'budget_guard', key.id, `Apify paused: the ${keyName(key)} (account ${p.accountUsername || '?'}) has used $${p.usedUsd} of $${p.limitUsd} this month and no backup on a paid plan is available${skippedFree.length ? ` (${skippedFree.length} free-plan backup${skippedFree.length === 1 ? '' : 's'} not used for limits)` : ''}. Raise the budget, add a paid key, or make a key primary manually.`);
    return { ok: false, guarded: true, reason: `Budget guard: $${p.usedUsd} of $${p.limitUsd} used on the ${keyName(key)}; no paid backup to switch to. Apify paused, alert raised.` };
  }
  return { ok: false, reason: 'Every Apify key was rejected. Alert raised.' };
}

// ───────────────────────── alerts ─────────────────────────
async function raiseAlert(provider, kind, keyId, message) {
  try {
    await ensureTables();
    const open = rows(await knex().raw('select id from integration_alerts where provider=? and kind=? and coalesce(key_id,0)=? and resolved_at is null', [provider, kind, keyId || 0]))[0];
    if (open) { await knex().raw('update integration_alerts set message=? where id=?', [message, open.id]); return; }
    const a = rows(await knex().raw('insert into integration_alerts (provider, kind, key_id, message) values (?,?,?,?) returning id', [provider, kind, keyId || null, message]))[0];
    strapi.log.warn(`[INTEGRATIONS ALERT] ${provider}/${kind}: ${message}`);
    emailAlert(a.id, message).catch(() => {});
  } catch (e) { strapi.log.warn(`[INTEGRATIONS] alert write failed: ${e.message}`); }
}

async function emailAlert(alertId, message) {
  const recent = rows(await knex().raw(`select 1 from integration_alerts where emailed_at > now() - interval '${ALERT_EMAIL_EVERY_H} hours' limit 1`))[0];
  if (recent) return;
  const to = rows(await knex().raw(`select u.email from up_users u join up_users_role_lnk l on l.user_id=u.id join up_roles r on r.id=l.role_id where r.type='super_admin' and u.email is not null and not coalesce(u.blocked,false)`)).map((r) => r.email);
  if (!to.length) return;
  await strapi.service('api::admin-email.admin-email').sendAdminEmail({
    to, subject: 'Serpbays integration alert',
    bodyHtml: `<p>${String(message).replace(/[<>&]/g, '')}</p><p>Open <a href="https://prod-panel20.serpbays.com/integrations">External APIs &amp; MCP</a> to fix it.</p>`,
  });
  await knex().raw('update integration_alerts set emailed_at=now() where id=?', [alertId]);
}

async function openAlerts() {
  await ensureTables();
  return rows(await knex().raw('select id, provider, kind, key_id, message, created_at, emailed_at from integration_alerts where resolved_at is null order by created_at desc limit 20'));
}

async function resolveAlerts(provider, keyId, adminId, alertId) {
  await ensureTables();
  if (alertId) return knex().raw('update integration_alerts set resolved_at=now(), resolved_by=? where id=? and resolved_at is null', [adminId || null, alertId]);
  return knex().raw('update integration_alerts set resolved_at=now(), resolved_by=? where provider=? and (key_id=? or key_id is null) and resolved_at is null', [adminId || null, provider, keyId || 0]);
}

// ───────────────────────── DR cache ─────────────────────────
async function cacheGet(domains) {
  await ensureTables();
  if (!domains.length) return {};
  const r = rows(await knex().raw(`select domain, dr, provider, fetched_at from integration_dr_cache where domain = any(?) and fetched_at > now() - interval '${CACHE_DAYS} days'`, [domains]));
  const out = {};
  r.forEach((x) => { out[x.domain] = { dr: n(x.dr), provider: x.provider, fetchedAt: x.fetched_at }; });
  return out;
}

async function cachePut(values, provider) {
  await ensureTables();
  const entries = Object.entries(values);
  for (let i = 0; i < entries.length; i += 500) {
    const chunk = entries.slice(i, i + 500);
    await knex().raw(`insert into integration_dr_cache (domain, dr, provider, fetched_at) values ${chunk.map(() => '(?,?,?,now())').join(',')}
        on conflict (domain) do update set dr=excluded.dr, provider=excluded.provider, fetched_at=now()`, chunk.flatMap(([d, v]) => [d, v, provider]));
  }
}

module.exports = {
  PROVIDERS, BUDGET_GUARD, CACHE_DAYS, mask,
  ensureTables, probe, listKeys, publicKey, upsertKey, updateKey, deleteKey, testKey,
  secretFor, apifyPool, withApify, raiseAlert, openAlerts, resolveAlerts, cacheGet, cachePut,
};
