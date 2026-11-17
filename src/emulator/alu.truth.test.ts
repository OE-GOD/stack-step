/**
 * Ground truth from a real x86-64 CPU.
 *
 * `scripts/make-truth-fixture.mjs` ran thousands of single instructions as real x86-64
 * code and wrote down what the CPU did in `__fixtures__/alu-truth.json`. This file
 * replays every vector through the emulator: the arithmetic and the jump conditions in
 * `alu.ts`, the register table and the write rules in `registers.ts`, and the sign
 * helpers in `bits.ts`. The tests only read the JSON file, so they need no compiler.
 *
 * One thing is NOT compared: SF and ZF after `imul`. Intel's manual says both are
 * undefined after `imul`, and machines differ: Rosetta 2 on an Apple Silicon Mac clears
 * both whatever the result is. (The notes at the top of the fixture say what the machine
 * that made it did.) The emulator sets them from the result on purpose (PLAN.md, section
 * 3.3), and `alu.test.ts` checks that rule. So for `imul` only the result, CF and OF are
 * pinned here.
 *
 * When the fixture is missing, this file holds one skipped test that says how to make it.
 */
import { describe, expect, it } from 'vitest'
import {
  add,
  conditionHolds,
  dec,
  imul,
  inc,
  isJumpCondition,
  JUMP_CONDITIONS,
  logic,
  sub,
  type AluResult,
  type JumpCondition,
} from './alu'
import { signExtend, truncate } from './bits'
import {
  ALL_REGISTER_NAMES,
  createRegisterFile,
  lookupRegister,
  mergeRegisterWrite,
  readRegister,
} from './registers'
import { FLAG_NAMES, type Bit, type FlagName, type Flags, type OperandSize } from './types'

/* ───────────────────────── Reading the fixture ───────────────────────── */

/** An empty object when the file does not exist (a plain `import` would fail). */
const found = import.meta.glob<unknown>('./__fixtures__/alu-truth.json', {
  eager: true,
  import: 'default',
})
const rawFixture: unknown = Object.values(found)[0]

const HOW_TO_MAKE_IT =
  'run `node scripts/make-truth-fixture.mjs` on a Mac with Rosetta 2 (or on any x86-64 ' +
  'machine with clang) to make src/emulator/__fixtures__/alu-truth.json'

const SIZES: readonly OperandSize[] = [8, 16, 32, 64]

const ARITHMETIC_OPS = [
  ...(['add', 'sub', 'and', 'or', 'xor'] as const),
  ...(['imul', 'inc', 'dec', 'cmp', 'test'] as const),
]
type ArithmeticOp = (typeof ARITHMETIC_OPS)[number]

const MOVE_OPS = ['mov', 'movzx', 'movsx', 'movsxd'] as const
type MoveOp = (typeof MOVE_OPS)[number]

/** `add al, cl` and friends: `a` and `b` are `size` bits wide. */
interface ArithmeticVector {
  kind: 'arithmetic'
  op: ArithmeticOp
  size: OperandSize
  a: bigint
  /** null for `inc` and `dec`. */
  b: bigint | null
  /** True when `b` was a number written in the instruction, as in `add eax, -1`. */
  immediate: boolean
  /** CF before the instruction. */
  cfIn: Bit
  /** The low `size` bits of the destination register afterwards. */
  result: bigint
  /** The flags afterwards. */
  flags: Flags
  /** Some vectors also record the whole 64-bit register `reg` that holds `dest`. */
  whole: { dest: string; reg: string; before: bigint; after: bigint } | null
  /** The vector as written in the file, for failure messages. */
  source: string
}

/** `mov ah, dl`, `movsx eax, cl`, `mov eax, -1`: a write into a register name. */
interface MoveVector {
  kind: 'move'
  op: MoveOp
  dest: string
  /** The 64-bit register that holds `dest`, and its value before and after. */
  destReg: string
  destBefore: bigint
  destAfter: bigint
  /** What was written: a register name (with its whole 64-bit register), or a number. */
  from: { src: string; srcReg: string; srcBefore: bigint } | { imm: bigint }
  source: string
}

/** `jl` with the four flags set one way: did it jump? */
interface JumpVector {
  kind: 'jump'
  op: JumpCondition
  flags: Flags
  taken: boolean
  source: string
}

type Vector = ArithmeticVector | MoveVector | JumpVector

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && list.some((item) => item === value)
}

