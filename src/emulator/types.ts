/**
 * Stack Step emulator: the shared contract.
 *
 * Everything in `src/emulator/` is pure TypeScript: no React, no DOM, no timers.
 * The parser, the machine model, the executor, the practice generators and the UI
 * all agree on the shapes in this file. Read PLAN.md ("Emulator design") for the why.
 *
 * Conventions
 * - Register values, addresses and immediates are `bigint`. A register value is always
 *   in the range 0 … 2^64-1 (unsigned). Use the helpers in `bits.ts` to view it as signed.
 * - Sizes are in BITS when the name says "size" on an operand or register (8/16/32/64)
 *   and in BYTES for instruction sizes and memory ranges. Each field says which.
 * - Source lines are 1-based.
 */

/* ────────────────────────────── Registers ────────────────────────────── */

/** The sixteen 64-bit general registers, in x86 encoding order (rax = 0 … r15 = 15). */
export const REG64_NAMES = [
  'rax',
  'rcx',
  'rdx',
  'rbx',
  'rsp',
  'rbp',
  'rsi',
  'rdi',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
  'r15',
] as const

export type Reg64 = (typeof REG64_NAMES)[number]

/** The order registers are shown to students (the order the course teaches them). */
export const REG64_DISPLAY_ORDER: readonly Reg64[] = [
  'rax',
  'rbx',
  'rcx',
  'rdx',
  'rsi',
  'rdi',
  'rbp',
  'rsp',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
  'r15',
]

/** Operand width in bits. */
export type OperandSize = 8 | 16 | 32 | 64

/** One register name (rax, eax, ax, ah, al, r8d, sil, …) and where it lives. */
export interface RegisterInfo {
  /** Lower-case name as written in code, e.g. "eax". */
  name: string
  /** The 64-bit register this name is a part of. */
  base: Reg64
  /** Width in bits. */
  size: OperandSize
  /** Bit position of the lowest bit: 8 for ah/bh/ch/dh, otherwise 0. */
  shift: 0 | 8
  /** True for ah, bh, ch, dh (bits 15–8). */
  highByte: boolean
  /**
   * True when using this name forces a REX prefix in real machine code:
   * r8–r15 (any width), sil, dil, spl, bpl. Such a register cannot appear in the
   * same instruction as ah/bh/ch/dh.
   */
  needsRex: boolean
}

/** The value of all sixteen registers. Plain object so it is easy to copy. */
export type RegisterFile = Record<Reg64, bigint>

/* ──────────────────────────────── Flags ──────────────────────────────── */

export const FLAG_NAMES = ['CF', 'ZF', 'SF', 'OF'] as const
export type FlagName = (typeof FLAG_NAMES)[number]
export type Bit = 0 | 1
export type Flags = Record<FlagName, Bit>

/* ───────────────────────────── Instructions ──────────────────────────── */

/**
 * Canonical mnemonics the emulator executes.
 * Spelling variants are folded by the parser (jz→je, jnz→jne, jnle→jg, jnl→jge, jnge→jl,
 * jng→jle, jnbe→ja, jnb/jnc→jae, jnae/jc→jb, jna→jbe, endbr64→nop). `Instruction.written`
 * keeps what the student typed.
 */
export const MNEMONICS = [
  'mov',
  'movzx',
  'movsx',
  'lea',
  'push',
  'pop',
  'add',
  'sub',
  'inc',
  'dec',
  'imul',
  'cmp',
  'test',
  'and',
  'or',
  'xor',
  'jmp',
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
  'call',
  'ret',
  'nop',
  'leave',
] as const

export type Mnemonic = (typeof MNEMONICS)[number]

/** A register operand, e.g. `eax`. */
export interface RegOperand {
  kind: 'reg'
  reg: RegisterInfo
  /** As written (lower-cased). */
  text: string
}

/** A constant operand: `5`, `-8`, `0x1f`, `'A'`, an `.equ` name, or `offset label`. */
export interface ImmOperand {
  kind: 'imm'
  /** The mathematical value as written (may be negative). The executor truncates it. */
  value: bigint
  /** `.equ` constant or data label the value came from, if any (for explanations). */
  symbol: string | null
  text: string
}

/**
 * A memory operand. Effective address = (symbol address) + base + index*scale + disp.
 * When `base` is 'rip' the operand is `label[rip]` and the effective address is simply
 * the address of `symbol` (the assembler works out the rip-relative distance).
 */
