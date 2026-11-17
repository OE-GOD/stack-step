/**
 * The operand rules of each instruction (behaviour contract, section 3).
 *
 * `validateInstruction` checks one instruction whose operands are already understood
 * and returns either the width it works on (`opSize`) or the first broken rule as a
 * `Diagnostic`. The rules are checked in a fixed order and the first failure wins:
 *
 *   1. the number of operands
 *   2. `ah/bh/ch/dh` together with a register that needs a REX prefix
 *   3. the rules of the instruction itself (see the table in each function)
 *
 * A number as the destination is always `immediate-destination` (PLAN.md: "a number
 * cannot be the destination"), except where the contract names another code:
 * `lea` (`invalid-operands`) and `pop` (`push-pop-operand`).
 */
import * as say from './errors'
import { subRegister } from './registers'
import type { Diagnostic, ImmOperand, Mnemonic, Operand, OperandSize, RegOperand } from './types'

export type ValidationResult =
  { ok: true; opSize: OperandSize | null } | { ok: false; diagnostic: Diagnostic }

function pass(opSize: OperandSize | null): ValidationResult {
  return { ok: true, opSize }
}

function fail(diagnostic: Diagnostic): ValidationResult {
  return { ok: false, diagnostic }
}

/* ───────────────────────── Kinds of instruction ───────────────────────── */

/** `je`, `jne`, … every jump except `jmp`. */
export function isConditionalJump(mnemonic: Mnemonic): boolean {
  return mnemonic !== 'jmp' && mnemonic.startsWith('j')
}

/** `jmp`, the conditional jumps and `call`: their one operand is a label. */
export function isBranch(mnemonic: Mnemonic): boolean {
  return mnemonic === 'jmp' || mnemonic === 'call' || isConditionalJump(mnemonic)
}

const NO_OPERANDS: ReadonlySet<Mnemonic> = new Set<Mnemonic>(['ret', 'nop', 'leave'])
const ONE_OPERAND: ReadonlySet<Mnemonic> = new Set<Mnemonic>(['inc', 'dec', 'push', 'pop'])

/** How many operands the instruction takes. */
export function expectedOperandCount(mnemonic: Mnemonic): 0 | 1 | 2 {
  if (NO_OPERANDS.has(mnemonic)) return 0
  if (ONE_OPERAND.has(mnemonic) || isBranch(mnemonic)) return 1
  return 2
}

/**
 * Rule 1: the operand count. Returns null when it is right.
 * `imul` with 1 or 3 operands is a real form that the emulator does not support, so it
 * gets its own message (`invalid-operands`) instead of `operand-count`.
 */
export function operandCountProblem(
  line: number,
  mnemonic: Mnemonic,
  written: string,
  found: number,
  missingComma = false,
): Diagnostic | null {
  const expected = expectedOperandCount(mnemonic)
  if (found === expected) return null
  if (mnemonic === 'imul' && (found === 1 || found === 3)) {
    return say.invalidOperands(line, { reason: 'imul-form', found })
  }
  return say.operandCount(line, { written, mnemonic, expected, found, missingComma })
}

/* ───────────────────────────── Immediates ───────────────────────────── */

const TWO_31 = 2n ** 31n
const TWO_64 = 2n ** 64n

/**
 * Does `value` fit a place of `size` bits? Both readings count: signed and unsigned,
 * so for 8 bits -128 … 255 fit (`mov al, 255` and `mov al, -1` are both fine).
 */
export function fitsBits(value: bigint, size: OperandSize): boolean {
  const bits = BigInt(size)
  return value >= -(1n << (bits - 1n)) && value <= (1n << bits) - 1n
}

/**
 * Can a 64-bit instruction carry `value` in its 32-bit immediate field?
 * The CPU sign-extends those 32 bits, so the values are -2^31 … 2^31-1, and also the
 * same bit patterns written as big unsigned numbers (`0xfffffffffffffff0` is -16).
 */
