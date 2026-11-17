/**
 * Writing part of a register: what does the whole register hold afterwards?
 *
 *   "rdi = 0x1111222233334444. Then `mov edi, 0x9` runs. What is rdi now?"
 *
 * This file and `register-names.ts` are the models for the other generators.
 * `generate(seed)` builds a problem in five steps, each in its own function:
 *
 *   1. choose     pick the register, the part, the starting values and the source
 *   2. run        run the program in the emulator: the answer key is the final rdi,
 *                 never a value worked out here
 *   3. prompt     the starting values, the question, the answer field, the reason
 *   4. mistakes   the tempting wrong answers, in the order of the specification
 *   5. stepper    the same program and starting values for "Show me"
 *
 * The write rules that the problems are about (the emulator implements them):
 *   - an 8-bit or 16-bit name changes only its own bits;
 *   - a 32-bit name also sets the top 32 bits to 0;
 *   - a 64-bit name replaces everything.
 */
import {
  hex,
  hex64,
  hexSized,
  mergeRegisterWrite,
  registerFamily,
  subRegister,
  type EmulatorOptions,
  type OperandSize,
  type Reg64,
  type RegisterInfo,
} from '../../../emulator'
import { createRng, type Rng } from '../../../lib/rng'
import {
  canonicalHex,
  FREE_REGISTERS,
  hexField,
  random64,
  registersBlock,
  runProgram,
  textBlock,
  type ProgramRun,
} from '../gen/helpers'
import type { Mistake, MistakeCode, Problem, ProblemGenerator } from '../types'

/* ───────────────────────────── the answer key ───────────────────────────── */

/** One tempting wrong answer: what a student who makes this mistake types. */
export interface Prediction {
  code: MistakeCode
  /** Field id → the text the student types (all 16 digits, as the question asks). */
  answers: Readonly<Record<string, string>>
}

export interface GeneratedProblem {
  problem: Problem
  /** Concrete wrong answers that `diagnose` names (the tests check every one). */
  predictions: readonly Prediction[]
}

/** The part of the register that the `mov` writes. */
type PartKind = 'low8' | 'high8' | '16' | '32' | '64'

type Source =
  | { kind: 'number'; value: bigint }
  /** Another register of the same size. Its whole 64-bit value is shown too. */
  | { kind: 'register'; name: RegisterInfo; start: bigint }

interface Choice {
  /** The name the `mov` writes, e.g. edi. */
  dest: RegisterInfo
  /** The whole register before the `mov`. */
  start: bigint
  source: Source
}

/** The four registers that have a name for bits 15 to 8 (ah, bh, ch, dh). */
const HIGH_BYTE_BASES: readonly Reg64[] = ['rax', 'rbx', 'rcx', 'rdx']

const LOW_32_BITS = 0xffff_ffffn
const HIGH_32_BITS = 0xffff_ffff_0000_0000n

/* ─────────────────────────────── 1. choose ──────────────────────────────── */

/** 32-bit writes come up most often: they are the rule students forget. */
function choosePart(rng: Rng): PartKind {
  const roll = rng.next()
  if (roll < 0.34) return '32'
  if (roll < 0.52) return '16'
  if (roll < 0.7) return 'low8'
  if (roll < 0.88) return 'high8'
  return '64'
}

function highByteOf(base: Reg64): RegisterInfo | undefined {
  return registerFamily(base).find((info) => info.highByte)
}

function lowByteOf(base: Reg64): RegisterInfo {
  return subRegister(base, 8)
}

const PART_SIZE: Record<Exclude<PartKind, 'high8'>, OperandSize> = {
  low8: 8,
  '16': 16,
  '32': 32,
  '64': 64,
}

/** A number with 1 to `maxDigits` hex digits, never 0. */
function numberWithDigits(rng: Rng, maxDigits: number): bigint {
  const digits = rng.int(1, maxDigits)
  return BigInt(rng.int(16 ** (digits - 1), 16 ** digits - 1))
}

/** A number that fits the part: short numbers too, because `mov di, 0x9` writes 0x0009. */
function chooseNumber(rng: Rng, size: OperandSize): bigint {
  switch (size) {
    case 8:
      return BigInt(rng.int(1, 0xff))
    case 16:
      return numberWithDigits(rng, 4)
    case 32:
      return numberWithDigits(rng, 8)
    case 64:
      return rng.chance() ? numberWithDigits(rng, 4) : random64(rng)
  }
}

/**
 * Another register of the same size. A write to bits 15 to 8 can only take another
 * byte of rax…rdx (ah…dh cannot be mixed with sil, dil or r8b…r15b).
 */
function chooseSourceName(rng: Rng, dest: RegisterInfo): RegisterInfo {
  if (dest.highByte) {
    const bytes = HIGH_BYTE_BASES.filter((base) => base !== dest.base).flatMap((base) => {
      const high = highByteOf(base)
      return high === undefined ? [lowByteOf(base)] : [lowByteOf(base), high]
    })
    return rng.pick(bytes)
  }
  const others = FREE_REGISTERS.filter((base) => base !== dest.base)
  return subRegister(rng.pick(others), dest.size)
}

