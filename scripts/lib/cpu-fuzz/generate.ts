/**
 * The fuzz program generator.
 *
 * `generateProgram(seed, index)` builds one straight-line program that is safe to run
 * blind on a real CPU and that the emulator must be able to assemble:
 *
 *   1. load a 64-bit value into every free register (about a third are edge values);
 *   2. `lea r15, scratch[rip]` and `cmp rsp, rsp` (known flags);
 *   3. 15–45 random instructions;
 *   4. pop whatever is still on the stack.
 *
 * Safety rules the generator keeps (the reference model re-checks most of them):
 *   - rsp and r15 are never written, and never read into another register;
 *   - memory operands are only `[r15+K]`, K from 0 to 248, inside the 256-byte scratch area;
 *   - `lea` uses only free registers, so its result does not depend on addresses;
 *   - push and pop are balanced, also inside every block a jump can skip;
 *   - jumps go forward over 1–3 instructions, and never nest;
 *   - after `imul`, the next flag reader may only look at CF or OF, and a `cmp`/`test`
 *     of two registers follows before anything else can see the flags (SF and ZF after
 *     `imul` are not reliable on real machines: Rosetta 2 always leaves both at 0);
 *   - ah, bh, ch, dh never meet a register or memory operand that needs a REX prefix;
 *   - every immediate obeys the range rules of the assembler contract.
 *
 * Two things make the programs better at finding mistakes (see `flagSetup`):
 *   - most conditional jumps are placed right after an instruction that sets the flags,
 *     often to a state chosen in advance (signed overflow, equal, below, …), so that
 *     each of the 14 conditions is seen with flags that tell it apart from the others;
 *   - memory operands prefer a few "hot" offsets, so reads often meet earlier writes of
 *     another width.
 */
import {
  CONDITIONS,
  FREE_REGISTERS,
  REGISTER_NAMES,
  programId,
  registerNamed,
  type BinaryOp,
  type Condition,
  type FreeRegister,
  type FuzzProgram,
  type ImmOperand,
  type Line,
  type MemOperand,
  type RegName,
  type Size,
  type Step,
} from './program'
import { createRng, type Rng } from './rng'

const MASK64 = 0xffff_ffff_ffff_ffffn

const POINTER_WORD: Readonly<Record<Size, string>> = {
  8: 'byte',
  16: 'word',
  32: 'dword',
  64: 'qword',
}

/** The edge values of every width: about a third of all values come from this list. */
const INTERESTING_VALUES: readonly bigint[] = [
  0n,
  1n,
  MASK64, // −1
  0x7fn,
  0x80n,
  0xffn,
  0x7fffn,
  0x8000n,
  0x7fff_ffffn,
  0x8000_0000n,
  0xffff_ffffn,
  0x7fff_ffff_ffff_ffffn,
  0x8000_0000_0000_0000n,
]

const INTERESTING_SIGNED_32: readonly bigint[] = [
  ...INTERESTING_VALUES.map((value) => BigInt.asIntN(32, value)),
  2n,
  -2n,
  -0x80n,
  -0x81n,
  -0x8000n,
  -0x8001n,
]

/** Other spellings of the same jump. The assembler contract folds them. */
const JUMP_ALIASES: Readonly<Record<Condition, readonly string[]>> = {
  je: ['jz'],
  jne: ['jnz'],
  jg: ['jnle'],
  jge: ['jnl'],
  jl: ['jnge'],
  jle: ['jng'],
  ja: ['jnbe'],
  jae: ['jnb', 'jnc'],
  jb: ['jnae', 'jc'],
  jbe: ['jna'],
  js: [],
  jns: [],
  jo: [],
  jno: [],
}

/** Conditions that read only CF or OF: the only ones allowed right after `imul`. */
const PROBE_CONDITIONS: readonly Condition[] = ['jo', 'jno', 'jb', 'jae']

const MAX_STACK_DEPTH = 6

