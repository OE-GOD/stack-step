/**
 * The emulator's side of the comparison: load the emulator from its TypeScript
 * sources, run one program step by step, and keep what the comparison needs.
 *
 * A "point" is a moment where the emulator and the real machine can be compared:
 * the start of `main`, and the state after each instruction. A call to a library
 * function (printf, scanf, …) is ONE point: the emulator takes two steps for it (the
 * `call`, then the library code), the debugger steps over it in one go.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_OPTIONS,
  type Diagnostic,
  type EmulatorApi,
  type EmulatorOptions,
  type FlagName,
  type Flags,
  type Instruction,
  type Mnemonic,
  type Reg64,
  type RegisterFile,
  type Status,
} from '../../../src/emulator/types'
import type { NativeStep } from './state'

export const FULL_MASK = 0xffff_ffff_ffff_ffffn

type Created =
  | { ok: true; emulator: EmulatorApi; diagnostics: Diagnostic[] }
  | { ok: false; emulator: null; diagnostics: Diagnostic[] }

export type CreateEmulator = (source: string, options?: EmulatorOptions) => Created

export type EmulatorLoad =
  { ok: true; createEmulator: CreateEmulator } | { ok: false; reason: string }

const EMULATOR_INDEX = new URL('../../../src/emulator/index.ts', import.meta.url)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Import `createEmulator` from `src/emulator/index.ts`.
 * The script that calls this must have installed the TypeScript resolver first
 * (`scripts/lib/load-typescript.mjs`). Never throws.
 */
export async function loadEmulator(): Promise<EmulatorLoad> {
  if (!existsSync(fileURLToPath(EMULATOR_INDEX))) {
    return { ok: false, reason: 'src/emulator/index.ts does not exist yet' }
  }
  let loaded: unknown
  try {
    loaded = await import(EMULATOR_INDEX.href)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: `src/emulator/index.ts could not be loaded (${text.split('\n')[0] ?? ''})`,
    }
  }
  if (!isRecord(loaded) || typeof loaded.createEmulator !== 'function') {
    return { ok: false, reason: 'src/emulator/index.ts does not export createEmulator yet' }
  }
  return { ok: true, createEmulator: loaded.createEmulator as CreateEmulator }
}

export interface EmulatorPoint {
  /** How the real machine gets here from the point before ('start' for the first point). */
  nativeStep: NativeStep | 'start'
  /** Source line and text of the instruction that ran (0 and '' for the start). */
  line: number
  text: string
  mnemonic: Mnemonic | null
  /** Name of the library function when this point is "after a library call". */
  library: string | null
  registers: Readonly<RegisterFile>
  rip: bigint
  flags: Readonly<Flags>
  status: Status
  /** Which bits of which registers the instruction wrote. */
  written: { reg: Reg64; mask: bigint }[]
  writtenFlags: readonly FlagName[]
}

export interface EmulatorLayout {
  /** Address of the first instruction that runs (`main`). */
  main: bigint
  regions: { name: string; low: bigint; high: bigint }[]
  stack: { low: bigint; high: bigint }
  /** Code and data labels with their addresses. */
  symbols: { name: string; address: bigint }[]
}

export interface EmulatorRun {
  points: EmulatorPoint[]
  output: string
  /** What a shell would see as the exit code (the low 8 bits), or null if the run did not end. */
  exitCode: number | null
  /** Why the run did not end normally, in one sentence; null when it did. */
  problem: string | null
  layout: EmulatorLayout
}

export type EmulatorRunResult = { ok: true; run: EmulatorRun } | { ok: false; reason: string }

/** More points than this means something is wrong (the emulator's own limit is 10 000). */
const MAX_POINTS = 20_000

/** Which bits of `reg` an instruction defines when it lists `reg` as written. */
export function writtenMask(instruction: Instruction | undefined, reg: Reg64): bigint {
  const destination = instruction?.operands[0]
  if (destination?.kind === 'reg' && destination.reg.base === reg) {
    // 8- and 16-bit writes change only their own bits. A 32-bit write clears the top half,
    // so it defines all 64 bits.
    if (destination.reg.size === 8) return 0xffn << BigInt(destination.reg.shift)
    if (destination.reg.size === 16) return 0xffffn
  }
  return FULL_MASK
}

