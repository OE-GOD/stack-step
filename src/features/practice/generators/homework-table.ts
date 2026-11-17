/**
 * Practice topic `homework-table`: the homework-style trace table.
 *
 * The student sees the starting values of 3 or 4 registers and five lines of code. Each
 * line changes exactly one of those registers. For each line the student places a chip
 * such as `rax = 0x0000000000000005`: the register that changed, and its new value.
 *
 * How a problem is made:
 *   1. Pick the registers and their starting values.
 *   2. Plan the five lines. Three jobs go to lines picked at random:
 *      - 'top':   a 32-bit write onto a register whose top half is not zero (always);
 *      - 'reads': a line that reads a register that an earlier line changed (always);
 *      - 'part':  an 8-bit or 16-bit write onto a register whose other bits are not zero
 *                 (most problems).
 *      Every candidate line is RUN IN THE EMULATOR before it is kept, so a line that
 *      changes nothing, or changes some other register, is never used.
 *   3. Run the whole program in the emulator. The right chip of each line names the
 *      register that the emulator says changed, with its new value.
 *   4. Make the tempting wrong chips from that same run:
 *      - 'top' line, old top half kept                     → `forgot-zero-upper`
 *      - 'reads' line run again in the emulator with the
 *        value from before the earlier change               → `stale-value`
 *      - an 8/16-bit line ('part', or any other one that
 *        keeps bits) with all the other bits cleared        → `cleared-upper-wrongly`
 *      - a right value on the wrong register                → no named mistake (the
 *        contract has no code for "the result goes into the first operand")
 *   The chips are shuffled and numbered in tray order (`chip-1` …), so an id says nothing.
 */
import {
  lookupRegister,
  MASK,
  REG64_DISPLAY_ORDER,
  registerFamily,
  subRegister,
  type EmulatorOptions,
  type Reg64,
  type RegisterFile,
  type RegisterInfo,
} from '../../../emulator'
import { createRng, type Rng } from '../../../lib/rng'
import {
  chipField,
  codeBlock,
  pickRegisters,
  random64,
  registersBlock,
  runProgram,
  show,
  show64,
  textBlock,
  type ProgramRun,
} from '../gen/helpers'
import type { Chip, Mistake, Problem, ProblemGenerator } from '../types'

const QUESTION =
  'Follow the code one line at a time. Each line changes exactly one of the registers below. For each line, place the chip that shows that register and its new value. Some chips are not needed.'

const LINE_COUNT = 5

/** Plans tried before giving up. A sweep of 50 000 seeds never needed more than 11. */
const MAX_ATTEMPTS = 60
const MAX_TRIES_PER_LINE = 40

/* ───────────────────────────── registers ───────────────────────────── */

/** The registers the course uses most. Some problems add one of r8 … r15. */
const CLASSIC: readonly Reg64[] = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi']
const NUMBERED: readonly Reg64[] = ['r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15']

/** Which part of a register a line writes: a size in bits, or bits 15–8 (`ah`). */
type Part = 64 | 32 | 16 | 8 | 'high'

function registerInfo(name: string): RegisterInfo {
  const found = lookupRegister(name)
  if (found === undefined) throw new Error(`homework-table: unknown register name '${name}'.`)
  return found
}

/** The name of a part of a register: (rax, 32) → eax, (rax, 'high') → ah, (r9, 8) → r9b. */
function nameOf(base: Reg64, part: Part): string {
  if (part !== 'high') return subRegister(base, part).name
  const high = registerFamily(base).find((entry) => entry.highByte)
  if (high === undefined) throw new Error(`homework-table: ${base} has no name for bits 15–8.`)
  return high.name
}

function hasHighByte(base: Reg64): boolean {
  return registerFamily(base).some((entry) => entry.highByte)
}

/** The bits of a 64-bit register that a part covers. */
function partMask(part: Part): bigint {
  return part === 'high' ? MASK[8] << 8n : MASK[part]
}

/** The value of one part of a register, as a number of that part's size. */
function partValue(value: bigint, part: Part): bigint {
  return part === 'high' ? (value >> 8n) & MASK[8] : value & MASK[part]
}

/** The largest number a part can hold. */
function partMax(part: Part): bigint {
  return part === 'high' ? MASK[8] : MASK[part]
}

/** The bits a write to `part` must leave alone. */
function otherBits(value: bigint, part: Part): bigint {
  return value & ~partMask(part) & MASK[64]
}

function topHalf(value: bigint): bigint {
  return value >> 32n
}

/** The part a register name writes: `eax` → 32, `ah` → 'high'. */
function partOf(name: RegisterInfo): Part {
  return name.highByte ? 'high' : name.size
}

/* ───────────────────────────── numbers ─────────────────────────────── */

/** A number as the code writes it: 0 … 9 in decimal (the same in hex), bigger ones in hex. */
function numberText(value: bigint): string {
  return value < 10n ? value.toString() : show(value)
}

