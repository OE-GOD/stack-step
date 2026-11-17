import { describe, expect, it } from 'vitest'
import { assemble, createEmulator, type Program } from '../../../emulator'
import { checkProblem } from '../check'
import type { MistakeCode, Problem, PromptBlock } from '../types'
import { generate } from './rip'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)

/* ─────────────────────── reading a problem like a student ───────────────────── */

type Form = 'A' | 'B' | 'C'

function texts(problem: Problem): string[] {
  return problem.prompt.flatMap((block) => (block.type === 'text' ? [block.text] : []))
}

function code(problem: Problem): Extract<PromptBlock, { type: 'code' }> | null {
  const block = problem.prompt.find((item) => item.type === 'code')
  return block?.type === 'code' ? block : null
}

function formOf(problem: Problem): Form {
  if (problem.fields.length === 2) return 'B'
  return code(problem)?.addresses === undefined ? 'A' : 'C'
}

/** The program the stepper runs, assembled the same way (for sizes and addresses only). */
function assembled(problem: Problem): Program {
  const result = assemble(problem.stepper.code, problem.stepper.options)
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join(' | '))
  return result.program
}

const hexText = (value: bigint) => value.toString(16)

/** A decimal-digit slip, written again here: digits read as decimal, result read as hex. */
function slipOf(start: bigint, change: bigint): bigint | null {
  const digits = start.toString(16)
  if (!/^[0-9]+$/.test(digits)) return null
  const asHex = BigInt(`0x${(BigInt(digits) + change).toString(10)}`)
  return asHex === start + change ? null : asHex
}

/** The conditions the course uses: the rule in words and as code (written here again). */
const RULES: Record<string, { words: string; holds: (f: Record<string, number>) => boolean }> = {
  je: { words: 'ZF = 1', holds: (f) => f.ZF === 1 },
  jne: { words: 'ZF = 0', holds: (f) => f.ZF === 0 },
  jg: { words: 'ZF = 0 and SF = OF', holds: (f) => f.ZF === 0 && f.SF === f.OF },
  jge: { words: 'SF = OF', holds: (f) => f.SF === f.OF },
  jl: { words: 'SF ≠ OF', holds: (f) => f.SF !== f.OF },
  jle: { words: 'ZF = 1 or SF ≠ OF', holds: (f) => f.ZF === 1 || f.SF !== f.OF },
  ja: { words: 'CF = 0 and ZF = 0', holds: (f) => f.CF === 0 && f.ZF === 0 },
  jae: { words: 'CF = 0', holds: (f) => f.CF === 0 },
  jb: { words: 'CF = 1', holds: (f) => f.CF === 1 },
  jbe: { words: 'CF = 1 or ZF = 1', holds: (f) => f.CF === 1 || f.ZF === 1 },
}

interface FormA {
  text: string
  address: bigint
  size: bigint
}

function readA(problem: Problem): FormA {
  const match =
    /^The instruction `(.+)` is at address (0x[0-9a-f]+)\. It is (\d+) bytes? long\. While it runs, what is in rip\? Answer in hex\.$/.exec(
      texts(problem)[0],
    )
  if (!match) throw new Error(`form A text: ${texts(problem)[0]}`)
  return { text: match[1], address: BigInt(match[2]), size: BigInt(match[3]) }
}

interface FormB {
  first: bigint
  lines: { text: string; size: bigint }[]
  p: number
  q: number
}

function readB(problem: Problem): FormB {
  const first = /^The first line is at address (0x[0-9a-f]+)\./.exec(texts(problem)[0])
  const block = code(problem)
  if (!first || !block) throw new Error('form B text')
  const lines = block.lines.map((line) => {
    const match = /^ {4}(.+?)\s+# (\d+) bytes?$/.exec(line)
    if (!match) throw new Error(`form B line: ${line}`)
    return { text: match[1], size: BigInt(match[2]) }
  })
  const p = Number(/^Address of line (\d)$/.exec(problem.fields[0].label)?.[1])
  const q = Number(/^rip while line (\d) runs$/.exec(problem.fields[1].label)?.[1])
  return { first: BigInt(first[1]), lines, p, q }
}

interface FormC {
  lines: readonly string[]
  addresses: bigint[]
  jumpLine: number
  mnemonic: string
  target: string
  flags: Record<string, number> | null
}

