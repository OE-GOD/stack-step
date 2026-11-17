/**
 * The run-time message catalog: every sentence the emulator can say when a program
 * stops with an error WHILE IT RUNS. (The messages about reading the program are in
 * `errors.ts`.)
 *
 * One function per situation. Each takes the line number and the details and returns a
 * `RuntimeProblem`: the finished `EmulatorError`, plus the first sentence of the message
 * by itself (`summary`), and that sentence as the explanation of the step says it
 * (`stepSummary`).
 *
 * Writing rules (see PLAN.md): short sentences, common words, one idea per sentence.
 * A message says what happened, then what to do next. It has at most three sentences.
 * Code is wrapped in backticks (the UI shows backticked text in a code font).
 * When the line is known the message starts with "Line N: ".
 */
import { code } from './errors'
import { groupDigits, joinAnd, joinOr, signedHex as hex } from './format'
import type { EmulatorError, LibraryFunctionName, RuntimeCode } from './types'

/* ───────────────────────────── Small helpers ───────────────────────────── */

export interface RuntimeProblem {
  error: EmulatorError
  /**
   * The first sentence of the message, without "Line N: ". It starts with a small
   * letter or with code, so it reads well after "Line 6: ".
   */
  summary: string
  /**
   * The same sentence for the explanation of the step, which already starts with the
   * instruction in backticks. Where the summary names the instruction again, this one
   * says "it" ("`pop rax`: it tried to read the top box …").
   */
  stepSummary: string
}

// Values are written in full here (`hex` is `signedHex`): an error is not the place to shorten.

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "`a`", "`a` and `b`", "`a`, `b` and `c`". */
function andList(items: readonly string[]): string {
  return joinAnd(items.map(code))
}

/** "`a`", "`a` or `b`", "`a`, `b` or `c`". */
function orList(items: readonly string[]): string {
  return joinOr(items.map(code))
}

/**
 * Where an address that is not readable text points, when it is inside the code of the
 * program: at an instruction, or somewhere else in the code (the code area is a whole
 * page, so most of its addresses are not instructions).
 */
export type CodePlace = 'instruction' | 'code' | null

/** ", which is the address of an instruction" — the end of a sentence about a value. */
function codePlaceWords(place: 'instruction' | 'code'): string {
  return place === 'instruction'
    ? 'which is the address of an instruction'
    : 'which is an address inside the code of the program'
}

function make(
  which: RuntimeCode,
  line: number | null,
  sentences: readonly string[],
  stepSummary: string = sentences[0],
): RuntimeProblem {
  const text = sentences.join(' ')
  const known = line !== null && line > 0
  return {
    error: {
      code: which,
      line: known ? line : null,
      message: known ? `Line ${line}: ${text}` : capitalize(text),
    },
    summary: sentences[0],
    stepSummary,
  }
}

const SEGMENTATION_FAULT = 'On a real machine this is called a segmentation fault.'

/* ───────────────────────────── Memory faults ───────────────────────────── */

/** A register that was used to build an address, and what it holds. */
export interface AddressRegister {
  name: string
  value: bigint
}

/** How the instruction reached the memory it touched. */
export type MemoryAccess =
  /** A memory operand such as `[rbx]` or `8[rsp]`, built from these registers. */
  | { via: 'operand'; registers: readonly AddressRegister[] }
  /** The top of the stack: `push`, `pop`, `call`, `ret`. */
  | { via: 'stack-top' }
  /** `leave` reads the box that rbp points at. */
  | { via: 'rbp' }

export interface MemoryFaultDetail {
  /** The instruction text. */
  text: string
  /** Where the access starts. */
  address: bigint
  /** How many bytes the instruction wanted. */
  bytes: number
  /** The first byte the program does not own (it can be later than `address`). */
  faultAddress: bigint
  access: MemoryAccess
}

/** The last sentence of a memory fault: where to look. */
function whereToLook(access: MemoryAccess): string {
  switch (access.via) {
    case 'stack-top':
      return 'Check rsp: it must point into the stack.'
    case 'rbp':
      return `Check rbp: it must point into the stack before ${code('leave')}.`
    case 'operand': {
      const [first, second] = access.registers
      if (first === undefined) return 'Check the address in this instruction.'
      if (second === undefined) {
        return `Check ${first.name}, the register used as the address: it holds ${hex(first.value)}.`
      }
      return `Check ${first.name} and ${second.name}, the registers used in the address: they hold ${hex(first.value)} and ${hex(second.value)}.`
    }
  }
}

