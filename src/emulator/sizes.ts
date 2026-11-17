/*
 * INSTRUCTION SIZES
 * =================
 *
 * Every instruction gets its real x86-64 encoding length in bytes, the same length
 * GNU `as` and clang give it. That is why the addresses in the emulator look like the
 * ones `gdb` shows, and why rip moves by 1, 3, 5 or 7 and not always by the same step.
 *
 * The table is checked against a real assembler: `scripts/make-size-fixture.mjs`
 * assembles a few hundred lines with clang and `sizes.test.ts` replays the result.
 *
 * An instruction is made of these parts, in this order. Its size is their sum.
 *
 *     [66] [REX] opcode [ModRM] [SIB] [displacement] [immediate]
 *
 * PART          BYTES  WHEN
 * ------------  -----  ------------------------------------------------------------
 * prefix 66     1      the operand size is 16 bits
 * REX           1      the operand size is 64 bits (but not for push, pop, call,
 *                      ret, jmp, jcc, leave, nop), or a register operand is
 *                      r8–r15 in any width, or sil, dil, spl, bpl, or the base or
 *                      index register of a memory operand is r8–r15
 * opcode        1      2 for movzx, movsx (but movsx r64, r/m32 has 1),
 *                      imul r, r/m and the far form of a conditional jump
 * ModRM         1      the form has a register/memory pair or a memory operand
 * SIB           1      the memory operand has an index register, or its base is
 *                      rsp or r12, or it has no base register (not rip-relative)
 * displacement  0      the number is 0 and the base is not rbp or r13
 *               1      the number fits a signed byte (-128 … 127)
 *               4      every other case; always 4 for `label[rip]`, for any
 *                      address that uses a label, when there is no base register,
 *                      and when the number uses a `.equ` constant gcc does not know
 *                      yet on that line (its `.equ` line comes later)
 * immediate     0–8    see the forms below
 *
 * FORM                                    PARTS (after the prefixes)             BYTES
 * --------------------------------------  -------------------------------------  -----
 * mov r, r   mov r, m   mov m, r          opcode ModRM                           2
 * mov r8, imm                             opcode imm8                            2
 * mov r16, imm                            opcode imm16                           3
 * mov r32, imm                            opcode imm32                           5
 * mov r64, imm  (fits signed 32 bits)     opcode ModRM imm32                     6
 * mov r64, imm  (bigger)                  opcode imm64                           9
 * mov m, imm                              opcode ModRM imm8/16/32/32             3/4/6/6
 * add sub cmp and or xor                  (the six share one shape)
 *   r/m, r   r, m                         opcode ModRM                           2
 *   r/m8, imm                             opcode ModRM imm8                      3
 *   r/m, imm  (fits a signed byte)        opcode ModRM imm8                      3
 *   r/m, imm  (bigger)                    opcode ModRM imm16/32/32               4/6/6
 *   al, imm                               opcode imm8             (no ModRM)     2
 *   ax/eax/rax, imm  (not a signed byte)  opcode imm16/32/32      (no ModRM)     3/5/5
 * test r/m, r   test r, m                 opcode ModRM                           2
 * test r/m, imm                           opcode ModRM imm8/16/32/32             3/4/6/6
 * test al/ax/eax/rax, imm                 opcode imm8/16/32/32    (no ModRM)     2/3/5/5
 * inc r/m   dec r/m                       opcode ModRM                           2
 * imul r, r/m                             opcode opcode ModRM                    3
 * imul r, imm  (fits a signed byte)       opcode ModRM imm8                      3
 * imul r, imm  (bigger)                   opcode ModRM imm16/32/32               4/6/6
 * movzx r, r/m   movsx r, r/m             opcode opcode ModRM                    3
 * movsx r64, r/m32                        opcode ModRM                           2
 * lea r, m                                opcode ModRM                           2
 * push r64   pop r64                      opcode                                 1
 * push imm  (fits a signed byte)          opcode imm8                            2
 * push imm  (bigger)                      opcode imm32                           5
 * call label                              opcode rel32                           5
 * jmp label  (near)                       opcode rel8                            2
 * jmp label  (far)                        opcode rel32                           5
 * jcc label  (near)                       opcode rel8                            2
 * jcc label  (far)                        opcode opcode rel32                    6
 * ret   nop   leave                       opcode                                 1
 * endbr64                                 (four fixed bytes)                     4
 *
 * Notes
 *
 * - "Fits a signed byte" is asked about the number as the CPU sees it, cut to the
 *   operand size: `add eax, 0xffffffff` is `add eax, -1` and takes 3 bytes, and
 *   `and rsp, 0xfffffffffffffff0` is `and rsp, -16` and takes 4.
 * - A jump is near when its target is -128 … 127 bytes from the END of the jump.
 *   The assembler starts with every jump near and makes the ones that do not reach
 *   far, again and again, until nothing changes.
 * - A number that is the address of a label (`offset message`) is filled in later by
 *   the linker, so it always takes 4 bytes, even when the address is small.
 * - gcc reads a file from top to bottom. In `mov rax, count[rbp]` with `.equ count, -8`
 *   on a LATER line, it does not know the number yet, so it leaves 4 bytes for it
 *   (7 bytes in all, not 4). Measured with clang.
 * - Where clang and GNU `as` differ, this table follows clang (the fixture is made
 *   with clang). One known difference: for `add/sub/cmp/and/or/xor ax|eax|rax, offset
 *   label` clang keeps the ModRM byte, GNU `as` uses the shorter form without it.
 *
 * Examples
 *
 *   push rbx                  1     mov rbp, rsp                 3
 *   mov eax, 0                5     mov rax, 5                   7
 *   mov rax, 0x1122334455667788 10  mov r8d, 7                   6
 *   sub rsp, 16               4     add eax, 1000                5
 *   lea rdi, message[rip]     7     lea rdi, 8[rsp]              5
 *   mov eax, [rbp-4]          3     mov rax, [rsp]               4
 *   mov dword ptr [rbp-4], 5  7     mov qword ptr [rbp-8], 5     8
 *   mov rax, [rdi+rcx*8]      4     imul rax, rbx                4
 *   movzx eax, al             3     call printf@PLT              5
 *   ret                       1     endbr64                      4
 */
