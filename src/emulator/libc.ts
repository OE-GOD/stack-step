/**
 * The library functions the emulator knows: printf, scanf, puts, putchar and exit
 * (behaviour contract, section 6).
 *
 * A library function runs as ONE step. Like the executor, `runLibraryFunction` is pure:
 * it looks at the machine and returns the `Effects` of the whole call (what it printed,
 * what it stored, the result in eax, the junk left in the caller-saved registers, and
 * the return to the program). It changes nothing. There are three ways a call can go:
 *
 *   - 'done'     the function did its job: commit the effects;
 *   - 'problem'  it could not (a bad address, an unknown `%` item): nothing changes and
 *                the program stops with a friendly error;
 *   - 'waiting'  scanf needs more input: nothing changes, and the step did not run.
 *
 * Text is handled as BYTES, the way C does it: printf counts the bytes it prints, and
 * scanf reads standard input one byte at a time. Text outside ASCII is UTF-8.
 *
 * Where C's library (glibc on x86-64 Linux) and the first contract differed, the real
 * library wins: `%p` of 0 prints `(nil)`, and input that scanf could not read stays in
 * the input, so the next scanf starts there.
 */
import { toSigned, truncate } from './bits'
import {
  boxOf,
  countUnwritten,
  findWriteFault,
  lineAt,
  littleEndianBytes,
  type Effects,
  type FoundInput,
  type LibraryFacts,
  type MachineView,
  type MemoryWrite,
  type NoteFacts,
  type RegisterWrite,
  type ReturnFacts,
  type ScanItem,
  type ScanKind,
  type StackLabelEffect,
  type StepOutcome,
} from './executor'
import { MemoryFault, type Memory } from './memory'
import { readRegister, reg } from './registers'
import * as say from './runtimeErrors'
import { LIBRARY_FUNCTIONS, type LibraryFunctionName, type Reg64 } from './types'

/* ───────────────────────────── What a call sees ───────────────────────────── */

export interface LibraryView extends MachineView {
  /** Standard input as bytes (UTF-8). */
  readonly stdin: readonly number[]
  /** How many bytes of `stdin` were read already. */
  readonly stdinPosition: number
  /** The number this step will have. The junk register values depend on it. */
  readonly stepNumber: number
  /** Leave junk in rcx, rdx, rsi, rdi, r8–r11, like a real call does. */
  readonly clobberCallerSaved: boolean
  /** How many characters the program has printed so far (an emoji counts as one). */
  readonly outputLength: number
}

/** A value scanf still needs: its kind and, for `%c`, how many characters. */
export interface MissingValue {
  kind: ScanKind
  width: number | null
}

export type LibraryResult =
  | { kind: 'done'; effects: Effects }
  | { kind: 'problem'; problem: say.RuntimeProblem }
  /**
   * scanf has no input yet. `missing` lists the values it still needs; `partial` is true
   * when the input already holds some of the values (they are read again, with the
   * rest, once the rest is there).
   */
  | { kind: 'waiting'; missing: MissingValue[]; partial: boolean }

/** Thrown inside this file when a library function cannot do its job. Never leaves it. */
class LibraryStop extends Error {
  readonly problem: say.RuntimeProblem

  constructor(problem: say.RuntimeProblem) {
    super(problem.error.message)
    this.name = 'LibraryStop'
    this.problem = problem
  }
}

const RSP = reg('rsp')
const EAX = reg('eax')
const EDI = reg('edi')

/** The registers that hold the values after the text: the 2nd to the 6th argument. */
const ARGUMENT_REGISTERS: readonly Reg64[] = ['rsi', 'rdx', 'rcx', 'r8', 'r9']

/** The registers a library function may change (besides rax, which holds its result). */
export const CALLER_SAVED: readonly Reg64[] = ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11']

/** Text handed to a library function is read up to this many bytes. */
const TEXT_LIMIT = 4096

/**
 * A character takes at most 4 bytes of UTF-8 (and a byte that is not UTF-8 shows as one
 * character). So a call that formats more bytes than this surely prints more than
 * `MAX_CALL_OUTPUT` characters, and printf can stop before it formats the rest.
 */
const CALL_OUTPUT_BYTES = 4 * say.MAX_CALL_OUTPUT

const PERCENT = 0x25
const NEW_LINE = 0x0a

/* ──────────────────────────────── Text ──────────────────────────────── */

/** Shown in place of bytes that are not valid UTF-8. */
const REPLACEMENT_CHARACTER = '�'

/**
 * Bytes (UTF-8) as text. Bytes that are not valid UTF-8 become U+FFFD, the way a
 * browser shows them. Nothing is thrown.
 */
export function decodeUtf8(bytes: readonly number[]): string {
  let text = ''
  let i = 0
  while (i < bytes.length) {
    const first = bytes[i]
    if (first < 0x80) {
      text += String.fromCharCode(first)
      i++
      continue
    }
    // How many bytes follow the first one, and the smallest code point that needs them.
    let more = 0
    let smallest = 0
    let point = 0
    if (first >= 0xc2 && first <= 0xdf) {
      more = 1
      smallest = 0x80
      point = first & 0x1f
    } else if (first >= 0xe0 && first <= 0xef) {
      more = 2
      smallest = 0x800
      point = first & 0x0f
    } else if (first >= 0xf0 && first <= 0xf4) {
      more = 3
      smallest = 0x10000
      point = first & 0x07
    }
    let used = 1
    let valid = more > 0
    while (valid && used <= more) {
      const next = bytes[i + used]
      if (next === undefined || next < 0x80 || next > 0xbf) valid = false
      else {
        point = (point << 6) | (next & 0x3f)
        used++
      }
    }
    const surrogate = point >= 0xd800 && point <= 0xdfff
    if (valid && point >= smallest && point <= 0x10ffff && !surrogate) {
      text += String.fromCodePoint(point)
      i += used
    } else {
      // Show one replacement, then look at the next byte as a new start.
      text += REPLACEMENT_CHARACTER
      i++
    }
  }
  return text
}