export function fitsSignExtended32(value: bigint): boolean {
  return (value >= -TWO_31 && value < TWO_31) || (value >= TWO_64 - TWO_31 && value < TWO_64)
}

function sizedRegister(operand: RegOperand): say.SizedText {
  return { text: operand.text, size: operand.reg.size }
}

function immediateText(operand: ImmOperand): say.ImmediateText {
  const kind = /^offset\b/.test(operand.text)
    ? 'address'
    : operand.symbol !== null
      ? 'constant'
      : 'number'
  return { text: operand.text, value: operand.value, kind }
}

/**
 * The "number does not fit" rule.
 * `rule` says what a 64-bit destination accepts: any 64-bit value (`mov` into a
 * register) or only a sign-extended 32-bit value (everything else).
 */
function immediateProblem(
  line: number,
  written: string,
  operand: ImmOperand,
  destination: say.SizedText,
  rule: 'any-64' | 'signed-32',
): Diagnostic | null {
  const immediate = immediateText(operand)
  if (destination.size !== 64) {
    if (fitsBits(operand.value, destination.size)) return null
    return say.immediateTooLarge(line, { reason: 'destination', immediate, destination })
  }
  if (!fitsBits(operand.value, 64)) {
    return say.immediateTooLarge(line, { reason: 'over-64', immediate })
  }
  if (rule === 'any-64' || fitsSignExtended32(operand.value)) return null
  return say.immediateTooLarge(line, { reason: 'signed-32', immediate, written })
}

/** `mov 5, rax`: the same line with the operands the right way round. */
function immediateFirst(
  line: number,
  mnemonic: Mnemonic,
  written: string,
  first: ImmOperand,
  second: Operand,
): Diagnostic {
  let place = 'rax'
  if (second.kind === 'reg') place = second.text
  else if (second.kind === 'mem') {
    place = second.size === null ? `dword ptr ${second.text}` : second.text
  }
  const example = `${written} ${place}, ${first.text}`
  return mnemonic === 'cmp' || mnemonic === 'test'
    ? say.immediateDestination(line, { reason: 'first', written, example })
    : say.immediateDestination(line, { reason: 'destination', example })
}

function mismatch(
  line: number,
  written: string,
  first: say.SizedText,
  second: say.SizedText,
): Diagnostic {
  return say.sizeMismatch(line, { reason: 'different', written, first, second })
}

/* ──────────────────────────── Rule 2: high bytes ──────────────────────────── */

const EXTENDED: ReadonlySet<string> = new Set([
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
  'r15',
])

/**
 * `ah`, `bh`, `ch`, `dh` cannot share an instruction with a register that needs a REX
 * prefix (`sil`, `dil`, `spl`, `bpl`, `r8`–`r15` in any width, also inside an address).
 */
function highByteProblem(line: number, operands: readonly Operand[]): Diagnostic | null {
  let high: string | null = null
  let other: string | null = null
  for (const operand of operands) {
    if (operand.kind === 'reg') {
      if (operand.reg.highByte) high ??= operand.text
      if (operand.reg.needsRex) other ??= operand.text
    } else if (operand.kind === 'mem') {
      for (const name of [operand.base, operand.index]) {
        if (name !== null && EXTENDED.has(name)) other ??= name
      }
    }
  }
  if (high === null || other === null) return null
  return say.highByteRex(line, { reason: 'register', high, other })
}

/* ─────────────────────── Rule 3: each instruction ─────────────────────── */

function memoryAction(mnemonic: Mnemonic): 'write' | 'change' | 'compare' {
  if (mnemonic === 'mov') return 'write'
  return mnemonic === 'cmp' || mnemonic === 'test' ? 'compare' : 'change'
}

