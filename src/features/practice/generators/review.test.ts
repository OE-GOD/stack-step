/**
 * Review of the practice answer keys and the mistake diagnoses (milestone 5).
 *
 * Every test in the first part proves one finding of the review: a student who did one
 * thing is told they did another, a correct answer is marked wrong, or a message is not
 * plain English. While a finding is open, its test FAILS on purpose. The test name says
 * what should happen.
 *
 * The second part ("guards") passes today. It pins the nearby cases that the generators
 * already name correctly, so a fix for a finding cannot break them.
 *
 * The simulated students below work from the question text only (the start value, the
 * trace rows, the listing), never from `expected`.
 */
import { describe, expect, it } from 'vitest'
import { checkProblem } from '../check'
import { buildQuiz } from '../session'
import type { Problem } from '../types'
import { makeProblem } from './index'

/* ─────────────────────────────── helpers ─────────────────────────────── */

const hex = (value: bigint): string => `0x${value.toString(16)}`

function textOf(problem: Problem, index: number): string {
  const block = problem.prompt[index]
  if (block?.type !== 'text') throw new Error(`${problem.id}: block ${index} is not text`)
  return block.text
}

/** What `diagnose` names for these typed answers ('CORRECT' when they are right). */
function named(problem: Problem, answers: Record<string, string>): string {
  const result = checkProblem(problem, answers)
  return result.correct ? 'CORRECT' : (result.mistake?.code ?? 'null')
}

/** The same decimal slip the specification describes: 0x200 − 8 → 0x192. */
function decimalSlip(start: bigint, change: bigint): bigint | null {
  const digits = start.toString(16)
  if (!/^[0-9]+$/.test(digits)) return null
  const wrong = BigInt(digits) + change
  if (wrong < 0n) return null
  const asHex = BigInt(`0x${wrong.toString(10)}`)
  return asHex === start + change ? null : asHex
}

/* ── rsp-tracker: a simulated student builds each step from their OWN last answer ── */

interface TraceRow {
  text: string
  fieldId: string
}

function rspTrace(problem: Problem): { start: bigint; rows: TraceRow[] } {
  const start = /starts at (0x[0-9a-f]+)/.exec(textOf(problem, 0))?.[1]
  const trace = problem.prompt.find((block) => block.type === 'trace')
  if (start === undefined || trace?.type !== 'trace') throw new Error(`${problem.id}: no trace`)
  return { start: BigInt(start), rows: trace.rows.map(({ text, fieldId }) => ({ text, fieldId })) }
}

type Move = (rsp: bigint, text: string) => bigint

const kindOf = (text: string): string => text.split(' ')[0] ?? ''
const isBoxMove = (text: string): boolean => ['push', 'pop', 'call', 'ret'].includes(kindOf(text))
const goesDown = (text: string): boolean => ['push', 'call', 'sub'].includes(kindOf(text))
const amountOf = (text: string): bigint => BigInt(/(\d+)$/.exec(text)?.[1] ?? '8')

/** The right rule. */
const rightMove: Move = (rsp, text) => {
  const size = isBoxMove(text) ? 8n : amountOf(text)
  return goesDown(text) ? rsp - size : rsp + size
}

/** push/pop/call/ret move rsp by `box` bytes; `sub`/`add` are right. */
const boxOf =
  (box: bigint): Move =>
  (rsp, text) =>
    isBoxMove(text) ? (goesDown(text) ? rsp - box : rsp + box) : rightMove(rsp, text)

function rspAnswers(problem: Problem, move: (rsp: bigint, text: string, index: number) => bigint) {
  const { start, rows } = rspTrace(problem)
  const answers: Record<string, string> = {}
  let rsp = start
  rows.forEach((row, index) => {
    rsp = move(rsp, row.text, index)
    answers[row.fieldId] = hex(rsp)
  })
  return answers
}

/* ── call-ret: the five answers, worked out from the listing ── */