/** The bytes of plain ASCII text (numbers that printf formats). */
function asciiBytes(text: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0x7f)
  return bytes
}

function fromBytes(bytes: readonly number[]): string {
  return String.fromCharCode(...bytes)
}

type TextRead =
  /**
   * `ranInto`: the text has no 0 byte at its end. It ran into a stack byte that was never
   * written ('stack'), or past the last byte of the program's data ('data'). Null: it
   * ended with a 0 byte.
   */
  | { ok: true; bytes: number[]; ranInto: 'stack' | 'data' | null }
  /**
   * 'unmapped': not the program's memory. 'code': inside the code of the program. `at` is
   * the first byte that could not be read (later than the start when the text runs into
   * memory the program does not own).
   */
  | { ok: false; why: 'unmapped' | 'code'; at: bigint }

/** Is this byte part of the data the program was loaded with (not the rest of its page)? */
function inDataImage(view: MachineView, address: bigint): boolean {
  const { layout } = view.program
  const inReadOnly = address >= layout.rodataBase && address < layout.rodataEnd
  return inReadOnly || (address >= layout.dataBase && address < layout.dataEnd)
}

/**
 * For an address inside the code of the program: is it the address of an instruction?
 * The code area is a whole page, so most of its addresses are not.
 */
function codePlace(view: MachineView, address: bigint): 'instruction' | 'code' {
  return view.program.addressToIndex.has(address) ? 'instruction' : 'code'
}

/** The bytes of the 0-terminated text at `address`, without the 0. */
function readText(view: MachineView, address: bigint): TextRead {
  const { memory, stack } = view
  const bytes: number[] = []
  for (let i = 0; i < TEXT_LIMIT; i++) {
    const at = address + BigInt(i)
    const region = memory.regionAt(at)
    if (region === null) return { ok: false, why: 'unmapped', at }
    // The emulator stores no instruction bytes, so there is no text to read in the code.
    if (region.name === 'text') return { ok: false, why: 'code', at }
    const byte = memory.peek(at)
    if (byte === null) {
      if (region === stack) return { ok: true, bytes, ranInto: 'stack' }
      // In the loaded data, a byte that is not stored is a 0 of `.zero`: the end of the text.
      if (inDataImage(view, at)) break
      return { ok: true, bytes, ranInto: 'data' }
    }
    if (byte === 0) break
    bytes.push(byte)
  }
  return { ok: true, bytes, ranInto: null }
}

/** The `width` bytes stored at `address` as one little-endian number (unwritten bytes are 0). */
function storedValue(memory: Memory, address: bigint, width: 4 | 8): bigint {
  const bytes = memory.peekBytes(address, width)
  let value = 0n
  for (let i = 0; i < width; i++) value |= BigInt(bytes[i] ?? 0) << BigInt(8 * i)
  return value
}

/**
 * When rdi holds the first bytes stored at a string of the program (the student wrote
 * `mov` where `lea` was needed), that label and how many bytes `mov` copied. Else null.
 * `bytes` is null when the count can't be known: when bytes 4 to 7 at the label are all 0
 * (a short text, followed by bytes that read as 0), 4 and 8 bytes give the same value.
 */
function textCopiedFrom(
  view: MachineView,
  value: bigint,
): { label: string; bytes: 4 | 8 | null } | null {
  if (value === 0n) return null
  for (const item of view.program.data) {
    if (item.label === null || item.text === null) continue
    const eight = storedValue(view.memory, item.address, 8)
    const four = storedValue(view.memory, item.address, 4)
    if (value !== eight && value !== four) continue
    const bytes = eight === four ? null : value === eight ? 8 : 4
    return { label: item.label, bytes }
  }
  return null
}

/** The text a function reads at the address in rdi. Stops when it is not readable. */
function textAtRdi(
  view: LibraryView,
  name: 'printf' | 'puts' | 'scanf',
  line: number,
  notes: NoteFacts[],
): number[] {
  const address = view.registers.rdi
  const read = readText(view, address)
  if (!read.ok && read.at !== address) {
    // The text starts in the program's memory, but has no 0 byte before it runs out of it.
    throw new LibraryStop(
      say.libraryError(line, { reason: 'text-runs-off', name, start: address, at: read.at }),
    )
  }
  if (!read.ok) {
    throw new LibraryStop(
      say.libraryError(line, {
        reason: 'text-address',
        name,
        value: address,
        copiedFrom: textCopiedFrom(view, address),
        pointsAtCode: read.why === 'code' ? codePlace(view, address) : null,
      }),
    )
  }
  if (read.ranInto !== null) {
    const at = address + BigInt(read.bytes.length)
    notes.push({
      kind: 'unterminated-text',
      start: address,
      at,
      ranInto: read.ranInto,
      functionName: name,
    })
  }
  return read.bytes
}

/* ──────────────────────────────── Arguments ──────────────────────────────── */

interface Argument {
  value: bigint
  place: say.ArgumentPlace
}

