/**
 * Property tests for the `Emulator`, written from the inside (white-box review of M2).
 *
 * A seeded generator writes random programs from the whole supported set:
 *
 * - STRUCTURED programs: a real prologue, locals through rbp, rsp and `.equ` names,
 *   `.data` variables, balanced push/pop, small helper functions (some call each other),
 *   loops with a bounded counter, and library calls (printf, puts, putchar, scanf, exit)
 *   with right and wrong arguments;
 * - FLAGS programs: short runs of imul, compares and conditional jumps (often a jump
 *   before anything wrote the flags), with library calls in between;
 * - WILD programs: random registers used as addresses, unbalanced pushes and pops, jumps
 *   and calls to any label, return addresses that no `call` saved, writes to read-only
 *   memory, reads of the code, rsp and rbp overwritten, odd starting options (the
 *   practice "small world", given registers, flags and memory).
 *
 * Every property is checked on every program (test 0b makes sure the programs really
 * reach every instruction, library function, run-time error and note). Nothing here uses
 * Math.random: the same seeds always give the same programs, so a failure can be
 * reproduced. A failing property prints its first problems and the source of the first
 * program that broke it.
 */
import { describe, expect, it } from 'vitest'
import {
  assemble,
  createEmulator,
  DEFAULT_OPTIONS,
  Emulator,
  FLAG_NAMES,
  isJumpCondition,
  LIBRARY_FUNCTIONS,
  MNEMONICS,
  REG64_NAMES,
  type EmulatorOptions,
  type MachineState,
  type Mnemonic,
  type OperandSize,
  type Program,
  type Reg64,
  type RunStopReason,
  type RuntimeCode,
  type StackSlot,
  type Status,
  type StepResult,
} from './index'

/* ───────────────────────────── Seeded random numbers ───────────────────────────── */

/** mulberry32: small, fast, and the same numbers on every machine. */
class Random {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  /** 0 ≤ result < 1 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** A whole number in low … high (both included). */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1))
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)]
    if (item === undefined) throw new Error('pick() from an empty list')
    return item
  }

  /** A bigint in low … high (both included). */
  big(low: bigint, high: bigint): bigint {
    let bits = 0n
    for (let i = 0; i < 3; i++) bits = (bits << 32n) | BigInt(Math.floor(this.next() * 2 ** 32))
    return low + (bits % (high - low + 1n))
  }

  /** Up to `count` different items of `items`. */
  sample<T>(items: readonly T[], count: number): T[] {
    const rest = [...items]
    const chosen: T[] = []
    while (chosen.length < count && rest.length > 0) {
      chosen.push(...rest.splice(Math.floor(this.next() * rest.length), 1))
    }
    return chosen
  }
}

/* ───────────────────────────── Registers and operands ───────────────────────────── */

const TWO_31 = 1n << 31n
const TWO_63 = 1n << 63n
const TWO_64 = 1n << 64n
const MASK64 = TWO_64 - 1n

const ALL64: readonly Reg64[] = REG64_NAMES
/** The registers a function may change freely (caller-saved). */
const SCRATCH: readonly Reg64[] = ['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11']
/** What main changes: the scratch registers and r13–r15 (rbx and r12 are loop counters). */
const MAIN_DESTINATIONS: readonly Reg64[] = [...SCRATCH, 'r13', 'r14', 'r15']
const LEGACY: readonly Reg64[] = ['rax', 'rcx', 'rdx', 'rbx']
const EXTENDED: ReadonlySet<Reg64> = new Set<Reg64>([
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
  'r15',
])

/** The 32-, 16- and 8-bit names of each register. */
const PARTS: Readonly<Record<Reg64, readonly [string, string, string]>> = {
  rax: ['eax', 'ax', 'al'],
  rcx: ['ecx', 'cx', 'cl'],
  rdx: ['edx', 'dx', 'dl'],
  rbx: ['ebx', 'bx', 'bl'],
  rsp: ['esp', 'sp', 'spl'],
  rbp: ['ebp', 'bp', 'bpl'],
  rsi: ['esi', 'si', 'sil'],
  rdi: ['edi', 'di', 'dil'],
  r8: ['r8d', 'r8w', 'r8b'],
  r9: ['r9d', 'r9w', 'r9b'],
  r10: ['r10d', 'r10w', 'r10b'],
  r11: ['r11d', 'r11w', 'r11b'],
  r12: ['r12d', 'r12w', 'r12b'],
  r13: ['r13d', 'r13w', 'r13b'],
  r14: ['r14d', 'r14w', 'r14b'],
  r15: ['r15d', 'r15w', 'r15b'],
}

const HIGH: Readonly<Record<Reg64, string | null>> = {
  rax: 'ah',
  rcx: 'ch',
  rdx: 'dh',
  rbx: 'bh',
  rsp: null,
  rbp: null,
  rsi: null,
  rdi: null,
  r8: null,
  r9: null,
  r10: null,
  r11: null,
  r12: null,
  r13: null,
  r14: null,
  r15: null,
}

const PTR: Readonly<Record<OperandSize, string>> = {
  8: 'byte ptr',
  16: 'word ptr',
  32: 'dword ptr',
  64: 'qword ptr',
}

/** Every spelling of every conditional jump. */
const CONDITIONS = [
  'je',
  'jz',
  'jne',
  'jnz',
  'jg',
  'jnle',
  'jge',
  'jnl',
  'jl',
  'jnge',
  'jle',
  'jng',
  'ja',
  'jnbe',
  'jae',
  'jnb',
  'jnc',
  'jb',
  'jnae',
  'jc',
  'jbe',
  'jna',
  'js',
  'jns',
  'jo',
  'jno',
] as const

interface Reg {
  text: string
  base: Reg64
  size: OperandSize
  high: boolean
  /** Using this name needs a REX prefix (it cannot share a line with ah, bh, ch, dh). */
  rex: boolean
}

function regInfo(base: Reg64, size: OperandSize, high = false): Reg {
  const highName = size === 8 && high ? HIGH[base] : null
  let text: string = base
  if (highName !== null) text = highName
  else if (size !== 64) text = PARTS[base][size === 32 ? 0 : size === 16 ? 1 : 2]
  const lowByteRex = size === 8 && highName === null && (base === 'rsi' || base === 'rdi')
  const stackByteRex = size === 8 && (base === 'rsp' || base === 'rbp')
  return {
    text,
    base,
    size,
    high: highName !== null,
    rex: EXTENDED.has(base) || lowByteRex || stackByteRex,
  }
}

/** A number as a student writes it: decimal or hex, with a minus sign when negative. */
function numberText(rng: Random, value: bigint): string {
  const magnitude = value < 0n ? -value : value
  const digits = rng.chance(0.5) ? `0x${magnitude.toString(16)}` : magnitude.toString()
  return value < 0n ? `-${digits}` : digits
}

/* ───────────────────────────── The program generator ───────────────────────────── */

type ProgramKind = 'structured' | 'flags' | 'wild'

interface Generated {
  id: string
  kind: ProgramKind
  source: string
  options: EmulatorOptions
  /** Text for `provideInput`, one entry each time the program waits for input. */
  input: readonly string[]
}

/** Where an instruction is written: this decides which memory it may touch. */
interface Place {
  /** main and helper have a frame of `frame` bytes below rbp; leaf has none; wild: anything. */
  kind: 'main' | 'helper' | 'leaf' | 'wild'
  frame: number
  /** rsp is at the bottom of the frame (no push in progress), so `[rsp+k]` is a local. */
  rspFrame: boolean
  /** A loop counter that holds 0 … 4 right now, for `arr[counter*8]`. */
  counter: Reg64 | null
}

/** The memory of every program: `.data` ends with padding, so a too-wide read stays inside. */
const DATA_LINES = [
  '.data',
  'x: .quad 5',
  'y: .long -3',
  'z: .word 7',
  'w: .byte 9',
  'arr: .quad 1, 2, 3, 4',
  'buf: .zero 32',
  'pad: .zero 64',
]

const DATA_OPERANDS: Readonly<Record<OperandSize, readonly string[]>> = {
  64: ['x[rip]', 'arr[rip]', 'arr+8[rip]', 'arr+24[rip]', 'buf+8[rip]'],
  32: ['y[rip]', 'arr+4[rip]', 'buf[rip]', 'x+4[rip]'],
  16: ['z[rip]', 'buf+2[rip]', 'arr+6[rip]'],
  8: ['w[rip]', 'buf+1[rip]', 'arr+7[rip]', 'x[rip]'],
}

const BARE_DATA: Readonly<Record<OperandSize, string>> = { 64: 'x', 32: 'y', 16: 'z', 8: 'w' }

/** `.equ VA, -8`, `.equ VB, -16`, `.equ VC, -24` (main's frame is at least 32 bytes). */
const EQU_OPERANDS: Readonly<Record<OperandSize, readonly string[]>> = {
  64: ['VA[rbp]', '[rbp+VB]', 'VC[rbp]'],
  32: ['VA[rbp]', 'VA+4[rbp]', '[rbp+VC]'],
  16: ['VA[rbp]', 'VA+6[rbp]', 'VC+2[rbp]'],
  8: ['VA[rbp]', 'VA+7[rbp]', 'VB+3[rbp]'],
}

type ArgKind = 'int' | 'long' | 'char' | 'text'

interface PrintfFormat {
  label: string
  text: string
  args: readonly ArgKind[]
}

const PRINTF_FORMATS: readonly PrintfFormat[] = [
  { label: 'p_hello', text: 'hello\\n', args: [] },
  { label: 'p_d', text: '%d\\n', args: ['int'] },
  { label: 'p_xu', text: 'x=%x u=%u\\n', args: ['int', 'int'] },
  { label: 'p_long', text: '%ld %lx %lu\\n', args: ['long', 'long', 'long'] },
  { label: 'p_chars', text: '[%c%c]\\n', args: ['char', 'char'] },
  { label: 'p_str', text: '%s|%5s|%-4s|\\n', args: ['text', 'text', 'text'] },
  { label: 'p_width', text: '%5d|%-5d|%05d|%+d\\n', args: ['int', 'int', 'int', 'int'] },
  { label: 'p_pct', text: '100%% %i\\n', args: ['int'] },
  { label: 'p_mix', text: '%hhd %hd %p %X\\n', args: ['int', 'int', 'long', 'int'] },
  // Seven values: the last two come from the stack.
  { label: 'p_seven', text: '%d %d %d %d %d %d %d\\n', args: ['int', 'int', 'int', 'int', 'int'] },
  { label: 'p_utf', text: 'héllo wörld %d\\n', args: ['int'] },
]

/** Formats that stop the program: an unknown item, `%s` with a number, a lone `%`. */
const WRONG_PRINTF: readonly PrintfFormat[] = [
  { label: 'p_float', text: 'pi=%f\\n', args: ['int'] },
  { label: 'p_sbad', text: '[%s]\\n', args: ['int'] },
  { label: 'p_lone', text: '50%', args: [] },
]

interface ScanfFormat {
  label: string
  text: string
  places: readonly ('local' | 'local2' | 'buffer')[]
  input: 'number' | 'char' | 'two' | 'word' | 'hex'
}

const SCANF_FORMATS: readonly ScanfFormat[] = [
  { label: 'q_d', text: '%d', places: ['local'], input: 'number' },
  { label: 'q_ld', text: '%ld', places: ['local'], input: 'number' },
  { label: 'q_c', text: ' %c', places: ['local'], input: 'char' },
  { label: 'q_dd', text: '%d %d', places: ['local', 'local2'], input: 'two' },
  { label: 'q_s', text: '%s', places: ['buffer'], input: 'word' },
  { label: 'q_x', text: '%x', places: ['local'], input: 'hex' },
]

/** Text for `%s` and puts. The long one comes last, so a too-wide read stays inside. */
const TEXT_LINES = [
  's_abc: .string "abc"',
  's_utf: .string "dé"',
  's_long: .string "a longer string at the end of the read-only data"',
]
const TEXT_LABELS = ['s_abc', 's_utf', 's_long']

