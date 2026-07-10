'use client';

import type { CSSProperties } from 'react';
import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { useApi } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { StatusBadge, Loading, ErrorBox, Empty, fmtTime, fmtRel, CHART_TOOLTIP } from '@/components/ui';

// ── Types ──────────────────────────────────────────────────────
type ServiceType = 'http' | 'tcp' | 'ssl' | 'dns';

type ServiceDetail = {
  id: number;
  name: string;
  type: ServiceType;
  target: string;
  site_id: number | null;
  site_name: string | null;
  group_id: string | null;
  agent_id: number | null;
  agent_name: string | null;
  interval_seconds: number;
  params: Record<string, any> | null;
  current_status: string;
  last_response_ms: number | null;
  last_detail: string | null;
  last_checked_at: string | null;
  active: boolean;
};

type ResultRow = { ts: string; status: string; response_ms: number | null; detail: string | null };
type ResultsResponse = { rows: ResultRow[]; uptime_pct: number | null; total: number };

const RANGES = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
];

const HISTORY_LIMIT = 50;

function dotStatus(s: string): string {
  const v = (s || 'unknown').toLowerCase();
  if (v === 'up' || v === 'down' || v === 'warning') return v;
  return 'unknown';
}

function typeLabel(t: string): string {
  return (t || '').toUpperCase();
}

