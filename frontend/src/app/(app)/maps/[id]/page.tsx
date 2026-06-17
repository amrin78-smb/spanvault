'use client';

import { useRef } from 'react';
import { useParams } from 'next/navigation';
import { useApi } from '@/lib/api';
import SVGMapView from '@/components/SVGMapView';
import { Loading, ErrorBox, Empty } from '@/components/ui';
import { normalizeMap, type FullMap } from '@/lib/mapTypes';
import { downloadMapSvg, downloadMapPng } from '@/lib/mapExport';

export default function MapViewPage() {
  const { id } = useParams<{ id: string }>();
  const map = useApi<FullMap>(`/api/maps/${id}`, 0); // loaded once; SVGMapView polls status
  const frameRef = useRef<HTMLDivElement | null>(null);

  if (map.loading && !map.data) return <Loading />;
  if (map.error) return <ErrorBox message={map.error} />;
  if (!map.data) return <Empty message="Map not found." />;

  const full = normalizeMap(map.data);
  const fileBase = (full.name || 'map').replace(/[^\w.-]+/g, '_');
  function mapSvg(): SVGSVGElement | null {
    return frameRef.current?.querySelector('svg.sv-mapview') ?? null;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
        <a href="/maps" className="sv-btn ghost sm">← Maps</a>
        <h1 className="sv-page-title" style={{ margin: 0 }}>{full.name}</h1>
        {full.is_public && <span className="sv-map-public" style={{ position: 'static' }}>Public</span>}
        <div style={{ flex: 1 }} />
        <button className="sv-btn ghost sm tint-teal" onClick={() => { const s = mapSvg(); if (s) downloadMapSvg(s, `${fileBase}.svg`); }}>Export SVG</button>
        <button className="sv-btn ghost sm tint-teal" onClick={() => { const s = mapSvg(); if (s) downloadMapPng(s, `${fileBase}.png`).catch(() => {}); }}>Export PNG</button>
        <a href={`/maps/${id}/edit`} className="sv-btn">Edit</a>
      </div>
      {full.description && <p className="sv-page-sub" style={{ marginTop: -4 }}>{full.description}</p>}

      <div ref={frameRef} className="sv-mapview-frame" style={{ aspectRatio: `${full.canvas_w} / ${full.canvas_h}` }}>
        <SVGMapView map={full} refreshUrl={`/api/maps/${id}`} interactive />
      </div>
    </div>
  );
}
