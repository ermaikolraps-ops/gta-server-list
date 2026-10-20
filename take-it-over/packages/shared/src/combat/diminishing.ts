/**
 * Approved diminishing-returns curve, applied once per side per front:
 *   P_eff = P                         if P <= T
 *   P_eff = T * (1 + ln(P / T))       if P >  T
 * It is continuous at T with slope 1, and strictly increasing, so it never
 * changes which side has more power — only by how much.
 */
export function effectivePower(power: number, threshold: number): number {
  if (power <= threshold) return power;
  return threshold * (1 + Math.log(power / threshold));
}

/** Multiplier applied to a side's damage output: P_eff / P (1 below the threshold). */
export function efficiency(power: number, threshold: number): number {
  if (power <= threshold || power <= 0) return 1;
  return effectivePower(power, threshold) / power;
}