/**
 * "this instruction tried to read memory at 0x0, but …". `subject` names the
 * instruction: "this instruction" or the instruction in backticks for the message, "it"
 * for the explanation of the step.
 */
function memorySentence(
  detail: MemoryFaultDetail,
  action: 'read' | 'write',
  subject: { operand: string; stack: string },
): string {
  const where = hex(detail.address)
  switch (detail.access.via) {
    case 'stack-top':
      return action === 'read'
        ? `${subject.stack} tried to read the top box at ${where}, but your program does not own that address.`
        : `${subject.stack} tried to write a new top box at ${where}, but your program does not own that address.`
    case 'rbp':
      return `${subject.stack} tried to read the stack box at ${where}, the address in rbp, but your program does not own that address.`
    case 'operand': {
      // An access can start inside the program's memory and end outside it.
      if (detail.faultAddress !== detail.address) {
        const owned = detail.faultAddress - detail.address
        return `${subject.operand} tried to ${action} ${detail.bytes} bytes at ${where}, but only the first ${owned} of them belong to your program.`
      }
      const verb = action === 'read' ? 'read' : 'write to'
      return `${subject.operand} tried to ${verb} memory at ${where}, but your program does not own that address.`
    }
  }
}

function memoryFault(
  which: 'bad-memory-read' | 'bad-memory-write',
  line: number,
  detail: MemoryFaultDetail,
): RuntimeProblem {
  const action = which === 'bad-memory-read' ? 'read' : 'write'
  // Only part of the access was outside: the size may be the mistake, not the address.
  const partial = detail.access.via === 'operand' && detail.faultAddress !== detail.address
  return make(
    which,
    line,
    [
      memorySentence(detail, action, { operand: 'this instruction', stack: code(detail.text) }),
      SEGMENTATION_FAULT,
      partial
        ? `${capitalize(action)} fewer bytes, or check the address in this instruction.`
        : whereToLook(detail.access),
    ],
    memorySentence(detail, action, { operand: 'it', stack: 'it' }),
  )
}

export function badMemoryRead(line: number, detail: MemoryFaultDetail): RuntimeProblem {
  return memoryFault('bad-memory-read', line, detail)
}

export function badMemoryWrite(line: number, detail: MemoryFaultDetail): RuntimeProblem {
  return memoryFault('bad-memory-write', line, detail)
}

export interface WriteReadOnlyDetail {
  text: string
  /** The first byte that cannot be changed. */
  address: bigint
  /** 'text' is the code of the program, 'rodata' its read-only data. */
  region: 'text' | 'rodata'
  /** The data label that owns the address, when there is one. */
  label: string | null
  /**
   * 'operand': a memory operand of the instruction. 'stack-top': `push` or `call` wrote
   * its new top box there, because rsp points at read-only memory.
   */
  via: 'operand' | 'stack-top'
}

export function writeReadOnly(line: number, detail: WriteReadOnlyDetail): RuntimeProblem {
  const where = hex(detail.address)
  if (detail.via === 'stack-top') {
    const what =
      detail.region === 'text'
        ? 'that memory is part of the code of the program'
        : 'that memory is read-only'
    const tried = `tried to write a new top box at ${where}, but ${what}.`
    return make(
      'write-read-only',
      line,
      [`${code(detail.text)} ${tried}`, 'Check rsp: it must point into the stack.'],
      `it ${tried}`,
    )
  }
  if (detail.region === 'text') {
    return make('write-read-only', line, [
      `this instruction tried to change memory at ${where}, but that memory is part of the code of the program.`,
      'A program cannot change its own code.',
      'Check the address in this instruction.',
    ])
  }
  return make('write-read-only', line, [
    `this instruction tried to change memory at ${where}, but that memory is read-only.`,
    detail.label !== null
      ? `It belongs to ${code(detail.label)}, which is not in the ${code('.data')} section.`
      : `It is not in the ${code('.data')} section.`,
    `Put data that the program changes after a ${code('.data')} line.`,
  ])
}

export function stackOverflow(line: number, detail: { text: string; rsp: bigint }): RuntimeProblem {
  const needs = `needs a new stack box below ${hex(detail.rsp)}, but the stack has no room left.`
  return make(
    'stack-overflow',
    line,
    [
      `${code(detail.text)} ${needs}`,
      'This is called a stack overflow.',
      'It usually means that a function calls itself and never stops, or that a loop pushes and never pops.',
    ],
    `it ${needs}`,
  )
}