/** The values after the text: rsi, rdx, rcx, r8, r9, then the boxes above the return address. */
class Arguments {
  private readonly view: LibraryView
  private readonly name: 'printf' | 'scanf'
  private readonly line: number
  private readonly notes: NoteFacts[]
  private taken = 0

  constructor(view: LibraryView, name: 'printf' | 'scanf', line: number, notes: NoteFacts[]) {
    this.view = view
    this.name = name
    this.line = line
    this.notes = notes
  }

  next(): Argument {
    const position = this.taken
    this.taken++
    const { registers, memory, stack } = this.view
    if (position < ARGUMENT_REGISTERS.length) {
      const name = ARGUMENT_REGISTERS[position]
      return { value: registers[name], place: { kind: 'register', name } }
    }
    // rsp points at the return address. The stack arguments are the boxes right above it.
    const onStack = BigInt(position - ARGUMENT_REGISTERS.length)
    const address = truncate(registers.rsp + 8n + 8n * onStack, 64)
    let read: { value: bigint; uninitialized: boolean }
    try {
      read = memory.read(address, 8)
    } catch (thrown) {
      if (!(thrown instanceof MemoryFault)) throw thrown
      throw new LibraryStop(
        say.libraryError(this.line, { reason: 'stack-argument', name: this.name, address }),
      )
    }
    if (read.uninitialized && memory.regionAt(address) === stack) {
      const missing = countUnwritten(memory, address, 8)
      this.notes.push({ kind: 'uninitialized-read', address, bytes: 8, missing })
    }
    return { value: read.value, place: { kind: 'stack', address } }
  }
}

/* ───────────────────────────── The way back ───────────────────────────── */

/** The leftover values look like addresses inside the C library. */
const JUNK_BASE = 0x7ffff7e00000n

/**
 * The junk a library call leaves in a caller-saved register. It depends only on the
 * step number and on which register it is, so the same program always gets the same
 * junk. It is never 0 and never the value the register holds now.
 */
export function junkValue(stepNumber: number, position: number, current: bigint): bigint {
  let hash = (Math.imul(stepNumber + 1, 0x9e3779b1) ^ Math.imul(position + 1, 0x85ebca6b)) >>> 0
  hash ^= hash >>> 15
  hash = Math.imul(hash, 0x2c1b3c6d) >>> 0
  hash ^= hash >>> 12
  hash = Math.imul(hash, 0x297a2d39) >>> 0
  hash ^= hash >>> 15
  // A multiple of 8 in the megabyte after JUNK_BASE.
  const value = JUNK_BASE + BigInt(hash & 0xffff8)
  return value === current ? value + 8n : value
}

/** What a library function leaves behind, besides the return to the program. */
interface CallWork {
  /** The result: it goes into eax (the top half of rax becomes 0). */
  eax: bigint
  output: number[]
  memoryWrites: MemoryWrite[]
  stackLabels: StackLabelEffect[]
  stdinPosition: number | null
  notes: NoteFacts[]
  facts: (eax: bigint, returned: ReturnFacts) => LibraryFacts
}

/** The 8 bytes at `address` (now `value`) after `writes` are stored, as one number. */
function afterWrites(value: bigint, address: bigint, writes: readonly MemoryWrite[]): bigint {
  const bytes = littleEndianBytes(value, 8)
  for (const write of writes) {
    const offset = write.address - address
    if (offset <= -BigInt(write.bytes.length) || offset >= 8n) continue
    write.bytes.forEach((byte, i) => {
      const at = Number(offset) + i
      if (at >= 0 && at < 8) bytes[at] = byte
    })
  }
  return bytes.reduce((sum, byte, i) => sum | (BigInt(byte) << BigInt(8 * i)), 0n)
}

/** The effects of a finished call: its work, the junk registers and the return. */
function finishCall(
  view: LibraryView,
  name: LibraryFunctionName,
  callLine: number,
  work: CallWork,
): Effects {
  const { program, registers, memory } = view
  // The text this call adds to the output. Both limits count real characters (an emoji
  // is one), the way the explanation counts them, so the messages say what happened.
  const printed = decodeUtf8(work.output)
  const count = [...printed].length
  const printer = name === 'puts' || name === 'putchar' ? name : 'printf'
  if (count > say.MAX_CALL_OUTPUT) {
    throw new LibraryStop(say.libraryError(callLine, { reason: 'call-output', name: printer }))
  }
  if (view.outputLength + count > say.MAX_TOTAL_OUTPUT) {
    throw new LibraryStop(
      say.libraryError(callLine, { reason: 'total-output', name: printer, count }),
    )
  }
  const rspBefore = registers.rsp
  let saved: bigint
  try {
    saved = memory.read(rspBefore, 8).value
  } catch (thrown) {
    if (!(thrown instanceof MemoryFault)) throw thrown
    throw new LibraryStop(
      say.badMemoryRead(callLine, {
        text: `${name} (library code)`,
        address: rspBefore,
        bytes: 8,
        faultAddress: thrown.address,
        access: { via: 'stack-top' },
      }),
    )
  }
  // scanf may have stored a value over its own return address: then, as on a real
  // machine, it returns to whatever is in that box after its work.
  const address = afterWrites(saved, rspBefore, work.memoryWrites)
  const rspAfter = truncate(rspBefore + 8n, 64)
  const line = lineAt(program, address)

  const registerWrites: RegisterWrite[] = [{ reg: EAX, value: work.eax }]
  const notes = [...work.notes]
  if (view.clobberCallerSaved) {
    CALLER_SAVED.forEach((register, position) => {
      const junk = junkValue(view.stepNumber, position, registers[register])
      registerWrites.push({ reg: reg(register), value: junk })
    })
    notes.push({ kind: 'junk-registers', functionName: name, registers: CALLER_SAVED })
  }
  registerWrites.push({ reg: RSP, value: rspAfter })

  let outcome: StepOutcome = { status: 'running' }
  if (line === null) {
    const call = program.instructions[program.lineToIndex.get(callLine) ?? -1]
    outcome =
      address === saved && address === program.layout.textEnd && call !== undefined
        ? {
            status: 'error',
            problem: say.ranOffEnd(callLine, {
              reason: 'last-instruction',
              text: call.text,
              functionName: null,
            }),
          }
        : {
            status: 'error',
            problem: say.badJump(callLine, { reason: 'library-return', name, value: address }),
          }
  }

  return {
    registerWrites,
    flagWrites: {},
    memoryWrites: work.memoryWrites,
    nextRip: address,
    stackLabels: work.stackLabels,
    callStack: null,
    library: 'leave',
    // Real library code may change every flag, as it may change the caller-saved
    // registers. With that realism switched off, the flags count as kept.
    flagsWriter: view.clobberCallerSaved ? { kind: 'library', name, callLine } : null,
    output: printed,
    stdinPosition: work.stdinPosition,
    outcome,
    facts: work.facts(truncate(work.eax, 32), {
      address,
      rspBefore,
      rspAfter,
      line,
      changed: address !== saved,
    }),
    notes,
  }
}

