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
