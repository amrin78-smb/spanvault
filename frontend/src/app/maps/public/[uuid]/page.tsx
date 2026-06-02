'use client';

import { useParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import SVGMapView from '@/components/SVGMapView';
import { Loading, ErrorBox, Empty } from '@/components/ui';
import { normalizeMap, type FullMap } from '@/lib/mapTypes';

export default function PublicMapPage() {
  const { uuid } = useParams<{ uuid: string }>();
  const map = useApi<FullMap>(`/api/maps/public/${uuid}`, 0); // loaded once; SVGMapView polls status

  return (
    <div className="sv-public-map">
      <header className="sv-public-head">
        <div className="brand">
          <span className="logo">SpanVault</span>
          <span className="sep">·</span>
          <span className="ttl">Live Network Map</span>
        </div>
        <div className="refresh">
          <span className="dot" /> Auto-refreshing every 30s
        </div>
      </header>

      <div className="sv-public-canvas">
        {map.loading && !map.data ? (
          <Loading />
        ) : map.error ? (
          <ErrorBox message="This map is not available. It may be private or no longer exist." />
        ) : !map.data ? (
          <Empty message="Map not found." />
        ) : (
          <SVGMapView map={normalizeMap(map.data)} refreshUrl={`/api/maps/public/${uuid}`} />
        )}
      </div>

      <footer className="sv-public-foot">
        {map.data ? map.data.name : ''} — powered by SpanVault NMS
      </footer>
    </div>
  );
}
