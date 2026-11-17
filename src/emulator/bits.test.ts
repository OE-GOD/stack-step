import { describe, expect, it } from 'vitest'
import { MASK, SIGN_BIT, signBit, signExtend, toSigned, truncate } from './bits'
import type { OperandSize } from './types'

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

/** A mix of ordinary, edge and out-of-range numbers, used by the "for many values" tests. */
const SAMPLES: readonly bigint[] = [
  0n,
  1n,
  2n,
  0x7fn,
  0x80n,
  0xffn,
  0x100n,
  0x7fffn,
  0x8000n,
  0xffffn,
  0x1_0000n,
  0x7fff_ffffn,
  0x8000_0000n,
  0xffff_ffffn,
  0x1_0000_0000n,
  0x7fff_ffff_ffff_ffffn,
  0x8000_0000_0000_0000n,
  0xffff_ffff_ffff_ffffn,
  0x1_0000_0000_0000_0000n,
  0x1234_5678_9abc_def0n,
  0xdead_beef_cafe_f00dn,
  -1n,
  -2n,
  -128n,
  -129n,
  -32768n,
  -0x8000_0000n,
  -0x8000_0000_0000_0000n,
  -0x1_2345_6789_abcd_ef01n,
]

describe('MASK and SIGN_BIT', () => {
  it.each([
    [8, 0xffn, 0x80n],
    [16, 0xffffn, 0x8000n],
    [32, 0xffff_ffffn, 0x8000_0000n],
    [64, 0xffff_ffff_ffff_ffffn, 0x8000_0000_0000_0000n],
  ] as [OperandSize, bigint, bigint][])('%i bits', (size, mask, sign) => {
    expect(MASK[size]).toBe(mask)
    expect(SIGN_BIT[size]).toBe(sign)
  })

  it.each(SIZES)('at %i bits the mask is 2^size - 1 and the sign bit is 2^(size - 1)', (size) => {
    expect(MASK[size]).toBe(2n ** BigInt(size) - 1n)
    expect(SIGN_BIT[size]).toBe(2n ** BigInt(size - 1))
    // The sign bit is the top bit of the mask, and nothing else.
    expect(MASK[size] >> 1n).toBe(SIGN_BIT[size] - 1n)
    expect(SIGN_BIT[size] & MASK[size]).toBe(SIGN_BIT[size])
  })

  it('has exactly the four widths', () => {
    expect(Object.keys(MASK)).toEqual(['8', '16', '32', '64'])
    expect(Object.keys(SIGN_BIT)).toEqual(['8', '16', '32', '64'])
  })
})

describe('truncate', () => {
  const cases: [bigint, OperandSize, bigint][] = [
    // A value that already fits is not changed.
    [0n, 8, 0n],
    [0x7fn, 8, 0x7fn],
    [0xffn, 8, 0xffn],
    [0xffffn, 16, 0xffffn],
    [0xffff_ffffn, 32, 0xffff_ffffn],
    [0xffff_ffff_ffff_ffffn, 64, 0xffff_ffff_ffff_ffffn],
    // Bits above the width are dropped.
    [0x100n, 8, 0n],
    [0x1ffn, 8, 0xffn],
    [0x1_2345n, 16, 0x2345n],
    [0x1_0000_0002n, 32, 0x2n],
    [0x1234_5678_9abc_def0n, 32, 0x9abc_def0n],
    [0x1_0000_0000_0000_0005n, 64, 0x5n],
    // A negative number becomes its two's complement.
    [-1n, 8, 0xffn],
    [-1n, 16, 0xffffn],
    [-1n, 32, 0xffff_ffffn],
    [-1n, 64, 0xffff_ffff_ffff_ffffn],
    [-128n, 8, 0x80n],
    [-129n, 8, 0x7fn],
    [-0x8000n, 16, 0x8000n],
    [-2n, 32, 0xffff_fffen],
    [-8n, 64, 0xffff_ffff_ffff_fff8n],
    [-0x8000_0000_0000_0000n, 64, 0x8000_0000_0000_0000n],
  ]

  it.each(titled(cases, ([value, size]) => `${h(value)} at ${size} bits`))(
    '%s',
    (_title, value, size, want) => {
      expect(truncate(value, size)).toBe(want)
    },
  )

  it.each(SIZES)('at %i bits the result is always unsigned and in range', (size) => {
    for (const value of SAMPLES) {
      const result = truncate(value, size)
      expect(result >= 0n && result <= MASK[size], h(value)).toBe(true)
      // Truncating twice changes nothing more.
      expect(truncate(result, size), h(value)).toBe(result)
      // Only whole multiples of 2^size were added or removed.
      expect((result - value) % 2n ** BigInt(size), h(value)).toBe(0n)
    }
  })
})

