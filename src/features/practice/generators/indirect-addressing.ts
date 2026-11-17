/**
 * Address or contents? `mov` and `lea` with `-8[rbp]`-style operands.
 *
 * The student sees rbp, rsp and a few stack boxes, then two or three lines that mix
 * `mov reg, off[rbp]` and `lea reg, off[rbp]` (both spellings, also `[rsp]` and
 * `8[rsp]`). They give the value of each destination register afterwards.
 *
 * About one problem in three is a chain: a later line uses, as its base, a register that
 * an earlier line changed (`lea rax, -16[rbp]`, then `mov rcx, 8[rax]`). The starting
 * value of that register is shown, so a student who forgets the change makes the
 * `stale-value` mistake.
 *
 * Build → run in the emulator → fields → predicted mistakes → stepper payload.
 */
import {
  joinAnd,
  type EmulatorOptions,
  type InitialMemoryCell,
  type Reg64,
} from '../../../emulator'
import { createRng, type Rng } from '../../../lib/rng'
import {
  answerIs,
  codeBlock,
  decimalSlip,
  FREE_REGISTERS,
  hexField,
  instructionAtLine,
  pickRegisters,
  registersBlock,
  runProgram,
  show,
  smallWorld,
  stackBlock,
  textBlock,
  type ProgramRun,
} from '../gen/helpers'
import type { Field, Mistake, MistakeCode, Problem, ProblemGenerator } from '../types'

const TOPIC = 'indirect-addressing'

/** The stepper program starts with these lines; the asked lines follow. */
const HEADER = ['    .intel_syntax noprefix', 'main:'] as const
/** 1-based source line of the first asked line in the stepper program. */
const FIRST_LINE = HEADER.length + 1

/**
 * Share of drawn problems where a later line uses a register that an earlier line
 * changed. Chain draws are thrown away more often (their answers collide more), so about
 * a quarter of the finished problems are chains.
 */
const CHAIN_SHARE = 0.4

/** The registers the course uses most. Four problems in five use only these. */
const CLASSIC_REGISTERS: readonly Reg64[] = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi']

/** The mistakes of this type, in the order the specification lists them. */
const MISTAKE_ORDER: readonly MistakeCode[] = [
  'address-vs-contents',
  'wrong-offset-direction',
  'decimal-arithmetic',
  'stale-value',
]

/** Draws are thrown away when their answers or predictions could be confused. */
const MAX_ATTEMPTS = 200

type Op = 'mov' | 'lea'

/** `-8[rbp]` (number before the brackets, as gcc writes it) or `[rbp-8]`. */
type Spelling = 'before' | 'inside'

interface LinePlan {
  op: Op
  dest: Reg64
  base: Reg64
  offset: bigint
  spelling: Spelling
}

interface Plan {
  rsp: bigint
  rbp: bigint
  /** Every box of the picture, lowest address (where rsp points) first. */
  boxes: readonly { address: bigint; value: bigint }[]
  /** Chain problems: the starting value of the register a later line uses as its base. */
  chainStart: { reg: Reg64; value: bigint } | null
  lines: readonly LinePlan[]
}

/** A wrong answer that a known mistake produces for one field. */
interface Prediction {
  code: MistakeCode
  value: bigint
  message: string
}

interface FieldInfo {
  field: Field
  predictions: readonly Prediction[]
  /** Set for a chain line: a line whose base register an earlier line changed. */
  chain: ChainInfo | null
}

/**
 * How a chain line follows from the student's own answer for its base register. A
 * student who slips on the earlier line and then works this line out right from that
 * wrong value has made ONE slip: this line is "carried" and names no mistake of its own.
 */
interface ChainInfo {
  /** The field that holds the student's value of the base register. */
  baseField: string
  /** The right value of the base register when this line runs. */
  rightBase: bigint
  /** Its value before the code runs (a student who uses it makes the stale-value slip). */
  oldBase: bigint
  /** What this line gives from a base value (undefined: no shown box there to read). */
  from: (base: bigint) => bigint | undefined
}

/* ──────────────────────────────── text ──────────────────────────────── */

