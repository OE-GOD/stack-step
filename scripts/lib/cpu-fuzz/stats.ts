/**
 * What a set of fuzz programs covers: how many instructions of each form, which
 * operand widths, which register names, and which jumps were taken or not taken.
 */
import type { ModelResult } from './model'
import {
  CONDITIONS,
  REGISTER_NAMES,
  type BinaryOp,
  type FuzzProgram,
  type Line,
  type Size,
  type Source,
} from './program'

export interface JumpCount {
  reached: number
  taken: number
  notTaken: number
}

export interface FuzzStats {
  programs: number
  /** Every instruction, including the opening loads and the closing pops. */
  instructions: number
  /** Fewest and most instructions in the random middle part of a program. */
  shortest: number
  longest: number
  /** Count per form, e.g. "add reg,imm": 212. Keys are sorted. */
  forms: Record<string, number>
  /** Count per mnemonic as written, so aliases such as `jz` and `movsxd` are visible. */
  spellings: Record<string, number>
  /** Count per operand width (instructions that have one). */
  sizes: Record<string, number>
  /** Count per register name (every operand, including `lea` address parts). */
  registers: Record<string, number>
  memory: { operands: number; numberFirst: number; explicitSize: number }
  /** Per condition (and "jmp"): how often it was reached, taken and not taken. */
  jumps: Record<string, JumpCount>
  /** The jumps right after an imul, which read only CF or OF. */
  imulProbes: JumpCount
}

const BINARY_OPS: readonly BinaryOp[] = ['mov', 'add', 'sub', 'and', 'or', 'xor', 'cmp', 'test']
const SHAPES = ['reg,reg', 'reg,imm', 'reg,mem', 'mem,reg', 'mem,imm'] as const
const EXTEND_WIDTHS: readonly (readonly [Size, Size])[] = [
  [16, 8],
  [32, 8],
  [64, 8],
  [32, 16],
  [64, 16],
]

/** Every form the generator is meant to produce. Used to prove nothing is missing. */
export function expectedForms(): string[] {
  const forms: string[] = []
  for (const op of BINARY_OPS) for (const shape of SHAPES) forms.push(`${op} ${shape}`)
  for (const op of ['movzx', 'movsx']) {
    for (const [dst, src] of EXTEND_WIDTHS)
      forms.push(`${op} r${dst},r${src}`, `${op} r${dst},m${src}`)
  }
  forms.push('movsx r64,r32', 'movsx r64,m32', 'lea')
  forms.push('inc reg', 'inc mem', 'dec reg', 'dec mem')
  forms.push('imul reg,reg', 'imul reg,mem', 'imul reg,imm')
  forms.push('push reg', 'push imm', 'pop reg', 'nop', 'jmp', ...CONDITIONS)
  return forms
}

function sorted(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function bump(counts: Map<string, number>, key: string, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by)
}

function widthOf(item: Line): Size | null {
  const step = item.step
  switch (step.op) {
    case 'mov':
    case 'add':
    case 'sub':
    case 'and':
    case 'or':
    case 'xor':
    case 'cmp':
    case 'test':
    case 'inc':
    case 'dec':
    case 'imul':
      return step.size
    case 'movzx':
    case 'movsx':
    case 'lea':
      return step.dst.size
    case 'push':
    case 'pop':
      return 64
    default:
      return null
  }
}

function registerNamesOf(item: Line): string[] {
  const step = item.step
  const names: string[] = []
  const place = (operand: Source): void => {
    if (operand.kind === 'reg') names.push(operand.reg.name)
  }
  switch (step.op) {
    case 'mov':
    case 'add':
    case 'sub':
    case 'and':
    case 'or':
    case 'xor':
    case 'cmp':
    case 'test':
      place(step.dst)
      place(step.src)
      break
    case 'movzx':
    case 'movsx':
      names.push(step.dst.name)
      place(step.src)
      break
    case 'lea':
      names.push(step.dst.name)
      if (step.base !== null) names.push(step.base)
      if (step.index !== null) names.push(step.index)
      break
    case 'inc':
    case 'dec':
      place(step.dst)
      break
    case 'imul':
      names.push(step.dst.name)
      place(step.src)
      break
    case 'push':
      place(step.src)
      break
    case 'pop':
      names.push(step.dst.name)
      break
    default:
      break
  }
  return names
}