interface CallRetFacts {
  rsp: bigint
  callAddress: bigint
  returnAddress: bigint
  functionAddress: bigint
}

function callRetFacts(problem: Problem): CallRetFacts {
  const match = /rsp is (0x[0-9a-f]+) just before the `call` on line (\d+)/.exec(textOf(problem, 0))
  const code = problem.prompt.find((block) => block.type === 'code')
  if (match === null || code?.type !== 'code' || code.addresses === undefined) {
    throw new Error(`${problem.id}: not a call-ret problem`)
  }
  const callLine = Number(match[2])
  const name = /call (\w+)/.exec(code.lines[callLine - 1] ?? '')?.[1]
  const fnRow = code.lines.findIndex((line) => line.trim() === `${name ?? '?'}:`)
  const at = (row: number) => BigInt(code.addresses?.[row] ?? '0')
  return {
    rsp: BigInt(match[1] ?? '0'),
    callAddress: at(callLine - 1),
    returnAddress: at(callLine),
    functionAddress: at(fnRow),
  }
}

function callRetAnswers(facts: CallRetFacts, rspAfterCall: bigint, rspAfterRet: bigint) {
  return {
    rspAfterCall: hex(rspAfterCall),
    pushed: hex(facts.returnAddress),
    ripAfterCall: hex(facts.functionAddress),
    ripAfterRet: hex(facts.returnAddress),
    rspAfterRet: hex(rspAfterRet),
  }
}

/* ─────────────────────────────── findings ────────────────────────────── */