/* ──────────────────────────────── printf ──────────────────────────────── */

type LengthModifier = '' | 'hh' | 'h' | 'l' | 'll' | 'L' | 'z' | 'j' | 't'

/** How many bits of the value a conversion uses, by its length modifier. */
function lengthBits(length: LengthModifier): 8 | 16 | 32 | 64 {
  if (length === 'hh') return 8
  if (length === 'h') return 16
  return length === '' ? 32 : 64
}

/** Reads `hh`, `h`, `ll`, `l`, `L`, `z`, `j`, `t` at `position`. */
function readLength(
  format: readonly number[],
  position: number,
): { length: LengthModifier; end: number } {
  const one = String.fromCharCode(format[position] ?? 0)
  const two = one + String.fromCharCode(format[position + 1] ?? 0)
  if (two === 'hh' || two === 'll') return { length: two, end: position + 2 }
  if (one === 'h' || one === 'l' || one === 'L' || one === 'z' || one === 'j' || one === 't') {
    return { length: one, end: position + 1 }
  }
  return { length: '', end: position }
}

function isDigit(byte: number | undefined): byte is number {
  return byte !== undefined && byte >= 0x30 && byte <= 0x39
}

/** Reads decimal digits at `position`. `value` is null when there are none. */
function readDigits(
  format: readonly number[],
  position: number,
): { value: number | null; end: number } {
  let end = position
  let value = 0
  while (isDigit(format[end])) {
    // A very long run of digits cannot overflow: the value stops growing at a million.
    value = Math.min(value * 10 + (format[end] - 0x30), 1_000_000)
    end++
  }
  return { value: end === position ? null : value, end }
}

interface PrintSpec {
  /** Flags: `-` left-justify, `0` zero padding, `+` and space for the sign, `#` for `0x`. */
  minus: boolean
  zero: boolean
  plus: boolean
  space: boolean
  hash: boolean
  width: number | null
  precision: number | null
  length: LengthModifier
  /** The conversion letter, or '' when the text ended first. */
  conversion: string
  /** The whole item as written, for messages: `%5d`. */
  text: string
}

/** Read one `%…` item. `start` is the position of the `%`. */
function readPrintSpec(
  format: readonly number[],
  start: number,
  args: Arguments,
): { spec: PrintSpec; end: number } {
  const spec: PrintSpec = {
    minus: false,
    zero: false,
    plus: false,
    space: false,
    hash: false,
    width: null,
    precision: null,
    length: '',
    conversion: '',
    text: '',
  }
  let position = start + 1
  for (;;) {
    const flag = String.fromCharCode(format[position] ?? 0)
    if (flag === '-') spec.minus = true
    else if (flag === '0') spec.zero = true
    else if (flag === '+') spec.plus = true
    else if (flag === ' ') spec.space = true
    else if (flag === '#') spec.hash = true
    else break
    position++
  }

  if (format[position] === 0x2a) {
    // `*`: the width is the next value. A negative width means left-justify.
    const width = Number(toSigned(truncate(args.next().value, 32), 32))
    spec.minus ||= width < 0
    spec.width = Math.abs(width)
    position++
  } else {
    const digits = readDigits(format, position)
    spec.width = digits.value
    position = digits.end
  }

  if (format[position] === 0x2e) {
    position++
    if (format[position] === 0x2a) {
      const precision = Number(toSigned(truncate(args.next().value, 32), 32))
      spec.precision = precision < 0 ? null : precision
      position++
    } else {
      const digits = readDigits(format, position)
      spec.precision = digits.value ?? 0
      position = digits.end
    }
  }

  const length = readLength(format, position)
  spec.length = length.length
  position = length.end

  const conversion = format[position]
  if (conversion !== undefined) {
    spec.conversion = String.fromCharCode(conversion)
    position++
  }
  spec.text = fromBytes(format.slice(start, position))
  return { spec, end: position }
}

/** Pad to the width with spaces: on the left, or on the right after a `-` flag. */
function padToWidth(bytes: number[], spec: PrintSpec): number[] {
  const missing = (spec.width ?? 0) - bytes.length
  if (missing <= 0) return bytes
  const spaces = new Array<number>(missing).fill(0x20)
  return spec.minus ? [...bytes, ...spaces] : [...spaces, ...bytes]
}

