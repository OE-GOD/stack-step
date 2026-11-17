/**
 * What every instruction does (behaviour contract, sections 2 to 4).
 *
 * Almost every test here is a real little program run through `createEmulator`, the way
 * a student would run it. The expected numbers were worked out by hand from the rules of
 * the contract. (`cpu-fuzz.test.ts` and `alu.truth.test.ts` compare the same machinery
 * with a real CPU.)
 */
import { describe, expect, it } from 'vitest'
import { assemble } from './assembler'
import { executeInstruction, type MachineView } from './executor'
import { createEmulator, type Emulator } from './index'
import { Memory, type Region } from './memory'
import { createRegisterFile } from './registers'
import {
  DEFAULT_OPTIONS,
  FLAG_NAMES,
  type EmulatorOptions,
  type Flags,
  type MachineState,
  type Reg64,
  type RuntimeCode,
  type StepResult,
} from './types'

/* ───────────────────────────── helpers ───────────────────────────── */

/** Where rsp starts with the default options. */
const RSP0 = 0x7ffffffddff8n
/** The address of the first instruction with the default options. */
const TEXT = 0x401126n
/** A value with a different digit in every 16-bit group, to see which bits a write changes. */
const PATTERN = 0x1111222233334444n

/**
 * A program: three header lines, then the given lines. So the first given line is
 * LINE 4 of the program, and `main` starts at the first instruction.
 */
function source(...lines: string[]): string {
  return ['.intel_syntax noprefix', '.text', 'main:', ...lines, ''].join('\n')
}

function emulatorFor(text: string, options?: EmulatorOptions): Emulator {
  const made = createEmulator(text, options)
  if (!made.ok) throw new Error(made.diagnostics.map((item) => item.message).join('\n'))
  return made.emulator
}

/** An emulator for `source(...lines)`. */
function emulatorOf(lines: string[], options?: EmulatorOptions): Emulator {
  return emulatorFor(source(...lines), options)
}

/** Every register starts with `PATTERN` (rsp keeps its normal value). */
function patternRegisters(): Partial<Record<Reg64, bigint>> {
  const registers: Partial<Record<Reg64, bigint>> = {}
  for (const name of Object.keys(createRegisterFile()) as Reg64[]) {
    if (name !== 'rsp') registers[name] = PATTERN
  }
  return registers
}

/** Run `count` steps and give back the results. */
function steps(emulator: Emulator, count: number): StepResult[] {
  const results: StepResult[] = []
  for (let i = 0; i < count; i++) results.push(emulator.step())
  return results
}

/** Run to the end; the program must end normally. */
function finish(emulator: Emulator): MachineState {
  const run = emulator.run()
  const state = emulator.getSnapshot()
  expect(run.reason, state.error?.message).toBe('halted')
  return state
}

/** The registers after running `lines` and a final `ret` to the end. */
function registersAfter(lines: string[], options?: EmulatorOptions): MachineState['registers'] {
  return finish(emulatorOf([...lines, 'ret'], options)).registers
}

function flagsOf(emulator: Emulator): Flags {
  return { ...emulator.getSnapshot().flags }
}

/** The flags after running `lines` (the last step is not a `ret`, flags are read before it). */
function flagsAfter(lines: string[], options?: EmulatorOptions): Flags {
  const emulator = emulatorOf([...lines, 'ret'], options)
  steps(emulator, lines.length)
  return flagsOf(emulator)
}

function bytesAt(emulator: Emulator, address: bigint, length: number): (number | null)[] {
  return emulator.readMemory(address, length)
}

/* ───────────────────────── sub-register writes ───────────────────────── */

describe('writing a part of a register', () => {
  it.each<[string, Reg64, bigint]>([
    ['mov al, 7', 'rax', 0x1111222233334407n],
    ['mov ah, 5', 'rax', 0x1111222233330544n],
    ['mov ax, 7', 'rax', 0x1111222233330007n],
    ['mov eax, 7', 'rax', 0x0000000000000007n],
    ['mov rax, 7', 'rax', 0x0000000000000007n],
    ['mov bl, 0xff', 'rbx', 0x11112222333344ffn],
    ['mov bh, 0xff', 'rbx', 0x111122223333ff44n],
    ['mov cx, 0xabcd', 'rcx', 0x111122223333abcdn],
    ['mov edx, 0xffffffff', 'rdx', 0x00000000ffffffffn],
    ['mov r8b, 7', 'r8', 0x1111222233334407n],
    ['mov r8w, 7', 'r8', 0x1111222233330007n],
    ['mov r8d, 7', 'r8', 0x0000000000000007n],
    ['mov r8, 7', 'r8', 0x0000000000000007n],
    ['mov sil, 7', 'rsi', 0x1111222233334407n],
    ['mov dil, 7', 'rdi', 0x1111222233334407n],
    ['mov si, 7', 'rsi', 0x1111222233330007n],
    ['mov di, 7', 'rdi', 0x1111222233330007n],
    ['mov esi, 7', 'rsi', 0x0000000000000007n],
    ['mov edi, 7', 'rdi', 0x0000000000000007n],
    ['mov bpl, 9', 'rbp', 0x1111222233334409n],
    ['mov ebp, 9', 'rbp', 0x0000000000000009n],
    ['mov r15b, 1', 'r15', 0x1111222233334401n],
    ['mov r15w, 1', 'r15', 0x1111222233330001n],
    ['mov r15d, 1', 'r15', 0x0000000000000001n],
    ['mov r12d, -1', 'r12', 0x00000000ffffffffn],
    ['mov r12w, -1', 'r12', 0x111122223333ffffn],
  ])('%s on 0x1111222233334444 gives the right 64 bits', (line, register, expected) => {
    const registers = registersAfter([line], { initialRegisters: patternRegisters() })
    expect(registers[register]).toBe(expected)
  })

  it('a write to one register leaves the other fifteen alone', () => {
    const registers = registersAfter(['mov eax, 7'], { initialRegisters: patternRegisters() })
    for (const name of Object.keys(createRegisterFile()) as Reg64[]) {
      if (name !== 'rax' && name !== 'rsp') expect(registers[name], name).toBe(PATTERN)
    }
  })

  it('reads the parts back: al, ah, ax, eax of one value', () => {
    const emulator = emulatorOf(['ret'], { initialRegisters: { rax: 0x1122334455667788n } })
    expect(emulator.readRegister('al')).toBe(0x88n)
    expect(emulator.readRegister('ah')).toBe(0x77n)
    expect(emulator.readRegister('ax')).toBe(0x7788n)
    expect(emulator.readRegister('eax')).toBe(0x55667788n)
    expect(emulator.readRegister('rax')).toBe(0x1122334455667788n)
  })

  it('the step diff shows the whole 64-bit register before and after', () => {
    const emulator = emulatorOf(['mov al, 7', 'ret'], { initialRegisters: { rax: PATTERN } })
    const [step] = steps(emulator, 1)
    expect(step.diff.registers).toEqual([
      { reg: 'rax', before: PATTERN, after: 0x1111222233334407n },
    ])
    expect(step.diff.written.registers).toEqual(['rax'])
  })

  it('a write that does not change the value is "written" but not "changed"', () => {
    const emulator = emulatorOf(['mov rax, 5', 'ret'], { initialRegisters: { rax: 5n } })
    const [step] = steps(emulator, 1)
    expect(step.diff.registers).toEqual([])
    expect(step.diff.written.registers).toEqual(['rax'])
  })
})

/* ─────────────────────────────── mov ─────────────────────────────── */

