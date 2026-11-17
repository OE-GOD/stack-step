/**
 * The words: the plain-English explanation of every step, the tips and warnings, the
 * labels of the stack boxes, and the short messages of `run()`.
 *
 * The executor and the library functions collect FACTS (which values were read, which
 * address was calculated, where rsp went). This file turns the facts into sentences.
 * The messages for run-time errors are in `runtimeErrors.ts`.
 *
 * Writing rules (see PLAN.md):
 * - Short sentences, common words, one idea per sentence. An explanation has one to
 *   three sentences, and it starts with the instruction text in backticks (a library
 *   step starts with the function name in backticks and "(library code)").
 * - The same word for the same thing every time: a BOX is 8 bytes of stack, the TOP BOX
 *   is the box where rsp points (the top of the stack), `mov` COPIES, rsp GOES DOWN BY 8
 *   and GOES UP BY 8.
 * - Numbers are in hex with `0x`. Values from 10 to 99 999 also show their decimal value:
 *   `0x37 (55)`. A value that reads as a small negative number shows that: `0xffffffff
 *   (-1)`. An 8- or 16-bit value with its top bit set shows both readings: `0xff (255 or
 *   -1)`, so that signed arithmetic can be followed.
 * - Stack addresses and code addresses (rsp, rbp, return addresses, calculated addresses)
 *   are shortened to their last four digits (`0x…dff0`). Numbers the student typed, and
 *   the value `main` returns, are always written in full.
 */
import { describeCondition, type JumpCondition } from './alu'
import { toSigned } from './bits'
import type {
  AddressFacts,
  ArithmeticOp,
  DestinationFacts,
  FlagsWriter,
  FoundInput,
  InstructionFacts,
  LibraryFacts,
  NoteFacts,
  OperandFacts,
  ReturnFacts,
  ScanItem,
  ScanKind,
  StackLabelFacts,
  StepFacts,
  TargetFacts,
} from './executor'
import { groupDigits, hex, hex64, joinAnd, shortAddress } from './format'
import type { MissingValue } from './libc'
import { lookupRegister } from './registers'
import type { RuntimeProblem } from './runtimeErrors'
import {
  FLAG_NAMES,
  type FlagName,
  type Flags,
  type LibraryFunctionName,
  type OperandSize,
  type RegisterInfo,
  type RunStopReason,
  type StepNote,
} from './types'

/* ───────────────────────────── Numbers and names ───────────────────────────── */

/** What the explanations need to know about the memory layout. */
export interface ExplainContext {
  /** The stack region is [stackStart, stackEnd). */
  stackStart: bigint
  stackEnd: bigint
  /** The code of the program is [textBase, textEnd). */
  textBase: bigint
  textEnd: bigint
  /**
   * True for the shorter form of an explanation that is too long to read well: an address
   * sum is shown without the values of its registers (the result is still there).
   */
  compact?: boolean
}

/** An explanation has at most this many sentences. */
export const MAX_SENTENCES = 3

/**
 * One sentence of an explanation. A plain string always stays as it is. When there is
 * not room for every sentence (an explanation has at most MAX_SENTENCES, and the step
 * that stops the program must also say so), `joinExplanation` first leaves out an
 * 'extra' sentence (it helps, but the step is clear without it), then joins a 'tail'
 * sentence to the sentence before it with a semicolon, so its facts stay.
 */
export type Sentence = string | { text: string; fit: 'extra' | 'tail' }

/** A sentence that may be left out when there is no room for it. */
function extra(text: string): Sentence {
  return { text, fit: 'extra' }
}

/** A sentence that may be joined to the sentence before it (the flags after a result). */
function tail(text: string): Sentence {
  return { text, fit: 'tail' }
}

function sentenceText(sentence: Sentence): string {
  return typeof sentence === 'string' ? sentence : sentence.text
}

/** Student text longer than this is cut short (with "…") when an explanation repeats it. */
const TYPED_LIMIT = 40

/** Code in backticks. A backtick inside the code would end the code font early. */
function quote(text: string): string {
  return '`' + text.replaceAll('`', "'") + '`'
}

/** Text the student typed, in backticks, cut short when it is long. */
function quoteTyped(text: string): string {
  const characters = [...text].map((character) => {
    const point = character.codePointAt(0) ?? 0
    return point < 0x20 || point === 0x7f ? ' ' : character
  })
  const shown =
    characters.length > TYPED_LIMIT
      ? `${characters.slice(0, TYPED_LIMIT).join('')}…`
      : characters.join('')
  return quote(shown)
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "a", "a and b", "a, b and c". */
const andList = joinAnd

/**
 * A list that names at most three items, then says how many more there are:
 * "1, 2, 3 and 4 more". A list of four or fewer is named in full.
 */
function someOf(items: readonly string[]): string {
  if (items.length <= 4) return andList(items)
  return `${items.slice(0, 3).join(', ')} and ${items.length - 3} more`
}

/** True when the top bit of a `size`-bit value is 1. */
function topBitSet(value: bigint, size: OperandSize): boolean {
  return value >= 0n && value < 1n << BigInt(size) && value >> BigInt(size - 1) === 1n
}

/**
 * A value in the house style: hex, plus the decimal value when that helps.
 * describeNumber(55n) → '0x37 (55)'; describeNumber(0xffffffffn, 32) → '0xffffffff (-1)';
 * describeNumber(0xffn, 8) → '0xff (255 or -1)'.
 */
export function describeNumber(value: bigint, size: OperandSize = 64): string {
  const text = hex(value)
  // 8 and 16 bits: both readings, so that `127 − 128` and signed overflow make sense.
  if ((size === 8 || size === 16) && topBitSet(value, size)) {
    return `${text} (${value} or ${toSigned(value, size)})`
  }
  if (value >= 10n && value <= 99_999n) return `${text} (${value})`
  const signed = toSigned(value, size)
  if (signed < 0n && signed >= -99_999n) return `${text} (${signed})`
  return text
}

/** A value read as a signed number only (for `movsx`): '0x80 (-128)'. */
function describeSigned(value: bigint, size: OperandSize): string {
  const signed = toSigned(value, size)
  const shown = (signed >= 10n && signed <= 99_999n) || (signed < 0n && signed >= -99_999n)
  return shown ? `${hex(value)} (${signed})` : hex(value)
}

/** A value read as an unsigned number only (for `movzx`): '0x80 (128)'. */
function describeUnsigned(value: bigint): string {
  return value >= 10n && value <= 99_999n ? `${hex(value)} (${value})` : hex(value)
}

/** Is this value an address inside the stack or inside the code? */
function isStackOrCode(value: bigint, context: ExplainContext): boolean {
  const inStack = value >= context.stackStart && value < context.stackEnd
  // A return address may be the address right after the last instruction.
  const inCode = value >= context.textBase && value <= context.textEnd
  return inStack || inCode
}

/** A value that may be an address: long stack and code addresses are shortened. */
function describeValue(value: bigint, size: OperandSize, context: ExplainContext): string {
  if (value > 0xffffn && isStackOrCode(value, context)) return shortAddress(value)
  return describeNumber(value, size)
}

/** The same without the decimal value, for the second time a number is named. */
function describePlainValue(value: bigint, context: ExplainContext): string {
  return value > 0xffffn && isStackOrCode(value, context) ? shortAddress(value) : hex(value)
}

/** An address that was calculated: short for the stack and the code, else in full. */
function describePlace(address: bigint, context: ExplainContext): string {
  return isStackOrCode(address, context) ? shortAddress(address) : hex(address)
}

/** "rsp went down by 8 (0x…dff8 → 0x…dff0)" */
function rspWent(
  direction: 'down' | 'up',
  before: bigint,
  after: bigint,
  context: ExplainContext,
): string {
  return `rsp went ${direction} by 8 (${describePlace(before, context)} → ${describePlace(after, context)})`
}

/** "1 byte", "8 bytes". */
function bytesText(bytes: number): string {
  return bytes === 1 ? '1 byte' : `${bytes} bytes`
}

/** "the 8 bytes", "the byte". */
function theBytes(bytes: number): string {
  return bytes === 1 ? 'the byte' : `the ${bytes} bytes`
}

/** "The 8 bytes stored there" / "The byte stored there". */
function storedThere(bytes: number): string {
  return `${capitalize(theBytes(bytes))} stored there`
}

/** "were" for several bytes, "was" for one. */
function wereOrWas(bytes: number): string {
  return bytes === 1 ? 'was' : 'were'
}

/** "CF=0, ZF=1": the named flags and their values. */
function flagList(flags: Flags, names: readonly FlagName[]): string {
  return names.map((name) => `${name}=${flags[name]}`).join(', ')
}

/** "(line 12)" when the address is an instruction, else the address itself. */
function whereIs(target: TargetFacts, context: ExplainContext): string {
  return target.line !== null
    ? `(line ${target.line})`
    : `(${describePlace(target.address, context)})`
}

/** `'A'`, `'\n'`: a character written in single quotes. */
function isCharacterText(text: string): boolean {
  return /^'(?:[^'\\]|\\.)+'$/.test(text)
}