const STRING_LINES = [...PRINTF_FORMATS, ...WRONG_PRINTF, ...SCANF_FORMATS].map(
  (format) => `${format.label}: .string "${format.text}"`,
)

const ARGUMENT_REGISTERS: readonly Reg64[] = ['rsi', 'rdx', 'rcx', 'r8', 'r9']

const ALU_OPS = [
  'mov',
  'mov',
  'mov',
  'mov',
  'add',
  'add',
  'sub',
  'sub',
  'and',
  'or',
  'xor',
  'cmp',
  'cmp',
  'test',
  'inc',
  'dec',
  'imul',
  'imul',
  'movzx',
  'movsx',
  'lea',
  'lea',
  'nop',
] as const

type TwoOperandOp = 'mov' | 'add' | 'sub' | 'and' | 'or' | 'xor' | 'cmp' | 'test'

/** Ways to break rsp and rbp in a wild program. */
const RSP_GAMES = [
  'mov rsp, rax',
  'xor esp, esp',
  'lea rsp, [rsp-8]',
  'and rsp, -16',
  'sub rsp, 0x200000',
  'add rsp, 8',
  'mov rbp, rsp',
  'mov rbp, 0',
  'mov rsp, rbp',
  'add rsp, 0x2000',
]

/** The tiny machine of the practice problems (`smallWorld()` in practice/gen/helpers.ts). */
const SMALL_WORLD = {
  textBase: 0x4000n,
  rodataBase: 0x6000n,
  dataBase: 0x7000n,
  stackBase: 0x1000n,
  stackSize: 0xfc0,
  initialRsp: 0x200n,
  osReturnAddress: 0x3ff0n,
} as const

/** The instruction writer shared by all kinds of program. */
class Gen {
  readonly rng: Random

  constructor(seed: number) {
    this.rng = new Random(seed)
  }

  size(): OperandSize {
    const roll = this.rng.next()
    if (roll < 0.35) return 64
    if (roll < 0.7) return 32
    if (roll < 0.8) return 16
    return 8
  }

  /** A register of `size` bits from `pool`. `noRex`: one that can share a line with ah. */
  reg(
    pool: readonly Reg64[],
    size: OperandSize,
    options: { high?: boolean; noRex?: boolean } = {},
  ): Reg {
    const usable =
      options.noRex === true
        ? pool.filter((base) => !EXTENDED.has(base) && (size !== 8 || HIGH[base] !== null))
        : pool
    const base = this.rng.pick(usable.length > 0 ? usable : LEGACY)
    const high = options.high === true && size === 8 && HIGH[base] !== null && this.rng.chance(0.35)
    return regInfo(base, size, high)
  }

  /** A number that fits. 'any' is for `mov r64, imm`; 'signed32' for the other 64-bit forms. */
  imm(size: OperandSize, rule: 'any' | 'signed32' = 'signed32'): string {
    const { rng } = this
    let value: bigint
    if (size === 8) value = BigInt(rng.int(-128, 255))
    else if (size === 16)
      value = BigInt(rng.chance(0.5) ? rng.int(-128, 127) : rng.int(-32768, 65535))
    else if (size === 32) {
      value = rng.chance(0.5) ? BigInt(rng.int(-100, 100)) : rng.big(-TWO_31, 2n ** 32n - 1n)
    } else if (rule === 'any') {
      value = rng.pick([
        rng.big(-TWO_63, MASK64),
        BigInt(rng.int(-1000, 1000)),
        TWO_63,
        TWO_63 - 1n,
        MASK64,
        -1n,
      ])
    } else {
      value = rng.pick([
        BigInt(rng.int(-1000, 1000)),
        rng.big(-TWO_31, TWO_31 - 1n),
        TWO_64 - BigInt(rng.int(1, 1000)),
      ])
    }
    return numberText(rng, value)
  }

  /** Any address at all, built from random registers (wild programs, and `lea`). */
  wildAddress(noRex: boolean): string {
    const { rng } = this
    const pool = noRex ? ALL64.filter((base) => !EXTENDED.has(base)) : ALL64
    const base = rng.pick(pool)
    const index = rng.pick(pool.filter((name) => name !== 'rsp'))
    const scale = rng.pick([1, 2, 4, 8])
    const disp = rng.pick([0, 8, -8, 16, 100, -4096, 4096])
    const signed = disp < 0 ? `${disp}` : `+${disp}`
    switch (rng.int(0, 3)) {
      case 0:
        return `[${base}]`
      case 1:
        return `[${base}${signed}]`
      case 2:
        return `[${base}+${index}*${scale}]`
      default:
        return `[${base}+${index}*${scale}${signed}]`
    }
  }

  /** A memory operand of `size` bits that is safe to use in `place`. */
  memory(
    place: Place,
    size: OperandSize,
    ptr: 'always' | 'maybe' | 'never',
    noRex = false,
  ): string {
    const { rng } = this
    const bytes = size / 8
    const choices: (() => string)[] = [
      () => (ptr !== 'always' && rng.chance(0.2) ? BARE_DATA[size] : rng.pick(DATA_OPERANDS[size])),
    ]
    const { kind, frame, counter } = place
    if (kind === 'main' || kind === 'helper') {
      choices.push(() => `[rbp-${bytes * rng.int(1, frame / bytes)}]`)
      if (place.rspFrame) {
        choices.push(() => {
          const offset = bytes * rng.int(0, frame / bytes - 1)
          if (offset === 0) return '[rsp]'
          return rng.chance(0.5) ? `[rsp+${offset}]` : `${offset}[rsp]`
        })
      }
    }
    if (kind === 'main') choices.push(() => rng.pick(EQU_OPERANDS[size]))
    if (counter !== null && size === 64 && !(noRex && EXTENDED.has(counter))) {
      choices.push(() => `arr[${counter}*8]`)
    }
    if (kind === 'wild') {
      choices.push(
        () => this.wildAddress(noRex),
        () => this.wildAddress(noRex),
        () => `[rbp-${8 * rng.int(1, 8)}]`,
        () => `[rsp+${8 * rng.int(0, 4)}]`,
      )
    }
    const text = rng.pick(choices)()
    const bare = /^[a-z]+$/.test(text)
    const sized = ptr === 'always' || (ptr === 'maybe' && rng.chance(0.4))
    return sized && !bare ? `${PTR[size]} ${text}` : text
  }

  twoOperandLine(op: TwoOperandOp, place: Place, destinations: readonly Reg64[]): string {
    const { rng } = this
    const size = this.size()
    const compares = op === 'cmp' || op === 'test'
    const destination = this.reg(compares ? ALL64 : destinations, size, { high: true })
    const noRex = destination.high
    switch (rng.pick(['rr', 'ri', 'rm', 'mr', 'mi'] as const)) {
      case 'rr': {
        const source = this.reg(ALL64, size, { high: !destination.rex, noRex })
        return `${op} ${destination.text}, ${source.text}`
      }
      case 'ri':
        return `${op} ${destination.text}, ${this.imm(size, op === 'mov' ? 'any' : 'signed32')}`
      case 'rm':
        return `${op} ${destination.text}, ${this.memory(place, size, 'maybe', noRex)}`
      case 'mr': {
        const source = this.reg(ALL64, size, { high: true })
        return `${op} ${this.memory(place, size, 'maybe', source.high)}, ${source.text}`
      }
      case 'mi':
        return `${op} ${this.memory(place, size, 'always')}, ${this.imm(size)}`
    }
  }

  extendLine(op: 'movzx' | 'movsx', place: Place, destinations: readonly Reg64[]): string {
    const { rng } = this
    const size = rng.pick([16, 32, 32, 64, 64] as const)
    let sources: OperandSize[] = [8, 16]
    if (size === 16) sources = [8]
    else if (size === 64 && op === 'movsx') sources = [8, 16, 32]
    const sourceSize = rng.pick(sources)
    const destination = this.reg(destinations, size)
    if (rng.chance(0.5)) {
      // A memory source always needs its size.
      return `${op} ${destination.text}, ${this.memory(place, sourceSize, 'always')}`
    }
    const source = this.reg(ALL64, sourceSize, { high: size !== 64 && !destination.rex })
    const written = op === 'movsx' && sourceSize === 32 && rng.chance(0.5) ? 'movsxd' : op
    return `${written} ${destination.text}, ${source.text}`
  }

  /** One data instruction (mov, arithmetic, logic, compares, imul, movzx/movsx, lea, nop). */
  aluLine(place: Place, destinations: readonly Reg64[]): string {
    const { rng } = this
    const op = rng.pick(ALU_OPS)
    switch (op) {
      case 'nop':
        return rng.pick(['nop', 'endbr64'])
      case 'inc':
      case 'dec':
        if (rng.chance(0.6))
          return `${op} ${this.reg(destinations, this.size(), { high: true }).text}`
        return `${op} ${this.memory(place, this.size(), 'always')}`
      case 'imul': {
        const size = rng.pick([16, 32, 64] as const)
        const destination = this.reg(destinations, size).text
        const form = rng.int(0, 2)
        if (form === 0) return `imul ${destination}, ${this.reg(ALL64, size).text}`
        if (form === 1) return `imul ${destination}, ${this.memory(place, size, 'maybe')}`
        return `imul ${destination}, ${this.imm(size)}`
      }
      case 'movzx':
      case 'movsx':
        return this.extendLine(op, place, destinations)
      case 'lea': {
        const size = rng.pick([16, 32, 64, 64] as const)
        const destination = this.reg(destinations, size).text
        const source = rng.chance(0.3) ? this.wildAddress(false) : this.memory(place, 64, 'never')
        return `lea ${destination}, ${source}`
      }
      default:
        return this.twoOperandLine(op, place, destinations)
    }
  }

  compareLine(place: Place): string {
    return this.twoOperandLine(this.rng.pick(['cmp', 'test'] as const), place, ALL64)
  }

  /** One or two lines of a wild program. */
  wildLines(place: Place, labels: readonly string[]): string[] {
    const { rng } = this
    const roll = rng.next()
    const target = rng.pick(labels)
    if (roll < 0.41) return [this.aluLine(place, ALL64)]
    if (roll < 0.53) {
      const base = rng.pick(ALL64)
      return [
        rng.pick([`push ${base}`, `push ${this.imm(64)}`, `pop ${base}`, 'push rsp', 'pop rsp']),
      ]
    }
    if (roll < 0.66) {
      return [
        rng.pick([
          `jmp ${target}`,
          `${rng.pick(CONDITIONS)} ${target}`,
          `call ${target}`,
          'ret',
          'leave',
          `mov qword ptr [rsp], offset ${target}`,
        ]),
      ]
    }
    // A return address that no `call` saved: `ret` jumps there with a warning.
    if (roll < 0.69) return [`push offset ${target}`, 'ret']
    if (roll < 0.75) return [rng.pick(RSP_GAMES)]
    if (roll < 0.78) {
      // Reading the code of the program (it reads 0, with a warning).
      return rng.pick([
        [`mov eax, dword ptr ${target}`],
        [`lea rbx, ${target}[rip]`, 'mov rax, qword ptr [rbx]'],
      ])
    }
    if (roll < 0.8) {
      // Writing to read-only data or to the code.
      return rng.pick([
        ['mov byte ptr s_abc[rip], 65'],
        ['add dword ptr p_d[rip], 1'],
        [`lea rbx, ${target}[rip]`, 'mov qword ptr [rbx], rax'],
      ])
    }
    if (roll < 0.9) {
      const setup = rng.pick([
        'lea rdi, p_d[rip]',
        'lea rdi, p_str[rip]',
        'lea rdi, q_d[rip]',
        'lea rdi, q_s[rip]',
        'mov rdi, rax',
        'mov edi, 65',
        'lea rdi, s_abc[rip]',
        'mov rdi, p_d',
        'lea rsi, buf[rip]',
        '',
      ])
      const call = rng.pick([
        'call printf@PLT',
        'call puts',
        'call putchar',
        'call scanf@PLT',
        'call exit@PLT',
        'call printf',
      ])
      return setup === '' ? [call] : [setup, call]
    }
    return [this.aluLine(place, ALL64)]
  }
}

