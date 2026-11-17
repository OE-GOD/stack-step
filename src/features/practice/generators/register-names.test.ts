import { describe, expect, it } from 'vitest'
import { createEmulator } from '../../../emulator'
import { checkProblem } from '../check'
import type { Problem } from '../types'
import { generate, generateWithPredictions, SHOW_ME_VALUE } from './register-names'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)

/* ─────────────────── an independent answer key (no emulator) ─────────────────── */

/**
 * The naming rules, written out by hand from the course notes, so the generator's answers
 * (which come from the emulator's register table) are checked against something else.
 */
function nameOf(base: string, size: number, high = false): string {
  if (/^r\d+$/.test(base)) {
    return base + ({ 64: '', 32: 'd', 16: 'w', 8: 'b' } as Record<number, string>)[size]
  }
  const stem = base.slice(1) // ax, bx, cx, dx, si, di, bp, sp
  if (size === 64) return base
  if (size === 32) return `e${stem}`
  if (size === 16) return stem
  if (['ax', 'bx', 'cx', 'dx'].includes(stem)) return `${stem.charAt(0)}${high ? 'h' : 'l'}`
  return `${stem}l`
}

/** Every part name of a register: [name, size in bits, is it bits 15 to 8]. */
function partsByHand(base: string): [string, number, boolean][] {
  const parts: [string, number, boolean][] = [
    [nameOf(base, 32), 32, false],
    [nameOf(base, 16), 16, false],
    [nameOf(base, 8), 8, false],
  ]
  if (['rax', 'rbx', 'rcx', 'rdx'].includes(base)) parts.push([nameOf(base, 8, true), 8, true])
  return parts
}

const BASES = [
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

/** What a problem asks, read back from its prompt text. */
type Asked =
  | { form: 'name'; base: string; size: number; high: boolean; askedUnit: string }
  | { form: 'family'; part: string; askedUnit: string }
  | { form: 'high-low'; base: string }

function readQuestion(problem: Problem): Asked {
  const block = problem.prompt[0]
  if (block?.type !== 'text') throw new Error('The first block must be text.')
  const text = block.text
  let match = /^What is the name of the (\d+)-bit part of `(\w+)`\? How many (bits|bytes)/.exec(
    text,
  )
  if (match) {
    return {
      form: 'name',
      size: Number(match[1]),
      base: match[2],
      high: false,
      askedUnit: match[3],
    }
  }
  match = /^What is the name of the low (\d) bytes of `(\w+)`\? How many (bits|bytes)/.exec(text)
  if (match) {
    const size = Number(match[1]) * 8
    return { form: 'name', size, base: match[2], high: false, askedUnit: match[3] }
  }
  match = /^What is the name of the lowest byte of `(\w+)`\? How many (bits|bytes)/.exec(text)
  if (match) return { form: 'name', size: 8, base: match[1], high: false, askedUnit: match[2] }
  match = /^What is the name of bits (15 to 8|7 to 0) of `(\w+)`\? How many (bits|bytes)/.exec(text)
  if (match) {
    const high = match[1] === '15 to 8'
    return { form: 'name', size: 8, base: match[2], high, askedUnit: match[3] }
  }
  match = /^`(\w+)` is a part of which 64-bit register\? How many (bits|bytes)/.exec(text)
  if (match) return { form: 'family', part: match[1], askedUnit: match[2] }
  match = /^Which name means bits 15 to 8 of `(\w+)`\?/.exec(text)
  if (match) return { form: 'high-low', base: match[1] }
  throw new Error(`Unexpected prompt: ${text}`)
}

function expectedOf(problem: Problem): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const field of problem.fields) answers[field.id] = field.expected
  return answers
}

/** The problem as plain data (JSON leaves out its function), so two problems can be compared. */
function asData(problem: Problem): unknown {
  return JSON.parse(
    JSON.stringify(problem, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
    ),
  )
}

/* ──────────────────────────────────── tests ──────────────────────────────────── */

