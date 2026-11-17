import { describe, expect, it } from 'vitest'
import { createEmulator } from '../../../emulator'
import { decodePayload, encodePayload } from '../../../lib/share'
import { checkProblem } from '../check'
import type { MistakeCode, Problem } from '../types'
import { generate } from './indirect-addressing'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)

/* ─────────────── an independent solver that reads only the prompt ─────────────── */

interface ParsedLine {
  text: string
  op: 'mov' | 'lea'
  dest: string
  base: string
  offset: bigint
}

interface Parsed {
  registers: Map<string, bigint>
  /** Stack box address → value, exactly as the table shows it. */
  stack: Map<bigint, bigint>
  markers: Map<string, bigint>
  lines: ParsedLine[]
}

function parseLine(text: string): ParsedLine {
  const match =
    /^(mov|lea) ([a-z0-9]+), (?:(-?\d+)\[([a-z0-9]+)\]|\[([a-z0-9]+)(?:([+-])(\d+))?\])$/.exec(text)
  if (match === null) throw new Error(`Cannot read the line: ${text}`)
  const [, op, dest, before, beforeBase, insideBase, sign, amount] = match
  if (before !== undefined) {
    return { text, op: op as 'mov' | 'lea', dest, base: beforeBase, offset: BigInt(before) }
  }
  const size = amount === undefined ? 0n : BigInt(amount)
  return {
    text,
    op: op as 'mov' | 'lea',
    dest,
    base: insideBase,
    offset: sign === '-' ? -size : size,
  }
}

function parse(problem: Problem): Parsed {
  const registers = new Map<string, bigint>()
  const stack = new Map<bigint, bigint>()
  const markers = new Map<string, bigint>()
  let lines: ParsedLine[] = []
  for (const block of problem.prompt) {
    if (block.type === 'registers') {
      for (const row of block.rows) registers.set(row.name, BigInt(row.value))
    } else if (block.type === 'stack') {
      for (const row of block.rows) {
        stack.set(BigInt(row.address), BigInt(row.value))
        for (const mark of (row.marker ?? '').split(', ').filter((m) => m !== '')) {
          markers.set(mark, BigInt(row.address))
        }
      }
    } else if (block.type === 'code') {
      lines = block.lines.map(parseLine)
    }
  }
  return { registers, stack, markers, lines }
}

/** "0x200 − 8" done with decimal digits: 200 − 8 = 192 → 0x192. Written here, not imported. */
function decimalStyle(start: bigint, change: bigint): bigint | null {
  const digits = start.toString(16)
  if (!/^[0-9]+$/.test(digits)) return null
  const result = Number(digits) + Number(change)
  if (result < 0) return null
  const wrong = BigInt(`0x${String(result)}`)
  return wrong === start + change ? null : wrong
}

interface Solved {
  line: ParsedLine
  baseValue: bigint
  address: bigint
  right: bigint
  /** What each listed mistake would answer, by the specification's definitions. */
  predicted: { code: MistakeCode; value: bigint }[]
}

function solve(parsed: Parsed): Solved[] {
  const regs = new Map(parsed.registers)
  const start = new Map(parsed.registers)
  const changed = new Set<string>()
  const contents = (address: bigint): bigint | undefined => parsed.stack.get(address)
  return parsed.lines.map((line) => {
    const baseValue = regs.get(line.base)
    if (baseValue === undefined) throw new Error(`The prompt does not show ${line.base}.`)
    const address = baseValue + line.offset
    const stored = contents(address)
    if (line.op === 'mov' && stored === undefined) throw new Error(`No box at ${address}.`)
    const right = line.op === 'lea' ? address : (stored ?? -1n)

    const predicted: { code: MistakeCode; value: bigint }[] = []
    const add = (code: MistakeCode, value: bigint | undefined) => {
      if (value !== undefined) predicted.push({ code, value })
    }
    add('address-vs-contents', line.op === 'mov' ? address : stored)
    if (line.offset !== 0n) {
      const mirror = baseValue - line.offset
      add('wrong-offset-direction', mirror)
      add('wrong-offset-direction', contents(mirror))
    }
    const slip = decimalStyle(baseValue, line.offset)
    if (slip !== null) add('decimal-arithmetic', line.op === 'lea' ? slip : contents(slip))
    if (changed.has(line.base)) {
      const old = start.get(line.base)
      if (old === undefined) throw new Error('A changed base must have a shown start value.')
      const oldAddress = old + line.offset
      add('stale-value', line.op === 'lea' ? oldAddress : contents(oldAddress))
    }

    regs.set(line.dest, right)
    changed.add(line.dest)
    return { line, baseValue, address, right, predicted }
  })
}

function rightAnswers(problem: Problem): Record<string, string> {
  return Object.fromEntries(problem.fields.map((field) => [field.id, field.expectedDisplay]))
}

