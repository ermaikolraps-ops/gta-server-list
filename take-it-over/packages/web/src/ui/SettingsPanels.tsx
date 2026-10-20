import type { ParamEntry, Profile } from '@tio/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { type Locale, type MessageKey, setLocale, t, useLocale } from '../i18n';
import { logout } from '../session';
import { type PanelId, setState, useStore } from '../store';
import { Sheet } from './Sheet';

const CATEGORIES = ['conquest', 'drones', 'wars', 'armies', 'bases', 'alliance', 'economy'] as const;

export function SettingsPanel() {
  useLocale();
  const me = useStore((s) => s.me)!;
  const [keepAwake, setKeepAwake] = useState(() => {
    try {
      return localStorage.getItem('tio.keepAwake') === '1';
    } catch {
      return false;
    }
  });

  const patch = async (body: Partial<{ locale: Locale; color: string; notificationPrefs: Record<string, boolean> }>) => {
    const updated = await api<Profile>('PATCH', '/api/me', body);
    setState({ me: updated, meAt: Date.now() });
    if (body.locale) setLocale(body.locale);
  };

  return (
    <Sheet title={t('settings.title')} onBack={() => setState({ panel: 'more' })}>
      <div className="field">
        <span>{t('settings.language')}</span>
        <select value={me.locale} onChange={(e) => void patch({ locale: e.target.value as Locale })}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </select>
      </div>
      <div className="field">
        <span>{t('settings.color')}</span>
        <input type="color" value={me.color} onChange={(e) => void patch({ color: e.target.value })} />
      </div>
      <h3>{t('settings.notifications')}</h3>
      {CATEGORIES.map((c) => (
        <label key={c} className="toggle">
          <input
            type="checkbox"
            checked={me.notificationPrefs[c] !== false}
            onChange={(e) => void patch({ notificationPrefs: { [c]: e.target.checked } })}
          />
          {t(`settings.category.${c}` as MessageKey)}
        </label>
      ))}
      <h3>GPS</h3>
      <label className="toggle">
        <input
          type="checkbox"
          checked={keepAwake}
          onChange={(e) => {
            setKeepAwake(e.target.checked);
            try {
              localStorage.setItem('tio.keepAwake', e.target.checked ? '1' : '0');
            } catch {
              /* ignore */
            }
          }}
        />
        {t('gps.keepAwake')}
      </label>
      <p className="muted small">{t('gps.backgroundNote')}</p>
      <button className="danger" onClick={() => void logout()}>
        {t('auth.logout')}
      </button>
    </Sheet>
  );
}

export function RulesPanel() {
  useLocale();
  const [params, setParams] = useState<ParamEntry[] | null>(null);
  useEffect(() => {
    api<{ params: ParamEntry[] }>('GET', '/api/params').then((r) => setParams(r.params), () => setParams([]));
  }, []);
  const groups = new Map<string, ParamEntry[]>();
  for (const p of params ?? []) {
    const g = p.path.split('.')[0]!;
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  return (
    <Sheet title={t('settings.rules')} onBack={() => setState({ panel: 'more' })}>
      <p className="muted small">{t('settings.rulesNote')}</p>
      {!params && <p>{t('common.loading')}</p>}
      {[...groups].map(([g, entries]) => (
        <div key={g} className="param-group">
          <h3>{g}</h3>
          <table className="params">
            <tbody>
              {entries.map((e) => (
                <tr key={e.path} title={e.note}>
                  <td>{e.path.split('.').slice(1).join('.')}</td>
                  <td className="num">{String(e.value)}</td>
                  <td>
                    <span className={`badge ${e.status}`}>{t(e.status === 'approved' ? 'common.approved' : 'common.provisional')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </Sheet>
  );
}

export function MorePanel() {
  useLocale();
  const items: { id: PanelId; key: MessageKey }[] = [
    { id: 'bases', key: 'bases.title' },
    { id: 'ships', key: 'ships.title' },
    { id: 'rankings', key: 'rankings.title' },
    { id: 'notifications', key: 'notifications.title' },
    { id: 'settings', key: 'settings.title' },
    { id: 'rules', key: 'settings.rules' },
  ];
  return (
    <Sheet title={t('more.title')}>
      <div className="menu">
        {items.map((i) => (
          <button key={i.id} onClick={() => setState({ panel: i.id })}>
            {t(i.key)}
            <span aria-hidden>›</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}
