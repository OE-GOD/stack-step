import { describe, expect, it } from 'vitest'
import { createEmulator, type Reg64 } from '../../../emulator'
import { checkProblem } from '../check'
import type { MistakeCode, Problem } from '../types'
import { generate, generateWithPredictions } from './subregister-writes'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)
const MASK64 = (1n << 64n) - 1n

/* ─────────────────── an independent answer key (no emulator) ─────────────────── */

interface NameByHand {
  base: string
  size: number
  shift: number
}

/** Every register name with its register, width and position, written out by hand. */
function namesByHand(): Map<string, NameByHand> {
  const names = new Map<string, NameByHand>()
  const add = (name: string, base: string, size: number, shift = 0) =>
    names.set(name, { base, size, shift })
  for (const letter of ['a', 'b', 'c', 'd']) {
    const base = `r${letter}x`
    add(base, base, 64)
    add(`e${letter}x`, base, 32)
    add(`${letter}x`, base, 16)
    add(`${letter}l`, base, 8)
    add(`${letter}h`, base, 8, 8)
  }
  for (const stem of ['si', 'di', 'bp', 'sp']) {
    const base = `r${stem}`
    add(base, base, 64)
    add(`e${stem}`, base, 32)
    add(stem, base, 16)
    add(`${stem}l`, base, 8)
  }
  for (let n = 8; n <= 15; n++) {
    const base = `r${n}`
    add(base, base, 64)
    add(`${base}d`, base, 32)
    add(`${base}w`, base, 16)
    add(`${base}b`, base, 8)
  }
  return names
}

const BY_HAND = namesByHand()

function nameByHand(name: string): NameByHand {
  const found = BY_HAND.get(name)
  if (found === undefined) throw new Error(`Unknown name ${name}`)
  return found
}

function mask(bits: number): bigint {
  return (1n << BigInt(bits)) - 1n
}

/** What a problem shows: the starting registers and the `mov` line. */
interface Shown {
  start: Record<string, bigint>
  dest: string
  source: string
}

function readProblem(problem: Problem): Shown {
  const [registers, text] = problem.prompt
  if (registers?.type !== 'registers' || text?.type !== 'text') {
    throw new Error('Expected a registers block, then a text block.')
  }
  const start: Record<string, bigint> = {}
  for (const row of registers.rows) start[row.name] = BigInt(row.value)
  const match =
    /^Then `mov (\w+), (\w+)` runs\. What is `(\w+)` now\? Type all 16 hex digits\.$/.exec(
      text.text,
    )
  if (match === null) throw new Error(`Unexpected text: ${text.text}`)
  return { start, dest: match[1], source: match[2] }
}

/** The x86-64 write rules with plain BigInt maths. */
function afterByHand({ start, dest, source }: Shown): bigint {
  const to = nameByHand(dest)
  let value: bigint
  if (source.startsWith('0x')) {
    value = BigInt(source)
  } else {
    const from = nameByHand(source)
    value = (start[from.base] >> BigInt(from.shift)) & mask(from.size)
  }
  const old = start[to.base]
  if (to.size === 64) return value & MASK64
  if (to.size === 32) return value & mask(32) // the top 32 bits become 0
  const hole = (mask(to.size) << BigInt(to.shift)) ^ MASK64
  return (old & hole) | ((value & mask(to.size)) << BigInt(to.shift))
}

/** The problem as plain data (JSON leaves out its function), so two problems can be compared. */
function asData(problem: Problem): unknown {
  return JSON.parse(
    JSON.stringify(problem, (_key, value: unknown) =>
      typeof value === 'bigint' ? `${value}n` : value,
    ),
  )
}

function typed(value: bigint): string {
  return `0x${value.toString(16).padStart(16, '0')}`
}

/* ──────────────────────────────────── tests ──────────────────────────────────── */

