/**
 * Comparing the emulator with a real x86-64 process, step by step.
 *
 * The two cannot be compared number for number: a real process lives at other
 * addresses, starts with whatever the system left in the registers, and its library
 * functions leave their own junk behind. The rules:
 *
 *   rip   the distance from the address of `main` must be equal (this also proves the
 *         size of every instruction that ran);
 *   rsp   the distance from its value at the start of `main` must be equal;
 *   other registers
 *         - equal values match;
 *         - if the emulator's value is a stack address: the distance from the starting
 *           rsp must be equal on both sides;
 *         - if it is an address in the program (code or data): it must point at the
 *           same label plus the same distance on the real machine;
 *         - if both sides still hold the value they had when `main` started (a saved
 *           register that was put back), that matches;
 *   after a library call
 *         rcx rdx rsi rdi r8 r9 r10 r11 are junk on both sides: they are skipped until
 *         the program writes them again (only the bits it writes count again).
 *         rax holds the function's result in its low 32 bits.
 *   flags CF ZF SF OF are compared once the program has written them. After `imul`,
 *         ZF is skipped until it is written again (it is undefined on real CPUs).
 */
import { FLAG_NAMES, REG64_NAMES, type FlagName, type Reg64 } from '../../../src/emulator/types'
import { FULL_MASK, type EmulatorLayout, type EmulatorPoint } from './emulator'
import type { NativeState } from './state'

export interface Difference {
  /** 0 is the start of `main`; N is the state after N steps of the real machine. */
  step: number
  /** Source line and text of the instruction that ran last (0 and '' for step 0). */
  line: number
  text: string
  /** "rax", "rip", "ZF", … */
  what: string
  emulator: string
  native: string
}

export interface CompareInput {
  points: readonly EmulatorPoint[]
  native: readonly NativeState[]
  layout: EmulatorLayout
  /** Run-time address of a label of the program on the real machine, when known. */
  nativeSymbol: (label: string) => bigint | null
  /**
   * Also skip SF after `imul`. Needed under Rosetta 2, which always leaves SF at 0
   * there (a real Intel CPU sets it from the result).
   */
  ignoreSfAfterImul: boolean
}

export interface CompareResult {
  /** How many points were compared (the one with a difference included). */
  stepsCompared: number
  /** Everything that differs at the FIRST point that differs (later points follow from it). */
  differences: Difference[]
  /** Set when one side ran more steps than the other. */
  lengthProblem: string | null
}

const CALLER_SAVED: readonly Reg64[] = ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11']

/** Library functions whose result in eax is the same on every system. */
const RESULT_IN_EAX = new Set(['printf', 'scanf', 'putchar'])

/** A value "near the program" when no label is known: within 16 MiB of `main`. */
const NEAR = 16n * 1024n * 1024n

export function hex64(value: bigint): string {
  return `0x${BigInt.asUintN(64, value).toString(16).padStart(16, '0')}`
}

/** A signed distance: "+0x10" or "-0x8". */
function distance(value: bigint, from: bigint): string {
  const delta = BigInt.asIntN(64, value - from)
  return delta < 0n ? `-0x${(-delta).toString(16)}` : `+0x${delta.toString(16)}`
}

function sameDistance(a: bigint, aFrom: bigint, b: bigint, bFrom: bigint): boolean {
  return BigInt.asUintN(64, a - aFrom) === BigInt.asUintN(64, b - bFrom)
}

function inside(value: bigint, range: { low: bigint; high: bigint }): boolean {
  return value >= range.low && value < range.high
}

