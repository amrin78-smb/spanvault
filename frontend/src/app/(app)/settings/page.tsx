'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useApi, apiSend } from '@/lib/api';
import { useRbac } from '@/lib/rbac';
import { Loading, ErrorBox, Empty, fmtTime, PageHeader, TableSkeleton } from '@/components/ui';
import { useLicense } from '@/components/LicenseGuard';

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'email', label: 'Email Alerts' },
  { key: 'rules', label: 'Alert Rules' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'updates', label: 'Updates' },
  { key: 'about', label: 'About' },
];

export default function SettingsPage() {
  const { canManageSettings } = useRbac();
  const router = useRouter();
  const [tab, setTab] = useState('general');
  // Highlight the Updates tab with a red dot when a new version is available.
  const updates = useApi<{ available?: boolean }>('/api/system/update-available');
  const updateAvail = !!updates.data?.available;

  // Shared settings state (load/save lifted into the parent). General and Email
  // Alerts render different sections of the SAME form and both call the same
  // save(), so a save from either tab persists ALL settings fields and no field
  // is ever dropped. (The backend PUT /api/settings upserts per key, so subset
  // saves would be safe too — but a single shared state keeps it foolproof and
  // avoids two competing loads of /api/settings.)
  const settings = useApi<Record<string, string>>('/api/settings');
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);

  function set(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); setSaved(false); }

  async function save() {
    setSaving(true);
    setSaveErr(null);
    try {
      await apiSend('/api/settings', 'PUT', form);
      setSaved(true);
    } catch (e: any) {
      setSaveErr(e?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // Deep-link support: /settings?tab=updates opens the Updates tab (used by the
  // update-notifier banner).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t && TABS.some((x) => x.key === t)) setTab(t);
  }, []);

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

  const formProps = {
    settings, form, set, save, saving, saved, saveErr,
  };

  return (
    <div className="sv-settings">
      <PageHeader title="Settings" subtitle="Polling, thresholds, notifications, and alert rules." />
      <div className="sv-tabs sticky">
        {TABS.filter((t) => t.key !== 'audit' || canManageSettings).map((t) => (
          <button key={t.key} className={`sv-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.key === 'updates' && updateAvail && (
              <span
                title="Update available"
                style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                  background: '#dc2626', marginLeft: 6, verticalAlign: 'middle',
                }}
              />
            )}
          </button>
        ))}
      </div>
      {tab === 'general' && <GeneralSettings {...formProps} />}
      {tab === 'email' && <EmailAlertSettings {...formProps} />}
      {tab === 'rules' && <AlertRules />}
      {tab === 'maintenance' && <Maintenance />}
      {tab === 'audit' && canManageSettings && <AuditLog />}
      {tab === 'updates' && <SystemUpdates />}
      {tab === 'about' && <AboutSettings />}
    </div>
  );
}

// ── Shared settings form (lifted to parent) ────────────────────
type SettingsFormProps = {
  settings: { loading: boolean; error: string | null; data: Record<string, string> | null };
  form: Record<string, string>;
  set: (k: string, v: string) => void;
  save: () => Promise<void>;
  saving: boolean;
  saved: boolean;
  saveErr: string | null;
};

// Shared Save toolbar — a save from either General or Email Alerts persists ALL
// settings fields (single shared form state in the parent).
function SaveBar({ save, saving, saved }: Pick<SettingsFormProps, 'save' | 'saving' | 'saved'>) {
  return (
    <div className="sv-toolbar">
      <button className="sv-btn" onClick={save} disabled={saving}>
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
      {saved && <span style={{ color: 'var(--sv-up)', fontWeight: 600 }}>Saved ✓</span>}
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

function GeneralSettings({ settings, form, set, save, saving, saved, saveErr }: SettingsFormProps) {
  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error) return <ErrorBox message={settings.error} />;

  return (
    <div>
      {saveErr && <ErrorBox message={saveErr} />}
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

      <SaveBar save={save} saving={saving} saved={saved} />
    </div>
  );
}

// ── Email Alerts settings ──────────────────────────────────────
function EmailAlertSettings({ settings, form, set, save, saving, saved, saveErr }: SettingsFormProps) {
  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error) return <ErrorBox message={settings.error} />;

  return (
    <div>
      {saveErr && <ErrorBox message={saveErr} />}
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
        <div style={{ marginTop: 14, display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-end' }}>
          <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, margin: 0 }}>
            <input type="checkbox"
              checked={String(form.email_recovery_enabled ?? 'true').toLowerCase() !== 'false'}
              onChange={(e) => set('email_recovery_enabled', e.target.checked ? 'true' : 'false')} />
            Send recovery (“all-clear”) emails
          </label>
          <label className="sv-field" style={{ margin: 0 }}>Re-notify cooldown (minutes)
            <input className="sv-input" type="number" min={0} style={{ maxWidth: 120 }}
              value={form.notify_cooldown_minutes ?? '15'}
              onChange={(e) => set('notify_cooldown_minutes', e.target.value)} />
            <span className="sv-muted" style={{ fontSize: 11 }}>0 = no throttle. Suppresses repeat emails for a flapping alert.</span>
          </label>
          <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, margin: 0 }}>
            <input type="checkbox"
              checked={String(form.anomaly_alerts_enabled ?? 'false').toLowerCase() === 'true'}
              onChange={(e) => set('anomaly_alerts_enabled', e.target.checked ? 'true' : 'false')} />
            Alert on baseline anomalies (latency / CPU / memory deviating from normal)
          </label>
        </div>
      </div>

      <NotificationRoutes />
      <EscalationOnCall form={form} set={set} />

      <SaveBar save={save} saving={saving} saved={saved} />
    </div>
  );
}

// ── Escalation + on-call ───────────────────────────────────────
type EscStep = { id: number; step_order: number; after_minutes: number; email_to: string | null; use_oncall: boolean; enabled: boolean };
type OncallShift = { id: number; contact_email: string; starts_at: string; ends_at: string };

function EscalationOnCall({ form, set }: { form: Record<string, any>; set: (k: string, v: string) => void }) {
  const steps = useApi<EscStep[]>('/api/escalation-steps');
  const shifts = useApi<OncallShift[]>('/api/oncall-shifts');
  const [after, setAfter] = useState('15');
  const [stepTo, setStepTo] = useState('');
  const [useOncall, setUseOncall] = useState(false);
  const [shiftEmail, setShiftEmail] = useState('');
  const [shiftStart, setShiftStart] = useState('');
  const [shiftEnd, setShiftEnd] = useState('');
  const enabled = String(form.escalation_enabled ?? 'false').toLowerCase() === 'true';

  async function addStep() {
    if (!useOncall && !stepTo.trim()) return;
    await apiSend('/api/escalation-steps', 'POST', {
      after_minutes: parseInt(after, 10) || 15, email_to: stepTo.trim() || null, use_oncall: useOncall,
      step_order: (steps.data?.length || 0) + 1,
    });
    setStepTo(''); setUseOncall(false); steps.reload();
  }
  async function addShift() {
    if (!shiftEmail.trim() || !shiftStart || !shiftEnd) return;
    await apiSend('/api/oncall-shifts', 'POST', { contact_email: shiftEmail.trim(), starts_at: shiftStart, ends_at: shiftEnd });
    setShiftEmail(''); setShiftStart(''); setShiftEnd(''); shifts.reload();
  }

  return (
    <div className="sv-panel" style={{ marginTop: 12 }}>
      <h2>Escalation & On-Call</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-end', marginBottom: 12 }}>
        <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, margin: 0 }}>
          <input type="checkbox" checked={enabled}
            onChange={(e) => set('escalation_enabled', e.target.checked ? 'true' : 'false')} />
          Enable escalation
        </label>
        <label className="sv-field" style={{ margin: 0 }}>Escalate severities
          <select className="sv-input" value={form.escalation_min_severity ?? 'critical'}
            onChange={(e) => set('escalation_min_severity', e.target.value)}>
            <option value="critical">Critical only</option>
            <option value="warning">Warning &amp; Critical</option>
          </select>
        </label>
        <span className="sv-muted" style={{ fontSize: 12 }}>Unacknowledged alerts email each step in turn. Save to apply enable/severity.</span>
      </div>

      <h3 style={{ fontSize: 13, margin: '8px 0' }}>Steps</h3>
      {(steps.data || []).length > 0 && (
        <table className="sv-table" style={{ marginBottom: 10 }}>
          <thead><tr><th>Order</th><th>After (min)</th><th>Recipients</th><th></th></tr></thead>
          <tbody>
            {(steps.data || []).map((s) => (
              <tr key={s.id}>
                <td>{s.step_order}</td><td>{s.after_minutes}</td>
                <td>{s.use_oncall ? 'Current on-call' : s.email_to}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="sv-btn ghost sm" onClick={async () => { await apiSend(`/api/escalation-steps/${s.id}`, 'DELETE'); steps.reload(); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 16 }}>
        <label className="sv-field" style={{ margin: 0 }}>After (min)
          <input className="sv-input" type="number" min={1} style={{ maxWidth: 100 }} value={after} onChange={(e) => setAfter(e.target.value)} />
        </label>
        <label className="sv-field" style={{ margin: 0, flex: 1, minWidth: 200 }}>Recipients
          <input className="sv-input" value={stepTo} onChange={(e) => setStepTo(e.target.value)} placeholder="ops@x.com" disabled={useOncall} />
        </label>
        <label className="sv-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, margin: 0 }}>
          <input type="checkbox" checked={useOncall} onChange={(e) => setUseOncall(e.target.checked)} /> Use on-call
        </label>
        <button className="sv-btn" onClick={addStep}>Add step</button>
      </div>

      <h3 style={{ fontSize: 13, margin: '8px 0' }}>On-Call Shifts</h3>
      {(shifts.data || []).length > 0 && (
        <table className="sv-table" style={{ marginBottom: 10 }}>
          <thead><tr><th>Contact</th><th>From</th><th>To</th><th></th></tr></thead>
          <tbody>
            {(shifts.data || []).map((s) => (
              <tr key={s.id}>
                <td>{s.contact_email}</td><td>{fmtTime(s.starts_at)}</td><td>{fmtTime(s.ends_at)}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="sv-btn ghost sm" onClick={async () => { await apiSend(`/api/oncall-shifts/${s.id}`, 'DELETE'); shifts.reload(); }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <label className="sv-field" style={{ margin: 0, flex: 1, minWidth: 180 }}>Contact email
          <input className="sv-input" value={shiftEmail} onChange={(e) => setShiftEmail(e.target.value)} placeholder="oncall@x.com" />
        </label>
        <label className="sv-field" style={{ margin: 0 }}>From
          <input className="sv-input" type="datetime-local" value={shiftStart} onChange={(e) => setShiftStart(e.target.value)} />
        </label>
        <label className="sv-field" style={{ margin: 0 }}>To
          <input className="sv-input" type="datetime-local" value={shiftEnd} onChange={(e) => setShiftEnd(e.target.value)} />
        </label>
        <button className="sv-btn" onClick={addShift}>Add shift</button>
      </div>
    </div>
  );
}

// ── Notification routing (send matching alerts to specific recipients) ─────────
type NotifRoute = {
  id: number; name: string; match_severity: string | null;
  match_site_id: number | null; match_alert_type: string | null;
  email_to: string; enabled: boolean;
};
const ALERT_TYPE_OPTIONS = [
  { v: '', label: 'Any type' },
  { v: 'device_down', label: 'Device down' },
  { v: 'high_latency', label: 'High latency' },
  { v: 'agent_down', label: 'Agent down' },
];

function NotificationRoutes() {
  const routes = useApi<NotifRoute[]>('/api/notification-routes');
  const sites = useApi<Site[]>('/api/netvault/sites');
  const [name, setName] = useState('');
  const [emailTo, setEmailTo] = useState('');
  const [sev, setSev] = useState('');
  const [siteId, setSiteId] = useState('');
  const [atype, setAtype] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const siteName = (id: number | null) =>
    id == null ? 'Any site' : (sites.data?.find((s) => s.id === id)?.name || `Site ${id}`);

  async function add() {
    if (!name.trim() || !emailTo.trim()) { setErr('Name and recipients are required'); return; }
    setBusy(true); setErr(null);
    try {
      await apiSend('/api/notification-routes', 'POST', {
        name: name.trim(), email_to: emailTo.trim(),
        match_severity: sev || null, match_site_id: siteId || null, match_alert_type: atype || null,
      });
      setName(''); setEmailTo(''); setSev(''); setSiteId(''); setAtype('');
      routes.reload();
    } catch (e: any) { setErr(e?.message || 'Failed to add route'); }
    finally { setBusy(false); }
  }
  async function remove(id: number) {
    await apiSend(`/api/notification-routes/${id}`, 'DELETE');
    routes.reload();
  }

  const list = routes.data || [];
  return (
    <div className="sv-panel" style={{ marginTop: 12 }}>
      <h2>Notification Routing</h2>
      <p className="sv-muted" style={{ fontSize: 13, marginTop: -4 }}>
        Send alerts that match a rule to specific recipients. If no route matches an alert, it goes to the
        Alert Recipients above.
      </p>
      {err && <div className="sv-err-inline">{err}</div>}
      {list.length > 0 && (
        <table className="sv-table" style={{ marginBottom: 12 }}>
          <thead><tr><th>Name</th><th>Severity</th><th>Site</th><th>Type</th><th>Recipients</th><th></th></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.match_severity || 'Any'}</td>
                <td>{siteName(r.match_site_id)}</td>
                <td>{r.match_alert_type || 'Any'}</td>
                <td style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.email_to}</td>
                <td style={{ textAlign: 'right' }}>
                  <button className="sv-btn ghost sm" onClick={() => remove(r.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
        <label className="sv-field" style={{ margin: 0 }}>Name
          <input className="sv-input" style={{ maxWidth: 160 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. DB team" />
        </label>
        <label className="sv-field" style={{ margin: 0 }}>Severity
          <select className="sv-input" value={sev} onChange={(e) => setSev(e.target.value)}>
            <option value="">Any</option><option value="warning">Warning</option><option value="critical">Critical</option>
          </select>
        </label>
        <label className="sv-field" style={{ margin: 0 }}>Site
          <select className="sv-input" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">Any site</option>
            {(sites.data || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="sv-field" style={{ margin: 0 }}>Type
          <select className="sv-input" value={atype} onChange={(e) => setAtype(e.target.value)}>
            {ALERT_TYPE_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
          </select>
        </label>
        <label className="sv-field" style={{ margin: 0, flex: 1, minWidth: 200 }}>Recipients
          <input className="sv-input" value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="a@x.com, b@x.com" />
        </label>
        <button className="sv-btn" onClick={add} disabled={busy}>{busy ? 'Adding…' : 'Add route'}</button>
      </div>
    </div>
  );
}

// ── About ──────────────────────────────────────────────────────
const ABOUT_TOP_ROWS = [
  { label: 'Product', value: 'SpanVault — Network Monitoring' },
  { label: 'Family', value: 'NocVault Network Intelligence Suite' },
];
const ABOUT_TECH_ROWS = [
  { label: 'App Port', value: '3008' },
  { label: 'API Port', value: '3009 (internal)' },
  { label: 'Collector', value: 'ICMP + SNMP polling' },
  { label: 'Database', value: 'PostgreSQL 16' },
  { label: 'Runtime', value: 'Node.js 20 · Next.js 14' },
];

function AboutSettings() {
  const health = useApi<{ version?: string }>('/api/health');
  const version = health.data?.version || '—';
  return (
    <div>
      <div className="sv-panel">
        <h2>About</h2>
        <table className="sv-table" style={{ maxWidth: 520 }}>
          <tbody>
            {ABOUT_TOP_ROWS.map((r) => (
              <tr key={r.label}>
                <td className="sv-muted" style={{ width: 140 }}>{r.label}</td>
                <td>{r.value}</td>
              </tr>
            ))}
            <tr>
              <td className="sv-muted" style={{ width: 140 }}>Version</td>
              <td><code>v{version}</code></td>
            </tr>
            {ABOUT_TECH_ROWS.map((r) => (
              <tr key={r.label}>
                <td className="sv-muted" style={{ width: 140 }}>{r.label}</td>
                <td>{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 16, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 600 }}>SpanVault v{version}</div>
          <div className="sv-muted">Part of the NocVault Network Intelligence Suite</div>
          <div className="sv-muted">© 2026 NocVault</div>
        </div>
      </div>
    </div>
  );
}

// ── Audit log (admin) ──────────────────────────────────────────
type AuditRow = {
  id: number; ts: string; user_email: string | null; user_role: string | null;
  method: string; path: string; status: number | null; detail: any; ip: string | null;
};
function AuditLog() {
  const audit = useApi<AuditRow[]>('/api/audit', 30000);
  if (audit.loading && !audit.data) return <Loading />;
  if (audit.error) return <ErrorBox message={audit.error} />;
  const rows = audit.data || [];
  return (
    <div className="sv-panel">
      <h2>Audit Log</h2>
      <p className="sv-muted" style={{ fontSize: 13, marginTop: -4 }}>
        Recent configuration and operational changes (most recent first).
      </p>
      {!rows.length ? <Empty message="No audit entries yet." /> : (
        <table className="sv-table">
          <thead><tr><th>When</th><th>User</th><th>Role</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.ts)}</td>
                <td>{r.user_email || '—'}</td>
                <td>{r.user_role || '—'}</td>
                <td><code style={{ fontSize: 11 }}>{r.method} {r.path}</code></td>
                <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={r.detail ? JSON.stringify(r.detail) : ''}>
                  {r.detail ? JSON.stringify(r.detail) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

// ── System Updates ─────────────────────────────────────────────
type UpdateStatus = {
  current_version?: string;
  latest_version?: string;
  current_commit?: string;
  latest_commit?: string;
  up_to_date?: boolean;
  update_available?: boolean;
  release_notes?: string[];
  release_date?: string;
  error?: string;
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
// Format an ISO date "2026-06-09" → "June 9, 2026" (no timezone shifting).
function fmtReleaseDate(d?: string): string {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  if (!y || !m || !day) return d;
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

const UPDATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — covers slow npm install + Next.js build before services are back
// Once BOTH the API and the Next.js frontend are confirmed live, wait only this
// short settle window before reloading. The real wait is now driven by frontend
// liveness probes (see UpdatingOverlay), not a fixed guess.
const RELOAD_SETTLE_SECONDS = 3;
// Safety cap: if the frontend never confirms live within this window after the
// API is back, proceed to reload anyway so we never hang worse than before.
const MAX_FRONTEND_WAIT_MS = 45 * 1000;

// Broadcast so the cross-app update banner (UpdateNotifier) re-fetches its own
// availability endpoint after a manual re-check — no page reload needed.
// Kept in sync with the same constant in components/UpdateNotifier.tsx. (Page
// files may not export arbitrary values, so this is a local constant.)
const UPDATE_STATUS_REFRESHED_EVENT = 'sv:update-status-refreshed';

// Re-check / check-for-updates button with an inline loading state.
function CheckButton({ busy, onClick, label, ghost }: {
  busy: boolean; onClick: () => void; label: string; ghost?: boolean;
}) {
  return (
    <button className={`sv-btn${ghost ? ' ghost' : ''}`} onClick={onClick} disabled={busy}>
      {busy ? (<><span className="sv-spinner-sm" /> Checking…</>) : label}
    </button>
  );
}

function SystemUpdates() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);     // initial full-panel load
  const [rechecking, setRechecking] = useState(false); // button-triggered re-check
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [updating, setUpdating] = useState(false);
  const { state: licenseState } = useLicense();
  const [updateErr, setUpdateErr] = useState<string | null>(null);

  const hubUrl = process.env.NEXT_PUBLIC_NOCVAULT_HUB_URL || 'http://localhost:3000';
  const updatesBlocked = licenseState.mode === 'grace' || licenseState.mode === 'disabled';

  // isRecheck=true keeps the current panel visible and only shows the button
  // spinner; the initial mount load uses the full-panel "Checking…" view.
  async function check(isRecheck = false) {
    if (isRecheck) setRechecking(true); else setChecking(true);
    setCheckErr(null);
    try {
      const s = await apiSend<UpdateStatus>('/api/system/update-status', 'GET' as any);
      setStatus(s);
      // Let the notification banner refresh from its own endpoint.
      window.dispatchEvent(new Event(UPDATE_STATUS_REFRESHED_EVENT));
    } catch (e: any) {
      setCheckErr(e?.message || 'Could not check for updates');
    } finally {
      if (isRecheck) setRechecking(false); else setChecking(false);
    }
  }

  // Auto-load status on mount (button click still available below).
  useEffect(() => { check(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function startUpdate() {
    setConfirming(false);
    setUpdateErr(null);
    setUpdating(true);
    try {
      const res = await fetch('/api/system/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.status === 402) {
        const j = await res.json().catch(() => ({} as any));
        setUpdating(false);
        setUpdateErr(j?.error || 'License expired — updates are disabled.');
        return;
      }
      // Any other response (including one cut off by a fast service restart)
      // falls through to the updating overlay so health polling detects recovery.
    } catch (e: any) {
      // Response cut off by a fast restart — keep the overlay; health polling recovers.
    }
  }

  const hasError = !!(status?.error) || !!checkErr;
  const errText = status?.error || checkErr;
  const upToDate = !hasError && !!status?.up_to_date;
  const updatesAvailable = !hasError && !!status?.update_available;

  return (
    <div>
      <div className="sv-panel">
        <h2>Software Updates</h2>

        {checking ? (
          <p className="sv-muted"><span className="sv-spinner-sm" /> Checking for updates…</p>
        ) : hasError ? (
          <div style={{ marginTop: 8 }}>
            <p style={{ color: 'var(--sv-down, #C8102E)', fontWeight: 600 }}>{errText}</p>
            {status?.current_version && (
              <p className="sv-muted">Current version: <code>v{status.current_version}</code></p>
            )}
            <CheckButton busy={rechecking} onClick={() => check(true)} label="Check for Updates" />
          </div>
        ) : upToDate ? (
          <div style={{ marginTop: 8 }}>
            <p style={{ color: 'var(--sv-up, #16a34a)', fontWeight: 600 }}>✓ SpanVault is up to date</p>
            <div className="sv-toolbar">
              <span className="sv-muted">Current version: <code>v{status?.current_version}</code></span>
              <CheckButton busy={rechecking} onClick={() => check(true)} label="Re-check" ghost />
            </div>
          </div>
        ) : updatesAvailable ? (
          <div style={{ marginTop: 8 }}>
            <p style={{ fontWeight: 700, fontSize: 16 }}>
              {status?.current_version === status?.latest_version
                ? <>🔄 Patches available since v{status?.current_version}</>
                : <>🔄 Update available: v{status?.current_version} → v{status?.latest_version}</>}
            </p>
            {(status?.current_commit || status?.latest_commit) && (
              <p className="sv-muted" style={{ fontSize: 13 }}>
                Current: v{status?.current_version}
                {status?.current_commit && <> (<code>{status.current_commit}</code>)</>}
                {'  →  '}
                Latest: v{status?.latest_version}
                {status?.latest_commit && <> (<code>{status.latest_commit}</code>)</>}
              </p>
            )}
            {status?.release_notes && status.release_notes.length > 0 && (
              <div style={{ margin: '12px 0' }}>
                <strong>What&apos;s new in v{status?.latest_version}</strong>
                <ul style={{
                  marginTop: 6, marginBottom: 0, paddingLeft: 20,
                  fontSize: 13, lineHeight: 1.6,
                }}>
                  {status.release_notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {status?.release_date && (
              <p className="sv-muted" style={{ fontSize: 13 }}>
                Released: {fmtReleaseDate(status.release_date)}
              </p>
            )}
            <p style={{ color: 'var(--sv-warn, #d97706)', fontWeight: 600 }}>
              ⚠ Services will restart during the update — you may lose connection for 30–60 seconds.
            </p>
            <div className="sv-toolbar">
              <button
                className="sv-btn"
                onClick={() => setConfirming(true)}
                disabled={updatesBlocked}
                style={updatesBlocked ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
              >
                Update Now
              </button>
              <CheckButton busy={rechecking} onClick={() => check(true)} label="Re-check" ghost />
            </div>
            {licenseState.mode === 'grace' && (
              <p style={{ marginTop: 10, color: 'var(--sv-warn, #d97706)', fontWeight: 600 }}>
                ⚠ License expired — updates disabled. Renew your license to receive updates.{' '}
                <a href={`${hubUrl}/settings/license`} target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--sv-warn, #d97706)', textDecoration: 'underline' }}>
                  Manage License →
                </a>
              </p>
            )}
            {licenseState.mode === 'disabled' && (
              <p style={{ marginTop: 10, color: 'var(--sv-down, #C8102E)', fontWeight: 600 }}>
                🔒 License expired — updates disabled. Renew your license to receive updates.{' '}
                <a href={`${hubUrl}/settings/license`} target="_blank" rel="noopener noreferrer"
                  style={{ color: 'var(--sv-down, #C8102E)', textDecoration: 'underline' }}>
                  Manage License →
                </a>
              </p>
            )}
            {licenseState.mode === 'trial' && (
              <p className="sv-muted" style={{ marginTop: 10, fontSize: 13 }}>
                Trial license — updates enabled
              </p>
            )}
            {updateErr && (
              <p style={{ marginTop: 10, color: 'var(--sv-down, #C8102E)', fontWeight: 600 }}>{updateErr}</p>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 8 }}>
            <CheckButton busy={rechecking} onClick={() => check(true)} label="Check for Updates" />
          </div>
        )}
      </div>

      {confirming && (
        <UpdateConfirmModal
          onCancel={() => setConfirming(false)}
          onConfirm={startUpdate}
        />
      )}

      {updating && <UpdatingOverlay />}
    </div>
  );
}

// Confirmation modal (top-level).
function UpdateConfirmModal({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="sv-modal-backdrop" onMouseDown={onCancel}>
      <div className="sv-modal" style={{ maxWidth: 460 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>Start Update?</h2>
        <p>Services will restart and you&apos;ll lose connection for 30–60 seconds. The page reloads automatically when the update completes.</p>
        <div className="sv-modal-actions">
          <button className="sv-btn ghost" onClick={onCancel}>Cancel</button>
          <button className="sv-btn" onClick={onConfirm}>Start Update</button>
        </div>
      </div>
    </div>
  );
}

// Full-screen overlay shown during an update; polls for recovery.
// State machine: 'starting' → 'down' → 'api_up' → 'back_up' (+ 'timeout').
//  - 'down'   : a probe failed at least once, so we know a restart is underway.
//  - 'api_up' : /api/health is stably back (3 consecutive OK after going down),
//               but the API (:3009) returning does NOT mean the Next.js frontend
//               (:3008, started LAST by the installer) is serving pages yet. So
//               we now poll a frontend-served static asset for real liveness.
//  - 'back_up': the frontend is confirmed live → short settle countdown → reload.
// A healthy /api/health response only counts as recovery once the API has
// actually been seen down first, so we never declare "complete" against the
// still-running pre-restart service.
function UpdatingOverlay() {
  const [phase, setPhase] = useState<'starting' | 'down' | 'api_up' | 'back_up' | 'timeout'>('starting');
  const [countdown, setCountdown] = useState(RELOAD_SETTLE_SECONDS);
  const wentDown = useRef(false);
  const consecutiveUp = useRef(0);

  // Navigate to the dashboard with a success banner. Used by both the countdown
  // and the "Reload Now" button (which skips the remaining countdown).
  const reloadToDashboard = () => { window.location.href = '/?updated=true'; };

  // Phase 1: poll /api/health until the API is stably back up after going down.
  useEffect(() => {
    let active = true;
    const startedAt = Date.now();
    let pollId: ReturnType<typeof setInterval> | null = null;

    function stopPolling() {
      if (pollId !== null) { clearInterval(pollId); pollId = null; }
    }

    const tick = async () => {
      if (!active) return;
      if (Date.now() - startedAt > UPDATE_TIMEOUT_MS) {
        stopPolling();
        if (active) setPhase('timeout');
        return;
      }

      // Per-poll timeout via AbortController so a hung connection during the
      // restart still resolves as "down" within the polling cadence rather than
      // blocking detection until the browser's default fetch timeout. Kept under
      // the 2s poll interval so probes don't pile up.
      const ctrl = new AbortController();
      const abortId = setTimeout(() => ctrl.abort(), 1800);
      let ok = false;
      try {
        const res = await fetch('/api/health', { cache: 'no-store', signal: ctrl.signal });
        ok = res.ok; // non-200 counts as down
      } catch {
        ok = false;
      } finally {
        clearTimeout(abortId);
      }
      if (!active) return;

      if (!ok) {
        // Fetch failed or non-200 → API is down (restarting). Reset the
        // consecutive-success counter: during startup the API can answer one
        // probe then drop again, so any failure restarts the stability window.
        consecutiveUp.current = 0;
        wentDown.current = true;
        setPhase('down');
        return;
      }

      // Healthy response. Only a recovery if we previously saw it go down.
      if (wentDown.current) {
        // Require 3 consecutive healthy probes (≈6s at the 2s cadence) before
        // declaring the API stably back up. A single success after going down
        // isn't enough — services may respond once then briefly drop again
        // mid-startup, which would trigger a premature reload.
        consecutiveUp.current += 1;
        if (consecutiveUp.current >= 3) {
          // API is stably back. Hand off to the frontend-liveness phase below —
          // the API returning does NOT mean Next.js is serving pages yet.
          stopPolling();
          setPhase('api_up');
        }
      }
      // else: still the pre-restart API — keep waiting for it to go down.
    };

    pollId = setInterval(tick, 2000); // poll every 2 seconds
    tick(); // immediate first poll

    return () => {
      active = false;
      stopPolling();
    };
  }, []);

  // Phase 2: once the API is back ('api_up'), poll a frontend-served static asset
  // (/spanvault-logo.svg on :3008) to confirm the Next.js app is actually serving
  // pages before we reload. Require 2 consecutive 200s. Safety fallback: if this
  // takes longer than MAX_FRONTEND_WAIT_MS, proceed to 'back_up' anyway so we
  // never hang worse than the old fixed-delay behavior.
  useEffect(() => {
    if (phase !== 'api_up') return;
    let active = true;
    const startedAt = Date.now();
    let pollId: ReturnType<typeof setInterval> | null = null;
    let consecutiveFrontendUp = 0;

    function stopPolling() {
      if (pollId !== null) { clearInterval(pollId); pollId = null; }
    }

    const tick = async () => {
      if (!active) return;
      if (Date.now() - startedAt > MAX_FRONTEND_WAIT_MS) {
        // Frontend never confirmed live in time — proceed anyway rather than hang.
        stopPolling();
        if (active) setPhase('back_up');
        return;
      }

      const ctrl = new AbortController();
      const abortId = setTimeout(() => ctrl.abort(), 1500);
      let ok = false;
      try {
        const res = await fetch('/spanvault-logo.svg?_=' + Date.now(), { cache: 'no-store', signal: ctrl.signal });
        ok = res.ok; // 200 from the frontend means it's serving
      } catch {
        ok = false;
      } finally {
        clearTimeout(abortId);
      }
      if (!active) return;

      if (!ok) {
        consecutiveFrontendUp = 0;
        return;
      }
      consecutiveFrontendUp += 1;
      if (consecutiveFrontendUp >= 2) {
        stopPolling();
        setPhase('back_up');
      }
    };

    pollId = setInterval(tick, 1500); // poll every 1.5 seconds
    tick(); // immediate first poll

    return () => {
      active = false;
      stopPolling();
    };
  }, [phase]);

  // Phase 3: frontend is confirmed live — short settle countdown, then reload.
  useEffect(() => {
    if (phase !== 'back_up') return;
    if (countdown <= 0) { reloadToDashboard(); return; }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [phase, countdown]);

  let statusLine = 'Starting update…';
  if (phase === 'down') statusLine = 'Services restarting… ⟳';
  else if (phase === 'api_up') statusLine = 'API is back. Waiting for the web app to start…';
  else if (phase === 'back_up') {
    statusLine = `✓ Services are back online. Reloading in ${countdown} second${countdown === 1 ? '' : 's'}…`;
  } else if (phase === 'timeout') statusLine = 'Update is taking longer than expected. Try refreshing the page manually.';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'rgba(15,23,42,0.78)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div className="sv-panel" style={{ maxWidth: 440, textAlign: 'center', width: '100%' }}>
        {phase !== 'back_up' && phase !== 'timeout' && (
          <div style={{ fontSize: 44, lineHeight: 1, display: 'inline-block', animation: 'spin 1s linear infinite' }}>⟳</div>
        )}
        {phase === 'back_up' && <div style={{ fontSize: 44, lineHeight: 1 }}>✓</div>}
        {phase === 'timeout' && <div style={{ fontSize: 44, lineHeight: 1 }}>⚠</div>}
        <h2 style={{ marginTop: 14 }}>Updating SpanVault…</h2>
        <p className="sv-muted">Pulling latest code and restarting services. Do not close this window.</p>
        <p style={{ fontWeight: 600, margin: '14px 0' }}>{statusLine}</p>
        {phase === 'back_up' && (
          <div style={{ fontSize: 40, fontWeight: 800, lineHeight: 1, margin: '4px 0 10px', color: 'var(--primary)' }}>
            {countdown}
          </div>
        )}
        {phase !== 'back_up' && (
          <p className="sv-muted" style={{ fontSize: 12 }}>(This usually takes 1-3 minutes)</p>
        )}
        <button
          className="sv-btn"
          style={{ marginTop: 10 }}
          onClick={phase === 'back_up' ? reloadToDashboard : () => window.location.reload()}
        >
          Reload Now
        </button>
      </div>
    </div>
  );
}