function allText(problem: Problem): string[] {
  const texts: string[] = [problem.reason, problem.stepper.note ?? '', problem.stepper.code]
  for (const block of problem.prompt) {
    if (block.type === 'text') texts.push(block.text)
    if (block.type === 'code') texts.push(...block.lines)
    if (block.type === 'registers' || block.type === 'stack') {
      texts.push(block.title ?? '', JSON.stringify(block.rows))
    }
  }
  for (const field of problem.fields) texts.push(field.label, field.expectedDisplay)
  return texts
}

/* ─────────────────────────────────── tests ─────────────────────────────────── */

describe('indirect-addressing: a sample checked by hand', () => {
  it('seed 0: lea puts an address in rdx, and a later line uses rdx', () => {
    // Worked out by hand from the question: rbp = 0x400, rsp = 0x3e8, rdx starts at 0x428.
    // lea rdx, 16[rbp]  → rdx = 0x400 + 0x10 = 0x410 (lea does not read memory)
    // mov rcx, -8[rbp]  → the box at 0x400 − 8 = 0x3f8 holds 0x53, so rcx = 0x53
    // lea rsi, [rdx-24] → rsi = 0x410 − 0x18 = 0x3f8
    const problem = generate(0)
    const code = problem.prompt.find((block) => block.type === 'code')
    expect(code).toEqual({
      type: 'code',
      lines: ['lea rdx, 16[rbp]', 'mov rcx, -8[rbp]', 'lea rsi, [rdx-24]'],
    })
    expect(problem.prompt).toContainEqual({
      type: 'registers',
      title: 'Registers before the code runs',
      rows: [
        { name: 'rbp', value: '0x400' },
        { name: 'rsp', value: '0x3e8' },
        { name: 'rdx', value: '0x428' },
      ],
    })
    expect(problem.fields.map((field) => [field.id, field.expected])).toEqual([
      ['rdx', '410'],
      ['rcx', '53'],
      ['rsi', '3f8'],
    ])
    const right = { rdx: '0x410', rcx: '0x53', rsi: '0x3f8' }
    // The old rdx: 0x428 − 0x18 = 0x410.
    expect(checkProblem(problem, { ...right, rsi: '0x410' }).mistake?.code).toBe('stale-value')
    // mov answered with the address instead of what is stored there.
    expect(checkProblem(problem, { ...right, rcx: '0x3f8' }).mistake?.code).toBe(
      'address-vs-contents',
    )
    // 410 − 24 = 386 in decimal.
    expect(checkProblem(problem, { ...right, rsi: '0x386' }).mistake?.code).toBe(
      'decimal-arithmetic',
    )
    // The box at rbp + 8 instead of rbp − 8.
    expect(checkProblem(problem, { ...right, rcx: '0x32' }).mistake?.code).toBe(
      'wrong-offset-direction',
    )
  })

  it('seed 4: positive offsets from rbp and rsp', () => {
    // rbp = 0x220, rsp = 0x210. mov rbx, [rbp+24] reads 0x220 + 0x18 = 0x238, which
    // holds 0x1f8. lea rax, 8[rbp] = 0x228. lea rsi, 32[rsp] = 0x210 + 0x20 = 0x230.
    const problem = generate(4)
    expect(problem.fields.map((field) => [field.id, field.expectedDisplay])).toEqual([
      ['rbx', '0x1f8'],
      ['rax', '0x228'],
      ['rsi', '0x230'],
    ])
    // 210 + 32 = 242 in decimal.
    const slip = checkProblem(problem, { rbx: '0x1f8', rax: '0x228', rsi: '0x242' })
    expect(slip.mistake?.code).toBe('decimal-arithmetic')
    expect(slip.mistake?.message).toContain('0x230')
  })
})