/** Indent instructions; labels stay at the start of the line. */
function layout(lines: readonly string[]): string[] {
  return lines.map((line) => (line.endsWith(':') ? line : `    ${line}`))
}

function header(rodata: string): string[] {
  return [
    '.intel_syntax noprefix',
    '.equ VA, -8',
    '.equ VB, -16',
    '.equ VC, -24',
    ...DATA_LINES,
    rodata,
    ...STRING_LINES,
    ...TEXT_LINES,
    '.text',
    '.globl main',
  ]
}

/** A program a student could write: frames, locals, helpers, loops and library calls. */
class StructuredWriter {
  readonly gen: Gen
  readonly rng: Random
  readonly frame: number
  readonly helperCount: number
  readonly inputMode: 'stdin' | 'provide' | 'none' | 'bad'
  readonly stdin: string[] = []
  readonly provided: string[] = []
  private labels = 0

  constructor(seed: number) {
    this.gen = new Gen(seed)
    this.rng = this.gen.rng
    this.frame = this.rng.pick([32, 48])
    this.helperCount = this.rng.int(0, 3)
    this.inputMode = this.rng.pick(['stdin', 'stdin', 'provide', 'bad', 'none'] as const)
  }

  fresh(prefix: string): string {
    this.labels += 1
    return `${prefix}${this.labels}`
  }

  alu(out: string[], place: Place, destinations: readonly Reg64[], count: number): void {
    for (let i = 0; i < count; i++) out.push(this.gen.aluLine(place, destinations))
  }

  argument(register: Reg64, kind: ArgKind): string {
    const { rng, gen } = this
    const half = regInfo(register, 32).text
    switch (kind) {
      case 'int':
        return rng.pick([
          `mov ${half}, ${gen.imm(32)}`,
          `mov ${half}, eax`,
          `mov ${half}, dword ptr [rbp-4]`,
        ])
      case 'long':
        return rng.pick([
          `mov ${register}, ${gen.imm(64, 'any')}`,
          `mov ${register}, qword ptr [rbp-8]`,
          `mov ${register}, rax`,
        ])
      case 'char':
        return `mov ${half}, ${rng.pick(['65', "'Z'", '10', '0x61', '33'])}`
      case 'text':
        return `lea ${register}, ${rng.pick(TEXT_LABELS)}[rip]`
    }
  }

  printf(out: string[]): void {
    const { rng } = this
    // Sometimes the stack is not lined up at the call (a warning note).
    const misaligned = rng.chance(0.1)
    if (misaligned) out.push('push rax')
    const format = rng.chance(0.12) ? rng.pick(WRONG_PRINTF) : rng.pick(PRINTF_FORMATS)
    format.args.forEach((kind, position) => {
      const register = ARGUMENT_REGISTERS[position]
      if (register !== undefined) out.push(this.argument(register, kind))
    })
    // `mov` where `lea` was needed, now and then.
    out.push(rng.chance(0.08) ? `mov rdi, ${format.label}` : `lea rdi, ${format.label}[rip]`)
    const zero = rng.pick(['mov eax, 0', 'xor eax, eax', ''])
    if (zero !== '') out.push(zero)
    out.push(rng.pick(['call printf@PLT', 'call printf']))
    if (misaligned) out.push('pop rcx')
  }

  scanf(out: string[]): void {
    const { rng } = this
    const format = rng.pick(SCANF_FORMATS)
    const wrongPlace = rng.chance(0.1)
    format.places.forEach((place, position) => {
      const register = ARGUMENT_REGISTERS[position] ?? 'rsi'
      if (wrongPlace && position === 0) out.push(`mov ${register}, qword ptr [rbp-8]`)
      else if (place === 'buffer') out.push(`lea ${register}, buf[rip]`)
      else if (place === 'local') {
        out.push(rng.pick([`lea ${register}, [rbp-8]`, `lea ${register}, VA[rbp]`]))
      } else out.push(`lea ${register}, [rbp-16]`)
    })
    out.push(
      `lea rdi, ${format.label}[rip]`,
      'mov eax, 0',
      rng.pick(['call scanf@PLT', 'call __isoc99_scanf@PLT', 'call scanf']),
    )
    let text: string
    switch (format.input) {
      case 'number':
        text = String(rng.int(-1000, 1000))
        break
      case 'char':
        text = 'Q'
        break
      case 'two':
        text = `${rng.int(-9, 99)} ${rng.int(0, 9)}`
        break
      case 'word':
        text = rng.pick(['word', 'héllo', 'x'])
        break
      case 'hex':
        text = rng.pick(['ff', '0x1F', '7'])
        break
    }
    if (this.inputMode === 'stdin') this.stdin.push(text)
    else if (this.inputMode === 'provide') this.provided.push(text)
    else if (this.inputMode === 'bad') this.stdin.push(rng.pick(['oops', 'x1', '-']))
  }

  putchar(out: string[]): void {
    out.push(`mov edi, ${this.rng.pick(['65', '10', "'z'", '0x41', '300'])}`, 'call putchar@PLT')
  }

  library(out: string[], allowScanf: boolean): void {
    const { rng } = this
    const roll = rng.next()
    if (roll < 0.55) this.printf(out)
    else if (roll < 0.7) {
      out.push(`lea rdi, ${rng.pick(TEXT_LABELS)}[rip]`, rng.pick(['call puts@PLT', 'call puts']))
    } else if (roll < 0.9 || !allowScanf) this.putchar(out)
    else this.scanf(out)
  }

  pushPop(out: string[], place: Place, destinations: readonly Reg64[]): void {
    const { rng, gen } = this
    const pushed: (Reg64 | null)[] = []
    for (let count = rng.int(1, 3); count > 0; count--) {
      if (rng.chance(0.75)) {
        const base = rng.pick(ALL64)
        pushed.push(base)
        out.push(`push ${base}`)
      } else {
        pushed.push(null)
        out.push(`push ${gen.imm(64)}`)
      }
    }
    this.alu(out, { ...place, rspFrame: false }, destinations, rng.int(0, 2))
    // Pop into the same registers in reverse order (restore), or into scratch registers.
    const restore = pushed.every((base) => base !== null) && rng.chance(0.5)
    for (const base of [...pushed].reverse()) {
      out.push(restore && base !== null ? `pop ${base}` : `pop ${rng.pick(destinations)}`)
    }
  }

  ifBlock(out: string[], place: Place, destinations: readonly Reg64[]): void {
    const { rng, gen } = this
    const skip = this.fresh('skip')
    const roll = rng.next()
    if (roll < 0.15) {
      // imul right before a jump: the warning note about ZF and SF.
      const destination = regInfo(rng.pick(destinations), 32).text
      out.push(`imul ${destination}, ${regInfo(rng.pick(ALL64), 32).text}`)
    } else if (roll < 0.55) out.push(gen.compareLine(place))
    else out.push(gen.aluLine(place, destinations))
    out.push(`${rng.pick(CONDITIONS)} ${skip}`)
    this.alu(out, place, destinations, rng.int(1, 3))
    if (rng.chance(0.3)) {
      const end = this.fresh('end')
      out.push(`jmp ${end}`, `${skip}:`)
      this.alu(out, place, destinations, rng.int(1, 2))
      out.push(`${end}:`)
    } else out.push(`${skip}:`)
  }

  loop(out: string[]): void {
    const { rng } = this
    const variant = rng.int(0, 2)
    const counter: Reg64 = variant === 1 ? 'r12' : 'rbx'
    const turns = rng.int(1, 4)
    const top = this.fresh('loop')
    const place: Place = { kind: 'main', frame: this.frame, rspFrame: true, counter }
    out.push(variant === 1 ? 'xor r12d, r12d' : `mov ${rng.pick(['ebx', 'rbx'])}, ${turns}`)
    out.push(`${top}:`)
    this.alu(out, place, MAIN_DESTINATIONS, rng.int(1, 3))
    if (rng.chance(0.3)) this.library(out, false)
    if (this.helperCount > 0 && rng.chance(0.3)) {
      out.push(`call helper${rng.int(0, this.helperCount - 1)}`)
    }
    if (rng.chance(0.2)) this.ifBlock(out, place, MAIN_DESTINATIONS)
    if (variant === 0) out.push('dec ebx', `${rng.pick(['jnz', 'jne'])} ${top}`)
    else if (variant === 1) {
      out.push('inc r12d', `cmp r12d, ${turns}`, `${rng.pick(['jl', 'jb', 'jnge', 'jc'])} ${top}`)
    } else out.push('sub ebx, 1', `${rng.pick(['ja', 'jnbe', 'jg', 'jnle'])} ${top}`)
  }

  helper(index: number): string[] {
    const { rng } = this
    const out = [`helper${index}:`]
    const later = this.helperCount - index - 1
    if (rng.chance(0.7)) {
      const place: Place = { kind: 'helper', frame: 16, rspFrame: true, counter: null }
      if (rng.chance(0.3)) out.push('endbr64')
      out.push('push rbp', 'mov rbp, rsp', 'sub rsp, 16')
      this.alu(out, place, SCRATCH, rng.int(1, 4))
      if (later > 0 && rng.chance(0.4)) out.push(`call helper${index + rng.int(1, later)}`)
      if (rng.chance(0.25)) this.library(out, false)
      if (rng.chance(0.5)) out.push('leave')
      else out.push('mov rsp, rbp', 'pop rbp')
    } else {
      // A leaf function without a frame: it only touches registers and `.data`.
      this.alu(
        out,
        { kind: 'leaf', frame: 0, rspFrame: false, counter: null },
        SCRATCH,
        rng.int(1, 3),
      )
      if (rng.chance(0.15)) this.putchar(out)
    }
    out.push('ret')
    return out
  }

  build(id: string): Generated {
    const { rng, gen } = this
    const place: Place = { kind: 'main', frame: this.frame, rspFrame: true, counter: null }
    const main = ['main:']
    if (rng.chance(0.3)) main.push('endbr64')
    main.push('push rbp', 'mov rbp, rsp', `sub rsp, ${this.frame}`)
    if (rng.chance(0.7))
      main.push('mov qword ptr [rbp-8], 0', `mov dword ptr [rbp-4], ${gen.imm(32)}`)
    let loops = 0
    for (let blocks = rng.int(3, 8); blocks > 0; blocks--) {
      const roll = rng.next()
      if (roll < 0.3) this.alu(main, place, MAIN_DESTINATIONS, rng.int(1, 5))
      else if (roll < 0.4) this.pushPop(main, place, MAIN_DESTINATIONS)
      else if (roll < 0.52) this.ifBlock(main, place, MAIN_DESTINATIONS)
      else if (roll < 0.64 && loops < 2) {
        loops += 1
        this.loop(main)
      } else if (roll < 0.76 && this.helperCount > 0) {
        main.push(`call helper${rng.int(0, this.helperCount - 1)}`)
      } else this.library(main, true)
    }
    const ending = rng.next()
    if (ending < 0.08) main.push(`mov edi, ${rng.int(0, 9)}`, 'call exit@PLT', 'leave', 'ret')
    else if (ending < 0.4) main.push(`mov eax, ${gen.imm(32)}`, 'leave', 'ret')
    else if (ending < 0.7) main.push('xor eax, eax', 'mov rsp, rbp', 'pop rbp', 'ret')
    else main.push(`mov eax, ${rng.int(0, 255)}`, `add rsp, ${this.frame}`, 'pop rbp', 'ret')

    const helpers: string[] = []
    for (let index = 0; index < this.helperCount; index++) helpers.push(...this.helper(index))

    const rodata = rng.chance(0.5) ? '.section .rodata' : '.text'
    const source = [...header(rodata), ...layout(main), ...layout(helpers), ''].join('\n')
    const options: EmulatorOptions = rng.chance(0.2)
      ? { ...SMALL_WORLD, clobberCallerSaved: false }
      : {}
    if (this.stdin.length > 0) options.stdin = this.stdin.map((line) => `${line}\n`).join('')
    return { id, kind: 'structured', source, options, input: this.provided }
  }
}