/* ───────────────────────────── Where rip went ───────────────────────────── */

export type BadJumpDetail =
  /** `ret` popped a value that is not the address of an instruction. */
  | { reason: 'ret'; value: bigint }
  /** `ret` went back to a `call` that was the last instruction of the program. */
  | { reason: 'return-to-end'; value: bigint; callLine: number }
  /** `jmp`, a conditional jump or `call` went to a label with no instruction after it. */
  | { reason: 'label-at-end'; text: string; name: string }
  /**
   * A library function returned to an address that is not an instruction: `scanf`
   * stored a value over its own return address.
   */
  | { reason: 'library-return'; name: LibraryFunctionName; value: bigint }
  /** Anything else: rip holds an address where no instruction starts. */
  | { reason: 'other'; text: string; value: bigint }

export function badJump(line: number | null, detail: BadJumpDetail): RuntimeProblem {
  switch (detail.reason) {
    case 'ret':
      return make('bad-jump', line, [
        `${code('ret')} took ${hex(detail.value)} from the top of the stack and tried to jump there, but that is not an instruction.`,
        'The top of the stack did not hold a return address.',
        'Did you push something and forget to pop it?',
      ])
    case 'return-to-end':
      return make('bad-jump', line, [
        `${code('ret')} went back to ${hex(detail.value)}, the address after the ${code('call')} on line ${detail.callLine}, but there is no instruction there.`,
        `That ${code('call')} was the last instruction of the program.`,
        `Add an instruction after it, for example ${code('ret')}.`,
      ])
    case 'label-at-end':
      return make('bad-jump', line, [
        `${code(detail.text)} jumped to the label ${code(detail.name)}, but there is no instruction after that label.`,
        `Add an instruction after ${code(`${detail.name}:`)}, for example ${code('ret')}.`,
      ])
    case 'library-return':
      return make('bad-jump', line, [
        `${code(detail.name)} stored a value over its own return address on the stack, so it tried to return to ${hex(detail.value)}, but that is not an instruction.`,
        `Check the addresses you gave ${code(detail.name)}: each one must point at a variable.`,
      ])
    case 'other':
      return make('bad-jump', line, [
        `${code(detail.text)} left rip at ${hex(detail.value)}, but that is not an instruction.`,
        'The program can only run the instructions you wrote.',
      ])
  }
}

export type RanOffEndDetail =
  /**
   * The last instruction ran and nothing ended the program. `functionName` is the
   * function that the instruction belongs to, when the emulator can tell.
   */
  | { reason: 'last-instruction'; text: string; functionName: string | null }
  /** The program starts at a label that has no instruction after it. */
  | { reason: 'nothing-to-run'; label: string | null }

export function ranOffEnd(line: number | null, detail: RanOffEndDetail): RuntimeProblem {
  if (detail.reason === 'nothing-to-run') {
    return make('ran-off-end', line, [
      detail.label !== null
        ? `the label ${code(detail.label)} has no instruction after it, so the program has nothing to run.`
        : 'the program has no instruction to run.',
      detail.label !== null
        ? `Put the instructions of the program after ${code(`${detail.label}:`)}.`
        : 'Write at least one instruction.',
    ])
  }
  return make('ran-off-end', line, [
    `${code(detail.text)} was the last instruction, but the program did not end: it went past the end of the code.`,
    detail.functionName !== null
      ? `Add ${code('ret')} at the end of ${code(detail.functionName)}.`
      : `Add ${code('ret')} at the end of the program.`,
  ])
}

/* ─────────────────────────── Library functions ─────────────────────────── */

/** Where a library function found one of its values. */
export type ArgumentPlace = { kind: 'register'; name: string } | { kind: 'stack'; address: bigint }

function placeName(place: ArgumentPlace): string {
  return place.kind === 'register' ? place.name : `the stack box at ${hex(place.address)}`
}

/** The conversions each function understands, as shown in messages. */
const PRINTF_CONVERSIONS = ['%d', '%i', '%u', '%x', '%X', '%c', '%s', '%p', '%%']
const SCANF_CONVERSIONS = ['%d', '%i', '%u', '%x', '%c', '%s']

/** The widest `%5d`-style width the emulator prints. */
export const MAX_FIELD_WIDTH = 1000