function layoutOf(emulator: EmulatorApi): EmulatorLayout {
  const { layout, symbols, entry } = emulator.program
  const start = emulator.getSnapshot().registers.rsp
  return {
    main: entry,
    regions: [
      { name: 'code', low: layout.textBase, high: layout.textEnd },
      { name: 'read-only data', low: layout.rodataBase, high: layout.rodataEnd },
      { name: 'data', low: layout.dataBase, high: layout.dataEnd },
    ],
    // The contract puts the stack below `stackBase` (plus a little room above the
    // starting rsp). Take a generous range around where rsp starts.
    stack: { low: start - BigInt(DEFAULT_OPTIONS.stackSize), high: start + 0x10000n },
    symbols: [...symbols.values()]
      .filter((symbol) => symbol.kind !== 'external')
      .map((symbol) => ({ name: symbol.name, address: symbol.address })),
  }
}

/**
 * Run `source` in the emulator one step at a time and collect the comparison points.
 * `stdin` is what the program reads (scanf).
 */
export function runInEmulator(
  createEmulator: CreateEmulator,
  source: string,
  stdin: string,
): EmulatorRunResult {
  let created: Created
  try {
    created = createEmulator(source, { stdin })
  } catch (error) {
    return {
      ok: false,
      reason: `createEmulator threw: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!created.ok) {
    const first = created.diagnostics.find((item) => item.severity === 'error')
    return {
      ok: false,
      reason: `the emulator could not assemble it: ${first?.message ?? 'no message'}`,
    }
  }
  const emulator = created.emulator
  const program = emulator.program
  const layout = layoutOf(emulator)

  const first = emulator.getSnapshot()
  const points: EmulatorPoint[] = [
    {
      nativeStep: 'start',
      line: 0,
      text: '',
      mnemonic: null,
      library: null,
      registers: first.registers,
      rip: first.rip,
      flags: first.flags,
      status: first.status,
      written: [],
      writtenFlags: [],
    },
  ]
  let problem: string | null = null
  let exitCode: number | null = null

  // The contract says the emulator never throws. If it does anyway, report it as a
  // problem of this program instead of ending the whole script.
  try {
    while (points.length < MAX_POINTS) {
      const before = emulator.getSnapshot()
      if (before.status !== 'running') break
      const index = program.addressToIndex.get(before.rip)
      const instruction = index === undefined ? undefined : program.instructions[index]
      const step = emulator.step()
      if (!step.executed) {
        problem = 'the emulator did not run the next step'
        break
      }
      let after = emulator.getSnapshot()
      const target = instruction?.operands[0]
      const libraryCall =
        instruction?.mnemonic === 'call' && target?.kind === 'target' && target.external

      if (libraryCall && after.status === 'running') {
        // The second half of the call: the library function itself.
        const argument = after.registers.rdi
        const inside = emulator.step()
        after = emulator.getSnapshot()
        if (!inside.executed) {
          problem =
            after.status === 'waiting-input'
              ? `the program asks for more input than the example gives (line ${step.line})`
              : `the emulator did not run ${target.name}`
          break
        }
        if (target.name === 'exit' && after.status === 'halted') exitCode = Number(argument & 0xffn)
        points.push({
          nativeStep: 'over',
          line: step.line,
          text: step.text,
          mnemonic: 'call',
          library: target.name,
          registers: after.registers,
          rip: after.rip,
          flags: after.flags,
          status: after.status,
          written: [],
          writtenFlags: [],
        })
      } else {
        points.push({
          nativeStep: 'into',
          line: step.line,
          text: step.text,
          mnemonic: instruction?.mnemonic ?? null,
          library: null,
          registers: after.registers,
          rip: after.rip,
          flags: after.flags,
          status: after.status,
          written: step.diff.written.registers.map((reg) => ({
            reg,
            mask: writtenMask(instruction, reg),
          })),
          writtenFlags: step.diff.written.flags,
        })
      }
      if (after.status === 'error') {
        problem = `the emulator stopped with an error: ${after.error?.message ?? 'no message'}`
        break
      }
    }
  } catch (error) {
    problem = `the emulator threw an exception: ${error instanceof Error ? error.message : String(error)}`
  }

  const last = emulator.getSnapshot()
  if (last.status === 'halted') {
    exitCode ??= Number(last.registers.rax & 0xffn)
  } else if (problem === null) {
    problem =
      points.length >= MAX_POINTS
        ? `the program did not end within ${MAX_POINTS} steps`
        : `the emulator stopped in state '${last.status}'`
  }
  return { ok: true, run: { points, output: last.output, exitCode, problem, layout } }
}
