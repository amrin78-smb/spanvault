'use client';

import { useEffect, useRef, useState } from 'react';
import { signOut } from 'next-auth/react';

// Hub URL — client-side reads NEXT_PUBLIC_*, falling back to the server var name
// (undefined in the browser) and finally localhost for local dev.
const HUB =
  process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL ||
  process.env.NOCVAULT_HUB_URL ||
  'http://localhost:3000';

const DEFAULT_TIMEOUT_MINUTES = 15;   // used only when the fetch fails
const WARNING_SECONDS = 60;           // lead time the warning modal is shown for
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click'] as const;

// Resolve the idle timeout (ms) from the hub's idle_timeout_minutes value.
// The endpoint returns either a number (minutes) or the string 'never'.
//   - 'never' / 0 / negative / unparseable → disabled (null)
//   - a positive number → that many minutes
function resolveTimeoutMs(value: any): number | null {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'never') return null;
  const n = Number(value);
  if (isNaN(n) || n <= 0) return null;
  return n * 60000;
}

export default function IdleTimeout() {
  // undefined = still loading, null = disabled, number = idle window in ms
  const [timeoutMs, setTimeoutMs] = useState<number | null | undefined>(undefined);
  const [showWarning, setShowWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(WARNING_SECONDS);

  // Lets the modal button reset the idle timer from outside the timer effect.
  const armRef = useRef<() => void>(() => {});

  // ── Fetch the configured timeout from the NocVault hub (once) ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${HUB}/api/settings`, {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // /api/settings returns the full settings object; the idle timeout is a
        // string value under idle_timeout_minutes (e.g. "30" or "never").
        const settings = await res.json();
        if (!cancelled) setTimeoutMs(resolveTimeoutMs(settings?.idle_timeout_minutes));
      } catch {
        if (!cancelled) setTimeoutMs(DEFAULT_TIMEOUT_MINUTES * 60000);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Arm timers + activity listeners once the timeout is known ──
  useEffect(() => {
    if (!timeoutMs) return; // undefined (loading) or null (disabled) → nothing to do

    let warnTimer: ReturnType<typeof setTimeout> | null = null;
    let logoutTimer: ReturnType<typeof setTimeout> | null = null;
    let countdown: ReturnType<typeof setInterval> | null = null;
    let warningActive = false;

    const clearAll = () => {
      if (warnTimer) clearTimeout(warnTimer);
      if (logoutTimer) clearTimeout(logoutTimer);
      if (countdown) clearInterval(countdown);
      warnTimer = logoutTimer = countdown = null;
    };

    const doLogout = () => {
      clearAll();
      signOut({ callbackUrl: `${HUB}/login?reason=timeout` });
    };

    const startWarning = () => {
      warningActive = true;
      setShowWarning(true);
      setSecondsLeft(WARNING_SECONDS);
      let remaining = WARNING_SECONDS;
      countdown = setInterval(() => {
        remaining -= 1;
        setSecondsLeft(remaining > 0 ? remaining : 0);
      }, 1000);
      logoutTimer = setTimeout(doLogout, WARNING_SECONDS * 1000);
    };

    // Push the warning back to the full idle window (no state churn).
    const scheduleWarn = () => {
      if (warnTimer) clearTimeout(warnTimer);
      warnTimer = setTimeout(startWarning, Math.max(0, timeoutMs - WARNING_SECONDS * 1000));
    };

    // Full reset — initial setup and the "Stay logged in" button.
    const arm = () => {
      clearAll();
      warningActive = false;
      setShowWarning(false);
      scheduleWarn();
    };
    armRef.current = arm;

    // While the warning is up, only the explicit button keeps the session.
    const onActivity = () => {
      if (warningActive) return;
      scheduleWarn();
    };

    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    arm();

    return () => {
      clearAll();
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
    };
  }, [timeoutMs]);

  if (!showWarning) return null;
  return <IdleWarningModal secondsLeft={secondsLeft} onStay={() => armRef.current()} />;
}

// ── Warning modal (top-level component — never nested) ─────────
function IdleWarningModal({
  secondsLeft, onStay,
}: {
  secondsLeft: number;
  onStay: () => void;
}) {
  return (
    <div className="sv-modal-backdrop" style={{ zIndex: 1000 }}>
      <div className="sv-modal" style={{ maxWidth: 420, textAlign: 'center' }}>
        <h2>Session expiring</h2>
        <p style={{ fontSize: 15, margin: '8px 0 20px' }}>
          You will be logged out in {secondsLeft} second{secondsLeft === 1 ? '' : 's'}.
        </p>
        <div className="sv-modal-actions" style={{ justifyContent: 'center' }}>
          <button className="sv-btn" onClick={onStay}>Stay logged in</button>
        </div>
      </div>
    </div>
  );
}
