import { type MessageKey, t, useLocale } from '../i18n';
import { type PanelId, setState, useStore } from '../store';

const ITEMS: { id: PanelId | null; key: MessageKey; icon: string }[] = [
  { id: null, key: 'nav.map', icon: '⌖' },
  { id: 'drones', key: 'nav.drones', icon: '✈' },
  { id: 'army', key: 'nav.army', icon: '⛨' },
  { id: 'wars', key: 'nav.wars', icon: '⚔' },
  { id: 'alliance', key: 'nav.alliance', icon: '⚑' },
  { id: 'more', key: 'nav.more', icon: '☰' },
];

export function Nav() {
  useLocale();
  const panel = useStore((s) => s.panel);
  return (
    <nav className="nav">
      {ITEMS.map((item) => (
        <button
          key={item.key}
          className={panel === item.id ? 'active' : ''}
          onClick={() => setState({ panel: item.id, mapMode: { kind: 'browse' } })}
        >
          <span className="nav-icon" aria-hidden>
            {item.icon}
          </span>
          <span>{t(item.key)}</span>
        </button>
      ))}
    </nav>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((x) => (
        <div key={x.id} className={`toast ${x.tone}`}>
          {x.text}
        </div>
      ))}
    </div>
  );
}
