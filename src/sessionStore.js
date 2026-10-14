'use strict';

/**
 * In-memory session store that actually expires entries (express-session's
 * built-in MemoryStore never evicts them). Sessions are lost on restart,
 * which for a single-admin dashboard just means signing in again.
 *
 * Takes the `express-session` module so it can extend session.Store.
 */
module.exports = function createSessionStore(session, { ttlMs }) {
  const expiryOf = (sess) => {
    const exp = sess && sess.cookie && sess.cookie.expires;
    return exp ? new Date(exp).getTime() : Date.now() + ttlMs;
  };

  class ExpiringStore extends session.Store {
    constructor() {
      super();
      this.map = new Map();
      this.timer = setInterval(() => this.sweep(), 60_000);
      this.timer.unref();
    }
    get(sid, cb) {
      const entry = this.map.get(sid);
      if (!entry) return cb(null, null);
      if (entry.exp <= Date.now()) { this.map.delete(sid); return cb(null, null); }
      return cb(null, JSON.parse(entry.data));
    }
    set(sid, sess, cb) {
      this.map.set(sid, { data: JSON.stringify(sess), exp: expiryOf(sess) });
      if (cb) cb(null);
    }
    touch(sid, sess, cb) {
      const entry = this.map.get(sid);
      if (entry) entry.exp = expiryOf(sess);
      if (cb) cb(null);
    }
    destroy(sid, cb) {
      this.map.delete(sid);
      if (cb) cb(null);
    }
    sweep() {
      const now = Date.now();
      for (const [sid, e] of this.map) if (e.exp <= now) this.map.delete(sid);
    }
  }
  return new ExpiringStore();
};
