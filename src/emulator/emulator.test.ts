/**
 * The `Emulator` class: the starting state, `step`, `stepBack`, `run`, `reset`,
 * breakpoints, listeners, snapshots, the stack view and the data view
 * (behaviour contract, sections 1, 2, 5, 9 and 10).
 */
import { describe, expect, it } from 'vitest'
import { assemble } from './assembler'
import { createEmulator, Emulator } from './index'
import {
  DEFAULT_OPTIONS,
  LIBRARY_FUNCTIONS,
  REG64_NAMES,
  type EmulatorOptions,
  type MachineState,
  type StackSlot,
  type StepResult,
} from './types'

/* ───────────────────────────── helpers ───────────────────────────── */

const RSP0 = 0x7ffffffddff8n
const TEXT = 0x401126n
const OS = DEFAULT_OPTIONS.osReturnAddress

/** Three header lines, then the given lines: the first given line is LINE 4. */
function source(...lines: string[]): string {
  return ['.intel_syntax noprefix', '.text', 'main:', ...lines, ''].join('\n')
}

function emulatorFor(text: string, options?: EmulatorOptions): Emulator {
  const made = createEmulator(text, options)
  if (!made.ok) throw new Error(made.diagnostics.map((item) => item.message).join('\n'))
  return made.emulator
}

function emulatorOf(lines: string[], options?: EmulatorOptions): Emulator {
  return emulatorFor(source(...lines), options)
}

function steps(emulator: Emulator, count: number): StepResult[] {
  const results: StepResult[] = []
  for (let i = 0; i < count; i++) results.push(emulator.step())
  return results
}

/** A snapshot without its version, to compare two states of the machine. */
function withoutVersion(state: MachineState): Omit<MachineState, 'version'> {
  const { version: _version, ...rest } = state
  return rest
}

/** The stack box at `address`. */
function slotAt(state: MachineState, address: bigint): StackSlot {
  const slot = state.stack.find((candidate) => candidate.address === address)
  if (slot === undefined) throw new Error(`no stack box at 0x${address.toString(16)}`)
  return slot
}

/** Hello World with printf: 9 steps to the end. */
const HELLO = [
  '.intel_syntax noprefix',
  '.text',
  'message:',
  '    .string "Hello World!\\n"',
  'main:',
  '    push rbp',
  '    mov rbp, rsp',
  '    lea rdi, message[rip]',
  '    mov eax, 0',
  '    call printf@PLT',
  '    mov eax, 0',
  '    pop rbp',
  '    ret',
  '',
].join('\n')

/** Reads one number with scanf and prints it. */
const ECHO = [
  '.intel_syntax noprefix',
  '.text',
  'pattern: .string "%d"',
  'report: .string "got %d\\n"',
  'main:',
  '    sub rsp, 8',
  '    lea rsi, [rsp]',
  '    lea rdi, pattern[rip]',
  '    mov eax, 0',
  '    call scanf@PLT',
  '    mov esi, [rsp]',
  '    lea rdi, report[rip]',
  '    mov eax, 0',
  '    call printf@PLT',
  '    add rsp, 8',
  '    mov eax, 0',
  '    ret',
  '',
].join('\n')

/* ───────────────────────────── createEmulator ───────────────────────────── */

describe('createEmulator', () => {
  it('gives an emulator and no diagnostics for a clean program', () => {
    const made = createEmulator(source('ret'))
    expect(made.ok).toBe(true)
    expect(made.emulator).toBeInstanceOf(Emulator)
    expect(made.diagnostics).toEqual([])
  })

  it('passes the warnings of the assembler through unchanged', () => {
    const text = 'mov eax, 1\nret\n'
    const made = createEmulator(text)
    const assembled = assemble(text)
    expect(made.ok).toBe(true)
    expect(made.diagnostics).toEqual(assembled.diagnostics)
    expect(made.diagnostics.map((item) => item.code)).toEqual(['missing-intel-syntax', 'no-main'])
    expect(made.diagnostics.every((item) => item.severity === 'warning')).toBe(true)
  })

  it('gives no emulator and the errors for a program with mistakes', () => {
    const made = createEmulator(source('mov [rax], [rbx]', 'ret'))
    expect(made.ok).toBe(false)
    expect(made.emulator).toBeNull()
    expect(made.diagnostics).toHaveLength(1)
    expect(made.diagnostics[0]).toMatchObject({
      severity: 'error',
      code: 'memory-to-memory',
      line: 4,
    })
  })

  it('uses the same options to assemble and to run', () => {
    const made = createEmulator(source('ret'), { textBase: 0x4000n })
    if (!made.ok) throw new Error('expected success')
    expect(made.emulator.program.entry).toBe(0x4000n)
    expect(made.emulator.getSnapshot().rip).toBe(0x4000n)
  })

  it('never throws, whatever the text is', () => {
    for (const text of ['', '\u0000\u0001', 'main:', '%%%', 'ret ret ret', 'x'.repeat(5000)]) {
      expect(() => createEmulator(text)).not.toThrow()
    }
  })

  it('an emulator can be made from a program directly', () => {
    const assembled = assemble(source('mov eax, 5', 'ret'))
    if (!assembled.ok) throw new Error('expected success')
    const emulator = new Emulator(assembled.program)
    expect(emulator.program).toBe(assembled.program)
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.readRegister('eax')).toBe(5n)
  })
})

/* ─────────────── size messages for `mov`: every line they suggest works ─────────────── */

describe('size messages for `mov` (errors.ts): a student who follows the hint gets no new error', () => {
  /** The message for one line of code, which must be a size mismatch on line 4. */
  function sizeError(line: string): string {
    const made = createEmulator(source(line, 'ret'))
    expect(made.ok).toBe(false)
    expect(made.diagnostics.map((item) => `${item.code} on line ${item.line}`)).toEqual([
      'size-mismatch on line 4',
    ])
    return made.diagnostics[0].message
  }

  /** Does this one line assemble with no error? */
  function assembles(line: string): boolean {
    return createEmulator(source(line, 'ret')).ok
  }

  /**
   * The lines a student writes by following the hint: a line it shows, or the student's
   * own line with the one word it names changed.
   */
  function followHint(line: string, hint: string): string[] {
    const operands = line.slice('mov '.length)
    const lines = [...hint.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1])
      .filter((text) => text.includes(','))
    // "Use `eax` instead of `rax`": the same line with the other register.
    const instead = /Use `(\w+)` instead of `(\w+)`/.exec(hint)
    if (instead !== null) lines.push(`mov ${operands.replace(instead[2], instead[1])}`)
    // "use `movsxd`", "use `movzx` or `movsx`": that instruction in place of `mov`.
    if (hint.includes('use `movsxd`')) lines.push(`movsxd ${operands}`)
    if (hint.includes('use `movzx` or `movsx`')) {
      lines.push(`movzx ${operands}`, `movsx ${operands}`)
    }
    return lines
  }

  it('a 32-bit value into a 64-bit register: the 32-bit name, or `movsxd`', () => {
    expect(sizeError('mov rax, ebx')).toBe(
      'Line 4: `rax` is 64 bits but `ebx` is 32 bits. Both sides of `mov` must be the same size. Use `eax` instead of `rax`: writing `eax` also sets the top 32 bits of `rax` to 0. To keep the sign, use `movsxd`.',
    )
    expect(sizeError('mov rax, dword ptr [rbp-8]')).toBe(
      'Line 4: `rax` is 64 bits but `dword ptr [rbp-8]` is 32 bits. Both sides of `mov` must be the same size. Use `eax` instead of `rax`: writing `eax` also sets the top 32 bits of `rax` to 0. To keep the sign, use `movsxd`.',
    )
    expect(sizeError('mov r8, ebx')).toContain('Use `r8d` instead of `r8`: writing `r8d` also sets')
    // x86-64 has no `movzx` from 32 bits, so the message never suggests it.
    expect(sizeError('mov r8, ebx')).not.toContain('movzx')
    expect(assembles('movzx rax, ebx')).toBe(false)
  })

  it('when the address uses the same register, the message shows the whole line', () => {
    // "Use `eax` instead of `rax`" could be read as `[eax]` too, which is not an address.
    expect(sizeError('mov rax, dword ptr [rax]')).toBe(
      'Line 4: `rax` is 64 bits but `dword ptr [rax]` is 32 bits. Both sides of `mov` must be the same size. Write `mov eax, dword ptr [rax]`: writing `eax` also sets the top 32 bits of `rax` to 0. To keep the sign, use `movsxd`.',
    )
    expect(assembles('mov eax, dword ptr [eax]')).toBe(false)
    expect(sizeError('mov r8, dword ptr [rbx+r8*4]')).toContain(
      'Write `mov r8d, dword ptr [rbx+r8*4]`: writing `r8d` also sets the top 32 bits of `r8` to 0.',
    )
    // An address built from other registers keeps the short hint.
    expect(sizeError('mov r10, dword ptr [r11]')).toContain('Use `r10d` instead of `r10`')
    expect(sizeError('mov r11, dword ptr [rbx+r10*4]')).toContain('Use `r11d` instead of `r11`')
  })

  it('the two lines the hint leads to do what the message says', () => {
    // ebx holds a negative number, -16.
    const rax = (line: string): bigint => {
      const emulator = emulatorOf([line, 'ret'], {
        initialRegisters: { rax: 0x1111222233334444n, rbx: 0xfffffff0n },
      })
      emulator.step()
      return emulator.readRegister('rax')
    }
    const lines = followHint('mov rax, ebx', sizeError('mov rax, ebx'))
    expect(lines).toEqual(['mov eax, ebx', 'movsxd rax, ebx'])
    expect(rax('mov eax, ebx')).toBe(0x00000000fffffff0n) // the top 32 bits are 0
    expect(rax('movsxd rax, ebx')).toBe(0xfffffffffffffff0n) // the sign is kept: still -16
  })

  it('a high byte into a 64-bit register: `movzx` into the 32-bit name', () => {
    expect(sizeError('mov rax, ah')).toBe(
      'Line 4: `rax` is 64 bits but `ah` is 8 bits. Both sides of `mov` must be the same size. Write `movzx eax, ah`: writing `eax` also sets the top 32 bits of `rax` to 0.',
    )
    // x86-64 machine code has no way to write `movzx rax, ah`.
    expect(assembles('movzx rax, ah')).toBe(false)
  })

  it('stays one short line, even with the longest operands of a practice problem', () => {
    // Practice problems show the message, without "Line N: ", as one line under 220 characters.
    for (const line of [
      'mov r15, dword ptr [rbp-16]',
      'mov r10, dword ptr -16[rbp]',
      'mov rdi, ch',
    ]) {
      expect(sizeError(line).replace(/^Line \d+: /, '').length, line).toBeLessThan(220)
    }
  })

  it('a memory destination gets no hint: `movzx` and `movsx` write only registers', () => {
    for (const line of [
      'mov qword ptr [rbp-8], ebx',
      'mov dword ptr [rbp-8], bx',
      'mov qword ptr [rbp-8], al',
    ]) {
      const message = sizeError(line)
      expect(message).toMatch(/Both sides of `mov` must be the same size\.$/)
      expect(message).not.toMatch(/movzx|movsx/)
    }
  })

  it.each([
    'mov rax, ebx',
    'mov r8, ebx',
    'mov r15, r9d',
    'mov rsp, ebx',
    'mov rax, dword ptr [rbp-8]',
    'mov rax, dword ptr [rax]',
    'mov r8, dword ptr [rbx+r8*4]',
    'mov rax, bl',
    'mov rax, bx',
    'mov eax, bx',
    'mov ax, bl',
    'mov eax, byte ptr [rbp-1]',
    'mov rax, word ptr [rbp-2]',
    'mov r8, bl',
    'mov rax, sil',
    'mov rax, ah',
    'mov rdi, ch',
    'mov eax, ah',
    'mov ax, bh',
  ])('`%s`: every line the hint leads to assembles', (line) => {
    const hint = sizeError(line).split('Both sides of `mov` must be the same size.')[1] ?? ''
    expect(hint).not.toBe('')
    const lines = followHint(line, hint)
    expect(lines.length).toBeGreaterThan(0)
    for (const text of lines) expect(assembles(text), text).toBe(true)
  })

  it('other instructions get no hint', () => {
    expect(sizeError('add rax, ebx')).toBe(
      'Line 4: `rax` is 64 bits but `ebx` is 32 bits. Both sides of `add` must be the same size.',
    )
  })
})

