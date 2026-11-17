/**
 * Tests of the `homework-table` generator (the trace table).
 *
 * The generator gets its answer key from the emulator. These tests check that key a
 * second time with a small model of the registers written here: its own table of
 * register names and plain BigInt maths, no emulator. The model also predicts every
 * tempting wrong chip, so each wrong chip in a problem must be one of its predictions,
 * and every named mistake must match. Then the stepper payload is stepped in the real
 * emulator, to see that "Show me" shows the same values.
 */
import { describe, expect, it } from 'vitest'
import { createEmulator } from '../../../emulator'
import { checkProblem } from '../check'
import type { MistakeCode, Problem } from '../types'
import { generate } from './homework-table'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)
const VARIETY_SEEDS = Array.from({ length: 1000 }, (_, seed) => seed)

/* ─────────────────── A model of the registers (independent of the app) ─────────────────── */

const MASK = { 8: 0xffn, 16: 0xffffn, 32: 0xffff_ffffn, 64: 0xffff_ffff_ffff_ffffn } as const
type Bits = keyof typeof MASK

interface Name {
  base: string
  bits: Bits
  /** 8 for ah, bh, ch, dh (bits 15–8), else 0. */
  shift: bigint
}

const NAMES = new Map<string, Name>()
for (const letter of ['a', 'b', 'c', 'd']) {
  const base = `r${letter}x`
  NAMES.set(base, { base, bits: 64, shift: 0n })
  NAMES.set(`e${letter}x`, { base, bits: 32, shift: 0n })
  NAMES.set(`${letter}x`, { base, bits: 16, shift: 0n })
  NAMES.set(`${letter}l`, { base, bits: 8, shift: 0n })
  NAMES.set(`${letter}h`, { base, bits: 8, shift: 8n })
}
for (const stem of ['si', 'di']) {
  const base = `r${stem}`
  NAMES.set(base, { base, bits: 64, shift: 0n })
  NAMES.set(`e${stem}`, { base, bits: 32, shift: 0n })
  NAMES.set(stem, { base, bits: 16, shift: 0n })
  NAMES.set(`${stem}l`, { base, bits: 8, shift: 0n })
}
for (let number = 8; number <= 15; number++) {
  const base = `r${number}`
  NAMES.set(base, { base, bits: 64, shift: 0n })
  NAMES.set(`${base}d`, { base, bits: 32, shift: 0n })
  NAMES.set(`${base}w`, { base, bits: 16, shift: 0n })
  NAMES.set(`${base}b`, { base, bits: 8, shift: 0n })
}

function nameOf(text: string): Name {
  const found = NAMES.get(text)
  if (found === undefined) throw new Error(`The model does not know the register '${text}'.`)
  return found
}

type Registers = Record<string, bigint>

function read(registers: Registers, name: string): bigint {
  const { base, bits, shift } = nameOf(name)
  return ((registers[base] ?? 0n) >> shift) & MASK[bits]
}

/** A 64-bit or 32-bit name replaces the whole register; 8/16-bit names keep the other bits. */
function write(registers: Registers, name: string, value: bigint): void {
  const { base, bits, shift } = nameOf(name)
  const part = value & MASK[bits]
  if (bits === 64 || bits === 32) {
    registers[base] = part
    return
  }
  const hole = ~(MASK[bits] << shift) & MASK[64]
  registers[base] = ((registers[base] ?? 0n) & hole) | (part << shift)
}

function isRegister(text: string): boolean {
  return NAMES.has(text)
}

/** A number as the code writes it: decimal (5) or hex (0x1f). */
function number(text: string): bigint {
  if (!/^(0x[0-9a-f]+|[0-9])$/.test(text))
    throw new Error(`Not a number the model expects: ${text}`)
  return BigInt(text)
}

interface Parsed {
  mnemonic: string
  dest: string
  /** The second operand as written ('' when there is none). */
  source: string
}