const tiny = (rng: Rng): bigint => BigInt(rng.int(1, 9))
const byte = (rng: Rng): bigint => BigInt(rng.int(0x10, 0xff))
const word = (rng: Rng): bigint => BigInt(rng.int(0x100, 0xffff))
const dword = (rng: Rng): bigint => BigInt(rng.int(0x1000_0000, 0x7fff_ffff))
/** A number to add or subtract: 1 … 9, or 0x10 … 0x7f. */
const amount = (rng: Rng): bigint => (rng.chance(0.5) ? tiny(rng) : BigInt(rng.int(0x10, 0x7f)))

/** Sums stay easy to work out on paper: at least one of the two numbers is at most this. */
const SMALL_LIMIT = 0xffffn

/* ───────────────────────────── lines ───────────────────────────────── */

/** One line of the program, as planned. The emulator decides what it really does. */
interface Line {
  /** As the student reads it: `add rbx, rax`. */
  text: string
  /** The register name the line writes (`eax`): its size and its 64-bit register. */
  dest: RegisterInfo
  /** The register names the line reads, as written (`bl`, `rax`). Includes the destination for `add` and the like. */
  reads: readonly RegisterInfo[]
}

function makeLine(text: string, dest: string, reads: readonly string[]): Line {
  return { text, dest: registerInfo(dest), reads: reads.map(registerInfo) }
}

/** What a form gets from the planner. */
interface FormInput {
  rng: Rng
  /** The register the line writes. */
  x: Reg64
  /** The register the line reads (forms with a source). */
  y: Reg64
  /** A second register to read (`lea` with two registers). Never the same as y. */
  z: Reg64
  /** Every register right before the line, from the emulator. */
  now: Readonly<RegisterFile>
}

/** A kind of line, such as "`add` a small number to a 16-bit name". */
interface Form {
  part: Part
  /** 'one' reads register y; 'two' reads y and z (`lea`). */
  source: 'none' | 'one' | 'two'
  /** The line reads its destination too (`add`, `sub`, `inc`, `dec`, `and`, `or`). */
  rmw: boolean
  /** y may be the destination register itself (`movzx eax, al`, `lea rax, [rax+8]`). */
  selfSource: boolean
  weight: number
  /** null when the numbers do not suit this form (a sum would wrap around, …). */
  build(input: FormInput): Line | null
}

function movImmediate(part: Part, weight: number, pick: (rng: Rng) => bigint): Form {
  return {
    part,
    source: 'none',
    rmw: false,
    selfSource: false,
    weight,
    build: ({ rng, x }) => {
      const dest = nameOf(x, part)
      return makeLine(`mov ${dest}, ${numberText(pick(rng))}`, dest, [])
    },
  }
}

function movRegister(part: 64 | 32 | 16 | 8, weight: number): Form {
  return {
    part,
    source: 'one',
    rmw: false,
    selfSource: false,
    weight,
    build: ({ x, y }) => {
      const dest = nameOf(x, part)
      const source = nameOf(y, part)
      return makeLine(`mov ${dest}, ${source}`, dest, [source])
    },
  }
}

/** `add`/`sub` with a small number. The part never wraps around (no carry out of it). */
function arithmeticImmediate(op: 'add' | 'sub', part: Part, weight: number): Form {
  return {
    part,
    source: 'none',
    rmw: true,
    selfSource: false,
    weight,
    build: ({ rng, x, now }) => {
      const change = amount(rng)
      const current = partValue(now[x], part)
      if (op === 'add' ? current + change > partMax(part) : current < change) return null
      const dest = nameOf(x, part)
      return makeLine(`${op} ${dest}, ${numberText(change)}`, dest, [dest])
    },
  }
}

function incDec(op: 'inc' | 'dec', part: Part, weight: number): Form {
  return {
    part,
    source: 'none',
    rmw: true,
    selfSource: false,
    weight,
    build: ({ x, now }) => {
      const current = partValue(now[x], part)
      if (op === 'inc' ? current === partMax(part) : current === 0n) return null
      const dest = nameOf(x, part)
      return makeLine(`${op} ${dest}`, dest, [dest])
    },
  }
}

/** `add`/`sub` with two registers. One of the numbers is small, and nothing wraps around. */
function arithmeticRegister(op: 'add' | 'sub', part: 64 | 32, weight: number): Form {
  return {
    part,
    source: 'one',
    rmw: true,
    selfSource: false,
    weight,
    build: ({ x, y, now }) => {
      const a = partValue(now[x], part)
      const b = partValue(now[y], part)
      if (op === 'add' && (a + b > partMax(part) || (a > SMALL_LIMIT && b > SMALL_LIMIT))) {
        return null
      }
      if (op === 'sub' && (a < b || b > SMALL_LIMIT)) return null
      const dest = nameOf(x, part)
      const source = nameOf(y, part)
      return makeLine(`${op} ${dest}, ${source}`, dest, [dest, source])
    },
  }
}

function logicImmediate(
  op: 'and' | 'or',
  part: Part,
  weight: number,
  masks: readonly bigint[],
): Form {
  return {
    part,
    source: 'none',
    rmw: true,
    selfSource: false,
    weight,
    build: ({ rng, x }) => {
      const dest = nameOf(x, part)
      return makeLine(`${op} ${dest}, ${numberText(rng.pick(masks))}`, dest, [dest])
    },
  }
}

