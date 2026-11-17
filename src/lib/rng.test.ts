import { describe, expect, it } from 'vitest'
import { createRng, randomSeed } from './rng'

describe('createRng', () => {
  it('gives the same sequence for the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    for (let i = 0; i < 50; i++) expect(a.next()).toBe(b.next())
  })

  it('gives different sequences for different seeds', () => {
    const a = createRng(1)
    const b = createRng(2)
    const same = Array.from({ length: 20 }, () => a.next() === b.next()).filter(Boolean)
    expect(same.length).toBeLessThan(3)
  })

  it('next() stays in [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 5000; i++) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('int() covers the whole range, ends included', () => {
    const rng = createRng(3)
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const value = rng.int(5, 9)
      expect(Number.isInteger(value)).toBe(true)
      seen.add(value)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([5, 6, 7, 8, 9])
    expect(rng.int(4, 4)).toBe(4)
    expect(() => rng.int(5, 4)).toThrow()
  })

  it('pick() returns items of the list and rejects an empty list', () => {
    const rng = createRng(11)
    const items = ['a', 'b', 'c'] as const
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(rng.pick(items))
    expect(seen).toEqual(new Set(items))
    expect(() => rng.pick([])).toThrow()
  })

  it('shuffle() keeps every item and does not change the input', () => {
    const rng = createRng(5)
    const input = [1, 2, 3, 4, 5, 6, 7, 8]
    const output = rng.shuffle(input)
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...output].sort((a, b) => a - b)).toEqual(input)
    expect(createRng(5).shuffle(input)).toEqual(output)
  })

  it('bits() stays inside the requested width', () => {
    const rng = createRng(9)
    for (const width of [1, 4, 8, 16, 17, 32, 33, 63, 64]) {
      for (let i = 0; i < 200; i++) {
        const value = rng.bits(width)
        expect(value >= 0n).toBe(true)
        expect(value < 1n << BigInt(width)).toBe(true)
      }
    }
    expect(() => rng.bits(0)).toThrow()
    expect(() => rng.bits(65)).toThrow()
  })

  it('bits(64) uses the top bits too', () => {
    const rng = createRng(13)
    let sawHigh = false
    for (let i = 0; i < 100; i++) if (rng.bits(64) >> 63n === 1n) sawHigh = true
    expect(sawHigh).toBe(true)
  })

  it('chance() follows its probability roughly', () => {
    const rng = createRng(21)
    let hits = 0
    for (let i = 0; i < 4000; i++) if (rng.chance(0.25)) hits++
    expect(hits).toBeGreaterThan(800)
    expect(hits).toBeLessThan(1200)
  })
})

describe('randomSeed', () => {
  it('is a non-negative 31-bit integer', () => {
    for (let i = 0; i < 100; i++) {
      const seed = randomSeed()
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(0x7fffffff)
    }
  })
})
