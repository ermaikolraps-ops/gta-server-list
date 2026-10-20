import type { MessageKey } from '../i18n';
import { onMapClick } from '../map/MapView';
import { setState } from '../store';

export interface Picked {
  lat: number;
  lon: number;
  cell: number;
}

let cancelCurrent: (() => void) | null = null;

/** Asks the player to tap the map; resolves with the tapped point, or null if cancelled. */
export function pickPoint(hint: MessageKey): Promise<Picked | null> {
  cancelCurrent?.();
  return new Promise((resolve) => {
    const finish = (p: Picked | null) => {
      onMapClick(null);
      cancelCurrent = null;
      setState({ pickHint: null });
      resolve(p);
    };
    cancelCurrent = () => finish(null);
    setState({ pickHint: hint });
    onMapClick((p) => finish(p));
  });
}

export function cancelPick(): void {
  cancelCurrent?.();
}