export interface MemOperand {
  kind: 'mem'
  /** Explicit size from `byte/word/dword/qword ptr` in bits, or null when not written. */
  size: OperandSize | null
  base: Reg64 | 'rip' | null
  index: Reg64 | null
  scale: 1 | 2 | 4 | 8
  /** Constant displacement with every `.equ` name already folded in. */
  disp: bigint
  /** Data label used inside the operand (`message[rip]`, `table[rax*8]`), else null. */
  symbol: string | null
  /** Resolved address of `symbol` (0n when symbol is null). */
  symbolAddress: bigint
  /** `.equ` names used in the displacement, e.g. ["count"] for `count[rbp]`. */
  equNames: string[]
  /** As written, e.g. "dword ptr [rbp-4]" or "count[rbp]". */
  text: string
}

/** The target of jmp / jcc / call. */
export interface TargetOperand {
  kind: 'target'
  /** Label name without any `@PLT` suffix. */
  name: string
  address: bigint
  /** True for library functions (printf, scanf, puts, putchar, exit). */
  external: boolean
  text: string
}

export type Operand = RegOperand | ImmOperand | MemOperand | TargetOperand

export interface Instruction {
  /** Position in `Program.instructions`. */
  index: number
  /** 1-based source line. */
  line: number
  address: bigint
  /** Encoded length in BYTES (see sizes.ts for the documented table). */
  size: number
  mnemonic: Mnemonic
  /** The mnemonic as typed, lower-cased (e.g. "jz", "endbr64"). */
  written: string
  operands: Operand[]
  /**
   * Width in bits the instruction works on (the destination width), or null when the
   * idea does not apply (jmp, jcc, call, ret, nop, leave).
   */
  opSize: OperandSize | null
  /** Tidy source text without label or comment, e.g. "mov eax, dword ptr [rbp-4]". */
  text: string
}

/* ─────────────────────────────── Program ─────────────────────────────── */

export type SectionName = 'text' | 'rodata' | 'data'

export interface SymbolInfo {
  name: string
  address: bigint
  kind: 'code' | 'data' | 'external'
  /** Line where the label is defined (null for library functions). */
  line: number | null
}

/** One data directive (`.string`, `.quad`, …) placed in memory. */
export interface DataItem {
  /** Label written just before the item, if any. */
  label: string | null
  line: number
  /** Strings written in `.text` or `.rodata` are read-only; `.data` is writable. */
  section: 'rodata' | 'data'
  address: bigint
  /** The directive as written, e.g. ".string". */
  directive: string
  /** Bytes per element: 1 for strings and .byte, 2 .word, 4 .long/.int, 8 .quad. */
  elementSize: 1 | 2 | 4 | 8
  /** Initial bytes. `.string`/`.asciz` include the ending 0 byte. */
  bytes: number[]
  /** For string directives: the decoded text (without the ending 0), else null. */
  text: string | null
}

export interface Layout {
  /** Code occupies [textBase, textEnd). */
  textBase: bigint
  textEnd: bigint
  /** Read-only data occupies [rodataBase, rodataEnd). */
  rodataBase: bigint
  rodataEnd: bigint
  /** Writable data occupies [dataBase, dataEnd). */
  dataBase: bigint
  dataEnd: bigint
}

export interface Program {
  source: string
  instructions: Instruction[]
  /** Code labels, data labels and the library functions the program calls. */
  symbols: Map<string, SymbolInfo>
  /** `.equ` constants. */
  constants: Map<string, bigint>
  data: DataItem[]
  layout: Layout
  /** Where execution starts: the `main` label if there is one, else the first instruction. */
  entry: bigint
  entryLabel: string | null
  /** Instruction address → index in `instructions`. */
  addressToIndex: Map<bigint, number>
  /** Source line → index of the instruction on that line. */
  lineToIndex: Map<number, number>
  /** Non-fatal problems found while assembling. */
  warnings: Diagnostic[]
}

