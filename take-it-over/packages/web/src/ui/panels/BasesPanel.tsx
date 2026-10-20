import type { AaDto, BaseDto } from '@tio/shared';
import { useState } from 'react';
import { num, useApi, useParams } from '../../data';
import { formatNumber, t, useLocale } from '../../i18n';
import { flyTo } from '../../map/MapView';
import { setState } from '../../store';
import { act } from '../act';
import { pickPoint } from '../pick';
import { Sheet } from '../Sheet';
import { hasUnits, type UnitCounts, UnitPicker, unitCost } from '../UnitPicker';

function Recruit({ base }: { base: BaseDto }) {
  const [units, setUnits] = useState<UnitCounts>({});
  const params = useParams();
  return (
    <>
      <UnitPicker value={units} onChange={setUnits} />
      <div className="card-row">
        <span className="muted small">{t('army.total', { n: formatNumber(unitCost(units, params)) })}</span>
        <button
          className="primary"
          disabled={!hasUnits(units)}
          onClick={async () => {
            if (await act('POST', `/api/bases/${base.id}/recruit`, { units }, ['armies'], t('done.recruited'))) setUnits({});
          }}
        >
          {t('army.recruit')}
        </button>
      </div>
    </>
  );
}

export function BasesPanel() {
  useLocale();
  const params = useParams();
  const bases = useApi<{ bases: BaseDto[] }>('/api/bases', ['armies', 'territory']);
  const aa = useApi<{ batteries: AaDto[] }>('/api/aa', ['armies', 'territory']);
  const [open, setOpen] = useState<string | null>(null);

  const build = async (what: 'base' | 'aa') => {
    setState({ panel: null });
    const p = await pickPoint(what === 'base' ? 'bases.pickCell' : 'bases.pickAaCell');
    if (p) {
      await act('POST', what === 'base' ? '/api/bases' : '/api/aa', { cellId: p.cell }, ['armies', 'territory'], t('done.built'));
      bases.reload();
      aa.reload();
    }
    setState({ panel: 'bases' });
  };

  return (
    <Sheet title={t('bases.title')} onBack={() => setState({ panel: 'more' })}>
      <p className="muted small">{t('bases.buildHint')}</p>
      <div className="row-actions">
        <button className="secondary" onClick={() => void build('base')}>
          {t('bases.build')} · {t('common.price', { n: num(params, 'bases.price') })}
        </button>
        <button className="secondary" onClick={() => void build('aa')}>
          {t('bases.buildAA')} · {t('common.price', { n: num(params, 'aa.price') })}
        </button>
      </div>
      {bases.data?.bases.map((b) => (
        <div key={b.id} className="card">
          <div className="card-row">
            <button className="link" onClick={() => flyTo(b.lat, b.lon, 16)}>
              {b.mine ? t('bases.mine') : t('bases.allied', { name: b.ownerName })}
            </button>
            {b.mine && (
              <button className="secondary" onClick={() => setOpen(open === b.id ? null : b.id)}>
                {t('army.recruit')}
              </button>
            )}
          </div>
          {open === b.id && <Recruit base={b} />}
        </div>
      ))}
      <h3>{t('bases.aa')}</h3>
      <p className="muted small">{t('bases.aaHint')}</p>
      {aa.data?.batteries.map((b) => (
        <div key={b.id} className="card" onClick={() => flyTo(b.lat, b.lon, 13)}>
          <span className="meta">#{b.cellId}</span>
        </div>
      ))}
    </Sheet>
  );
}
