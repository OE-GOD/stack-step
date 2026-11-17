/**
 * Register names: name a part of a register and say its size.
 *
 * This file and `subregister-writes.ts` are the models for the other generators.
 * `generate(seed)` builds a problem in five steps, each in its own function:
 *
 *   1. choose     pick the question with the seeded rng (never Math.random)
 *   2. facts      read every answer from the emulator: here, its register table
 *                 (`registerFamily`, `subRegister`, `lookupRegister`), so nothing is
 *                 typed in by hand and nothing needs to run
 *   3. prompt     the question, the answer fields and the one-line reason
 *   4. mistakes   the tempting wrong answers, in the order of the specification
 *   5. stepper    the problem as a program for "Show me"
 *
 * Three forms of question:
 *   - name + size:    "What is the name of the 16-bit part of `r9`? How many bytes is that?"
 *   - family + size:  "`esi` is a part of which 64-bit register? How many bits does it have?"
 *   - high + low:     "Which name means bits 15 to 8 of `rbx`? Which name means bits 7 to 0?"
 *                     (only rax, rbx, rcx and rdx have a name for bits 15 to 8)
 *
 * The size is asked in bytes when the question gives it in bits, and in bits when it
 * gives it in bytes, so both directions of the bits/bytes slip can happen.
 */
import {
  joinAnd,
  lookupRegister,
  REG64_NAMES,
  registerFamily,
  type Reg64,
  type RegisterInfo,
} from '../../../emulator'
import { createRng, type Rng } from '../../../lib/rng'
import { decimalField, textBlock, textField } from '../gen/helpers'
import type { Field, Mistake, MistakeCode, Problem, ProblemGenerator, PromptBlock } from '../types'

/* ───────────────────────────── the answer key ───────────────────────────── */

type Unit = 'bits' | 'bytes'

/** One question, as chosen from the seed. Every name in it comes from the register table. */
type Question =
  /** Name a part, then give its size in the unit the question does NOT use. */
  | { form: 'name-and-size'; part: RegisterInfo; given: Unit }
  /** Name the 64-bit register a part belongs to, then give the part's size. */
  | { form: 'family-and-size'; part: RegisterInfo; asked: Unit }
  /** Name bits 15 to 8 and bits 7 to 0 of rax, rbx, rcx or rdx. */
  | { form: 'high-and-low'; base: Reg64 }

/** A field that asks for a register name. */
interface NameAsk {
  fieldId: string
  /** The right name. */
  right: RegisterInfo
  /** The register the question is about. Its other names are the "wrong part" answers. */
  family: Reg64
}

/** A field that asks for a size. */
interface SizeAsk {
  fieldId: string
  asked: Unit
  /** Width of the part in bits. */
  bits: number
}

/** One tempting wrong answer: what a student who makes this mistake types. */
export interface Prediction {
  code: MistakeCode
  /** Field id → the text the student types (every field of the problem). */
  answers: Readonly<Record<string, string>>
}

export interface GeneratedProblem {
  problem: Problem
  /** Concrete wrong answers that `diagnose` names (the tests check every one). */
  predictions: readonly Prediction[]
}

/** The registers that have a name for bits 15 to 8 (ah, bh, ch, dh). */
const HIGH_BYTE_BASES: readonly Reg64[] = ['rax', 'rbx', 'rcx', 'rdx']

/** The value the "Show me" program loads: every byte is different, so each part is easy to see. */
export const SHOW_ME_VALUE = 0x1122334455667788n

const UNITS: readonly Unit[] = ['bits', 'bytes']

/* ─────────────────────────────── 1. choose ──────────────────────────────── */

/** Every name inside a 64-bit register except the 64-bit one, widest first. */
function partsOf(base: Reg64): RegisterInfo[] {
  return registerFamily(base).filter((info) => info.size !== 64)
}

/** All 52 part names of the 16 registers, so that every one is equally likely. */
const ALL_PARTS: readonly RegisterInfo[] = REG64_NAMES.flatMap(partsOf)

/**
 * The high + low form has only four questions (one per register), so it comes up
 * rarely; the other two forms share the rest.
 */
function choose(rng: Rng): Question {
  const roll = rng.next()
  if (roll < 0.04) return { form: 'high-and-low', base: rng.pick(HIGH_BYTE_BASES) }

  const part = rng.pick(ALL_PARTS)
  if (roll < 0.52) {
    // Bits 15 to 8 have no short description in bytes, so that part is always given in bits.
    const given = part.highByte ? 'bits' : rng.pick(UNITS)
    return { form: 'name-and-size', part, given }
  }
  return { form: 'family-and-size', part, asked: rng.pick(UNITS) }
}

