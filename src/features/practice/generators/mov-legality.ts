/**
 * Is this mov legal? If not, which rule does it break?
 *
 * The student sees one `mov` line and picks "Legal" or the rule it breaks.
 *
 * The answer key is the assembler itself. A line is built from a template (one of the
 * five legal forms, or one of the five broken rules) and assembled inside a minimal
 * `main`: no error → "legal", otherwise the code of the first error. When a template
 * gives another verdict than it aimed for, the draw is thrown away and another is made:
 * the assembler is the authority. Legal lines are also run in the emulator, so "Show me"
 * steps through a program that ends cleanly.
 *
 * Build → assemble (and run) → field → predicted mistakes → stepper payload.
 */
import {
  assemble,
  registerFamily,
  type EmulatorOptions,
  type InitialMemoryCell,
  type Instruction,
  type OperandSize,
  type Reg64,
  type RegisterInfo,
} from '../../../emulator'
import { createRng, type Rng } from '../../../lib/rng'
import {
  choiceField,
  codeBlock,
  FREE_REGISTERS,
  random64,
  runProgram,
  show,
  SMALL_WORLD,
  smallWorld,
  textBlock,
} from '../gen/helpers'
import type { Mistake, Problem, ProblemGenerator } from '../types'

const TOPIC = 'mov-legality'

/** The choices, in the order of the specification. The ids are the assembler's codes. */
const CHOICES = [
  { id: 'legal', label: 'Legal' },
  { id: 'memory-to-memory', label: 'Illegal: memory to memory' },
  { id: 'immediate-destination', label: 'Illegal: a number cannot be the destination' },
  { id: 'size-mismatch', label: 'Illegal: the two sizes do not match' },
  { id: 'missing-size', label: 'Illegal: memory needs a size (byte, word, dword or qword ptr)' },
  { id: 'immediate-too-large', label: 'Illegal: the number is too big for the destination' },
] as const

type Verdict = (typeof CHOICES)[number]['id']
type Rule = Exclude<Verdict, 'legal'>

/** The five legal forms of `mov`. */
type Form = 'reg-reg' | 'reg-number' | 'reg-memory' | 'memory-reg' | 'memory-number'

const FORMS: readonly Form[] = [
  'reg-reg',
  'reg-number',
  'reg-memory',
  'memory-reg',
  'memory-number',
]
const RULES: readonly Rule[] = [
  'memory-to-memory',
  'immediate-destination',
  'size-mismatch',
  'missing-size',
  'immediate-too-large',
]

/** The stepper program starts with these lines; the `mov` line comes next. */
const HEADER = ['    .intel_syntax noprefix', 'main:'] as const

/** Draws are thrown away when the assembler's verdict is not the one aimed for. */
const MAX_ATTEMPTS = 100

/** The registers the course uses most. Three registers in four are one of these. */
const CLASSIC_REGISTERS: readonly Reg64[] = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi']

const PTR_WORD: Readonly<Record<OperandSize, string>> = {
  8: 'byte',
  16: 'word',
  32: 'dword',
  64: 'qword',
}

/** The numbers a place of this many bits takes (the assembler's rule: signed or unsigned). */
const RANGE_TEXT: Readonly<Record<OperandSize, string>> = {
  8: '-128 to 255',
  16: '-32768 to 65535',
  32: '-2147483648 to 4294967295',
  64: 'any 64-bit number',
}

/**
 * Where the bases of memory operands point in the stepper (small-world stack, rsp starts
 * at 0x1f8). Every address a line can touch stays above the box at 0x1f8, which holds the
 * return address that ends the program: rbp − 32 = 0x210, rdi + 0 = 0x208, rsp + 8 = 0x200.
 * Only one memory operand of a legal line is ever used, so the bases may share boxes.
 * `rsp` is not listed: it keeps its starting value.
 */
const MEMORY_BASE: Readonly<Partial<Record<Reg64, bigint>>> = {
  rbp: 0x230n,
  rdi: 0x208n,
  rsi: 0x210n,
  rbx: 0x218n,
}

interface RegisterOperand {
  kind: 'reg'
  info: RegisterInfo
}

interface MemoryOperand {
  kind: 'mem'
  /** The `ptr` size written in front, or null when none is written. */
  ptr: OperandSize | null
  base: Reg64
  offset: bigint
  text: string
}

interface NumberOperand {
  kind: 'imm'
  value: bigint
  text: string
}