function parse(line: string): Parsed {
  const match = /^([a-z]+) ([^,]+)(?:, (.+))?$/.exec(line)
  if (match === null) throw new Error(`The model cannot read the line '${line}'.`)
  return { mnemonic: match[1], dest: match[2], source: match[3] ?? '' }
}

/** The registers inside `[rbx+rcx*4+0x10]`. */
function addressRegisters(expression: string): string[] {
  return expression
    .slice(1, -1)
    .split('+')
    .map((term) => term.split('*')[0])
    .filter(isRegister)
}

/** The sum inside `[…]`, the long way (it may be more than 64 bits hold). */
function addressSum(registers: Registers, expression: string): bigint {
  if (!expression.startsWith('[') || !expression.endsWith(']')) {
    throw new Error(`Not an address: ${expression}`)
  }
  return expression
    .slice(1, -1)
    .split('+')
    .map((term) => {
      const [left, scale] = term.split('*')
      const value = isRegister(left) ? read(registers, left) : number(left)
      return scale === undefined ? value : value * number(scale)
    })
    .reduce((sum, value) => sum + value, 0n)
}

function addressValue(registers: Registers, expression: string): bigint {
  return addressSum(registers, expression) & MASK[64]
}

function sourceValue(registers: Registers, source: string): bigint {
  return isRegister(source) ? read(registers, source) : number(source)
}

/** The register names a line reads: sources, the registers of an address, and the destination of `add` and the like. */
function readsOf(line: string): string[] {
  const { mnemonic, dest, source } = parse(line)
  const sources =
    mnemonic === 'lea'
      ? addressRegisters(source)
      : source === '' || !isRegister(source)
        ? []
        : [source]
  if (mnemonic === 'xor' && dest === source) return []
  const readsDest = ['add', 'sub', 'and', 'or', 'xor', 'inc', 'dec'].includes(mnemonic)
  return readsDest ? [dest, ...sources] : sources
}

/** Run one line on a copy of the registers. */
function runLine(start: Registers, line: string): Registers {
  const registers = { ...start }
  const { mnemonic, dest, source } = parse(line)
  const now = () => read(registers, dest)
  switch (mnemonic) {
    case 'mov':
    case 'movzx':
      write(registers, dest, sourceValue(registers, source))
      break
    case 'lea':
      write(registers, dest, addressValue(registers, source))
      break
    case 'add':
      write(registers, dest, now() + sourceValue(registers, source))
      break
    case 'sub':
      write(registers, dest, now() - sourceValue(registers, source))
      break
    case 'and':
      write(registers, dest, now() & sourceValue(registers, source))
      break
    case 'or':
      write(registers, dest, now() | sourceValue(registers, source))
      break
    case 'xor':
      write(registers, dest, now() ^ sourceValue(registers, source))
      break
    case 'inc':
      write(registers, dest, now() + 1n)
      break
    case 'dec':
      write(registers, dest, now() - 1n)
      break
    default:
      throw new Error(`The model does not know the instruction '${mnemonic}'.`)
  }
  return registers
}

/**
 * The result of a line worked out with no wraparound: null when its sum goes past the top
 * of the part it writes, or below 0 (0x5 − 0x8). The other lines cannot wrap around.
 */
function exactResult(registers: Registers, line: string): bigint | null {
  const { mnemonic, dest, source } = parse(line)
  const now = read(registers, dest)
  const fits = (value: bigint) => (value >= 0n && value <= MASK[nameOf(dest).bits] ? value : null)
  switch (mnemonic) {
    case 'add':
      return fits(now + sourceValue(registers, source))
    case 'sub':
      return fits(now - sourceValue(registers, source))
    case 'inc':
      return fits(now + 1n)
    case 'dec':
      return fits(now - 1n)
    case 'lea': {
      const sum = addressSum(registers, source)
      return sum <= MASK[64] ? sum : null
    }
    default:
      return read(runLine(registers, line), dest)
  }
}

function label(register: string, value: bigint): string {
  return `${register} = 0x${value.toString(16).padStart(16, '0')}`
}

