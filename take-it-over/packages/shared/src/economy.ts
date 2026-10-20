/**
 * Credits are stored as integer "units": 1 credit = 3,600,000 units, i.e. one
 * unit is what a single parcel earns in one millisecond at 1 credit/hour.
 * Accrual is therefore exact integer maths with no rounding drift, however
 * often a balance is settled.
 */

export const UNITS_PER_CREDIT = 3_600_000n;
const MS_PER_HOUR = 3_600_000;

export function creditsToUnits(credits: number): bigint {
  if (!Number.isInteger(credits)) throw new Error('credit amounts must be whole numbers');
  return BigInt(credits) * UNITS_PER_CREDIT;
}

/** Whole credits available (floor). */
export function unitsToCredits(units: bigint): number {
  return Number(units / UNITS_PER_CREDIT);
}

/** Units earned by `parcels` over `elapsedMs` at `creditsPerParcelPerHour` (an integer). */
export function accruedUnits(parcels: number, elapsedMs: number, creditsPerParcelPerHour: number): bigint {
  if (parcels <= 0 || elapsedMs <= 0) return 0n;
  // 1 credit/hour/parcel == 1 unit/ms/parcel by construction of UNITS_PER_CREDIT.
  const unitsPerMsPerParcel = (BigInt(creditsPerParcelPerHour) * UNITS_PER_CREDIT) / BigInt(MS_PER_HOUR);
  return BigInt(parcels) * BigInt(Math.floor(elapsedMs)) * unitsPerMsPerParcel;
}

export function balanceUnitsAt(
  settledUnits: bigint,
  parcels: number,
  settledAtMs: number,
  nowMs: number,
  creditsPerParcelPerHour: number,
): bigint {
  return settledUnits + accruedUnits(parcels, nowMs - settledAtMs, creditsPerParcelPerHour);
}
