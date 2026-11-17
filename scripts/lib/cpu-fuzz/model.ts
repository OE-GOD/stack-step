/**
 * A small reference model of the instructions a fuzz program uses.
 *
 * The ground truth in the fixture always comes from the real CPU, never from this file.
 * The model has three jobs:
 *   1. re-check the generator's safety rules while "running" each program (balanced
 *      stack, no read of a flag that `imul` leaves undefined, memory inside the
 *      scratch area);
 *   2. count which jumps were taken, for the coverage report;
 *   3. cross-check the harness: if the model and the real CPU disagree about any
 *      register, flag or byte, either the harness or my reading of x86-64 is wrong, and
 *      no fixture is written until that is understood.
 *
 * It works on the `step` data of each line, not on the text.
 */
import {
  FREE_REGISTERS,
  type Condition,
  type FreeRegister,
  type FuzzProgram,
  type Place,
  type RegName,
  type Size,
  type Source,
} from './program'

export type FlagName = 'CF' | 'ZF' | 'SF' | 'OF'
export const FLAG_NAMES: readonly FlagName[] = ['CF', 'ZF', 'SF', 'OF']

/** A flag is 0, 1, or not defined by the last instruction that wrote it (imul's SF and ZF). */
type FlagValue = 0 | 1 | 'undefined'

export interface ModelJump {
  condition: Condition | null
  taken: boolean
  probe: boolean
}

export interface ModelResult {
  registers: Record<FreeRegister, bigint>
  flags: Record<FlagName, 0 | 1>
  scratch: Uint8Array
  /** Every jump that was reached, in order. */
  jumps: ModelJump[]
  /** How many instructions ran (skipped ones are not counted). */
  executed: number
}

export const SCRATCH_BYTES = 256

function mask(size: Size): bigint {
  return (1n << BigInt(size)) - 1n
}

function topBit(value: bigint, size: Size): 0 | 1 {
  return (value >> BigInt(size - 1)) & 1n ? 1 : 0
}

/** Which flags each condition reads, and when it holds. */
const CONDITION_RULES: Readonly<
  Record<Condition, { reads: readonly FlagName[]; holds: (f: Record<FlagName, 0 | 1>) => boolean }>
> = {
  je: { reads: ['ZF'], holds: (f) => f.ZF === 1 },
  jne: { reads: ['ZF'], holds: (f) => f.ZF === 0 },
  jg: { reads: ['ZF', 'SF', 'OF'], holds: (f) => f.ZF === 0 && f.SF === f.OF },
  jge: { reads: ['SF', 'OF'], holds: (f) => f.SF === f.OF },
  jl: { reads: ['SF', 'OF'], holds: (f) => f.SF !== f.OF },
  jle: { reads: ['ZF', 'SF', 'OF'], holds: (f) => f.ZF === 1 || f.SF !== f.OF },
  ja: { reads: ['CF', 'ZF'], holds: (f) => f.CF === 0 && f.ZF === 0 },
  jae: { reads: ['CF'], holds: (f) => f.CF === 0 },
  jb: { reads: ['CF'], holds: (f) => f.CF === 1 },
  jbe: { reads: ['CF', 'ZF'], holds: (f) => f.CF === 1 || f.ZF === 1 },
  js: { reads: ['SF'], holds: (f) => f.SF === 1 },
  jns: { reads: ['SF'], holds: (f) => f.SF === 0 },
  jo: { reads: ['OF'], holds: (f) => f.OF === 1 },
  jno: { reads: ['OF'], holds: (f) => f.OF === 0 },
}