/* ───────────────────────── reading a problem with the model ───────────────────────── */

type Kind = 'forgot-zero-upper' | 'stale-value' | 'cleared-upper-wrongly' | 'wrong-register'

interface Prediction {
  /** 1-based line. */
  line: number
  kind: Kind
  label: string
}

interface Traced {
  shown: string[]
  start: Registers
  lines: readonly string[]
  /** states[k] = the registers after k lines. */
  states: Registers[]
  /** For each line: the register that changed (the model says), its new value, its chip label. */
  changed: { register: string; value: bigint; label: string }[]
  predictions: Prediction[]
}

function trace(problem: Problem): Traced {
  const registersBlock = problem.prompt.find((block) => block.type === 'registers')
  const codeBlock = problem.prompt.find((block) => block.type === 'code')
  if (registersBlock?.type !== 'registers' || codeBlock?.type !== 'code') {
    throw new Error(`${problem.id} has no registers or no code.`)
  }
  const shown = registersBlock.rows.map((row) => row.name)
  const start: Registers = {}
  for (const row of registersBlock.rows) start[row.name] = BigInt(row.value)

  const states: Registers[] = [start]
  const changed: Traced['changed'] = []
  for (const line of codeBlock.lines) {
    const before = states[states.length - 1]
    const after = runLine(before, line)
    states.push(after)
    const different = Object.keys(after).filter((name) => after[name] !== before[name])
    // Exactly one register changes, and it is one of the shown ones.
    expect(different, `${problem.id}: ${line}`).toHaveLength(1)
    const register = different[0]
    expect(shown, `${problem.id}: ${line}`).toContain(register)
    changed.push({ register, value: after[register], label: label(register, after[register]) })
  }

  const predictions: Prediction[] = []
  codeBlock.lines.forEach((line, index) => {
    const lineNumber = index + 1
    const before = states[index]
    const { register, value } = changed[index]
    const dest = nameOf(parse(line).dest)
    const old = before[register]

    // 32-bit write: the old top half kept.
    if (dest.bits === 32 && old >> 32n !== 0n) {
      const kept = (old & ~MASK[32] & MASK[64]) | (value & MASK[32])
      predictions.push({
        line: lineNumber,
        kind: 'forgot-zero-upper',
        label: label(register, kept),
      })
    }
    // 8/16-bit write: every other bit cleared.
    if (dest.bits === 8 || dest.bits === 16) {
      const cleared = value & (MASK[dest.bits] << dest.shift)
      if (cleared !== value) {
        predictions.push({
          line: lineNumber,
          kind: 'cleared-upper-wrongly',
          label: label(register, cleared),
        })
      }
    }
    // A register the line reads, with its value from before the last change to it.
    for (const name of readsOf(line)) {
      const base = nameOf(name).base
      let lastChange = -1
      for (let earlier = 0; earlier < index; earlier++) {
        if (changed[earlier].register === base) lastChange = earlier
      }
      if (lastChange < 0) continue
      const stale = runLine({ ...before, [base]: states[lastChange][base] }, line)[register]
      if (stale !== value) {
        predictions.push({ line: lineNumber, kind: 'stale-value', label: label(register, stale) })
      }
    }
    // The right value on another shown register that does not hold it.
    for (const other of shown) {
      if (other !== register && states[index + 1][other] !== value) {
        predictions.push({ line: lineNumber, kind: 'wrong-register', label: label(other, value) })
      }
    }
  })

  return { shown, start, lines: codeBlock.lines, states, changed, predictions }
}

function rightAnswers(problem: Problem): Record<string, string> {
  return Object.fromEntries(problem.fields.map((field) => [field.id, field.expected]))
}

function chipLabel(problem: Problem, chipId: string): string {
  return problem.chips?.find((chip) => chip.id === chipId)?.label ?? ''
}

