import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config';
import type { GameContext } from './context';
import { GameError } from './errors';
import { coreRoutes } from './routes/core';
import { authenticate, SESSION_COOKIE } from './services/players';
import type { Services } from './services';
import { militaryRoutes } from './routes/military';
import { registerWebSocket } from './ws';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(
  ctx: GameContext,
  services: Services,
  config: Config,
  opts: { logger?: boolean | object } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });
  app.decorateRequest('playerId', null);
  await app.register(cookie);

  // Authentication runs first so rate limits can be keyed by player.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api') && !req.url.startsWith('/ws')) return;
    req.playerId = await authenticate(ctx, req.cookies[SESSION_COOKIE]);
  });

  // CSRF defence for cookie auth: state-changing API calls must carry a custom
  // header (impossible cross-site without a CORS preflight we never grant) and,
  // when the browser sends an Origin, it must be ours.
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api') || SAFE_METHODS.has(req.method)) return;
    if (req.headers['x-tio-client'] === undefined) {
      throw new GameError('csrf', 'missing X-TIO-Client header', 403);
    }
    const origin = req.headers.origin;
    if (origin && !originAllowed(origin, req.headers.host, config.allowedOrigins)) {
      throw new GameError('csrf', 'origin not allowed', 403);
    }
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimits.global,
    timeWindow: 60_000,
    keyGenerator: (req) => req.playerId ?? req.ip,
    errorResponseBuilder: (_req, c) => ({
      statusCode: 429,
      error: 'rate_limited',
      message: `too many requests, retry in ${Math.ceil(c.ttl / 1000)}s`,
    }),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof GameError) {
      return reply.code(err.status).send({ error: err.code, message: err.message, ...(err.details ?? {}) });
    }
    const { statusCode: status, message } = err as { statusCode?: number; message?: string };
    if (status === 429) return reply.code(429).send({ error: 'rate_limited', message });
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'bad_request', message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  coreRoutes(app, ctx, services.gps, config);
  militaryRoutes(app, ctx, services);
  await registerWebSocket(app, ctx, services, config);

  if (config.webDist) {
    const root = resolve(config.webDist);
    if (existsSync(root)) {
      await app.register(fastifyStatic, {
        root,
        // Serve whatever is on disk now, so a rebuilt client needs no restart.
        wildcard: true,
        cacheControl: false,
        setHeaders(res, path) {
          // Hashed bundles never change; the shell and service worker must revalidate.
          if (/[\\/]assets[\\/]/.test(path)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
          else res.setHeader('cache-control', 'no-cache');
        },
      });
      // SPA fallback for client-side routes.
      app.setNotFoundHandler((req, reply) => {
        if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
          return reply.sendFile('index.html');
        }
        return reply.code(404).send({ error: 'not_found', message: 'not found' });
      });
    } else {
      app.log.warn({ root }, 'TIO_WEB_DIST does not exist; not serving the web app');
    }
  }
  return app;
}

function originAllowed(origin: string, host: string | undefined, allowed: string[]): boolean {
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