/** Short runs of imul, compares and jumps (forward only), with library calls in between. */
function flagsProgram(seed: number): Generated {
  const gen = new Gen(seed)
  const { rng } = gen
  const body = ['main:']
  const pending: string[] = []
  let labels = 0
  const jump = (): void => {
    const label = `F${labels++}`
    pending.push(label)
    body.push(`${rng.pick(CONDITIONS)} ${label}`)
  }
  // Half of them jump before any instruction wrote the flags.
  if (rng.chance(0.5)) jump()
  for (let count = rng.int(6, 18); count > 0; count--) {
    const waiting = pending.shift()
    if (waiting !== undefined) {
      if (rng.chance(0.4)) body.push(`${waiting}:`)
      else pending.unshift(waiting)
    }
    const roll = rng.next()
    if (roll < 0.25) {
      body.push(
        rng.pick([
          'imul eax, ecx',
          'imul rdx, rax',
          'imul cx, ax',
          `imul eax, ${gen.imm(32)}`,
          'imul ecx, dword ptr x[rip]',
        ]),
      )
    } else if (roll < 0.5) jump()
    else if (roll < 0.65) {
      body.push(
        rng.pick([
          'cmp eax, 5',
          'test ecx, ecx',
          'add eax, 1',
          'dec ecx',
          'sub rdx, rax',
          'xor eax, eax',
          'or ecx, 1',
          'and eax, -2',
          'inc rdx',
        ]),
      )
    } else if (roll < 0.8) {
      body.push(
        ...rng.pick([
          [`mov eax, ${gen.imm(32)}`],
          [`mov ecx, ${gen.imm(32)}`],
          [`mov rdx, ${gen.imm(64, 'any')}`],
          ['lea rax, [rax+rcx*2]'],
          ['push rax', 'pop rcx'],
          ['nop'],
        ]),
      )
    } else if (roll < 0.9) {
      body.push('lea rdi, p_d[rip]', 'mov esi, eax', rng.pick(['call printf@PLT', 'call printf']))
    } else body.push(`mov edi, ${rng.pick(['65', '10'])}`, 'call putchar@PLT')
  }
  for (const label of pending) body.push(`${label}:`)
  body.push('ret')
  const options: EmulatorOptions = { clobberCallerSaved: rng.chance(0.7) }
  if (rng.chance(0.3)) options.initialFlags = { ZF: rng.chance(0.5) ? 1 : 0, SF: 1 }
  const source = [...header('.section .rodata'), ...layout(body), ''].join('\n')
  return { id: `flags-${seed}`, kind: 'flags', source, options, input: [] }
}

/** A program that does whatever it likes with registers, rsp, rbp, memory and jumps. */
function wildProgram(seed: number): Generated {
  const gen = new Gen(seed)
  const { rng } = gen
  const labels = Array.from({ length: rng.int(1, 5) }, (_, index) => `W${index}`)
  const place: Place = { kind: 'wild', frame: 64, rspFrame: true, counter: null }
  const pieces: string[][] = []
  for (let count = rng.int(4, 24); count > 0; count--) pieces.push(gen.wildLines(place, labels))
  // Each label goes before a random piece, or after the last instruction.
  const labelsAt = new Map<number, string[]>()
  for (const label of labels) {
    const at = rng.int(0, pieces.length)
    labelsAt.set(at, [...(labelsAt.get(at) ?? []), label])
  }
  const mainAt = rng.chance(0.85) ? rng.int(0, Math.min(2, pieces.length - 1)) : -1
  const body: string[] = []
  pieces.forEach((piece, index) => {
    if (index === mainAt) body.push('main:')
    for (const label of labelsAt.get(index) ?? []) body.push(`${label}:`)
    body.push(...piece)
  })
  for (const label of labelsAt.get(pieces.length) ?? []) body.push(`${label}:`)

  const roll = rng.next()
  let options: EmulatorOptions
  if (roll < 0.5) options = { maxSteps: 150 }
  else if (roll < 0.8)
    options = { ...SMALL_WORLD, clobberCallerSaved: rng.chance(0.5), maxSteps: 150 }
  else {
    options = {
      maxSteps: 150,
      clobberCallerSaved: false,
      initialRegisters: {
        rax: rng.big(0n, MASK64),
        rbx: BigInt(rng.int(0, 64)),
        rbp: DEFAULT_OPTIONS.stackBase - 0x40n,
      },
      initialFlags: { ZF: 1, CF: rng.chance(0.5) ? 1 : 0 },
      initialMemory: [
        { address: DEFAULT_OPTIONS.stackBase - 0x30n, bytes: 8, value: 0x1234n, label: 'saved' },
      ],
    }
  }
  if (rng.chance(0.5)) options.stdin = rng.pick(['12 abc -7\n', 'x\n', '5 6\nword\n'])
  const source = [...header('.section .rodata'), ...layout(body), ''].join('\n')
  return { id: `wild-${seed}`, kind: 'wild', source, options, input: ['5', 'hello', '-3'] }
}

const PROGRAMS: readonly Generated[] = [
  ...Array.from({ length: 130 }, (_, index) =>
    new StructuredWriter(1000 + index).build(`structured-${1000 + index}`),
  ),
  ...Array.from({ length: 50 }, (_, index) => flagsProgram(5000 + index)),
  ...Array.from({ length: 130 }, (_, index) => wildProgram(9000 + index)),
]

/**
 * Hand-made edge programs. Every property runs on them too (they are in ALL_PROGRAMS):
 * the generated programs never overflow the stack, and never end with a long explanation.
 */
const EDGE_PROGRAMS: readonly Generated[] = [
  {
    id: 'edge-main-at-the-end',
    kind: 'structured',
    source: '.intel_syntax noprefix\n.text\nhelper:\n    ret\nmain:\n',
    options: {},
    input: [],
  },
  {
    id: 'edge-library-call-last',
    kind: 'structured',
    source:
      '.intel_syntax noprefix\n.text\ns: .string "hi"\nmain:\n    lea rdi, s[rip]\n    call puts\n',
    options: {},
    input: [],
  },
  {
    id: 'edge-small-stack-overflow',
    kind: 'wild',
    source: '.intel_syntax noprefix\n.text\nmain:\n    push rax\n    jmp main\n',
    options: { ...SMALL_WORLD },
    input: [],
  },
  {
    id: 'edge-ret-to-nowhere',
    kind: 'wild',
    source: '.intel_syntax noprefix\n.text\nmain:\n    push 5\n    ret\n',
    options: {},
    input: [],
  },
  // The last instruction already has a long explanation, and then the program stops: the
  // stop sentence must still fit in 400 characters (property 10).
  ...[
    'movsx esi, byte ptr arr[rcx*1+3]',
    'movzx r12d, word ptr arr[rcx*4+2]',
    'movsx esi, word ptr arr[rbx+rcx*2+2]',
    'movzx r12d, byte ptr arr[rbx+rcx*8+1]',
  ].map((last, index): Generated => ({
    id: `edge-long-last-${index}`,
    kind: 'structured',
    source: [
      '.intel_syntax noprefix',
      '.data',
      'arr: .long 1, 2, 3, 4, 5, 6, 7, 8',
      '.text',
      'main:',
      '    mov rsi, 0x1111222233334444',
      '    mov r12, 0x1111222233334444',
      '    mov ecx, 2',
      '    mov ebx, 4',
      `    ${last}`,
      '',
    ].join('\n'),
    options: {},
    input: [],
  })),
]

/** Every program the properties run on: the generated ones and the hand-made edge cases. */
const ALL_PROGRAMS: readonly Generated[] = [...PROGRAMS, ...EDGE_PROGRAMS]

/* ───────────────────────────── Running programs ───────────────────────────── */

const assembledPrograms = new Map<string, Program | string>()

/** The assembled program (cached), or a throw with the assembler's messages. */
function assembled(program: Generated): Program {
  let code = assembledPrograms.get(program.id)
  if (code === undefined) {
    const result = assemble(program.source, program.options)
    code = result.ok ? result.program : result.diagnostics.map((item) => item.message).join(' | ')
    assembledPrograms.set(program.id, code)
  }
  if (typeof code === 'string') throw new Error(`${program.id} does not assemble: ${code}`)
  return code
}

function emulatorFor(program: Generated, options: EmulatorOptions = program.options): Emulator {
  return new Emulator(assembled(program), options)
}

/** The program's input given up front, so a run never waits (and can be repeated exactly). */
function withAllInput(program: Generated): EmulatorOptions {
  const extra = program.input.map((line) => `${line}\n`).join('')
  return { ...program.options, stdin: (program.options.stdin ?? '') + extra }
}

/** Lines that hold an instruction, for breakpoints. */
function instructionLines(program: Generated): number[] {
  return [...assembled(program).lineToIndex.keys()]
}

const REASONS: readonly RunStopReason[] = [
  'halted',
  'error',
  'breakpoint',
  'waiting-input',
  'step-limit',
]
const STATUSES: readonly Status[] = ['running', 'waiting-input', 'halted', 'error']

const RUNTIME_CODES: readonly RuntimeCode[] = [
  'bad-memory-read',
  'bad-memory-write',
  'write-read-only',
  'bad-jump',
  'ran-off-end',
  'stack-overflow',
  'library-error',
]

/** Errors where the step changed nothing (the instruction or library call faulted). */
const FAULT_CODES: ReadonlySet<string> = new Set<RuntimeCode>([
  'bad-memory-read',
  'bad-memory-write',
  'write-read-only',
  'stack-overflow',
  'library-error',
])

/** How to recognise each kind of note (contract, section 7). */
const NOTE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['alignment', /multiple of 16/],
  [
    'junk registers',
    /^`[a-z]+` may change rcx, rdx, rsi, rdi, r8, r9, r10 and r11, so they hold junk/,
  ],
  ['never written', /never written/],
  ['code read', /from the code of the program/],
  ['return address', /^`ret` jumped to/],
  ['imul flags', /flags that `imul` wrote/],
  ['scanf mismatch', /^`scanf` wanted/],
]

const LIBRARY_ADDRESSES: ReadonlySet<bigint> = new Set(Object.values(LIBRARY_FUNCTIONS))

/** The conditional jumps whose rule reads ZF or SF (contract, section 7). */
const READS_ZF_OR_SF: ReadonlySet<Mnemonic> = new Set<Mnemonic>([
  'je',
  'jne',
  'jg',
  'jge',
  'jl',
  'jle',
  'ja',
  'jbe',
  'js',
  'jns',
])

const FLAG_WRITERS: ReadonlySet<Mnemonic> = new Set<Mnemonic>([
  'add',
  'sub',
  'cmp',
  'test',
  'and',
  'or',
  'xor',
  'inc',
  'dec',
  'imul',
])

/* ───────────────────────────── Comparing and reporting ───────────────────────────── */

function hex(value: bigint): string {
  return value < 0n ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`
}

function show(value: unknown): string {
  if (typeof value === 'bigint') return hex(value)
  if (typeof value === 'string') {
    return JSON.stringify(value.length > 90 ? `${value.slice(0, 90)}…` : value)
  }
  if (typeof value === 'object' && value !== null) {
    const text = JSON.stringify(value, (_key, inner: unknown) =>
      typeof inner === 'bigint' ? hex(inner) : inner,
    )
    return text.length > 160 ? `${text.slice(0, 160)}…` : text
  }
  return String(value)
}

/** Where two values first differ (bigint aware), or null when they are deeply equal. */
function firstDifference(a: unknown, b: unknown, path = ''): string | null {
  if (Object.is(a, b)) return null
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return `${path === '' ? 'value' : path}: ${show(a)} ≠ ${show(b)}`
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: an array and an object`
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const difference = firstDifference(left[key], right[key], `${path}.${key}`)
    if (difference !== null) return difference
  }
  return null
}

function withoutVersion(state: MachineState): Omit<MachineState, 'version'> {
  const { version: _version, ...rest } = state
  return rest
}

/** null when the two states are the same machine (every field except `version`). */
function stateDifference(a: MachineState, b: MachineState): string | null {
  return firstDifference(withoutVersion(a), withoutVersion(b), 'snapshot')
}

