/**
 * The executor: what every instruction does (behaviour contract, sections 3 and 4).
 *
 * `executeInstruction` is PURE. It looks at the machine and at one instruction and
 * returns the `Effects` of running it: the register writes, the flag writes, the memory
 * writes, the next rip, and the facts that the explanation needs. It changes nothing.
 * The `Emulator` commits the effects only when the whole instruction succeeded, which
 * gives three things for free:
 *
 *   - atomic faults: an instruction that touches memory it does not own changes nothing;
 *   - the diff: every write is known, with its value before and after;
 *   - undo: the diff is the undo record.
 *
 * This file also holds the shapes that the executor, the library functions (`libc.ts`),
 * the explanations (`explain.ts`) and the `Emulator` share: `MachineView`, `Effects`,
 * and the facts and notes. No sentence for students is built here: wording lives in
 * `explain.ts` and `runtimeErrors.ts`.
 */
import {
  add,
  conditionHolds,
  dec,
  imul,
  inc,
  isJumpCondition,
  logic,
  sub,
  type AluResult,
  type JumpCondition,
} from './alu'
import { toSigned, truncate } from './bits'
import { MemoryFault, type Memory, type Region } from './memory'
import { mergeRegisterWrite, readRegister, reg } from './registers'
import * as say from './runtimeErrors'
import {
  LIBRARY_FUNCTIONS,
  type CallFrame,
  type FlagName,
  type Flags,
  type ImmOperand,
  type Instruction,
  type LibraryFunctionName,
  type MemOperand,
  type OperandSize,
  type Program,
  type Reg64,
  type RegisterFile,
  type RegisterInfo,
  type RegOperand,
  type TargetOperand,
} from './types'

/* ───────────────────────────── The machine, read-only ───────────────────────────── */

/**
 * What wrote the flags last. The notes and the explanation of a conditional jump use it.
 * (Null in the machine: nothing has written the flags yet.)
 */
export type FlagsWriter =
  /** `cmp` or `test`, with its two operands as written. */
  | { kind: 'cmp' | 'test'; first: string; second: string }
  /** `imul`: on a real CPU, ZF and SF are not defined after it. */
  | { kind: 'imul' }
  /** `add`, `sub`, `and`, `or`, `xor`, `inc` or `dec`. */
  | { kind: 'other' }
  /**
   * A library call (with junk in the caller-saved registers on): real library code may
   * change every flag, so the flags the program set before the call are gone.
   */
  | { kind: 'library'; name: LibraryFunctionName; callLine: number }

/** What the executor may look at. Nothing here is changed by it. */
export interface MachineView {
  readonly program: Program
  readonly registers: Readonly<RegisterFile>
  readonly flags: Readonly<Flags>
  readonly memory: Memory
  /** The stack region: for stack overflow and for the "never written" warning. */
  readonly stack: Region
  /** A `ret` that pops exactly this value ends the program. */
  readonly osReturnAddress: bigint
  /** Active calls, outermost first. */
  readonly callStack: readonly CallFrame[]
  /** What wrote the flags last (null: nothing has written them yet). */
  readonly flagsWriter: FlagsWriter | null
}

/* ─────────────────────────────────── Effects ─────────────────────────────────── */

export interface RegisterWrite {
  reg: RegisterInfo
  value: bigint
}

export interface MemoryWrite {
  address: bigint
  /** The bytes to store, lowest address first. */
  bytes: readonly number[]
}

/** What a stack box holds, for its label in the stack panel. */
export type StackLabelFacts =
  /** A return address saved by `call`. `line` is the line it returns to, when it is an instruction. */
  | { kind: 'return-address'; line: number | null }
  /** A register saved by `push`. */
  | { kind: 'saved-register'; register: string }
  /** A box reached through an `.equ` name: `count[rbp]`. `offset` is added to the name. */
  | { kind: 'local'; names: readonly string[]; offset: bigint }

/** A change to the label of one stack box (`box` is its address, a multiple of 8). */
export type StackLabelEffect =
  | { box: bigint; set: StackLabelFacts }
  /**
   * The box got a new value and its old label may be wrong now. 'always' forgets any
   * label; 'unless-local' keeps an `.equ` name (a variable keeps its name when it is
   * written through a pointer).
   */
  | { box: bigint; clear: 'always' | 'unless-local' }

/** The kinds of value `scanf` reads. */
export type ScanKind = 'decimal' | 'integer' | 'unsigned' | 'hex' | 'character' | 'word'

/** What `scanf` found in the input where it wanted something else. */
export type FoundInput =
  | { kind: 'space' }
  | { kind: 'tab' }
  /** A new line (Enter), or `\r` of a Windows line end. */
  | { kind: 'line-end' }
  /** Other white space (`\v`, `\f`). */
  | { kind: 'white-space' }
  /** The next word of the input. */
  | { kind: 'text'; text: string }

