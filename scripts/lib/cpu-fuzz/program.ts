/**
 * The shape of a fuzz program.
 *
 * A fuzz program is a list of lines. Every line carries three things:
 *   - `text`:   the line as the emulator should read it (this goes into the fixture)
 *   - `native`: the same line for the real assembler (equal to `text`, except for the
 *               one spelling clang does not accept: `movsx r64, r/m32` → `movsxd`)
 *   - `step`:   what the line means, as plain data. The reference model in `model.ts`
 *               reads this, never the text, so a wrong rendering shows up as a
 *               disagreement with the real CPU.
 *
 * Nothing here imports the emulator: the fuzz tooling must stay independent of the
 * code it checks.
 */

export type Size = 8 | 16 | 32 | 64

/**
 * The registers a fuzz program may use freely. rsp is left out (its value differs
 * between a real process and the emulator) and so is r15 (it holds the address of the
 * scratch area, which also differs).
 */
export const FREE_REGISTERS = [
  'rax',
  'rbx',
  'rcx',
  'rdx',
  'rsi',
  'rdi',
  'rbp',
  'r8',
  'r9',
  'r10',
  'r11',
  'r12',
  'r13',
  'r14',
] as const

export type FreeRegister = (typeof FREE_REGISTERS)[number]

/** One register name (eax, ah, r8w, …) and the part of the 64-bit register it names. */
export interface RegName {
  name: string
  base: FreeRegister
  size: Size
  /** 8 for ah, bh, ch, dh (bits 15–8), else 0. */
  shift: 0 | 8
  /** True when real machine code needs a REX prefix for this name: r8–r14, sil, dil, bpl. */
  rex: boolean
}

function buildRegisterNames(): RegName[] {
  const names: RegName[] = []
  for (const letter of ['a', 'b', 'c', 'd']) {
    const base = `r${letter}x` as FreeRegister
    names.push({ name: base, base, size: 64, shift: 0, rex: false })
    names.push({ name: `e${letter}x`, base, size: 32, shift: 0, rex: false })
    names.push({ name: `${letter}x`, base, size: 16, shift: 0, rex: false })
    names.push({ name: `${letter}l`, base, size: 8, shift: 0, rex: false })
    names.push({ name: `${letter}h`, base, size: 8, shift: 8, rex: false })
  }
  for (const stem of ['si', 'di', 'bp']) {
    const base = `r${stem}` as FreeRegister
    names.push({ name: base, base, size: 64, shift: 0, rex: false })
    names.push({ name: `e${stem}`, base, size: 32, shift: 0, rex: false })
    names.push({ name: stem, base, size: 16, shift: 0, rex: false })
    names.push({ name: `${stem}l`, base, size: 8, shift: 0, rex: true })
  }
  for (let n = 8; n <= 14; n++) {
    const base = `r${n}` as FreeRegister
    names.push({ name: base, base, size: 64, shift: 0, rex: true })
    names.push({ name: `${base}d`, base, size: 32, shift: 0, rex: true })
    names.push({ name: `${base}w`, base, size: 16, shift: 0, rex: true })
    names.push({ name: `${base}b`, base, size: 8, shift: 0, rex: true })
  }
  return names
}

/** All 60 register names a fuzz program may use (14 registers × 4 widths + ah bh ch dh). */
export const REGISTER_NAMES: readonly RegName[] = buildRegisterNames()

export function registerNamed(name: string): RegName {
  const found = REGISTER_NAMES.find((r) => r.name === name)
  if (!found) throw new Error(`Not a fuzz register: ${name}`)
  return found
}

export interface RegOperand {
  kind: 'reg'
  reg: RegName
}

/** `[r15+offset]`: `size` bits of the scratch area, starting at byte `offset`. */
export interface MemOperand {
  kind: 'mem'
  offset: number
  size: Size
}

/** A number as written in the program (it may be negative). */
export interface ImmOperand {
  kind: 'imm'
  value: bigint
}

export type Place = RegOperand | MemOperand
export type Source = RegOperand | MemOperand | ImmOperand

export const CONDITIONS = [
  'je',
  'jne',
  'jg',
  'jge',
  'jl',
  'jle',
  'ja',
  'jae',
  'jb',
  'jbe',
  'js',
  'jns',
  'jo',
  'jno',
] as const

export type Condition = (typeof CONDITIONS)[number]

export type BinaryOp = 'mov' | 'add' | 'sub' | 'and' | 'or' | 'xor' | 'cmp' | 'test'

/** What one line does. */
export type Step =
  /** The fixed opening lines: `lea r15, scratch[rip]` and `cmp rsp, rsp`. */
  | { op: 'point-at-scratch' }
  | { op: 'known-flags' }
  | { op: BinaryOp; size: Size; dst: Place; src: Source }
  | { op: 'movzx' | 'movsx'; dst: RegName; src: Place }
  | {
      op: 'lea'
      dst: RegName
      base: FreeRegister | null
      index: FreeRegister | null
      scale: 1 | 2 | 4 | 8
      disp: bigint
    }
  | { op: 'inc' | 'dec'; size: Size; dst: Place }
  | { op: 'imul'; size: 16 | 32 | 64; dst: RegName; src: Source }
  | { op: 'push'; src: RegOperand | ImmOperand }
  | { op: 'pop'; dst: RegName }
  | { op: 'nop' }
  /** `condition: null` is a plain `jmp`. `probe` marks the CF/OF-only jump after an imul. */
  | { op: 'jump'; condition: Condition | null; label: string; probe: boolean }
  | { op: 'label'; name: string }

export interface Line {
  step: Step
  text: string
  native: string
  /** Statistics key such as "add reg,imm" or "je"; null for labels and the opening lines. */
  form: string | null
  /** The mnemonic exactly as written (it may be an alias such as `jz` or `movsxd`). */
  written: string | null
}

export interface FuzzProgram {
  /** "p0000", "p0001", … */
  id: string
  index: number
  /** How many instructions the random middle part has (15 to 45). */
  randomInstructions: number
  lines: Line[]
}

export function programId(index: number): string {
  return `p${String(index).padStart(4, '0')}`
}

function renderLines(program: FuzzProgram, pick: (line: Line) => string): string {
  return program.lines
    .map((line) => (line.step.op === 'label' ? pick(line) : `    ${pick(line)}`))
    .join('\n')
}

/** The program text for the emulator: labels at the left edge, instructions indented. */
export function emulatorBody(program: FuzzProgram): string {
  return renderLines(program, (line) => line.text)
}

/** The program text for the real assembler. */
export function nativeBody(program: FuzzProgram): string {
  return renderLines(program, (line) => line.native)
}
