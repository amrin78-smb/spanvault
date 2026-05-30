'use client';

import { useEffect, useState } from 'react';
import { useApi, apiSend } from '@/lib/api';
import { Loading, ErrorBox, Empty, fmtTime } from '@/components/ui';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'rules', label: 'Alert Rules' },
  { key: 'maintenance', label: 'Maintenance' },
];

export default function SettingsPage() {
  const [tab, setTab] = useState('general');
  return (
    <div>
      <h1 className="sv-page-title">Settings</h1>
      <p className="sv-page-sub">Polling, thresholds, notifications, and alert rules.</p>
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

// ── Alert rules ────────────────────────────────────────────────
type Rule = {
  id: number; device_id: number | null; device_name: string | null;
  metric: string; operator: string; threshold: number; severity: string; enabled: boolean;
};
const METRICS = ['cpu_pct', 'mem_pct', 'if_in_bps', 'if_out_bps'];
const OPERATORS = ['>', '>=', '<', '<=', '=', '!='];

function AlertRules() {
  const rules = useApi<Rule[]>('/api/alert-rules');
  const [form, setForm] = useState({ metric: 'cpu_pct', operator: '>', threshold: '80', severity: 'warning' });
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setErr(null);
    try {
      await apiSend('/api/alert-rules', 'POST', {
        metric: form.metric,
        operator: form.operator,
        threshold: parseFloat(form.threshold),
        severity: form.severity,
        enabled: true,
      });
      rules.reload();
    } catch (e: any) {
      setErr(e?.message || 'Failed to add rule');
    }
  }
  async function toggle(r: Rule) {
    await apiSend(`/api/alert-rules/${r.id}`, 'PUT', { enabled: !r.enabled });
    rules.reload();
  }
  async function remove(r: Rule) {
    if (!confirm('Delete this rule?')) return;
    await apiSend(`/api/alert-rules/${r.id}`, 'DELETE');
    rules.reload();
  }

  return (
    <div>
      {err && <ErrorBox message={err} />}
      <div className="sv-panel">
        <h2>Add Global Rule</h2>
        <div className="sv-toolbar">
          <select className="sv-select" value={form.metric} onChange={(e) => setForm((f) => ({ ...f, metric: e.target.value }))}>
            {METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select className="sv-select" value={form.operator} onChange={(e) => setForm((f) => ({ ...f, operator: e.target.value }))}>
            {OPERATORS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input className="sv-input" type="number" style={{ width: 110 }} value={form.threshold}
            onChange={(e) => setForm((f) => ({ ...f, threshold: e.target.value }))} />
          <select className="sv-select" value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
          <button className="sv-btn" onClick={add}>+ Add Rule</button>
        </div>
      </div>

      <div className="sv-panel" style={{ padding: 0 }}>
        {rules.loading && !rules.data ? (
          <Loading />
        ) : rules.data && rules.data.length ? (
          <table className="sv-table">
            <thead>
              <tr><th>Scope</th><th>Metric</th><th>Condition</th><th>Severity</th><th>Enabled</th><th></th></tr>
            </thead>
            <tbody>
              {rules.data.map((r) => (
                <tr key={r.id}>
                  <td>{r.device_name || 'All devices'}</td>
                  <td>{r.metric}</td>
                  <td>{r.operator} {r.threshold}</td>
                  <td>{r.severity}</td>
                  <td>
                    <button className="sv-btn ghost sm" onClick={() => toggle(r)}>
                      {r.enabled ? 'On' : 'Off'}
                    </button>
                  </td>
                  <td><button className="sv-btn ghost sm" onClick={() => remove(r)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No alert rules defined." />
        )}
      </div>
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
          <Loading />
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