/** The memory operand as written in the code: `-8[rbp]`, `[rbp-8]`, `[rsp]`, `8[rax]`. */
function operandText(line: LinePlan): string {
  if (line.offset === 0n) return `[${line.base}]`
  if (line.spelling === 'before') return `${line.offset.toString()}[${line.base}]`
  const sign = line.offset < 0n ? '-' : '+'
  return `[${line.base}${sign}${absolute(line.offset).toString()}]`
}

function lineText(line: LinePlan): string {
  return `${line.op} ${line.dest}, ${operandText(line)}`
}

/** One line of the stepper program, in the house style (`    mov     rax, -8[rbp]`). */
function sourceLine(line: LinePlan): string {
  return `    ${line.op.padEnd(8)}${line.dest}, ${operandText(line)}`
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value
}

/** `text` in backticks, the way the UI shows code. */
function code(text: string): string {
  return `\`${text}\``
}

/**
 * "rbp − 8", "rsp + 16", "rsp": how the address is worked out, in plain arithmetic.
 * No backticks here: a code chip in the middle of a sum breaks it apart on the page.
 */
function addressSum(base: string, offset: bigint): string {
  if (offset === 0n) return base
  return `${base} ${offset < 0n ? '−' : '+'} ${absolute(offset).toString()}`
}

/** "`rax`", "`rax` and `rcx`", "`rax`, `rcx` and `rdx`". */
function listOf(names: readonly string[]): string {
  return joinAnd(names.map(code))
}

/* ─────────────────────────────── planning ────────────────────────────── */

/** rbp: a multiple of 16 with three hex digits; half the time only digits 0–9. */
function pickRbp(rng: Rng): bigint {
  const decimalLooking = rng.chance()
  const high = decimalLooking ? rng.int(2, 9) : rng.int(2, 14)
  const middle = decimalLooking ? rng.int(0, 9) : rng.int(0, 15)
  return BigInt(high * 0x100 + middle * 0x10)
}

function pickSpelling(rng: Rng): Spelling {
  return rng.chance() ? 'before' : 'inside'
}

/**
 * Plan one problem: the boxes, rbp and rsp, and the lines. Returns null when the draw
 * does not work out (the caller draws again with the same random stream).
 */
