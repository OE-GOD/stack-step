import { describe, expect, it } from 'vitest'
import { createEmulator, type MachineState, type Program, type StackSlot } from '../../emulator'
import { exampleById } from '../../examples'
import {
  byteOf,
  changedRegisters,
  clearedTopHalves,
  junkRegisters,
  leadingZeros,
  MAX_STACK_ROWS,
  rbpOffset,
  readableNumbers,
  registerList,
  registerName,
  registerParts,
  registersInProgram,
  stackBoxName,
  stackRows,
  stepKey,
  visibleStack,
  visibleText,
} from './machineView'

function run(source: string, steps: number): { machine: MachineState; program: Program } {
  const created = createEmulator(source)
  if (!created.ok) throw new Error(created.diagnostics.map((item) => item.message).join(' | '))
  for (let i = 0; i < steps; i++) created.emulator.step()
  return { machine: created.emulator.getSnapshot(), program: created.emulator.program }
}

describe('hex digits', () => {
  it('finds the zeros to dim (the digits and their groups come from the emulator)', () => {
    expect(leadingZeros('0000000000000007')).toBe(15)
    // The last digit of 0 is never dimmed.
    expect(leadingZeros('0000')).toBe(3)
    expect(leadingZeros('8000')).toBe(0)
  })

  it('keeps a shortened address in one piece', () => {
    expect(readableNumbers('rsp went down 8 (0x…dff8 → 0x…dff0)')).toBe(
      'rsp went down 8 (0x…⁠dff8 → 0x…⁠dff0)',
    )
  })
})

describe('registers', () => {
  it('splits a register into its named parts', () => {
    const parts = registerParts('rax', 0x1122334455667788n)
    expect(parts.map((part) => [part.name, part.value, part.firstByte, part.byteCount])).toEqual([
      ['rax', 0x1122334455667788n, 0, 8],
      ['eax', 0x55667788n, 0, 4],
      ['ax', 0x7788n, 0, 2],
      ['ah', 0x77n, 1, 1],
      ['al', 0x88n, 0, 1],
    ])
    expect(registerParts('r8', 0n).map((part) => part.name)).toEqual(['r8', 'r8d', 'r8w', 'r8b'])
    expect(byteOf(0x1234n, 1)).toBe(0x12)
  })

  it('names a 32-bit write that cleared the top half, and not a 64-bit one', () => {
    const source =
      'main:\n    mov rax, -1\n    mov eax, 5\n    mov rbx, -1\n    mov rbx, 5\n    ret\n'
    const after32 = run(source, 2)
    expect(clearedTopHalves(after32.machine.lastStep, after32.program).get('rax')).toBe(
      0xffffffffffffffffn,
    )
    const after64 = run(source, 4)
    expect(clearedTopHalves(after64.machine.lastStep, after64.program).size).toBe(0)
  })

  it('finds the registers a program names, in display order', () => {
    const { program } = run(
      'main:\n    mov rcx, [rbp-8]\n    add rax, rcx\n    push r8\n    ret\n',
      0,
    )
    expect(registersInProgram(program)).toEqual(['rax', 'rcx', 'rbp', 'r8'])
  })
})

describe('stack', () => {
  function slot(address: bigint, dead: boolean): StackSlot {
    return {
      address,
      value: 1n,
      bytes: [1, 0, 0, 0, 0, 0, 0, 0],
      label: null,
      kind: 'value',
      isRsp: false,
      isRbp: false,
      dead,
      changed: false,
    }
  }

  it('shows the live boxes and at most four leftovers, the nearest to rsp', () => {
    const stack = [0x100n, 0xf8n, 0xf0n, 0xe8n, 0xe0n, 0xd8n, 0xd0n].map((address, index) =>
      slot(address, index >= 1),
    )
    expect(visibleStack(stack).map((box) => box.address)).toEqual([
      0x100n,
      0xf8n,
      0xf0n,
      0xe8n,
      0xe0n,
    ])
  })

  it('writes offsets from rbp with a real minus sign', () => {
    expect(rbpOffset(0x1f0n, 0x1f8n)).toBe('rbp−8')
    expect(rbpOffset(0x200n, 0x1f8n)).toBe('rbp+8')
    expect(rbpOffset(0x1f8n, 0x1f8n)).toBe('rbp')
  })
})

describe('data', () => {
  it('writes special characters of a string as escapes', () => {
    expect(visibleText('Hi\n\t"x"\\')).toEqual([
      { text: 'Hi', escape: false },
      { text: '\\n', escape: true },
      { text: '\\t', escape: true },
      { text: '\\"', escape: true },
      { text: 'x', escape: false },
      { text: '\\"', escape: true },
      { text: '\\\\', escape: true },
    ])
  })
})

