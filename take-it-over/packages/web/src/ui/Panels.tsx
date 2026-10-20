import { useStore } from '../store';
import { AlliancePanel } from './panels/AlliancePanel';
import { ArmyPanel } from './panels/ArmyPanel';
import { BasesPanel } from './panels/BasesPanel';
import { DronesPanel } from './panels/DronesPanel';
import { ShipsPanel } from './panels/ShipsPanel';
import { NotificationsPanel, RankingsPanel } from './panels/SocialPanels';
import { WarsPanel } from './panels/WarsPanel';
import { MorePanel, RulesPanel, SettingsPanel } from './SettingsPanels';

export function Panels() {
  const panel = useStore((s) => s.panel);
  switch (panel) {
    case 'drones':
      return <DronesPanel />;
    case 'army':
      return <ArmyPanel />;
    case 'wars':
      return <WarsPanel />;
    case 'alliance':
      return <AlliancePanel />;
    case 'bases':
      return <BasesPanel />;
    case 'ships':
      return <ShipsPanel />;
    case 'rankings':
      return <RankingsPanel />;
    case 'notifications':
      return <NotificationsPanel />;
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
