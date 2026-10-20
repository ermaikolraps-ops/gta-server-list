import { type FormEvent, useState } from 'react';
import { ApiError } from '../api';
import { errorMessage, setLocale, t, useLocale } from '../i18n';
import { loginOrRegister } from '../session';

export function AuthScreen() {
  useLocale();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginOrRegister(mode, username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? errorMessage(err.code) : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <img src="icons/icon-192.png" alt="" width={72} height={72} />
        <h1>{t('app.name')}</h1>
        <p className="muted">{t('app.tagline')}</p>
        <form onSubmit={submit}>
          <label>
            {t('auth.username')}
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              minLength={3}
              maxLength={20}
              required
            />
          </label>
          <label>
            {t('auth.password')}
            <input
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={mode === 'register' ? 8 : 1}
              required
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={busy}>
            {mode === 'login' ? t('auth.login') : t('auth.register')}
          </button>
        </form>
        {mode === 'register' && <p className="muted small">{t('auth.starter')}</p>}
        <button className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? t('auth.switchToRegister') : t('auth.switchToLogin')}
        </button>
        <div className="lang-switch">
          <button className="link" onClick={() => setLocale('en')}>
            English
          </button>
          ·
          <button className="link" onClick={() => setLocale('es')}>
            Español
          </button>
        </div>
      </div>
    </div>
  );
}
