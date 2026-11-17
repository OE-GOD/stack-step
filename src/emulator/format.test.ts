import { describe, expect, it } from 'vitest'
import {
  countHexDigits,
  groupDigits,
  groupHex,
  hex,
  hex64,
  hexDigits,
  hexSized,
  joinAnd,
  joinOr,
  parseHexAnswer,
  shortAddress,
  signedDecimal,
  signedHex,
} from './format'
import type { OperandSize } from './types'

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

const RSP_AT_START = 0x7fff_fffd_dff8n
const MAX_64 = 0xffff_ffff_ffff_ffffn

/** Values every formatter must handle: small numbers, addresses, edges and negatives. */
const SAMPLES: readonly bigint[] = [
  0n,
  1n,
  7n,
  0xffn,
  0x1f8n,
  0xffffn,
  0x1_0000n,
  0x40_1126n,
  0x40_4030n,
  RSP_AT_START,
  0x7fff_ffff_ffff_ffffn,
  0x8000_0000_0000_0000n,
  MAX_64,
  -1n,
  -8n,
  -0x8000_0000_0000_0000n,
]

describe('hex', () => {
  const cases: [bigint, number | undefined, string][] = [
    [255n, undefined, '0xff'],
    [255n, 4, '0x00ff'],
    [0n, undefined, '0x0'],
    [0n, 2, '0x00'],
    [0x1f8n, undefined, '0x1f8'],
    [0xabcdefn, undefined, '0xabcdef'],
    [RSP_AT_START, undefined, '0x7ffffffddff8'],
    [0x5n, 16, '0x0000000000000005'],
    [0xffn, 2, '0xff'],
    // `digits` only pads. It never cuts digits off.
    [0x1_2345n, 4, '0x12345'],
    [0x1_2345n, 0, '0x12345'],
    [MAX_64, undefined, '0xffffffffffffffff'],
    // A negative value is shown as its 64-bit two's complement.
    [-1n, undefined, '0xffffffffffffffff'],
    [-8n, undefined, '0xfffffffffffffff8'],
    [-0x8000_0000_0000_0000n, undefined, '0x8000000000000000'],
    [-1n, 4, '0xffffffffffffffff'],
    // A positive value wider than 64 bits keeps all its digits.
    [0x1_0000_0000_0000_0000n, undefined, '0x10000000000000000'],
  ]

  it.each(
    titled(
      cases,
      ([value, digits]) => `hex(${h(value)}${digits === undefined ? '' : `, ${digits}`})`,
    ),
  )('%s', (_title, value, digits, want) => {
    expect(hex(value, digits)).toBe(want)
  })

  it('always writes lower-case digits after a lower-case 0x', () => {
    for (const value of SAMPLES) expect(hex(value), h(value)).toMatch(/^0x[0-9a-f]+$/)
  })
})

describe('hex64', () => {
  const cases: [bigint, string][] = [
    [7n, '0x0000000000000007'],
    [0n, '0x0000000000000000'],
    [RSP_AT_START, '0x00007ffffffddff8'],
    [0x40_1126n, '0x0000000000401126'],
    [MAX_64, '0xffffffffffffffff'],
    [0x8000_0000_0000_0000n, '0x8000000000000000'],
    [-1n, '0xffffffffffffffff'],
    [-16n, '0xfffffffffffffff0'],
    // Bits above 64 are dropped, so there are never more than 16 digits.
    [0x1_0000_0000_0000_0007n, '0x0000000000000007'],
  ]

  it.each(titled(cases, ([value]) => `hex64(${h(value)})`))('%s', (_title, value, want) => {
    expect(hex64(value)).toBe(want)
  })

  it('always gives 0x and exactly 16 digits', () => {
    for (const value of [...SAMPLES, 0x1234_5678_9abc_def0_1234n]) {
      expect(hex64(value), h(value)).toMatch(/^0x[0-9a-f]{16}$/)
    }
  })

  it('is hexSized at 64 bits', () => {
    for (const value of SAMPLES) expect(hex64(value), h(value)).toBe(hexSized(value, 64))
  })
})

