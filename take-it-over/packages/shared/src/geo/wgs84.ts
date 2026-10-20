/**
 * WGS84 ellipsoid geodesy used to lay out grid rows.
 *
 * Rows are spaced by true meridian arc length (not by degrees of latitude),
 * so every row is ~100 m tall from the equator to the poles. The meridian arc
 * uses the rectifying-latitude series in the third flattening n (Helmert /
 * Krüger form). Truncation at n^4 leaves an error below a millimetre, which is
 * far below anything that matters for 100 m cells.
 */

export const WGS84_A = 6378137.0;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_E2 = WGS84_F * (2 - WGS84_F);

const N = WGS84_F / (2 - WGS84_F);
const N2 = N * N;
const N3 = N2 * N;
const N4 = N3 * N;

/** Radius of the sphere whose great circle has the same length as a meridian. */
export const RECTIFYING_RADIUS = (WGS84_A / (1 + N)) * (1 + N2 / 4 + N4 / 64);

/** Distance along a meridian from the equator to a pole (~10,001,965.729 m). */
export const QUARTER_MERIDIAN_M = (RECTIFYING_RADIUS * Math.PI) / 2;

// geodetic latitude -> rectifying latitude
const F2 = -1.5 * N + (9 / 16) * N3;
const F4 = (15 / 16) * N2 - (15 / 32) * N4;
const F6 = -(35 / 48) * N3;
const F8 = (315 / 512) * N4;

// rectifying latitude -> geodetic latitude
const I2 = 1.5 * N - (27 / 32) * N3;
const I4 = (21 / 16) * N2 - (55 / 32) * N4;
const I6 = (151 / 96) * N3;
const I8 = (1097 / 512) * N4;

/** Signed meridian arc length in metres from the equator to `latRad`. */
export function meridianArc(latRad: number): number {
  const mu =
    latRad +
    F2 * Math.sin(2 * latRad) +
    F4 * Math.sin(4 * latRad) +
    F6 * Math.sin(6 * latRad) +
    F8 * Math.sin(8 * latRad);
  return RECTIFYING_RADIUS * mu;
}

/** Inverse of {@link meridianArc}: geodetic latitude (radians) at a signed arc length. */
export function latFromMeridianArc(arcM: number): number {
  const mu = arcM / RECTIFYING_RADIUS;
  return (
    mu +
    I2 * Math.sin(2 * mu) +
    I4 * Math.sin(4 * mu) +
    I6 * Math.sin(6 * mu) +
    I8 * Math.sin(8 * mu)
  );
}

/** Radius of the parallel (distance to the polar axis) at a geodetic latitude. */
export function parallelRadius(latRad: number): number {
  const s = Math.sin(latRad);
  return (WGS84_A * Math.cos(latRad)) / Math.sqrt(1 - WGS84_E2 * s * s);
}

/** Length of the full parallel circle at a geodetic latitude, in metres. */
export function parallelCircumference(latRad: number): number {
  return 2 * Math.PI * Math.max(0, parallelRadius(latRad));
}