describe('mov', () => {
  it('copies a register into a register and changes no flag', () => {
    const emulator = emulatorOf(['mov rbx, rax', 'ret'], {
      initialRegisters: { rax: 0xdeadbeefn },
      initialFlags: { CF: 1, ZF: 1, SF: 1, OF: 1 },
    })
    const [step] = steps(emulator, 1)
    expect(emulator.readRegister('rbx')).toBe(0xdeadbeefn)
    expect(emulator.readRegister('rax')).toBe(0xdeadbeefn)
    expect(flagsOf(emulator)).toEqual({ CF: 1, ZF: 1, SF: 1, OF: 1 })
    expect(step.diff.flags).toEqual([])
    expect(step.diff.written.flags).toEqual([])
  })

  it.each<[string, bigint]>([
    ['mov rax, 0x1122334455667788', 0x1122334455667788n],
    ['mov rax, -1', 0xffffffffffffffffn],
    ['mov rax, -8', 0xfffffffffffffff8n],
    ['mov rax, 0xffffffffffffffff', 0xffffffffffffffffn],
    ['mov eax, -1', 0x00000000ffffffffn],
    ['mov eax, 0x80000000', 0x0000000080000000n],
    ['mov ax, -1', 0x000000000000ffffn],
    ['mov al, -1', 0x00000000000000ffn],
    ['mov al, 255', 0x00000000000000ffn],
    ["mov al, 'A'", 0x0000000000000041n],
    ['mov eax, 0b101', 0x0000000000000005n],
  ])('%s truncates the number to the operand width', (line, expected) => {
    expect(registersAfter([line]).rax).toBe(expected)
  })

  it('stores the bytes of a number in little-endian order', () => {
    const emulator = emulatorOf(['sub rsp, 16', 'mov dword ptr [rsp], 0x11223344', 'ret'])
    steps(emulator, 2)
    const rsp = emulator.readRegister('rsp')
    expect(rsp).toBe(RSP0 - 16n)
    // The lowest byte goes to the lowest address. The other four bytes were never written.
    expect(bytesAt(emulator, rsp, 8)).toEqual([0x44, 0x33, 0x22, 0x11, null, null, null, null])
  })

  it.each<[string, (number | null)[]]>([
    ['mov byte ptr [rsp], 0x11', [0x11, null, null, null, null, null, null, null]],
    ['mov word ptr [rsp], 0x1122', [0x22, 0x11, null, null, null, null, null, null]],
    ['mov dword ptr [rsp], 0x11223344', [0x44, 0x33, 0x22, 0x11, null, null, null, null]],
    ['mov qword ptr [rsp], 0x11223344', [0x44, 0x33, 0x22, 0x11, 0, 0, 0, 0]],
    ['mov qword ptr [rsp], -2', [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]],
    ['mov dword ptr [rsp], -2', [0xfe, 0xff, 0xff, 0xff, null, null, null, null]],
  ])('%s writes exactly its own width', (line, expected) => {
    const emulator = emulatorOf(['sub rsp, 8', line, 'ret'])
    steps(emulator, 2)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual(expected)
  })

  it('a register stored to memory uses the width of the register', () => {
    const emulator = emulatorOf(['sub rsp, 8', 'mov [rsp], ax', 'ret'], {
      initialRegisters: { rax: 0x1122334455667788n },
    })
    const [, step] = steps(emulator, 2)
    expect(bytesAt(emulator, RSP0 - 8n, 4)).toEqual([0x88, 0x77, null, null])
    expect(step.diff.memory).toEqual([
      { address: RSP0 - 8n, before: [null, null], after: [0x88, 0x77] },
    ])
    expect(step.diff.written.memory).toEqual([{ address: RSP0 - 8n, bytes: 2 }])
  })

  it.each<[string, bigint]>([
    ['mov rax, [rsp]', 0x8877665544332211n],
    ['mov eax, [rsp]', 0x0000000044332211n],
    ['mov ax, [rsp]', 0xaaaaaaaaaaaa2211n],
    ['mov al, [rsp]', 0xaaaaaaaaaaaaaa11n],
    ['mov ah, [rsp]', 0xaaaaaaaaaaaa11aan],
    ['mov eax, dword ptr 4[rsp]', 0x0000000088776655n],
    ['mov al, byte ptr [rsp+7]', 0xaaaaaaaaaaaaaa88n],
  ])('%s reads the width of the register', (line, expected) => {
    // The top box holds 0x8877665544332211, lowest byte first.
    const registers = registersAfter(['push rbx', line, 'pop rbx'], {
      initialRegisters: { rax: 0xaaaaaaaaaaaaaaaan, rbx: 0x8877665544332211n },
    })
    expect(registers.rax).toBe(expected)
  })

  it('reads and writes through `.equ` offsets from rbp', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.equ count, -8',
        '.equ total, -16',
        'main:',
        'push rbp',
        'mov rbp, rsp',
        'sub rsp, 16',
        'mov qword ptr count[rbp], 5',
        'mov qword ptr total[rbp], 100',
        'mov rax, count[rbp]',
        'add total[rbp], rax',
        'mov rdx, total[rbp]',
        'leave',
        'ret',
        '',
      ].join('\n'),
    )
    const state = finish(emulator)
    expect(state.registers.rax).toBe(5n)
    expect(state.registers.rdx).toBe(105n)
    // rbp was rsp after one push: count is the box right below it.
    expect(bytesAt(emulator, RSP0 - 16n, 8)).toEqual([5, 0, 0, 0, 0, 0, 0, 0])
    expect(bytesAt(emulator, RSP0 - 24n, 8)).toEqual([105, 0, 0, 0, 0, 0, 0, 0])
  })

  it('reads a data label with and without brackets', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'counter: .long 7',
        'numbers: .quad 10, 20, 30',
        '.text',
        'main:',
        'mov eax, counter',
        'mov rbx, numbers[rip]',
        'mov rcx, numbers+8[rip]',
        'mov edx, 2',
        'mov rsi, numbers[rdx*8]',
        'lea rdi, numbers[rip]',
        'mov r8, [rdi+rdx*8-8]',
        'mov r9, offset numbers',
        'ret',
        '',
      ].join('\n'),
    )
    const { registers } = finish(emulator)
    expect(registers.rax).toBe(7n)
    expect(registers.rbx).toBe(10n)
    expect(registers.rcx).toBe(20n)
    expect(registers.rsi).toBe(30n)
    expect(registers.rdi).toBe(0x404034n)
    expect(registers.r8).toBe(20n)
    expect(registers.r9).toBe(0x404034n)
  })

  it('writes a data label and the data stays changed', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'counter: .long 7',
        '.text',
        'main:',
        'mov dword ptr counter[rip], 0x01020304',
        'mov eax, counter[rip]',
        'ret',
        '',
      ].join('\n'),
    )
    const [write] = steps(emulator, 1)
    expect(write.diff.memory).toEqual([
      { address: 0x404030n, before: [7, 0, 0, 0], after: [4, 3, 2, 1] },
    ])
    expect(finish(emulator).registers.rax).toBe(0x01020304n)
  })

  it('wraps an effective address to 64 bits', () => {
    // rbx + rcx = 2^64 + (rsp - 8): the carry out of bit 63 is dropped.
    const emulator = emulatorOf(['mov rax, [rbx+rcx]', 'ret'], {
      initialRegisters: { rbx: 0xffffffffffffffffn, rcx: RSP0 + 1n },
    })
    const [step] = steps(emulator, 1)
    expect(step.status).toBe('running')
    expect(emulator.readRegister('rax')).toBe(DEFAULT_OPTIONS.osReturnAddress)
  })

  it('a negative displacement wraps below zero the same way', () => {
    const emulator = emulatorOf(['lea rax, [rbx-16]', 'ret'], { initialRegisters: { rbx: 8n } })
    steps(emulator, 1)
    expect(emulator.readRegister('rax')).toBe(0xfffffffffffffff8n)
  })
})

/* ──────────────────────────── movzx, movsx ──────────────────────────── */

describe('movzx and movsx', () => {
  const start = { initialRegisters: { rax: PATTERN, rbx: 0xaaaaaaaaaaaa8080n } }

  it.each<[string, bigint]>([
    // bl = 0x80, bx = 0x8080
    ['movzx eax, bl', 0x0000000000000080n],
    ['movzx rax, bl', 0x0000000000000080n],
    ['movzx ax, bl', 0x1111222233330080n],
    ['movzx eax, bx', 0x0000000000008080n],
    ['movzx rax, bx', 0x0000000000008080n],
    ['movzx eax, bh', 0x0000000000000080n],
    ['movsx eax, bl', 0x00000000ffffff80n],
    ['movsx rax, bl', 0xffffffffffffff80n],
    ['movsx ax, bl', 0x111122223333ff80n],
    ['movsx eax, bx', 0x00000000ffff8080n],
    ['movsx rax, bx', 0xffffffffffff8080n],
    ['movsx rax, ebx', 0xffffffffaaaa8080n],
    ['movsxd rax, ebx', 0xffffffffaaaa8080n],
    ['movsx eax, bh', 0x00000000ffffff80n],
  ])('%s', (line, expected) => {
    expect(registersAfter([line], start).rax).toBe(expected)
  })

  it.each<[string, bigint]>([
    ['movsx eax, bl', 0x000000000000007fn],
    ['movsx rax, bl', 0x000000000000007fn],
    ['movsx rax, bx', 0x0000000000007f7fn],
    ['movsx rax, ebx', 0x000000007f7f7f7fn],
    ['movzx rax, bx', 0x0000000000007f7fn],
  ])('%s keeps a positive value as it is', (line, expected) => {
    const options = { initialRegisters: { rax: PATTERN, rbx: 0x7f7f7f7f7f7f7f7fn } }
    expect(registersAfter([line], options).rax).toBe(expected)
  })

  it.each<[string, bigint]>([
    ['movzx eax, byte ptr [rsp]', 0x00000000000000f0n],
    ['movzx eax, word ptr [rsp]', 0x000000000000e1f0n],
    ['movzx rax, word ptr [rsp]', 0x000000000000e1f0n],
    ['movsx eax, byte ptr [rsp]', 0x00000000fffffff0n],
    ['movsx rax, byte ptr [rsp]', 0xfffffffffffffff0n],
    ['movsx eax, word ptr [rsp]', 0x00000000ffffe1f0n],
    ['movsx rax, word ptr [rsp]', 0xffffffffffffe1f0n],
    ['movsx rax, dword ptr [rsp]', 0xffffffffc3d2e1f0n],
    ['movsx ax, byte ptr [rsp]', 0x111122223333fff0n],
  ])('%s reads only the narrow source from memory', (line, expected) => {
    const emulator = emulatorOf(['push rbx', line, 'pop rbx', 'ret'], {
      initialRegisters: { rax: PATTERN, rbx: 0x00000000c3d2e1f0n },
    })
    expect(finish(emulator).registers.rax).toBe(expected)
  })

  it('does not change the flags or the source', () => {
    const emulator = emulatorOf(['movsx rax, bl', 'ret'], {
      initialRegisters: { rbx: 0x80n },
      initialFlags: { CF: 1, OF: 1 },
    })
    const [step] = steps(emulator, 1)
    expect(step.diff.flags).toEqual([])
    expect(emulator.readRegister('rbx')).toBe(0x80n)
    expect(flagsOf(emulator)).toEqual({ CF: 1, ZF: 0, SF: 0, OF: 1 })
  })
})

/* ─────────────────────────────── lea ─────────────────────────────── */

describe('lea', () => {
  it('`lea rdi, 8[rsp]` gives an address, `mov rdi, 8[rsp]` reads memory', () => {
    const options = {
      initialMemory: [{ address: RSP0 + 8n, bytes: 8 as const, value: 0x1234n }],
    }
    const address = emulatorOf(['lea rdi, 8[rsp]', 'ret'], options)
    address.step()
    expect(address.readRegister('rdi')).toBe(RSP0 + 8n)

    const contents = emulatorOf(['mov rdi, 8[rsp]', 'ret'], options)
    contents.step()
    expect(contents.readRegister('rdi')).toBe(0x1234n)
  })

  it.each<[string, bigint]>([
    ['lea rax, [rbx]', 0x1000n],
    ['lea rax, [rbx+8]', 0x1008n],
    ['lea rax, [rbx-8]', 0x0ff8n],
    ['lea rax, [rbx+rcx]', 0x1003n],
    ['lea rax, [rbx+rcx*2]', 0x1006n],
    ['lea rax, [rbx+rcx*4+10]', 0x1016n],
    ['lea rax, [rbx+rcx*8-1]', 0x1017n],
    ['lea rax, [rcx*8]', 0x18n],
    ['lea rax, -16[rbx]', 0x0ff0n],
    ['lea eax, [rbx+rcx]', 0x1003n],
    ['lea ax, [rbx+rcx]', 0x1111222233331003n],
  ])('%s works out base + index*scale + displacement', (line, expected) => {
    const options = { initialRegisters: { rax: PATTERN, rbx: 0x1000n, rcx: 3n } }
    expect(registersAfter([line], options).rax).toBe(expected)
  })

  it('a 32-bit destination keeps the low 32 bits of the address', () => {
    const options = { initialRegisters: { rbx: 0x1122334455667788n } }
    expect(registersAfter(['lea eax, [rbx+1]'], options).rax).toBe(0x55667789n)
  })

  it('gives the address of a label with `label[rip]`', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'message: .string "hi"',
        'main:',
        'lea rdi, message[rip]',
        'ret',
        '',
      ].join('\n'),
    )
    emulator.step()
    expect(emulator.readRegister('rdi')).toBe(0x402010n)
    expect(emulator.program.symbols.get('message')?.address).toBe(0x402010n)
  })

  it('never reads memory, so an address nobody owns is fine', () => {
    const emulator = emulatorOf(['lea rax, [rbx+rcx*8]', 'ret'], {
      initialRegisters: { rbx: 0x10n, rcx: 0x7n },
    })
    const [step] = steps(emulator, 1)
    expect(step.status).toBe('running')
    expect(step.notes).toEqual([])
    expect(emulator.readRegister('rax')).toBe(0x48n)
    expect(step.diff.memory).toEqual([])
  })

  it('does not change the flags', () => {
    const flags = flagsAfter(['lea rax, [rbx+rbx]'], {
      initialRegisters: { rbx: 0xffffffffffffffffn },
      initialFlags: { ZF: 1 },
    })
    expect(flags).toEqual({ CF: 0, ZF: 1, SF: 0, OF: 0 })
  })
})

