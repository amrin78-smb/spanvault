'use client';

import { useState } from 'react';
import { useApi } from '@/lib/api';
import { Loading, ErrorBox, Empty } from '@/components/ui';

type Row = Record<string, any>;

const TABS = [
  { key: 'availability', label: 'Availability', endpoint: '/api/reports/availability' },
  { key: 'response-time', label: 'Response Time', endpoint: '/api/reports/response-time' },
  { key: 'alerts', label: 'Alert Summary', endpoint: '/api/reports/alerts' },
];
const RANGES = [
  { key: '24h', label: '24 Hours' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
];

const COLUMNS: Record<string, { key: string; label: string; fmt?: (v: any) => string }[]> = {
  availability: [
    { key: 'device_name', label: 'Device' },
    { key: 'ip_address', label: 'IP' },
    { key: 'site_name', label: 'Site' },
    { key: 'uptime_pct', label: 'Uptime %', fmt: (v) => (v == null ? '—' : `${v}%`) },
    { key: 'total_checks', label: 'Checks' },
    { key: 'failed_checks', label: 'Failed' },
  ],
  'response-time': [
    { key: 'device_name', label: 'Device' },
    { key: 'ip_address', label: 'IP' },
    { key: 'site_name', label: 'Site' },
    { key: 'avg_ms', label: 'Avg ms', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'min_ms', label: 'Min ms', fmt: (v) => (v == null ? '—' : `${v}`) },
    { key: 'max_ms', label: 'Max ms', fmt: (v) => (v == null ? '—' : `${v}`) },
  ],
  alerts: [
    { key: 'device_name', label: 'Device' },
    { key: 'ip_address', label: 'IP' },
    { key: 'site_name', label: 'Site' },
    { key: 'total_alerts', label: 'Total Alerts' },
    { key: 'mttr_minutes', label: 'MTTR (min)', fmt: (v) => (v == null ? '—' : `${v}`) },
  ],
};

export default function ReportsPage() {
  const [tab, setTab] = useState('availability');
  const [range, setRange] = useState('24h');

  const active = TABS.find((t) => t.key === tab)!;
  const report = useApi<Row[]>(`${active.endpoint}?range=${range}`);
  const cols = COLUMNS[tab];

  function downloadCsv() {
    window.open(`${active.endpoint}?range=${range}&format=csv`, '_blank');
  }

  return (
    <div>
      <h1 className="sv-page-title">Reports</h1>
      <p className="sv-page-sub">Availability, performance, and alert summaries.</p>

      <div className="sv-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`sv-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="sv-toolbar">
        <select className="sv-select" value={range} onChange={(e) => setRange(e.target.value)}>
          {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <div className="spacer" />
        <button className="sv-btn ghost" onClick={downloadCsv}>Export CSV</button>
      </div>

      {report.error && <ErrorBox message={report.error} />}
      <div className="sv-panel" style={{ padding: 0 }}>
        {report.loading && !report.data ? (
          <Loading />
        ) : report.data && report.data.length ? (
          <table className="sv-table">
            <thead>
              <tr>{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {report.data.map((row, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.key} className={c.key === 'device_name' ? '' : 'sv-muted'}>
                      {c.fmt ? c.fmt(row[c.key]) : (row[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No data for the selected range." />
        )}
      </div>
    </div>
  );
}