describe('hexSized', () => {
  const cases: [bigint, OperandSize, string][] = [
    [7n, 32, '0x00000007'],
    [7n, 8, '0x07'],
    [7n, 16, '0x0007'],
    [7n, 64, '0x0000000000000007'],
    [0n, 8, '0x00'],
    [0xffn, 8, '0xff'],
    [0xabcdn, 16, '0xabcd'],
    [0xdead_beefn, 32, '0xdeadbeef'],
    [RSP_AT_START, 64, '0x00007ffffffddff8'],
    // A negative value is shown as its two's complement at that width.
    [-1n, 8, '0xff'],
    [-1n, 16, '0xffff'],
    [-1n, 32, '0xffffffff'],
    [-1n, 64, '0xffffffffffffffff'],
    [-128n, 8, '0x80'],
    [-2n, 16, '0xfffe'],
    // Bits above the width are dropped.
    [0x1ffn, 8, '0xff'],
    [0x1_0000_0002n, 32, '0x00000002'],
    [0x1234_5678_9abc_def0n, 16, '0xdef0'],
    [0x1234_5678_9abc_def0n, 32, '0x9abcdef0'],
  ]

  it.each(titled(cases, ([value, size]) => `hexSized(${h(value)}, ${size})`))(
    '%s',
    (_title, value, size, want) => {
      expect(hexSized(value, size)).toBe(want)
    },
  )

  it.each([8, 16, 32, 64] as OperandSize[])('at %i bits there are size / 4 digits', (size) => {
    for (const value of SAMPLES) {
      expect(hexSized(value, size), h(value)).toMatch(new RegExp(`^0x[0-9a-f]{${size / 4}}$`))
    }
  })
})

describe('shortAddress', () => {
  const cases: [bigint, string][] = [
    // Below 0x10000: shown in full.
    [0x1f8n, '0x1f8'],
    [0n, '0x0'],
    [0x8n, '0x8'],
    [0xffffn, '0xffff'],
    // From 0x10000 up: only the last four digits.
    [0x1_0000n, '0x…0000'],
    [0x1_2345n, '0x…2345'],
    [RSP_AT_START, '0x…dff8'],
    [0x7fff_fffd_e000n, '0x…e000'],
    [0x40_1126n, '0x…1126'],
    [0x40_4030n, '0x…4030'],
    [MAX_64, '0x…ffff'],
    // A negative value is a very high 64-bit address.
    [-8n, '0x…fff8'],
  ]

  it.each(titled(cases, ([value]) => `shortAddress(${h(value)})`))('%s', (_title, value, want) => {
    expect(shortAddress(value)).toBe(want)
  })

  it('uses the one-character ellipsis, not three dots', () => {
    expect(shortAddress(RSP_AT_START)).toContain('\u2026')
    expect(shortAddress(RSP_AT_START)).not.toContain('...')
  })
})

describe('groupHex', () => {
  const cases: [bigint, number | undefined, string][] = [
    [RSP_AT_START, undefined, '0000 7fff fffd dff8'],
    [0n, undefined, '0000 0000 0000 0000'],
    [MAX_64, undefined, 'ffff ffff ffff ffff'],
    [0x1122_3344_5566_7788n, undefined, '1122 3344 5566 7788'],
    [0x40_1126n, undefined, '0000 0000 0040 1126'],
    // `digits` chooses the padding.
    [0x1234n, 8, '0000 1234'],
    [0xabn, 4, '00ab'],
    [0xabn, 2, 'ab'],
    [RSP_AT_START, 12, '7fff fffd dff8'],
    // The groups are cut from the right, so only the first group can be short.
    [0x12_3456n, 6, '12 3456'],
    [0x7n, 6, '00 0007'],
    [0x1_2345n, 4, '1 2345'],
    // A negative value is shown as its 64-bit two's complement.
    [-1n, undefined, 'ffff ffff ffff ffff'],
    [-0x10n, undefined, 'ffff ffff ffff fff0'],
  ]

  it.each(
    titled(
      cases,
      ([value, digits]) => `groupHex(${h(value)}${digits === undefined ? '' : `, ${digits}`})`,
    ),
  )('%s', (_title, value, digits, want) => {
    expect(groupHex(value, digits)).toBe(want)
  })

  it('has no 0x prefix and no upper-case letters', () => {
    for (const value of SAMPLES) {
      expect(groupHex(value), h(value)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/)
    }
  })

  it('can be typed back as an answer', () => {
    // What the page shows is what a student may type: both sides must agree.
    for (const value of SAMPLES) {
      const shown = groupHex(value)
      expect(parseHexAnswer(shown), h(value)).toBe(BigInt.asUintN(64, value))
      expect(countHexDigits(shown), h(value)).toBe(16)
    }
  })
})

