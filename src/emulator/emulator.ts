/**
 * The `Emulator`: a `Program` goes in, and a student can step through it, step back,
 * run it, and read what every step did (behaviour contract: the `Emulator`).
 *
 * How the pieces fit:
 *
 *   step()  ─►  executor.ts / libc.ts   work out the EFFECTS of one step (pure)
 *           ─►  commit()                apply them, and build the diff from what changed
 *           ─►  explain.ts              the explanation and the notes, from the facts
 *           ─►  history                 one undo record per step (not a copy of the machine)
 *
 * - Nothing is committed unless the whole step succeeded, so a faulting step changes
 *   nothing.
 * - `stepBack()` applies one undo record in reverse: the step's diff already has every
 *   "before" value.
 * - `getSnapshot()` is lazy. A step does not build the stack view; the immutable
 *   `MachineState` is built the first time somebody asks for it after a change, and is
 *   kept until the next change. So `run()` over thousands of steps stays fast.
 * - No exception leaves `step`, `stepBack`, `run`, `reset` or `getSnapshot`. A bug in
 *   the emulator becomes `status: 'error'` with a friendly message.
 */
import { assemble } from './assembler'
import { truncate } from './bits'
import { internalProblem as assembleProblem } from './errors'
import {
  boxOf,
  executeInstruction,
  findWriteFault,
  lineAt,
  littleEndianBytes,
  type Effects,
  type FlagsWriter,
  type MemoryWrite,
} from './executor'
import * as explain from './explain'
import { decodeUtf8, runLibraryFunction, type LibraryView } from './libc'
import { Memory, type Region } from './memory'
import { utf8Bytes } from './parser'
import { createRegisterFile, lookupRegister, mergeRegisterWrite, readRegister } from './registers'
import * as say from './runtimeErrors'
import {
  DEFAULT_OPTIONS,
  FLAG_NAMES,
  LIBRARY_FUNCTIONS,
  REG64_NAMES,
  type Bit,
  type CallFrame,
  type DataItem,
  type DataView,
  type Diagnostic,
  type EmulatorApi,
  type EmulatorError,
  type EmulatorOptions,
  type FlagChange,
  type Flags,
  type Layout,
  type LibraryFunctionName,
  type MachineState,
  type MemoryChange,
  type Program,
  type Reg64,
  type RegisterChange,
  type RegisterFile,
  type RunResult,
  type RunStopReason,
  type StackSlot,
  type StackSlotKind,
  type StateDiff,
  type Status,
  type StepResult,
} from './types'

/* ──────────────────────────────── Limits ──────────────────────────────── */

/** `stepBack()` can undo at least this many steps. */
const HISTORY_LIMIT = 20_000

/** The history is cut back to `HISTORY_LIMIT` when it has grown this much past it. */
const HISTORY_SLACK = 5_000

const PAGE = 4096n

/** One past the highest address. */
const ADDRESS_LIMIT = 1n << 64n

/**
 * Addresses below this are never part of the stack (unless the starting rsp itself is
 * there). The practice "small world" stack also starts here.
 */
const NEVER_MAPPED = 0x40n

/**
 * The most boxes `snapshot.stack` holds (2 MiB of stack). The default stack is 1 MiB, so
 * this only matters when `stackSize` is made much bigger: then the lowest boxes are
 * left out, so that a snapshot can never use up the memory of the page.
 */
const MAX_STACK_BOXES = 1 << 18

/**
 * The most elements `snapshot.data` lists: for one data item, and for all of them
 * together. A program with a huge `.zero` area still gets a snapshot quickly.
 */
const MAX_ITEM_ELEMENTS = 1 << 16
const MAX_DATA_ELEMENTS = 1 << 18

/** `readMemory` gives back at most this many bytes. */
const MAX_READ_BYTES = 1 << 20

/* ──────────────────────────────── Shapes ──────────────────────────────── */

/** What `snapshot.inLibrary` holds. */
interface LibraryCall {
  name: LibraryFunctionName
  callLine: number
}

/** The label of one stack box. A box with no entry is 'value' or 'empty'. */
interface StackLabel {
  label: string | null
  kind: StackSlotKind
}

/** The lowest and the highest stack address that was written. */
interface WrittenRange {
  low: bigint
  high: bigint
}

/** The parts of a `StepResult` that say which step it is. */
interface StepBase {
  kind: 'instruction' | 'library'
  line: number
  address: bigint
  text: string
}

/** Everything `stepBack()` needs to undo one step. */
interface UndoRecord {
  /** The step. Its diff holds the register and flag values from before. */
  result: StepResult
  /** Every memory write of the step, in order, with the bytes it replaced. */
  memory: MemoryChange[]
  status: Status
  error: EmulatorError | null
  inputRequest: { prompt: string } | null
  /** The length of `output` (UTF-16 units, for `slice`) and its count of real characters. */
  outputLength: number
  outputCharacters: number
  stdinPosition: number
  inLibrary: LibraryCall | null
  flagsWriter: FlagsWriter | null
  lastStep: StepResult | null
  /** The call-stack change to take back: a frame was added, or these frames were removed. */
  callStack: { pushed: true } | { popped: CallFrame[] } | null
  stackWritten: WrittenRange | null
  /** The stack labels the step replaced, in order. */
  labels: { box: bigint; previous: StackLabel | undefined }[]
}

/** The options with their defaults filled in. */
interface Settings {
  startRsp: bigint
  osReturnAddress: bigint
  /** Label the box where rsp starts "return address (ends the program)". */
  labelStartBox: boolean
  maxSteps: number
  clobberCallerSaved: boolean
}

/* ──────────────────────────────── Helpers ──────────────────────────────── */

