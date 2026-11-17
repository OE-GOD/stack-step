/**
 * Shared helpers for practice problem generators.
 *
 * A generator builds a tiny program, RUNS IT IN THE EMULATOR to get the answer key, and
 * predicts the wrong answers that common mistakes would produce. Everything a generator
 * needs for that is here, so all problem types read the same way:
 *
 *   const run = runProgram(source, smallWorld({ rsp: 0x200n }))
 *   const rspAfterStep2 = run.steps[1].after.registers.rsp
 *   fields.push(hexField('step2', 'rsp after step 2', rspAfterStep2))
 */
import {
  createEmulator,
  hex,
  hex64,
  REG64_NAMES,
  type EmulatorApi,
  type EmulatorOptions,
  type Instruction,
  type MachineState,
  type Program,
  type Reg64,
  type StepResult,
} from '../../../emulator'
import type { Rng } from '../../../lib/rng'
import type { Field, PromptBlock } from '../types'

/* ───────────────────────── running a program ─────────────────────────── */

export interface RunStep {
  /** What the step did (line, text, diff, explanation). */
  result: StepResult
  /** The machine right after the step. */
  after: MachineState
}

export interface ProgramRun {
  program: Program
  emulator: EmulatorApi
  /** The machine before the first step. */
  start: MachineState
  /** Every executed step, in execution order. */
  steps: RunStep[]
  /** The machine after the last step. */
  end: MachineState
}

export interface RunProgramSettings {
  /** Stop after this many steps even if the program has not ended. Default 200. */
  maxSteps?: number
  /**
   * By default a program that stops with an error, or that has not ended after
   * `maxSteps`, is a bug in the generator and throws. Set this to true for problems
   * that look only at the first few steps.
   */
  allowUnfinished?: boolean
}

/**
 * Assemble and run a program step by step, keeping the machine state after every step.
 *
 * Throws an Error (with the assembler's messages) when the program does not assemble:
 * that is a bug in the generator, never something a student should see. The tests of
 * every generator run it for hundreds of seeds, so such a bug cannot ship.
 */
export function runProgram(
  source: string,
  options: EmulatorOptions = {},
  settings: RunProgramSettings = {},
): ProgramRun {
  const created = createEmulator(source, options)
  if (!created.ok) {
    const messages = created.diagnostics
      .filter((item) => item.severity === 'error')
      .map((item) => item.message)
    throw new Error(`The practice program did not assemble: ${messages.join(' | ')}\n${source}`)
  }

  const emulator = created.emulator
  const start = emulator.getSnapshot()
  const steps: RunStep[] = []
  const limit = settings.maxSteps ?? 200

  while (steps.length < limit) {
    const status = emulator.getSnapshot().status
    if (status !== 'running') break
    const result = emulator.step()
    if (!result.executed) break
    steps.push({ result, after: emulator.getSnapshot() })
  }

  const end = emulator.getSnapshot()
  if (!settings.allowUnfinished && end.status !== 'halted') {
    const why = end.error ? end.error.message : `status '${end.status}' after ${steps.length} steps`
    throw new Error(`The practice program did not end cleanly: ${why}\n${source}`)
  }
  return { program: emulator.program, emulator, start, steps, end }
}

/** The instruction on a source line (1-based). Throws when that line has none. */
export function instructionAtLine(program: Program, line: number): Instruction {
  const index = program.lineToIndex.get(line)
  const instruction = index === undefined ? undefined : program.instructions[index]
  if (instruction === undefined) throw new Error(`Line ${line} has no instruction.`)
  return instruction
}

/** A line that holds only a label, such as `helper:`: the label's name, else null. */
const LABEL_LINE = /^\s*([A-Za-z_.][\w.]*):\s*$/

/**
 * The address column of a listing: the address of each line of `lines`, which are the
 * lines of `program`'s source, from line 1 on. A line with an instruction shows the
 * instruction's address; a line with only a label shows the label's address (the address
 * of the instruction that follows it). Throws when a line has neither: such a listing
 * cannot show an address column, and that is a bug in the generator.
 */
export function lineAddresses(program: Program, lines: readonly string[]): bigint[] {
  return lines.map((text, index) => {
    const position = program.lineToIndex.get(index + 1)
    const instruction = position === undefined ? undefined : program.instructions[position]
    if (instruction !== undefined) return instruction.address
    const label = LABEL_LINE.exec(text)?.[1]
    const symbol = label === undefined ? undefined : program.symbols.get(label)
    if (symbol === undefined) throw new Error(`Line ${index + 1} of the listing has no address.`)
    return symbol.address
  })
}