/** How the immediate of an instruction is limited (assembler contract, section 3). */
type ImmediateRule =
  /** 8/16/32-bit operand: any value from −2^(N−1) to 2^N − 1. */
  | 'pattern'
  /** 64-bit operand, `push`: must fit a signed 32-bit number. */
  | 'signed32'
  /** `mov r64, imm`: any 64-bit value. */
  | 'any64'

interface Context {
  rng: Rng
  id: string
  labels: number
  /** How many values are on the stack right now (top level only). */
  depth: number
  /** Favourite scratch offsets, so that reads often meet earlier writes. */
  hot: number[]
  lines: Line[]
}

/* ───────────────────────────── small helpers ───────────────────────────── */

function mask(size: Size): bigint {
  return (1n << BigInt(size)) - 1n
}

function line(step: Step, text: string, form: string | null, native?: string): Line {
  const written = form === null ? null : (text.split(' ')[0] ?? null)
  return { step, text, native: native ?? text, form, written }
}

function registersOf(size: Size, filter?: (reg: RegName) => boolean): RegName[] {
  return REGISTER_NAMES.filter((reg) => reg.size === size && (filter === undefined || filter(reg)))
}

const notHigh = (reg: RegName): boolean => reg.shift === 0
const noRex = (reg: RegName): boolean => !reg.rex

function anyRegister(rng: Rng, size: Size, filter?: (reg: RegName) => boolean): RegName {
  return rng.pick(registersOf(size, filter))
}

/** Two registers of one width that may legally share an instruction. */
function registerPair(rng: Rng, size: Size): [RegName, RegName] {
  const first = anyRegister(rng, size)
  if (rng.chance(0.12)) return [first, first]
  // ah/bh/ch/dh cannot be encoded next to a register that needs a REX prefix.
  if (first.shift === 8) return [first, anyRegister(rng, size, noRex)]
  return [first, anyRegister(rng, size, first.rex ? notHigh : undefined)]
}

function sizeOf(rng: Rng): Size {
  return rng.pick<Size>([8, 16, 32, 64])
}

function renderNumber(rng: Rng, value: bigint): string {
  if (value < 0n) {
    const size = -value
    return rng.chance(0.3) ? `-0x${size.toString(16)}` : `-${size.toString()}`
  }
  // Large numbers are easier to read in hex.
  if (value > 0xffff_ffffn || !rng.chance(0.35)) return `0x${value.toString(16)}`
  return value.toString()
}

/** An N-bit pattern: an edge value about a third of the time. */
function pattern(rng: Rng, size: Size): bigint {
  if (rng.chance(0.34)) return BigInt.asUintN(size, rng.pick(INTERESTING_VALUES))
  if (rng.chance(0.25)) return BigInt(rng.below(16))
  return rng.u64() & mask(size)
}

function immediate(
  rng: Rng,
  size: Size,
  rule: ImmediateRule,
): { operand: ImmOperand; text: string } {
  let value: bigint
  if (rule === 'signed32') {
    if (rng.chance(0.34)) value = rng.pick(INTERESTING_SIGNED_32)
    else if (rng.chance(0.3)) value = BigInt(rng.between(-16, 16))
    else value = BigInt.asIntN(32, BigInt(rng.u32()))
  } else {
    const width: Size = rule === 'any64' ? 64 : size
    const bits = pattern(rng, width)
    const negative = bits >> BigInt(width - 1) === 1n
    // The same bits can be written as a big positive number or as a negative one.
    value =
      negative && rng.chance(rule === 'any64' ? 0.3 : 0.5) ? bits - (1n << BigInt(width)) : bits
  }
  return { operand: { kind: 'imm', value }, text: renderNumber(rng, value) }
}

function immediateRule(
  op: BinaryOp | 'imul',
  size: Size,
  destinationIsRegister: boolean,
): ImmediateRule {
  if (size !== 64) return 'pattern'
  return op === 'mov' && destinationIsRegister ? 'any64' : 'signed32'
}

