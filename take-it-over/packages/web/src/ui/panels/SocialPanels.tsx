import type { NotificationDto, RankingDto, RankingMetric } from '@tio/shared';
import { useState } from 'react';
import { api } from '../../api';
import { useApi } from '../../data';
import { formatNumber, formatTime, type MessageKey, t, useLocale } from '../../i18n';
import { bump, setState } from '../../store';
import { Sheet } from '../Sheet';

const METRICS: { id: RankingMetric; key: MessageKey }[] = [
  { id: 'territory', key: 'rankings.territory' },
  { id: 'wars', key: 'rankings.wars' },
  { id: 'drones', key: 'rankings.drones' },
];

export function RankingsPanel() {
  useLocale();
  const [metric, setMetric] = useState<RankingMetric>('territory');
  const { data } = useApi<RankingDto>(`/api/rankings?metric=${metric}`, ['territory', 'wars']);
  return (
    <Sheet title={t('rankings.title')} onBack={() => setState({ panel: 'more' })}>
      <div className="row-actions">
        {METRICS.map((m) => (
          <button key={m.id} className={metric === m.id ? 'primary' : 'secondary'} onClick={() => setMetric(m.id)}>
            {t(m.key)}
          </button>
        ))}
      </div>
      <p className="muted small">{t('rankings.note')}</p>
      <table className="params">
        <tbody>
          {data?.rows.map((r) => (
            <tr key={r.id}>
              <td className="num">{r.rank}</td>
              <td>
                <span className="swatch" style={{ background: r.color }} /> {r.name}
              </td>
              <td className="num">{formatNumber(r.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.me && (
        <p className="muted small">
          #{data.me.rank} · {formatNumber(data.me.value)}
        </p>
      )}
    </Sheet>
  );
}

export function NotificationsPanel() {
  useLocale();
  const { data, reload } = useApi<{ items: NotificationDto[]; unread: number }>('/api/notifications', ['notifications']);
  return (
    <Sheet title={t('notifications.title')}>
      {!data?.items.length && <p className="muted">{t('notifications.empty')}</p>}
      {!!data?.unread && (
        <button
          className="secondary"
          onClick={async () => {
            await api('POST', '/api/notifications/read');
            bump('notifications');
            reload();
          }}
        >
          {t('notifications.markRead')}
        </button>
      )}
      {data?.items.map((n) => (
        <div key={n.id} className={`card toast ${n.tone}`} style={{ opacity: n.read ? 0.6 : 1 }}>
          <div>{t(n.key as MessageKey, n.params)}</div>
          <div className="meta">{formatTime(n.createdAt)}</div>
        </div>
      ))}
    </Sheet>
  );
}
