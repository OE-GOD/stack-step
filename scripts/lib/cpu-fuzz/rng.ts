/**
 * Seeded random numbers for the fuzz generator.
 *
 * The same (seed, stream) pair always gives the same numbers on every machine and
 * every Node version: only 32-bit integer maths is used (xoshiro128**, seeded through
 * splitmix32). `Math.random` is never used.
 */

export interface Rng {
  /** 32 random bits, as a number from 0 to 2^32 - 1. */
  u32(): number
  /** A whole number from 0 to `n` - 1. */
  below(n: number): number
  /** A whole number from `low` to `high`, both included. */
  between(low: number, high: number): number
  /** True with probability `p` (0 = never, 1 = always). */
  chance(p: number): boolean
  /** One item of a non-empty list. */
  pick<T>(items: readonly T[]): T
  /** One item, where each item has its own weight. */
  weighted<T>(items: readonly (readonly [T, number])[]): T
  /** 64 random bits. */
  u64(): bigint
}

function splitmix32(start: number): () => number {
  let a = start | 0
  return () => {
    a = (a + 0x9e3779b9) | 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t ^= t >>> 15
    t = Math.imul(t, 0x735a2d97)
    t ^= t >>> 15
    return t >>> 0
  }
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k))
}

/**
 * `stream` picks an independent sequence for the same seed. The generator uses the
 * program number as the stream, so program 7 is the same whatever `--count` is.
 */
export function createRng(seed: number, stream: number): Rng {
  const first = splitmix32(seed >>> 0)
  const mixed = (first() ^ Math.imul((stream >>> 0) + 1, 0x85ebca6b)) >>> 0
  const init = splitmix32(mixed)
  let s0 = init()
  let s1 = init()
  let s2 = init()
  let s3 = init()
  // xoshiro must not start from the all-zero state.
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1

  const u32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0
    const t = s1 << 9
    s2 ^= s0
    s3 ^= s1
    s1 ^= s2
    s0 ^= s3
    s2 ^= t
    s3 = rotl(s3, 11)
    return result
  }

  const below = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`below(${n}): need a whole number > 0`)
    return Math.floor((u32() / 0x1_0000_0000) * n)
  }

  return {
    u32,
    below,
    between: (low, high) => low + below(high - low + 1),
    chance: (p) => u32() < p * 0x1_0000_0000,
    pick: <T>(items: readonly T[]): T => {
      const item = items[below(items.length)]
      if (item === undefined) throw new Error('pick() from an empty list')
      return item
    },
    weighted: <T>(items: readonly (readonly [T, number])[]): T => {
      let total = 0
      for (const [, weight] of items) total += weight
      let roll = below(total)
      for (const [item, weight] of items) {
        if (roll < weight) return item
        roll -= weight
      }
      throw new Error('weighted() from an empty list')
    },
    u64: () => (BigInt(u32()) << 32n) | BigInt(u32()),
  }
}
