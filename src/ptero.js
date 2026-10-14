'use strict';
const { HttpError } = require('./errors');

/**
 * Translate a panel error into one of OUR errors. Important: we never forward
 * the panel's 401/403 as-is, because the browser treats 401 as "your admin
 * session expired". A rejected API key is a server-side problem -> 502.
 */
function toHttpError(status, data) {
  const detail = data && data.errors && data.errors[0] && data.errors[0].detail;
  switch (status) {
    case 400:
    case 422: return new HttpError(400, detail || 'The panel rejected this request.');
    case 401:
    case 403: return new HttpError(502, 'The panel rejected the API key. Check its permissions in Admin > Application API.');
    case 404: return new HttpError(404, 'Not found on the panel (it may already have been removed).');
    case 429: return new HttpError(429, 'The panel is rate limiting requests. Try again shortly.');
    default: return new HttpError(502, `The panel returned an error (HTTP ${status}).`);
  }
}

function normalizePagination(p = {}) {
  return {
    total: p.total ?? 0,
    page: p.current_page ?? 1,
    perPage: p.per_page ?? 0,
    totalPages: Math.max(1, p.total_pages ?? 1),
  };
}

/** Pterodactyl Application API client. The API key never leaves the server. */
function createPtero({ baseUrl, apiKey, timeoutMs = 10_000, fetchImpl = globalThis.fetch }) {
  async function request(method, endpoint, body) {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.pterodactyl.v1+json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/application${endpoint}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new HttpError(timedOut ? 504 : 502, timedOut ? 'The panel API timed out.' : 'Could not reach the panel API.');
    }

    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw toHttpError(res.status, data);
    return data;
  }

  /** GET a paginated collection and return raw attribute objects + pagination. */
  async function list(resource, { page = 1, perPage = 25, q = '', filter, include } = {}) {
    const qs = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (include) qs.set('include', include);
    if (q && filter) qs.set(`filter[${filter}]`, q);
    const d = await request('GET', `/${resource}?${qs}`);
    return {
      items: ((d && d.data) || []).map((x) => x.attributes),
      pagination: normalizePagination(d && d.meta && d.meta.pagination),
    };
  }

  /** GET one resource and return its attributes. */
  async function get(resource, id) {
    const d = await request('GET', `/${resource}/${id}`);
    return d && d.attributes;
  }

  return { request, list, get };
}

module.exports = { createPtero, normalizePagination };