/** The bits of `value` that a register name covers (to compare starting values only). */
function partOf(value: bigint, info: RegisterInfo): bigint {
  return (value >> BigInt(info.shift)) & ((1n << BigInt(info.size)) - 1n)
}

function sourceValue(source: Source): bigint {
  return source.kind === 'number' ? source.value : partOf(source.start, source.name)
}

function choose(rng: Rng): Choice {
  const kind = choosePart(rng)
  let dest: RegisterInfo
  if (kind === 'high8') {
    const high = highByteOf(rng.pick(HIGH_BYTE_BASES))
    if (high === undefined) throw new Error('subregister-writes: no high byte name.')
    dest = high
  } else {
    dest = subRegister(rng.pick(FREE_REGISTERS), PART_SIZE[kind])
  }
  const start = random64(rng)
  // A whole 64-bit register copied into another prints its own answer in the question, so
  // it stays a rare contrast case; the other parts take a register source one time in three.
  const sourceName = rng.chance(dest.size === 64 ? 1 / 8 : 1 / 3)
    ? chooseSourceName(rng, dest)
    : null

  // A write that changes nothing (the same byte copied over itself) teaches nothing:
  // draw the source again until the emulator's write rule says the register changes.
  for (let attempt = 0; attempt < 50; attempt++) {
    const source: Source =
      sourceName === null
        ? { kind: 'number', value: chooseNumber(rng, dest.size) }
        : { kind: 'register', name: sourceName, start: random64(rng) }
    if (mergeRegisterWrite(start, dest, sourceValue(source)) !== start) {
      return { dest, start, source }
    }
  }
  throw new Error('subregister-writes: could not find a write that changes the register.')
}

/* ──────────────────────────────── 2. run ────────────────────────────────── */

function sourceText(source: Source): string {
  return source.kind === 'number' ? hex(source.value) : source.name.name
}

/** The `mov` line as the question shows it: `mov edi, 0x9`. */
function instruction(choice: Choice): string {
  return `mov ${choice.dest.name}, ${sourceText(choice.source)}`
}

function programFor(choice: Choice): string {
  const line = `mov     ${choice.dest.name}, ${sourceText(choice.source)}`
  return `    .intel_syntax noprefix\nmain:\n    ${line}\n    ret\n`
}

function optionsFor(choice: Choice): EmulatorOptions {
  const initialRegisters: Partial<Record<Reg64, bigint>> = { [choice.dest.base]: choice.start }
  if (choice.source.kind === 'register') {
    initialRegisters[choice.source.name.base] = choice.source.start
  }
  return { initialRegisters }
}

/** What the emulator says: the whole register after the `mov`, and the part it wrote. */
interface Facts {
  run: ProgramRun
  /** The whole register before. */
  before: bigint
  /** The whole register after: the answer. */
  after: bigint
  /** The value now in the part that was written (the number, or the source part). */
  written: bigint
}

function runIt(choice: Choice): Facts {
  const run = runProgram(programFor(choice), optionsFor(choice))
  const base = choice.dest.base
  return {
    run,
    before: run.start.registers[base],
    after: run.end.registers[base],
    written: run.emulator.readRegister(choice.dest.name),
  }
}

/* ─────────────────────────────── 3. prompt ──────────────────────────────── */

/** Which bits a name covers: "bits 15 to 8". */
function bitRange(info: RegisterInfo): string {
  return `bits ${info.shift + info.size - 1} to ${info.shift}`
}

/** The bits a write to `info` leaves alone, when there are some: "bits 63 to 16". */
function keptBits(info: RegisterInfo): string {
  if (info.highByte) return 'All other bits'
  return `Bits 63 to ${info.size}`
}

/** One line that states the rule that decides the answer, with this problem's numbers. */
function reasonFor(choice: Choice, facts: Facts): string {
  const { dest, source } = choice
  const base = dest.base
  if (dest.size === 64) {
    return source.kind === 'register'
      ? `\`mov ${dest.name}, ${source.name.name}\` copies all 64 bits of \`${source.name.base}\` into \`${base}\`.`
      : `Writing \`${dest.name}\` (64 bits) replaces all 64 bits with ${hex64(facts.written)}.`
  }
  const value = hexSized(facts.written, dest.size)
  const holds = source.kind === 'register' ? `\`${source.name.name}\` holds ${value}. ` : ''
  const what = source.kind === 'register' ? 'that value' : value
  const sets = `Writing \`${dest.name}\` (${dest.size} bits) sets ${bitRange(dest)} of \`${base}\` to ${what}`
  if (dest.size === 32) return `${holds}${sets} and clears bits 63 to 32.`
  return `${holds}${sets}. ${keptBits(dest)} keep their old value.`
}

/* ────────────────────────────── 4. mistakes ─────────────────────────────── */

interface WrongValue {
  mistake: Mistake
  value: bigint
}

