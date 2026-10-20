import type { ReactNode } from 'react';
import { t } from '../i18n';
import { setState } from '../store';

/** A bottom sheet over the map; the map stays usable above it. */
export function Sheet({ title, children, onBack }: { title: string; children: ReactNode; onBack?: () => void }) {
  return (
    <section className="sheet" role="dialog" aria-label={title}>
      <div className="sheet-head">
        {onBack && (
          <button className="icon-btn" onClick={onBack} aria-label="back">
            ‹
          </button>
        )}
        <h2>{title}</h2>
        <button
          className="icon-btn"
          onClick={() => setState({ panel: null, mapMode: { kind: 'browse' } })}
          aria-label={t('common.close')}
        >
          ×
        </button>
      </div>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