/** Run one program in the model. Throws when the program breaks a generator rule. */
export function runModel(program: FuzzProgram): ModelResult {
  const registers = Object.fromEntries(FREE_REGISTERS.map((name) => [name, 0n])) as Record<
    FreeRegister,
    bigint
  >
  const flags: Record<FlagName, FlagValue> = { CF: 0, ZF: 0, SF: 0, OF: 0 }
  const scratch = new Uint8Array(SCRATCH_BYTES)
  const stack: bigint[] = []
  const jumps: ModelJump[] = []
  let scratchReady = false
  let executed = 0

  const fail = (message: string): never => {
    throw new Error(`Fuzz program ${program.id} breaks a generator rule: ${message}`)
  }

  const readRegister = (reg: RegName): bigint =>
    (registers[reg.base] >> BigInt(reg.shift)) & mask(reg.size)

  const writeRegister = (reg: RegName, value: bigint): void => {
    const part = value & mask(reg.size)
    const old = registers[reg.base]
    if (reg.size === 64 || reg.size === 32) {
      // A 32-bit write clears the top half of the 64-bit register.
      registers[reg.base] = part
    } else {
      const hole = mask(reg.size) << BigInt(reg.shift)
      registers[reg.base] = (old & ~hole & mask(64)) | (part << BigInt(reg.shift))
    }
  }

  const checkMemory = (offset: number, size: Size): void => {
    if (!scratchReady) fail('memory used before r15 points at the scratch area')
    if (offset < 0 || offset + size / 8 > SCRATCH_BYTES) {
      fail(`memory access [r15+${offset}] of ${size} bits leaves the scratch area`)
    }
  }

  const readMemory = (offset: number, size: Size): bigint => {
    checkMemory(offset, size)
    let value = 0n
    for (let i = size / 8 - 1; i >= 0; i--) value = (value << 8n) | BigInt(scratch[offset + i] ?? 0)
    return value
  }

  const writeMemory = (offset: number, size: Size, value: bigint): void => {
    checkMemory(offset, size)
    for (let i = 0; i < size / 8; i++) {
      scratch[offset + i] = Number((value >> BigInt(8 * i)) & 0xffn)
    }
  }

  /** The operand's value as an unsigned `size`-bit number. */
  const read = (operand: Source, size: Size): bigint => {
    if (operand.kind === 'reg') {
      if (operand.reg.size !== size) fail(`register ${operand.reg.name} is not ${size} bits`)
      return readRegister(operand.reg)
    }
    if (operand.kind === 'mem') {
      if (operand.size !== size) fail(`memory operand is ${operand.size} bits, not ${size}`)
      return readMemory(operand.offset, size)
    }
    // Two's complement: a negative number wraps, and for 64 bits this is sign extension.
    return BigInt.asUintN(size, operand.value)
  }

  const write = (place: Place, size: Size, value: bigint): void => {
    if (place.kind === 'reg') {
      if (place.reg.size !== size) fail(`register ${place.reg.name} is not ${size} bits`)
      writeRegister(place.reg, value)
    } else {
      if (place.size !== size) fail(`memory operand is ${place.size} bits, not ${size}`)
      writeMemory(place.offset, size, value)
    }
  }

  const setResultFlags = (result: bigint, size: Size): void => {
    flags.ZF = result === 0n ? 1 : 0
    flags.SF = topBit(result, size)
  }

  const add = (a: bigint, b: bigint, size: Size, keepCarry: boolean): bigint => {
    const full = a + b
    const result = full & mask(size)
    if (!keepCarry) flags.CF = full > mask(size) ? 1 : 0
    // Overflow: both inputs have the same sign and the result's sign differs.
    flags.OF = topBit((a ^ result) & (b ^ result), size)
    setResultFlags(result, size)
    return result
  }

  const subtract = (a: bigint, b: bigint, size: Size, keepCarry: boolean): bigint => {
    const result = (a - b) & mask(size)
    if (!keepCarry) flags.CF = a < b ? 1 : 0
    // Overflow: the inputs have different signs and the result's sign differs from a's.
    flags.OF = topBit((a ^ b) & (a ^ result), size)
    setResultFlags(result, size)
    return result
  }

  const logic = (result: bigint, size: Size): bigint => {
    flags.CF = 0
    flags.OF = 0
    setResultFlags(result, size)
    return result
  }

  const labelIndex = new Map<string, number>()
  program.lines.forEach((item, index) => {
    if (item.step.op === 'label') labelIndex.set(item.step.name, index)
  })

  let position = 0
  while (position < program.lines.length) {
    const current = program.lines[position]
    if (current === undefined) break
    const step = current.step
    position += 1
    if (step.op === 'label') continue
    executed += 1

    switch (step.op) {
      case 'point-at-scratch':
        scratchReady = true
        break
      case 'known-flags':
        // cmp rsp, rsp: the result is 0.
        flags.CF = 0
        flags.ZF = 1
        flags.SF = 0
        flags.OF = 0
        break
      case 'mov':
        write(step.dst, step.size, read(step.src, step.size))
        break
      case 'add':
        write(
          step.dst,
          step.size,
          add(read(step.dst, step.size), read(step.src, step.size), step.size, false),
        )
        break
      case 'sub':
        write(
          step.dst,
          step.size,
          subtract(read(step.dst, step.size), read(step.src, step.size), step.size, false),
        )
        break
      case 'cmp':
        subtract(read(step.dst, step.size), read(step.src, step.size), step.size, false)
        break
      case 'and':
        write(
          step.dst,
          step.size,
          logic(read(step.dst, step.size) & read(step.src, step.size), step.size),
        )
        break
      case 'or':
        write(
          step.dst,
          step.size,
          logic(read(step.dst, step.size) | read(step.src, step.size), step.size),
        )
        break
      case 'xor':
        write(
          step.dst,
          step.size,
          logic(read(step.dst, step.size) ^ read(step.src, step.size), step.size),
        )
        break
      case 'test':
        logic(read(step.dst, step.size) & read(step.src, step.size), step.size)
        break
      case 'inc':
        write(step.dst, step.size, add(read(step.dst, step.size), 1n, step.size, true))
        break
      case 'dec':
        write(step.dst, step.size, subtract(read(step.dst, step.size), 1n, step.size, true))
        break
      case 'movzx':
      case 'movsx': {
        const sourceSize = step.src.kind === 'reg' ? step.src.reg.size : step.src.size
        if (sourceSize >= step.dst.size)
          fail(`${step.op} source is not narrower than its destination`)
        const value = read(step.src, sourceSize)
        writeRegister(step.dst, step.op === 'movzx' ? value : BigInt.asIntN(sourceSize, value))
        break
      }
      case 'lea': {
        const base = step.base === null ? 0n : registers[step.base]
        const index = step.index === null ? 0n : registers[step.index]
        writeRegister(step.dst, base + index * BigInt(step.scale) + step.disp)
        break
      }
      case 'imul': {
        const a = BigInt.asIntN(step.size, readRegister(step.dst))
        const b = BigInt.asIntN(step.size, read(step.src, step.size))
        const product = a * b
        const result = BigInt.asUintN(step.size, product)
        const overflow = BigInt.asIntN(step.size, result) !== product
        writeRegister(step.dst, result)
        flags.CF = overflow ? 1 : 0
        flags.OF = overflow ? 1 : 0
        // Officially undefined (and Rosetta does not set them from the result).
        flags.SF = 'undefined'
        flags.ZF = 'undefined'
        break
      }
      case 'push':
        stack.push(
          step.src.kind === 'reg' ? readRegister(step.src.reg) : BigInt.asUintN(64, step.src.value),
        )
        break
      case 'pop': {
        const value = stack.pop()
        if (value === undefined) return fail('pop with nothing on the stack')
        writeRegister(step.dst, value)
        break
      }
      case 'nop':
        break
      case 'jump': {
        let taken = true
        if (step.condition !== null) {
          const rule = CONDITION_RULES[step.condition]
          const seen: Record<FlagName, 0 | 1> = { CF: 0, ZF: 0, SF: 0, OF: 0 }
          for (const name of rule.reads) {
            const value = flags[name]
            if (value === 'undefined') {
              return fail(`${step.condition} reads ${name}, which imul left undefined`)
            }
            seen[name] = value
          }
          taken = rule.holds(seen)
        }
        jumps.push({ condition: step.condition, taken, probe: step.probe })
        if (taken) {
          const target = labelIndex.get(step.label)
          if (target === undefined) return fail(`jump to unknown label ${step.label}`)
          if (target < position) return fail(`jump to ${step.label} goes backwards`)
          position = target
        }
        break
      }
    }
  }

  if (stack.length !== 0) fail(`${stack.length} value(s) left on the stack at the end`)
  const finalFlags: Record<FlagName, 0 | 1> = { CF: 0, ZF: 0, SF: 0, OF: 0 }
  for (const name of FLAG_NAMES) {
    const value = flags[name]
    if (value === 'undefined') return fail(`${name} is undefined at the end of the program`)
    finalFlags[name] = value
  }
  return { registers, flags: finalFlags, scratch, jumps, executed }
}