/** Codes for problems found while reading the program (before it runs). */
export type AssembleCode =
  // errors
  | 'unknown-instruction' // not an x86 instruction at all (maybe a typo → suggest)
  | 'unsupported-instruction' // real x86, but outside the teaching subset
  | 'unknown-register'
  | 'operand-count'
  | 'bad-operand' // could not understand an operand
  | 'bad-number'
  | 'bad-memory-operand'
  | 'bad-directive' // known directive, wrong arguments
  | 'bad-string'
  | 'bad-label'
  | 'duplicate-label'
  | 'undefined-symbol'
  | 'memory-to-memory'
  | 'immediate-destination'
  | 'size-mismatch'
  | 'missing-size' // memory destination + immediate source without `… ptr`
  | 'immediate-too-large'
  | 'push-pop-operand'
  | 'invalid-operands' // any other illegal operand combination for this instruction
  | 'high-byte-rex' // ah/bh/ch/dh mixed with sil/dil/spl/bpl/r8–r15
  | 'jump-target'
  | 'address-register' // address built from non-64-bit registers, rsp as index, …
  | 'comment-style' // `;` or `//` used as a comment
  | 'att-syntax' // `%rax`, `$5`: AT&T syntax
  | 'wrong-section' // an instruction inside `.data`
  | 'empty-program'
  // warnings
  | 'unknown-directive' // also `.comm` and `.lcomm`, which this emulator does not support
  | 'missing-intel-syntax'
  | 'no-main' // no `main:` in front of an instruction (also: `main:` with nothing after it)
  /**
   * Not a problem itself: the line-0 note after the first 20 errors, which says that more
   * errors follow ("There are more errors after line N. Fix these first."). It is a
   * warning, so the count of errors stays at most 20.
   */
  | 'more-errors'

export interface Diagnostic {
  severity: 'error' | 'warning'
  code: AssembleCode
  /** 1-based line, or 0 when the message is about the whole program. */
  line: number
  /**
   * A complete, beginner-friendly message. When `line > 0` it starts with "Line N: ".
   * Example: "Line 7: you can't move memory into memory. Load it into a register first."
   */
  message: string
}

export type AssembleResult =
  | { ok: true; program: Program; diagnostics: Diagnostic[] }
  | { ok: false; program: null; diagnostics: Diagnostic[] }

/* ─────────────────────────────── Options ─────────────────────────────── */

export interface EmulatorOptions {
  /** Address of the first instruction. Default 0x401126 (where gcc usually puts main). */
  textBase?: bigint
  /** Start of read-only data (`.string` in .text/.rodata). Default 0x402010. */
  rodataBase?: bigint
  /** Start of writable data (`.data`). Default 0x404030. */
  dataBase?: bigint
  /**
   * Where the stack starts. The stack grows DOWN from here. Default 0x7ffffffde000.
   * The 8 bytes just below it hold the fake return address into the "OS".
   */
  stackBase?: bigint
  /**
   * Value of rsp when the program starts. Default `stackBase - 8`. The fake return
   * address is stored at this address, so a `ret` from main ends the program.
   * With the default, rsp ends in 8 at entry and in 0 at every correctly aligned `call`,
   * exactly like a real Linux machine.
   */
  initialRsp?: bigint
  /** The fake return address into the "OS". Default 0x7ffff7c29d90. */
  osReturnAddress?: bigint
  /**
   * When true (default), the box where rsp starts is labelled "return address (ends the
   * program)". A practice problem that shows its own value in that box (it sets
   * `osReturnAddress` to that value) turns this off: the box then shows the label of an
   * `initialMemory` cell there, or no label. A `ret` that pops the value still ends the
   * program.
   */
  labelStartBox?: boolean
  /** How many bytes below `stackBase` the program may use. Default 1 MiB. */
  stackSize?: number
  /** `run()` stops after this many steps. Default 10 000. */
  maxSteps?: number
  /**
   * When true (default), a library call (printf, scanf, …) leaves junk in the
   * caller-saved registers rcx, rdx, rsi, rdi, r8–r11, like a real call does.
   */
  clobberCallerSaved?: boolean
  /** Starting register values (others start at 0; rsp/rbp see above). */
  initialRegisters?: Partial<Record<Reg64, bigint>>
  /** Starting flag values (default all 0). */
  initialFlags?: Partial<Flags>
  /** Memory to fill in before the program starts (used by practice problems). */
  initialMemory?: InitialMemoryCell[]
  /** Text already waiting on standard input for scanf (used by tests). */
  stdin?: string
}

