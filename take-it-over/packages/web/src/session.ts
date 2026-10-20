import type { Profile } from '@tio/shared';
import { api, ApiError } from './api';
import { type Locale, setLocale } from './i18n';
import { startLive, stopLive } from './live';
import { resetState, setState } from './store';

function applyProfile(me: Profile): void {
  setState({ me, meAt: Date.now(), authChecked: true });
  if (me.locale === 'en' || me.locale === 'es') setLocale(me.locale as Locale);
}

export async function refreshMe(): Promise<Profile | null> {
  try {
    const me = await api<Profile>('GET', '/api/me');
    applyProfile(me);
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      stopLive();
      resetState();
    }
    return null;
  }
}

export async function boot(): Promise<void> {
  const me = await refreshMe();
  if (me) startLive();
  else setState({ authChecked: true });
}

export async function loginOrRegister(mode: 'login' | 'register', username: string, password: string): Promise<void> {
  const me = await api<Profile>('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register', {
    username,
    password,
  });
  applyProfile(me);
  startLive();
}

export async function logout(): Promise<void> {
  await api('POST', '/api/auth/logout').catch(() => {});
  stopLive();
  resetState();
}
