/**
 * Follow rsp through `push`, `pop`, `call`, `ret`, `sub rsp, N` and `add rsp, N`.
 *
 * Build: `main` with a balanced mix of stack lines and (usually) one `call` to a helper
 * that does a push/pop pair or a sub/add pair. Run it once from a probe rsp to learn how
 * far rsp moves at each step, pick a starting rsp so that at least two steps cross a
 * multiple of 0x100 (…00 − 8 = …f8), then run it again from there. The rsp after each
 * step of that second run is the answer key.
 *
 * Diagnosis. Students build a trace from their own previous line, so each step is compared
 * with the student's OWN answer for the step before (the right rsp only for step 1, or
 * after a blank or unreadable answer). A step that applies the right change to that
 * answer is a carried slip, not a new mistake. Whole-trace habits are looked for first
 * (every push/pop/call/ret the wrong way, or by the wrong box size), then single steps.
 */
import type { Reg64 } from '../../../emulator'
import { createRng, type Rng } from '../../../lib/rng'
import {
  answerIs,
  codeBlock,
  decimalSlip,
  hexField,
  readAsHex,
  runProgram,
  show,
  smallWorld,
  textBlock,
  type ProgramRun,
} from '../gen/helpers'
import type { Mistake, Problem, ProblemGenerator, PromptBlock } from '../types'

/* ─────────────────────────────── the program ─────────────────────────────── */

/** `sub rsp, N` and `add rsp, N` use these numbers, written in decimal as in class. */
const AMOUNTS = [8, 16, 24, 32, 40, 48] as const

/** Registers that `push` and `pop` use. */
const STACK_REGISTERS: readonly Reg64[] = [
  'rax',
  'rbx',
  'rcx',
  'rdx',
  'rsi',
  'rdi',
  'rbp',
  'r12',
  'r13',
]

/** `main` never goes deeper than this many bytes below the starting rsp. */
const MAX_DEPTH = 96

type MainLine =
  { kind: 'push' | 'pop'; reg: Reg64 } | { kind: 'sub' | 'add'; amount: number } | { kind: 'call' }

type Helper = { kind: 'push-pop'; reg: Reg64 } | { kind: 'sub-add'; amount: number }

const HELPER = 'helper'

/** The first line of the stepper program (gcc needs it; the question does not show it). */
const STEPPER_HEADER = '    .intel_syntax noprefix'

function lineText(line: MainLine): string {
  switch (line.kind) {
    case 'push':
    case 'pop':
      return `${line.kind} ${line.reg}`
    case 'sub':
    case 'add':
      return `${line.kind} rsp, ${line.amount}`
    case 'call':
      return `call ${HELPER}`
  }
}

function helperLines(helper: Helper): string[] {
  return helper.kind === 'push-pop'
    ? [`push ${helper.reg}`, `pop ${helper.reg}`]
    : [`sub rsp, ${helper.amount}`, `add rsp, ${helper.amount}`]
}

/** True when `depth` bytes can be given back in exactly `left` more lines. */
function canFinish(depth: number, left: number): boolean {
  if (left === 0) return depth === 0
  if (depth === 0) return left >= 2
  return depth <= AMOUNTS[AMOUNTS.length - 1] * left
}

/** One item, chosen with probability proportional to its weight. */
function pickWeighted<T>(rng: Rng, items: readonly { value: T; weight: number }[]): T {
  const total = items.reduce((sum, item) => sum + item.weight, 0)
  let roll = rng.int(1, total)
  for (const item of items) {
    roll -= item.weight
    if (roll <= 0) return item.value
  }
  throw new Error('pickWeighted: the list is empty.')
}

/**
 * `count` lines that start and end at the starting rsp. Each box below the start holds
 * either a pushed register or reserved space (from `sub`), so a `pop` only ever takes a
 * box that a `push` filled.
 */
