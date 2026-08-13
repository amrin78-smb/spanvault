'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Same-origin fetch — Next rewrites /api/* (except /api/auth/*) to the Express API.
 *
 * `onMeta` receives the response headers before the body is parsed. Routes that
 * cap their result set (e.g. /api/intelligence/anomalies) report the true total
 * in `X-Total-Count` so the UI can say "showing 200 of 2,137" instead of
 * presenting a truncated page as if it were everything.
 */
export async function apiGet<T = any>(
  path: string,
  signal?: AbortSignal,
  onMeta?: (headers: Headers) => void
): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  if (onMeta) onMeta(res.headers);
  return res.json();
}

export async function apiSend<T = any>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: any
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${method} ${path} → ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

/** Polling-capable GET hook. */
export function useApi<T = any>(path: string | null, pollMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Response headers of the most recent successful GET. Additive — existing
  // callers ignore it; callers of a result-capped route read `X-Total-Count`.
  const [headers, setHeaders] = useState<Headers | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  // Out-of-order guard: a monotonic sequence + an AbortController so a slow
  // earlier response can never overwrite a newer one's data (e.g. fast-changing
  // search/filter querystrings). Backward-compatible — same return shape; only
  // stale/aborted responses are ignored.
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    const seq = ++seqRef.current;
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      let h: Headers | null = null;
      const d = await apiGet<T>(p, ctrl.signal, (hh) => { h = hh; });
      if (seq !== seqRef.current) return; // superseded by a newer request
      setData(d);
      setHeaders(h);
      setError(null);
    } catch (e: any) {
      if (ctrl.signal.aborted || seq !== seqRef.current) return; // aborted/stale
      setError(e?.message || 'Request failed');
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    reload();
    if (pollMs > 0) {
      const id = setInterval(reload, pollMs);
      return () => clearInterval(id);
    }
  }, [path, pollMs, reload]);

  // Abort any in-flight request on unmount.
  useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

  return { data, error, loading, reload, headers };
}
