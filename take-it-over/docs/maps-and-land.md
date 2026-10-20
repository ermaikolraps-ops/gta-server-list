# Maps and land data

## Basemap

The map uses MapLibre GL JS (BSD-3-Clause) with a custom dark "military" style
(`packages/web/src/map/style.ts`) over vector tiles in the
[OpenMapTiles](https://openmaptiles.org/) schema, built from OpenStreetMap
data.

- **Default source:** [OpenFreeMap](https://openfreemap.org/) (free, no API
  key). Attribution "© OpenMapTiles © OpenStreetMap contributors" comes from
  the tile source and is shown on the map; it must stay visible (ODbL).
- **Production:** for real traffic, check the provider's current terms, or
  self-host tiles. Point `VITE_MAP_TILEJSON` and `VITE_MAP_GLYPHS` at your own
  server at build time, for example a [planetiler](https://github.com/onthegomap/planetiler)
  build served by a static file host, or [Protomaps](https://protomaps.com/)
  PMTiles. The OpenStreetMap Foundation's own tile servers must not be used
  for an app like this (their usage policy forbids heavy use).
- If tiles are unreachable, the game still works: territory, grid and units
  render on the dark background, and a notice is shown.
- The service worker caches viewed tiles for 7 days to save bandwidth.
  Game API responses are never cached.

## Land mask

What counts as conquerable land is decided on the server from two PostGIS
tables, `land_polygons` and `water_polygons` (lakes, reservoirs). Both are
subdivided (`ST_Subdivide`, ≤256 vertices) and GiST-indexed.

**Default data: Natural Earth 1:10m** (public domain), via
`pnpm land:fetch && pnpm land:load`. It is small (~15 MB) and quick to load,
but its coastlines are generalised to roughly 1 km: some beach or harbour
parcels may be classified wrongly. Good for development and early testing.

**Production data: OpenStreetMap land polygons** from
[osmdata.openstreetmap.de](https://osmdata.openstreetmap.de/data/land-polygons.html)
(ODbL, about 700 MB, metre-level coastlines). Convert the split land polygons
to GeoJSON (or load with `ogr2ogr` directly) and run:

```bash
ogr2ogr -f GeoJSON land.geojson land-polygons-split-4326/land_polygons.shp
pnpm land:load --land land.geojson --water lakes.geojson --source osm
```

For inland water, extract `natural=water` polygons (lakes, reservoirs) with a
tool such as `osmium` and pass them as `--water`. Restart the server after
reloading, because land status is cached per cell.

A parcel is land when its centre point is on land. Routes for armies are
checked cell by cell; sea routes are checked every 1 km.
