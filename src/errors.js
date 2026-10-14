'use strict';

/** An error whose message is safe to show to the (authenticated) admin. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true;
  }
}

module.exports = { HttpError };