describe('indirect-addressing: every problem', () => {
  it('is the same for the same seed (diagnose included)', () => {
    for (const seed of SEEDS) {
      const first = generate(seed)
      const second = generate(seed)
      // Everything but the function itself is plain data.
      expect({ ...first, diagnose: null }).toEqual({ ...second, diagnose: null })
      for (const solved of solve(parse(first))) {
        for (const { value } of solved.predicted) {
          const answers = { ...rightAnswers(first), [solved.line.dest]: value.toString(16) }
          expect(first.diagnose(answers)).toEqual(second.diagnose(answers))
        }
      }
    }
  })

  it('accepts the expected answers, in every accepted spelling', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      expect(problem.id).toBe(`indirect-addressing-${seed}`)
      expect(checkProblem(problem, rightAnswers(problem)).correct).toBe(true)
      const shouted = Object.fromEntries(
        problem.fields.map((field) => [field.id, ` 0X${field.expected.toUpperCase()} `]),
      )
      expect(checkProblem(problem, shouted).correct).toBe(true)
    }
  })

  it('has the right answers, worked out from the question alone', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const parsed = parse(problem)
      const solved = solve(parsed)
      expect(problem.fields.map((field) => field.id)).toEqual(solved.map((s) => s.line.dest))
      for (const [index, field] of problem.fields.entries()) {
        expect(field.expected, `seed ${seed}, ${field.id}`).toBe(solved[index].right.toString(16))
        expect(field.label).toBe(solved[index].line.dest)
      }
      // The registers block and the markers in the stack table agree.
      expect(parsed.markers.get('rbp')).toBe(parsed.registers.get('rbp'))
      expect(parsed.markers.get('rsp')).toBe(parsed.registers.get('rsp'))
    }
  })

  it('names every predicted mistake, and none of them is the right answer', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      for (const solved of solve(parse(problem))) {
        for (const { code, value } of solved.predicted) {
          expect(value, `seed ${seed}: a ${code} answer equals the right answer`).not.toBe(
            solved.right,
          )
          const answers = {
            ...rightAnswers(problem),
            [solved.line.dest]: `0x${value.toString(16)}`,
          }
          const result = checkProblem(problem, answers)
          expect(result.correct).toBe(false)
          expect(
            result.mistake?.code,
            `seed ${seed}, ${solved.line.text} → 0x${value.toString(16)}`,
          ).toBe(code)
          // The message uses this problem's numbers: the address the line reads, or for a
          // stale value the new value of the base register.
          const mention = code === 'stale-value' ? solved.baseValue : solved.address
          expect(result.mistake?.message).toContain(`0x${mention.toString(16)}`)
          if (code === 'decimal-arithmetic') {
            expect(result.mistake?.message).toContain(`0x${value.toString(16)}`)
          }
        }
      }
    }
  })

  it('names a slip on the first line of a chain by its first cause, when the student carries it on', () => {
    // A later line that uses a register an earlier line changed, worked out RIGHT from the
    // student's own (wrong) value of that register, is not a second mistake. Seeds 1660,
    // 2184 and 2251 once named a coincidence on the later line instead.
    let chains = 0
    for (let seed = 0; seed < 3000; seed++) {
      const problem = generate(seed)
      const parsed = parse(problem)
      const solved = solve(parsed)
      for (const [later, s] of solved.entries()) {
        const earlier = solved.findIndex((e, i) => i < later && e.line.dest === s.line.base)
        if (earlier < 0) continue
        chains++
        for (const { code, value } of solved[earlier].predicted) {
          const address = value + s.line.offset
          const carried = s.line.op === 'lea' ? address : parsed.stack.get(address)
          if (carried === undefined) continue
          const answers = {
            ...rightAnswers(problem),
            [solved[earlier].line.dest]: `0x${value.toString(16)}`,
            [s.line.dest]: `0x${carried.toString(16)}`,
          }
          expect(
            checkProblem(problem, answers).mistake?.code,
            `seed ${seed}: ${solved[earlier].line.text} → 0x${value.toString(16)}, then ${s.line.text} → 0x${carried.toString(16)}`,
          ).toBe(code)
        }
      }
    }
    expect(chains).toBeGreaterThan(300)
  })

  it('never names a mistake that does not fit the answer', () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const problem = generate(seed)
      const parsed = parse(problem)
      const solved = solve(parsed)
      const candidates = new Set<bigint>([...parsed.stack.keys(), ...parsed.stack.values()])
      for (const value of parsed.registers.values()) candidates.add(value)
      for (const s of solved)
        for (const delta of [-16n, -8n, -1n, 1n, 8n, 16n]) candidates.add(s.right + delta)
      for (const [index, s] of solved.entries()) {
        for (const value of candidates) {
          if (value === s.right || value < 0n) continue
          const answers = { ...rightAnswers(problem), [s.line.dest]: value.toString(16) }
          const mistake = checkProblem(problem, answers).mistake
          if (mistake === null) continue
          const fits = s.predicted.some((p) => p.code === mistake.code && p.value === value)
          expect(
            fits,
            `seed ${seed}, field ${index}: 0x${value.toString(16)} → ${mistake.code}`,
          ).toBe(true)
        }
      }
      // The answers of two fields swapped, all blank but one, junk: never a crash.
      expect(() => problem.diagnose({})).not.toThrow()
      expect(
        problem.diagnose(Object.fromEntries(problem.fields.map((f) => [f.id, 'zz']))),
      ).toBeNull()
    }
  })

  it('opens in the stepper as the same problem, and stepping shows the same values', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const parsed = parse(problem)
      const made = createEmulator(problem.stepper.code, problem.stepper.options)
      expect(made.ok, `seed ${seed}`).toBe(true)
      if (!made.ok) continue
      const emulator = made.emulator
      expect(made.diagnostics).toEqual([])

      // The starting machine is the one in the question.
      const start = emulator.getSnapshot()
      for (const [name, value] of parsed.registers) {
        expect(emulator.readRegister(name), `seed ${seed}, ${name}`).toBe(value)
      }
      for (const [address, value] of parsed.stack) {
        const slot = start.stack.find((box) => box.address === address)
        expect(slot?.value, `seed ${seed}, box ${address}`).toBe(value)
      }

      // Each asked line, one step each, gives the expected value.
      for (const [index, field] of problem.fields.entries()) {
        const step = emulator.step()
        expect(step.text).toBe(parsed.lines[index].text)
        expect(emulator.readRegister(field.id).toString(16)).toBe(field.expected)
      }
      // Then `ret` ends the program cleanly, and nothing changed the answers.
      const last = emulator.step()
      expect(last.text).toBe('ret')
      expect(emulator.getSnapshot().status).toBe('halted')
      for (const field of problem.fields) {
        expect(emulator.readRegister(field.id).toString(16)).toBe(field.expected)
      }

      expect(decodePayload(encodePayload(problem.stepper))).toEqual(problem.stepper)
    }
  })

  it('writes clean text: no undefined, NaN, [object or 123n; the reason is one short line', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const messages: string[] = []
      for (const solved of solve(parse(problem))) {
        for (const { value } of solved.predicted) {
          const answers = { ...rightAnswers(problem), [solved.line.dest]: value.toString(16) }
          messages.push(checkProblem(problem, answers).mistake?.message ?? '')
        }
      }
      for (const text of [...allText(problem), ...messages]) {
        expect(text).not.toMatch(/undefined|NaN|\[object|\b\d+n\b/)
      }
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
      expect(problem.stepper.note).toMatch(/^[^.]+\.$/)
    }
  })
})