export interface InitialMemoryCell {
  address: bigint
  /** Bytes to write: 1, 2, 4 or 8 (little-endian). */
  bytes: 1 | 2 | 4 | 8
  value: bigint
  /** Optional label shown in the stack panel, e.g. "x". */
  label?: string
}

/** Default values for every option that has a fixed default. */
export const DEFAULT_OPTIONS = {
  textBase: 0x401126n,
  rodataBase: 0x402010n,
  dataBase: 0x404030n,
  stackBase: 0x7ffffffde000n,
  osReturnAddress: 0x7ffff7c29d90n,
  stackSize: 0x100000,
  maxSteps: 10_000,
  clobberCallerSaved: true,
} as const

/** Fake addresses of the library functions the emulator knows (they look like libc). */
export const LIBRARY_FUNCTIONS = {
  printf: 0x7ffff7c606f0n,
  scanf: 0x7ffff7c62110n,
  puts: 0x7ffff7c80e50n,
  putchar: 0x7ffff7c82b10n,
  exit: 0x7ffff7c455f0n,
} as const

export type LibraryFunctionName = keyof typeof LIBRARY_FUNCTIONS

/* ───────────────────────────── Running state ─────────────────────────── */

/**
 * - 'running'       the next step can run (also the state of a fresh program)
 * - 'waiting-input' scanf needs text: call `provideInput()` then step again
 * - 'halted'        the program finished normally (main returned, or exit was called)
 * - 'error'         a run-time error stopped the program (stepBack still works)
 */
export type Status = 'running' | 'waiting-input' | 'halted' | 'error'

/** Codes for problems that happen while the program runs. */
export type RuntimeCode =
  | 'bad-memory-read' // address is not part of the program's memory ("segmentation fault")
  | 'bad-memory-write'
  | 'write-read-only' // tried to change code or read-only data
  | 'bad-jump' // ret/jmp landed on an address that is not an instruction
  | 'ran-off-end' // executed past the last instruction (missing ret?)
  | 'stack-overflow'
  | 'library-error' // printf/scanf could not do its job (bad format, bad pointer)
  | 'internal' // the emulator itself hit a problem (a bug in the emulator, not in the program)

export interface EmulatorError {
  code: RuntimeCode
  /** Source line of the instruction that failed, when there is one. */
  line: number | null
  /** Beginner-friendly message, e.g. "Line 9: `ret` jumped to 0x5, which is not … ". */
  message: string
}

export interface RegisterChange {
  reg: Reg64
  before: bigint
  after: bigint
}

export interface FlagChange {
  flag: FlagName
  before: Bit
  after: Bit
}

/** One memory write. `before[i]` is null when that byte had never been written. */
export interface MemoryChange {
  address: bigint
  before: (number | null)[]
  after: number[]
}

/** What one step changed. Only real changes are listed (before ≠ after). */
export interface StateDiff {
  registers: RegisterChange[]
  flags: FlagChange[]
  memory: MemoryChange[]
  rip: { before: bigint; after: bigint }
  /**
   * Everything the step wrote, even when the value stayed the same
   * (e.g. `mov rax, 5` when rax was already 5, or `cmp` leaving the flags as they were).
   */
  written: {
    registers: Reg64[]
    flags: FlagName[]
    memory: { address: bigint; bytes: number }[]
  }
}

export interface StepNote {
  kind: 'tip' | 'warning'
  text: string
}

export interface StepResult {
  /**
   * False when nothing ran: the program is halted, has an error, or scanf is still
   * waiting for input. `diff` is empty in that case.
   */
  executed: boolean
  /** 1-based number of this step (the step count after it ran). */
  stepNumber: number
  /**
   * 'instruction' for a line of the student's program, 'library' for the inside of a
   * library function (the second half of `call printf@PLT`, run as one step).
   */
  kind: 'instruction' | 'library'
  /** Source line. For a library step: the line of the `call`. */
  line: number
  /** Address of the instruction (or of the library function). */
  address: bigint
  /** Instruction text, or e.g. "printf (library code)". */
  text: string
  diff: StateDiff
  /**
   * Plain-English explanation with the real numbers filled in. Code is wrapped in
   * backticks so the UI can show it in a code font. One to three short sentences.
   */
  explanation: string
  /** Extra tips and warnings for this step (alignment, junk registers, …). */
  notes: StepNote[]
  /** Text printed by this step ('' when none). */
  output: string
  /** Status after the step. */
  status: Status
  /** Set when `status` is 'error'. */
  error: EmulatorError | null
}