/** One whole number the way C prints it (sign, `0x`, precision, width, zero padding). */
function formatInteger(
  value: bigint,
  spec: PrintSpec,
  base: 10 | 16,
  options: { upper: boolean; signed: boolean },
): number[] {
  const negative = value < 0n
  let digits = (negative ? -value : value).toString(base)
  if (options.upper) digits = digits.toUpperCase()
  if (spec.precision !== null) {
    // A precision is the smallest number of digits. With precision 0, the value 0 prints nothing.
    digits = spec.precision === 0 && value === 0n ? '' : digits.padStart(spec.precision, '0')
  }
  let prefix = ''
  if (negative) prefix = '-'
  else if (options.signed && spec.plus) prefix = '+'
  else if (options.signed && spec.space) prefix = ' '
  if (spec.hash && base === 16 && value !== 0n) prefix += options.upper ? '0X' : '0x'

  const width = spec.width ?? 0
  if (spec.zero && !spec.minus && spec.precision === null) {
    // Zeros go between the sign and the digits.
    digits = digits.padStart(width - prefix.length, '0')
  }
  return padToWidth(asciiBytes(prefix + digits), spec)
}

/** What formatting one `%…` item needs besides the item itself. */
interface PrintContext {
  view: LibraryView
  args: Arguments
  line: number
  notes: NoteFacts[]
}

/** The bytes one `%…` item prints. */
function formatItem(spec: PrintSpec, context: PrintContext): number[] {
  const { view, args, line, notes } = context
  const bits = lengthBits(spec.length)
  switch (spec.conversion) {
    case '%':
      return [PERCENT]
    case 'd':
    case 'i': {
      const value = toSigned(truncate(args.next().value, bits), bits)
      return formatInteger(value, spec, 10, { upper: false, signed: true })
    }
    case 'u':
      return formatInteger(truncate(args.next().value, bits), spec, 10, {
        upper: false,
        signed: false,
      })
    case 'x':
    case 'X':
      return formatInteger(truncate(args.next().value, bits), spec, 16, {
        upper: spec.conversion === 'X',
        signed: false,
      })
    case 'c':
      return padToWidth([Number(args.next().value & 0xffn)], spec)
    case 's': {
      const argument = args.next()
      const read = readText(view, argument.value)
      if (!read.ok && read.at !== argument.value) {
        throw new LibraryStop(
          say.libraryError(line, {
            reason: 'text-runs-off',
            name: 'printf',
            start: argument.value,
            at: read.at,
          }),
        )
      }
      if (!read.ok) {
        throw new LibraryStop(
          say.libraryError(line, {
            reason: 'string-argument',
            name: 'printf',
            place: argument.place,
            value: argument.value,
            pointsAtCode: read.why === 'code' ? codePlace(view, argument.value) : null,
          }),
        )
      }
      // A precision is the largest number of bytes to print (and to read).
      const cut = spec.precision !== null && spec.precision <= read.bytes.length
      if (read.ranInto !== null && !cut) {
        notes.push({
          kind: 'unterminated-text',
          start: argument.value,
          at: argument.value + BigInt(read.bytes.length),
          ranInto: read.ranInto,
          functionName: 'printf',
        })
      }
      const bytes = spec.precision === null ? read.bytes : read.bytes.slice(0, spec.precision)
      return padToWidth(bytes, spec)
    }
    case 'p': {
      // glibc prints a null pointer as "(nil)".
      const value = args.next().value
      return padToWidth(asciiBytes(value === 0n ? '(nil)' : `0x${value.toString(16)}`), spec)
    }
    case '':
      if (spec.text === '%') {
        throw new LibraryStop(say.libraryError(line, { reason: 'lone-percent', name: 'printf' }))
      }
      throw new LibraryStop(
        say.libraryError(line, {
          reason: 'unknown-conversion',
          name: 'printf',
          conversion: spec.text,
        }),
      )
    default:
      throw new LibraryStop(
        say.libraryError(line, {
          reason: 'unknown-conversion',
          name: 'printf',
          conversion: spec.text,
        }),
      )
  }
}

/** The bytes `printf` prints for the text in `format`. */
function formatPrintf(format: readonly number[], context: PrintContext): number[] {
  const { args, line } = context
  const output: number[] = []
  let position = 0
  while (position < format.length) {
    const byte = format[position]
    if (byte !== PERCENT) {
      // Everything that is not a `%` item is printed as it is.
      output.push(byte)
      position++
      continue
    }
    const { spec, end } = readPrintSpec(format, position, args)
    const tooWide =
      (spec.width ?? 0) > say.MAX_FIELD_WIDTH || (spec.precision ?? 0) > say.MAX_FIELD_WIDTH
    if (tooWide) {
      throw new LibraryStop(
        say.libraryError(line, { reason: 'width', name: 'printf', conversion: spec.text }),
      )
    }
    for (const printed of formatItem(spec, context)) output.push(printed)
    // Stop early, so that the work stays small: this text surely has more characters
    // than one call may print. (`finishCall` checks the exact count of every call.)
    if (output.length > CALL_OUTPUT_BYTES) {
      throw new LibraryStop(say.libraryError(line, { reason: 'call-output', name: 'printf' }))
    }
    position = end
  }
  return output
}

/** How many characters a run of printed bytes is (fewer than its bytes outside ASCII). */
function countCharacters(bytes: readonly number[]): number {
  return [...decodeUtf8(bytes)].length
}