type OperandPlan = RegisterOperand | MemoryOperand | NumberOperand

interface LinePlan {
  /** The legal form or the broken rule this line was built for. */
  aim: Form | Rule
  dest: OperandPlan
  src: OperandPlan
}

/* ──────────────────────────────── text ──────────────────────────────── */

function operandText(operand: OperandPlan): string {
  return operand.kind === 'reg' ? operand.info.name : operand.text
}

function lineText(plan: LinePlan): string {
  return `mov ${operandText(plan.dest)}, ${operandText(plan.src)}`
}

/** `text` in backticks, the way the UI shows code. */
function code(text: string): string {
  return `\`${text}\``
}

/** An assembler message without its `Line N: ` start, as a sentence. */
function assemblerSentence(message: string): string {
  const text = message.replace(/^Line \d+: /, '')
  return /^[a-z]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

/**
 * The reason of an illegal line: the first two sentences of the assembler's message (what
 * is wrong, and the rule). Its advice after them ("Use `ecx` instead of `rcx`…") stays in
 * the stepper, where "Show me" opens the line, so the reason stays one short line.
 */
function illegalReason(message: string): string {
  const sentences = assemblerSentence(message).split(/(?<=[.!?])\s+(?=[A-Z`])/)
  return sentences.slice(0, 2).join(' ')
}

/* ──────────────────────────────── drawing ────────────────────────────── */

function pickSize(rng: Rng): OperandSize {
  return rng.pick<OperandSize>([8, 16, 32, 32, 64, 64])
}

/** Every name of this size in the fourteen free registers (for 8 bits also `ah`…`dh`). */
function registersOfSize(size: OperandSize): RegisterInfo[] {
  return FREE_REGISTERS.flatMap((base) => registerFamily(base).filter((info) => info.size === size))
}

/** `ah`, `bh`, `ch`, `dh` can never share a line with `sil`, `dil`, `spl`, `bpl` or `r8`–`r15`. */
function compatible(a: RegisterInfo, b: RegisterInfo): boolean {
  return !(a.highByte && b.needsRex) && !(b.highByte && a.needsRex)
}

function pickRegister(
  rng: Rng,
  size: OperandSize,
  avoid: { bases?: readonly Reg64[]; partner?: RegisterInfo } = {},
): RegisterOperand {
  const classic = rng.chance(0.75)
  const highBytes = size === 8 && rng.chance(0.25)
  const pool = registersOfSize(size).filter(
    (info) =>
      (!classic || CLASSIC_REGISTERS.includes(info.base)) &&
      info.highByte === highBytes &&
      !(avoid.bases ?? []).includes(info.base) &&
      (avoid.partner === undefined || compatible(info, avoid.partner)),
  )
  const fallback = registersOfSize(size).filter(
    (info) =>
      !info.highByte &&
      !(avoid.bases ?? []).includes(info.base) &&
      (avoid.partner === undefined || compatible(info, avoid.partner)),
  )
  return { kind: 'reg', info: rng.pick(pool.length > 0 ? pool : fallback) }
}

/**
 * A memory operand: `-8[rbp]`, `[rbp-8]`, `16[rsp]`, `[rdi]`, `[rsi+8]`, with a `ptr` size
 * in front when `ptr` is given. `access` is how many bits the line reads or writes there.
 */
function pickMemory(
  rng: Rng,
  ptr: OperandSize | null,
  access: OperandSize,
  avoidBases: readonly Reg64[] = [],
): MemoryOperand {
  const others = (['rdi', 'rsi', 'rbx'] as const).filter((name) => !avoidBases.includes(name))
  const roll = rng.next()
  const base: Reg64 =
    roll < 0.6 ? 'rbp' : roll < 0.75 || others.length === 0 ? 'rsp' : rng.pick(others)
  let offset: bigint
  if (base === 'rbp') offset = -BigInt(access / 8) * BigInt(rng.int(1, 4))
  else if (base === 'rsp') offset = 8n * BigInt(rng.int(1, 3))
  else offset = rng.pick([0n, 8n, 16n])

  let address: string
  if (offset === 0n) address = `[${base}]`
  else if (rng.chance()) address = `${offset.toString()}[${base}]`
  else address = `[${base}${offset < 0n ? '-' : '+'}${(offset < 0n ? -offset : offset).toString()}]`
  return {
    kind: 'mem',
    ptr,
    base,
    offset,
    text: ptr === null ? address : `${PTR_WORD[ptr]} ptr ${address}`,
  }
}

/** A number written in decimal or in hex (negative numbers in decimal). */
function numberOperand(rng: Rng, value: bigint, hexOnly = false): NumberOperand {
  const asHex = value >= 0n && (hexOnly || value > 99_999n || rng.chance())
  return { kind: 'imm', value, text: asHex ? `0x${value.toString(16)}` : value.toString() }
}

function randomBetween(rng: Rng, low: bigint, high: bigint): bigint {
  const span = high - low
  if (span <= 0n) return low
  // Up to 48 random bits are plenty for the ranges used here.
  return low + (rng.bits(48) % (span + 1n))
}

/** A number that fits: for 64-bit memory it must fit in 32 bits (it is sign-extended). */
function fittingNumber(rng: Rng, size: OperandSize, place: 'register' | 'memory'): NumberOperand {
  if (size === 64) {
    if (place === 'register' && rng.chance(0.4)) return numberOperand(rng, random64(rng), true)
    return numberOperand(rng, BigInt(rng.int(1, 0x7fff_ffff)))
  }
  const max = (1n << BigInt(size)) - 1n
  const roll = rng.next()
  if (roll < 0.2) return numberOperand(rng, max)
  if (roll < 0.35) return numberOperand(rng, -BigInt(rng.int(1, 100)))
  return numberOperand(rng, randomBetween(rng, 1n, max))
}

/** A positive number one size too big: 256 or more for 8 bits, and so on. */
function tooBigNumber(rng: Rng, size: 8 | 16 | 32): NumberOperand {
  const limit = 1n << BigInt(size)
  if (rng.chance(0.25)) return numberOperand(rng, limit, size === 32)
  return numberOperand(rng, randomBetween(rng, limit + 1n, limit * 16n - 1n), size === 32)
}

/** A small number that fits every size (for `missing-size` and `immediate-destination`). */
function smallNumber(rng: Rng): NumberOperand {
  return numberOperand(rng, BigInt(rng.int(1, 127)))
}

/** Build one line aimed at a legal form or a broken rule. */
function planLine(rng: Rng, aim: Form | Rule): LinePlan {
  switch (aim) {
    case 'reg-reg': {
      const size = pickSize(rng)
      const dest = pickRegister(rng, size)
      const src = pickRegister(rng, size, { bases: [dest.info.base], partner: dest.info })
      return { aim, dest, src }
    }
    case 'reg-number': {
      const size = pickSize(rng)
      return { aim, dest: pickRegister(rng, size), src: fittingNumber(rng, size, 'register') }
    }
    case 'reg-memory': {
      const size = pickSize(rng)
      const dest = pickRegister(rng, size)
      const src = pickMemory(rng, rng.chance() ? size : null, size, [dest.info.base])
      return { aim, dest, src }
    }
    case 'memory-reg': {
      const size = pickSize(rng)
      const src = pickRegister(rng, size)
      const dest = pickMemory(rng, rng.chance() ? size : null, size, [src.info.base])
      return { aim, dest, src }
    }
    case 'memory-number': {
      const size = pickSize(rng)
      return { aim, dest: pickMemory(rng, size, size), src: fittingNumber(rng, size, 'memory') }
    }
    case 'memory-to-memory': {
      // A `ptr` size on at least one side (the same size when both have one). Then the
      // only broken rule is memory to memory, and "memory needs a size" cannot also read
      // as true: the size is written.
      const size = pickSize(rng)
      const destPtr = rng.chance(0.7) ? size : null
      const srcPtr = destPtr === null || rng.chance() ? size : null
      const dest = pickMemory(rng, destPtr, size)
      let src = pickMemory(rng, srcPtr, size)
      while (src.base === dest.base && src.offset === dest.offset) {
        src = pickMemory(rng, srcPtr, size)
      }
      return { aim, dest, src }
    }
    case 'immediate-destination':
      return { aim, dest: smallNumber(rng), src: pickRegister(rng, pickSize(rng)) }
    case 'size-mismatch': {
      const first = pickSize(rng)
      const second = rng.pick(([8, 16, 32, 64] as const).filter((size) => size !== first))
      const roll = rng.next()
      if (roll < 0.5) {
        const dest = pickRegister(rng, first)
        const src = pickRegister(rng, second, { bases: [dest.info.base], partner: dest.info })
        return { aim, dest, src }
      }
      if (roll < 0.75) {
        const dest = pickRegister(rng, first)
        return { aim, dest, src: pickMemory(rng, second, second, [dest.info.base]) }
      }
      const src = pickRegister(rng, second)
      return { aim, dest: pickMemory(rng, first, first, [src.info.base]), src }
    }
    case 'missing-size':
      return { aim, dest: pickMemory(rng, null, 64), src: smallNumber(rng) }
    case 'immediate-too-large': {
      const size = rng.pick([8, 16, 32] as const)
      const dest = rng.chance(0.6) ? pickRegister(rng, size) : pickMemory(rng, size, size)
      return { aim, dest, src: tooBigNumber(rng, size) }
    }
  }
}

/* ─────────────────────────── the program ─────────────────────────────── */

function stepperCode(plan: LinePlan): string {
  const operands = `${operandText(plan.dest)}, ${operandText(plan.src)}`
  return [...HEADER, `    ${'mov'.padEnd(8)}${operands}`, '    ret', ''].join('\n')
}

/** Bits a memory operand reads or writes: its `ptr` size, else the size of the register. */
function accessSize(plan: LinePlan): OperandSize {
  for (const operand of [plan.dest, plan.src]) {
    if (operand.kind === 'mem' && operand.ptr !== null) return operand.ptr
  }
  for (const operand of [plan.dest, plan.src]) {
    if (operand.kind === 'reg') return operand.info.size
  }
  return 64
}

/**
 * The starting machine for "Show me": memory bases point into the small-world stack
 * (away from the box where rsp starts), a register that is copied holds a value that is
 * easy to see, and memory that is read holds a value.
 */
function stepperOptions(rng: Rng, plan: LinePlan): EmulatorOptions {
  const initialRegisters: Partial<Record<Reg64, bigint>> = {}
  const initialMemory: InitialMemoryCell[] = []
  for (const operand of [plan.dest, plan.src]) {
    if (operand.kind !== 'mem') continue
    const base = MEMORY_BASE[operand.base]
    if (base !== undefined) initialRegisters[operand.base] = base
  }
  if (plan.src.kind === 'reg') initialRegisters[plan.src.info.base] = random64(rng)
  if (plan.src.kind === 'mem') {
    const bits = accessSize(plan)
    const bytes = (bits / 8) as 1 | 2 | 4 | 8
    const base = MEMORY_BASE[plan.src.base] ?? SMALL_WORLD.initialRsp
    const value = random64(rng) & ((1n << BigInt(bits)) - 1n)
    initialMemory.push({ address: base + plan.src.offset, bytes, value })
  }
  const extra: EmulatorOptions = {}
  if (Object.keys(initialRegisters).length > 0) extra.initialRegisters = initialRegisters
  if (initialMemory.length > 0) extra.initialMemory = initialMemory
  return smallWorld({ extra })
}

/** The legal form of an assembled `mov`, read from its operands. */
function formOf(instruction: Instruction): Form {
  const [dest, src] = instruction.operands
  if (dest?.kind === 'reg' && src?.kind === 'reg') return 'reg-reg'
  if (dest?.kind === 'reg' && src?.kind === 'imm') return 'reg-number'
  if (dest?.kind === 'reg' && src?.kind === 'mem') return 'reg-memory'
  if (dest?.kind === 'mem' && src?.kind === 'reg') return 'memory-reg'
  if (dest?.kind === 'mem' && src?.kind === 'imm') return 'memory-number'
  throw new Error(`mov-legality: \`${instruction.text}\` is not one of the five legal forms.`)
}

/* ───────────────────────────── explanations ──────────────────────────── */

/** Bits of an operand: a register's size or a written `ptr` size; null for the rest. */
function sizeOf(operand: OperandPlan): OperandSize | null {
  if (operand.kind === 'reg') return operand.info.size
  if (operand.kind === 'mem') return operand.ptr
  return null
}

function registerOf(plan: LinePlan): RegisterInfo | null {
  if (plan.dest.kind === 'reg') return plan.dest.info
  if (plan.src.kind === 'reg') return plan.src.info
  return null
}

function memoryOf(plan: LinePlan): MemoryOperand | null {
  if (plan.dest.kind === 'mem') return plan.dest
  if (plan.src.kind === 'mem') return plan.src
  return null
}

function numberOf(plan: LinePlan): NumberOperand | null {
  if (plan.src.kind === 'imm') return plan.src
  if (plan.dest.kind === 'imm') return plan.dest
  return null
}

/** The reason of a legal line: which of the five forms it is, and why the sizes work. */
function legalReason(form: Form, instruction: Instruction): string {
  const [dest, src] = instruction.operands
  const bits = instruction.opSize ?? 64
  const text = (index: 0 | 1) => code(instruction.operands[index]?.text ?? '')
  const memory = dest?.kind === 'mem' ? dest : src?.kind === 'mem' ? src : null
  const ptr = memory?.size ?? null
  switch (form) {
    case 'reg-reg':
      return `Legal: it copies a register into a register, and ${text(0)} and ${text(1)} are both ${bits} bits.`
    case 'reg-number':
      return `Legal: it copies a number into a register, and ${text(1)} fits in ${text(0)} (${bits} bits).`
    case 'reg-memory':
      return ptr === null
        ? `Legal: it copies memory into a register, and ${text(0)} gives the size: ${bits} bits.`
        : `Legal: it copies memory into a register, and ${code(`${PTR_WORD[ptr]} ptr`)} matches ${text(0)}: both are ${bits} bits.`
    case 'memory-reg':
      return ptr === null
        ? `Legal: it copies a register into memory, and ${text(1)} gives the size: ${bits} bits.`
        : `Legal: it copies a register into memory, and ${code(`${PTR_WORD[ptr]} ptr`)} matches ${text(1)}: both are ${bits} bits.`
    case 'memory-number':
      return `Legal: it copies a number into memory, ${code(`${PTR_WORD[ptr ?? 64]} ptr`)} gives the size (${bits} bits), and ${text(1)} fits.`
  }
}

/** For a legal line: why the rule the student picked does not apply here. */
function whyItIsAllowed(plan: LinePlan, picked: Rule): string {
  const reg = registerOf(plan)
  const memory = memoryOf(plan)
  const number = numberOf(plan)
  const bits = sizeOf(plan.dest) ?? sizeOf(plan.src) ?? 64
  const regText = reg === null ? '' : code(reg.name)
  const ptr = memory === null ? null : memory.ptr
  const ptrText = ptr === null ? '' : code(`${PTR_WORD[ptr]} ptr`)
  switch (picked) {
    case 'memory-to-memory':
      return memory === null
        ? `Neither ${code(operandText(plan.dest))} nor ${code(operandText(plan.src))} is memory.`
        : `Only one side, ${code(memory.text)}, is memory.`
    case 'immediate-destination':
      return `The destination is ${code(operandText(plan.dest))}, not a number.`
    case 'size-mismatch':
      if (plan.dest.kind === 'reg' && plan.src.kind === 'reg') {
        return `${code(plan.dest.info.name)} and ${code(plan.src.info.name)} are both ${bits} bits.`
      }
      if (number !== null && reg !== null) {
        return `A number takes the size of its register, and ${code(number.text)} fits in ${regText} (${bits} bits).`
      }
      if (number !== null) {
        return `A number takes the size of the memory, and ${ptrText} means ${bits} bits.`
      }
      return ptr === null
        ? `The memory has no \`ptr\` size, so it takes the size of ${regText}: ${bits} bits.`
        : `${ptrText} and ${regText} are both ${bits} bits.`
    case 'missing-size':
      if (memory === null) {
        return reg !== null && number !== null
          ? `There is no memory in ${code(lineText(plan))}: ${regText} gives the size.`
          : `There is no memory in ${code(lineText(plan))}, so no \`ptr\` is needed.`
      }
      return reg !== null
        ? `The register ${regText} gives the size: ${bits} bits.`
        : `${ptrText} already gives the size.`
    case 'immediate-too-large':
      if (number === null) return `There is no number in ${code(lineText(plan))}.`
      if (plan.dest.kind === 'reg' && bits === 64) {
        return `${regText} holds 64 bits, so \`mov\` can copy any 64-bit number into it.`
      }
      // 64-bit memory takes only numbers that fit in 32 bits, so no range is claimed there.
      return bits === 64
        ? `${code(number.text)} fits in ${code(operandText(plan.dest))} (${bits} bits).`
        : `${code(number.text)} fits in ${code(operandText(plan.dest))}, which takes ${RANGE_TEXT[bits]}.`
  }
}

/** For an illegal line: the rule it breaks, with this line's operands. */
function ruleBroken(plan: LinePlan, rule: Rule): string {
  switch (rule) {
    case 'memory-to-memory':
      return `${code(operandText(plan.dest))} and ${code(operandText(plan.src))} are both memory, and \`mov\` cannot copy memory to memory in one step.`
    case 'immediate-destination':
      return `The first operand, ${code(operandText(plan.dest))}, is a number, and a number cannot be the destination.`
    case 'size-mismatch':
      return `${code(operandText(plan.dest))} is ${sizeOf(plan.dest) ?? 64} bits but ${code(operandText(plan.src))} is ${sizeOf(plan.src) ?? 64} bits.`
    case 'missing-size':
      return `Nothing tells how many bytes to write at ${code(operandText(plan.dest))}: it needs \`byte ptr\`, \`word ptr\`, \`dword ptr\` or \`qword ptr\`.`
    case 'immediate-too-large': {
      const bits = sizeOf(plan.dest) ?? 64
      return `${code(operandText(plan.src))} does not fit in ${code(operandText(plan.dest))}, which holds ${bits} bits (${RANGE_TEXT[bits]}).`
    }
  }
}

function isChoice(id: string): id is Verdict {
  return CHOICES.some((choice) => choice.id === id)
}

function isRule(id: Verdict): id is Rule {
  return id !== 'legal'
}

/* ──────────────────────────────── build ──────────────────────────────── */

function buildProblem(seed: number, rng: Rng, plan: LinePlan): Problem | null {
  const stepperSource = stepperCode(plan)
  const options = stepperOptions(rng, plan)

  // The answer key: the assembler's verdict on the exact stepper program.
  const assembled = assemble(stepperSource, options)
  const error = assembled.diagnostics.find((item) => item.severity === 'error')
  const verdict = error === undefined ? 'legal' : error.code
  const aimed: Verdict = (FORMS as readonly string[]).includes(plan.aim)
    ? 'legal'
    : (plan.aim as Rule)
  if (!isChoice(verdict) || verdict !== aimed) return null

  let reason: string
  let note: string
  if (error === undefined) {
    const run = runProgram(stepperSource, options)
    const instruction = run.program.instructions[0]
    const form = formOf(instruction)
    if (form !== plan.aim) {
      throw new Error(`mov-legality: \`${instruction.text}\` is ${form}, not ${plan.aim}.`)
    }
    reason = legalReason(form, instruction)
    const write = run.steps[0]?.result.diff.written.memory[0]
    if (plan.dest.kind === 'reg') {
      note = `Step once and watch ${code(plan.dest.info.base)}.`
    } else if (write !== undefined) {
      note = `Step once and watch the stack box at ${show(write.address - (write.address % 8n))}.`
    } else {
      throw new Error(`mov-legality: \`${instruction.text}\` wrote no memory.`)
    }
  } else {
    reason = illegalReason(error.message)
    note = "This line does not assemble: the stepper shows the assembler's message."
  }

  const expected = verdict
  const diagnose = (answers: Readonly<Record<string, string>>): Mistake | null => {
    const picked = answers.verdict ?? ''
    if (!isChoice(picked) || picked === expected) return null
    if (!isRule(expected)) {
      if (!isRule(picked)) return null
      return {
        code: 'wrong-legality',
        message: `This line is legal. ${whyItIsAllowed(plan, picked)}`,
      }
    }
    if (picked === 'legal') {
      return {
        code: 'wrong-legality',
        message: `This line is not legal. ${ruleBroken(plan, expected)}`,
      }
    }
    return {
      code: 'wrong-reason',
      message: `It is illegal, but for a different reason. ${ruleBroken(plan, expected)}`,
    }
  }

  return {
    id: `${TOPIC}-${seed}`,
    topic: TOPIC,
    seed,
    view: 'form',
    prompt: [
      textBlock('Is this `mov` line legal? If it is not, pick the rule it breaks.'),
      codeBlock([lineText(plan)]),
    ],
    fields: [choiceField('verdict', 'Legal or illegal?', CHOICES, expected)],
    reason,
    stepper: { code: stepperSource, options, note },
    diagnose,
  }
}

export const generate: ProblemGenerator = (seed) => {
  const rng = createRng(seed)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Half legal, half illegal; then every form and every rule equally often.
    const aim: Form | Rule = rng.chance() ? rng.pick(FORMS) : rng.pick(RULES)
    const problem = buildProblem(seed, rng, planLine(rng, aim))
    if (problem !== null) return problem
  }
  throw new Error(`mov-legality: no usable line for seed ${seed}.`)
}
