'use strict';

/**
 * Counts failures per key inside a sliding window. Old entries are swept
 * periodically so the map cannot grow without bound.
 */
class FailureLimiter {
  constructor({ max, windowMs, now = Date.now }) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
    this.timer = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    this.timer.unref();
  }

  _recent(key) {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (recent.length) this.hits.set(key, recent); else this.hits.delete(key);
    return recent;
  }

  /** Milliseconds until the key may try again, or 0 if it isn't blocked. */
  retryAfterMs(key) {
    const recent = this._recent(key);
    if (recent.length < this.max) return 0;
    return Math.max(1, recent[0] + this.windowMs - this.now());
  }

  fail(key) {
    const recent = this._recent(key);
    recent.push(this.now());
    this.hits.set(key, recent);
  }

  reset(key) { this.hits.delete(key); }
  sweep() { for (const key of [...this.hits.keys()]) this._recent(key); }
  stop() { clearInterval(this.timer); }
}

module.exports = { FailureLimiter };