/** The most one library call may print. More is almost always a mistake (and slow to show). */
export const MAX_CALL_OUTPUT = 1 << 16

/** The most a program may print in all: past this, the program is stopped. */
export const MAX_TOTAL_OUTPUT = 1 << 20

export type LibraryErrorDetail =
  /** The text address in rdi is not readable text. */
  | {
      reason: 'text-address'
      name: 'printf' | 'puts' | 'scanf'
      value: bigint
      /**
       * Set when rdi holds the first `bytes` bytes stored at this label's text: `mov` was
       * used where `lea` was needed. `bytes` is null when the value does not show how many
       * bytes `mov` copied (a short text reads the same with 4 and with 8 bytes).
       */
      copiedFrom: { label: string; bytes: 4 | 8 | null } | null
      /** Set when rdi points into the code of the program (at an instruction, or not). */
      pointsAtCode: CodePlace
    }
  /**
   * The text starts in the program's memory but has no 0 byte at its end: it runs into
   * memory the program does not own, at `at`.
   */
  | { reason: 'text-runs-off'; name: 'printf' | 'puts' | 'scanf'; start: bigint; at: bigint }
  /** `%s` got a value that is not the address of readable text. */
  | {
      reason: 'string-argument'
      name: 'printf'
      place: ArgumentPlace
      value: bigint
      /** Set when the value points into the code of the program (at an instruction, or not). */
      pointsAtCode: CodePlace
    }
  /** `%f` and other conversions the emulator does not have. */
  | { reason: 'unknown-conversion'; name: 'printf' | 'scanf'; conversion: string }
  /** A `%` at the very end of the text, with no letter after it. */
  | { reason: 'lone-percent'; name: 'printf' | 'scanf' }
  /** `%5000d` */
  | { reason: 'width'; name: 'printf'; conversion: string }
  /** scanf was given something that is not the address of writable memory. */
  | { reason: 'destination'; place: ArgumentPlace; value: bigint; conversion: string }
  /** scanf read a word that does not fit in the writable memory at its address. */
  | { reason: 'word-room'; word: string; needed: number; room: number; address: bigint }
  /** A value that should be on the stack is outside the program's memory. */
  | { reason: 'stack-argument'; name: 'printf' | 'scanf'; address: bigint }
  /**
   * One call would print more than `MAX_CALL_OUTPUT` characters (counted the way
   * `snapshot.output` counts them). Nothing was printed: the step is atomic.
   */
  | { reason: 'call-output'; name: 'printf' | 'puts' | 'putchar' }
  /**
   * This call wanted to print `count` characters, and with them the program's output would
   * be longer than `MAX_TOTAL_OUTPUT` characters. (Nothing was printed: the step is atomic.)
   */
  | { reason: 'total-output'; name: 'printf' | 'puts' | 'putchar'; count: number }

function textAddressError(
  line: number,
  detail: Extract<LibraryErrorDetail, { reason: 'text-address' }>,
): RuntimeProblem {
  const name = code(detail.name)
  const value = hex(detail.value)
  const scanf = detail.name === 'scanf'
  const what = scanf ? `its format text (like ${code('"%d"')})` : 'its text'
  const example = code(scanf ? 'lea rdi, pattern[rip]' : 'lea rdi, message[rip]')
  const needs = `${name} needs the ADDRESS of ${what} in rdi`
  if (detail.copiedFrom !== null) {
    const { label, bytes } = detail.copiedFrom
    const which = bytes === null ? 'the first bytes' : `the ${bytes} bytes`
    return make('library-error', line, [
      `${needs}, but rdi holds ${value}: ${which} stored at ${code(label)}.`,
      `${code('mov')} copied those bytes into rdi, not the address of ${code(label)}.`,
      `To put the address in rdi, write ${code(`lea rdi, ${label}[rip]`)}.`,
    ])
  }
  if (detail.pointsAtCode !== null) {
    return make('library-error', line, [
      `${needs}, but rdi holds ${value}, ${codePlaceWords(detail.pointsAtCode)}.`,
      `Point rdi at a ${code('.string')} label, for example ${example}.`,
    ])
  }
  return make('library-error', line, [
    `${needs}, but rdi holds ${value}, and your program does not own that address.`,
    `Load the address with ${code('lea')}, for example ${example}.`,
  ])
}

