/**
 * mapIcons.tsx — built-in SVG glyph set for the network map designer.
 *
 * All artwork is inline path data drawn in a 24×24 coordinate box (no external
 * icon dependency, a few KB total). Used both as device-node glyphs (node_style
 * 'icon') and as decorative, non-device map shapes (cloud/internet/router/…).
 *
 * Embed inside the canvas <svg> with <MapGlyph .../> (positions + scales a <g>),
 * or render a standalone preview with <GlyphSwatch .../> for palettes.
 */
import React from 'react';

// Device-node glyph options (used when a node's node_style = 'icon').
export const DEVICE_GLYPHS: { key: string; label: string }[] = [
  { key: 'auto', label: 'Auto (by type)' },
  { key: 'router', label: 'Router' },
  { key: 'switch', label: 'Switch' },
  { key: 'firewall', label: 'Firewall' },
  { key: 'server', label: 'Server' },
  { key: 'ap', label: 'Access Point' },
  { key: 'loadbalancer', label: 'Load Balancer' },
  { key: 'database', label: 'Database' },
  { key: 'generic', label: 'Generic Device' },
];

// Decorative network glyphs for the Shapes palette.
export const SHAPE_GLYPHS: { key: string; label: string }[] = [
  { key: 'cloud', label: 'Cloud' },
  { key: 'internet', label: 'Internet' },
  { key: 'wan', label: 'WAN' },
  { key: 'router', label: 'Router' },
  { key: 'switch', label: 'Switch' },
  { key: 'firewall', label: 'Firewall' },
  { key: 'server', label: 'Server' },
  { key: 'loadbalancer', label: 'Load Balancer' },
  { key: 'ap', label: 'Access Point' },
  { key: 'database', label: 'Database' },
  { key: 'building', label: 'Building / Site' },
];

// Basic (geometric) decorative shapes.
export const BASIC_SHAPES: { key: string; label: string }[] = [
  { key: 'rect', label: 'Rectangle' },
  { key: 'ellipse', label: 'Ellipse' },
  { key: 'zone', label: 'Zone box' },
  { key: 'line', label: 'Line' },
  { key: 'arrow', label: 'Arrow' },
  { key: 'text', label: 'Text' },
];

const GLYPH_KEYS = new Set([
  ...DEVICE_GLYPHS.map((g) => g.key), ...SHAPE_GLYPHS.map((g) => g.key),
]);
export function isGlyphKind(kind: string): boolean {
  return GLYPH_KEYS.has(kind);
}

// Pick a glyph key from a device's type/name string.
export function deviceGlyphFor(typeOrName?: string | null): string {
  const s = (typeOrName || '').toLowerCase();
  if (/fire ?wall|fortigate|palo|\basa\b|srx/.test(s)) return 'firewall';
  if (/switch|catalyst|nexus|procurve|\bsw\b/.test(s)) return 'switch';
  if (/router|gateway|edge|mpls|\bwan\b/.test(s)) return 'router';
  if (/access point|\bap\b|wireless|\bwlan\b|\bwlc\b/.test(s)) return 'ap';
  if (/load ?balancer|\blb\b|\bf5\b|netscaler/.test(s)) return 'loadbalancer';
  if (/database|\bdb\b|\bsql\b|oracle/.test(s)) return 'database';
  if (/server|host|\bvm\b|esxi|linux|windows/.test(s)) return 'server';
  return 'generic';
}

