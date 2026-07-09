'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Same-origin fetch — Next rewrites /api/* (except /api/auth/*) to the Express API. */
export async function apiGet<T = any>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
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
      const d = await apiGet<T>(p, ctrl.signal);
      if (seq !== seqRef.current) return; // superseded by a newer request
      setData(d);
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

  return { data, error, loading, reload };
}
