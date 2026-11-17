/**
 * The hand-written sample problems, checked a second time.
 *
 * The values in sampleProblems.ts were worked out by hand. This file works them out
 * again with a tiny model of its own (plain BigInt maths, written without looking at the
 * chips) and compares. It also checks that every problem has the shape the practice
 * specification gives to the trace table, and that `checkProblem` treats it as expected.
 */
import { describe, expect, it } from 'vitest'
import { checkProblem } from '../../check'
import type { Problem } from '../../types'
import { SAMPLE_PROBLEMS } from './sampleProblems'

/* ───────────── A tiny model of the registers (independent of the app) ───────────── */

const MASK = { 8: 0xffn, 16: 0xffffn, 32: 0xffff_ffffn, 64: 0xffff_ffff_ffff_ffffn } as const
type Bits = keyof typeof MASK

/** Every register name the sample problems use → its 64-bit register and its width. */
const NAMES: Record<string, { base: string; bits: Bits }> = {}
for (const [base, e, x, l] of [
  ['rax', 'eax', 'ax', 'al'],
  ['rbx', 'ebx', 'bx', 'bl'],
  ['rcx', 'ecx', 'cx', 'cl'],
  ['rdx', 'edx', 'dx', 'dl'],
  ['rsi', 'esi', 'si', 'sil'],
  ['rdi', 'edi', 'di', 'dil'],
  ['r10', 'r10d', 'r10w', 'r10b'],
] as const) {
  NAMES[base] = { base, bits: 64 }
  NAMES[e] = { base, bits: 32 }
  NAMES[x] = { base, bits: 16 }
  NAMES[l] = { base, bits: 8 }
}

type Registers = Record<string, bigint>

function nameInfo(name: string): { base: string; bits: Bits } {
  const info = NAMES[name]
  if (info === undefined) throw new Error(`The model does not know the register ${name}.`)
  return info
}

function read(registers: Registers, name: string): bigint {
  const { base, bits } = nameInfo(name)
  return (registers[base] ?? 0n) & MASK[bits]
}

/**
 * The write rules: a 64-bit name replaces everything, a 32-bit name clears the top half,
 * an 8-bit or 16-bit name keeps all the other bits.
 */
function write(registers: Registers, name: string, value: bigint): string {
  const { base, bits } = nameInfo(name)
  const old = registers[base] ?? 0n
  const low = value & MASK[bits]
  registers[base] = bits === 64 || bits === 32 ? low : (old & ~MASK[bits] & MASK[64]) | low
  return base
}

/** The value of a source operand: a number, a register, or a `[a+b*8+16]` sum for lea. */
function valueOf(registers: Registers, operand: string): bigint {
  const text = operand.trim()
  if (text.startsWith('[')) {
    return text
      .slice(1, -1)
      .split('+')
      .map((term) => {
        const [left = '', scale] = term.split('*')
        const amount = /^[0-9]/.test(left) ? BigInt(left) : (registers[nameInfo(left).base] ?? 0n)
        return scale === undefined ? amount : amount * BigInt(scale)
      })
      .reduce((sum, term) => (sum + term) & MASK[64], 0n)
  }
  return /^[0-9]/.test(text) ? BigInt(text) : read(registers, text)
}

/** Run one instruction. Returns the 64-bit register it wrote. */
function run(registers: Registers, line: string): string {
  const space = line.indexOf(' ')
  const mnemonic = line.slice(0, space)
  const [dest = '', source = ''] = line
    .slice(space + 1)
    .split(/,(.*)/)
    .map((part) => part.trim())
  const now = read(registers, dest)
  switch (mnemonic) {
    case 'mov':
    case 'movzx':
    case 'lea':
      return write(registers, dest, valueOf(registers, source))
    case 'add':
      return write(registers, dest, now + valueOf(registers, source))
    case 'sub':
      return write(registers, dest, now - valueOf(registers, source))
    case 'and':
      return write(registers, dest, now & valueOf(registers, source))
    case 'xor':
      return write(registers, dest, now ^ valueOf(registers, source))
    case 'inc':
      return write(registers, dest, now + 1n)
    case 'dec':
      return write(registers, dest, now - 1n)
    default:
      throw new Error(`The model does not know the instruction ${mnemonic}.`)
  }
}

