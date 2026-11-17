import { describe, expect, it } from 'vitest'
import { assemble, createEmulator } from '../../../emulator'
import { checkProblem } from '../check'
import type { MistakeCode, Problem, PromptBlock } from '../types'
import { generate } from './rsp-tracker'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)

/* ─────────────── independent helpers (plain BigInt, no emulator) ─────────────── */

type Kind = 'push' | 'pop' | 'call' | 'ret' | 'sub' | 'add'

interface Row {
  fieldId: string
  text: string
  kind: Kind
  amount: bigint | null
}

function traceRows(problem: Problem): Row[] {
  const block = problem.prompt.find((item) => item.type === 'trace')
  if (block?.type !== 'trace') throw new Error('no trace block')
  return block.rows.map((row) => {
    const sized = /^(sub|add) rsp, (\d+)$/.exec(row.text)
    if (sized) {
      return {
        fieldId: row.fieldId,
        text: row.text,
        kind: sized[1] as Kind,
        amount: BigInt(sized[2]),
      }
    }
    const kind = /^(push|pop|call|ret)\b/.exec(row.text)?.[1] as Kind | undefined
    if (kind === undefined) throw new Error(`unexpected trace row: ${row.text}`)
    return { fieldId: row.fieldId, text: row.text, kind, amount: null }
  })
}

/** How rsp changes for one line, by the rules taught in class. */
function delta(row: Row): bigint {
  switch (row.kind) {
    case 'push':
    case 'call':
      return -8n
    case 'pop':
    case 'ret':
      return 8n
    case 'sub':
      return -(row.amount ?? 0n)
    case 'add':
      return row.amount ?? 0n
  }
}

function startOf(problem: Problem): bigint {
  const text = problem.prompt.find((item) => item.type === 'text')
  const match = text?.type === 'text' ? /rsp starts at (0x[0-9a-f]+)\./.exec(text.text) : null
  if (!match) throw new Error('no start in the prompt')
  return BigInt(match[1])
}

/** rsp before step 1, after step 1, … after the last step. */
function rspTrace(problem: Problem): bigint[] {
  const values = [startOf(problem)]
  for (const row of traceRows(problem)) values.push(values[values.length - 1] + delta(row))
  return values
}

/** The executed lines of the code block, found by walking it like a CPU (call/ret only). */
function executionOrder(lines: readonly string[]): string[] {
  const labels = new Map<string, number>()
  lines.forEach((line, index) => {
    const label = /^(\w+):$/.exec(line)?.[1]
    if (label !== undefined) labels.set(label, index)
  })
  const order: string[] = []
  const returns: number[] = []
  let at = (labels.get('main') ?? -1) + 1
  for (let guard = 0; guard < 100; guard++) {
    const text = lines[at].trim()
    if (/^\w+:$/.test(text)) {
      at++
      continue
    }
    order.push(text)
    const call = /^call (\w+)$/.exec(text)
    if (call) {
      returns.push(at + 1)
      at = (labels.get(call[1]) ?? -1) + 1
    } else if (text === 'ret') {
      const back = returns.pop()
      if (back === undefined) return order
      at = back
    } else {
      at++
    }
  }
  throw new Error('the program does not end')
}

/** A decimal-digit slip, written again here: digits read as decimal, result read as hex. */
function slipOf(start: bigint, change: bigint): bigint | null {
  const digits = start.toString(16)
  if (!/^[0-9]+$/.test(digits)) return null
  const wrong = BigInt(digits) + change
  if (wrong < 0n) return null
  const asHex = BigInt(`0x${wrong.toString(10)}`)
  return asHex === start + change ? null : asHex
}

const hexText = (value: bigint) => value.toString(16)

/** Everything of a problem except its `diagnose` function (functions never compare equal). */
function withoutDiagnose(problem: Problem): Record<string, unknown> {
  return Object.fromEntries(Object.entries(problem).filter(([key]) => key !== 'diagnose'))
}

function rightAnswers(problem: Problem): Record<string, string> {
  return Object.fromEntries(problem.fields.map((field) => [field.id, field.expectedDisplay]))
}