describe('register-names', () => {
  it('is deterministic: the same seed gives the same problem', () => {
    for (const seed of [0, 1, 7, 42, 999, 123456789]) {
      const a = generateWithPredictions(seed)
      const b = generateWithPredictions(seed)
      expect(asData(a.problem)).toEqual(asData(b.problem))
      expect(a.predictions).toEqual(b.predictions)
      for (const prediction of a.predictions) {
        expect(a.problem.diagnose(prediction.answers)).toEqual(
          b.problem.diagnose(prediction.answers),
        )
      }
    }
  })

  it('has the right id, topic, seed and view', () => {
    const problem = generate(31)
    expect(problem.id).toBe('register-names-31')
    expect(problem.topic).toBe('register-names')
    expect(problem.seed).toBe(31)
    expect(problem.view).toBe('form')
  })

  it('accepts the expected answers, also typed in upper case or with spaces (500 seeds)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      expect(checkProblem(problem, expectedOf(problem)).correct, problem.id).toBe(true)
      const shouted: Record<string, string> = {}
      for (const field of problem.fields)
        shouted[field.id] = ` ${field.expectedDisplay.toUpperCase()} `
      expect(checkProblem(problem, shouted).correct, problem.id).toBe(true)
    }
  })

  it('agrees with the naming rules written out by hand (500 seeds)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const answers = expectedOf(problem)
      const asked = readQuestion(problem)
      if (asked.form === 'name') {
        expect(answers.name, problem.id).toBe(nameOf(asked.base, asked.size, asked.high))
        const size = asked.askedUnit === 'bytes' ? asked.size / 8 : asked.size
        expect(answers[asked.askedUnit], problem.id).toBe(String(size))
      } else if (asked.form === 'family') {
        const owner = BASES.find((base) => partsByHand(base).some(([name]) => name === asked.part))
        expect(answers.base, problem.id).toBe(owner)
        const bits = partsByHand(owner ?? '').find(([name]) => name === asked.part)?.[1] ?? 0
        const size = asked.askedUnit === 'bytes' ? bits / 8 : bits
        expect(answers[asked.askedUnit], problem.id).toBe(String(size))
      } else {
        expect(['rax', 'rbx', 'rcx', 'rdx']).toContain(asked.base)
        expect(answers.high).toBe(nameOf(asked.base, 8, true))
        expect(answers.low).toBe(nameOf(asked.base, 8, false))
      }
    }
  })

  it('names every predicted mistake, and no prediction is the right answer (500 seeds)', () => {
    for (const seed of SEEDS) {
      const { problem, predictions } = generateWithPredictions(seed)
      expect(predictions.length).toBeGreaterThan(0)
      const codes = new Set(predictions.map((prediction) => prediction.code))
      expect(codes.has('wrong-part')).toBe(true)
      expect(codes.has('wrong-register-family')).toBe(true)
      for (const prediction of predictions) {
        const result = checkProblem(problem, prediction.answers)
        expect(result.correct, `${problem.id} ${JSON.stringify(prediction.answers)}`).toBe(false)
        expect(result.mistake?.code, `${problem.id} ${JSON.stringify(prediction.answers)}`).toBe(
          prediction.code,
        )
        expect(result.mistake?.message.length ?? 0).toBeGreaterThan(20)
      }
    }
  })

  it('predicts the bits/bytes slip in both directions', () => {
    const units = new Set<string>()
    for (const seed of SEEDS) {
      const { problem, predictions } = generateWithPredictions(seed)
      const slip = predictions.find((prediction) => prediction.code === 'bits-vs-bytes')
      if (slip === undefined) continue
      const sizeField = problem.fields.find((field) => field.kind.type === 'decimal')
      if (sizeField === undefined) throw new Error('A size question needs a decimal field.')
      units.add(sizeField.id)
      const message = checkProblem(problem, slip.answers).mistake?.message ?? ''
      expect(message).toContain(`asks for ${sizeField.id}`)
    }
    expect(units).toEqual(new Set(['bits', 'bytes']))
  })

  it('names the bits/bytes slip when a unit word is typed too ("32 bits", "32bits")', () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const { problem, predictions } = generateWithPredictions(seed)
      const slip = predictions.find((prediction) => prediction.code === 'bits-vs-bytes')
      const sizeField = problem.fields.find((field) => field.kind.type === 'decimal')
      if (slip === undefined || sizeField === undefined) continue
      const number = slip.answers[sizeField.id]
      const otherUnit = sizeField.id === 'bytes' ? 'bits' : 'bytes'
      for (const typed of [`${number} ${otherUnit}`, `${number}${otherUnit}`, ` ${number} BITS `]) {
        const result = checkProblem(problem, { ...slip.answers, [sizeField.id]: typed })
        expect(result.mistake?.code, `${problem.id}: "${typed}"`).toBe('bits-vs-bytes')
      }
    }
  })

  it('writes plain English for one byte: "1 byte is 8 bits"', () => {
    for (const seed of SEEDS) {
      const { problem, predictions } = generateWithPredictions(seed)
      const slip = predictions.find((prediction) => prediction.code === 'bits-vs-bytes')
      if (slip === undefined) continue
      const message = checkProblem(problem, slip.answers).mistake?.message ?? ''
      expect(message).not.toMatch(/\b1 byte are\b|\b1 bits\b|\b1 bytes\b/)
      if (problem.fields.some((field) => field.id === 'bits' && field.expected === '8')) {
        expect(message).toContain('so 1 byte is 8 bits.')
      }
    }
  })

  it('never calls a right field a mistake: a wrong size alone is not "wrong part"', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const problem = generate(seed)
      const answers = expectedOf(problem)
      const size = problem.fields.find((field) => field.kind.type === 'decimal')
      if (size === undefined) continue
      // 3 is never a size in bits or in bytes, so it is no known slip.
      const result = checkProblem(problem, { ...answers, [size.id]: '3' })
      expect(result.correct).toBe(false)
      expect(result.mistake).toBeNull()
    }
  })

  it('explains names that are not registers, and does not repeat a long answer', () => {
    // The first "name + size" question about r8.
    const seed = SEEDS.find((candidate) => {
      const asked = readQuestion(generate(candidate))
      return asked.form === 'name' && asked.base === 'r8'
    })
    if (seed === undefined) throw new Error('No question about r8 in 500 seeds.')
    const problem = generate(seed)
    const answers = expectedOf(problem)
    expect(problem.diagnose({ ...answers, name: 'r8x' })?.message).toMatch(
      /^`r8x` is not a register name the assembler knows\. The parts of `r8` are `r8d` \(32 bits\), `r8w` \(16 bits\) and `r8b` \(8 bits\)\.$/,
    )
    const long = problem.diagnose({ ...answers, name: 'this is not a name at all' })
    expect(long?.code).toBe('wrong-register-family')
    expect(long?.message.startsWith('That is not a register name the assembler knows.')).toBe(true)
    expect(problem.diagnose({ ...answers, name: 'rip' })?.message).toContain(
      'not one of the 16 general registers',
    )
    expect(problem.diagnose({ ...answers, name: 'r`8`x' })?.message).not.toContain('``')
  })

  it('makes its "Show me" program run and show the named part (500 seeds)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const created = createEmulator(problem.stepper.code, problem.stepper.options)
      expect(created.ok, problem.id).toBe(true)
      if (!created.ok) continue
      expect(created.diagnostics, problem.id).toEqual([])
      const emulator = created.emulator
      emulator.run()
      const end = emulator.getSnapshot()
      expect(end.status, problem.id).toBe('halted')

      const answers = expectedOf(problem)
      const asked = readQuestion(problem)
      const base = asked.form === 'family' ? answers.base : asked.base
      // Every register but rsp gets the easy-to-read value; rsp keeps its stack address.
      const shown = base === 'rsp' ? end.registers.rsp : SHOW_ME_VALUE
      expect(emulator.readRegister(base), problem.id).toBe(shown)
      // The part the answer names holds its slice of that value (plain BigInt maths).
      const named =
        asked.form === 'family' ? asked.part : asked.form === 'name' ? answers.name : answers.high
      const part = partsByHand(base).find(([name]) => name === named)
      expect(part, problem.id).toBeDefined()
      if (part !== undefined) {
        const [, size, high] = part
        const slice = (shown >> (high ? 8n : 0n)) & ((1n << BigInt(size)) - 1n)
        expect(emulator.readRegister(named), problem.id).toBe(slice)
      }
      expect(problem.stepper.note).toMatch(/tap or click `r\w+` to see its parts/)
    }
  })

  it('writes clean text: no undefined, NaN or [object, and a one-line reason', () => {
    for (const seed of SEEDS) {
      const { problem, predictions } = generateWithPredictions(seed)
      const messages = predictions.map(
        (prediction) => problem.diagnose(prediction.answers)?.message ?? '',
      )
      const text = JSON.stringify([
        problem.prompt,
        problem.fields,
        problem.reason,
        problem.stepper,
        messages,
      ])
      expect(text).not.toMatch(/undefined|NaN|\[object/)
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
    }
  })

  it('gives at least 200 different problems over seeds 0…999', () => {
    const seen = new Set<string>()
    for (let seed = 0; seed < 1000; seed++) {
      const problem = generate(seed)
      seen.add(JSON.stringify([problem.prompt, expectedOf(problem)]))
    }
    expect(seen.size).toBeGreaterThanOrEqual(200)
  })

  it('asks every one of its 208 questions somewhere in seeds 0…4999', () => {
    // name + size: 52 parts given in bits, 48 given in bytes (not bits 15 to 8);
    // family + size: 52 parts × 2 units; high + low: 4 registers.
    const seen = new Set<string>()
    for (let seed = 0; seed < 5000; seed++) {
      const block = generate(seed).prompt[0]
      if (block?.type === 'text') seen.add(block.text)
    }
    expect(seen.size).toBe(52 + 48 + 52 * 2 + 4)
  })
})