import type { ImmOperand, MemOperand, Mnemonic, Operand, OperandSize } from './types'

export interface SizeOptions {
  /** For `jmp` and the conditional jumps: the target is too far for the 2-byte form. */
  longJump?: boolean
  /**
   * Tells whether a name is a label. A number that is a label address always takes
   * 4 bytes. Without it, every named number is treated as an `.equ` constant.
   */
  isLabel?: (name: string) => boolean
  /**
   * The displacement of the memory operand uses a `.equ` constant that gcc does not
   * know yet on this line, so it takes 4 bytes whatever its value.
   */
  lateDisplacement?: boolean
}

/** Size of a `jmp` or a conditional jump in its near form. */
export const NEAR_JUMP_SIZE = 2

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

/** -128 … 127 */
export function fitsSignedByte(value: bigint): boolean {
  return value >= -128n && value <= 127n
}

function fitsSigned32(value: bigint): boolean {
  return value >= -(2n ** 31n) && value < 2n ** 31n
}

/** Bytes of an immediate that is written in full: 1, 2, 4, and 4 again for 64 bits. */
function immediateBytes(size: OperandSize): number {
  if (size === 8) return 1
  return size === 16 ? 2 : 4
}

/**
 * SIB byte plus displacement bytes of a memory operand (the ModRM byte is not counted).
 * `late`: the displacement uses a constant gcc does not know yet, so it is 4 bytes.
 */
export function memoryBytes(memory: MemOperand, late = false): number {
  if (memory.base === 'rip') return 4
  if (memory.base === null) return 1 + 4
  const sib = memory.index !== null || memory.base === 'rsp' || memory.base === 'r12' ? 1 : 0
  if (memory.symbol !== null || late) return sib + 4
  if (memory.disp === 0n && memory.base !== 'rbp' && memory.base !== 'r13') return sib
  return sib + (fitsSignedByte(memory.disp) ? 1 : 4)
}

/** ModRM byte, plus SIB and displacement when one of the operands is memory. */
function modrmBytes(operands: readonly Operand[], late: boolean): number {
  for (const operand of operands) {
    if (operand.kind === 'mem') return 1 + memoryBytes(operand, late)
  }
  return 1
}

/** The `66` prefix and the REX prefix. `wide` is false for forms that never use REX.W. */
function prefixBytes(operands: readonly Operand[], size: OperandSize, wide: boolean): number {
  let rex = wide && size === 64
  for (const operand of operands) {
    if (operand.kind === 'reg') {
      if (operand.reg.needsRex) rex = true
    } else if (operand.kind === 'mem') {
      if (operand.base !== null && EXTENDED.has(operand.base)) rex = true
      if (operand.index !== null && EXTENDED.has(operand.index)) rex = true
    }
  }
  return (size === 16 ? 1 : 0) + (rex ? 1 : 0)
}

