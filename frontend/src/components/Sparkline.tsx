'use client';

// Compact, dependency-free SVG sparkline for inline list rendering (no recharts
// — too heavy per row). Renders one <rect> per data point. A null value is drawn
// as a short grey "no data" bar; a zero value can be drawn in `zeroColor` (used
// by the response sparkline where 0 = down).
export interface SparklineProps {
  data: (number | null)[];
  color: string;
  width?: number;
  height?: number;
  /** Color for zero-valued bars (e.g. "down" on the response sparkline). */
  zeroColor?: string;
  /** Value mapped to full bar height. Defaults to the max value in `data`. */
  max?: number;
  /** Tooltip / accessible label. */
  title?: string;
}

const NO_DATA = '#cbd5e1';

export function Sparkline({
  data, color, width = 60, height = 20, zeroColor, max, title,
}: SparklineProps) {
  const n = data.length || 1;
  const step = width / n;
  const barW = Math.max(1, step - 0.6);
  const nums = data.filter((v): v is number => v != null);
  const peak = max ?? Math.max(1, ...nums);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sv-sparkline"
      role="img"
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {data.map((v, i) => {
        let fill = color;
        let h: number;
        if (v == null) {
          fill = NO_DATA;
          h = height * 0.3;
        } else if (v === 0 && zeroColor) {
          fill = zeroColor;
          h = height;
        } else {
          const frac = Math.max(0.12, Math.min(1, v / peak));
          h = height * frac;
        }
        return (
          <rect key={i} x={i * step} y={height - h} width={barW} height={h} rx={0.4} fill={fill} />
        );
      })}
    </svg>
  );
}
