import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, harness, type Harness, registerPlayer } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => h.close());

describe('accounts and sessions', () => {
  it('gives a new player 1,000 credits and one free basic drone', async () => {
    const p = await registerPlayer(h, 'alice');
    const me = await api(h, p, 'GET', '/api/me');
    expect(me.status).toBe(200);
    expect(me.body.credits).toBe(1000);
    expect(me.body.parcels).toBe(0);
    expect(me.body.incomePerHour).toBe(0);
    expect(me.body.color).toMatch(/^#[0-9a-f]{6}$/);
    const drones = await h.pool.query('SELECT type, status FROM drones WHERE owner_id = $1', [p.id]);
    expect(drones.rows).toEqual([{ type: 'basic', status: 'idle' }]);
  });

  it('rejects duplicate usernames case-insensitively', async () => {
    await registerPlayer(h, 'bob');
    const res = await api(h, null, 'POST', '/api/auth/register', { username: 'BOB', password: 'whatever123' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('username_taken');
  });

  it('validates username and password', async () => {
    expect((await api(h, null, 'POST', '/api/auth/register', { username: 'a', password: 'longenough' })).body.error).toBe(
      'invalid_username',
    );
    expect((await api(h, null, 'POST', '/api/auth/register', { username: 'okname', password: 'short' })).body.error).toBe(
      'invalid_password',
    );
  });

  it('logs in, rejects wrong passwords, and logs out', async () => {
    await registerPlayer(h, 'carol');
    const bad = await api(h, null, 'POST', '/api/auth/login', { username: 'carol', password: 'nope-nope' });
    expect(bad.status).toBe(401);
    const unknown = await api(h, null, 'POST', '/api/auth/login', { username: 'nobody', password: 'nope-nope' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe(bad.body.error);
    const ok = await api(h, null, 'POST', '/api/auth/login', { username: 'Carol', password: 'correct horse battery' });
    expect(ok.status).toBe(200);
    const cookie = String(ok.headers['set-cookie']).split(';')[0]!;
    const session = { id: ok.body.id, cookie, name: 'carol' };
    expect((await api(h, session, 'GET', '/api/me')).status).toBe(200);
    await api(h, session, 'POST', '/api/auth/logout');
    expect((await api(h, session, 'GET', '/api/me')).status).toBe(401);
  });

  it('expires sessions', async () => {
    const p = await registerPlayer(h, 'dave');
    h.clock.advance(31 * 86400_000);
    expect((await api(h, p, 'GET', '/api/me')).status).toBe(401);
  });

  it('requires login for player endpoints', async () => {
    expect((await api(h, null, 'GET', '/api/me')).status).toBe(401);
    expect((await api(h, null, 'POST', '/api/gps', { lat: 40.3, lon: 0.3, accuracy: 5 })).status).toBe(401);
  });

  it('blocks cross-site state changes', async () => {
    const p = await registerPlayer(h, 'erin');
    const noHeader = await h.app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie: p.cookie },
      payload: { locale: 'es' },
    });
    expect(noHeader.statusCode).toBe(403);
    const evilOrigin = await api(h, p, 'PATCH', '/api/me', { locale: 'es' }, { origin: 'https://evil.example' });
    expect(evilOrigin.status).toBe(403);
    const sameOrigin = await api(h, p, 'PATCH', '/api/me', { locale: 'es' }, { origin: 'http://game.test:8080', host: 'game.test:8080' });
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body.locale).toBe('es');
  });

  it('validates settings', async () => {
    const p = await registerPlayer(h, 'frank');
    expect((await api(h, p, 'PATCH', '/api/me', { color: 'red' })).status).toBe(400);
    expect((await api(h, p, 'PATCH', '/api/me', { notificationPrefs: { spam: true } })).status).toBe(400);
    const ok = await api(h, p, 'PATCH', '/api/me', { color: '#123abc', notificationPrefs: { wars: false } });
    expect(ok.body.color).toBe('#123abc');
    expect(ok.body.notificationPrefs).toEqual({ wars: false });
  });

  it('rate-limits registration attempts', async () => {
    const strict = await harness({ pool: h.pool, reset: false, rateLimits: { auth: 10 } });
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) {
      const r = await api(strict, null, 'POST', '/api/auth/register', { username: 'x', password: 'y' });
      statuses.push(r.status);
    }
    await strict.close();
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
  });

  it('publishes the parameter catalogue with statuses', async () => {
    const res = await api(h, null, 'GET', '/api/params');
    const entry = res.body.params.find((e: { path: string }) => e.path === 'drones.types.basic.price');
    expect(entry.status).toBe('provisional');
  });
});

describe('hosting under a path of an existing website', () => {
  it('serves the API under the public path and scopes the session cookie to it', async () => {
    const sub = await harness({ pool: h.pool, reset: false, publicPath: '/play/' });
    const reg = await sub.app.inject({
      method: 'POST',
      url: '/play/api/auth/register',
      headers: { 'x-tio-client': 'test' },
      payload: { username: 'subpath', password: 'correct horse battery' },
    });
    expect(reg.statusCode).toBe(201);
    const cookie = String(reg.headers['set-cookie']);
    expect(cookie).toMatch(/Path=\/play\//);
    const session = cookie.split(';')[0]!;
    // a proxy that already stripped the prefix works too
    const stripped = await sub.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: session } });
    const prefixed = await sub.app.inject({ method: 'GET', url: '/play/api/me', headers: { cookie: session } });
    expect(stripped.statusCode).toBe(200);
    expect(prefixed.statusCode).toBe(200);
    expect(prefixed.json().username).toBe('subpath');
    await sub.close();
  });

  it('normalises and validates the configured path', async () => {
    const { normalizePublicPath } = await import('../src/config');
    expect(normalizePublicPath(undefined)).toBe('/');
    expect(normalizePublicPath('play')).toBe('/play/');
    expect(normalizePublicPath('/games/tio')).toBe('/games/tio/');
    expect(() => normalizePublicPath('/play?x=1')).toThrow();
  });
});

describe('client address behind a reverse proxy', () => {
  it('trusts only the hop the proxy appended, so a spoofed X-Forwarded-For cannot dodge rate limits', async () => {
    const { loadConfig, proxyHops } = await import('../src/config');
    expect(proxyHops('true')).toBe(1);
    expect(proxyHops('2')).toBe(2);
    expect(proxyHops('false')).toBe(0);
    expect(loadConfig({ TIO_TRUST_PROXY: 'true' }).trustProxyHops).toBe(1);

    const behindProxy = await harness({ pool: h.pool, reset: false, rateLimits: { auth: 3 }, trustProxyHops: 1 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await behindProxy.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        // the attacker rotates a fake left-most address; nginx appends the real one last
        headers: { 'x-tio-client': 'test', 'x-forwarded-for': `10.9.9.${i}, 203.0.113.7` },
        payload: { username: 'x', password: 'y' },
      });
      statuses.push(res.statusCode);
    }
    await behindProxy.close();
    expect(statuses.slice(0, 3).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
  });
});
