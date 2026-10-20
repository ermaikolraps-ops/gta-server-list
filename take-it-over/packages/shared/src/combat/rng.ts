/**
 * mulberry32: a tiny 32-bit PRNG whose entire state is one uint32, so a war's
 * randomness can be persisted after every round and resumed exactly.
 */
export class Rng {
  constructor(public state: number) {
    this.state = state >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

/** Derives a well-mixed uint32 seed from a string (e.g. a war id). */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