describe('library calls', () => {
  const hello = exampleById('hello-world')?.source ?? ''

  it('tell the junk they leave apart from the result in rax', () => {
    const { machine } = run(hello, 6) // printf ran
    const junk = junkRegisters(machine.lastStep)
    expect([...junk].sort()).toEqual(['r10', 'r11', 'r8', 'r9', 'rcx', 'rdi', 'rdx', 'rsi'])
    expect([...changedRegisters(machine.lastStep)].sort()).toEqual(['rax', 'rsp'])
    // An instruction step has no junk.
    expect(junkRegisters(run(hello, 1).machine.lastStep).size).toBe(0)
  })

  it('list registers in the order of the course, with r8 to r11 as one run', () => {
    expect(registerList(new Set(['r11', 'rcx', 'r9', 'rdi', 'rdx', 'r10', 'rsi', 'r8']))).toBe(
      '`rcx`, `rdx`, `rsi`, `rdi` and `r8` to `r11`',
    )
    expect(registerList(new Set(['rcx']))).toBe('`rcx`')
    expect(registerList(new Set(['rcx', 'r8', 'r9']))).toBe('`rcx`, `r8` and `r9`')
  })
})

describe('accessible names', () => {
  it('read a register with all 16 digits, as the screen shows it', () => {
    expect(registerName('rax', 5n, true, false)).toBe('rax: 0x0000000000000005, changed')
    expect(registerName('rcx', 0x1234n, false, true)).toBe(
      'rcx: 0x0000000000001234, junk from the library call',
    )
  })

  it('read a stack box label first, then its value, address and pointers', () => {
    const slot = {
      address: 0x7ffffffddff0n,
      value: 0x5n,
      bytes: [5, 0, 0, 0, 0, 0, 0, 0],
      label: 'saved rax',
      kind: 'saved-register',
      isRsp: true,
      isRbp: false,
      dead: false,
      changed: true,
    } satisfies StackSlot
    expect(stackBoxName(slot, 'rbp−8')).toBe(
      'saved rax, 0x0000000000000005, changed, address 0x7ffffffddff0, rbp−8, rsp points here',
    )
    expect(
      stackBoxName({ ...slot, label: null, value: null, isRsp: false, changed: false }, null),
    ).toBe('Box, not set yet, address 0x7ffffffddff0')
  })
})

describe('stack rows', () => {
  it('fold a long run of unset boxes into one row, and keep the ends', () => {
    const { machine } = run('main:\n    sub rsp, 4096\n    ret\n', 1)
    const rows = stackRows(machine.stack)
    const unset = rows.filter((row) => row.kind === 'unset')
    expect(unset).toHaveLength(1)
    // 511 boxes between the OS return address and rsp; 2 stay at each end.
    expect(unset[0]?.kind === 'unset' && unset[0].count).toBe(511 - 4)
    expect(rows.some((row) => row.kind === 'box' && row.slot.isRsp)).toBe(true)
  })

  it('stay a short list for a very deep stack, with rsp and the top in it', () => {
    // 4 096 boxes written one by one (no runs of unset boxes to fold).
    const program = `main:\n    mov rcx, 4096\nagain:\n    push rcx\n    dec rcx\n    jne again\n    ret\n`
    const { machine } = run(program, 1 + 3 * 4096)
    expect(machine.stack.length).toBeGreaterThan(4096)
    const rows = stackRows(machine.stack)
    expect(rows.length).toBeLessThanOrEqual(MAX_STACK_ROWS + 2)
    const hidden = rows.find((row) => row.kind === 'hidden')
    expect(hidden?.kind === 'hidden' && hidden.count).toBeGreaterThan(3800)
    expect(rows.some((row) => row.kind === 'box' && row.slot.isRsp)).toBe(true)
    expect(rows[0]?.kind === 'box' && rows[0].slot.address).toBe(machine.stack[0]?.address)
    // "Show more" reveals more of the hidden boxes.
    expect(stackRows(machine.stack, 200).length).toBeGreaterThan(rows.length)
  })
})

describe('stepKey', () => {
  it('changes with the step on the screen, and only then', () => {
    const created = createEmulator(exampleById('hello-world')?.source ?? '')
    if (!created.ok) throw new Error('bad program')
    const emu = created.emulator
    expect(stepKey(emu.getSnapshot().lastStep)).toBe(0)
    emu.step()
    const first = stepKey(emu.getSnapshot().lastStep)
    expect(first).toBeGreaterThan(0)
    emu.toggleBreakpoint(13) // a new snapshot, the same step
    expect(stepKey(emu.getSnapshot().lastStep)).toBe(first)
    emu.step()
    expect(stepKey(emu.getSnapshot().lastStep)).not.toBe(first)
  })
})
