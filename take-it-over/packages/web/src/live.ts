import type { GpsResult } from '@tio/shared';
import { t } from './i18n';
import { bump, getState, setState, toast } from './store';
import { refreshMe } from './session';

/**
 * The live connection: server pushes game events, client streams GPS fixes.
 * Reconnects with backoff; while it is down, GPS falls back to HTTP.
 */
let socket: WebSocket | null = null;
let retry = 0;
let stopped = true;

export function startLive(): void {
  stopped = false;
  connect();
}

export function stopLive(): void {
  stopped = true;
  socket?.close();
  socket = null;
}

export function sendLive(msg: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

function connect(): void {
  if (stopped) return;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  setState({ connection: 'connecting' });
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    setState({ connection: 'open' });
  };
  ws.onclose = (ev) => {
    if (socket === ws) socket = null;
    setState({ connection: 'closed' });
    if (ev.code === 4401) return; // logged out
    if (!stopped) setTimeout(connect, Math.min(30_000, 1000 * 2 ** retry++));
  };
  ws.onmessage = (ev) => {
    try {
      handle(JSON.parse(ev.data as string));
    } catch {
      /* ignore malformed */
    }
  };
}

export function handleGpsResult(r: GpsResult): void {
  setState((s) => ({ gps: { ...s.gps, last: r, lastAt: Date.now() } }));
  if (r.status === 'conquered') {
    toast(t('gps.status.conquered'), 'good');
    bump('territory');
    void refreshMe();
  }
  if (r.explorationReward) {
    toast(t('gps.exploration', { n: r.explorationReward }), 'good');
    void refreshMe();
  }
}

interface Notice {
  type: 'notification';
  category: string;
  key: string;
  params?: Record<string, string | number>;
  tone?: 'info' | 'good' | 'bad';
}

function handle(msg: { type: string; [k: string]: unknown }): void {
  switch (msg.type) {
    case 'gps_result':
      handleGpsResult(msg as unknown as GpsResult);
      return;
    case 'parcel_conquered':
    case 'parcel_lost':
      bump('territory');
      void refreshMe();
      return;
    case 'drone_update':
      bump('drones', 'territory');
      void refreshMe();
      return;
    case 'army_update':
      bump('armies');
      return;
    case 'war_update':
      bump('wars', 'armies', 'territory');
      return;
    case 'alliance_update':
      bump('alliance', 'territory');
      void refreshMe();
      return;
    case 'gps_suspended':
      void refreshMe();
      return;
    case 'notification': {
      const n = msg as unknown as Notice;
      bump('notifications');
      const prefs = getState().me?.notificationPrefs ?? {};
      if (prefs[n.category] === false) return;
      toast(n.params ? t(n.key as never, n.params) : t(n.key as never), n.tone ?? 'info');
      return;
    }
  }
}