/* ──────────────────────────── 2. facts (words) ──────────────────────────── */

function register(name: string): RegisterInfo {
  const info = lookupRegister(name)
  if (info === undefined) throw new Error(`register-names: '${name}' is not in the register table.`)
  return info
}

/** The part as described in bits: "the 16-bit part", "bits 15 to 8", … */
function partInBits(info: RegisterInfo): string {
  if (info.highByte) return 'bits 15 to 8'
  if (info.size === 8) return 'bits 7 to 0'
  if (info.size === 64) return 'the whole 64-bit register'
  return `the ${info.size}-bit part`
}

/** The part as described in bytes: "the low 2 bytes", "the lowest byte". */
function partInBytes(info: RegisterInfo): string {
  return info.size === 8 ? 'the lowest byte' : `the low ${info.size / 8} bytes`
}

function bytesText(count: number): string {
  return count === 1 ? '1 byte' : `${count} bytes`
}

/** The answer of a size field: the width in the unit that was asked. */
function sizeIn(unit: Unit, bits: number): number {
  return unit === 'bits' ? bits : bits / 8
}

function otherUnit(unit: Unit): Unit {
  return unit === 'bits' ? 'bytes' : 'bits'
}

/** "The parts of `r9` are `r9d` (32 bits), `r9w` (16 bits) and `r9b` (8 bits)." */
function familyPattern(base: Reg64): string {
  const parts = partsOf(base).map((info) => {
    const where = info.size === 8 && HIGH_BYTE_BASES.includes(base) ? partInBits(info) : null
    return `\`${info.name}\` (${where ?? `${info.size} bits`})`
  })
  return `The parts of \`${base}\` are ${joinAnd(parts)}.`
}

/** "`r9w` is the 16-bit part of `r9`: 16 bits, which is 2 bytes." */
function sizeReason(part: RegisterInfo): string {
  return `\`${part.name}\` is ${partInBits(part)} of \`${part.base}\`: ${part.size} bits, which is ${bytesText(part.size / 8)}.`
}

/* ─────────────────────────────── 3. prompt ──────────────────────────────── */

interface Built {
  prompt: PromptBlock[]
  fields: Field[]
  names: NameAsk[]
  size: SizeAsk | null
  reason: string
  /** The register the "Show me" program shows. */
  base: Reg64
}

function sizeField(asked: Unit, bits: number): Field {
  return decimalField(asked, `Size in ${asked}`, sizeIn(asked, bits))
}

function build(question: Question): Built {
  switch (question.form) {
    case 'name-and-size': {
      const { part, given } = question
      const asked = otherUnit(given)
      const described = given === 'bits' ? partInBits(part) : partInBytes(part)
      return {
        prompt: [
          textBlock(
            `What is the name of ${described} of \`${part.base}\`? How many ${asked} is that?`,
          ),
        ],
        fields: [textField('name', 'Name of the part', part.name), sizeField(asked, part.size)],
        names: [{ fieldId: 'name', right: part, family: part.base }],
        size: { fieldId: asked, asked, bits: part.size },
        reason: sizeReason(part),
        base: part.base,
      }
    }
    case 'family-and-size': {
      const { part, asked } = question
      return {
        prompt: [
          textBlock(
            `\`${part.name}\` is a part of which 64-bit register? How many ${asked} does \`${part.name}\` have?`,
          ),
        ],
        fields: [textField('base', '64-bit register', part.base), sizeField(asked, part.size)],
        names: [{ fieldId: 'base', right: register(part.base), family: part.base }],
        size: { fieldId: asked, asked, bits: part.size },
        reason: sizeReason(part),
        base: part.base,
      }
    }
    case 'high-and-low': {
      const { base } = question
      const parts = partsOf(base)
      const high = parts.find((info) => info.highByte)
      const low = parts.find((info) => info.size === 8 && !info.highByte)
      if (high === undefined || low === undefined) {
        throw new Error(`register-names: ${base} has no high and low byte names.`)
      }
      return {
        prompt: [
          textBlock(
            `Which name means bits 15 to 8 of \`${base}\`? Which name means bits 7 to 0 of \`${base}\`?`,
          ),
        ],
        fields: [
          textField('high', 'Bits 15 to 8', high.name),
          textField('low', 'Bits 7 to 0', low.name),
        ],
        names: [
          { fieldId: 'high', right: high, family: base },
          { fieldId: 'low', right: low, family: base },
        ],
        size: null,
        reason: `In \`${base}\`, \`${high.name}\` is bits 15 to 8 (h for high) and \`${low.name}\` is bits 7 to 0 (l for low).`,
        base,
      }
    }
  }
}

