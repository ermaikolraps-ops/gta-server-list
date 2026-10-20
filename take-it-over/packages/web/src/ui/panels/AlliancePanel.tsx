import type { MyAllianceView } from '@tio/shared';
import { useState } from 'react';
import { api, ApiError } from '../../api';
import { useApi } from '../../data';
import { errorMessage, formatNumber, t, useLocale } from '../../i18n';
import { refreshMe } from '../../session';
import { bump, toast, useStore } from '../../store';
import { Sheet } from '../Sheet';

async function call(path: string, body: unknown = {}): Promise<void> {
  try {
    await api('POST', path, body);
    bump('alliance', 'territory');
    void refreshMe();
  } catch (err) {
    toast(err instanceof ApiError ? errorMessage(err.code) : t('error.generic'), 'bad');
  }
}

export function AlliancePanel() {
  useLocale();
  const me = useStore((s) => s.me)!;
  const { data } = useApi<MyAllianceView>('/api/alliance', ['alliance']);
  const [name, setName] = useState('');
  const [color, setColor] = useState('#34d399');
  const [invitee, setInvitee] = useState('');
  const a = data?.alliance;
  const leader = a?.leaderId === me.id;
  return (
    <Sheet title={t('alliance.title')}>
      {!a && (
        <>
          <p className="muted">{t('alliance.none')}</p>
          {data?.invitations.map((i) => (
            <div key={i.allianceId} className="card card-row">
              <span>
                <span className="swatch" style={{ background: i.color }} /> {i.name}
              </span>
              <span className="row-actions">
                <button className="primary" onClick={() => void call(`/api/alliances/${i.allianceId}/accept`)}>
                  {t('alliance.accept')}
                </button>
                <button className="secondary" onClick={() => void call(`/api/alliances/${i.allianceId}/decline`)}>
                  {t('alliance.decline')}
                </button>
              </span>
            </div>
          ))}
          <h3>{t('alliance.create')}</h3>
          <div className="field">
            <input placeholder={t('alliance.name')} value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </div>
          <button className="primary" disabled={name.trim().length < 3} onClick={() => void call('/api/alliances', { name, color })}>
            {t('alliance.create')}
          </button>
        </>
      )}
      {a && (
        <>
          <div className="card-row">
            <strong>
              <span className="swatch" style={{ background: a.color }} /> {a.name}
            </strong>
            <span className="muted small">{t('alliance.members', { n: a.members.length, max: data!.maxMembers })}</span>
          </div>
          {a.members.map((m) => (
            <div key={m.id} className="card card-row">
              <span>
                <span className="swatch" style={{ background: m.color }} /> {m.name}
                {m.id === a.leaderId && <span className="badge approved"> {t('alliance.leader')}</span>}
              </span>
              <span className="muted small">{t('hud.parcels', { n: formatNumber(m.parcels) })}</span>
              {leader && m.id !== me.id && (
                <button className="link" onClick={() => void call('/api/alliance/kick', { playerId: m.id })}>
                  {t('alliance.kick')}
                </button>
              )}
            </div>
          ))}
          {leader && (
            <div className="field">
              <input placeholder={t('auth.username')} value={invitee} onChange={(e) => setInvitee(e.target.value)} />
              <button
                className="secondary"
                disabled={!invitee.trim()}
                onClick={async () => {
                  await call('/api/alliance/invite', { username: invitee.trim() });
                  setInvitee('');
                }}
              >
                {t('alliance.invite')}
              </button>
            </div>
          )}
          {a.invites.length > 0 && (
            <p className="muted small">
              {t('alliance.invites')}: {a.invites.map((i) => i.name).join(', ')}
            </p>
          )}
          <button className="danger" onClick={() => void call('/api/alliance/leave')}>
            {t('alliance.leave')}
          </button>
        </>
      )}
    </Sheet>
  );
}