function planProblem(rng: Rng): Plan | null {
  const boxCount = rng.int(4, 6)
  // rbp always has boxes above and below it, so positive and negative offsets both work.
  const rbpIndex = rng.int(1, boxCount - 2)
  const rbp = pickRbp(rng)
  const rsp = rbp - 8n * BigInt(rbpIndex)
  const indexes = Array.from({ length: boxCount }, (_, index) => index)
  const addressOf = (index: number): bigint => rsp + 8n * BigInt(index)
  const notRbp = indexes.filter((index) => index !== rbpIndex)

  const lineCount = rng.int(2, 3)
  const dests = pickRegisters(rng, lineCount, rng.chance(0.8) ? CLASSIC_REGISTERS : FREE_REGISTERS)
  const lines: (LinePlan | null)[] = Array.from({ length: lineCount }, () => null)
  /** Where each line reads, for the planning checks below (the key comes from the emulator). */
  const plannedAddress: bigint[] = Array.from({ length: lineCount }, () => 0n)

  const plainLine = (op: Op, dest: Reg64, useRbp: boolean): { line: LinePlan; address: bigint } => {
    if (useRbp) {
      const index = rng.pick(notRbp)
      const offset = 8n * BigInt(index - rbpIndex)
      return {
        line: { op, dest, base: 'rbp', offset, spelling: pickSpelling(rng) },
        address: addressOf(index),
      }
    }
    const index = rng.pick(indexes)
    const offset = 8n * BigInt(index)
    return {
      line: { op, dest, base: 'rsp', offset, spelling: pickSpelling(rng) },
      address: addressOf(index),
    }
  }

  let chainStart: Plan['chainStart'] = null
  let pointer: { address: bigint; value: bigint } | null = null
  const chain: Op | null = rng.next() < CHAIN_SHARE ? (rng.chance() ? 'lea' : 'mov') : null

  if (chain === null) {
    // Both `mov` and `lea` in every problem, and at least one line based on rbp.
    const ops: Op[] = rng.shuffle(
      lineCount === 2 ? ['mov', 'lea'] : ['mov', 'lea', rng.pick<Op>(['mov', 'lea'])],
    )
    const useRbp = ops.map(() => rng.chance(0.65))
    if (!useRbp.includes(true)) useRbp[rng.int(0, lineCount - 1)] = true
    ops.forEach((op, index) => {
      const made = plainLine(op, dests[index], useRbp[index])
      lines[index] = made.line
      plannedAddress[index] = made.address
    })
  } else {
    const [first, second] =
      lineCount === 2
        ? [0, 1]
        : rng.pick<readonly [number, number]>([
            [0, 1],
            [0, 2],
            [1, 2],
          ])
    const reg = dests[first]

    // The first line of the chain puts an address in `reg`.
    const firstIndex = rng.pick(notRbp)
    let regValue: bigint
    let secondIndex: number
    if (chain === 'lea') {
      regValue = addressOf(firstIndex)
      secondIndex = rng.pick(indexes)
    } else {
      // `mov` loads a box that holds the address of another box (a pointer).
      const target = rng.pick(indexes.filter((index) => index !== firstIndex))
      regValue = addressOf(target)
      pointer = { address: addressOf(firstIndex), value: regValue }
      secondIndex = rng.chance() ? target : rng.pick(indexes)
    }
    lines[first] = {
      op: chain,
      dest: reg,
      base: 'rbp',
      offset: 8n * BigInt(firstIndex - rbpIndex),
      spelling: pickSpelling(rng),
    }
    plannedAddress[first] = addressOf(firstIndex)

    // The second line uses `reg` as its base and lands on a box of the picture.
    const secondOffset = addressOf(secondIndex) - regValue
    const secondOp: Op =
      lineCount === 2 ? (chain === 'lea' ? 'mov' : 'lea') : rng.pick<Op>(['mov', 'lea'])
    lines[second] = {
      op: secondOp,
      dest: dests[second],
      base: reg,
      offset: secondOffset,
      spelling: pickSpelling(rng),
    }
    plannedAddress[second] = addressOf(secondIndex)

    // The shown starting value of `reg`: with it, the second line would land on another box.
    const staleIndex = rng.pick(indexes.filter((index) => index !== secondIndex))
    const start = addressOf(staleIndex) - secondOffset
    if (start <= 0n || start === regValue || start === rbp || start === rsp) return null
    chainStart = { reg, value: start }

    if (lineCount === 3) {
      const other = [0, 1, 2].find((index) => index !== first && index !== second) ?? 2
      const otherOp: Op =
        chain === secondOp ? (chain === 'mov' ? 'lea' : 'mov') : rng.pick<Op>(['mov', 'lea'])
      const made = plainLine(otherOp, dests[other], rng.chance(0.65))
      lines[other] = made.line
      plannedAddress[other] = made.address
    }
  }

  const planned = lines.filter((line): line is LinePlan => line !== null)
  if (planned.length !== lineCount) return null

  // No two lines may do the same thing to the same address.
  const keys = planned.map((line, index) => `${line.op}:${plannedAddress[index].toString()}`)
  if (new Set(keys).size !== keys.length) return null

  // Box values: small different numbers, and one or two that look like nearby addresses.
  const values = new Map<bigint, bigint>()
  const used = new Set<bigint>()
  if (pointer !== null) {
    values.set(pointer.address, pointer.value)
    used.add(pointer.value)
  }
  for (const index of indexes) {
    const address = addressOf(index)
    if (values.has(address)) continue
    let value = BigInt(rng.int(1, 0x7f))
    while (used.has(value)) value = BigInt(rng.int(1, 0x7f))
    values.set(address, value)
    used.add(value)
  }
  const addressLike = rng.int(1, 2) - (pointer === null ? 0 : 1)
  const low = rsp - 0x18n
  const span = (addressOf(boxCount - 1) + 0x18n - low) / 8n
  const changeable = rng.shuffle(indexes.map(addressOf).filter((a) => a !== pointer?.address))
  for (const address of changeable.slice(0, addressLike)) {
    let value = low + 8n * BigInt(rng.int(0, Number(span)))
    while (used.has(value) || value === address) value = low + 8n * BigInt(rng.int(0, Number(span)))
    used.delete(values.get(address) ?? -1n)
    values.set(address, value)
    used.add(value)
  }

  const boxes = indexes.map((index) => {
    const address = addressOf(index)
    return { address, value: values.get(address) ?? 0n }
  })
  return { rsp, rbp, boxes, chainStart, lines: planned }
}