/** `xor eax, eax`: the classic way to put 0 in a register. The old value does not matter. */
function zeroItself(part: 64 | 32, weight: number): Form {
  return {
    part,
    source: 'none',
    rmw: false,
    selfSource: false,
    weight,
    build: ({ x }) => {
      const dest = nameOf(x, part)
      return makeLine(`xor ${dest}, ${dest}`, dest, [])
    },
  }
}

/** `xor rax, rbx` with two small numbers, so the bits are easy to compare. */
const XOR_REGISTERS: Form = {
  part: 64,
  source: 'one',
  rmw: true,
  selfSource: false,
  weight: 1,
  build: ({ x, y, now }) =>
    now[x] > SMALL_LIMIT || now[y] > SMALL_LIMIT ? null : makeLine(`xor ${x}, ${y}`, x, [x, y]),
}

function movzx(destPart: 64 | 32, sourcePart: 8 | 16, weight: number): Form {
  return {
    part: destPart,
    source: 'one',
    rmw: false,
    selfSource: true,
    weight,
    build: ({ x, y }) => {
      const dest = nameOf(x, destPart)
      const source = nameOf(y, sourcePart)
      return makeLine(`movzx ${dest}, ${source}`, dest, [source])
    },
  }
}

/** `lea` adds up registers and numbers without reading memory. At most one big number. */
function lea(shape: 'number' | 'two' | 'scaled', weight: number): Form {
  return {
    part: 64,
    source: shape === 'number' ? 'one' : 'two',
    rmw: false,
    selfSource: true,
    weight,
    build: ({ rng, x, y, z, now }) => {
      if (shape === 'number') {
        return makeLine(`lea ${x}, [${y}+${numberText(amount(rng))}]`, x, [y])
      }
      if (shape === 'two') {
        if (now[y] > SMALL_LIMIT && now[z] > SMALL_LIMIT) return null
        return makeLine(`lea ${x}, [${y}+${z}]`, x, [y, z])
      }
      if (now[z] > 0xfffn) return null
      const scale = rng.pick([2, 4, 8])
      const extra = rng.chance(0.5) ? `+${numberText(amount(rng))}` : ''
      return makeLine(`lea ${x}, [${y}+${z}*${scale}${extra}]`, x, [y, z])
    },
  }
}

const AND_MASKS = [0xffn, 0xffffn, 0xf0n, 0xff00n] as const
const OR_MASKS = [0x1n, 0x8n, 0x10n, 0x80n, 0xf0n, 0xffn, 0x100n, 0xf00n] as const

const FORMS: readonly Form[] = [
  // 64-bit names: the whole register gets the new value.
  movImmediate(64, 3, (rng) => (rng.chance(0.5) ? tiny(rng) : byte(rng))),
  movRegister(64, 3),
  arithmeticImmediate('add', 64, 3),
  arithmeticImmediate('sub', 64, 2),
  arithmeticRegister('add', 64, 3),
  arithmeticRegister('sub', 64, 2),
  incDec('inc', 64, 2),
  incDec('dec', 64, 2),
  lea('number', 2),
  lea('two', 2),
  lea('scaled', 2),
  logicImmediate('and', 64, 1, AND_MASKS),
  logicImmediate('or', 64, 1, OR_MASKS),
  zeroItself(64, 1),
  XOR_REGISTERS,
  movzx(64, 8, 1),
  movzx(64, 16, 1),
  // 32-bit names: the top 32 bits become 0.
  movImmediate(32, 4, (rng) => rng.pick([tiny, byte, word, dword])(rng)),
  movRegister(32, 3),
  arithmeticImmediate('add', 32, 2),
  arithmeticImmediate('sub', 32, 2),
  arithmeticRegister('add', 32, 2),
  arithmeticRegister('sub', 32, 1),
  incDec('inc', 32, 2),
  incDec('dec', 32, 2),
  logicImmediate('and', 32, 2, AND_MASKS),
  logicImmediate('or', 32, 1, OR_MASKS),
  zeroItself(32, 3),
  movzx(32, 8, 2),
  movzx(32, 16, 1),
  // 16-bit names: only the lowest 16 bits change.
  movImmediate(16, 3, (rng) => (rng.chance(0.8) ? word(rng) : byte(rng))),
  movRegister(16, 2),
  arithmeticImmediate('add', 16, 2),
  arithmeticImmediate('sub', 16, 1),
  incDec('inc', 16, 1),
  incDec('dec', 16, 1),
  // 8-bit names: only their own 8 bits change.
  movImmediate(8, 3, (rng) => (rng.chance(0.8) ? byte(rng) : tiny(rng))),
  movRegister(8, 2),
  arithmeticImmediate('add', 8, 2),
  arithmeticImmediate('sub', 8, 1),
  incDec('inc', 8, 1),
  incDec('dec', 8, 1),
  logicImmediate('or', 8, 1, [0x1n, 0x8n, 0x10n, 0x80n, 0xfn, 0xf0n]),
  movImmediate('high', 2, byte),
  arithmeticImmediate('add', 'high', 1),
]

