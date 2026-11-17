/**
 * Seeded random numbers (mulberry32).
 *
 * Practice problems are generated from a seed, so a problem can be rebuilt exactly
 * (for "Show me", for tests, and for bug reports). `Math.random` is only used to pick
 * the seed of a new problem.
 */
export interface Rng {
  /** A float in [0, 1). */
  next(): number
  /** An integer from `min` to `max`, both included. */
  int(min: number, max: number): number
  /** True with probability `p` (default one half). */
  chance(p?: number): boolean
  /** One item of a non-empty list. */
  pick<T>(items: readonly T[]): T
  /** A shuffled copy of the list. */
  shuffle<T>(items: readonly T[]): T[]
  /** A random unsigned value of `bits` bits (1 … 64). */
  bits(bits: number): bigint
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const int = (min: number, max: number): number => {
    if (max < min) throw new Error(`rng.int: max (${max}) is below min (${min})`)
    return min + Math.floor(next() * (max - min + 1))
  }

  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('rng.pick: the list is empty')
    return items[int(0, items.length - 1)]
  }

  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i)
      const a = copy[i]
      copy[i] = copy[j]
      copy[j] = a
    }
    return copy
  }

  const bits = (count: number): bigint => {
    if (count < 1 || count > 64) throw new Error(`rng.bits: ${count} is not 1 … 64`)
    let value = 0n
    let have = 0
    while (have < count) {
      const take = Math.min(16, count - have)
      value = (value << BigInt(take)) | BigInt(int(0, (1 << take) - 1))
      have += take
    }
    return value
  }

  return {
    next,
    int,
    chance: (p = 0.5) => next() < p,
    pick,
    shuffle,
    bits,
  }
}

/** A fresh seed for a new problem (the only place that is not reproducible). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff)
}