/* ───────────────────────────── push and pop ───────────────────────────── */

describe('push and pop', () => {
  it('push moves rsp down by exactly 8 and stores the value in the new top box', () => {
    const emulator = emulatorOf(['push rbx', 'ret'], {
      initialRegisters: { rbx: 0x1122334455667788n },
    })
    const [step] = steps(emulator, 1)
    expect(emulator.readRegister('rsp')).toBe(RSP0 - 8n)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual([
      0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
    ])
    expect(step.diff.registers).toEqual([{ reg: 'rsp', before: RSP0, after: RSP0 - 8n }])
    expect(step.diff.memory).toEqual([
      {
        address: RSP0 - 8n,
        before: [null, null, null, null, null, null, null, null],
        after: [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11],
      },
    ])
    expect(step.diff.flags).toEqual([])
  })

  it('pop reads the top box, then moves rsp up by exactly 8', () => {
    const emulator = emulatorOf(['push rbx', 'pop rcx', 'ret'], {
      initialRegisters: { rbx: 0x55n },
    })
    const [, pop] = steps(emulator, 2)
    expect(emulator.readRegister('rcx')).toBe(0x55n)
    expect(emulator.readRegister('rsp')).toBe(RSP0)
    expect(pop.diff.registers).toEqual([
      { reg: 'rsp', before: RSP0 - 8n, after: RSP0 },
      { reg: 'rcx', before: 0n, after: 0x55n },
    ])
    expect(pop.diff.memory).toEqual([])
    // The old box keeps its bytes.
    expect(bytesAt(emulator, RSP0 - 8n, 1)).toEqual([0x55])
  })

  it('popping in the same order as the pushes swaps two registers', () => {
    const registers = registersAfter(['push rax', 'push rcx', 'pop rax', 'pop rcx'], {
      initialRegisters: { rax: 1n, rcx: 2n },
    })
    expect(registers.rax).toBe(2n)
    expect(registers.rcx).toBe(1n)
    expect(registers.rsp).toBe(RSP0 + 8n)
  })

  it('popping in reverse order restores two registers', () => {
    const registers = registersAfter(
      ['push rax', 'push rcx', 'mov rax, 100', 'mov rcx, 200', 'pop rcx', 'pop rax'],
      { initialRegisters: { rax: 1n, rcx: 2n } },
    )
    expect(registers.rax).toBe(1n)
    expect(registers.rcx).toBe(2n)
  })

  it.each<[string, bigint]>([
    ['push 5', 5n],
    ['push -1', 0xffffffffffffffffn],
    ['push -8', 0xfffffffffffffff8n],
    ['push 0x7fffffff', 0x7fffffffn],
    ['push 0x12', 0x12n],
  ])('%s sign-extends the number to 64 bits', (line, expected) => {
    const registers = registersAfter([line, 'pop rax'])
    expect(registers.rax).toBe(expected)
  })

  it('`push rsp` stores the value rsp had before the push', () => {
    const emulator = emulatorOf(['push rsp', 'pop rax', 'ret'])
    steps(emulator, 2)
    expect(emulator.readRegister('rax')).toBe(RSP0)
    expect(emulator.readRegister('rsp')).toBe(RSP0)
  })

  it('`pop rsp` leaves the popped value in rsp', () => {
    const emulator = emulatorOf(['push rbx', 'pop rsp', 'ret'], {
      initialRegisters: { rbx: RSP0 - 64n },
    })
    const [, pop] = steps(emulator, 2)
    expect(emulator.readRegister('rsp')).toBe(RSP0 - 64n)
    expect(pop.diff.registers).toEqual([{ reg: 'rsp', before: RSP0 - 8n, after: RSP0 - 64n }])
  })

  it('works with r8 to r15 too', () => {
    const registers = registersAfter(['push r12', 'push r15', 'pop r8', 'pop r9'], {
      initialRegisters: { r12: 12n, r15: 15n },
    })
    expect(registers.r8).toBe(15n)
    expect(registers.r9).toBe(12n)
  })

  it('ten pushes move rsp down 80, ten pops bring it back', () => {
    const lines = [...Array<string>(10).fill('push rax'), ...Array<string>(10).fill('pop rbx')]
    const emulator = emulatorOf([...lines, 'ret'])
    steps(emulator, 10)
    expect(emulator.readRegister('rsp')).toBe(RSP0 - 80n)
    steps(emulator, 10)
    expect(emulator.readRegister('rsp')).toBe(RSP0)
  })
})

/* ─────────────────────────── arithmetic and logic ─────────────────────────── */

describe('add and sub', () => {
  it('0x7f + 1 in 8 bits sets OF and SF (signed overflow)', () => {
    const emulator = emulatorOf(['mov al, 0x7f', 'add al, 1', 'ret'])
    steps(emulator, 2)
    expect(emulator.readRegister('al')).toBe(0x80n)
    expect(flagsOf(emulator)).toEqual({ CF: 0, ZF: 0, SF: 1, OF: 1 })
  })

  it('0xff + 1 in 8 bits sets CF and ZF (the carry leaves the byte)', () => {
    const emulator = emulatorOf(['mov al, 0xff', 'add al, 1', 'ret'], {
      initialRegisters: { rax: PATTERN },
    })
    steps(emulator, 2)
    expect(emulator.readRegister('rax')).toBe(0x1111222233334400n)
    expect(flagsOf(emulator)).toEqual({ CF: 1, ZF: 1, SF: 0, OF: 0 })
  })

  it('5 - 5 sets ZF', () => {
    const emulator = emulatorOf(['mov eax, 5', 'sub eax, 5', 'ret'])
    steps(emulator, 2)
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(flagsOf(emulator)).toEqual({ CF: 0, ZF: 1, SF: 0, OF: 0 })
  })

  it.each<[string, Partial<Record<Reg64, bigint>>, bigint, Flags]>([
    ['add eax, ebx', { rax: 45n, rbx: 10n }, 55n, { CF: 0, ZF: 0, SF: 0, OF: 0 }],
    ['add rax, rbx', { rax: 0xffffffffffffffffn, rbx: 1n }, 0n, { CF: 1, ZF: 1, SF: 0, OF: 0 }],
    ['add eax, ebx', { rax: 0x7fffffffn, rbx: 1n }, 0x80000000n, { CF: 0, ZF: 0, SF: 1, OF: 1 }],
    [
      'add rax, rbx',
      { rax: 0x7fffffffffffffffn, rbx: 1n },
      0x8000000000000000n,
      { CF: 0, ZF: 0, SF: 1, OF: 1 },
    ],
    ['add ax, bx', { rax: 0x8000n, rbx: 0x8000n }, 0n, { CF: 1, ZF: 1, SF: 0, OF: 1 }],
    ['sub eax, ebx', { rax: 0n, rbx: 1n }, 0xffffffffn, { CF: 1, ZF: 0, SF: 1, OF: 0 }],
    ['sub rax, rbx', { rax: 10n, rbx: 3n }, 7n, { CF: 0, ZF: 0, SF: 0, OF: 0 }],
    ['sub eax, ebx', { rax: 0x80000000n, rbx: 1n }, 0x7fffffffn, { CF: 0, ZF: 0, SF: 0, OF: 1 }],
    ['sub al, bl', { rax: 0x10n, rbx: 0x20n }, 0xf0n, { CF: 1, ZF: 0, SF: 1, OF: 0 }],
    [
      'sub rax, rbx',
      { rax: 0n, rbx: 0x8000000000000000n },
      0x8000000000000000n,
      { CF: 1, ZF: 0, SF: 1, OF: 1 },
    ],
  ])('%s', (line, registers, expected, flags) => {
    const emulator = emulatorOf([line, 'ret'], { initialRegisters: registers })
    const [step] = steps(emulator, 1)
    expect(emulator.readRegister('rax')).toBe(expected)
    expect(flagsOf(emulator)).toEqual(flags)
    expect(step.diff.written.flags).toEqual(['CF', 'ZF', 'SF', 'OF'])
  })

  it('a 32-bit add clears the top half of the register', () => {
    const registers = registersAfter(['add eax, 1'], { initialRegisters: { rax: PATTERN } })
    expect(registers.rax).toBe(0x0000000033334445n)
  })

  it('a 16-bit and an 8-bit add keep the other bits', () => {
    const options = { initialRegisters: { rax: PATTERN, rbx: PATTERN } }
    const registers = registersAfter(['add ax, 1', 'add bh, 1'], options)
    expect(registers.rax).toBe(0x1111222233334445n)
    expect(registers.rbx).toBe(0x1111222233334544n)
  })

  it('a number is sign-extended for a 64-bit operand', () => {
    const registers = registersAfter(['add rax, -1', 'sub rbx, -16'], {
      initialRegisters: { rax: 10n, rbx: 16n },
    })
    expect(registers.rax).toBe(9n)
    expect(registers.rbx).toBe(32n)
  })

  it.each<[string, number[]]>([
    ['add qword ptr [rsp], 1', [0, 0, 0, 0, 1, 0, 0, 0]],
    ['add dword ptr [rsp], 1', [0, 0, 0, 0, 0, 0, 0, 0]],
    ['add word ptr [rsp], 1', [0, 0, 0xff, 0xff, 0, 0, 0, 0]],
    ['add byte ptr [rsp], 1', [0, 0xff, 0xff, 0xff, 0, 0, 0, 0]],
    ['sub byte ptr [rsp+4], 1', [0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0]],
    ['add [rsp], rbx', [0, 0, 0, 0, 1, 0, 0, 0]],
    ['add [rsp], ebx', [0, 0, 0, 0, 0, 0, 0, 0]],
    ['add [rsp], bl', [0, 0xff, 0xff, 0xff, 0, 0, 0, 0]],
  ])('%s changes memory at its own width', (line, expected) => {
    // The box holds 0x00000000ffffffff and rbx holds 1.
    const emulator = emulatorOf(['push rax', line, 'ret'], {
      initialRegisters: { rax: 0xffffffffn, rbx: 1n },
    })
    steps(emulator, 2)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual(expected)
  })

  it('adds memory to a register', () => {
    const registers = registersAfter(['push rbx', 'add rax, [rsp]', 'add ecx, [rsp]', 'pop rbx'], {
      initialRegisters: { rax: 1n, rbx: 0x100000002n, rcx: 1n },
    })
    expect(registers.rax).toBe(0x100000003n)
    expect(registers.rcx).toBe(3n)
  })
})

