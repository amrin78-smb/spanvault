/**
 * mapExport.ts — Network-map SVG export helpers (browser/DOM only).
 *
 * Exports a rendered network-map <svg> (the `.sv-mapview` element produced by
 * SVGMapView) to downloadable SVG and PNG files.
 *
 * SVG export is LOSSLESS: it serializes the live SVG markup, so everything the
 * browser rendered — including the box-style node labels drawn with
 * <foreignObject> (HTML inside SVG) — is preserved exactly.
 *
 * PNG export RASTERIZES the SVG via an offscreen Image + canvas. This is
 * convenient for sharing/embedding, but it has a known browser limitation:
 * some browsers do NOT render <foreignObject> content when an SVG is loaded as
 * an <img>/data URL, so HTML-based node labels MAY be missing or blank in the
 * PNG. This is a browser behavior, not a bug here — when fidelity matters, use
 * the SVG export, which always preserves foreignObject content.
 *
 * No React, no external dependencies, no hardcoded URLs.
 */

interface MapSize {
  width: number;
  height: number;
}

/**
 * Read the SVG's intrinsic size from its viewBox ("minX minY width height"),
 * falling back to clientWidth/clientHeight, and finally to 1600x900.
 */
function readSvgSize(svg: SVGSVGElement): MapSize {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      const width = parts[2];
      const height = parts[3];
      if (width > 0 && height > 0) {
        return { width, height };
      }
    }
  }

  const cw = svg.clientWidth;
  const ch = svg.clientHeight;
  if (cw > 0 && ch > 0) {
    return { width: cw, height: ch };
  }

  return { width: 1600, height: 900 };
}

/**
 * Clone the SVG (so the live DOM is untouched), stamp the XML namespaces and
 * explicit width/height attributes, and serialize to a string.
 */
function serializeSvg(svg: SVGSVGElement, size: MapSize): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(size.width));
  clone.setAttribute('height', String(size.height));
  return new XMLSerializer().serializeToString(clone);
}

/**
 * Trigger a browser download for the given Blob using a temporary anchor.
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export the rendered network map as a downloadable .svg file (lossless).
 */
export function downloadMapSvg(svg: SVGSVGElement, filename: string): void {
  const size = readSvgSize(svg);
  const svgString = serializeSvg(svg, size);
  const withProlog = '<?xml version="1.0" encoding="UTF-8"?>\n' + svgString;
  const blob = new Blob([withProlog], { type: 'image/svg+xml;charset=utf-8' });
  triggerDownload(blob, filename);
}

/**
 * Export the rendered network map as a downloadable .png file by rasterizing
 * the SVG. `scale` (default 2) multiplies the output resolution.
 *
 * NOTE: <foreignObject> (HTML) node labels may not appear in the PNG in some
 * browsers — see the file header. Use downloadMapSvg for guaranteed fidelity.
 */
export async function downloadMapPng(
  svg: SVGSVGElement,
  filename: string,
  scale: number = 2
): Promise<void> {
  const size = readSvgSize(svg);
  const svgString = serializeSvg(svg, size);
  // A data URL avoids canvas tainting more reliably than a blob URL for SVG.
  const dataUrl =
    'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);

  const outWidth = Math.max(1, Math.round(size.width * scale));
  const outHeight = Math.max(1, Math.round(size.height * scale));

  await new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = outWidth;
        canvas.height = outHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get 2D canvas context for PNG export.'));
          return;
        }

        // White background fallback so transparent areas are not black.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, outWidth, outHeight);

        ctx.drawImage(img, 0, 0, outWidth, outHeight);

        canvas.toBlob((blob) => {
          if (!blob) {
            reject(new Error('Canvas produced no PNG blob (toBlob returned null).'));
            return;
          }
          triggerDownload(blob, filename);
          resolve();
        }, 'image/png');
      } catch (err) {
        reject(
          new Error(
            'Failed to rasterize SVG to PNG: ' +
              (err instanceof Error ? err.message : String(err))
          )
        );
      }
    };

    img.onerror = () => {
      reject(new Error('Failed to load SVG image for PNG export.'));
    };

    img.src = dataUrl;
  });
}
