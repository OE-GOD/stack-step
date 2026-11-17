/**
 * Small pure helpers that turn a machine snapshot into what the panels show.
 * No React here, so the rules are easy to test (machineView.test.ts).
 */
import {
  hex,
  hexDigits,
  joinAnd,
  REG64_DISPLAY_ORDER,
  registerFamily,
  type DataView,
  type MachineState,
  type OperandSize,
  type Program,
  type Reg64,
  type StackSlot,
  type StepResult,
} from '../../emulator'

/* ─────────────────────────────── Hex digits ─────────────────────────────── */

/** How many leading zeros to dim. The last digit is never dimmed, so 0 still reads as 0. */
export function leadingZeros(digits: string): number {
  let count = 0
  while (count < digits.length - 1 && digits.charAt(count) === '0') count++
  return count
}

/**
 * Explanations shorten long addresses to `0x…dff8`. A line may not break after the `…`
 * (a word joiner holds the two halves together), so the address is never cut in two.
 */
export function readableNumbers(text: string): string {
  return text.replaceAll('0x\u2026', '0x\u2026\u2060')
}

/** Two hex digits for one byte. */
export function byteHex(byte: number): string {
  return byte.toString(16).padStart(2, '0')
}

/* ─────────────────────────────── Registers ─────────────────────────────── */

/** The three families the course groups the registers into. */
export const REGISTER_GROUPS: readonly (readonly Reg64[])[] = [
  REG64_DISPLAY_ORDER.slice(0, 4), // rax rbx rcx rdx
  REG64_DISPLAY_ORDER.slice(4, 8), // rsi rdi rbp rsp
  REG64_DISPLAY_ORDER.slice(8), // r8 … r15
]

/** One name inside a 64-bit register (rax → rax, eax, ax, ah, al) with its value. */
export interface RegisterPart {
  name: string
  size: OperandSize
  value: bigint
  /** Index of the lowest byte the name covers (0 = the lowest byte of the register). */
  firstByte: number
  /** How many bytes it covers. */
  byteCount: number
}

/** Every name inside `base`, widest first, with its value read from `full`. */
export function registerParts(base: Reg64, full: bigint): RegisterPart[] {
  return registerFamily(base).map((info) => {
    const mask = (1n << BigInt(info.size)) - 1n
    return {
      name: info.name,
      size: info.size,
      value: (full >> BigInt(info.shift)) & mask,
      firstByte: info.shift / 8,
      byteCount: info.size / 8,
    }
  })
}

/** Byte `index` (0 = lowest) of a 64-bit value. */
export function byteOf(value: bigint, index: number): number {
  return Number((value >> BigInt(index * 8)) & 0xffn)
}

/**
 * The registers that library code may change (the caller-saved ones), apart from rax,
 * which holds the function's result.
 */
export const CALLER_SAVED: readonly Reg64[] = ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11']

/**
 * The registers a library step left junk in: the caller-saved registers it changed. They
 * are not a result, so the panels mark them differently from a real change.
 */
export function junkRegisters(step: StepResult | null): ReadonlySet<Reg64> {
  if (step === null || step.kind !== 'library') return new Set()
  return new Set(
    step.diff.registers.map((change) => change.reg).filter((reg) => CALLER_SAVED.includes(reg)),
  )
}

/**
 * The registers whose value changed in the last step (`machine.lastStep`), without the
 * junk that a library step left behind (see `junkRegisters`).
 */
export function changedRegisters(step: StepResult | null): ReadonlySet<Reg64> {
  if (step === null) return new Set()
  const junk = junkRegisters(step)
  return new Set(step.diff.registers.map((change) => change.reg).filter((reg) => !junk.has(reg)))
}

/** "rcx, rdx, rsi, rdi and r8 to r11", in the order the course shows the registers. */
export function registerList(registers: ReadonlySet<Reg64>): string {
  const names = REG64_DISPLAY_ORDER.filter((name) => registers.has(name))
  const parts: string[] = []
  for (let i = 0; i < names.length; i++) {
    // r8, r9, r10, r11 in a row: "r8 to r11".
    const number = Number(/^r(\d+)$/.exec(names[i])?.[1] ?? NaN)
    let end = i
    while (
      Number.isInteger(number) &&
      end + 1 < names.length &&
      names[end + 1] === `r${number + (end + 1 - i)}`
    ) {
      end += 1
    }
    if (end - i >= 2) {
      parts.push(`\`${names[i]}\` to \`${names[end]}\``)
      i = end
    } else {
      parts.push(`\`${names[i]}\``)
    }
  }
  return joinAnd(parts)
}

