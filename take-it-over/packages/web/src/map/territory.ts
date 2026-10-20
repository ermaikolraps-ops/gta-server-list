import { type CellId, cellRing, cellsInBBox, type TerritoryView } from '@tio/shared';
import type { FeatureCollection, Polygon, LineString } from 'geojson';

export const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/**
 * Converts a territory response into GeoJSON. Close up, every parcel is drawn
 * in its owner's colour. Zoomed out, bins are drawn in the alliance colour
 * when the dominant owner has one, with opacity by how full the bin is.
 */
export function territoryToGeoJSON(view: TerritoryView, myId: string | null): FeatureCollection<Polygon> {
  if (view.mode === 'cells') {
    return {
      type: 'FeatureCollection',
      features: view.cells.map(([id, idx]) => {
        const o = view.owners[idx]!;
        // No feature `id`: cell ids (~1e11) exceed what MapLibre's tile index keeps
        // reliably, and nothing here needs feature-state.
        return {
          type: 'Feature',
          properties: { cell: id, owner: o.id, name: o.name, color: o.color, mine: o.id === myId },
          geometry: { type: 'Polygon', coordinates: [cellRing(id)] },
        };
      }),
    };
  }
  const deg = view.zoneDeg;
  return {
    type: 'FeatureCollection',
    features: view.zones.map(([bz, bx, idx, count]) => {
      const o = view.owners[idx]!;
      const south = -90 + bz * deg;
      const west = -180 + bx * deg;
      const midLat = ((south + deg / 2) * Math.PI) / 180;
      const binCells = (deg * 111.2) ** 2 * Math.cos(midLat) * 100;
      const density = Math.min(1, count / Math.max(1, binCells));
      return {
        type: 'Feature',
        properties: {
          owner: o.id,
          name: o.name,
          color: o.allianceColor ?? o.color,
          mine: o.id === myId,
          opacity: 0.2 + 0.55 * Math.sqrt(density),
          count,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [west, south],
              [west + deg, south],
              [west + deg, south + deg],
              [west, south + deg],
              [west, south],
            ],
          ],
        },
      };
    }),
  };
}

/** Faint outlines of every grid cell in view (only at high zoom). */
export function gridLines(bounds: { west: number; south: number; east: number; north: number }): FeatureCollection<LineString> {
  const cells = cellsInBBox(bounds, 6000);
  if (!cells) return EMPTY as FeatureCollection<LineString>;
  return {
    type: 'FeatureCollection',
    features: cells.map((id) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: cellRing(id) },
    })),
  };
}

export function cellsToGeoJSON(ids: CellId[], props: Record<string, unknown> = {}): FeatureCollection<Polygon> {
  return {
    type: 'FeatureCollection',
    features: ids.map((id) => ({
      type: 'Feature',
      properties: { ...props, cell: id },
      geometry: { type: 'Polygon', coordinates: [cellRing(id)] },
    })),
  };
}

/** A geodesic circle polygon (for drone and AA radii). */
export function circlePolygon(lat: number, lon: number, radiusM: number, steps = 96): FeatureCollection<Polygon> {
  const R = 6371008.8;
  const d = radiusM / R;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const brg = (2 * Math.PI * i) / steps;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(brg));
    const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    ring.push([(l2 * 180) / Math.PI, (p2 * 180) / Math.PI]);
  }
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
}
