'use strict';

let cachedLicense = null;
let lastChecked   = null;
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 hours

async function fetchLicense() {
  const hubUrl = process.env.NOCVAULT_HUB_URL || process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${hubUrl}/api/license`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // never block on network failure
  }
}

async function getLicense(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedLicense && lastChecked && (now - lastChecked) < CACHE_TTL) {
    return cachedLicense;
  }
  const license = await fetchLicense();
  if (license) {
    cachedLicense = license;
    lastChecked   = now;
  }
  return cachedLicense;
}

function getLicenseState(license) {
  if (!license) return { mode: 'unreachable', canWrite: true, canRead: true, disabled: false };
  const { status, daysRemaining } = license;
  if (status === 'active' || status === 'trial') {
    return { mode: status, canWrite: true, canRead: true, disabled: false };
  }
  if (status === 'expired' || status === 'grace') {
    const inGrace = daysRemaining > -30;
    if (inGrace) return { mode: 'grace', canWrite: false, canRead: true, disabled: false };
    return { mode: 'disabled', canWrite: false, canRead: false, disabled: true };
  }
  return { mode: 'unknown', canWrite: true, canRead: true, disabled: false };
}

module.exports = { getLicense, getLicenseState, fetchLicense };
