import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GameError } from './errors';
import type { Outcome } from './idempotency';

declare module 'fastify' {
  interface FastifyRequest {
    playerId: string | null;
  }
}

export function me(req: FastifyRequest): string {
  if (!req.playerId) throw new GameError('unauthorized', 'login required', 401);
  return req.playerId;
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new GameError('bad_request', 'invalid request', 400, {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function idemKey(req: FastifyRequest): string | undefined {
  const k = req.headers['idempotency-key'];
  return typeof k === 'string' ? k : undefined;
}

export function send<T>(reply: FastifyReply, out: Outcome<T>): FastifyReply {
  if (out.replayed) reply.header('idempotent-replay', 'true');
  return reply.code(out.status).send(out.body);
}

export const zLat = z.number().finite().min(-90).max(90);
export const zLon = z.number().finite().min(-180).max(180);
export const zCellId = z.number().int().nonnegative().max(2 ** 40);
export const zUuid = z.string().uuid();