/** A scratch offset from 0 to 248 (every access of up to 8 bytes stays inside 256 bytes). */
function scratchOffset(ctx: Context): number {
  const { rng } = ctx
  if (rng.chance(0.7)) {
    const base = rng.pick(ctx.hot)
    const extra = rng.chance(0.3) ? rng.below(8) : 0
    return Math.min(base + extra, 248)
  }
  return rng.below(249)
}

function memory(
  ctx: Context,
  size: Size,
  explicitSize: boolean,
): { operand: MemOperand; text: string } {
  const { rng } = ctx
  const offset = scratchOffset(ctx)
  const number = rng.chance(0.15) ? `0x${offset.toString(16)}` : String(offset)
  let inside: string
  if (rng.chance(0.3)) inside = `${number}[r15]`
  else if (offset === 0 && rng.chance(0.8)) inside = '[r15]'
  else inside = `[r15+${number}]`
  const text = explicitSize ? `${POINTER_WORD[size]} ptr ${inside}` : inside
  return { operand: { kind: 'mem', offset, size }, text }
}

/* ───────────────────────────── instructions ───────────────────────────── */

type Shape = 'reg,reg' | 'reg,imm' | 'reg,mem' | 'mem,reg' | 'mem,imm'

function binary(ctx: Context, op: BinaryOp, wanted?: Shape): Line {
  const { rng } = ctx
  const size = sizeOf(rng)
  const shape =
    wanted ??
    rng.weighted<Shape>([
      ['reg,reg', 30],
      ['reg,imm', 25],
      ['reg,mem', 15],
      ['mem,reg', 15],
      ['mem,imm', 15],
    ])
  const form = `${op} ${shape}`
  switch (shape) {
    case 'reg,reg': {
      const [dst, src] = registerPair(rng, size)
      return line(
        { op, size, dst: { kind: 'reg', reg: dst }, src: { kind: 'reg', reg: src } },
        `${op} ${dst.name}, ${src.name}`,
        form,
      )
    }
    case 'reg,imm': {
      const dst = anyRegister(rng, size)
      const imm = immediate(rng, size, immediateRule(op, size, true))
      return line(
        { op, size, dst: { kind: 'reg', reg: dst }, src: imm.operand },
        `${op} ${dst.name}, ${imm.text}`,
        form,
      )
    }
    case 'reg,mem': {
      // Memory uses r15 as its base, which needs a REX prefix: no ah/bh/ch/dh here.
      const dst = anyRegister(rng, size, notHigh)
      const src = memory(ctx, size, rng.chance(0.5))
      return line(
        { op, size, dst: { kind: 'reg', reg: dst }, src: src.operand },
        `${op} ${dst.name}, ${src.text}`,
        form,
      )
    }
    case 'mem,reg': {
      const src = anyRegister(rng, size, notHigh)
      const dst = memory(ctx, size, rng.chance(0.5))
      return line(
        { op, size, dst: dst.operand, src: { kind: 'reg', reg: src } },
        `${op} ${dst.text}, ${src.name}`,
        form,
      )
    }
    default: {
      // mem,imm: the size must be written, nothing else says how wide the store is.
      const dst = memory(ctx, size, true)
      const imm = immediate(rng, size, immediateRule(op, size, false))
      return line(
        { op, size, dst: dst.operand, src: imm.operand },
        `${op} ${dst.text}, ${imm.text}`,
        form,
      )
    }
  }
}

