import { type ArmyDto, cellAt, UNIT_TYPES } from '@tio/shared';
import { useState } from 'react';
import { useApi, useParams } from '../../data';
import { formatNumber, formatTime, type MessageKey, t, useLocale } from '../../i18n';
import { flyTo } from '../../map/MapView';
import { setState, useStore } from '../../store';
import { act } from '../act';
import { pickPoint } from '../pick';
import { Sheet } from '../Sheet';
import { hasUnits, type UnitCounts, UnitPicker, unitCost } from '../UnitPicker';

export function unitSummary(a: ArmyDto): string {
  return UNIT_TYPES.filter((u) => a.units[u].count > 0)
    .map((u) => `${formatNumber(a.units[u].count)} ${t(`units.${u}` as MessageKey)}`)
    .join(' · ');
}

function ArmyCard({ army, all }: { army: ArmyDto; all: ArmyDto[] }) {
  const idle = army.status === 'idle';
  const mates = all.filter((o) => o.id !== army.id && o.status === 'idle' && cellAt(o.lat, o.lon) === cellAt(army.lat, army.lon));
  const move = async () => {
    setState({ panel: null });
    const p = await pickPoint('army.pickDestination');
    if (p) await act('POST', `/api/armies/${army.id}/move`, { lat: p.lat, lon: p.lon }, ['armies']);
    setState({ panel: 'army' });
  };
  const splitHalf = () => {
    const half: UnitCounts = {};
    for (const u of UNIT_TYPES) half[u] = Math.floor(army.units[u].count / 2);
    void act('POST', `/api/armies/${army.id}/split`, { units: half }, ['armies']);
  };
  return (
    <div className="card">
      <div className="card-row">
        <button className="link" onClick={() => flyTo(army.lat, army.lon, 15)}>
          {t(`army.status.${army.status}` as MessageKey)}
        </button>
        <span className="muted small">{t('army.power', { n: formatNumber(Math.round(army.power)) })}</span>
      </div>
      <div className="meta">{unitSummary(army)}</div>
      <div className="bar">
        <div style={{ width: `${army.health * 100}%` }} />
      </div>
      <div className="meta">
        {t('army.health', { n: Math.round(army.health * 100) })}
        {army.movement && ` · ${t('common.eta', { t: formatTime(army.movement.arriveAt) })}`}
        {army.repair && ` · ${t('bases.repairing', { t: formatTime(army.repair.finishesAt) })}`}
      </div>
      {idle && (
        <div className="row-actions">
          <button className="secondary" onClick={() => void move()}>
            {t('army.move')}
          </button>
          <button
            className="secondary"
            onClick={() => setState({ panel: null, mapMode: { kind: 'war-sector', armyIds: [army.id], selected: [] } })}
          >
            {t('wars.declare')}
          </button>
          {army.baseId && army.health < 0.999 && (
            <button className="secondary" onClick={() => void act('POST', `/api/armies/${army.id}/repair`, {}, ['armies'])}>
              {t('army.repair')}
            </button>
          )}
          {army.headcount > 1 && (
            <button className="secondary" onClick={splitHalf}>
              {t('army.split')}
            </button>
          )}
          {mates[0] && (
            <button
              className="secondary"
              onClick={() => void act('POST', `/api/armies/${army.id}/merge`, { otherId: mates[0]!.id }, ['armies'])}
            >
              {t('army.merge')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function ArmyPanel() {
  useLocale();
  const { data } = useApi<{ armies: ArmyDto[] }>('/api/armies', ['armies']);
  const me = useStore((s) => s.me)!;
  const gps = useStore((s) => s.gps);
  const params = useParams();
  const [units, setUnits] = useState<UnitCounts>({ infantry: 100 });
  const armies = data?.armies ?? [];
  return (
    <Sheet title={t('army.title')}>
      {me.parcels === 0 && (
        <div className="card">
          <strong>{t('army.expedition')}</strong>
          <p className="muted small">{t('army.expeditionHint')}</p>
          <UnitPicker value={units} onChange={setUnits} />
          <div className="card-row">
            <span className="muted small">{t('army.total', { n: formatNumber(unitCost(units, params)) })}</span>
            <button
              className="primary"
              disabled={!hasUnits(units) || gps.state !== 'on'}
              onClick={() => void act('POST', '/api/armies/expedition', { units }, ['armies'], t('done.deployed'))}
            >
              {t('army.deploy')}
            </button>
          </div>
          {gps.state !== 'on' && <p className="muted small">{t('drones.needGps')}</p>}
        </div>
      )}
      {!armies.length && <p className="muted">{t('army.empty')}</p>}
      {armies.map((a) => (
        <ArmyCard key={a.id} army={a} all={armies} />
      ))}
    </Sheet>
  );
}
