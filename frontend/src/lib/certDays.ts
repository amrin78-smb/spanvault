/**
 * Whole days until a certificate expires.
 *
 * ONE implementation, because there were two and they disagreed on screen:
 * the Services list floored and the service detail page ceiled, so the same
 * certificate read "64 days" on one page and "65 days" one click later. Floor
 * is the right half of that pair — it matches what the collector stores in
 * `cert_days_left`, and the expiry tone thresholds (<=14 danger, <=60
 * expiring) are tuned against it.
 *
 * Computed from the stored expiry at RENDER time rather than read from
 * `cert_days_left`: the stored count is only correct on the day it was
 * written, whereas the date stays correct. `cert_days_left` is the fallback
 * for a row that has a count but no date.
 */
export function certDaysLeft(
  validTo: string | null | undefined,
  storedDaysLeft?: number | null,
): number | null {
  if (validTo) {
    const t = new Date(validTo).getTime();
    if (isFinite(t)) return Math.floor((t - Date.now()) / 86400000);
  }
  return storedDaysLeft ?? null;
}