/** An operand as a word in a sentence: a register or a number bare, anything else as code. */
function operandWord(text: string): string {
  const plain = lookupRegister(text) !== undefined || /^-?(?:0x[0-9a-f]+|\d+)$/i.test(text)
  return plain ? text : quote(text)
}

/* ───────────────────────── Parts of a register ───────────────────────── */

/** "the lowest 8 bits of rax", "bits 8 to 15 of rax". Null for a whole 64-bit register. */
function partOfRegister(register: RegisterInfo): string | null {
  if (register.size === 64) return null
  if (register.highByte) return `bits 8 to 15 of ${register.base}`
  return `the lowest ${register.size} bits of ${register.base}`
}

/** A register as a destination: "al, the lowest 8 bits of rax" for the small names. */
function destinationName(register: RegisterInfo): string {
  const part = register.size === 8 || register.size === 16 ? partOfRegister(register) : null
  return part === null ? register.name : `${register.name}, ${part}`
}

/** True when a 32-bit write set a top half that was not 0 to 0. */
function clearedTopHalf(destination: DestinationFacts): boolean {
  return (
    destination.kind === 'reg' && destination.reg.size === 32 && destination.before >> 32n !== 0n
  )
}

/**
 * What a write did to the rest of the register: the #1 thing beginners get wrong.
 * Null when there is nothing to say (a 64-bit write, or a 32-bit write over a top half
 * that was 0 already).
 */
function restOfRegister(destination: DestinationFacts): string | null {
  if (destination.kind !== 'reg') return null
  const { reg, before, after } = destination
  if (reg.size === 32) {
    if (!clearedTopHalf(destination)) return null
    return `Writing ${reg.name} also sets the top 32 bits of ${reg.base} to 0, so ${reg.base} went from ${hex64(before)} to ${hex64(after)}.`
  }
  if (reg.size === 64) return null
  return `The other bits did not change: ${reg.base} = ${hex64(after)}.`
}

/* ─────────────────────────── Memory addresses ─────────────────────────── */

/** A displacement as a positive number: 8 stays "8", 16 becomes "0x10 (16)". */
function describeOffset(amount: bigint): string {
  return amount < 10n ? amount.toString() : describeNumber(amount)
}

/** Join the terms of a sum: ["rbp", "-8"] is written "rbp − 8". */
function joinTerms(terms: readonly { text: string; negative: boolean }[]): string {
  return terms
    .map((term, position) => {
      if (position === 0) return term.negative ? `−${term.text}` : term.text
      return term.negative ? `− ${term.text}` : `+ ${term.text}`
    })
    .join(' ')
}

/** How an address was calculated, in two shapes for two kinds of sentence. */
interface AddressWords {
  /** After "the address": "rbp − 8 = 0x…dfe8", or "of `message`, 0x402010," … */
  noun: string
  /** A whole clause: "the address is rbp − 8 = 0x…dfe8". */
  clause: string
}

function describeAddress(access: AddressFacts, context: ExplainContext): AddressWords {
  const { operand, base, index, constants } = access
  const result = describePlace(access.address, context)
  const registerTerms: { text: string; negative: boolean }[] = []
  if (base !== null) registerTerms.push({ text: base.name, negative: false })
  if (index !== null) {
    const text = index.scale === 1 ? index.name : `${index.name}×${index.scale}`
    registerTerms.push({ text, negative: false })
  }

  // The simple shapes read better as words than as a sum.
  if (registerTerms.length === 0 && operand.symbol !== null && operand.disp === 0n) {
    const name = quote(operand.symbol)
    return { noun: `of ${name}, ${result},`, clause: `the address of ${name} is ${result}` }
  }
  if (registerTerms.length === 0 && operand.symbol === null) {
    return { noun: result, clause: `the address is ${result}` }
  }
  if (base !== null && index === null && operand.symbol === null && operand.disp === 0n) {
    return {
      noun: `in ${base.name}, ${result},`,
      clause: `the address is the value of ${base.name}, ${result}`,
    }
  }

  const terms: { text: string; negative: boolean }[] = []
  if (operand.symbol !== null) {
    // In the compact form the label is only its address: its name is in the instruction.
    terms.push({
      text:
        context.compact === true
          ? hex(operand.symbolAddress)
          : `${quote(operand.symbol)} (${hex(operand.symbolAddress)})`,
      negative: false,
    })
  }
  terms.push(...registerTerms)
  const numbers = [...terms]
  const offset =
    operand.disp === 0n
      ? null
      : {
          text: describeOffset(operand.disp < 0n ? -operand.disp : operand.disp),
          negative: operand.disp < 0n,
        }
  if (offset !== null) numbers.push(offset)
  let sum = joinTerms(numbers)

  // With an index register the sum is shown with its numbers too: that arithmetic is
  // the lesson of array indexing (`array + rcx×8 = 0x404038 + 0x2×8`).
  if (index !== null && context.compact !== true) {
    const values: { text: string; negative: boolean }[] = []
    if (operand.symbol !== null) values.push({ text: hex(operand.symbolAddress), negative: false })
    if (base !== null) values.push({ text: describePlace(base.value, context), negative: false })
    const scaled = index.scale === 1 ? hex(index.value) : `${hex(index.value)}×${index.scale}`
    values.push({ text: scaled, negative: false })
    if (offset !== null) values.push(offset)
    sum = `${sum} = ${joinTerms(values)}`
  }

  // `count[rbp]`: show the name first, then what it stands for.
  const total = constants.reduce((value, constant) => value + constant.value, 0n)
  if (constants.length > 0 && total === operand.disp) {
    const names = constants.map((constant) => ({ text: constant.name, negative: false }))
    const named = joinTerms([...terms, ...names])
    return {
      noun: `${named} = ${sum} = ${result}`,
      clause: `the address is ${named} = ${sum} = ${result}`,
    }
  }
  return { noun: `${sum} = ${result}`, clause: `the address is ${sum} = ${result}` }
}

/* ───────────────────────────── Each instruction ───────────────────────────── */

/** A value that an instruction copies, worded for two places in a sentence. */
interface SourceWords {
  /** After a verb: "copied RBX'S VALUE 0x5 into rax", "copied 0x7 into eax". */
  inline: string
  /** As the subject: "THE VALUE OF RBX, 0x5, was copied", "THE VALUE 0x7 was copied". */
  subject: string
}

