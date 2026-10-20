import { useSyncExternalStore } from 'react';
import { en, type MessageKey } from './en';
import { es } from './es';

export type Locale = 'en' | 'es';
export type { MessageKey };

const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, es };

let current: Locale = 'en';
const listeners = new Set<() => void>();

export function setLocale(locale: Locale): void {
  if (locale === current) return;
  current = locale;
  document.documentElement.lang = locale;
  try {
    localStorage.setItem('tio.locale', locale);
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function getLocale(): Locale {
  return current;
}

/** English unless the player chose Spanish before (the account setting wins after login). */
export function initLocale(): void {
  try {
    const saved = localStorage.getItem('tio.locale');
    if (saved === 'es' || saved === 'en') current = saved;
  } catch {
    /* storage unavailable */
  }
  document.documentElement.lang = current;
}

export function translate(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  const template = dictionaries[locale][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(current, key, params);
}

/** Error codes from the server map to `error.<code>` messages when we have one. */
export function errorMessage(code: string | undefined): string {
  const key = `error.${code}` as MessageKey;
  return key in en ? t(key) : t('error.generic');
}

export function useLocale(): Locale {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(current === 'es' ? 'es-ES' : 'en-US').format(n);
}

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(current === 'es' ? 'es-ES' : 'en-US', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(ms),
  );
}
