import { cellAt, cellRing, type CellInfo, isConnected, type TerritoryView } from '@tio/shared';
import type { FeatureCollection } from 'geojson';
import maplibregl, { type GeoJSONSource, type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { t } from '../i18n';
import { getState, setState, useStore } from '../store';
import { militaryStyle } from './style';
import { circlePolygon, EMPTY, gridLines, territoryToGeoJSON } from './territory';

let mapRef: MlMap | null = null;
let territorySeq = 0;
const pendingOverlays = new Map<string, FeatureCollection>();

/** Panels draw markers, paths, selections and radii through these overlays. */
export type OverlayId = 'markers' | 'paths' | 'selection' | 'radius';

export function setOverlay(id: OverlayId, data: FeatureCollection): void {
  const src = mapRef?.getSource(`ov-${id}`) as GeoJSONSource | undefined;
  if (src) src.setData(data);
  else pendingOverlays.set(id, data);
}

export function flyTo(lat: number, lon: number, zoom?: number): void {
  mapRef?.flyTo({ center: [lon, lat], zoom: zoom ?? Math.max(mapRef.getZoom(), 15) });
}

type MapClickHandler = (p: { lat: number; lon: number; cell: number }) => void;
let clickHandler: MapClickHandler | null = null;
/** Lets a panel take over map taps (e.g. choosing an army destination). */
export function onMapClick(handler: MapClickHandler | null): void {
  clickHandler = handler;
}

/** MapLibre zoom is 512-px based: at 16 a 100 m cell is ~110 px wide at mid latitudes. */
const FOLLOW_ZOOM = 16;

const STATUS_COLOR: Record<string, string> = {
  tracking: '#fbbf24',
  conquered: '#34d399',
  own: '#34d399',
  enemy: '#ef4444',
  water: '#38bdf8',
  low_accuracy: '#a3a3a3',
  suspended: '#a3a3a3',
  rate_limited: '#a3a3a3',
};

function loadSavedView(): { center: [number, number]; zoom: number } {
  try {
    const v = JSON.parse(localStorage.getItem('tio.view') ?? '');
    if (Array.isArray(v.center) && typeof v.zoom === 'number') return v;
  } catch {
    /* none saved */
  }
  return { center: [0, 25], zoom: 1.6 };
}

export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const [cellInfo, setCellInfo] = useState<CellInfo | null>(null);
  const [basemapFailed, setBasemapFailed] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const territoryTick = useStore((s) => s.ticks.territory);
  const myId = useStore((s) => s.me?.id ?? null);
  const gps = useStore((s) => s.gps);
  const mode = useStore((s) => s.mapMode);
  const focus = useStore((s) => s.focus);
  const [showGrid, setShowGrid] = useState(true);
  const [follow, setFollow] = useState(true);
  const loaded = useRef(false);
  const hadFix = useRef(false);

  useEffect(() => {
    const saved = loadSavedView();
    const map = new maplibregl.Map({
      container: container.current!,
      style: militaryStyle(),
      center: saved.center,
      zoom: saved.zoom,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.touchZoomRotate.disableRotation();
    mapRef = map;
    map.on('error', (e) => {
      const msg = String((e as { error?: Error }).error?.message ?? '');
      if (/tiles|planet|fetch|Failed/i.test(msg)) setBasemapFailed(true);
    });
    map.on('load', () => {
      const add = (id: string, data: FeatureCollection = EMPTY) => map.addSource(id, { type: 'geojson', data });
      add('zones');
      add('cells');
      add('grid');
      for (const id of ['radius', 'selection', 'paths', 'markers'] as const) add(`ov-${id}`, pendingOverlays.get(id) ?? EMPTY);
      add('here');
      add('me');
      add('me-acc');
      map.addLayer({
        id: 'zones-fill',
        type: 'fill',
        source: 'zones',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'opacity'] },
      });
      map.addLayer({
        id: 'cells-fill',
        type: 'fill',
        source: 'cells',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['get', 'mine'], 0.55, 0.42] },
      });
      map.addLayer({
        id: 'cells-line',
        type: 'line',
        source: 'cells',
        minzoom: 14,
        paint: { 'line-color': ['get', 'color'], 'line-width': 1, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'grid',
        type: 'line',
        source: 'grid',
        minzoom: 15.5,
        paint: { 'line-color': '#d1fae5', 'line-opacity': 0.08, 'line-width': 0.6 },
      });
      map.addLayer({
        id: 'radius-fill',
        type: 'fill',
        source: 'ov-radius',
        paint: { 'fill-color': '#fbbf24', 'fill-opacity': 0.04 },
      });
      map.addLayer({
        id: 'radius-line',
        type: 'line',
        source: 'ov-radius',
        paint: { 'line-color': '#fbbf24', 'line-width': 1.5, 'line-dasharray': [3, 2] },
      });
      map.addLayer({
        id: 'selection-fill',
        type: 'fill',
        source: 'ov-selection',
        paint: { 'fill-color': ['coalesce', ['get', 'color'], '#fbbf24'], 'fill-opacity': 0.5 },
      });
      map.addLayer({
        id: 'selection-line',
        type: 'line',
        source: 'ov-selection',
        paint: { 'line-color': ['coalesce', ['get', 'color'], '#fbbf24'], 'line-width': 2 },
      });
      map.addLayer({
        id: 'here-line',
        type: 'line',
        source: 'here',
        paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
      });
      map.addLayer({
        id: 'paths',
        type: 'line',
        source: 'ov-paths',
        paint: {
          'line-color': ['coalesce', ['get', 'color'], '#e5e7eb'],
          'line-width': 2,
          'line-dasharray': [2, 2],
          'line-opacity': 0.8,
        },
      });
      map.addLayer({
        id: 'markers',
        type: 'circle',
        source: 'ov-markers',
        paint: {
          'circle-radius': ['coalesce', ['get', 'size'], 7],
          'circle-color': ['coalesce', ['get', 'color'], '#e5e7eb'],
          'circle-stroke-color': '#0b0f0c',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'markers-label',
        type: 'symbol',
        source: 'ov-markers',
        layout: {
          'text-field': ['coalesce', ['get', 'label'], ''],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
        },
        paint: { 'text-color': '#e5e7eb', 'text-halo-color': '#0b0f0c', 'text-halo-width': 1.5 },
      });
      map.addLayer({
        id: 'me-acc',
        type: 'fill',
        source: 'me-acc',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 },
      });
      map.addLayer({
        id: 'me',
        type: 'circle',
        source: 'me',
        paint: {
          'circle-radius': 7,
          'circle-color': '#38bdf8',
          'circle-stroke-color': '#e0f2fe',
          'circle-stroke-width': 2.5,
        },
      });
      loaded.current = true;
      refresh();
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadTerritory(map), 250);
      const b = map.getBounds();
      try {
        localStorage.setItem('tio.view', JSON.stringify({ center: map.getCenter().toArray(), zoom: map.getZoom() }));
      } catch {
        /* ignore */
      }
      if (map.getZoom() >= 15.5) {
        (map.getSource('grid') as GeoJSONSource | undefined)?.setData(
          gridLines({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }),
        );
      }
    };
    map.on('moveend', refresh);
    // Panning by hand stops the camera from following the player.
    map.on('dragstart', () => setFollow(false));

    map.on('click', (e) => {
      const { lat, lng } = e.lngLat;
      const cell = cellAt(lat, lng);
      const mm = getState().mapMode;
      if (mm.kind === 'drone-targets' || mm.kind === 'war-sector') {
        const sel = mm.selected.includes(cell) ? mm.selected.filter((c) => c !== cell) : [...mm.selected, cell];
        setState({ mapMode: { ...mm, selected: sel } });
        return;
      }
      if (clickHandler) {
        clickHandler({ lat, lon: lng, cell });
        return;
      }
      api<CellInfo>('GET', `/api/cells/${cell}`).then(setCellInfo, () => setCellInfo(null));
    });

    return () => {
      mapRef = null;
      loaded.current = false;
      map.remove();
    };
  }, []);

  async function loadTerritory(map: MlMap) {
    if (!loaded.current) return;
    const b = map.getBounds();
    const zoom = Math.floor(map.getZoom());
    // Normalised west > east means the view crosses the antimeridian; the server splits it.
    const q =
      b.getEast() - b.getWest() >= 360
        ? `west=-180&east=180`
        : `west=${normLon(b.getWest()).toFixed(5)}&east=${normLon(b.getEast()).toFixed(5)}`;
    const south = Math.max(-90, b.getSouth()).toFixed(5);
    const north = Math.min(90, b.getNorth()).toFixed(5);
    const seq = ++territorySeq;
    try {
      const view = await api<TerritoryView>('GET', `/api/territory?${q}&south=${south}&north=${north}&zoom=${zoom}`);
      if (seq !== territorySeq) return; // a newer request superseded this one
      const fc = territoryToGeoJSON(view, getState().me?.id ?? null);
      (map.getSource(view.mode === 'cells' ? 'cells' : 'zones') as GeoJSONSource).setData(fc);
      (map.getSource(view.mode === 'cells' ? 'zones' : 'cells') as GeoJSONSource).setData(EMPTY);
      setTruncated(view.truncated);
    } catch {
      /* keep the last view */
    }
  }

  // Refetch territory when the server says it changed.
  useEffect(() => {
    if (mapRef && loaded.current) void loadTerritory(mapRef);
  }, [territoryTick, myId]);

  // Player position, accuracy and the cell being captured.
  useEffect(() => {
    const map = mapRef;
    if (!map || !loaded.current) return;
    const me = map.getSource('me') as GeoJSONSource | undefined;
    const acc = map.getSource('me-acc') as GeoJSONSource | undefined;
    const here = map.getSource('here') as GeoJSONSource | undefined;
    if (gps.state !== 'on' || gps.lat === undefined || gps.lon === undefined) {
      me?.setData(EMPTY);
      acc?.setData(EMPTY);
      here?.setData(EMPTY);
      return;
    }
    me?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [gps.lon, gps.lat] } }],
    });
    acc?.setData(circlePolygon(gps.lat, gps.lon, gps.accuracy ?? 0, 48));
    if (!hadFix.current) {
      hadFix.current = true;
      map.jumpTo({ center: [gps.lon, gps.lat], zoom: Math.max(map.getZoom(), FOLLOW_ZOOM) });
    } else if (follow) {
      map.easeTo({ center: [gps.lon, gps.lat], duration: 600 });
    }
    const cell = gps.last?.cell ?? cellAt(gps.lat, gps.lon);
    here?.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { color: STATUS_COLOR[gps.last?.status ?? 'tracking'] ?? '#fbbf24' },
          geometry: { type: 'LineString', coordinates: cellRing(cell) },
        },
      ],
    });
  }, [gps, follow]);

  useEffect(() => {
    if (gps.state === 'off') hadFix.current = false;
  }, [gps.state]);

  // Selection modes draw the picked cells; non-selection modes clear them.
  useEffect(() => {
    if (mode.kind === 'drone-targets' || mode.kind === 'war-sector') {
      const ok = mode.selected.length > 0 && isConnected(mode.selected);
      setOverlay('selection', {
        type: 'FeatureCollection',
        features: mode.selected.map((id) => ({
          type: 'Feature',
          properties: { color: ok ? (mode.kind === 'war-sector' ? '#ef4444' : '#fbbf24') : '#a3a3a3' },
          geometry: { type: 'Polygon', coordinates: [cellRing(id)] },
        })),
      });
    } else {
      setOverlay('selection', EMPTY);
    }
  }, [mode]);

  useEffect(() => {
    if (focus) flyTo(focus.lat, focus.lon, focus.zoom);
  }, [focus]);

  const locate = () => {
    setFollow(true);
    if (gps.lat !== undefined && gps.lon !== undefined) flyTo(gps.lat, gps.lon, FOLLOW_ZOOM);
  };

  return (
    <div className="map-wrap">
      <div ref={container} className="map" data-testid="map" />
      <div className="map-tools">
        <button
          className={`icon-btn ${follow && gps.state === 'on' ? 'on' : ''}`}
          title={t('map.locate')}
          aria-label={t('map.locate')}
          onClick={locate}
        >
          ◎
        </button>
        <button
          className={`icon-btn ${showGrid ? 'on' : ''}`}
          title={t('map.grid')}
          aria-label={t('map.grid')}
          onClick={() => {
            setShowGrid(!showGrid);
            mapRef?.setLayoutProperty('grid', 'visibility', showGrid ? 'none' : 'visible');
          }}
        >
          #
        </button>
      </div>
      {basemapFailed && <div className="map-notice">{t('map.basemapFailed')}</div>}
      {truncated && <div className="map-notice">{t('map.truncated')}</div>}
      {cellInfo && (
        <div className="cell-card" role="dialog">
          <button className="close" onClick={() => setCellInfo(null)} aria-label={t('common.close')}>
            ×
          </button>
          <div className="cell-id">#{cellInfo.cellId}</div>
          <div>
            {!cellInfo.land
              ? t('map.cell.water')
              : !cellInfo.owner
                ? t('map.cell.neutral')
                : cellInfo.owner.id === myId
                  ? t('map.cell.yours')
                  : t('map.cell.ownedBy', { name: cellInfo.owner.name })}
          </div>
          {cellInfo.owner && <span className="swatch" style={{ background: cellInfo.owner.color }} />}
        </div>
      )}
    </div>
  );
}

function normLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}