describe('inc and dec', () => {
  it('inc adds 1 and leaves CF alone', () => {
    // 0xff + 1 in 8 bits sets CF. Then inc must not clear it.
    const emulator = emulatorOf(['mov al, 0xff', 'add al, 1', 'inc ecx', 'ret'])
    const [, , inc] = steps(emulator, 3)
    expect(emulator.readRegister('rcx')).toBe(1n)
    expect(flagsOf(emulator)).toEqual({ CF: 1, ZF: 0, SF: 0, OF: 0 })
    expect(inc.diff.written.flags).toEqual(['ZF', 'SF', 'OF'])
  })

  it('dec subtracts 1 and leaves CF alone', () => {
    const emulator = emulatorOf(['dec ecx', 'ret'], {
      initialRegisters: { rcx: 1n },
      initialFlags: { CF: 1 },
    })
    const [dec] = steps(emulator, 1)
    expect(emulator.readRegister('rcx')).toBe(0n)
    expect(flagsOf(emulator)).toEqual({ CF: 1, ZF: 1, SF: 0, OF: 0 })
    expect(dec.diff.written.flags).toEqual(['ZF', 'SF', 'OF'])
  })

  it.each<[string, bigint, bigint, Flags]>([
    ['inc eax', 0x7fffffffn, 0x80000000n, { CF: 0, ZF: 0, SF: 1, OF: 1 }],
    ['inc eax', 0xffffffffn, 0n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
    ['inc rax', 0xffffffffn, 0x100000000n, { CF: 0, ZF: 0, SF: 0, OF: 0 }],
    ['inc al', 0x7fn, 0x80n, { CF: 0, ZF: 0, SF: 1, OF: 1 }],
    ['inc ax', 0xffffn, 0n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
    ['dec eax', 0n, 0xffffffffn, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
    ['dec rax', 0n, 0xffffffffffffffffn, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
    ['dec eax', 0x80000000n, 0x7fffffffn, { CF: 0, ZF: 0, SF: 0, OF: 1 }],
    ['dec al', 0x80n, 0x7fn, { CF: 0, ZF: 0, SF: 0, OF: 1 }],
    ['dec ax', 1n, 0n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
  ])('%s on %s', (line, before, after, flags) => {
    const emulator = emulatorOf([line, 'ret'], { initialRegisters: { rax: before } })
    steps(emulator, 1)
    expect(emulator.readRegister('rax')).toBe(after)
    expect(flagsOf(emulator)).toEqual(flags)
  })

  it('works on memory with a `ptr` size', () => {
    const emulator = emulatorOf(
      ['push rax', 'inc dword ptr [rsp]', 'dec byte ptr [rsp+7]', 'inc qword ptr [rsp]', 'ret'],
      { initialRegisters: { rax: 0x01000000ffffffffn } },
    )
    steps(emulator, 2)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    steps(emulator, 1)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    steps(emulator, 1)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
  })
})

describe('imul', () => {
  it.each<[string, Partial<Record<Reg64, bigint>>, bigint, 0 | 1]>([
    ['imul eax, ebx', { rax: 6n, rbx: 7n }, 42n, 0],
    ['imul rax, rbx', { rax: 6n, rbx: 7n }, 42n, 0],
    ['imul ax, bx', { rax: 6n, rbx: 7n }, 42n, 0],
    // -3 * 5 = -15
    ['imul eax, ebx', { rax: 0xfffffffdn, rbx: 5n }, 0xfffffff1n, 0],
    ['imul rax, rbx', { rax: 0xfffffffffffffffdn, rbx: 5n }, 0xfffffffffffffff1n, 0],
    // 0x7fffffff * 2 does not fit in 32 signed bits
    ['imul eax, ebx', { rax: 0x7fffffffn, rbx: 2n }, 0xfffffffen, 1],
    ['imul rax, rbx', { rax: 0x7fffffffn, rbx: 2n }, 0xfffffffen, 0],
    ['imul rax, rbx', { rax: 0x4000000000000000n, rbx: 2n }, 0x8000000000000000n, 1],
    ['imul ax, bx', { rax: 0x100n, rbx: 0x100n }, 0n, 1],
    ['imul eax, 10', { rax: 12n }, 120n, 0],
    ['imul rax, -1', { rax: 5n }, 0xfffffffffffffffbn, 0],
    ['imul eax, eax', { rax: 0x10000n }, 0n, 1],
  ])('%s', (line, registers, expected, overflow) => {
    const emulator = emulatorOf([line, 'ret'], { initialRegisters: registers })
    const [step] = steps(emulator, 1)
    expect(emulator.readRegister('rax')).toBe(expected)
    const flags = flagsOf(emulator)
    // CF = OF = 1 exactly when the signed product does not fit.
    expect(flags.CF).toBe(overflow)
    expect(flags.OF).toBe(overflow)
    expect(step.diff.written.flags).toEqual(['CF', 'ZF', 'SF', 'OF'])
  })

  it('sets SF and ZF from the result (the documented choice of this emulator)', () => {
    expect(flagsAfter(['imul eax, ebx'], { initialRegisters: { rax: 5n, rbx: 0n } })).toEqual({
      CF: 0,
      ZF: 1,
      SF: 0,
      OF: 0,
    })
    expect(
      flagsAfter(['imul eax, ebx'], { initialRegisters: { rax: 5n, rbx: 0xffffffffn } }),
    ).toEqual({ CF: 0, ZF: 0, SF: 1, OF: 0 })
  })

  it('multiplies by a value in memory', () => {
    const registers = registersAfter(['push rbx', 'imul eax, [rsp]', 'pop rbx'], {
      initialRegisters: { rax: 6n, rbx: 7n },
    })
    expect(registers.rax).toBe(42n)
  })

  it('a 32-bit imul clears the top half of the register', () => {
    const registers = registersAfter(['imul eax, ebx'], {
      initialRegisters: { rax: 0x1111222200000003n, rbx: 3n },
    })
    expect(registers.rax).toBe(9n)
  })
})

describe('and, or, xor', () => {
  it.each<[string, bigint, bigint, bigint, Flags]>([
    ['and eax, ebx', 0xff00ff00n, 0x0ff00ff0n, 0x0f000f00n, { CF: 0, ZF: 0, SF: 0, OF: 0 }],
    ['or eax, ebx', 0xff00ff00n, 0x0ff00ff0n, 0xfff0fff0n, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
    ['xor eax, ebx', 0xff00ff00n, 0x0ff00ff0n, 0xf0f0f0f0n, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
    ['and rax, rbx', 0xf0n, 0x0fn, 0n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
    ['or al, bl', 0x80n, 0x01n, 0x81n, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
    ['xor ax, bx', 0xffffn, 0xffffn, 0n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
    ['or rax, rbx', 0x8000000000000000n, 1n, 0x8000000000000001n, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
  ])('%s', (line, a, b, expected, flags) => {
    // CF and OF start at 1: the instruction must clear them.
    const emulator = emulatorOf([line, 'ret'], {
      initialRegisters: { rax: a, rbx: b },
      initialFlags: { CF: 1, OF: 1 },
    })
    steps(emulator, 1)
    expect(emulator.readRegister('rax')).toBe(expected)
    expect(flagsOf(emulator)).toEqual(flags)
  })

  it('`xor eax, eax` makes the whole of rax 0 and sets ZF', () => {
    const emulator = emulatorOf(['xor eax, eax', 'ret'], { initialRegisters: { rax: PATTERN } })
    steps(emulator, 1)
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(flagsOf(emulator)).toEqual({ CF: 0, ZF: 1, SF: 0, OF: 0 })
  })

  it('takes numbers, also sign-extended for 64 bits', () => {
    const registers = registersAfter(['and rax, -16', 'or ebx, 0x80000000', 'xor cl, 0xff'], {
      initialRegisters: { rax: 0x12345678n, rbx: 1n, rcx: 0x0fn },
    })
    expect(registers.rax).toBe(0x12345670n)
    expect(registers.rbx).toBe(0x80000001n)
    expect(registers.rcx).toBe(0xf0n)
  })

  it('works on memory', () => {
    const emulator = emulatorOf(['push rax', 'and dword ptr [rsp], 0x0f', 'or [rsp], bx', 'ret'], {
      initialRegisters: { rax: 0xffffffffffffffffn, rbx: 0x1100n },
    })
    steps(emulator, 3)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual([0x0f, 0x11, 0, 0, 0xff, 0xff, 0xff, 0xff])
  })
})

describe('cmp and test', () => {
  it('cmp computes a - b, sets all four flags and stores nothing', () => {
    const emulator = emulatorOf(['cmp ecx, edx', 'ret'], {
      initialRegisters: { rcx: 11n, rdx: 10n },
    })
    const [step] = steps(emulator, 1)
    expect(emulator.readRegister('rcx')).toBe(11n)
    expect(emulator.readRegister('rdx')).toBe(10n)
    expect(flagsOf(emulator)).toEqual({ CF: 0, ZF: 0, SF: 0, OF: 0 })
    expect(step.diff.registers).toEqual([])
    expect(step.diff.written.registers).toEqual([])
    expect(step.diff.written.flags).toEqual(['CF', 'ZF', 'SF', 'OF'])
  })

  it.each<[string, bigint, bigint, Flags]>([
    ['cmp eax, ebx', 5n, 5n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
    ['cmp eax, ebx', 1n, 2n, { CF: 1, ZF: 0, SF: 1, OF: 0 }],
    ['cmp eax, ebx', 2n, 1n, { CF: 0, ZF: 0, SF: 0, OF: 0 }],
    // -1 compared with 1: below as unsigned is false, less as signed is true
    ['cmp eax, ebx', 0xffffffffn, 1n, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
    ['cmp eax, ebx', 0x80000000n, 1n, { CF: 0, ZF: 0, SF: 0, OF: 1 }],
    ['cmp rax, rbx', 0n, 0xffffffffffffffffn, { CF: 1, ZF: 0, SF: 0, OF: 0 }],
    ['cmp al, bl', 0x7fn, 0xffn, { CF: 1, ZF: 0, SF: 1, OF: 1 }],
    ['cmp ax, bx', 0x8000n, 0x8000n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
  ])('%s with %s and %s', (line, a, b, flags) => {
    expect(flagsAfter([line], { initialRegisters: { rax: a, rbx: b } })).toEqual(flags)
  })

  it('cmp takes a number and memory', () => {
    expect(
      flagsAfter(['push rax', 'cmp qword ptr [rsp], 7'], { initialRegisters: { rax: 7n } }),
    ).toEqual({ CF: 0, ZF: 1, SF: 0, OF: 0 })
    expect(flagsAfter(['cmp rax, -1'], { initialRegisters: { rax: 0xffffffffffffffffn } })).toEqual(
      {
        CF: 0,
        ZF: 1,
        SF: 0,
        OF: 0,
      },
    )
    expect(
      flagsAfter(['push rbx', 'cmp eax, [rsp]'], { initialRegisters: { rax: 1n, rbx: 2n } }),
    ).toEqual({ CF: 1, ZF: 0, SF: 1, OF: 0 })
  })

  it('test computes a AND b, clears CF and OF and stores nothing', () => {
    const emulator = emulatorOf(['test eax, eax', 'ret'], {
      initialRegisters: { rax: 0x80000000n },
      initialFlags: { CF: 1, OF: 1, ZF: 1 },
    })
    const [step] = steps(emulator, 1)
    expect(emulator.readRegister('rax')).toBe(0x80000000n)
    expect(flagsOf(emulator)).toEqual({ CF: 0, ZF: 0, SF: 1, OF: 0 })
    expect(step.diff.written.flags).toEqual(['CF', 'ZF', 'SF', 'OF'])
    expect(step.diff.registers).toEqual([])
  })

  it.each<[string, bigint, bigint, Flags]>([
    ['test rax, rax', 0n, 0n, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
    ['test eax, ebx', 0xf0n, 0x0fn, { CF: 0, ZF: 1, SF: 0, OF: 0 }],
    ['test al, bl', 0x81n, 0x80n, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
    ['test ax, 1', 3n, 0n, { CF: 0, ZF: 0, SF: 0, OF: 0 }],
    ['test rax, rbx', 0xffffffffffffffffn, 0x8000000000000000n, { CF: 0, ZF: 0, SF: 1, OF: 0 }],
  ])('%s with %s and %s', (line, a, b, flags) => {
    expect(flagsAfter([line], { initialRegisters: { rax: a, rbx: b } })).toEqual(flags)
  })

  it('test takes memory on either side', () => {
    const options = { initialRegisters: { rax: 0x0fn, rbx: 0xf0n } }
    expect(flagsAfter(['push rax', 'test [rsp], bl'], options).ZF).toBe(1)
    expect(flagsAfter(['push rax', 'test rax, [rsp]'], options).ZF).toBe(0)
    expect(flagsAfter(['push rax', 'test byte ptr [rsp], 0x10'], options).ZF).toBe(1)
  })

  it('a compare does not write memory', () => {
    const emulator = emulatorOf(['push rax', 'cmp qword ptr [rsp], 1', 'ret'])
    const [, cmp] = steps(emulator, 2)
    expect(cmp.diff.memory).toEqual([])
    expect(cmp.diff.written.memory).toEqual([])
  })
})

/* ─────────────────────────────── jumps ─────────────────────────────── */

/** The rule of every conditional jump, written again from the contract. */
const JUMP_RULES: Record<string, (flags: Flags) => boolean> = {
  je: (f) => f.ZF === 1,
  jne: (f) => f.ZF === 0,
  jg: (f) => f.ZF === 0 && f.SF === f.OF,
  jge: (f) => f.SF === f.OF,
  jl: (f) => f.SF !== f.OF,
  jle: (f) => f.ZF === 1 || f.SF !== f.OF,
  ja: (f) => f.CF === 0 && f.ZF === 0,
  jae: (f) => f.CF === 0,
  jb: (f) => f.CF === 1,
  jbe: (f) => f.CF === 1 || f.ZF === 1,
  js: (f) => f.SF === 1,
  jns: (f) => f.SF === 0,
  jo: (f) => f.OF === 1,
  jno: (f) => f.OF === 0,
}

/** Other spellings and the jump they stand for. */
const JUMP_SPELLINGS: [string, string][] = [
  ['jz', 'je'],
  ['jnz', 'jne'],
  ['jnle', 'jg'],
  ['jnl', 'jge'],
  ['jnge', 'jl'],
  ['jng', 'jle'],
  ['jnbe', 'ja'],
  ['jnb', 'jae'],
  ['jnc', 'jae'],
  ['jnae', 'jb'],
  ['jc', 'jb'],
  ['jna', 'jbe'],
]

/** All 16 combinations of the four flags. */
function allFlags(): Flags[] {
  const combinations: Flags[] = []
  for (let bits = 0; bits < 16; bits++) {
    combinations.push({
      CF: bits & 1 ? 1 : 0,
      ZF: bits & 2 ? 1 : 0,
      SF: bits & 4 ? 1 : 0,
      OF: bits & 8 ? 1 : 0,
    })
  }
  return combinations
}

/** Where rip is after `written target` with these flags: at `target` or at the next line. */
function jumpLands(written: string, flags: Flags): 'target' | 'next' {
  // The jump is 2 bytes at TEXT, `nop` is 1 byte after it, `target` follows.
  const emulator = emulatorOf([`${written} target`, 'nop', 'target:', 'ret'], {
    initialFlags: flags,
  })
  const [step] = steps(emulator, 1)
  expect(step.diff.rip.before).toBe(TEXT)
  expect(step.diff.flags).toEqual([])
  expect(step.diff.registers).toEqual([])
  expect(flagsOf(emulator)).toEqual(flags)
  const rip = emulator.getSnapshot().rip
  if (rip === TEXT + 3n) return 'target'
  expect(rip).toBe(TEXT + 2n)
  return 'next'
}

describe('conditional jumps', () => {
  it.each(Object.keys(JUMP_RULES))(
    '%s follows its rule for all 16 flag combinations',
    (written) => {
      const rule = JUMP_RULES[written]
      let taken = 0
      for (const flags of allFlags()) {
        const expected = rule(flags) ? 'target' : 'next'
        expect(jumpLands(written, flags), JSON.stringify(flags)).toBe(expected)
        if (expected === 'target') taken++
      }
      // Every condition is true for some flags and false for others.
      expect(taken).toBeGreaterThan(0)
      expect(taken).toBeLessThan(16)
    },
  )

  it.each(JUMP_SPELLINGS)('%s jumps exactly when %s does', (written, canonical) => {
    for (const flags of allFlags()) {
      expect(jumpLands(written, flags), JSON.stringify(flags)).toBe(
        JUMP_RULES[canonical](flags) ? 'target' : 'next',
      )
    }
  })

  it('a taken jump goes to the label, a jump that is not taken falls through', () => {
    const emulator = emulatorOf([
      'mov eax, 1',
      'cmp eax, 1',
      'jne skip',
      'mov ebx, 10',
      'skip:',
      'cmp eax, 2',
      'jne done',
      'mov ebx, 20',
      'done:',
      'ret',
    ])
    expect(finish(emulator).registers.rbx).toBe(10n)
  })

  it('jmp always jumps, forwards and backwards', () => {
    const emulator = emulatorOf([
      'jmp forward',
      'back:',
      'mov eax, 2',
      'ret',
      'forward:',
      'mov ebx, 1',
      'jmp back',
    ])
    const state = finish(emulator)
    expect(state.registers.rax).toBe(2n)
    expect(state.registers.rbx).toBe(1n)
    expect(state.stepCount).toBe(5)
  })

  it('a loop counts down with dec and jne', () => {
    const emulator = emulatorOf([
      'mov ecx, 5',
      'mov eax, 0',
      'again:',
      'add eax, ecx',
      'dec ecx',
      'jne again',
      'ret',
    ])
    const state = finish(emulator)
    expect(state.registers.rax).toBe(15n)
    expect(state.registers.rcx).toBe(0n)
    expect(state.stepCount).toBe(2 + 5 * 3 + 1)
  })

  it('signed and unsigned jumps differ for a negative number', () => {
    // -1 compared with 1: less than (signed), but above (unsigned).
    const signed = emulatorOf(['mov eax, -1', 'cmp eax, 1', 'jl yes', 'mov ebx, 1', 'yes:', 'ret'])
    expect(finish(signed).registers.rbx).toBe(0n)
    const unsigned = emulatorOf([
      'mov eax, -1',
      'cmp eax, 1',
      'jb yes',
      'mov ebx, 1',
      'yes:',
      'ret',
    ])
    expect(finish(unsigned).registers.rbx).toBe(1n)
  })
})

/* ───────────────────────── call, ret, leave, nop ───────────────────────── */

describe('call and ret', () => {
  const twoFunctions = ['call helper', 'mov ebx, 2', 'ret', 'helper:', 'mov eax, 1', 'ret']

  it('call pushes the address of the next instruction and jumps', () => {
    const emulator = emulatorOf(twoFunctions)
    const call = emulator.program.instructions[0]
    const [step] = steps(emulator, 1)
    const returnAddress = call.address + BigInt(call.size)
    expect(call.size).toBe(5)
    expect(returnAddress).toBe(TEXT + 5n)
    expect(emulator.readRegister('rsp')).toBe(RSP0 - 8n)
    expect(bytesAt(emulator, RSP0 - 8n, 8)).toEqual([0x2b, 0x11, 0x40, 0, 0, 0, 0, 0])
    expect(emulator.getSnapshot().rip).toBe(emulator.program.symbols.get('helper')?.address)
    expect(step.diff.rip).toEqual({ before: TEXT, after: TEXT + 11n })
    expect(step.diff.flags).toEqual([])
  })

  it('ret pops the return address into rip and moves rsp up 8', () => {
    const emulator = emulatorOf(twoFunctions)
    const [, , ret] = steps(emulator, 3)
    expect(ret.text).toBe('ret')
    expect(emulator.getSnapshot().rip).toBe(TEXT + 5n)
    expect(emulator.readRegister('rsp')).toBe(RSP0)
    expect(ret.diff.registers).toEqual([{ reg: 'rsp', before: RSP0 - 8n, after: RSP0 }])
    expect(emulator.getSnapshot().nextLine).toBe(5)
  })

  it('runs the function and comes back', () => {
    const state = finish(emulatorOf(twoFunctions))
    expect(state.registers.rax).toBe(1n)
    expect(state.registers.rbx).toBe(2n)
    expect(state.registers.rsp).toBe(RSP0 + 8n)
  })

  it('keeps the active calls in callStack', () => {
    const emulator = emulatorOf([
      'call outer',
      'ret',
      'outer:',
      'call inner',
      'ret',
      'inner:',
      'ret',
    ])
    const names = (): (string | null)[] =>
      emulator.getSnapshot().callStack.map((frame) => frame.functionName)
    expect(names()).toEqual(['main'])
    emulator.step()
    expect(names()).toEqual(['main', 'outer'])
    emulator.step()
    expect(names()).toEqual(['main', 'outer', 'inner'])
    expect(emulator.getSnapshot().callStack[2]).toEqual({
      functionName: 'inner',
      callLine: 7,
      returnAddress: TEXT + 11n,
      slotAddress: RSP0 - 16n,
    })
    emulator.step()
    expect(names()).toEqual(['main', 'outer'])
    emulator.step()
    expect(names()).toEqual(['main'])
    emulator.step()
    expect(names()).toEqual([])
    expect(emulator.getSnapshot().status).toBe('halted')
  })

  it('a `ret` that pops the OS return address ends the program', () => {
    const emulator = emulatorOf(['mov eax, 3', 'ret'])
    const [, ret] = steps(emulator, 2)
    expect(ret.status).toBe('halted')
    expect(ret.error).toBeNull()
    const state = emulator.getSnapshot()
    expect(state.status).toBe('halted')
    expect(state.rip).toBe(DEFAULT_OPTIONS.osReturnAddress)
    expect(state.nextLine).toBeNull()
    expect(state.registers.rsp).toBe(RSP0 + 8n)
  })

  it('recursion: a function that calls itself counts down', () => {
    const emulator = emulatorOf([
      'mov edi, 4',
      'call count',
      'ret',
      'count:',
      'cmp edi, 0',
      'je finished',
      'add eax, edi',
      'dec edi',
      'call count',
      'finished:',
      'ret',
    ])
    const state = finish(emulator)
    expect(state.registers.rax).toBe(10n)
    expect(state.registers.rsp).toBe(RSP0 + 8n)
    expect(state.callStack).toEqual([])
  })

  it('`ret` to an instruction that no `call` saved still jumps, with a warning', () => {
    // The address of `landing` is pushed by hand, so `ret` works as a jump.
    const emulator = emulatorOf(['push offset landing', 'ret', 'landing:', 'mov eax, 9', 'ret'])
    const [, ret] = steps(emulator, 2)
    expect(ret.status).toBe('running')
    expect(emulator.getSnapshot().nextLine).toBe(7)
    expect(ret.notes.map((note) => note.kind)).toEqual(['warning'])
    expect(emulator.getSnapshot().callStack).toHaveLength(1)
    expect(finish(emulator).registers.rax).toBe(9n)
  })

  it('a correct `ret` has no note', () => {
    const emulator = emulatorOf(twoFunctions)
    const results = steps(emulator, 5)
    expect(results.flatMap((result) => result.notes)).toEqual([])
  })
})

describe('leave, nop and endbr64', () => {
  it('`leave` does `mov rsp, rbp` and then `pop rbp`', () => {
    const emulator = emulatorOf(['push rbp', 'mov rbp, rsp', 'sub rsp, 32', 'leave', 'ret'], {
      initialRegisters: { rbp: 0x1234n },
    })
    const [, , , leave] = steps(emulator, 4)
    expect(emulator.readRegister('rsp')).toBe(RSP0)
    expect(emulator.readRegister('rbp')).toBe(0x1234n)
    expect(leave.diff.registers).toEqual([
      { reg: 'rsp', before: RSP0 - 40n, after: RSP0 },
      { reg: 'rbp', before: RSP0 - 8n, after: 0x1234n },
    ])
    expect(leave.diff.flags).toEqual([])
    expect(finish(emulator).status).toBe('halted')
  })

  it.each(['nop', 'endbr64'])('%s changes nothing except rip', (line) => {
    const emulator = emulatorOf([line, 'ret'], {
      initialRegisters: patternRegisters(),
      initialFlags: { CF: 1, ZF: 1 },
    })
    const size = emulator.program.instructions[0].size
    const [step] = steps(emulator, 1)
    expect(step.text).toBe(line)
    expect(step.diff.registers).toEqual([])
    expect(step.diff.flags).toEqual([])
    expect(step.diff.memory).toEqual([])
    expect(step.diff.written).toEqual({ registers: [], flags: [], memory: [] })
    expect(step.diff.rip).toEqual({ before: TEXT, after: TEXT + BigInt(size) })
  })
})

/* ─────────────────────────────── rip ─────────────────────────────── */

describe('rip', () => {
  it('moves by the size of each instruction', () => {
    const emulator = emulatorOf(['push rbx', 'mov rbp, rsp', 'mov eax, 0', 'sub rsp, 16', 'ret'])
    const sizes = emulator.program.instructions.map((instruction) => instruction.size)
    expect(sizes).toEqual([1, 3, 5, 4, 1])
    let expected = TEXT
    for (const size of sizes.slice(0, 4)) {
      const step = emulator.step()
      expect(step.address).toBe(expected)
      expect(step.diff.rip).toEqual({ before: expected, after: expected + BigInt(size) })
      expected += BigInt(size)
      expect(emulator.getSnapshot().rip).toBe(expected)
    }
  })

  it('step results carry the line, the address and the text of the instruction', () => {
    const emulator = emulatorOf(['MOV   EAX,DWORD PTR [RSP]', 'ret'])
    const [step] = steps(emulator, 1)
    expect(step).toMatchObject({
      executed: true,
      stepNumber: 1,
      kind: 'instruction',
      line: 4,
      address: TEXT,
      text: 'mov eax, dword ptr [rsp]',
      status: 'running',
      error: null,
      output: '',
    })
  })
})

/* ────────────────────────────── run-time errors ────────────────────────────── */

/** Step until the program stops with an error; give back that step and the emulator. */
function failingStep(
  lines: string[],
  options?: EmulatorOptions,
): { step: StepResult; emulator: Emulator } {
  const emulator = emulatorOf(lines, options)
  for (let i = 0; i < 1000; i++) {
    const step = emulator.step()
    if (step.status === 'error') return { step, emulator }
    if (!step.executed) break
  }
  throw new Error('the program did not stop with an error')
}

describe('run-time errors', () => {
  it.each<[string, string[], RuntimeCode, number, RegExp]>([
    ['a read at address 0', ['mov rbx, 0', 'mov rax, [rbx]', 'ret'], 'bad-memory-read', 5, /0x0\b/],
    [
      'a write at a small address',
      ['mov rbx, 16', 'mov [rbx], rax', 'ret'],
      'bad-memory-write',
      5,
      /0x10\b/,
    ],
    [
      'a write into the code',
      ['mov qword ptr main[rip], 1', 'ret'],
      'write-read-only',
      4,
      /0x401126/,
    ],
    ['a `ret` with a number on top', ['push 5', 'ret'], 'bad-jump', 5, /0x5\b/],
    ['a program with no `ret`', ['mov eax, 0'], 'ran-off-end', 4, /`ret`/],
    [
      'a `pop` with rsp outside the stack',
      ['mov rsp, 64', 'pop rax', 'ret'],
      'bad-memory-read',
      5,
      /0x40\b/,
    ],
    [
      'a `push` with rsp outside the stack',
      ['mov rsp, 64', 'push rax', 'ret'],
      'bad-memory-write',
      5,
      /0x38\b/,
    ],
    ['a `ret` with rsp outside the stack', ['mov rsp, 64', 'ret'], 'bad-memory-read', 5, /0x40\b/],
    [
      '`leave` with rbp outside the stack',
      ['mov rbp, 64', 'leave', 'ret'],
      'bad-memory-read',
      5,
      /0x40\b/,
    ],
    [
      'a jump to a label with nothing after it',
      ['jmp finish', 'ret', 'finish:'],
      'bad-jump',
      4,
      /`finish`/,
    ],
    [
      'a call to a label with nothing after it',
      ['call finish', 'ret', 'finish:'],
      'bad-jump',
      4,
      /`finish`/,
    ],
  ])('%s is %s on its line, with a real sentence', (_what, lines, code, line, mentions) => {
    const { step, emulator } = failingStep(lines)
    const error = emulator.getSnapshot().error
    expect(error).not.toBeNull()
    expect(error?.code).toBe(code)
    expect(error?.line).toBe(line)
    expect(error?.message.startsWith(`Line ${line}: `)).toBe(true)
    expect(error?.message).toMatch(mentions)
    // A real sentence: it ends with a full stop or a question mark, and has no code leftovers.
    expect(error?.message).toMatch(/[.?]$/)
    expect(error?.message).not.toMatch(/undefined|NaN|\[object|\$\{/)
    expect(step.error).toEqual(error)
    expect(step.executed).toBe(true)
    expect(step.line).toBe(line)
    expect(emulator.getSnapshot().status).toBe('error')
  })

  it('a faulting instruction changes nothing: it is atomic', () => {
    const emulator = emulatorOf(['mov rbx, 0', 'add rax, [rbx]', 'ret'], {
      initialRegisters: { rax: 7n },
      initialFlags: { CF: 1 },
    })
    emulator.step()
    const before = emulator.getSnapshot()
    const step = emulator.step()
    const after = emulator.getSnapshot()
    expect(step.executed).toBe(true)
    expect(step.status).toBe('error')
    expect(step.stepNumber).toBe(2)
    expect(after.stepCount).toBe(2)
    expect(step.diff).toEqual({
      registers: [],
      flags: [],
      memory: [],
      rip: { before: before.rip, after: before.rip },
      written: { registers: [], flags: [], memory: [] },
    })
    expect(after.registers).toEqual(before.registers)
    expect(after.flags).toEqual(before.flags)
    expect(after.rip).toBe(before.rip)
    expect(after.stack).toEqual(before.stack)
  })

  it('a write that faults leaves rsp and memory alone (push below the stack)', () => {
    const emulator = emulatorOf(['push rax', 'ret'], { stackSize: 8 })
    const before = emulator.getSnapshot()
    const step = emulator.step()
    expect(step.error?.code).toBe('stack-overflow')
    expect(emulator.readRegister('rsp')).toBe(RSP0)
    expect(emulator.getSnapshot().stack).toEqual(before.stack)
    expect(step.diff.registers).toEqual([])
  })

  it('a memory operand that reads and writes faults before anything is written', () => {
    // The read works (the code reads as 0), the write does not: nothing may change.
    const emulator = emulatorOf(['add qword ptr main[rip], 1', 'ret'], { initialFlags: { ZF: 1 } })
    const step = emulator.step()
    expect(step.error?.code).toBe('write-read-only')
    expect(flagsOf(emulator)).toEqual({ CF: 0, ZF: 1, SF: 0, OF: 0 })
    expect(step.diff.flags).toEqual([])
  })

  it('a write to read-only data names the label', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'message: .string "hi"',
        'main:',
        'mov byte ptr message[rip], 65',
        'ret',
        '',
      ].join('\n'),
    )
    const step = emulator.step()
    expect(step.error?.code).toBe('write-read-only')
    expect(step.error?.line).toBe(4)
    expect(step.error?.message).toContain('`message`')
    expect(step.error?.message).toContain('0x402010')
    expect(bytesAt(emulator, 0x402010n, 2)).toEqual([0x68, 0x69])
  })

  it('a function that calls itself for ever ends in a stack overflow', () => {
    const emulator = emulatorOf(['call main'], { stackSize: 64, maxSteps: 1000 })
    const run = emulator.run()
    expect(run.reason).toBe('error')
    // 64 bytes below the stack start: 8 boxes. One holds the OS return address.
    expect(run.stepsRun).toBe(8)
    const state = emulator.getSnapshot()
    expect(state.error?.code).toBe('stack-overflow')
    expect(state.error?.line).toBe(4)
    expect(state.error?.message).toMatch(/stack/)
    expect(state.registers.rsp).toBe(RSP0 - 56n)
  })

  it('the default stack holds one megabyte', () => {
    const emulator = emulatorOf(['call main'], { maxSteps: 200_000 })
    const run = emulator.run()
    expect(run.reason).toBe('error')
    expect(emulator.getSnapshot().error?.code).toBe('stack-overflow')
    // rsp starts 8 below the stack start, so 131071 more boxes fit.
    expect(run.stepsRun).toBe(131_072)
    // 131 072 steps take about a second; more when the other test files run at the same time.
  }, 30_000)

  it('a read that starts inside the stack and ends outside it faults', () => {
    const top = emulatorOf(['ret']).getSnapshot()
    expect(top.status).toBe('running')
    // One page above the stack start is the end of the region.
    const emulator = emulatorOf(['mov rax, [rbx]', 'ret'], {
      initialRegisters: { rbx: DEFAULT_OPTIONS.stackBase + 4096n - 4n },
    })
    const step = emulator.step()
    expect(step.error?.code).toBe('bad-memory-read')
    expect(step.error?.message).toMatch(/8 bytes/)
  })

  it('reading a little above the starting rsp works (and warns that it is junk)', () => {
    const emulator = emulatorOf(['mov rax, 16[rsp]', 'ret'])
    const step = emulator.step()
    expect(step.status).toBe('running')
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(step.notes).toHaveLength(1)
    expect(step.notes[0].kind).toBe('warning')
  })

  it('an address at 2^64 - 1 does not wrap into the program', () => {
    const emulator = emulatorOf(['mov eax, [rbx]', 'ret'], {
      initialRegisters: { rbx: 0xfffffffffffffffen },
    })
    const step = emulator.step()
    expect(step.error?.code).toBe('bad-memory-read')
    expect(step.error?.message).toContain('0xfffffffffffffffe')
  })

  it('`ret` on a value that is the address of the middle of an instruction is a bad jump', () => {
    const emulator = emulatorOf(['push rax', 'ret'], { initialRegisters: { rax: TEXT + 2n } })
    const [, ret] = steps(emulator, 2)
    expect(ret.error?.code).toBe('bad-jump')
    // The step itself is applied: rsp went up and rip holds the popped value.
    expect(emulator.readRegister('rsp')).toBe(RSP0)
    expect(emulator.getSnapshot().rip).toBe(TEXT + 2n)
    expect(ret.diff.registers).toEqual([{ reg: 'rsp', before: RSP0 - 8n, after: RSP0 }])
    expect(ret.diff.rip).toEqual({ before: TEXT + 1n, after: TEXT + 2n })
  })

  it('running past the last instruction applies the step, then stops', () => {
    const emulator = emulatorOf(['mov eax, 7'])
    const step = emulator.step()
    expect(step.error?.code).toBe('ran-off-end')
    expect(emulator.readRegister('rax')).toBe(7n)
    expect(step.diff.registers).toEqual([{ reg: 'rax', before: 0n, after: 7n }])
    const state = emulator.getSnapshot()
    expect(state.rip).toBe(emulator.program.layout.textEnd)
    expect(state.nextLine).toBeNull()
    expect(state.error?.message).toContain('`main`')
  })

  it('a conditional jump that is not taken on the last line runs past the end', () => {
    const emulator = emulatorOf(['top:', 'jne top'], { initialFlags: { ZF: 1 } })
    const step = emulator.step()
    expect(step.error?.code).toBe('ran-off-end')
  })

  it('coming back from a `call` on the last line says so', () => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', 'helper:', 'ret', 'main:', 'call helper', ''].join('\n'),
    )
    const [, ret] = steps(emulator, 2)
    expect(ret.error?.code).toBe('bad-jump')
    expect(ret.error?.line).toBe(3)
    expect(ret.error?.message).toMatch(/line 5/)
    expect(ret.error?.message).toMatch(/last instruction/)
    expect(emulator.getSnapshot().callStack.map((frame) => frame.functionName)).toEqual(['main'])
  })

  it('a program that starts at a label with no instruction stops on the first step', () => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', 'helper:', 'ret', 'main:', ''].join('\n'),
    )
    expect(emulator.getSnapshot().status).toBe('running')
    const step = emulator.step()
    expect(step.executed).toBe(true)
    expect(step.status).toBe('error')
    expect(step.error?.code).toBe('ran-off-end')
    expect(step.error?.message).toContain('`main`')
    expect(emulator.stepBack()).toBe(true)
    expect(emulator.getSnapshot().status).toBe('running')
  })

  it('stepping after an error runs nothing and repeats the error', () => {
    const { emulator, step } = failingStep(['push 5', 'ret'])
    const again = emulator.step()
    expect(again.executed).toBe(false)
    expect(again.status).toBe('error')
    expect(again.error).toEqual(step.error)
    expect(again.explanation).toBe(step.error?.message)
    expect(again.diff.registers).toEqual([])
    expect(emulator.getSnapshot().stepCount).toBe(2)
  })

  it('a not-taken jump on the last line: ran past the end, and the message says to add `ret`', () => {
    // A jump that is not taken falls through like any other instruction.
    const emulator = emulatorOf(['cmp eax, 1', 'je main'])
    const [, jump] = steps(emulator, 2)
    expect(jump.error?.code).toBe('ran-off-end')
    expect(jump.error?.message).toBe(
      'Line 5: `je main` was the last instruction, but the program did not end: it went past the end of the code. Add `ret` at the end of `main`.',
    )
    expect(jump.explanation).toContain('so it did not jump')
  })

  it('a read-modify-write at an address nobody owns is a READ fault, as on a real CPU', () => {
    const emulator = emulatorOf(['add qword ptr [rbx], 1', 'ret'], {
      initialRegisters: { rbx: 0x10n },
      initialFlags: { CF: 1 },
    })
    const step = emulator.step()
    expect(step.error?.code).toBe('bad-memory-read')
    expect(step.diff.flags).toEqual([])
    expect(flagsOf(emulator)).toEqual({ CF: 1, ZF: 0, SF: 0, OF: 0 })
  })

  it('a push with rsp at 0 is a bad write: rsp does not point into the stack', () => {
    // The stack never reaches below 0x40 (so a NULL pointer faults), and rsp = 0 is below it.
    const emulator = emulatorOf(['mov rsp, 0', 'push rax', 'ret'], {
      textBase: 0x4000n,
      stackBase: 0x1000n,
      initialRsp: 0x200n,
      osReturnAddress: 0x3ff0n,
    })
    const [, push] = steps(emulator, 2)
    expect(push.error?.code).toBe('bad-memory-write')
    expect(emulator.readRegister('rsp')).toBe(0n)
    // Nothing was written anywhere, also not at the top of memory after a wrap.
    expect(push.diff.memory).toEqual([])
    expect(emulator.readMemory(0xfffffffffffffff8n, 8)).toEqual(new Array(8).fill(null))
  })

  it.each<[string, string[], RegExp]>([
    [
      'push',
      ['lea rsp, msg+8[rip]', 'push rax'],
      /`push rax` tried to write a new top box at 0x402010, but that memory is read-only\./,
    ],
    [
      'call',
      ['lea rsp, main+16[rip]', 'call main'],
      /`call main` tried to write a new top box at 0x40112e, but that memory is part of the code of the program\./,
    ],
  ])('%s with rsp in read-only memory: the error is about rsp', (_name, lines, summary) => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', 'msg: .string "hello, world"', 'main:', ...lines, 'ret', ''].join(
        '\n',
      ),
    )
    const [, step] = steps(emulator, 2)
    expect(step.error?.code).toBe('write-read-only')
    expect(step.error?.message).toMatch(summary)
    expect(step.error?.message).toContain('Check rsp: it must point into the stack.')
    expect(step.error?.message).not.toContain('.data')
  })
})

/* ──────────────────────── memory in whole pages, as on a real machine ──────────────────────── */

describe('the areas of the program are whole 4 KiB pages', () => {
  it('reading 8 bytes at a 4-byte variable at the end of `.data` works, and the rest reads 0', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'x: .long 5',
        '.text',
        'main:',
        'mov rax, x',
        'ret',
        '',
      ].join('\n'),
    )
    const step = emulator.step()
    expect(step.status).toBe('running')
    expect(emulator.readRegister('rax')).toBe(5n)
    expect(step.notes).toEqual([])
  })

  it('a write just past the last variable stays in the page of `.data`, so it works', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'x: .long 5',
        '.text',
        'main:',
        'mov dword ptr x+4[rip], 7',
        'mov rax, x',
        'ret',
        '',
      ].join('\n'),
    )
    const [write, read] = steps(emulator, 2)
    expect(write.status).toBe('running')
    expect(read.status).toBe('running')
    expect(emulator.readRegister('rax')).toBe(0x0000000700000005n)
  })

  it('code and read-only data stay read-only to the end of their page', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'msg: .string "hi"',
        'main:',
        'mov byte ptr msg+100[rip], 1',
        'ret',
        '',
      ].join('\n'),
    )
    expect(emulator.step().error?.code).toBe('write-read-only')
    const code = emulatorOf(['mov byte ptr main+200[rip], 1', 'ret'])
    expect(code.step().error?.code).toBe('write-read-only')
  })

  it('past the last page of an area nothing is mapped: the read faults', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'x: .long 5',
        '.text',
        'main:',
        'mov rax, x+0xfd0',
        'ret',
        '',
      ].join('\n'),
    )
    // .data starts at 0x404030, so its page ends at 0x405000; x+0xfd0 = 0x405000.
    const step = emulator.step()
    expect(step.error?.code).toBe('bad-memory-read')
    expect(step.error?.message).toContain('0x405000')
  })
})