function balancedLines(rng: Rng, count: number): MainLine[] {
  const lines: MainLine[] = []
  const boxes: (Reg64 | null)[] = []
  for (let index = 0; index < count; index++) {
    const left = count - index - 1
    const depth = boxes.length * 8
    const top = boxes.length > 0 ? boxes[boxes.length - 1] : null
    const fits = (next: number) => next <= MAX_DEPTH && canFinish(next, left)

    const subs = AMOUNTS.filter((amount) => fits(depth + amount))
    const adds = AMOUNTS.filter((amount) => amount <= depth && fits(depth - amount))
    const kinds: { value: MainLine['kind']; weight: number }[] = []
    if (fits(depth + 8)) kinds.push({ value: 'push', weight: 3 })
    if (top !== null && fits(depth - 8)) kinds.push({ value: 'pop', weight: 3 })
    if (subs.length > 0) kinds.push({ value: 'sub', weight: 2 })
    if (adds.length > 0) kinds.push({ value: 'add', weight: 2 })

    const chosen = pickWeighted(rng, kinds)
    if (chosen === 'push') {
      const reg = rng.pick(STACK_REGISTERS)
      boxes.push(reg)
      lines.push({ kind: 'push', reg })
    } else if (chosen === 'pop' && top !== null) {
      // Usually back into the same register (a restore); sometimes into another (a swap).
      const reg = rng.chance(0.75) ? top : rng.pick(STACK_REGISTERS.filter((r) => r !== top))
      boxes.pop()
      lines.push({ kind: 'pop', reg })
    } else if (chosen === 'sub') {
      const amount = rng.pick(subs)
      for (let box = 0; box < amount / 8; box++) boxes.push(null)
      lines.push({ kind: 'sub', amount })
    } else if (chosen === 'add') {
      // Usually give back exactly the space a `sub` reserved on top.
      let reserved = 0
      while (reserved < boxes.length && boxes[boxes.length - 1 - reserved] === null) reserved++
      const undo = adds.find((amount) => amount === reserved * 8)
      const amount = undo !== undefined && rng.chance(0.6) ? undo : rng.pick(adds)
      boxes.splice(boxes.length - amount / 8, amount / 8)
      lines.push({ kind: 'add', amount })
    } else {
      throw new Error('rsp-tracker: no line fits (a bug in balancedLines).')
    }
  }
  if (boxes.length !== 0) throw new Error('rsp-tracker: main does not give back its boxes.')
  return lines
}

interface Shape {
  main: MainLine[]
  helper: Helper | null
}

/** Program shape: 6 to 9 executed steps in all, counting the helper and both `ret`s. */
function pickShape(rng: Rng): Shape {
  const withCall = rng.chance(0.8)
  for (let attempt = 0; ; attempt++) {
    // With a call: call + 2 helper lines + helper ret + main ret = 5 steps, so main has
    // 2–4 more lines. Without a call: main ret + 5–8 lines.
    const count = withCall ? rng.int(2, 4) : rng.int(5, 8)
    const main = balancedLines(rng, count)
    const helper: Helper | null = !withCall
      ? null
      : rng.chance(0.5)
        ? { kind: 'push-pop', reg: rng.pick(STACK_REGISTERS) }
        : { kind: 'sub-add', amount: rng.pick(AMOUNTS) }
    if (helper !== null) main.splice(rng.int(0, main.length), 0, { kind: 'call' })

    // A real mix: at least one push and at least one sub/add somewhere in the program.
    const kinds = new Set<string>(main.map((line) => line.kind))
    if (helper !== null) kinds.add(helper.kind === 'push-pop' ? 'push' : 'sub')
    if ((kinds.has('push') && (kinds.has('sub') || kinds.has('add'))) || attempt >= 30) {
      return { main, helper }
    }
  }
}

function programLines(shape: Shape): string[] {
  const lines = ['main:', ...shape.main.map((line) => `    ${lineText(line)}`), '    ret']
  if (shape.helper !== null) {
    lines.push(`${HELPER}:`, ...helperLines(shape.helper).map((line) => `    ${line}`), '    ret')
  }
  return lines
}

/* ────────────────────────────── the starting rsp ─────────────────────────── */

/** Where the probe run starts. Any address inside the small-world stack works. */
const PROBE_RSP = 0x800n
/**
 * Every rsp in the trace stays in 0x100 … 0x1000, so each one has 3 or 4 hex digits
 * (the small-world stack itself goes down to 0x40, which would give 2-digit values).
 */
const STACK_LOW = 0x100n
const STACK_HIGH = 0x1000n

/** Steps whose rsp crosses a multiple of 0x100, such as 0x300 → 0x2f8. */
function boundaryCrossings(values: readonly bigint[]): number {
  let count = 0
  for (let index = 1; index < values.length; index++) {
    if (values[index] >> 8n !== values[index - 1] >> 8n) count++
  }
  return count
}

/**
 * A starting rsp (a multiple of 8 in 0x100 … 0xff8) such that at least two steps cross
 * a multiple of 0x100. The distances come from a probe run in the emulator.
 */
