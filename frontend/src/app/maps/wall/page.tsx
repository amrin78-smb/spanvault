'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import SVGMapView from '@/components/SVGMapView';
import { normalizeMap, type FullMap, type MapSummary } from '@/lib/mapTypes';

const INTERVALS = [10, 15, 30, 60];
const DEFAULT_INTERVAL = 15;

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
    fontSize: 13,
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
        fontSize: 13,
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

  return (
    <div className="sv-public-map" style={{ background: '#0b1220' }}>
      <header className="sv-public-head">
        <div className="brand">
          <span className="logo">SpanVault</span>
          <span className="sep">·</span>
          <span className="ttl">NOC Wallboard</span>
        </div>
        <div className="refresh">
          <span className="dot" /> Live status · auto-refreshing
        </div>
      </header>

      <div className="sv-public-canvas">
        {list.loading && !list.data ? (
          <div style={centerMsg}>Loading…</div>
        ) : maps.length === 0 ? (
          <div style={centerMsg}>
            <div style={{ fontSize: 22, fontWeight: 600 }}>No network maps yet</div>
            <div style={{ color: '#64748b', marginTop: 8 }}>
              Create a map in the Network Map designer to display it here.
            </div>
          </div>
        ) : map.loading && !map.data ? (
          <div style={centerMsg}>Loading…</div>
        ) : map.data ? (
          <SVGMapView map={normalizeMap(map.data)} refreshUrl={`/api/maps/${currentId}`} />
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

const centerMsg: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  textAlign: 'center',
  color: '#e2e8f0',
};
