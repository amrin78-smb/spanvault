'use client';

type TopWorst = {
  metric: 'uptime' | 'response' | 'alerts';
  generated_at: string;
  devices: {
    device_id: number;
    device_name: string;
    site_name: string;
    uptime_pct: number | null;
    avg_response_ms: number | null;
    alerts_count: number;
    downtime_minutes: number;
  }[];
};

const METRIC_LABELS: Record<TopWorst['metric'], string> = {
  uptime: 'Availability',
  response: 'Response Time',
  alerts: 'Alerts',
};

const METRIC_COLUMN_HEADERS: Record<TopWorst['metric'], string> = {
  uptime: 'Uptime %',
  response: 'Avg Response',
  alerts: 'Alerts',
};

function metricRawValue(device: TopWorst['devices'][number], metric: TopWorst['metric']): number | null {
  // Coerce — Postgres numeric columns arrive as JSON strings; comparison and
  // bar-scaling below need real numbers.
  const v = metric === 'uptime' ? device.uptime_pct
    : metric === 'response' ? device.avg_response_ms : device.alerts_count;
  return v == null ? null : Number(v);
}

function metricDisplayValue(device: TopWorst['devices'][number], metric: TopWorst['metric']): string {
  if (metric === 'uptime') {
    return device.uptime_pct == null ? '—' : `${device.uptime_pct}%`;
  }
  if (metric === 'response') {
    return device.avg_response_ms == null ? '—' : `${device.avg_response_ms} ms`;
  }
  return device.alerts_count == null ? '—' : `${device.alerts_count}`;
}

function maxMetricValue(devices: TopWorst['devices'], metric: TopWorst['metric']): number {
  let max = 0;
  for (const d of devices) {
    const v = metricRawValue(d, metric);
    if (v != null && v > max) max = v;
  }
  return max;
}

function barWidthPct(value: number | null, metric: TopWorst['metric'], maxValue: number): number {
  if (value == null) return 0;
  if (metric === 'uptime') {
    // For uptime, width = uptime_pct% directly (worse = shorter bar).
    return Math.max(0, Math.min(100, value));
  }
  if (maxValue <= 0) return 0;
  return Math.max(0, Math.min(100, (value / maxValue) * 100));
}

// ── Shared REPORT OUTPUT style constants (module scope) ─────────
const PANEL: React.CSSProperties = { padding: 16 };
const SECTION_TITLE: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  textTransform: 'uppercase',
  fontWeight: 600,
  color: 'var(--text-muted)',
  letterSpacing: '0.06em',
  margin: '0 0 8px',
};
const TH: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  textTransform: 'uppercase',
  fontWeight: 600,
  letterSpacing: '0.06em',
  color: 'var(--text-muted)',
  padding: '8px 12px',
  textAlign: 'left',
};
const TD: React.CSSProperties = {
  fontSize: 'var(--text-sm)',
  color: 'var(--text-primary)',
  padding: '8px 12px',
  height: 36,
};

export default function TopWorstReport({ data }: { data: TopWorst }) {
  if (!data) return null;
  const metric = data.metric || 'uptime';
  const generated_at = data.generated_at;
  const devices = data.devices || [];
  const label = METRIC_LABELS[metric];
  const valueHeader = METRIC_COLUMN_HEADERS[metric];
  const maxValue = maxMetricValue(devices, metric);

  return (
    <div>
      <h2 style={SECTION_TITLE}>
        Top {devices.length} Worst by {label}
      </h2>
      {generated_at ? (
        <div className="sv-muted" style={{ marginBottom: 12, fontSize: 'var(--text-xs)' }}>
          Generated {generated_at}
        </div>
      ) : null}

      <div className="sv-panel" style={PANEL}>
        <table className="sv-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th style={{ ...TH, width: 64 }}>Rank</th>
              <th style={TH}>Device</th>
              <th style={TH}>Site</th>
              <th style={{ ...TH, width: '38%' }}>{valueHeader}</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device, index) => {
              const rank = index + 1;
              const isWorst = rank <= 3;
              const rawValue = metricRawValue(device, metric);
              const width = barWidthPct(rawValue, metric, maxValue);
              const barColor = isWorst ? '#C8102E' : '#9aa3b2';
              const rankBg = isWorst ? '#C8102E' : '#6b7280';

              return (
                <tr key={device.device_id}>
                  <td style={TD}>
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minWidth: 26,
                        height: 22,
                        padding: '0 6px',
                        borderRadius: 999,
                        background: rankBg,
                        color: '#ffffff',
                        fontSize: 'var(--text-xs)',
                        fontWeight: 700,
                        lineHeight: 1,
                      }}
                    >
                      #{rank}
                    </span>
                  </td>
                  <td style={TD}>{device.device_name || '—'}</td>
                  <td style={TD} className="sv-muted">{device.site_name || '—'}</td>
                  <td style={TD}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div
                        style={{
                          flex: 1,
                          minWidth: 80,
                          height: 4,
                          borderRadius: 2,
                          background: 'var(--surface-subtle)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${width}%`,
                            height: '100%',
                            background: barColor,
                          }}
                        />
                      </div>
                      <span style={{ minWidth: 70, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {metricDisplayValue(device, metric)}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
            {devices.length === 0 ? (
              <tr>
                <td colSpan={4} className="sv-muted" style={{ textAlign: 'center', padding: 24 }}>
                  No data available.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