/* ──────────────────────── the call stack after an unusual ret ──────────────────────── */

describe('the call stack and a `ret` that does not use the saved return address', () => {
  it('keeps the frame while its return address is still on the stack', () => {
    // f pushes the address of `there` and returns to it: f's return address is still above rsp.
    const emulator = emulatorOf([
      'call f',
      'ret',
      'f:',
      'lea rax, there[rip]',
      'push rax',
      'ret',
      'there:',
      'ret',
    ])
    const results = steps(emulator, 4)
    expect(results[3].notes.map((note) => note.kind)).toEqual(['warning'])
    expect(emulator.getSnapshot().callStack.map((frame) => frame.functionName)).toEqual([
      'main',
      'f',
    ])
    // The `ret` at `there` pops f's real return address and ends the frame.
    emulator.step()
    expect(emulator.getSnapshot().callStack.map((frame) => frame.functionName)).toEqual(['main'])
    expect(emulator.run().reason).toBe('halted')
  })

  it('drops a frame whose return-address box was popped with something else in it', () => {
    const emulator = emulatorOf([
      'call f',
      'ret',
      'f:',
      'lea rax, back[rip]',
      'mov [rsp], rax',
      'ret',
      'back:',
      'ret',
    ])
    steps(emulator, 4)
    // The box of f's return address was popped (with another value in it): f is over.
    expect(emulator.getSnapshot().callStack.map((frame) => frame.functionName)).toEqual(['main'])
  })
})

