export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  /** Set Secure on cookies (on behind HTTPS in production). */
  cookieSecure: boolean;
  sessionTtlDays: number;
  /** Origins allowed to make state-changing requests. Empty = same host only. */
  allowedOrigins: string[];
  /** Optional JSON file with parameter overrides (balance tuning). */
  paramsFile?: string;
  /** 'postgis' needs land data loaded; 'permissive' treats everything as land (dev only). */
  landMask: 'postgis' | 'permissive';
  /** Directory of the built web app to serve, if any. */
  webDist?: string;
  /**
   * Reverse proxies in front of the server whose X-Forwarded-For entries are
   * trusted (0 = none). Only the last N hops are trusted, so a client cannot
   * fake its address by sending its own X-Forwarded-For header.
   */
  trustProxyHops: number;
  logLevel: string;
  schedulerIntervalMs: number;
  /**
   * Public path the game is served under, e.g. '/play/' on an existing site
   * (default '/'). The session cookie is scoped to it, and the prefix is
   * stripped from incoming URLs whether or not the reverse proxy strips it.
   */
  publicPath: string;
  /** Requests per minute: global per player/IP, auth endpoints per IP, GPS per player. */
  rateLimits: { global: number; auth: number; gps: number };
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/** TIO_TRUST_PROXY: 'true' = one proxy (the usual case), a number = that many hops, else none. */
export function proxyHops(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  return bool(raw, false) ? 1 : 0;
}

export function normalizePublicPath(raw: string | undefined): string {
  const p = (raw ?? '/').trim();
  if (!/^\/?[A-Za-z0-9._~/-]*$/.test(p)) throw new Error('TIO_PUBLIC_PATH must be a plain URL path like /play/');
  const withLead = p.startsWith('/') ? p : `/${p}`;
  return withLead.endsWith('/') ? withLead : `${withLead}/`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const landMask = (env.TIO_LAND_MASK ?? 'postgis') as Config['landMask'];
  if (landMask !== 'postgis' && landMask !== 'permissive') throw new Error('TIO_LAND_MASK must be postgis or permissive');
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://tio:tio@localhost:5432/takeitover',
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
    cookieSecure: bool(env.TIO_COOKIE_SECURE, env.NODE_ENV === 'production'),
    sessionTtlDays: Number(env.TIO_SESSION_TTL_DAYS ?? 30),
    allowedOrigins: (env.TIO_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    paramsFile: env.TIO_PARAMS_FILE || undefined,
    landMask,
    webDist: env.TIO_WEB_DIST || undefined,
    trustProxyHops: proxyHops(env.TIO_TRUST_PROXY),
    logLevel: env.LOG_LEVEL ?? 'info',
    schedulerIntervalMs: Number(env.TIO_SCHEDULER_INTERVAL_MS ?? 500),
    publicPath: normalizePublicPath(env.TIO_PUBLIC_PATH),
    rateLimits: {
      global: Number(env.TIO_RATE_LIMIT_GLOBAL ?? 300),
      auth: Number(env.TIO_RATE_LIMIT_AUTH ?? 10),
      gps: Number(env.TIO_RATE_LIMIT_GPS ?? 600),
    },
  };
}