function label(register: string, value: bigint): string {
  return `${register} = 0x${value.toString(16).padStart(16, '0')}`
}

/* ─────────────────────────── Reading a sample problem ─────────────────────────── */

function partsOf(problem: Problem) {
  const registersBlock = problem.prompt.find((block) => block.type === 'registers')
  const codeBlock = problem.prompt.find((block) => block.type === 'code')
  if (registersBlock?.type !== 'registers' || codeBlock?.type !== 'code') {
    throw new Error(`${problem.id} has no registers or no code.`)
  }
  const start: Registers = {}
  for (const row of registersBlock.rows) start[row.name] = BigInt(row.value)
  return { start, shown: registersBlock.rows, lines: codeBlock.lines, chips: problem.chips ?? [] }
}

function rightAnswers(problem: Problem): Record<string, string> {
  return Object.fromEntries(problem.fields.map((field) => [field.id, field.expected]))
}

function labelOfChip(problem: Problem, chipId: string): string {
  return problem.chips?.find((chip) => chip.id === chipId)?.label ?? ''
}

/* ───────────────────────────────── The checks ───────────────────────────────── */

describe('the model of this test', () => {
  it('follows the write rules of x86-64', () => {
    const registers: Registers = { rax: 0x1111222233334444n }
    write(registers, 'al', 0xffn)
    expect(registers.rax).toBe(0x11112222333344ffn)
    write(registers, 'ax', 0xbeefn)
    expect(registers.rax).toBe(0x111122223333beefn)
    write(registers, 'eax', 0x5n)
    expect(registers.rax).toBe(0x5n)
    write(registers, 'rax', -1n)
    expect(registers.rax).toBe(0xffffffffffffffffn)
  })
})