/** "the value of `LIMIT`", "the address of `msg`", "the character code of `'A'`", or null. */
function immediateOrigin(
  operand: Extract<OperandFacts, { kind: 'imm' }>['operand'],
): string | null {
  const { symbol, text } = operand
  if (symbol !== null) {
    // `offset message` is the address of a label. A bare name is an `.equ` constant.
    const what = /^offset\b/i.test(text) ? 'address' : 'value'
    return `the ${what} of ${quote(symbol)}`
  }
  return isCharacterText(text) ? `the character code of ${quote(text)}` : null
}

function describeSource(
  source: OperandFacts,
  size: OperandSize,
  context: ExplainContext,
): SourceWords {
  switch (source.kind) {
    case 'reg': {
      const value = describeValue(source.value, size, context)
      return {
        inline: `${source.reg.name}'s value ${value}`,
        subject: `the value of ${source.reg.name}, ${value},`,
      }
    }
    case 'imm': {
      // A number the student typed is written in full, even when it looks like an address.
      const value = describeNumber(source.value, size)
      const origin = immediateOrigin(source.operand)
      if (origin === null) return { inline: value, subject: `the value ${value}` }
      return { inline: `${value}, ${origin},`, subject: `${origin}, ${value},` }
    }
    case 'mem': {
      const value = describeValue(source.value, size, context)
      return { inline: value, subject: `the value ${value}` }
    }
  }
}

function explainMove(
  facts: Extract<InstructionFacts, { kind: 'mov' }>,
  context: ExplainContext,
): Sentence[] {
  const { mnemonic, source, sourceSize, destination, size, value } = facts
  const sentences: Sentence[] = []

  if (destination.kind === 'mem') {
    // Only `mov` can store to memory.
    const what = describeSource(source, sourceSize, context)
    sentences.push(`${describeAddress(destination.access, context).clause}.`)
    sentences.push(
      `${capitalize(what.subject)} was copied into ${theBytes(destination.bytes)} at that address.`,
    )
    return sentences
  }

  const name = destinationName(destination.reg)
  const short = destination.reg.name
  if (mnemonic === 'mov') {
    const what = describeSource(source, sourceSize, context)
    if (source.kind === 'mem') {
      sentences.push(`${describeAddress(source.access, context).clause}.`)
      sentences.push(
        `${storedThere(source.bytes)}, ${what.inline}, ${wereOrWas(source.bytes)} copied into ${name}.`,
      )
    } else {
      sentences.push(`copied ${what.inline} into ${name}.`)
    }
  } else {
    // movsx keeps the signed value, movzx the unsigned one: the decimals show that.
    const signed = mnemonic === 'movsx'
    const from = signed ? describeSigned(source.value, sourceSize) : describeUnsigned(source.value)
    const result = signed ? describeSigned(value, size) : describeUnsigned(value)
    const topBit = (source.value >> BigInt(sourceSize - 1)) & 1n
    if (source.kind === 'mem') {
      const owner = source.bytes === 1 ? 'its' : 'their'
      const fill = signed ? `copies of ${owner} top bit (${topBit})` : '0'
      sentences.push(`${describeAddress(source.access, context).clause}.`)
      sentences.push(
        `${storedThere(source.bytes)}, ${from}, ${wereOrWas(source.bytes)} copied into ${short}, and the upper bits were filled with ${fill}, so ${short} = ${result}.`,
      )
    } else {
      const fill = signed ? `copies of its top bit (${topBit})` : '0'
      const what = source.kind === 'reg' ? `${source.reg.name}'s value ${from}` : from
      sentences.push(
        `copied ${what} into ${short} and filled the upper bits with ${fill}, so ${short} = ${result}.`,
      )
    }
  }

  // What the write did to the rest of the register follows from the copy just before it.
  const rest = restOfRegister(destination)
  if (rest !== null) sentences.push(tail(rest))
  return sentences
}

function explainLea(
  facts: Extract<InstructionFacts, { kind: 'lea' }>,
  context: ExplainContext,
): Sentence[] {
  const { access, destination, size, value } = facts
  const name = destination.reg.name
  const words = describeAddress(access, context)
  const put =
    size === 64
      ? `put that address in ${name}`
      : `put its low ${size} bits, ${describeValue(value, size, context)}, in ${name}`
  const sentences: Sentence[] = [
    `calculated the address ${words.noun} and ${put}.`,
    tail(`${quote('lea')} does not read memory.`),
  ]
  const rest = restOfRegister(destination)
  if (rest !== null) sentences.push(tail(rest))
  return sentences
}

function explainPush(
  facts: Extract<InstructionFacts, { kind: 'push' }>,
  context: ExplainContext,
): string[] {
  const { source, value, rspBefore, rspAfter } = facts
  const went = rspWent('down', rspBefore, rspAfter, context)
  const words = describeSource(source, 64, context)
  let what: string
  if (source.kind === 'reg' && source.reg.base === 'rsp') {
    // `push rsp` stores the value rsp had BEFORE it went down.
    what = `the old value of rsp, ${describePlace(value, context)},`
  } else {
    what = source.kind === 'reg' ? words.inline : words.subject
  }
  return [`${went}, then ${what} was copied into the new top box.`]
}

function explainPop(
  facts: Extract<InstructionFacts, { kind: 'pop' }>,
  context: ExplainContext,
): string[] {
  const { register, value, rspBefore, rspAfter } = facts
  const shown = describeValue(value, 64, context)
  if (register.base === 'rsp') {
    return [
      `the value in the top box, ${shown}, was copied into rsp (rsp was ${describePlace(rspBefore, context)}).`,
      `Because the value went into rsp itself, rsp did not also go up by 8.`,
    ]
  }
  return [
    `the value in the top box, ${shown}, was copied into ${register.name}, then ${rspWent('up', rspBefore, rspAfter, context)}.`,
    `The old box still holds ${shown}, but it is not part of the stack any more.`,
  ]
}

const OPERATOR: Readonly<Record<ArithmeticOp | 'cmp' | 'test', string>> = {
  add: '+',
  sub: '−',
  imul: '×',
  and: 'AND',
  or: 'OR',
  xor: 'XOR',
  inc: '+',
  dec: '−',
  cmp: '−',
  test: 'AND',
}

/** The memory operand among the operands of an instruction, if there is one. */
function memoryOperand(
  operands: readonly (OperandFacts | null)[],
): Extract<OperandFacts, { kind: 'mem' }> | null {
  for (const operand of operands) {
    if (operand !== null && operand.kind === 'mem') return operand
  }
  return null
}

/** "the address is rbp − 8 = 0x…dfe8, and the 4 bytes stored there hold 0xa (10)." */
function addressAndContents(
  operand: Extract<OperandFacts, { kind: 'mem' }>,
  size: OperandSize,
  context: ExplainContext,
): string {
  const holds = operand.bytes === 1 ? 'holds' : 'hold'
  return `${describeAddress(operand.access, context).clause}, and ${theBytes(operand.bytes)} stored there ${holds} ${describeValue(operand.value, size, context)}.`
}

/** The value of an operand of arithmetic: a typed number in full, a register or memory value maybe short. */
function operandValue(
  operand: OperandFacts,
  value: bigint,
  size: OperandSize,
  context: ExplainContext,
): string {
  return operand.kind === 'imm' ? describeNumber(value, size) : describeValue(value, size, context)
}