export function compareRuns(input: CompareInput): CompareResult {
  const { points, native, layout } = input
  const emulatorStart = points[0]
  const nativeStart = native[0]
  if (emulatorStart === undefined || nativeStart === undefined) {
    return { stepsCompared: 0, differences: [], lengthProblem: 'there is nothing to compare' }
  }
  const nativeMain = nativeStart.rip

  // Which bits of each register can be compared right now, and which flags.
  const known = Object.fromEntries(REG64_NAMES.map((reg) => [reg, FULL_MASK])) as Record<
    Reg64,
    bigint
  >
  const flagKnown: Record<FlagName, boolean> = { CF: false, ZF: false, SF: false, OF: false }

  /** The nearest label at or below `address` in the same region. */
  const labelBelow = (address: bigint): { name: string; address: bigint } | null => {
    const region = layout.regions.find((item) => inside(address, item))
    if (region === undefined) return null
    let best: { name: string; address: bigint } | null = null
    for (const symbol of layout.symbols) {
      if (!inside(symbol.address, region) || symbol.address > address) continue
      if (best === null || symbol.address > best.address) best = symbol
    }
    return best
  }

  const registerMatches = (reg: Reg64, emulator: bigint, real: bigint): boolean => {
    const mask = known[reg]
    if (mask === 0n) return true
    if ((emulator & mask) === (real & mask)) return true
    if (mask !== FULL_MASK) return false
    if (inside(emulator, layout.stack)) {
      return sameDistance(emulator, emulatorStart.registers.rsp, real, nativeStart.registers.rsp)
    }
    if (layout.regions.some((region) => inside(emulator, region))) {
      const label = labelBelow(emulator)
      const realLabel = label === null ? null : input.nativeSymbol(label.name)
      if (label !== null && realLabel !== null) {
        return real === realLabel + (emulator - label.address)
      }
      // No label to check against: any address close to the program is accepted.
      const gap = real > nativeMain ? real - nativeMain : nativeMain - real
      return gap < NEAR
    }
    return emulator === emulatorStart.registers[reg] && real === nativeStart.registers[reg]
  }

  const count = Math.min(points.length, native.length)
  let stepsCompared = 0
  for (let step = 0; step < count; step++) {
    const point = points[step]
    const real = native[step]
    if (point === undefined || real === undefined) break

    // 1. What this step makes comparable (or not comparable any more).
    if (point.nativeStep === 'over') {
      for (const reg of CALLER_SAVED) known[reg] = 0n
      known.rax = point.library !== null && RESULT_IN_EAX.has(point.library) ? 0xffff_ffffn : 0n
      for (const flag of FLAG_NAMES) flagKnown[flag] = false
    } else if (point.nativeStep === 'into') {
      for (const { reg, mask } of point.written) known[reg] |= mask
      for (const flag of point.writtenFlags) flagKnown[flag] = true
      if (point.mnemonic === 'imul') {
        flagKnown.ZF = false
        if (input.ignoreSfAfterImul) flagKnown.SF = false
      }
    }

    // 2. Compare.
    const differences: Difference[] = []
    const report = (what: string, emulator: string, real_: string): void => {
      differences.push({ step, line: point.line, text: point.text, what, emulator, native: real_ })
    }

    const code = layout.regions[0]
    if (point.status !== 'halted' && code !== undefined && inside(point.rip, code)) {
      if (!sameDistance(point.rip, layout.main, real.rip, nativeMain)) {
        report(
          'rip',
          `main${distance(point.rip, layout.main)}`,
          `main${distance(real.rip, nativeMain)}`,
        )
      }
    }

    for (const reg of REG64_NAMES) {
      const emulator = point.registers[reg]
      const value = real.registers[reg]
      if (reg === 'rsp') {
        const from = emulatorStart.registers.rsp
        const realFrom = nativeStart.registers.rsp
        if (!sameDistance(emulator, from, value, realFrom)) {
          report('rsp', `start${distance(emulator, from)}`, `start${distance(value, realFrom)}`)
        }
      } else if (!registerMatches(reg, emulator, value)) {
        const mask = known[reg]
        const part = mask === FULL_MASK ? '' : ` (bits ${hex64(mask)})`
        report(`${reg}${part}`, hex64(emulator), hex64(value))
      }
    }

    for (const flag of FLAG_NAMES) {
      if (flagKnown[flag] && point.flags[flag] !== real.flags[flag]) {
        report(flag, String(point.flags[flag]), String(real.flags[flag]))
      }
    }

    stepsCompared += 1
    if (differences.length > 0) return { stepsCompared, differences, lengthProblem: null }
  }

  let lengthProblem: string | null = null
  if (native.length !== points.length) {
    const last = points.at(-1)
    // A program that ends inside exit() never comes back: the real trace is one shorter.
    const endedInExit =
      last?.library === 'exit' && last.status === 'halted' && native.length === points.length - 1
    if (!endedInExit) {
      lengthProblem =
        `the real program ran ${native.length - 1} steps, the emulator ${points.length - 1}` +
        ` (compared the first ${Math.max(0, count - 1)})`
    }
  }
  return { stepsCompared, differences: [], lengthProblem }
}
