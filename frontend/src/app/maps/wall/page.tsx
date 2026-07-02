'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import SVGMapView, { LIVE_REFRESH_MS } from '@/components/SVGMapView';
import { normalizeMap, type FullMap, type MapSummary } from '@/lib/mapTypes';

const INTERVALS = [10, 15, 30, 60];
const DEFAULT_INTERVAL = 15;

// Aggregate device rollup from /api/dashboard/summary (same source as TopBar /
// AlertBanner). Only the fields the band renders are typed here.
type DashSummary = {
  total: number; up: number; down: number; warning: number; unknown: number; active_alerts: number;
};

// HH:MM:SS wall clock from an epoch-ms tick (helper at module scope — no nested
// component/function definitions per CLAUDE.md).
function fmtClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Control bar (top-level component — no nested definitions per CLAUDE.md) ──
function WallControls(props: {
  name: string;
  index: number;
  total: number;
  playing: boolean;
  interval: number;
  countdown: number;
  canRotate: boolean;
  onTogglePlay: () => void;
  onPrev: () => void;
  onNext: () => void;
  onInterval: (n: number) => void;
  onFullscreen: () => void;
}) {
  const btn: React.CSSProperties = {
    background: '#1e293b',
    color: '#e2e8f0',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '6px 12px',
    fontSize: 'var(--text-base)',
    cursor: 'pointer',
    lineHeight: 1.2,
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        background: '#0b1220',
        borderTop: '1px solid #1e293b',
        color: '#e2e8f0',
        fontSize: 'var(--text-base)',
        flexWrap: 'wrap',
      }}
    >
      <button style={btn} onClick={props.onPrev} disabled={!props.canRotate} title="Previous map">
        ‹ Prev
      </button>
      <button
        style={{ ...btn, background: props.playing ? '#C8102E' : '#1e293b' }}
        onClick={props.onTogglePlay}
        disabled={!props.canRotate}
        title={props.playing ? 'Pause rotation' : 'Play rotation'}
      >
        {props.playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <button style={btn} onClick={props.onNext} disabled={!props.canRotate} title="Next map">
        Next ›
      </button>

      <span style={{ marginLeft: 8, fontWeight: 600 }}>
        {props.name || '—'}
        <span style={{ color: '#64748b', fontWeight: 400 }}>
          {' '}
          · {props.total ? props.index + 1 : 0}/{props.total}
        </span>
      </span>

      {props.playing && props.canRotate ? (
        <span style={{ color: '#64748b', marginLeft: 6 }}>next in {props.countdown}s</span>
      ) : null}

      <span style={{ flex: 1 }} />

      <label style={{ color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
        Interval
        <select
          value={props.interval}
          onChange={(e) => props.onInterval(Number(e.target.value))}
          style={{ ...btn, padding: '5px 8px' }}
        >
          {INTERVALS.map((n) => (
            <option key={n} value={n}>
              {n}s
            </option>
          ))}
        </select>
      </label>

      <button style={btn} onClick={props.onFullscreen} title="Toggle fullscreen">
        ⛶ Fullscreen
      </button>
    </div>
  );
}

export default function MapWallPage() {
  const list = useApi<MapSummary[]>('/api/maps', 60000);
  const maps = useMemo(() => list.data || [], [list.data]);

  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [interval, setIntervalSecs] = useState(DEFAULT_INTERVAL);
  const [countdown, setCountdown] = useState(DEFAULT_INTERVAL);

  // Keep index valid as the list changes.
  useEffect(() => {
    if (maps.length === 0) {
      if (index !== 0) setIndex(0);
    } else if (index >= maps.length) {
      setIndex(0);
    }
  }, [maps.length, index]);

  const canRotate = maps.length >= 2;
  const indexRef = useRef(index);
  indexRef.current = index;

  // Rotation + countdown tick (1s). Resets countdown on map/interval change.
  useEffect(() => {
    setCountdown(interval);
    if (!playing || !canRotate) return;
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          setIndex((i) => (i + 1) % maps.length);
          return interval;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
    // `index` intentionally omitted: the tick advances via the functional setIndex
    // updater, so including it would tear down/rebuild the timer on every rotation.
  }, [playing, canRotate, interval, maps.length]);

  const currentId = maps.length ? maps[Math.min(index, maps.length - 1)].id : null;
  const map = useApi<FullMap>(currentId != null ? `/api/maps/${currentId}` : null, 0);

  // ── Live-data staleness (NOC safety) ──────────────────────────────
  // SVGMapView keeps the last-known node colours when its poll fails, so a
  // wallboard can silently show all-green STALE data during an outage. Track
  // the last successful update and consecutive poll failures, and drive the
  // header dot from green → amber → red so operators are warned.
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);
  const [fails, setFails] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // Tick every second so the "Stale 45s" label counts up live even when the
  // rotation timer is paused or there is only a single map.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // A fresh map fetch (initial load or rotation) is itself a successful update.
  useEffect(() => {
    if (map.data) { setLastOkAt(Date.now()); setFails(0); }
  }, [map.data]);

  const onLiveRefresh = useCallback((ok: boolean) => {
    if (ok) { setLastOkAt(Date.now()); setFails(0); }
    else { setFails((f) => f + 1); }
  }, []);

  // Stale after ~2x the live poll cadence (or 2 consecutive failures); dead
  // after ~4x (or 4 failures). Fresh keeps the pulsing green "Live" dot.
  const sinceOkMs = lastOkAt == null ? null : now - lastOkAt;
  const staleSecs = sinceOkMs == null ? 0 : Math.round(sinceOkMs / 1000);
  const timeStale = sinceOkMs != null && sinceOkMs > 2 * LIVE_REFRESH_MS;
  const timeDead = sinceOkMs != null && sinceOkMs > 4 * LIVE_REFRESH_MS;
  const liveLevel: 'live' | 'stale' | 'dead' =
    timeDead || fails >= 4 ? 'dead' : timeStale || fails >= 2 ? 'stale' : 'live';
  const liveDotColor =
    liveLevel === 'dead' ? 'var(--red)' : liveLevel === 'stale' ? 'var(--yellow)' : 'var(--green)';
  const liveLabel =
    liveLevel === 'dead' ? 'No live data — check collector'
      : liveLevel === 'stale' ? `Stale data · ${staleSecs}s since update`
        : 'Live status · auto-refreshing';

  const handleFullscreen = () => {
    const doc = document as any;
    if (doc.fullscreenElement) {
      if (typeof document.exitFullscreen === 'function') document.exitFullscreen();
    } else {
      const el = document.documentElement as any;
      if (typeof el.requestFullscreen === 'function') el.requestFullscreen();
    }
  };

  const goPrev = () => {
    if (!maps.length) return;
    setIndex((i) => (i - 1 + maps.length) % maps.length);
  };
  const goNext = () => {
    if (!maps.length) return;
    setIndex((i) => (i + 1) % maps.length);
  };

  const currentName = map.data?.name || (currentId != null ? maps[index]?.name : '') || '';

  // ── Aggregate health band (room-readable rollup + live clock) ──────
  const summaryApi = useApi<DashSummary>('/api/dashboard/summary', 20000);
  const summary = summaryApi.data;
  const downCount = summary?.down ?? 0;
  const warnCount = summary?.warning ?? 0;
  const upCount = summary?.up ?? 0;
  const clock = fmtClock(now); // reuse the existing 1s `now` tick — no extra timer

  return (
    <div className="sv-public-map" style={{ background: '#0b1220' }}>
      <header className="sv-public-head">
        <div className="brand">
          <span className="logo">SpanVault</span>
          <span className="sep">·</span>
          <span className="ttl">NOC Wallboard</span>
        </div>
        <div className="refresh" title={liveLabel}>
          <span
            className="dot"
            style={{
              background: liveDotColor,
              // Only the healthy state pulses; stale/dead show a solid warning dot.
              animation: liveLevel === 'live' ? undefined : 'none',
              boxShadow: liveLevel === 'live' ? undefined : 'none',
            }}
          />{' '}
          {liveLabel}
        </div>
      </header>

      {/* Aggregate health band — large, high-contrast, readable across a NOC. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 32,
          padding: '14px 24px',
          flex: 'none',
          background: downCount > 0 ? 'rgba(239,68,68,0.14)' : '#0b1220',
          borderBottom: downCount > 0 ? '2px solid var(--red)' : '1px solid #1e293b',
        }}
      >
        <div style={bandStat}>
          <span style={{ ...bandNum, color: 'var(--red)' }}>{downCount}</span>
          <span style={bandLabel}>Down</span>
        </div>
        <div style={bandStat}>
          <span style={{ ...bandNum, color: 'var(--yellow)' }}>{warnCount}</span>
          <span style={bandLabel}>Warning</span>
        </div>
        <div style={bandStat}>
          <span style={{ ...bandNum, color: 'var(--green)' }}>{upCount}</span>
          <span style={bandLabel}>Up</span>
        </div>
        <span style={{ flex: 1 }} />
        <div
          style={{
            fontSize: 44,
            fontWeight: 800,
            color: '#e2e8f0',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: 1,
          }}
        >
          {clock}
        </div>
      </div>

      <div className="sv-public-canvas">
        {list.loading && !list.data ? (
          <div style={centerMsg}>Loading…</div>
        ) : maps.length === 0 ? (
          <div style={centerMsg}>
            <div style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>No network maps yet</div>
            <div style={{ color: '#64748b', marginTop: 8 }}>
              Create a map in the Network Map designer to display it here.
            </div>
          </div>
        ) : map.loading && !map.data ? (
          <div style={centerMsg}>Loading…</div>
        ) : map.data ? (
          <SVGMapView map={normalizeMap(map.data)} refreshUrl={`/api/maps/${currentId}`} onRefresh={onLiveRefresh} />
        ) : (
          <div style={centerMsg}>Map unavailable.</div>
        )}
      </div>

      <WallControls
        name={currentName}
        index={Math.min(index, Math.max(0, maps.length - 1))}
        total={maps.length}
        playing={playing}
        interval={interval}
        countdown={countdown}
        canRotate={canRotate}
        onTogglePlay={() => setPlaying((p) => !p)}
        onPrev={goPrev}
        onNext={goNext}
        onInterval={(n) => setIntervalSecs(n)}
        onFullscreen={handleFullscreen}
      />

      <footer className="sv-public-foot">powered by SpanVault NMS</footer>
    </div>
  );
}

// Health-band cell + typography (module scope — shared, no per-render objects
// beyond the status-tinted number colour). Display sizes are intentional.
const bandStat: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  lineHeight: 1,
};
const bandNum: React.CSSProperties = {
  fontSize: 56,
  fontWeight: 800,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
};
const bandLabel: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#94a3b8',
  marginTop: 4,
};

const centerMsg: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  textAlign: 'center',
  color: '#e2e8f0',
};