// ── Layout style constants ──────────────────────────────────────
const SECTION_CARD: CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '16px 20px', marginBottom: 16,
};
const SECTION_HEADING: CSSProperties = {
  fontSize: 'var(--text-sm)', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)',
  letterSpacing: '0.06em', margin: '0 0 8px',
};
const STAT_GRID: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16,
};
const STAT_VALUE: CSSProperties = { fontSize: 'var(--text-2xl)', fontWeight: 800, lineHeight: 1.1, letterSpacing: '-0.5px' };
const STAT_LABEL: CSSProperties = {
  fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textTransform: 'uppercase',
  letterSpacing: '0.04em', marginTop: 6,
};
const STATUS_COLORS: Record<string, string> = {
  up: 'var(--green)', warning: 'var(--yellow)', down: 'var(--red)', unknown: 'var(--text-muted)',
};
function statCardStyle(variant?: string): CSSProperties {
  return {
    background: 'var(--bg-card)', border: '1px solid var(--border)',
    borderLeft: `3px solid ${variant ? STATUS_COLORS[variant] || 'var(--border)' : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)', padding: '12px 16px', minHeight: 75,
    display: 'flex', flexDirection: 'column', justifyContent: 'center',
  };
}
const GRAPH_CARD: CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16,
};
const GRAPH_HEADER: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 8, marginBottom: 10,
};
const TAB_BTN_BASE: CSSProperties = {
  fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1.4,
};
const TAB_BTN_ACTIVE: CSSProperties = {
  ...TAB_BTN_BASE, background: 'var(--primary)', borderColor: 'var(--primary)', color: '#fff',
};

function tickLabel(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Page ───────────────────────────────────────────────────────
export default function ServiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [range, setRange] = useState('24h');

  const svc = useApi<ServiceDetail>(`/api/service-checks/${id}`, 20000);
  const results = useApi<ResultsResponse>(
    `/api/service-checks/${id}/results?range=${range}&limit=${HISTORY_LIMIT}`, 20000
  );

  if (svc.loading && !svc.data) return <Loading />;
  if (svc.error) return <ErrorBox message={svc.error} />;
  if (!svc.data) return <Empty message="Service check not found." />;

  const s = svc.data;
  const rows = results.data?.rows || [];
  const uptimePct = results.data?.uptime_pct ?? null;
  const upVariant = uptimePct == null ? 'unknown' : uptimePct >= 99.5 ? 'up' : uptimePct >= 95 ? 'warning' : 'down';

  // Chart wants oldest → newest; the results API returns newest-first.
  const chartData = rows.slice().reverse().map((r) => ({
    ts: r.ts, ms: r.response_ms != null ? Number(r.response_ms) : null, status: r.status,
  }));

  const isSsl = s.type === 'ssl';
  const sslWarn = isSsl && (s.current_status === 'warning' || s.current_status === 'down');

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <Link href="/services" className="sv-btn ghost sm">← Back to Services</Link>
      </div>

      {/* Compact header: status dot + name + badges */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2, flexWrap: 'wrap' }}>
        <StatusDot
          status={dotStatus(s.current_status)}
          size={14}
          title={`${(s.current_status || 'unknown').replace(/^\w/, (c) => c.toUpperCase())} — checked ${fmtRel(s.last_checked_at)}`}
        />
        <h1 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 700, letterSpacing: '-0.3px' }}>{s.name}</h1>
        <StatusBadge status={s.current_status} />
        <span className="sv-type-badge">{typeLabel(s.type)}</span>
        {!s.active && <span className="sv-type-badge" style={{ fontSize: 'var(--text-xs)' }}>Paused</span>}
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-base)', margin: '0 0 14px' }}>
        {s.target} · {s.site_name || 'No site'} · Runs from {s.agent_name || 'Central collector'} · Poll every {s.interval_seconds}s
      </p>

      {/* SSL expiry callout */}
      {isSsl && s.last_detail && (
        <div
          style={{
            ...SECTION_CARD,
            marginBottom: 16,
            borderLeft: `3px solid ${sslWarn ? STATUS_COLORS[dotStatus(s.current_status)] : 'var(--border)'}`,
            background: sslWarn ? (s.current_status === 'down' ? 'var(--tint-danger)' : 'var(--tint-warn)') : 'var(--bg-card)',
            padding: '12px 16px',
          }}
        >
          <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: sslWarn ? (s.current_status === 'down' ? 'var(--tint-danger-fg)' : 'var(--tint-warn-fg)') : 'var(--text-primary)' }}>
            {sslWarn ? '⚠ ' : ''}{s.last_detail}
          </div>
        </div>
      )}

      {/* Stat tiles */}
      <div style={STAT_GRID}>
        <div style={statCardStyle(dotStatus(s.current_status))}>
          <div style={STAT_VALUE}>{(s.current_status || 'unknown').replace(/^\w/, (c) => c.toUpperCase())}</div>
          <div style={STAT_LABEL}>Current Status</div>
        </div>
        <div style={statCardStyle()}>
          <div style={STAT_VALUE}>
            {s.last_response_ms != null ? Number(s.last_response_ms).toFixed(0) : '—'}
            {s.last_response_ms != null && <span style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}> ms</span>}
          </div>
          <div style={STAT_LABEL}>Last Response</div>
        </div>
        <div style={statCardStyle(upVariant)}>
          <div style={STAT_VALUE}>{uptimePct != null ? `${uptimePct}%` : '—'}</div>
          <div style={STAT_LABEL}>Uptime ({range})</div>
        </div>
        <div style={statCardStyle()}>
          <div style={STAT_VALUE}>{fmtRel(s.last_checked_at)}</div>
          <div style={STAT_LABEL}>Last Checked</div>
        </div>
      </div>

      {/* Response time chart */}
      <div style={GRAPH_CARD}>
        <div style={GRAPH_HEADER}>
          <h3 style={{ ...SECTION_HEADING, margin: 0 }}>Response Time</h3>
          <div style={{ display: 'flex', gap: 4 }}>
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                style={range === r.key ? TAB_BTN_ACTIVE : TAB_BTN_BASE}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {results.loading && !results.data ? (
          <Loading />
        ) : !chartData.length ? (
          <Empty message="No results for this range." />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 16, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="ts" tickFormatter={tickLabel} fontSize={11} minTickGap={40} />
              <YAxis fontSize={11} width={44} />
              <Tooltip
                {...CHART_TOOLTIP}
                labelFormatter={tickLabel}
                formatter={(v: any, _name: any, item: any) => [
                  v == null ? 'No response' : `${v} ms`,
                  item?.payload?.status ? `Status: ${item.payload.status}` : 'Response time',
                ]}
              />
              <Line type="monotone" dataKey="ms" stroke="#C8102E" strokeWidth={2} dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Recent status history */}
      <div style={SECTION_CARD}>
        <div style={SECTION_HEADING}>Recent Checks</div>
        {results.loading && !results.data ? (
          <Loading />
        ) : rows.length ? (
          <table className="sv-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Response</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const st = dotStatus(r.status);
                const rowBg = st === 'down' ? 'var(--tint-danger)' : st === 'warning' ? 'var(--tint-warn)' : undefined;
                return (
                  <tr key={`${r.ts}-${i}`} style={{ background: rowBg }}>
                    <td className="sv-muted">{fmtTime(r.ts)}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td style={{ textAlign: 'right' }}>{r.response_ms != null ? `${Number(r.response_ms).toFixed(0)} ms` : '—'}</td>
                    <td style={{ color: 'var(--text-muted)', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.detail || ''}>
                      {r.detail || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty message="No check results recorded for this range yet." />
        )}
      </div>
    </div>
  );
}
