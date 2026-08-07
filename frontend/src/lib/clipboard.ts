// Clipboard copy that works on THIS deployment.
//
// `navigator.clipboard` only exists in a *secure context* — HTTPS or localhost.
// The NocVault suite is served over plain HTTP on a LAN IP, so on the live
// server it is `undefined` (verified 2026-08-06: isSecureContext=false,
// navigator.clipboard=undefined, document.execCommand present).
//
// That makes both of the obvious spellings wrong here:
//   navigator.clipboard.writeText(x)   -> TypeError, reading 'writeText' of undefined
//   navigator.clipboard?.writeText(x)  -> silently does nothing, and any `.then()`
//                                         chained onto it never runs
// A `.catch()` does not save the first form either: the TypeError is thrown
// synchronously while reading the property, before any promise exists.
//
// `document.execCommand('copy')` is deprecated but is the only thing that works
// without HTTPS, so it stays as the fallback until the suite is served over TLS.
export function copyText(text: string): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      // Fire-and-forget: the caller gets its answer synchronously, and the
      // fallback below is unreachable once the real API is available.
      void navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