function explainArithmetic(
  facts: Extract<InstructionFacts, { kind: 'arithmetic' }>,
  context: ExplainContext,
): Sentence[] {
  const { op, size, a, b, result, first, second, destination, flags, flagsWritten } = facts
  const sentences: Sentence[] = []
  const memory = memoryOperand([first, second])
  if (memory !== null) sentences.push(addressAndContents(memory, size, context))

  const unary = op === 'inc' || op === 'dec'
  const left = operandValue(first, a, size, context)
  const right = second === null ? '1' : operandValue(second, b, size, context)
  const answer = describeValue(result, size, context)
  const sameRegister =
    second !== null &&
    first.kind === 'reg' &&
    second.kind === 'reg' &&
    first.reg.name === second.reg.name
  const xorItself = op === 'xor' && sameRegister
  const cleared = clearedTopHalf(destination)
  let where: string
  if (destination.kind === 'reg') {
    where = destination.reg.name
    // The 32-bit rule, said where the result is stored (the `xor` remark says it itself).
    if (cleared && !xorItself)
      where += `, and the top 32 bits of ${destination.reg.base} were set to 0`
  } else {
    where = destination.bytes === 1 ? 'that byte' : `those ${destination.bytes} bytes`
  }
  sentences.push(`${left} ${OPERATOR[op]} ${right} = ${answer}, stored in ${where}.`)

  if (op === 'imul') {
    // ZF and SF after `imul` are this emulator's choice: a real CPU does not define them.
    sentences.push(
      tail(
        `Flags: CF=${flags.CF}, OF=${flags.OF} (this emulator also set ZF=${flags.ZF} and SF=${flags.SF}; on a real CPU, they are not defined after ${quote('imul')}).`,
      ),
    )
  } else {
    const list = flagList(flags, flagsWritten)
    sentences.push(tail(unary ? `Flags: ${list}; CF is not changed.` : `Flags: ${list}.`))
  }

  // One more remark, left out when there is no room for it. The `xor` remark stays when
  // it is the sentence that says the top 32 bits became 0.
  if (xorItself && destination.kind === 'reg') {
    const { name, base } = destination.reg
    sentences.push(
      cleared
        ? `A value XOR itself is always 0, and writing ${name} also sets the top 32 bits of ${base} to 0, so all of ${base} is 0 now.`
        : extra(`A value XOR itself is always 0, so this is a short way to put 0 in ${name}.`),
    )
  } else if (op === 'imul' && flags.OF === 1) {
    sentences.push(
      extra(
        `As a signed number, the full answer is too big for ${size} bits, so only its low ${size} bits were kept.`,
      ),
    )
  }
  return sentences
}

/** A compared value, with the name of the constant or the character it came from. */
function comparedValue(
  operand: OperandFacts,
  value: bigint,
  size: OperandSize,
  context: ExplainContext,
): string {
  if (operand.kind !== 'imm') return describeValue(value, size, context)
  const origin = immediateOrigin(operand.operand)
  const number = describeNumber(value, size)
  return origin === null ? number : `${number}, ${origin},`
}

function explainCompare(
  facts: Extract<InstructionFacts, { kind: 'compare' }>,
  context: ExplainContext,
): Sentence[] {
  const { op, size, a, b, result, first, second, flags } = facts
  const sentences: Sentence[] = []
  const memory = memoryOperand([first, second])
  if (memory !== null) sentences.push(addressAndContents(memory, size, context))

  const left = comparedValue(first, a, size, context)
  const right = comparedValue(second, b, size, context)
  const answer = describeValue(result, size, context)
  const plain = (operand: OperandFacts, value: bigint): string =>
    operand.kind === 'imm' ? hex(value) : describePlainValue(value, context)
  const main =
    op === 'cmp'
      ? `compared ${left} with ${right} by computing ${plain(first, a)} − ${plain(second, b)} = ${answer}, without storing the result.`
      : `computed ${left} AND ${right} = ${answer} to set the flags, without storing the result.`
  sentences.push(memory === null ? main : capitalize(main))
  sentences.push(tail(`Flags: ${flagList(flags, FLAG_NAMES)}.`))
  return sentences
}

/** The rule of a conditional jump as the explanations write it: "ZF=0 and SF=OF". */
function conditionRule(rule: string): string {
  return rule.replaceAll(' = ', '=').replaceAll(' ≠ ', '≠')
}

/** What a jump compares after `cmp a, b`: the sign between a and b, and how they are read. */
const RELATION: Readonly<
  Record<JumpCondition, { sign: string; reading: 'equal' | 'signed' | 'unsigned' } | null>
> = {
  je: { sign: '=', reading: 'equal' },
  jne: { sign: '≠', reading: 'equal' },
  jg: { sign: '>', reading: 'signed' },
  jge: { sign: '≥', reading: 'signed' },
  jl: { sign: '<', reading: 'signed' },
  jle: { sign: '≤', reading: 'signed' },
  ja: { sign: '>', reading: 'unsigned' },
  jae: { sign: '≥', reading: 'unsigned' },
  jb: { sign: '<', reading: 'unsigned' },
  jbe: { sign: '≤', reading: 'unsigned' },
  js: null,
  jns: null,
  jo: null,
  jno: null,
}

/** For the jumps that look at one result: what their flag means. */
const RESULT_MEANING: Readonly<Partial<Record<JumpCondition, string>>> = {
  js: 'This means the result was negative (its top bit is 1).',
  jns: 'This means the result was not negative (its top bit is 0).',
  jo: 'This means the result did not fit as a signed number.',
  jno: 'This means the result fit as a signed number.',
}

const READING: Readonly<Record<'signed' | 'unsigned', string>> = {
  signed: ', for signed numbers (numbers that can be negative)',
  unsigned: ', for unsigned numbers (numbers that are never negative)',
}

/**
 * The second sentence of a conditional jump: what its rule means. After `cmp` it uses the
 * two operands that were compared; after `test x, x`, the value that was tested.
 */
function conditionMeaning(condition: JumpCondition, writer: FlagsWriter | null): string {
  const relation = RELATION[condition]
  if (relation === null) return RESULT_MEANING[condition] ?? ''
  const zero = condition === 'je' ? '0' : 'not 0'
  if (writer?.kind === 'test' && relation.reading === 'equal') {
    const tested =
      writer.first === writer.second
        ? operandWord(writer.first)
        : `${operandWord(writer.first)} AND ${operandWord(writer.second)}`
    return `After ${quote(`test ${writer.first}, ${writer.second}`)}, this means ${tested} is ${zero}.`
  }
  const suffix = relation.reading === 'equal' ? '' : READING[relation.reading]
  if (writer?.kind === 'cmp') {
    const compared = `${operandWord(writer.first)} ${relation.sign} ${operandWord(writer.second)}`
    return `After ${quote(`cmp ${writer.first}, ${writer.second}`)}, this means ${compared}${suffix}.`
  }
  if (relation.reading === 'equal') {
    return `After ${quote('cmp a, b')}, this means a ${relation.sign} b; after other instructions, it means the result was ${zero}.`
  }
  return `After ${quote('cmp a, b')}, this means a ${relation.sign} b${suffix}.`
}

/**
 * What a jump checks, said with the line that set the flags: "after `cmp ecx, edx`, it
 * jumps when ecx > edx (as signed numbers)", or for `je`/`jne` after `test`, "after
 * `test eax, eax`, it jumps when eax is 0". Null when the flags came from something else.
 */
function comparisonFirst(condition: JumpCondition, writer: FlagsWriter | null): string | null {
  const relation = RELATION[condition]
  if (relation === null || writer === null) return null
  if (writer.kind === 'test' && relation.reading === 'equal') {
    const tested =
      writer.first === writer.second
        ? operandWord(writer.first)
        : `${operandWord(writer.first)} AND ${operandWord(writer.second)}`
    const zero = condition === 'je' ? '0' : 'not 0'
    return `after ${quote(`test ${writer.first}, ${writer.second}`)}, it jumps when ${tested} is ${zero}`
  }
  if (writer.kind !== 'cmp') return null
  const compared = `${operandWord(writer.first)} ${relation.sign} ${operandWord(writer.second)}`
  const reading = relation.reading === 'equal' ? '' : ` (as ${relation.reading} numbers)`
  return `after ${quote(`cmp ${writer.first}, ${writer.second}`)}, it jumps when ${compared}${reading}`
}

