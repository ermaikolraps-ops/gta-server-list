import type { ParamEntry } from '@tio/shared';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { type AppState, useStore } from './store';

type TickKey = keyof AppState['ticks'];

/** GET a JSON endpoint and refetch whenever one of the given ticks changes. */
export function useApi<T>(path: string | null, ticks: TickKey[] = []): { data: T | null; reload: () => void } {
  const tickValues = useStore((s) => ticks.map((k) => s.ticks[k]).join(','));
  const [data, setData] = useState<T | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>('GET', path).then(
      (d) => live && setData(d),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [path, tickValues, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, reload };
}

let paramsCache: Map<string, unknown> | null = null;
let paramsPromise: Promise<Map<string, unknown>> | null = null;

/** Game parameters by dotted path (prices, radii…), fetched once. */
export function useParams(): Map<string, unknown> | null {
  const [p, setP] = useState(paramsCache);
  useEffect(() => {
    if (paramsCache) return;
    paramsPromise ??= api<{ params: ParamEntry[] }>('GET', '/api/params').then((r) => {
      paramsCache = new Map(r.params.map((e) => [e.path, e.value]));
      return paramsCache;
    });
    void paramsPromise.then(setP);
  }, []);
  return p;
}

export function num(params: Map<string, unknown> | null, path: string): number {
  return Number(params?.get(path) ?? 0);
}
