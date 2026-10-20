import { useStore } from '../store';
import { MorePanel, RulesPanel, SettingsPanel } from './SettingsPanels';

export function Panels() {
  const panel = useStore((s) => s.panel);
  switch (panel) {
    case 'more':
      return <MorePanel />;
    case 'settings':
      return <SettingsPanel />;
    case 'rules':
      return <RulesPanel />;
    default:
      return null;
  }
}
