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
  trustProxy: boolean;
  logLevel: string;
  schedulerIntervalMs: number;
  /** Requests per minute: global per player/IP, auth endpoints per IP, GPS per player. */
  rateLimits: { global: number; auth: number; gps: number };
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
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
    trustProxy: bool(env.TIO_TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL ?? 'info',
    schedulerIntervalMs: Number(env.TIO_SCHEDULER_INTERVAL_MS ?? 500),
    rateLimits: {
      global: Number(env.TIO_RATE_LIMIT_GLOBAL ?? 300),
      auth: Number(env.TIO_RATE_LIMIT_AUTH ?? 10),
      gps: Number(env.TIO_RATE_LIMIT_GPS ?? 600),
    },
  };
}