/** A tip or a warning, as facts. `explain.ts` writes the sentence. */
export type NoteFacts =
  /** A `call` to a library function while rsp was not a multiple of 16. */
  | { kind: 'misaligned-call'; rsp: bigint; functionName: LibraryFunctionName }
  /** A read of stack bytes that were never written (`missing` of the `bytes` read). */
  | { kind: 'uninitialized-read'; address: bigint; bytes: number; missing: number }
  /**
   * Text that a library function read has no 0 byte at its end. At `at` it ran into a
   * stack byte that was never written ('stack'), or past the last byte of the program's
   * data, where the rest of the page reads as 0 ('data').
   */
  | {
      kind: 'unterminated-text'
      start: bigint
      at: bigint
      ranInto: 'stack' | 'data'
      functionName: 'printf' | 'puts' | 'scanf'
    }
  /** A read of the program's own code: the emulator stores no instruction bytes. */
  | { kind: 'code-read'; address: bigint; bytes: number; label: string | null }
  /** `ret` used a value that is not the return address the last `call` saved. */
  | { kind: 'return-mismatch'; used: bigint; saved: bigint | null }
  /** A conditional jump read ZF or SF that `imul` wrote. */
  | { kind: 'imul-flags'; written: string }
  /** A conditional jump read flags from before a library call (which may change them). */
  | { kind: 'library-flags'; written: string; functionName: LibraryFunctionName; callLine: number }
  /** A library function left junk in the caller-saved registers. */
  | { kind: 'junk-registers'; functionName: LibraryFunctionName; registers: readonly Reg64[] }
  /**
   * `scanf` could not read the kind of value it wanted. What it found stays in the
   * input, as in C: the next `scanf` starts there.
   */
  | {
      kind: 'scanf-mismatch'
      wanted: ScanKind | { literal: string }
      found: FoundInput
      stored: number
    }

/** What the machine does after the step. */
export type StepOutcome =
  | { status: 'running' }
  | { status: 'halted' }
  /** The step is applied, and then the program stops (rip is not a place that can run). */
  | { status: 'error'; problem: say.RuntimeProblem }

export interface Effects {
  /** Applied in order (so the last write to a register wins). */
  registerWrites: RegisterWrite[]
  flagWrites: Partial<Flags>
  memoryWrites: MemoryWrite[]
  nextRip: bigint
  stackLabels: StackLabelEffect[]
  /** A new call frame, or how many frames are left after a return. Null: no change. */
  callStack: { push: CallFrame } | { keep: number } | null
  /** `enter`: this `call` went into a library function. 'leave': the function returned. */
  library: { enter: { name: LibraryFunctionName; callLine: number } } | 'leave' | null
  /** What wrote the flags last, after this step. Null: no change. */
  flagsWriter: FlagsWriter | null
  /** Text printed by this step. */
  output: string
  /** How many bytes of standard input are used up after this step. Null: no change. */
  stdinPosition: number | null
  outcome: StepOutcome
  facts: StepFacts
  notes: NoteFacts[]
}

export type ExecutionResult =
  /** The instruction ran. */
  | { ok: true; effects: Effects }
  /** The instruction faulted: nothing changes and the program stops. */
  | { ok: false; problem: say.RuntimeProblem }

/* ──────────────────────────── Facts for the explanation ──────────────────────────── */

/** A memory operand and how its address was worked out. */
export interface AddressFacts {
  operand: MemOperand
  /** The effective address, wrapped to 64 bits. */
  address: bigint
  base: { name: Reg64; value: bigint } | null
  index: { name: Reg64; value: bigint; scale: 1 | 2 | 4 | 8 } | null
  /** The `.equ` names used in the operand, with their values. */
  constants: { name: string; value: bigint }[]
}

/** A value an instruction read, and where it came from. */
export type OperandFacts =
  | { kind: 'reg'; reg: RegisterInfo; value: bigint }
  | { kind: 'imm'; operand: ImmOperand; value: bigint }
  | { kind: 'mem'; access: AddressFacts; bytes: number; value: bigint }

/** Where an instruction stored its result. */
export type DestinationFacts =
  /** `before` and `after` are the whole 64-bit register. */
  | { kind: 'reg'; reg: RegisterInfo; before: bigint; after: bigint }
  | { kind: 'mem'; access: AddressFacts; bytes: number }

/** Where a jump or a call goes. `line` is null when no instruction starts there. */
export interface TargetFacts {
  name: string
  address: bigint
  line: number | null
}

export type ArithmeticOp = 'add' | 'sub' | 'imul' | 'and' | 'or' | 'xor' | 'inc' | 'dec'

export type InstructionFacts =
  | {
      kind: 'mov'
      mnemonic: 'mov' | 'movzx' | 'movsx'
      source: OperandFacts
      /** Width of the source in bits (smaller than `size` for movzx and movsx). */
      sourceSize: OperandSize
      destination: DestinationFacts
      size: OperandSize
      /** The value stored, `size` bits wide. */
      value: bigint
    }
  | {
      kind: 'lea'
      access: AddressFacts
      destination: Extract<DestinationFacts, { kind: 'reg' }>
      size: OperandSize
      value: bigint
    }
  | {
      kind: 'push'
      source: Extract<OperandFacts, { kind: 'reg' | 'imm' }>
      value: bigint
      rspBefore: bigint
      rspAfter: bigint
    }
  | { kind: 'pop'; register: RegisterInfo; value: bigint; rspBefore: bigint; rspAfter: bigint }
  | {
      kind: 'arithmetic'
      op: ArithmeticOp
      size: OperandSize
      /** The two inputs and the result, `size` bits wide (for inc and dec, `b` is 1). */
      a: bigint
      b: bigint
      result: bigint
      first: OperandFacts
      /** Null for inc and dec. */
      second: OperandFacts | null
      destination: DestinationFacts
      /** The flags after the instruction. */
      flags: Flags
      /** The flags it wrote, in order. */
      flagsWritten: FlagName[]
    }
  | {
      kind: 'compare'
      op: 'cmp' | 'test'
      size: OperandSize
      a: bigint
      b: bigint
      result: bigint
      first: OperandFacts
      second: OperandFacts
      flags: Flags
    }
  | { kind: 'jmp'; target: TargetFacts }
  | {
      kind: 'jcc'
      condition: JumpCondition
      /** The mnemonic as typed (`jz`, `jnle`, …). */
      written: string
      flags: Flags
      taken: boolean
      target: TargetFacts
      /** The line that runs next when the jump is not taken (null: none). */
      nextLine: number | null
      /** What wrote the flags this jump reads (null: nothing yet). */
      writer: FlagsWriter | null
    }
  | {
      kind: 'call'
      target: TargetFacts
      /** Set when the call went into a library function. */
      library: LibraryFunctionName | null
      returnAddress: bigint
      /** The line of the instruction at the return address (null: there is none). */
      returnLine: number | null
      rspBefore: bigint
      rspAfter: bigint
    }
  | {
      kind: 'ret'
      /** The value popped into rip. */
      address: bigint
      rspBefore: bigint
      rspAfter: bigint
      /** 'os': the program ended. 'instruction': it goes on at `line`. 'nowhere': an error. */
      lands: 'os' | 'instruction' | 'nowhere'
      line: number | null
      /** True when the value is the return address that the last `call` saved. */
      saved: boolean
      /** The value in eax (what `main` returns). */
      eax: bigint
      entryLabel: string | null
    }
  | {
      kind: 'leave'
      /** rbp before: the address rsp was set to. */
      rbp: bigint
      /** The value popped into rbp. */
      value: bigint
      rspBefore: bigint
      rspAfter: bigint
    }
  | { kind: 'nop'; written: string }

