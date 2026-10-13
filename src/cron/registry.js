'use strict';

/**
 * Remembers when each cron task last ran, how long it took and whether it
 * failed (2026-10-13), for the admin System health page. In memory: resets
 * on restart. Task behaviour is unchanged (errors are re-thrown).
 */
const runs = {};

function wrap(tasks) {
  const out = {};
  for (const [key, def] of Object.entries(tasks)) {
    const isObj = def && typeof def === 'object' && typeof def.task === 'function';
    const fn = isObj ? def.task : def;
    if (typeof fn !== 'function') { out[key] = def; continue; }
    const name = isObj ? key : `cron:${key}`;
    const rule = isObj ? (def.options && def.options.rule) || def.options : key;
    runs[name] = runs[name] || { name, rule: String(rule || ''), runs: 0, failures: 0 };
    const wrapped = async (...args) => {
      const r = runs[name];
      r.lastStart = new Date().toISOString();
      const t0 = Date.now();
      try {
        const v = await fn(...args);
        r.lastOk = new Date().toISOString();
        r.lastError = null;
        return v;
      } catch (e) {
        r.failures += 1;
        r.lastError = String((e && e.message) || e).slice(0, 300);
        r.lastErrorAt = new Date().toISOString();
        throw e;
      } finally {
        r.runs += 1;
        r.lastMs = Date.now() - t0;
      }
    };
    out[key] = isObj ? { ...def, task: wrapped } : wrapped;
  }
  return out;
}

module.exports = { wrap, runs };
