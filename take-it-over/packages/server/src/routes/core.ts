import { cellBounds, cellCenter, GRID_VERSION, isValidCellId, paramCatalog, ROW_COUNT } from '@tio/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config';
import type { GameContext } from '../context';
import { GameError } from '../errors';
import { me, parse, zLat, zLon } from '../http';
import type { GpsService } from '../services/gps';
import {
  login,
  logout,
  NOTIFICATION_CATEGORIES,
  profile,
  register,
  SESSION_COOKIE,
  updateSettings,
} from '../services/players';
import { territoryView } from '../services/territory';

const credentials = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(200) });

export function coreRoutes(app: FastifyInstance, ctx: GameContext, gps: GpsService, config: Config): void {
  const setSession = (reply: import('fastify').FastifyReply, token: string) =>
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      maxAge: Math.floor(ctx.sessionTtlMs / 1000),
    });

  app.get('/api/health', async () => ({ ok: true, time: ctx.clock.now(), land: ctx.land.kind }));

  app.get('/api/params', async () => ({ params: paramCatalog(ctx.params) }));

  app.get('/api/grid', async () => ({ version: GRID_VERSION, rows: ROW_COUNT, cellSizeM: 100 }));

  app.post('/api/auth/register', { config: { rateLimit: { max: config.rateLimits.auth, timeWindow: 60_000 } } }, async (req, reply) => {
    const body = parse(credentials, req.body);
    const { playerId, token } = await register(ctx, body.username, body.password);
    setSession(reply, token);
    return reply.code(201).send(await profile(ctx, playerId));
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: config.rateLimits.auth * 2, timeWindow: 60_000 } } }, async (req, reply) => {
    const body = parse(credentials, req.body);
    const { playerId, token } = await login(ctx, body.username, body.password);
    setSession(reply, token);
    return profile(ctx, playerId);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await logout(ctx, token);
    if (req.playerId) gps.forget(req.playerId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => profile(ctx, me(req)));

  app.patch('/api/me', async (req) => {
    const body = parse(
      z.object({
        locale: z.enum(['en', 'es']).optional(),
        color: z.string().optional(),
        notificationPrefs: z.record(z.enum(NOTIFICATION_CATEGORIES), z.boolean()).optional(),
      }),
      req.body,
    );
    await updateSettings(ctx, me(req), body);
    return profile(ctx, me(req));
  });

  app.post('/api/gps', { config: { rateLimit: { max: config.rateLimits.gps, timeWindow: 60_000 } } }, async (req) => {
    const body = parse(
      z.object({ lat: zLat, lon: zLon, accuracy: z.number().finite().positive().max(100000) }),
      req.body,
    );
    return gps.handleFix(me(req), body);
  });

  app.get('/api/territory', async (req) => {
    const q = parse(
      z.object({
        west: z.coerce.number().min(-180).max(180),
        south: z.coerce.number().min(-90).max(90),
        east: z.coerce.number().min(-180).max(180),
        north: z.coerce.number().min(-90).max(90),
        zoom: z.coerce.number().min(0).max(24),
      }),
      req.query,
    );
    if (q.south > q.north) throw new GameError('bad_request', 'south must be <= north', 400);
    return territoryView(ctx.pool, q, q.zoom);
  });

  app.get('/api/cells/:id', async (req) => {
    const id = Number((req.params as { id: string }).id);
    if (!isValidCellId(id)) throw new GameError('bad_cell', 'invalid cell id', 400);
    const [land, owner] = await Promise.all([
      ctx.land.cellsOnLand([id]),
      ctx.pool.query<{ owner_id: string; username: string; color: string; acquired_at: Date }>(
        `SELECT p.owner_id, pl.username, pl.color, p.acquired_at
           FROM parcels p JOIN players pl ON pl.id = p.owner_id WHERE p.cell_id = $1`,
        [id],
      ),
    ]);
    const o = owner.rows[0];
    return {
      cellId: id,
      bounds: cellBounds(id),
      center: cellCenter(id),
      land: land.get(id) ?? false,
      owner: o ? { id: o.owner_id, name: o.username, color: o.color, since: o.acquired_at.toISOString() } : null,
    };
  });

  // Validates lat/lon pairs for clients that want to check a point without a fix.
  app.get('/api/land', async (req) => {
    const q = parse(z.object({ lat: z.coerce.number().pipe(zLat), lon: z.coerce.number().pipe(zLon) }), req.query);
    const [land] = await ctx.land.pointsOnLand([q]);
    return { land };
  });
}