export type RunStopReason = 'halted' | 'error' | 'breakpoint' | 'waiting-input' | 'step-limit'

export interface RunResult {
  reason: RunStopReason
  /** Steps executed by this call. */
  stepsRun: number
  /** One friendly sentence saying why the run stopped. */
  message: string
}

export type StackSlotKind = 'return-address' | 'saved-register' | 'local' | 'value' | 'empty'

/** One 8-byte box of the stack, ready for the stack panel. */
export interface StackSlot {
  /** Address of the lowest byte of the box (a multiple of 8). */
  address: bigint
  /** The 8 bytes as one little-endian number; null when no byte was ever written. */
  value: bigint | null
  /** The 8 bytes, lowest address first; null = never written. */
  bytes: (number | null)[]
  /** e.g. "return address (back to line 12)", "saved rbp", "count". */
  label: string | null
  kind: StackSlotKind
  /** rsp points at this box. */
  isRsp: boolean
  /** rbp points at this box. */
  isRbp: boolean
  /** Below rsp: a leftover value that is no longer part of the stack. */
  dead: boolean
  /** Written by the last step. */
  changed: boolean
}

export interface CallFrame {
  /** Name of the function that was called (label), or null if unknown. */
  functionName: string | null
  /** Line of the `call` instruction (0 for the OS calling main). */
  callLine: number
  returnAddress: bigint
  /** Address of the stack box that holds the return address. */
  slotAddress: bigint
}

/** Current contents of one data directive, ready for a "Data" panel. */
export interface DataView {
  label: string | null
  address: bigint
  directive: string
  readOnly: boolean
  elementSize: 1 | 2 | 4 | 8
  /** Current value of each element (little-endian, unsigned). */
  values: bigint[]
  /** For strings: the current text up to the first 0 byte, else null. */
  text: string | null
}

/**
 * An immutable picture of the machine. `Emulator.getSnapshot()` returns the same
 * object until something changes, so it works with React's `useSyncExternalStore`.
 */
export interface MachineState {
  /** Goes up by one on every change. */
  version: number
  status: Status
  /** Steps executed so far (0 = fresh program). */
  stepCount: number
  registers: Readonly<RegisterFile>
  /** Address of the instruction that runs next. */
  rip: bigint
  flags: Readonly<Flags>
  /** Source line that runs next; null when halted or while inside library code. */
  nextLine: number | null
  /** Set while rip is inside a library function (between the two halves of a call). */
  inLibrary: { name: LibraryFunctionName; callLine: number } | null
  /** Everything printed so far. */
  output: string
  /** Set when status is 'waiting-input'. */
  inputRequest: { prompt: string } | null
  /** The step that ran last (null at the start, or after stepping back to the start). */
  lastStep: StepResult | null
  /** Stack boxes, highest address first. */
  stack: readonly StackSlot[]
  /**
   * Active calls, outermost first (the first one is "the OS called main"). It is empty
   * after main returned with `ret` (main is over). After `exit` the frames stay: the
   * program stopped inside them.
   */
  callStack: readonly CallFrame[]
  data: readonly DataView[]
  /** Lines with a breakpoint, ascending. */
  breakpoints: readonly number[]
  error: EmulatorError | null
  canStepBack: boolean
}

/** The public face of the emulator (implemented by the `Emulator` class). */
export interface EmulatorApi {
  readonly program: Program
  /** Current state. Same object until the next change. */
  getSnapshot(): MachineState
  /** Call `listener` after every change. Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void
  /** Run one step. */
  step(): StepResult
  /** Undo the last step. Returns false when already at the start. */
  stepBack(): boolean
  /** Run until the program ends, hits a breakpoint, needs input, fails or hits maxSteps. */
  run(): RunResult
  /** Back to the starting state (breakpoints are kept, input is cleared). */
  reset(): void
  setBreakpoints(lines: Iterable<number>): void
  toggleBreakpoint(line: number): void
  /** Give text to standard input (scanf). Use '\n' between lines if several. */
  provideInput(text: string): void
  /** Value of any register name, including parts: readRegister('al'). */
  readRegister(name: string): bigint
  /** `length` bytes starting at `address`; null = never written / not mapped. */
  readMemory(address: bigint, length: number): (number | null)[]
}