/* ───────────────────────────── the starting state ───────────────────────────── */

describe('the starting state', () => {
  it('has every register at 0 except rsp', () => {
    const state = emulatorOf(['ret']).getSnapshot()
    for (const name of REG64_NAMES) {
      expect(state.registers[name], name).toBe(name === 'rsp' ? RSP0 : 0n)
    }
    expect(state.flags).toEqual({ CF: 0, ZF: 0, SF: 0, OF: 0 })
  })

  it('is ready to run the first instruction of main', () => {
    const emulator = emulatorOf(['nop', 'ret'])
    const state = emulator.getSnapshot()
    expect(state).toMatchObject({
      status: 'running',
      stepCount: 0,
      rip: TEXT,
      nextLine: 4,
      inLibrary: null,
      output: '',
      inputRequest: null,
      lastStep: null,
      error: null,
      canStepBack: false,
      breakpoints: [],
      data: [],
    })
    expect(state.rip).toBe(emulator.program.entry)
  })

  it('starts at `main` even when other code comes first', () => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', 'helper:', 'ret', 'main:', 'mov eax, 1', 'ret', ''].join('\n'),
    )
    expect(emulator.getSnapshot().nextLine).toBe(5)
    expect(emulator.getSnapshot().rip).toBe(TEXT + 1n)
  })

  it('holds the fake return address in the box at rsp', () => {
    const emulator = emulatorOf(['ret'])
    expect(emulator.readMemory(RSP0, 8)).toEqual([0x90, 0x9d, 0xc2, 0xf7, 0xff, 0x7f, 0, 0])
    const state = emulator.getSnapshot()
    expect(state.stack).toHaveLength(1)
    expect(state.stack[0]).toEqual({
      address: RSP0,
      value: OS,
      bytes: [0x90, 0x9d, 0xc2, 0xf7, 0xff, 0x7f, 0, 0],
      label: expect.stringContaining('return address') as string,
      kind: 'return-address',
      isRsp: true,
      isRbp: false,
      dead: false,
      changed: false,
    })
  })

  it('has one call frame: the OS called main', () => {
    const state = emulatorOf(['ret']).getSnapshot()
    expect(state.callStack).toEqual([
      { functionName: 'main', callLine: 0, returnAddress: OS, slotAddress: RSP0 },
    ])
  })

  it('names no function when the program has no `main`', () => {
    const emulator = emulatorFor('.intel_syntax noprefix\nmov eax, 1\nret\n')
    expect(emulator.getSnapshot().callStack[0].functionName).toBeNull()
    expect(emulator.getSnapshot().nextLine).toBe(2)
  })

  it('applies initialRegisters, initialFlags and initialRsp', () => {
    const emulator = emulatorOf(['ret'], {
      initialRegisters: { rax: 5n, r15: 0xffffffffffffffffn, rsp: 0x7ffffffdd000n },
      initialFlags: { CF: 1, SF: 1 },
    })
    const state = emulator.getSnapshot()
    expect(state.registers.rax).toBe(5n)
    expect(state.registers.r15).toBe(0xffffffffffffffffn)
    expect(state.registers.rsp).toBe(0x7ffffffdd000n)
    expect(state.flags).toEqual({ CF: 1, ZF: 0, SF: 1, OF: 0 })
    expect(emulator.readMemory(0x7ffffffdd000n, 1)).toEqual([0x90])
  })

  it('initialRsp wins over initialRegisters.rsp', () => {
    const emulator = emulatorOf(['ret'], {
      initialRsp: 0x7ffffffdd100n,
      initialRegisters: { rsp: 0x7ffffffdd000n },
    })
    expect(emulator.readRegister('rsp')).toBe(0x7ffffffdd100n)
    expect(emulator.getSnapshot().callStack[0].slotAddress).toBe(0x7ffffffdd100n)
  })

  it('rsp follows stackBase: 8 below it', () => {
    const emulator = emulatorOf(['ret'], { stackBase: 0x7000n })
    expect(emulator.readRegister('rsp')).toBe(0x6ff8n)
    expect(emulator.run().reason).toBe('halted')
  })

  it('loads initialMemory cells in little-endian order and labels their boxes', () => {
    const emulator = emulatorOf(['mov eax, -8[rsp]', 'ret'], {
      initialMemory: [
        { address: RSP0 - 8n, bytes: 4, value: 0x11223344n, label: 'x' },
        { address: RSP0 - 16n, bytes: 8, value: 7n },
        { address: RSP0 - 24n, bytes: 1, value: 0x1ffn },
      ],
    })
    expect(emulator.readMemory(RSP0 - 8n, 8)).toEqual([
      0x44,
      0x33,
      0x22,
      0x11,
      null,
      null,
      null,
      null,
    ])
    expect(emulator.readMemory(RSP0 - 24n, 2)).toEqual([0xff, null])
    const state = emulator.getSnapshot()
    expect(slotAt(state, RSP0 - 8n)).toMatchObject({
      label: 'x',
      kind: 'local',
      value: 0x11223344n,
    })
    expect(slotAt(state, RSP0 - 16n)).toMatchObject({ label: null, kind: 'value', value: 7n })
    expect(slotAt(state, RSP0 - 24n)).toMatchObject({ label: null, kind: 'value', value: 0xffn })
    emulator.step()
    expect(emulator.readRegister('rax')).toBe(0x11223344n)
  })

  it('uses a different OS return address when asked', () => {
    const emulator = emulatorOf(['ret'], { osReturnAddress: 0x1234n })
    expect(emulator.getSnapshot().stack[0].value).toBe(0x1234n)
    expect(emulator.step().status).toBe('halted')
    expect(emulator.getSnapshot().rip).toBe(0x1234n)
  })

  it('labelStartBox: false leaves the label of the starting box to the practice problem', () => {
    // A practice problem shows 0x34 in the box at rsp. It stores that value there as the
    // "OS" return address, so the box must not be called a return address.
    const options: EmulatorOptions = { osReturnAddress: 0x34n, labelStartBox: false }
    const plain = emulatorOf(['mov rax, [rsp]', 'ret'], options)
    expect(plain.getSnapshot().stack[0]).toMatchObject({
      address: RSP0,
      value: 0x34n,
      label: null,
      kind: 'value',
      isRsp: true,
    })
    plain.step()
    expect(plain.readRegister('rax')).toBe(0x34n)
    // The `ret` that pops the value still ends the program.
    expect(plain.step().status).toBe('halted')

    // With an initialMemory cell there, the box shows that cell's label.
    const named = emulatorOf(['ret'], {
      ...options,
      initialMemory: [{ address: RSP0, bytes: 8, value: 0x34n, label: 'x' }],
    })
    expect(named.getSnapshot().stack[0]).toMatchObject({ value: 0x34n, label: 'x', kind: 'local' })

    // Reset gives the same start, and the default still labels the box.
    plain.reset()
    expect(plain.getSnapshot().stack[0]).toMatchObject({ label: null, kind: 'value' })
    expect(emulatorOf(['ret']).getSnapshot().stack[0].kind).toBe('return-address')
  })

  it('loads the data of the program', () => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', '.data', 'numbers: .long 1, 2', '.text', 'main:', 'ret', ''].join(
        '\n',
      ),
    )
    expect(emulator.readMemory(0x404030n, 8)).toEqual([1, 0, 0, 0, 2, 0, 0, 0])
  })

  it('does not mind strange option values', () => {
    const emulator = emulatorOf(['push rax', 'pop rax', 'ret'], {
      stackSize: -5,
      maxSteps: Number.NaN,
      initialRegisters: { rax: -1n },
    })
    expect(emulator.readRegister('rax')).toBe(0xffffffffffffffffn)
    const run = emulator.run()
    expect(run.reason).toBe('halted')
    expect(run.stepsRun).toBe(3)
  })
})