/**
 * The step of a run that ran the instruction on a source line (1-based), the first time it
 * ran: an index into `run.steps`. Throws when that line never ran.
 */
export function stepAtLine(run: ProgramRun, line: number): number {
  const index = run.steps.findIndex((step) => step.result.line === line)
  if (index < 0) throw new Error(`Line ${line} never ran.`)
  return index
}

/* ─────────────────────────── the small world ─────────────────────────── */

export interface SmallWorldSettings {
  /** Address of the first instruction. Default 0x4000. Keep it in 0x4000 … 0x4ff0. */
  textBase?: bigint
  /** rsp when the program starts. Default 0x1f8. A multiple of 8 in 0x100 … 0xff8. */
  rsp?: bigint
  /** Extra options (registers, memory, flags). They win over the small-world values. */
  extra?: EmulatorOptions
}

/** Where the small world keeps things. Code never reaches the data, data never the stack. */
export const SMALL_WORLD = {
  textBase: 0x4000n,
  rodataBase: 0x6000n,
  dataBase: 0x7000n,
  /** The stack may use 0x40 … 0xfff, so every stack address has 2 or 3 hex digits. */
  stackBase: 0x1000n,
  stackSize: 0xfc0,
  /**
   * rsp when `main` starts. It ends in 8, as on a real Linux machine (the `call` to `main`
   * has just pushed its return address), so rsp ends in 0 at every correctly aligned
   * `call` of the program, and the stepper shows no alignment note for one.
   */
  initialRsp: 0x1f8n,
  /** The fake return address into the "OS": just below the code. */
  osReturnAddress: 0x3ff0n,
} as const

/**
 * Options for a tiny machine with short addresses (3 or 4 hex digits), for problems
 * about rsp and rip arithmetic. Library junk is switched off so registers stay readable.
 */
export function smallWorld(settings: SmallWorldSettings = {}): EmulatorOptions {
  return {
    textBase: settings.textBase ?? SMALL_WORLD.textBase,
    rodataBase: SMALL_WORLD.rodataBase,
    dataBase: SMALL_WORLD.dataBase,
    stackBase: SMALL_WORLD.stackBase,
    stackSize: SMALL_WORLD.stackSize,
    initialRsp: settings.rsp ?? SMALL_WORLD.initialRsp,
    osReturnAddress: SMALL_WORLD.osReturnAddress,
    clobberCallerSaved: false,
    ...settings.extra,
  }
}

/* ───────────────────────── numbers as text ───────────────────────────── */

/** A value the way a student reads it in a question: "0x1f8". */
export function show(value: bigint): string {
  return hex(value)
}

/** A whole register the way a student reads it: "0x0000000000000009". */
export function show64(value: bigint): string {
  return hex64(value)
}

/** The canonical form `checkProblem` compares against: lower-case hex, no prefix ("1f8"). */
export function canonicalHex(value: bigint): string {
  return BigInt.asUintN(64, value).toString(16)
}

/** True when a student's canonical answer is exactly this value. */
export function answerIs(answer: string | undefined, value: bigint): boolean {
  return answer !== undefined && answer !== '' && answer === canonicalHex(value)
}

/* ─────────────────────────────── fields ──────────────────────────────── */

/** A number typed in hex. With `digits: 16` the student must type the whole register. */
export function hexField(
  id: string,
  label: string,
  value: bigint,
  settings: { digits?: number } = {},
): Field {
  const { digits } = settings
  return {
    id,
    label,
    kind: digits === undefined ? { type: 'hex' } : { type: 'hex', digits },
    expected: canonicalHex(value),
    expectedDisplay: digits === undefined ? show(value) : hex(value, digits),
  }
}

/** A short word such as a register name. */
export function textField(id: string, label: string, expected: string): Field {
  const tidy = expected.trim().toLowerCase()
  return { id, label, kind: { type: 'text' }, expected: tidy, expectedDisplay: tidy }
}

/** A number typed in decimal. */
export function decimalField(id: string, label: string, expected: number | bigint): Field {
  const text = BigInt(expected).toString()
  return { id, label, kind: { type: 'decimal' }, expected: text, expectedDisplay: text }
}

/** Pick one of the choices. `expectedId` must be the id of one of them. */
export function choiceField(
  id: string,
  label: string,
  choices: readonly { id: string; label: string }[],
  expectedId: string,
): Field {
  const right = choices.find((choice) => choice.id === expectedId)
  if (!right) throw new Error(`choiceField: no choice has the id '${expectedId}'.`)
  return {
    id,
    label,
    kind: { type: 'choice', choices },
    expected: expectedId,
    expectedDisplay: right.label,
  }
}

