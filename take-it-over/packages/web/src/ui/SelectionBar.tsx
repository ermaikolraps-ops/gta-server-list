import { type DronePreview, isConnected } from '@tio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { num, useParams } from '../data';
import { t, useLocale } from '../i18n';
import { setOverlay } from '../map/MapView';
import { EMPTY } from '../map/territory';
import { setState, useStore } from '../store';
import { act } from './act';
import { cancelPick } from './pick';

/** Floating bar while picking drone targets or a war sector on the map. */
export function SelectionBar() {
  useLocale();
  const mode = useStore((s) => s.mapMode);
  const params = useParams();
  const [preview, setPreview] = useState<DronePreview | null>(null);

  const droneId = mode.kind === 'drone-targets' ? mode.droneId : null;
  const selected = mode.kind === 'drone-targets' || mode.kind === 'war-sector' ? mode.selected : [];
  useEffect(() => {
    if (!droneId || !selected.length) {
      setPreview(null);
      return;
    }
    const id = setTimeout(() => {
      api<DronePreview>('POST', `/api/drones/${droneId}/preview`, { targets: selected }).then(setPreview, () => setPreview(null));
    }, 250);
    return () => clearTimeout(id);
  }, [droneId, selected.join(',')]);

  if (mode.kind !== 'drone-targets' && mode.kind !== 'war-sector') return null;
  const close = () => {
    setOverlay('radius', EMPTY);
    setState({ mapMode: { kind: 'browse' } });
  };

  if (mode.kind === 'drone-targets') {
    const max = num(params, 'drones.maxTargets') || 20;
    const problems: string[] = [];
    if (selected.length > max) problems.push(t('drones.invalid.tooMany', { max }));
    if (selected.length > 1 && !isConnected(selected)) problems.push(t('drones.invalid.notConnected'));
    if (preview?.cells.some((c) => c.status === 'water' || c.status === 'owned')) problems.push(t('drones.invalid.notNeutral'));
    if (preview?.cells.some((c) => c.status === 'out_of_range')) problems.push(t('drones.invalid.outOfRange'));
    const launch = async () => {
      const r = await act('POST', `/api/drones/${mode.droneId}/launch`, { targets: selected }, ['drones'], t('done.droneLaunched'));
      if (r) close();
    };
    return (
      <div className="selection-bar">
        <div className="muted small">{t('drones.selecting', { max, r: mode.radiusKm })}</div>
        <div className="card-row">
          <strong>{t('drones.selected', { n: selected.length })}</strong>
          {preview?.arriveAt && <span className="muted small">{t('common.eta', { t: new Date(preview.arriveAt).toLocaleTimeString() })}</span>}
        </div>
        {problems.map((p) => (
          <div key={p} className="error">
            {p}
          </div>
        ))}
        <div className="row-actions">
          <button className="secondary" onClick={close}>
            {t('common.cancel')}
          </button>
          <button className="secondary" onClick={() => setState({ mapMode: { ...mode, selected: [] } })}>
            {t('drones.clear')}
          </button>
          <button className="primary" disabled={!preview?.ok} onClick={() => void launch()}>
            {t('drones.launch')}
          </button>
        </div>
      </div>
    );
  }

  const max = num(params, 'war.maxSectorParcels') || 100;
  const ok = selected.length > 0 && selected.length <= max && isConnected(selected);
  const declare = async () => {
    const r = await act('POST', '/api/wars', { sector: selected, armyIds: mode.armyIds }, ['wars', 'armies', 'territory']);
    if (r) {
      close();
      setState({ panel: 'wars' });
    }
  };
  return (
    <div className="selection-bar">
      <div className="muted small">{t('army.attackHint', { max })}</div>
      <strong>{t('wars.sector', { n: selected.length })}</strong>
      {selected.length > 1 && !isConnected(selected) && <div className="error">{t('drones.invalid.notConnected')}</div>}
      <div className="row-actions">
        <button className="secondary" onClick={close}>
          {t('common.cancel')}
        </button>
        <button className="danger-solid" disabled={!ok} onClick={() => void declare()}>
          {t('wars.declare')}
        </button>
      </div>
    </div>
  );
}

export function PickBanner() {
  useLocale();
  const hint = useStore((s) => s.pickHint);
  if (!hint) return null;
  return (
    <div className="selection-bar">
      <div>{t(hint)}</div>
      <div className="row-actions">
        <button className="secondary" onClick={cancelPick}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