/** How a library function went back to the program. */
export interface ReturnFacts {
  /** The value popped into rip (the return address, unless the call changed it). */
  address: bigint
  rspBefore: bigint
  rspAfter: bigint
  /** The line the program goes on at (null: no instruction there). */
  line: number | null
  /** True when the call itself stored something over its return address (scanf can). */
  changed: boolean
}

/** One value that `scanf` stored. */
export type ScanItem =
  | {
      kind: 'number'
      conversion: ScanKind
      value: bigint
      /** The input it was read from, as typed (`010`, `-5`, `0x1f`). */
      typed: string
      address: bigint
      bytes: number
    }
  | { kind: 'character'; codes: number[]; address: bigint; bytes: number }
  | { kind: 'word'; text: string; address: bigint; bytes: number }

export type LibraryFacts =
  | {
      kind: 'print'
      name: 'printf' | 'puts'
      /** How many bytes were printed (this is the value left in eax). */
      bytes: number
      /** How many characters that is (fewer than `bytes` for text outside ASCII). */
      characters: number
      eax: bigint
      returned: ReturnFacts
    }
  | { kind: 'putchar'; code: number; eax: bigint; returned: ReturnFacts }
  | {
      kind: 'scanf'
      stored: ScanItem[]
      /** How many values the format asks for (`%*d` and the like are not counted). */
      wanted: number
      /** True when scanf stopped before it had all of them. */
      failed: boolean
      eax: bigint
      returned: ReturnFacts
    }
  | { kind: 'exit'; code: bigint }

export type StepFacts = InstructionFacts | LibraryFacts

/* ───────────────────────────── Helpers shared with libc ───────────────────────────── */

const RSP = reg('rsp')
const RBP = reg('rbp')
const EAX = reg('eax')

/** `value` as `count` little-endian bytes. */
export function littleEndianBytes(value: bigint, count: number): number[] {
  const bytes: number[] = []
  let rest = BigInt.asUintN(count * 8, value)
  for (let i = 0; i < count; i++) {
    bytes.push(Number(rest & 0xffn))
    rest >>= 8n
  }
  return bytes
}

/** The address of the 8-byte stack box that holds `address`. */
export function boxOf(address: bigint): bigint {
  return address - (address % 8n)
}

/** The line of the instruction that starts at `address`, or null. */
export function lineAt(program: Program, address: bigint): number | null {
  const index = program.addressToIndex.get(address)
  return index === undefined ? null : (program.instructions[index]?.line ?? null)
}

export interface WriteFault {
  code: 'bad-memory-write' | 'write-read-only'
  /** The first byte that cannot be written. */
  address: bigint
  region: 'text' | 'rodata' | null
}

/** Why `bytes` bytes at `address` cannot be written, or null when they can. */
export function findWriteFault(memory: Memory, address: bigint, bytes: number): WriteFault | null {
  for (let i = 0; i < bytes; i++) {
    const at = address + BigInt(i)
    const region = memory.regionAt(at)
    if (region === null) return { code: 'bad-memory-write', address: at, region: null }
    if (!region.writable) {
      const name = region.name === 'text' ? 'text' : 'rodata'
      return { code: 'write-read-only', address: at, region: name }
    }
  }
  return null
}

/** How many of the `bytes` bytes at `address` were never written. */
export function countUnwritten(memory: Memory, address: bigint, bytes: number): number {
  return memory.peekBytes(address, bytes).filter((byte) => byte === null).length
}

/** The data label whose bytes include `address`, or null. */
function dataLabelAt(program: Program, address: bigint): string | null {
  for (const item of program.data) {
    if (address >= item.address && address < item.address + BigInt(item.bytes.length)) {
      return item.label
    }
  }
  return null
}

/**
 * The function that the instruction at `address` belongs to: the nearest label before
 * it that is the start of the program or the target of a `call`. Null when unknown.
 */
function functionAt(program: Program, address: bigint): string | null {
  const called = new Set<string>()
  if (program.entryLabel !== null) called.add(program.entryLabel)
  for (const instruction of program.instructions) {
    const target = instruction.operands.at(0)
    if (instruction.mnemonic === 'call' && target?.kind === 'target' && !target.external) {
      called.add(target.name)
    }
  }
  let best: { name: string; address: bigint } | null = null
  for (const symbol of program.symbols.values()) {
    if (symbol.kind !== 'code' || symbol.address > address || !called.has(symbol.name)) continue
    if (best === null || symbol.address > best.address) best = symbol
  }
  return best === null ? null : best.name
}