function codeLines(problem: Problem): readonly string[] {
  const block = problem.prompt.find((item): item is Extract<PromptBlock, { type: 'code' }> => {
    return item.type === 'code'
  })
  if (!block) throw new Error('no code block')
  return block.lines
}

const isMove = (row: Row) => row.kind !== 'sub' && row.kind !== 'add'

/* ───────────────────────── predicted wrong answers ───────────────────────── */

const ORDER: readonly MistakeCode[] = [
  'rsp-wrong-direction',
  'decimal-arithmetic',
  'decimal-immediate',
  'call-ret-forgot-stack',
  'rsp-wrong-amount',
  'stale-value',
]

/** What each mistake predicts for step `index` when it starts from the right rsp. */
function predictions(rows: readonly Row[], values: readonly bigint[], index: number) {
  const row = rows[index]
  const before = values[index]
  const change = delta(row)
  const out = new Map<MistakeCode, bigint[]>()
  out.set('rsp-wrong-direction', isMove(row) ? [before - change] : [])
  const slip = slipOf(before, change)
  out.set('decimal-arithmetic', slip === null ? [] : [slip])
  const misread =
    row.amount !== null && row.amount >= 10n ? BigInt(`0x${row.amount.toString(10)}`) : null
  out.set(
    'decimal-immediate',
    misread === null ? [] : [row.kind === 'sub' ? before - misread : before + misread],
  )
  out.set('call-ret-forgot-stack', row.kind === 'call' || row.kind === 'ret' ? [before] : [])
  const sign = change < 0n ? -1n : 1n
  out.set('rsp-wrong-amount', isMove(row) ? [1n, 2n, 4n, 16n].map((m) => before + sign * m) : [])
  out.set('stale-value', index >= 1 ? [values[index - 1] + change] : [])
  return out
}

/**
 * One wrong step (as a mistake predicts it); the other steps right, or (carried) built
 * on from the wrong value with the right changes.
 */
function oneSlip(
  problem: Problem,
  index: number,
  value: bigint,
  carried: boolean,
): Record<string, string> {
  const rows = traceRows(problem)
  const values = rspTrace(problem)
  const answers = rightAnswers(problem)
  let current = value
  answers[rows[index].fieldId] = hexText(value)
  for (let later = index + 1; later < rows.length; later++) {
    current += delta(rows[later])
    if (carried) answers[rows[later].fieldId] = hexText(current)
    else answers[rows[later].fieldId] = hexText(values[later + 1])
  }
  return answers
}

/** Every predicted single-step mistake of a problem, with the code it must get. */
function singleSlips(problem: Problem) {
  const rows = traceRows(problem)
  const values = rspTrace(problem)
  const cases: { code: MistakeCode; answers: Record<string, string>; why: string }[] = []
  let skipped = 0
  rows.forEach((row, index) => {
    const predicted = predictions(rows, values, index)
    for (const code of ORDER.slice(1)) {
      for (const value of predicted.get(code) ?? []) {
        if (value === values[index + 1]) continue
        // A value that an earlier mistake in the list also predicts is named after that one.
        const earlier = ORDER.slice(0, ORDER.indexOf(code)).some((other) =>
          (predicted.get(other) ?? []).includes(value),
        )
        if (earlier) {
          skipped++
          continue
        }
        for (const carried of [false, true]) {
          cases.push({
            code,
            answers: oneSlip(problem, index, value, carried),
            why: `step ${index + 1} (${row.text}) = 0x${hexText(value)}${carried ? ', carried' : ''}`,
          })
        }
      }
    }
  })
  return { cases, skipped }
}

/** A student who moves rsp the wrong way for push/pop/call/ret, from their own answers. */
function wrongWayTrace(problem: Problem): Record<string, string> {
  const answers: Record<string, string> = {}
  let current = startOf(problem)
  for (const row of traceRows(problem)) {
    current += isMove(row) ? -delta(row) : delta(row)
    answers[row.fieldId] = hexText(current)
  }
  return answers
}

