'use client';

import Link from 'next/link';
import { useApi } from '@/lib/api';
import { StatusDot } from '@/components/StatusDot';
import { Loading, ErrorBox, Empty } from '@/components/ui';

type Node = { id: number; name: string; ip_address: string; device_type: string | null; status: string };
type Site = { site_id: number; site_name: string; devices: Node[] };

export default function MapPage() {
  const map = useApi<Site[]>('/api/map', 20000);

  return (
    <div>
      <h1 className="sv-page-title">Network Map</h1>
      <p className="sv-page-sub">Monitored devices grouped by site.</p>

      {map.error && <ErrorBox message={map.error} />}
      {map.loading && !map.data ? (
        <Loading />
      ) : map.data && map.data.length ? (
        map.data.map((site) => {
          const down = site.devices.filter((d) => d.status === 'down').length;
          const warn = site.devices.filter((d) => d.status === 'warning').length;
          return (
            <div className="sv-map-site" key={site.site_id}>
              <h3>
                {site.site_name}
                <span className="sv-muted" style={{ fontWeight: 400, fontSize: 13 }}>
                  · {site.devices.length} device(s)
                  {down ? ` · ${down} down` : ''}
                  {warn ? ` · ${warn} warning` : ''}
                </span>
              </h3>
              <div className="sv-map-grid">
                {site.devices.map((d) => (
                  <Link key={d.id} href={`/devices/${d.id}`} className={`sv-node ${d.status}`}>
                    <div className="nm" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <StatusDot status={d.status} size={9} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                    </div>
                    <div className="ip">{d.ip_address}</div>
                    <div className="ty">{d.device_type || 'device'}</div>
                  </Link>
                ))}
              </div>
            </div>
          );
        })
      ) : (
        <Empty message="No monitored devices to display." />
      )}
    </div>
  );
}