/* ─────────────────────────── the program ─────────────────────────────── */

function stepperSource(plan: Plan): string {
  return [...HEADER, ...plan.lines.map(sourceLine), '    ret', ''].join('\n')
}

/**
 * The starting machine: rbp, rsp (and the chain register) in registers, the boxes in
 * memory. The emulator always stores its "return address that ends the program" in the
 * box where rsp starts, so that box's value is passed as `osReturnAddress`: the box
 * shows the planned value and the final `ret` still ends the program cleanly. That box
 * holds an ordinary value in the question, so it gets no "return address" label
 * (`labelStartBox: false`).
 */
function stepperOptions(plan: Plan): EmulatorOptions {
  const initialRegisters: Partial<Record<Reg64, bigint>> = { rbp: plan.rbp }
  if (plan.chainStart !== null) initialRegisters[plan.chainStart.reg] = plan.chainStart.value
  const initialMemory: InitialMemoryCell[] = plan.boxes
    .filter((box) => box.address !== plan.rsp)
    .map((box) => ({ address: box.address, bytes: 8, value: box.value }))
  const rspBox = plan.boxes.find((box) => box.address === plan.rsp)
  if (rspBox === undefined) throw new Error('indirect-addressing: rsp has no box.')
  return smallWorld({
    rsp: plan.rsp,
    extra: {
      initialRegisters,
      initialMemory,
      osReturnAddress: rspBox.value,
      labelStartBox: false,
    },
  })
}

/* ──────────────────────────── predictions ────────────────────────────── */

/**
 * The wrong answers a student would give for one line, in the specification's order.
 * `contents` holds only the boxes shown in the question: a student can only use those.
 */
function predictionsFor(
  line: LinePlan,
  baseValue: bigint,
  contents: ReadonlyMap<bigint, bigint>,
  stale: { old: bigint; changedBy: LinePlan } | null,
): Prediction[] {
  const out: Prediction[] = []
  const address = baseValue + line.offset
  const operand = code(operandText(line))
  const dest = code(line.dest)
  const where = `${addressSum(line.base, line.offset)} = ${show(address)}`

  // 1. address-vs-contents
  if (line.op === 'mov') {
    out.push({
      code: 'address-vs-contents',
      value: address,
      message: `For ${dest} you gave the address, ${show(address)}. \`mov\` copies what is stored AT that address; \`lea\` gives the address itself.`,
    })
  } else {
    const stored = contents.get(address)
    if (stored !== undefined) {
      out.push({
        code: 'address-vs-contents',
        value: stored,
        message: `For ${dest} you gave what is stored at ${show(address)}. \`lea\` gives the address itself and does not read memory; \`mov\` copies what is stored there.`,
      })
    }
  }

  // 2. wrong-offset-direction: the box on the other side of the base, contents or address.
  if (line.offset !== 0n) {
    const mirror = baseValue - line.offset
    const used = `For ${dest} you used ${addressSum(line.base, -line.offset)} = ${show(mirror)}. ${operand} means ${where}`
    const stored = contents.get(mirror)
    const simple = line.op === 'mov' ? stored : mirror
    const both = line.op === 'mov' ? mirror : stored
    const extra =
      line.op === 'mov'
        ? ', and `mov` copies what is stored there'
        : ', and `lea` gives that address itself'
    if (simple !== undefined) {
      out.push({ code: 'wrong-offset-direction', value: simple, message: `${used}.` })
    }
    if (both !== undefined) {
      out.push({ code: 'wrong-offset-direction', value: both, message: `${used}${extra}.` })
    }
  }

  // 3. decimal-arithmetic: the address worked out as if the digits were decimal.
  const slip = decimalSlip(baseValue, line.offset)
  if (slip !== null) {
    const value = line.op === 'lea' ? slip : contents.get(slip)
    if (value !== undefined) {
      const amount = absolute(line.offset)
      const asHex = amount >= 10n ? ` (0x${amount.toString(16)})` : ''
      const verb = line.offset < 0n ? 'subtracted' : 'added'
      out.push({
        code: 'decimal-arithmetic',
        value,
        message: `It looks like you ${verb} in decimal. In hex, ${show(baseValue)} ${line.offset < 0n ? '−' : '+'} ${amount.toString()}${asHex} = ${show(address)}, not ${show(slip)}.`,
      })
    }
  }

  // 4. stale-value: the base register's starting value instead of its new one.
  if (stale !== null) {
    const oldAddress = stale.old + line.offset
    const value = line.op === 'lea' ? oldAddress : contents.get(oldAddress)
    if (value !== undefined) {
      out.push({
        code: 'stale-value',
        value,
        message: `You used the old value of ${code(line.base)} (${show(stale.old)}). ${code(lineText(stale.changedBy))} changed ${code(line.base)} to ${show(baseValue)} before ${code(lineText(line))} used it.`,
      })
    }
  }
  return out
}