function pickWeighted<T extends { weight: number }>(rng: Rng, items: readonly T[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let roll = rng.next() * total
  for (const item of items) {
    roll -= item.weight
    if (roll < 0) return item
  }
  return items[items.length - 1]
}

/* ───────────────────────────── the program ─────────────────────────── */

/** The five lines inside `main`, then `ret`: what the stepper gets and what the key comes from. */
function programSource(lines: readonly string[]): string {
  return [
    '.intel_syntax noprefix',
    '.globl main',
    'main:',
    ...lines.map((text) => `    ${text}`),
    '    ret',
    '',
  ].join('\n')
}

/** The registers right before line `index` (0-based) of a run. */
function before(run: ProgramRun, index: number): Readonly<RegisterFile> {
  return index === 0 ? run.start.registers : run.steps[index - 1].after.registers
}

/** Only the shown registers (the problem sets nothing else). */
function shownValues(
  registers: Readonly<RegisterFile>,
  regs: readonly Reg64[],
): Partial<Record<Reg64, bigint>> {
  return Object.fromEntries(regs.map((reg) => [reg, registers[reg]]))
}

/**
 * Planning only (the value itself comes from the emulator): did the line's sum go past the
 * top of the part it writes, or below 0 (0x5 − 0x8 = 0xff…fd)? Such a number is hard to
 * work out on paper, so a tempting chip never needs one. `run` ran this one line.
 */
function wrapsAround(run: ProgramRun, line: Line): boolean {
  const instruction = run.program.instructions[0]
  const after = run.steps[0].after
  const part = partOf(line.dest)
  switch (instruction.mnemonic) {
    case 'add':
    case 'sub':
      return after.flags.CF === 1
    case 'inc':
      return partValue(after.registers[line.dest.base], part) === 0n
    case 'dec':
      return partValue(after.registers[line.dest.base], part) === partMax(part)
    case 'lea': {
      // `lea` sets no flags: add up its address the long way and see if it fits 64 bits.
      const address = instruction.operands[1]
      if (address?.kind !== 'mem') return false
      const start = run.start.registers
      const base = address.base === null || address.base === 'rip' ? 0n : start[address.base]
      const index = address.index === null ? 0n : start[address.index] * BigInt(address.scale)
      const sum = base + index + address.disp
      return sum < 0n || sum > MASK[64]
    }
    default:
      return false
  }
}

/**
 * Run one line on its own, from the given register values, and return the 64-bit value of
 * the register it writes. Used for the `stale-value` chip: the same line, an old value.
 */
function runAlone(
  line: Line,
  registers: Partial<Record<Reg64, bigint>>,
): { value: bigint; wrapped: boolean } {
  const run = runProgram(programSource([line.text]), { initialRegisters: registers })
  return { value: run.steps[0].after.registers[line.dest.base], wrapped: wrapsAround(run, line) }
}

/* ───────────────────────────── planning ────────────────────────────── */

type Job = 'top' | 'reads' | 'part' | 'free'

/** Which line does which job. The 'reads' line is never line 1. */
function planJobs(rng: Rng): Job[] {
  const jobs: Job[] = Array.from({ length: LINE_COUNT }, () => 'free')
  const readsAt = rng.int(1, LINE_COUNT - 1)
  jobs[readsAt] = 'reads'
  const open = jobs.map((_, index) => index).filter((index) => index !== readsAt)
  const topAt = rng.pick(open)
  jobs[topAt] = 'top'
  if (rng.chance(0.8)) jobs[rng.pick(open.filter((index) => index !== topAt))] = 'part'
  return jobs
}

function pickRegistersOfProblem(rng: Rng): Reg64[] {
  const count = rng.chance(0.5) ? 3 : 4
  const picked = rng.chance(0.35)
    ? [...pickRegisters(rng, count - 1, CLASSIC), ...pickRegisters(rng, 1, NUMBERED)]
    : pickRegisters(rng, count, CLASSIC)
  return REG64_DISPLAY_ORDER.filter((reg) => picked.includes(reg))
}

type Size = 'big' | 'medium' | 'small'

/** The sizes of the starting values: always at least one with a top half that is not zero. */
const MIXES: Readonly<Record<number, readonly (readonly Size[])[]>> = {
  3: [
    ['big', 'big', 'small'],
    ['big', 'small', 'small'],
    ['big', 'medium', 'small'],
  ],
  4: [
    ['big', 'big', 'small', 'small'],
    ['big', 'medium', 'small', 'small'],
    ['big', 'big', 'medium', 'small'],
  ],
}

function valueOfSize(rng: Rng, size: Size): bigint {
  if (size === 'big') return random64(rng)
  if (size === 'medium') return word(rng)
  return rng.chance(0.3) ? tiny(rng) : byte(rng)
}

function startingValues(rng: Rng, regs: readonly Reg64[]): Partial<Record<Reg64, bigint>> {
  const sizes = rng.shuffle(rng.pick(MIXES[regs.length]))
  const values: Partial<Record<Reg64, bigint>> = {}
  const used = new Set<bigint>()
  regs.forEach((reg, index) => {
    let value = valueOfSize(rng, sizes[index])
    while (used.has(value)) value = valueOfSize(rng, sizes[index])
    used.add(value)
    values[reg] = value
  })
  return values
}

interface PlanState {
  rng: Rng
  regs: readonly Reg64[]
  options: EmulatorOptions
  jobs: readonly Job[]
  lines: Line[]
  /** history[k] = every register after k lines (history[0] = the start). From the emulator. */
  history: Readonly<RegisterFile>[]
  /** register → the lines (1-based) that changed it so far. */
  changes: Map<Reg64, number[]>
}

interface Chosen {
  line: Line
  after: Readonly<RegisterFile>
  /** The 'reads' line: the register name it reads that an earlier line changed. */
  read: RegisterInfo | null
}

/** The register a 'reads' line will read: prefer the ones the 'top' or 'part' line changed. */
function pickReadTarget(state: PlanState): Reg64 | null {
  const options = [...state.changes.entries()].map(([reg, lines]) => {
    const byJob = lines.some((lineNumber) => state.jobs[lineNumber - 1] !== 'free')
    return { reg, weight: (lines.length === 1 ? 2 : 1) * (byJob ? 2 : 1) }
  })
  return options.length === 0 ? null : pickWeighted(state.rng, options).reg
}

function formsFor(job: Job): readonly Form[] {
  switch (job) {
    case 'top':
      return FORMS.filter((form) => form.part === 32)
    case 'part':
      return FORMS.filter((form) => form.part === 8 || form.part === 16 || form.part === 'high')
    case 'reads':
      return FORMS.filter((form) => form.source !== 'none' || form.rmw)
    case 'free':
      return FORMS
  }
}

/** A register to read: not `avoid`, unless the form may read its own destination. */
function pickSource(rng: Rng, regs: readonly Reg64[], avoid: Reg64, self: boolean): Reg64 {
  if (self && rng.chance(0.2)) return avoid
  return rng.pick(regs.filter((reg) => reg !== avoid))
}

interface Registers {
  x: Reg64
  y: Reg64
  z: Reg64
  /** For the 'reads' job: the register that an earlier line changed. */
  target: Reg64 | null
}

function assignRegisters(state: PlanState, form: Form, job: Job): Registers | null {
  const { rng, regs } = state
  const now = state.history[state.history.length - 1]
  const canWrite = (reg: Reg64) => form.part !== 'high' || hasHighByte(reg)
  const other = (reg: Reg64) => rng.pick(regs.filter((entry) => entry !== reg))

  if (job === 'reads') {
    const target = pickReadTarget(state)
    if (target === null) return null
    if (form.source !== 'none' && (!form.rmw || rng.chance(0.75))) {
      // The target is a source: `add rbx, rax`, `movzx edx, bl`, `lea rsi, [rax+rdx]`.
      const writable = regs.filter((reg) => canWrite(reg) && (form.selfSource || reg !== target))
      if (writable.length === 0) return null
      const x = rng.pick(writable)
      const second = other(target)
      return form.source === 'two' && rng.chance(0.3)
        ? { x, y: second, z: target, target }
        : { x, y: target, z: second, target }
    }
    // The target is the destination, which the line also reads: `inc rax`, `add eax, 3`.
    if (!form.rmw || !canWrite(target)) return null
    const y = other(target)
    return { x: target, y, z: other(y), target }
  }

  let writable = regs.filter(canWrite)
  if (job === 'top') writable = writable.filter((reg) => topHalf(now[reg]) !== 0n)
  if (job === 'part') writable = writable.filter((reg) => otherBits(now[reg], form.part) !== 0n)
  if (job === 'free') {
    // Bring in a register that no line uses yet, so every shown register plays a part.
    const unused = writable.filter((reg) => !state.lines.some((line) => usesRegister(line, reg)))
    if (unused.length > 0 && rng.chance(0.5)) writable = unused
  }
  if (writable.length === 0) return null
  const x = rng.pick(writable)
  const y = pickSource(rng, regs, x, form.selfSource)
  return { x, y, z: other(y), target: null }
}

function usesRegister(line: Line, reg: Reg64): boolean {
  return line.dest.base === reg || line.reads.some((read) => read.base === reg)
}

/** Run the lines so far plus `line`. The registers after it, or null when it does not change exactly its own register. */
function tryLine(state: PlanState, line: Line): Readonly<RegisterFile> | null {
  const texts = [...state.lines.map((entry) => entry.text), line.text]
  const run = runProgram(programSource(texts), state.options)
  const last = run.steps[texts.length - 1]
  const changed = last.result.diff.registers
  if (changed.length !== 1 || changed[0].reg !== line.dest.base) return null
  return last.after.registers
}

/** The value of `reg` before the last line that changed it. */
function valueBeforeLastChange(state: PlanState, reg: Reg64): bigint | null {
  const lines = state.changes.get(reg)
  if (lines === undefined || lines.length === 0) return null
  return state.history[lines[lines.length - 1] - 1][reg]
}

function chooseLine(state: PlanState, job: Job): Chosen | null {
  const { rng, regs } = state
  const now = state.history[state.history.length - 1]
  const topStillToCome = state.jobs.slice(state.lines.length + 1).includes('top')
  const forms = formsFor(job)

  for (let tries = 0; tries < MAX_TRIES_PER_LINE; tries++) {
    const form = pickWeighted(rng, forms)
    const assigned = assignRegisters(state, form, job)
    if (assigned === null) continue
    const line = form.build({ rng, x: assigned.x, y: assigned.y, z: assigned.z, now })
    if (line === null) continue
    const after = tryLine(state, line)
    if (after === null) continue
    const x = line.dest.base

    // A later line still needs a register whose top half is not zero.
    if (topStillToCome && !regs.some((reg) => topHalf(after[reg]) !== 0n)) continue

    if (job === 'top') {
      // The low half changes too, so "top half kept" is not simply the old value.
      if ((after[x] & MASK[32]) === (now[x] & MASK[32])) continue
      return { line, after, read: null }
    }

    if (job === 'reads') {
      const target = assigned.target
      const read = line.reads.find((entry) => entry.base === target)
      const old = target === null ? null : valueBeforeLastChange(state, target)
      if (target === null || read === undefined || old === null) continue
      // The old value must give another result, or there is no `stale-value` chip.
      const stale = runAlone(line, { ...shownValues(now, regs), [target]: old })
      if (stale.value === after[x] || stale.wrapped) continue
      return { line, after, read }
    }

    return { line, after, read: null }
  }
  return null
}

interface Plan {
  regs: readonly Reg64[]
  start: Partial<Record<Reg64, bigint>>
  jobs: readonly Job[]
  lines: readonly Line[]
  /** The register name that the 'reads' line reads. */
  read: RegisterInfo
}

function makePlan(rng: Rng): Plan | null {
  const regs = pickRegistersOfProblem(rng)
  const start = startingValues(rng, regs)
  const options: EmulatorOptions = { initialRegisters: start }
  const jobs = planJobs(rng)
  const state: PlanState = {
    rng,
    regs,
    options,
    jobs,
    lines: [],
    history: [runProgram(programSource([]), options).start.registers],
    changes: new Map(),
  }

  let read: RegisterInfo | null = null
  for (let index = 0; index < LINE_COUNT; index++) {
    let chosen = chooseLine(state, jobs[index])
    if (chosen === null && jobs[index] === 'part') {
      // No register has other bits to keep right now: this problem has no 8/16-bit line.
      jobs[index] = 'free'
      chosen = chooseLine(state, 'free')
    }
    if (chosen === null) return null
    if (jobs[index] === 'reads') read = chosen.read
    state.lines.push(chosen.line)
    state.history.push(chosen.after)
    const reg = chosen.line.dest.base
    state.changes.set(reg, [...(state.changes.get(reg) ?? []), index + 1])
  }

  if (read === null) return null
  if (!regs.every((reg) => state.lines.some((line) => usesRegister(line, reg)))) return null
  return { regs, start, jobs, lines: state.lines, read }
}

/* ─────────────────────────────── chips ─────────────────────────────── */

interface Trap {
  label: string
  /** The line (0-based) where this chip stands for the mistake. */
  index: number
  mistake: Mistake | null
}

function chipLabel(reg: Reg64, value: bigint): string {
  return `${reg} = ${show64(value)}`
}

function sizeName(bits: number): string {
  return bits === 8 ? 'an 8-bit name' : `a ${bits}-bit name`
}

/** The register name a line reads, as a word in a sentence: `bl`. */
function code(name: string): string {
  return `\`${name}\``
}

interface Solved {
  plan: Plan
  run: ProgramRun
  /** For each line: the register that changed and its new value (from the emulator). */
  right: readonly { reg: Reg64; value: bigint }[]
}

function solve(plan: Plan): Solved | null {
  const run = runProgram(programSource(plan.lines.map((line) => line.text)), {
    initialRegisters: plan.start,
  })
  const right: { reg: Reg64; value: bigint }[] = []
  for (let index = 0; index < LINE_COUNT; index++) {
    const step = run.steps[index]
    const changed = step.result.diff.registers
    // The plan already ran every line, so this never fails; if it did, try another plan.
    if (changed.length !== 1 || changed[0].reg !== plan.lines[index].dest.base) return null
    right.push({ reg: changed[0].reg, value: step.after.registers[changed[0].reg] })
  }
  return { plan, run, right }
}

/** The 32-bit line with the old top half kept. */
function topTrap(solved: Solved, index: number): Trap | null {
  const { reg, value } = solved.right[index]
  const line = solved.plan.lines[index]
  const old = before(solved.run, index)[reg]
  if (line.dest.size !== 32 || topHalf(old) === 0n) return null
  const kept = (old & ~MASK[32] & MASK[64]) | (value & MASK[32])
  if (kept === value || kept === old) return null
  return {
    label: chipLabel(reg, kept),
    index,
    mistake: {
      code: 'forgot-zero-upper',
      message: `On line ${index + 1} you kept the top half of ${code(reg)}. Writing a 32-bit name such as ${code(line.dest.name)} always clears the top 32 bits.`,
    },
  }
}

/** The line (0-based) that last changed `reg` before line `index`, or -1. */
function lastChangeBefore(solved: Solved, reg: Reg64, index: number): number {
  let found = -1
  for (let earlier = 0; earlier < index; earlier++) {
    if (solved.right[earlier].reg === reg) found = earlier
  }
  return found
}

/** What the 'reads' line depends on, in words: which name, which earlier line, which value. */
interface Dependency {
  /** The line (0-based) that last changed the register before the 'reads' line. */
  changedAt: number
  /** The name as a sentence shows it, in backticks: `bl` (as written in the line), or `rax` (the whole register). */
  name: string
  /** The value of that name right after the earlier line. */
  value: bigint
}

function dependencyOf(solved: Solved, index: number): Dependency | null {
  const { plan, run } = solved
  const line = plan.lines[index]
  const target = plan.read.base
  const changedAt = lastChangeBefore(solved, target, index)
  if (changedAt < 0) return null
  const after = run.steps[changedAt].after.registers[target]
  // `add ah, 8` or `inc dx` keeps the other bits of its own register, so its result
  // depends on the WHOLE register: name the 64-bit register, not just the part.
  const ownPart = line.dest.base === target && (line.dest.size === 8 || line.dest.size === 16)
  return ownPart
    ? { changedAt, name: code(target), value: after }
    : { changedAt, name: code(plan.read.name), value: partValue(after, partOf(plan.read)) }
}

/** The 'reads' line, run again with the value its register had before the earlier change. */
function staleTrap(solved: Solved, index: number): Trap | null {
  const { plan, run } = solved
  const line = plan.lines[index]
  const dependency = dependencyOf(solved, index)
  if (dependency === null) return null
  const target = plan.read.base
  const old = before(run, dependency.changedAt)[target]
  const ran = runAlone(line, { ...shownValues(before(run, index), plan.regs), [target]: old })
  if (ran.value === solved.right[index].value || ran.wrapped) return null
  const stale = ran.value
  const { name, changedAt, value } = dependency
  return {
    label: chipLabel(line.dest.base, stale),
    index,
    mistake: {
      code: 'stale-value',
      message: `On line ${index + 1} you used an old value of ${name}. Line ${changedAt + 1} changed ${name} to ${show(value)}.`,
    },
  }
}

/** The 8-bit or 16-bit line with all the other bits cleared. */
function partTrap(solved: Solved, index: number): Trap | null {
  const { reg, value } = solved.right[index]
  const name = solved.plan.lines[index].dest
  if (name.size !== 8 && name.size !== 16) return null
  const cleared = value & partMask(partOf(name))
  if (cleared === value) return null
  const rule = name.highByte
    ? `Writing ${code(name.name)} changes only bits 15 to 8.`
    : `Writing ${sizeName(name.size)} such as ${code(name.name)} changes only the lowest ${name.size} bits.`
  return {
    label: chipLabel(reg, cleared),
    index,
    mistake: {
      code: 'cleared-upper-wrongly',
      message: `On line ${index + 1} you cleared the other bits of ${code(reg)}. ${rule}`,
    },
  }
}

/**
 * A right value on the wrong register. Best: the register the line reads, as if the
 * result went into the source (`add rbx, rax` → "rax = the sum"). The chip never says
 * what that register really holds after the line.
 */
function wrongRegisterTrap(solved: Solved, rng: Rng, taken: ReadonlySet<string>): Trap | null {
  const { plan, run } = solved
  const candidates: { trap: Trap; fromSource: boolean }[] = []
  plan.lines.forEach((line, index) => {
    const { reg, value } = solved.right[index]
    const after = run.steps[index].after.registers
    const sources = new Set(line.reads.map((read) => read.base).filter((base) => base !== reg))
    for (const other of plan.regs) {
      if (other === reg || after[other] === value) continue
      const label = chipLabel(other, value)
      if (taken.has(label)) continue
      candidates.push({ trap: { label, index, mistake: null }, fromSource: sources.has(other) })
    }
  })
  const best = candidates.filter((candidate) => candidate.fromSource)
  const pool = best.length > 0 ? best : candidates
  return pool.length === 0 ? null : rng.pick(pool).trap
}

/* ─────────────────────────────── words ─────────────────────────────── */

function topSentence(solved: Solved, index: number): string {
  const line = solved.plan.lines[index]
  // "so `rcx` = 0x0", not "so only 0x0 is left": after `xor ecx, ecx` the 0 comes from the
  // xor, and the 32-bit rule is only why the top half is 0 too.
  const base = code(line.dest.base)
  return `Line ${index + 1}: writing ${code(line.dest.name)} (32 bits) also clears the top 32 bits of ${base}, so ${base} = ${show(solved.right[index].value)}.`
}

function partSentence(solved: Solved, index: number): string {
  const name = solved.plan.lines[index].dest
  return name.highByte
    ? `Line ${index + 1}: writing ${code(name.name)} changes only bits 15 to 8 of ${code(name.base)}.`
    : `Line ${index + 1}: writing ${code(name.name)} (${name.size} bits) changes only the lowest ${name.size} bits of ${code(name.base)}.`
}

function readsSentence(index: number, dependency: Dependency): string {
  const { name, changedAt, value } = dependency
  return `Line ${index + 1} uses ${name} after line ${changedAt + 1} changed it to ${show(value)}.`
}

/** The stepper note: watch the two lines that the reason talks about (two different lines). */
function watchNote(solved: Solved, a: number, b: number): string {
  const [first, second] = a < b ? [a, b] : [b, a]
  const one = code(solved.right[first].reg)
  const two = code(solved.right[second].reg)
  return one === two
    ? `Step one line at a time and watch ${one} on lines ${first + 1} and ${second + 1}.`
    : `Step one line at a time and watch ${one} on line ${first + 1} and ${two} on line ${second + 1}.`
}

/* ───────────────────────────── the problem ─────────────────────────── */

function buildProblem(seed: number, rng: Rng, solved: Solved): Problem | null {
  const { plan, right } = solved
  const topAt = plan.jobs.indexOf('top')
  const readsAt = plan.jobs.indexOf('reads')

  const rightLabels = right.map(({ reg, value }) => chipLabel(reg, value))
  if (new Set(rightLabels).size !== LINE_COUNT) return null

  // In the order of the specification: the first one that matches is the one named.
  const top = topTrap(solved, topAt)
  const stale = staleTrap(solved, readsAt)
  const dependency = dependencyOf(solved, readsAt)
  if (top === null || stale === null || dependency === null) return null
  const taken = new Set([...rightLabels, top.label, stale.label])
  if (taken.size !== LINE_COUNT + 2) return null

  // The cleared chip comes from the 'part' line, or else from any 8/16-bit line that
  // keeps other bits (a 'free' line can be one too). A problem with such a line always
  // gets this chip.
  const jobPart = plan.jobs.indexOf('part')
  const partLines = jobPart >= 0 ? [jobPart] : plan.lines.map((_, index) => index)
  const partTraps = partLines
    .map((index) => partTrap(solved, index))
    .filter((trap) => trap !== null)
  const part = partTraps.find((trap) => !taken.has(trap.label)) ?? null
  if ((jobPart >= 0 || partTraps.length > 0) && part === null) return null
  const partAt = part === null ? -1 : part.index
  if (part !== null) taken.add(part.label)
  const named = part === null ? [top, stale] : [top, stale, part]

  const other = wrongRegisterTrap(solved, rng, taken)
  const traps = other === null ? named : [...named, other]
  if (traps.length < 3) return null

  // Shuffle, then number the chips in tray order, so an id says nothing about the answer.
  const labels = rng.shuffle([...rightLabels, ...traps.map((trap) => trap.label)])
  const chips: Chip[] = labels.map((label, index) => ({ id: `chip-${index + 1}`, label }))
  const idOf = (label: string): string => {
    const chip = chips.find((entry) => entry.label === label)
    if (chip === undefined) throw new Error(`homework-table: no chip '${label}'.`)
    return chip.id
  }

  const fields = rightLabels.map((label, index) =>
    chipField(`line${index + 1}`, `Line ${index + 1}`, { id: idOf(label), label }),
  )
  const cells = traps
    .filter((trap) => trap.mistake !== null)
    .map((trap) => ({ fieldId: `line${trap.index + 1}`, chipId: idOf(trap.label), trap }))

  // Two sentences, in line order: the 32-bit rule, then the 8/16-bit rule (or, without
  // such a line, the line that needs a value an earlier line changed).
  const secondAt = partAt >= 0 ? partAt : readsAt
  const sentences = [
    { at: topAt, text: topSentence(solved, topAt) },
    {
      at: secondAt,
      text: partAt >= 0 ? partSentence(solved, partAt) : readsSentence(readsAt, dependency),
    },
  ]
  const reason = sentences
    .sort((a, b) => a.at - b.at)
    .map((sentence) => sentence.text)
    .join(' ')

  return {
    id: `homework-table-${seed}`,
    topic: 'homework-table',
    seed,
    view: 'trace-table',
    prompt: [
      textBlock(QUESTION),
      registersBlock(
        plan.regs.map((reg) => ({ name: reg, value: plan.start[reg] ?? 0n })),
        { title: 'Starting values' },
      ),
      codeBlock(plan.lines.map((line) => line.text)),
    ],
    fields,
    chips,
    reason,
    stepper: {
      code: programSource(plan.lines.map((line) => line.text)),
      options: { initialRegisters: { ...plan.start } },
      note: watchNote(solved, topAt, secondAt),
    },
    diagnose(answers) {
      const found = cells.find((cell) => answers[cell.fieldId] === cell.chipId)
      return found?.trap.mistake ?? null
    },
  }
}

export const generate: ProblemGenerator = (seed) => {
  const rng = createRng(seed)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const plan = makePlan(rng)
    const solved = plan === null ? null : solve(plan)
    const problem = solved === null ? null : buildProblem(seed, rng, solved)
    if (problem !== null) return problem
  }
  throw new Error(`homework-table: no problem could be made for seed ${seed}.`)
}