/**
 * What a screen reader hears: "rax: 0x0000000000000005, changed". The value with all 16
 * digits, as the screen shows it: the name holds the words on the button (speech input
 * finds the row by them), and the student hears how wide a register is.
 */
export function registerName(name: Reg64, value: bigint, changed: boolean, junk: boolean): string {
  const words = [`${name}: 0x${hexDigits(value, 16)}`]
  if (changed) words.push('changed')
  if (junk) words.push('junk from the library call')
  return words.join(', ')
}

/* ───────────────────────────── Animations ───────────────────────────── */

const stepKeys = new WeakMap<StepResult, number>()
let lastStepKey = 0

/**
 * A number for the step on the screen, for the `key` that restarts a flash or a slide-in.
 * It changes when another step is shown (Step, Back, Run), and only then: the snapshot
 * version also changes when only a breakpoint was switched, and nothing ran then.
 * 0 = no step (a fresh program).
 */
export function stepKey(step: StepResult | null): number {
  if (step === null) return 0
  let key = stepKeys.get(step)
  if (key === undefined) {
    lastStepKey += 1
    key = lastStepKey
    stepKeys.set(step, key)
  }
  return key
}

/**
 * The registers whose top 32 bits were cleared by a 32-bit write in the last step
 * (`machine.lastStep`), such as `mov eax, 5` when rax held 0xffff…, with the value from
 * before the step. A 64-bit write that happens to clear the top half is not listed.
 */
export function clearedTopHalves(
  step: StepResult | null,
  program: Program | null,
): ReadonlyMap<Reg64, bigint> {
  const cleared = new Map<Reg64, bigint>()
  if (step === null || !step.executed) return cleared
  for (const change of step.diff.registers) {
    if (change.before >> 32n === 0n || change.after >> 32n !== 0n) continue
    let wrote32 = false
    if (step.kind === 'library') {
      // A library function leaves its result in eax: a 32-bit write.
      wrote32 = change.reg === 'rax'
    } else if (program !== null) {
      const index = program.addressToIndex.get(step.address)
      const destination = index === undefined ? undefined : program.instructions[index]?.operands[0]
      wrote32 =
        destination?.kind === 'reg' &&
        destination.reg.base === change.reg &&
        destination.reg.size === 32
    }
    if (wrote32) cleared.set(change.reg, change.before)
  }
  return cleared
}

/** The tidy text of the instruction on `line` ("mov eax, 0"), or null. */
export function instructionText(program: Program | null, line: number | null): string | null {
  if (program === null || line === null) return null
  const index = program.lineToIndex.get(line)
  return index === undefined ? null : (program.instructions[index]?.text ?? null)
}

/**
 * The registers a program names in its code, in display order (rax, rbx, …). The
 * registers that push, pop, call and ret use without naming them are not counted.
 */
export function registersInProgram(program: Program): Reg64[] {
  const named = new Set<Reg64>()
  for (const instruction of program.instructions) {
    for (const operand of instruction.operands) {
      if (operand.kind === 'reg') named.add(operand.reg.base)
      if (operand.kind === 'mem') {
        if (operand.base !== null && operand.base !== 'rip') named.add(operand.base)
        if (operand.index !== null) named.add(operand.index)
      }
    }
  }
  return REG64_DISPLAY_ORDER.filter((name) => named.has(name))
}

/** True when the program calls printf, scanf, puts, putchar or exit. */
export function callsLibrary(program: Program): boolean {
  return [...program.symbols.values()].some((symbol) => symbol.kind === 'external')
}

/* ───────────────────────────────── Stack ───────────────────────────────── */

/** At most this many leftover boxes (below rsp) are shown, the ones nearest to rsp. */
const MAX_LEFTOVERS = 4