function runPrintf(view: LibraryView, callLine: number): Effects {
  const notes: NoteFacts[] = []
  const format = textAtRdi(view, 'printf', callLine, notes)
  const output = formatPrintf(format, {
    view,
    args: new Arguments(view, 'printf', callLine, notes),
    line: callLine,
    notes,
  })
  return finishCall(view, 'printf', callLine, {
    eax: BigInt(output.length),
    output,
    memoryWrites: [],
    stackLabels: [],
    stdinPosition: null,
    notes,
    facts: (eax, returned) => ({
      kind: 'print',
      name: 'printf',
      bytes: output.length,
      characters: countCharacters(output),
      eax,
      returned,
    }),
  })
}

/* ───────────────────────────── puts, putchar, exit ───────────────────────────── */

function runPuts(view: LibraryView, callLine: number): Effects {
  const notes: NoteFacts[] = []
  const output = [...textAtRdi(view, 'puts', callLine, notes), NEW_LINE]
  return finishCall(view, 'puts', callLine, {
    eax: BigInt(output.length),
    output,
    memoryWrites: [],
    stackLabels: [],
    stdinPosition: null,
    notes,
    facts: (eax, returned) => ({
      kind: 'print',
      name: 'puts',
      bytes: output.length,
      characters: countCharacters(output),
      eax,
      returned,
    }),
  })
}

function runPutchar(view: LibraryView, callLine: number): Effects {
  const code = Number(view.registers.rdi & 0xffn)
  return finishCall(view, 'putchar', callLine, {
    eax: BigInt(code),
    output: [code],
    memoryWrites: [],
    stackLabels: [],
    stdinPosition: null,
    notes: [],
    facts: (eax, returned) => ({ kind: 'putchar', code, eax, returned }),
  })
}

/** `exit` ends the program. It does not return, so rip and rsp stay where they are. */
function runExit(view: LibraryView): Effects {
  const code = toSigned(readRegister(view.registers, EDI), 32)
  return {
    registerWrites: [],
    flagWrites: {},
    memoryWrites: [],
    // rip stays inside `exit`.
    nextRip: LIBRARY_FUNCTIONS.exit,
    stackLabels: [],
    callStack: null,
    library: null,
    flagsWriter: null,
    output: '',
    stdinPosition: null,
    outcome: { status: 'halted' },
    facts: { kind: 'exit', code },
    notes: [],
  }
}

/* ──────────────────────────────── scanf ──────────────────────────────── */

type ScanDirective =
  /** White space in the format: skip white space in the input. */
  | { kind: 'space' }
  /** Any other character: the input must have the same one. */
  | { kind: 'literal'; byte: number }
  | {
      kind: 'conversion'
      type: ScanKind
      /** `%*d`: read the value and throw it away. */
      suppress: boolean
      width: number | null
      /** How many bytes a number is stored in (1, 2, 4 or 8). */
      bytes: number
      /** The item as written, for messages: `%d`. */
      text: string
    }

type ScanConversion = Extract<ScanDirective, { kind: 'conversion' }>

const SCAN_TYPES: Readonly<Record<string, ScanKind>> = {
  d: 'decimal',
  i: 'integer',
  u: 'unsigned',
  x: 'hex',
  X: 'hex',
  c: 'character',
  s: 'word',
}

/** Space, tab, new line and the other characters C calls white space. */
function isSpace(byte: number | undefined): boolean {
  return byte === 0x20 || (byte !== undefined && byte >= 0x09 && byte <= 0x0d)
}

/** Split the format of `scanf` into its parts. Stops at an item the emulator does not know. */
function readScanFormat(format: readonly number[], line: number): ScanDirective[] {
  const directives: ScanDirective[] = []
  let position = 0
  while (position < format.length) {
    const byte = format[position]
    if (isSpace(byte)) {
      while (isSpace(format[position])) position++
      directives.push({ kind: 'space' })
      continue
    }
    if (byte !== PERCENT) {
      directives.push({ kind: 'literal', byte })
      position++
      continue
    }

    const start = position
    position++
    const suppress = format[position] === 0x2a
    if (suppress) position++
    const digits = readDigits(format, position)
    position = digits.end
    const length = readLength(format, position)
    position = length.end
    const letter = format[position] === undefined ? '' : String.fromCharCode(format[position])
    if (letter !== '') position++
    const text = fromBytes(format.slice(start, position))

    if (letter === '%') {
      // `%%` stands for one percent sign in the input (after any white space).
      directives.push({ kind: 'space' }, { kind: 'literal', byte: PERCENT })
      continue
    }
    if (text === '%') {
      throw new LibraryStop(say.libraryError(line, { reason: 'lone-percent', name: 'scanf' }))
    }
    const type = Object.hasOwn(SCAN_TYPES, letter) ? SCAN_TYPES[letter] : undefined
    if (type === undefined) {
      throw new LibraryStop(
        say.libraryError(line, { reason: 'unknown-conversion', name: 'scanf', conversion: text }),
      )
    }
    directives.push({
      kind: 'conversion',
      type,
      suppress,
      width: digits.value === null || digits.value === 0 ? null : digits.value,
      bytes: lengthBits(length.length) / 8,
      text,
    })
  }
  return directives
}

const TWO_63 = 1n << 63n
const TWO_64 = 1n << 64n

