import {
  type AaDto,
  type ArmyDto,
  type BaseDto,
  cellRing,
  distanceM,
  interpolate,
  type LatLon,
  type MissionDto,
  positionAt,
  type ShipDto,
  type WarDto,
} from '@tio/shared';
import type { Feature, FeatureCollection } from 'geojson';
import { useEffect, useState } from 'react';
import { useApi } from '../data';
import { useStore } from '../store';
import { setOverlay } from './MapView';

const COLORS = {
  army: '#34d399',
  moving: '#fbbf24',
  war: '#ef4444',
  base: '#f59e0b',
  allyBase: '#93c5fd',
  aa: '#a855f7',
  ship: '#38bdf8',
  drone: '#e5e7eb',
};

function along(route: LatLon[], departAt: number, arriveAt: number, now: number): LatLon {
  const legs = route.slice(1).map((p, i) => distanceM(route[i]!, p));
  const total = legs.reduce((s, x) => s + x, 0);
  let d = (Math.min(1, Math.max(0, (now - departAt) / Math.max(1, arriveAt - departAt)))) * total;
  for (let i = 0; i < legs.length; i++) {
    if (d <= legs[i]! || i === legs.length - 1) return interpolate(route[i]!, route[i + 1]!, legs[i]! ? Math.min(1, d / legs[i]!) : 1);
    d -= legs[i]!;
  }
  return route[route.length - 1]!;
}

const point = (p: LatLon, props: Record<string, unknown>): Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
});
const line = (pts: LatLon[], props: Record<string, unknown>): Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) },
});

function compact(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}

/** Draws the player's own (and allied) military on the map, animating anything in motion. */
export function MilitaryLayer() {
  const me = useStore((s) => s.me);
  const armies = useApi<{ armies: ArmyDto[] }>(me ? '/api/armies' : null, ['armies']);
  const bases = useApi<{ bases: BaseDto[] }>(me ? '/api/bases' : null, ['armies', 'territory']);
  const aa = useApi<{ batteries: AaDto[] }>(me ? '/api/aa' : null, ['armies', 'territory']);
  const ships = useApi<{ ships: ShipDto[] }>(me ? '/api/ships' : null, ['armies']);
  const drones = useApi<{ missions: MissionDto[] }>(me ? '/api/drones' : null, ['drones']);
  const wars = useApi<{ wars: WarDto[] }>(me ? '/api/wars' : null, ['wars']);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const markers: Feature[] = [];
    const paths: Feature[] = [];
    for (const w of wars.data?.wars ?? []) {
      if (w.status !== 'active') continue;
      for (const c of w.sector) paths.push(line(cellRing(c).map(([lon, lat]) => ({ lat, lon })), { color: COLORS.war }));
      markers.push(point(w.center, { color: COLORS.war, size: 10, label: `⚔ ${w.round}/${w.totalRounds}` }));
    }
    for (const b of bases.data?.bases ?? []) {
      markers.push(point(b, { color: b.mine ? COLORS.base : COLORS.allyBase, size: 12, label: b.mine ? 'HQ' : b.ownerName }));
    }
    for (const b of aa.data?.batteries ?? []) markers.push(point(b, { color: COLORS.aa, size: 6, label: 'AA' }));
    for (const a of armies.data?.armies ?? []) {
      if (a.status === 'sailing') continue;
      let pos: LatLon = a;
      if (a.movement) {
        const f = (now - a.movement.departAt) / Math.max(1, a.movement.arriveAt - a.movement.departAt);
        pos = interpolate(a.movement.from, a.movement.to, Math.min(1, Math.max(0, f)));
        paths.push(line([a.movement.from, a.movement.to], { color: COLORS.moving }));
      }
      const color = a.status === 'at_war' ? COLORS.war : a.movement ? COLORS.moving : COLORS.army;
      markers.push(point(pos, { color, size: 7, label: compact(a.headcount) }));
    }
    for (const s of ships.data?.ships ?? []) {
      const pos = s.route && s.departAt && s.arriveAt ? along(s.route, s.departAt, s.arriveAt, now) : s;
      if (s.route) paths.push(line(s.route, { color: COLORS.ship }));
      markers.push(point(pos, { color: COLORS.ship, size: 7, label: s.cargoArmyId ? '⛴ ✦' : '⛴' }));
    }
    for (const m of drones.data?.missions ?? []) {
      if (m.status !== 'outbound' && m.status !== 'returning') continue;
      const plan = { launch: m.launch, target: m.target, launchedAt: m.launchedAt, arriveAt: m.arriveAt, returnAt: m.returnAt };
      paths.push(line([m.launch, m.target], { color: COLORS.drone }));
      markers.push(point(positionAt(plan, now), { color: COLORS.drone, size: 5, label: '✈' }));
    }
    const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
    setOverlay('markers', fc(markers));
    setOverlay('paths', fc(paths));
  }, [armies.data, bases.data, aa.data, ships.data, drones.data, wars.data, now]);

  return null;
}