function explainConditionalJump(
  facts: Extract<InstructionFacts, { kind: 'jcc' }>,
  context: ExplainContext,
): Sentence[] {
  const { condition, written, flags, taken, target, nextLine, writer } = facts
  const { rule } = describeCondition(condition)
  const looked = FLAG_NAMES.filter((name) => rule.includes(name))
  const now = `Now ${flagList(flags, looked)}`
  let outcome: string
  if (taken) {
    outcome = `so it jumped to ${quote(target.name)} ${whereIs(target, context)}`
  } else if (nextLine !== null) {
    outcome = `so it did not jump, and the program continues at line ${nextLine}`
  } else {
    outcome = 'so it did not jump'
  }
  // A student reads this on every pass of a loop, so the comparison comes first, in the
  // words of the `cmp` (or `test`) before it; the flag rule follows. The rule, the flags
  // and the outcome are the facts: when the step must also say that the program stopped,
  // the rule is joined to the comparison.
  const comparison = comparisonFirst(condition, writer)
  if (comparison !== null) {
    return [
      `${comparison}.`,
      tail(`It checks this with the flags: ${conditionRule(rule)}.`),
      `${now}, ${outcome}.`,
    ]
  }
  // No compare to say it with: the flag rule first. What the rule means is left out when
  // the step must also say that the program stopped.
  return [
    `${quote(written)} jumps when ${conditionRule(rule)}.`,
    extra(conditionMeaning(condition, writer)),
    `${now}, ${outcome}.`,
  ]
}

function explainJump(
  facts: Extract<InstructionFacts, { kind: 'jmp' }>,
  context: ExplainContext,
): string[] {
  const { target } = facts
  const name = quote(target.name)
  const rip = describePlace(target.address, context)
  return target.line !== null
    ? [`the program jumped to ${name} (line ${target.line}), so rip = ${rip}.`]
    : [`the program jumped to ${name}, so rip = ${rip}.`]
}

function explainCall(
  facts: Extract<InstructionFacts, { kind: 'call' }>,
  context: ExplainContext,
): string[] {
  const { target, library, returnAddress, returnLine, rspBefore, rspAfter } = facts
  const went = rspWent('down', rspBefore, rspAfter, context)
  const next = returnLine === null ? '' : ` (line ${returnLine}, the next instruction)`
  return [
    `${went}, and the return address ${describePlace(returnAddress, context)}${next} was saved in the new top box.`,
    library !== null
      ? `Then the program jumped into the library function ${quote(library)}.`
      : `Then the program jumped to ${quote(target.name)} ${whereIs(target, context)}.`,
  ]
}

/** The value `main` returns: in full, with the exit code the shell sees when it is 0 … 255. */
function describeReturnValue(eax: bigint): string {
  return eax <= 255n ? `${hex(eax)} (exit code ${eax})` : describeNumber(eax, 32)
}

function explainRet(
  facts: Extract<InstructionFacts, { kind: 'ret' }>,
  context: ExplainContext,
): string[] {
  const { address, rspBefore, rspAfter, lands, line, saved, eax, entryLabel } = facts
  const went = rspWent('up', rspBefore, rspAfter, context)
  // Only a value that `call` saved is called a return address.
  const what = lands !== 'os' && !saved ? 'the value' : 'the return address'
  const popped = `${what} ${describePlace(address, context)} was popped from the top box into rip, and ${went}.`
  if (lands === 'os') {
    const returned = describeReturnValue(eax)
    return [
      popped,
      entryLabel !== null
        ? `This address goes back to the code that started ${quote(entryLabel)}, so the program ended.`
        : 'This address goes back to the code that started the program, so the program ended.',
      entryLabel !== null
        ? `${quote(entryLabel)} returned ${returned}, the value in eax.`
        : `The program returned ${returned}, the value in eax.`,
    ]
  }
  if (lands === 'instruction' && line !== null) {
    return [popped, `The program continues at line ${line}.`]
  }
  return [popped]
}

function explainLeave(
  facts: Extract<InstructionFacts, { kind: 'leave' }>,
  context: ExplainContext,
): string[] {
  const { rbp, value, rspBefore, rspAfter } = facts
  return [
    `first rbp's value, ${describePlace(rbp, context)}, was copied into rsp (rsp was ${describePlace(rspBefore, context)}).`,
    `Then the value in the top box, ${describeValue(value, 64, context)}, was copied into rbp, and ${rspWent('up', rbp, rspAfter, context)}.`,
  ]
}

function explainNop(facts: Extract<InstructionFacts, { kind: 'nop' }>): string[] {
  if (facts.written === 'endbr64') {
    // Only a gcc built with -fcf-protection writes it (the default on many Linux systems).
    return [
      'many Linux versions of gcc put this marker at the start of each function.',
      'It changes nothing here: only rip changed, to point to the next instruction.',
    ]
  }
  return ['this instruction changes nothing: only rip changed, to point to the next instruction.']
}

/* ───────────────────────────── Library functions ───────────────────────────── */

/** "printf (library code)": the `text` of a library step. */
export function libraryStepText(name: LibraryFunctionName): string {
  return `${name} (library code)`
}

/** "`printf` (library code)": how the explanation of a library step starts. */
function libraryHead(name: LibraryFunctionName): string {
  return `${quote(name)} (library code)`
}

function characters(count: number): string {
  return count === 1 ? '1 character' : `${count} characters`
}

/** "Then it returned to line 16: the return address 0x…1141 was popped into rip, and rsp went up by 8 (…)." */
function returnSentence(returned: ReturnFacts, context: ExplainContext): string {
  const address = describePlace(returned.address, context)
  const went = rspWent('up', returned.rspBefore, returned.rspAfter, context)
  const what = returned.changed ? 'the value' : 'the return address'
  const to = returned.line !== null ? ` to line ${returned.line}` : ''
  return `Then it returned${to}: ${what} ${address} was popped into rip, and ${went}.`
}

/** A character that `putchar` printed. */
function describeCharacter(code: number): string {
  if (code === 0x0a) return 'a new line'
  if (code === 0x20) return 'a space'
  if (code === 0x09) return 'a tab'
  if (code > 0x20 && code < 0x7f) return `the character ${quote(String.fromCharCode(code))}`
  return `the character with the code ${hex(BigInt(code))}`
}

/** A character that `scanf` read. */
function describeReadCharacter(code: number): string {
  return code === 0x0a ? 'the new-line character (from Enter)' : describeCharacter(code)
}

/** The decoded text of characters scanf read (bytes outside ASCII as they are). */
function charactersText(codes: readonly number[]): string {
  return String.fromCharCode(...codes)
}

/**
 * How a number was typed, when `%i` read it in another base: "(`%i` reads `010` as
 * octal, base 8)". Empty for plain numbers.
 */
function readAs(item: Extract<ScanItem, { kind: 'number' }>): string {
  if (item.conversion !== 'integer') return ''
  const digits = item.typed.replace(/^[+-]/, '')
  if (/^0x/i.test(digits)) return ` (${quote('%i')} reads ${quoteTyped(item.typed)} as hex)`
  if (digits.length > 1 && digits.startsWith('0')) {
    return ` (${quote('%i')} reads ${quoteTyped(item.typed)} as octal, base 8)`
  }
  return ''
}

