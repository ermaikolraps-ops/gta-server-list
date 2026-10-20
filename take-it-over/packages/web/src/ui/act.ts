import { api, ApiError } from '../api';
import { errorMessage, t } from '../i18n';
import { bump, toast } from '../store';
import { refreshMe } from '../session';

/**
 * Runs a game action (always idempotent on the server), shows a toast on
 * failure and refreshes the views it may have changed.
 */
export async function act<T>(
  method: 'POST' | 'PATCH',
  path: string,
  body: unknown,
  refresh: Parameters<typeof bump>,
  success?: string,
): Promise<T | null> {
  try {
    const res = await api<T>(method, path, body, { idempotent: true });
    if (success) toast(success, 'good');
    bump(...refresh);
    void refreshMe();
    return res;
  } catch (err) {
    toast(err instanceof ApiError ? errorMessage(err.code) : t('error.generic'), 'bad');
    return null;
  }
}