describe('finding: rsp-tracker names a consistent misconception for what the student did', () => {
  it('a student who moves rsp 4 bytes per box (the 32-bit habit) is told about the box size, not that `call` leaves rsp alone (seed 0)', () => {
    // Seed 0: start 0xa00; push rbx, call helper, sub rsp 32, add rsp 32, ret, pop rbx, ret.
    // The student types 0x9fc, 0x9f8, 0x9d8, 0x9f8, 0x9fc, 0xa00, 0xa04. Their `call` did move
    // rsp (0x9fc → 0x9f8), but 0x9f8 is also the right rsp BEFORE the call, so today the
    // site says "`call` moves rsp too: it pushes the return address …".
    const problem = makeProblem('rsp-tracker', 0)
    expect(named(problem, rspAnswers(problem, boxOf(4n)))).toBe('rsp-wrong-amount')
  })

  it('a student who moves rsp 16 bytes per box is told about the box size, not that `ret` leaves rsp alone (seed 0)', () => {
    const problem = makeProblem('rsp-tracker', 0)
    expect(named(problem, rspAnswers(problem, boxOf(16n)))).toBe('rsp-wrong-amount')
  })

  it('over seeds 0…499, a student with 4- or 16-byte boxes is never told call-ret-forgot-stack', () => {
    const wrong: string[] = []
    for (let seed = 0; seed < 500; seed++) {
      const problem = makeProblem('rsp-tracker', seed)
      for (const box of [4n, 16n]) {
        if (named(problem, rspAnswers(problem, boxOf(box))) === 'call-ret-forgot-stack') {
          wrong.push(`seed ${seed} (${box.toString()}-byte boxes)`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it('a student whose pop and ret also move rsp down is not told "you used an old value of rsp" (seed 5)', () => {
    // Today: "You used an old value of rsp. Step 8 changed rsp to 0x208, and step 9 starts
    // from there." The student's step 9 does start from their own step 8 (0x1f8 − 8).
    const problem = makeProblem('rsp-tracker', 5)
    const answers = rspAnswers(problem, (rsp, text) =>
      isBoxMove(text) ? rsp - 8n : rightMove(rsp, text),
    )
    expect(named(problem, answers)).not.toBe('stale-value')
  })

  it('a student who moves push/pop/call/ret correctly but reverses sub/add is not told that push and pop went the wrong way (seed 1882)', () => {
    const problem = makeProblem('rsp-tracker', 1882)
    const answers = rspAnswers(problem, (rsp, text) =>
      isBoxMove(text)
        ? rightMove(rsp, text)
        : goesDown(text)
          ? rsp + amountOf(text)
          : rsp - amountOf(text),
    )
    expect(named(problem, answers)).not.toBe('rsp-wrong-direction')
  })
})

describe('finding: call-ret names a slip at the `call` at the `call`, not at the `ret`', () => {
  it('rsp moved down 16 at the call, then up 8 at the ret: not "`ret` moves rsp too" (seed 0)', () => {
    // Seed 0: rsp 0xa50. The student types 0xa40 after the call and 0xa48 after the ret:
    // their ret DID move rsp up by 8. Today the site names call-ret-forgot-stack for the ret.
    const problem = makeProblem('call-ret', 0)
    const facts = callRetFacts(problem)
    const answers = callRetAnswers(facts, facts.rsp - 16n, facts.rsp - 8n)
    expect(named(problem, answers)).not.toBe('call-ret-forgot-stack')
  })

  it('over seeds 0…499, a call that moves rsp by 16 or 24 and a ret that adds 8 is never blamed on the ret', () => {
    const wrong: string[] = []
    for (let seed = 0; seed < 500; seed++) {
      const problem = makeProblem('call-ret', seed)
      const facts = callRetFacts(problem)
      for (const moved of [16n, 24n]) {
        const answers = callRetAnswers(facts, facts.rsp - moved, facts.rsp - moved + 8n)
        const code = named(problem, answers)
        if (code === 'call-ret-forgot-stack' || code === 'rsp-wrong-direction') {
          wrong.push(`seed ${seed} (call moved ${moved.toString()}): ${code}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})

describe('finding: indirect-addressing names the first cause of a slip carried down a chain', () => {
  it('seed 1660: rbp + 8 used for `[rbp-8]` on line 1, carried into line 2, is named wrong-offset-direction', () => {
    // rbp = 0x230. Line 1 `lea rbx, [rbp-8]` → the student writes rbx = 0x238 (rbp + 8).
    // Line 2 `mov rsi, [rbx+8]` → from their rbx they read the box at 0x240, which holds
    // 0x230. Today the site says "For `rsi` you gave the address, 0x230. `mov` copies what
    // is stored AT that address", but the student used `mov` correctly.
    const problem = makeProblem('indirect-addressing', 1660)
    expect(textOf(problem, 0)).toContain('`rbp` and `rsp` point to boxes')
    expect(named(problem, { rbx: '0x238', rsi: '0x230' })).toBe('wrong-offset-direction')
  })
})

describe('finding: rip form B never makes "added in decimal" equal to the address of another line', () => {
  it('over seeds 0…1999, the decimal slip for "Address of line p" is not the address of another line', () => {
    // Seed 459: the first line is at 0x4537 and line 1 takes 3 bytes. Line 2 is at 0x453a,
    // and 4537 + 3 = 4540 in decimal is 0x4540, which is ALSO the address of line 3. A
    // student who counts one line too far is told "It looks like you added in decimal".
    // Form C already moves the code when its decimal slip meets a label address.
    const collisions: number[] = []
    for (let seed = 0; seed < 2000; seed++) {
      const problem = makeProblem('rip', seed)
      const first = /^The first line is at address (0x[0-9a-f]+)\./.exec(textOf(problem, 0))?.[1]
      const code = problem.prompt.find((block) => block.type === 'code')
      if (first === undefined || code?.type !== 'code') continue
      const addresses = [BigInt(first)]
      for (const line of code.lines) {
        const size = BigInt(/#\s*(\d+) bytes?$/.exec(line)?.[1] ?? '0')
        addresses.push((addresses[addresses.length - 1] ?? 0n) + size)
      }
      const p = Number(/line (\d+)/.exec(problem.fields[0]?.label ?? '')?.[1])
      const q = Number(/line (\d+)/.exec(problem.fields[1]?.label ?? '')?.[1])
      const target = addresses[p - 1] ?? 0n
      const slip = decimalSlip(BigInt(first), target - BigInt(first))
      // What a student could plausibly type instead: another listed line's address, or the
      // answer of the other box ("rip while line q runs" = the address of line q + 1).
      const plausible = [...addresses.slice(0, code.lines.length), addresses[q] ?? -1n]
      if (slip !== null && plausible.includes(slip)) collisions.push(seed)
    }
    expect(collisions).toEqual([])
  })
})

describe('finding: register-names messages are plain, correct English', () => {
  it('never says "1 byte are 8 bits"', () => {
    const bad: string[] = []
    for (let seed = 0; seed < 1000; seed++) {
      const problem = makeProblem('register-names', seed)
      const bits = problem.fields.find((field) => field.id === 'bits')
      if (bits?.expected !== '8') continue
      const answers: Record<string, string> = {}
      for (const field of problem.fields) answers[field.id] = field.expected
      answers.bits = '1'
      const message = checkProblem(problem, answers).mistake?.message ?? ''
      if (message.includes('1 byte are')) bad.push(`${problem.id}: ${message}`)
    }
    expect(bad).toEqual([])
  })
})

describe('finding: check.ts accepts a decimal answer typed with its unit', () => {
  it('register-names seed 0 ("How many bytes is that?", right answer 4) accepts "4 bytes"', () => {
    const problem = makeProblem('register-names', 0)
    expect(textOf(problem, 0)).toBe(
      'What is the name of the 32-bit part of `rax`? How many bytes is that?',
    )
    expect(checkProblem(problem, { name: 'eax', bytes: '4 bytes' }).correct).toBe(true)
    expect(checkProblem(problem, { name: 'eax', bytes: '4bytes' }).correct).toBe(true)
    // The other unit is never right, and it is named as a bits-vs-bytes slip.
    const bits = checkProblem(problem, { name: 'eax', bytes: '32 bits' })
    expect(bits.correct).toBe(false)
    expect(bits.mistake?.code).toBe('bits-vs-bytes')
    expect(checkProblem(problem, { name: 'eax', bytes: '4 bits' }).correct).toBe(false)
  })
})

describe('finding: indirect-addressing "Show me" does not call an ordinary box a return address', () => {
  it('seeds 0…49: no box of the question is a return address in the stepper', async () => {
    const { createEmulator } = await import('../../../emulator')
    const labelled: string[] = []
    for (let seed = 0; seed < 50; seed++) {
      const problem = makeProblem('indirect-addressing', seed)
      const made = createEmulator(problem.stepper.code, problem.stepper.options ?? {})
      if (!made.ok) throw new Error(`${problem.id}: Show me does not assemble`)
      const stack = problem.prompt.find((block) => block.type === 'stack')
      const shown = new Set(
        stack?.type === 'stack' ? stack.rows.map((row) => BigInt(row.address)) : [],
      )
      for (const slot of made.emulator.getSnapshot().stack) {
        if (shown.has(slot.address) && slot.kind === 'return-address') {
          labelled.push(
            `${problem.id}: ${hex(slot.address)} holds ${hex(slot.value ?? 0n)}, labelled "${slot.label ?? ''}"`,
          )
        }
      }
    }
    expect(labelled).toEqual([])
  })
})

describe('finding: the mock quiz does not ask the same question twice', () => {
  it('quiz 107 has 15 different questions', () => {
    // Today questions 5 and 9 are the same register-names question (seeds 307056384 and
    // 404718107 make the same problem). About 0.4% of quizzes repeat a question.
    const questions = buildQuiz(107)
    const asked = questions.map((question) =>
      JSON.stringify([question.topic, question.problem.prompt]),
    )
    expect(new Set(asked).size).toBe(questions.length)
  })
})

/* ───────────────────── guards (pass today; keep them passing) ───────────────────── */

describe('guard: cases the diagnoses name correctly today', () => {
  const seeds = Array.from({ length: 200 }, (_, seed) => seed)

  it('rsp-tracker: every push/pop/call/ret the wrong way is rsp-wrong-direction', () => {
    for (const seed of seeds) {
      const problem = makeProblem('rsp-tracker', seed)
      const answers = rspAnswers(problem, (rsp, text) =>
        isBoxMove(text) ? (goesDown(text) ? rsp + 8n : rsp - 8n) : rightMove(rsp, text),
      )
      expect(named(problem, answers), problem.id).toBe('rsp-wrong-direction')
    }
  })

  it('rsp-tracker: one `call` or `ret` that leaves rsp alone, then right steps, is call-ret-forgot-stack', () => {
    for (const seed of seeds) {
      const problem = makeProblem('rsp-tracker', seed)
      rspTrace(problem).rows.forEach((row, at) => {
        if (kindOf(row.text) !== 'call' && kindOf(row.text) !== 'ret') return
        const answers = rspAnswers(problem, (rsp, text, index) =>
          index === at ? rsp : rightMove(rsp, text),
        )
        expect(named(problem, answers), `${problem.id} step ${at + 1}`).toBe(
          'call-ret-forgot-stack',
        )
      })
    }
  })

  it('rsp-tracker: one step done in decimal, then right steps from there, is decimal-arithmetic', () => {
    for (const seed of seeds) {
      const problem = makeProblem('rsp-tracker', seed)
      rspTrace(problem).rows.forEach((row, at) => {
        const answers = rspAnswers(problem, (rsp, text, index) => {
          if (index !== at) return rightMove(rsp, text)
          const change = rightMove(rsp, text) - rsp
          return decimalSlip(rsp, change) ?? rightMove(rsp, text)
        })
        if (named(problem, answers) === 'CORRECT') return
        expect(named(problem, answers), `${problem.id} step ${at + 1} (${row.text})`).toBe(
          'decimal-arithmetic',
        )
      })
    }
  })

  it('rsp-tracker: one push/pop/call/ret that moves 16, then right steps, is rsp-wrong-amount', () => {
    for (const seed of seeds) {
      const problem = makeProblem('rsp-tracker', seed)
      rspTrace(problem).rows.forEach((row, at) => {
        if (!isBoxMove(row.text)) return
        const answers = rspAnswers(problem, (rsp, text, index) =>
          index === at ? boxOf(16n)(rsp, text) : rightMove(rsp, text),
        )
        expect(named(problem, answers), `${problem.id} step ${at + 1}`).toBe('rsp-wrong-amount')
      })
    }
  })

  it('call-ret: the classic slips are named, also when the ret is worked out from the student’s own rsp', () => {
    for (const seed of seeds) {
      const problem = makeProblem('call-ret', seed)
      const facts = callRetFacts(problem)
      const right = callRetAnswers(facts, facts.rsp - 8n, facts.rsp)
      expect(named(problem, right), problem.id).toBe('CORRECT')
      expect(
        named(problem, { ...right, pushed: right.ripAfterCall, ripAfterCall: right.pushed }),
      ).toBe('return-address-in-rip')
      expect(
        named(problem, {
          ...right,
          pushed: hex(facts.callAddress),
          ripAfterRet: hex(facts.callAddress),
        }),
      ).toBe('return-address-is-call')
      expect(named(problem, callRetAnswers(facts, facts.rsp + 8n, facts.rsp))).toBe(
        'rsp-wrong-direction',
      )
      expect(named(problem, callRetAnswers(facts, facts.rsp, facts.rsp + 8n))).toBe(
        'call-ret-forgot-stack',
      )
      expect(named(problem, callRetAnswers(facts, facts.rsp - 8n, facts.rsp - 8n))).toBe(
        'call-ret-forgot-stack',
      )
      const slip = decimalSlip(facts.rsp, -8n)
      if (slip !== null) {
        expect(named(problem, callRetAnswers(facts, slip, slip + 8n)), problem.id).toBe(
          'decimal-arithmetic',
        )
      }
    }
  })
})
