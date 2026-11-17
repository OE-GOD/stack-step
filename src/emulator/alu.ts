/**
 * The arithmetic and logic unit: what `add`, `sub`, `inc`, `dec`, `imul`, `and`, `or`
 * and `xor` (and `cmp`, `test`) compute, which flags they leave behind, and how each
 * conditional jump reads those flags.
 *
 * The four flags
 *   CF  carry:    the answer did not fit when the numbers are read as unsigned
 *   ZF  zero:     the answer is 0
 *   SF  sign:     the top bit of the answer is 1 (negative when read as signed)
 *   OF  overflow: the answer did not fit when the numbers are read as signed
 *
 * Every function accepts any bigint (so a negative immediate works), keeps only the low
 * `size` bits of each input, and returns an unsigned result of `size` bits.
 */
import { MASK, signBit, toSigned, truncate } from './bits'
import type { Bit, Flags, Mnemonic, OperandSize } from './types'

export interface AluResult {
  /** Unsigned result, truncated to `size` bits. */
  result: bigint
  /** All four flags after the operation. */
  flags: Flags
}

function bit(on: boolean): Bit {
  return on ? 1 : 0
}

/** ZF and SF always come from the result. CF and OF depend on the operation. */
function flagsFor(result: bigint, size: OperandSize, carry: boolean, overflow: boolean): Flags {
  return {
    CF: bit(carry),
    ZF: bit(result === 0n),
    SF: signBit(result, size),
    OF: bit(overflow),
  }
}

/** a + b. CF = carry out of the top bit. OF = signed overflow. ZF, SF from the result. */
export function add(a: bigint, b: bigint, size: OperandSize): AluResult {
  const x = truncate(a, size)
  const y = truncate(b, size)
  const result = truncate(x + y, size)
  // CF: the true unsigned sum is too big. OF: the true signed sum is not what we kept.
  const carry = x + y > MASK[size]
  const overflow = toSigned(x, size) + toSigned(y, size) !== toSigned(result, size)
  return { result, flags: flagsFor(result, size, carry, overflow) }
}

/** a - b (also `cmp`). CF = borrow (a < b as unsigned). OF = signed overflow. */
export function sub(a: bigint, b: bigint, size: OperandSize): AluResult {
  const x = truncate(a, size)
  const y = truncate(b, size)
  const result = truncate(x - y, size)
  const borrow = x < y
  const overflow = toSigned(x, size) - toSigned(y, size) !== toSigned(result, size)
  return { result, flags: flagsFor(result, size, borrow, overflow) }
}

/** a + 1. Like add, but CF keeps the value it had in `before`. */
export function inc(a: bigint, size: OperandSize, before: Flags): AluResult {
  const { result, flags } = add(a, 1n, size)
  return { result, flags: { ...flags, CF: before.CF } }
}

/** a - 1. Like sub, but CF keeps the value it had in `before`. */
export function dec(a: bigint, size: OperandSize, before: Flags): AluResult {
  const { result, flags } = sub(a, 1n, size)
  return { result, flags: { ...flags, CF: before.CF } }
}

/**
 * Signed multiply, result truncated to `size` (16, 32 or 64) bits.
 * CF = OF = 1 when the full signed product does not fit in `size` bits, else 0.
 * SF = top bit of the truncated result. ZF = 1 when the truncated result is 0.
 *
 * SF and ZF are our documented choice: they describe the result the student sees.
 * Intel's manual lists both as undefined after `imul`, so real machines may differ.
 * Apple's Rosetta 2 (measured on macOS 26) clears both after every `imul`, so a test
 * against that machine can compare only the result, CF and OF.
 *
 * A `size` of 8 follows the same rules, although x86 has no 2-operand 8-bit `imul`.
 */
export function imul(a: bigint, b: bigint, size: OperandSize): AluResult {
  const x = truncate(a, size)
  const y = truncate(b, size)
  const product = toSigned(x, size) * toSigned(y, size)
  const result = truncate(product, size)
  const overflow = toSigned(result, size) !== product
  return { result, flags: flagsFor(result, size, overflow, overflow) }
}

/** Bitwise and / or / xor (and `test`, which is `and` without storing). CF = OF = 0. */
export function logic(
  op: 'and' | 'or' | 'xor',
  a: bigint,
  b: bigint,
  size: OperandSize,
): AluResult {
  const x = truncate(a, size)
  const y = truncate(b, size)
  const result = combine(op, x, y)
  return { result, flags: flagsFor(result, size, false, false) }
}