/** The boxes the stack panel shows: the live ones and the nearest leftovers. */
export function visibleStack(stack: readonly StackSlot[]): readonly StackSlot[] {
  const firstDead = stack.findIndex((slot) => slot.dead)
  return firstDead === -1 ? stack : stack.slice(0, firstDead + MAX_LEFTOVERS)
}

/**
 * One row of the Stack panel:
 * - 'box':    one 8-byte box;
 * - 'unset':  boxes that nobody wrote yet, in one row (`sub rsp, 4096` makes 512 of them);
 * - 'hidden': boxes left out so the list stays short; a button shows `count` of them.
 */
export type StackRow =
  | { kind: 'box'; slot: StackSlot }
  | { kind: 'unset'; count: number; high: bigint; low: bigint }
  | { kind: 'hidden'; count: number }

/** A run of this many plain boxes that nobody wrote becomes one row (the 2 at each end stay). */
const UNSET_RUN = 6
/** Unset boxes kept at each end of such a run: where the next push and the locals go. */
const UNSET_ENDS = 2
/** The list shows at most about this many rows; more boxes are left out (see 'hidden'). */
export const MAX_STACK_ROWS = 200
/** Rows always kept at the top: the start of the stack (main's frame, the way back to the OS). */
const TOP_ROWS = 6
/** Rows kept around rbp when it is far from rsp. */
const AROUND_RBP = 6
/** How many more rows one press of "Show more" adds. */
export const MORE_STACK_ROWS = 200

/** A box with nothing to show: never written, no label, no pointer, not changed. */
function plainUnset(slot: StackSlot): boolean {
  return (
    slot.value === null &&
    slot.label === null &&
    !slot.isRsp &&
    !slot.isRbp &&
    !slot.changed &&
    !slot.dead
  )
}

/** Long runs of plain unset boxes become one 'unset' row each. */
function collapseUnset(slots: readonly StackSlot[]): StackRow[] {
  const rows: StackRow[] = []
  let index = 0
  while (index < slots.length) {
    const slot = slots[index]
    if (!plainUnset(slot)) {
      rows.push({ kind: 'box', slot })
      index += 1
      continue
    }
    let end = index
    while (end + 1 < slots.length && plainUnset(slots[end + 1])) end += 1
    const run = slots.slice(index, end + 1)
    if (run.length < UNSET_RUN) {
      for (const box of run) rows.push({ kind: 'box', slot: box })
    } else {
      const middle = run.slice(UNSET_ENDS, run.length - UNSET_ENDS)
      for (const box of run.slice(0, UNSET_ENDS)) rows.push({ kind: 'box', slot: box })
      rows.push({
        kind: 'unset',
        count: middle.length,
        high: middle[0].address,
        low: middle[middle.length - 1].address,
      })
      for (const box of run.slice(run.length - UNSET_ENDS)) rows.push({ kind: 'box', slot: box })
    }
    index = end + 1
  }
  return rows
}

/**
 * The rows of the Stack panel, high addresses first, never much more than
 * `MAX_STACK_ROWS` of them, however big the stack is: long runs of unset boxes are one
 * row, and from a very deep stack only the top, the part around rsp and the part around
 * rbp are shown. `revealed` more rows above the part around rsp are shown on request.
 */
export function stackRows(stack: readonly StackSlot[], revealed = 0): StackRow[] {
  const rows = collapseUnset(visibleStack(stack))
  if (rows.length <= MAX_STACK_ROWS) return rows

  const isBox = (row: StackRow, test: (slot: StackSlot) => boolean) =>
    row.kind === 'box' && test(row.slot)
  const rspRow = rows.findIndex((row) => isBox(row, (slot) => slot.isRsp))
  const rbpRow = rows.findIndex((row) => isBox(row, (slot) => slot.isRbp))
  const bottom = rspRow === -1 ? rows.length - 1 : rspRow
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(TOP_ROWS, rows.length); i++) keep.add(i)
  const firstNearRsp = Math.max(0, bottom - (MAX_STACK_ROWS - TOP_ROWS) - revealed)
  for (let i = firstNearRsp; i < rows.length; i++) keep.add(i)
  if (rbpRow !== -1) {
    const from = Math.max(0, rbpRow - AROUND_RBP)
    const to = Math.min(rows.length - 1, rbpRow + AROUND_RBP)
    for (let i = from; i <= to; i++) keep.add(i)
  }

  const shown: StackRow[] = []
  let hidden = 0
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (hidden > 0) shown.push({ kind: 'hidden', count: hidden })
      hidden = 0
      shown.push(row)
    } else {
      hidden += row.kind === 'unset' ? row.count : 1
    }
  })
  return shown
}

