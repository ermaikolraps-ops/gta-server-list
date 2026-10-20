import type { GpsResult, Profile } from '@tio/shared';
import { useSyncExternalStore } from 'react';

export type PanelId =
  | 'drones'
  | 'army'
  | 'wars'
  | 'alliance'
  | 'more'
  | 'bases'
  | 'ships'
  | 'rankings'
  | 'notifications'
  | 'settings'
  | 'rules';

export type GpsState = 'off' | 'waiting' | 'on' | 'denied' | 'unavailable';

/** What a map tap means right now. */
export type MapMode =
  | { kind: 'browse' }
  | { kind: 'drone-targets'; droneId: string; radiusKm: number; selected: number[] }
  | { kind: 'army-destination'; armyId: string }
  | { kind: 'war-sector'; armyIds: string[]; selected: number[] };

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'good' | 'bad';
}

export interface AppState {
  authChecked: boolean;
  me: Profile | null;
  /** Client time when `me` was fetched, to tick credits smoothly. */
  meAt: number;
  gps: {
    state: GpsState;
    lat?: number;
    lon?: number;
    accuracy?: number;
    last?: GpsResult;
    lastAt?: number;
  };
  connection: 'connecting' | 'open' | 'closed';
  panel: PanelId | null;
  mapMode: MapMode;
  toasts: Toast[];
  /** Bumped when server data may have changed, so views refetch. */
  ticks: { territory: number; drones: number; armies: number; wars: number; alliance: number; notifications: number };
  focus: { lat: number; lon: number; zoom?: number } | null;
  /** Shown while the player is asked to tap the map. */
  pickHint: import('./i18n').MessageKey | null;
}

const initial: AppState = {
  authChecked: false,
  me: null,
  meAt: 0,
  gps: { state: 'off' },
  connection: 'closed',
  panel: null,
  mapMode: { kind: 'browse' },
  toasts: [],
  ticks: { territory: 0, drones: 0, armies: 0, wars: 0, alliance: 0, notifications: 0 },
  focus: null,
  pickHint: null,
};

let state = initial;
const listeners = new Set<() => void>();

export function getState(): AppState {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

export function bump(...keys: (keyof AppState['ticks'])[]): void {
  setState((s) => {
    const ticks = { ...s.ticks };
    for (const k of keys) ticks[k]++;
    return { ticks };
  });
}

let toastSeq = 0;
export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4500);
}

export function useStore<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(state),
  );
}

export function resetState(): void {
  state = { ...initial, authChecked: true };
  listeners.forEach((l) => l());
}