/**
 * What happens when rip moves on to `next` without a jump: the program goes on, or it
 * ran past its last instruction.
 */
function fallThroughOutcome(
  program: Program,
  next: bigint,
  from: { line: number; address: bigint; text: string },
): StepOutcome {
  if (program.addressToIndex.has(next)) return { status: 'running' }
  if (next === program.layout.textEnd) {
    const functionName = functionAt(program, from.address)
    return {
      status: 'error',
      problem: say.ranOffEnd(from.line, {
        reason: 'last-instruction',
        text: from.text,
        functionName,
      }),
    }
  }
  return {
    status: 'error',
    problem: say.badJump(from.line, { reason: 'other', text: from.text, value: next }),
  }
}

/* ────────────────────────────── One instruction ────────────────────────────── */

/** Thrown inside the executor when the instruction faults. Never leaves this file. */
class Stop extends Error {
  readonly problem: say.RuntimeProblem

  constructor(problem: say.RuntimeProblem) {
    super(problem.error.message)
    this.name = 'Stop'
    this.problem = problem
  }
}

/** Everything one run of an instruction needs. */
interface Run {
  view: MachineView
  instruction: Instruction
  /** The address of the next instruction: what rip holds while this one runs. */
  next: bigint
  /** What the instruction will write, collected while it is worked out. */
  registerWrites: RegisterWrite[]
  memoryWrites: MemoryWrite[]
  notes: NoteFacts[]
  labels: StackLabelEffect[]
}

type DataOperand = RegOperand | ImmOperand | MemOperand