function extend(ctx: Context, op: 'movzx' | 'movsx'): Line {
  const { rng } = ctx
  const widths: (readonly [Size, Size])[] = [
    [16, 8],
    [32, 8],
    [64, 8],
    [32, 16],
    [64, 16],
  ]
  // `movsx r64, r/m32` is the one extra form movsx has. Give it two tickets.
  if (op === 'movsx') widths.push([64, 32], [64, 32])
  const [dstSize, srcSize] = rng.pick(widths)
  const wide = srcSize === 32
  // clang only accepts the 32 → 64 form under the name movsxd.
  const written = wide && rng.chance(0.15) ? 'movsxd' : op
  const nativeName = wide ? 'movsxd' : op

  if (rng.chance(0.35)) {
    const dst = anyRegister(rng, dstSize, notHigh)
    const src = memory(ctx, srcSize, true)
    const operands = `${dst.name}, ${src.text}`
    return line(
      { op, dst, src: src.operand },
      `${written} ${operands}`,
      `${op} r${dstSize},m${srcSize}`,
      `${nativeName} ${operands}`,
    )
  }

  // A high byte (ah…) can only be extended into a 16- or 32-bit register without REX.
  const highAllowed = srcSize === 8 && dstSize !== 64
  const src = anyRegister(rng, srcSize, highAllowed ? undefined : notHigh)
  const dst = anyRegister(rng, dstSize, src.shift === 8 ? noRex : undefined)
  const operands = `${dst.name}, ${src.name}`
  return line(
    { op, dst, src: { kind: 'reg', reg: src } },
    `${written} ${operands}`,
    `${op} r${dstSize},r${srcSize}`,
    `${nativeName} ${operands}`,
  )
}

function lea(ctx: Context): Line {
  const { rng } = ctx
  const dstSize = rng.weighted<Size>([
    [64, 50],
    [32, 35],
    [16, 15],
  ])
  const dst = anyRegister(rng, dstSize)
  let base: FreeRegister | null = rng.chance(0.85) ? rng.pick(FREE_REGISTERS) : null
  const index: FreeRegister | null = rng.chance(0.6) ? rng.pick(FREE_REGISTERS) : null
  if (base === null && index === null) base = rng.pick(FREE_REGISTERS)
  const scale = index === null ? 1 : rng.pick<1 | 2 | 4 | 8>([1, 2, 4, 8])
  let disp = 0n
  if (rng.chance(0.6)) {
    disp = rng.chance(0.6) ? BigInt(rng.between(-128, 127)) : BigInt.asIntN(32, BigInt(rng.u32()))
  }

  const terms: string[] = []
  if (base !== null) terms.push(base)
  if (index !== null) {
    if (base === null || scale !== 1 || rng.chance(0.2)) {
      terms.push(rng.chance(0.1) ? `${scale}*${index}` : `${index}*${scale}`)
    } else {
      terms.push(index)
    }
  }
  const size = disp < 0n ? -disp : disp
  const number = size > 255n || rng.chance(0.3) ? `0x${size.toString(16)}` : size.toString()
  let operand: string
  if (disp !== 0n && rng.chance(0.2)) {
    // The gcc spelling: the displacement goes in front of the brackets.
    operand = `${disp < 0n ? '-' : ''}${number}[${terms.join('+')}]`
  } else if (disp !== 0n) {
    operand = `[${terms.join('+')}${disp < 0n ? '-' : '+'}${number}]`
  } else {
    operand = `[${terms.join('+')}]`
  }
  return line({ op: 'lea', dst, base, index, scale, disp }, `lea ${dst.name}, ${operand}`, 'lea')
}

function incDec(ctx: Context, op: 'inc' | 'dec'): Line {
  const { rng } = ctx
  const size = sizeOf(rng)
  if (rng.chance(0.3)) {
    const dst = memory(ctx, size, true)
    return line({ op, size, dst: dst.operand }, `${op} ${dst.text}`, `${op} mem`)
  }
  const dst = anyRegister(rng, size)
  return line({ op, size, dst: { kind: 'reg', reg: dst } }, `${op} ${dst.name}`, `${op} reg`)
}

function imul(ctx: Context): Line {
  const { rng } = ctx
  const size = rng.pick<16 | 32 | 64>([16, 32, 64])
  const dst = anyRegister(rng, size)
  const shape = rng.weighted<string>([
    ['reg,reg', 50],
    ['reg,mem', 25],
    ['reg,imm', 25],
  ])
  const form = `imul ${shape}`
  if (shape === 'reg,reg') {
    const src = rng.chance(0.1) ? dst : anyRegister(rng, size)
    return line(
      { op: 'imul', size, dst, src: { kind: 'reg', reg: src } },
      `imul ${dst.name}, ${src.name}`,
      form,
    )
  }
  if (shape === 'reg,mem') {
    const src = memory(ctx, size, rng.chance(0.5))
    return line({ op: 'imul', size, dst, src: src.operand }, `imul ${dst.name}, ${src.text}`, form)
  }
  const imm = immediate(rng, size, immediateRule('imul', size, true))
  return line({ op: 'imul', size, dst, src: imm.operand }, `imul ${dst.name}, ${imm.text}`, form)
}

