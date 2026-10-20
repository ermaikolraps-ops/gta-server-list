import { useEffect } from 'react';
import { useLocale } from './i18n';
import { MapView } from './map/MapView';
import { MilitaryLayer } from './map/MilitaryLayer';
import { boot, refreshMe } from './session';
import { useStore } from './store';
import { AuthScreen } from './ui/AuthScreen';
import { GpsChip, Hud } from './ui/Hud';
import { Nav, Toasts } from './ui/Nav';
import { Panels } from './ui/Panels';
import { PickBanner, SelectionBar } from './ui/SelectionBar';

export function App() {
  useLocale();
  const authChecked = useStore((s) => s.authChecked);
  const me = useStore((s) => s.me);

  useEffect(() => {
    void boot();
  }, []);

  // Re-sync with the server's authoritative balance every minute.
  useEffect(() => {
    if (!me) return;
    const id = setInterval(() => void refreshMe(), 60_000);
    return () => clearInterval(id);
  }, [me?.id]);

  if (!authChecked) return <div className="splash" />;
  if (!me) return <AuthScreen />;
  return (
    <div className="app">
      <MapView />
      <MilitaryLayer />
      <Hud />
      <GpsChip />
      <Panels />
      <SelectionBar />
      <PickBanner />
      <Toasts />
      <Nav />
    </div>
  );
}
