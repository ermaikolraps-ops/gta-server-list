import type { ApiErrorBody } from '@tio/shared';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: ApiErrorBody,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * API paths are written as '/api/…' but requested relative to the page, so
 * the game works at a domain root or under a path such as /play/.
 */
export function apiUrl(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

/**
 * JSON API call. Mutations marked `idempotent` get one Idempotency-Key for
 * the user action and are retried on network failure with that same key, so
 * a flaky connection can never buy something twice.
 */
export async function api<T>(
  method: Method,
  path: string,
  body?: unknown,
  opts: { idempotent?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'x-tio-client': 'web' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotent) headers['idempotency-key'] = newKey();
  const attempts = opts.idempotent ? 3 : 1;
  const url = apiUrl(path);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      continue;
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const b = json as ApiErrorBody | undefined;
      throw new ApiError(res.status, b?.error ?? 'generic', b?.message ?? res.statusText, b);
    }
    return json as T;
  }
  throw new ApiError(0, 'network', String(lastErr));
}