/** A number scanf read, as a short phrase: "41", "the hex number `ff`". */
function typedNumber(item: Extract<ScanItem, { kind: 'number' }>): string {
  if (item.conversion === 'hex') return `the hex number ${quoteTyped(item.typed)}`
  return `the number ${item.value}${readAs(item)}`
}

/** The value as stored: "0x29 (41)". */
function storedNumber(item: Extract<ScanItem, { kind: 'number' }>): string {
  const bits = item.bytes * 8
  const size: OperandSize = bits === 8 || bits === 16 || bits === 32 ? bits : 64
  return describeNumber(BigInt.asUintN(bits, item.value), size)
}

/** One stored value, short, for a list: "the number 3", "the word `hi`". */
function scanItemName(item: ScanItem): string {
  switch (item.kind) {
    case 'number':
      return typedNumber(item)
    case 'character':
      return item.codes.length === 1
        ? describeReadCharacter(item.codes[0])
        : `${item.codes.length} characters, ${quoteTyped(charactersText(item.codes))}`
    case 'word':
      return `the word ${quoteTyped(item.text)}`
  }
}

/** "read the number 41 and stored it as 0x29 (41) in the 4 bytes at 0x…dfe8" */
function readOne(item: ScanItem, context: ExplainContext): string {
  const place = describePlace(item.address, context)
  switch (item.kind) {
    case 'number':
      return `read ${typedNumber(item)} and stored it as ${storedNumber(item)} in ${theBytes(item.bytes)} at ${place}`
    case 'character':
      return item.codes.length === 1
        ? `read ${describeReadCharacter(item.codes[0])} and stored it in the byte at ${place}`
        : `read ${scanItemName(item)}, and stored them in ${theBytes(item.bytes)} at ${place}`
    case 'word':
      return `read the word ${quoteTyped(item.text)} and stored it in ${theBytes(item.bytes)} at ${place} (the text and a 0 byte at the end)`
  }
}

/**
 * "read 2 numbers, 3 and 4, and stored them at 0x…dfe8 and 0x…dfe0". With more than four
 * values, three are named and the rest counted, so the sentence stays readable.
 */
function readSeveral(stored: readonly ScanItem[], context: ExplainContext): string {
  const places = someOf(stored.map((item) => describePlace(item.address, context)))
  const numbers = stored.filter(
    (item): item is Extract<ScanItem, { kind: 'number' }> =>
      item.kind === 'number' && item.conversion !== 'hex' && readAs(item) === '',
  )
  const values =
    numbers.length === stored.length
      ? `${stored.length} numbers, ${someOf(numbers.map((item) => String(item.value)))}`
      : `${stored.length} values, ${someOf(stored.map(scanItemName))}`
  return `read ${values}, and stored them at ${places}`
}

function explainScanf(
  facts: Extract<LibraryFacts, { kind: 'scanf' }>,
  context: ExplainContext,
): string {
  const { stored, wanted, failed, eax } = facts
  const head = libraryHead('scanf')
  const left = `eax = ${describeNumber(eax, 32)}`
  if (stored.length === 0) {
    return wanted === 0
      ? `${head} has no ${quote('%')} item that stores a value in its format text, so it stored nothing and ${left}.`
      : `${head} could not read the value it wanted, so it stored nothing and ${left}.`
  }
  const [only] = stored
  const what = stored.length === 1 ? readOne(only, context) : readSeveral(stored, context)
  const count = `${left}, the number of values it stored`
  return failed
    ? `${head} ${what}, but it could not read the next value, so ${count}.`
    : `${head} ${what}, so ${count}.`
}

function explainLibrary(facts: LibraryFacts, context: ExplainContext): string[] {
  switch (facts.kind) {
    case 'print': {
      const left = `eax = ${describeNumber(facts.eax, 32)}`
      let printed: string
      if (facts.bytes === 0) printed = 'printed nothing'
      else if (facts.name === 'puts') {
        // eax counts bytes: say how many when text outside ASCII makes them differ.
        const bytes = facts.bytes !== facts.characters ? `, ${facts.bytes} bytes` : ''
        printed = `printed ${characters(facts.characters)} (the text and a new line${bytes})`
      } else if (facts.bytes !== facts.characters) {
        printed = `printed ${characters(facts.characters)} (${facts.bytes} bytes)`
      } else printed = `printed ${characters(facts.characters)}`
      return [
        `${libraryHead(facts.name)} ${printed}, so ${left}.`,
        returnSentence(facts.returned, context),
      ]
    }
    case 'putchar':
      return [
        `${libraryHead('putchar')} printed ${describeCharacter(facts.code)}, so eax = ${describeNumber(facts.eax, 32)}.`,
        returnSentence(facts.returned, context),
      ]
    case 'scanf':
      return [explainScanf(facts, context), returnSentence(facts.returned, context)]
    case 'exit':
      return [`${libraryHead('exit')} ended the program.`, exitCodeSentence(facts.code)]
  }
}

/**
 * The exit code `exit` gives the shell. `code` is the value in edi (read as signed). On
 * Linux the shell sees only its lowest 8 bits: `exit(300)` gives 44, `exit(-1)` gives 255.
 */
function exitCodeSentence(code: bigint): string {
  if (code >= 0n && code <= 255n) return `The exit code is ${code}, the value in edi.`
  const seen = BigInt.asUintN(8, code)
  return `edi holds ${code}, so the exit code is ${seen}: the shell sees only the lowest 8 bits.`
}

/* ───────────────────────────── The whole explanation ───────────────────────────── */

function explainInstruction(facts: InstructionFacts, context: ExplainContext): Sentence[] {
  switch (facts.kind) {
    case 'mov':
      return explainMove(facts, context)
    case 'lea':
      return explainLea(facts, context)
    case 'push':
      return explainPush(facts, context)
    case 'pop':
      return explainPop(facts, context)
    case 'arithmetic':
      return explainArithmetic(facts, context)
    case 'compare':
      return explainCompare(facts, context)
    case 'jmp':
      return explainJump(facts, context)
    case 'jcc':
      return explainConditionalJump(facts, context)
    case 'call':
      return explainCall(facts, context)
    case 'ret':
      return explainRet(facts, context)
    case 'leave':
      return explainLeave(facts, context)
    case 'nop':
      return explainNop(facts)
  }
}

function isLibraryFacts(facts: StepFacts): facts is LibraryFacts {
  return (
    facts.kind === 'print' ||
    facts.kind === 'putchar' ||
    facts.kind === 'scanf' ||
    facts.kind === 'exit'
  )
}

/**
 * The sentences that explain one step that ran. `text` is the instruction text (it is
 * not used for a library step, which starts with the name of the function). The first
 * sentence starts with the instruction, so it always stays.
 */
export function explainStep(text: string, facts: StepFacts, context: ExplainContext): Sentence[] {
  if (isLibraryFacts(facts)) return explainLibrary(facts, context)
  const [first, ...rest] = explainInstruction(facts, context)
  return [`${quote(text)}: ${sentenceText(first)}`, ...rest]
}

/**
 * The sentence that says the program stopped. `short` is used when `text` would make the
 * explanation too long, and `tiny` when even `short` would (the error message under the
 * explanation says the rest).
 */
export interface StopSentence {
  text: string
  short: string
  tiny: string
}

/** Past this many characters an explanation is hard to read, so a shorter form is used. */
export const LONG_EXPLANATION = 400

/** The shortest way to say that the program stopped. */
const STOPPED = 'Then the program stopped with an error.'

/**
 * The last sentence of a step that was applied and then stopped the program, because
 * rip ended at a place that cannot run.
 */