/** The conditional jumps that look at ZF or SF (both are undefined after `imul` on a real CPU). */
const READS_ZF_OR_SF: ReadonlySet<JumpCondition> = new Set<JumpCondition>([
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

function dataOperand(instruction: Instruction, position: number): DataOperand {
  const operand = instruction.operands.at(position)
  if (operand === undefined || operand.kind === 'target') {
    throw new Error(`${instruction.text}: operand ${position + 1} is missing or is a label`)
  }
  return operand
}

function targetOperand(instruction: Instruction): TargetOperand {
  const operand = instruction.operands.at(0)
  if (operand === undefined || operand.kind !== 'target') {
    throw new Error(`${instruction.text}: the jump target is missing`)
  }
  return operand
}

/** The width the instruction works on. (The assembler always sets it for data instructions.) */
function widthOf(instruction: Instruction): OperandSize {
  return instruction.opSize ?? 64
}

/** The effects collected so far, with rip moving on to the next instruction. */
function effectsFor(run: Run, facts: StepFacts): Effects {
  return {
    registerWrites: run.registerWrites,
    flagWrites: {},
    memoryWrites: run.memoryWrites,
    nextRip: run.next,
    stackLabels: run.labels,
    callStack: null,
    library: null,
    flagsWriter: null,
    output: '',
    stdinPosition: null,
    outcome: { status: 'running' },
    facts,
    notes: run.notes,
  }
}

/** The effects of an instruction that falls through to the next one. */
function straightLine(run: Run, facts: StepFacts): Effects {
  const effects = effectsFor(run, facts)
  effects.outcome = fallThroughOutcome(run.view.program, run.next, run.instruction)
  return effects
}

/** Work out the address of a memory operand. Never reads memory, never faults. */
function addressOf(run: Run, operand: MemOperand): AddressFacts {
  const { registers, program } = run.view
  const constants: AddressFacts['constants'] = []
  for (const name of operand.equNames) {
    const value = program.constants.get(name)
    if (value !== undefined) constants.push({ name, value })
  }
  if (operand.base === 'rip') {
    // `label[rip]`: the assembler already worked out the distance from rip.
    const address = truncate(operand.symbolAddress + operand.disp, 64)
    return { operand, address, base: null, index: null, constants }
  }
  const base = operand.base === null ? null : { name: operand.base, value: registers[operand.base] }
  const index =
    operand.index === null
      ? null
      : { name: operand.index, value: registers[operand.index], scale: operand.scale }
  const sum =
    operand.symbolAddress +
    (base === null ? 0n : base.value) +
    (index === null ? 0n : index.value * BigInt(index.scale)) +
    operand.disp
  return { operand, address: truncate(sum, 64), base, index, constants }
}

function addressRegisters(access: AddressFacts): say.AddressRegister[] {
  const registers: say.AddressRegister[] = []
  if (access.base !== null) registers.push(access.base)
  if (access.index !== null) registers.push(access.index)
  return registers
}

/**
 * The label of the stack box that a memory operand reaches. An operand that uses an
 * `.equ` name with rbp or rsp names the box (`count[rbp]`). Any other write means the
 * old label of the box may be wrong.
 */
function touchStack(run: Run, access: AddressFacts, bytes: number, wrote: boolean): void {
  const { stack } = run.view
  const { operand, address } = access
  if (address < stack.start || address >= stack.end) return
  const direct = operand.base === 'rbp' || operand.base === 'rsp'
  const box = boxOf(address)
  const named = direct && access.constants.length > 0
  if (named) {
    const base = access.base === null ? 0n : access.base.value
    const names = access.constants.map((constant) => constant.name)
    const total = access.constants.reduce((sum, constant) => sum + constant.value, 0n)
    // What is added to the names to reach this address: 0 for `count[rbp]`, 8 for `count+8[rbp]`.
    const offset = toSigned(truncate(address - base - total, 64), 64)
    run.labels.push({ box, set: { kind: 'local', names, offset } })
  }
  if (!wrote) return
  const last = boxOf(address + BigInt(Math.max(bytes, 1) - 1))
  for (let other = box; other <= last; other += 8n) {
    if (named && other === box) continue
    run.labels.push({ box: other, clear: direct ? 'always' : 'unless-local' })
  }
}

/** Read `bytes` bytes at a memory operand's address. Faults become a `Stop`. */
function readAt(run: Run, access: AddressFacts, bytes: number): bigint {
  const { memory, stack, program } = run.view
  const { instruction } = run
  let read: { value: bigint; uninitialized: boolean }
  try {
    read = memory.read(access.address, bytes)
  } catch (thrown) {
    if (!(thrown instanceof MemoryFault)) throw thrown
    throw new Stop(
      say.badMemoryRead(instruction.line, {
        text: instruction.text,
        address: access.address,
        bytes,
        faultAddress: thrown.address,
        access: { via: 'operand', registers: addressRegisters(access) },
      }),
    )
  }
  if (read.uninitialized) {
    const region = memory.regionAt(access.address)
    if (region === stack) {
      const missing = countUnwritten(memory, access.address, bytes)
      run.notes.push({ kind: 'uninitialized-read', address: access.address, bytes, missing })
    } else if (region !== null && region.name === 'text') {
      const symbol = access.operand.symbol
      const isCodeLabel = symbol !== null && program.symbols.get(symbol)?.kind === 'code'
      const bare = access.operand.base === null && access.operand.index === null
      run.notes.push({
        kind: 'code-read',
        address: access.address,
        bytes,
        label: isCodeLabel && bare ? symbol : null,
      })
    }
  }
  touchStack(run, access, bytes, false)
  return read.value
}

/** Read one operand at `size` bits. */
function readValue(run: Run, operand: DataOperand, size: OperandSize): OperandFacts {
  switch (operand.kind) {
    case 'reg':
      return { kind: 'reg', reg: operand.reg, value: readRegister(run.view.registers, operand.reg) }
    case 'imm':
      // An immediate is cut to the operand width (two's complement).
      return { kind: 'imm', operand, value: truncate(operand.value, size) }
    case 'mem': {
      const access = addressOf(run, operand)
      const bytes = size / 8
      return { kind: 'mem', access, bytes, value: readAt(run, access, bytes) }
    }
  }
}

/** Make sure `bytes` bytes at a memory operand's address can be written, or `Stop`. */
function checkWrite(run: Run, access: AddressFacts, bytes: number): void {
  const { instruction, view } = run
  const fault = findWriteFault(view.memory, access.address, bytes)
  if (fault === null) return
  if (fault.code === 'write-read-only') {
    throw new Stop(
      say.writeReadOnly(instruction.line, {
        text: instruction.text,
        address: fault.address,
        region: fault.region ?? 'rodata',
        label: dataLabelAt(view.program, fault.address),
        via: 'operand',
      }),
    )
  }
  throw new Stop(
    say.badMemoryWrite(instruction.line, {
      text: instruction.text,
      address: access.address,
      bytes,
      faultAddress: fault.address,
      access: { via: 'operand', registers: addressRegisters(access) },
    }),
  )
}

/** A register write and the facts about it (the whole register before and after). */
function writeRegister(
  run: Run,
  target: RegisterInfo,
  value: bigint,
): Extract<DestinationFacts, { kind: 'reg' }> {
  const before = run.view.registers[target.base]
  run.registerWrites.push({ reg: target, value })
  return { kind: 'reg', reg: target, before, after: mergeRegisterWrite(before, target, value) }
}

/** A memory write at an address that was already worked out. */
function writeMemory(
  run: Run,
  access: AddressFacts,
  size: OperandSize,
  value: bigint,
): DestinationFacts {
  const bytes = size / 8
  checkWrite(run, access, bytes)
  run.memoryWrites.push({ address: access.address, bytes: littleEndianBytes(value, bytes) })
  touchStack(run, access, bytes, true)
  return { kind: 'mem', access, bytes }
}

/** Store `value` in a register or in memory. */
function store(run: Run, operand: DataOperand, size: OperandSize, value: bigint): DestinationFacts {
  switch (operand.kind) {
    case 'reg':
      return writeRegister(run, operand.reg, value)
    case 'mem':
      return writeMemory(run, addressOf(run, operand), size, value)
    case 'imm':
      throw new Error(`${run.instruction.text}: a number cannot be the destination`)
  }
}

/** Where a jump or a call goes. */
function targetFacts(program: Program, operand: TargetOperand): TargetFacts {
  return { name: operand.name, address: operand.address, line: lineAt(program, operand.address) }
}

/** What happens after a jump or a call to a label of the program. */
function jumpOutcome(run: Run, target: TargetOperand): StepOutcome {
  const { instruction, view } = run
  if (view.program.addressToIndex.has(target.address)) return { status: 'running' }
  return {
    status: 'error',
    problem: say.badJump(instruction.line, {
      reason: 'label-at-end',
      text: instruction.text,
      name: target.name,
    }),
  }
}

/**
 * The new rsp for `push` and `call`, after checking that the new top box can be
 * written. `Stop` with 'stack-overflow' when rsp would leave the stack at its low end.
 */
function pushRsp(run: Run): bigint {
  const { instruction, view } = run
  const { stack, memory } = view
  const rsp = view.registers.rsp
  const below = rsp - 8n
  if (rsp >= stack.start && rsp <= stack.end && below < stack.start) {
    throw new Stop(say.stackOverflow(instruction.line, { text: instruction.text, rsp }))
  }
  const next = truncate(below, 64)
  const fault = findWriteFault(memory, next, 8)
  if (fault === null) return next
  if (fault.code === 'write-read-only') {
    // rsp points at code or read-only data: the advice is about rsp, not about an operand.
    throw new Stop(
      say.writeReadOnly(instruction.line, {
        text: instruction.text,
        address: fault.address,
        region: fault.region ?? 'rodata',
        label: dataLabelAt(view.program, fault.address),
        via: 'stack-top',
      }),
    )
  }
  throw new Stop(
    say.badMemoryWrite(instruction.line, {
      text: instruction.text,
      address: next,
      bytes: 8,
      faultAddress: fault.address,
      access: { via: 'stack-top' },
    }),
  )
}

/** Read the 8 bytes of a stack box (`pop`, `ret`, `leave`). Faults become a `Stop`. */
function readBox(run: Run, address: bigint, via: 'stack-top' | 'rbp'): bigint {
  const { instruction, view } = run
  let read: { value: bigint; uninitialized: boolean }
  try {
    read = view.memory.read(address, 8)
  } catch (thrown) {
    if (!(thrown instanceof MemoryFault)) throw thrown
    throw new Stop(
      say.badMemoryRead(instruction.line, {
        text: instruction.text,
        address,
        bytes: 8,
        faultAddress: thrown.address,
        access: { via },
      }),
    )
  }
  if (read.uninitialized && view.memory.regionAt(address) === view.stack) {
    const missing = countUnwritten(view.memory, address, 8)
    run.notes.push({ kind: 'uninitialized-read', address, bytes: 8, missing })
  }
  return read.value
}

/* ───────────────────────── mov, movzx, movsx, lea ───────────────────────── */

function runMove(run: Run, mnemonic: 'mov' | 'movzx' | 'movsx'): Effects {
  const { instruction } = run
  const destination = dataOperand(instruction, 0)
  const source = dataOperand(instruction, 1)
  const size = widthOf(instruction)

  // movzx and movsx read a narrower source.
  let sourceSize = size
  if (mnemonic !== 'mov') {
    if (source.kind === 'reg') sourceSize = source.reg.size
    else if (source.kind === 'mem') sourceSize = source.size ?? 8
  }

  const from = readValue(run, source, sourceSize)
  const value = mnemonic === 'movsx' ? truncate(toSigned(from.value, sourceSize), size) : from.value

  const to = store(run, destination, size, value)
  return straightLine(run, {
    kind: 'mov',
    mnemonic,
    source: from,
    sourceSize,
    destination: to,
    size,
    value,
  })
}

function runLea(run: Run): Effects {
  const { instruction } = run
  const destination = dataOperand(instruction, 0)
  const source = dataOperand(instruction, 1)
  if (destination.kind !== 'reg' || source.kind !== 'mem') {
    throw new Error(`${instruction.text}: lea needs a register and a memory expression`)
  }
  const size = widthOf(instruction)
  const access = addressOf(run, source)
  // `lea` only does the arithmetic. It still shows which box an `.equ` name means.
  touchStack(run, access, 0, false)
  const value = truncate(access.address, size)
  const to = writeRegister(run, destination.reg, value)
  return straightLine(run, { kind: 'lea', access, destination: to, size, value })
}

/* ─────────────────────────────── push, pop ─────────────────────────────── */

function runPush(run: Run): Effects {
  const { instruction, view } = run
  const operand = dataOperand(instruction, 0)
  if (operand.kind === 'mem') throw new Error(`${instruction.text}: push cannot take memory`)
  // The value is read first, so `push rsp` stores the OLD rsp. A number is
  // sign-extended to 64 bits.
  const source: Extract<OperandFacts, { kind: 'reg' | 'imm' }> =
    operand.kind === 'reg'
      ? { kind: 'reg', reg: operand.reg, value: readRegister(view.registers, operand.reg) }
      : { kind: 'imm', operand, value: truncate(operand.value, 64) }
  const rspBefore = view.registers.rsp
  const rspAfter = pushRsp(run)

  const box = boxOf(rspAfter)
  if (source.kind === 'reg') {
    run.labels.push({ box, set: { kind: 'saved-register', register: source.reg.name } })
  } else {
    run.labels.push({ box, clear: 'always' })
  }

  run.registerWrites.push({ reg: RSP, value: rspAfter })
  run.memoryWrites.push({ address: rspAfter, bytes: littleEndianBytes(source.value, 8) })
  return straightLine(run, { kind: 'push', source, value: source.value, rspBefore, rspAfter })
}

function runPop(run: Run): Effects {
  const { instruction, view } = run
  const operand = dataOperand(instruction, 0)
  if (operand.kind !== 'reg') throw new Error(`${instruction.text}: pop needs a register`)
  const rspBefore = view.registers.rsp
  const value = readBox(run, rspBefore, 'stack-top')
  const rspAfter = truncate(rspBefore + 8n, 64)

  // rsp moves first, then the register gets the value (so `pop rsp` ends with the value).
  run.registerWrites.push({ reg: RSP, value: rspAfter })
  run.registerWrites.push({ reg: operand.reg, value })
  return straightLine(run, {
    kind: 'pop',
    register: operand.reg,
    value,
    rspBefore,
    // `pop rsp` leaves the popped value in rsp.
    rspAfter: operand.reg.base === 'rsp' ? value : rspAfter,
  })
}

/* ─────────────────────── Arithmetic, logic and compares ─────────────────────── */

function compute(
  op: ArithmeticOp | 'cmp' | 'test',
  a: bigint,
  b: bigint,
  size: OperandSize,
  flags: Flags,
): AluResult {
  switch (op) {
    case 'add':
      return add(a, b, size)
    case 'sub':
    case 'cmp':
      return sub(a, b, size)
    case 'imul':
      return imul(a, b, size)
    case 'and':
    case 'test':
      return logic('and', a, b, size)
    case 'or':
      return logic('or', a, b, size)
    case 'xor':
      return logic('xor', a, b, size)
    case 'inc':
      return inc(a, size, flags)
    case 'dec':
      return dec(a, size, flags)
  }
}

/** `add`, `sub`, `imul`, `and`, `or`, `xor`, `inc`, `dec`: compute, store, write flags. */
function runArithmetic(run: Run, op: ArithmeticOp): Effects {
  const { instruction, view } = run
  const destination = dataOperand(instruction, 0)
  const unary = op === 'inc' || op === 'dec'
  const size = widthOf(instruction)
  const bytes = size / 8

  // A memory destination is read and written at the same address: work it out once.
  const access = destination.kind === 'mem' ? addressOf(run, destination) : null
  const first: OperandFacts =
    access !== null
      ? { kind: 'mem', access, bytes, value: readAt(run, access, bytes) }
      : readValue(run, destination, size)
  const second = unary ? null : readValue(run, dataOperand(instruction, 1), size)

  const a = first.value
  const b = second === null ? 1n : second.value
  const { result, flags } = compute(op, a, b, size, view.flags)

  const to =
    access !== null ? writeMemory(run, access, size, result) : store(run, destination, size, result)

  // inc and dec leave CF alone.
  const flagsWritten: FlagName[] = unary ? ['ZF', 'SF', 'OF'] : ['CF', 'ZF', 'SF', 'OF']
  const flagWrites: Partial<Flags> = {}
  for (const name of flagsWritten) flagWrites[name] = flags[name]

  const effects = straightLine(run, {
    kind: 'arithmetic',
    op,
    size,
    a,
    b,
    result,
    first,
    second,
    destination: to,
    flags: { ...view.flags, ...flagWrites },
    flagsWritten,
  })
  effects.flagWrites = flagWrites
  effects.flagsWriter = op === 'imul' ? { kind: 'imul' } : { kind: 'other' }
  return effects
}

/** `cmp` and `test`: compute, write flags, store nothing. */
function runCompare(run: Run, op: 'cmp' | 'test'): Effects {
  const { instruction, view } = run
  const size = widthOf(instruction)
  const left = dataOperand(instruction, 0)
  const right = dataOperand(instruction, 1)
  const first = readValue(run, left, size)
  const second = readValue(run, right, size)
  const { result, flags } = compute(op, first.value, second.value, size, view.flags)

  const effects = straightLine(run, {
    kind: 'compare',
    op,
    size,
    a: first.value,
    b: second.value,
    result,
    first,
    second,
    flags,
  })
  effects.flagWrites = { CF: flags.CF, ZF: flags.ZF, SF: flags.SF, OF: flags.OF }
  effects.flagsWriter = { kind: op, first: left.text, second: right.text }
  return effects
}

/* ───────────────────────────── Jumps, call, ret ───────────────────────────── */

function runJump(run: Run): Effects {
  const { view, instruction } = run
  const target = targetOperand(instruction)
  const effects = effectsFor(run, { kind: 'jmp', target: targetFacts(view.program, target) })
  effects.nextRip = target.address
  effects.outcome = jumpOutcome(run, target)
  return effects
}

function runConditionalJump(run: Run, condition: JumpCondition): Effects {
  const { view, instruction } = run
  const target = targetOperand(instruction)
  const taken = conditionHolds(condition, view.flags)
  const writer = view.flagsWriter
  if (writer?.kind === 'library') {
    // Every jump reads some flag, and real library code may have changed all of them.
    run.notes.push({
      kind: 'library-flags',
      written: instruction.written,
      functionName: writer.name,
      callLine: writer.callLine,
    })
  } else if (writer?.kind === 'imul' && READS_ZF_OR_SF.has(condition)) {
    run.notes.push({ kind: 'imul-flags', written: instruction.written })
  }
  const effects = effectsFor(run, {
    kind: 'jcc',
    condition,
    written: instruction.written,
    flags: { ...view.flags },
    taken,
    target: targetFacts(view.program, target),
    nextLine: lineAt(view.program, run.next),
    writer,
  })
  if (taken) {
    effects.nextRip = target.address
    effects.outcome = jumpOutcome(run, target)
  } else {
    effects.outcome = fallThroughOutcome(view.program, run.next, instruction)
  }
  return effects
}

function isLibraryName(name: string): name is LibraryFunctionName {
  return Object.hasOwn(LIBRARY_FUNCTIONS, name)
}

function runCall(run: Run): Effects {
  const { view, instruction } = run
  const target = targetOperand(instruction)
  const rspBefore = view.registers.rsp
  const rspAfter = pushRsp(run)
  const returnAddress = run.next
  const library = target.external && isLibraryName(target.name) ? target.name : null

  run.labels.push({
    box: boxOf(rspAfter),
    set: { kind: 'return-address', line: lineAt(view.program, returnAddress) },
  })

  run.registerWrites.push({ reg: RSP, value: rspAfter })
  run.memoryWrites.push({ address: rspAfter, bytes: littleEndianBytes(returnAddress, 8) })
  const effects = effectsFor(run, {
    kind: 'call',
    target: targetFacts(view.program, target),
    library,
    returnAddress,
    returnLine: lineAt(view.program, returnAddress),
    rspBefore,
    rspAfter,
  })
  effects.nextRip = target.address

  if (library !== null) {
    // Real library code expects rsp to be a multiple of 16 right before the call.
    if (rspBefore % 16n !== 0n) {
      run.notes.push({ kind: 'misaligned-call', rsp: rspBefore, functionName: library })
    }
    effects.library = { enter: { name: library, callLine: instruction.line } }
    return effects
  }

  effects.callStack = {
    push: {
      functionName: target.name,
      callLine: instruction.line,
      returnAddress,
      slotAddress: rspAfter,
    },
  }
  effects.outcome = jumpOutcome(run, target)
  return effects
}

/**
 * How many call frames are left after a `ret` that popped `value` from the box at
 * `slot`, and whether that value is the return address the last `call` saved.
 *
 * A frame ends when its return address is popped, and also when its return-address box
 * is popped with something else in it, or is left below rsp: a frame stays only while
 * its box is still on the stack. (So a `ret` that pops a pushed value and jumps to a
 * wrong place keeps the frame: its return address is still there, above rsp.)
 */
function framesAfterReturn(
  frames: readonly CallFrame[],
  value: bigint,
  slot: bigint,
): { keep: number; matched: boolean } {
  const top = frames.at(-1)
  const matched = top !== undefined && top.returnAddress === value
  let keep = matched ? frames.length - 1 : frames.length
  while (keep > 0 && frames[keep - 1].slotAddress <= slot) keep--
  return { keep, matched }
}

function runRet(run: Run): Effects {
  const { view, instruction } = run
  const { program } = view
  const rspBefore = view.registers.rsp
  const address = readBox(run, rspBefore, 'stack-top')
  const rspAfter = truncate(rspBefore + 8n, 64)
  const frames = framesAfterReturn(view.callStack, address, rspBefore)
  const line = lineAt(program, address)

  let lands: 'os' | 'instruction' | 'nowhere'
  let outcome: StepOutcome
  if (address === view.osReturnAddress) {
    lands = 'os'
    outcome = { status: 'halted' }
  } else if (line !== null) {
    lands = 'instruction'
    outcome = { status: 'running' }
    if (!frames.matched) {
      const saved = view.callStack.at(-1)?.returnAddress ?? null
      run.notes.push({ kind: 'return-mismatch', used: address, saved })
    }
  } else {
    lands = 'nowhere'
    // A `call` that is the last instruction saves the address after the code. Coming
    // back to it is not a stack mistake: there is just nothing left to run.
    const call = view.callStack.at(-1)
    const afterLastCall = frames.matched && call !== undefined && address === program.layout.textEnd
    outcome = {
      status: 'error',
      problem: afterLastCall
        ? say.badJump(instruction.line, {
            reason: 'return-to-end',
            value: address,
            callLine: call.callLine,
          })
        : say.badJump(instruction.line, { reason: 'ret', value: address }),
    }
  }

  run.registerWrites.push({ reg: RSP, value: rspAfter })
  const effects = effectsFor(run, {
    kind: 'ret',
    address,
    rspBefore,
    rspAfter,
    lands,
    line,
    saved: frames.matched,
    eax: readRegister(view.registers, EAX),
    entryLabel: program.entryLabel,
  })
  effects.nextRip = address
  effects.outcome = outcome
  // After `main` returns to the OS, no frame is left: the call stack is empty when the
  // program has ended this way. (After `exit` the frames stay: no function returned.)
  if (frames.keep !== view.callStack.length) effects.callStack = { keep: frames.keep }
  return effects
}

function runLeave(run: Run): Effects {
  const { view } = run
  const rbp = view.registers.rbp
  // rsp = rbp, then pop rbp.
  const value = readBox(run, rbp, 'rbp')
  const rspAfter = truncate(rbp + 8n, 64)
  run.registerWrites.push({ reg: RSP, value: rspAfter })
  run.registerWrites.push({ reg: RBP, value })
  return straightLine(run, {
    kind: 'leave',
    rbp,
    value,
    rspBefore: view.registers.rsp,
    rspAfter,
  })
}

/* ──────────────────────────────── Dispatch ──────────────────────────────── */

function dispatch(run: Run): Effects {
  const { instruction } = run
  const mnemonic = instruction.mnemonic
  switch (mnemonic) {
    case 'mov':
    case 'movzx':
    case 'movsx':
      return runMove(run, mnemonic)
    case 'lea':
      return runLea(run)
    case 'push':
      return runPush(run)
    case 'pop':
      return runPop(run)
    case 'add':
    case 'sub':
    case 'imul':
    case 'and':
    case 'or':
    case 'xor':
    case 'inc':
    case 'dec':
      return runArithmetic(run, mnemonic)
    case 'cmp':
    case 'test':
      return runCompare(run, mnemonic)
    case 'jmp':
      return runJump(run)
    case 'call':
      return runCall(run)
    case 'ret':
      return runRet(run)
    case 'leave':
      return runLeave(run)
    case 'nop':
      return straightLine(run, { kind: 'nop', written: instruction.written })
    default:
      if (isJumpCondition(mnemonic)) return runConditionalJump(run, mnemonic)
      throw new Error(`The executor does not know the instruction ${String(mnemonic)}`)
  }
}

/**
 * Work out what `instruction` does to the machine in `view`. Changes nothing.
 *
 * Returns the effects to commit, or (when the instruction touches memory it may not
 * touch) the problem that stops the program. In that case nothing must be committed.
 */
export function executeInstruction(view: MachineView, instruction: Instruction): ExecutionResult {
  const run: Run = {
    view,
    instruction,
    next: truncate(instruction.address + BigInt(instruction.size), 64),
    registerWrites: [],
    memoryWrites: [],
    notes: [],
    labels: [],
  }
  try {
    return { ok: true, effects: dispatch(run) }
  } catch (thrown) {
    if (thrown instanceof Stop) return { ok: false, problem: thrown.problem }
    throw thrown
  }
}
