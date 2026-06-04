'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, fmtTime, PageHeader, TableSkeleton } from '@/components/ui';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'rules', label: 'Alert Rules' },
  { key: 'maintenance', label: 'Maintenance' },
];

export default function SettingsPage() {
  const { canManageSettings } = useRbac();
  const router = useRouter();
  const [tab, setTab] = useState('general');

  // View-only roles (site_admin / viewer) cannot manage settings — bounce them
  // to the dashboard with a notice.
  useEffect(() => {
    if (!canManageSettings) {
      router.replace('/?notice=' + encodeURIComponent('Settings access requires admin role'));
    }
  }, [canManageSettings, router]);

  if (!canManageSettings) {
    return <div className="sv-panel" style={{ marginTop: 20 }}><Loading /></div>;
  }

  return (
    <div>
      <PageHeader title="Settings" subtitle="Polling, thresholds, notifications, and alert rules." />
      <div className="sv-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`sv-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'general' && <GeneralSettings />}
      {tab === 'rules' && <AlertRules />}
      {tab === 'maintenance' && <Maintenance />}
    </div>
  );
}

// ── General settings ───────────────────────────────────────────
const NUM_FIELDS = [
  { key: 'icmp_poll_interval_seconds', label: 'ICMP Poll Interval (s)' },
  { key: 'snmp_poll_interval_seconds', label: 'SNMP Poll Interval (s)' },
  { key: 'ping_threshold_ms', label: 'Ping Threshold (ms)' },
  { key: 'ping_failures_before_down', label: 'Failures Before Down' },
  { key: 'cpu_threshold_pct', label: 'CPU Alert Threshold (%)' },
  { key: 'mem_threshold_pct', label: 'Memory Alert Threshold (%)' },
  { key: 'netvault_sync_minutes', label: 'NetVault Sync (min)' },
];
const SMTP_FIELDS = [
  { key: 'smtp_host', label: 'SMTP Host' },
  { key: 'smtp_port', label: 'SMTP Port' },
  { key: 'smtp_user', label: 'SMTP User' },
  { key: 'smtp_pass', label: 'SMTP Password', type: 'password' },
  { key: 'smtp_from', label: 'From Address' },
  { key: 'alert_email_to', label: 'Alert Recipients' },
];

function GeneralSettings() {
  const settings = useApi<Record<string, string>>('/api/settings');
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  function set(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); setSaved(false); }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await apiSend('/api/settings', 'PUT', form);
      setSaved(true);
    } catch (e: any) {
      setErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error) return <ErrorBox message={settings.error} />;

  return (
    <div>
      {err && <ErrorBox message={err} />}
      <div className="sv-panel">
        <h2>Polling &amp; Thresholds</h2>
        <div className="sv-form-grid">
          {NUM_FIELDS.map((f) => (
            <label className="sv-field" key={f.key}>{f.label}
              <input className="sv-input" type="number" value={form[f.key] ?? ''}
                onChange={(e) => set(f.key, e.target.value)} />
            </label>
          ))}
        </div>
      </div>

      <div className="sv-panel">
        <h2>Email Notifications</h2>
        <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <input type="checkbox"
            checked={String(form.email_alerts_enabled).toLowerCase() === 'true'}
            onChange={(e) => set('email_alerts_enabled', e.target.checked ? 'true' : 'false')} />
          Enable email alerts
        </label>
        <div className="sv-form-grid">
          {SMTP_FIELDS.map((f) => (
            <label className="sv-field" key={f.key}>{f.label}
              <input className="sv-input" type={f.type || 'text'} value={form[f.key] ?? ''}
                onChange={(e) => set(f.key, e.target.value)} />
            </label>
          ))}
        </div>
      </div>

      <div className="sv-toolbar">
        <button className="sv-btn" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
        {saved && <span style={{ color: 'var(--sv-up)', fontWeight: 600 }}>Saved ✓</span>}
      </div>
    </div>
  );
}