function pickStart(rng: Rng, code: string): bigint {
  const probe = runProgram(code, smallWorld({ rsp: PROBE_RSP }))
  const offsets = [0n, ...probe.steps.map((step) => step.after.registers.rsp - PROBE_RSP)]
  const starts: bigint[] = []
  for (let start = 0x100n; start <= 0xff8n; start += 8n) {
    const values = offsets.map((offset) => start + offset)
    if (values.some((value) => value < STACK_LOW || value > STACK_HIGH)) continue
    if (boundaryCrossings(values) >= 2) starts.push(start)
  }
  return rng.pick(starts)
}

/* ─────────────────────────────── one step ────────────────────────────────── */

type StepKind = 'push' | 'pop' | 'call' | 'ret' | 'sub' | 'add'

/** push, pop, call and ret always move rsp by one box. */
const MOVES: ReadonlySet<StepKind> = new Set(['push', 'pop', 'call', 'ret'])

/** How far students sometimes move rsp for one box instead of 8 (bits, words, …). */
const WRONG_SIZES = [1n, 2n, 4n, 16n] as const

interface Step {
  /** 1-based step number, as in the trace. */
  number: number
  fieldId: string
  /** The instruction as written, e.g. "sub rsp, 16". */
  text: string
  kind: StepKind
  /** N of `sub rsp, N` / `add rsp, N`, else null. */
  amount: bigint | null
  /** rsp before and after the step (from the emulator). */
  before: bigint
  after: bigint
}

function readSteps(run: ProgramRun): Step[] {
  return run.steps.map((step, index): Step => {
    const position = run.program.addressToIndex.get(step.result.address)
    const instruction = position === undefined ? undefined : run.program.instructions[position]
    const mnemonic = instruction?.mnemonic
    if (
      instruction === undefined ||
      (mnemonic !== 'push' &&
        mnemonic !== 'pop' &&
        mnemonic !== 'call' &&
        mnemonic !== 'ret' &&
        mnemonic !== 'sub' &&
        mnemonic !== 'add')
    ) {
      throw new Error(`rsp-tracker: step ${index + 1} is not a stack line.`)
    }
    const source = mnemonic === 'sub' || mnemonic === 'add' ? instruction.operands[1] : undefined
    return {
      number: index + 1,
      fieldId: `step${index + 1}`,
      text: step.result.text,
      kind: mnemonic,
      amount: source?.kind === 'imm' ? source.value : null,
      before: index === 0 ? run.start.registers.rsp : run.steps[index - 1].after.registers.rsp,
      after: step.after.registers.rsp,
    }
  })
}

const change = (step: Step): bigint => step.after - step.before

/* ───────────────────────────── the mistakes ──────────────────────────────── */

/** A canonical hex answer as a number, or null for anything else. */
function readAnswer(text: string | undefined): bigint | null {
  return text !== undefined && /^[0-9a-f]+$/.test(text) ? BigInt(`0x${text}`) : null
}

interface Look {
  step: Step
  given: bigint | null
  /**
   * The rsp this step starts from, as the student sees it: their own answer for the step
   * before (a trace is built from its previous line), or the right rsp for step 1 and
   * after a blank or unreadable answer.
   */
  base: bigint
  /** The base two steps back, the same way (for an "old value of rsp"). */
  twoBack: bigint
  /** Wrong, and not just the right change applied to `base` (a slip carried from earlier). */
  slipped: boolean
}

function lookAtSteps(steps: readonly Step[], answers: Readonly<Record<string, string>>): Look[] {
  const givens = steps.map((step) => readAnswer(answers[step.fieldId]))
  /** The rsp before step `index`, as the student has it. */
  const startOf = (index: number): bigint =>
    index <= 0 ? steps[0].before : (givens[index - 1] ?? steps[index].before)
  return steps.map((step, index): Look => {
    const given = givens[index]
    const base = startOf(index)
    const slipped = given !== null && given !== step.after && given !== base + change(step)
    return { step, given, base, twoBack: startOf(index - 1), slipped }
  })
}

/** True when this slipped step's answer is one of the predicted values. */
function matches(look: Look, predicted: bigint | null | readonly bigint[]): boolean {
  if (!look.slipped || look.given === null || predicted === null) return false
  return Array.isArray(predicted) ? predicted.includes(look.given) : predicted === look.given
}

/** Every push/pop/call/ret is `predict(look)`, and at least one of them is wrong. */
function everyMove(moves: readonly Look[], predict: (look: Look) => bigint): boolean {
  return (
    moves.length > 0 &&
    moves.every((look) => look.given === predict(look)) &&
    moves.some((look) => look.given !== look.step.after)
  )
}