describe.each(SAMPLE_PROBLEMS.map((problem) => [problem.id, problem] as const))(
  'sample problem %s',
  (_id, problem) => {
    const { start, shown, lines, chips } = partsOf(problem)

    it('has the shape of a trace-table problem', () => {
      expect(problem.view).toBe('trace-table')
      expect(problem.topic).toBe('homework-table')
      expect(problem.id).toBe(`homework-table-${problem.seed}`)
      expect(shown.length).toBeGreaterThanOrEqual(3)
      expect(shown.length).toBeLessThanOrEqual(4)
      expect(lines).toHaveLength(5)
      expect(problem.fields.map((field) => field.id)).toEqual([
        'line1',
        'line2',
        'line3',
        'line4',
        'line5',
      ])
      expect(problem.fields.every((field) => field.kind.type === 'chip')).toBe(true)
      expect(chips.length).toBeGreaterThanOrEqual(8)
      expect(chips.length).toBeLessThanOrEqual(9)
      expect(new Set(chips.map((chip) => chip.id)).size).toBe(chips.length)
      expect(new Set(chips.map((chip) => chip.label)).size).toBe(chips.length)
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
    })

    it('uses chip labels of the form `name = 0x` + 16 hex digits (at most 24 characters)', () => {
      for (const chip of chips) {
        expect(chip.label).toMatch(/^[a-z0-9]{2,3} = 0x[0-9a-f]{16}$/)
        expect(chip.label.length).toBeLessThanOrEqual(24)
      }
    })

    it('shows starting values with all 16 hex digits', () => {
      for (const row of shown) expect(row.value).toMatch(/^0x[0-9a-f]{16}$/)
    })

    it('has the right chip for every line, by independent arithmetic', () => {
      const registers = { ...start }
      lines.forEach((line, index) => {
        const before = { ...registers }
        const changed = run(registers, line)

        // The line changes exactly one register, and it is one of the shown ones.
        const different = Object.keys(registers).filter((name) => registers[name] !== before[name])
        expect(different, line).toEqual([changed])
        expect(shown.map((row) => row.name)).toContain(changed)

        const field = problem.fields[index]
        if (field === undefined) throw new Error('A line has no field.')
        const expected = label(changed, registers[changed] ?? 0n)
        expect(labelOfChip(problem, field.expected), `line ${index + 1}: ${line}`).toBe(expected)
        expect(field.expectedDisplay).toBe(expected)
      })
    })

    it('has a 32-bit write onto a register whose top half is not zero', () => {
      const registers = { ...start }
      const found = lines.some((line) => {
        const dest =
          line
            .slice(line.indexOf(' ') + 1)
            .split(',')[0]
            ?.trim() ?? ''
        const { base, bits } = nameInfo(dest)
        const topHalf = (registers[base] ?? 0n) >> 32n
        run(registers, line)
        return bits === 32 && topHalf !== 0n
      })
      expect(found).toBe(true)
    })

    it('gives a runnable program to the stepper: the five lines inside main, then ret', () => {
      const code = problem.stepper.code.split('\n').map((line) => line.trim())
      expect(code.slice(0, 3)).toEqual(['.intel_syntax noprefix', '.globl main', 'main:'])
      expect(code.slice(3, 8)).toEqual([...lines])
      expect(code[8]).toBe('ret')
      expect(problem.stepper.options?.initialRegisters).toEqual(start)
      // One short sentence that says what to watch (the rule of the practice specification).
      expect(problem.stepper.note).toMatch(/^[A-Z][^.]*\.$/)
    })

    it('is correct with the right chips and names the blank parts when empty', () => {
      const right = checkProblem(problem, rightAnswers(problem))
      expect(right.correct).toBe(true)
      expect(right.mistake).toBeNull()

      const blank = checkProblem(problem, {})
      expect(blank.correct).toBe(false)
      expect(blank.mistake?.code).toBe('unanswered')

      const one = checkProblem(problem, { ...rightAnswers(problem), line3: '' })
      expect(one.correct).toBe(false)
      expect(one.mistake?.message).toContain('"Line 3"')
    })

    it('names no mistake for a right chip on the wrong line', () => {
      const [first, second] = problem.fields
      if (first === undefined || second === undefined) throw new Error('No fields.')
      const swapped = {
        ...rightAnswers(problem),
        [first.id]: second.expected,
        [second.id]: first.expected,
      }
      const result = checkProblem(problem, swapped)
      expect(result.correct).toBe(false)
      expect(result.mistake).toBeNull()
    })
  },
)

/**
 * The tempting wrong chips. Each row: problem, chip id, the line it belongs to, the
 * mistake it stands for, and the value that mistake gives, worked out here from the
 * starting values with the model above.
 */