// ── Alert rules (multi-level: global / site / device) ─────────
type Rule = {
  id: number; device_id: number | null; device_name: string | null;
  site_id: number | null; site_name: string | null; scope: string;
  metric: string; operator: string; threshold: number | null; severity: string;
  enabled: boolean; notify_recovery: boolean; description: string | null;
};
type NewRule = {
  metric: string; operator: string; threshold: number | null;
  severity: string; notify_recovery: boolean; description: string | null;
};
type Site = { id: number; name: string; code?: string; city?: string };
type DeviceLite = { id: number; name: string; ip_address: string; site_id: number | null; site_name: string | null };

const OPERATORS = ['>', '>=', '<', '<=', '=', '!='];
const METRIC_OPTIONS = [
  { value: 'device_down',   label: 'Device Down',          noThreshold: true,  unit: '' },
  { value: 'response_time', label: 'Response Time (ms)',   unit: 'ms' },
  { value: 'packet_loss',   label: 'Packet Loss (%)',      unit: '%' },
  { value: 'cpu_pct',       label: 'CPU % (SNMP)',         unit: '%' },
  { value: 'mem_pct',       label: 'Memory % (SNMP)',      unit: '%' },
  { value: 'snmp_no_data',  label: 'SNMP No Data (minutes)', unit: 'm' },
  { value: 'interface_down', label: 'Interface Down',      noThreshold: true,  unit: '' },
  { value: 'bandwidth_pct', label: 'Bandwidth % (SNMP)',   unit: '%' },
];
function metricLabel(metric: string): string {
  return METRIC_OPTIONS.find((m) => m.value === metric)?.label || metric;
}
function metricUnit(metric: string): string {
  return METRIC_OPTIONS.find((m) => m.value === metric)?.unit || '';
}
function isNoThreshold(metric: string): boolean {
  return !!METRIC_OPTIONS.find((m) => m.value === metric)?.noThreshold;
}
function conditionText(r: Rule): string {
  if (isNoThreshold(r.metric)) return 'triggered';
  const u = metricUnit(r.metric);
  return `${r.operator} ${r.threshold}${u}`;
}

const RULE_SUBTABS = [
  { key: 'global', label: 'Global Rules' },
  { key: 'site', label: 'Site Rules' },
  { key: 'device', label: 'Device Rules' },
];

