import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { translate } from '../src/i18n';

describe('i18n', () => {
  it('has a Spanish string for every English key and no extras', () => {
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it('keeps the same placeholders in both languages', () => {
    const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const k of Object.keys(en) as (keyof typeof en)[]) expect(holes(es[k])).toEqual(holes(en[k]));
  });

  it('interpolates parameters', () => {
    expect(translate('en', 'gps.status.tracking', { s: '1.2', total: 2 })).toBe('Capturing… 1.2 / 2 s');
    expect(translate('es', 'hud.parcels', { n: 3 })).toBe('3 parcelas');
  });
});

describe('server message keys', () => {
  it('has a translation for every notification and error code the server sends', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(__dirname, '../../server/src');
    const files: string[] = [];
    const walk = (d: string) =>
      readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
    walk(root);
    const src = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    const notify = new Set([...src.matchAll(/'(notify\.[\w.]+)'/g)].map((m) => m[1]!));
    const errors = new Set([...src.matchAll(/new GameError\(\s*'(\w+)'/g)].map((m) => `error.${m[1]}`));
    expect(notify.size).toBeGreaterThan(10);
    const missing = [...notify, ...errors].filter((k) => !(k in en));
    // generic validation codes fall back to "Something went wrong"
    const allowed = new Set(['error.bad_request', 'error.bad_amount', 'error.bad_cell', 'error.csrf', 'error.bad_idempotency_key', 'error.idempotency_key_reused', 'error.invalid_color', 'error.invalid_category', 'error.already_member', 'error.no_alliance', 'error.army_empty', 'error.internal']);
    expect(missing.filter((k) => !allowed.has(k))).toEqual([]);
  });
});
