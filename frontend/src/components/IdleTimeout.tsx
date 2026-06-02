'use client';

import { useEffect, useRef, useState } from 'react';
import { signOut } from 'next-auth/react';

// Hub URL — client-side reads NEXT_PUBLIC_*, falling back to the server var name
// (undefined in the browser) and finally localhost for local dev.
const HUB =
  process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL ||
  process.env.NOCVAULT_HUB_URL ||
  'http://localhost:3000';

const DEFAULT_TIMEOUT_MINUTES = 15;   // used when the hub doesn't specify one
const WARNING_SECONDS = 60;           // lead time the warning modal is shown for
const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click'] as const;

// The hub's /api/settings shape isn't versioned here, so accept any of the
// likely key names NetVault may use for the idle timeout (in minutes).
const SETTING_KEYS = [
  'idle_timeout_minutes', 'session_timeout_minutes', 'inactivity_timeout_minutes',
  'idle_timeout', 'session_timeout', 'timeout_minutes',
];

// Resolve the idle timeout (ms) from a settings object.
//   - a positive value → that many minutes
//   - an explicit 0 / negative → disabled (null)
//   - no recognised key → default
function resolveTimeoutMs(settings: any): number | null {
  if (settings && typeof settings === 'object') {
    for (const k of SETTING_KEYS) {
      const raw = settings[k];
      if (raw !== undefined && raw !== null && raw !== '') {
        const n = Number(raw);
        if (!isNaN(n)) return n > 0 ? n * 60000 : null;
      }
    }
  }
  return DEFAULT_TIMEOUT_MINUTES * 60000;
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
        const data = res.ok ? await res.json() : null;
        if (!cancelled) setTimeoutMs(resolveTimeoutMs(data));
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