describe('subregister-writes', () => {
  it('is deterministic: the same seed gives the same problem', () => {
    for (const seed of [0, 1, 7, 42, 999, 2 ** 31 - 1]) {
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

  it('has the right id, topic, seed, view and one 16-digit hex field', () => {
    const problem = generate(8)
    expect(problem.id).toBe('subregister-writes-8')
    expect(problem.topic).toBe('subregister-writes')
    expect(problem.seed).toBe(8)
    expect(problem.view).toBe('form')
    expect(problem.fields).toHaveLength(1)
    expect(problem.fields[0]?.id).toBe('after')
    expect(problem.fields[0]?.kind).toEqual({ type: 'hex', digits: 16 })
    expect(problem.fields[0]?.expectedDisplay).toMatch(/^0x[0-9a-f]{16}$/)
  })

  it('accepts the right answer typed in every allowed way (500 seeds)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const shown = problem.fields[0]?.expectedDisplay ?? ''
      const digits = shown.slice(2)
      const spaced = digits.replace(/(.{4})(?!$)/g, '$1 ')
      const underscored = digits.replace(/(.{4})(?!$)/g, '$1_')
      for (const answer of [shown, digits, shown.toUpperCase(), `0x${spaced}`, underscored]) {
        expect(checkProblem(problem, { after: answer }).correct, `${problem.id}: ${answer}`).toBe(
          true,
        )
      }
    }
  })

  it('agrees with the write rules done by hand in BigInt maths (500 seeds)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const expected = BigInt(problem.fields[0]?.expectedDisplay ?? '')
      expect(expected, problem.id).toBe(afterByHand(readProblem(problem)))
    }
  })

  it('starts from values whose top half is not zero and whose halves differ', () => {
    for (const seed of SEEDS) {
      for (const value of Object.values(readProblem(generate(seed)).start)) {
        const top = value >> 32n
        const bottom = value & mask(32)
        expect(top).not.toBe(0n)
        expect(top).not.toBe(bottom)
      }
    }
  })

  it('names every predicted mistake, and no prediction is the right answer (500 seeds)', () => {
    for (const seed of SEEDS) {
      const { problem, predictions } = generateWithPredictions(seed)
      const right = problem.fields[0]?.expected
      const values = new Set<string>()
      for (const prediction of predictions) {
        const answer = prediction.answers.after ?? ''
        expect(answer).toMatch(/^0x[0-9a-f]{16}$/)
        expect(BigInt(answer).toString(16), problem.id).not.toBe(right)
        expect(values.has(answer), `${problem.id}: one value, one mistake`).toBe(false)
        values.add(answer)
        const result = checkProblem(problem, prediction.answers)
        expect(result.correct).toBe(false)
        expect(result.mistake?.code, `${problem.id}: ${answer}`).toBe(prediction.code)
      }
    }
  })

  it('predicts the mistakes each kind of write invites', () => {
    const seen = new Set<string>()
    for (const seed of SEEDS) {
      const { problem, predictions } = generateWithPredictions(seed)
      const shown = readProblem(problem)
      const dest = nameByHand(shown.dest)
      const codes = new Set<MistakeCode>(predictions.map((prediction) => prediction.code))
      const kind = dest.shift === 8 ? 'high8' : `${dest.size}`
      const fromRegister = !shown.source.startsWith('0x')
      seen.add(`${kind}:${fromRegister ? 'register' : 'number'}`)

      expect(codes.has('forgot-zero-upper'), problem.id).toBe(dest.size === 32)
      if (dest.size === 8 || dest.size === 16) {
        expect(codes.has('cleared-upper-wrongly'), problem.id).toBe(true)
      }
      if (dest.shift === 8 || (dest.size === 8 && /^r[abcd]x$/.test(dest.base))) {
        expect(codes.has('wrong-byte'), problem.id).toBe(true)
      }
      if (fromRegister) expect(codes.has('stale-value'), problem.id).toBe(true)
      else expect(codes.has('stale-value'), problem.id).toBe(false)
    }
    // Every kind of part, from a number and from a register.
    for (const kind of ['8', 'high8', '16', '32', '64']) {
      expect(seen.has(`${kind}:number`), kind).toBe(true)
      expect(seen.has(`${kind}:register`), kind).toBe(true)
    }
  })

  it('rarely copies a whole 64-bit register (its answer is in the question)', () => {
    let copies = 0
    for (let seed = 0; seed < 1000; seed++) {
      const shown = readProblem(generateWithPredictions(seed).problem)
      const dest = nameByHand(shown.dest)
      if (dest.size === 64 && !shown.source.startsWith('0x')) copies++
    }
    expect(copies).toBeGreaterThan(0)
    expect(copies).toBeLessThanOrEqual(25)
  })

  it('names the 32-bit slip with this problem’s numbers', () => {
    const seed = SEEDS.find((candidate) =>
      generateWithPredictions(candidate).predictions.some(
        (prediction) => prediction.code === 'forgot-zero-upper',
      ),
    )
    if (seed === undefined) throw new Error('No 32-bit write in 500 seeds.')
    const problem = generate(seed)
    const shown = readProblem(problem)
    const to = nameByHand(shown.dest)
    const right = afterByHand(shown)
    const keptTop = (shown.start[to.base] & (mask(32) << 32n)) | right
    const result = checkProblem(problem, { after: typed(keptTop) })
    expect(result.mistake?.code).toBe('forgot-zero-upper')
    const top = (shown.start[to.base] >> 32n).toString(16).padStart(8, '0')
    expect(result.mistake?.message).toContain(`0x${top}`)
    expect(result.mistake?.message).toContain(`\`${shown.dest}\``)
  })

  it('names nothing for a wrong answer that is no known slip', () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const problem = generate(seed)
      const right = BigInt(problem.fields[0]?.expectedDisplay ?? '')
      const result = checkProblem(problem, { after: typed((right + 1n) & MASK64) })
      expect(result.correct).toBe(false)
      expect(result.mistake).toBeNull()
    }
  })

  it('makes its "Show me" program run and end with the expected value (500 seeds)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const shown = readProblem(problem)
      const base = nameByHand(shown.dest).base as Reg64
      const created = createEmulator(problem.stepper.code, problem.stepper.options)
      expect(created.ok, problem.id).toBe(true)
      if (!created.ok) continue
      expect(created.diagnostics, problem.id).toEqual([])
      const start = created.emulator.getSnapshot()
      for (const [name, value] of Object.entries(shown.start)) {
        expect(start.registers[name as Reg64], `${problem.id}: ${name}`).toBe(value)
      }
      created.emulator.run()
      const end = created.emulator.getSnapshot()
      expect(end.status, problem.id).toBe('halted')
      expect(end.stepCount, problem.id).toBe(2) // the mov, then ret
      expect(end.registers[base], problem.id).toBe(BigInt(problem.fields[0]?.expectedDisplay ?? ''))
      expect(problem.stepper.code).toContain(`mov     ${shown.dest}, ${shown.source}`)
      expect(problem.stepper.note).toBe(`Step once and watch \`${base}\`.`)
    }
  })

  it('writes clean text: no undefined, NaN or [object, and a one-line reason', () => {
    for (const seed of SEEDS) {
      const { problem, predictions } = generateWithPredictions(seed)
      const messages = predictions.map(
        (prediction) => problem.diagnose(prediction.answers)?.message ?? '',
      )
      const text = JSON.stringify(
        [problem.prompt, problem.fields, problem.reason, problem.stepper.code, messages],
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString(16) : value),
      )
      expect(text).not.toMatch(/undefined|NaN|\[object/)
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
      expect(problem.reason).toContain(`\`${readProblem(problem).dest}\``)
    }
  })

  it('gives at least 200 different problems over seeds 0…999', () => {
    const seen = new Set<string>()
    for (let seed = 0; seed < 1000; seed++) {
      const problem = generate(seed)
      seen.add(JSON.stringify([problem.prompt, problem.fields[0]?.expected]))
    }
    expect(seen.size).toBeGreaterThanOrEqual(200)
  })

  it('copies from another register about one time in three', () => {
    let fromRegister = 0
    for (let seed = 0; seed < 1000; seed++) {
      if (!readProblem(generate(seed)).source.startsWith('0x')) fromRegister++
    }
    expect(fromRegister).toBeGreaterThan(250)
    expect(fromRegister).toBeLessThan(420)
  })
})