/** `cmp` or `test` of two registers: writes all four flags, so nothing of imul's is left. */
function flagReset(ctx: Context): Line {
  const { rng } = ctx
  const op = rng.pick<'cmp' | 'test'>(['cmp', 'test'])
  const size = sizeOf(rng)
  const [dst, src] = registerPair(rng, size)
  return line(
    { op, size, dst: { kind: 'reg', reg: dst }, src: { kind: 'reg', reg: src } },
    `${op} ${dst.name}, ${src.name}`,
    `${op} reg,reg`,
  )
}

function push(ctx: Context): Line {
  const { rng } = ctx
  if (rng.chance(0.35)) {
    const imm = immediate(rng, 64, 'signed32')
    return line({ op: 'push', src: imm.operand }, `push ${imm.text}`, 'push imm')
  }
  const src = anyRegister(rng, 64)
  return line({ op: 'push', src: { kind: 'reg', reg: src } }, `push ${src.name}`, 'push reg')
}

function pop(ctx: Context): Line {
  const dst = anyRegister(ctx.rng, 64)
  return line({ op: 'pop', dst }, `pop ${dst.name}`, 'pop reg')
}

function nop(ctx: Context): Line {
  // endbr64 is what gcc puts at the start of functions. It does nothing.
  return line({ op: 'nop' }, ctx.rng.chance(0.2) ? 'endbr64' : 'nop', 'nop')
}

type SimpleKind = BinaryOp | 'movzx' | 'movsx' | 'lea' | 'inc' | 'dec' | 'nop'

/** One instruction that needs no partner: no push, pop, imul or jump. */
function simple(ctx: Context): Line {
  const kind = ctx.rng.weighted<SimpleKind>([
    ['mov', 18],
    ['movzx', 5],
    ['movsx', 6],
    ['lea', 6],
    ['add', 6],
    ['sub', 6],
    ['and', 4],
    ['or', 4],
    ['xor', 4],
    ['cmp', 5],
    ['test', 5],
    ['inc', 4],
    ['dec', 4],
    ['nop', 1],
  ])
  switch (kind) {
    case 'movzx':
    case 'movsx':
      return extend(ctx, kind)
    case 'lea':
      return lea(ctx)
    case 'inc':
    case 'dec':
      return incDec(ctx, kind)
    case 'nop':
      return nop(ctx)
    default:
      return binary(ctx, kind)
  }
}

/**
 * `count` instructions that a jump may skip. The stack is balanced inside the block,
 * and an imul inside the block brings its own flag reset.
 */
function block(ctx: Context, count: number, allowImul: boolean): Line[] {
  const { rng } = ctx
  const lines: Line[] = []
  let left = count
  while (left > 0) {
    if (left >= 2 && rng.chance(0.15)) {
      lines.push(push(ctx), pop(ctx))
      left -= 2
    } else if (allowImul && left >= 2 && rng.chance(0.1)) {
      lines.push(imul(ctx), flagReset(ctx))
      left -= 2
    } else {
      lines.push(simple(ctx))
      left -= 1
    }
  }
  return lines
}

function jumpLine(ctx: Context, condition: Condition | null, label: string, probe: boolean): Line {
  const { rng } = ctx
  let written: string = condition ?? 'jmp'
  if (condition !== null) {
    const aliases = JUMP_ALIASES[condition]
    if (aliases.length > 0 && rng.chance(0.15)) written = rng.pick(aliases)
  }
  return line({ op: 'jump', condition, label, probe }, `${written} ${label}`, condition ?? 'jmp')
}

function labelLine(name: string): Line {
  return line({ op: 'label', name }, `${name}:`, null)
}