function readC(problem: Problem): FormC {
  const question =
    /^What is in rip right after line (\d+) \(`(j\w+) (\w+)`\) runs\? Answer in hex\.$/.exec(
      texts(problem)[0],
    )
  const block = code(problem)
  if (!question || !block?.addresses) throw new Error('form C text')
  const [, line, mnemonic, target] = question
  let flags: Record<string, number> | null = null
  if (mnemonic !== 'jmp') {
    const sentence = texts(problem)[1]
    expect(sentence).toContain(`\`${mnemonic}\` jumps when ${RULES[mnemonic].words}.`)
    const state = /Before line \d+ runs, (.+)\.$/.exec(sentence)?.[1] ?? ''
    flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }
    for (const [, flag, value] of state.matchAll(/([CZSO]F) is ([01])/g))
      flags[flag] = Number(value)
    // Every flag the rule reads is stated.
    for (const flag of ['CF', 'ZF', 'SF', 'OF']) {
      if (RULES[mnemonic].words.includes(flag)) expect(state).toContain(`${flag} is`)
    }
  }
  return {
    lines: block.lines,
    addresses: block.addresses.map((text) => BigInt(text)),
    jumpLine: Number(line),
    mnemonic,
    target,
    flags,
  }
}

/** Expected answers, worked out with address + size only. */
function independentAnswers(problem: Problem): Record<string, bigint> {
  const program = assembled(problem)
  switch (formOf(problem)) {
    case 'A': {
      const a = readA(problem)
      const instruction = program.instructions[0]
      expect(instruction.text).toBe(a.text)
      expect(instruction.address).toBe(a.address)
      expect(BigInt(instruction.size)).toBe(a.size)
      return { rip: a.address + a.size }
    }
    case 'B': {
      const b = readB(problem)
      b.lines.forEach((line, index) => {
        expect(program.instructions[index].text).toBe(line.text)
        expect(BigInt(program.instructions[index].size)).toBe(line.size)
      })
      expect(program.instructions[0].address).toBe(b.first)
      let at = b.first
      const starts = b.lines.map((line) => {
        const start = at
        at += line.size
        return start
      })
      expect(b.q + 1).not.toBe(b.p)
      return { address: starts[b.p - 1], rip: starts[b.q - 1] + b.lines[b.q - 1].size }
    }
    case 'C': {
      const c = readC(problem)
      // The address column is the assembler's: an instruction's address, or for a label
      // line the address of the instruction after it.
      c.lines.forEach((line, index) => {
        const position = program.lineToIndex.get(index + 1)
        const expected =
          position === undefined
            ? program.instructions[program.lineToIndex.get(index + 2) ?? -1].address
            : program.instructions[position].address
        expect(c.addresses[index], line).toBe(expected)
      })
      expect(c.lines[c.jumpLine - 1].trim()).toBe(`${c.mnemonic} ${c.target}`)
      const taken = c.flags === null || RULES[c.mnemonic].holds(c.flags)
      const targetLine = c.lines.indexOf(`${c.target}:`)
      return { rip: taken ? c.addresses[targetLine] : c.addresses[c.jumpLine] }
    }
  }
}

/* ───────────────────────── predicted wrong answers ───────────────────────── */

interface Case {
  code: MistakeCode
  answers: Record<string, string>
}

function predictedMistakes(problem: Problem): Case[] {
  const right = independentAnswers(problem)
  const answers = (changes: Record<string, bigint>): Record<string, string> => {
    const all: Record<string, string> = {}
    for (const [id, value] of Object.entries({ ...right, ...changes })) all[id] = hexText(value)
    return all
  }
  const cases: Case[] = []
  switch (formOf(problem)) {
    case 'A': {
      const a = readA(problem)
      cases.push({ code: 'rip-is-current', answers: answers({ rip: a.address }) })
      const slip = slipOf(a.address, a.size)
      if (slip !== null) cases.push({ code: 'decimal-arithmetic', answers: answers({ rip: slip }) })
      break
    }
    case 'B': {
      const b = readB(problem)
      const sizes = b.lines.map((line) => line.size)
      const sum = (count: number) => sizes.slice(0, count).reduce((t, s) => t + s, 0n)
      const lineQ = b.first + sum(b.q - 1)
      cases.push({ code: 'rip-is-current', answers: answers({ rip: lineQ }) })
      const slipP = slipOf(b.first, sum(b.p - 1))
      if (slipP !== null) {
        cases.push({ code: 'decimal-arithmetic', answers: answers({ address: slipP }) })
      }
      for (const slip of [slipOf(b.first, sum(b.q)), slipOf(lineQ, sizes[b.q - 1])]) {
        if (slip !== null && slip !== lineQ) {
          cases.push({ code: 'decimal-arithmetic', answers: answers({ rip: slip }) })
        }
      }
      break
    }
    case 'C': {
      const c = readC(problem)
      const own = c.addresses[c.jumpLine - 1]
      const next = c.addresses[c.jumpLine]
      const target = c.addresses[c.lines.indexOf(`${c.target}:`)]
      const taken = c.flags === null || RULES[c.mnemonic].holds(c.flags)
      cases.push({ code: 'rip-is-current', answers: answers({ rip: own }) })
      cases.push({ code: 'wrong-reason', answers: answers({ rip: taken ? next : target }) })
      const slip = taken ? null : slipOf(own, next - own)
      if (slip !== null) cases.push({ code: 'decimal-arithmetic', answers: answers({ rip: slip }) })
      break
    }
  }
  return cases
}