describe('the tempting wrong chips', () => {
  const [p1, p2, p3] = SAMPLE_PROBLEMS
  if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error('No samples.')

  /** The registers of a problem after its first `count` lines. */
  function after(problem: Problem, count: number): Registers {
    const { start, lines } = partsOf(problem)
    const registers = { ...start }
    for (const line of lines.slice(0, count)) run(registers, line)
    return registers
  }
  const top = (value: bigint) => value & ~MASK[32] & MASK[64]

  const traps = [
    // Problem 1.
    {
      problem: p1,
      chipId: 'p1-keep',
      line: 1,
      code: 'forgot-zero-upper',
      // mov eax, 5 with the old top half of rax kept.
      label: label('rax', top(after(p1, 0).rax ?? 0n) | 5n),
    },
    {
      problem: p1,
      chipId: 'p1-stale',
      line: 2,
      code: 'stale-value',
      // add rbx, rax with rax as it was before line 1.
      label: label('rbx', (after(p1, 0).rbx ?? 0n) + (after(p1, 0).rax ?? 0n)),
    },
    {
      problem: p1,
      chipId: 'p1-clear',
      line: 3,
      code: 'cleared-upper-wrongly',
      // mov cl, 0x7f with every other bit of rcx cleared.
      label: label('rcx', 0x7fn),
    },
    // Problem 2.
    {
      problem: p2,
      chipId: 'p2-clear',
      line: 1,
      code: 'cleared-upper-wrongly',
      // mov bx, 0x1234 with every other bit of rbx cleared.
      label: label('rbx', 0x1234n),
    },
    {
      problem: p2,
      chipId: 'p2-stale',
      line: 2,
      code: 'stale-value',
      // movzx edx, bl with bl as it was before line 1.
      label: label('rdx', (after(p2, 0).rbx ?? 0n) & MASK[8]),
    },
    {
      problem: p2,
      chipId: 'p2-keep',
      line: 5,
      code: 'forgot-zero-upper',
      // and ebx, 0xff with the old top half of rbx kept.
      label: label('rbx', top(after(p2, 4).rbx ?? 0n) | ((after(p2, 4).rbx ?? 0n) & 0xffn)),
    },
    // Problem 3.
    {
      problem: p3,
      chipId: 'p3-keep',
      line: 2,
      code: 'forgot-zero-upper',
      // mov edi, 0x12345678 with the old top half of rdi kept.
      label: label('rdi', top(after(p3, 1).rdi ?? 0n) | 0x12345678n),
    },
    {
      problem: p3,
      chipId: 'p3-stale',
      line: 4,
      code: 'stale-value',
      // add rdi, rsi with rsi as it was before line 1.
      label: label('rdi', (after(p3, 3).rdi ?? 0n) + (after(p3, 0).rsi ?? 0n)),
    },
    {
      problem: p3,
      chipId: 'p3-clear',
      line: 3,
      code: 'cleared-upper-wrongly',
      // mov r10b, 0x2a with every other bit of r10 cleared.
      label: label('r10', 0x2an),
    },
  ] as const

  it.each(traps)('$chipId is the $code value of line $line', (trap) => {
    expect(labelOfChip(trap.problem, trap.chipId)).toBe(trap.label)
    // It is never a right answer.
    expect(trap.problem.fields.map((field) => field.expected)).not.toContain(trap.chipId)
  })

  it.each(traps)('$chipId on line $line is named as $code', (trap) => {
    const answers = { ...rightAnswers(trap.problem), [`line${trap.line}`]: trap.chipId }
    const result = checkProblem(trap.problem, answers)
    expect(result.correct).toBe(false)
    expect(result.fields.filter((field) => !field.correct).map((field) => field.fieldId)).toEqual([
      `line${trap.line}`,
    ])
    expect(result.mistake?.code).toBe(trap.code)
    expect(result.mistake?.message).toMatch(/\.$/)
  })

  it.each(traps)('$chipId on another line is wrong, with no named mistake', (trap) => {
    const other = trap.line === 5 ? 4 : trap.line + 1
    const answers = { ...rightAnswers(trap.problem), [`line${other}`]: trap.chipId }
    const result = checkProblem(trap.problem, answers)
    expect(result.correct).toBe(false)
    expect(result.mistake).toBeNull()
  })

  it('the chip with the right value on the wrong register has no named mistake', () => {
    // add rbx, rax: the sum belongs to rbx, the chip says rax.
    expect(labelOfChip(p1, 'p1-other')).toBe(label('rax', after(p1, 2).rbx ?? 0n))
    expect(checkProblem(p1, { ...rightAnswers(p1), line2: 'p1-other' }).mistake).toBeNull()
    // lea rsi, [rax+rdx]: the sum belongs to rsi, the chip says rax.
    expect(labelOfChip(p2, 'p2-other')).toBe(label('rax', after(p2, 4).rsi ?? 0n))
    expect(checkProblem(p2, { ...rightAnswers(p2), line4: 'p2-other' }).mistake).toBeNull()
  })

  it('names the first mistake of the specification order when two chips are wrong', () => {
    // Problem 1: stale-value on line 2 and forgot-zero-upper on line 1 → forgot-zero-upper.
    const result = checkProblem(p1, {
      ...rightAnswers(p1),
      line1: 'p1-keep',
      line2: 'p1-stale',
    })
    expect(result.mistake?.code).toBe('forgot-zero-upper')
  })
})
