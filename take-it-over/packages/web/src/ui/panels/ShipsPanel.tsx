import type { ArmyDto, ShipDto } from '@tio/shared';
import { useState } from 'react';
import { num, useApi, useParams } from '../../data';
import { formatTime, t, useLocale } from '../../i18n';
import { flyTo } from '../../map/MapView';
import { setState } from '../../store';
import { act } from '../act';
import { type Picked, pickPoint } from '../pick';
import { Sheet } from '../Sheet';
import { unitSummary } from './ArmyPanel';

function ShipCard({ ship, armies }: { ship: ShipDto; armies: ArmyDto[] }) {
  const [armyId, setArmyId] = useState('');
  const [waypoints, setWaypoints] = useState<Picked[]>([]);
  const addWaypoint = async () => {
    setState({ panel: null });
    const p = await pickPoint('ships.pickWaypoint');
    if (p) setWaypoints((w) => [...w, p]);
    setState({ panel: 'ships' });
  };
  const sail = async () => {
    setState({ panel: null });
    const dest = await pickPoint('ships.pickDestination');
    if (dest) {
      const ok = await act(
        'POST',
        `/api/ships/${ship.id}/sail`,
        {
          waypoints: waypoints.map((w) => ({ lat: w.lat, lon: w.lon })),
          destination: { lat: dest.lat, lon: dest.lon },
          ...(armyId ? { armyId } : {}),
        },
        ['armies'],
        t('done.sailing'),
      );
      if (ok) setWaypoints([]);
    }
    setState({ panel: 'ships' });
  };
  return (
    <div className="card">
      <div className="card-row">
        <button className="link" onClick={() => flyTo(ship.lat, ship.lon, 12)}>
          {ship.status === 'sailing' ? t('army.status.sailing') : t('army.status.idle')}
        </button>
        {ship.arriveAt && <span className="muted small">{t('common.eta', { t: formatTime(ship.arriveAt) })}</span>}
      </div>
      {ship.status === 'idle' && (
        <>
          <label className="field">
            <span>{t('ships.embark')}</span>
            <select value={armyId} onChange={(e) => setArmyId(e.target.value)}>
              <option value="">—</option>
              {armies
                .filter((a) => a.status === 'idle')
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {unitSummary(a)}
                  </option>
                ))}
            </select>
          </label>
          <div className="meta">{t('ships.waypoints', { n: waypoints.length })}</div>
          <div className="row-actions">
            <button className="secondary" onClick={() => void addWaypoint()}>
              {t('ships.addWaypoint')}
            </button>
            <button className="primary" onClick={() => void sail()}>
              {t('ships.sail')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ShipsPanel() {
  useLocale();
  const params = useParams();
  const ships = useApi<{ ships: ShipDto[] }>('/api/ships', ['armies']);
  const armies = useApi<{ armies: ArmyDto[] }>('/api/armies', ['armies']);
  const buy = async () => {
    setState({ panel: null });
    const p = await pickPoint('ships.pickCoast');
    if (p) await act('POST', '/api/ships', { lat: p.lat, lon: p.lon }, ['armies'], t('done.bought'));
    setState({ panel: 'ships' });
  };
  return (
    <Sheet title={t('ships.title')} onBack={() => setState({ panel: 'more' })}>
      <p className="muted small">
        {t('ships.capacity', { n: num(params, 'ships.capacityUnits') })} · {t('ships.hint')}
      </p>
      <button className="secondary" onClick={() => void buy()}>
        {t('ships.buy')} · {t('common.price', { n: num(params, 'ships.price') })}
      </button>
      {ships.data?.ships.map((s) => (
        <ShipCard key={s.id} ship={s} armies={armies.data?.armies ?? []} />
      ))}
    </Sheet>
  );
}