function arrow(step: Step): string {
  return `step ${step.number}: ${show(step.before)} → ${show(step.after)}`
}

const sign = (step: Step): bigint => (change(step) < 0n ? -1n : 1n)

function wrongAmount(step: Step): Mistake {
  return {
    code: 'rsp-wrong-amount',
    message: `Each \`push\`, \`pop\`, \`call\` and \`ret\` moves rsp by exactly 8, because one box is 8 bytes (${arrow(step)}).`,
  }
}

function findMistake(
  steps: readonly Step[],
  answers: Readonly<Record<string, string>>,
): Mistake | null {
  const looks = lookAtSteps(steps, answers)
  const moves = looks.filter((look) => MOVES.has(look.step.kind))

  // 1. A habit over the whole trace: every push/pop/call/ret went the opposite way. Built
  // from their own answers, such a student lands on a right value now and then (push to
  // 0x308, pop back to 0x300), so a right step counts too.
  if (everyMove(moves, (look) => look.base - change(look.step))) {
    return {
      code: 'rsp-wrong-direction',
      message: `rsp moved the wrong way. \`push\` and \`call\` make rsp go DOWN by 8; \`pop\` and \`ret\` make it go UP by 8 (${arrow(moves[0].step)}).`,
    }
  }
  // …or every push/pop/call/ret moved by one wrong box size (4 bytes is the 32-bit habit).
  const firstWrongMove = moves.find((look) => look.given !== look.step.after)
  for (const size of WRONG_SIZES) {
    if (everyMove(moves, (look) => look.base + sign(look.step) * size) && firstWrongMove) {
      return wrongAmount(firstWrongMove.step)
    }
  }

  // 2. Single steps, in the order of the specification. One push/pop/call/ret the wrong way.
  for (const look of moves) {
    if (!matches(look, look.base - change(look.step))) continue
    const { kind } = look.step
    const down = kind === 'push' || kind === 'call'
    return {
      code: 'rsp-wrong-direction',
      message: `rsp moved the wrong way. \`${kind}\` makes rsp go ${down ? 'DOWN' : 'UP'} by 8 (${arrow(look.step)}).`,
    }
  }

  // 3. Hex digits added or subtracted as if they were decimal digits.
  for (const look of looks) {
    const delta = change(look.step)
    if (!matches(look, decimalSlip(look.base, delta)) || look.given === null) continue
    const size = delta < 0n ? -delta : delta
    const sizeText = size === 8n ? '8' : `${size} (${show(size)})`
    return {
      code: 'decimal-arithmetic',
      message: `It looks like you ${delta < 0n ? 'subtracted' : 'added'} in decimal. In hex, ${show(look.base)} ${delta < 0n ? '−' : '+'} ${sizeText} = ${show(look.base + delta)}, not ${show(look.given)}.`,
    }
  }

  // 4. The decimal number in `sub rsp, 16` read as 0x16.
  for (const look of looks) {
    const { amount, kind } = look.step
    const misread = amount === null ? null : readAsHex(amount)
    if (misread === null || amount === null) continue
    if (!matches(look, kind === 'sub' ? look.base - misread : look.base + misread)) continue
    return {
      code: 'decimal-immediate',
      message: `The ${amount} in \`${look.step.text}\` is a decimal number: ${amount} = ${show(amount)}, not ${show(misread)}. So rsp goes from ${show(look.step.before)} to ${show(look.step.after)}.`,
    }
  }

  // 5. rsp left as it was across a `call` or a `ret`.
  for (const look of moves) {
    if (look.step.kind !== 'call' && look.step.kind !== 'ret') continue
    if (!matches(look, look.base)) continue
    return {
      code: 'call-ret-forgot-stack',
      message:
        look.step.kind === 'call'
          ? `\`call\` moves rsp too: it pushes the return address, so rsp goes down by 8 (${arrow(look.step)}).`
          : `\`ret\` moves rsp too: it pops the return address, so rsp goes up by 8 (${arrow(look.step)}).`,
    }
  }

  // 6. One box moved by 1, 2, 4 or 16 bytes instead of 8 (in the right direction).
  for (const look of moves) {
    const predicted = WRONG_SIZES.map((size) => look.base + sign(look.step) * size)
    if (matches(look, predicted)) return wrongAmount(look.step)
  }

  // 7. The right change, applied to the rsp from two steps earlier. Only named when the
  // step before is right, so the message's numbers are the student's own.
  for (let index = 1; index < looks.length; index++) {
    const look = looks[index]
    const previous = looks[index - 1].step
    if (look.base !== previous.after) continue
    if (!matches(look, look.twoBack + change(look.step))) continue
    return {
      code: 'stale-value',
      message: `You used an old value of rsp. Step ${previous.number} changed rsp to ${show(previous.after)}, and step ${look.step.number} starts from there.`,
    }
  }

  return null
}

