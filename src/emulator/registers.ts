/**
 * The register model: sixteen 64-bit registers and every smaller name that
 * points into them.
 *
 * The write rules are the #1 thing beginners get wrong, so they live in one
 * small function (`writeRegister`) and are tested bit by bit:
 *
 *   - writing an  8-bit name (al, ah, sil, r8b …) changes only those 8 bits
 *   - writing a  16-bit name (ax, si, r8w …)      changes only the low 16 bits
 *   - writing a  32-bit name (eax, esi, r8d …)    ZEROES the upper 32 bits
 *   - writing a  64-bit name                       replaces everything
 *   - ah, bh, ch, dh are bits 15–8
 */
import { MASK } from './bits'
import {
  REG64_NAMES,
  type OperandSize,
  type Reg64,
  type RegisterFile,
  type RegisterInfo,
} from './types'

function info(
  name: string,
  base: Reg64,
  size: OperandSize,
  opts: { highByte?: boolean; needsRex?: boolean } = {},
): RegisterInfo {
  const highByte = opts.highByte ?? false
  return {
    name,
    base,
    size,
    shift: highByte ? 8 : 0,
    highByte,
    needsRex: opts.needsRex ?? false,
  }
}

function buildTable(): Map<string, RegisterInfo> {
  const table = new Map<string, RegisterInfo>()
  const add = (r: RegisterInfo) => table.set(r.name, r)

  // rax, rbx, rcx, rdx: the four with a high-byte name.
  for (const letter of ['a', 'b', 'c', 'd']) {
    const base = `r${letter}x` as Reg64
    add(info(base, base, 64))
    add(info(`e${letter}x`, base, 32))
    add(info(`${letter}x`, base, 16))
    add(info(`${letter}l`, base, 8))
    add(info(`${letter}h`, base, 8, { highByte: true }))
  }

  // rsi, rdi, rbp, rsp: the low byte (sil, dil, bpl, spl) needs a REX prefix.
  for (const stem of ['si', 'di', 'bp', 'sp']) {
    const base = `r${stem}` as Reg64
    add(info(base, base, 64))
    add(info(`e${stem}`, base, 32))
    add(info(stem, base, 16))
    add(info(`${stem}l`, base, 8, { needsRex: true }))
  }

  // r8 … r15: suffix d (32), w (16), b (8).
  for (let n = 8; n <= 15; n++) {
    const base = `r${n}` as Reg64
    add(info(base, base, 64, { needsRex: true }))
    add(info(`${base}d`, base, 32, { needsRex: true }))
    add(info(`${base}w`, base, 16, { needsRex: true }))
    add(info(`${base}b`, base, 8, { needsRex: true }))
  }

  return table
}

const TABLE = buildTable()

/** Every register name the emulator knows, e.g. "rax", "eax", "ax", "ah", "al", … */
export const ALL_REGISTER_NAMES: readonly string[] = [...TABLE.keys()]

/** Look up a register by name (any letter case). Returns undefined for unknown names. */
export function lookupRegister(name: string): RegisterInfo | undefined {
  return TABLE.get(name.toLowerCase())
}

export function isRegisterName(name: string): boolean {
  return TABLE.has(name.toLowerCase())
}

/** Look up a register that must exist (throws on a typo in emulator code). */
export function reg(name: string): RegisterInfo {
  const found = lookupRegister(name)
  if (!found) throw new Error(`Unknown register name: ${name}`)
  return found
}

/**
 * All the names that live inside one 64-bit register, widest first:
 * rax → [rax, eax, ax, ah, al]; rsi → [rsi, esi, si, sil]; r8 → [r8, r8d, r8w, r8b].
 */
export function registerFamily(base: Reg64): RegisterInfo[] {
  return [...TABLE.values()]
    .filter((r) => r.base === base)
    .sort((a, b) => b.size - a.size || b.shift - a.shift)
}

/** The name of the `size`-bit low part of a 64-bit register: (rax, 32) → eax. */
export function subRegister(base: Reg64, size: OperandSize): RegisterInfo {
  const found = [...TABLE.values()].find((r) => r.base === base && r.size === size && !r.highByte)
  if (!found) throw new Error(`No ${size}-bit part of ${base}`)
  return found
}

/** A fresh set of registers, all zero. */
export function createRegisterFile(): RegisterFile {
  const file = {} as RegisterFile
  for (const name of REG64_NAMES) file[name] = 0n
  return file
}

/** Read a register or a part of one. The result is unsigned and fits in `r.size` bits. */
export function readRegister(file: RegisterFile, r: RegisterInfo): bigint {
  return (file[r.base] >> BigInt(r.shift)) & MASK[r.size]
}

/**
 * Write a register or a part of one, following the x86-64 rules, and return the
 * new full 64-bit value. `value` may be any bigint; only its low `r.size` bits are used.
 */
export function writeRegister(file: RegisterFile, r: RegisterInfo, value: bigint): bigint {
  file[r.base] = mergeRegisterWrite(file[r.base], r, value)
  return file[r.base]
}

/**
 * The write rule as a pure function: what does the full 64-bit register hold
 * after writing `value` into the part named by `r`?
 */
export function mergeRegisterWrite(old64: bigint, r: RegisterInfo, value: bigint): bigint {
  const part = value & MASK[r.size]
  switch (r.size) {
    case 64:
      return part
    case 32:
      // The special rule: a 32-bit write clears bits 63–32.
      return part
    case 16:
      return (old64 & ~MASK[16] & MASK[64]) | part
    case 8: {
      const shift = BigInt(r.shift)
      const hole = (MASK[8] << shift) ^ MASK[64]
      return (old64 & hole) | (part << shift)
    }
  }
}