/** The digit a byte stands for in `base`, or -1. */
function digitValue(byte: number | undefined, base: number): number {
  if (byte === undefined) return -1
  let digit = -1
  if (byte >= 0x30 && byte <= 0x39) digit = byte - 0x30
  else if (byte >= 0x61 && byte <= 0x66) digit = byte - 0x61 + 10
  else if (byte >= 0x41 && byte <= 0x46) digit = byte - 0x41 + 10
  return digit >= 0 && digit < base ? digit : -1
}

/**
 * Read one number at `position`, not going past `limit`. The value is the number as
 * typed (it may be negative). When the input there is not a number of that kind, `ok`
 * is false and `end` is where C stops reading: after a sign, if there was one (the C
 * library keeps the sign it read and puts back only the character after it).
 */
function scanNumber(
  input: readonly number[],
  position: number,
  limit: number,
  type: ScanKind,
): { ok: true; value: bigint; end: number } | { ok: false; end: number } {
  let at = position
  let negative = false
  if (at < limit && (input[at] === 0x2b || input[at] === 0x2d)) {
    negative = input[at] === 0x2d
    at++
  }
  let base = 10
  if (type === 'hex' || type === 'integer') {
    const zero = input[at] === 0x30
    const x = input[at + 1] === 0x78 || input[at + 1] === 0x58
    if (zero && x && at + 2 < limit && digitValue(input[at + 2], 16) >= 0) {
      base = 16
      at += 2
    } else if (type === 'hex') base = 16
    else if (zero) base = 8 // `%i` reads a number that starts with 0 as octal, like C
  }
  let value = 0n
  let digits = 0
  while (at < limit) {
    const digit = digitValue(input[at], base)
    if (digit < 0) break
    value = value * BigInt(base) + BigInt(digit)
    digits++
    at++
  }
  // No digit: `at` is past the sign, if there was one (a `0x` is only taken with a digit after it).
  if (digits === 0) return { ok: false, end: at }
  if (negative) value = -value
  // Like the C library, a number that is too big stays at the biggest value.
  if (type === 'decimal' || type === 'integer') {
    if (value >= TWO_63) value = TWO_63 - 1n
    if (value < -TWO_63) value = -TWO_63
  } else if (value >= TWO_64 || value <= -TWO_64) {
    value = TWO_64 - 1n
  }
  return { ok: true, value, end: at }
}

interface PendingStore {
  item: ScanItem
  bytes: number[]
}

type ScanResult =
  | { kind: 'need-input'; missing: MissingValue[]; partial: boolean }
  | {
      kind: 'done'
      stores: PendingStore[]
      /** How many input bytes are used up. */
      position: number
      /**
       * Set when the input did not match a value the format still wanted. (A text part
       * of the format that does not match after the last value is not a problem: scanf
       * has stored everything by then.)
       */
      mismatch: { wanted: ScanKind | { literal: string }; found: FoundInput } | null
    }

/** The next word of the input (at most 20 bytes), for the "found `abc`" part of a warning. */
function nextWord(input: readonly number[], position: number): string {
  let end = position
  while (end < input.length && !isSpace(input[end]) && end - position < 20) end++
  return decodeUtf8(input.slice(position, end))
}

/** What the input holds at `position`, for a warning. */
function foundAt(input: readonly number[], position: number): FoundInput {
  const byte = input[position]
  if (byte === 0x20) return { kind: 'space' }
  if (byte === 0x09) return { kind: 'tab' }
  if (byte === undefined || byte === 0x0a || byte === 0x0d) return { kind: 'line-end' }
  if (isSpace(byte)) return { kind: 'white-space' }
  return { kind: 'text', text: nextWord(input, position) }
}

/** Match the input against the format. Nothing is stored here. */
function scanInput(
  directives: readonly ScanDirective[],
  destinations: readonly bigint[],
  input: readonly number[],
  start: number,
): ScanResult {
  const stores: PendingStore[] = []
  let position = start
  let destination = 0
  let matched = 0
  const skipSpace = (): void => {
    while (position < input.length && isSpace(input[position])) position++
  }
  /** The values that are still missing from directive `from` on. */
  const missingFrom = (from: number): MissingValue[] =>
    directives
      .slice(from)
      .filter((directive): directive is ScanConversion => directive.kind === 'conversion')
      .map((directive) => ({ kind: directive.type, width: directive.width }))
  const needInput = (from: number): ScanResult => ({
    kind: 'need-input',
    missing: missingFrom(from),
    partial: matched > 0,
  })
  // As in C, the character that did not match stays in the input.
  const stop = (from: number, wanted: ScanKind | { literal: string }, at: number): ScanResult => ({
    kind: 'done',
    stores,
    position: at,
    mismatch: missingFrom(from).length > 0 ? { wanted, found: foundAt(input, at) } : null,
  })

  for (let i = 0; i < directives.length; i++) {
    const directive = directives[i]
    if (directive.kind === 'space') {
      skipSpace()
      continue
    }
    if (directive.kind === 'literal') {
      if (position >= input.length) {
        // Out of input: wait only when a value is still to come.
        if (missingFrom(i).length > 0) return needInput(i)
        break
      }
      if (input[position] !== directive.byte) {
        return stop(i, { literal: fromBytes([directive.byte]) }, position)
      }
      position++
      continue
    }

    // A conversion. Everything except `%c` skips white space first.
    if (directive.type !== 'character') skipSpace()
    const limit = Math.min(input.length, position + (directive.width ?? Infinity))
    const address = directive.suppress ? 0n : (destinations[destination] ?? 0n)

    if (directive.type === 'character') {
      const count = directive.width ?? 1
      if (position + count > input.length) return needInput(i)
      const codes = input.slice(position, position + count)
      position += count
      matched++
      if (directive.suppress) continue
      stores.push({
        item: { kind: 'character', codes, address, bytes: count },
        bytes: codes,
      })
      destination++
      continue
    }

    if (position >= input.length) return needInput(i)

    if (directive.type === 'word') {
      let end = position
      while (end < limit && !isSpace(input[end])) end++
      const word = input.slice(position, end)
      position = end
      matched++
      if (directive.suppress) continue
      stores.push({
        item: { kind: 'word', text: decodeUtf8(word), address, bytes: word.length + 1 },
        // The word and the 0 byte that ends it.
        bytes: [...word, 0],
      })
      destination++
      continue
    }

    const begin = position
    const number = scanNumber(input, position, limit, directive.type)
    if (!number.ok) return stop(i, directive.type, number.end)
    position = number.end
    matched++
    if (directive.suppress) continue
    stores.push({
      item: {
        kind: 'number',
        conversion: directive.type,
        value: number.value,
        typed: decodeUtf8(input.slice(begin, number.end)),
        address,
        bytes: directive.bytes,
      },
      bytes: littleEndianBytes(number.value, directive.bytes),
    })
    destination++
  }
  return { kind: 'done', stores, position, mismatch: null }
}

