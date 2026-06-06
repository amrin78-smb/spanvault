'use strict';

// Shared HTTP helper for wireless controller REST API clients.
//
// TLS NOTE / LIMITATION:
//   Wireless controllers frequently use self-signed certificates. Node 20's
//   native global `fetch` (powered by undici) does NOT expose a simple
//   per-request way to disable TLS verification. Setting
//   `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` globally is explicitly
//   NOT done here because it would weaken TLS for the entire process.
//   In production, the correct fix is to pass a custom undici `Agent`/
//   `dispatcher` with `connect: { rejectUnauthorized: false }` (or a pinned
//   CA) into the fetch options. For now we attempt the fetch normally and
//   let any TLS error surface as a thrown Error to the caller.

const DEFAULT_TIMEOUT_MS = 15000;

// httpFetch: fetch + AbortController timeout + res.ok check.
// Returns the raw Response. Throws a short Error on network/timeout/non-2xx.
async function httpFetch(url, options, timeoutMs) {
  const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  let res;
  try {
    res = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('request timed out after ' + ms + 'ms');
    }
    throw new Error('request failed: ' + (err && err.message ? err.message : String(err)));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' from controller');
  }
  return res;
}

// httpJson: like httpFetch but parses and returns JSON.
// Throws a short Error on bad JSON.
async function httpJson(url, options, timeoutMs) {
  const res = await httpFetch(url, options, timeoutMs);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error('invalid JSON response from controller');
  }
  return body;
}

module.exports = { httpFetch, httpJson, DEFAULT_TIMEOUT_MS };