function combine(op: 'and' | 'or' | 'xor', x: bigint, y: bigint): bigint {
  switch (op) {
    case 'and':
      return x & y
    case 'or':
      return x | y
    case 'xor':
      return x ^ y
  }
}

/** The conditional jumps (canonical spellings). */
export type JumpCondition = Extract<
  Mnemonic,
  | 'je'
  | 'jne'
  | 'jg'
  | 'jge'
  | 'jl'
  | 'jle'
  | 'ja'
  | 'jae'
  | 'jb'
  | 'jbe'
  | 'js'
  | 'jns'
  | 'jo'
  | 'jno'
>

interface ConditionInfo {
  /** The flag rule in the words shown to students, e.g. 'SF ≠ OF'. */
  rule: string
  /** What the rule means after `cmp a, b` (or after any result), e.g. 'less than (signed)'. */
  meaning: string
  holds: (flags: Flags) => boolean
}

/**
 * One row per conditional jump: the rule in words, what it means, and the rule as code.
 * Keeping the three side by side stops the words from drifting away from the behavior.
 * (`alu.test.ts` also checks that each `rule` text agrees with its `holds` function.)
 */
const CONDITIONS: Readonly<Record<JumpCondition, ConditionInfo>> = {
  je: {
    rule: 'ZF = 1',
    meaning: 'equal (or zero)',
    holds: (f) => f.ZF === 1,
  },
  jne: {
    rule: 'ZF = 0',
    meaning: 'not equal (or not zero)',
    holds: (f) => f.ZF === 0,
  },
  jg: {
    rule: 'ZF = 0 and SF = OF',
    meaning: 'greater than (signed)',
    holds: (f) => f.ZF === 0 && f.SF === f.OF,
  },
  jge: {
    rule: 'SF = OF',
    meaning: 'greater than or equal (signed)',
    holds: (f) => f.SF === f.OF,
  },
  jl: {
    rule: 'SF ≠ OF',
    meaning: 'less than (signed)',
    holds: (f) => f.SF !== f.OF,
  },
  jle: {
    rule: 'ZF = 1 or SF ≠ OF',
    meaning: 'less than or equal (signed)',
    holds: (f) => f.ZF === 1 || f.SF !== f.OF,
  },
  ja: {
    rule: 'CF = 0 and ZF = 0',
    meaning: 'greater than (unsigned)',
    holds: (f) => f.CF === 0 && f.ZF === 0,
  },
  jae: {
    rule: 'CF = 0',
    meaning: 'greater than or equal (unsigned)',
    holds: (f) => f.CF === 0,
  },
  jb: {
    rule: 'CF = 1',
    meaning: 'less than (unsigned)',
    holds: (f) => f.CF === 1,
  },
  jbe: {
    rule: 'CF = 1 or ZF = 1',
    meaning: 'less than or equal (unsigned)',
    holds: (f) => f.CF === 1 || f.ZF === 1,
  },
  js: {
    rule: 'SF = 1',
    meaning: 'negative',
    holds: (f) => f.SF === 1,
  },
  jns: {
    rule: 'SF = 0',
    meaning: 'not negative',
    holds: (f) => f.SF === 0,
  },
  jo: {
    rule: 'OF = 1',
    meaning: 'signed overflow',
    holds: (f) => f.OF === 1,
  },
  jno: {
    rule: 'OF = 0',
    meaning: 'no signed overflow',
    holds: (f) => f.OF === 0,
  },
}

export const JUMP_CONDITIONS: readonly JumpCondition[] = [
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

export function isJumpCondition(m: string): m is JumpCondition {
  return Object.hasOwn(CONDITIONS, m)
}

/** Does this conditional jump jump, given the flags? */
export function conditionHolds(condition: JumpCondition, flags: Flags): boolean {
  return CONDITIONS[condition].holds(flags)
}

/**
 * Words for explanations and the cheat sheet. Example for 'jl':
 * { rule: 'SF ≠ OF', meaning: 'less than (signed)' }
 */
export function describeCondition(condition: JumpCondition): { rule: string; meaning: string } {
  const { rule, meaning } = CONDITIONS[condition]
  return { rule, meaning }
}