/** Every text a student can read in a problem, including every mistake message. */
function allTexts(problem: Problem): string[] {
  const texts: string[] = [problem.reason, problem.stepper.code, problem.stepper.note ?? '']
  for (const block of problem.prompt) {
    if (block.type === 'text') texts.push(block.text)
    if (block.type === 'code') texts.push(...block.lines)
    if (block.type === 'registers') {
      texts.push(block.title ?? '', ...block.rows.flatMap((row) => [row.name, row.value]))
    }
  }
  for (const field of problem.fields) texts.push(field.label, field.expectedDisplay)
  for (const chip of problem.chips ?? []) {
    texts.push(chip.label)
    for (const field of problem.fields) {
      const mistake = problem.diagnose({ ...rightAnswers(problem), [field.id]: chip.id })
      if (mistake !== null) texts.push(mistake.message)
    }
  }
  return texts
}

const PROBLEMS = new Map(SEEDS.map((seed) => [seed, generate(seed)]))

function problemOf(seed: number): Problem {
  const problem = PROBLEMS.get(seed)
  if (problem === undefined) throw new Error(`No problem for seed ${seed}.`)
  return problem
}

/* ─────────────────────────────────── the tests ─────────────────────────────────── */

describe('the model of this test', () => {
  // Worked out by hand, so the model itself is checked before it checks anything else.
  const start: Registers = { rax: 0x1111222233334444n, rbx: 0x5555666677778888n, rcx: 0x3n }

  it('follows the write rules of x86-64', () => {
    expect(runLine(start, 'mov eax, 5').rax).toBe(0x5n)
    expect(runLine(start, 'mov ax, 0x1234').rax).toBe(0x1111222233331234n)
    expect(runLine(start, 'mov al, 0x7f').rax).toBe(0x111122223333447fn)
    expect(runLine(start, 'mov ah, 0x7f').rax).toBe(0x1111222233337f44n)
    expect(runLine(start, 'add ah, 8').rax).toBe(0x1111222233334c44n)
    expect(runLine(start, 'xor eax, eax').rax).toBe(0n)
    expect(runLine(start, 'movzx eax, bl').rax).toBe(0x88n)
    expect(runLine(start, 'movzx rcx, bx').rcx).toBe(0x8888n)
    // 0x4444 + 3 × 4 + 0x10 = 0x4444 + 0x1c = 0x4460
    expect(runLine(start, 'lea rcx, [rax+rcx*4+0x10]').rcx).toBe(0x1111222233334460n)
    expect(runLine(start, 'sub cx, 1').rcx).toBe(0x2n)
    expect(runLine(start, 'and ebx, 0xff00').rbx).toBe(0x8800n)
    expect(runLine(start, 'or rcx, 0x80').rcx).toBe(0x83n)
    expect(runLine(start, 'dec eax').rax).toBe(0x33334443n)
  })

  it('lists what a line reads', () => {
    expect(readsOf('add rbx, rax')).toEqual(['rbx', 'rax'])
    expect(readsOf('mov edx, ecx')).toEqual(['ecx'])
    expect(readsOf('lea rsi, [rax+rdx*4+0x10]')).toEqual(['rax', 'rdx'])
    expect(readsOf('xor eax, eax')).toEqual([])
    expect(readsOf('inc al')).toEqual(['al'])
    expect(readsOf('mov cl, 0x7f')).toEqual([])
  })
})