/** al, ax, eax or rax: the register with shorter forms for some instructions. */
function isAccumulator(operand: Operand): boolean {
  return operand.kind === 'reg' && operand.reg.base === 'rax' && !operand.reg.highByte
}

/**
 * The encoded length of one instruction in bytes.
 *
 * The instruction must already be valid (see validate.ts). For a shape that is not
 * valid the result is a harmless guess: this function never throws.
 *
 * @param written the mnemonic as typed (only `endbr64` matters: it is a 4-byte `nop`)
 * @param opSize  the width the instruction works on (`Instruction.opSize`)
 */
export function instructionSize(
  mnemonic: Mnemonic,
  written: string,
  operands: readonly Operand[],
  opSize: OperandSize | null,
  options: SizeOptions = {},
): number {
  const first: Operand | undefined = operands[0]
  const second: Operand | undefined = operands[1]
  const size: OperandSize = opSize ?? 64
  const long = options.longJump === true
  /** ModRM byte, plus SIB and displacement when there is a memory operand. */
  const modrm = (): number => modrmBytes(operands, options.lateDisplacement === true)

  /** A number that is a label address: 4 bytes, whatever its value. */
  const isAddress = (operand: ImmOperand): boolean =>
    operand.symbol !== null && options.isLabel?.(operand.symbol) === true
  /** Can this number use the 1-byte immediate form? */
  const isShort = (operand: ImmOperand): boolean =>
    !isAddress(operand) && fitsSignedByte(BigInt.asIntN(size, operand.value))

  switch (mnemonic) {
    case 'ret':
    case 'leave':
      return 1
    case 'nop':
      return written === 'endbr64' ? 4 : 1
    case 'call':
      return 5
    case 'jmp':
      return long ? 5 : NEAR_JUMP_SIZE

    case 'push':
      if (first?.kind === 'imm') return isShort(first) ? 2 : 5
      return 1 + prefixBytes(operands, 64, false)
    case 'pop':
      return 1 + prefixBytes(operands, 64, false)

    case 'mov': {
      const prefix = prefixBytes(operands, size, true)
      if (second?.kind !== 'imm') return prefix + 1 + modrm()
      if (first?.kind !== 'reg') return prefix + 1 + modrm() + immediateBytes(size)
      if (size === 8) return prefix + 2
      if (size === 16) return prefix + 3
      if (size === 32) return prefix + 5
      const fits32 = isAddress(second) || fitsSigned32(BigInt.asIntN(64, second.value))
      return fits32 ? prefix + 6 : prefix + 9
    }

    case 'add':
    case 'sub':
    case 'cmp':
    case 'and':
    case 'or':
    case 'xor': {
      const prefix = prefixBytes(operands, size, true)
      if (second?.kind !== 'imm') return prefix + 1 + modrm()
      if (size === 8) {
        return first !== undefined && isAccumulator(first) ? prefix + 2 : prefix + 1 + modrm() + 1
      }
      if (isShort(second)) return prefix + 1 + modrm() + 1
      // clang keeps the ModRM form when the number is a label address (GNU as does not).
      if (first !== undefined && isAccumulator(first) && !isAddress(second)) {
        return prefix + 1 + immediateBytes(size)
      }
      return prefix + 1 + modrm() + immediateBytes(size)
    }

    case 'test': {
      const prefix = prefixBytes(operands, size, true)
      if (second?.kind !== 'imm') return prefix + 1 + modrm()
      if (first !== undefined && isAccumulator(first)) return prefix + 1 + immediateBytes(size)
      return prefix + 1 + modrm() + immediateBytes(size)
    }

    case 'inc':
    case 'dec':
      return prefixBytes(operands, size, true) + 1 + modrm()

    case 'imul': {
      const prefix = prefixBytes(operands, size, true)
      if (second?.kind !== 'imm') return prefix + 2 + modrm()
      return prefix + 1 + 1 + (isShort(second) ? 1 : immediateBytes(size))
    }

    case 'movzx':
      return prefixBytes(operands, size, true) + 2 + modrm()
    case 'movsx': {
      const prefix = prefixBytes(operands, size, true)
      const sourceSize =
        second?.kind === 'reg' ? second.reg.size : second?.kind === 'mem' ? second.size : null
      // `movsx r64, r/m32` is the one-byte opcode 63 (clang spells it `movsxd`).
      const opcode = size === 64 && sourceSize === 32 ? 1 : 2
      return prefix + opcode + modrm()
    }

    case 'lea':
      return prefixBytes(operands, size, true) + 1 + modrm()

    default:
      // A conditional jump.
      return long ? 6 : NEAR_JUMP_SIZE
  }
}