/** A student who follows one rule at every step, each step built on their own last answer. */
function habitTrace(
  problem: Problem,
  move: (row: Row, rsp: bigint) => bigint,
): Record<string, string> {
  const answers: Record<string, string> = {}
  let current = startOf(problem)
  for (const row of traceRows(problem)) {
    current = move(row, current)
    answers[row.fieldId] = hexText(current)
  }
  return answers
}

/** A student who leaves rsp alone at every call and ret, and is right otherwise. */
function forgetsCallRet(problem: Problem): Record<string, string> {
  const answers: Record<string, string> = {}
  let current = startOf(problem)
  for (const row of traceRows(problem)) {
    if (row.kind !== 'call' && row.kind !== 'ret') current += delta(row)
    answers[row.fieldId] = hexText(current)
  }
  return answers
}

/* ─────────────────────────────────── tests ──────────────────────────────── */

describe('rsp-tracker generator', () => {
  it('is deterministic: the same seed gives the same problem and the same diagnoses', () => {
    for (const seed of SEEDS) {
      const a = generate(seed)
      const b = generate(seed)
      expect(withoutDiagnose(a)).toEqual(withoutDiagnose(b))
      for (const answers of [wrongWayTrace(a), forgetsCallRet(a), { step1: 'zz' }, {}]) {
        expect(a.diagnose(answers)).toEqual(b.diagnose(answers))
      }
    }
  })

  it('has an id, a topic and one rsp field per executed step (6 to 9)', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      expect(problem.id).toBe(`rsp-tracker-${seed}`)
      expect(problem.topic).toBe('rsp-tracker')
      expect(problem.view).toBe('form')
      const rows = traceRows(problem)
      expect(rows.length).toBeGreaterThanOrEqual(6)
      expect(rows.length).toBeLessThanOrEqual(9)
      expect(problem.fields.map((field) => field.id)).toEqual(rows.map((row) => row.fieldId))
      problem.fields.forEach((field, index) => {
        expect(field.label).toBe(`rsp after step ${index + 1}`)
        expect(field.kind).toEqual({ type: 'hex' })
      })
    }
  })

  it('accepts the expected answers, also typed in other ways', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const answers = rightAnswers(problem)
      expect(checkProblem(problem, answers).correct).toBe(true)
      const shouting = Object.fromEntries(
        Object.entries(answers).map(([id, text]) => [id, ` 0X${text.slice(2).toUpperCase()} `]),
      )
      expect(checkProblem(problem, shouting).correct).toBe(true)
      expect(
        problem.diagnose(Object.fromEntries(problem.fields.map((f) => [f.id, f.expected]))),
      ).toBe(null)
    }
  })

  it('has the answer key that plain hex arithmetic gives, in real execution order', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const values = rspTrace(problem)
      problem.fields.forEach((field, index) => {
        expect(field.expected).toBe(hexText(values[index + 1]))
        expect(field.expectedDisplay).toBe(`0x${hexText(values[index + 1])}`)
      })
      // The trace is the order a CPU runs the code block in (helper lines after the call).
      expect(traceRows(problem).map((row) => row.text)).toEqual(executionOrder(codeLines(problem)))
      // The start is a multiple of 8 in the small world; the stack is balanced.
      const start = values[0]
      expect(start % 8n).toBe(0n)
      expect(start).toBeGreaterThanOrEqual(0x100n)
      expect(start).toBeLessThanOrEqual(0xff8n)
      expect(values[values.length - 1]).toBe(start + 8n)
      expect(values[values.length - 2]).toBe(start)
      // Every rsp the student reads or types has 3 or 4 hex digits (small world).
      for (const value of values) {
        expect(value).toBeGreaterThanOrEqual(0x100n)
        expect(value).toBeLessThanOrEqual(0x1000n)
      }
      // At least two steps cross a multiple of 0x100 (…00 − 8 = …f8).
      let crossings = 0
      for (let i = 1; i < values.length; i++) {
        if (values[i] / 0x100n !== values[i - 1] / 0x100n) crossings++
      }
      expect(crossings).toBeGreaterThanOrEqual(2)
      // N in sub/add is one of the numbers used in class, written in decimal.
      for (const row of traceRows(problem)) {
        if (row.amount !== null) expect([8n, 16n, 24n, 32n, 40n, 48n]).toContain(row.amount)
      }
    }
  })

  it('a hand-checked problem', () => {
    // Seed 2, worked out on paper: start 0x308.
    //   push rsi    0x308 − 8 = 0x300
    //   add rsp, 8  0x300 + 8 = 0x308
    //   call helper 0x308 − 8 = 0x300
    //   push rdx    0x300 − 8 = 0x2f8   (…00 − 8 = …f8)
    //   pop rdx     0x2f8 + 8 = 0x300
    //   ret         0x300 + 8 = 0x308
    //   ret         0x308 + 8 = 0x310   (main returns to the "OS")
    const problem = generate(2)
    expect(codeLines(problem)).toEqual([
      'main:',
      '    push rsi',
      '    add rsp, 8',
      '    call helper',
      '    ret',
      'helper:',
      '    push rdx',
      '    pop rdx',
      '    ret',
    ])
    expect(startOf(problem)).toBe(0x308n)
    expect(problem.fields.map((field) => field.expectedDisplay)).toEqual([
      '0x300',
      '0x308',
      '0x300',
      '0x2f8',
      '0x300',
      '0x308',
      '0x310',
    ])
  })

  it('the stepper program is the problem: stepping it shows the same rsp after each step', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      // The shown lines, after the `.intel_syntax noprefix` line that gcc needs.
      expect(problem.stepper.code).toBe(
        `    .intel_syntax noprefix\n${codeLines(problem).join('\n')}\n`,
      )
      const assembled = assemble(problem.stepper.code, problem.stepper.options)
      expect(assembled.diagnostics, problem.id).toEqual([])
      expect(problem.stepper.options?.initialRsp).toBe(startOf(problem))
      expect(problem.stepper.note).toMatch(/^[A-Z][^.]*\.$/)
      const made = createEmulator(problem.stepper.code, problem.stepper.options)
      expect(made.ok).toBe(true)
      if (!made.ok) continue
      const emulator = made.emulator
      const rows = traceRows(problem)
      problem.fields.forEach((field, index) => {
        const step = emulator.step()
        expect(step.executed).toBe(true)
        expect(step.text).toBe(rows[index].text)
        expect(hexText(emulator.getSnapshot().registers.rsp)).toBe(field.expected)
      })
      expect(emulator.getSnapshot().status).toBe('halted')
      expect(emulator.getSnapshot().error).toBeNull()
    }
  })

  it('names a student who moves rsp the wrong way every time', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const answers = wrongWayTrace(problem)
      const result = checkProblem(problem, answers)
      expect(result.correct).toBe(false)
      expect(result.mistake?.code).toBe('rsp-wrong-direction')
    }
  })

  it('names a student who forgets that call and ret move rsp', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const result = checkProblem(problem, forgetsCallRet(problem))
      expect(result.correct).toBe(false)
      expect(result.mistake?.code).toBe('call-ret-forgot-stack')
    }
  })

  it('names a student who moves rsp by one wrong box size at every push, pop, call and ret', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      for (const box of [1n, 2n, 4n, 16n]) {
        // Built from their own answers; sub/add right.
        const answers = habitTrace(problem, (row, rsp) =>
          isMove(row) ? rsp + (delta(row) < 0n ? -box : box) : rsp + delta(row),
        )
        const result = checkProblem(problem, answers)
        expect(result.mistake?.code, `seed ${seed}, ${box}-byte boxes`).toBe('rsp-wrong-amount')
        expect(result.mistake?.message).toContain('exactly 8')
      }
    }
  })

  it('names the first pop or ret that goes down, when push and call are right', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const rows = traceRows(problem)
      const answers = habitTrace(problem, (row, rsp) =>
        row.kind === 'pop' || row.kind === 'ret' ? rsp - 8n : rsp + delta(row),
      )
      const result = checkProblem(problem, answers)
      const first = rows.findIndex((row) => row.kind === 'pop' || row.kind === 'ret')
      expect(result.mistake?.code, `seed ${seed}`).toBe('rsp-wrong-direction')
      expect(result.mistake?.message, `seed ${seed}`).toContain(
        `\`${rows[first].kind}\` makes rsp go UP by 8 (step ${first + 1}:`,
      )
    }
  })

  it('never blames push, pop, call or ret when only sub and add went the other way', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const answers = habitTrace(problem, (row, rsp) =>
        isMove(row) ? rsp + delta(row) : rsp - delta(row),
      )
      const result = checkProblem(problem, answers)
      expect(result.correct).toBe(false)
      expect(result.mistake, `seed ${seed}: ${result.mistake?.message ?? ''}`).toBeNull()
    }
  })

  it('a step worked out right from the student’s own (wrong) previous answer is never a mistake', () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const problem = generate(seed)
      const rows = traceRows(problem)
      // An unexplained slip (+0x100) at step 1, carried: no mistake at any later step.
      const values = rspTrace(problem)
      const answers = oneSlip(problem, 0, values[1] + 0x100n, true)
      expect(checkProblem(problem, answers).mistake, `seed ${seed}`).toBeNull()
      expect(rows.length).toBeGreaterThan(1)
    }
  })

  it('names every predicted one-step slip, alone or carried on through later steps', () => {
    const seen = new Map<MistakeCode, number>()
    let skipped = 0
    let predicted = 0
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const slips = singleSlips(problem)
      skipped += slips.skipped
      predicted += slips.skipped + slips.cases.length / 2
      for (const { code, answers, why } of slips.cases) {
        const result = checkProblem(problem, answers)
        expect(result.correct, `seed ${seed}: ${why}`).toBe(false)
        expect(result.mistake?.code, `seed ${seed}: ${why}`).toBe(code)
        seen.set(code, (seen.get(code) ?? 0) + 1)
      }
    }
    for (const code of ORDER.slice(1)) {
      expect(seen.get(code) ?? 0, code).toBeGreaterThanOrEqual(100)
    }
    // Some predictions coincide by definition: after two moves the same way (pop, ret),
    // "the right change from two steps earlier" IS "unchanged"; after push then pop it
    // IS "moved by 16". The earlier mistake in the list is named then. Keep that rare.
    expect(skipped / predicted).toBeLessThan(0.15)
  })

  it('mistake messages are short, kind and use this problem’s numbers', () => {
    const problem = generate(2)
    const rows = traceRows(problem)
    // Step 4 (push rdx): 0x300 − 8 in decimal digits gives 0x292.
    const decimal = checkProblem(problem, oneSlip(problem, 3, 0x292n, false)).mistake
    expect(decimal?.message).toBe(
      'It looks like you subtracted in decimal. In hex, 0x300 − 8 = 0x2f8, not 0x292.',
    )
    const wrongWay = checkProblem(problem, wrongWayTrace(problem)).mistake
    expect(wrongWay?.message).toContain('0x308 → 0x300')
    const forgot = checkProblem(problem, forgetsCallRet(problem)).mistake
    expect(forgot?.message).toContain(`step 3: 0x308 → 0x300`)
    expect(rows[2].text).toBe('call helper')
    for (const seed of SEEDS.slice(0, 100)) {
      const p = generate(seed)
      for (const { answers } of singleSlips(p).cases) {
        const message = checkProblem(p, answers).mistake?.message ?? ''
        expect(message.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2)
        expect(message).toMatch(/0x[0-9a-f]+/)
        expect(message).not.toMatch(/\byou forgot\b|\bwrong!|\bcareless/i)
      }
    }
  })

  it('returns null for wrong answers it cannot explain, and never throws on junk', () => {
    for (const seed of SEEDS.slice(0, 200)) {
      const problem = generate(seed)
      const answers = rightAnswers(problem)
      // A slip of 0x100 at the first step, then right again: no known mistake.
      const first = traceRows(problem)[0]
      const odd = { ...answers, [first.fieldId]: hexText(rspTrace(problem)[1] + 0x100n) }
      expect(checkProblem(problem, odd).mistake).toBeNull()
      for (const junk of ['', 'zz', '-8', '0x', '1'.repeat(40), 'ffffffffffffffff']) {
        const filled = Object.fromEntries(problem.fields.map((field) => [field.id, junk]))
        expect(() => problem.diagnose(filled)).not.toThrow()
      }
    }
  })

  it('varies: many distinct problems, and every shape appears often', () => {
    const distinct = new Set<string>()
    const counts = new Map<string, number>()
    const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
    for (let seed = 0; seed < 1000; seed++) {
      const problem = generate(seed)
      distinct.add(JSON.stringify([problem.prompt, problem.fields]))
      const lines = codeLines(problem)
      const helperAt = lines.indexOf('helper:')
      count(helperAt < 0 ? 'no call' : 'call')
      if (helperAt >= 0)
        count(lines[helperAt + 1].includes('push') ? 'helper push/pop' : 'helper sub/add')
      count(`${traceRows(problem).length} steps`)
      const kinds = new Set(traceRows(problem).map((row) => row.kind))
      for (const kind of kinds) count(`has ${kind}`)
    }
    expect(distinct.size).toBeGreaterThanOrEqual(200)
    for (const key of [
      'call',
      'no call',
      'helper push/pop',
      'helper sub/add',
      '6 steps',
      '7 steps',
      '8 steps',
      '9 steps',
      'has push',
      'has pop',
      'has sub',
      'has add',
    ]) {
      expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(20)
    }
  })

  it('has clean text: no undefined, NaN, [object or raw bigint; a one-line reason', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const texts: string[] = [problem.reason, problem.stepper.note ?? '']
      for (const block of problem.prompt) {
        if (block.type === 'text') texts.push(block.text)
        if (block.type === 'code') texts.push(...block.lines)
        if (block.type === 'trace') texts.push(...block.rows.map((row) => row.text))
      }
      for (const field of problem.fields) texts.push(field.label, field.expectedDisplay)
      for (const answers of [wrongWayTrace(problem), forgetsCallRet(problem)]) {
        texts.push(problem.diagnose(answers)?.message ?? '')
      }
      for (const text of texts) {
        expect(text).not.toMatch(/undefined|NaN|\[object|\b\d+n\b/)
      }
      expect(problem.reason).not.toContain('\n')
      expect(problem.reason.length).toBeLessThan(220)
    }
  })

  it('works out the first step that crosses a multiple of 0x100 in the reason, with its numbers', () => {
    // The browser review: the reason was one generic rule. It now names the step whose sum
    // is the tricky one, and gives a decimal amount in hex too ("40 (0x28)").
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const facts =
        /Step (\d) in hex: (0x[0-9a-f]+) ([−+]) (\d+)(?: \((0x[0-9a-f]+)\))? = (0x[0-9a-f]+)\.$/.exec(
          problem.reason,
        )
      if (facts === null) throw new Error(`${problem.id}: ${problem.reason}`)
      const [, step, before, sign, size, sizeHex, after] = facts
      const values = [
        startOf(problem),
        ...problem.fields.map((field) => BigInt(`0x${field.expected}`)),
      ]
      const index = Number(step)
      expect(BigInt(before ?? '')).toBe(values[index - 1])
      expect(BigInt(after ?? '')).toBe(values[index])
      const moved = BigInt(size ?? '0')
      expect(values[index] - (values[index - 1] ?? 0n)).toBe(sign === '−' ? -moved : moved)
      if (moved >= 10n) expect(BigInt(sizeHex ?? '')).toBe(moved)
      // It is the first step that crosses a multiple of 0x100.
      const first = values.findIndex(
        (value, at) => at > 0 && value >> 8n !== (values[at - 1] ?? 0n) >> 8n,
      )
      expect(index).toBe(first)
    }
  })
})