/** Every value in the list is different. */
function allDifferent(values: readonly bigint[]): boolean {
  return new Set(values).size === values.length
}

/* ──────────────────────────────── build ──────────────────────────────── */

/**
 * Run the planned program in the emulator and turn it into a problem. Returns null when
 * two answers, or an answer and a predicted mistake, would be the same number (the
 * caller draws again).
 */
function buildProblem(seed: number, plan: Plan): Problem | null {
  const source = stepperSource(plan)
  const options = stepperOptions(plan)
  const run: ProgramRun = runProgram(source, options)

  // The picture of the stack comes from the emulator's starting state.
  const shown = new Set(plan.boxes.map((box) => box.address))
  const slots = run.start.stack.filter((slot) => shown.has(slot.address))
  if (slots.length !== plan.boxes.length || slots.some((slot) => slot.value === null)) {
    throw new Error(
      `indirect-addressing: the emulator's stack does not hold every box (seed ${seed}).`,
    )
  }
  const contents = new Map<bigint, bigint>()
  for (const slot of slots) contents.set(slot.address, slot.value ?? 0n)

  const infos: FieldInfo[] = []
  const facts: string[] = []
  plan.lines.forEach((line, index) => {
    const lineNumber = FIRST_LINE + index
    const step = run.steps[index]
    if (step === undefined || step.result.line !== lineNumber) {
      throw new Error(
        `indirect-addressing: step ${index + 1} is not line ${lineNumber} (seed ${seed}).`,
      )
    }
    const operand = instructionAtLine(run.program, lineNumber).operands[1]
    if (operand === undefined || operand.kind !== 'mem' || operand.base !== line.base) {
      throw new Error(
        `indirect-addressing: line ${lineNumber} has no memory operand on ${line.base}.`,
      )
    }
    const before = index === 0 ? run.start : run.steps[index - 1].after
    const baseValue = before.registers[line.base]
    const right = step.after.registers[line.dest]
    const address = baseValue + operand.disp
    // The reason explains the answer with this address: it must agree with the emulator.
    const explained = line.op === 'lea' ? address : contents.get(address)
    if (explained !== right) {
      throw new Error(`indirect-addressing: line ${lineNumber} disagrees with the emulator.`)
    }

    let stale: { old: bigint; changedBy: LinePlan } | null = null
    let chain: ChainInfo | null = null
    const old = run.start.registers[line.base]
    if (old !== baseValue) {
      const changedBy = plan.lines
        .slice(0, index)
        .filter((earlier) => earlier.dest === line.base)
        .at(-1)
      if (changedBy === undefined) throw new Error('indirect-addressing: unknown change of a base.')
      stale = { old, changedBy }
      const disp = operand.disp
      chain = {
        baseField: changedBy.dest,
        rightBase: baseValue,
        oldBase: old,
        from: (base) => (line.op === 'lea' ? base + disp : contents.get(base + disp)),
      }
    }

    infos.push({
      field: hexField(line.dest, line.dest, right),
      predictions: predictionsFor({ ...line, offset: operand.disp }, baseValue, contents, stale),
      chain,
    })
    const sum = addressSum(line.base, operand.disp)
    facts.push(
      line.op === 'lea'
        ? `${code(line.dest)} = ${sum} = ${show(right)}`
        : `${code(line.dest)} = [${sum}] = [${show(address)}] = ${show(right)}`,
    )
  })

  // Two fields never share an answer, and no prediction can be confused with another.
  // The shown starting value of a register that a line changes counts too: a student who
  // leaves that register unchanged must not be told about a different mistake.
  const rights = infos.map((info) => BigInt(`0x${info.field.expected}`))
  if (!allDifferent(rights)) return null
  for (const [index, info] of infos.entries()) {
    const values = [rights[index], ...info.predictions.map((prediction) => prediction.value)]
    const dest = plan.lines[index].dest
    if (plan.chainStart?.reg === dest) values.push(run.start.registers[dest])
    if (!allDifferent(values)) return null
  }

  const dests = plan.lines.map((line) => line.dest)
  const registerRows = [
    { name: 'rbp', value: run.start.registers.rbp },
    { name: 'rsp', value: run.start.registers.rsp },
  ]
  if (plan.chainStart !== null) {
    const reg = plan.chainStart.reg
    registerRows.push({ name: reg, value: run.start.registers[reg] })
  }
  const boxes = slots.map((slot) => {
    const marks = [slot.isRsp ? 'rsp' : '', slot.isRbp ? 'rbp' : ''].filter((mark) => mark !== '')
    return marks.length === 0
      ? { address: slot.address, value: slot.value ?? 0n }
      : { address: slot.address, value: slot.value ?? 0n, marker: marks.join(', ') }
  })

  const prompt = [
    textBlock('`rbp` and `rsp` point to boxes on the stack. Each box holds 8 bytes.'),
    registersBlock(registerRows, { title: 'Registers before the code runs', short: true }),
    stackBlock(boxes, { title: 'The stack (highest address at the top)' }),
    textBlock(
      plan.lines.length === 2
        ? 'These two lines run, one after the other:'
        : 'These three lines run, one after the other:',
    ),
    codeBlock(plan.lines.map(lineText)),
    textBlock('What is in each register after the lines run? Answer in hex.'),
  ]

  const fieldInfos = infos
  /**
   * A chain line worked out right from the student's own (wrong) value of its base
   * register. The old value of that register is not "own work": using it is the
   * stale-value slip, which this line names.
   */
  const carried = (info: FieldInfo, answers: Readonly<Record<string, string>>): boolean => {
    const { chain } = info
    if (chain === null) return false
    const text = answers[chain.baseField] ?? ''
    if (!/^[0-9a-f]{1,16}$/.test(text)) return false
    const own = BigInt(`0x${text}`)
    if (own === chain.rightBase || own === chain.oldBase) return false
    const result = chain.from(own)
    return result !== undefined && answerIs(answers[info.field.id], result)
  }

  const diagnose = (answers: Readonly<Record<string, string>>): Mistake | null => {
    for (const mistake of MISTAKE_ORDER) {
      for (const info of fieldInfos) {
        const { field, predictions } = info
        const answer = answers[field.id]
        if (answer === undefined || answer === '' || answer === field.expected) continue
        if (carried(info, answers)) continue
        const match = predictions.find(
          (prediction) => prediction.code === mistake && answerIs(answer, prediction.value),
        )
        if (match !== undefined) return { code: mistake, message: match.message }
      }
    }
    return null
  }

  return {
    id: `${TOPIC}-${seed}`,
    topic: TOPIC,
    seed,
    view: 'form',
    prompt,
    fields: infos.map((info) => info.field),
    reason: `\`mov\` copies what is stored at the address; \`lea\` gives the address itself: ${facts.join(', ')}.`,
    stepper: {
      code: source,
      options,
      note: `Step through the lines and watch ${listOf(dests)}.`,
    },
    diagnose,
  }
}

export const generate: ProblemGenerator = (seed) => {
  const rng = createRng(seed)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const plan = planProblem(rng)
    if (plan === null) continue
    const problem = buildProblem(seed, plan)
    if (problem !== null) return problem
  }
  throw new Error(`indirect-addressing: no usable problem for seed ${seed}.`)
}
