'use strict';
const fs = require('fs');
const path = require('path');

const ROTATE_BYTES = 5 * 1024 * 1024;

/**
 * Append-only JSON-lines audit log + a small in-memory tail for the UI.
 * Records who did what to which resource, from where, and whether it worked.
 */
function createAudit({ file, keep = 200, logger = console }) {
  let recent = [];
  let warned = false;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
    if (fs.existsSync(file)) {
      recent = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-keep)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    }
  } catch (e) {
    logger.error(`[audit] cannot prepare ${file}: ${e.message}`);
  }

  function record({ actor, ip, action, target, ok, detail }) {
    const entry = { ts: new Date().toISOString(), actor, ip, action, target: target ?? null, ok: !!ok, detail: detail ?? null };
    recent.push(entry);
    if (recent.length > keep) recent = recent.slice(-keep);
    // Synchronous on purpose: concurrent fs.appendFile calls can complete out of order, which would
    // corrupt the sequence of an audit trail. Volume is tiny (admin actions only), so blocking is fine.
    try {
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      if (!warned) { warned = true; logger.error(`[audit] cannot write ${file}: ${err.message}`); }
    }
    return entry;
  }

  return { record, recent: (n = 100) => recent.slice(-n).reverse() };
}

module.exports = { createAudit };
