'use client';

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, fmtRel } from '@/components/ui';
import type { MapSummary } from '@/lib/mapTypes';

const CANVAS_PRESETS = [
  { key: 'hd', label: 'HD — 1600 × 900', w: 1600, h: 900 },
  { key: 'fhd', label: 'FHD — 1920 × 1080', w: 1920, h: 1080 },
  { key: 'square', label: 'Square — 1200 × 1200', w: 1200, h: 1200 },
];

// Persistent, manually-copyable public-link bar. Stays until dismissed; the
// clipboard API only works over HTTPS, so we fall back to selecting the text.
function ShareLinkBar({ url, onClose }: { url: string; onClose: () => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
      } else if (ref.current) {
        ref.current.select();
        document.execCommand('copy');
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      ref.current?.select();
    }
  }
  return (
    <div className="sv-share-bar">
      <span className="lbl">🔗 Public link</span>
      <input ref={ref} className="sv-input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      <button className="sv-btn sm" onClick={copy}>{copied ? '✓ Copied' : 'Copy'}</button>
      <button className="sv-btn ghost sm" onClick={onClose}>Close</button>
    </div>
  );
}

export default function MapsPage() {
  const { canEdit } = useRbac();
  const maps = useApi<MapSummary[]>('/api/maps', 0);
  const [showCreate, setShowCreate] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  async function handleDelete(m: MapSummary) {
    if (!confirm(`Delete map "${m.name}"? This cannot be undone.`)) return;
    await apiSend(`/api/maps/${m.id}`, 'DELETE');
    maps.reload();
  }

  async function handleShare(m: MapSummary) {
    let isPublic = m.is_public;
    let uuid = m.uuid;
    if (!isPublic) {
      if (!confirm(`"${m.name}" is private. Make it public so anyone with the link can view it?`)) return;
      const r = await apiSend<{ is_public: boolean; uuid: string }>(`/api/maps/${m.id}/toggle-public`, 'POST', {});
      isPublic = r.is_public;
      uuid = r.uuid;
      maps.reload();
    }
    // Show a persistent, copyable bar — auto-copy via the clipboard API only works
    // in a secure (HTTPS) context, so over plain HTTP the user copies manually.
    const url = `${window.location.origin}/maps/public/${uuid}`;
    setShareUrl(url);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 className="sv-page-title" style={{ margin: 0 }}>Maps</h1>
        <div style={{ flex: 1 }} />
        <a className="sv-btn ghost sm tint-violet" href="/maps/wall" target="_blank" rel="noopener noreferrer" title="Full-screen rotating wallboard">Wallboard ↗</a>
        {canEdit && <button className="sv-btn" onClick={() => setShowCreate(true)}>+ New Map</button>}
      </div>
      <p className="sv-page-sub">Design interactive network maps with live device status.</p>

      <TopologyCard />

      {notice && <div className="sv-toast ok" onClick={() => setNotice(null)}>{notice}</div>}
      {shareUrl && <ShareLinkBar url={shareUrl} onClose={() => setShareUrl(null)} />}
      {maps.error && <ErrorBox message={maps.error} />}

      {maps.loading && !maps.data ? (
        <div className="sv-panel"><Loading /></div>
      ) : maps.data && maps.data.length ? (
        <div className="sv-map-cards">
          {maps.data.map((m) => (
            <MapCard key={m.id} map={m} onDelete={handleDelete} onShare={handleShare} />
          ))}
        </div>
      ) : (
        <div className="sv-panel" style={{ padding: 0 }}>
          <Empty message="No maps yet. Create one to get started." />
        </div>
      )}

      {showCreate && (
        <CreateMapModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); maps.reload(); }}
        />
      )}
    </div>
  );
}

// ── Topology discovery card (top-level component) ──────────────
type TopologyStatus = {
  running: boolean;
  last_run_at: string | null;
  links_found: number;
  devices_discovered: number;
};

