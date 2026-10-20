import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Config } from './config';
import type { GameContext } from './context';
import type { Services } from './services';

const gpsMsg = z.object({
  type: z.literal('gps'),
  seq: z.number().int().optional(),
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().positive().max(100000),
});

const MAX_MSGS_PER_SEC = 10;

/**
 * One WebSocket per open client. Server → client: live game events for that
 * player. Client → server: GPS fixes (cheaper than HTTP at 1 Hz) and pings.
 */
export async function registerWebSocket(
  app: FastifyInstance,
  ctx: GameContext,
  services: Services,
  config: Config,
): Promise<void> {
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  const sockets = new Map<string, Set<WebSocket>>();

  const sendTo = (pid: string, data: string) => {
    for (const s of sockets.get(pid) ?? []) if (s.readyState === s.OPEN) s.send(data);
  };
  ctx.events.onPlayer((pid, ev) => sendTo(pid, JSON.stringify(ev)));
  ctx.events.onBroadcast((ev) => {
    const data = JSON.stringify(ev);
    for (const pid of sockets.keys()) sendTo(pid, data);
  });

  app.get('/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      let sameHost = false;
      try {
        sameHost = new URL(origin).host === req.headers.host;
      } catch {
        sameHost = false;
      }
      if (!sameHost) {
        socket.close(4403, 'origin not allowed');
        return;
      }
    }
    const playerId = req.playerId;
    if (!playerId) {
      socket.close(4401, 'unauthorized');
      return;
    }
    let set = sockets.get(playerId);
    if (!set) sockets.set(playerId, (set = new Set()));
    set.add(socket);

    let windowStart = Date.now();
    let count = 0;
    socket.on('message', async (raw) => {
      const t = Date.now();
      if (t - windowStart > 1000) {
        windowStart = t;
        count = 0;
      }
      if (++count > MAX_MSGS_PER_SEC) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if ((msg as { type?: string })?.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', serverTime: ctx.clock.now() }));
        return;
      }
      const gps = gpsMsg.safeParse(msg);
      if (gps.success) {
        try {
          const result = await services.gps.handleFix(playerId, gps.data);
          socket.send(JSON.stringify({ type: 'gps_result', seq: gps.data.seq, ...result }));
        } catch (err) {
          ctx.log.error({ err }, 'gps over ws failed');
        }
      }
    });
    socket.on('close', () => {
      set!.delete(socket);
      if (!set!.size) sockets.delete(playerId);
    });
    socket.send(JSON.stringify({ type: 'hello', serverTime: ctx.clock.now() }));
  });
}
