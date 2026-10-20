import { useEffect, useState } from 'react';
import { formatNumber, t, useLocale } from '../i18n';
import { startGps, stopGps } from '../gps';
import { setState, useStore } from '../store';

/** Credits tick up smoothly between server refreshes using the known income rate. */
function useTickingCredits(): number {
  const me = useStore((s) => s.me);
  const meAt = useStore((s) => s.meAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (!me) return 0;
  const earned = (me.incomePerHour * (now - meAt)) / 3_600_000;
  return Math.floor(me.credits + me.creditFraction + earned);
}

export function Hud() {
  useLocale();
  const me = useStore((s) => s.me)!;
  const credits = useTickingCredits();
  const unread = useStore((s) => s.ticks.notifications);
  void unread;
  return (
    <header className="hud">
      <div className="hud-credits" data-testid="credits">
        <span className="label">{t('hud.credits')}</span>
        <strong>{formatNumber(credits)}</strong>
        <span className="rate">{t('hud.perHour', { n: formatNumber(me.incomePerHour) })}</span>
      </div>
      <div className="hud-parcels">{t('hud.parcels', { n: formatNumber(me.parcels) })}</div>
      <button className="icon-btn" aria-label={t('notifications.title')} onClick={() => setState({ panel: 'notifications' })}>
        🔔
      </button>
    </header>
  );
}

export function GpsChip() {
  useLocale();
  const gps = useStore((s) => s.gps);
  const suspended = useStore((s) => s.me?.gpsSuspendedUntil);
  const last = gps.last;
  let text: string;
  let tone = 'neutral';
  if (gps.state === 'off') text = t('gps.off');
  else if (gps.state === 'denied') text = t('gps.denied');
  else if (gps.state === 'unavailable') text = t('gps.unavailable');
  else if (gps.state === 'waiting' || !last) text = t('gps.waiting');
  else if (suspended && last.status !== 'own' && last.status !== 'enemy' && last.status !== 'water')
    text = t('gps.status.suspended');
  else if (last.status === 'tracking') {
    text = t('gps.status.tracking', {
      s: ((last.dwellMs ?? 0) / 1000).toFixed(1),
      total: (last.requiredMs / 1000).toFixed(0),
    });
    tone = 'warn';
  } else {
    text = t(`gps.status.${last.status}`);
    tone = last.status === 'enemy' ? 'bad' : last.status === 'conquered' || last.status === 'own' ? 'good' : 'neutral';
  }
  const progress = last?.status === 'tracking' ? Math.min(1, (last.dwellMs ?? 0) / last.requiredMs) : 0;
  const running = gps.state === 'on' || gps.state === 'waiting';
  return (
    <div className={`gps-chip ${tone}`} data-testid="gps-chip">
      <div className="gps-text">
        <span>{text}</span>
        {gps.accuracy !== undefined && running && (
          <span className={`acc ${gps.accuracy > 20 ? 'bad' : ''}`}>{t('gps.accuracy', { n: Math.round(gps.accuracy) })}</span>
        )}
      </div>
      {progress > 0 && <div className="progress" style={{ width: `${progress * 100}%` }} />}
      <button className="small-btn" onClick={() => (running ? stopGps() : startGps())}>
        {running ? t('gps.stop') : t('gps.start')}
      </button>
    </div>
  );
}