/* ───────────────────────────── notes of a step ───────────────────────────── */

describe('warnings on a step', () => {
  it('reading a stack box that was never written warns, and reads 0', () => {
    const emulator = emulatorOf(['sub rsp, 8', 'mov rax, [rsp]', 'ret'], {
      initialRegisters: { rax: 99n },
    })
    const [, read] = steps(emulator, 2)
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(read.notes).toHaveLength(1)
    expect(read.notes[0].kind).toBe('warning')
    expect(read.notes[0].text).toMatch(/never written/)
    expect(read.notes[0].text).toMatch(/junk/)
    expect(read.notes[0].text).toMatch(/real machine/)
  })

  it('a pop of a box that was never written warns too', () => {
    const emulator = emulatorOf(['sub rsp, 8', 'pop rax', 'ret'])
    const [, pop] = steps(emulator, 2)
    expect(pop.notes.map((note) => note.kind)).toEqual(['warning'])
    expect(pop.notes[0].text).toMatch(/never written/)
  })

  it('reading a box that was written has no note', () => {
    const emulator = emulatorOf(['push rax', 'mov rbx, [rsp]', 'pop rcx', 'ret'])
    const results = steps(emulator, 3)
    expect(results.flatMap((result) => result.notes)).toEqual([])
  })

  it('reading half of a box that is only half written warns', () => {
    const emulator = emulatorOf([
      'sub rsp, 8',
      'mov dword ptr [rsp], 1',
      'mov rax, [rsp]',
      'mov ebx, [rsp]',
      'ret',
    ])
    const [, , whole, half] = steps(emulator, 4)
    expect(whole.notes).toHaveLength(1)
    expect(whole.notes[0].text).toMatch(/4 of the 8 bytes/)
    expect(half.notes).toEqual([])
  })

  it('a conditional jump that reads ZF or SF after `imul` warns', () => {
    const emulator = emulatorOf(['imul eax, ebx', 'je done', 'done:', 'ret'])
    const [, jump] = steps(emulator, 2)
    expect(jump.notes).toHaveLength(1)
    expect(jump.notes[0].kind).toBe('warning')
    expect(jump.notes[0].text).toContain('imul')
    expect(jump.notes[0].text).toMatch(/cmp|test/)
  })

  it.each([
    'je',
    'jne',
    'jg',
    'jge',
    'jl',
    'jle',
    'ja',
    'jbe',
    'js',
    'jns',
    'jz',
    'jnz',
    'jnle',
    'jna',
  ])('%s after `imul` warns', (written) => {
    const emulator = emulatorOf(['imul eax, ebx', `${written} done`, 'done:', 'ret'])
    const [, jump] = steps(emulator, 2)
    expect(jump.notes.map((note) => note.kind)).toEqual(['warning'])
  })

  it.each(['jae', 'jb', 'jo', 'jno', 'jc', 'jnc', 'jmp'])(
    '%s after `imul` does not warn (CF and OF are defined)',
    (written) => {
      const emulator = emulatorOf(['imul eax, ebx', `${written} done`, 'done:', 'ret'])
      const [, jump] = steps(emulator, 2)
      expect(jump.notes).toEqual([])
    },
  )

  it.each(['cmp eax, 1', 'test eax, eax', 'add eax, 1', 'dec eax', 'and eax, 1'])(
    'no warning when `%s` wrote the flags after the `imul`',
    (line) => {
      const emulator = emulatorOf(['imul eax, ebx', line, 'je done', 'done:', 'ret'])
      const [, , jump] = steps(emulator, 3)
      expect(jump.notes).toEqual([])
    },
  )

  it('instructions that do not write flags keep the `imul` warning alive', () => {
    const emulator = emulatorOf([
      'imul eax, ebx',
      'mov ecx, 1',
      'lea rdx, [rcx]',
      'push rax',
      'pop rax',
      'jle done',
      'done:',
      'ret',
    ])
    const results = steps(emulator, 6)
    expect(results[5].notes.map((note) => note.kind)).toEqual(['warning'])
  })

  it('reading the code of the program gives 0 and says why', () => {
    const emulator = emulatorOf(['mov rax, main', 'ret'], { initialRegisters: { rax: 5n } })
    const [step] = steps(emulator, 1)
    expect(step.status).toBe('running')
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(step.notes).toHaveLength(1)
    expect(step.notes[0].text).toMatch(/code/)
    expect(step.notes[0].text).toContain('lea')
  })
})

