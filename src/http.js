'use strict';

/** Wrap an async route handler so rejected promises reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const noStore = (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

module.exports = { asyncHandler, noStore };
