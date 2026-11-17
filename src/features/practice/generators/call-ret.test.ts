import { describe, expect, it } from 'vitest'
import { assemble, createEmulator, type Program } from '../../../emulator'
import { checkProblem } from '../check'
import type { MistakeCode, Problem, PromptBlock } from '../types'
import { generate } from './call-ret'

const SEEDS = Array.from({ length: 500 }, (_, seed) => seed)

/* ─────────────────────── reading a problem like a student ───────────────────── */

const hexText = (value: bigint) => value.toString(16)

function listing(problem: Problem): Extract<PromptBlock, { type: 'code' }> {
  const block = problem.prompt.find((item) => item.type === 'code')
  if (block?.type !== 'code' || block.addresses === undefined) throw new Error('no listing')
  return block
}

interface Read {
  rspBefore: bigint
  callLine: number
  fn: string
  lines: readonly string[]
  addresses: bigint[]
}

function read(problem: Problem): Read {
  const text = problem.prompt.find((item) => item.type === 'text')
  const match =
    text?.type === 'text'
      ? /^rsp is (0x[0-9a-f]+) just before the `call` on line (\d+)\. Answer in hex\.$/.exec(
          text.text,
        )
      : null
  if (!match) throw new Error('no rsp in the prompt')
  const block = listing(problem)
  const callLine = Number(match[2])
  const fn = /^ {4}call (\w+)$/.exec(block.lines[callLine - 1])?.[1]
  if (fn === undefined) throw new Error('no call on that line')
  return {
    rspBefore: BigInt(match[1]),
    callLine,
    fn,
    lines: block.lines,
    addresses: (block.addresses ?? []).map((value) => BigInt(value)),
  }
}

function assembled(problem: Problem): Program {
  const result = assemble(problem.stepper.code, problem.stepper.options)
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join(' | '))
  return result.program
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

interface Key {
  rspAfterCall: bigint
  pushed: bigint
  ripAfterCall: bigint
  ripAfterRet: bigint
  rspAfterRet: bigint
  callAddress: bigint
  callSize: bigint
}

/** The answers by the rules: call = push (address after the call) + jump; ret = pop into rip. */
function independentKey(problem: Problem): Key {
  const r = read(problem)
  const program = assembled(problem)
  const call = program.instructions[program.lineToIndex.get(r.callLine) ?? -1]
  const fn = program.symbols.get(r.fn)
  if (fn === undefined) throw new Error('no function label')
  // The address column is the assembler's (a label line shows the next instruction's).
  r.lines.forEach((line, index) => {
    const position = program.lineToIndex.get(index + 1) ?? program.lineToIndex.get(index + 2)
    expect(r.addresses[index], line).toBe(program.instructions[position ?? -1].address)
  })
  const returnAddress = call.address + BigInt(call.size)
  return {
    rspAfterCall: r.rspBefore - 8n,
    pushed: returnAddress,
    ripAfterCall: fn.address,
    ripAfterRet: returnAddress,
    rspAfterRet: r.rspBefore,
    callAddress: call.address,
    callSize: BigInt(call.size),
  }
}

function answersFrom(key: Key, changes: Partial<Key> = {}): Record<string, string> {
  const all = { ...key, ...changes }
  return {
    rspAfterCall: hexText(all.rspAfterCall),
    pushed: hexText(all.pushed),
    ripAfterCall: hexText(all.ripAfterCall),
    ripAfterRet: hexText(all.ripAfterRet),
    rspAfterRet: hexText(all.rspAfterRet),
  }
}