describe('homework-table problems', () => {
  it('have the shape the trace table expects', () => {
    for (const seed of SEEDS) {
      const problem = problemOf(seed)
      expect(problem.id).toBe(`homework-table-${seed}`)
      expect(problem.topic).toBe('homework-table')
      expect(problem.seed).toBe(seed)
      expect(problem.view).toBe('trace-table')

      expect(problem.prompt.filter((block) => block.type === 'text')).toHaveLength(1)
      expect(problem.prompt.filter((block) => block.type === 'code')).toHaveLength(1)
      const { shown, lines } = trace(problem)
      expect([3, 4]).toContain(shown.length)
      expect(new Set(shown).size).toBe(shown.length)
      expect(lines).toHaveLength(5)
      const registersBlock = problem.prompt.find((block) => block.type === 'registers')
      if (registersBlock?.type !== 'registers') throw new Error('No registers block.')
      for (const row of registersBlock.rows) expect(row.value).toMatch(/^0x[0-9a-f]{16}$/)

      expect(problem.fields.map((field) => field.id)).toEqual([
        'line1',
        'line2',
        'line3',
        'line4',
        'line5',
      ])
      expect(problem.fields.map((field) => field.label)).toEqual([
        'Line 1',
        'Line 2',
        'Line 3',
        'Line 4',
        'Line 5',
      ])
      for (const field of problem.fields) expect(field.kind).toEqual({ type: 'chip' })

      const chips = problem.chips ?? []
      expect([8, 9]).toContain(chips.length)
      expect(new Set(chips.map((chip) => chip.id)).size).toBe(chips.length)
      expect(new Set(chips.map((chip) => chip.label)).size).toBe(chips.length)
      for (const chip of chips) {
        expect(chip.id).not.toBe('')
        expect(chip.id.startsWith('trace-table:')).toBe(false)
        // The trace table fits labels of this form: a 64-bit name and all 16 digits.
        expect(chip.label).toMatch(/^[a-z0-9]{2,3} = 0x[0-9a-f]{16}$/)
      }
      // Each right chip is a different chip.
      expect(new Set(problem.fields.map((field) => field.expected)).size).toBe(5)
    }
  })

  it('use only register and number operands with the instructions of the specification', () => {
    const allowed = ['mov', 'movzx', 'lea', 'add', 'sub', 'inc', 'dec', 'xor', 'and', 'or']
    for (const seed of SEEDS) {
      for (const line of trace(problemOf(seed)).lines) {
        const { mnemonic, dest, source } = parse(line)
        expect(allowed, line).toContain(mnemonic)
        expect(isRegister(dest), line).toBe(true)
        if (mnemonic === 'lea') expect(source).toMatch(/^\[[a-z0-9+*]+\]$/)
        else expect(source.includes('['), line).toBe(false)
      }
    }
  })

  it('have the right chip on every line, by the independent model', () => {
    for (const seed of SEEDS) {
      const problem = problemOf(seed)
      const { changed } = trace(problem)
      problem.fields.forEach((field, index) => {
        expect(chipLabel(problem, field.expected), `${problem.id} line ${index + 1}`).toBe(
          changed[index].label,
        )
        expect(field.expectedDisplay).toBe(changed[index].label)
      })
    }
  })

  it('always have a 32-bit write onto a register whose top half is not zero', () => {
    for (const seed of SEEDS) {
      const { lines, states, changed } = trace(problemOf(seed))
      const found = lines.some((line, index) => {
        const register = changed[index].register
        return nameOf(parse(line).dest).bits === 32 && states[index][register] >> 32n !== 0n
      })
      expect(found, `seed ${seed}`).toBe(true)
    }
  })

  it('always have a line that reads a register an earlier line changed', () => {
    for (const seed of SEEDS) {
      // The model predicts a stale-value chip only for such a line (and only when the old
      // value would give another result).
      const { predictions } = trace(problemOf(seed))
      expect(predictions.some((prediction) => prediction.kind === 'stale-value')).toBe(true)
    }
  })

  it('use every shown register in the code', () => {
    for (const seed of SEEDS) {
      const { shown, lines } = trace(problemOf(seed))
      for (const register of shown) {
        const used = lines.some((line) =>
          [parse(line).dest, ...readsOf(line)].some((name) => nameOf(name).base === register),
        )
        expect(used, `seed ${seed}: ${register}`).toBe(true)
      }
    }
  })

  it('accept the right chips and name the blank parts', () => {
    for (const seed of SEEDS) {
      const problem = problemOf(seed)
      const right = checkProblem(problem, rightAnswers(problem))
      expect(right.correct).toBe(true)
      expect(right.mistake).toBeNull()

      const blank = checkProblem(problem, {})
      expect(blank.correct).toBe(false)
      expect(blank.mistake?.code).toBe('unanswered')

      const one = checkProblem(problem, { ...rightAnswers(problem), line4: '' })
      expect(one.correct).toBe(false)
      expect(one.mistake?.message).toContain('"Line 4"')
    }
  })

  it('have only wrong chips that the model predicts, with the mistakes it predicts', () => {
    const codeOf: Record<Kind, MistakeCode | null> = {
      'forgot-zero-upper': 'forgot-zero-upper',
      'stale-value': 'stale-value',
      'cleared-upper-wrongly': 'cleared-upper-wrongly',
      'wrong-register': null,
    }
    for (const seed of SEEDS) {
      const problem = problemOf(seed)
      const { changed, predictions } = trace(problem)
      const rightIds = new Set(problem.fields.map((field) => field.expected))
      const wrong = (problem.chips ?? []).filter((chip) => !rightIds.has(chip.id))
      expect([3, 4]).toContain(wrong.length)

      const named = new Set<MistakeCode>()
      for (const chip of wrong) {
        // Never a right answer: no right chip has this label.
        expect(changed.map((entry) => entry.label)).not.toContain(chip.label)
        const explained = predictions.filter((prediction) => prediction.label === chip.label)
        expect(explained.length, `${problem.id}: ${chip.label}`).toBeGreaterThan(0)

        for (const field of problem.fields) {
          const result = checkProblem(problem, { ...rightAnswers(problem), [field.id]: chip.id })
          expect(result.correct).toBe(false)
          if (result.mistake === null) continue
          // A named mistake is always one the model predicts for this chip on this line.
          const line = Number(field.id.slice(4))
          const match = explained.find(
            (prediction) =>
              prediction.line === line && codeOf[prediction.kind] === result.mistake?.code,
          )
          expect(match, `${problem.id}: ${chip.label} on ${field.id}`).toBeDefined()
          named.add(result.mistake.code)
        }
      }

      // The two mistakes every problem has, and the third when an 8/16-bit line keeps bits.
      expect(named.has('forgot-zero-upper'), problem.id).toBe(true)
      expect(named.has('stale-value'), problem.id).toBe(true)
      const canClear = predictions.some((prediction) => prediction.kind === 'cleared-upper-wrongly')
      expect(named.has('cleared-upper-wrongly'), problem.id).toBe(canClear)
    }
  })

  it('never make a tempting chip from a sum that wraps around (0x5 − 0x8 = 0xff…fd)', () => {
    // Seed 743 once had the stale chip `rdx = 0xffffffffffffffff`: hard to work out on
    // paper, unlike every right value. The model redoes each stale chip's line with the
    // old value and no wraparound at all: the chip must be that exact sum.
    let checked = 0
    for (let seed = 0; seed < 1000; seed++) {
      const problem = PROBLEMS.get(seed) ?? generate(seed)
      const { lines, states, changed } = trace(problem)
      for (const field of problem.fields) {
        for (const chip of problem.chips ?? []) {
          const mistake = problem.diagnose({ ...rightAnswers(problem), [field.id]: chip.id })
          if (mistake?.code !== 'stale-value') continue
          const index = Number(field.id.slice(4)) - 1
          const line = lines[index]
          // The register the line reads that an earlier line changed, back at its old value.
          const stale = readsOf(line)
            .map((name) => nameOf(name).base)
            .map((base) => {
              let last = -1
              for (let earlier = 0; earlier < index; earlier++) {
                if (changed[earlier].register === base) last = earlier
              }
              return last < 0 ? null : { ...states[index], [base]: states[last][base] }
            })
            .filter((registers) => registers !== null)
            .map((registers) => ({ registers, exact: exactResult(registers, line) }))
            .find(({ registers }) => {
              const after = runLine(registers, line)[changed[index].register]
              return label(changed[index].register, after) === chip.label
            })
          expect(stale, `${problem.id}: ${chip.label} on ${field.id}`).toBeDefined()
          expect(stale?.exact, `${problem.id}: ${line} wraps around`).not.toBeNull()
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(1000)
  })

  it('name the mistake with the numbers of the problem', () => {
    for (const seed of SEEDS) {
      const problem = problemOf(seed)
      const { lines, states, changed } = trace(problem)
      for (const chip of problem.chips ?? []) {
        for (const field of problem.fields) {
          const mistake = problem.diagnose({ ...rightAnswers(problem), [field.id]: chip.id })
          if (mistake === null) continue
          const index = Number(field.id.slice(4)) - 1
          const line = lines[index]
          const dest = parse(line).dest
          const register = changed[index].register
          expect(mistake.message).toContain(`line ${index + 1} `)
          expect(mistake.message.split('. ').length).toBeLessThanOrEqual(2)

          if (mistake.code === 'forgot-zero-upper' || mistake.code === 'cleared-upper-wrongly') {
            expect(mistake.message).toContain(` \`${register}\`.`)
            expect(mistake.message).toContain(`\`${dest}\``)
          }
          if (mistake.code === 'stale-value') {
            // "… an old value of <name>. Line <j> changed <name> to <value>."
            const facts =
              /old value of (`?)([a-z0-9]+)\1\. Line (\d) changed \1\2\1 to 0x([0-9a-f]+)\./.exec(
                mistake.message,
              )
            if (facts === null) throw new Error(`Unexpected message: ${mistake.message}`)
            const name = facts[2]
            const earlier = Number(facts[3]) - 1
            const base = nameOf(name).base
            // The name (in backticks, like all code) is read by the line, or it is the whole
            // register of an 8/16-bit destination, whose result depends on the bits it keeps.
            expect(facts[1]).toBe('`')
            const whole = name === nameOf(dest).base && nameOf(dest).bits <= 16
            expect(readsOf(line).includes(name) || whole, mistake.message).toBe(true)
            // Line <j> is the last line before this one that changed that register…
            expect(changed[earlier].register).toBe(base)
            for (let between = earlier + 1; between < index; between++) {
              expect(changed[between].register).not.toBe(base)
            }
            // … and <value> is what that name holds after line <j>.
            expect(BigInt(`0x${facts[4]}`)).toBe(read(states[earlier + 1], name))
            expect(read(states[earlier], name)).not.toBe(read(states[earlier + 1], name))
          }
        }
      }
    }
  })

  it('give a stepper program that shows the same values, step by step', () => {
    for (const seed of SEEDS) {
      const problem = problemOf(seed)
      const { start, lines, changed } = trace(problem)
      const code = problem.stepper.code.split('\n').map((line) => line.trim())
      expect(code.slice(0, 3)).toEqual(['.intel_syntax noprefix', '.globl main', 'main:'])
      expect(code.slice(3, 8)).toEqual([...lines])
      expect(code[8]).toBe('ret')
      expect(problem.stepper.options?.initialRegisters).toEqual(start)
      expect(problem.stepper.note).toMatch(/^Step one line at a time and watch [^.]+\.$/)

      const created = createEmulator(problem.stepper.code, problem.stepper.options)
      if (!created.ok) throw new Error(`${problem.id}: the stepper program does not assemble.`)
      const emulator = created.emulator
      changed.forEach(({ register, value }, index) => {
        const result = emulator.step()
        expect(result.line, problem.id).toBe(4 + index)
        expect(result.diff.registers.map((change) => change.reg)).toEqual([register])
        expect(emulator.getSnapshot().registers[register as 'rax']).toBe(value)
      })
      emulator.step()
      expect(emulator.getSnapshot().status).toBe('halted')
    }
  })

  it('are the same problem for the same seed', () => {
    for (const seed of SEEDS) {
      // Two fresh calls (the cached problem is a third one, so three calls agree).
      const first = generate(seed)
      const second = generate(seed)
      expect({ ...first, diagnose: null }).toEqual({ ...problemOf(seed), diagnose: null })
      expect({ ...second, diagnose: null }).toEqual({ ...first, diagnose: null })
      for (const chip of first.chips ?? []) {
        for (const field of first.fields) {
          const answers = { ...rightAnswers(first), [field.id]: chip.id }
          expect(second.diagnose(answers)).toEqual(first.diagnose(answers))
        }
      }
    }
  })

  it('have clean text: no undefined, NaN, [object or raw bigint, and a one-line reason', () => {
    for (const seed of SEEDS) {
      const problem = problemOf(seed)
      for (const text of allTexts(problem)) {
        expect(text).not.toMatch(/undefined|NaN|\[object|\b\d+n\b/)
      }
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
      // The reason states the 32-bit rule, on a line where it matters, with its numbers.
      const { lines, states, changed } = trace(problem)
      const index =
        Number(/Line (\d): writing `[a-z0-9]+` \(32 bits\)/.exec(problem.reason)?.[1]) - 1
      const line = lines[index]
      expect(line, problem.reason).toBeDefined()
      const dest = parse(line).dest
      const { register, value } = changed[index]
      expect(nameOf(dest).bits).toBe(32)
      expect(states[index][register] >> 32n).not.toBe(0n)
      expect(problem.reason).toContain(`\`${dest}\` (32 bits)`)
      expect(problem.reason).toContain(`top 32 bits of \`${register}\`,`)
      expect(problem.reason).toContain(`so \`${register}\` = 0x${value.toString(16)}.`)
    }
  })

  it('vary enough over seeds 0 … 999, with every kind of line and chip', () => {
    const problems = VARIETY_SEEDS.map((seed) => PROBLEMS.get(seed) ?? generate(seed))
    const distinct = new Set(
      problems.map((problem) =>
        JSON.stringify([problem.prompt, (problem.chips ?? []).map((chip) => chip.label)]),
      ),
    )
    expect(distinct.size).toBeGreaterThanOrEqual(200)

    const count = new Map<string, number>()
    const add = (key: string) => count.set(key, (count.get(key) ?? 0) + 1)
    for (const problem of problems) {
      const { shown, lines, predictions } = trace(problem)
      const keys = new Set<string>()
      for (const line of lines) {
        const { mnemonic, dest, source } = parse(line)
        const name = nameOf(dest)
        keys.add(`mnemonic ${mnemonic}`)
        keys.add(`size ${name.bits}`)
        if (name.shift === 8n) keys.add('high byte')
        if (/^r(8|9|1[0-5])/.test(dest) || /\br(8|9|1[0-5])/.test(source)) keys.add('r8-r15')
        if (/^[0-9]$/.test(source)) keys.add('decimal number')
        if (/^0x/.test(source)) keys.add('hex number')
      }
      keys.add(`${shown.length} registers`)
      keys.add(`${(problem.chips ?? []).length} chips`)
      const rightIds = new Set(problem.fields.map((field) => field.expected))
      for (const chip of problem.chips ?? []) {
        if (rightIds.has(chip.id)) continue
        for (const prediction of predictions) {
          if (prediction.label === chip.label) keys.add(`chip ${prediction.kind}`)
        }
      }
      keys.forEach(add)
    }
    const expected = [
      ...['mov', 'movzx', 'lea', 'add', 'sub', 'inc', 'dec', 'xor', 'and', 'or'].map(
        (mnemonic) => `mnemonic ${mnemonic}`,
      ),
      'size 8',
      'size 16',
      'size 32',
      'size 64',
      'high byte',
      'r8-r15',
      'decimal number',
      'hex number',
      '3 registers',
      '4 registers',
      '8 chips',
      '9 chips',
      'chip forgot-zero-upper',
      'chip stale-value',
      'chip cleared-upper-wrongly',
      'chip wrong-register',
    ]
    for (const key of expected) {
      expect(count.get(key) ?? 0, key).toBeGreaterThanOrEqual(20)
    }
  })
})