/**
 * `mov add sub cmp and or xor test`.
 *
 * | first | second | rule                                                        |
 * | ----- | ------ | ----------------------------------------------------------- |
 * | imm   | any    | never: `immediate-destination`                              |
 * | mem   | mem    | never: `memory-to-memory`                                   |
 * | reg   | reg    | same size, else `size-mismatch`                             |
 * | reg   | mem    | a written size must match, else `size-mismatch`             |
 * | mem   | reg    | a written size must match, else `size-mismatch`             |
 * | mem   | imm    | the size must be written (`missing-size`); number must fit  |
 * | reg   | imm    | the number must fit, else `immediate-too-large`             |
 */
function twoOperandRule(
  line: number,
  mnemonic: Mnemonic,
  written: string,
  first: Operand,
  second: Operand,
): ValidationResult {
  if (first.kind === 'target' || second.kind === 'target') {
    return fail(say.invalidOperands(line, { reason: 'other', written, mnemonic }))
  }
  if (first.kind === 'imm') return fail(immediateFirst(line, mnemonic, written, first, second))

  if (first.kind === 'reg') {
    const size = first.reg.size
    if (second.kind === 'reg') {
      if (second.reg.size !== size) {
        return fail(mismatch(line, written, sizedRegister(first), sizedRegister(second)))
      }
      return pass(size)
    }
    if (second.kind === 'mem') {
      if (second.size !== null && second.size !== size) {
        const memory = { text: second.text, size: second.size }
        return fail(mismatch(line, written, sizedRegister(first), memory))
      }
      return pass(size)
    }
    // A 64-bit register takes any 64-bit number with `mov`, else 32 bits.
    const rule = mnemonic === 'mov' ? 'any-64' : 'signed-32'
    const problem = immediateProblem(line, written, second, sizedRegister(first), rule)
    return problem === null ? pass(size) : fail(problem)
  }

  // The first operand is memory.
  if (second.kind === 'mem') return fail(say.memoryToMemory(line, { written }))
  if (second.kind === 'reg') {
    if (first.size !== null && first.size !== second.reg.size) {
      const memory = { text: first.text, size: first.size }
      return fail(mismatch(line, written, memory, sizedRegister(second)))
    }
    return pass(second.reg.size)
  }
  if (first.size === null) {
    return fail(
      say.missingSize(line, {
        memory: first.text,
        action: memoryAction(mnemonic),
        example: `${written} dword ptr ${first.text}, ${second.text}`,
      }),
    )
  }
  const destination = { text: first.text, size: first.size }
  const problem = immediateProblem(line, written, second, destination, 'signed-32')
  return problem === null ? pass(first.size) : fail(problem)
}

/** `inc`, `dec`: a register, or memory with a written size. */
function oneOperandRule(
  line: number,
  mnemonic: Mnemonic,
  written: string,
  operand: Operand,
): ValidationResult {
  switch (operand.kind) {
    case 'reg':
      return pass(operand.reg.size)
    case 'mem':
      if (operand.size === null) {
        return fail(
          say.missingSize(line, {
            memory: operand.text,
            action: 'change',
            example: `${written} dword ptr ${operand.text}`,
          }),
        )
      }
      return pass(operand.size)
    case 'imm':
      return fail(say.immediateDestination(line, { reason: 'single', written }))
    case 'target':
      return fail(say.invalidOperands(line, { reason: 'other', written, mnemonic }))
  }
}

/**
 * `imul d, s`: d is a register of 16, 32 or 64 bits; s is a register or memory of the
 * same size, or a number.
 */
