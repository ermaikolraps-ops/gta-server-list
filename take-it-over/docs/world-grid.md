# World grid

The world is divided into square-ish parcels of about 100 × 100 m. The grid
must be identical on every server and client, stable forever (parcel ids are
stored), cover the whole planet, and keep parcels close to 100 m in both
directions at every latitude.

## Why not a simple lat/lon grid or a map projection

- A **fixed-degree grid** (for example 0.0009° × 0.0009°) is 100 m tall
  everywhere but 100 m wide only at the equator. At 60° it would be 50 m wide.
- A **Web Mercator tile grid** is square on screen but its cells shrink on the
  ground with latitude (by cos φ): a 100 m cell at the equator is 50 m at 60°.
- **S2 or H3 cells** are global and well behaved, but they are not squares
  aligned with north and east, and their size varies from cell to cell.

The game needs parcels that *look* square on the map, are really 100 m on the
ground, and connect only through shared sides. A banded latitude grid gives
exactly that.

## Layout (grid version 1)

**Rows by true distance.** Rows are spaced by meridian arc length on the WGS84
ellipsoid, not by degrees. The pole-to-pole meridian (20,003,931.46 m) is cut
into 200,039 rows of 100.0002 m. The row count is odd, so the middle row
(100,019) is centred on the equator and the hemispheres mirror each other.
Arc length uses the rectifying-latitude series in the third flattening
(Helmert/Krüger form), checked in the tests against numerical integration to
under a millimetre.

**Columns by real circumference.** The length of a parallel shrinks toward the
poles, so the number of columns per row must shrink too. If every row had its
own column count, cells in neighbouring rows would never line up and every
parcel would have ragged, brick-like neighbours. Instead, rows are grouped into
**bands**. Every row in a band has the same column count, so cells inside a
band form a perfect grid. Bands are chosen greedily from the equator so that
each cell's real width stays within **±1 %** of 100 m.

- 386 bands per hemisphere. They are tall near the equator (the first band
  spans 12,672 rows, about 1,267 km) and shrink toward the poles.
- 396,763 columns at the equator, 305,907 at 40.4° (Madrid), 200,968 at 60°.
- Measured width range below 89.5° latitude: 99.0 m to 101.0 m.
- About 5.10 × 10¹⁰ cells in total, within 0.5 % of the Earth's surface
  divided by 1 ha.

The band table is **frozen** in `bandTable.generated.ts`, so a client whose
`Math.sin` differs in the last bit still uses exactly the server's grid. A test
regenerates the table and checks it is unchanged. Changing it would be a grid
migration.

**Polar caps.** Within about 50 rows (5 km) of a pole, a parallel is shorter
than a few cells, so each row is its own band and cells turn into thin wedges.
This affects only the South Pole station area (the north pole is sea).

## Cell ids

`id = row × 2¹⁹ + col`. The largest id is about 1.05 × 10¹¹, which fits a
Postgres `BIGINT` and a JavaScript number exactly. Within a row, ids are
contiguous, so a map viewport is a handful of id ranges, one per row, and is
queried with indexed range scans.

## Adjacency

Two cells are connected only if they share a side, or part of a side:

- Inside a band: the usual four neighbours (west, east, north, south).
  Columns wrap at the antimeridian.
- Across a band seam, the rows above and below have different column counts.
  A cell is adjacent to every cell in the next row whose span overlaps its own
  by a **positive length**, so a cell on a seam has one or two neighbours on
  that side. The overlap test uses integer arithmetic, so cells that touch at
  a single point (a corner) are never adjacent, even after floating-point
  rounding.

Connectivity (drone target groups, war sectors) is a breadth-first search over
this neighbour relation. The tests check that adjacency is symmetric
everywhere, including band seams, the antimeridian and the polar rows, and
that diagonal (corner-only) pairs are not connected.

## Land and water

A cell is land when its centre lies inside a land polygon and outside every
inland-water polygon (see [maps-and-land.md](maps-and-land.md)). Land status
is cached per cell in memory.

## Distances

Gameplay distances (drone radius, AA radius, army and ship travel) use great
circles on a sphere with the IUGG mean radius (6,371,008.8 m). That is within
about 0.5 % of the ellipsoid, well inside the tolerance of these rules. The
grid itself uses the ellipsoid.