/** Every predicted mistake with the code it must get, in the order of the specification. */
function predictedMistakes(
  problem: Problem,
): { code: MistakeCode; answers: Record<string, string> }[] {
  const key = independentKey(problem)
  const s = key.rspAfterRet
  const cases: { code: MistakeCode; answers: Record<string, string> }[] = [
    // Return address and function address swapped, or the return address put in rip.
    {
      code: 'return-address-in-rip',
      answers: answersFrom(key, { pushed: key.ripAfterCall, ripAfterCall: key.pushed }),
    },
    { code: 'return-address-in-rip', answers: answersFrom(key, { ripAfterCall: key.pushed }) },
    { code: 'return-address-in-rip', answers: answersFrom(key, { pushed: key.ripAfterCall }) },
    // The address of the call itself as the return address.
    { code: 'return-address-is-call', answers: answersFrom(key, { pushed: key.callAddress }) },
    { code: 'return-address-is-call', answers: answersFrom(key, { ripAfterRet: key.callAddress }) },
    {
      code: 'return-address-is-call',
      answers: answersFrom(key, { pushed: key.callAddress, ripAfterRet: key.callAddress }),
    },
    // rsp up for call (then down again for ret: right by accident), or down for ret.
    { code: 'rsp-wrong-direction', answers: answersFrom(key, { rspAfterCall: s + 8n }) },
    { code: 'rsp-wrong-direction', answers: answersFrom(key, { rspAfterRet: s - 16n }) },
    // rsp unchanged by call (and so unchanged after ret too), or by ret.
    { code: 'call-ret-forgot-stack', answers: answersFrom(key, { rspAfterCall: s }) },
    { code: 'call-ret-forgot-stack', answers: answersFrom(key, { rspAfterRet: s - 8n }) },
  ]
  const callSlip = slipOf(s, -8n)
  if (callSlip !== null) {
    cases.push({
      code: 'decimal-arithmetic',
      answers: answersFrom(key, { rspAfterCall: callSlip }),
    })
  }
  const retSlip = slipOf(s - 8n, 8n)
  if (retSlip !== null) {
    cases.push({ code: 'decimal-arithmetic', answers: answersFrom(key, { rspAfterRet: retSlip }) })
  }
  const addressSlip = slipOf(key.callAddress, key.callSize)
  if (addressSlip !== null) {
    cases.push({ code: 'decimal-arithmetic', answers: answersFrom(key, { pushed: addressSlip }) })
  }
  // A box of 16 bytes (or 1, 2, 4) at the call or at the ret.
  for (const size of [1n, 2n, 4n, 16n]) {
    cases.push({ code: 'rsp-wrong-amount', answers: answersFrom(key, { rspAfterCall: s - size }) })
    cases.push({
      code: 'rsp-wrong-amount',
      answers: answersFrom(key, { rspAfterRet: s - 8n + size }),
    })
  }
  return cases
}

/**
 * A slip at the `call`, and then a `ret` worked out RIGHT from the student's own rsp
 * (+ 8): the code the slip at the call must get (null: no known mistake).
 */
function carriedCallSlips(problem: Problem): { code: MistakeCode | null; rsp: bigint }[] {
  const s = independentKey(problem).rspAfterRet
  const slips: { code: MistakeCode | null; rsp: bigint }[] = [
    { code: 'rsp-wrong-direction', rsp: s + 8n },
    { code: 'call-ret-forgot-stack', rsp: s },
    { code: 'rsp-wrong-amount', rsp: s - 16n },
    { code: 'rsp-wrong-amount', rsp: s - 4n },
    { code: null, rsp: s - 24n },
    { code: null, rsp: s - 8n + 0x100n },
  ]
  const decimal = slipOf(s, -8n)
  if (decimal !== null) slips.push({ code: 'decimal-arithmetic', rsp: decimal })
  return slips
}

/** Everything of a problem except its `diagnose` function (functions never compare equal). */
function withoutDiagnose(problem: Problem): Record<string, unknown> {
  return Object.fromEntries(Object.entries(problem).filter(([key]) => key !== 'diagnose'))
}

/* ─────────────────────────────────── tests ──────────────────────────────── */

