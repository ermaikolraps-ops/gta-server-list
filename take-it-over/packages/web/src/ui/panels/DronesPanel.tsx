import { DRONE_TYPES, type DroneDto, type MissionDto } from '@tio/shared';
import { useApi, num, useParams } from '../../data';
import { formatTime, type MessageKey, t, useLocale } from '../../i18n';
import { flyTo, setOverlay } from '../../map/MapView';
import { circlePolygon } from '../../map/territory';
import { setState, toast, useStore } from '../../store';
import { act } from '../act';
import { Sheet } from '../Sheet';

export interface DronesView {
  drones: DroneDto[];
  missions: MissionDto[];
  maxActive: number;
}

export function DronesPanel() {
  useLocale();
  const { data } = useApi<DronesView>('/api/drones', ['drones']);
  const params = useParams();
  const gps = useStore((s) => s.gps);
  const flying = data?.drones.filter((d) => d.status === 'flying').length ?? 0;

  const startSelecting = (d: DroneDto) => {
    if (gps.state !== 'on' || gps.lat === undefined || gps.lon === undefined) {
      toast(t('drones.needGps'), 'bad');
      return;
    }
    setOverlay('radius', circlePolygon(gps.lat, gps.lon, d.radiusKm * 1000));
    setState({ panel: null, mapMode: { kind: 'drone-targets', droneId: d.id, radiusKm: d.radiusKm, selected: [] } });
    flyTo(gps.lat, gps.lon, 14);
  };

  return (
    <Sheet title={t('drones.title')}>
      <p className="muted small">{t('drones.active', { n: flying, max: data?.maxActive ?? 10 })}</p>
      {data?.drones.map((d) => (
        <div key={d.id} className="card">
          <div className="card-row">
            <div>
              <strong>{t(`drones.${d.type}` as MessageKey)}</strong>
              <div className="meta">
                {t('drones.radius', { n: d.radiusKm })} · {t(`drones.status.${d.status}` as MessageKey)}
              </div>
            </div>
            {d.status === 'idle' && (
              <button className="secondary" onClick={() => startSelecting(d)}>
                {t('drones.selectTargets')}
              </button>
            )}
          </div>
        </div>
      ))}
      <h3>{t('drones.buy')}</h3>
      <div className="row-actions">
        {DRONE_TYPES.map((type) => (
          <button
            key={type}
            className="secondary"
            onClick={() => void act('POST', '/api/drones', { type }, ['drones'], t('done.bought'))}
          >
            {t(`drones.${type}` as MessageKey)}
            <div className="meta">
              {t('drones.radius', { n: num(params, `drones.types.${type}.radiusKm`) })} ·{' '}
              {t('common.price', { n: num(params, `drones.types.${type}.price`) })}
            </div>
          </button>
        ))}
      </div>
      <h3>{t('drones.missions')}</h3>
      {!data?.missions.length && <p className="muted">{t('common.none')}</p>}
      {data?.missions.map((m) => (
        <div key={m.id} className="card" onClick={() => flyTo(m.target.lat, m.target.lon, 14)}>
          <div className="meta">
            {m.status === 'outbound' && t('drones.mission.outbound', { t: formatTime(m.arriveAt) })}
            {m.status === 'returning' && t('drones.mission.returning', { t: formatTime(m.returnAt) })}
            {m.status === 'completed' && t('drones.mission.completed', { n: m.captured.length })}
            {m.status === 'destroyed' && t('drones.mission.destroyed')}
          </div>
        </div>
      ))}
    </Sheet>
  );
}