describe('indirect-addressing: variety over seeds 0…999', () => {
  const problems = Array.from({ length: 1000 }, (_, seed) => generate(seed))

  it('has at least 200 different problems', () => {
    const distinct = new Set(
      problems.map((problem) => JSON.stringify({ prompt: problem.prompt, fields: problem.fields })),
    )
    expect(distinct.size).toBeGreaterThanOrEqual(200)
  })

  it('shows every listed form at least 20 times', () => {
    const counts = new Map<string, number>()
    const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
    for (const problem of problems) {
      const parsed = parse(problem)
      const solved = solve(parsed)
      bump(`boxes:${parsed.stack.size}`)
      bump(`lines:${parsed.lines.length}`)
      if (parsed.lines.some((l) => l.op === 'mov') && parsed.lines.some((l) => l.op === 'lea')) {
        bump('mov and lea mixed')
      }
      for (const [index, line] of parsed.lines.entries()) {
        if (line.base === 'rbp' && /^\w+ \w+, -?\d+\[/.test(line.text)) bump('spelling -8[rbp]')
        if (line.base === 'rbp' && /\[rbp[+-]\d+\]$/.test(line.text)) bump('spelling [rbp-8]')
        if (line.base === 'rbp' && line.offset < 0n) bump('negative offset')
        if (line.base === 'rbp' && line.offset > 0n) bump('positive offset')
        if (line.text.endsWith(', [rsp]')) bump('[rsp]')
        if (/, \d+\[rsp\]$/.test(line.text)) bump('8[rsp]')
        if (/\[rsp\+\d+\]$/.test(line.text)) bump('[rsp+8]')
        if (line.base !== 'rbp' && line.base !== 'rsp') {
          const changer = parsed.lines
            .slice(0, index)
            .filter((earlier) => earlier.dest === line.base)
            .at(-1)
          bump(`chain base after ${changer?.op ?? 'nothing'}`)
        }
      }
      const addressLike = [...parsed.stack.values()].filter((value) => value >= 0x100n).length
      bump(`address-like values:${addressLike}`)
      const codes = new Set(solved.flatMap((s) => s.predicted.map((p) => p.code)))
      for (const code of codes) bump(`predicts ${code}`)
    }
    const needed = [
      'boxes:4',
      'boxes:5',
      'boxes:6',
      'lines:2',
      'lines:3',
      'spelling -8[rbp]',
      'spelling [rbp-8]',
      'negative offset',
      'positive offset',
      '[rsp]',
      '8[rsp]',
      '[rsp+8]',
      'chain base after lea',
      'chain base after mov',
      'address-like values:1',
      'address-like values:2',
      'predicts address-vs-contents',
      'predicts wrong-offset-direction',
      'predicts decimal-arithmetic',
      'predicts stale-value',
    ]
    for (const key of needed) expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(20)
    expect(counts.get('mov and lea mixed')).toBe(1000)
    expect(
      (counts.get('address-like values:1') ?? 0) + (counts.get('address-like values:2') ?? 0),
    ).toBe(1000)
  })
})