function newLabel(ctx: Context): string {
  ctx.labels += 1
  return `${ctx.id}_${ctx.labels}`
}

function registerImmediate(op: BinaryOp, reg: RegName, value: bigint): Line {
  const text = value < 0n ? `-${(-value).toString()}` : `0x${value.toString(16)}`
  return line(
    { op, size: reg.size, dst: { kind: 'reg', reg }, src: { kind: 'imm', value } },
    `${op} ${reg.name}, ${text}`,
    `${op} reg,imm`,
  )
}

function registerItself(op: BinaryOp, reg: RegName): Line {
  return line(
    { op, size: reg.size, dst: { kind: 'reg', reg }, src: { kind: 'reg', reg } },
    `${op} ${reg.name}, ${reg.name}`,
    `${op} reg,reg`,
  )
}

/**
 * Two instructions that leave the flags in a state chosen in advance, whatever the
 * registers held before. Together the recipes reach the flag states that tell the 14
 * jump conditions apart: signed overflow with either sign, "equal", "below", and so on.
 * (The flags each recipe gives are written next to it as CF ZF SF OF.)
 */
function flagRecipe(ctx: Context): Line[] {
  const { rng } = ctx
  const size = sizeOf(rng)
  const reg = anyRegister(rng, size)
  const lowest = 1n << BigInt(size - 1) // the most negative number of this width
  const highest = lowest - 1n // the most positive number
  const load = (value: bigint): Line => registerImmediate('mov', reg, value)
  switch (rng.below(10)) {
    case 0: // 1 0 1 1: highest − (−1) does not fit
      return [load(highest), registerImmediate('cmp', reg, -1n)]
    case 1: // 0 0 0 1: lowest − 1 does not fit
      return [load(lowest), registerImmediate('cmp', reg, 1n)]
    case 2: // 1 1 0 1: lowest + lowest wraps to 0
      return [load(lowest), registerItself('add', reg)]
    case 3: // 0 0 1 1: highest + 1 does not fit
      return [load(highest), registerImmediate('add', reg, 1n)]
    case 4: // 1 0 1 0: 0 − 1
      return [load(0n), registerImmediate('cmp', reg, 1n)]
    case 5: // 0 1 0 0: equal
      return [load(pattern(rng, size)), registerItself('cmp', reg)]
    case 6: // 0 0 1 0: −1 − 1
      return [load(mask(size)), registerImmediate('cmp', reg, 1n)]
    case 7: // 1 0 0 0: 1 − (−1), below as unsigned numbers
      return [load(1n), registerImmediate('cmp', reg, -1n)]
    case 8: // 0 0 0 1: like case 1, but the result is stored
      return [load(lowest), registerImmediate('sub', reg, 1n)]
    default: // CF kept, 0 1 1: inc does not touch CF
      return [
        load(highest),
        line({ op: 'inc', size, dst: { kind: 'reg', reg } }, `inc ${reg.name}`, 'inc reg'),
      ]
  }
}

/**
 * One or two instructions that set the flags right before a conditional jump.
 *
 * Without them most jumps would see flags left by some earlier logic instruction, where
 * OF is always 0. Then a `jl` that looks only at SF would pass every test.
 */
function flagSetup(ctx: Context, room: number): Line[] {
  const { rng } = ctx
  if (room >= 2 && rng.chance(0.5)) return flagRecipe(ctx)
  const [op, shape] = rng.weighted<readonly [BinaryOp, Shape]>([
    [['cmp', 'reg,reg'], 55],
    [['cmp', 'reg,imm'], 15],
    [['sub', 'reg,reg'], 10],
    [['add', 'reg,reg'], 10],
    [['test', 'reg,reg'], 10],
  ])
  return [binary(ctx, op, shape)]
}