function textField(raw: Raw, key: string): string {
  const value = raw[key]
  if (typeof value !== 'string') throw new Error(`"${key}" should be text`)
  return value
}

function hexField(raw: Raw, key: string): bigint {
  const value = raw[key]
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/.test(value)) {
    throw new Error(`"${key}" should be a hex string such as "0x7f"`)
  }
  return BigInt(value)
}

function bitField(raw: Raw, key: string): Bit {
  const value = raw[key]
  if (value !== 0 && value !== 1) throw new Error(`"${key}" should be 0 or 1`)
  return value
}

function sizeField(raw: Raw): OperandSize {
  const value = raw.size
  if (value !== 8 && value !== 16 && value !== 32 && value !== 64) {
    throw new Error('"size" should be 8, 16, 32 or 64')
  }
  return value
}

/** A number as written in an instruction: `5`, `-1`, `0x80000000`, `-0x80000000`. */
function immediateField(raw: Raw): bigint {
  const text = textField(raw, 'imm')
  if (!/^-?(0x[0-9a-f]+|[0-9]+)$/.test(text)) throw new Error('"imm" should be a number')
  return text.startsWith('-') ? -BigInt(text.slice(1)) : BigInt(text)
}

function decodeVector(raw: unknown): Vector {
  if (!isRecord(raw)) throw new Error('a vector should be an object')
  const source = JSON.stringify(raw)
  const op = raw.op

  if (isOneOf(ARITHMETIC_OPS, op)) {
    const unary = op === 'inc' || op === 'dec'
    const immediate = !unary && 'imm' in raw
    return {
      kind: 'arithmetic',
      op,
      size: sizeField(raw),
      a: hexField(raw, 'a'),
      b: unary ? null : immediate ? immediateField(raw) : hexField(raw, 'b'),
      immediate,
      cfIn: bitField(raw, 'cfIn'),
      result: hexField(raw, 'result'),
      flags: {
        CF: bitField(raw, 'cf'),
        ZF: bitField(raw, 'zf'),
        SF: bitField(raw, 'sf'),
        OF: bitField(raw, 'of'),
      },
      whole:
        'dest' in raw
          ? {
              dest: textField(raw, 'dest'),
              reg: textField(raw, 'destReg'),
              before: hexField(raw, 'destBefore'),
              after: hexField(raw, 'destAfter'),
            }
          : null,
      source,
    }
  }

  if (isOneOf(MOVE_OPS, op)) {
    return {
      kind: 'move',
      op,
      dest: textField(raw, 'dest'),
      destReg: textField(raw, 'destReg'),
      destBefore: hexField(raw, 'destBefore'),
      destAfter: hexField(raw, 'destAfter'),
      from:
        'imm' in raw
          ? { imm: immediateField(raw) }
          : {
              src: textField(raw, 'src'),
              srcReg: textField(raw, 'srcReg'),
              srcBefore: hexField(raw, 'srcBefore'),
            },
      source,
    }
  }

  if (typeof op === 'string' && isJumpCondition(op)) {
    return {
      kind: 'jump',
      op,
      flags: {
        CF: bitField(raw, 'cfIn'),
        ZF: bitField(raw, 'zfIn'),
        SF: bitField(raw, 'sfIn'),
        OF: bitField(raw, 'ofIn'),
      },
      taken: bitField(raw, 'taken') === 1,
      source,
    }
  }

  throw new Error(`unknown "op" ${JSON.stringify(op)}`)
}

interface Fixture {
  generatedBy: string
  host: string
  /** How many entries the file's `vectors` list has. */
  listed: number
  vectors: Vector[]
  /** Entries this test could not read, one sentence each. */
  unreadable: string[]
}

function decodeFixture(raw: unknown): Fixture {
  if (!isRecord(raw) || !Array.isArray(raw.vectors)) {
    throw new Error(`alu-truth.json has no "vectors" list. To make it again, ${HOW_TO_MAKE_IT}.`)
  }
  const list: unknown[] = raw.vectors
  const vectors: Vector[] = []
  const unreadable: string[] = []
  list.forEach((entry, index) => {
    try {
      vectors.push(decodeVector(entry))
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'not readable'
      unreadable.push(`vector ${index}: ${reason}: ${JSON.stringify(entry)}`)
    }
  })
  return {
    generatedBy: typeof raw.generatedBy === 'string' ? raw.generatedBy : '',
    host: typeof raw.host === 'string' ? raw.host : '',
    listed: list.length,
    vectors,
    unreadable,
  }
}

