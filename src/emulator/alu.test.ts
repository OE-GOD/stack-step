import { describe, expect, it } from 'vitest'
import {
  add,
  conditionHolds,
  dec,
  describeCondition,
  imul,
  inc,
  isJumpCondition,
  JUMP_CONDITIONS,
  logic,
  sub,
  type AluResult,
  type JumpCondition,
} from './alu'
import { MNEMONICS, type Bit, type FlagName, type Flags, type OperandSize } from './types'

/* ─────────────────────────────── Helpers ─────────────────────────────── */

const SIZES: readonly OperandSize[] = [8, 16, 32, 64]

/** Hex text for test names (negative numbers keep their minus sign). */
function h(value: bigint): string {
  return value < 0n ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`
}

/** Put a readable name in front of every row of a table, for `it.each`. */
function titled<Row extends unknown[]>(
  rows: readonly Row[],
  title: (row: Row) => string,
): [string, ...Row][] {
  return rows.map((row) => [title(row), ...row])
}

function bit(on: boolean): Bit {
  return on ? 1 : 0
}

/** All 16 combinations of the four flags. */
const ALL_FLAGS: readonly Flags[] = Array.from({ length: 16 }, (_unused, n) => ({
  CF: bit((n & 8) !== 0),
  ZF: bit((n & 4) !== 0),
  SF: bit((n & 2) !== 0),
  OF: bit((n & 1) !== 0),
}))

/** Flags as short text, for failure messages. */
function show(flags: Flags): string {
  return `CF=${flags.CF} ZF=${flags.ZF} SF=${flags.SF} OF=${flags.OF}`
}

/**
 * Plain maths for one width, written without the emulator's own bit helpers:
 * 2^size, half of it, the signed reading of a value, and "does it fit as signed?".
 */
function widthOf(size: OperandSize) {
  const modulus = 2n ** BigInt(size)
  const half = modulus / 2n
  return {
    modulus,
    half,
    max: modulus - 1n,
    signed: (value: bigint) => (value >= half ? value - modulus : value),
    fitsSigned: (value: bigint) => value >= -half && value < half,
  }
}

/** Numbers at the edges of a width: around 0, around the sign change, around the top. */
function edgeValues(size: OperandSize): bigint[] {
  const { half, max } = widthOf(size)
  return [0n, 1n, 2n, 5n, half - 2n, half - 1n, half, half + 1n, max - 1n, max]
}

/** splitmix64: a tiny seeded generator, so the "random" tests are the same on every run. */
function makeRandom(seed: bigint): () => bigint {
  const mask = 2n ** 64n - 1n
  let state = seed & mask
  return () => {
    state = (state + 0x9e37_79b9_7f4a_7c15n) & mask
    let z = state
    z = ((z ^ (z >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & mask
    z = ((z ^ (z >> 27n)) * 0x94d0_49bb_1331_11ebn) & mask
    return z ^ (z >> 31n)
  }
}

/**
 * Pseudo-random pairs for one width. Plain random numbers almost never hit the
 * interesting cases, so some pairs are edge values, small numbers, equal numbers, or
 * numbers that add up to exactly 2^size.
 */
function randomPairs(size: OperandSize, count: number, seed: bigint): [bigint, bigint][] {
  const next = makeRandom(seed)
  const { modulus } = widthOf(size)
  const edges = edgeValues(size)
  const operand = (): bigint => {
    const kind = next() % 4n
    if (kind === 0n) return edges[Number(next() % BigInt(edges.length))]
    if (kind === 1n) return next() % 256n
    return next() % modulus
  }
  const pairs: [bigint, bigint][] = []
  for (let i = 0; i < count; i++) {
    const a = operand()
    const kind = next() % 8n
    const b = kind === 0n ? a : kind === 1n ? (modulus - a) % modulus : operand()
    pairs.push([a, b])
  }
  return pairs
}

/* a, b, size → result, CF, ZF, SF, OF */
type BinaryCase = [
  a: bigint,
  b: bigint,
  size: OperandSize,
  result: bigint,
  CF: Bit,
  ZF: Bit,
  SF: Bit,
  OF: Bit,
]

/* ───────────────────────────────── add ───────────────────────────────── */

describe('add', () => {
  // a, b, size → result, CF, ZF, SF, OF
  const cases: BinaryCase[] = [
    // 8 bits
    [0x7fn, 0x01n, 8, 0x80n, 0, 0, 1, 1], // biggest signed + 1: signed overflow
    [0xffn, 0x01n, 8, 0x00n, 1, 1, 0, 0], // biggest unsigned + 1: carry, wraps to 0
    [0x80n, 0x80n, 8, 0x00n, 1, 1, 0, 1], // smallest signed twice: carry and overflow
    [0x00n, 0x00n, 8, 0x00n, 0, 1, 0, 0],
    [0x01n, 0x01n, 8, 0x02n, 0, 0, 0, 0],
    [0x12n, 0x34n, 8, 0x46n, 0, 0, 0, 0],
    [0xffn, 0xffn, 8, 0xfen, 1, 0, 1, 0], // -1 + -1 = -2: fits as signed
    [0x7fn, 0x7fn, 8, 0xfen, 0, 0, 1, 1], // 127 + 127 does not fit as signed
    [0x80n, 0xffn, 8, 0x7fn, 1, 0, 0, 1], // -128 + -1 does not fit as signed
    [0x80n, 0x7fn, 8, 0xffn, 0, 0, 1, 0], // -128 + 127 = -1
    // 16 bits
    [0x7fffn, 0x0001n, 16, 0x8000n, 0, 0, 1, 1],
    [0xffffn, 0x0001n, 16, 0x0000n, 1, 1, 0, 0],
    [0x8000n, 0x8000n, 16, 0x0000n, 1, 1, 0, 1],
    [0x0000n, 0x0000n, 16, 0x0000n, 0, 1, 0, 0],
    [0x1234n, 0x4321n, 16, 0x5555n, 0, 0, 0, 0],
    [0xffffn, 0xffffn, 16, 0xfffen, 1, 0, 1, 0],
    [0x7fffn, 0x7fffn, 16, 0xfffen, 0, 0, 1, 1],
    [0x8000n, 0xffffn, 16, 0x7fffn, 1, 0, 0, 1],
    [0x8000n, 0x7fffn, 16, 0xffffn, 0, 0, 1, 0],
    [0x00ffn, 0x0001n, 16, 0x0100n, 0, 0, 0, 0], // the 8-bit carry case is ordinary here
    // 32 bits
    [0x7fff_ffffn, 0x1n, 32, 0x8000_0000n, 0, 0, 1, 1],
    [0xffff_ffffn, 0x1n, 32, 0x0000_0000n, 1, 1, 0, 0],
    [0x8000_0000n, 0x8000_0000n, 32, 0x0000_0000n, 1, 1, 0, 1],
    [0x0n, 0x0n, 32, 0x0n, 0, 1, 0, 0],
    [0x1234_5678n, 0x1111_1111n, 32, 0x2345_6789n, 0, 0, 0, 0],
    [0xffff_ffffn, 0xffff_ffffn, 32, 0xffff_fffen, 1, 0, 1, 0],
    [0x7fff_ffffn, 0x7fff_ffffn, 32, 0xffff_fffen, 0, 0, 1, 1],
    [0x8000_0000n, 0xffff_ffffn, 32, 0x7fff_ffffn, 1, 0, 0, 1],
    [0x8000_0000n, 0x7fff_ffffn, 32, 0xffff_ffffn, 0, 0, 1, 0],
    [0x0000_ffffn, 0x1n, 32, 0x0001_0000n, 0, 0, 0, 0],
    // 64 bits
    [0x7fff_ffff_ffff_ffffn, 0x1n, 64, 0x8000_0000_0000_0000n, 0, 0, 1, 1],
    [0xffff_ffff_ffff_ffffn, 0x1n, 64, 0x0n, 1, 1, 0, 0],
    [0x8000_0000_0000_0000n, 0x8000_0000_0000_0000n, 64, 0x0n, 1, 1, 0, 1],
    [0x0n, 0x0n, 64, 0x0n, 0, 1, 0, 0],
    [0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, 64, 0xffff_ffff_ffff_fffen, 1, 0, 1, 0],
    [0x7fff_ffff_ffff_ffffn, 0x7fff_ffff_ffff_ffffn, 64, 0xffff_ffff_ffff_fffen, 0, 0, 1, 1],
    [0x8000_0000_0000_0000n, 0xffff_ffff_ffff_ffffn, 64, 0x7fff_ffff_ffff_ffffn, 1, 0, 0, 1],
    [0x8000_0000_0000_0000n, 0x7fff_ffff_ffff_ffffn, 64, 0xffff_ffff_ffff_ffffn, 0, 0, 1, 0],
    [0xffff_ffffn, 0x1n, 64, 0x1_0000_0000n, 0, 0, 0, 0], // the 32-bit carry case is ordinary here
    [0x7fff_fffd_dff8n, 0x8n, 64, 0x7fff_fffd_e000n, 0, 0, 0, 0], // `add rsp, 8`
  ]

  it.each(titled(cases, ([a, b, size]) => `${h(a)} + ${h(b)} at ${size} bits`))(
    '%s',
    (_title, a, b, size, result, CF, ZF, SF, OF) => {
      expect(add(a, b, size)).toEqual({ result, flags: { CF, ZF, SF, OF } })
    },
  )

  it('gives the same answer with the operands the other way round', () => {
    for (const size of SIZES) {
      for (const a of edgeValues(size)) {
        for (const b of edgeValues(size)) {
          expect(add(a, b, size), `${h(a)} + ${h(b)} at ${size}`).toEqual(add(b, a, size))
        }
      }
    }
  })
})

/* ───────────────────────────── sub and cmp ───────────────────────────── */

describe('sub (and cmp)', () => {
  // a, b, size → result, CF, ZF, SF, OF
  const cases: BinaryCase[] = [
    // 8 bits
    [0x05n, 0x05n, 8, 0x00n, 0, 1, 0, 0], // equal: zero, no borrow
    [0x00n, 0x01n, 8, 0xffn, 1, 0, 1, 0], // 0 - 1: borrow
    [0x80n, 0x01n, 8, 0x7fn, 0, 0, 0, 1], // smallest signed - 1: signed overflow
    [0x7fn, 0xffn, 8, 0x80n, 1, 0, 1, 1], // 127 - (-1) does not fit as signed
    [0x01n, 0xffn, 8, 0x02n, 1, 0, 0, 0], // below as unsigned, greater as signed (1 > -1)
    [0xffn, 0x01n, 8, 0xfen, 0, 0, 1, 0], // above as unsigned, less as signed (-1 < 1)
    [0xffn, 0xffn, 8, 0x00n, 0, 1, 0, 0],
    [0x80n, 0x80n, 8, 0x00n, 0, 1, 0, 0],
    [0x00n, 0x80n, 8, 0x80n, 1, 0, 1, 1], // 0 - (-128) does not fit as signed
    [0x03n, 0x05n, 8, 0xfen, 1, 0, 1, 0],
    [0x05n, 0x03n, 8, 0x02n, 0, 0, 0, 0],
    [0x80n, 0x7fn, 8, 0x01n, 0, 0, 0, 1], // -128 - 127 does not fit as signed
    [0x7fn, 0x80n, 8, 0xffn, 1, 0, 1, 1], // 127 - (-128) does not fit as signed
    [0x00n, 0x00n, 8, 0x00n, 0, 1, 0, 0],
    // 16 bits
    [0x0005n, 0x0005n, 16, 0x0000n, 0, 1, 0, 0],
    [0x0000n, 0x0001n, 16, 0xffffn, 1, 0, 1, 0],
    [0x8000n, 0x0001n, 16, 0x7fffn, 0, 0, 0, 1],
    [0x7fffn, 0xffffn, 16, 0x8000n, 1, 0, 1, 1],
    [0x0001n, 0xffffn, 16, 0x0002n, 1, 0, 0, 0],
    [0xffffn, 0x0001n, 16, 0xfffen, 0, 0, 1, 0],
    [0xffffn, 0xffffn, 16, 0x0000n, 0, 1, 0, 0],
    [0x0000n, 0x8000n, 16, 0x8000n, 1, 0, 1, 1],
    [0x0003n, 0x0005n, 16, 0xfffen, 1, 0, 1, 0],
    [0x0100n, 0x0001n, 16, 0x00ffn, 0, 0, 0, 0], // the 8-bit borrow case is ordinary here
    // 32 bits
    [0x5n, 0x5n, 32, 0x0n, 0, 1, 0, 0],
    [0x0n, 0x1n, 32, 0xffff_ffffn, 1, 0, 1, 0],
    [0x8000_0000n, 0x1n, 32, 0x7fff_ffffn, 0, 0, 0, 1],
    [0x7fff_ffffn, 0xffff_ffffn, 32, 0x8000_0000n, 1, 0, 1, 1],
    [0x1n, 0xffff_ffffn, 32, 0x2n, 1, 0, 0, 0],
    [0xffff_ffffn, 0x1n, 32, 0xffff_fffen, 0, 0, 1, 0],
    [0xffff_ffffn, 0xffff_ffffn, 32, 0x0n, 0, 1, 0, 0],
    [0x0n, 0x8000_0000n, 32, 0x8000_0000n, 1, 0, 1, 1],
    [0x3n, 0x5n, 32, 0xffff_fffen, 1, 0, 1, 0],
    [0xan, 0x1n, 32, 0x9n, 0, 0, 0, 0], // a loop counter going down
    // 64 bits
    [0x5n, 0x5n, 64, 0x0n, 0, 1, 0, 0],
    [0x0n, 0x1n, 64, 0xffff_ffff_ffff_ffffn, 1, 0, 1, 0],
    [0x8000_0000_0000_0000n, 0x1n, 64, 0x7fff_ffff_ffff_ffffn, 0, 0, 0, 1],
    [0x7fff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, 64, 0x8000_0000_0000_0000n, 1, 0, 1, 1],
    [0x1n, 0xffff_ffff_ffff_ffffn, 64, 0x2n, 1, 0, 0, 0],
    [0xffff_ffff_ffff_ffffn, 0x1n, 64, 0xffff_ffff_ffff_fffen, 0, 0, 1, 0],
    [0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, 64, 0x0n, 0, 1, 0, 0],
    [0x0n, 0x8000_0000_0000_0000n, 64, 0x8000_0000_0000_0000n, 1, 0, 1, 1],
    [0x3n, 0x5n, 64, 0xffff_ffff_ffff_fffen, 1, 0, 1, 0],
    [0x7fff_fffd_e000n, 0x10n, 64, 0x7fff_fffd_dff0n, 0, 0, 0, 0], // `sub rsp, 16`
    [0x1_0000_0000n, 0x1n, 64, 0xffff_ffffn, 0, 0, 0, 0], // the 32-bit borrow case is ordinary here
  ]

  it.each(titled(cases, ([a, b, size]) => `${h(a)} - ${h(b)} at ${size} bits`))(
    '%s',
    (_title, a, b, size, result, CF, ZF, SF, OF) => {
      expect(sub(a, b, size)).toEqual({ result, flags: { CF, ZF, SF, OF } })
    },
  )

  it('a - a is always 0 with ZF = 1 and nothing else', () => {
    for (const size of SIZES) {
      for (const a of edgeValues(size)) {
        expect(sub(a, a, size), `${h(a)} at ${size}`).toEqual({
          result: 0n,
          flags: { CF: 0, ZF: 1, SF: 0, OF: 0 },
        })
      }
    }
  })

  it('adding b back gives a again', () => {
    for (const size of SIZES) {
      for (const a of edgeValues(size)) {
        for (const b of edgeValues(size)) {
          const difference = sub(a, b, size).result
          expect(add(difference, b, size).result, `${h(a)} - ${h(b)} at ${size}`).toBe(a)
        }
      }
    }
  })
})

/* ───────────────────────────── inc and dec ───────────────────────────── */

/* a, size → result, ZF, SF, OF (CF is whatever it was before) */
type UnaryCase = [a: bigint, size: OperandSize, result: bigint, ZF: Bit, SF: Bit, OF: Bit]

const INC_CASES: UnaryCase[] = [
  [0x7fn, 8, 0x80n, 0, 1, 1], // biggest signed: signed overflow
  [0xffn, 8, 0x00n, 1, 0, 0], // biggest unsigned: wraps to 0, and CF still does not change
  [0x00n, 8, 0x01n, 0, 0, 0],
  [0x80n, 8, 0x81n, 0, 1, 0],
  [0xfen, 8, 0xffn, 0, 1, 0],
  [0x7fffn, 16, 0x8000n, 0, 1, 1],
  [0xffffn, 16, 0x0000n, 1, 0, 0],
  [0x0000n, 16, 0x0001n, 0, 0, 0],
  [0x00ffn, 16, 0x0100n, 0, 0, 0],
  [0x7fff_ffffn, 32, 0x8000_0000n, 0, 1, 1],
  [0xffff_ffffn, 32, 0x0000_0000n, 1, 0, 0],
  [0x0n, 32, 0x1n, 0, 0, 0],
  [0x9n, 32, 0xan, 0, 0, 0],
  [0x7fff_ffff_ffff_ffffn, 64, 0x8000_0000_0000_0000n, 0, 1, 1],
  [0xffff_ffff_ffff_ffffn, 64, 0x0n, 1, 0, 0],
  [0x0n, 64, 0x1n, 0, 0, 0],
  [0xffff_ffffn, 64, 0x1_0000_0000n, 0, 0, 0],
]

const DEC_CASES: UnaryCase[] = [
  [0x00n, 8, 0xffn, 0, 1, 0], // 0 - 1: all ones, and CF still does not change
  [0x80n, 8, 0x7fn, 0, 0, 1], // smallest signed: signed overflow
  [0x01n, 8, 0x00n, 1, 0, 0],
  [0xffn, 8, 0xfen, 0, 1, 0],
  [0x81n, 8, 0x80n, 0, 1, 0],
  [0x0000n, 16, 0xffffn, 0, 1, 0],
  [0x8000n, 16, 0x7fffn, 0, 0, 1],
  [0x0001n, 16, 0x0000n, 1, 0, 0],
  [0x0100n, 16, 0x00ffn, 0, 0, 0],
  [0x0n, 32, 0xffff_ffffn, 0, 1, 0],
  [0x8000_0000n, 32, 0x7fff_ffffn, 0, 0, 1],
  [0x1n, 32, 0x0n, 1, 0, 0],
  [0xan, 32, 0x9n, 0, 0, 0],
  [0x0n, 64, 0xffff_ffff_ffff_ffffn, 0, 1, 0],
  [0x8000_0000_0000_0000n, 64, 0x7fff_ffff_ffff_ffffn, 0, 0, 1],
  [0x1n, 64, 0x0n, 1, 0, 0],
  [0x1_0000_0000n, 64, 0xffff_ffffn, 0, 0, 0],
]

// Each case runs twice. The other three flags of `before` are set to the opposite of CF,
// to show that inc and dec take nothing but CF from the old flags.
describe.each([
  [0, { CF: 0, ZF: 1, SF: 1, OF: 1 }],
  [1, { CF: 1, ZF: 0, SF: 0, OF: 0 }],
] as [Bit, Flags][])('when CF was %i before', (carry, before) => {
  it.each(titled(INC_CASES, ([a, size]) => `inc ${h(a)} at ${size} bits keeps CF = ${carry}`))(
    '%s',
    (_title, a, size, result, ZF, SF, OF) => {
      expect(inc(a, size, before)).toEqual({ result, flags: { CF: carry, ZF, SF, OF } })
    },
  )

  it.each(titled(DEC_CASES, ([a, size]) => `dec ${h(a)} at ${size} bits keeps CF = ${carry}`))(
    '%s',
    (_title, a, size, result, ZF, SF, OF) => {
      expect(dec(a, size, before)).toEqual({ result, flags: { CF: carry, ZF, SF, OF } })
    },
  )
})

describe('inc and dec next to add and sub', () => {
  it('inc is add 1 and dec is sub 1, except for CF', () => {
    for (const size of SIZES) {
      for (const a of edgeValues(size)) {
        for (const before of ALL_FLAGS) {
          const plusOne = add(a, 1n, size)
          const minusOne = sub(a, 1n, size)
          const what = `${h(a)} at ${size} with ${show(before)}`
          expect(inc(a, size, before), what).toEqual({
            result: plusOne.result,
            flags: { ...plusOne.flags, CF: before.CF },
          })
          expect(dec(a, size, before), what).toEqual({
            result: minusOne.result,
            flags: { ...minusOne.flags, CF: before.CF },
          })
        }
      }
    }
  })

  it('add 1 sets CF where inc does not', () => {
    const before: Flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }
    expect(add(0xffn, 1n, 8).flags.CF).toBe(1)
    expect(inc(0xffn, 8, before).flags.CF).toBe(0)
    expect(sub(0x00n, 1n, 8).flags.CF).toBe(1)
    expect(dec(0x00n, 8, before).flags.CF).toBe(0)
  })

  it('does not change the flags object it was given', () => {
    const before: Flags = { CF: 1, ZF: 1, SF: 0, OF: 1 }
    const incremented = inc(0x7fn, 8, before)
    const decremented = dec(0x80n, 8, before)
    expect(before).toEqual({ CF: 1, ZF: 1, SF: 0, OF: 1 })
    expect(incremented.flags).not.toBe(before)
    expect(decremented.flags).not.toBe(before)
  })
})

/* ───────────────────────────────── imul ──────────────────────────────── */

describe('imul', () => {
  // CF and OF are always equal after imul, so the table has one column for both.
  // SF and ZF follow the result: that is this emulator's documented choice (see alu.ts).
  // a, b, size → result, CF = OF, ZF, SF
  type ImulCase = [
    a: bigint,
    b: bigint,
    size: OperandSize,
    result: bigint,
    overflow: Bit,
    ZF: Bit,
    SF: Bit,
  ]

  const cases: ImulCase[] = [
    // 16 bits
    [0x0003n, 0x0004n, 16, 0x000cn, 0, 0, 0], // small × small
    [0xfffdn, 0x0004n, 16, 0xfff4n, 0, 0, 1], // -3 × 4 = -12
    [0xffffn, 0xffffn, 16, 0x0001n, 0, 0, 0], // -1 × -1 = 1
    [0x1234n, 0x0000n, 16, 0x0000n, 0, 1, 0], // × 0
    [0x4000n, 0x0002n, 16, 0x8000n, 1, 0, 1], // 16384 × 2 = 32768 does not fit
    [0x8000n, 0xffffn, 16, 0x8000n, 1, 0, 1], // -32768 × -1 = 32768 does not fit
    [0x8000n, 0x0001n, 16, 0x8000n, 0, 0, 1], // -32768 × 1 fits
    [0x7fffn, 0x7fffn, 16, 0x0001n, 1, 0, 0], // 0x3fff0001: only the low 16 bits stay
    [0x8000n, 0x8000n, 16, 0x0000n, 1, 1, 0], // 2^30: the low 16 bits are all 0
    [0xff00n, 0x0100n, 16, 0x0000n, 1, 1, 0], // -256 × 256 = -65536
    [0x00b5n, 0x00b5n, 16, 0x7ff9n, 0, 0, 0], // 181 × 181 = 32761: the last square that fits
    [0x00b6n, 0x00b6n, 16, 0x8164n, 1, 0, 1], // 182 × 182 = 33124: the first that does not
    // 32 bits
    [0x3n, 0x4n, 32, 0xcn, 0, 0, 0],
    [0x7n, 0x6n, 32, 0x2an, 0, 0, 0],
    [0xffff_fffdn, 0x4n, 32, 0xffff_fff4n, 0, 0, 1],
    [0xffff_fff9n, 0xffff_fffan, 32, 0x2an, 0, 0, 0], // -7 × -6 = 42
    [0xffff_ffffn, 0xffff_ffffn, 32, 0x1n, 0, 0, 0],
    [0x1234_5678n, 0x0n, 32, 0x0n, 0, 1, 0],
    [0x7fff_ffffn, 0x2n, 32, 0xffff_fffen, 1, 0, 1], // the classic: twice the biggest int
    [0x8000_0000n, 0xffff_ffffn, 32, 0x8000_0000n, 1, 0, 1],
    [0x8000_0000n, 0x1n, 32, 0x8000_0000n, 0, 0, 1],
    [0x1_0000n, 0x1_0000n, 32, 0x0n, 1, 1, 0], // 2^32
    [0xb504n, 0xb504n, 32, 0x7ffe_a810n, 0, 0, 0], // 46340 × 46340: the last square that fits
    [0xb505n, 0xb505n, 32, 0x8000_1219n, 1, 0, 1], // 46341 × 46341: the first that does not
    // 64 bits
    [0x3n, 0x4n, 64, 0xcn, 0, 0, 0],
    [0x78n, 0x6n, 64, 0x2d0n, 0, 0, 0], // 120 × 6 = 720, a factorial step
    [0xffff_ffff_ffff_fffdn, 0x4n, 64, 0xffff_ffff_ffff_fff4n, 0, 0, 1],
    [0xffff_ffff_ffff_ffffn, 0xffff_ffff_ffff_ffffn, 64, 0x1n, 0, 0, 0],
    [0x1234_5678_9abc_def0n, 0x0n, 64, 0x0n, 0, 1, 0],
    [0x7fff_ffffn, 0x2n, 64, 0xffff_fffen, 0, 0, 0], // overflows at 32 bits, fits at 64
    [0x4000_0000_0000_0000n, 0x2n, 64, 0x8000_0000_0000_0000n, 1, 0, 1],
    [0x4000_0000_0000_0000n, 0x4n, 64, 0x0n, 1, 1, 0], // 2^64
    [0x8000_0000_0000_0000n, 0xffff_ffff_ffff_ffffn, 64, 0x8000_0000_0000_0000n, 1, 0, 1],
    [0x8000_0000_0000_0000n, 0x1n, 64, 0x8000_0000_0000_0000n, 0, 0, 1],
    [0x1_0000_0000n, 0x1_0000_0000n, 64, 0x0n, 1, 1, 0],
    [0xb504_f333n, 0xb504_f333n, 64, 0x7fff_fffe_9ea1_dc29n, 0, 0, 0], // the last square that fits
    [0xb504_f334n, 0xb504_f334n, 64, 0x8000_0000_08ab_c290n, 1, 0, 1], // the first that does not
    // 8 bits: no such 2-operand instruction on a real CPU, but the rule is the same.
    [0x03n, 0x04n, 8, 0x0cn, 0, 0, 0],
    [0xffn, 0xffn, 8, 0x01n, 0, 0, 0],
    [0x10n, 0x08n, 8, 0x80n, 1, 0, 1], // 16 × 8 = 128 does not fit
    [0x80n, 0xffn, 8, 0x80n, 1, 0, 1],
    [0x10n, 0x10n, 8, 0x00n, 1, 1, 0],
  ]

  it.each(titled(cases, ([a, b, size]) => `${h(a)} × ${h(b)} at ${size} bits`))(
    '%s',
    (_title, a, b, size, result, overflow, ZF, SF) => {
      expect(imul(a, b, size)).toEqual({ result, flags: { CF: overflow, ZF, SF, OF: overflow } })
    },
  )

  it('gives the same answer with the operands the other way round', () => {
    for (const size of SIZES) {
      for (const a of edgeValues(size)) {
        for (const b of edgeValues(size)) {
          expect(imul(a, b, size), `${h(a)} × ${h(b)} at ${size}`).toEqual(imul(b, a, size))
        }
      }
    }
  })

  it.each(SIZES)('matches plain BigInt maths on 2000 pseudo-random pairs at %i bits', (size) => {
    const { modulus, half, signed, fitsSigned } = widthOf(size)
    let overflows = 0
    for (const [a, b] of randomPairs(size, 2000, 0x1ced_c0ffeen + BigInt(size))) {
      const product = signed(a) * signed(b)
      const result = ((product % modulus) + modulus) % modulus
      const overflow = bit(!fitsSigned(product))
      overflows += overflow
      expect(imul(a, b, size), `${h(a)} × ${h(b)}`).toEqual({
        result,
        flags: { CF: overflow, ZF: bit(result === 0n), SF: bit(result >= half), OF: overflow },
      })
    }
    // The pairs must really exercise both outcomes.
    expect(overflows).toBeGreaterThan(100)
    expect(overflows).toBeLessThan(1900)
  })
})

/* ───────────────────────── and, or, xor, test ────────────────────────── */

describe('logic (and, or, xor, test)', () => {
  // CF and OF are always 0 after these, so the table lists only ZF and SF.
  // op, a, b, size → result, ZF, SF
  type LogicCase = [
    op: 'and' | 'or' | 'xor',
    a: bigint,
    b: bigint,
    size: OperandSize,
    result: bigint,
    ZF: Bit,
    SF: Bit,
  ]

  const cases: LogicCase[] = [
    // 8 bits
    ['and', 0xf0n, 0x0fn, 8, 0x00n, 1, 0],
    ['and', 0xffn, 0x80n, 8, 0x80n, 0, 1],
    ['and', 0x7fn, 0x7fn, 8, 0x7fn, 0, 0],
    ['or', 0x00n, 0x00n, 8, 0x00n, 1, 0],
    ['or', 0x80n, 0x01n, 8, 0x81n, 0, 1],
    ['or', 0x0fn, 0x30n, 8, 0x3fn, 0, 0],
    ['xor', 0x5an, 0x5an, 8, 0x00n, 1, 0], // x xor x = 0
    ['xor', 0xffn, 0x7fn, 8, 0x80n, 0, 1],
    ['xor', 0x0fn, 0x05n, 8, 0x0an, 0, 0],
    // 16 bits
    ['and', 0xff00n, 0x00ffn, 16, 0x0000n, 1, 0],
    ['and', 0xffffn, 0x8000n, 16, 0x8000n, 0, 1],
    ['or', 0x0000n, 0x0000n, 16, 0x0000n, 1, 0],
    ['or', 0x8000n, 0x0001n, 16, 0x8001n, 0, 1],
    ['xor', 0x1234n, 0x1234n, 16, 0x0000n, 1, 0],
    ['xor', 0xffffn, 0x7fffn, 16, 0x8000n, 0, 1],
    ['and', 0x00ffn, 0x0080n, 16, 0x0080n, 0, 0], // the 8-bit sign bit is ordinary here
    // 32 bits
    ['and', 0xffff_0000n, 0x0000_ffffn, 32, 0x0n, 1, 0],
    ['and', 0xffff_ffffn, 0x8000_0000n, 32, 0x8000_0000n, 0, 1],
    ['or', 0x0n, 0x0n, 32, 0x0n, 1, 0],
    ['or', 0x8000_0000n, 0x1n, 32, 0x8000_0001n, 0, 1],
    ['xor', 0xdead_beefn, 0xdead_beefn, 32, 0x0n, 1, 0], // `xor eax, eax`
    ['xor', 0xffff_ffffn, 0x7fff_ffffn, 32, 0x8000_0000n, 0, 1],
    ['and', 0x5n, 0x5n, 32, 0x5n, 0, 0], // `test eax, eax` with eax = 5
    ['and', 0x0n, 0x0n, 32, 0x0n, 1, 0], // `test eax, eax` with eax = 0
    // 64 bits
    ['and', 0xffff_ffff_0000_0000n, 0x0000_0000_ffff_ffffn, 64, 0x0n, 1, 0],
    ['and', 0xffff_ffff_ffff_ffffn, 0x8000_0000_0000_0000n, 64, 0x8000_0000_0000_0000n, 0, 1],
    ['or', 0x0n, 0x0n, 64, 0x0n, 1, 0],
    ['or', 0x8000_0000_0000_0000n, 0x1n, 64, 0x8000_0000_0000_0001n, 0, 1],
    ['xor', 0x1234_5678_9abc_def0n, 0x1234_5678_9abc_def0n, 64, 0x0n, 1, 0],
    ['xor', 0xffff_ffff_ffff_ffffn, 0x7fff_ffff_ffff_ffffn, 64, 0x8000_0000_0000_0000n, 0, 1],
    ['and', 0x8000_0000n, 0x8000_0000n, 64, 0x8000_0000n, 0, 0], // the 32-bit sign bit is ordinary here
    ['and', 0x7fff_fffd_dff8n, 0xffff_ffff_ffff_fff0n, 64, 0x7fff_fffd_dff0n, 0, 0], // `and rsp, -16`
  ]

  it.each(titled(cases, ([op, a, b, size]) => `${h(a)} ${op} ${h(b)} at ${size} bits`))(
    '%s',
    (_title, op, a, b, size, result, ZF, SF) => {
      expect(logic(op, a, b, size)).toEqual({ result, flags: { CF: 0, ZF, SF, OF: 0 } })
    },
  )

  it.each(SIZES)(
    'CF and OF are 0, ZF and SF follow the result, for every edge pair at %i bits',
    (size) => {
      const { half } = widthOf(size)
      const operations = {
        and: (a: bigint, b: bigint) => a & b,
        or: (a: bigint, b: bigint) => a | b,
        xor: (a: bigint, b: bigint) => a ^ b,
      }
      for (const op of ['and', 'or', 'xor'] as const) {
        for (const a of edgeValues(size)) {
          for (const b of edgeValues(size)) {
            const result = operations[op](a, b)
            expect(logic(op, a, b, size), `${h(a)} ${op} ${h(b)}`).toEqual({
              result,
              flags: { CF: 0, ZF: bit(result === 0n), SF: bit(result >= half), OF: 0 },
            })
          }
        }
      }
    },
  )

  it.each(SIZES)('x xor x is 0 with ZF = 1, and x and x is x, at %i bits', (size) => {
    for (const x of edgeValues(size)) {
      expect(logic('xor', x, x, size), h(x)).toEqual({
        result: 0n,
        flags: { CF: 0, ZF: 1, SF: 0, OF: 0 },
      })
      expect(logic('and', x, x, size).result, h(x)).toBe(x)
      expect(logic('or', x, x, size).result, h(x)).toBe(x)
    }
  })
})

/* ──────────────────────── Inputs out of range ────────────────────────── */

describe('inputs that are negative or too wide', () => {
  it('a negative immediate works like its two’s complement', () => {
    expect(add(0x05n, -1n, 8)).toEqual({ result: 0x04n, flags: { CF: 1, ZF: 0, SF: 0, OF: 0 } })
    expect(add(-1n, -1n, 64)).toEqual({
      result: 0xffff_ffff_ffff_fffen,
      flags: { CF: 1, ZF: 0, SF: 1, OF: 0 },
    })
    expect(sub(0x00n, -1n, 8)).toEqual({ result: 0x01n, flags: { CF: 1, ZF: 0, SF: 0, OF: 0 } })
    expect(sub(-1n, -1n, 64)).toEqual({ result: 0x0n, flags: { CF: 0, ZF: 1, SF: 0, OF: 0 } })
    expect(sub(0x7fff_fffd_e000n, -8n, 64).result).toBe(0x7fff_fffd_e008n)
    expect(imul(-3n, 4n, 32)).toEqual({
      result: 0xffff_fff4n,
      flags: { CF: 0, ZF: 0, SF: 1, OF: 0 },
    })
    expect(logic('and', 0x7fff_fffd_dff8n, -16n, 64).result).toBe(0x7fff_fffd_dff0n)
    expect(logic('xor', -1n, 0n, 8)).toEqual({
      result: 0xffn,
      flags: { CF: 0, ZF: 0, SF: 1, OF: 0 },
    })
  })

  it('bits above the width are ignored', () => {
    expect(add(0x1ffn, 0x01n, 8)).toEqual({ result: 0x00n, flags: { CF: 1, ZF: 1, SF: 0, OF: 0 } })
    expect(add(0x1_0000_0001n, 0x2_0000_0001n, 32).result).toBe(0x2n)
    expect(sub(0x100n, 0x01n, 8)).toEqual({ result: 0xffn, flags: { CF: 1, ZF: 0, SF: 1, OF: 0 } })
    expect(imul(0x1_0003n, 0x1_0004n, 16).result).toBe(0xcn)
    expect(logic('or', 0xf00n, 0x0fn, 8).result).toBe(0x0fn)
    const before: Flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }
    expect(inc(-1n, 8, before)).toEqual({ result: 0x00n, flags: { CF: 0, ZF: 1, SF: 0, OF: 0 } })
    expect(dec(0x100n, 8, before)).toEqual({ result: 0xffn, flags: { CF: 0, ZF: 0, SF: 1, OF: 0 } })
  })

  it.each(SIZES)('every result is unsigned and fits in %i bits', (size) => {
    const { max } = widthOf(size)
    const before: Flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }
    const wild = [-1n, -2n, -(2n ** 70n), 2n ** 70n + 3n, max + 1n, max * 5n, -max]
    for (const a of wild) {
      for (const b of wild) {
        const results: AluResult[] = [
          add(a, b, size),
          sub(a, b, size),
          imul(a, b, size),
          logic('and', a, b, size),
          logic('or', a, b, size),
          logic('xor', a, b, size),
          inc(a, size, before),
          dec(a, size, before),
        ]
        for (const { result } of results) {
          expect(result >= 0n && result <= max, `${h(a)}, ${h(b)}`).toBe(true)
        }
      }
    }
  })

  it.each(SIZES)('an input and its truncated form give the same answer at %i bits', (size) => {
    const { modulus } = widthOf(size)
    const wild = [-1n, -2n, -200n, modulus, modulus + 7n, modulus * 3n + 0x55n, -modulus - 1n]
    for (const a of wild) {
      for (const b of wild) {
        const lowA = ((a % modulus) + modulus) % modulus
        const lowB = ((b % modulus) + modulus) % modulus
        const what = `${h(a)}, ${h(b)}`
        expect(add(a, b, size), what).toEqual(add(lowA, lowB, size))
        expect(sub(a, b, size), what).toEqual(sub(lowA, lowB, size))
        expect(imul(a, b, size), what).toEqual(imul(lowA, lowB, size))
        expect(logic('xor', a, b, size), what).toEqual(logic('xor', lowA, lowB, size))
      }
    }
  })
})

/* ─────────────────── add and sub against plain maths ─────────────────── */

describe('add and sub against plain BigInt maths', () => {
  /** a + b, worked out with ordinary whole-number maths. */
  function referenceAdd(a: bigint, b: bigint, size: OperandSize): AluResult {
    const { modulus, half, signed, fitsSigned } = widthOf(size)
    const result = (a + b) % modulus
    return {
      result,
      flags: {
        CF: bit(a + b >= modulus),
        ZF: bit(result === 0n),
        SF: bit(result >= half),
        OF: bit(!fitsSigned(signed(a) + signed(b))),
      },
    }
  }

  /** a - b, worked out with ordinary whole-number maths. */
  function referenceSub(a: bigint, b: bigint, size: OperandSize): AluResult {
    const { modulus, half, signed, fitsSigned } = widthOf(size)
    const result = (a - b + modulus) % modulus
    return {
      result,
      flags: {
        CF: bit(a < b),
        ZF: bit(result === 0n),
        SF: bit(result >= half),
        OF: bit(!fitsSigned(signed(a) - signed(b))),
      },
    }
  }

  it('the reference itself gets the three cases from the product brief right', () => {
    expect(referenceAdd(0x7fn, 0x01n, 8)).toEqual({
      result: 0x80n,
      flags: { CF: 0, ZF: 0, SF: 1, OF: 1 },
    })
    expect(referenceAdd(0xffn, 0x01n, 8)).toEqual({
      result: 0x00n,
      flags: { CF: 1, ZF: 1, SF: 0, OF: 0 },
    })
    expect(referenceSub(0x05n, 0x05n, 8)).toEqual({
      result: 0x00n,
      flags: { CF: 0, ZF: 1, SF: 0, OF: 0 },
    })
  })

  it.each(SIZES)('every pair of edge values at %i bits', (size) => {
    for (const a of edgeValues(size)) {
      for (const b of edgeValues(size)) {
        expect(add(a, b, size), `${h(a)} + ${h(b)}`).toEqual(referenceAdd(a, b, size))
        expect(sub(a, b, size), `${h(a)} - ${h(b)}`).toEqual(referenceSub(a, b, size))
      }
    }
  })

  it.each(SIZES)('2000 pseudo-random pairs at %i bits', (size) => {
    const pairs = randomPairs(size, 2000, 0x5eed_0000n + BigInt(size))
    expect(pairs).toHaveLength(2000)
    const seen = { CF: 0, ZF: 0, SF: 0, OF: 0 }
    for (const [a, b] of pairs) {
      const sum = add(a, b, size)
      const difference = sub(a, b, size)
      expect(sum, `${h(a)} + ${h(b)}`).toEqual(referenceAdd(a, b, size))
      expect(difference, `${h(a)} - ${h(b)}`).toEqual(referenceSub(a, b, size))
      for (const name of ['CF', 'ZF', 'SF', 'OF'] as const) {
        seen[name] += sum.flags[name] + difference.flags[name]
      }
    }
    // The pairs must really exercise every flag, many times.
    for (const name of ['CF', 'ZF', 'SF', 'OF'] as const) {
      expect(seen[name], name).toBeGreaterThan(100)
    }
  })

  it('the generator gives the same pairs on every run', () => {
    expect(randomPairs(32, 50, 7n)).toEqual(randomPairs(32, 50, 7n))
    expect(randomPairs(32, 50, 7n)).not.toEqual(randomPairs(32, 50, 8n))
  })
})

/* ──────────────────────── Conditional jumps ──────────────────────────── */

const BRIEF_ORDER: JumpCondition[] = [
  'je',
  'jne',
  'jg',
  'jge',
  'jl',
  'jle',
  'ja',
  'jae',
  'jb',
  'jbe',
  'js',
  'jns',
  'jo',
  'jno',
]

describe('JUMP_CONDITIONS and isJumpCondition', () => {
  it('lists the 14 conditional jumps, each one once', () => {
    expect(JUMP_CONDITIONS).toEqual(BRIEF_ORDER)
    expect(new Set(JUMP_CONDITIONS).size).toBe(14)
  })

  it('is every `j…` mnemonic of the emulator except jmp', () => {
    const jumps = MNEMONICS.filter((m) => m.startsWith('j') && m !== 'jmp')
    expect([...JUMP_CONDITIONS].sort()).toEqual([...jumps].sort())
  })

  it.each(BRIEF_ORDER)('%s is a jump condition', (name) => {
    expect(isJumpCondition(name)).toBe(true)
  })

  it.each([
    'jmp',
    'call',
    'ret',
    'mov',
    'cmp',
    // Other spellings are folded by the parser before they get here.
    'jz',
    'jnz',
    'jc',
    'jnle',
    // Only lower case is canonical.
    'JE',
    'Jne',
    '',
    ' je',
    // Names every JavaScript object has.
    'toString',
    'constructor',
    'hasOwnProperty',
    '__proto__',
  ])('%j is not a jump condition', (name) => {
    expect(isJumpCondition(name)).toBe(false)
  })

  it('narrows the type, so the result can be used right away', () => {
    const typed: string = 'jle'
    expect(isJumpCondition(typed) && conditionHolds(typed, ALL_FLAGS[0])).toBe(false)
    expect(isJumpCondition(typed) && describeCondition(typed).rule).toBe('ZF = 1 or SF ≠ OF')
  })
})

describe('conditionHolds', () => {
  /**
   * The rules from the brief, written again in a different way (with bit arithmetic):
   * je ZF=1 · jne ZF=0 · jg ZF=0 and SF=OF · jge SF=OF · jl SF≠OF · jle ZF=1 or SF≠OF ·
   * ja CF=0 and ZF=0 · jae CF=0 · jb CF=1 · jbe CF=1 or ZF=1 · js SF=1 · jns SF=0 ·
   * jo OF=1 · jno OF=0.
   */
  const RULES: Record<JumpCondition, (f: Flags) => boolean> = {
    je: (f) => f.ZF === 1,
    jne: (f) => f.ZF !== 1,
    jg: (f) => (f.ZF | (f.SF ^ f.OF)) === 0,
    jge: (f) => (f.SF ^ f.OF) === 0,
    jl: (f) => (f.SF ^ f.OF) === 1,
    jle: (f) => (f.ZF | (f.SF ^ f.OF)) === 1,
    ja: (f) => (f.CF | f.ZF) === 0,
    jae: (f) => f.CF !== 1,
    jb: (f) => f.CF === 1,
    jbe: (f) => (f.CF | f.ZF) === 1,
    js: (f) => f.SF === 1,
    jns: (f) => f.SF !== 1,
    jo: (f) => f.OF === 1,
    jno: (f) => f.OF !== 1,
  }

  it('the truth table really has all 16 flag combinations', () => {
    expect(new Set(ALL_FLAGS.map(show)).size).toBe(16)
  })

  it.each(BRIEF_ORDER)('%s follows its rule for all 16 flag combinations', (condition) => {
    for (const flags of ALL_FLAGS) {
      expect(conditionHolds(condition, flags), show(flags)).toBe(RULES[condition](flags))
    }
  })

  // How many of the 16 combinations make each jump jump (counted by hand from the rules).
  it.each([
    ['je', 8],
    ['jne', 8],
    ['jg', 4],
    ['jge', 8],
    ['jl', 8],
    ['jle', 12],
    ['ja', 4],
    ['jae', 8],
    ['jb', 8],
    ['jbe', 12],
    ['js', 8],
    ['jns', 8],
    ['jo', 8],
    ['jno', 8],
  ] as [JumpCondition, number][])('%s jumps for %i of the 16 combinations', (condition, count) => {
    expect(ALL_FLAGS.filter((flags) => conditionHolds(condition, flags))).toHaveLength(count)
  })

  it.each([
    ['je', 'jne'],
    ['jg', 'jle'],
    ['jge', 'jl'],
    ['ja', 'jbe'],
    ['jae', 'jb'],
    ['js', 'jns'],
    ['jo', 'jno'],
  ] as [JumpCondition, JumpCondition][])('%s and %s are opposites', (one, other) => {
    for (const flags of ALL_FLAGS) {
      expect(conditionHolds(one, flags), show(flags)).toBe(!conditionHolds(other, flags))
    }
  })

  it('does not change the flags it reads', () => {
    const flags: Flags = { CF: 1, ZF: 0, SF: 1, OF: 0 }
    for (const condition of JUMP_CONDITIONS) conditionHolds(condition, flags)
    expect(flags).toEqual({ CF: 1, ZF: 0, SF: 1, OF: 0 })
  })
})

describe('conditional jumps after cmp and test', () => {
  // Which jumps are taken after `cmp a, b`, in the order of JUMP_CONDITIONS.
  const afterCmp: [a: bigint, b: bigint, size: OperandSize, taken: JumpCondition[]][] = [
    [0x3n, 0x5n, 32, ['jne', 'jl', 'jle', 'jb', 'jbe', 'js', 'jno']], // 3 < 5 both ways
    [0x5n, 0x3n, 32, ['jne', 'jg', 'jge', 'ja', 'jae', 'jns', 'jno']], // 5 > 3 both ways
    [0x5n, 0x5n, 32, ['je', 'jge', 'jle', 'jae', 'jbe', 'jns', 'jno']], // equal
    // -1 against 1: less as signed, but above as unsigned (0xffffffff is huge).
    [0xffff_ffffn, 0x1n, 32, ['jne', 'jl', 'jle', 'ja', 'jae', 'js', 'jno']],
    // 1 against -1: greater as signed, but below as unsigned.
    [0x1n, 0xffff_ffffn, 32, ['jne', 'jg', 'jge', 'jb', 'jbe', 'jns', 'jno']],
    // Smallest int against 1: the subtraction overflows, and jl still gets it right.
    [0x8000_0000n, 0x1n, 32, ['jne', 'jl', 'jle', 'ja', 'jae', 'jns', 'jo']],
    // Biggest int against -1: overflows the other way, and jg still gets it right.
    [0x7fff_ffffn, 0xffff_ffffn, 32, ['jne', 'jg', 'jge', 'jb', 'jbe', 'js', 'jo']],
    // The same shapes at other widths.
    [0x80n, 0x7fn, 8, ['jne', 'jl', 'jle', 'ja', 'jae', 'jns', 'jo']],
    [0x8000n, 0x8000n, 16, ['je', 'jge', 'jle', 'jae', 'jbe', 'jns', 'jno']],
    [0x0n, 0xffff_ffff_ffff_ffffn, 64, ['jne', 'jg', 'jge', 'jb', 'jbe', 'jns', 'jno']],
    [0x9n, 0xan, 64, ['jne', 'jl', 'jle', 'jb', 'jbe', 'js', 'jno']], // a loop: i = 9, n = 10
  ]

  it.each(titled(afterCmp, ([a, b, size]) => `cmp ${h(a)}, ${h(b)} at ${size} bits`))(
    '%s',
    (_title, a, b, size, taken) => {
      const { flags } = sub(a, b, size)
      expect(JUMP_CONDITIONS.filter((condition) => conditionHolds(condition, flags))).toEqual(taken)
    },
  )

  // Which jumps are taken after `test x, x` (an `and` that only sets the flags).
  const afterTest: [x: bigint, size: OperandSize, taken: JumpCondition[]][] = [
    [0x0n, 32, ['je', 'jge', 'jle', 'jae', 'jbe', 'jns', 'jno']], // zero
    [0x5n, 32, ['jne', 'jg', 'jge', 'ja', 'jae', 'jns', 'jno']], // positive
    [0x8000_0000n, 32, ['jne', 'jl', 'jle', 'ja', 'jae', 'js', 'jno']], // negative
    [0x8000_0000n, 64, ['jne', 'jg', 'jge', 'ja', 'jae', 'jns', 'jno']], // positive at 64 bits
  ]

  it.each(titled(afterTest, ([x, size]) => `test ${h(x)}, ${h(x)} at ${size} bits`))(
    '%s',
    (_title, x, size, taken) => {
      const { flags } = logic('and', x, x, size)
      expect(JUMP_CONDITIONS.filter((condition) => conditionHolds(condition, flags))).toEqual(taken)
    },
  )

  it.each(SIZES)('after cmp a, b each jump means what its name says, at %i bits', (size) => {
    const { signed } = widthOf(size)
    const values = [
      ...edgeValues(size),
      ...randomPairs(size, 40, 0xc0de_0000n + BigInt(size)).flat(),
    ]
    for (const a of values) {
      for (const b of values) {
        const { flags } = sub(a, b, size)
        const meaning: Partial<Record<JumpCondition, boolean>> = {
          je: a === b,
          jne: a !== b,
          jg: signed(a) > signed(b),
          jge: signed(a) >= signed(b),
          jl: signed(a) < signed(b),
          jle: signed(a) <= signed(b),
          ja: a > b,
          jae: a >= b,
          jb: a < b,
          jbe: a <= b,
        }
        for (const condition of JUMP_CONDITIONS) {
          const expected = meaning[condition]
          if (expected === undefined) continue
          expect(conditionHolds(condition, flags), `${condition} after cmp ${h(a)}, ${h(b)}`).toBe(
            expected,
          )
        }
      }
    }
  })

  it.each(SIZES)(
    'js and jo read the sign and the overflow of the last result, at %i bits',
    (size) => {
      const { half, signed, fitsSigned } = widthOf(size)
      for (const a of edgeValues(size)) {
        for (const b of edgeValues(size)) {
          const sum = add(a, b, size)
          const what = `${h(a)} + ${h(b)}`
          expect(conditionHolds('js', sum.flags), what).toBe(sum.result >= half)
          expect(conditionHolds('jns', sum.flags), what).toBe(sum.result < half)
          expect(conditionHolds('jo', sum.flags), what).toBe(!fitsSigned(signed(a) + signed(b)))
          expect(conditionHolds('jno', sum.flags), what).toBe(fitsSigned(signed(a) + signed(b)))
        }
      }
    },
  )
})

/* ──────────────────────────── describeCondition ──────────────────────── */

describe('describeCondition', () => {
  // The words students read: the rule exactly as the brief gives it, and what it means.
  const words: [JumpCondition, rule: string, meaning: string][] = [
    ['je', 'ZF = 1', 'equal (or zero)'],
    ['jne', 'ZF = 0', 'not equal (or not zero)'],
    ['jg', 'ZF = 0 and SF = OF', 'greater than (signed)'],
    ['jge', 'SF = OF', 'greater than or equal (signed)'],
    ['jl', 'SF ≠ OF', 'less than (signed)'],
    ['jle', 'ZF = 1 or SF ≠ OF', 'less than or equal (signed)'],
    ['ja', 'CF = 0 and ZF = 0', 'greater than (unsigned)'],
    ['jae', 'CF = 0', 'greater than or equal (unsigned)'],
    ['jb', 'CF = 1', 'less than (unsigned)'],
    ['jbe', 'CF = 1 or ZF = 1', 'less than or equal (unsigned)'],
    ['js', 'SF = 1', 'negative'],
    ['jns', 'SF = 0', 'not negative'],
    ['jo', 'OF = 1', 'signed overflow'],
    ['jno', 'OF = 0', 'no signed overflow'],
  ]

  it.each(words)('%s: %s, %s', (condition, rule, meaning) => {
    expect(describeCondition(condition)).toEqual({ rule, meaning })
  })

  it('covers every condition', () => {
    expect(words.map(([condition]) => condition)).toEqual(JUMP_CONDITIONS)
  })

  it('gives the example from the brief for jl', () => {
    expect(describeCondition('jl')).toEqual({ rule: 'SF ≠ OF', meaning: 'less than (signed)' })
  })

  /** Work out a rule text such as 'ZF = 1 or SF ≠ OF' for one set of flags. */
  function ruleHolds(rule: string, flags: Flags): boolean {
    return rule
      .split(' or ')
      .some((part) => part.split(' and ').every((term) => termHolds(term, flags)))
  }

  function termHolds(term: string, flags: Flags): boolean {
    const match = /^(CF|ZF|SF|OF) (=|≠) (CF|ZF|SF|OF|0|1)$/.exec(term)
    if (match === null) throw new Error(`Cannot read the rule term "${term}"`)
    const [, left, operator, right] = match
    const leftValue = flags[left as FlagName]
    const rightValue = right === '0' || right === '1' ? Number(right) : flags[right as FlagName]
    return operator === '=' ? leftValue === rightValue : leftValue !== rightValue
  }

  it.each(BRIEF_ORDER)('the rule text of %s says exactly what the emulator does', (condition) => {
    const { rule } = describeCondition(condition)
    for (const flags of ALL_FLAGS) {
      expect(ruleHolds(rule, flags), `"${rule}" with ${show(flags)}`).toBe(
        conditionHolds(condition, flags),
      )
    }
  })

  it('writes every meaning the same way: short, lower case, no full stop', () => {
    const meanings = JUMP_CONDITIONS.map((condition) => describeCondition(condition).meaning)
    expect(new Set(meanings).size).toBe(meanings.length)
    for (const meaning of meanings) {
      expect(meaning).toMatch(/^[a-z][a-z ()]*[a-z)]$/)
      expect(meaning.length).toBeLessThanOrEqual(40)
    }
  })

  it('says "signed" for jg/jge/jl/jle and "unsigned" for ja/jae/jb/jbe', () => {
    for (const condition of ['jg', 'jge', 'jl', 'jle'] as const) {
      expect(describeCondition(condition).meaning).toMatch(/ \(signed\)$/)
    }
    for (const condition of ['ja', 'jae', 'jb', 'jbe'] as const) {
      expect(describeCondition(condition).meaning).toMatch(/ \(unsigned\)$/)
    }
  })

  it('returns a fresh object each time', () => {
    const first = describeCondition('je')
    first.rule = 'changed'
    first.meaning = 'changed'
    expect(describeCondition('je')).toEqual({ rule: 'ZF = 1', meaning: 'equal (or zero)' })
  })
})