function describeStep(result: StepResult): string {
  const text = result.kind === 'library' ? result.text : `\`${result.text}\``
  return `step ${result.stepNumber} ${text} (line ${result.line})`
}

function numbered(source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(3)}  ${line}`)
    .join('\n')
}

/** The problems a property found, ready to print. */
class Problems {
  private readonly first: { program: Generated; text: string }[] = []
  private readonly programs = new Set<string>()
  private count = 0

  add(program: Generated, text: string): void {
    this.count += 1
    this.programs.add(program.id)
    if (this.first.length < 10) this.first.push({ program, text })
  }

  /** '' when there was no problem; else the first problems and the first program's source. */
  summary(): string {
    if (this.count === 0) return ''
    const lines = [`${this.count} problem(s) in ${this.programs.size} program(s). The first ones:`]
    for (const { program, text } of this.first) lines.push(`- [${program.id}] ${text}`)
    const program = this.first[0]?.program
    if (program !== undefined) {
      lines.push(
        '',
        `Source of ${program.id}, options ${show(program.options)}:`,
        numbered(program.source),
      )
    }
    return lines.join('\n')
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/** Run `check` on every program; a throw is a problem too. */
function forEachProgram(
  programs: readonly Generated[],
  check: (program: Generated, problems: Problems, index: number) => void,
): Problems {
  const problems = new Problems()
  programs.forEach((program, index) => {
    try {
      check(program, problems, index)
    } catch (error) {
      problems.add(program, `threw: ${errorText(error)}`)
    }
  })
  return problems
}

/* ───────────────────────────── Traces ───────────────────────────── */

interface TraceStep {
  before: MachineState
  result: StepResult
  after: MachineState
}

interface Trace {
  program: Generated
  code: Program
  steps: TraceStep[]
  /** Checks that need the live emulator, done the moment each snapshot was taken. */
  stackView: string[]
  region: string[]
  dataView: string[]
  stable: string[]
  clones: { label: string; snapshot: MachineState; clone: MachineState }[]
  crashed: string | null
}

/** The stack region the contract describes (types.ts: `stackSize` bytes below `stackBase`). */
function stackBounds(options: EmulatorOptions): { low: bigint; top: bigint } {
  const stackBase = options.stackBase ?? DEFAULT_OPTIONS.stackBase
  const rsp = options.initialRsp ?? options.initialRegisters?.rsp ?? stackBase - 8n
  let low = stackBase - BigInt(options.stackSize ?? DEFAULT_OPTIONS.stackSize)
  // The box of the starting rsp is always part of the stack.
  if (rsp - (rsp % 8n) < low) low = rsp - (rsp % 8n)
  if (low < 0n) low = 0n
  // "At least one page above both the stack start and the starting rsp."
  const top = (stackBase > rsp + 8n ? stackBase : rsp + 8n) + 4096n
  return { low, top }
}

function littleEndian(bytes: readonly (number | null)[]): bigint | null {
  if (bytes.every((byte) => byte === null)) return null
  return bytes.reduce<bigint>((value, byte, i) => value | (BigInt(byte ?? 0) << BigInt(8 * i)), 0n)
}

function sameBytes(a: readonly (number | null)[], b: readonly (number | null)[]): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/** Property 8: what must be true of `snapshot.stack` (checked while the emulator is live). */
function stackViewProblems(
  emulator: Emulator,
  state: MachineState,
  bounds: { low: bigint; top: bigint },
): string[] {
  const problems: string[] = []
  const boxes = state.stack
  const rsp = state.registers.rsp
  boxes.forEach((box, index) => {
    if (box.address % 8n !== 0n) problems.push(`box ${hex(box.address)} is not at a multiple of 8`)
    const previous = boxes[index - 1]
    if (previous !== undefined && previous.address - box.address !== 8n) {
      problems.push(`boxes ${hex(previous.address)} and ${hex(box.address)} are not neighbours`)
    }
  })
  for (const [name, value, flag] of [
    ['rsp', rsp, 'isRsp'],
    ['rbp', state.registers.rbp, 'isRbp'],
  ] as const) {
    const box = value - (value % 8n)
    const listed = boxes.some((slot) => slot.address === box)
    const marked = boxes.filter((slot) => slot[flag])
    if (value >= bounds.low && value < bounds.top && !listed) {
      problems.push(`${name} = ${hex(value)} is inside the stack, but its box is not listed`)
    }
    if (marked.length !== (listed ? 1 : 0) || (listed && marked[0]?.address !== box)) {
      const where = marked.map((slot) => hex(slot.address)).join(', ')
      problems.push(`${name} = ${hex(value)}: ${flag} is set on [${where}]`)
    }
  }
  const written = state.lastStep?.diff.written.memory ?? []
  for (const box of boxes) {
    // The whole box is below rsp (for an rsp that is a multiple of 8: address < rsp).
    const dead = rsp % 8n === 0n ? box.address < rsp : box.address + 8n <= rsp
    if (box.dead !== dead) {
      problems.push(`box ${hex(box.address)}: dead is ${String(box.dead)}, rsp = ${hex(rsp)}`)
    }
    const changed = written.some(
      (range) =>
        range.address < box.address + 8n && box.address < range.address + BigInt(range.bytes),
    )
    if (box.changed !== changed) {
      problems.push(
        `box ${hex(box.address)}: changed is ${String(box.changed)}, written: ${String(changed)}`,
      )
    }
    const memory = emulator.readMemory(box.address, 8)
    if (!sameBytes(box.bytes, memory)) {
      problems.push(`box ${hex(box.address)}: bytes ${show(box.bytes)}, readMemory ${show(memory)}`)
    }
    const value = littleEndian(box.bytes)
    if (box.value !== value) {
      problems.push(
        `box ${hex(box.address)}: value ${show(box.value)}, its bytes say ${show(value)}`,
      )
    }
    if (box.kind === 'empty' && (box.value !== null || box.label !== null)) {
      problems.push(`box ${hex(box.address)} is 'empty' but has a value or a label`)
    }
    if (box.kind === 'value' && (box.value === null || box.label !== null)) {
      problems.push(`box ${hex(box.address)} is 'value' but has no value, or has a label`)
    }
  }
  return problems
}

/** Property 8b: no box outside the stack region of the contract (below stackBase − stackSize). */
function regionProblems(state: MachineState, bounds: { low: bigint; top: bigint }): string[] {
  const outside = state.stack.filter((box) => box.address + 8n <= bounds.low)
  const lowest = outside.at(-1)
  if (lowest === undefined) return []
  return [
    `${outside.length} box(es) below the stack region [${hex(bounds.low)}, …); the lowest is ` +
      `${hex(lowest.address)} (isRbp: ${String(lowest.isRbp)}, kind '${lowest.kind}'); ` +
      `rbp = ${hex(state.registers.rbp)}, rsp = ${hex(state.registers.rsp)}`,
  ]
}

/** The data view shows what is in memory (each element, little-endian). */
function dataViewProblems(emulator: Emulator, state: MachineState): string[] {
  const problems: string[] = []
  for (const view of state.data) {
    const bytes = emulator.readMemory(view.address, view.values.length * view.elementSize)
    view.values.forEach((value, element) => {
      const start = element * view.elementSize
      const own = littleEndian(bytes.slice(start, start + view.elementSize)) ?? 0n
      if (own !== value) {
        problems.push(
          `data ${String(view.label)}[${element}] is ${hex(value)}, memory holds ${hex(own)}`,
        )
      }
    })
  }
  return problems
}

const TRACE_LIMIT: Readonly<Record<ProgramKind, number>> = {
  structured: 320,
  flags: 120,
  wild: 160,
}

/** Step a program to its end (giving input when it waits), and check snapshots on the way. */
function buildTrace(program: Generated): Trace {
  const code = assembled(program)
  const emulator = new Emulator(code, program.options)
  const bounds = stackBounds(program.options)
  const trace: Trace = {
    program,
    code,
    steps: [],
    stackView: [],
    region: [],
    dataView: [],
    stable: [],
    clones: [],
    crashed: null,
  }
  const look = (state: MachineState, label: string, deep: boolean): void => {
    for (const text of stackViewProblems(emulator, state, bounds)) {
      trace.stackView.push(`${label}: ${text}`)
    }
    for (const text of regionProblems(state, bounds)) trace.region.push(`${label}: ${text}`)
    if (deep) {
      for (const text of dataViewProblems(emulator, state)) trace.dataView.push(`${label}: ${text}`)
    }
    if (emulator.getSnapshot() !== state) {
      trace.stable.push(`${label}: getSnapshot() twice gave two objects`)
    }
  }
  try {
    const input = [...program.input]
    let before = emulator.getSnapshot()
    look(before, 'start', true)
    for (let count = 0; count < TRACE_LIMIT[program.kind]; count++) {
      if (before.status === 'waiting-input') {
        const line = input.shift()
        if (line === undefined) break
        emulator.provideInput(line)
        before = emulator.getSnapshot()
      }
      const result = emulator.step()
      const after = emulator.getSnapshot()
      const label = describeStep(result)
      look(after, label, count % 4 === 0 || result.diff.memory.length > 0)
      if (count % 3 === 0) {
        trace.clones.push({ label, snapshot: after, clone: structuredClone(after) })
      }
      trace.steps.push({ before, result, after })
      if (!result.executed && (after.status === 'halted' || after.status === 'error')) {
        if (after !== before)
          trace.stable.push(`${label}: a step that ran nothing made a new snapshot`)
        emulator.run()
        if (emulator.getSnapshot() !== after) {
          trace.stable.push('run() on a program that has ended made a new snapshot')
        }
        emulator.setBreakpoints(after.breakpoints)
        if (emulator.getSnapshot() !== after) {
          trace.stable.push('setBreakpoints() with the same lines made a new snapshot')
        }
        break
      }
      before = after
    }
  } catch (error) {
    trace.crashed = errorText(error)
  }
  return trace
}

let traces: Trace[] | null = null

function allTraces(): Trace[] {
  traces ??= ALL_PROGRAMS.map(buildTrace)
  return traces
}

function instructionOf(code: Program, result: StepResult) {
  return result.kind === 'library'
    ? undefined
    : code.instructions[code.addressToIndex.get(result.address) ?? -1]
}

/* ───────────────────────────── Property checks ───────────────────────────── */

/** One byte as a snapshot shows it: from its stack box or its data item (undefined: not shown). */
function byteShown(
  state: MachineState,
  boxes: ReadonlyMap<bigint, StackSlot>,
  address: bigint,
): number | null | undefined {
  const box = boxes.get(address - (address % 8n))
  if (box !== undefined) return box.bytes[Number(address % 8n)] ?? null
  for (const view of state.data) {
    const offset = address - view.address
    const length = BigInt(view.values.length * view.elementSize)
    if (offset >= 0n && offset < length) {
      const value = view.values[Math.floor(Number(offset) / view.elementSize)] ?? 0n
      return Number((value >> BigInt(8 * (Number(offset) % view.elementSize))) & 0xffn)
    }
  }
  return undefined
}

/** Property 3 for one step: replaying the diff onto `before` gives `after`, and nothing else moved. */
function diffProblems(step: TraceStep): string[] {
  const { before, result, after } = step
  const { diff } = result
  const problems: string[] = []
  if (!result.executed) {
    const listed =
      diff.registers.length +
      diff.flags.length +
      diff.memory.length +
      diff.written.registers.length +
      diff.written.flags.length +
      diff.written.memory.length
    if (listed > 0 || diff.rip.before !== diff.rip.after) {
      problems.push('a step that ran nothing has a diff')
    }
    // Only "now waiting for input" may change (contract, section 6).
    const waiting = after.status === 'waiting-input'
    const masked = (state: MachineState): unknown => ({
      ...withoutVersion(state),
      status: waiting ? 'masked' : state.status,
      inputRequest: waiting ? 'masked' : state.inputRequest,
    })
    const difference = firstDifference(masked(before), masked(after), 'snapshot')
    if (difference !== null) problems.push(`a step that ran nothing changed ${difference}`)
    return problems
  }

  if (after.stepCount !== before.stepCount + 1) {
    problems.push(`stepCount ${before.stepCount} → ${after.stepCount}`)
  }
  if (result.stepNumber !== after.stepCount) {
    problems.push(`stepNumber ${result.stepNumber} ≠ stepCount ${after.stepCount}`)
  }
  if (after.lastStep !== result) problems.push('snapshot.lastStep is not the result step() gave')
  if (after.output !== before.output + result.output) {
    problems.push('output is not the old output plus the output of the step')
  }

  const registerChanges = new Map(diff.registers.map((change) => [change.reg, change]))
  if (registerChanges.size !== diff.registers.length) {
    problems.push('a register is listed twice in diff.registers')
  }
  for (const name of REG64_NAMES) {
    const change = registerChanges.get(name)
    const was = before.registers[name]
    const now = after.registers[name]
    if (change === undefined) {
      if (was !== now) problems.push(`${name} changed (${hex(was)} → ${hex(now)}), not in the diff`)
      continue
    }
    if (change.before !== was || change.after !== now) {
      problems.push(
        `diff says ${name} ${hex(change.before)} → ${hex(change.after)}; it was ${hex(was)} → ${hex(now)}`,
      )
    }
    if (change.before === change.after) problems.push(`${name} is in diff.registers but unchanged`)
    if (!diff.written.registers.includes(name)) {
      problems.push(`${name} changed but is not in diff.written.registers`)
    }
  }
  const flagChanges = new Map(diff.flags.map((change) => [change.flag, change]))
  for (const name of FLAG_NAMES) {
    const change = flagChanges.get(name)
    const was = before.flags[name]
    const now = after.flags[name]
    if (change === undefined) {
      if (was !== now) problems.push(`${name} changed (${was} → ${now}) but is not in diff.flags`)
      continue
    }
    if (change.before !== was || change.after !== now || was === now) {
      problems.push(`diff says ${name} ${change.before} → ${change.after}; it was ${was} → ${now}`)
    }
    if (!diff.written.flags.includes(name)) {
      problems.push(`${name} changed but is not in diff.written.flags`)
    }
  }
  if (diff.rip.before !== before.rip || diff.rip.after !== after.rip) {
    problems.push(
      `diff.rip ${hex(diff.rip.before)} → ${hex(diff.rip.after)}; rip was ${hex(before.rip)} → ${hex(after.rip)}`,
    )
  }

  // Memory: replay the diff onto the bytes the snapshot showed before.
  const beforeBoxes = new Map(before.stack.map((box) => [box.address, box]))
  const afterBoxes = new Map(after.stack.map((box) => [box.address, box]))
  const replayed = new Map<bigint, number>()
  const expectedByte = (address: bigint): number | null =>
    replayed.get(address) ?? byteShown(before, beforeBoxes, address) ?? null
  for (const change of diff.memory) {
    change.after.forEach((byte, i) => {
      const address = change.address + BigInt(i)
      const old = expectedByte(address)
      if ((change.before[i] ?? null) !== old) {
        problems.push(
          `diff.memory says byte ${hex(address)} was ${show(change.before[i])}; it was ${show(old)}`,
        )
      }
      replayed.set(address, byte)
    })
    if (change.before.every((byte, i) => byte === change.after[i])) {
      problems.push(`diff.memory lists ${hex(change.address)} but no byte changed`)
    }
    const inside = change.after.every((_, i) => {
      const address = change.address + BigInt(i)
      return diff.written.memory.some(
        (range) => range.address <= address && address < range.address + BigInt(range.bytes),
      )
    })
    if (!inside) problems.push(`the change at ${hex(change.address)} is not in diff.written.memory`)
  }
  const touches = (start: bigint, length: bigint): boolean =>
    diff.memory.some(
      (change) =>
        change.address < start + length && start < change.address + BigInt(change.after.length),
    )
  for (const box of after.stack) {
    const old = beforeBoxes.get(box.address)
    if (old !== undefined && !touches(box.address, 8n)) {
      if (!sameBytes(old.bytes, box.bytes))
        problems.push(`box ${hex(box.address)} changed, not in the diff`)
      continue
    }
    box.bytes.forEach((byte, i) => {
      const address = box.address + BigInt(i)
      if (byte !== expectedByte(address)) {
        problems.push(
          `byte ${hex(address)} is ${show(byte)}; replaying the diff gives ${show(expectedByte(address))}`,
        )
      }
    })
  }
  for (const box of before.stack) {
    if (!afterBoxes.has(box.address) && (touches(box.address, 8n) || box.value !== null)) {
      problems.push(`box ${hex(box.address)} holds bytes but left the stack view`)
    }
  }
  after.data.forEach((view, index) => {
    const length = BigInt(view.values.length * view.elementSize)
    if (before.data[index] === view && !touches(view.address, length)) return
    for (let i = 0n; i < length; i++) {
      const address = view.address + i
      const shown = byteShown(after, afterBoxes, address)
      if (shown !== expectedByte(address)) {
        problems.push(
          `data byte ${hex(address)} is ${show(shown)}; replaying gives ${show(expectedByte(address))}`,
        )
        break
      }
    }
  })

  // A step that faulted changed nothing (contract, section 2: atomic).
  if (faulted(result)) {
    const changed = diff.registers.length + diff.flags.length + diff.memory.length
    if (changed > 0 || diff.rip.before !== diff.rip.after) {
      problems.push(`the step faulted (${String(result.error?.code)}) but its diff is not empty`)
    }
  }
  return problems
}

/** Instructions whose first operand, when it is a register, is written. */
const WRITES_FIRST: ReadonlySet<Mnemonic> = new Set<Mnemonic>([
  'mov',
  'movzx',
  'movsx',
  'lea',
  'add',
  'sub',
  'and',
  'or',
  'xor',
  'imul',
  'inc',
  'dec',
  'pop',
])

function faulted(result: StepResult): boolean {
  return result.error !== null && FAULT_CODES.has(result.error.code)
}

/** Property 7 for one step. */
function registerProblems(code: Program, step: TraceStep): string[] {
  const { before, result, after } = step
  const problems: string[] = []
  for (const name of REG64_NAMES) {
    const value = after.registers[name]
    if (value < 0n || value > MASK64) problems.push(`${name} = ${hex(value)} is not in 0 … 2^64-1`)
  }
  for (const name of FLAG_NAMES) {
    const value: number = after.flags[name]
    if (value !== 0 && value !== 1) problems.push(`${name} = ${value}`)
  }
  if (!result.executed || faulted(result)) return problems

  const wrap = (value: bigint): bigint => BigInt.asUintN(64, value)
  const rspBefore = before.registers.rsp
  const rspAfter = after.registers.rsp
  if (result.kind === 'library') {
    const exit = result.text.startsWith('exit')
    const wanted = exit ? rspBefore : wrap(rspBefore + 8n)
    if (rspAfter !== wanted) problems.push(`rsp ${hex(rspBefore)} → ${hex(rspAfter)}`)
    if (!exit && after.registers.rax >> 32n !== 0n) problems.push('it left a top half in rax')
    return problems
  }
  const instruction = instructionOf(code, result)
  if (instruction === undefined) return problems
  const first = instruction.operands[0]
  const destination =
    WRITES_FIRST.has(instruction.mnemonic) && first?.kind === 'reg' ? first.reg : null
  if (destination !== null) {
    const { base, size, shift } = destination
    const was = before.registers[base]
    const now = after.registers[base]
    if (size === 32 && now >> 32n !== 0n) {
      problems.push(`a 32-bit write left ${hex(now >> 32n)} in the top half of ${base}`)
    }
    if (size === 8 || size === 16) {
      const part = ((1n << BigInt(size)) - 1n) << BigInt(shift)
      if (((now ^ was) & ~part & MASK64) !== 0n) {
        problems.push(
          `a ${size}-bit write changed other bits of ${base}: ${hex(was)} → ${hex(now)}`,
        )
      }
    }
  }
  const writesRsp = destination?.base === 'rsp'
  let wanted: bigint | null
  switch (instruction.mnemonic) {
    case 'push':
    case 'call':
      wanted = wrap(rspBefore - 8n)
      break
    case 'pop':
      wanted = writesRsp ? null : wrap(rspBefore + 8n)
      break
    case 'ret':
      wanted = wrap(rspBefore + 8n)
      break
    case 'leave':
      wanted = wrap(before.registers.rbp + 8n)
      break
    default:
      wanted = writesRsp ? null : rspBefore
  }
  if (wanted !== null && rspAfter !== wanted) {
    problems.push(`rsp ${hex(rspBefore)} → ${hex(rspAfter)}, expected ${hex(wanted)}`)
  }
  return problems
}

/**
 * Property 8c, labels (contract, section 9): right after `push reg` the top box is "saved reg";
 * right after `call` it is a return address (with the line it goes back to); a box reached
 * through an `.equ` name with base rbp or rsp is named after it.
 */
function labelProblems(code: Program, step: TraceStep): string[] {
  const { before, result, after } = step
  if (!result.executed || faulted(result)) return []
  const instruction = instructionOf(code, result)
  if (instruction === undefined) return []
  const boxes = new Map(after.stack.map((box) => [box.address, box]))
  const boxAt = (address: bigint): StackSlot | undefined => boxes.get(address - (address % 8n))
  const problems: string[] = []
  const describe = (box: StackSlot): string => `'${box.kind}' ${show(box.label)}`
  const first = instruction.operands[0]
  const top = boxAt(after.registers.rsp)
  if (instruction.mnemonic === 'push' && first?.kind === 'reg' && top !== undefined) {
    if (top.kind !== 'saved-register' || !(top.label ?? '').includes(`saved ${first.reg.name}`)) {
      problems.push(`the new top box is ${describe(top)}`)
    }
  }
  if (instruction.mnemonic === 'call' && top !== undefined) {
    const back = code.instructions[instruction.index + 1]?.line
    const label = top.label ?? ''
    const named =
      label.includes('return address') && (back === undefined || label.includes(`line ${back}`))
    if (top.kind !== 'return-address' || !named)
      problems.push(`the new top box is ${describe(top)}`)
  }
  for (const operand of instruction.operands) {
    if (operand.kind !== 'mem' || operand.equNames.length === 0) continue
    if (operand.base !== 'rbp' && operand.base !== 'rsp') continue
    const index =
      operand.index === null ? 0n : before.registers[operand.index] * BigInt(operand.scale)
    const address = BigInt.asUintN(64, before.registers[operand.base] + index + operand.disp)
    const box = boxAt(address)
    const name = operand.equNames[0] ?? ''
    if (box !== undefined && (box.kind !== 'local' || !(box.label ?? '').startsWith(name))) {
      problems.push(`the box of \`${operand.text}\` is ${describe(box)}`)
    }
  }
  return problems
}

