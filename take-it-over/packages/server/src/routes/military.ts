import { DRONE_TYPES, UNIT_TYPES } from '@tio/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GameContext } from '../context';
import { idemKey, me, parse, send, zCellId, zLat, zLon, zUuid } from '../http';
import type { Services } from '../services';

const zUnits = z.object(Object.fromEntries(UNIT_TYPES.map((t) => [t, z.number().int().min(0).max(1_000_000).optional()]))).strict();
const zPoint = z.object({ lat: zLat, lon: zLon });
const idParam = (p: unknown) => parse(z.object({ id: zUuid }), p).id;

export function militaryRoutes(app: FastifyInstance, _ctx: GameContext, s: Services): void {
  // ---- drones
  app.get('/api/drones', async (req) => s.drones.list(me(req)));

  app.post('/api/drones', async (req, reply) => {
    const body = parse(z.object({ type: z.enum(DRONE_TYPES) }), req.body);
    return send(reply, await s.drones.buy(me(req), body.type, idemKey(req)));
  });

  app.post('/api/drones/:id/preview', async (req) => {
    const body = parse(z.object({ targets: z.array(zCellId).max(200) }), req.body);
    return s.drones.preview(me(req), idParam(req.params), body.targets);
  });

  app.post('/api/drones/:id/launch', async (req, reply) => {
    const body = parse(z.object({ targets: z.array(zCellId).min(1).max(200) }), req.body);
    return send(reply, await s.drones.launch(me(req), idParam(req.params), body.targets, idemKey(req)));
  });

  // ---- armies
  app.get('/api/armies', async (req) => ({ armies: await s.military.listArmies(me(req)) }));

  app.post('/api/armies/expedition', async (req, reply) => {
    const body = parse(z.object({ units: zUnits }), req.body);
    return send(reply, await s.military.deployExpedition(me(req), body.units, idemKey(req)));
  });

  app.post('/api/armies/:id/move', async (req, reply) => {
    const body = parse(zPoint, req.body);
    return send(reply, await s.military.moveArmy(me(req), idParam(req.params), body, idemKey(req)));
  });

  app.post('/api/armies/:id/split', async (req, reply) => {
    const body = parse(z.object({ units: zUnits }), req.body);
    return send(reply, await s.military.splitArmy(me(req), idParam(req.params), body.units, idemKey(req)));
  });

  app.post('/api/armies/:id/merge', async (req, reply) => {
    const body = parse(z.object({ otherId: zUuid }), req.body);
    return send(reply, await s.military.mergeArmies(me(req), idParam(req.params), body.otherId, idemKey(req)));
  });

  app.post('/api/armies/:id/repair', async (req, reply) => {
    return send(reply, await s.military.startRepair(me(req), idParam(req.params), idemKey(req)));
  });

  // ---- bases and AA
  app.get('/api/bases', async (req) => ({ bases: await s.military.listBases(me(req)) }));

  app.post('/api/bases', async (req, reply) => {
    const body = parse(z.object({ cellId: zCellId }), req.body);
    return send(reply, await s.military.buildBase(me(req), body.cellId, idemKey(req)));
  });

  app.post('/api/bases/:id/recruit', async (req, reply) => {
    const body = parse(z.object({ units: zUnits }), req.body);
    return send(reply, await s.military.recruit(me(req), idParam(req.params), body.units, idemKey(req)));
  });

  app.get('/api/aa', async (req) => ({ batteries: await s.military.listAa(me(req)) }));

  app.post('/api/aa', async (req, reply) => {
    const body = parse(z.object({ cellId: zCellId }), req.body);
    return send(reply, await s.military.buildAa(me(req), body.cellId, idemKey(req)));
  });

  // ---- ships
  app.get('/api/ships', async (req) => ({ ships: await s.ships.list(me(req)) }));

  app.post('/api/ships', async (req, reply) => {
    const body = parse(zPoint, req.body);
    return send(reply, await s.ships.buy(me(req), body, idemKey(req)));
  });

  app.post('/api/ships/:id/sail', async (req, reply) => {
    const body = parse(
      z.object({ waypoints: z.array(zPoint).max(30).default([]), destination: zPoint, armyId: zUuid.optional() }),
      req.body,
    );
    return send(
      reply,
      await s.ships.sail(me(req), idParam(req.params), body.waypoints, body.destination, body.armyId, idemKey(req)),
    );
  });

  // ---- wars
  app.get('/api/wars', async (req) => ({ wars: await s.wars.list(me(req)) }));

  app.get('/api/wars/public', async (req) => {
    const q = parse(
      z.object({
        west: z.coerce.number().min(-180).max(180),
        south: z.coerce.number().min(-90).max(90),
        east: z.coerce.number().min(-180).max(180),
        north: z.coerce.number().min(-90).max(90),
      }),
      req.query,
    );
    return { wars: await s.wars.publicWars(q) };
  });

  app.get('/api/wars/:id', async (req) => s.wars.get(me(req), idParam(req.params)));

  app.post('/api/wars', async (req, reply) => {
    const body = parse(z.object({ sector: z.array(zCellId).min(1).max(200), armyIds: z.array(zUuid).min(1).max(50) }), req.body);
    return send(reply, await s.wars.declare(me(req), body.sector, body.armyIds, idemKey(req)));
  });

  app.post('/api/wars/:id/reinforce', async (req, reply) => {
    const body = parse(z.object({ armyIds: z.array(zUuid).min(1).max(50) }), req.body);
    return send(reply, await s.wars.reinforce(me(req), idParam(req.params), body.armyIds, idemKey(req)));
  });

  // ---- alliances
  app.get('/api/alliance', async (req) => s.alliances.view(me(req)));

  app.post('/api/alliances', async (req) => {
    const body = parse(z.object({ name: z.string().max(40), color: z.string().max(7) }), req.body);
    return s.alliances.create(me(req), body.name.trim(), body.color.toLowerCase());
  });

  app.post('/api/alliance/invite', async (req) => {
    const body = parse(z.object({ username: z.string().min(1).max(40) }), req.body);
    return s.alliances.invite(me(req), body.username);
  });

  app.post('/api/alliances/:id/accept', async (req) => s.alliances.accept(me(req), idParam(req.params)));
  app.post('/api/alliances/:id/decline', async (req) => s.alliances.decline(me(req), idParam(req.params)));
  app.post('/api/alliance/leave', async (req) => s.alliances.leave(me(req)));

  app.post('/api/alliance/kick', async (req) => {
    const body = parse(z.object({ playerId: zUuid }), req.body);
    return s.alliances.kick(me(req), body.playerId);
  });

  // ---- notifications and rankings
  app.get('/api/notifications', async (req) => s.social.notifications(me(req)));

  app.post('/api/notifications/read', async (req) => {
    await s.social.markRead(me(req));
    return { ok: true };
  });

  app.get('/api/rankings', async (req) => {
    const q = parse(z.object({ metric: z.enum(['territory', 'wars', 'drones']).default('territory') }), req.query);
    return s.social.rankings(me(req), q.metric);
  });
}
