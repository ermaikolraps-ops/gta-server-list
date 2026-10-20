import type { GpsResult } from '@tio/shared';
import { api } from './api';
import { handleGpsResult, sendLive } from './live';
import { getState, setState } from './store';

/**
 * Streams the device position to the server about once a second. The server
 * decides everything (cell, dwell, capture); the client only reports raw fixes.
 *
 * watchPosition may stay silent while the device is still, but capture needs
 * continuous presence, so the latest fix is re-sent each second while it is
 * recent. Fixes older than STALE_MS are never re-sent.
 */
const SEND_EVERY_MS = 1000;
const STALE_MS = 8000;

let watchId: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let latest: { lat: number; lon: number; accuracy: number; at: number } | null = null;
let seq = 0;
let wakeLock: { release(): Promise<void> } | null = null;

export function startGps(): void {
  if (!('geolocation' in navigator)) {
    setState((s) => ({ gps: { ...s.gps, state: 'unavailable' } }));
    return;
  }
  if (watchId !== null) return;
  setState((s) => ({ gps: { ...s.gps, state: 'waiting' } }));
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      latest = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: Date.now(),
      };
      setState((s) => ({
        gps: { ...s.gps, state: 'on', lat: latest!.lat, lon: latest!.lon, accuracy: latest!.accuracy },
      }));
    },
    (err) => {
      if (err.code === err.PERMISSION_DENIED) {
        stopGps();
        setState((s) => ({ gps: { ...s.gps, state: 'denied' } }));
      }
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
  );
  timer = setInterval(sendLatest, SEND_EVERY_MS);
  void keepAwake();
}

export function stopGps(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (timer) clearInterval(timer);
  timer = null;
  latest = null;
  void wakeLock?.release().catch(() => {});
  wakeLock = null;
  setState({ gps: { state: 'off' } });
}

export function gpsRunning(): boolean {
  return watchId !== null;
}

/** The latest fix if fresh — used to tell the server where an action happens. */
export function currentFix(): { lat: number; lon: number; accuracy: number } | null {
  if (!latest || Date.now() - latest.at > STALE_MS) return null;
  return latest;
}

async function sendLatest(): Promise<void> {
  if (!latest || Date.now() - latest.at > STALE_MS) return;
  const fix = { lat: latest.lat, lon: latest.lon, accuracy: latest.accuracy };
  if (sendLive({ type: 'gps', seq: ++seq, ...fix })) return;
  try {
    handleGpsResult(await api<GpsResult>('POST', '/api/gps', fix));
  } catch {
    /* transient; the next tick retries */
  }
}

async function keepAwake(): Promise<void> {
  try {
    if (localStorage.getItem('tio.keepAwake') !== '1') return;
  } catch {
    return;
  }
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
  try {
    wakeLock = (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && watchId !== null && !wakeLock) void keepAwake();
  if (document.visibilityState === 'visible' && getState().gps.state === 'on') void sendLatest();
});