export function stopSentence(
  problem: RuntimeProblem,
  kind: 'instruction' | 'library',
): StopSentence {
  if (problem.error.code === 'ran-off-end') {
    const last =
      kind === 'library'
        ? `The ${quote('call')} was the last instruction`
        : 'This was the last instruction'
    return {
      text: `${last}, so the program ran past the end of its code and stopped with an error.`,
      short: `${last}, so the program stopped with an error.`,
      tiny: STOPPED,
    }
  }
  const text = 'No instruction starts at that address, so the program stopped with an error.'
  return { text, short: text, tiny: STOPPED }
}

/** "A." and "Flags: …" become "A; flags: …". A name such as `ZF=1` keeps its capitals. */
function joinTwo(first: string, second: string): string {
  const head = first.endsWith('.') ? first.slice(0, -1) : first
  const rest = /^[A-Z][a-z]/.test(second)
    ? second.charAt(0).toLowerCase() + second.slice(1)
    : second
  return `${head}; ${rest}`
}

/**
 * Join the sentences of an explanation into at most MAX_SENTENCES sentences. `stop`, the
 * sentence that says the program stopped, always comes last and is never left out
 * (contract, section 8). To make room, extra sentences are left out first (the last one
 * first), then a tail sentence is joined to the sentence before it (the first one first),
 * and with no tail left, the last two sentences are joined. The first sentence, which
 * starts with the instruction, always stays first. The stop sentence is used in its
 * short (or tiny) form when the full one would make the explanation longer than
 * LONG_EXPLANATION.
 */
export function joinExplanation(
  sentences: readonly Sentence[],
  stop: StopSentence | null = null,
): string {
  const room = stop === null ? MAX_SENTENCES : MAX_SENTENCES - 1
  const parts: { text: string; fit: 'keep' | 'extra' | 'tail' }[] = sentences
    .map((sentence) =>
      typeof sentence === 'string' ? { text: sentence, fit: 'keep' as const } : sentence,
    )
    .filter((part) => part.text !== '')
  while (parts.length > room) {
    const extraAt = parts.findLastIndex((part, at) => at > 0 && part.fit === 'extra')
    if (extraAt > 0) {
      parts.splice(extraAt, 1)
      continue
    }
    const tailAt = parts.findIndex((part, at) => at > 0 && part.fit === 'tail')
    const at = tailAt > 0 ? tailAt : parts.length - 1
    if (at < 1) break
    const before = parts[at - 1]
    parts.splice(at - 1, 2, { text: joinTwo(before.text, parts[at].text), fit: before.fit })
  }
  const texts = parts.map((part) => part.text)
  if (stop === null) return texts.join(' ')
  const full = [...texts, stop.text].join(' ')
  if (full.length <= LONG_EXPLANATION) return full
  const short = [...texts, stop.short].join(' ')
  return short.length <= LONG_EXPLANATION ? short : [...texts, stop.tiny].join(' ')
}

/**
 * The finished explanation of a step that ran (`stop` is set when the step also stopped
 * the program). When it is longer than LONG_EXPLANATION, the compact form is used: an
 * address sum without the values of its registers (the address itself stays).
 */
export function explanationOf(
  text: string,
  facts: StepFacts,
  context: ExplainContext,
  stop: StopSentence | null,
): string {
  const full = joinExplanation(explainStep(text, facts, context), stop)
  if (full.length <= LONG_EXPLANATION) return full
  const compact = joinExplanation(explainStep(text, facts, { ...context, compact: true }), stop)
  return compact.length < full.length ? compact : full
}

/** The explanation of a step that faulted: nothing changed, and the program stopped. */
export function explainFault(
  step: { kind: 'instruction'; text: string } | { kind: 'library'; name: LibraryFunctionName },
  problem: RuntimeProblem,
): string {
  if (step.kind === 'library') {
    return `${libraryHead(step.name)} stopped with an error before it changed anything. ${capitalize(problem.summary)}`
  }
  return `${quote(step.text)}: ${problem.stepSummary} Nothing changed, and the program stopped.`
}

/** What `step()` says when the program has already ended. */
export function explainEnded(): string {
  return 'The program has ended. Reset it to run it again.'
}

/** What `step()` says while `scanf` still has no input. */
export function explainWaiting(name: LibraryFunctionName, prompt: string): string {
  return `${libraryHead(name)} is waiting for input. ${prompt}`
}

/**
 * The step of a program that starts at a label with no instruction after it. `text` is
 * the label line, like "main:".
 */
export function explainNothingToRun(text: string, problem: RuntimeProblem): string {
  return `${quote(text)}: ${problem.stepSummary} Nothing changed, and the program stopped.`
}

/* ───────────────────────────── Tips and warnings ───────────────────────────── */

/** What each `scanf` conversion wants, as a noun phrase. */
const WANTED: Readonly<Record<ScanKind, string>> = {
  decimal: 'a whole number',
  integer: 'a whole number',
  unsigned: 'a whole number',
  hex: 'a hex number',
  character: 'one character',
  word: 'a word',
}

/** What scanf found instead, as words. */
function describeFound(found: FoundInput): string {
  switch (found.kind) {
    case 'space':
      return 'a space'
    case 'tab':
      return 'a tab'
    case 'line-end':
      return 'the end of the line'
    case 'white-space':
      return 'white space'
    case 'text':
      return quoteTyped(found.text)
  }
}

