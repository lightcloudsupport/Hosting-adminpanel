'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KEYLEN = 64;
const MAX_LEN = 256; // cap input so a huge "password" can't be used to burn CPU/memory

/** Returns "scrypt:<salt>:<hash>" (base64url). */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN);
  return `scrypt:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

async function verifyPassword(stored, password) {
  const [scheme, saltB64, keyB64] = String(stored).split(':');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  if (typeof password !== 'string' || password.length > MAX_LEN) return false;
  const expected = Buffer.from(keyB64, 'base64url');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** Constant-time string comparison (hashes first so lengths don't leak). */
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = { hashPassword, verifyPassword, safeEqual, MAX_LEN };