/* ──────────────────────────── the executor is pure ──────────────────────────── */

describe('executeInstruction', () => {
  function viewFor(text: string): { view: MachineView; memory: Memory } {
    const assembled = assemble(text)
    if (!assembled.ok) throw new Error('the test program does not assemble')
    const { layout } = assembled.program
    const stack: Region = { name: 'stack', start: 0x7000n, end: 0x8000n, writable: true }
    const memory = new Memory([
      { name: 'text', start: layout.textBase, end: layout.textEnd, writable: false },
      stack,
    ])
    memory.load(0x7ff0n, [1, 2, 3, 4, 5, 6, 7, 8])
    const registers = createRegisterFile()
    registers.rsp = 0x7ff0n
    registers.rax = 0x10n
    const view: MachineView = {
      program: assembled.program,
      registers,
      flags: { CF: 0, ZF: 0, SF: 0, OF: 0 },
      memory,
      stack,
      osReturnAddress: DEFAULT_OPTIONS.osReturnAddress,
      callStack: [],
      flagsWriter: null,
    }
    return { view, memory }
  }

  it('returns the effects and changes nothing', () => {
    const { view, memory } = viewFor(source('add [rsp], rax', 'ret'))
    const registersBefore = { ...view.registers }
    const result = executeInstruction(view, view.program.instructions[0])
    if (!result.ok) throw new Error('the instruction must run')
    expect(result.effects.memoryWrites).toEqual([
      { address: 0x7ff0n, bytes: [0x11, 2, 3, 4, 5, 6, 7, 8] },
    ])
    expect(result.effects.flagWrites).toEqual({ CF: 0, ZF: 0, SF: 0, OF: 0 })
    expect(result.effects.nextRip).toBe(TEXT + 4n)
    expect(result.effects.outcome).toEqual({ status: 'running' })
    // The machine is untouched.
    expect(view.registers).toEqual(registersBefore)
    expect(memory.peekBytes(0x7ff0n, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(view.flags).toEqual({ CF: 0, ZF: 0, SF: 0, OF: 0 })
  })

  it('lists the register writes in the order they happen', () => {
    const { view } = viewFor(source('pop rsp', 'ret'))
    const result = executeInstruction(view, view.program.instructions[0])
    if (!result.ok) throw new Error('the instruction must run')
    expect(result.effects.registerWrites.map((write) => [write.reg.name, write.value])).toEqual([
      ['rsp', 0x7ff8n],
      ['rsp', 0x0807060504030201n],
    ])
  })

  it('reports a fault as a problem, with nothing to commit', () => {
    const { view } = viewFor(source('mov rax, [rbx]', 'ret'))
    const result = executeInstruction(view, view.program.instructions[0])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem.error.code).toBe('bad-memory-read')
    expect(result.problem.error.line).toBe(4)
    expect(result.problem.summary).toMatch(/0x0/)
  })

  it('gives the same effects every time it is asked', () => {
    const { view } = viewFor(source('imul rax, rax', 'ret'))
    const first = executeInstruction(view, view.program.instructions[0])
    const second = executeInstruction(view, view.program.instructions[0])
    expect(second).toEqual(first)
  })

  it('names every flag in the order CF, ZF, SF, OF', () => {
    expect(FLAG_NAMES).toEqual(['CF', 'ZF', 'SF', 'OF'])
  })
})
