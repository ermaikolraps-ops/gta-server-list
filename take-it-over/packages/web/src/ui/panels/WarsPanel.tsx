import type { ArmyDto, WarDto } from '@tio/shared';
import { useState } from 'react';
import { useApi } from '../../data';
import { formatNumber, formatTime, t, useLocale } from '../../i18n';
import { flyTo } from '../../map/MapView';
import { act } from '../act';
import { Sheet } from '../Sheet';
import { unitSummary } from './ArmyPanel';

function WarCard({ war, idle }: { war: WarDto; idle: ArmyDto[] }) {
  const [armyId, setArmyId] = useState('');
  const mine = war.role === 'attacker' ? war.attacker : war.defender;
  const them = war.role === 'attacker' ? war.defender : war.attacker;
  const won = war.winner === war.role;
  return (
    <div className="card">
      <div className="card-row">
        <button className="link" onClick={() => flyTo(war.center.lat, war.center.lon, 15)}>
          {war.attacker.name} ⚔ {war.defender.name}
        </button>
        <span className={`badge ${war.role === 'attacker' ? 'provisional' : 'approved'}`}>
          {t(war.role === 'attacker' ? 'wars.attacker' : 'wars.defender')}
        </span>
      </div>
      <div className="meta">
        {t('wars.sector', { n: war.sector.length })} · {mine.name} vs {them.name}
      </div>
      {war.status === 'active' ? (
        <>
          <div className="bar">
            <div style={{ width: `${(war.round / war.totalRounds) * 100}%` }} />
          </div>
          <div className="meta">
            {t('wars.round', { n: war.round, total: war.totalRounds })} · {t('wars.endsAt', { t: formatTime(war.endsAt) })}
          </div>
          <div className="card-row">
            <span>{t('wars.yourForces')}</span>
            <strong>{formatNumber(Math.round(war.friendly.power ?? 0))}</strong>
          </div>
          {war.friendly.armies?.map((a) => (
            <div key={a.id} className="meta">
              {a.mine ? '★ ' : ''}
              {a.ownerName}: {formatNumber(a.headcount)} · {formatNumber(Math.round(a.power))}
              {a.arriveAt ? ` · ${t('common.eta', { t: formatTime(a.arriveAt) })}` : ''}
            </div>
          ))}
          <div className="card-row">
            <span>{t('wars.enemyEstimate')}</span>
            <strong>
              {war.enemy.band ? `${formatNumber(war.enemy.band[0])}–${formatNumber(war.enemy.band[1])}` : '?'}
            </strong>
          </div>
          {idle.length > 0 && (
            <div className="row-actions">
              <select value={armyId} onChange={(e) => setArmyId(e.target.value)}>
                <option value="">{t('wars.reinforce')}…</option>
                {idle.map((a) => (
                  <option key={a.id} value={a.id}>
                    {unitSummary(a)}
                  </option>
                ))}
              </select>
              <button
                className="secondary"
                disabled={!armyId}
                onClick={() => void act('POST', `/api/wars/${war.id}/reinforce`, { armyIds: [armyId] }, ['wars', 'armies'])}
              >
                {t('wars.reinforce')}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="meta">
          <strong className={won ? 'good' : 'bad'}>{t(won ? 'wars.won' : 'wars.lost')}</strong>
          {war.outcome?.surrendered && ` · ${t('wars.surrendered')}`}
          {war.outcome && ` · ${t('wars.conquered', { n: war.outcome.conquered.length })}`}
          {war.outcome &&
            ` · ${t('wars.casualties', { n: formatNumber(war.outcome.casualties[war.role]) })}`}
        </div>
      )}
    </div>
  );
}

export function WarsPanel() {
  useLocale();
  const wars = useApi<{ wars: WarDto[] }>('/api/wars', ['wars']);
  const armies = useApi<{ armies: ArmyDto[] }>('/api/armies', ['armies']);
  const idle = (armies.data?.armies ?? []).filter((a) => a.status === 'idle' && a.headcount > 0);
  return (
    <Sheet title={t('wars.title')}>
      {!wars.data?.wars.length && <p className="muted">{t('wars.none')}</p>}
      {wars.data?.wars.map((w) => (
        <WarCard key={w.id} war={w} idle={idle} />
      ))}
    </Sheet>
  );
}
