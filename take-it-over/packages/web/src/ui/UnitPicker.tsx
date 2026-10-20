import { UNIT_TYPES, type UnitType } from '@tio/shared';
import { num, useParams } from '../data';
import { formatNumber, type MessageKey, t } from '../i18n';

export type UnitCounts = Partial<Record<UnitType, number>>;

export function unitCost(units: UnitCounts, params: Map<string, unknown> | null): number {
  return UNIT_TYPES.reduce((s, u) => s + (units[u] ?? 0) * num(params, `units.${u}.price`), 0);
}

/** Number inputs per unit type; shows prices when `priced`, or a maximum per type. */
export function UnitPicker({
  value,
  onChange,
  max,
  priced = true,
}: {
  value: UnitCounts;
  onChange: (v: UnitCounts) => void;
  max?: Partial<Record<UnitType, number>>;
  priced?: boolean;
}) {
  const params = useParams();
  return (
    <div className="unit-grid">
      {UNIT_TYPES.filter((u) => !max || (max[u] ?? 0) > 0).map((u) => (
        <label key={u} style={{ display: 'contents' }}>
          <span>
            {t(`units.${u}` as MessageKey)}{' '}
            <span className="muted small">
              {priced ? t('common.price', { n: num(params, `units.${u}.price`) }) : `≤ ${formatNumber(max?.[u] ?? 0)}`}
            </span>
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={max?.[u]}
            value={value[u] ?? 0}
            onChange={(e) => onChange({ ...value, [u]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </label>
      ))}
    </div>
  );
}

export function hasUnits(u: UnitCounts): boolean {
  return Object.values(u).some((n) => (n ?? 0) > 0);
}
