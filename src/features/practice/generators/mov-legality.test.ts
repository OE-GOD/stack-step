import { describe, expect, it } from 'vitest'
import { assemble, createEmulator } from '../../../emulator'
import { decodePayload, encodePayload } from '../../../lib/share'
import { checkProblem } from '../check'
import type { Problem } from '../types'
import { generate } from './mov-legality'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)

const CHOICE_IDS = [
  'legal',
  'memory-to-memory',
  'immediate-destination',
  'size-mismatch',
  'missing-size',
  'immediate-too-large',
] as const

/* ─────────────── an independent judge, written from the rule table ─────────────── */

/** Register name → size in bits, typed out by hand (not taken from the emulator). */
const REGISTER_BITS = new Map<string, number>()
for (const [wide, dword, word, low] of [
  ['rax', 'eax', 'ax', 'al'],
  ['rbx', 'ebx', 'bx', 'bl'],
  ['rcx', 'ecx', 'cx', 'cl'],
  ['rdx', 'edx', 'dx', 'dl'],
  ['rsi', 'esi', 'si', 'sil'],
  ['rdi', 'edi', 'di', 'dil'],
  ['rbp', 'ebp', 'bp', 'bpl'],
  ['rsp', 'esp', 'sp', 'spl'],
]) {
  REGISTER_BITS.set(wide, 64).set(dword, 32).set(word, 16).set(low, 8)
}
for (let n = 8; n <= 15; n++) {
  REGISTER_BITS.set(`r${n}`, 64).set(`r${n}d`, 32).set(`r${n}w`, 16).set(`r${n}b`, 8)
}
for (const high of ['ah', 'bh', 'ch', 'dh']) REGISTER_BITS.set(high, 8)

const PTR_BITS: Record<string, number> = { byte: 8, word: 16, dword: 32, qword: 64 }

type Judged =
  | { kind: 'reg'; bits: number; name: string }
  | { kind: 'mem'; bits: number | null }
  | { kind: 'imm'; value: bigint }

function judgeOperand(text: string): Judged {
  if (/^-?(0x[0-9a-f]+|[1-9]\d*|0)$/.test(text)) return { kind: 'imm', value: BigInt(text) }
  const bits = REGISTER_BITS.get(text)
  if (bits !== undefined) return { kind: 'reg', bits, name: text }
  const memory = /^(?:(byte|word|dword|qword) ptr )?(?:-?\d+)?\[[a-z0-9+-]+\]$/.exec(text)
  if (memory === null) throw new Error(`Cannot read the operand: ${text}`)
  return { kind: 'mem', bits: memory[1] === undefined ? null : PTR_BITS[memory[1]] }
}