describe('small layouts', () => {
  const small: EmulatorOptions = {
    textBase: 0x4000n,
    stackBase: 0x1000n,
    initialRsp: 0x200n,
    osReturnAddress: 0x3ff0n,
  }

  it('runs a program at small, easy addresses', () => {
    const emulator = emulatorOf(['push rax', 'call helper', 'pop rbx', 'ret', 'helper:', 'ret'], {
      ...small,
      initialRegisters: { rax: 7n },
    })
    expect(emulator.getSnapshot().rip).toBe(0x4000n)
    expect(emulator.readRegister('rsp')).toBe(0x200n)
    emulator.step()
    expect(emulator.readRegister('rsp')).toBe(0x1f8n)
    emulator.step()
    expect(emulator.readRegister('rsp')).toBe(0x1f0n)
    // The call is at 0x4001 and is 5 bytes long.
    expect(emulator.readMemory(0x1f0n, 8)).toEqual([0x06, 0x40, 0, 0, 0, 0, 0, 0])
    const run = emulator.run()
    expect(run.reason).toBe('halted')
    const state = emulator.getSnapshot()
    expect(state.registers.rbx).toBe(7n)
    expect(state.registers.rsp).toBe(0x208n)
    expect(state.rip).toBe(0x3ff0n)
  })

  it('a `ret` that pops exactly the OS return address ends the program', () => {
    const emulator = emulatorOf(['ret'], small)
    const step = emulator.step()
    expect(step.status).toBe('halted')
    expect(step.error).toBeNull()
  })

  it('the stack reaches down to 0x40 and not below', () => {
    const emulator = emulatorOf(['top:', 'push rax', 'jmp top'], small)
    const run = emulator.run()
    expect(run.reason).toBe('error')
    const state = emulator.getSnapshot()
    expect(state.error?.code).toBe('stack-overflow')
    expect(state.registers.rsp).toBe(0x40n)
    // (0x200 - 0x40) / 8 = 56 pushes fit; the 57th does not.
    expect(run.stepsRun).toBe(56 * 2 + 1)
    expect(emulator.readMemory(0x40n, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('a NULL pointer faults, also when the stack would reach address 0', () => {
    // No stackSize: 1 MiB below stackBase 0x1000 would reach 0, but 0x0–0x3f stay unmapped.
    const read = emulatorOf(['mov rax, qword ptr [rbx]', 'ret'], small)
    // rbp = 0 is not in the stack, so the first view has only the box at rsp.
    expect(read.getSnapshot().stack).toHaveLength(1)
    expect(read.step().error?.code).toBe('bad-memory-read')
    const write = emulatorOf(['mov qword ptr [rbx+8], 7', 'ret'], small)
    expect(write.step().error?.code).toBe('bad-memory-write')
    expect(write.readMemory(8n, 8)).toEqual(new Array(8).fill(null))
  })

  it('shows small addresses in full in the explanations', () => {
    const emulator = emulatorOf(['push rax', 'ret'], small)
    const step = emulator.step()
    expect(step.explanation).toContain('0x200')
    expect(step.explanation).toContain('0x1f8')
  })

  it('reads a little above the starting rsp', () => {
    const emulator = emulatorOf(['mov rax, 0x100[rsp]', 'ret'], small)
    expect(emulator.step().status).toBe('running')
  })
})

describe('the stack region: `stackSize` bytes below `stackBase` (types.ts)', () => {
  /** The practice "small world" (practice/gen/helpers.ts): the stack may use 0x40 … 0xfff. */
  const practice: EmulatorOptions = {
    textBase: 0x4000n,
    rodataBase: 0x6000n,
    dataBase: 0x7000n,
    stackBase: 0x1000n,
    stackSize: 0xfc0,
    initialRsp: 0x200n,
    osReturnAddress: 0x3ff0n,
  }

  it('a fresh stack view holds only the box of the starting rsp (rbp = 0 is not in the stack)', () => {
    const state = emulatorOf(['ret'], practice).getSnapshot()
    expect(state.stack.map((slot) => slot.address)).toEqual([0x200n])
    expect(state.stack.some((slot) => slot.isRbp)).toBe(false)
  })

  it('a NULL pointer is a segmentation fault, for a read and for a write', () => {
    const read = emulatorOf(['mov rax, qword ptr [rbx]', 'ret'], practice).step()
    expect(read.error?.code).toBe('bad-memory-read')
    expect(read.error?.message).toContain('0x0')
    const write = emulatorOf(['mov qword ptr [rbx], 7', 'ret'], practice)
    expect(write.step().error?.code).toBe('bad-memory-write')
    expect(write.readMemory(0n, 1)).toEqual([null])
  })

  it('the stack ends at stackBase − stackSize: a push loop stops at 0x40', () => {
    const emulator = emulatorOf(['top:', 'push rax', 'jmp top'], practice)
    const run = emulator.run()
    expect(run.reason).toBe('error')
    const state = emulator.getSnapshot()
    expect(state.error?.code).toBe('stack-overflow')
    expect(state.registers.rsp).toBe(0x40n)
    expect(state.stack.at(-1)?.address).toBe(0x40n)
    expect(state.stack.every((slot) => slot.address >= 0x40n)).toBe(true)
  })

  it('the default layout is the same as before: 1 MiB below the stack start', () => {
    const lowest = DEFAULT_OPTIONS.stackBase - 0x100000n
    const inside = emulatorOf(['mov rax, [rbx]', 'ret'], { initialRegisters: { rbx: lowest } })
    expect(inside.step().status).toBe('running')
    const below = emulatorOf(['mov rax, [rbx]', 'ret'], { initialRegisters: { rbx: lowest - 8n } })
    expect(below.step().error?.code).toBe('bad-memory-read')
  })

  it('always holds the box of the starting rsp, even when that is below stackBase − stackSize', () => {
    const emulator = emulatorOf(['mov rax, [rsp]', 'ret'], {
      stackBase: 0x8000n,
      stackSize: 0x10,
      initialRsp: 0x100n,
    })
    expect(emulator.step().status).toBe('running')
    expect(emulator.readRegister('rax')).toBe(OS)
  })

  it('correct code warns about alignment only when the starting rsp ends in 0, not in 8', () => {
    // Like a real machine, a correct function lines rsp up to 16 at its calls only when
    // rsp ended in 8 when it started. The practice small world starts at 0x200 (ends in
    // 0), so correct code there gets the warning; 0x1f8 or 0x208 would not.
    const program = [
      '.intel_syntax noprefix',
      '.text',
      'msg: .string "hi"',
      'main:',
      'push rbp',
      'mov rbp, rsp',
      'sub rsp, 16',
      'lea rdi, msg[rip]',
      'call puts@PLT',
      'leave',
      'ret',
      '',
    ].join('\n')
    const notesAtCall = (initialRsp: bigint): { rsp: bigint; notes: string[] } => {
      const emulator = emulatorFor(program, { ...practice, initialRsp, clobberCallerSaved: false })
      for (let i = 0; i < 20; i++) {
        const rsp = emulator.readRegister('rsp')
        const step = emulator.step()
        if (step.text.startsWith('call')) return { rsp, notes: step.notes.map((note) => note.text) }
      }
      throw new Error('no call')
    }
    expect(notesAtCall(0x200n)).toEqual({
      rsp: 0x1e8n,
      notes: [
        expect.stringMatching(/^rsp was 0x1e8 before this `call`\. That is not a multiple of 16/),
      ],
    })
    expect(notesAtCall(0x1f8n)).toEqual({ rsp: 0x1e0n, notes: [] })
    expect(notesAtCall(0x208n)).toEqual({ rsp: 0x1f0n, notes: [] })
    // The whole program runs to the end in each case.
    for (const initialRsp of [0x200n, 0x1f8n, 0x208n]) {
      const emulator = emulatorFor(program, { ...practice, initialRsp })
      expect(emulator.run().reason).toBe('halted')
      expect(emulator.getSnapshot().output).toBe('hi\n')
    }
  })
})

/* ──────────────────────────────── step() ──────────────────────────────── */

describe('step()', () => {
  it('runs one instruction and counts the step', () => {
    const emulator = emulatorOf(['mov eax, 7', 'ret'])
    const step = emulator.step()
    expect(step.executed).toBe(true)
    expect(step.stepNumber).toBe(1)
    expect(step.kind).toBe('instruction')
    expect(step.status).toBe('running')
    const state = emulator.getSnapshot()
    expect(state.stepCount).toBe(1)
    expect(state.lastStep).toBe(step)
    expect(state.nextLine).toBe(5)
    expect(state.canStepBack).toBe(true)
  })

  it('on a program that has ended: runs nothing and says so', () => {
    const emulator = emulatorOf(['ret'])
    const last = emulator.step()
    const before = emulator.getSnapshot()
    const again = emulator.step()
    expect(again.executed).toBe(false)
    expect(again.status).toBe('halted')
    expect(again.error).toBeNull()
    expect(again.stepNumber).toBe(1)
    expect(again.explanation).toMatch(/ended/)
    expect(again.diff).toEqual({
      registers: [],
      flags: [],
      memory: [],
      rip: { before: OS, after: OS },
      written: { registers: [], flags: [], memory: [] },
    })
    // Nothing changed: the same snapshot object, and the last step is still the `ret`.
    expect(emulator.getSnapshot()).toBe(before)
    expect(emulator.getSnapshot().lastStep).toBe(last)
  })

  it('on a program that stopped with an error: runs nothing and repeats the error', () => {
    const emulator = emulatorOf(['mov rax, [rbx]', 'ret'])
    const failed = emulator.step()
    const before = emulator.getSnapshot()
    const again = emulator.step()
    expect(again.executed).toBe(false)
    expect(again.status).toBe('error')
    expect(again.error).toEqual(failed.error)
    expect(again.explanation).toBe(failed.error?.message)
    expect(emulator.getSnapshot()).toBe(before)
  })

  it('a faulting step still counts, with an empty diff', () => {
    const emulator = emulatorOf(['mov rax, [rbx]', 'ret'])
    const failed = emulator.step()
    expect(failed.executed).toBe(true)
    expect(failed.stepNumber).toBe(1)
    expect(failed.diff.rip).toEqual({ before: TEXT, after: TEXT })
    const state = emulator.getSnapshot()
    expect(state.stepCount).toBe(1)
    expect(state.rip).toBe(TEXT)
    expect(state.nextLine).toBe(4)
    expect(state.error).toEqual(failed.error)
  })

  it('a library call takes two steps: the `call`, then the library function', () => {
    const emulator = emulatorFor(HELLO)
    steps(emulator, 4)
    const call = emulator.step()
    expect(call.kind).toBe('instruction')
    expect(call.text).toBe('call printf@PLT')
    expect(call.line).toBe(10)
    const inside = emulator.getSnapshot()
    expect(inside.inLibrary).toEqual({ name: 'printf', callLine: 10 })
    expect(inside.nextLine).toBeNull()
    expect(inside.rip).toBe(LIBRARY_FUNCTIONS.printf)
    expect(inside.output).toBe('')
    expect(inside.registers.rsp).toBe(RSP0 - 16n)

    const library = emulator.step()
    expect(library.kind).toBe('library')
    expect(library.line).toBe(10)
    expect(library.address).toBe(LIBRARY_FUNCTIONS.printf)
    expect(library.text).toContain('printf')
    expect(library.text).toContain('library code')
    expect(library.output).toBe('Hello World!\n')
    expect(library.stepNumber).toBe(6)
    expect(library.diff.rip).toEqual({ before: LIBRARY_FUNCTIONS.printf, after: call.address + 5n })
    const after = emulator.getSnapshot()
    expect(after.inLibrary).toBeNull()
    expect(after.nextLine).toBe(11)
    expect(after.output).toBe('Hello World!\n')
    expect(after.registers.rsp).toBe(RSP0 - 8n)
    expect(after.registers.rax).toBe(13n)
  })

  it('while scanf waits for input: runs nothing, again and again', () => {
    const emulator = emulatorFor(ECHO)
    steps(emulator, 5)
    const waiting = emulator.step()
    expect(waiting.executed).toBe(false)
    expect(waiting.status).toBe('waiting-input')
    expect(waiting.kind).toBe('library')
    expect(waiting.line).toBe(10)
    // A step that did not run has the number of the last step that did.
    expect(waiting.stepNumber).toBe(5)
    const state = emulator.getSnapshot()
    expect(state.status).toBe('waiting-input')
    expect(state.inputRequest?.prompt).toMatch(/\S+ \S+/)
    expect(state.stepCount).toBe(5)
    const again = emulator.step()
    expect(again.executed).toBe(false)
    expect(again.status).toBe('waiting-input')
    expect(emulator.getSnapshot()).toBe(state)
  })

  it('returns results that cannot be changed from outside', () => {
    const emulator = emulatorOf(['push rax', 'ret'])
    const step = emulator.step()
    expect(Object.isFrozen(step)).toBe(true)
    expect(Object.isFrozen(step.diff)).toBe(true)
    expect(Object.isFrozen(step.diff.registers)).toBe(true)
    expect(Object.isFrozen(step.diff.memory[0].after)).toBe(true)
    expect(Object.isFrozen(step.notes)).toBe(true)
  })

  it('never throws, even when the program is damaged', () => {
    const assembled = assemble(source('mov eax, 1', 'ret'))
    if (!assembled.ok) throw new Error('expected success')
    // Break the program on purpose: an instruction with no operands at all.
    assembled.program.instructions[0].operands = []
    const emulator = new Emulator(assembled.program)
    let step: StepResult | undefined
    expect(() => {
      step = emulator.step()
    }).not.toThrow()
    expect(step?.status).toBe('error')
    // Its own code: it is not the program's mistake, and not a library error.
    expect(step?.error?.code).toBe('internal')
    expect(step?.error?.message).toMatch(/internal problem/)
    expect(step?.error?.message).toMatch(/not in your program/)
    expect(emulator.getSnapshot().status).toBe('error')
    expect(() => emulator.run()).not.toThrow()
    expect(emulator.stepBack()).toBe(true)
    expect(emulator.getSnapshot().status).toBe('running')
  })
})

/* ──────────────────────────────── stepBack() ──────────────────────────────── */

describe('stepBack()', () => {
  it('returns false and changes nothing at the start', () => {
    const emulator = emulatorOf(['ret'])
    const before = emulator.getSnapshot()
    expect(emulator.stepBack()).toBe(false)
    expect(emulator.getSnapshot()).toBe(before)
  })

  it.each<[string, string[], EmulatorOptions | undefined]>([
    ['a register write', ['mov eax, 7', 'ret'], { initialRegisters: { rax: 0x1111222233334444n } }],
    ['flags', ['cmp eax, 1', 'ret'], { initialFlags: { OF: 1 } }],
    ['a push', ['push rax', 'ret'], undefined],
    ['a pop', ['pop rax', 'ret'], undefined],
    ['a memory write', ['mov qword ptr [rsp], 5', 'ret'], undefined],
    ['a write to a box that was never written', ['mov byte ptr -1[rsp], 5', 'ret'], undefined],
    ['a jump', ['jmp next', 'next:', 'ret'], undefined],
    ['a call', ['call helper', 'ret', 'helper:', 'ret'], undefined],
    ['a call into the library', ['call puts@PLT', 'ret'], undefined],
    ['the step that ends the program', ['ret'], undefined],
    ['a faulting step', ['mov rax, [rbx]', 'ret'], undefined],
    ['a step that runs past the end', ['mov eax, 1'], undefined],
    ['a bad jump', ['jmp nowhere', 'nowhere:'], undefined],
    ['lea with an `.equ` name', ['.equ x, -8', 'lea rax, x[rsp]', 'ret'], undefined],
    ['leave', ['leave', 'ret'], { initialRegisters: { rbp: RSP0 } }],
  ])('undoes %s exactly', (_what, lines, options) => {
    const emulator = emulatorOf(lines, options)
    const fresh = emulator.getSnapshot()
    const step = emulator.step()
    expect(step.executed).toBe(true)
    expect(emulator.getSnapshot()).not.toBe(fresh)
    expect(emulator.stepBack()).toBe(true)
    const back = emulator.getSnapshot()
    expect(withoutVersion(back)).toEqual(withoutVersion(fresh))
    expect(back.version).toBeGreaterThan(fresh.version)
    expect(back.lastStep).toBeNull()
    expect(back.canStepBack).toBe(false)
    // Stepping forward again does the same thing again.
    const again = emulator.step()
    expect(again).toEqual(step)
  })

  it('a byte that was never written becomes unwritten again', () => {
    const emulator = emulatorOf(['push rax', 'ret'], { initialRegisters: { rax: 0x55n } })
    emulator.step()
    expect(emulator.readMemory(RSP0 - 8n, 1)).toEqual([0x55])
    emulator.stepBack()
    expect(emulator.readMemory(RSP0 - 8n, 8)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    expect(emulator.getSnapshot().stack).toHaveLength(1)
  })

  it('goes back one step at a time: lastStep becomes the step before', () => {
    const emulator = emulatorOf(['mov eax, 1', 'mov ebx, 2', 'mov ecx, 3', 'ret'])
    const [first, second] = steps(emulator, 3)
    emulator.stepBack()
    expect(emulator.getSnapshot().lastStep).toBe(second)
    expect(emulator.getSnapshot().stepCount).toBe(2)
    expect(emulator.readRegister('rcx')).toBe(0n)
    emulator.stepBack()
    expect(emulator.getSnapshot().lastStep).toBe(first)
    expect(emulator.readRegister('rbx')).toBe(0n)
    emulator.stepBack()
    expect(emulator.getSnapshot().lastStep).toBeNull()
    expect(emulator.stepBack()).toBe(false)
  })

  it('every state on the way back equals the state on the way forward', () => {
    const emulator = emulatorFor(HELLO)
    const forward: MachineState[] = [emulator.getSnapshot()]
    while (emulator.step().executed) forward.push(emulator.getSnapshot())
    expect(forward).toHaveLength(10)
    for (let i = forward.length - 2; i >= 0; i--) {
      expect(emulator.stepBack()).toBe(true)
      expect(withoutVersion(emulator.getSnapshot()), `after going back to step ${i}`).toEqual(
        withoutVersion(forward[i]),
      )
    }
    expect(emulator.stepBack()).toBe(false)
  })

  it('takes back the output of a library step', () => {
    const emulator = emulatorFor(HELLO)
    steps(emulator, 6)
    expect(emulator.getSnapshot().output).toBe('Hello World!\n')
    emulator.stepBack()
    const state = emulator.getSnapshot()
    expect(state.output).toBe('')
    expect(state.inLibrary).toEqual({ name: 'printf', callLine: 10 })
    expect(state.rip).toBe(LIBRARY_FUNCTIONS.printf)
    expect(state.registers.rdi).toBe(0x402010n)
  })

  it('takes back an error and a halt', () => {
    const failing = emulatorOf(['push 5', 'ret'])
    steps(failing, 2)
    expect(failing.getSnapshot().status).toBe('error')
    failing.stepBack()
    expect(failing.getSnapshot()).toMatchObject({ status: 'running', error: null, nextLine: 5 })

    const ending = emulatorOf(['ret'])
    ending.step()
    expect(ending.getSnapshot().callStack).toEqual([])
    ending.stepBack()
    expect(ending.getSnapshot().status).toBe('running')
    expect(ending.getSnapshot().callStack).toHaveLength(1)
  })

  it('keeps the input that was given: stepping forward reads it again without asking', () => {
    const emulator = emulatorFor(ECHO)
    steps(emulator, 6)
    expect(emulator.getSnapshot().status).toBe('waiting-input')
    emulator.provideInput('42')
    const scanf = emulator.step()
    expect(scanf.executed).toBe(true)
    expect(emulator.readRegister('eax')).toBe(1n)

    expect(emulator.stepBack()).toBe(true)
    const back = emulator.getSnapshot()
    expect(back.status).toBe('running')
    expect(back.inputRequest).toBeNull()
    expect(back.inLibrary).toEqual({ name: 'scanf', callLine: 10 })
    expect(emulator.readMemory(RSP0 - 8n, 4)).toEqual([null, null, null, null])

    const again = emulator.step()
    expect(again.executed).toBe(true)
    expect(again).toEqual(scanf)
    expect(emulator.readMemory(RSP0 - 8n, 4)).toEqual([42, 0, 0, 0])
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe('got 42\n')
  })

  it('going back from "waiting for input" undoes the `call`', () => {
    const emulator = emulatorFor(ECHO)
    steps(emulator, 4)
    const beforeCall = emulator.getSnapshot()
    steps(emulator, 2)
    expect(emulator.getSnapshot().status).toBe('waiting-input')
    expect(emulator.stepBack()).toBe(true)
    expect(withoutVersion(emulator.getSnapshot())).toEqual(withoutVersion(beforeCall))
  })

  it('remembers at least the last 20 000 steps', () => {
    const emulator = emulatorOf(['top:', 'inc rax', 'jmp top'], { maxSteps: 30_000 })
    expect(emulator.run().stepsRun).toBe(30_000)
    expect(emulator.readRegister('rax')).toBe(15_000n)
    let undone = 0
    while (undone < 20_000 && emulator.stepBack()) undone++
    expect(undone).toBe(20_000)
    expect(emulator.getSnapshot().stepCount).toBe(10_000)
    expect(emulator.readRegister('rax')).toBe(5_000n)
  })
})

/* ──────────────────────────────── run() ──────────────────────────────── */

describe('run()', () => {
  it("stops with 'halted' when the program ends", () => {
    const emulator = emulatorFor(HELLO)
    const run = emulator.run()
    expect(run.reason).toBe('halted')
    expect(run.stepsRun).toBe(9)
    expect(run.message).toMatch(/^[A-Z].*\.$/)
    expect(emulator.getSnapshot().output).toBe('Hello World!\n')
  })

  it("stops with 'error' when the program fails", () => {
    const emulator = emulatorOf(['mov eax, 1', 'mov rax, [rbx]', 'ret'])
    const run = emulator.run()
    expect(run.reason).toBe('error')
    expect(run.stepsRun).toBe(2)
    expect(run.message).toMatch(/line 5/)
    expect(emulator.getSnapshot().error?.code).toBe('bad-memory-read')
  })

  it("stops with 'waiting-input' when scanf needs input, and goes on after it", () => {
    const emulator = emulatorFor(ECHO)
    const first = emulator.run()
    expect(first.reason).toBe('waiting-input')
    expect(first.stepsRun).toBe(5)
    expect(emulator.getSnapshot().inputRequest).not.toBeNull()

    // Still no input: nothing runs.
    const still = emulator.run()
    expect(still.reason).toBe('waiting-input')
    expect(still.stepsRun).toBe(0)

    emulator.provideInput('7\n')
    expect(emulator.getSnapshot().status).toBe('running')
    expect(emulator.getSnapshot().inputRequest).toBeNull()
    const second = emulator.run()
    expect(second.reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe('got 7\n')
  })

  it("stops with 'step-limit' in a loop that never ends", () => {
    const emulator = emulatorOf(['top:', 'jmp top'])
    const run = emulator.run()
    expect(run.reason).toBe('step-limit')
    expect(run.stepsRun).toBe(10_000)
    expect(run.message).toContain('loop')
    expect(emulator.getSnapshot().status).toBe('running')
    // Run again: another 10 000 steps.
    expect(emulator.run().stepsRun).toBe(10_000)
    expect(emulator.getSnapshot().stepCount).toBe(20_000)
  })

  it('uses options.maxSteps', () => {
    const emulator = emulatorOf(['top:', 'jmp top'], { maxSteps: 25 })
    const run = emulator.run()
    expect(run).toMatchObject({ reason: 'step-limit', stepsRun: 25 })
    expect(run.message).toContain('25')
  })

  it("stops with 'breakpoint' before the line with the breakpoint", () => {
    const emulator = emulatorOf(['mov eax, 1', 'mov ebx, 2', 'mov ecx, 3', 'ret'])
    emulator.setBreakpoints([6])
    const run = emulator.run()
    expect(run.reason).toBe('breakpoint')
    expect(run.stepsRun).toBe(2)
    expect(run.message).toContain('6')
    const state = emulator.getSnapshot()
    expect(state.nextLine).toBe(6)
    expect(state.registers.rcx).toBe(0n)
    expect(state.status).toBe('running')
  })

  it('Run while standing on a breakpoint moves on', () => {
    const emulator = emulatorOf(['top:', 'inc eax', 'cmp eax, 3', 'jne top', 'ret'])
    emulator.setBreakpoints([5])
    // Line 5 is where the program starts: the first run still runs.
    const first = emulator.run()
    expect(first).toMatchObject({ reason: 'breakpoint', stepsRun: 3 })
    expect(emulator.readRegister('eax')).toBe(1n)
    const second = emulator.run()
    expect(second).toMatchObject({ reason: 'breakpoint', stepsRun: 3 })
    expect(emulator.readRegister('eax')).toBe(2n)
    const third = emulator.run()
    expect(third).toMatchObject({ reason: 'halted', stepsRun: 4 })
  })

  it('runs 0 steps on a program that has ended or failed', () => {
    const ended = emulatorOf(['ret'])
    ended.run()
    expect(ended.run()).toMatchObject({ reason: 'halted', stepsRun: 0 })

    const failed = emulatorOf(['mov rax, [rbx]'])
    failed.run()
    const again = failed.run()
    expect(again).toMatchObject({ reason: 'error', stepsRun: 0 })
    expect(again.message).toMatch(/\.$/)
  })

  it('counts a library step as a step, and checks breakpoints only for instructions', () => {
    const emulator = emulatorFor(HELLO)
    // Line 10 is the `call printf@PLT`. The library step has the same line.
    emulator.setBreakpoints([10])
    const first = emulator.run()
    expect(first).toMatchObject({ reason: 'breakpoint', stepsRun: 4 })
    const second = emulator.run()
    // The call, the library step and the rest: no second stop on line 10.
    expect(second).toMatchObject({ reason: 'halted', stepsRun: 5 })
  })

  it('10 000 steps take well under a second', () => {
    const emulator = emulatorOf([
      'top:',
      'push rax',
      'add qword ptr [rsp], 3',
      'pop rbx',
      'inc rax',
      'cmp rax, rbx',
      'jmp top',
    ])
    const started = performance.now()
    const run = emulator.run()
    const elapsed = performance.now() - started
    expect(run.stepsRun).toBe(10_000)
    expect(elapsed).toBeLessThan(500)
    // The snapshot is built once, after the run.
    expect(emulator.getSnapshot().stepCount).toBe(10_000)
  })
})

/* ──────────────────────────────── reset() ──────────────────────────────── */

describe('reset()', () => {
  it('goes back to the starting state', () => {
    const emulator = emulatorFor(HELLO, { initialRegisters: { rbx: 9n } })
    const fresh = emulator.getSnapshot()
    emulator.run()
    emulator.reset()
    const state = emulator.getSnapshot()
    expect(withoutVersion(state)).toEqual(withoutVersion(fresh))
    expect(state.version).toBeGreaterThan(fresh.version)
    expect(emulator.stepBack()).toBe(false)
    expect(emulator.readMemory(RSP0 - 8n, 1)).toEqual([null])
    // And the program runs again from the start.
    expect(emulator.run()).toMatchObject({ reason: 'halted', stepsRun: 9 })
  })

  it('keeps the breakpoints', () => {
    const emulator = emulatorOf(['nop', 'nop', 'ret'])
    emulator.setBreakpoints([5, 6])
    emulator.run()
    emulator.reset()
    expect(emulator.getSnapshot().breakpoints).toEqual([5, 6])
    expect(emulator.run().reason).toBe('breakpoint')
  })

  it('forgets the input that was given, but keeps options.stdin', () => {
    const typed = emulatorFor(ECHO)
    typed.run()
    typed.provideInput('5')
    typed.run()
    expect(typed.getSnapshot().output).toBe('got 5\n')
    typed.reset()
    expect(typed.run().reason).toBe('waiting-input')

    const given = emulatorFor(ECHO, { stdin: '8\n' })
    expect(given.run().reason).toBe('halted')
    given.reset()
    expect(given.run().reason).toBe('halted')
    expect(given.getSnapshot().output).toBe('got 8\n')
  })

  it('clears an error and a changed data area', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'value: .quad 1',
        '.text',
        'main:',
        'mov qword ptr value[rip], 9',
        'mov rax, [rbx]',
        '',
      ].join('\n'),
    )
    emulator.run()
    expect(emulator.getSnapshot().status).toBe('error')
    expect(emulator.getSnapshot().data[0].values).toEqual([9n])
    emulator.reset()
    expect(emulator.getSnapshot().status).toBe('running')
    expect(emulator.getSnapshot().error).toBeNull()
    expect(emulator.getSnapshot().data[0].values).toEqual([1n])
  })
})

/* ──────────────────────────────── breakpoints ──────────────────────────────── */

describe('breakpoints', () => {
  it('setBreakpoints replaces the set: sorted, no duplicates', () => {
    const emulator = emulatorOf(['ret'])
    emulator.setBreakpoints([9, 4, 7, 4, 9])
    expect(emulator.getSnapshot().breakpoints).toEqual([4, 7, 9])
    emulator.setBreakpoints(new Set([12]))
    expect(emulator.getSnapshot().breakpoints).toEqual([12])
    emulator.setBreakpoints([])
    expect(emulator.getSnapshot().breakpoints).toEqual([])
  })

  it('toggleBreakpoint flips one line', () => {
    const emulator = emulatorOf(['ret'])
    emulator.toggleBreakpoint(8)
    emulator.toggleBreakpoint(3)
    expect(emulator.getSnapshot().breakpoints).toEqual([3, 8])
    emulator.toggleBreakpoint(8)
    expect(emulator.getSnapshot().breakpoints).toEqual([3])
  })

  it('a line without an instruction is accepted and never hit', () => {
    const emulator = emulatorOf(['mov eax, 1', '# just a comment', 'ret'])
    emulator.setBreakpoints([1, 5, 99])
    expect(emulator.getSnapshot().breakpoints).toEqual([1, 5, 99])
    expect(emulator.run()).toMatchObject({ reason: 'halted', stepsRun: 2 })
  })

  it('stepping ignores breakpoints', () => {
    const emulator = emulatorOf(['mov eax, 1', 'ret'])
    emulator.setBreakpoints([4, 5])
    expect(emulator.step().executed).toBe(true)
    expect(emulator.step().status).toBe('halted')
  })

  it('stops every time the loop comes round', () => {
    const emulator = emulatorOf(['mov ecx, 3', 'top:', 'dec ecx', 'jne top', 'ret'])
    emulator.setBreakpoints([6])
    const stops: bigint[] = []
    for (;;) {
      const run = emulator.run()
      if (run.reason !== 'breakpoint') break
      stops.push(emulator.readRegister('ecx'))
    }
    expect(stops).toEqual([3n, 2n, 1n])
  })
})

/* ──────────────────────────────── listeners ──────────────────────────────── */

describe('subscribe()', () => {
  it('calls the listener after every change', () => {
    const emulator = emulatorOf(['mov eax, 1', 'ret'])
    let calls = 0
    emulator.subscribe(() => calls++)
    emulator.step()
    expect(calls).toBe(1)
    emulator.stepBack()
    expect(calls).toBe(2)
    emulator.setBreakpoints([4])
    expect(calls).toBe(3)
    emulator.toggleBreakpoint(5)
    expect(calls).toBe(4)
    emulator.provideInput('x')
    expect(calls).toBe(5)
    emulator.reset()
    expect(calls).toBe(6)
  })

  it('calls the listener once for a whole run', () => {
    const emulator = emulatorFor(HELLO)
    let calls = 0
    emulator.subscribe(() => calls++)
    emulator.run()
    expect(calls).toBe(1)
  })

  it('does not call the listener when nothing changed', () => {
    const emulator = emulatorOf(['ret'])
    emulator.run()
    let calls = 0
    emulator.subscribe(() => calls++)
    emulator.step()
    emulator.run()
    emulator.stepBack()
    emulator.stepBack()
    expect(calls).toBe(1) // only the one stepBack that had something to undo
    emulator.setBreakpoints([])
    expect(calls).toBe(1)
  })

  it('run() on a program that already stopped with an error runs nothing and tells nobody', () => {
    const emulator = emulatorOf(['mov rax, [rbx]', 'ret'])
    emulator.run()
    let calls = 0
    emulator.subscribe(() => calls++)
    expect(emulator.run()).toMatchObject({ reason: 'error', stepsRun: 0 })
    expect(calls).toBe(0)
  })

  it('tells the listener when scanf starts to wait', () => {
    const emulator = emulatorFor(ECHO)
    steps(emulator, 5)
    let calls = 0
    emulator.subscribe(() => calls++)
    emulator.step()
    expect(calls).toBe(1)
    emulator.step()
    expect(calls).toBe(1)
  })

  it('the returned function unsubscribes', () => {
    const emulator = emulatorOf(['nop', 'nop', 'ret'])
    let first = 0
    let second = 0
    const stopFirst = emulator.subscribe(() => first++)
    emulator.subscribe(() => second++)
    emulator.step()
    stopFirst()
    emulator.step()
    stopFirst()
    expect(first).toBe(1)
    expect(second).toBe(2)
  })

  it('the listener sees the new snapshot', () => {
    const emulator = emulatorOf(['mov eax, 7', 'ret'])
    const seen: bigint[] = []
    emulator.subscribe(() => seen.push(emulator.getSnapshot().registers.rax))
    emulator.step()
    expect(seen).toEqual([7n])
  })

  it('a listener that throws does not break the emulator', () => {
    const emulator = emulatorOf(['mov eax, 7', 'ret'])
    let calls = 0
    emulator.subscribe(() => {
      throw new Error('a broken listener')
    })
    emulator.subscribe(() => calls++)
    expect(() => emulator.step()).not.toThrow()
    expect(calls).toBe(1)
    expect(emulator.readRegister('eax')).toBe(7n)
  })
})

/* ──────────────────────────────── snapshots ──────────────────────────────── */

describe('getSnapshot()', () => {
  it('returns the same object until the next change', () => {
    const emulator = emulatorOf(['mov eax, 1', 'ret'])
    const first = emulator.getSnapshot()
    expect(emulator.getSnapshot()).toBe(first)
    emulator.readRegister('rax')
    emulator.readMemory(RSP0, 8)
    expect(emulator.getSnapshot()).toBe(first)
    emulator.step()
    const second = emulator.getSnapshot()
    expect(second).not.toBe(first)
    expect(second.version).toBeGreaterThan(first.version)
    expect(emulator.getSnapshot()).toBe(second)
  })

  it('the version goes up by one on every change', () => {
    const emulator = emulatorOf(['nop', 'nop', 'ret'])
    const start = emulator.getSnapshot().version
    emulator.step()
    expect(emulator.getSnapshot().version).toBe(start + 1)
    emulator.toggleBreakpoint(4)
    expect(emulator.getSnapshot().version).toBe(start + 2)
    emulator.stepBack()
    expect(emulator.getSnapshot().version).toBe(start + 3)
    emulator.reset()
    expect(emulator.getSnapshot().version).toBe(start + 4)
  })

  it('an old snapshot never changes', () => {
    const emulator = emulatorFor(HELLO)
    emulator.step()
    const old = emulator.getSnapshot()
    const copy = structuredClone(old)
    emulator.run()
    emulator.reset()
    emulator.step()
    expect(old).toEqual(copy)
    expect(old.stepCount).toBe(1)
    expect(old.registers.rsp).toBe(RSP0 - 8n)
  })

  it('is read-only all the way down', () => {
    const emulator = emulatorFor(HELLO)
    emulator.setBreakpoints([7])
    emulator.step()
    const state = emulator.getSnapshot()
    expect(Object.isFrozen(state)).toBe(true)
    expect(Object.isFrozen(state.registers)).toBe(true)
    expect(Object.isFrozen(state.flags)).toBe(true)
    expect(Object.isFrozen(state.stack)).toBe(true)
    expect(Object.isFrozen(state.stack[0])).toBe(true)
    expect(Object.isFrozen(state.stack[0].bytes)).toBe(true)
    expect(Object.isFrozen(state.callStack)).toBe(true)
    expect(Object.isFrozen(state.callStack[0])).toBe(true)
    expect(Object.isFrozen(state.data)).toBe(true)
    expect(Object.isFrozen(state.data[0])).toBe(true)
    expect(Object.isFrozen(state.data[0].values)).toBe(true)
    expect(Object.isFrozen(state.breakpoints)).toBe(true)
    expect(Object.isFrozen(state.lastStep)).toBe(true)
    expect(() => {
      ;(state.registers as { rax: bigint }).rax = 1n
    }).toThrow(TypeError)
  })

  it('never throws', () => {
    const emulator = emulatorOf(['mov rsp, 0', 'mov rbp, -1', 'push rax'])
    emulator.run()
    expect(() => emulator.getSnapshot()).not.toThrow()
    expect(emulator.getSnapshot().status).toBe('error')
  })
})

/* ──────────────────────────────── the stack view ──────────────────────────────── */

describe('the stack view', () => {
  it('lists 8-byte boxes, highest address first, with no gaps', () => {
    const emulator = emulatorOf(['sub rsp, 40', 'mov qword ptr [rsp], 1', 'ret'])
    steps(emulator, 2)
    const { stack } = emulator.getSnapshot()
    expect(stack.map((slot) => slot.address)).toEqual([
      RSP0,
      RSP0 - 8n,
      RSP0 - 16n,
      RSP0 - 24n,
      RSP0 - 32n,
      RSP0 - 40n,
    ])
    expect(stack.every((slot) => slot.address % 8n === 0n)).toBe(true)
    expect(stack.map((slot) => slot.kind)).toEqual([
      'return-address',
      'empty',
      'empty',
      'empty',
      'empty',
      'value',
    ])
  })

  it('marks where rsp and rbp point', () => {
    const emulator = emulatorOf(['push rbp', 'mov rbp, rsp', 'sub rsp, 16', 'ret'])
    steps(emulator, 3)
    const state = emulator.getSnapshot()
    expect(state.stack.filter((slot) => slot.isRbp).map((slot) => slot.address)).toEqual([
      RSP0 - 8n,
    ])
    expect(state.stack.filter((slot) => slot.isRsp).map((slot) => slot.address)).toEqual([
      RSP0 - 24n,
    ])
    expect(state.stack).toHaveLength(4)
  })

  it('a push labels its box with the saved register', () => {
    const emulator = emulatorOf(['push rbp', 'push rbx', 'push 7', 'ret'], {
      initialRegisters: { rbx: 5n },
    })
    steps(emulator, 3)
    const state = emulator.getSnapshot()
    expect(slotAt(state, RSP0 - 8n)).toMatchObject({
      kind: 'saved-register',
      label: 'saved rbp',
      value: 0n,
    })
    expect(slotAt(state, RSP0 - 16n)).toMatchObject({ kind: 'saved-register', value: 5n })
    expect(slotAt(state, RSP0 - 16n).label).toContain('rbx')
    // A pushed number is just a value.
    expect(slotAt(state, RSP0 - 24n)).toMatchObject({ kind: 'value', label: null, value: 7n })
  })

  it('a call labels its box with the return address and the line it goes back to', () => {
    const emulator = emulatorOf(['call helper', 'ret', 'helper:', 'ret'])
    emulator.step()
    const slot = slotAt(emulator.getSnapshot(), RSP0 - 8n)
    expect(slot.kind).toBe('return-address')
    expect(slot.label).toContain('return address')
    expect(slot.label).toContain('line 5')
    expect(slot.value).toBe(TEXT + 5n)
  })

  it('a library call labels its return address box the same way', () => {
    const emulator = emulatorFor(HELLO)
    steps(emulator, 5)
    const slot = slotAt(emulator.getSnapshot(), RSP0 - 16n)
    expect(slot.kind).toBe('return-address')
    expect(slot.label).toContain('return address')
    expect(slot.label).toContain('line 11')
  })

  it('an `.equ` name with rbp or rsp names its box, also for lea and for reads', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.equ count, -8',
        '.equ total, -16',
        '.equ spare, 0',
        'main:',
        'push rbp',
        'mov rbp, rsp',
        'sub rsp, 32',
        'mov qword ptr count[rbp], 5',
        'lea rax, total[rbp]',
        'mov rbx, spare[rsp]',
        'leave',
        'ret',
        '',
      ].join('\n'),
    )
    steps(emulator, 6)
    const state = emulator.getSnapshot()
    expect(slotAt(state, RSP0 - 16n)).toMatchObject({ kind: 'local', label: 'count', value: 5n })
    // `lea` and a read name the box even though nothing was written there.
    expect(slotAt(state, RSP0 - 24n)).toMatchObject({ kind: 'local', label: 'total', value: null })
    expect(slotAt(state, RSP0 - 40n)).toMatchObject({ kind: 'local', label: 'spare', value: null })
    expect(slotAt(state, RSP0 - 32n)).toMatchObject({ kind: 'empty', label: null, value: null })
  })

  it('a later write of another kind replaces the label', () => {
    const emulator = emulatorOf([
      'call helper',
      'push rbx',
      'mov qword ptr [rsp], 1',
      'ret',
      'helper:',
      'ret',
    ])
    emulator.step()
    expect(slotAt(emulator.getSnapshot(), RSP0 - 8n).kind).toBe('return-address')
    emulator.step() // ret
    // The old return address is still there, below rsp.
    expect(slotAt(emulator.getSnapshot(), RSP0 - 8n)).toMatchObject({
      kind: 'return-address',
      dead: true,
    })
    emulator.step() // push rbx over it
    expect(slotAt(emulator.getSnapshot(), RSP0 - 8n)).toMatchObject({
      kind: 'saved-register',
      label: 'saved rbx',
      dead: false,
    })
    emulator.step() // a plain write over the saved register
    expect(slotAt(emulator.getSnapshot(), RSP0 - 8n)).toMatchObject({ kind: 'value', label: null })
  })

  it('a variable keeps its name when it is written through a pointer', () => {
    const emulator = emulatorOf(['.equ x, -8', 'lea rax, x[rsp]', 'mov qword ptr [rax], 5', 'ret'])
    steps(emulator, 2)
    expect(slotAt(emulator.getSnapshot(), RSP0 - 8n)).toMatchObject({
      kind: 'local',
      label: 'x',
      value: 5n,
    })
  })

  it('boxes below rsp are dead leftovers that keep their bytes', () => {
    const emulator = emulatorOf(['push rax', 'push rbx', 'pop rcx', 'pop rdx', 'ret'], {
      initialRegisters: { rax: 1n, rbx: 2n },
    })
    steps(emulator, 4)
    const state = emulator.getSnapshot()
    expect(state.stack.map((slot) => [slot.value, slot.dead])).toEqual([
      [OS, false],
      [1n, true],
      [2n, true],
    ])
  })

  it('marks the boxes that the last step wrote', () => {
    const emulator = emulatorOf(['push rax', 'push rbx', 'mov rcx, [rsp]', 'ret'])
    emulator.step()
    expect(emulator.getSnapshot().stack.map((slot) => slot.changed)).toEqual([false, true])
    emulator.step()
    expect(emulator.getSnapshot().stack.map((slot) => slot.changed)).toEqual([false, false, true])
    emulator.step()
    expect(emulator.getSnapshot().stack.map((slot) => slot.changed)).toEqual([false, false, false])
  })

  it('a write of the same value still marks the box', () => {
    const emulator = emulatorOf(['push rax', 'mov qword ptr [rsp], 0', 'ret'])
    steps(emulator, 2)
    expect(slotAt(emulator.getSnapshot(), RSP0 - 8n).changed).toBe(true)
    expect(emulator.getSnapshot().lastStep?.diff.memory).toEqual([])
  })

  it('a box that is only partly written shows its bytes, with 0 for the missing ones in value', () => {
    const emulator = emulatorOf(['sub rsp, 8', 'mov word ptr [rsp+2], 0x1234', 'ret'])
    steps(emulator, 2)
    const slot = slotAt(emulator.getSnapshot(), RSP0 - 8n)
    expect(slot.bytes).toEqual([null, null, 0x34, 0x12, null, null, null, null])
    expect(slot.value).toBe(0x12340000n)
    expect(slot.kind).toBe('value')
  })

  it('covers the box of rbp when rbp points into the stack', () => {
    const emulator = emulatorOf(['mov rbp, rsp', 'add rbp, 32', 'ret'])
    steps(emulator, 2)
    const { stack } = emulator.getSnapshot()
    expect(stack[0]).toMatchObject({ address: RSP0 + 32n, isRbp: true, kind: 'empty', value: null })
    expect(stack).toHaveLength(5)
    expect(stack[4]).toMatchObject({ address: RSP0, isRsp: true })
  })

  it('does not follow rsp or rbp outside the stack', () => {
    const emulator = emulatorOf(['mov rbp, 0x10', 'mov rsp, 0x18', 'ret'])
    steps(emulator, 2)
    const { stack } = emulator.getSnapshot()
    expect(stack).toHaveLength(1)
    expect(stack[0]).toMatchObject({ address: RSP0, isRsp: false, isRbp: false })
  })

  it('rsp in the middle of a box points at that box', () => {
    const emulator = emulatorOf(['sub rsp, 12', 'ret'])
    emulator.step()
    const { stack } = emulator.getSnapshot()
    expect(stack.map((slot) => [slot.address, slot.isRsp, slot.dead])).toEqual([
      [RSP0, false, false],
      [RSP0 - 8n, false, false],
      [RSP0 - 16n, true, false],
    ])
  })

  it('after a function returns, its frame is still there as dead boxes', () => {
    const emulator = emulatorOf(['call helper', 'ret', 'helper:', 'push rbp', 'pop rbp', 'ret'])
    steps(emulator, 4)
    const state = emulator.getSnapshot()
    expect(state.stack.map((slot) => [slot.kind, slot.dead])).toEqual([
      ['return-address', false],
      ['return-address', true],
      ['saved-register', true],
    ])
  })

  it('a new view reuses the boxes that did not change (a deep stack stays fast)', () => {
    const emulator = emulatorOf(['call main'], { maxSteps: 5000 })
    emulator.run()
    const deep = emulator.getSnapshot()
    expect(deep.stack.length).toBe(5001)
    emulator.stepBack()
    const back = emulator.getSnapshot()
    expect(back.stack.length).toBe(5000)
    // Only the box of the old rsp changed (its rsp mark moved, and it is dead now)…
    const same = back.stack.filter((slot, i) => slot === deep.stack[i]).length
    expect(same).toBeGreaterThanOrEqual(4997)
    // …and the reused boxes are still right.
    for (const slot of back.stack) {
      expect(slot.isRsp).toBe(slot.address === back.registers.rsp)
      expect(slot.dead).toBe(slot.address + 8n <= back.registers.rsp)
    }
    // And forward again gives an equal view.
    emulator.step()
    expect(emulator.getSnapshot().stack).toEqual(deep.stack)
  })
})