/** A bigint from an option that should be one (a plain whole number is accepted too). */
function asBigInt(value: unknown, fallback: bigint): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value)
  return fallback
}

function roundUp(value: bigint, step: bigint): bigint {
  const rest = value % step
  return rest === 0n ? value : value + (step - rest)
}

function roundDown(value: bigint, step: bigint): bigint {
  return value - (value % step)
}

/**
 * The stack region. It ends at least one page above the stack start and the starting
 * rsp, so a program can read a little above its starting rsp. It reaches `stackSize`
 * bytes below the stack start (types.ts: "how many bytes below `stackBase` the program
 * may use"), never below 0x40, and it always holds the box of the starting rsp.
 */
function stackRegionFor(stackBase: bigint, startRsp: bigint, stackSize: bigint): Region {
  const highest = stackBase > startRsp + 8n ? stackBase : startRsp + 8n
  let end = roundUp(highest, PAGE) + PAGE
  if (end > ADDRESS_LIMIT) end = ADDRESS_LIMIT
  let start = stackBase - stackSize
  // The lowest bytes are never memory, as on a real machine, so a NULL pointer (and a small
  // offset from it) always faults, also in a small layout whose stack would reach 0.
  if (start < NEVER_MAPPED) start = NEVER_MAPPED
  // The box of the starting rsp is always in the stack (even below that, if asked).
  if (start > boxOf(startRsp)) start = boxOf(startRsp)
  if (start < 0n) start = 0n
  return { name: 'stack', start, end, writable: true }
}

/**
 * The areas of the program. A real machine gives memory to a program in whole 4 KiB
 * pages, so reading (or, in `.data`, writing) a little past the last string or variable
 * does not fault there: each area is grown to whole pages here too. An area never grows
 * into another area or into the stack, and an empty area stays empty. Code and
 * read-only data stay read-only.
 */
function programRegions(layout: Layout, stack: Region): Region[] {
  const areas: Region[] = [
    { name: 'text', start: layout.textBase, end: layout.textEnd, writable: false },
    { name: 'rodata', start: layout.rodataBase, end: layout.rodataEnd, writable: false },
    { name: 'data', start: layout.dataBase, end: layout.dataEnd, writable: true },
  ]
  const taken = [...areas.filter((area) => area.end > area.start), stack]
  const grown = areas.map((area): Region => {
    if (area.end <= area.start) return area
    let start = roundDown(area.start, PAGE)
    let end = roundUp(area.end, PAGE)
    if (end > ADDRESS_LIMIT) end = ADDRESS_LIMIT
    for (const other of taken) {
      if (other === area) continue
      // Only the stack can overlap an area (with odd options): then the area does not grow.
      if (other.start < area.end && area.start < other.end) return area
      if (other.end <= area.start && other.end > start) start = other.end
      if (other.start >= area.end && other.start < end) end = other.start
    }
    return { ...area, start, end }
  })
  // Two grown areas can still share the gap between them: the lower area keeps it.
  const order = [0, 1, 2]
    .filter((index) => areas[index].end > areas[index].start)
    .sort((a, b) => (areas[a].start < areas[b].start ? -1 : 1))
  for (let k = 1; k < order.length; k++) {
    const lower = grown[order[k - 1]]
    const upper = grown[order[k]]
    if (upper.start < lower.end) grown[order[k]] = { ...upper, start: lower.end }
  }
  return grown
}

/** `.zero`, `.space` and `.skip` make zero bytes. They are not stored one by one. */
function isFill(item: DataItem): boolean {
  return item.text === null && /^\.(zero|space|skip)$/i.test(item.directive)
}

function emptyDiff(rip: bigint): StateDiff {
  return {
    registers: [],
    flags: [],
    memory: [],
    rip: { before: rip, after: rip },
    written: { registers: [], flags: [], memory: [] },
  }
}

/** Make a step result read-only, with everything inside it. */
function freezeResult(result: StepResult): StepResult {
  const { diff } = result
  for (const change of diff.registers) Object.freeze(change)
  for (const change of diff.flags) Object.freeze(change)
  for (const change of diff.memory) {
    Object.freeze(change.before)
    Object.freeze(change.after)
    Object.freeze(change)
  }
  for (const range of diff.written.memory) Object.freeze(range)
  Object.freeze(diff.registers)
  Object.freeze(diff.flags)
  Object.freeze(diff.memory)
  Object.freeze(diff.rip)
  Object.freeze(diff.written.registers)
  Object.freeze(diff.written.flags)
  Object.freeze(diff.written.memory)
  Object.freeze(diff.written)
  Object.freeze(diff)
  for (const note of result.notes) Object.freeze(note)
  Object.freeze(result.notes)
  if (result.error !== null) Object.freeze(result.error)
  return Object.freeze(result)
}

function sameLabel(a: StackLabel | undefined, b: StackLabel | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.kind === b.kind && a.label === b.label
}

/* ──────────────────────────────── The emulator ──────────────────────────────── */

export class Emulator implements EmulatorApi {
  readonly program: Program

  private readonly options: EmulatorOptions
  private readonly settings: Settings
  private readonly stackRegion: Region
  private readonly memory: Memory
  private readonly context: explain.ExplainContext
  /** Indexes into `program.data` of the items in the writable data area, by address. */
  private readonly writableItems: number[]
  /** How many elements of each data item `snapshot.data` lists. */
  private readonly dataLimits: number[]