function imulRule(
  line: number,
  written: string,
  first: Operand,
  second: Operand,
): ValidationResult {
  if (first.kind === 'imm') {
    // `imul 5, rbx` → show `imul rbx, 5` when that is a line that works.
    const swap = second.kind === 'reg' && second.reg.size !== 8
    const example = swap ? `${written} ${second.text}, ${first.text}` : `${written} rax, 5`
    return fail(say.immediateDestination(line, { reason: 'register', written, example }))
  }
  if (first.kind !== 'reg' || first.reg.size === 8) {
    return fail(say.invalidOperands(line, { reason: 'imul-destination' }))
  }
  const size = first.reg.size
  switch (second.kind) {
    case 'reg':
      if (second.reg.size !== size) {
        return fail(mismatch(line, written, sizedRegister(first), sizedRegister(second)))
      }
      return pass(size)
    case 'mem':
      if (second.size !== null && second.size !== size) {
        const memory = { text: second.text, size: second.size }
        return fail(mismatch(line, written, sizedRegister(first), memory))
      }
      return pass(size)
    case 'imm': {
      const problem = immediateProblem(line, written, second, sizedRegister(first), 'signed-32')
      return problem === null ? pass(size) : fail(problem)
    }
    case 'target':
      return fail(say.invalidOperands(line, { reason: 'other', written, mnemonic: 'imul' }))
  }
}

/**
 * `movzx d, s` and `movsx d, s`: d is a register of 16, 32 or 64 bits; s is a smaller
 * register or memory of 8 or 16 bits (`movsx` also takes 32 bits into 64).
 */
function extendRule(
  line: number,
  mnemonic: Mnemonic,
  written: string,
  first: Operand,
  second: Operand,
): ValidationResult {
  if (first.kind === 'imm') {
    const example = `${written} eax, al`
    return fail(say.immediateDestination(line, { reason: 'register', written, example }))
  }
  if (first.kind !== 'reg' || (second.kind !== 'reg' && second.kind !== 'mem')) {
    return fail(say.invalidOperands(line, { reason: 'extend', written }))
  }
  const destination = sizedRegister(first)
  let sourceSize: OperandSize
  if (second.kind === 'reg') {
    sourceSize = second.reg.size
  } else if (second.size !== null) {
    sourceSize = second.size
  } else {
    return fail(
      say.missingSize(line, {
        memory: second.text,
        action: 'read',
        example: `${written} ${first.text}, byte ptr ${second.text}`,
      }),
    )
  }
  const source = { text: second.text, size: sourceSize }
  const half = subRegister(first.reg.base, 32).name
  if (sourceSize >= destination.size) {
    // A line that works: a 32-bit destination for a small source, else a plain `mov`.
    let example = `${written} ${half}, ${second.text}`
    if (sourceSize === 32 && mnemonic === 'movsx')
      example = `movsx ${first.reg.base}, ${second.text}`
    else if (sourceSize === 32) example = `mov ${half}, ${second.text}`
    else if (sourceSize === 64) example = `mov ${first.reg.base}, ${second.text}`
    return fail(
      say.sizeMismatch(line, { reason: 'not-smaller', written, destination, source, example }),
    )
  }
  if (sourceSize === 32 && mnemonic === 'movzx') {
    const example = `mov ${half}, ${second.text}`
    return fail(say.invalidOperands(line, { reason: 'extend-32', written, example }))
  }
  // A 64-bit destination needs a REX prefix, and `ah/bh/ch/dh` cannot be written with one.
  if (second.kind === 'reg' && second.reg.highByte && destination.size === 64) {
    const example = mnemonic === 'movzx' ? `${written} ${half}, ${second.text}` : null
    return fail(say.highByteRex(line, { reason: 'wide', high: second.text, example }))
  }
  return pass(destination.size)
}

/** `lea d, s`: d is a register of 16, 32 or 64 bits; s is memory. */
function leaRule(line: number, first: Operand, second: Operand): ValidationResult {
  if (first.kind !== 'reg' || first.reg.size === 8 || second.kind !== 'mem') {
    return fail(say.invalidOperands(line, { reason: 'lea' }))
  }
  return pass(first.reg.size)
}

/** A 64-bit register that the operand does not use, for an example line. */
function scratchRegister(operand: Operand): string {
  const used: (string | null)[] = operand.kind === 'mem' ? [operand.base, operand.index] : []
  return ['rax', 'rcx', 'rdx'].find((name) => !used.includes(name)) ?? 'rax'
}