describe('toSigned', () => {
  const cases: [bigint, OperandSize, bigint][] = [
    [0n, 8, 0n],
    [0x7fn, 8, 127n],
    [0x80n, 8, -128n],
    [0xffn, 8, -1n],
    [0x7fffn, 16, 32767n],
    [0x8000n, 16, -32768n],
    [0xffffn, 16, -1n],
    [0x7fff_ffffn, 32, 2147483647n],
    [0x8000_0000n, 32, -2147483648n],
    [0xffff_ffffn, 32, -1n],
    [0x7fff_ffff_ffff_ffffn, 64, 9223372036854775807n],
    [0x8000_0000_0000_0000n, 64, -9223372036854775808n],
    [0xffff_ffff_ffff_ffffn, 64, -1n],
    // The same bits mean different numbers at different widths.
    [0xffn, 16, 255n],
    [0xffff_ffffn, 64, 4294967295n],
    // Only the low `size` bits count.
    [0x1ffn, 8, -1n],
    [0x100n, 8, 0n],
    [0x1_8000n, 16, -32768n],
    // A negative input is read by its low bits too.
    [-1n, 8, -1n],
    [-129n, 8, 127n],
    [-200n, 8, 56n],
    [-1n, 64, -1n],
  ]

  it.each(titled(cases, ([value, size]) => `${h(value)} at ${size} bits`))(
    '%s',
    (_title, value, size, want) => {
      expect(toSigned(value, size)).toBe(want)
    },
  )

  it.each(SIZES)('at %i bits the result is in the signed range and keeps the bits', (size) => {
    for (const value of SAMPLES) {
      const signed = toSigned(value, size)
      expect(signed >= -SIGN_BIT[size] && signed < SIGN_BIT[size], h(value)).toBe(true)
      // Going back to unsigned gives the same low bits as before.
      expect(truncate(signed, size), h(value)).toBe(truncate(value, size))
    }
  })
})

describe('signExtend', () => {
  const cases: [bigint, OperandSize, bigint][] = [
    // Top bit 0: zeros are added on the left.
    [0x7fn, 8, 0x7fn],
    [0x7fffn, 16, 0x7fffn],
    [0x7fff_ffffn, 32, 0x7fff_ffffn],
    [0n, 8, 0n],
    // Top bit 1: ones are added on the left.
    [0x80n, 8, 0xffff_ffff_ffff_ff80n],
    [0xffn, 8, 0xffff_ffff_ffff_ffffn],
    [0x8000n, 16, 0xffff_ffff_ffff_8000n],
    [0xfffen, 16, 0xffff_ffff_ffff_fffen],
    [0x8000_0000n, 32, 0xffff_ffff_8000_0000n],
    [0xffff_fff0n, 32, 0xffff_ffff_ffff_fff0n],
    // From 64 bits there is nothing to add.
    [0x8000_0000_0000_0000n, 64, 0x8000_0000_0000_0000n],
    [0x1234n, 64, 0x1234n],
    // Bits above `from` are ignored.
    [0x1234_5680n, 8, 0xffff_ffff_ffff_ff80n],
    [0xabcd_0012n, 8, 0x12n],
    [0xffff_7fffn, 16, 0x7fffn],
    // A negative input is read by its low bits.
    [-1n, 8, 0xffff_ffff_ffff_ffffn],
    [-128n, 8, 0xffff_ffff_ffff_ff80n],
    [-129n, 8, 0x7fn],
    [-2n, 32, 0xffff_ffff_ffff_fffen],
  ]

  it.each(titled(cases, ([value, from]) => `${h(value)} from ${from} bits`))(
    '%s',
    (_title, value, from, want) => {
      expect(signExtend(value, from)).toBe(want)
    },
  )

  it.each(SIZES)('from %i bits the signed value stays the same', (from) => {
    for (const value of SAMPLES) {
      const extended = signExtend(value, from)
      expect(extended >= 0n && extended <= MASK[64], h(value)).toBe(true)
      expect(toSigned(extended, 64), h(value)).toBe(toSigned(value, from))
      // The low `from` bits are untouched.
      expect(truncate(extended, from), h(value)).toBe(truncate(value, from))
    }
  })
})

describe('signBit', () => {
  const cases: [bigint, OperandSize, 0 | 1][] = [
    [0n, 8, 0],
    [0x7fn, 8, 0],
    [0x80n, 8, 1],
    [0xffn, 8, 1],
    [0x7fffn, 16, 0],
    [0x8000n, 16, 1],
    [0x7fff_ffffn, 32, 0],
    [0x8000_0000n, 32, 1],
    [0x7fff_ffff_ffff_ffffn, 64, 0],
    [0x8000_0000_0000_0000n, 64, 1],
    // The top bit of a narrow width is an ordinary bit of a wider one.
    [0x80n, 16, 0],
    [0x8000n, 32, 0],
    [0x8000_0000n, 64, 0],
    // Only the one bit at position size - 1 counts.
    [0x180n, 8, 1],
    [0x100n, 8, 0],
    [0x8000n, 8, 0],
    // A negative input is read by its two's complement bits.
    [-1n, 8, 1],
    [-1n, 64, 1],
    [-128n, 8, 1],
    [-129n, 8, 0],
  ]

  it.each(titled(cases, ([value, size]) => `${h(value)} at ${size} bits`))(
    '%s',
    (_title, value, size, want) => {
      expect(signBit(value, size)).toBe(want)
    },
  )

  it.each(SIZES)('at %i bits it is 1 exactly when the signed value is negative', (size) => {
    for (const value of SAMPLES) {
      expect(signBit(value, size), h(value)).toBe(toSigned(value, size) < 0n ? 1 : 0)
    }
  })
})