describe('the call stack', () => {
  it('is empty after main returned to the code that started it (main is over)', () => {
    const emulator = emulatorOf(['ret'])
    expect(emulator.getSnapshot().callStack).toHaveLength(1)
    emulator.step()
    expect(emulator.getSnapshot().callStack).toEqual([])
    expect(emulator.stepBack()).toBe(true)
    expect(emulator.getSnapshot().callStack.map((frame) => frame.functionName)).toEqual(['main'])
  })

  it('keeps its frames after `exit`: no function returned', () => {
    const emulator = emulatorOf(['sub rsp, 8', 'mov edi, 0', 'call exit@PLT'])
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().callStack.map((frame) => frame.functionName)).toEqual(['main'])
  })
})

describe('a program that starts at a label with nothing after it', () => {
  it('its one step is the label line, with the label as its text', () => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', '.text', 'helper:', '    ret', 'main:', ''].join('\n'),
    )
    const step = emulator.step()
    expect(step.executed).toBe(true)
    expect(step.text).toBe('main:')
    expect(step.line).toBe(5)
    expect(step.explanation).toBe(
      '`main:`: the label `main` has no instruction after it, so the program has nothing to run. Nothing changed, and the program stopped.',
    )
    expect(step.error?.message).toBe(
      'Line 5: the label `main` has no instruction after it, so the program has nothing to run. Put the instructions of the program after `main:`.',
    )
  })

  it('the assembler already warns about it on the line of `main:`', () => {
    const made = createEmulator(
      ['.intel_syntax noprefix', '.text', 'helper:', '    ret', 'main:', ''].join('\n'),
    )
    expect(made.ok).toBe(true)
    expect(made.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'no-main', line: 5 }),
    ])
    expect(made.diagnostics[0].message).toContain('the label `main:` has no instruction after it')
  })
})

