import type { StyleSpecification } from 'maplibre-gl';

/**
 * Dark "military" basemap over OpenMapTiles-schema vector tiles. The default
 * source is OpenFreeMap (free, no key, OSM data; attribution is kept on the
 * map). Point VITE_MAP_TILEJSON / VITE_MAP_GLYPHS at a self-hosted planetiler
 * or Protomaps build for production traffic — see docs/maps.md.
 */
const TILEJSON = import.meta.env.VITE_MAP_TILEJSON ?? 'https://tiles.openfreemap.org/planet';
const GLYPHS = import.meta.env.VITE_MAP_GLYPHS ?? 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

export const PALETTE = {
  bg: '#0b0f0c',
  water: '#08161d',
  waterway: '#0b1e28',
  wood: '#0e1610',
  grass: '#0d140e',
  urban: '#121813',
  building: '#161e17',
  roadMajor: '#3a4636',
  road: '#283225',
  roadMinor: '#1d241c',
  rail: '#2b342a',
  border: '#6b7d55',
  borderMinor: '#344030',
  label: '#9fb39a',
  labelDim: '#6f8069',
  halo: '#070a08',
};

const FONT = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

export function militaryStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      omt: { type: 'vector', url: TILEJSON },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': PALETTE.bg } },
      {
        id: 'landcover-wood',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]],
        paint: { 'fill-color': PALETTE.wood },
      },
      {
        id: 'landcover-grass',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landcover',
        filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland', 'wetland']]],
        paint: { 'fill-color': PALETTE.grass },
      },
      {
        id: 'landuse-urban',
        type: 'fill',
        source: 'omt',
        'source-layer': 'landuse',
        filter: ['in', ['get', 'class'], ['literal', ['residential', 'industrial', 'commercial', 'retail']]],
        paint: { 'fill-color': PALETTE.urban },
      },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': PALETTE.water } },
      {
        id: 'waterway',
        type: 'line',
        source: 'omt',
        'source-layer': 'waterway',
        paint: { 'line-color': PALETTE.waterway, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 3] },
      },
      {
        id: 'building',
        type: 'fill',
        source: 'omt',
        'source-layer': 'building',
        minzoom: 14,
        paint: { 'fill-color': PALETTE.building, 'fill-opacity': 0.9 },
      },
      {
        id: 'road-minor',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        minzoom: 12,
        filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'track', 'path']]],
        paint: { 'line-color': PALETTE.roadMinor, 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 18, 6] },
      },
      {
        id: 'road',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['secondary', 'tertiary']]],
        paint: { 'line-color': PALETTE.road, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 18, 9] },
      },
      {
        id: 'road-major',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: ['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]],
        paint: { 'line-color': PALETTE.roadMajor, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 18, 12] },
      },
      {
        id: 'rail',
        type: 'line',
        source: 'omt',
        'source-layer': 'transportation',
        filter: ['==', ['get', 'class'], 'rail'],
        paint: { 'line-color': PALETTE.rail, 'line-width': 1, 'line-dasharray': [3, 3] },
      },
      {
        id: 'border-minor',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 4], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': PALETTE.borderMinor, 'line-width': 0.8, 'line-dasharray': [1, 2] },
      },
      {
        id: 'border-country',
        type: 'line',
        source: 'omt',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: {
          'line-color': PALETTE.border,
          'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.6, 10, 2],
          'line-dasharray': [4, 2],
        },
      },
      {
        id: 'label-road',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'transportation_name',
        minzoom: 14,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['get', 'name'],
          'text-font': FONT,
          'text-size': 11,
        },
        paint: { 'text-color': PALETTE.labelDim, 'text-halo-color': PALETTE.halo, 'text-halo-width': 1.5 },
      },
      {
        id: 'label-place',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'village', 'suburb']]],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 12, 15],
        },
        paint: { 'text-color': PALETTE.label, 'text-halo-color': PALETTE.halo, 'text-halo-width': 1.5 },
      },
      {
        id: 'label-country',
        type: 'symbol',
        source: 'omt',
        'source-layer': 'place',
        maxzoom: 8,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': ['upcase', ['coalesce', ['get', 'name:en'], ['get', 'name']]],
          'text-font': FONT_BOLD,
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 6, 14],
          'text-letter-spacing': 0.2,
        },
        paint: { 'text-color': PALETTE.labelDim, 'text-halo-color': PALETTE.halo, 'text-halo-width': 1.5 },
      },
    ],
  };
}