describe('signedDecimal', () => {
  const cases: [bigint, OperandSize, string][] = [
    [0xffn, 8, '-1'],
    [0x7fn, 8, '127'],
    [0x80n, 8, '-128'],
    [0n, 8, '0'],
    [0xffffn, 16, '-1'],
    [0x7fffn, 16, '32767'],
    [0x8000n, 16, '-32768'],
    [0xffff_ffffn, 32, '-1'],
    [0x7fff_ffffn, 32, '2147483647'],
    [0x8000_0000n, 32, '-2147483648'],
    [MAX_64, 64, '-1'],
    [0x7fff_ffff_ffff_ffffn, 64, '9223372036854775807'],
    [0x8000_0000_0000_0000n, 64, '-9223372036854775808'],
    [0x2an, 64, '42'],
    // The same bits are a different number at a different width.
    [0xffn, 16, '255'],
    [0xffff_fff0n, 32, '-16'],
    [0xffff_fff0n, 64, '4294967280'],
    // Bits above the width are dropped.
    [0x1ffn, 8, '-1'],
    [0x100n, 8, '0'],
    // A negative input is read by its low bits.
    [-5n, 8, '-5'],
    [-129n, 8, '127'],
    [-1n, 64, '-1'],
  ]

  it.each(titled(cases, ([value, size]) => `signedDecimal(${h(value)}, ${size})`))(
    '%s',
    (_title, value, size, want) => {
      expect(signedDecimal(value, size)).toBe(want)
    },
  )
})

describe('parseHexAnswer', () => {
  const valid: [string, bigint][] = [
    // The example from the practice pages, in the forms a student may type.
    ['0x 0000 7FFF fffd dff8', RSP_AT_START],
    ['0x7ffffffddff8', RSP_AT_START],
    ['7ffffffddff8', RSP_AT_START],
    ['0X7FFFFFFDDFF8', RSP_AT_START],
    ['0x00007ffffffddff8', RSP_AT_START],
    ['0000 7fff fffd dff8', RSP_AT_START],
    ['0000_7fff_fffd_dff8', RSP_AT_START],
    ['0x0000_7fff_fffd_dff8', RSP_AT_START],
    ['0x_7fff_fffd_dff8', RSP_AT_START],
    ['  0x7ffffffddff8  ', RSP_AT_START],
    // Short answers.
    ['0x1f8', 0x1f8n],
    ['0x1F8', 0x1f8n],
    ['1f8', 0x1f8n],
    ['1 f 8', 0x1f8n],
    ['0', 0n],
    ['0x0', 0n],
    ['0000 0000 0000 0000', 0n],
    ['ff', 255n],
    ['FF', 255n],
    ['fF', 255n],
    ['0x00ff', 255n],
    ['abcdef', 0xabcdefn],
    ['ABCDEF', 0xabcdefn],
    // The text is always read as hex, never as decimal.
    ['10', 16n],
    ['0x10', 16n],
    // Other kinds of white space count as spaces.
    ['7fff\tfffd', 0x7fff_fffdn],
    ['7fff\u00a0fffd', 0x7fff_fffdn],
    ['0x1f8\n', 0x1f8n],
    // Too many digits: the value is NOT cut to 64 bits, so the answer stays wrong.
    ['1 0000 7fff fffd dff8', 0x1_0000_7fff_fffd_dff8n],
    // Two digits swapped (…fffd d… typed as …ffdd d…): a different number, not rsp.
    ['0x 0000 7FFF ffdd dff8', 0x7fff_ffdd_dff8n],
    // Looks like a binary number, but every character is a hex digit: it is read as hex.
    ['0b101', 0xb101n],
  ]

  it.each(titled(valid, ([text]) => `reads ${JSON.stringify(text)}`))(
    '%s',
    (_title, text, want) => {
      expect(parseHexAnswer(text)).toBe(want)
    },
  )

  const invalid: string[] = [
    // Nothing to read.
    '',
    '   ',
    '0x',
    '0X',
    '0x   ',
    '_',
    '0x_',
    // Not hex digits.
    'xyz',
    '0xg1',
    '12g',
    'hello',
    'rsp',
    // Signs are not part of a hex answer.
    '-0x10',
    '-5',
    '+5',
    // A broken or repeated prefix, or a prefix that is not at the start.
    'x10',
    '0x0x10',
    '0 x10',
    '10x5',
    'ff0x12',
    // Other ways to write numbers.
    '1f8h',
    '$1f8',
    '%rax',
    '0x1f8;',
    '1.5',
    '1,000',
    '0o17',
  ]

  it.each(invalid.map((text): [string, string] => [`rejects ${JSON.stringify(text)}`, text]))(
    '%s',
    (_title, text) => {
      expect(parseHexAnswer(text)).toBeNull()
    },
  )

  it('reads back every plain and every padded hex text', () => {
    for (const value of SAMPLES) {
      const unsigned = BigInt.asUintN(64, value)
      expect(parseHexAnswer(hex(value)), h(value)).toBe(unsigned)
      expect(parseHexAnswer(hex64(value)), h(value)).toBe(unsigned)
      expect(parseHexAnswer(hex64(value).toUpperCase()), h(value)).toBe(unsigned)
    }
  })
})