describe('call-ret generator', () => {
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

  it('has an id, a topic and the five fields of the specification', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      expect(problem.id).toBe(`call-ret-${seed}`)
      expect(problem.topic).toBe('call-ret')
      expect(problem.view).toBe('form')
      expect(problem.fields.map((field) => field.id)).toEqual([
        'rspAfterCall',
        'pushed',
        'ripAfterCall',
        'ripAfterRet',
        'rspAfterRet',
      ])
      for (const field of problem.fields) expect(field.kind).toEqual({ type: 'hex' })
    }
  })

  it('accepts the expected answers, also typed in other ways', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const right = Object.fromEntries(problem.fields.map((f) => [f.id, f.expectedDisplay]))
      expect(checkProblem(problem, right).correct).toBe(true)
      const typed = Object.fromEntries(
        problem.fields.map((f) => [f.id, `0x 0${f.expected.toUpperCase()}`]),
      )
      expect(checkProblem(problem, typed).correct).toBe(true)
    }
  })

  it('has the answer key the rules of call and ret give', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const key = independentKey(problem)
      const expected = Object.fromEntries(problem.fields.map((f) => [f.id, f.expected]))
      expect(expected).toEqual(answersFrom(key))
      // rsp before the call is lined up to 16 bytes, in the small world, and every rsp of
      // the problem (down to rsp − 16 inside the function) has 3 hex digits.
      const { rspBefore } = read(problem)
      expect(rspBefore % 16n).toBe(0n)
      expect(rspBefore - 16n).toBeGreaterThanOrEqual(0x100n)
      expect(rspBefore).toBeLessThanOrEqual(0xff0n)
      // Code addresses have 4 hex digits.
      expect(key.callAddress).toBeGreaterThanOrEqual(0x4000n)
      expect(key.ripAfterCall).toBeLessThanOrEqual(0x4fffn)
    }
  })

  it('a hand-checked problem', () => {
    // Seed 5, on paper: the call at 0x4780 is 5 bytes, so the return address is 0x4785.
    // call: rsp 0x790 − 8 = 0x788, the box at 0x788 holds 0x4785, rip = add_five = 0x4788.
    // ret: rip = 0x4785 (popped), rsp = 0x788 + 8 = 0x790.
    const problem = generate(5)
    const { lines, addresses } = listing(problem)
    expect(lines[3]).toBe('    call add_five')
    expect(addresses?.[3]).toBe('0x4780')
    expect(addresses?.[6]).toBe('0x4788')
    expect(problem.fields.map((field) => field.expectedDisplay)).toEqual([
      '0x788',
      '0x4785',
      '0x4788',
      '0x4785',
      '0x790',
    ])
  })

  it('the stepper program is the problem: stepping it shows the same values', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const r = read(problem)
      expect(problem.stepper.code).toBe(`${r.lines.join('\n')}\n`)
      expect(problem.stepper.note).toMatch(/^[A-Z][^.]*\.$/)
      const made = createEmulator(problem.stepper.code, problem.stepper.options)
      expect(made.ok).toBe(true)
      if (!made.ok) continue
      const emulator = made.emulator
      const value = (id: string) => problem.fields.find((field) => field.id === id)?.expected
      let step = emulator.step()
      for (let guard = 0; step.line !== r.callLine && guard < 50; guard++) step = emulator.step()
      expect(step.line).toBe(r.callLine)
      const afterCall = emulator.getSnapshot()
      expect(hexText(afterCall.registers.rsp)).toBe(value('rspAfterCall'))
      expect(hexText(afterCall.rip)).toBe(value('ripAfterCall'))
      const top = emulator.readMemory(afterCall.registers.rsp, 8)
      const word = top.reduceRight((total, byte) => (total << 8n) | BigInt(byte ?? 0), 0n)
      expect(hexText(word)).toBe(value('pushed'))
      // Run on to the function's ret (the last line of the listing).
      for (let guard = 0; step.line !== r.lines.length && guard < 50; guard++) {
        step = emulator.step()
      }
      expect(step.line).toBe(r.lines.length)
      const afterRet = emulator.getSnapshot()
      expect(hexText(afterRet.rip)).toBe(value('ripAfterRet'))
      expect(hexText(afterRet.registers.rsp)).toBe(value('rspAfterRet'))
      expect(emulator.run().reason).toBe('halted')
      expect(emulator.getSnapshot().error).toBeNull()
    }
  })

  it('names every predicted mistake, and never a right answer', () => {
    const seen = new Map<MistakeCode, number>()
    for (const seed of SEEDS) {
      const problem = generate(seed)
      for (const { code, answers } of predictedMistakes(problem)) {
        const result = checkProblem(problem, answers)
        expect(result.correct, `seed ${seed} ${code}`).toBe(false)
        expect(result.mistake?.code, `seed ${seed} ${JSON.stringify(answers)}`).toBe(code)
        seen.set(code, (seen.get(code) ?? 0) + 1)
      }
    }
    expect(seen.get('decimal-arithmetic') ?? 0).toBeGreaterThanOrEqual(100)
  })

  it('names a slip at the `call` at the call, when the `ret` is worked out right from it', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const key = independentKey(problem)
      for (const { code, rsp } of carriedCallSlips(problem)) {
        const answers = answersFrom(key, { rspAfterCall: rsp, rspAfterRet: rsp + 8n })
        const mistake = checkProblem(problem, answers).mistake
        expect(mistake?.code ?? null, `seed ${seed}: call → 0x${hexText(rsp)}`).toBe(code)
        // The ret was right from the student's own rsp: it is never the one blamed.
        expect(mistake?.message ?? '').not.toMatch(/^`ret`/)
      }
    }
  })

  it('mistake messages are short and use this problem’s numbers', () => {
    const problem = generate(5)
    const key = independentKey(problem)
    const message = (changes: Partial<Key>) =>
      checkProblem(problem, answersFrom(key, changes)).mistake?.message
    expect(message({ ripAfterCall: key.pushed })).toBe(
      'You put the return address in rip. `call` saves the return address (0x4785) on the stack; rip gets the address of `add_five` (0x4788).',
    )
    expect(message({ pushed: key.callAddress })).toBe(
      'The return address is the line after the `call` (0x4785), not the `call` itself (0x4780). Going back to the `call` would run it again.',
    )
    expect(message({ rspAfterCall: 0x790n })).toBe(
      '`call` moves rsp too: it pushes the return address, so rsp goes down by 8 (0x790 → 0x788).',
    )
    for (const seed of SEEDS) {
      const p = generate(seed)
      for (const { answers } of predictedMistakes(p)) {
        const text = checkProblem(p, answers).mistake?.message ?? ''
        expect(text.split(/(?<=\.)\s(?=[A-Z`])/).length).toBeLessThanOrEqual(2)
        expect(text).toMatch(/0x[0-9a-f]+/)
      }
    }
  })

  it('returns null for wrong answers it cannot explain, and never throws on junk', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const key = independentKey(problem)
      // Everything shifted by 0x100: wrong, but not one of the known mistakes.
      const odd = answersFrom(key, {
        rspAfterCall: key.rspAfterCall + 0x100n,
        rspAfterRet: key.rspAfterRet + 0x100n,
      })
      expect(checkProblem(problem, odd).mistake).toBeNull()
      for (const junk of ['', 'call', '-8', '0x', 'f'.repeat(40)]) {
        const filled = Object.fromEntries(problem.fields.map((field) => [field.id, junk]))
        expect(() => problem.diagnose(filled)).not.toThrow()
      }
    }
  })

  it('varies: many distinct problems; with and without a push/pop in the function', () => {
    const distinct = new Set<string>()
    const counts = new Map<string, number>()
    const count = (key: string) => counts.set(key, (counts.get(key) ?? 0) + 1)
    for (let seed = 0; seed < 1000; seed++) {
      const problem = generate(seed)
      distinct.add(JSON.stringify([problem.prompt, problem.fields]))
      const { lines, fn, callLine } = read(problem)
      const body = lines.slice(lines.indexOf(`${fn}:`) + 1)
      count(body.some((line) => line.includes('push')) ? 'push/pop' : 'no push/pop')
      count(`call on line ${callLine}`)
      count(fn)
    }
    expect(distinct.size).toBeGreaterThanOrEqual(200)
    for (const key of ['push/pop', 'no push/pop', 'call on line 3', 'call on line 4']) {
      expect(counts.get(key) ?? 0, key).toBeGreaterThanOrEqual(20)
    }
  })

  it('has clean text: no undefined, NaN, [object or raw bigint; a one-line reason', () => {
    for (const seed of SEEDS) {
      const problem = generate(seed)
      const { lines, addresses } = listing(problem)
      const all: string[] = [
        problem.reason,
        problem.stepper.note ?? '',
        ...lines,
        ...(addresses ?? []),
      ]
      for (const block of problem.prompt) if (block.type === 'text') all.push(block.text)
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