/* ────────────────────────────── 4. mistakes ─────────────────────────────── */

/** Registers that are real, but not one of the sixteen general registers. */
const OTHER_REGISTERS = new Set(['rip', 'eip', 'ip', 'rflags', 'eflags', 'flags'])

/**
 * A student's answer, ready to put in backticks inside a message. null when it is too
 * long to repeat (a pasted paragraph is not worth quoting).
 */
function quoted(answer: string): string | null {
  const clean = answer.replaceAll('`', '')
  return clean === '' || clean.length > 12 ? null : `\`${clean}\``
}

/** wrong-part: a real name of the same register, but another part. */
function wrongPart(ask: NameAsk, answer: string): Mistake | null {
  const info = lookupRegister(answer)
  if (info === undefined || info.base !== ask.family || info.name === ask.right.name) return null
  const { right, family } = ask
  if (right.size === 64) {
    return {
      code: 'wrong-part',
      message: `\`${info.name}\` is ${partInBits(info)} of \`${family}\`. The whole 64-bit register is \`${right.name}\`.`,
    }
  }
  if (info.size === 64) {
    return {
      code: 'wrong-part',
      message: `\`${info.name}\` is the whole 64-bit register. The name for ${partInBits(right)} of \`${family}\` is \`${right.name}\`.`,
    }
  }
  return {
    code: 'wrong-part',
    message: `\`${info.name}\` is ${partInBits(info)} of \`${family}\`, not ${partInBits(right)}. The name for ${partInBits(right)} is \`${right.name}\`.`,
  }
}

/** wrong-register-family: not a name of this register at all (r9x, e9, sih, or another register). */
function wrongFamily(ask: NameAsk, answer: string): Mistake | null {
  if (answer === '' || answer === ask.right.name) return null
  const info = lookupRegister(answer)
  if (info !== undefined && info.base === ask.family) return null

  let first: string
  if (info !== undefined) {
    first =
      info.size === 64
        ? `\`${info.name}\` is another register.`
        : `\`${info.name}\` is a part of \`${info.base}\`, not of \`${ask.family}\`.`
  } else if (OTHER_REGISTERS.has(answer)) {
    first = `\`${answer}\` is not one of the 16 general registers.`
  } else {
    // "Not a name the assembler knows": Intel's manual writes r9l, but the assembler
    // (and this site) only knows r9b, so "not a register name" alone could confuse.
    const shown = quoted(answer)
    first =
      shown === null
        ? 'That is not a register name the assembler knows.'
        : `${shown} is not a register name the assembler knows.`
  }
  return { code: 'wrong-register-family', message: `${first} ${familyPattern(ask.family)}` }
}

/**
 * The number in a size answer: "32", or "32 bits" / "4bytes" (a unit word after it is
 * natural to type). null for anything else.
 */
function sizeNumber(answer: string): string | null {
  return /^(\d+)\s*(?:bits?|bytes?)?$/.exec(answer)?.[1] ?? null
}

/** bits-vs-bytes: the size in the other unit (with or without a unit word after it). */
function bitsVsBytes(size: SizeAsk, answer: string): Mistake | null {
  const right = sizeIn(size.asked, size.bits)
  const slip = sizeIn(otherUnit(size.asked), size.bits)
  if (slip === right || sizeNumber(answer) !== String(slip)) return null
  const bytes = bytesText(size.bits / 8)
  return {
    code: 'bits-vs-bytes',
    message:
      size.asked === 'bytes'
        ? `You gave the size in bits, but the question asks for bytes. A byte is 8 bits, so ${size.bits} bits are ${bytes}.`
        : `You gave the size in bytes, but the question asks for bits. A byte is 8 bits, so ${bytes} ${size.bits === 8 ? 'is' : 'are'} ${size.bits} bits.`,
  }
}

/**
 * Name the mistake in the student's answers (canonical form), in the order of the
 * specification: wrong-part, wrong-register-family, bits-vs-bytes. The first match wins.
 * A right field never matches, so a correct answer is never called a mistake.
 */