/* ─────────────────────────────── Helpers ─────────────────────────────── */

function hex(value: bigint): string {
  return `0x${value.toString(16)}`
}

function showFlags(flags: Flags, names: readonly FlagName[] = FLAG_NAMES): string {
  return names.map((name) => `${name}=${flags[name]}`).join(' ')
}

/** Fail with the first few problems (a full list of thousands would hide the cause). */
function expectNoProblems(problems: string[]): void {
  const shown = problems.slice(0, 10)
  if (problems.length > shown.length) shown.push(`… and ${problems.length - shown.length} more`)
  expect(shown).toEqual([])
}

/**
 * The interesting values of one width, worked out with plain maths (not with the
 * emulator's helpers): 0, 1, 2, the largest unsigned value and the one below it, the
 * largest signed value, the smallest signed value and the one above it, 0x55…, 0xAA….
 */
function interestingValues(size: OperandSize): bigint[] {
  const modulus = 2n ** BigInt(size)
  const half = modulus / 2n
  return [
    0n,
    1n,
    2n,
    modulus - 1n,
    modulus - 2n,
    half - 1n,
    half,
    half + 1n,
    0x5555_5555_5555_5555n % modulus,
    0xaaaa_aaaa_aaaa_aaaan % modulus,
  ]
}

/** `value` as a number from 0 to 2^size - 1 (plain maths, not the emulator's helper). */
function inRange(value: bigint, size: OperandSize): bigint {
  const modulus = 2n ** BigInt(size)
  return ((value % modulus) + modulus) % modulus
}

/**
 * Other ways to hand the same `size`-bit operand to the emulator:
 * as a negative number (the way `add eax, -1` writes 0xffffffff), and with more bits
 * above it (on the CPU the rest of the register held random bits). The emulator must
 * give the CPU's answer for each of them.
 */
function spellings(value: bigint, size: OperandSize): bigint[] {
  const modulus = 2n ** BigInt(size)
  const negative = value - modulus
  return size === 64 ? [value, negative] : [value, negative, value + modulus * 0xabcdn]
}

/* ─────────────────────── Replaying through the emulator ─────────────────────── */

/** `cmp` and `test` set flags and store nothing. */
function storesNothing(op: ArithmeticOp): boolean {
  return op === 'cmp' || op === 'test'
}

/** SF and ZF after `imul` are undefined on real CPUs, so they are not compared. */
function comparedFlags(op: ArithmeticOp): readonly FlagName[] {
  return op === 'imul' ? ['CF', 'OF'] : FLAG_NAMES
}

/** What the emulator computes for one arithmetic instruction. */
function emulate(
  op: ArithmeticOp,
  a: bigint,
  b: bigint,
  size: OperandSize,
  before: Flags,
): AluResult {
  switch (op) {
    case 'add':
      return add(a, b, size)
    case 'sub':
    case 'cmp':
      return sub(a, b, size)
    case 'and':
    case 'or':
    case 'xor':
      return logic(op, a, b, size)
    case 'test':
      return logic('and', a, b, size)
    case 'imul':
      return imul(a, b, size)
    case 'inc':
      return inc(a, size, before)
    case 'dec':
      return dec(a, size, before)
  }
}

/** Where the emulator and the CPU disagree on one arithmetic vector (empty = they agree). */
function arithmeticProblems(vector: ArithmeticVector): string[] {
  const { op, size } = vector
  const problems = new Set<string>()
  const flagNames = comparedFlags(op)
  // The same two operands, handed to the emulator in each of the other ways.
  const written = vector.b ?? 0n
  const seconds = spellings(inRange(written, size), size)
  const operands = spellings(vector.a, size).map((first, i) => [first, seconds[i]])
  if (vector.immediate) operands.push([vector.a, written]) // exactly as in the instruction
  for (const [a, b] of operands) {
    // Only CF before may matter (for inc and dec). Try the other three flags both ways.
    for (const others of [0, 1] as const) {
      const before: Flags = { CF: vector.cfIn, ZF: others, SF: others, OF: others }
      const ours = emulate(op, a, b, size, before)
      const stored = storesNothing(op) ? vector.a : ours.result
      const flagsAgree = flagNames.every((name) => ours.flags[name] === vector.flags[name])
      if (stored !== vector.result || !flagsAgree) {
        const flags = showFlags(ours.flags, flagNames)
        problems.add(`${vector.source} → the emulator gives ${hex(stored)} ${flags}`)
      }
    }
  }
  return [...problems]
}