/** Property 8c (programs without wild stack games): call stack, boxes, inLibrary, nextLine. */
function frameProblems(code: Program, state: MachineState): string[] {
  const problems: string[] = []
  const boxes = new Map(state.stack.map((box) => [box.address, box]))
  let newest: bigint | null = null
  for (const frame of state.callStack) {
    const name = String(frame.functionName)
    const box = boxes.get(frame.slotAddress)
    if (box === undefined) {
      problems.push(`the box of the frame of ${name} (${hex(frame.slotAddress)}) is not listed`)
      continue
    }
    if (box.value !== frame.returnAddress) {
      problems.push(
        `frame ${name}: its box holds ${show(box.value)}, not ${hex(frame.returnAddress)}`,
      )
    }
    if (box.kind !== 'return-address' || !(box.label ?? '').includes('return address')) {
      problems.push(`frame ${name}: its box is '${box.kind}' with label ${show(box.label)}`)
    }
    if (newest !== null && frame.slotAddress >= newest) problems.push('frames are not in order')
    newest = frame.slotAddress
  }
  if (newest !== null && state.registers.rsp > newest) {
    problems.push(`rsp ${hex(state.registers.rsp)} is above the newest frame (${hex(newest)})`)
  }
  if ((state.inLibrary !== null) !== LIBRARY_ADDRESSES.has(state.rip)) {
    problems.push(`inLibrary is ${show(state.inLibrary)} while rip is ${hex(state.rip)}`)
  }
  const index = code.addressToIndex.get(state.rip)
  const line = index === undefined ? null : (code.instructions[index]?.line ?? null)
  const nextLine = state.status === 'halted' || state.inLibrary !== null ? null : line
  if (state.nextLine !== nextLine) {
    problems.push(
      `nextLine is ${String(state.nextLine)}, rip ${hex(state.rip)} is line ${String(line)}`,
    )
  }
  if (state.canStepBack !== state.stepCount > 0) {
    problems.push(`canStepBack is ${String(state.canStepBack)} at step ${state.stepCount}`)
  }
  return problems
}