// Vector art for a glyph in 24×24 space, stroked (and lightly filled) in `color`.
export function glyphArt(kind: string, color: string): React.ReactNode {
  const s = {
    stroke: color, strokeWidth: 1.7, fill: 'none',
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  const soft = { fill: color, fillOpacity: 0.12 };
  switch (kind) {
    case 'router':
      return (<>
        <circle cx="12" cy="12" r="6.5" {...s} {...soft} />
        <path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M7.4 7.4l2.2 2.2M16.6 7.4l-2.2 2.2M7.4 16.6l2.2-2.2M16.6 16.6l-2.2-2.2" {...s} />
      </>);
    case 'switch':
      return (<>
        <rect x="3" y="8.5" width="18" height="7" rx="1.5" {...s} {...soft} />
        <path d="M6 8.5V5M10 8.5V5M14 8.5V5M18 8.5V5M6 15.5V19M10 15.5V19M14 15.5V19M18 15.5V19" {...s} />
      </>);
    case 'firewall':
      return (<>
        <rect x="3" y="5" width="18" height="14" rx="1" {...s} {...soft} />
        <path d="M3 9.7h18M3 14.3h18M9 5v4.7M15 5v4.7M6 9.7v4.6M12 9.7v4.6M18 9.7v4.6M9 14.3V19M15 14.3V19" {...s} />
      </>);
    case 'server':
      return (<>
        <rect x="5" y="3" width="14" height="18" rx="1.5" {...s} {...soft} />
        <path d="M5 9h14M5 15h14" {...s} />
        <circle cx="8" cy="6" r="0.9" fill={color} stroke="none" />
        <circle cx="8" cy="12" r="0.9" fill={color} stroke="none" />
        <circle cx="8" cy="18" r="0.9" fill={color} stroke="none" />
      </>);
    case 'ap':
      return (<>
        <rect x="8" y="14" width="8" height="6" rx="1.2" {...s} {...soft} />
        <path d="M6.5 11a7.5 7.5 0 0 1 11 0M9 13a4 4 0 0 1 6 0" {...s} />
        <circle cx="12" cy="17" r="0.9" fill={color} stroke="none" />
      </>);
    case 'loadbalancer':
      return (<>
        <rect x="9" y="9" width="6" height="6" rx="1.2" {...s} {...soft} />
        <path d="M12 9V4M6 20l3.2-5M18 20l-3.2-5" {...s} />
      </>);
    case 'database':
      return (<>
        <ellipse cx="12" cy="6" rx="7" ry="3" {...s} {...soft} />
        <path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" {...s} />
        <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" {...s} />
      </>);
    case 'cloud':
      return (
        <path d="M7 18h10a4 4 0 0 0 .45-7.97A6 6 0 0 0 6 9.6 3.5 3.5 0 0 0 7 18z" {...s} {...soft} />
      );
    case 'internet':
      return (<>
        <circle cx="12" cy="12" r="8.5" {...s} {...soft} />
        <path d="M3.5 12h17M12 3.5c3.2 3 3.2 14 0 17M12 3.5c-3.2 3-3.2 14 0 17" {...s} />
      </>);
    case 'wan':
      return (<>
        <circle cx="12" cy="12" r="7.5" {...s} {...soft} />
        <path d="M4.5 12h15M12 4.5v15M6.7 6.7l10.6 10.6M17.3 6.7L6.7 17.3" {...s} />
      </>);
    case 'building':
      return (<>
        <rect x="5" y="3" width="14" height="18" rx="0.8" {...s} {...soft} />
        <path d="M8 7h2M14 7h2M8 11h2M14 11h2M8 15h2M14 15h2" {...s} />
        <rect x="10.5" y="16.5" width="3" height="4.5" {...s} />
      </>);
    case 'generic':
    default:
      return (<>
        <rect x="3" y="4.5" width="18" height="12" rx="1.5" {...s} {...soft} />
        <path d="M9 20.5h6M12 16.5v4" {...s} />
      </>);
  }
}

// Embed a glyph inside the canvas <svg> at (x,y), scaled to `size`×`size`.
export function MapGlyph({ kind, x, y, size, color }: {
  kind: string; x: number; y: number; size: number; color: string;
}) {
  return (
    <g transform={`translate(${x},${y}) scale(${size / 24})`}>{glyphArt(kind, color)}</g>
  );
}

// Standalone preview (HTML context) for palettes / pickers.
export function GlyphSwatch({ kind, size = 22, color = '#334155' }: {
  kind: string; size?: number; color?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>{glyphArt(kind, color)}</svg>
  );
}