function TopologyCard() {
  const { canEdit } = useRbac();
  const status = useApi<TopologyStatus>('/api/topology/status', 0);
  const [running, setRunning] = useState(false);

  async function runDiscovery() {
    setRunning(true);
    try {
      await apiSend('/api/topology/discover', 'POST', {});
      // Discovery runs in the background; give it a moment, then refresh.
      setTimeout(() => { status.reload(); setRunning(false); }, 2500);
    } catch {
      setRunning(false);
    }
  }

  const s = status.data;
  const busy = running || !!s?.running;

  return (
    <div className="sv-panel" style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap', marginBottom: 18 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 10, flex: 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-primary)', border: '1px solid var(--border)', color: 'var(--primary)',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="19" r="2.5" /><circle cx="19" cy="19" r="2.5" />
          <line x1="12" y1="7.5" x2="6" y2="16.8" /><line x1="12" y1="7.5" x2="18" y2="16.8" />
          <line x1="7.5" y1="19" x2="16.5" y2="19" />
        </svg>
      </div>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Network Topology Discovery</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Auto-discover device connections via LLDP and CDP.
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
          {busy
            ? 'Discovery running…'
            : s && s.last_run_at
              ? `Last run: ${fmtRel(s.last_run_at)} · ${s.links_found} link${s.links_found === 1 ? '' : 's'} found`
              : 'Not run yet'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        {canEdit && (
          <button className="sv-btn" onClick={runDiscovery} disabled={busy}>
            {busy ? 'Running…' : 'Run Discovery'}
          </button>
        )}
        <a className="sv-btn ghost" href="/topology">View Topology</a>
      </div>
    </div>
  );
}

// ── Map card (top-level component) ─────────────────────────────
function MapCard({
  map, onDelete, onShare,
}: {
  map: MapSummary;
  onDelete: (m: MapSummary) => void;
  onShare: (m: MapSummary) => void;
}) {
  const { canEdit } = useRbac();
  return (
    <div className="sv-map-card">
      <div className="thumb" style={{ background: map.bg_color || '#f8fafc' }}>
        <svg width="44" height="44" viewBox="0 0 24 24" fill="none"
          stroke="#94a3b8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
          <line x1="8" y1="2" x2="8" y2="18" /><line x1="16" y1="6" x2="16" y2="22" />
        </svg>
        {map.is_public && <span className="sv-map-public">Public</span>}
      </div>
      <div className="body">
        <div className="nm" title={map.name}>{map.name}</div>
        {map.description && <div className="desc" title={map.description}>{map.description}</div>}
        <div className="meta">
          {map.device_count} device{map.device_count === 1 ? '' : 's'} · updated {fmtRel(map.updated_at)}
        </div>
        <div className="actions">
          {canEdit && <a className="sv-btn ghost sm" href={`/maps/${map.id}/edit`}>Edit</a>}
          <a className="sv-btn ghost sm" href={`/maps/${map.id}`}>View</a>
          {canEdit && <button className="sv-btn ghost sm" onClick={() => onShare(map)}>Share</button>}
          <div style={{ flex: 1 }} />
          {canEdit && <button className="sv-btn ghost sm" onClick={() => onDelete(map)} title="Delete map">Delete</button>}
        </div>
      </div>
    </div>
  );
}

// ── Create map modal (top-level component) ─────────────────────
function CreateMapModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [preset, setPreset] = useState('hd');
  const [bgColor, setBgColor] = useState('#f8fafc');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) { setErr('Name is required'); return; }
    const p = CANVAS_PRESETS.find((x) => x.key === preset) || CANVAS_PRESETS[0];
    setSaving(true);
    setErr(null);
    try {
      const m = await apiSend<{ id: number }>('/api/maps', 'POST', {
        name: name.trim(),
        description: description.trim() || null,
        bg_color: bgColor,
        canvas_w: p.w,
        canvas_h: p.h,
      });
      onCreated(m.id);
      router.push(`/maps/${m.id}/edit`);
    } catch (e: any) {
      setErr(e?.message || 'Failed to create map');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sv-modal-backdrop" onMouseDown={onClose}>
      <div className="sv-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>New Map</h2>
        {err && <ErrorBox message={err} />}
        <div className="sv-form-grid">
          <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Name
            <input className="sv-input" value={name} autoFocus
              onChange={(e) => setName(e.target.value)} placeholder="e.g. Core Network" />
          </label>
          <label className="sv-field" style={{ gridColumn: '1 / -1' }}>Description
            <input className="sv-input" value={description}
              onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </label>
          <label className="sv-field">Canvas size
            <select className="sv-select" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {CANVAS_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </label>
          <label className="sv-field">Background color
            <input type="color" className="sv-input" value={bgColor}
              onChange={(e) => setBgColor(e.target.value)} style={{ height: 40, padding: 4 }} />
          </label>
        </div>
        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="sv-btn" onClick={create} disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create & Edit'}
          </button>
        </div>
      </div>
    </div>
  );
}