/** The verdict of the rules in PLAN.md section 3.4, checked in the specification's order. */
function judge(line: string): (typeof CHOICE_IDS)[number] {
  const match = /^mov (.+?), (.+)$/.exec(line)
  if (match === null) throw new Error(`Not a mov line: ${line}`)
  const dest = judgeOperand(match[1])
  const src = judgeOperand(match[2])
  const high = (o: Judged) => o.kind === 'reg' && /^[abcd]h$/.test(o.name)
  const rex = (o: Judged) => o.kind === 'reg' && /^(sil|dil|spl|bpl|r\d+[dwb]?)$/.test(o.name)
  if ((high(dest) && rex(src)) || (high(src) && rex(dest))) {
    throw new Error(`The generator must not make ah/bh/ch/dh lines with REX registers: ${line}`)
  }
  if (dest.kind === 'imm') return 'immediate-destination'
  if (dest.kind === 'mem' && src.kind === 'mem') return 'memory-to-memory'
  if (dest.kind === 'reg' && src.kind === 'reg' && dest.bits !== src.bits) return 'size-mismatch'
  if (dest.kind === 'reg' && src.kind === 'mem' && src.bits !== null && src.bits !== dest.bits) {
    return 'size-mismatch'
  }
  if (dest.kind === 'mem' && src.kind === 'reg' && dest.bits !== null && dest.bits !== src.bits) {
    return 'size-mismatch'
  }
  if (dest.kind === 'mem' && src.kind === 'imm' && dest.bits === null) return 'missing-size'
  if (src.kind === 'imm') {
    const bits = BigInt(dest.kind === 'reg' ? dest.bits : (dest.bits ?? 64))
    const v = src.value
    let fits: boolean
    if (bits < 64n) fits = v >= -(1n << (bits - 1n)) && v <= (1n << bits) - 1n
    else if (dest.kind === 'reg') fits = v >= -(1n << 63n) && v <= (1n << 64n) - 1n
    else fits = v >= -(1n << 31n) && v <= (1n << 31n) - 1n
    if (!fits) return 'immediate-too-large'
  }
  return 'legal'
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function lineOf(problem: Problem): string {
  const block = problem.prompt.find((item) => item.type === 'code')
  if (block?.type !== 'code' || block.lines.length !== 1) throw new Error('One code line expected.')
  return block.lines[0]
}

function assemblerError(problem: Problem) {
  const result = assemble(problem.stepper.code, problem.stepper.options)
  return result.diagnostics.find((item) => item.severity === 'error') ?? null
}

function allText(problem: Problem): string[] {
  const texts = [problem.reason, problem.stepper.note ?? '', problem.stepper.code]
  for (const block of problem.prompt) {
    if (block.type === 'text') texts.push(block.text)
    if (block.type === 'code') texts.push(...block.lines)
  }
  for (const field of problem.fields) {
    texts.push(field.label, field.expectedDisplay)
    if (field.kind.type === 'choice') texts.push(...field.kind.choices.map((c) => c.label))
  }
  return texts
}

/* ─────────────────────────────────── tests ─────────────────────────────────── */

describe('mov-legality: samples checked by hand', () => {
  it.each([
    // dx and si are both 16 bits: register ← register.
    [0, 'mov dx, si', 'legal'],
    // Two memory operands (a ptr size is written, so only memory to memory is broken).
    [1, 'mov [rdi+8], dword ptr -16[rbp]', 'memory-to-memory'],
    // A number on the left.
    [2, 'mov 37, rdx', 'immediate-destination'],
    // Memory ← number with no ptr: nothing says 1, 2, 4 or 8 bytes.
    [5, 'mov -24[rbp], 76', 'missing-size'],
    // 134 is between -128 and 255, and byte ptr gives the size.
    [9, 'mov byte ptr 16[rbx], 134', 'legal'],
    // 0x100000000 = 2^32 is one more than the biggest 32-bit number.
    [10, 'mov dword ptr -8[rbp], 0x100000000', 'immediate-too-large'],
    // dword ptr is 32 bits, ax is 16 bits.
    [11, 'mov dword ptr -12[rbp], ax', 'size-mismatch'],
  ] as const)('seed %i: `%s` is %s', (seed, line, verdict) => {
    const problem = generate(seed)
    expect(lineOf(problem)).toBe(line)
    expect(problem.fields[0].expected).toBe(verdict)
  })
})

describe('mov-legality: every problem', () => {
  it('is the same for the same seed (diagnose included)', () => {
    for (const seed of SEEDS) {
      const first = generate(seed)
      const second = generate(seed)
      // Everything but the function itself is plain data.
      expect({ ...first, diagnose: null }).toEqual({ ...second, diagnose: null })
      for (const id of CHOICE_IDS) {
        expect(first.diagnose({ verdict: id })).toEqual(second.diagnose({ verdict: id }))
      }
    }
  })

  it('has one choice field with the six choices, and the key is right', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      expect(problem.id).toBe(`mov-legality-${seed}`)
      expect(problem.fields).toHaveLength(1)
      const field = problem.fields[0]
      expect(field.kind.type).toBe('choice')
      if (field.kind.type === 'choice') {
        expect(field.kind.choices.map((choice) => choice.id)).toEqual(CHOICE_IDS)
      }
      expect(checkProblem(problem, { verdict: field.expected }).correct).toBe(true)
    }
  })

  it('writes a `ptr` size on a memory-to-memory line, so "memory needs a size" cannot also fit', () => {
    let count = 0
    for (let seed = 0; seed < 2000; seed++) {
      const problem = generate(seed)
      if (problem.fields[0].expected !== 'memory-to-memory') continue
      count++
      const line = lineOf(problem)
      expect(line, problem.id).toMatch(/\b(byte|word|dword|qword) ptr\b/)
      // Two ptr sizes are the same size.
      const sizes = [...line.matchAll(/\b(byte|word|dword|qword) ptr\b/g)].map((m) => m[1])
      expect(new Set(sizes).size, problem.id).toBe(1)
      // Picking "needs a size" is told the real rule, with this line's operands.
      const mistake = checkProblem(problem, { verdict: 'missing-size' }).mistake
      expect(mistake?.code).toBe('wrong-reason')
      expect(mistake?.message).toContain('are both memory')
    }
    expect(count).toBeGreaterThan(100)
  })

  it('agrees with an independent reading of the rules', () => {
    for (let seed = 0; seed < 1000; seed++) {
      const problem = generate(seed)
      expect(problem.fields[0].expected, `seed ${seed}: ${lineOf(problem)}`).toBe(
        judge(lineOf(problem)),
      )
    }
  })

  it('names the mistake for every wrong choice', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const expected = problem.fields[0].expected
      for (const picked of CHOICE_IDS) {
        if (picked === expected) continue
        const result = checkProblem(problem, { verdict: picked })
        expect(result.correct).toBe(false)
        const legalityWrong = picked === 'legal' || expected === 'legal'
        expect(result.mistake?.code, `seed ${seed}, picked ${picked}`).toBe(
          legalityWrong ? 'wrong-legality' : 'wrong-reason',
        )
        expect(result.mistake?.message).toMatch(
          expected === 'legal'
            ? /^This line is legal\. /
            : picked === 'legal'
              ? /^This line is not legal\. /
              : /^It is illegal, but for a different reason\. /,
        )
        // The message talks about this line: it quotes an operand, or the whole line.
        const [, destText, srcText] = /^mov (.+?), (.+)$/.exec(lineOf(problem)) ?? []
        const quoted = [destText, srcText, lineOf(problem)].some((text) =>
          (result.mistake?.message ?? '').includes(`\`${text}\``),
        )
        const ptrOnly = /`(byte|word|dword|qword) ptr`/.test(result.mistake?.message ?? '')
        expect(
          quoted || ptrOnly,
          `seed ${seed}, picked ${picked}: ${result.mistake?.message}`,
        ).toBe(true)
      }
      expect(problem.diagnose({ verdict: 'zz' })).toBeNull()
      expect(problem.diagnose({})).toBeNull()
      expect(checkProblem(problem, {}).mistake?.code).toBe('unanswered')
    }
  })

  it('explains a legal line by its form, and an illegal one with the assembler message', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const error = assemblerError(problem)
      if (problem.fields[0].expected === 'legal') {
        expect(error).toBeNull()
        expect(problem.reason).toMatch(
          /^Legal: it copies (a register into a register|a number into a register|memory into a register|a register into memory|a number into memory)[,. ]/,
        )
      } else {
        expect(error?.code).toBe(problem.fields[0].expected)
        // The reason is the start of the assembler's message: what is wrong and the rule
        // (at most two sentences). The advice after them is in the stepper ("Show me").
        const message = (error?.message ?? '').replace(/^Line \d+: /, '')
        expect(message.toLowerCase().startsWith(problem.reason.toLowerCase())).toBe(true)
        expect(problem.reason.slice(1)).toBe(message.slice(1, problem.reason.length))
        expect(problem.reason.split(/(?<=[.!?])\s+(?=[A-Z`])/).length).toBeLessThanOrEqual(2)
      }
    }
  })

  it('opens in the stepper as the same line: it assembles, or fails, exactly as the key says', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const line = lineOf(problem)
      const made = createEmulator(problem.stepper.code, problem.stepper.options)
      if (problem.fields[0].expected !== 'legal') {
        expect(made.ok).toBe(false)
        expect(made.diagnostics.find((item) => item.severity === 'error')?.code).toBe(
          problem.fields[0].expected,
        )
        // The failing line is the line of the question.
        expect(problem.stepper.code.split('\n')[(assemblerError(problem)?.line ?? 0) - 1]).toMatch(
          /^ {4}mov {5}/,
        )
        continue
      }
      expect(made.ok, `seed ${seed}`).toBe(true)
      if (!made.ok) continue
      expect(made.diagnostics).toEqual([])
      const step = made.emulator.step()
      expect(step.text).toBe(line)
      // The note names what changes, and it does change.
      const note = problem.stepper.note ?? ''
      const register = /^Step once and watch `(r[a-z0-9]+)`\.$/.exec(note)
      const box = /^Step once and watch the stack box at 0x([0-9a-f]+)\.$/.exec(note)
      if (register !== null) {
        expect(step.diff.registers.map((change) => change.reg)).toContain(register[1])
      } else {
        expect(box, note).not.toBeNull()
        const start = BigInt(`0x${box?.[1] ?? '0'}`)
        const written = step.diff.written.memory[0]
        expect(written.address >= start && written.address < start + 8n).toBe(true)
      }
      // Then `ret` ends the program cleanly.
      made.emulator.step()
      expect(made.emulator.getSnapshot().status).toBe('halted')
      expect(decodePayload(encodePayload(problem.stepper))).toEqual(problem.stepper)
    }
  })

  it('writes clean text: no undefined, NaN, [object or 123n; the reason is one short line', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const messages = CHOICE_IDS.map((id) => problem.diagnose({ verdict: id })?.message ?? '')
      for (const text of [...allText(problem), ...messages]) {
        expect(text).not.toMatch(/undefined|NaN|\[object|\b\d+n\b/)
      }
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
      expect(problem.stepper.note).toMatch(/^[^\n]+\.$/)
    }
  })
})

describe('mov-legality: variety over seeds 0…999', () => {
  const problems = Array.from({ length: 1000 }, (_, seed) => generate(seed))

  it('has at least 200 different problems, half of them legal', () => {
    expect(new Set(problems.map(lineOf)).size).toBeGreaterThanOrEqual(200)
    const legal = problems.filter((problem) => problem.fields[0].expected === 'legal').length
    expect(legal).toBeGreaterThan(400)
    expect(legal).toBeLessThan(600)
  })

  it('shows every legal form, every rule, and every size at least 20 times', () => {
    const counts = new Map<string, number>()
    const bump = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
    for (const problem of problems) {
      const line = lineOf(problem)
      const [, destText, srcText] = /^mov (.+?), (.+)$/.exec(line) ?? []
      const dest = judgeOperand(destText)
      const src = judgeOperand(srcText)
      const verdict = problem.fields[0].expected
      bump(verdict)
      if (verdict === 'legal') bump(`legal ${dest.kind} ← ${src.kind}`)
      for (const operand of [dest, src]) {
        if (operand.kind === 'reg') bump(`register of ${operand.bits} bits`)
        if (operand.kind === 'mem')
          bump(operand.bits === null ? 'memory without ptr' : `ptr ${operand.bits}`)
      }
      if (/-?\d+\[/.test(line)) bump('spelling -8[rbp]')
      if (/\[[a-z0-9]+[+-]\d+\]/.test(line)) bump('spelling [rbp-8]')
      if (/\b[abcd]h\b/.test(line)) bump('ah, bh, ch or dh')
      if (/\br(8|9|1[0-5])[dwb]?\b/.test(line)) bump('r8 to r15')
    }
    for (const key of [
      ...CHOICE_IDS,
      'legal reg ← reg',
      'legal reg ← imm',
      'legal reg ← mem',
      'legal mem ← reg',
      'legal mem ← imm',
      'register of 8 bits',
      'register of 16 bits',
      'register of 32 bits',
      'register of 64 bits',
      'memory without ptr',
      'ptr 8',
      'ptr 16',
      'ptr 32',
      'ptr 64',
      'spelling -8[rbp]',
      'spelling [rbp-8]',
      'ah, bh, ch or dh',
      'r8 to r15',
    ]) {
      expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(20)
    }
  })
})