function rightAnswers(problem: Problem): Record<string, string> {
  return Object.fromEntries(problem.fields.map((field) => [field.id, field.expectedDisplay]))
}

/** Everything of a problem except its `diagnose` function (functions never compare equal). */
function withoutDiagnose(problem: Problem): Record<string, unknown> {
  return Object.fromEntries(Object.entries(problem).filter(([key]) => key !== 'diagnose'))
}

/* ─────────────────────────────────── tests ──────────────────────────────── */

describe('rip generator', () => {
  it('is deterministic: the same seed gives the same problem and the same diagnoses', () => {
    for (const seed of SEEDS) {
      const a = generate(seed)
      const b = generate(seed)
      expect(withoutDiagnose(a)).toEqual(withoutDiagnose(b))
      for (const { answers } of predictedMistakes(a)) {
        expect(a.diagnose(answers)).toEqual(b.diagnose(answers))
      }
    }
  })

  it('has an id, a topic and the fields of its form', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      expect(problem.id).toBe(`rip-${seed}`)
      expect(problem.topic).toBe('rip')
      expect(problem.view).toBe('form')
      const ids = problem.fields.map((field) => field.id)
      expect(ids).toEqual(formOf(problem) === 'B' ? ['address', 'rip'] : ['rip'])
      for (const field of problem.fields) expect(field.kind).toEqual({ type: 'hex' })
    }
  })

  it('accepts the expected answers, also typed in other ways', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      expect(checkProblem(problem, rightAnswers(problem)).correct).toBe(true)
      const typed = Object.fromEntries(
        problem.fields.map((field) => [field.id, `0X${field.expected.toUpperCase()}`]),
      )
      expect(checkProblem(problem, typed).correct).toBe(true)
    }
  })

  it('has the answer key that address + size gives (sizes from the assembler)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const right = independentAnswers(problem)
      for (const field of problem.fields) {
        expect(field.expected, `seed ${seed} ${field.id}`).toBe(hexText(right[field.id]))
      }
      // Small world: code addresses have 4 hex digits, 0x4000 … 0x4fff.
      for (const value of Object.values(right)) {
        expect(value).toBeGreaterThanOrEqual(0x4000n)
        expect(value).toBeLessThanOrEqual(0x4fffn)
      }
    }
  })

  it('hand-checked problems', () => {
    // Seed 0 (form A): `mov ebx, 16` at 0x4568 is 5 bytes: B8+r imm32. 0x4568 + 5 = 0x456d.
    const a = generate(0)
    expect(texts(a)[0]).toBe(
      'The instruction `mov ebx, 16` is at address 0x4568. It is 5 bytes long. While it runs, what is in rip? Answer in hex.',
    )
    expect(a.fields[0].expectedDisplay).toBe('0x456d')

    // Seed 1 (form B): first line 0x4146; movzx r15d, dl = REX + 0F B6 + ModRM = 4 bytes.
    // Line 2 = 0x4146 + 4 = 0x414a. Line 3 = 0x414a + 4 = 0x414e; while it runs (3 bytes),
    // rip = 0x414e + 3 = 0x4151.
    const b = generate(1)
    expect(b.fields.map((field) => [field.label, field.expectedDisplay])).toEqual([
      ['Address of line 2', '0x414a'],
      ['rip while line 3 runs', '0x4151'],
    ])

    // Seed 5 (form C): main at 0x4a44; `mov -8[rbp], r9` = REX + 89 + ModRM + disp8 = 4 bytes,
    // so `jg other` is at 0x4a48 (2 bytes). ZF = 0, SF = 1, OF = 0: jg needs SF = OF, so it
    // does not jump and rip = the next line, 0x4a48 + 2 = 0x4a4a.
    const c = generate(5)
    expect(texts(c)[1]).toBe(
      '`jg` jumps when ZF = 0 and SF = OF. Before line 3 runs, ZF is 0, SF is 1 and OF is 0.',
    )
    expect(code(c)?.addresses?.slice(0, 3)).toEqual(['0x4a44', '0x4a44', '0x4a48'])
    expect(c.fields[0].expectedDisplay).toBe('0x4a4a')
  })

  it('the stepper program is the problem: stepping it shows the same rip values', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const made = createEmulator(problem.stepper.code, problem.stepper.options)
      expect(made.ok).toBe(true)
      if (!made.ok) continue
      const emulator = made.emulator
      expect(problem.stepper.note).toMatch(/^[A-Z][^.]*\.$/)
      const listing = code(problem)
      const form = formOf(problem)
      if (listing !== null) {
        // The listing is the start of the stepper program, line for line.
        expect(problem.stepper.code.split('\n').slice(0, listing.lines.length)).toEqual(
          listing.lines,
        )
      }
      if (form === 'A') {
        expect(emulator.getSnapshot().rip).toBe(readA(problem).address)
        emulator.step()
        expect(hexText(emulator.getSnapshot().rip)).toBe(problem.fields[0].expected)
      } else if (form === 'B') {
        const { p, q } = readB(problem)
        for (let line = 1; line <= Math.max(p, q); line++) {
          if (line === p)
            expect(hexText(emulator.getSnapshot().rip)).toBe(problem.fields[0].expected)
          emulator.step()
          if (line === q)
            expect(hexText(emulator.getSnapshot().rip)).toBe(problem.fields[1].expected)
        }
      } else {
        const { jumpLine } = readC(problem)
        let step = emulator.step()
        for (let guard = 0; step.line !== jumpLine && guard < 50; guard++) step = emulator.step()
        expect(step.line).toBe(jumpLine)
        expect(hexText(emulator.getSnapshot().rip)).toBe(problem.fields[0].expected)
        const steps = Number(/Press Step (\d+|once)/.exec(problem.stepper.note ?? '')?.[1] ?? NaN)
        expect(emulator.getSnapshot().stepCount).toBe(Number.isNaN(steps) ? 1 : steps)
      }
      expect(emulator.run().reason).toBe('halted')
      expect(emulator.getSnapshot().error).toBeNull()
    }
  })

  it('form A opens in the stepper with no warning (B and C keep the question’s line numbers)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      if (formOf(problem) !== 'A') continue
      expect(problem.stepper.code.startsWith('    .intel_syntax noprefix\nmain:\n')).toBe(true)
      const result = assemble(problem.stepper.code, problem.stepper.options)
      expect(result.diagnostics, problem.id).toEqual([])
    }
  })

  it('form B: an "added in decimal" slip never looks like another line or the other answer', () => {
    // Seed 459 once had line 2 at 0x453a, and 4537 + 3 = 4540 in decimal is 0x4540: the
    // address of line 3 and the answer of the other box.
    let checked = 0
    for (let seed = 0; seed < 2000; seed++) {
      const problem = generate(seed)
      if (formOf(problem) !== 'B') continue
      const { first, lines, p, q } = readB(problem)
      const addresses = [first]
      for (const line of lines) addresses.push(addresses[addresses.length - 1] + line.size)
      const slips = [
        slipOf(first, addresses[p - 1] - first),
        slipOf(first, addresses[q] - first),
        slipOf(addresses[q - 1], lines[q - 1].size),
      ]
      for (const slip of slips) {
        if (slip === null) continue
        checked++
        expect(addresses, `seed ${seed}: 0x${hexText(slip)}`).not.toContain(slip)
      }
    }
    expect(checked).toBeGreaterThan(300)
  })

  it('the flags a conditional jump reads are the flags the stepper starts with', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      if (formOf(problem) !== 'C') continue
      const { flags } = readC(problem)
      if (flags === null) continue
      expect(problem.stepper.options?.initialFlags).toEqual(flags)
    }
  })

  it('names every predicted mistake, and never a right answer', () => {
    const seen = new Map<string, number>()
    for (const seed of SEEDS) {
      const problem = generate(seed)
      for (const { code: mistake, answers } of predictedMistakes(problem)) {
        const result = checkProblem(problem, answers)
        expect(result.correct, `seed ${seed} ${mistake}`).toBe(false)
        expect(result.mistake?.code, `seed ${seed} ${JSON.stringify(answers)}`).toBe(mistake)
        const key = `${formOf(problem)} ${mistake}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
      }
    }
    for (const key of [
      'A rip-is-current',
      'A decimal-arithmetic',
      'B rip-is-current',
      'B decimal-arithmetic',
      'C rip-is-current',
      'C wrong-reason',
    ]) {
      expect(seen.get(key) ?? 0, key).toBeGreaterThanOrEqual(10)
    }
  })

  it('names the decimal slip after a jump that is not taken (rare: needs …8 or …9 + 2)', () => {
    let seen = 0
    for (let seed = 0; seed < 2000; seed++) {
      const problem = generate(seed)
      if (formOf(problem) !== 'C') continue
      for (const { code: mistake, answers } of predictedMistakes(problem)) {
        if (mistake !== 'decimal-arithmetic') continue
        expect(checkProblem(problem, answers).mistake?.code, `seed ${seed}`).toBe(mistake)
        seen++
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10)
  })

  it('mistake messages are short and use this problem’s numbers', () => {
    const a = generate(0)
    expect(checkProblem(a, { rip: '0x4568' }).mistake?.message).toBe(
      'That is the address of the instruction itself. While it runs, rip already holds the address of the next instruction: 0x4568 + 5 = 0x456d.',
    )
    const c = generate(5)
    expect(checkProblem(c, { rip: '0x4a4f' }).mistake).toEqual({
      code: 'wrong-reason',
      message:
        'This jump is not taken: `jg` jumps only when ZF = 0 and SF = OF, and ZF is 0, SF is 1 and OF is 0. So rip moves on to the next line: 0x4a4a.',
    })
    for (const seed of SEEDS) {
      const problem = generate(seed)
      for (const { answers } of predictedMistakes(problem)) {
        const message = checkProblem(problem, answers).mistake?.message ?? ''
        expect(message.split(/(?<=\.)\s(?=[A-Z`])/).length).toBeLessThanOrEqual(2)
        expect(message).toMatch(/0x4[0-9a-f]{3}/)
      }
    }
  })

  it('returns null for wrong answers it cannot explain, and never throws on junk', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const right = independentAnswers(problem)
      const odd = Object.fromEntries(
        Object.entries(right).map(([id, value]) => [id, hexText(value + 0x100n)]),
      )
      expect(checkProblem(problem, odd).mistake).toBeNull()
      if (formOf(problem) === 'B') {
        // The two answers in each other's boxes: no mistake is named, even when one value
        // looks like a slip on its own (seed 28: 0x4993 is also 0x4989 + 4 "in decimal").
        const swapped = { address: hexText(right.rip), rip: hexText(right.address) }
        expect(checkProblem(problem, swapped).mistake, `seed ${seed}`).toBeNull()
      }
      for (const junk of ['', 'rip', '-2', '0x', '9'.repeat(30)]) {
        const filled = Object.fromEntries(problem.fields.map((field) => [field.id, junk]))
        expect(() => problem.diagnose(filled)).not.toThrow()
      }
    }
  })

  it('varies: many distinct problems, every form and every kind of jump', () => {
    const distinct = new Set<string>()
    const counts = new Map<string, number>()
    const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
    const sizes = new Set<bigint>()
    for (let seed = 0; seed < 1000; seed++) {
      const problem = generate(seed)
      distinct.add(JSON.stringify([problem.prompt, problem.fields]))
      const form = formOf(problem)
      count(form)
      if (form === 'A') sizes.add(readA(problem).size)
      if (form === 'B') count(`B ${readB(problem).lines.length} lines`)
      if (form === 'C') {
        const c = readC(problem)
        const taken = c.flags === null || RULES[c.mnemonic].holds(c.flags)
        count(c.mnemonic === 'jmp' ? 'C jmp' : taken ? 'C taken' : 'C not taken')
      }
    }
    expect(distinct.size).toBeGreaterThanOrEqual(200)
    for (const key of [
      'A',
      'B',
      'C',
      'B 3 lines',
      'B 4 lines',
      'C jmp',
      'C taken',
      'C not taken',
    ]) {
      expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(20)
    }
    // Form A asks about instructions of many sizes, 1 to 10 bytes.
    expect(sizes.size).toBeGreaterThanOrEqual(7)
    expect(sizes).toContain(1n)
    expect(sizes).toContain(10n)
  })

  it('has clean text: no undefined, NaN, [object or raw bigint; a one-line reason', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const all: string[] = [problem.reason, problem.stepper.note ?? '', ...texts(problem)]
      const listing = code(problem)
      if (listing) all.push(...listing.lines, ...(listing.addresses ?? []))
      for (const field of problem.fields) all.push(field.label, field.expectedDisplay)
      for (const { answers } of predictedMistakes(problem)) {
        all.push(problem.diagnose(answers)?.message ?? '')
      }
      for (const text of all) expect(text).not.toMatch(/undefined|NaN|\[object|\b\d+n\b/)
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
    }
  })
})