/**
 * What a screen reader hears for a box: what it is first, then its value (all 16 digits,
 * as the screen shows it) and its address.
 */
export function stackBoxName(slot: StackSlot, offset: string | null): string {
  const parts = [slot.label ?? 'Box']
  parts.push(slot.value === null ? 'not set yet' : `0x${hexDigits(slot.value, 16)}`)
  if (slot.changed) parts.push('changed')
  if (slot.dead) parts.push('leftover')
  parts.push(`address ${hex(slot.address)}`)
  if (offset !== null) parts.push(offset)
  if (slot.isRsp) parts.push('rsp points here')
  if (slot.isRbp) parts.push('rbp points here')
  return parts.join(', ')
}

/** True when rbp points at a box of the stack. */
export function rbpInStack(stack: readonly StackSlot[]): boolean {
  return stack.some((slot) => slot.isRbp)
}

/** "rbp", "rbp+8", "rbp−16" (with a real minus sign, as the explanations write it). */
export function rbpOffset(address: bigint, rbp: bigint): string {
  const offset = address - rbp
  if (offset === 0n) return 'rbp'
  return offset > 0n ? `rbp+${offset}` : `rbp−${-offset}`
}

/**
 * True when the last step pushed this box: it was written, rsp points at it, and rsp
 * went down in that step (push, call).
 */
export function wasPushed(slot: StackSlot, machine: MachineState): boolean {
  if (!slot.changed || !slot.isRsp) return false
  const rsp = machine.lastStep?.diff.registers.find((change) => change.reg === 'rsp')
  return rsp !== undefined && rsp.after < rsp.before
}

/* ───────────────────────────────── Data ───────────────────────────────── */

/** A string as the Data panel shows it: line breaks and other special characters as `\n`, `\t`, … */
export function visibleText(text: string): { text: string; escape: boolean }[] {
  const parts: { text: string; escape: boolean }[] = []
  let plain = ''
  const flush = () => {
    if (plain !== '') parts.push({ text: plain, escape: false })
    plain = ''
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    let escape: string | null = null
    if (char === '\n') escape = '\\n'
    else if (char === '\t') escape = '\\t'
    else if (char === '\r') escape = '\\r'
    else if (char === '\\') escape = '\\\\'
    else if (char === '"') escape = '\\"'
    else if (code < 0x20 || code === 0x7f) escape = `\\x${byteHex(code)}`
    if (escape === null) {
      plain += char
    } else {
      flush()
      parts.push({ text: escape, escape: true })
    }
  }
  flush()
  return parts
}

/** True when the last step wrote any byte of this data item. */
export function dataChanged(item: DataView, machine: MachineState): boolean {
  const step = machine.lastStep
  if (step === null) return false
  const start = item.address
  const end = start + BigInt(item.values.length * item.elementSize)
  return step.diff.memory.some((change) => {
    const writeEnd = change.address + BigInt(change.after.length)
    return change.address < end && writeEnd > start
  })
}

/** The last step changed something the Output tab shows: printed text or a data item. */
export function outputChanged(machine: MachineState): boolean {
  const step = machine.lastStep
  if (step === null) return false
  return step.output !== '' || machine.data.some((item) => dataChanged(item, machine))
}

/** The last step changed something the Stack tab shows: a box, or where rsp / rbp point. */
export function stackChanged(machine: MachineState): boolean {
  const step = machine.lastStep
  if (step === null) return false
  return (
    machine.stack.some((slot) => slot.changed) ||
    step.diff.registers.some((change) => change.reg === 'rsp' || change.reg === 'rbp')
  )
}

/** The last step changed a register or a flag. */
export function registersChanged(machine: MachineState): boolean {
  const step = machine.lastStep
  if (step === null) return false
  return step.diff.registers.length > 0 || step.diff.flags.length > 0
}