describe('M8: a program longer than the gap before its read-only data', () => {
  it('runs: the read-only data moved up past the code, so puts finds its text', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        's: .string "hi"',
        'main:',
        ...Array.from({ length: 381 }, () => '    mov rax, 0x1122334455667788'),
        '    lea rdi, s[rip]',
        '    call puts@PLT',
        '    mov eax, 0',
        '    ret',
        '',
      ].join('\n'),
    )
    expect(emulator.program.layout.rodataBase).toBe(0x403010n)
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe('hi\n')
    expect(emulator.getSnapshot().data[0]).toMatchObject({ address: 0x403010n, text: 'hi' })
  })
})

/* ──────────────────────────────── the data view ──────────────────────────────── */

describe('the data view', () => {
  const program = [
    '.intel_syntax noprefix',
    '.data',
    'numbers: .quad 12, 7',
    'small: .word 0x1234, 0xffff',
    'bytes: .byte 1, 2, 3',
    'room: .zero 4',
    '.text',
    'greeting: .string "hi"',
    'pair: .string "a", "b"',
    'raw: .ascii "xyz"',
    'main:',
    'mov qword ptr numbers+8[rip], 99',
    'mov byte ptr room+1[rip], 0x41',
    'ret',
    '',
  ].join('\n')

  it('has one entry per data directive, in program order', () => {
    const state = emulatorFor(program).getSnapshot()
    expect(state.data.map((view) => view.label)).toEqual([
      'numbers',
      'small',
      'bytes',
      'room',
      'greeting',
      'pair',
      'raw',
    ])
    expect(state.data[0]).toEqual({
      label: 'numbers',
      address: 0x404030n,
      directive: '.quad',
      readOnly: false,
      elementSize: 8,
      values: [12n, 7n],
      text: null,
    })
    expect(state.data[1]).toMatchObject({
      elementSize: 2,
      values: [0x1234n, 0xffffn],
      address: 0x404040n,
    })
    expect(state.data[2]).toMatchObject({ elementSize: 1, values: [1n, 2n, 3n] })
    expect(state.data[3]).toMatchObject({
      directive: '.zero',
      values: [0n, 0n, 0n, 0n],
      text: null,
    })
  })

  it('shows strings as text, up to the first 0 byte', () => {
    const state = emulatorFor(program).getSnapshot()
    expect(state.data[4]).toMatchObject({
      label: 'greeting',
      readOnly: true,
      address: 0x402010n,
      elementSize: 1,
      values: [0x68n, 0x69n, 0n],
      text: 'hi',
    })
    expect(state.data[5]).toMatchObject({ values: [0x61n, 0n, 0x62n, 0n], text: 'a' })
    expect(state.data[6]).toMatchObject({
      directive: '.ascii',
      values: [0x78n, 0x79n, 0x7an],
      text: 'xyz',
    })
  })

  it('follows the writes of the program, and stepBack', () => {
    const emulator = emulatorFor(program)
    const before = emulator.getSnapshot().data
    emulator.step()
    const after = emulator.getSnapshot().data
    expect(after[0].values).toEqual([12n, 99n])
    // The items that did not change are the same objects.
    expect(after[1]).toBe(before[1])
    expect(after[4]).toBe(before[4])
    emulator.step()
    expect(emulator.getSnapshot().data[3].values).toEqual([0n, 0x41n, 0n, 0n])
    emulator.stepBack()
    emulator.stepBack()
    expect(emulator.getSnapshot().data).toEqual(before)
  })

  it('the bytes of `.zero` read as 0, before and after a write', () => {
    const emulator = emulatorFor(program)
    const room = emulator.program.symbols.get('room')?.address ?? 0n
    expect(emulator.readMemory(room, 4)).toEqual([0, 0, 0, 0])
    emulator.step()
    const step = emulator.step()
    expect(step.diff.memory).toEqual([{ address: room + 1n, before: [0], after: [0x41] }])
    expect(emulator.readMemory(room, 4)).toEqual([0, 0x41, 0, 0])
    emulator.stepBack()
    expect(emulator.readMemory(room, 4)).toEqual([0, 0, 0, 0])
  })

  it('a huge `.zero` area does not slow the emulator down', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'big: .zero 1000000',
        '.text',
        'main:',
        'mov byte ptr big[rip], 1',
        'ret',
        '',
      ].join('\n'),
    )
    const started = performance.now()
    expect(emulator.run().reason).toBe('halted')
    const view = emulator.getSnapshot().data[0]
    expect(performance.now() - started).toBeLessThan(1000)
    expect(view.values[0]).toBe(1n)
    expect(view.values[1]).toBe(0n)
    expect(emulator.readMemory(0x404030n + 999_999n, 1)).toEqual([0])
  })
})