function makeDiagnose(names: readonly NameAsk[], size: SizeAsk | null): Problem['diagnose'] {
  return (answers) => {
    const answerOf = (fieldId: string): string => answers[fieldId] ?? ''
    for (const ask of names) {
      const mistake = wrongPart(ask, answerOf(ask.fieldId))
      if (mistake !== null) return mistake
    }
    for (const ask of names) {
      const mistake = wrongFamily(ask, answerOf(ask.fieldId))
      if (mistake !== null) return mistake
    }
    return size === null ? null : bitsVsBytes(size, answerOf(size.fieldId))
  }
}

/** Names that look like a part of `base` but do not exist (the spec's r9x, e9, r9l, sih). */
function madeUpNames(base: Reg64): string[] {
  const numbered = /^r(\d+)$/.exec(base)
  let names: string[]
  if (numbered !== null) {
    names = [`${base}x`, `e${numbered[1]}`, `${base}l`, `${base}h`]
  } else if (HIGH_BYTE_BASES.includes(base)) {
    const letter = base.charAt(1)
    names = [`r${letter}l`, `${letter}xl`, `e${letter}`, `${base}d`]
  } else {
    const stem = base.slice(1)
    names = [`${stem}h`, `${stem}x`, `${base}d`, `${stem}b`]
  }
  return names.filter((name) => lookupRegister(name) === undefined)
}

/** The same-size name in the register after `base` (r9w → r10w): a real name, wrong family. */
function nameInAnotherRegister(right: RegisterInfo): string {
  const index = REG64_NAMES.indexOf(right.base)
  const other = REG64_NAMES[(index + 1) % REG64_NAMES.length]
  const match = registerFamily(other).find(
    (info) => info.size === right.size && info.highByte === right.highByte,
  )
  return (match ?? registerFamily(other)[0]).name
}

/** Concrete answers for each mistake, every other field right (used by the tests). */
function predict(built: Built): Prediction[] {
  const right: Record<string, string> = {}
  for (const field of built.fields) right[field.id] = field.expected
  const withAnswer = (fieldId: string, text: string) => ({ ...right, [fieldId]: text })

  const predictions: Prediction[] = []
  for (const ask of built.names) {
    for (const sibling of registerFamily(ask.family)) {
      if (sibling.name !== ask.right.name) {
        predictions.push({ code: 'wrong-part', answers: withAnswer(ask.fieldId, sibling.name) })
      }
    }
  }
  for (const ask of built.names) {
    for (const name of [...madeUpNames(ask.family), nameInAnotherRegister(ask.right)]) {
      predictions.push({ code: 'wrong-register-family', answers: withAnswer(ask.fieldId, name) })
    }
  }
  if (built.size !== null) {
    const slip = sizeIn(otherUnit(built.size.asked), built.size.bits)
    predictions.push({
      code: 'bits-vs-bytes',
      answers: withAnswer(built.size.fieldId, String(slip)),
    })
  }
  return predictions
}

/* ─────────────────────────────── 5. stepper ─────────────────────────────── */

/**
 * Load the easy-to-read value into the register, then return. rsp cannot take that value
 * (the `ret` would then read from a wrong address), so for rsp the program copies it
 * instead: rsp already holds a real stack address with parts to look at.
 */
function stepperFor(base: Reg64): Problem['stepper'] {
  // One space after `mov`: the inline stepper is narrow on a phone, and the long value
  // must fit. "Tap or click": the note is read on phones too.
  if (base === 'rsp') {
    return {
      code: '    .intel_syntax noprefix\nmain:\n    mov rax, rsp\n    ret\n',
      note: 'Step once, then tap or click `rsp` to see its parts (it holds an address on the stack).',
    }
  }
  return {
    code: `    .intel_syntax noprefix\nmain:\n    mov ${base}, 0x${SHOW_ME_VALUE.toString(16)}\n    ret\n`,
    note: `Step once, then tap or click \`${base}\` to see its parts.`,
  }
}

/* ─────────────────────────────── the problem ────────────────────────────── */

export function generateWithPredictions(seed: number): GeneratedProblem {
  const rng = createRng(seed)
  const built = build(choose(rng))
  const problem: Problem = {
    id: `register-names-${seed}`,
    topic: 'register-names',
    seed,
    view: 'form',
    prompt: built.prompt,
    fields: built.fields,
    reason: built.reason,
    stepper: stepperFor(built.base),
    diagnose: makeDiagnose(built.names, built.size),
  }
  return { problem, predictions: predict(built) }
}

export const generate: ProblemGenerator = (seed) => generateWithPredictions(seed).problem