describe('countHexDigits', () => {
  const cases: [string, number | null][] = [
    // All 16 digits, written in different ways.
    ['0x00007ffffffddff8', 16],
    ['0x 0000 7FFF fffd dff8', 16],
    ['0000_7fff_fffd_dff8', 16],
    ['0000 0000 0000 0000', 16],
    // Not all 16: the leading zeros were left out.
    ['0x7ffffffddff8', 12],
    ['7fff fffd dff8', 12],
    // Leading zeros are digits too.
    ['0', 1],
    ['0x0', 1],
    ['00', 2],
    ['  ff ', 2],
    ['0x00ff', 4],
    // One digit too many.
    ['1 0000 7fff fffd dff8', 17],
    // Not hex at all.
    ['', null],
    ['   ', null],
    ['0x', null],
    ['xyz', null],
    ['0x12g4', null],
    ['-1', null],
  ]

  it.each(titled(cases, ([text]) => `counts ${JSON.stringify(text)}`))(
    '%s',
    (_title, text, want) => {
      expect(countHexDigits(text)).toBe(want)
    },
  )

  it('is null exactly when parseHexAnswer is null', () => {
    const texts = [
      '',
      ' ',
      '0x',
      '0',
      'ff',
      '0xFF',
      'g',
      '0x 12 34',
      '12_34',
      '1 2 3 x',
      '-1',
      '0x0x1',
    ]
    for (const text of texts) {
      expect(countHexDigits(text) === null, JSON.stringify(text)).toBe(
        parseHexAnswer(text) === null,
      )
    }
  })
})

describe('the helpers every message shares (one copy each)', () => {
  it('hexDigits pads, and treats a negative value as 64-bit', () => {
    expect(hexDigits(255n)).toBe('ff')
    expect(hexDigits(255n, 4)).toBe('00ff')
    expect(hexDigits(-1n)).toBe('ffffffffffffffff')
  })

  it('signedHex keeps a negative value negative (a message shows it as it is)', () => {
    expect(signedHex(0n)).toBe('0x0')
    expect(signedHex(0x402010n)).toBe('0x402010')
    expect(signedHex(-8n)).toBe('-0x8')
    expect(signedHex(1n << 64n)).toBe('0x10000000000000000')
  })

  it('groupDigits puts commas between groups of three digits', () => {
    expect(groupDigits(0)).toBe('0')
    expect(groupDigits(999)).toBe('999')
    expect(groupDigits(1000)).toBe('1,000')
    expect(groupDigits(65_536)).toBe('65,536')
    expect(groupDigits(1_048_576)).toBe('1,048,576')
    expect(groupDigits(10_000n)).toBe('10,000')
    expect(groupDigits(-1234)).toBe('-1,234')
  })

  it('joinAnd and joinOr join a list the plain English way', () => {
    expect(joinAnd([])).toBe('')
    expect(joinAnd(['a'])).toBe('a')
    expect(joinAnd(['a', 'b'])).toBe('a and b')
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c')
    expect(joinOr(['a', 'b', 'c'])).toBe('a, b or c')
  })
})