/* ───────────────────────── readRegister and readMemory ───────────────────────── */

describe('readRegister() and readMemory()', () => {
  it('reads all 68 register names, in any letter case', () => {
    const emulator = emulatorOf(['ret'], {
      initialRegisters: {
        rax: 0x1122334455667788n,
        rsi: 0xa1a2a3a4a5a6a7a8n,
        r8: 0xb1b2b3b4b5b6b7b8n,
      },
    })
    expect(emulator.readRegister('RAX')).toBe(0x1122334455667788n)
    expect(emulator.readRegister('Eax')).toBe(0x55667788n)
    expect(emulator.readRegister('AH')).toBe(0x77n)
    expect(emulator.readRegister('sil')).toBe(0xa8n)
    expect(emulator.readRegister('si')).toBe(0xa7a8n)
    expect(emulator.readRegister('r8d')).toBe(0xb5b6b7b8n)
    expect(emulator.readRegister('r8w')).toBe(0xb7b8n)
    expect(emulator.readRegister('R8B')).toBe(0xb8n)
    expect(emulator.readRegister('spl')).toBe(0xf8n)
  })

  it('throws a normal Error for a name that is not a register', () => {
    const emulator = emulatorOf(['ret'])
    expect(() => emulator.readRegister('rip')).toThrow(Error)
    expect(() => emulator.readRegister('')).toThrow(Error)
    expect(() => emulator.readRegister('eex')).toThrow(/eex/)
  })

  it('gives null for bytes that were never written or that nobody owns', () => {
    const emulator = emulatorOf(['ret'])
    expect(emulator.readMemory(RSP0 - 8n, 2)).toEqual([null, null])
    expect(emulator.readMemory(0n, 3)).toEqual([null, null, null])
    expect(emulator.readMemory(TEXT, 2)).toEqual([null, null])
    expect(emulator.readMemory(RSP0 + 7n, 2)).toEqual([0, null])
  })

  it('never throws for strange arguments', () => {
    const emulator = emulatorOf(['ret'])
    expect(emulator.readMemory(RSP0, 0)).toEqual([])
    expect(emulator.readMemory(RSP0, -3)).toEqual([])
    expect(emulator.readMemory(RSP0, Number.NaN)).toEqual([])
    expect(emulator.readMemory(-8n, 2)).toEqual([null, null])
    expect(emulator.readMemory(1n << 64n, 2)).toEqual([null, null])
    expect(emulator.readMemory(RSP0, 2.9)).toEqual([0x90, 0x9d])
  })
})