export function libraryError(line: number, detail: LibraryErrorDetail): RuntimeProblem {
  switch (detail.reason) {
    case 'text-address':
      return textAddressError(line, detail)
    case 'text-runs-off':
      return make('library-error', line, [
        `${code(detail.name)} read the text at ${hex(detail.start)}, but the text has no 0 byte at its end: it runs into memory your program does not own, at ${hex(detail.at)}.`,
        `Write the text with ${code('.string')}: it adds the 0 byte.`,
      ])
    case 'string-argument':
      return make('library-error', line, [
        detail.pointsAtCode !== null
          ? `${code(detail.name)} found ${code('%s')} in its text, so it needs the ADDRESS of some text, but ${placeName(detail.place)} holds ${hex(detail.value)}, ${codePlaceWords(detail.pointsAtCode)}.`
          : `${code(detail.name)} found ${code('%s')} in its text, so it needs the ADDRESS of some text, but ${placeName(detail.place)} holds ${hex(detail.value)}, and your program does not own that address.`,
        `To print a number, use ${code('%d')}.`,
        `To print text, load its address with ${code('lea')}.`,
      ])
    case 'unknown-conversion': {
      const known = detail.name === 'printf' ? PRINTF_CONVERSIONS : SCANF_CONVERSIONS
      return make('library-error', line, [
        `${code(detail.name)} in this emulator does not know ${code(detail.conversion)}.`,
        `It knows ${andList(known)}.`,
        `You can also put ${orList(['l', 'll', 'h', 'hh'])} before the letter, for example ${code('%ld')}.`,
      ])
    }
    case 'lone-percent':
      return detail.name === 'printf'
        ? make('library-error', line, [
            `the text of ${code('printf')} ends with a ${code('%')} that has no letter after it.`,
            `To print a percent sign, write ${code('%%')}.`,
          ])
        : make('library-error', line, [
            `the format text of ${code('scanf')} ends with a ${code('%')} that has no letter after it.`,
            `Put a letter after it, like ${code('%d')}.`,
          ])
    case 'width':
      return make('library-error', line, [
        `${code(detail.conversion)} asks ${code(detail.name)} for more characters than this emulator prints for one value.`,
        `Use a width of ${MAX_FIELD_WIDTH} or less.`,
      ])
    case 'destination': {
      const register = detail.place.kind === 'register' ? detail.place.name : 'rsi'
      return make('library-error', line, [
        `${code('scanf')} needs the ADDRESS of a variable for ${code(detail.conversion)}, but ${placeName(detail.place)} holds ${hex(detail.value)}, and your program cannot write to that address.`,
        `${code('scanf')} stores the value it reads at that address.`,
        `Load the address of a variable with ${code('lea')}, for example ${code(`lea ${register}, -8[rbp]`)}.`,
      ])
    }
    case 'word-room':
      return make('library-error', line, [
        `${code('scanf')} read the word ${code(detail.word)}, which needs ${detail.needed} bytes with the 0 byte at its end, but your program can write only ${detail.room} bytes at ${hex(detail.address)}.`,
        `Type a shorter word, or give ${code('scanf')} the address of a bigger buffer.`,
      ])
    case 'stack-argument':
      return make('library-error', line, [
        `${code(detail.name)} looked for one of its values in the stack box at ${hex(detail.address)}, but your program does not own that address.`,
        `Check that the text has one ${code('%')} item for each value you pass.`,
      ])
    case 'call-output':
      return make('library-error', line, [
        `${code(detail.name)} tried to print more than ${groupDigits(MAX_CALL_OUTPUT)} characters in one call.`,
        'This emulator stops a program there.',
        'Print less text in each call.',
      ])
    case 'total-output': {
      // The call printed nothing: say what it tried to do, not what the program has printed.
      const characters = `${groupDigits(detail.count)} ${detail.count === 1 ? 'character' : 'characters'}`
      return make('library-error', line, [
        `${code(detail.name)} tried to print ${characters}, but that would make the program's output longer than ${groupDigits(MAX_TOTAL_OUTPUT)} characters.`,
        'So this emulator stopped the program.',
        'Check for a loop that prints and never ends.',
      ])
    }
  }
}

/* ───────────────────────────── The emulator itself ───────────────────────────── */

/** A bug in the emulator must never crash the page: it becomes this message. */
export function internalProblem(line: number | null): RuntimeProblem {
  return make('internal', line, [
    'the emulator hit an internal problem and stopped the program.',
    'This is a mistake in the emulator, not in your program.',
    'You can step back, or reset the program.',
  ])
}