/**
 * The tempting wrong answers, in the order of the specification. Each one applies the
 * write rule the wrong way, using the emulator's own write rule (`mergeRegisterWrite`)
 * where it can. A wrong value that equals the right answer, or that an earlier mistake
 * already gives, is dropped: a correct student is never told they made a mistake, and
 * every value names exactly one mistake.
 */
function wrongValues(choice: Choice, facts: Facts): WrongValue[] {
  const { dest, source } = choice
  const base = dest.base
  const { before, written } = facts
  const list: WrongValue[] = []

  // forgot-zero-upper: a 32-bit write that keeps the old top half.
  if (dest.size === 32) {
    list.push({
      value: (before & HIGH_32_BITS) | written,
      mistake: {
        code: 'forgot-zero-upper',
        message: `You kept the old top half (${hexSized(before >> 32n, 32)}). Writing a 32-bit name such as \`${dest.name}\` always sets bits 63 to 32 of \`${base}\` to 0.`,
      },
    })
  }

  // cleared-upper-wrongly: an 8-bit or 16-bit write that clears bits it should keep.
  if (dest.size === 8 || dest.size === 16) {
    const mistake: Mistake = {
      code: 'cleared-upper-wrongly',
      message: `You cleared bits that should stay. Writing \`${dest.name}\` changes only ${bitRange(dest)} of \`${base}\`; every other bit keeps its old value.`,
    }
    // Just the new value, everything else 0 (in its place, and for bh-style also moved down).
    list.push({ value: mergeRegisterWrite(0n, dest, written), mistake })
    if (dest.highByte) list.push({ value: written, mistake })
    // Treated like a 32-bit write: the top half cleared.
    list.push({ value: mergeRegisterWrite(before & LOW_32_BITS, dest, written), mistake })
  }

  // wrong-byte: bits 15 to 8 and bits 7 to 0 mixed up.
  if (dest.highByte) {
    list.push({
      value: mergeRegisterWrite(before, lowByteOf(base), written),
      mistake: {
        code: 'wrong-byte',
        message: `You put the byte in bits 7 to 0. \`${dest.name}\` means bits 15 to 8 of \`${base}\` (h for high).`,
      },
    })
  } else if (dest.size === 8) {
    const high = highByteOf(base)
    if (high !== undefined) {
      list.push({
        value: mergeRegisterWrite(before, high, written),
        mistake: {
          code: 'wrong-byte',
          message: `You put the byte in bits 15 to 8. \`${dest.name}\` means bits 7 to 0 of \`${base}\` (l for low).`,
        },
      })
    }
  }

  // stale-value: as if the copy went the other way (the destination keeps its old value),
  // or as if the destination's own old part were written.
  if (source.kind === 'register') {
    const mistake: Mistake = {
      code: 'stale-value',
      message: `You used the old value of \`${dest.name}\`. In \`${instruction(choice)}\` the destination comes first: \`${source.name.name}\` is copied into \`${dest.name}\`.`,
    }
    list.push({ value: before, mistake })
    list.push({ value: mergeRegisterWrite(before, dest, before >> BigInt(dest.shift)), mistake })
  }

  const seen = new Set<bigint>([facts.after])
  return list.filter((entry) => {
    if (seen.has(entry.value)) return false
    seen.add(entry.value)
    return true
  })
}

function makeDiagnose(wrong: readonly WrongValue[]): Problem['diagnose'] {
  return (answers) => {
    const answer = answers.after ?? ''
    return wrong.find((entry) => answer === canonicalHex(entry.value))?.mistake ?? null
  }
}

/* ─────────────────────────────── the problem ────────────────────────────── */

export function generateWithPredictions(seed: number): GeneratedProblem {
  const rng = createRng(seed)
  const choice = choose(rng)
  const facts = runIt(choice)
  const { dest, source } = choice
  const base = dest.base

  const shown = [{ name: base, value: facts.before }]
  if (source.kind === 'register') {
    shown.push({ name: source.name.base, value: facts.run.start.registers[source.name.base] })
  }
  const wrong = wrongValues(choice, facts)

  const problem: Problem = {
    id: `subregister-writes-${seed}`,
    topic: 'subregister-writes',
    seed,
    view: 'form',
    prompt: [
      registersBlock(shown, { title: 'Before' }),
      textBlock(
        `Then \`${instruction(choice)}\` runs. What is \`${base}\` now? Type all 16 hex digits.`,
      ),
    ],
    fields: [hexField('after', `${base} after the mov`, facts.after, { digits: 16 })],
    reason: reasonFor(choice, facts),
    stepper: {
      code: programFor(choice),
      options: optionsFor(choice),
      note: `Step once and watch \`${base}\`.`,
    },
    diagnose: makeDiagnose(wrong),
  }

  return {
    problem,
    predictions: wrong.map((entry) => ({
      code: entry.mistake.code,
      answers: { after: hex64(entry.value) },
    })),
  }
}

export const generate: ProblemGenerator = (seed) => generateWithPredictions(seed).problem