/** The same for the vectors that record the whole 64-bit register. */
function wholeRegisterProblems(vector: ArithmeticVector): string[] {
  if (vector.whole === null) return []
  const { dest: name, reg, before, after } = vector.whole
  const dest = lookupRegister(name)
  if (!dest) return [`${vector.source} → the emulator does not know ${name}`]
  if (dest.base !== reg) return [`${vector.source} → the emulator puts ${name} in ${dest.base}`]
  const file = createRegisterFile()
  file[dest.base] = before
  if (dest.size !== vector.size || readRegister(file, dest) !== vector.a) {
    return [`${vector.source} → "a" is not the ${name} part of "destBefore"`]
  }
  const flags: Flags = { CF: vector.cfIn, ZF: 0, SF: 0, OF: 0 }
  const ours = emulate(vector.op, vector.a, vector.b ?? 0n, vector.size, flags)
  const left = storesNothing(vector.op) ? before : mergeRegisterWrite(before, dest, ours.result)
  return left === after ? [] : [`${vector.source} → the emulator leaves ${hex(left)} in ${reg}`]
}

/** Where the emulator and the CPU disagree on one register write. */
function moveProblems(vector: MoveVector): string[] {
  const complain = (text: string) => [`${vector.source} → ${text}`]
  const dest = lookupRegister(vector.dest)
  if (!dest) return complain(`the emulator does not know ${vector.dest}`)
  if (dest.base !== vector.destReg) {
    return complain(`the emulator puts ${dest.name} in ${dest.base}`)
  }

  let value: bigint
  if ('imm' in vector.from) {
    if (vector.op !== 'mov') return complain('only mov takes a number')
    value = vector.from.imm
  } else {
    const src = lookupRegister(vector.from.src)
    if (!src) return complain(`the emulator does not know ${vector.from.src}`)
    if (src.base !== vector.from.srcReg) {
      return complain(`the emulator puts ${src.name} in ${src.base}`)
    }
    if (src.base === dest.base && vector.from.srcBefore !== vector.destBefore) {
      return complain(`${src.name} and ${dest.name} are one register with two values`)
    }
    const sizesFit =
      vector.op === 'mov'
        ? src.size === dest.size
        : vector.op === 'movsxd'
          ? src.size === 32 && dest.size === 64
          : (src.size === 8 || src.size === 16) && src.size < dest.size
    if (!sizesFit) return complain(`${vector.op} does not take these sizes`)

    const file = createRegisterFile()
    file[src.base] = vector.from.srcBefore
    const part = readRegister(file, src)
    if (vector.op === 'mov') value = part
    else if (vector.op === 'movzx') value = truncate(part, src.size)
    else value = signExtend(part, src.size)
  }

  const left = mergeRegisterWrite(vector.destBefore, dest, value)
  return left === vector.destAfter
    ? []
    : complain(`the emulator leaves ${hex(left)} in ${vector.destReg}`)
}

function jumpProblems(vector: JumpVector): string[] {
  const jumps = conditionHolds(vector.op, vector.flags)
  return jumps === vector.taken
    ? []
    : [`${vector.source} → the emulator says ${jumps ? 'it jumps' : 'it does not jump'}`]
}

/* ──────────────────────────────── Tests ──────────────────────────────── */