/** How many of the `wanted` bytes at `address` can be written, from the first one on. */
function writableRoom(memory: Memory, address: bigint, wanted: number): number {
  let room = 0
  while (room < wanted && findWriteFault(memory, address + BigInt(room), 1) === null) room++
  return room
}

function runScanf(view: LibraryView, callLine: number): LibraryResult {
  const { memory, stack } = view
  const notes: NoteFacts[] = []
  const format = textAtRdi(view, 'scanf', callLine, notes)
  const directives = readScanFormat(format, callLine)

  // Every value needs the address of a place to store it. Check them all before
  // reading anything, so a wrong address is reported at once.
  const args = new Arguments(view, 'scanf', callLine, notes)
  const destinations: bigint[] = []
  const places: say.ArgumentPlace[] = []
  const refuse = (index: number, conversion: string): never => {
    throw new LibraryStop(
      say.libraryError(callLine, {
        reason: 'destination',
        place: places[index],
        value: destinations[index],
        conversion,
      }),
    )
  }
  for (const directive of directives) {
    if (directive.kind !== 'conversion' || directive.suppress) continue
    const argument = args.next()
    destinations.push(argument.value)
    places.push(argument.place)
    let needed = directive.bytes
    if (directive.type === 'word') needed = 1
    else if (directive.type === 'character') needed = directive.width ?? 1
    if (findWriteFault(memory, argument.value, needed) !== null) {
      refuse(destinations.length - 1, directive.text)
    }
  }

  const scanned = scanInput(directives, destinations, view.stdin, view.stdinPosition)
  if (scanned.kind === 'need-input') {
    return { kind: 'waiting', missing: scanned.missing, partial: scanned.partial }
  }

  // A word can be longer than the room at its address: check the whole of it now.
  for (const pending of scanned.stores) {
    const { item } = pending
    const length = pending.bytes.length
    if (item.kind !== 'word' || findWriteFault(memory, item.address, length) === null) continue
    throw new LibraryStop(
      say.libraryError(callLine, {
        reason: 'word-room',
        word: item.text,
        needed: length,
        room: writableRoom(memory, item.address, length),
        address: item.address,
      }),
    )
  }

  const memoryWrites: MemoryWrite[] = []
  const stackLabels: StackLabelEffect[] = []
  for (const pending of scanned.stores) {
    const { address } = pending.item
    memoryWrites.push({ address, bytes: pending.bytes })
    if (address >= stack.start && address < stack.end && pending.bytes.length > 0) {
      // A variable keeps its name when scanf fills it; other labels may be wrong now.
      const last = boxOf(address + BigInt(pending.bytes.length - 1))
      for (let box = boxOf(address); box <= last; box += 8n) {
        stackLabels.push({ box, clear: 'unless-local' })
      }
    }
  }

  const stored = scanned.stores.map((pending) => pending.item)
  if (scanned.mismatch !== null) {
    notes.push({ kind: 'scanf-mismatch', ...scanned.mismatch, stored: stored.length })
  }
  const failed = scanned.mismatch !== null
  const wanted = destinations.length
  const effects = finishCall(view, 'scanf', callLine, {
    eax: BigInt(stored.length),
    output: [],
    memoryWrites,
    stackLabels,
    stdinPosition: scanned.position,
    notes,
    facts: (eax, returned) => ({ kind: 'scanf', stored, wanted, failed, eax, returned }),
  })
  return { kind: 'done', effects }
}

/* ──────────────────────────────── Dispatch ──────────────────────────────── */

/**
 * Run the library function `name`, called from `callLine`. Changes nothing: the result
 * says what to commit, why the program stops, or that scanf is waiting for input.
 */
export function runLibraryFunction(
  view: LibraryView,
  name: LibraryFunctionName,
  callLine: number,
): LibraryResult {
  try {
    switch (name) {
      case 'printf':
        return { kind: 'done', effects: runPrintf(view, callLine) }
      case 'puts':
        return { kind: 'done', effects: runPuts(view, callLine) }
      case 'putchar':
        return { kind: 'done', effects: runPutchar(view, callLine) }
      case 'scanf':
        return runScanf(view, callLine)
      case 'exit':
        return { kind: 'done', effects: runExit(view) }
    }
  } catch (thrown) {
    if (thrown instanceof LibraryStop) return { kind: 'problem', problem: thrown.problem }
    throw thrown
  }
}