/** A forward jump over 1–3 instructions. Returns the lines; uses at most `budget` instructions. */
function jumpGroup(ctx: Context, budget: number): Line[] {
  const { rng } = ctx
  const condition = rng.chance(0.09) ? null : rng.pick(CONDITIONS)
  const lines: Line[] = []
  let left = budget
  if (condition !== null && left >= 3 && rng.chance(0.7)) {
    // Keep room for the jump itself and at least one instruction to skip.
    const setup = flagSetup(ctx, left - 2)
    lines.push(...setup)
    left -= setup.length
  }
  const label = newLabel(ctx)
  const skipped = rng.between(1, Math.min(3, left - 1))
  lines.push(jumpLine(ctx, condition, label, false), ...block(ctx, skipped, true), labelLine(label))
  return lines
}

/**
 * An imul, sometimes a jump that looks only at CF or OF (the two flags imul defines),
 * then the flag reset.
 */
function imulGroup(ctx: Context, budget: number): Line[] {
  const { rng } = ctx
  const lines = [imul(ctx)]
  if (budget >= 4 && rng.chance(0.5)) {
    const label = newLabel(ctx)
    const skipped = rng.between(1, Math.min(3, budget - 3))
    lines.push(
      jumpLine(ctx, rng.pick(PROBE_CONDITIONS), label, true),
      ...block(ctx, skipped, false),
      labelLine(label),
    )
  }
  lines.push(flagReset(ctx))
  return lines
}

/** The next instruction (or group) at the top level. */
function next(ctx: Context, budget: number): Line[] {
  const { rng } = ctx
  const kind = rng.weighted<string>([
    ['simple', 77],
    ['imul', 6],
    ['push', 5],
    ['pop', 4],
    ['jump', 8],
  ])
  if (kind === 'jump' && budget >= 2) return jumpGroup(ctx, budget)
  if (kind === 'imul' && budget >= 2) return imulGroup(ctx, budget)
  if (kind === 'push' && ctx.depth < MAX_STACK_DEPTH) {
    ctx.depth += 1
    return [push(ctx)]
  }
  if (kind === 'pop' && ctx.depth > 0) {
    ctx.depth -= 1
    return [pop(ctx)]
  }
  return [simple(ctx)]
}

function countInstructions(lines: readonly Line[]): number {
  return lines.filter((item) => item.step.op !== 'label').length
}

/* ───────────────────────────── the program ───────────────────────────── */

function opening(ctx: Context): Line[] {
  const { rng } = ctx
  const lines: Line[] = []
  for (const base of FREE_REGISTERS) {
    const value = rng.chance(1 / 3) ? rng.pick(INTERESTING_VALUES) : rng.u64()
    const text = value === MASK64 && rng.chance(0.5) ? '-1' : `0x${value.toString(16)}`
    lines.push(
      line(
        {
          op: 'mov',
          size: 64,
          dst: { kind: 'reg', reg: registerNamed(base) },
          src: { kind: 'imm', value: text === '-1' ? -1n : value },
        },
        `mov ${base}, ${text}`,
        null,
      ),
    )
  }
  lines.push(line({ op: 'point-at-scratch' }, 'lea r15, scratch[rip]', null))
  lines.push(line({ op: 'known-flags' }, 'cmp rsp, rsp', null))
  return lines
}

/** Build program number `index` for `seed`. The result depends on nothing else. */
export function generateProgram(seed: number, index: number): FuzzProgram {
  const rng = createRng(seed, index)
  const id = programId(index)
  const ctx: Context = {
    rng,
    id,
    labels: 0,
    depth: 0,
    hot: Array.from({ length: 5 }, () => rng.below(32) * 8),
    lines: [],
  }
  ctx.lines.push(...opening(ctx))

  const randomInstructions = rng.between(15, 45)
  let budget = randomInstructions
  while (budget > 0) {
    const group = next(ctx, budget)
    ctx.lines.push(...group)
    budget -= countInstructions(group)
  }
  while (ctx.depth > 0) {
    ctx.lines.push(pop(ctx))
    ctx.depth -= 1
  }
  return { id, index, randomInstructions, lines: ctx.lines }
}

export function generatePrograms(seed: number, count: number): FuzzProgram[] {
  return Array.from({ length: count }, (_, index) => generateProgram(seed, index))
}
