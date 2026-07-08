'use client';

import { useMemo, useState } from 'react';

// Left-rail report catalog: a search box + a grouped, single-column list of report
// templates. Replaces the old pill-tab template selector. Purely presentational —
// selection state (the active template key) lives in the parent ReportsPage via
// `activeKey`/`onSelect`. Module-level component (never defined inside the page body)
// so it doesn't remount on every parent render (which would drop input focus).

export interface CatalogReport {
  key: string;
  short: string;   // rail label (concise)
  title: string;   // full report title (for search)
  desc: string;    // description (for search)
  icon: string;    // emoji glyph shown on the row
  category: string;
}

const MUTED: React.CSSProperties = { fontSize: 'var(--text-sm)', color: 'var(--text-muted)' };

export default function ReportsCatalog({
  reports, groupOrder, activeKey, onSelect,
}: {
  reports: CatalogReport[];
  groupOrder: string[];
  activeKey: string | null;
  onSelect: (key: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (r: CatalogReport) =>
      !q ||
      r.short.toLowerCase().includes(q) ||
      r.title.toLowerCase().includes(q) ||
      r.desc.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q);
    return groupOrder
      .map((cat) => ({ cat, items: reports.filter((r) => r.category === cat && match(r)) }))
      .filter((g) => g.items.length > 0);
  }, [reports, groupOrder, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <input
        placeholder="Search reports…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search reports"
        style={{
          width: '100%', flexShrink: 0, height: 32, padding: '0 10px',
          fontSize: 'var(--text-sm)', borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border)', background: 'var(--bg-card)',
          color: 'var(--text-primary)', fontFamily: 'inherit', outline: 'none',
        }}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 2 }}>
        {groups.length === 0 ? (
          <div style={{ ...MUTED, padding: '8px 4px' }}>No reports match “{query}”.</div>
        ) : groups.map((g) => (
          <div key={g.cat}>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '0 8px 6px' }}>
              {g.cat}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {g.items.map((r) => {
                const isActive = r.key === activeKey;
                const baseBg = isActive ? 'var(--primary-light)' : 'transparent';
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => onSelect(r.key)}
                    onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = 'var(--surface-subtle)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = baseBg; }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
                      padding: '8px 10px', cursor: 'pointer',
                      background: baseBg,
                      border: 'none',
                      borderLeft: isActive ? '3px solid var(--primary)' : '3px solid transparent',
                      borderRadius: 'var(--radius-sm)',
                      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: 'var(--text-base)',
                      fontWeight: isActive ? 600 : 500,
                      fontFamily: 'inherit',
                      outlineOffset: -2,
                    }}
                  >
                    <span aria-hidden style={{ fontSize: 'var(--text-md)', lineHeight: 1, flexShrink: 0 }}>{r.icon}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.short}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