if (rawFixture === undefined) {
  describe('ground truth from a real x86-64 CPU', () => {
    it.skip(`has no fixture: ${HOW_TO_MAKE_IT}`, () => {
      // Nothing to replay.
    })
  })
} else {
  const fixture = decodeFixture(rawFixture)
  const arithmetic = fixture.vectors.filter((vector) => vector.kind === 'arithmetic')
  const moves = fixture.vectors.filter((vector) => vector.kind === 'move')
  const jumps = fixture.vectors.filter((vector) => vector.kind === 'jump')

  const arithmeticOf = (op: ArithmeticOp, size: OperandSize) =>
    arithmetic.filter((vector) => vector.op === op && vector.size === size)

  /** One test per instruction and width. `imul` has no 8-bit form with two operands. */
  const arithmeticGroups = ARITHMETIC_OPS.flatMap((op) =>
    SIZES.filter((size) => !(op === 'imul' && size === 8)).map((size) => {
      const vectors = arithmeticOf(op, size)
      return { title: `${op}, ${size} bits (${vectors.length} vectors)`, op, size, vectors }
    }),
  )
  const moveGroups = MOVE_OPS.map((op) => {
    const vectors = moves.filter((vector) => vector.op === op)
    return { title: `${op} (${vectors.length} vectors)`, op, vectors }
  })
  const jumpGroups = JUMP_CONDITIONS.map((op) => {
    const vectors = jumps.filter((vector) => vector.op === op)
    return { title: `${op} (${vectors.length} vectors)`, op, vectors }
  })

  describe('the fixture from a real x86-64 CPU', () => {
    it('was made by the script, by running x86-64 code', () => {
      expect(fixture.generatedBy).toContain('scripts/make-truth-fixture.mjs')
      expect(fixture.host).toMatch(/x86-64/)
    })

    it('holds only vectors this test can read, and every one is replayed below', () => {
      expectNoProblems(fixture.unreadable)
      expect(fixture.vectors).toHaveLength(fixture.listed)
      const replayed = [...arithmeticGroups, ...moveGroups, ...jumpGroups]
        .map((group) => group.vectors.length)
        .reduce((sum, count) => sum + count, 0)
      expect(replayed).toBe(fixture.listed)
    })

    it('has every pair of interesting values for add, sub, and, or, xor and imul', () => {
      const missing: string[] = []
      for (const { op, size, vectors } of arithmeticGroups) {
        if (!['add', 'sub', 'and', 'or', 'xor', 'imul'].includes(op)) continue
        const present = new Set(vectors.map((vector) => `${vector.a} ${vector.b ?? ''}`))
        for (const a of interestingValues(size)) {
          for (const b of interestingValues(size)) {
            if (!present.has(`${a} ${b}`)) missing.push(`${op} ${size}: ${hex(a)}, ${hex(b)}`)
          }
        }
      }
      expectNoProblems(missing)
    })

    it('has at least 40 more pairs (the random ones) for each of them, at every size', () => {
      for (const { op, size, vectors } of arithmeticGroups) {
        if (!['add', 'sub', 'and', 'or', 'xor', 'imul'].includes(op)) continue
        const interesting = new Set(interestingValues(size))
        const others = vectors.filter(
          ({ a, b, immediate }) =>
            !immediate && b !== null && !(interesting.has(a) && interesting.has(b)),
        )
        expect(others.length, `${op} ${size}`).toBeGreaterThanOrEqual(40)
      }
    })

    it('has inc and dec of every interesting value, with CF = 0 and CF = 1 before', () => {
      const missing: string[] = []
      for (const op of ['inc', 'dec'] as const) {
        for (const size of SIZES) {
          const present = new Set(arithmeticOf(op, size).map((v) => `${v.a} ${v.cfIn}`))
          for (const a of interestingValues(size)) {
            for (const cfIn of [0, 1]) {
              if (!present.has(`${a} ${cfIn}`)) missing.push(`${op} ${size}: ${hex(a)}, CF=${cfIn}`)
            }
          }
        }
      }
      expectNoProblems(missing)
    })

    it('has cmp and test at every size', () => {
      for (const op of ['cmp', 'test'] as const) {
        for (const size of SIZES) {
          expect(arithmeticOf(op, size).length, `${op} ${size}`).toBeGreaterThanOrEqual(10)
        }
      }
    })

    it('has no 8-bit imul', () => {
      expect(arithmeticOf('imul', 8)).toEqual([])
    })

    it('has arithmetic with the number written in the instruction, negative ones too', () => {
      const written = arithmetic.filter((vector) => vector.immediate)
      const ops = new Set(written.map((vector) => vector.op))
      const wanted = ['add', 'sub', 'and', 'or', 'xor', 'imul', 'cmp', 'test'] as const
      expect(wanted.filter((op) => !ops.has(op))).toEqual([])
      const negative = new Set(written.filter((v) => (v.b ?? 0n) < 0n).map((v) => v.op))
      expect(wanted.filter((op) => !negative.has(op))).toEqual([])
    })

    it('shows that cmp and test left the destination as it was', () => {
      const compares = arithmetic.filter((vector) => storesNothing(vector.op))
      expectNoProblems(
        compares.filter((vector) => vector.result !== vector.a).map((vector) => vector.source),
      )
    })

    it('shows that inc and dec left CF as it was', () => {
      const steps = arithmetic.filter((vector) => vector.op === 'inc' || vector.op === 'dec')
      expectNoProblems(
        steps.filter((vector) => vector.flags.CF !== vector.cfIn).map((vector) => vector.source),
      )
    })

    it('writes every one of the 68 register names with mov', () => {
      const written = new Set(moves.filter((vector) => vector.op === 'mov').map((v) => v.dest))
      expect(ALL_REGISTER_NAMES.filter((name) => !written.has(name))).toEqual([])
    })

    it('reads ah, bh, ch and dh, and moves negative numbers', () => {
      const sources = new Set(moves.map((v) => ('src' in v.from ? v.from.src : '')))
      expect(['ah', 'bh', 'ch', 'dh'].filter((name) => !sources.has(name))).toEqual([])
      const negative = moves.filter((v) => 'imm' in v.from && v.from.imm < 0n)
      expect(negative.length).toBeGreaterThanOrEqual(4)
    })

    it('extends from 8 and 16 bits into 16, 32 and 64 bits, and from 32 into 64', () => {
      const shapes = new Set<string>()
      for (const vector of moves) {
        if (vector.op === 'mov' || !('src' in vector.from)) continue
        const from = lookupRegister(vector.from.src)?.size ?? 0
        const to = lookupRegister(vector.dest)?.size ?? 0
        shapes.add(`${vector.op} ${from}→${to}`)
      }
      const wanted = [
        ...['movzx 8→16', 'movzx 8→32', 'movzx 8→64', 'movzx 16→32', 'movzx 16→64'],
        ...['movsx 8→16', 'movsx 8→32', 'movsx 8→64', 'movsx 16→32', 'movsx 16→64'],
        'movsxd 32→64',
      ]
      expect(wanted.filter((shape) => !shapes.has(shape))).toEqual([])
    })

    it('has every conditional jump with all 16 settings of the four flags', () => {
      for (const { op, vectors } of jumpGroups) {
        const settings = new Set(vectors.map((vector) => showFlags(vector.flags)))
        expect(settings.size, op).toBe(16)
        expect(vectors, op).toHaveLength(16)
      }
    })
  })

  describe('arithmetic: the emulator gives the result and the flags the CPU gave', () => {
    it.each(arithmeticGroups)('$title', ({ vectors }) => {
      expect(vectors.length).toBeGreaterThan(0)
      expectNoProblems(vectors.flatMap(arithmeticProblems))
    })

    it('an arithmetic result is written into the register by the same rule as mov', () => {
      const whole = arithmetic.filter((vector) => vector.whole !== null)
      // Every instruction at 8, 16 and 32 bits (imul only at 16 and 32).
      const covered = new Set(whole.map((vector) => `${vector.op} ${vector.size}`))
      const wanted = arithmeticGroups
        .filter((group) => group.size !== 64)
        .map((group) => `${group.op} ${group.size}`)
      expect(wanted.filter((name) => !covered.has(name))).toEqual([])
      expectNoProblems(whole.flatMap(wholeRegisterProblems))
    })
  })

  describe('registers: the emulator leaves the 64-bit value the CPU left', () => {
    it('every register name is a part of the 64-bit register where the CPU has it', () => {
      const wrong: string[] = []
      for (const name of ALL_REGISTER_NAMES) {
        const write = moves.find((vector) => vector.op === 'mov' && vector.dest === name)
        const base = lookupRegister(name)?.base
        if (write?.destReg !== base) {
          wrong.push(`${name}: the CPU changed ${write?.destReg ?? '?'}, the emulator ${base}`)
        }
      }
      expect(wrong).toEqual([])
    })

    it.each(moveGroups)('$title', ({ vectors }) => {
      expect(vectors.length).toBeGreaterThan(0)
      expectNoProblems(vectors.flatMap(moveProblems))
    })
  })

  describe('conditional jumps: the emulator jumps exactly when the CPU jumped', () => {
    it.each(jumpGroups)('$title', ({ vectors }) => {
      expect(vectors.length).toBeGreaterThan(0)
      expectNoProblems(vectors.flatMap(jumpProblems))
    })
  })
}