/** Property 11: the tips and warnings of the contract (section 7) appear exactly when due. */
function noteProblems(trace: Trace): string[] {
  const problems: string[] = []
  const options = trace.program.options
  const clobber = options.clobberCallerSaved !== false
  const os = options.osReturnAddress ?? DEFAULT_OPTIONS.osReturnAddress
  let lastFlagWriter: Mnemonic | null = null
  for (const { before, result } of trace.steps) {
    if (!result.executed) continue
    const where = describeStep(result)
    const has = (pattern: RegExp): boolean => result.notes.some((note) => pattern.test(note.text))
    if (result.kind === 'library') {
      const exit = result.text.startsWith('exit')
      const tip = result.notes.some(
        (note) =>
          note.kind === 'tip' && note.text.includes('rcx, rdx, rsi, rdi, r8, r9, r10 and r11'),
      )
      const due = clobber && !exit && !faulted(result)
      if (tip !== due) problems.push(`${where}: junk-register tip ${tip ? 'shown' : 'missing'}`)
      // Real library code may change every flag (the System V ABI keeps none across a call),
      // so with the realism on, the last code that wrote the flags is the library function,
      // not an earlier `imul`. (The jump then gets the "flags from before the call" warning.)
      if (clobber && !faulted(result)) lastFlagWriter = null
      continue
    }
    const instruction = instructionOf(trace.code, result)
    if (instruction === undefined || faulted(result)) continue
    const mnemonic = instruction.mnemonic
    const imulNote = has(/`imul`/) && has(/`cmp`/) && has(/`test`/)
    const imulDue =
      isJumpCondition(mnemonic) && READS_ZF_OR_SF.has(mnemonic) && lastFlagWriter === 'imul'
    if (imulNote !== imulDue) {
      const last = String(lastFlagWriter)
      problems.push(
        `${where}: imul note ${imulNote ? 'shown' : 'missing'} (last flag writer ${last})`,
      )
    }
    if (mnemonic === 'call') {
      const target = instruction.operands[0]
      const external = target?.kind === 'target' && target.external
      const warned = has(/multiple of 16/)
      const due = external && before.registers.rsp % 16n !== 0n
      if (warned !== due) {
        const rsp = hex(before.registers.rsp)
        problems.push(`${where}: alignment warning ${warned ? 'shown' : 'missing'} (rsp ${rsp})`)
      }
    }
    if (mnemonic === 'ret') {
      const popped = result.diff.rip.after
      const saved = before.callStack.at(-1)?.returnAddress
      const warned = has(/^`ret` jumped to/)
      const due = popped !== os && trace.code.addressToIndex.has(popped) && popped !== saved
      if (warned !== due) {
        problems.push(`${where}: return-address warning ${warned ? 'shown' : 'missing'}`)
      }
    }
    if (FLAG_WRITERS.has(mnemonic)) lastFlagWriter = mnemonic
  }
  return problems
}

/** Property 10 for one step that ran. */
function explanationProblems(result: StepResult): string[] {
  const problems: string[] = []
  const text = result.explanation
  if (text.trim() === '') return ['the explanation is empty']
  const name = result.kind === 'library' ? (result.text.split(' ')[0] ?? '') : null
  const startsWell = text.startsWith('`') || (name !== null && name !== '' && text.startsWith(name))
  if (!startsWell) {
    problems.push(
      `the explanation starts with neither a backtick nor the function name: ${show(text)}`,
    )
  }
  for (const piece of [text, ...result.notes.map((note) => note.text)]) {
    for (const bad of ['undefined', 'NaN', '[object Object]']) {
      if (piece.includes(bad)) problems.push(`"${bad}" in ${show(piece)}`)
    }
    if (/\b\d+n\b/.test(piece)) problems.push(`bigint text like "12n" in ${show(piece)}`)
  }
  if (text.length > 400) {
    problems.push(`the explanation has ${text.length} characters: ${show(text)}`)
  }
  // "One to three short sentences" (contract, section 8).
  const sentences = (text.match(/[.!?](?=\s|$)/g) ?? []).length
  if (sentences < 1 || sentences > 3) {
    problems.push(`the explanation has ${sentences} sentences: ${show(text)}`)
  }
  return problems
}

function deepFrozenProblem(value: unknown, path: string): string | null {
  if (typeof value !== 'object' || value === null) return null
  if (!Object.isFrozen(value)) return `${path} is not frozen`
  for (const [key, inner] of Object.entries(value)) {
    const problem = deepFrozenProblem(inner, `${path}.${key}`)
    if (problem !== null) return problem
  }
  return null
}

/* ───────────────────────────── The properties ───────────────────────────── */