/** `push s`: a 64-bit register, or a number that fits 32 bits. */
function pushRule(line: number, operand: Operand): ValidationResult {
  if (operand.kind === 'reg') {
    if (operand.reg.size === 64) return pass(64)
    const register = sizedRegister(operand)
    const wide = operand.reg.base
    return fail(
      say.pushPopOperand(line, { reason: 'small-register', written: 'push', register, wide }),
    )
  }
  if (operand.kind === 'imm') {
    if (fitsSignExtended32(operand.value)) return pass(64)
    return fail(
      say.pushPopOperand(line, { reason: 'too-large', written: 'push', text: operand.text }),
    )
  }
  const scratch = scratchRegister(operand)
  return fail(
    say.pushPopOperand(line, { reason: 'memory', written: 'push', memory: operand.text, scratch }),
  )
}

/** `pop d`: a 64-bit register. */
function popRule(line: number, operand: Operand): ValidationResult {
  if (operand.kind === 'reg') {
    if (operand.reg.size === 64) return pass(64)
    const register = sizedRegister(operand)
    const wide = operand.reg.base
    return fail(
      say.pushPopOperand(line, { reason: 'small-register', written: 'pop', register, wide }),
    )
  }
  if (operand.kind === 'imm') {
    return fail(say.pushPopOperand(line, { reason: 'number', written: 'pop' }))
  }
  const scratch = scratchRegister(operand)
  return fail(
    say.pushPopOperand(line, { reason: 'memory', written: 'pop', memory: operand.text, scratch }),
  )
}

/** `jmp`, the conditional jumps and `call`: one label. Only `call` reaches the library. */
function branchRule(
  line: number,
  mnemonic: Mnemonic,
  written: string,
  operand: Operand,
): ValidationResult {
  switch (operand.kind) {
    case 'target':
      if (operand.external && mnemonic !== 'call') {
        return fail(say.jumpTarget(line, { reason: 'library', written, name: operand.name }))
      }
      return pass(null)
    case 'reg':
      return fail(say.jumpTarget(line, { reason: 'register', written }))
    case 'mem':
      return fail(say.jumpTarget(line, { reason: 'memory', written }))
    case 'imm':
      return fail(say.jumpTarget(line, { reason: 'number', written }))
  }
}

/**
 * Check one instruction against the operand rules.
 *
 * @param written the mnemonic as typed (lower case), used in messages
 * @returns `opSize` (the width the instruction works on, null for jumps, `call`,
 *          `ret`, `nop`, `leave`) or the first broken rule
 */
export function validateInstruction(
  line: number,
  mnemonic: Mnemonic,
  written: string,
  operands: readonly Operand[],
): ValidationResult {
  const countProblem = operandCountProblem(line, mnemonic, written, operands.length)
  if (countProblem !== null) return fail(countProblem)

  const highByte = highByteProblem(line, operands)
  if (highByte !== null) return fail(highByte)

  const [first, second] = operands
  switch (mnemonic) {
    case 'mov':
    case 'add':
    case 'sub':
    case 'cmp':
    case 'and':
    case 'or':
    case 'xor':
    case 'test':
      return twoOperandRule(line, mnemonic, written, first, second)
    case 'inc':
    case 'dec':
      return oneOperandRule(line, mnemonic, written, first)
    case 'imul':
      return imulRule(line, written, first, second)
    case 'movzx':
    case 'movsx':
      return extendRule(line, mnemonic, written, first, second)
    case 'lea':
      return leaRule(line, first, second)
    case 'push':
      return pushRule(line, first)
    case 'pop':
      return popRule(line, first)
    case 'ret':
    case 'nop':
    case 'leave':
      return pass(null)
    default:
      return branchRule(line, mnemonic, written, first)
  }
}