export function collectStats(
  programs: readonly FuzzProgram[],
  results: readonly ModelResult[],
): FuzzStats {
  const forms = new Map<string, number>()
  const spellings = new Map<string, number>()
  const sizes = new Map<string, number>()
  const registers = new Map<string, number>()
  const memory = { operands: 0, numberFirst: 0, explicitSize: 0 }
  let instructions = 0
  let shortest = Number.POSITIVE_INFINITY
  let longest = 0

  for (const name of expectedForms()) forms.set(name, 0)
  for (const reg of REGISTER_NAMES) registers.set(reg.name, 0)

  for (const program of programs) {
    shortest = Math.min(shortest, program.randomInstructions)
    longest = Math.max(longest, program.randomInstructions)
    for (const item of program.lines) {
      if (item.step.op === 'label') continue
      instructions += 1
      for (const name of registerNamesOf(item)) bump(registers, name)
      if (item.form === null) continue
      bump(forms, item.form)
      if (item.written !== null) bump(spellings, item.written)
      const width = widthOf(item)
      if (width !== null) bump(sizes, String(width))
      if (item.text.includes('[r15')) {
        memory.operands += 1
        if (/[0-9a-f]\[r15\]/.test(item.text)) memory.numberFirst += 1
        if (/ ptr /.test(item.text)) memory.explicitSize += 1
      }
    }
  }

  const jumps: Record<string, JumpCount> = {}
  for (const name of ['jmp', ...CONDITIONS]) jumps[name] = { reached: 0, taken: 0, notTaken: 0 }
  const imulProbes: JumpCount = { reached: 0, taken: 0, notTaken: 0 }
  for (const result of results) {
    for (const jump of result.jumps) {
      for (const count of [jumps[jump.condition ?? 'jmp'], jump.probe ? imulProbes : undefined]) {
        if (count === undefined) continue
        count.reached += 1
        if (jump.taken) count.taken += 1
        else count.notTaken += 1
      }
    }
  }

  return {
    programs: programs.length,
    instructions,
    shortest: programs.length === 0 ? 0 : shortest,
    longest,
    forms: sorted(forms),
    spellings: sorted(spellings),
    sizes: sorted(sizes),
    registers: sorted(registers),
    memory,
    jumps,
    imulProbes,
  }
}

/** Everything the brief asks the fixture to cover that these programs do not cover. */
export function coverageGaps(stats: FuzzStats): string[] {
  const gaps: string[] = []
  for (const [form, count] of Object.entries(stats.forms)) {
    if (count === 0) gaps.push(`no instruction of the form "${form}"`)
  }
  for (const [name, count] of Object.entries(stats.registers)) {
    if (count === 0) gaps.push(`register ${name} is never used`)
  }
  for (const size of ['8', '16', '32', '64']) {
    if ((stats.sizes[size] ?? 0) === 0) gaps.push(`no ${size}-bit instruction`)
  }
  for (const condition of CONDITIONS) {
    const count = stats.jumps[condition]
    if (count === undefined || count.taken === 0) gaps.push(`${condition} is never taken`)
    if (count === undefined || count.notTaken === 0) gaps.push(`${condition} never falls through`)
  }
  if ((stats.jumps.jmp?.taken ?? 0) === 0) gaps.push('jmp is never reached')
  if (stats.imulProbes.taken === 0) gaps.push('no CF/OF jump after an imul is taken')
  if (stats.imulProbes.notTaken === 0) gaps.push('no CF/OF jump after an imul falls through')
  if (stats.memory.numberFirst === 0) gaps.push('the K[r15] spelling is never used')
  return gaps
}