/** A cell of the trace table. `chip` is the chip that belongs there. */
export function chipField(id: string, label: string, chip: { id: string; label: string }): Field {
  return { id, label, kind: { type: 'chip' }, expected: chip.id, expectedDisplay: chip.label }
}

/* ───────────────────────────── prompt blocks ─────────────────────────── */

export function textBlock(text: string): PromptBlock {
  return { type: 'text', text }
}

/** A code listing. Pass `addresses` (same length as `lines`) to show an address column. */
export function codeBlock(lines: readonly string[], addresses?: readonly bigint[]): PromptBlock {
  if (addresses === undefined) return { type: 'code', lines }
  if (addresses.length !== lines.length) {
    throw new Error('codeBlock: `addresses` and `lines` must have the same length.')
  }
  return { type: 'code', lines, addresses: addresses.map(show) }
}

/** Starting register values, shown as whole 16-digit registers unless `short` is set. */
export function registersBlock(
  rows: readonly { name: string; value: bigint }[],
  settings: { title?: string; short?: boolean } = {},
): PromptBlock {
  return {
    type: 'registers',
    title: settings.title,
    rows: rows.map((row) => ({
      name: row.name,
      value: settings.short ? show(row.value) : show64(row.value),
    })),
  }
}

/** Stack boxes for a picture of the stack. Give them in any order: highest address first here. */
export function stackBlock(
  boxes: readonly { address: bigint; value: bigint; marker?: string }[],
  settings: { title?: string } = {},
): PromptBlock {
  const sorted = [...boxes].sort((a, b) =>
    a.address > b.address ? -1 : a.address < b.address ? 1 : 0,
  )
  return {
    type: 'stack',
    title: settings.title,
    rows: sorted.map((box) => ({
      address: show(box.address),
      value: show(box.value),
      marker: box.marker,
    })),
  }
}

/* ────────────────────── the classic decimal slips ────────────────────── */

/**
 * What a student gets who does hex arithmetic as if the digits were decimal.
 *
 *   decimalSlip(0x200n, -8n) → 0x192n     (200 − 8 = 192, read back as hex)
 *   decimalSlip(0x4009n, 8n) → 0x4017n    (4009 + 8 = 4017)
 *
 * Returns null when the slip cannot happen or gives nothing new: the start has a digit
 * a–f, the result would be negative, or the result equals the right answer.
 */
export function decimalSlip(start: bigint, change: bigint): bigint | null {
  const digits = start.toString(16)
  if (start < 0n || !/^[0-9]+$/.test(digits)) return null
  const wrong = BigInt(digits) + change
  if (wrong < 0n) return null
  const asHex = BigInt(`0x${wrong.toString(10)}`)
  return asHex === start + change ? null : asHex
}

/**
 * A decimal number in the code read as if it were hex: `sub rsp, 16` applied as 0x16.
 *
 *   readAsHex(16n) → 0x16n (22)
 *
 * Returns null when both readings are the same number (0 … 9).
 */
export function readAsHex(decimal: bigint): bigint | null {
  if (decimal < 0n) return null
  const asHex = BigInt(`0x${decimal.toString(10)}`)
  return asHex === decimal ? null : asHex
}

/* ─────────────────────────── random pieces ───────────────────────────── */

/** The registers a problem may freely use (never rsp or rbp, which hold addresses). */
export const FREE_REGISTERS: readonly Reg64[] = REG64_NAMES.filter(
  (name) => name !== 'rsp' && name !== 'rbp',
)

/** `count` different registers from `pool` (default: every register except rsp and rbp). */
export function pickRegisters(
  rng: Rng,
  count: number,
  pool: readonly Reg64[] = FREE_REGISTERS,
): Reg64[] {
  if (count > pool.length)
    throw new Error(`pickRegisters: only ${pool.length} registers to pick from.`)
  return rng.shuffle(pool).slice(0, count)
}

/**
 * A 64-bit value that is easy to compare by eye: 8 different bytes, none of them 0x00
 * or 0xff, so the top half is never zero and no part looks like another part.
 */
export function random64(rng: Rng): bigint {
  const used = new Set<number>()
  let value = 0n
  while (used.size < 8) {
    const byte = rng.int(0x11, 0xee)
    if (used.has(byte)) continue
    used.add(byte)
    value = (value << 8n) | BigInt(byte)
  }
  return value
}