function AlertRules() {
  const [sub, setSub] = useState('global');
  return (
    <div>
      <div className="sv-tabs" style={{ marginTop: 0 }}>
        {RULE_SUBTABS.map((t) => (
          <button key={t.key} className={`sv-tab ${sub === t.key ? 'active' : ''}`} onClick={() => setSub(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {sub === 'global' && <GlobalRules />}
      {sub === 'site' && <SiteRules />}
      {sub === 'device' && <DeviceRules />}
    </div>
  );
}

// Shared add-rule form (top-level component).
function RuleForm({ onAdd }: { onAdd: (r: NewRule) => Promise<void> }) {
  const [metric, setMetric] = useState('response_time');
  const [operator, setOperator] = useState('>');
  const [threshold, setThreshold] = useState('100');
  const [severity, setSeverity] = useState('warning');
  const [recovery, setRecovery] = useState(false);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const noThresh = isNoThreshold(metric);

  async function submit() {
    setBusy(true);
    try {
      await onAdd({
        metric, operator,
        threshold: noThresh ? null : parseFloat(threshold),
        severity, notify_recovery: recovery, description: description || null,
      });
      setDescription('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="sv-toolbar" style={{ flexWrap: 'wrap' }}>
        <select className="sv-select" value={metric} onChange={(e) => setMetric(e.target.value)}>
          {METRIC_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {!noThresh && (
          <>
            <select className="sv-select" value={operator} onChange={(e) => setOperator(e.target.value)}>
              {OPERATORS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input className="sv-input" type="number" style={{ width: 110 }} value={threshold}
              onChange={(e) => setThreshold(e.target.value)} placeholder="threshold" />
          </>
        )}
        <select className="sv-select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="warning">warning</option>
          <option value="critical">critical</option>
        </select>
        <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={recovery} onChange={(e) => setRecovery(e.target.checked)} />
          Notify on recovery
        </label>
        <button className="sv-btn" onClick={submit} disabled={busy}>{busy ? 'Adding…' : '+ Add Rule'}</button>
      </div>
      <input className="sv-input" style={{ marginTop: 10, width: '100%', maxWidth: 520 }}
        placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
    </div>
  );
}

// Editable rules table (toggle / delete) — top-level component.
function RulesTable({ rules, onChange }: { rules: Rule[] | null; onChange: () => void }) {
  async function toggle(r: Rule) {
    await apiSend(`/api/alert-rules/${r.id}`, 'PUT', { enabled: !r.enabled });
    onChange();
  }
  async function remove(r: Rule) {
    if (!confirm('Delete this rule?')) return;
    await apiSend(`/api/alert-rules/${r.id}`, 'DELETE');
    onChange();
  }
  if (!rules) return <Loading />;
  if (!rules.length) return <Empty message="No rules defined at this level." />;
  return (
    <table className="sv-table">
      <thead>
        <tr><th>Metric</th><th>Condition</th><th>Severity</th><th>Recovery</th><th>Description</th><th>Enabled</th><th></th></tr>
      </thead>
      <tbody>
        {rules.map((r) => (
          <tr key={r.id}>
            <td>{metricLabel(r.metric)}</td>
            <td>{conditionText(r)}</td>
            <td>{r.severity}</td>
            <td className="sv-muted">{r.notify_recovery ? 'Yes' : '—'}</td>
            <td className="sv-muted">{r.description || '—'}</td>
            <td><button className="sv-btn ghost sm" onClick={() => toggle(r)}>{r.enabled ? 'On' : 'Off'}</button></td>
            <td><button className="sv-btn ghost sm" onClick={() => remove(r)}>Delete</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Read-only inherited rules shown in muted style — top-level component.
function InheritedRules({ title, rules }: { title: string; rules: Rule[] | null | undefined }) {
  if (!rules || !rules.length) return null;
  return (
    <div className="sv-panel" style={{ padding: 0, opacity: 0.62 }}>
      <div style={{ padding: '12px 16px 0' }}>
        <h2 style={{ fontSize: 14, margin: 0 }}>{title}</h2>
        <p className="sv-muted" style={{ fontSize: 12, margin: '4px 0 0' }}>Inherited — edit on its own tab.</p>
      </div>
      <table className="sv-table">
        <thead><tr><th>Scope</th><th>Metric</th><th>Condition</th><th>Severity</th><th>Description</th></tr></thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td><span className="sv-badge unknown">{r.scope}</span></td>
              <td>{metricLabel(r.metric)}</td>
              <td>{conditionText(r)}</td>
              <td>{r.severity}</td>
              <td className="sv-muted">{r.description || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GlobalRules() {
  const rules = useApi<Rule[]>('/api/alert-rules?scope=global');
  const [err, setErr] = useState<string | null>(null);
  async function add(r: NewRule) {
    setErr(null);
    try {
      await apiSend('/api/alert-rules', 'POST', { ...r, scope: 'global', enabled: true });
      rules.reload();
    } catch (e: any) { setErr(e?.message || 'Failed to add rule'); }
  }
  return (
    <div>
      {err && <ErrorBox message={err} />}
      <div className="sv-panel">
        <h2>Add Global Rule</h2>
        <p className="sv-muted" style={{ marginTop: -6 }}>Applies to all devices unless a site or device rule overrides it.</p>
        <RuleForm onAdd={add} />
      </div>
      <div className="sv-panel" style={{ padding: 0 }}>
        <RulesTable rules={rules.data} onChange={() => rules.reload()} />
      </div>
    </div>
  );
}

function SiteRules() {
  const sites = useApi<Site[]>('/api/netvault/sites');
  const globals = useApi<Rule[]>('/api/alert-rules?scope=global');
  const [siteId, setSiteId] = useState('');
  const site = sites.data?.find((s) => String(s.id) === siteId);
  const rules = useApi<Rule[]>(siteId ? `/api/alert-rules?scope=site&site_id=${siteId}` : null);
  const [err, setErr] = useState<string | null>(null);

  async function add(r: NewRule) {
    if (!site) return;
    setErr(null);
    try {
      await apiSend('/api/alert-rules', 'POST',
        { ...r, scope: 'site', site_id: site.id, site_name: site.name, enabled: true });
      rules.reload();
    } catch (e: any) { setErr(e?.message || 'Failed to add rule'); }
  }

  return (
    <div>
      {err && <ErrorBox message={err} />}
      <div className="sv-panel">
        <h2>Site Rules</h2>
        <div className="sv-toolbar">
          <select className="sv-select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">Select a site…</option>
            {sites.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {site ? (
          <>
            <p className="sv-muted" style={{ marginTop: 4 }}>Rules for <strong>{site.name}</strong> override global rules for devices at this site.</p>
            <RuleForm onAdd={add} />
          </>
        ) : (
          <Empty message="Select a site to manage its rules." />
        )}
      </div>
      {site && (
        <div className="sv-panel" style={{ padding: 0 }}>
          <RulesTable rules={rules.data} onChange={() => rules.reload()} />
        </div>
      )}
      {site && <InheritedRules title="Inherited global rules" rules={globals.data} />}
    </div>
  );
}

function DeviceRules() {
  const devices = useApi<DeviceLite[]>('/api/devices');
  const [search, setSearch] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const device = devices.data?.find((d) => String(d.id) === deviceId);
  const rules = useApi<Rule[]>(deviceId ? `/api/alert-rules?scope=device&device_id=${deviceId}` : null);
  const effective = useApi<{ device: any; rules: Rule[] }>(deviceId ? `/api/alert-rules/effective/${deviceId}` : null);
  const globals = useApi<Rule[]>('/api/alert-rules?scope=global');
  const siteRules = useApi<Rule[]>(device?.site_id ? `/api/alert-rules?scope=site&site_id=${device.site_id}` : null);
  const [err, setErr] = useState<string | null>(null);

  const filtered = (devices.data || []).filter((d) =>
    !search || d.name.toLowerCase().includes(search.toLowerCase()) || (d.ip_address || '').includes(search));

  async function add(r: NewRule) {
    if (!device) return;
    setErr(null);
    try {
      await apiSend('/api/alert-rules', 'POST', { ...r, scope: 'device', device_id: device.id, enabled: true });
      rules.reload();
      effective.reload();
    } catch (e: any) { setErr(e?.message || 'Failed to add rule'); }
  }

  return (
    <div>
      {err && <ErrorBox message={err} />}
      <div className="sv-panel">
        <h2>Device Rules</h2>
        <div className="sv-toolbar" style={{ flexWrap: 'wrap' }}>
          <input className="sv-input" placeholder="Search device by name or IP…" value={search}
            onChange={(e) => setSearch(e.target.value)} style={{ width: 240 }} />
          <select className="sv-select" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">Select a device…</option>
            {filtered.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.ip_address})</option>)}
          </select>
        </div>
        {device ? (
          <>
            <p className="sv-muted" style={{ marginTop: 4 }}>
              Device rules for <strong>{device.name}</strong> override site and global rules.
            </p>
            <RuleForm onAdd={add} />
          </>
        ) : (
          <Empty message="Select a device to manage its rules." />
        )}
      </div>

      {device && (
        <div className="sv-panel" style={{ padding: 0 }}>
          <RulesTable rules={rules.data} onChange={() => { rules.reload(); effective.reload(); }} />
        </div>
      )}

      {device && <InheritedRules title="Inherited site rules" rules={siteRules.data} />}
      {device && <InheritedRules title="Inherited global rules" rules={globals.data} />}

      {device && effective.data && (
        <div className="sv-panel" style={{ padding: 0 }}>
          <div style={{ padding: '12px 16px 0' }}>
            <h2 style={{ fontSize: 14, margin: 0 }}>Effective Rules</h2>
            <p className="sv-muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
              Final merged ruleset actually evaluated for {device.name}.
            </p>
          </div>
          {effective.data.rules.length ? (
            <table className="sv-table">
              <thead><tr><th>Metric</th><th>Condition</th><th>Severity</th><th>Source</th><th>Recovery</th></tr></thead>
              <tbody>
                {effective.data.rules.map((r) => (
                  <tr key={r.id}>
                    <td>{metricLabel(r.metric)}</td>
                    <td>{conditionText(r)}</td>
                    <td>{r.severity}</td>
                    <td><span className={`sv-badge ${r.scope === 'device' ? 'down' : r.scope === 'site' ? 'warning' : 'unknown'}`}>{r.scope}</span></td>
                    <td className="sv-muted">{r.notify_recovery ? 'Yes' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty message="No effective rules — add a global, site, or device rule." />
          )}
        </div>
      )}
    </div>
  );
}

// ── Maintenance windows ────────────────────────────────────────
type Window = {
  id: number; device_id: number | null; device_name: string | null;
  starts_at: string; ends_at: string; reason: string | null;
};

function Maintenance() {
  const windows = useApi<Window[]>('/api/maintenance');
  const [form, setForm] = useState({ starts_at: '', ends_at: '', reason: '' });
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setErr(null);
    try {
      await apiSend('/api/maintenance', 'POST', {
        starts_at: form.starts_at,
        ends_at: form.ends_at,
        reason: form.reason || null,
      });
      setForm({ starts_at: '', ends_at: '', reason: '' });
      windows.reload();
    } catch (e: any) {
      setErr(e?.message || 'Failed to add window');
    }
  }
  async function remove(w: Window) {
    if (!confirm('Delete this maintenance window?')) return;
    await apiSend(`/api/maintenance/${w.id}`, 'DELETE');
    windows.reload();
  }

  return (
    <div>
      {err && <ErrorBox message={err} />}
      <div className="sv-panel">
        <h2>Schedule Maintenance Window</h2>
        <p className="sv-muted" style={{ marginTop: -8 }}>Alerts are suppressed for all devices during this window.</p>
        <div className="sv-toolbar">
          <label className="sv-field">Starts
            <input className="sv-input" type="datetime-local" value={form.starts_at}
              onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))} />
          </label>
          <label className="sv-field">Ends
            <input className="sv-input" type="datetime-local" value={form.ends_at}
              onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))} />
          </label>
          <label className="sv-field">Reason
            <input className="sv-input" value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
          </label>
          <button className="sv-btn" onClick={add} disabled={!form.starts_at || !form.ends_at}>+ Add</button>
        </div>
      </div>

      <div className="sv-panel" style={{ padding: 0 }}>
        {windows.loading && !windows.data ? (
          <TableSkeleton rows={4} cols={5} />
        ) : windows.data && windows.data.length ? (
          <table className="sv-table">
            <thead>
              <tr><th>Scope</th><th>Starts</th><th>Ends</th><th>Reason</th><th></th></tr>
            </thead>
            <tbody>
              {windows.data.map((w) => (
                <tr key={w.id}>
                  <td>{w.device_name || 'All devices'}</td>
                  <td className="sv-muted">{fmtTime(w.starts_at)}</td>
                  <td className="sv-muted">{fmtTime(w.ends_at)}</td>
                  <td>{w.reason || '—'}</td>
                  <td><button className="sv-btn ghost sm" onClick={() => remove(w)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No maintenance windows scheduled." />
        )}
      </div>
    </div>
  );
}