  private registers: RegisterFile = createRegisterFile()
  private flags: Flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }
  private rip = 0n
  private status: Status = 'running'
  private error: EmulatorError | null = null
  private stepCount = 0
  private output = ''
  /** How many real characters `output` has (an emoji is one). The output limits count these. */
  private outputCharacters = 0
  /** Standard input as bytes, and how many of them were read. */
  private stdin: number[] = []
  private stdinPosition = 0
  private inputRequest: { prompt: string } | null = null
  private inLibrary: LibraryCall | null = null
  /** Active calls, outermost first. (Changed in place: a deep recursion must stay cheap.) */
  private callStack: CallFrame[] = []
  /** The read-only copy of `callStack` that the snapshots share (null: make it again). */
  private callStackList: readonly CallFrame[] | null = null
  private stackLabels = new Map<bigint, StackLabel>()
  private stackWritten: WrittenRange | null = null
  /** What wrote the flags last (for the notes and the explanations of jumps). */
  private flagsWriter: FlagsWriter | null = null
  private lastStep: StepResult | null = null
  private history: UndoRecord[] = []
  /**
   * The boxes of earlier stack views, so a new view rebuilds only the boxes that
   * changed. (After a deep recursion the view has many thousands of boxes.)
   */
  private boxCache = new Map<bigint, StackSlot>()
  /** Boxes whose bytes or label changed since their entry in `boxCache` was made. */
  private staleBoxes = new Set<bigint>()

  private breakpoints = new Set<number>()
  private breakpointList: readonly number[] | null = null
  private readonly listeners = new Set<{ listener: () => void }>()
  private version = 0
  private snapshot: MachineState | null = null
  /** True when something changed that the listeners do not know about yet. */
  private dirty = false
  /** The data views that are still right (null: build it again). */
  private dataViews: (DataView | null)[] = []
  private dataList: readonly DataView[] | null = null

  constructor(program: Program, options: EmulatorOptions = {}) {
    this.program = program
    this.options = options

    const stackBase = truncate(asBigInt(options.stackBase, DEFAULT_OPTIONS.stackBase), 64)
    const startRsp = truncate(
      asBigInt(options.initialRsp ?? options.initialRegisters?.rsp, stackBase - 8n),
      64,
    )
    const size = options.stackSize
    const stackSize =
      typeof size === 'number' && Number.isFinite(size) && size >= 0
        ? Math.floor(size)
        : DEFAULT_OPTIONS.stackSize
    const maxSteps = options.maxSteps
    this.settings = {
      startRsp,
      osReturnAddress: truncate(
        asBigInt(options.osReturnAddress, DEFAULT_OPTIONS.osReturnAddress),
        64,
      ),
      labelStartBox: options.labelStartBox !== false,
      maxSteps:
        typeof maxSteps === 'number' && Number.isFinite(maxSteps) && maxSteps >= 0
          ? Math.floor(maxSteps)
          : DEFAULT_OPTIONS.maxSteps,
      clobberCallerSaved: options.clobberCallerSaved ?? DEFAULT_OPTIONS.clobberCallerSaved,
    }

    // Where an area of the program meets the stack region (only with odd options), the area
    // wins, so it comes first. Otherwise the stack comes first: it is used the most, and
    // `Memory` looks at the regions in order.
    const { layout } = program
    this.stackRegion = stackRegionFor(stackBase, startRsp, BigInt(stackSize))
    const areas = programRegions(layout, this.stackRegion)
    const stack = this.stackRegion
    const overlaps = areas.some((area) => area.start < stack.end && stack.start < area.end)
    this.memory = new Memory(overlaps ? [...areas, stack] : [stack, ...areas])
    this.context = {
      stackStart: this.stackRegion.start,
      stackEnd: this.stackRegion.end,
      textBase: layout.textBase,
      textEnd: layout.textEnd,
    }

    this.writableItems = program.data
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.section === 'data' && item.bytes.length > 0)
      .sort((a, b) => (a.item.address < b.item.address ? -1 : 1))
      .map(({ index }) => index)
    let budget = MAX_DATA_ELEMENTS
    this.dataLimits = program.data.map((item) => {
      const count = Math.floor(item.bytes.length / item.elementSize)
      const shown = Math.min(count, MAX_ITEM_ELEMENTS, budget)
      budget -= shown
      return shown
    })

    this.start()
  }

  /* ───────────────────────────── The starting state ───────────────────────────── */

  /** Put the machine in its starting state (contract, section 1). Breakpoints stay. */
  private start(): void {
    const { program, options, settings } = this
    const { startRsp, osReturnAddress } = settings

    this.memory.clear()
    this.stackLabels = new Map()
    this.stackWritten = null
    this.boxCache = new Map()
    this.staleBoxes = new Set()
    this.dataViews = program.data.map(() => null)
    this.dataList = null

    for (const item of program.data) {
      // The zero bytes of `.zero` are not stored: a byte of the data areas that is not
      // stored reads as 0 everywhere (see `byteAt`).
      if (!isFill(item)) this.memory.load(item.address, item.bytes)
    }

    for (const cell of options.initialMemory ?? []) {
      const count = cell.bytes === 1 || cell.bytes === 2 || cell.bytes === 4 ? cell.bytes : 8
      const address = truncate(asBigInt(cell.address, 0n), 64)
      this.memory.load(address, littleEndianBytes(asBigInt(cell.value, 0n), count))
      this.noteStackWrite(address, count)
      if (cell.label !== undefined && this.inStack(address)) {
        this.stackLabels.set(boxOf(address), { label: String(cell.label), kind: 'local' })
      }
    }

    // The "OS" has already called the program: its return address is on the stack.
    this.memory.load(startRsp, littleEndianBytes(osReturnAddress, 8))
    this.noteStackWrite(startRsp, 8)
    if (settings.labelStartBox) {
      this.stackLabels.set(boxOf(startRsp), {
        label: explain.osReturnLabel(),
        kind: 'return-address',
      })
    }

    const registers = createRegisterFile()
    for (const name of REG64_NAMES) {
      registers[name] = truncate(asBigInt(options.initialRegisters?.[name], 0n), 64)
    }
    registers.rsp = startRsp
    this.registers = registers

    const flags: Flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }
    for (const name of FLAG_NAMES) {
      const value: unknown = options.initialFlags?.[name]
      if (value !== undefined) flags[name] = value === 0 || value === false ? 0 : 1
    }
    this.flags = flags

    this.rip = program.entry
    this.status = 'running'
    this.error = null
    this.stepCount = 0
    this.output = ''
    this.outputCharacters = 0
    this.stdin = utf8Bytes(typeof options.stdin === 'string' ? options.stdin : '')
    this.stdinPosition = 0
    this.inputRequest = null
    this.inLibrary = null
    this.callStack = [
      Object.freeze({
        functionName: program.entryLabel,
        callLine: 0,
        returnAddress: osReturnAddress,
        slotAddress: startRsp,
      }),
    ]
    this.callStackList = null
    this.flagsWriter = null
    this.lastStep = null
    this.history = []
  }

  private inStack(address: bigint): boolean {
    return address >= this.stackRegion.start && address < this.stackRegion.end
  }

  /** Is this byte part of the data the program was loaded with (`.data`, not the rest of its page)? */
  private inDataImage(address: bigint): boolean {
    const { layout } = this.program
    return address >= layout.dataBase && address < layout.dataEnd
  }

  /** The same for the read-only data. */
  private inReadOnlyImage(address: bigint): boolean {
    const { layout } = this.program
    return address >= layout.rodataBase && address < layout.rodataEnd
  }

  /** The stack boxes that hold these bytes changed: the next stack view builds them again. */
  private markBoxes(address: bigint, length: number): void {
    if (length <= 0) return
    const { start, end } = this.stackRegion
    if (address + BigInt(length) <= start || address >= end) return
    const last = boxOf(address + BigInt(length - 1))
    for (let box = boxOf(address); box <= last; box += 8n) this.staleBoxes.add(box)
  }

  /** Remember that these bytes were written, when they are stack bytes. */
  private noteStackWrite(address: bigint, length: number): void {
    let range = this.stackWritten
    for (let i = 0; i < length; i++) {
      const at = address + BigInt(i)
      if (this.memory.regionAt(at) !== this.stackRegion) continue
      if (range === null) range = { low: at, high: at }
      else if (at < range.low) range = { low: at, high: range.high }
      else if (at > range.high) range = { low: range.low, high: at }
    }
    this.stackWritten = range
  }

  /* ───────────────────────────── Reading the machine ───────────────────────────── */

  /**
   * One byte as the program sees it. A byte of the data the program was loaded with
   * always has a value: the zeros of `.zero` are not stored, so they read as 0 here.
   * Null: never written (stack, code, the rest of a page after the data) or not part of
   * the program's memory.
   */
  private byteAt(address: bigint): number | null {
    const stored = this.memory.peek(address)
    if (stored !== null) return stored
    return this.inDataImage(address) || this.inReadOnlyImage(address) ? 0 : null
  }

  readRegister(name: string): bigint {
    const info = lookupRegister(name)
    if (info === undefined) throw new Error(`Unknown register name: ${name}`)
    return readRegister(this.registers, info)
  }

  readMemory(address: bigint, length: number): (number | null)[] {
    const wanted = Number.isFinite(length) ? Math.floor(length) : 0
    const count = Math.min(Math.max(wanted, 0), MAX_READ_BYTES)
    const bytes: (number | null)[] = []
    try {
      for (let i = 0; i < count; i++) bytes.push(this.byteAt(address + BigInt(i)))
    } catch {
      // `address` was not a number the emulator can use: nothing is there.
      while (bytes.length < count) bytes.push(null)
    }
    return bytes
  }

  /* ──────────────────────────────── Listeners ──────────────────────────────── */

  subscribe(listener: () => void): () => void {
    // Its own entry, so the same function can subscribe twice and leave once.
    const entry = { listener }
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  /** Tell the world that the state changed: a new snapshot, and a call to every listener. */
  private publish(): void {
    this.dirty = false
    this.version += 1
    this.snapshot = null
    for (const entry of [...this.listeners]) {
      try {
        entry.listener()
      } catch {
        // A listener that fails must not break the emulator or the other listeners.
      }
    }
  }

  /* ──────────────────────────────── Stepping ──────────────────────────────── */

  step(): StepResult {
    const result = this.safeAdvance()
    if (this.dirty) this.publish()
    return result
  }

  run(): RunResult {
    const limit = this.settings.maxSteps
    let stepsRun = 0
    let reason: RunStopReason
    for (;;) {
      if (this.status === 'halted') {
        reason = 'halted'
        break
      }
      if (this.status === 'error') {
        reason = 'error'
        break
      }
      // Not before the first step: Run while standing on a breakpoint moves on.
      if (stepsRun > 0 && this.breakpointLine() !== null) {
        reason = 'breakpoint'
        break
      }
      if (stepsRun >= limit) {
        reason = 'step-limit'
        break
      }
      const result = this.safeAdvance()
      if (!result.executed) {
        // scanf with no input, or (in theory) a failure of the emulator itself.
        reason = this.status === 'waiting-input' ? 'waiting-input' : 'error'
        break
      }
      stepsRun++
    }
    const line = reason === 'breakpoint' ? this.breakpointLine() : (this.error?.line ?? null)
    const message = explain.runMessage(reason, { line, steps: stepsRun })
    if (this.dirty) this.publish()
    return { reason, stepsRun, message }
  }

  stepBack(): boolean {
    const record = this.history.pop()
    if (record === undefined) return false
    try {
      this.undo(record)
    } catch {
      // Undo only puts stored values back, so there is nothing here that can fail.
    }
    this.publish()
    return true
  }

  reset(): void {
    try {
      this.start()
    } catch {
      // Nothing in `start` depends on the student's program in a way that can fail.
    }
    this.publish()
  }

  provideInput(text: string): void {
    const typed = typeof text === 'string' ? text : String(text)
    const line = typed.endsWith('\n') ? typed : `${typed}\n`
    for (const byte of utf8Bytes(line)) this.stdin.push(byte)
    if (this.status === 'waiting-input') {
      this.status = 'running'
      this.inputRequest = null
    }
    this.publish()
  }

  /** The line of the breakpoint that the next instruction is on, or null. */
  private breakpointLine(): number | null {
    if (this.inLibrary !== null || this.breakpoints.size === 0) return null
    const line = lineAt(this.program, this.rip)
    return line !== null && this.breakpoints.has(line) ? line : null
  }

  /** One step, with the last line of defence: a bug in the emulator must not crash the page. */
  private safeAdvance(): StepResult {
    try {
      return this.advance()
    } catch {
      return this.crash()
    }
  }

  /** One step, without telling the listeners (contract, section 2). */
  private advance(): StepResult {
    if (this.status === 'halted') {
      return this.idle(this.lastBase(), explain.explainEnded())
    }
    if (this.status === 'error') {
      return this.idle(this.lastBase(), this.error?.message ?? explain.explainEnded())
    }
    if (this.inLibrary !== null) return this.libraryStep(this.inLibrary)

    const instruction = this.program.instructions[this.program.addressToIndex.get(this.rip) ?? -1]
    if (instruction === undefined) return this.nothingToRun()

    const base: StepBase = {
      kind: 'instruction',
      line: instruction.line,
      address: instruction.address,
      text: instruction.text,
    }
    const result = executeInstruction(this.view(), instruction)
    if (!result.ok) {
      const explanation = explain.explainFault(
        { kind: 'instruction', text: base.text },
        result.problem,
      )
      return this.fault(base, result.problem, explanation)
    }
    return this.commit(base, result.effects)
  }

  /** The second half of `call printf@PLT`: the library function, as one step. */
  private libraryStep(call: LibraryCall): StepResult {
    const base = this.libraryBase(call)
    const result = runLibraryFunction(this.view(), call.name, call.callLine)
    switch (result.kind) {
      case 'done':
        return this.commit(base, result.effects)
      case 'problem': {
        const explanation = explain.explainFault(
          { kind: 'library', name: call.name },
          result.problem,
        )
        return this.fault(base, result.problem, explanation)
      }
      case 'waiting': {
        // scanf has no input: the step did not run, and nothing was read or written.
        const prompt = explain.inputPrompt(result.missing, result.partial)
        if (this.status !== 'waiting-input' || this.inputRequest?.prompt !== prompt) {
          this.status = 'waiting-input'
          this.inputRequest = Object.freeze({ prompt })
          this.dirty = true
        }
        return this.idle(base, explain.explainWaiting(call.name, prompt))
      }
    }
  }

  private libraryBase(call: LibraryCall): StepBase {
    return {
      kind: 'library',
      line: call.callLine,
      address: LIBRARY_FUNCTIONS[call.name],
      text: explain.libraryStepText(call.name),
    }
  }

  /** What the executor and the library functions may look at. */
  private view(): LibraryView {
    return {
      program: this.program,
      registers: this.registers,
      flags: this.flags,
      memory: this.memory,
      stack: this.stackRegion,
      osReturnAddress: this.settings.osReturnAddress,
      callStack: this.callStack,
      flagsWriter: this.flagsWriter,
      stdin: this.stdin,
      stdinPosition: this.stdinPosition,
      stepNumber: this.stepCount + 1,
      clobberCallerSaved: this.settings.clobberCallerSaved,
      outputLength: this.outputCharacters,
    }
  }

  /** Which step a result is about when nothing ran: the last one, if there was one. */
  private lastBase(): StepBase {
    const last = this.lastStep
    if (last !== null) {
      return { kind: last.kind, line: last.line, address: last.address, text: last.text }
    }
    return { kind: 'instruction', line: 0, address: this.rip, text: '' }
  }

  /** The result of a `step()` that ran nothing. No state changes. */
  private idle(base: StepBase, explanation: string): StepResult {
    return freezeResult({
      executed: false,
      stepNumber: this.stepCount,
      ...base,
      diff: emptyDiff(this.rip),
      explanation,
      notes: [],
      output: '',
      status: this.status,
      error: this.error,
    })
  }

  /**
   * The program starts at a label with no instruction after it. The step is the label
   * line itself (`main:`), so its text and explanation have code to start with.
   */
  private nothingToRun(): StepResult {
    const label = this.program.entryLabel
    const line = label === null ? null : (this.program.symbols.get(label)?.line ?? null)
    const problem = say.ranOffEnd(line, { reason: 'nothing-to-run', label })
    // Without an entry label the program starts at its first instruction, so this needs a label.
    const text = label === null ? 'main:' : `${label}:`
    const base: StepBase = { kind: 'instruction', line: line ?? 0, address: this.rip, text }
    return this.fault(base, problem, explain.explainNothingToRun(text, problem))
  }

  /** A bug in the emulator: stop the program with a friendly message. */
  private crash(): StepResult {
    let base: StepBase = { kind: 'instruction', line: 0, address: this.rip, text: '' }
    const problem = say.internalProblem(null)
    try {
      const instruction = this.program.instructions[this.program.addressToIndex.get(this.rip) ?? -1]
      if (this.inLibrary !== null) base = this.libraryBase(this.inLibrary)
      else if (instruction !== undefined) {
        base = { ...base, line: instruction.line, text: instruction.text }
      }
      return this.fault(base, problem, problem.error.message)
    } catch {
      this.status = 'error'
      this.error = problem.error
      this.dirty = true
      return freezeResult({
        executed: false,
        stepNumber: this.stepCount,
        ...base,
        diff: emptyDiff(this.rip),
        explanation: problem.error.message,
        notes: [],
        output: '',
        status: 'error',
        error: problem.error,
      })
    }
  }

  /* ──────────────────────────────── Committing ──────────────────────────────── */

  /** A fresh undo record: everything the next step may replace, as it is now. */
  private undoRecord(result: StepResult): UndoRecord {
    return {
      result,
      memory: [],
      status: this.status,
      error: this.error,
      inputRequest: this.inputRequest,
      outputLength: this.output.length,
      outputCharacters: this.outputCharacters,
      stdinPosition: this.stdinPosition,
      inLibrary: this.inLibrary,
      flagsWriter: this.flagsWriter,
      lastStep: this.lastStep,
      callStack: null,
      stackWritten: this.stackWritten,
      labels: [],
    }
  }

  private remember(record: UndoRecord): void {
    this.history.push(record)
    if (this.history.length > HISTORY_LIMIT + HISTORY_SLACK) {
      this.history.splice(0, this.history.length - HISTORY_LIMIT)
    }
  }

  /**
   * A step that faulted: no register, flag or memory byte changes and rip stays, but
   * the step counts, and the program stops with `problem`.
   */
  private fault(base: StepBase, problem: say.RuntimeProblem, explanation: string): StepResult {
    const error = Object.freeze({ ...problem.error })
    const result = freezeResult({
      executed: true,
      stepNumber: this.stepCount + 1,
      ...base,
      diff: emptyDiff(this.rip),
      explanation,
      notes: [],
      output: '',
      status: 'error',
      error,
    })
    this.remember(this.undoRecord(result))
    this.stepCount += 1
    this.status = 'error'
    this.error = error
    this.inputRequest = null
    this.lastStep = result
    this.dirty = true
    return result
  }

  /** Store bytes that were checked already, and say what they replaced. */
  private writeBytes(write: MemoryWrite): MemoryChange {
    const before: (number | null)[] = []
    const after: number[] = []
    for (let i = 0; i < write.bytes.length; i++) {
      const change = this.memory.write(write.address + BigInt(i), 1, BigInt(write.bytes[i]))
      before.push(change.before[0])
      after.push(change.after[0])
    }
    return { address: write.address, before, after }
  }

  /** Apply the effects of a step that succeeded, and build its result (contract, section 2). */
  private commit(base: StepBase, effects: Effects): StepResult {
    // Everything that could fail happens before the first change.
    const { outcome } = effects
    const stop =
      outcome.status === 'error' ? explain.stopSentence(outcome.problem, base.kind) : null
    const explanation = explain.explanationOf(base.text, effects.facts, this.context, stop)
    const notes = explain.notesFor(effects.notes, this.context)
    for (const write of effects.memoryWrites) {
      if (findWriteFault(this.memory, write.address, write.bytes.length) !== null) {
        throw new Error(`${base.text}: a write that was not checked reached the commit`)
      }
    }
    const error = outcome.status === 'error' ? Object.freeze({ ...outcome.problem.error }) : null
    const output = this.output + effects.output

    const diff = emptyDiff(this.rip)
    const result: StepResult = {
      executed: true,
      stepNumber: this.stepCount + 1,
      ...base,
      diff,
      explanation,
      notes,
      output: effects.output,
      status: outcome.status,
      error,
    }
    const record = this.undoRecord(result)

    // Registers: several writes to one register count as one change.
    const before = new Map<Reg64, bigint>()
    for (const write of effects.registerWrites) {
      const name = write.reg.base
      if (!before.has(name)) before.set(name, this.registers[name])
      this.registers[name] = mergeRegisterWrite(this.registers[name], write.reg, write.value)
    }
    for (const [name, old] of before) {
      diff.written.registers.push(name)
      const now = this.registers[name]
      if (now !== old) {
        const change: RegisterChange = { reg: name, before: old, after: now }
        diff.registers.push(change)
      }
    }

    for (const name of FLAG_NAMES) {
      const value: Bit | undefined = effects.flagWrites[name]
      if (value === undefined) continue
      diff.written.flags.push(name)
      if (this.flags[name] !== value) {
        const change: FlagChange = { flag: name, before: this.flags[name], after: value }
        diff.flags.push(change)
        this.flags[name] = value
      }
    }

    for (const write of effects.memoryWrites) {
      const change = this.writeBytes(write)
      record.memory.push(change)
      diff.written.memory.push({ address: write.address, bytes: write.bytes.length })
      this.noteStackWrite(write.address, write.bytes.length)
      this.markBoxes(write.address, write.bytes.length)
      this.forgetDataViews(write.address, write.bytes.length)
      // In the loaded data a byte that was not stored yet was 0, not "never written".
      const shown = change.before.map((byte, i) =>
        byte === null && this.inDataImage(change.address + BigInt(i)) ? 0 : byte,
      )
      if (shown.some((byte, i) => byte !== change.after[i])) {
        diff.memory.push({ address: change.address, before: shown, after: change.after })
      }
    }

    diff.rip.after = effects.nextRip
    this.rip = effects.nextRip

    for (const effect of effects.stackLabels) {
      const current = this.stackLabels.get(effect.box)
      let next: StackLabel | undefined
      if ('set' in effect) {
        next = { label: explain.stackLabelText(effect.set), kind: effect.set.kind }
      } else if (effect.clear === 'unless-local' && current?.kind === 'local') {
        continue
      }
      if (sameLabel(current, next)) continue
      record.labels.push({ box: effect.box, previous: current })
      this.staleBoxes.add(effect.box)
      if (next === undefined) this.stackLabels.delete(effect.box)
      else this.stackLabels.set(effect.box, next)
    }

    if (effects.callStack !== null) {
      if ('push' in effects.callStack) {
        this.callStack.push(Object.freeze({ ...effects.callStack.push }))
        record.callStack = { pushed: true }
      } else {
        record.callStack = { popped: this.callStack.splice(effects.callStack.keep) }
      }
      this.callStackList = null
    }
    if (effects.library === 'leave') this.inLibrary = null
    else if (effects.library !== null) this.inLibrary = Object.freeze({ ...effects.library.enter })
    if (effects.flagsWriter !== null) this.flagsWriter = Object.freeze({ ...effects.flagsWriter })
    if (effects.stdinPosition !== null) this.stdinPosition = effects.stdinPosition
    this.output = output
    if (effects.output !== '') this.outputCharacters += [...effects.output].length

    this.stepCount += 1
    this.status = outcome.status
    this.error = error
    this.inputRequest = null
    this.lastStep = freezeResult(result)
    this.remember(record)
    this.dirty = true
    return result
  }

  /** Undo one step: put back everything its record says it replaced. */
  private undo(record: UndoRecord): void {
    const { diff } = record.result
    for (const change of diff.registers) this.registers[change.reg] = change.before
    for (const change of diff.flags) this.flags[change.flag] = change.before
    for (let i = record.memory.length - 1; i >= 0; i--) {
      const change = record.memory[i]
      // A byte that was never written becomes unwritten again.
      this.memory.revert(change)
      this.markBoxes(change.address, change.after.length)
      this.forgetDataViews(change.address, change.after.length)
    }
    this.rip = diff.rip.before
    for (let i = record.labels.length - 1; i >= 0; i--) {
      const { box, previous } = record.labels[i]
      this.staleBoxes.add(box)
      if (previous === undefined) this.stackLabels.delete(box)
      else this.stackLabels.set(box, previous)
    }
    this.status = record.status
    this.error = record.error
    this.inputRequest = record.inputRequest
    this.output = this.output.slice(0, record.outputLength)
    this.outputCharacters = record.outputCharacters
    // The input itself is kept: stepping forward again reads the same text.
    this.stdinPosition = record.stdinPosition
    this.inLibrary = record.inLibrary
    this.flagsWriter = record.flagsWriter
    this.lastStep = record.lastStep
    if (record.callStack !== null) {
      if ('pushed' in record.callStack) this.callStack.pop()
      else for (const frame of record.callStack.popped) this.callStack.push(frame)
      this.callStackList = null
    }
    this.stackWritten = record.stackWritten
    this.stepCount -= 1
  }

  /* ──────────────────────────────── Breakpoints ──────────────────────────────── */

  setBreakpoints(lines: Iterable<number>): void {
    const next = new Set<number>()
    try {
      for (const line of lines) if (Number.isInteger(line)) next.add(line)
    } catch {
      // Not a list of lines: the same as an empty list.
    }
    const same =
      next.size === this.breakpoints.size && [...next].every((line) => this.breakpoints.has(line))
    if (same) return
    this.breakpoints = next
    this.breakpointList = null
    this.publish()
  }

  toggleBreakpoint(line: number): void {
    if (!Number.isInteger(line)) return
    if (!this.breakpoints.delete(line)) this.breakpoints.add(line)
    this.breakpointList = null
    this.publish()
  }

  /* ──────────────────────────────── Snapshots ──────────────────────────────── */

  getSnapshot(): MachineState {
    if (this.snapshot === null) {
      try {
        this.snapshot = this.buildSnapshot(this.buildStack(), this.buildData())
      } catch {
        // A bug in a view must not take the registers and the output away too.
        this.snapshot = this.buildSnapshot(Object.freeze([]), Object.freeze([]))
      }
    }
    return this.snapshot
  }

  private buildSnapshot(stack: readonly StackSlot[], data: readonly DataView[]): MachineState {
    this.breakpointList ??= Object.freeze([...this.breakpoints].sort((a, b) => a - b))
    this.callStackList ??= Object.freeze([...this.callStack])
    // No line runs next once the program has ended, or while rip is inside library code.
    const nextLine =
      this.status === 'halted' || this.inLibrary !== null ? null : lineAt(this.program, this.rip)
    return Object.freeze({
      version: this.version,
      status: this.status,
      stepCount: this.stepCount,
      registers: Object.freeze({ ...this.registers }),
      rip: this.rip,
      flags: Object.freeze({ ...this.flags }),
      nextLine,
      inLibrary: this.inLibrary,
      output: this.output,
      inputRequest: this.inputRequest,
      lastStep: this.lastStep,
      stack,
      callStack: this.callStackList,
      data,
      breakpoints: this.breakpointList,
      error: this.error,
      canStepBack: this.history.length > 0,
    })
  }

  /** The stack as 8-byte boxes, highest address first, with no gaps (contract, section 9). */
  private buildStack(): readonly StackSlot[] {
    const { rsp, rbp } = this.registers
    let high = boxOf(this.settings.startRsp)
    let low = high
    const include = (address: bigint): void => {
      const box = boxOf(address)
      if (box > high) high = box
      if (box < low) low = box
    }
    if (this.stackWritten !== null) {
      include(this.stackWritten.low)
      include(this.stackWritten.high)
    }
    if (this.inStack(rsp)) include(rsp)
    if (this.inStack(rbp)) include(rbp)
    const lowest = high - 8n * BigInt(MAX_STACK_BOXES - 1)
    if (low < lowest) low = lowest

    // The boxes that the last step wrote.
    const changed = new Set<bigint>()
    for (const range of this.lastStep?.diff.written.memory ?? []) {
      if (range.bytes <= 0) continue
      const last = boxOf(range.address + BigInt(range.bytes - 1))
      for (let box = boxOf(range.address); box <= last; box += 8n) changed.add(box)
    }

    // A box whose bytes and label did not change since it was built, and whose rsp, rbp,
    // dead and changed marks are still the same, is used again as it is.
    for (const box of this.staleBoxes) this.boxCache.delete(box)
    this.staleBoxes.clear()

    const rspBox = boxOf(rsp)
    const rbpBox = boxOf(rbp)
    const slots: StackSlot[] = []
    for (let address = high; address >= low; address -= 8n) {
      const isRsp = address === rspBox
      const isRbp = address === rbpBox
      // Below rsp: a leftover that is not part of the stack any more.
      const dead = address + 8n <= rsp
      const written = changed.has(address)
      const cached = this.boxCache.get(address)
      if (
        cached !== undefined &&
        cached.isRsp === isRsp &&
        cached.isRbp === isRbp &&
        cached.dead === dead &&
        cached.changed === written
      ) {
        slots.push(cached)
        continue
      }
      const bytes = this.memory.peekBytes(address, 8)
      let value: bigint | null = null
      for (let i = 0; i < 8; i++) {
        const byte = bytes[i]
        if (byte !== null) value = (value ?? 0n) | (BigInt(byte) << BigInt(8 * i))
      }
      const stored = this.stackLabels.get(address)
      let kind: StackSlotKind = value === null ? 'empty' : 'value'
      if (stored !== undefined) kind = stored.kind
      Object.freeze(bytes)
      const slot: StackSlot = Object.freeze({
        address,
        value,
        bytes,
        label: stored === undefined ? null : stored.label,
        kind,
        isRsp,
        isRbp,
        dead,
        changed: written,
      })
      this.boxCache.set(address, slot)
      slots.push(slot)
    }
    return Object.freeze(slots)
  }

  /** Forget the data views of the items that hold these bytes: they changed. */
  private forgetDataViews(address: bigint, length: number): void {
    const { layout, data } = this.program
    const end = address + BigInt(length)
    if (end <= layout.dataBase || address >= layout.dataEnd) return
    // The first item that ends after `address` (the items are in address order).
    const items = this.writableItems
    let low = 0
    let high = items.length
    while (low < high) {
      const middle = (low + high) >> 1
      const item = data[items[middle]]
      if (item.address + BigInt(item.bytes.length) <= address) low = middle + 1
      else high = middle
    }
    for (let i = low; i < items.length && data[items[i]].address < end; i++) {
      this.dataViews[items[i]] = null
      this.dataList = null
    }
  }

  private buildData(): readonly DataView[] {
    if (this.dataList !== null) return this.dataList
    const views = this.program.data.map((item, index) => {
      const view = this.dataViews[index] ?? this.buildDataView(item, this.dataLimits[index])
      this.dataViews[index] = view
      return view
    })
    this.dataList = Object.freeze(views)
    return this.dataList
  }

  /** The current contents of one data directive. */
  private buildDataView(item: DataItem, elements: number): DataView {
    const size = item.elementSize
    const values: bigint[] = []
    for (let element = 0; element < elements; element++) {
      let value = 0n
      for (let i = 0; i < size; i++) {
        const byte = this.byteAt(item.address + BigInt(element * size + i)) ?? 0
        value |= BigInt(byte) << BigInt(8 * i)
      }
      values.push(value)
    }
    let text: string | null = null
    if (item.text !== null) {
      // The current text, up to the first 0 byte (or to the end of the item).
      const bytes: number[] = []
      for (let i = 0; i < item.bytes.length; i++) {
        const byte = this.byteAt(item.address + BigInt(i)) ?? 0
        if (byte === 0) break
        bytes.push(byte)
      }
      text = decodeUtf8(bytes)
    }
    Object.freeze(values)
    return Object.freeze({
      label: item.label,
      address: item.address,
      directive: item.directive,
      readOnly: item.section === 'rodata',
      elementSize: size,
      values,
      text,
    })
  }
}

/* ──────────────────────────────── createEmulator ──────────────────────────────── */

export type CreateEmulatorResult =
  /** `diagnostics` holds warnings only. */
  | { ok: true; emulator: Emulator; diagnostics: Diagnostic[] }
  /** `diagnostics` holds at least one error. */
  | { ok: false; emulator: null; diagnostics: Diagnostic[] }

/**
 * Read a program and make an emulator for it, with the same options for both.
 * Never throws: a program with mistakes gives `ok: false` and the list of problems.
 */
export function createEmulator(source: string, options?: EmulatorOptions): CreateEmulatorResult {
  const assembled = assemble(source, options)
  if (!assembled.ok) return { ok: false, emulator: null, diagnostics: assembled.diagnostics }
  try {
    const emulator = new Emulator(assembled.program, options)
    return { ok: true, emulator, diagnostics: assembled.diagnostics }
  } catch {
    // A bug in the emulator must never crash the page.
    return { ok: false, emulator: null, diagnostics: [assembleProblem()] }
  }
}