function noteFor(note: NoteFacts, context: ExplainContext): StepNote {
  switch (note.kind) {
    case 'misaligned-call': {
      const off = note.rsp % 16n
      return {
        kind: 'warning',
        text: `rsp was ${describePlace(note.rsp, context)} before this ${quote('call')}. That is not a multiple of 16: in hex, a multiple of 16 ends in 0. On a real machine, ${quote(note.functionName)} can crash when rsp is not a multiple of 16 at a ${quote('call')}. Move rsp down by ${off} more before the call (${quote(`sub rsp, ${off}`)}), and back up after it (${quote(`add rsp, ${off}`)}).`,
      }
    }
    case 'uninitialized-read': {
      const where = describePlace(note.address, context)
      const junk = 'whatever was left there before'
      const fix = 'Store a value there before you read it.'
      let text: string
      if (note.missing < note.bytes) {
        text =
          note.missing === 1
            ? `1 of the ${note.bytes} bytes at ${where} on the stack was never written, so the emulator read 0 for it. On a real machine it holds junk: ${junk}. ${fix}`
            : `${note.missing} of the ${note.bytes} bytes at ${where} on the stack were never written, so the emulator read 0 for them. On a real machine they hold junk: ${junk}. ${fix}`
      } else if (note.bytes === 8 && note.address % 8n === 0n) {
        text = `The stack box at ${where} was never written, so the emulator read 0 from it. On a real machine that box holds junk: ${junk}. ${fix}`
      } else if (note.bytes === 1) {
        text = `The byte at ${where} on the stack was never written, so the emulator read 0 for it. On a real machine it holds junk: ${junk}. ${fix}`
      } else {
        text = `The ${note.bytes} bytes at ${where} on the stack were never written, so the emulator read 0 for them. On a real machine they hold junk: ${junk}. ${fix}`
      }
      return { kind: 'warning', text }
    }
    case 'unterminated-text': {
      const name = quote(note.functionName)
      const verb = note.functionName === 'scanf' ? 'read' : 'print'
      const start = describePlace(note.start, context)
      const at = describePlace(note.at, context)
      if (note.ranInto === 'data') {
        return {
          kind: 'warning',
          text: `The text at ${start} has no 0 byte at its end, so ${name} read past the last byte of the program's data, to ${at}. On a real machine, ${name} would ${verb} whatever bytes come next, up to the first 0 byte. Write the text with ${quote('.string')}: it adds the 0 byte.`,
        }
      }
      return {
        kind: 'warning',
        text: `The text at ${start} has no 0 byte at its end, so ${name} kept reading, up to the stack byte at ${at}, which was never written. On a real machine, ${name} would ${verb} the junk there as part of the text.`,
      }
    }
    case 'code-read': {
      const where = describePlace(note.address, context)
      const text = `This instruction read ${bytesText(note.bytes)} from the code of the program, at ${where}. This emulator does not store the bytes of the instructions, so it read 0. A real machine gives the machine code that is stored there.`
      return {
        kind: 'warning',
        text:
          note.label !== null
            ? `${text} To get the ADDRESS of ${quote(note.label)}, use ${quote('lea')} with ${quote(`${note.label}[rip]`)}.`
            : text,
      }
    }
    case 'return-mismatch': {
      const used = describePlace(note.used, context)
      const saved =
        note.saved !== null
          ? `the last ${quote('call')} saved the return address ${describePlace(note.saved, context)}`
          : `no ${quote('call')} saved that address`
      return {
        kind: 'warning',
        text: `${quote('ret')} jumped to ${used}, but ${saved}. The top box did not hold the return address of this function. Check that the function pops everything it pushes.`,
      }
    }
    case 'imul-flags':
      return {
        kind: 'warning',
        text: `This jump looked at flags that ${quote('imul')} wrote. On a real CPU, ZF and SF are not defined after ${quote('imul')}, so the jump may go the other way there. Put ${quote('cmp')} or ${quote('test')} before ${quote(note.written)}.`,
      }
    case 'library-flags':
      return {
        kind: 'warning',
        text: `This jump looked at flags from before the call to ${quote(note.functionName)} on line ${note.callLine}. Library code may change the flags, so on a real machine the jump may go the other way. Put ${quote('cmp')} or ${quote('test')} after the call, just before ${quote(note.written)}.`,
      }
    case 'junk-registers':
      // Short: it shows after every library call. (No "push it": one push breaks the
      // alignment of the stack before the call.)
      return {
        kind: 'tip',
        text: `${quote(note.functionName)} may change ${andList(note.registers)}, so they hold junk now. To keep a value until after the call, store it in a local variable on the stack, or in rbx or r12 to r15 (restore those before ${quote('ret')}).`,
      }
    case 'scanf-mismatch': {
      const wanted =
        typeof note.wanted === 'string'
          ? WANTED[note.wanted]
          : `${quote(note.wanted.literal)} next in the input`
      const stored =
        note.stored === 0
          ? 'stored nothing'
          : note.stored === 1
            ? 'stored only 1 value'
            : `stored only ${note.stored} values`
      // As in C, what scanf could not read stays in the input.
      const stays =
        note.found.kind === 'text'
          ? ` ${quoteTyped(note.found.text)} stays in the input, so the next ${quote('scanf')} starts there.`
          : ''
      return {
        kind: 'warning',
        text: `${quote('scanf')} wanted ${wanted}, but it found ${describeFound(note.found)}. It stopped there and ${stored}.${stays}`,
      }
    }
  }
}

/** The tips and warnings of a step, as finished sentences. */
export function notesFor(notes: readonly NoteFacts[], context: ExplainContext): StepNote[] {
  return notes.map((note) => noteFor(note, context))
}

/* ───────────────────────────── Stack box labels ───────────────────────────── */

/** The label of a stack box: "return address (back to line 12)", "saved rbp", "count". */
export function stackLabelText(facts: StackLabelFacts): string {
  switch (facts.kind) {
    case 'return-address':
      return facts.line !== null ? `return address (back to line ${facts.line})` : 'return address'
    case 'saved-register':
      return `saved ${facts.register}`
    case 'local': {
      const name = facts.names.join('+')
      if (facts.offset === 0n) return name
      return facts.offset > 0n ? `${name}+${facts.offset}` : `${name}-${-facts.offset}`
    }
  }
}

/** The label of the box that holds the return address into the "OS". */
export function osReturnLabel(): string {
  return 'return address (ends the program)'
}

/* ───────────────────────────── scanf and run() ───────────────────────────── */

/** What one value is called in a prompt, without "a": "whole number". */
const NOUN: Readonly<Record<ScanKind, string>> = {
  decimal: 'whole number',
  integer: 'whole number',
  unsigned: 'whole number',
  hex: 'hex number',
  character: 'character',
  word: 'word',
}

/** Example input for `count` values of one kind: "3 4", "1f 2a". */
function exampleInput(kind: ScanKind, count: number): string {
  const samples =
    kind === 'hex'
      ? ['1f', '2a', '3b', '4c', '5d', '6e']
      : ['3', '4', '5', '6', '7', '8', '9', '10', '11', '12']
  const shown: string[] = []
  for (let i = 0; i < count; i++) shown.push(samples[i % samples.length])
  return shown.join(' ')
}

/** "a whole number" / "an …": the noun with its article. */
function withArticle(noun: string): string {
  return /^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`
}

/**
 * One short sentence for the input box: what to type. `partial` is true when the input
 * already holds some of the values the format wants.
 */
export function inputPrompt(missing: readonly MissingValue[], partial = false): string {
  if (missing.length === 0) return 'Type your input and press Enter.'
  const more = partial ? ' more' : ''
  // `%3c` wants 3 characters: count each character.
  const characterCount = missing.reduce((sum, value) => sum + (value.width ?? 1), 0)
  if (missing.every((value) => value.kind === 'character')) {
    if (characterCount === 1) {
      return partial ? 'Type 1 more character.' : 'Type one character and press Enter.'
    }
    return `Type ${characterCount}${more} characters.`
  }
  if (missing.length === 1) {
    const [only] = missing
    if (partial) return `Type 1 more ${NOUN[only.kind]}.`
    switch (only.kind) {
      case 'decimal':
      case 'integer':
        return 'Type a whole number, like 42 or -7, and press Enter.'
      case 'unsigned':
        return 'Type a whole number, like 42, and press Enter.'
      case 'hex':
        return 'Type a hex number, like 1f, and press Enter.'
      case 'word':
        return 'Type one word with no spaces, and press Enter.'
      case 'character':
        return 'Type one character and press Enter.'
    }
  }
  const [first] = missing
  const sameNoun = missing.every((value) => NOUN[value.kind] === NOUN[first.kind])
  if (sameNoun && first.kind !== 'character') {
    const plural = `${NOUN[first.kind]}s`
    return first.kind === 'word'
      ? `Type ${missing.length}${more} words with a space between them.`
      : `Type ${missing.length}${more} ${plural} with a space between them, like ${exampleInput(first.kind, missing.length)}.`
  }
  const nouns = missing.map((value) =>
    value.kind === 'character' && (value.width ?? 1) > 1
      ? `${value.width} characters`
      : withArticle(NOUN[value.kind]),
  )
  const listed = `${nouns.slice(0, -1).join(', ')}, then ${nouns[nouns.length - 1]}`
  return `Type ${missing.length}${more} values: ${listed}.`
}

/** The one sentence `run()` gives back. */
export function runMessage(
  reason: RunStopReason,
  detail: { line: number | null; steps: number },
): string {
  switch (reason) {
    case 'halted':
      return 'The program ended.'
    case 'error':
      return detail.line !== null
        ? `The program stopped with an error on line ${detail.line}.`
        : 'The program stopped with an error.'
    case 'breakpoint':
      return detail.line !== null
        ? `The program stopped at the breakpoint on line ${detail.line}.`
        : 'The program stopped at a breakpoint.'
    case 'waiting-input':
      return 'The program is waiting for input.'
    case 'step-limit': {
      const steps = detail.steps === 1 ? '1 step' : `${groupDigits(detail.steps)} steps`
      return `The program ran ${steps} without ending, so it may be stuck in a loop that never ends: check the jump that should end it.`
    }
  }
}