/* ──────────────────────────────── words ──────────────────────────────────── */

/** A size in a sum of hex numbers: "8", or "40 (0x28)" so the reader sees it in hex too. */
function sizeText(size: bigint): string {
  return size < 10n ? size.toString() : `${size} (${show(size)})`
}

/**
 * The rule in short sentences, then this problem's trickiest step worked out: the first
 * step that crosses a multiple of 0x100 ("Step 4 in hex: 0x300 − 8 = 0x2f8.").
 */
function reasonText(steps: readonly Step[]): string {
  const amounts = [...new Set(steps.map((step) => step.amount))]
    .filter((amount): amount is bigint => amount !== null)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const decimals = amounts.filter((amount) => readAsHex(amount) !== null)
  const sentences = ['`push` and `call` take 8 from rsp; `pop` and `ret` add 8.']
  const crossing = steps.find((step) => step.before >> 8n !== step.after >> 8n)
  if (amounts.length > 0) {
    // One amount in hex is enough, and not the one the worked step below shows anyway
    // (the reason stays one short line).
    const worked = crossing === undefined ? null : change(crossing)
    const other = decimals.find((amount) => amount !== worked && amount !== -(worked ?? 0n))
    sentences.push(
      other === undefined
        ? '`sub rsp, N` and `add rsp, N` move it by N, written in decimal.'
        : `\`sub rsp, N\` and \`add rsp, N\` move it by N, written in decimal (${other} = ${show(other)}).`,
    )
  }
  if (crossing !== undefined) {
    const delta = change(crossing)
    sentences.push(
      `Step ${crossing.number} in hex: ${show(crossing.before)} ${delta < 0n ? '−' : '+'} ${sizeText(delta < 0n ? -delta : delta)} = ${show(crossing.after)}.`,
    )
  }
  return sentences.join(' ')
}

/* ────────────────────────────── the problem ──────────────────────────────── */

export const generate: ProblemGenerator = (seed) => {
  const rng = createRng(seed)

  // 1. Build the program and choose where rsp starts. The question shows the lines; the
  // stepper program also starts with `.intel_syntax noprefix`, as gcc wants (the question
  // asks about steps, never about line numbers, so the extra line changes nothing).
  const shape = pickShape(rng)
  const lines = programLines(shape)
  const code = `${[STEPPER_HEADER, ...lines].join('\n')}\n`
  const start = pickStart(rng, code)
  const options = smallWorld({ rsp: start })

  // 2. Run it: the rsp after each step is the answer key.
  const run = runProgram(code, options)
  const steps = readSteps(run)
  if (steps.length < 6 || steps.length > 9) {
    throw new Error(`rsp-tracker: ${steps.length} steps (6 to 9 expected).\n${code}`)
  }

  // 3. Fields and prompt.
  const fields = steps.map((step) =>
    hexField(step.fieldId, `rsp after step ${step.number}`, step.after),
  )
  const prompt: PromptBlock[] = [
    textBlock(`rsp starts at ${show(start)}. Give rsp after each step, in hex.`),
    codeBlock(lines),
    textBlock(
      shape.helper === null
        ? 'The last `ret` ends `main` and goes back to the code that called `main`.'
        : `The \`call\` jumps to \`${HELPER}\`, so its lines come next in the steps. The last \`ret\` ends \`main\` and goes back to the code that called \`main\`.`,
    ),
    {
      type: 'trace',
      rows: steps.map((step) => ({ step: step.number, text: step.text, fieldId: step.fieldId })),
    },
  ]

  const problem: Problem = {
    id: `rsp-tracker-${seed}`,
    topic: 'rsp-tracker',
    seed,
    view: 'form',
    prompt,
    fields,
    reason: reasonText(steps),
    // 5. The same program in the stepper.
    stepper: {
      code,
      options,
      note: 'Step through the program and compare rsp with your answer after each step.',
    },
    // 4. The tempting wrong answers.
    diagnose: (answers) => {
      // Never name a mistake when every answer is right.
      if (steps.every((step) => answerIs(answers[step.fieldId], step.after))) return null
      return findMistake(steps, answers)
    },
  }
  return problem
}