describe('emulator properties on generated programs', () => {
  it('0. the generator writes programs the assembler accepts', () => {
    const problems = forEachProgram(ALL_PROGRAMS, (program) => {
      assembled(program)
    })
    expect(problems.summary()).toBe('')
    expect(PROGRAMS.length).toBeGreaterThanOrEqual(300)
  })

  it('0b. the programs reach every instruction, library function, run-time error and note', () => {
    const seen = new Set<string>()
    for (const trace of allTraces()) {
      for (const { result, after } of trace.steps) {
        seen.add(`status ${after.status}`)
        if (!result.executed) continue
        const instruction = instructionOf(trace.code, result)
        if (result.kind === 'library') seen.add(`library ${result.text.split(' ')[0] ?? ''}`)
        else if (instruction !== undefined) seen.add(`instruction ${instruction.mnemonic}`)
        if (result.error !== null) seen.add(`error ${result.error.code}`)
        for (const [name, pattern] of NOTE_PATTERNS) {
          if (result.notes.some((note) => pattern.test(note.text))) seen.add(`note ${name}`)
        }
      }
    }
    // The traces include the hand-made edge programs (one overflows the small-world
    // stack), so every property below also runs on them.
    const wanted = [
      ...MNEMONICS.map((mnemonic) => `instruction ${mnemonic}`),
      ...Object.keys(LIBRARY_FUNCTIONS).map((name) => `library ${name}`),
      ...RUNTIME_CODES.map((code) => `error ${code}`),
      ...NOTE_PATTERNS.map(([name]) => `note ${name}`),
      ...STATUSES.map((status) => `status ${status}`),
    ]
    expect(wanted.filter((item) => !seen.has(item))).toEqual([])
  }, 30_000)

  it('1. never throws, always ends: run() gives one of five reasons, status one of four', () => {
    const problems = forEachProgram(ALL_PROGRAMS, (program, problems, index) => {
      const rng = new Random(77_000 + index)
      const emulator = emulatorFor(program)
      const lines = instructionLines(program)
      const input = [...program.input, 'abc', '7']
      const check = (status: Status, where: string): void => {
        if (!STATUSES.includes(status)) problems.add(program, `${where}: status ${show(status)}`)
      }
      const say = (text: string): void => problems.add(program, text)
      for (let op = 0; op < 80; op++) {
        const roll = rng.next()
        let action = 'step'
        try {
          // Each call must also show in the very next snapshot (no stale cache).
          const before = emulator.getSnapshot()
          if (roll < 0.55) {
            const result = emulator.step()
            const after = emulator.getSnapshot()
            check(result.status, 'step()')
            if (result.status !== after.status)
              say(`step() said ${result.status}, snapshot ${after.status}`)
            if (after.stepCount !== before.stepCount + (result.executed ? 1 : 0)) {
              say(
                `step() (executed: ${String(result.executed)}): stepCount ${before.stepCount} → ${after.stepCount}`,
              )
            }
          } else if (roll < 0.62) {
            action = 'run'
            const run = emulator.run()
            const after = emulator.getSnapshot()
            if (!REASONS.includes(run.reason)) say(`run() gave ${show(run.reason)}`)
            if (
              !Number.isInteger(run.stepsRun) ||
              after.stepCount !== before.stepCount + run.stepsRun
            ) {
              say(
                `run() said ${run.stepsRun} steps; stepCount ${before.stepCount} → ${after.stepCount}`,
              )
            }
          } else if (roll < 0.82) {
            action = 'stepBack'
            const went = emulator.stepBack()
            const after = emulator.getSnapshot()
            if (went && after.stepCount !== before.stepCount - 1) {
              say(`stepBack() went from step ${before.stepCount} to ${after.stepCount}`)
            }
            if (!went && (after !== before || before.stepCount !== 0)) {
              say(`stepBack() returned false at step ${before.stepCount} (or made a new snapshot)`)
            }
          } else if (roll < 0.85) {
            action = 'reset'
            emulator.reset()
            const after = emulator.getSnapshot()
            const start =
              after.stepCount === 0 &&
              after.output === '' &&
              after.lastStep === null &&
              !after.canStepBack &&
              after.status === 'running'
            if (!start) say('reset() did not go back to the starting state')
            if (firstDifference(after.breakpoints, before.breakpoints) !== null) {
              say('reset() changed the breakpoints')
            }
          } else if (roll < 0.92) {
            action = 'provideInput'
            emulator.provideInput(rng.pick(input))
            const after = emulator.getSnapshot()
            const waiting = after.status === 'waiting-input' || after.inputRequest !== null
            if (before.status === 'waiting-input' && waiting)
              say('provideInput() did not end the wait')
          } else if (roll < 0.97) {
            action = 'toggleBreakpoint'
            const line = lines.length > 0 ? rng.pick(lines) : 1
            emulator.toggleBreakpoint(line)
            if (
              emulator.getSnapshot().breakpoints.includes(line) ===
              before.breakpoints.includes(line)
            ) {
              say(`toggleBreakpoint(${line}) did not flip it`)
            }
          } else {
            action = 'setBreakpoints'
            // With a duplicate, in any order: the snapshot lists them sorted, once each.
            const wanted = rng.chance(0.3) ? [] : [...rng.sample(lines, 3), ...rng.sample(lines, 1)]
            emulator.setBreakpoints(wanted)
            const expected = [...new Set(wanted)].sort((a, b) => a - b)
            const difference = firstDifference(emulator.getSnapshot().breakpoints, expected)
            if (difference !== null) say(`setBreakpoints(): ${difference}`)
          }
          action = 'getSnapshot'
          check(emulator.getSnapshot().status, `after operation ${op}`)
        } catch (error) {
          problems.add(program, `operation ${op} (${action}) threw: ${errorText(error)}`)
          return
        }
      }
      // Every program ends: run() comes back, also when it is given input whenever it waits.
      emulator.reset()
      emulator.setBreakpoints([])
      for (let round = 0; round < 20; round++) {
        const run = emulator.run()
        if (!REASONS.includes(run.reason)) problems.add(program, `run() gave ${show(run.reason)}`)
        if (run.reason !== 'waiting-input') break
        emulator.provideInput(rng.pick(input))
      }
    })
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('2. undo is exact: k steps forward then k back is the fresh state; forward again repeats', () => {
    const problems = forEachProgram(ALL_PROGRAMS, (program, problems, index) => {
      const rng = new Random(88_000 + index)
      const emulator = emulatorFor(program, withAllInput(program))
      const states: MachineState[] = [emulator.getSnapshot()]
      const results: StepResult[] = []
      let executed = 0
      for (let count = 0; count < 45; count++) {
        const result = emulator.step()
        results.push(result)
        states.push(emulator.getSnapshot())
        if (!result.executed) break
        executed += 1
      }
      const compare = (where: string, expected: MachineState | undefined): boolean => {
        const difference =
          expected === undefined ? 'no state' : stateDifference(emulator.getSnapshot(), expected)
        if (difference !== null) problems.add(program, `${where}: ${difference}`)
        return difference === null
      }
      const again = (position: number, where: string): boolean => {
        const difference = firstDifference(emulator.step(), results[position], 'result')
        if (difference !== null)
          problems.add(program, `${where}, step ${position + 1}: ${difference}`)
        return difference === null
      }
      // All the way back: each state on the way back is the state on the way forward.
      for (let k = executed; k >= 1; k--) {
        if (!emulator.stepBack()) problems.add(program, `stepBack() returned false at step ${k}`)
        if (!compare(`back from step ${k} to ${k - 1}`, states[k - 1])) return
      }
      if (emulator.stepBack()) problems.add(program, 'stepBack() at the start returned true')
      if (!compare('stepBack() at the start', states[0])) return
      // Forward again: the same StepResults and the same states.
      for (let i = 0; i < results.length; i++) {
        if (!again(i, 'forward again')) return
        if (!compare(`forward again to step ${i + 1}`, states[i + 1])) return
      }
      // A random walk, back and forward a few steps at a time: hidden state that stepBack
      // forgot (input position, the imul note, labels, …) shows up as a different result.
      emulator.reset()
      let position = 0
      for (let move = 0; move < Math.max(12, executed); move++) {
        const distance = rng.int(1, 6)
        if (position > 0 && rng.chance(0.5)) {
          for (let i = 0; i < distance && position > 0; i++) {
            emulator.stepBack()
            position -= 1
          }
        } else {
          for (let i = 0; i < distance && position < executed; i++) {
            if (!again(position, `random walk move ${move}`)) return
            position += 1
          }
        }
        if (!compare(`random walk move ${move}, at step ${position}`, states[position])) return
      }
      // The literal property for a few k: fresh, k steps forward, k steps back.
      const lengths = Array.from({ length: executed }, (_, i) => i + 1)
      for (const k of rng.sample(lengths, 2)) {
        emulator.reset()
        for (let i = 0; i < k; i++) emulator.step()
        for (let i = 0; i < k; i++) emulator.stepBack()
        if (!compare(`${k} forward, ${k} back`, states[0])) return
      }
    })
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('3. diffs are complete and honest: replaying each diff gives the next snapshot', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      if (trace.crashed !== null) problems.add(trace.program, `threw: ${trace.crashed}`)
      for (const step of trace.steps) {
        for (const text of diffProblems(step)) {
          problems.add(trace.program, `${describeStep(step.result)}: ${text}`)
        }
      }
    }
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('4. run() equals a loop of step(): same snapshots, output and step count', () => {
    const problems = forEachProgram(ALL_PROGRAMS, (program, problems, index) => {
      const rng = new Random(99_000 + index)
      const options = { ...program.options, maxSteps: 200 }
      const byRun = emulatorFor(program, options)
      const bySteps = emulatorFor(program, options)
      const breakpoints = rng.chance(0.5) ? rng.sample(instructionLines(program), 2) : []
      byRun.setBreakpoints(breakpoints)
      bySteps.setBreakpoints(breakpoints)
      const input = [...program.input]
      for (let round = 0; round < 30; round++) {
        const run = byRun.run()
        for (let i = 0; i < run.stepsRun; i++) {
          const result = bySteps.step()
          if (!result.executed) {
            problems.add(program, `run() counted ${run.stepsRun} steps; step ${i + 1} ran nothing`)
            return
          }
          // run() stops at the first place where it should: it passes no stop point.
          const state = bySteps.getSnapshot()
          const last = i === run.stepsRun - 1
          const atBreakpoint =
            state.inLibrary === null &&
            state.nextLine !== null &&
            breakpoints.includes(state.nextLine)
          if (!last && (state.status !== 'running' || atBreakpoint)) {
            const at = `status ${state.status}, next line ${String(state.nextLine)}`
            problems.add(program, `run() went on after step ${i + 1} (${at})`)
            return
          }
        }
        if (run.reason === 'waiting-input' && bySteps.step().executed) {
          problems.add(program, 'run() stopped for input, but step() could run')
        }
        if (run.reason === 'breakpoint') {
          const line = byRun.getSnapshot().nextLine
          if (run.stepsRun === 0)
            problems.add(program, 'run() stopped at a breakpoint after 0 steps')
          if (line === null || !breakpoints.includes(line)) {
            problems.add(program, `run() stopped at line ${String(line)}, not at a breakpoint`)
          }
        }
        if (run.reason === 'step-limit' && run.stepsRun !== options.maxSteps) {
          problems.add(program, `step-limit after ${run.stepsRun} steps`)
        }
        const difference = stateDifference(byRun.getSnapshot(), bySteps.getSnapshot())
        if (difference !== null) {
          problems.add(program, `after run() number ${round + 1} (${run.reason}): ${difference}`)
          return
        }
        if (run.reason === 'waiting-input') {
          const line = input.shift()
          if (line === undefined) return
          byRun.provideInput(line)
          bySteps.provideInput(line)
        } else if (run.reason !== 'breakpoint') return
      }
    })
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('5. reset() equals a fresh emulator (breakpoints stay), and the future is the same too', () => {
    const problems = forEachProgram(ALL_PROGRAMS, (program, problems, index) => {
      const rng = new Random(111_000 + index)
      const breakpoints = rng.sample(instructionLines(program), 2)
      const used = emulatorFor(program)
      used.setBreakpoints(breakpoints)
      const input = [...program.input, 'zz']
      for (let op = 0; op < 40; op++) {
        const roll = rng.next()
        if (roll < 0.6) used.step()
        else if (roll < 0.7) used.run()
        else if (roll < 0.85) used.stepBack()
        else used.provideInput(rng.pick(input))
      }
      used.reset()
      const fresh = emulatorFor(program)
      fresh.setBreakpoints(breakpoints)
      const difference = stateDifference(used.getSnapshot(), fresh.getSnapshot())
      if (difference !== null) {
        problems.add(program, `after reset(): ${difference}`)
        return
      }
      // Hidden state must be gone too: both machines now do exactly the same.
      for (let op = 0; op < 64; op++) {
        const roll = rng.next()
        let left: unknown = null
        let right: unknown = null
        if (roll < 0.75) {
          left = used.step()
          right = fresh.step()
        } else if (roll < 0.85) {
          left = used.run()
          right = fresh.run()
        } else if (roll < 0.95) {
          left = used.stepBack()
          right = fresh.stepBack()
        } else {
          const line = rng.pick(input)
          used.provideInput(line)
          fresh.provideInput(line)
        }
        const result = firstDifference(left, right, `operation ${op} after reset`)
        if (result !== null) {
          problems.add(program, result)
          return
        }
        if (op % 8 === 7) {
          const state = stateDifference(used.getSnapshot(), fresh.getSnapshot())
          if (state !== null) {
            problems.add(program, `operation ${op} after reset: ${state}`)
            return
          }
        }
      }
    })
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('6. snapshots are immutable and stable', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      for (const text of trace.stable) problems.add(trace.program, text)
      trace.clones.forEach(({ label, snapshot, clone }, index) => {
        const difference = firstDifference(snapshot, clone, 'snapshot')
        if (difference !== null) {
          problems.add(trace.program, `${label}: an old snapshot changed later: ${difference}`)
        }
        if (index % 4 === 0) {
          const frozen = deepFrozenProblem(snapshot, 'snapshot')
          if (frozen !== null) problems.add(trace.program, `${label}: ${frozen}`)
        }
      })
    }
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('7. register invariants: 64-bit values, 0/1 flags, partial writes, rsp moves', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      for (const step of trace.steps) {
        for (const text of registerProblems(trace.code, step)) {
          problems.add(trace.program, `${describeStep(step.result)}: ${text}`)
        }
      }
    }
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('8. stack view invariants: boxes, isRsp/isRbp, dead, changed, bytes, value, kind', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      for (const text of trace.stackView) problems.add(trace.program, text)
      for (const text of trace.dataView) problems.add(trace.program, text)
    }
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('8b. the stack view lists no box below the stack region (stackSize bytes below stackBase)', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      // One problem per program is enough: it usually shows at the first snapshot.
      const first = trace.region[0]
      if (first !== undefined) problems.add(trace.program, first)
    }
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('8c. stack labels; and without stack games: call stack, inLibrary and nextLine agree', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      for (const step of trace.steps) {
        const where = `after ${describeStep(step.result)}`
        for (const text of labelProblems(trace.code, step)) {
          problems.add(trace.program, `${where}: ${text}`)
        }
        if (trace.program.kind === 'wild') continue
        for (const text of frameProblems(trace.code, step.after)) {
          problems.add(trace.program, `${where}: ${text}`)
        }
      }
    }
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('9. speed: a 10 000-step loop runs well under the limit, with run() and with step()', () => {
    const loop = [
      '.intel_syntax noprefix',
      'main:',
      '    mov ecx, 6000',
      'again:',
      '    dec ecx',
      '    jne again',
      '    ret',
      '',
    ].join('\n')
    const busy = [
      '.intel_syntax noprefix',
      'main:',
      '    push rbp',
      '    mov rbp, rsp',
      '    sub rsp, 16',
      '    mov ebx, 2000',
      'again:',
      '    mov qword ptr [rbp-8], rbx',
      '    add rax, qword ptr [rbp-8]',
      '    call helper',
      '    dec ebx',
      '    jne again',
      '    leave',
      '    ret',
      'helper:',
      '    push rbp',
      '    pop rbp',
      '    ret',
      '',
    ].join('\n')
    for (const [name, source] of [
      ['counting loop', loop],
      ['loop with memory, push/pop and call/ret', busy],
    ] as const) {
      const first = createEmulator(source)
      const second = createEmulator(source)
      if (!first.ok || !second.ok) throw new Error(`${name} does not assemble`)
      let start = performance.now()
      const run = first.emulator.run()
      const runTime = performance.now() - start
      expect(run.reason).toBe('step-limit')
      expect(run.stepsRun).toBe(10_000)
      start = performance.now()
      for (let i = 0; i < 10_000; i++) second.emulator.step()
      const state = second.emulator.getSnapshot()
      const stepTime = performance.now() - start
      expect(state.stepCount).toBe(10_000)
      expect(stateDifference(state, first.emulator.getSnapshot())).toBeNull()
      // The target is 300 ms; the limits are generous so the test is not flaky.
      expect(runTime, `${name}: run()`).toBeLessThan(1500)
      expect(stepTime, `${name}: 10 000 × step()`).toBeLessThan(1500)
      expect(stepTime, `${name}: step() against run()`).toBeLessThan(runTime * 5 + 250)
    }
  }, 30_000)

  it('10. every step that ran has a clean explanation (code or name first, 1–3 sentences, ≤ 400 characters)', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      for (const { result } of trace.steps) {
        if (!result.executed) continue
        for (const text of explanationProblems(result)) {
          problems.add(trace.program, `${describeStep(result)}: ${text}`)
        }
      }
    }
    expect(problems.summary()).toBe('')
  }, 30_000)

  it('10b. the same holds for hand-made edge programs (an entry label with nothing after it, …)', () => {
    const problems = forEachProgram(EDGE_PROGRAMS, (program, problems) => {
      const emulator = emulatorFor(program)
      for (let count = 0; count < 2000; count++) {
        const result = emulator.step()
        if (!result.executed) break
        for (const text of explanationProblems(result)) {
          problems.add(program, `${describeStep(result)}: ${text}`)
        }
      }
    })
    expect(problems.summary()).toBe('')
  })

  it('11. tips and warnings appear exactly when due (imul flags, alignment, junk, ret)', () => {
    const problems = new Problems()
    for (const trace of allTraces()) {
      for (const text of noteProblems(trace)) problems.add(trace.program, text)
    }
    expect(problems.summary()).toBe('')
  }, 30_000)
})
