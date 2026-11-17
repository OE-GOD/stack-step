/**
 * Black-box tests for the emulator.
 *
 * Written only from the behaviour contract (spec-emulator.md, spec-assembler.md, types.ts,
 * PLAN.md) and from how a real x86-64 CPU behaves. The implementation was not read.
 * Every expected value is worked out by hand (or with plain BigInt maths in the test),
 * never by asking the emulator.
 */
import { describe, expect, it } from 'vitest'
import { EXAMPLES } from '../examples'
import { MASK } from './bits'
import { groupHex, hex, hex64, shortAddress } from './format'
import { createEmulator } from './index'
import {
  DEFAULT_OPTIONS,
  LIBRARY_FUNCTIONS,
  REG64_NAMES,
  type Bit,
  type EmulatorApi,
  type EmulatorOptions,
  type Flags,
  type Instruction,
  type MachineState,
  type Reg64,
  type StackSlot,
  type StepNote,
  type StepResult,
} from './types'

/* ───────────────────────── Defaults from the contract ───────────────────────── */

const TEXT_BASE = 0x401126n
const RODATA_BASE = 0x402010n
const DATA_BASE = 0x404030n
const STACK_BASE = 0x7ffffffde000n
const START_RSP = 0x7ffffffddff8n
const OS_RET = 0x7ffff7c29d90n
const PRINTF = 0x7ffff7c606f0n
const SCANF = 0x7ffff7c62110n

/* ─────────────────────────────────── Helpers ─────────────────────────────────── */

const LABEL_AT_START = /^[A-Za-z_.$][\w.$]*:/

/** Program text: the intel_syntax line, `.text`, then the given lines. */
function asm(...lines: string[]): string {
  return ['    .intel_syntax noprefix', '    .text', ...lines].join('\n') + '\n'
}

/** `before` (data, .equ) goes above `main:`. Lines that start with a label are not indented. */
function mainProg(body: readonly string[], before: readonly string[] = []): string {
  const indent = (line: string) => (LABEL_AT_START.test(line) ? line : `    ${line}`)
  return asm(...before.map(indent), 'main:', ...body.map(indent))
}

/** Assemble and build an emulator; the program must assemble. */
function boot(source: string, options: EmulatorOptions = {}): EmulatorApi {
  const result = createEmulator(source, options)
  if (!result.ok) {
    const messages = result.diagnostics.map((d) => d.message).join('\n')
    throw new Error(`The test program did not assemble:\n${messages}\n---\n${source}`)
  }
  return result.emulator
}

function bootMain(
  body: readonly string[],
  options: EmulatorOptions = {},
  before: readonly string[] = [],
): EmulatorApi {
  return boot(mainProg(body, before), options)
}

function snap(emu: EmulatorApi): MachineState {
  return emu.getSnapshot()
}

function reg(emu: EmulatorApi, name: string): bigint {
  return emu.readRegister(name)
}

function stepN(emu: EmulatorApi, n: number): StepResult[] {
  const out: StepResult[] = []
  for (let i = 0; i < n; i++) out.push(emu.step())
  return out
}

/** Step while the status is 'running' (at most `limit` steps). */
function runToEnd(emu: EmulatorApi, limit = 10_000): StepResult[] {
  const out: StepResult[] = []
  while (emu.getSnapshot().status === 'running' && out.length < limit) out.push(emu.step())
  return out
}

/** Step until rip is inside a library function; returns the `call` step. */
function stepToLibrary(emu: EmulatorApi): StepResult {
  for (let i = 0; i < 1000; i++) {
    const r = emu.step()
    if (emu.getSnapshot().inLibrary !== null) return r
    if (!r.executed || r.status !== 'running') break
  }
  throw new Error('The program never reached a library call')
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing: ${what}`)
  return value
}

function lastOf<T>(items: readonly T[]): T {
  return must(items[items.length - 1], 'last item')
}

function instr(emu: EmulatorApi, index: number): Instruction {
  return must(emu.program.instructions[index], `instruction ${index}`)
}

function symbolAddress(emu: EmulatorApi, name: string): bigint {
  return must(emu.program.symbols.get(name), `symbol ${name}`).address
}

function box(s: MachineState, address: bigint): StackSlot {
  return must(
    s.stack.find((b) => b.address === address),
    `stack box ${hex(address)}`,
  )
}

/** Little-endian bytes of `value` (two's complement), `count` bytes. */
function le(value: bigint, count: number): number[] {
  const out: number[] = []
  let v = BigInt.asUintN(count * 8, value)
  for (let i = 0; i < count; i++) {
    out.push(Number(v & 0xffn))
    v >>= 8n
  }
  return out
}

function F(CF: Bit, ZF: Bit, SF: Bit, OF: Bit): Flags {
  return { CF, ZF, SF, OF }
}

function oneReg(name: Reg64, value: bigint): Partial<Record<Reg64, bigint>> {
  const regs: Partial<Record<Reg64, bigint>> = {}
  regs[name] = value
  return regs
}

function notesOf(r: StepResult, kind: StepNote['kind']): StepNote[] {
  return r.notes.filter((n) => n.kind === kind)
}

/** The explanation may write a stack/code address in full or shortened (`0x…dff0`). */
function mentionsAddress(text: string, address: bigint): boolean {
  return text.includes(shortAddress(address)) || text.includes(hex(address))
}

/** `0x5`, `0x00000005`, `0x0000000000000005` or grouped digits all count. */
function mentionsValue(text: string, value: bigint): boolean {
  const digits = BigInt.asUintN(64, value).toString(16)
  return (
    new RegExp(`0x0*${digits}(?![0-9a-f])`, 'i').test(text) ||
    text.includes(groupHex(BigInt.asUintN(64, value)))
  )
}

function show(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? `${v.toString()}n` : v,
  )
}

/** Deep comparison that understands bigint and Map. Returns the differences (empty = equal). */
function deepDiff(a: unknown, b: unknown, path = '$', out: string[] = []): string[] {
  if (out.length >= 20 || Object.is(a, b)) return out
  if (
    typeof a === 'bigint' ||
    typeof b === 'bigint' ||
    a === null ||
    b === null ||
    typeof a !== 'object' ||
    typeof b !== 'object'
  ) {
    out.push(`${path}: ${show(a)} is not ${show(b)}`)
    return out
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    out.push(`${path}: array vs object`)
    return out
  }
  if (a instanceof Map && b instanceof Map) {
    const ma = a as Map<unknown, unknown>
    const mb = b as Map<unknown, unknown>
    if (ma.size !== mb.size) out.push(`${path}.size: ${ma.size} is not ${mb.size}`)
    for (const [key, value] of ma) deepDiff(value, mb.get(key), `${path}<${show(key)}>`, out)
    return out
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  for (const key of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    deepDiff(ra[key], rb[key], `${path}.${key}`, out)
  }
  return out
}

function withoutVersion(s: MachineState): Omit<MachineState, 'version'> {
  const { version: _version, ...rest } = s
  return rest
}

function expectSameState(actual: MachineState, expected: MachineState): void {
  expect(deepDiff(withoutVersion(actual), withoutVersion(expected))).toEqual([])
}

/** Text for a `.string` directive: escapes backslash, quote, newline and tab. */
function asmString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
}

/**
 * main calls scanf with the format `format`. rbp = 0x…dff0 and rsp = 0x…dfe0 before the
 * call (aligned), so -8[rbp] is 0x…dfe8 and -4[rbp] is 0x…dfec.
 */
function scanfProgram(format: string, args: readonly string[] = ['lea rsi, -8[rbp]']): string {
  return mainProg(
    [
      'push rbp',
      'mov rbp, rsp',
      'sub rsp, 16',
      ...args,
      'lea rdi, fmt[rip]',
      'mov eax, 0',
      'call scanf@PLT',
      'leave',
      'ret',
    ],
    [`fmt: .string "${asmString(format)}"`],
  )
}

const LOCAL_8 = 0x7ffffffddfe8n // -8[rbp] in scanfProgram
const LOCAL_4 = 0x7ffffffddfecn // -4[rbp] in scanfProgram

/* ═════════════════════════════ 1. Starting state ═════════════════════════════ */

describe('1. Starting state', () => {
  const simple = mainProg(['mov eax, 1', 'ret'])
  const SMALL: EmulatorOptions = {
    textBase: 0x4000n,
    stackBase: 0x1000n,
    initialRsp: 0x200n,
    osReturnAddress: 0x3ff0n,
  }

  it('uses the default addresses written in the contract', () => {
    expect(DEFAULT_OPTIONS.textBase).toBe(TEXT_BASE)
    expect(DEFAULT_OPTIONS.rodataBase).toBe(RODATA_BASE)
    expect(DEFAULT_OPTIONS.dataBase).toBe(DATA_BASE)
    expect(DEFAULT_OPTIONS.stackBase).toBe(STACK_BASE)
    expect(DEFAULT_OPTIONS.osReturnAddress).toBe(OS_RET)
    expect(LIBRARY_FUNCTIONS.printf).toBe(PRINTF)
    expect(LIBRARY_FUNCTIONS.scanf).toBe(SCANF)
  })

  it('starts rsp at 0x7ffffffddff8 and every other register at 0', () => {
    const s = snap(boot(simple))
    expect(s.registers.rsp).toBe(START_RSP)
    for (const name of REG64_NAMES) {
      if (name !== 'rsp') expect(s.registers[name], name).toBe(0n)
    }
  })

  it('stores the OS return address 0x7ffff7c29d90 little-endian at the starting rsp', () => {
    expect(boot(simple).readMemory(START_RSP, 8)).toEqual([
      0x90, 0x9d, 0xc2, 0xf7, 0xff, 0x7f, 0, 0,
    ])
  })

  it('shows the OS return address as a return-address box where rsp points', () => {
    const b = box(snap(boot(simple)), START_RSP)
    expect(b.kind).toBe('return-address')
    expect(b.label ?? '').toContain('return address')
    expect(b.value).toBe(OS_RET)
    expect(b.bytes).toEqual(le(OS_RET, 8))
    expect(b.isRsp).toBe(true)
    expect(b.dead).toBe(false)
  })

  it('starts with flags 0, status running, no steps, no output and nothing to undo', () => {
    const s = snap(boot(simple))
    expect(s.flags).toEqual(F(0, 0, 0, 0))
    expect(s.status).toBe('running')
    expect(s.stepCount).toBe(0)
    expect(s.output).toBe('')
    expect(s.lastStep).toBeNull()
    expect(s.error).toBeNull()
    expect(s.canStepBack).toBe(false)
    expect(s.inLibrary).toBeNull()
    expect(s.inputRequest).toBeNull()
    expect(s.breakpoints).toEqual([])
  })

  it('sets rip to program.entry (main) even when main is not the first instruction', () => {
    const emu = boot(asm('helper:', '    ret', 'main:', '    mov eax, 1', '    ret'))
    expect(emu.program.entryLabel).toBe('main')
    expect(instr(emu, 0).address).toBe(TEXT_BASE)
    expect(emu.program.entry).toBe(TEXT_BASE + 1n) // `ret` is 1 byte
    expect(snap(emu).rip).toBe(TEXT_BASE + 1n)
    expect(snap(emu).nextLine).toBe(instr(emu, 1).line)
  })

  it('starts at the first instruction when there is no main label', () => {
    const result = createEmulator(asm('start:', '    mov eax, 1', '    ret'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.diagnostics.some((d) => d.code === 'no-main')).toBe(true)
    const s = result.emulator.getSnapshot()
    expect(s.rip).toBe(TEXT_BASE)
    expect(s.callStack).toEqual([
      { functionName: null, callLine: 0, returnAddress: OS_RET, slotAddress: START_RSP },
    ])
  })

  it('has one call frame: the OS called main', () => {
    expect(snap(boot(simple)).callStack).toEqual([
      { functionName: 'main', callLine: 0, returnAddress: OS_RET, slotAddress: START_RSP },
    ])
  })

  it('applies initialRegisters and keeps the default rsp', () => {
    const s = snap(boot(simple, { initialRegisters: { rax: 5n, rbx: 0x10n, r15: MASK[64] } }))
    expect(s.registers.rax).toBe(5n)
    expect(s.registers.rbx).toBe(0x10n)
    expect(s.registers.r15).toBe(MASK[64])
    expect(s.registers.rcx).toBe(0n)
    expect(s.registers.rsp).toBe(START_RSP)
  })

  it('uses initialRegisters.rsp when initialRsp is not given', () => {
    const emu = boot(simple, { initialRegisters: { rsp: 0x7ffffffdd000n } })
    expect(snap(emu).registers.rsp).toBe(0x7ffffffdd000n)
    expect(emu.readMemory(0x7ffffffdd000n, 8)).toEqual(le(OS_RET, 8))
    expect(snap(emu).callStack[0]?.slotAddress).toBe(0x7ffffffdd000n)
  })

  it('prefers initialRsp over initialRegisters.rsp', () => {
    const emu = boot(simple, {
      initialRsp: 0x7ffffffdc000n,
      initialRegisters: { rsp: 0x7ffffffdd000n },
    })
    expect(snap(emu).registers.rsp).toBe(0x7ffffffdc000n)
    expect(emu.readMemory(0x7ffffffdc000n, 8)).toEqual(le(OS_RET, 8))
  })

  it('applies initialFlags', () => {
    expect(snap(boot(simple, { initialFlags: { CF: 1, OF: 1 } })).flags).toEqual(F(1, 0, 0, 1))
  })

  it('loads an 8-byte initialMemory cell little-endian and labels its stack box', () => {
    const emu = boot(simple, {
      initialRsp: 0x7ffffffddfe0n,
      initialMemory: [{ address: 0x7ffffffddfe8n, bytes: 8, value: 0x2an, label: 'x' }],
    })
    expect(emu.readMemory(0x7ffffffddfe8n, 8)).toEqual(le(0x2an, 8))
    const b = box(snap(emu), 0x7ffffffddfe8n)
    expect(b.kind).toBe('local')
    expect(b.label).toBe('x')
    expect(b.value).toBe(0x2an)
    expect(b.dead).toBe(false)
  })

  it('loads a 4-byte initialMemory cell and leaves the next bytes never written', () => {
    const emu = boot(simple, {
      initialMemory: [{ address: 0x7ffffffddff0n, bytes: 4, value: 0x11223344n }],
    })
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual([
      0x44,
      0x33,
      0x22,
      0x11,
      null,
      null,
      null,
      null,
    ])
  })

  it('places the code at the textBase option', () => {
    const emu = boot(mainProg(['call f', 'ret', 'f:', 'ret']), { textBase: 0x500000n })
    expect(instr(emu, 0).address).toBe(0x500000n)
    expect(snap(emu).rip).toBe(0x500000n)
    emu.step()
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual(le(0x500005n, 8)) // call = 5 bytes
    expect(snap(emu).rip).toBe(0x500006n) // f: after the call (5) and ret (1)
  })

  it('places .string data at rodataBase and .data at dataBase', () => {
    const emu = boot(mainProg(['ret'], ['msg: .string "Hi"', '.data', 'num: .quad 5', '.text']), {
      rodataBase: 0x600000n,
      dataBase: 0x700000n,
    })
    expect(symbolAddress(emu, 'msg')).toBe(0x600000n)
    expect(symbolAddress(emu, 'num')).toBe(0x700000n)
    expect(emu.readMemory(0x600000n, 3)).toEqual([0x48, 0x69, 0])
    expect(emu.readMemory(0x700000n, 8)).toEqual(le(5n, 8))
  })

  it('gives scanf the text in options.stdin without waiting', () => {
    const emu = boot(scanfProgram('%d'), { stdin: '42\n' })
    stepToLibrary(emu)
    const r = emu.step()
    expect(r.executed).toBe(true)
    expect(r.kind).toBe('library')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(42n, 4))
    expect(snap(emu).status).toBe('running')
  })

  it('works with a small practice layout: push, read above rsp, pop, and ret ends it', () => {
    const emu = bootMain(['push rbx', 'mov rax, [rsp+8]', 'pop rcx', 'ret'], {
      ...SMALL,
      initialRegisters: { rbx: 0x77n },
    })
    expect(snap(emu).rip).toBe(0x4000n)
    expect(snap(emu).registers.rsp).toBe(0x200n)
    expect(emu.readMemory(0x200n, 8)).toEqual(le(0x3ff0n, 8))
    emu.step()
    expect(reg(emu, 'rsp')).toBe(0x1f8n)
    expect(emu.readMemory(0x1f8n, 8)).toEqual(le(0x77n, 8))
    emu.step()
    expect(reg(emu, 'rax')).toBe(0x3ff0n)
    emu.step()
    expect(reg(emu, 'rcx')).toBe(0x77n)
    expect(reg(emu, 'rsp')).toBe(0x200n)
    const r = emu.step()
    expect(r.status).toBe('halted')
    expect(reg(emu, 'rsp')).toBe(0x208n)
  })

  it('ends the program when ret pops a custom osReturnAddress', () => {
    const emu = boot(simple, { osReturnAddress: 0x12345678n })
    expect(emu.readMemory(START_RSP, 8)).toEqual(le(0x12345678n, 8))
    stepN(emu, 2)
    expect(snap(emu).status).toBe('halted')
    expect(snap(emu).error).toBeNull()
  })

  it('allows reading a little above the starting rsp', () => {
    const emu = bootMain(['mov rax, [rsp+8]', 'mov rbx, [rsp+64]', 'ret'], {
      initialRegisters: { rax: 9n, rbx: 9n },
    })
    stepN(emu, 2)
    expect(snap(emu).status).toBe('running')
    expect(reg(emu, 'rax')).toBe(0n)
    expect(reg(emu, 'rbx')).toBe(0n)
  })

  // Changed by the lead (contract section 1, Nov 17): the stack never reaches below 0x40,
  // so a NULL pointer always faults. This test used to let the stack reach address 0.
  it('lets a small-layout stack reach down to 0x40, and stops a push below it', () => {
    const emu = bootMain(['mov rsp, 0x50', 'push rax', 'push rax', 'push rax', 'ret'], {
      ...SMALL,
      initialRegisters: { rax: 0x5an },
    })
    stepN(emu, 3)
    expect(snap(emu).status).toBe('running')
    expect(reg(emu, 'rsp')).toBe(0x40n)
    expect(emu.readMemory(0x40n, 8)).toEqual(le(0x5an, 8))
    const r = emu.step()
    expect(r.status).toBe('error')
    // Contract: a push that would move rsp below the stack region.
    expect(r.error?.code).toBe('stack-overflow')
    expect(reg(emu, 'rsp')).toBe(0x40n)
  })
})

/* ═══════════════════ 2. The write rules through real instructions ═══════════════════ */

describe('2. Write rules through real instructions', () => {
  const START = 0x1111222233334444n

  const partRows: { name: string; base: Reg64; expected: bigint }[] = [
    { name: 'mov al, 7', base: 'rax', expected: 0x1111222233334407n },
    { name: 'mov ah, 5', base: 'rax', expected: 0x1111222233330544n },
    { name: 'mov ax, 7', base: 'rax', expected: 0x1111222233330007n },
    { name: 'mov eax, 7', base: 'rax', expected: 0x0000000000000007n },
    { name: 'mov bl, 7', base: 'rbx', expected: 0x1111222233334407n },
    { name: 'mov bh, 5', base: 'rbx', expected: 0x1111222233330544n },
    { name: 'mov bx, 7', base: 'rbx', expected: 0x1111222233330007n },
    { name: 'mov ebx, 7', base: 'rbx', expected: 0x0000000000000007n },
    { name: 'mov ch, 5', base: 'rcx', expected: 0x1111222233330544n },
    { name: 'mov dl, 7', base: 'rdx', expected: 0x1111222233334407n },
    { name: 'mov sil, 7', base: 'rsi', expected: 0x1111222233334407n },
    { name: 'mov si, 7', base: 'rsi', expected: 0x1111222233330007n },
    { name: 'mov esi, 7', base: 'rsi', expected: 0x0000000000000007n },
    { name: 'mov dil, 7', base: 'rdi', expected: 0x1111222233334407n },
    { name: 'mov di, 7', base: 'rdi', expected: 0x1111222233330007n },
    { name: 'mov edi, 7', base: 'rdi', expected: 0x0000000000000007n },
    { name: 'mov r8b, 7', base: 'r8', expected: 0x1111222233334407n },
    { name: 'mov r8w, 7', base: 'r8', expected: 0x1111222233330007n },
    { name: 'mov r8d, 7', base: 'r8', expected: 0x0000000000000007n },
    { name: 'mov r15b, 7', base: 'r15', expected: 0x1111222233334407n },
    { name: 'mov r15w, 7', base: 'r15', expected: 0x1111222233330007n },
    { name: 'mov r15d, 7', base: 'r15', expected: 0x0000000000000007n },
  ]

  it.each(partRows)('`$name` on 0x1111222233334444', ({ name, base, expected }) => {
    const emu = bootMain([name, 'ret'], { initialRegisters: oneReg(base, START) })
    const r = emu.step()
    expect(r.status).toBe('running')
    expect(snap(emu).registers[base]).toBe(expected)
  })

  // rax = 0xaaaaaaaa00000005, rbx = 3, rcx = 0x80. [rsp] holds 0x00007ffff7c29d90.
  const TOP = 0xaaaaaaaa00000005n
  const regs = { rax: TOP, rbx: 3n, rcx: 0x80n }

  const clearRows: { code: string; expected: bigint }[] = [
    { code: 'add eax, 1', expected: 6n },
    { code: 'sub eax, 1', expected: 4n },
    { code: 'xor eax, 3', expected: 6n },
    { code: 'and eax, 0xff', expected: 5n },
    { code: 'or eax, 0', expected: 5n },
    { code: 'inc eax', expected: 6n },
    { code: 'dec eax', expected: 4n },
    { code: 'imul eax, ebx', expected: 15n },
    { code: 'imul eax, 3', expected: 15n },
    { code: 'lea eax, [rax+1]', expected: 6n },
    { code: 'movzx eax, bl', expected: 3n },
    { code: 'movsx eax, cl', expected: 0xffffff80n },
    { code: 'movzx eax, word ptr [rsp]', expected: 0x9d90n },
    { code: 'mov eax, dword ptr [rsp]', expected: 0xf7c29d90n },
    { code: 'mov eax, [rsp]', expected: 0xf7c29d90n },
    { code: 'mov eax, ebx', expected: 3n },
    { code: 'mov eax, 5', expected: 5n },
    { code: 'add eax, ebx', expected: 8n },
    { code: 'xor eax, eax', expected: 0n },
  ]

  it.each(clearRows)(
    '32-bit destination: `$code` clears the top half of rax',
    ({ code, expected }) => {
      const emu = bootMain([code, 'ret'], { initialRegisters: regs })
      expect(emu.step().status).toBe('running')
      expect(reg(emu, 'rax')).toBe(expected)
    },
  )

  const keepRows: { code: string; expected: bigint }[] = [
    { code: 'add al, 1', expected: 0xaaaaaaaa00000006n },
    { code: 'add ax, 1', expected: 0xaaaaaaaa00000006n },
    { code: 'sub al, 1', expected: 0xaaaaaaaa00000004n },
    { code: 'sub ax, 6', expected: 0xaaaaaaaa0000ffffn },
    { code: 'xor al, 3', expected: 0xaaaaaaaa00000006n },
    { code: 'and ax, 4', expected: 0xaaaaaaaa00000004n },
    { code: 'or al, 0', expected: TOP },
    { code: 'inc ax', expected: 0xaaaaaaaa00000006n },
    { code: 'dec al', expected: 0xaaaaaaaa00000004n },
    { code: 'imul ax, bx', expected: 0xaaaaaaaa0000000fn },
    { code: 'lea ax, [rax+1]', expected: 0xaaaaaaaa00000006n },
    { code: 'movzx ax, bl', expected: 0xaaaaaaaa00000003n },
    { code: 'movsx ax, cl', expected: 0xaaaaaaaa0000ff80n },
    { code: 'mov al, byte ptr [rsp]', expected: 0xaaaaaaaa00000090n },
    { code: 'mov ax, word ptr [rsp]', expected: 0xaaaaaaaa00009d90n },
    { code: 'mov ah, 1', expected: 0xaaaaaaaa00000105n },
    { code: 'mov ax, bx', expected: 0xaaaaaaaa00000003n },
  ]

  it.each(keepRows)('8/16-bit destination: `$code` keeps the other bits', ({ code, expected }) => {
    const emu = bootMain([code, 'ret'], { initialRegisters: regs })
    expect(emu.step().status).toBe('running')
    expect(reg(emu, 'rax')).toBe(expected)
  })

  it('readRegister reads every part of a register, in any letter case', () => {
    const emu = bootMain(['ret'], { initialRegisters: { rax: 0x1122334455667788n } })
    expect(reg(emu, 'rax')).toBe(0x1122334455667788n)
    expect(reg(emu, 'EAX')).toBe(0x55667788n)
    expect(reg(emu, 'ax')).toBe(0x7788n)
    expect(reg(emu, 'ah')).toBe(0x77n)
    expect(reg(emu, 'Al')).toBe(0x88n)
    expect(() => reg(emu, 'rex')).toThrow(Error)
  })
})

/* ═════════════════════════════ 3. Each instruction ═════════════════════════════ */

interface AluRow {
  name: string
  code: string
  regs?: Partial<Record<Reg64, bigint>>
  flagsBefore?: Partial<Flags>
  /** Register (part) to read after the step. */
  read: string
  result: bigint
  flags: Flags
}

function runAluRow(row: AluRow): EmulatorApi {
  const emu = bootMain([row.code, 'ret'], {
    initialRegisters: row.regs ?? {},
    initialFlags: row.flagsBefore ?? {},
  })
  const r = emu.step()
  expect(r.executed).toBe(true)
  expect(r.status).toBe('running')
  expect(reg(emu, row.read)).toBe(row.result)
  expect(snap(emu).flags).toEqual(row.flags)
  return emu
}

const MIN64 = 0x8000000000000000n
const MAX64 = 0x7fffffffffffffffn

describe('3a. add', () => {
  const rows: AluRow[] = [
    {
      name: '8-bit 0x7f + 1 (signed overflow)',
      code: 'add al, 1',
      regs: { rax: 0x7fn },
      read: 'al',
      result: 0x80n,
      flags: F(0, 0, 1, 1),
    },
    {
      name: '8-bit 0xff + 1 (carry, zero)',
      code: 'add al, 1',
      regs: { rax: 0xffn },
      read: 'al',
      result: 0n,
      flags: F(1, 1, 0, 0),
    },
    {
      name: '8-bit 0x80 + 0x80',
      code: 'add al, bl',
      regs: { rax: 0x80n, rbx: 0x80n },
      read: 'al',
      result: 0n,
      flags: F(1, 1, 0, 1),
    },
    {
      name: '8-bit 0xff + 0xff',
      code: 'add al, bl',
      regs: { rax: 0xffn, rbx: 0xffn },
      read: 'al',
      result: 0xfen,
      flags: F(1, 0, 1, 0),
    },
    {
      name: '8-bit 5 + 3',
      code: 'add bl, 3',
      regs: { rbx: 5n },
      read: 'bl',
      result: 8n,
      flags: F(0, 0, 0, 0),
    },
    {
      name: '16-bit 0x7fff + 1',
      code: 'add ax, 1',
      regs: { rax: 0x7fffn },
      read: 'ax',
      result: 0x8000n,
      flags: F(0, 0, 1, 1),
    },
    {
      name: '16-bit 0xffff + 1',
      code: 'add ax, 1',
      regs: { rax: 0xffffn },
      read: 'ax',
      result: 0n,
      flags: F(1, 1, 0, 0),
    },
    {
      name: '16-bit 0x8000 + 0xffff',
      code: 'add ax, bx',
      regs: { rax: 0x8000n, rbx: 0xffffn },
      read: 'ax',
      result: 0x7fffn,
      flags: F(1, 0, 0, 1),
    },
    {
      name: '32-bit 0x7fffffff + 1',
      code: 'add eax, 1',
      regs: { rax: 0x7fffffffn },
      read: 'rax',
      result: 0x80000000n,
      flags: F(0, 0, 1, 1),
    },
    {
      name: '32-bit 0xffffffff + 1',
      code: 'add eax, 1',
      regs: { rax: 0xffffffffn },
      read: 'rax',
      result: 0n,
      flags: F(1, 1, 0, 0),
    },
    {
      name: '32-bit 0x80000000 + 0x80000000',
      code: 'add eax, 0x80000000',
      regs: { rax: 0x80000000n },
      read: 'rax',
      result: 0n,
      flags: F(1, 1, 0, 1),
    },
    {
      name: '32-bit 1000 + 1000',
      code: 'add eax, 1000',
      regs: { rax: 1000n },
      read: 'rax',
      result: 2000n,
      flags: F(0, 0, 0, 0),
    },
    {
      name: '64-bit max + 1',
      code: 'add rax, 1',
      regs: { rax: MAX64 },
      read: 'rax',
      result: MIN64,
      flags: F(0, 0, 1, 1),
    },
    {
      name: '64-bit 0xffffffffffffffff + 1',
      code: 'add rax, 1',
      regs: { rax: MASK[64] },
      read: 'rax',
      result: 0n,
      flags: F(1, 1, 0, 0),
    },
    {
      name: '64-bit 5 + (-3): the immediate is sign-extended',
      code: 'add rax, -3',
      regs: { rax: 5n },
      read: 'rax',
      result: 2n,
      flags: F(1, 0, 0, 0),
    },
    {
      name: '64-bit min + min',
      code: 'add rax, rbx',
      regs: { rax: MIN64, rbx: MIN64 },
      read: 'rax',
      result: 0n,
      flags: F(1, 1, 0, 1),
    },
    {
      name: '64-bit r8 + r9',
      code: 'add r8, r9',
      regs: { r8: 0x123456789n, r9: 1n },
      read: 'r8',
      result: 0x12345678an,
      flags: F(0, 0, 0, 0),
    },
  ]
  it.each(rows)('$name', (row) => {
    runAluRow(row)
  })

  it('add into memory: dword ptr [rsp] + 0x10 changes 4 bytes only', () => {
    const emu = bootMain(['add dword ptr [rsp], 0x10', 'ret'])
    emu.step()
    // low dword 0xf7c29d90 + 0x10 = 0xf7c29da0
    expect(emu.readMemory(START_RSP, 8)).toEqual([0xa0, 0x9d, 0xc2, 0xf7, 0xff, 0x7f, 0, 0])
    expect(snap(emu).flags).toEqual(F(0, 0, 1, 0))
  })

  it('add from memory: rax + [rsp]', () => {
    const emu = bootMain(['add rax, [rsp]', 'ret'], { initialRegisters: { rax: 0x10n } })
    emu.step()
    expect(reg(emu, 'rax')).toBe(0x7ffff7c29da0n)
  })
})

describe('3b. sub', () => {
  const rows: AluRow[] = [
    {
      name: '8-bit 5 - 5 = 0',
      code: 'sub al, 5',
      regs: { rax: 5n },
      read: 'al',
      result: 0n,
      flags: F(0, 1, 0, 0),
    },
    { name: '8-bit 0 - 1', code: 'sub al, 1', read: 'al', result: 0xffn, flags: F(1, 0, 1, 0) },
    {
      name: '8-bit min - 1',
      code: 'sub al, 1',
      regs: { rax: 0x80n },
      read: 'al',
      result: 0x7fn,
      flags: F(0, 0, 0, 1),
    },
    {
      name: '8-bit 0x7f - 0xff (127 - (-1))',
      code: 'sub al, bl',
      regs: { rax: 0x7fn, rbx: 0xffn },
      read: 'al',
      result: 0x80n,
      flags: F(1, 0, 1, 1),
    },
    { name: '16-bit 0 - 1', code: 'sub ax, 1', read: 'ax', result: 0xffffn, flags: F(1, 0, 1, 0) },
    {
      name: '16-bit min - 1',
      code: 'sub ax, 1',
      regs: { rax: 0x8000n },
      read: 'ax',
      result: 0x7fffn,
      flags: F(0, 0, 0, 1),
    },
    {
      name: '16-bit 3 - 5',
      code: 'sub ax, bx',
      regs: { rax: 3n, rbx: 5n },
      read: 'ax',
      result: 0xfffen,
      flags: F(1, 0, 1, 0),
    },
    {
      name: '32-bit 0 - 1',
      code: 'sub eax, 1',
      read: 'rax',
      result: 0xffffffffn,
      flags: F(1, 0, 1, 0),
    },
    {
      name: '32-bit min - 1',
      code: 'sub eax, 1',
      regs: { rax: 0x80000000n },
      read: 'rax',
      result: 0x7fffffffn,
      flags: F(0, 0, 0, 1),
    },
    {
      name: '32-bit 1 - 0xffffffff (1 - (-1))',
      code: 'sub eax, ebx',
      regs: { rax: 1n, rbx: 0xffffffffn },
      read: 'rax',
      result: 2n,
      flags: F(1, 0, 0, 0),
    },
    {
      name: '32-bit 5 - 5',
      code: 'sub ecx, 5',
      regs: { rcx: 5n },
      read: 'rcx',
      result: 0n,
      flags: F(0, 1, 0, 0),
    },
    {
      name: '64-bit 0 - 1',
      code: 'sub rax, 1',
      read: 'rax',
      result: MASK[64],
      flags: F(1, 0, 1, 0),
    },
    {
      name: '64-bit min - 1',
      code: 'sub rax, 1',
      regs: { rax: MIN64 },
      read: 'rax',
      result: MAX64,
      flags: F(0, 0, 0, 1),
    },
    {
      name: '64-bit 10 - 3',
      code: 'sub rax, rbx',
      regs: { rax: 10n, rbx: 3n },
      read: 'rax',
      result: 7n,
      flags: F(0, 0, 0, 0),
    },
    {
      name: '64-bit 5 - (-3): the immediate is sign-extended',
      code: 'sub rax, -3',
      regs: { rax: 5n },
      read: 'rax',
      result: 8n,
      flags: F(1, 0, 0, 0),
    },
    {
      name: '64-bit max - (-1) overflows',
      code: 'sub rax, -1',
      regs: { rax: MAX64 },
      read: 'rax',
      result: MIN64,
      flags: F(1, 0, 1, 1),
    },
    {
      name: 'sub rsp, 16',
      code: 'sub rsp, 16',
      read: 'rsp',
      result: 0x7ffffffddfe8n,
      flags: F(0, 0, 0, 0),
    },
  ]
  it.each(rows)('$name', (row) => {
    runAluRow(row)
  })

  it('sub from a memory byte: 0x90 - 0x91 borrows', () => {
    const emu = bootMain(['sub byte ptr [rsp], 0x91', 'ret'])
    emu.step()
    expect(emu.readMemory(START_RSP, 2)).toEqual([0xff, 0x9d])
    expect(snap(emu).flags).toEqual(F(1, 0, 1, 0))
  })
})

describe('3c. cmp stores nothing', () => {
  const rows: AluRow[] = [
    {
      name: '64-bit 5 vs 7',
      code: 'cmp rax, 7',
      regs: { rax: 5n },
      read: 'rax',
      result: 5n,
      flags: F(1, 0, 1, 0),
    },
    {
      name: '8-bit 0x80 vs 1',
      code: 'cmp al, 1',
      regs: { rax: 0x80n },
      read: 'rax',
      result: 0x80n,
      flags: F(0, 0, 0, 1),
    },
    {
      name: '32-bit 7 vs 7',
      code: 'cmp eax, ebx',
      regs: { rax: 7n, rbx: 7n },
      read: 'rax',
      result: 7n,
      flags: F(0, 1, 0, 0),
    },
    {
      name: '16-bit 0x7fff vs 0xffff',
      code: 'cmp ax, bx',
      regs: { rax: 0x7fffn, rbx: 0xffffn },
      read: 'rax',
      result: 0x7fffn,
      flags: F(1, 0, 1, 1),
    },
    {
      name: '32-bit cmp does not clear the top half',
      code: 'cmp eax, 1',
      regs: { rax: 0xaaaaaaaa00000005n },
      read: 'rax',
      result: 0xaaaaaaaa00000005n,
      flags: F(0, 0, 0, 0),
    },
  ]
  it.each(rows)('$name', (row) => {
    const emu = runAluRow(row)
    expect(must(snap(emu).lastStep, 'lastStep').diff.registers).toEqual([])
  })

  it('cmp with a memory operand leaves memory alone', () => {
    const emu = bootMain(['cmp qword ptr [rsp], 0', 'ret'])
    const r = emu.step()
    expect(emu.readMemory(START_RSP, 8)).toEqual(le(OS_RET, 8))
    expect(r.diff.memory).toEqual([])
    expect(snap(emu).flags).toEqual(F(0, 0, 0, 0))
  })
})

describe('3d. inc and dec leave CF alone', () => {
  const rows: AluRow[] = [
    {
      name: 'inc al on 0xff with CF=0: CF stays 0',
      code: 'inc al',
      regs: { rax: 0xffn },
      flagsBefore: { CF: 0 },
      read: 'al',
      result: 0n,
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'inc al on 0xff with CF=1: CF stays 1',
      code: 'inc al',
      regs: { rax: 0xffn },
      flagsBefore: { CF: 1 },
      read: 'al',
      result: 0n,
      flags: F(1, 1, 0, 0),
    },
    {
      name: 'inc al on 0x7f',
      code: 'inc al',
      regs: { rax: 0x7fn },
      read: 'al',
      result: 0x80n,
      flags: F(0, 0, 1, 1),
    },
    {
      name: 'inc ax on 0x7fff with CF=1',
      code: 'inc ax',
      regs: { rax: 0x7fffn },
      flagsBefore: { CF: 1 },
      read: 'ax',
      result: 0x8000n,
      flags: F(1, 0, 1, 1),
    },
    {
      name: 'inc eax on 0xffffffff with CF=1',
      code: 'inc eax',
      regs: { rax: 0xffffffffn },
      flagsBefore: { CF: 1 },
      read: 'rax',
      result: 0n,
      flags: F(1, 1, 0, 0),
    },
    {
      name: 'inc rax on max',
      code: 'inc rax',
      regs: { rax: MAX64 },
      read: 'rax',
      result: MIN64,
      flags: F(0, 0, 1, 1),
    },
    {
      name: 'inc rbx on 5',
      code: 'inc rbx',
      regs: { rbx: 5n },
      read: 'rbx',
      result: 6n,
      flags: F(0, 0, 0, 0),
    },
    {
      name: 'inc ecx clears ZF SF OF that were set, keeps CF',
      code: 'inc ecx',
      regs: { rcx: 1n },
      flagsBefore: { CF: 1, ZF: 1, SF: 1, OF: 1 },
      read: 'rcx',
      result: 2n,
      flags: F(1, 0, 0, 0),
    },
    {
      name: 'dec al on 0x80',
      code: 'dec al',
      regs: { rax: 0x80n },
      read: 'al',
      result: 0x7fn,
      flags: F(0, 0, 0, 1),
    },
    {
      name: 'dec al on 0 with CF=0: CF stays 0',
      code: 'dec al',
      flagsBefore: { CF: 0 },
      read: 'al',
      result: 0xffn,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'dec eax on 0 with CF=1: CF stays 1',
      code: 'dec eax',
      flagsBefore: { CF: 1 },
      read: 'rax',
      result: 0xffffffffn,
      flags: F(1, 0, 1, 0),
    },
    {
      name: 'dec ax on 1',
      code: 'dec ax',
      regs: { rax: 1n },
      read: 'ax',
      result: 0n,
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'dec rax on min with CF=1',
      code: 'dec rax',
      regs: { rax: MIN64 },
      flagsBefore: { CF: 1 },
      read: 'rax',
      result: MAX64,
      flags: F(1, 0, 0, 1),
    },
    { name: 'dec rdx on 0', code: 'dec rdx', read: 'rdx', result: MASK[64], flags: F(0, 0, 1, 0) },
  ]
  it.each(rows)('$name', (row) => {
    runAluRow(row)
  })

  it('inc qword ptr [rsp] changes the memory value', () => {
    const emu = bootMain(['inc qword ptr [rsp]', 'ret'], { initialFlags: { CF: 1 } })
    emu.step()
    expect(emu.readMemory(START_RSP, 8)).toEqual(le(OS_RET + 1n, 8))
    expect(snap(emu).flags).toEqual(F(1, 0, 0, 0))
  })
})

describe('3e. imul (2-operand)', () => {
  interface ImulRow {
    name: string
    size: 16 | 32 | 64
    a: bigint
    b: bigint
    /** Use `b` as an immediate instead of a register. */
    imm?: boolean
    result: bigint
    overflow: Bit
  }
  const NAMES = { 16: ['ax', 'bx'], 32: ['eax', 'ebx'], 64: ['rax', 'rbx'] } as const
  const rows: ImulRow[] = [
    { name: '16-bit 100 * 200 fits', size: 16, a: 100n, b: 200n, result: 0x4e20n, overflow: 0 },
    {
      name: '16-bit 300 * 200 overflows',
      size: 16,
      a: 300n,
      b: 200n,
      result: 0xea60n,
      overflow: 1,
    },
    { name: '16-bit -3 * 7', size: 16, a: -3n, b: 7n, result: 0xffebn, overflow: 0 },
    {
      name: '16-bit 0x100 * 0x100 overflows to 0',
      size: 16,
      a: 0x100n,
      b: 0x100n,
      result: 0n,
      overflow: 1,
    },
    {
      name: '16-bit -128 * 256 = min fits',
      size: 16,
      a: -128n,
      b: 256n,
      result: 0x8000n,
      overflow: 0,
    },
    {
      name: '16-bit 40 * 1000 (immediate) overflows',
      size: 16,
      a: 40n,
      b: 1000n,
      imm: true,
      result: 0x9c40n,
      overflow: 1,
    },
    {
      name: '32-bit 0x10000 * 0x7fff fits',
      size: 32,
      a: 0x10000n,
      b: 0x7fffn,
      result: 0x7fff0000n,
      overflow: 0,
    },
    {
      name: '32-bit 0x10000 * 0x10000 overflows to 0',
      size: 32,
      a: 0x10000n,
      b: 0x10000n,
      result: 0n,
      overflow: 1,
    },
    {
      name: '32-bit 0x10000 * 0x8000 = 2^31 overflows',
      size: 32,
      a: 0x10000n,
      b: 0x8000n,
      result: 0x80000000n,
      overflow: 1,
    },
    { name: '32-bit -2 * -3', size: 32, a: -2n, b: -3n, result: 6n, overflow: 0 },
    {
      name: '32-bit -65536 * 65536 (immediate) overflows',
      size: 32,
      a: -65536n,
      b: 65536n,
      imm: true,
      result: 0n,
      overflow: 1,
    },
    {
      name: '32-bit -0x40000000 * 2 (immediate) = min fits',
      size: 32,
      a: -0x40000000n,
      b: 2n,
      imm: true,
      result: 0x80000000n,
      overflow: 0,
    },
    {
      name: '32-bit 0x7fffffff * -1 (immediate)',
      size: 32,
      a: 0x7fffffffn,
      b: -1n,
      imm: true,
      result: 0x80000001n,
      overflow: 0,
    },
    {
      name: '32-bit min * -1 overflows',
      size: 32,
      a: -0x80000000n,
      b: -1n,
      result: 0x80000000n,
      overflow: 1,
    },
    {
      name: '64-bit 2^32 * 0x7fffffff fits',
      size: 64,
      a: 0x100000000n,
      b: 0x7fffffffn,
      result: 0x7fffffff00000000n,
      overflow: 0,
    },
    {
      name: '64-bit 2^32 * 2^32 overflows to 0',
      size: 64,
      a: 0x100000000n,
      b: 0x100000000n,
      result: 0n,
      overflow: 1,
    },
    {
      name: '64-bit -5 * 3 (immediate)',
      size: 64,
      a: -5n,
      b: 3n,
      imm: true,
      result: 0xfffffffffffffff1n,
      overflow: 0,
    },
    {
      name: '64-bit 2^62 * -2 = min fits',
      size: 64,
      a: 0x4000000000000000n,
      b: -2n,
      result: MIN64,
      overflow: 0,
    },
    {
      name: '64-bit 2^62 * 2 (immediate) overflows',
      size: 64,
      a: 0x4000000000000000n,
      b: 2n,
      imm: true,
      result: MIN64,
      overflow: 1,
    },
    {
      name: '64-bit min * -1 (immediate) overflows',
      size: 64,
      a: -MIN64,
      b: -1n,
      imm: true,
      result: MIN64,
      overflow: 1,
    },
    { name: '64-bit -1 * -1', size: 64, a: -1n, b: -1n, result: 1n, overflow: 0 },
  ]

  it.each(rows)('$name', (row) => {
    // Check my own table with plain BigInt maths first.
    const product = row.a * row.b
    expect(BigInt.asUintN(row.size, product)).toBe(row.result)
    expect(BigInt.asIntN(row.size, product) === product ? 0 : 1).toBe(row.overflow)

    const [dest, src] = NAMES[row.size]
    const code = `imul ${dest}, ${row.imm ? row.b.toString() : src}`
    const emu = bootMain([code, 'ret'], {
      initialRegisters: {
        rax: BigInt.asUintN(row.size, row.a),
        rbx: row.imm ? 0n : BigInt.asUintN(row.size, row.b),
      },
    })
    expect(emu.step().status).toBe('running')
    expect(reg(emu, dest)).toBe(row.result)
    const sf: Bit = BigInt.asUintN(1, row.result >> BigInt(row.size - 1)) === 1n ? 1 : 0
    // CF = OF = overflow; SF and ZF from the result (the contract's documented choice).
    expect(snap(emu).flags).toEqual(F(row.overflow, row.result === 0n ? 1 : 0, sf, row.overflow))
  })

  it('imul r9, r10 (extended registers)', () => {
    const emu = bootMain(['imul r9, r10', 'ret'], { initialRegisters: { r9: 7n, r10: 6n } })
    emu.step()
    expect(reg(emu, 'r9')).toBe(42n)
  })

  it('imul eax, dword ptr [rsp+8]: a memory source', () => {
    const emu = bootMain(
      ['sub rsp, 16', 'mov dword ptr [rsp+8], -4', 'imul eax, dword ptr [rsp+8]', 'ret'],
      {
        initialRegisters: { rax: 5n },
      },
    )
    stepN(emu, 3)
    expect(reg(emu, 'rax')).toBe(0xffffffecn) // -20 in 32 bits, top half 0
    expect(snap(emu).flags).toEqual(F(0, 0, 1, 0))
  })
})

describe('3f. and / or / xor / test clear CF and OF', () => {
  const before: Partial<Flags> = { CF: 1, OF: 1 }
  const rows: AluRow[] = [
    {
      name: 'and eax, 0x0f on 0xf0 gives 0',
      code: 'and eax, 0x0f',
      regs: { rax: 0xf0n },
      read: 'rax',
      result: 0n,
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'and rax, -16 sign-extends the immediate',
      code: 'and rax, -16',
      regs: { rax: 0x123456789abcdeffn },
      read: 'rax',
      result: 0x123456789abcdef0n,
      flags: F(0, 0, 0, 0),
    },
    {
      name: 'and al, bl keeps the sign bit',
      code: 'and al, bl',
      regs: { rax: 0xffn, rbx: 0x80n },
      read: 'al',
      result: 0x80n,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'and ax, 0x0ff0',
      code: 'and ax, 0x0ff0',
      regs: { rax: 0x1234n },
      read: 'ax',
      result: 0x0230n,
      flags: F(0, 0, 0, 0),
    },
    {
      name: 'or al, 1 on 0x80',
      code: 'or al, 1',
      regs: { rax: 0x80n },
      read: 'al',
      result: 0x81n,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'or eax, -1',
      code: 'or eax, -1',
      read: 'rax',
      result: 0xffffffffn,
      flags: F(0, 0, 1, 0),
    },
    { name: 'or ax, 0 on 0', code: 'or ax, 0', read: 'ax', result: 0n, flags: F(0, 1, 0, 0) },
    {
      name: 'or rax, rbx sets the 64-bit sign bit',
      code: 'or rax, rbx',
      regs: { rax: 1n, rbx: MIN64 },
      read: 'rax',
      result: MIN64 + 1n,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'xor rax, rax',
      code: 'xor rax, rax',
      regs: { rax: 5n },
      read: 'rax',
      result: 0n,
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'xor ax, 0xff on 0xffff',
      code: 'xor ax, 0xff',
      regs: { rax: 0xffffn },
      read: 'ax',
      result: 0xff00n,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'xor eax, ebx',
      code: 'xor eax, ebx',
      regs: { rax: 0x80000000n, rbx: 1n },
      read: 'rax',
      result: 0x80000001n,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'xor r8b, 0x0f',
      code: 'xor r8b, 0x0f',
      regs: { r8: 0xf0n },
      read: 'r8b',
      result: 0xffn,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'test al, 0x80 stores nothing',
      code: 'test al, 0x80',
      regs: { rax: 0x80n },
      read: 'rax',
      result: 0x80n,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'test ax, 0x8000',
      code: 'test ax, 0x8000',
      regs: { rax: 0x7fffn },
      read: 'rax',
      result: 0x7fffn,
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'test rax, rax on 0',
      code: 'test rax, rax',
      read: 'rax',
      result: 0n,
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'test eax, ebx with no common bits',
      code: 'test eax, ebx',
      regs: { rax: 0x0fn, rbx: 0xf0n },
      read: 'rax',
      result: 0x0fn,
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'test rax, -1 sign-extends the immediate',
      code: 'test rax, -1',
      regs: { rax: MIN64 },
      read: 'rax',
      result: MIN64,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'test eax, eax keeps the top half',
      code: 'test eax, eax',
      regs: { rax: 0xaaaaaaaa00000000n },
      read: 'rax',
      result: 0xaaaaaaaa00000000n,
      flags: F(0, 1, 0, 0),
    },
  ]
  it.each(rows)('$name', (row) => {
    runAluRow({ ...row, flagsBefore: before })
  })

  it('test with a memory operand stores nothing', () => {
    const emu = bootMain(['test qword ptr [rsp], 0xff', 'ret'], { initialFlags: before })
    const r = emu.step()
    expect(r.diff.memory).toEqual([])
    expect(r.diff.registers).toEqual([])
    expect(emu.readMemory(START_RSP, 8)).toEqual(le(OS_RET, 8))
    expect(snap(emu).flags).toEqual(F(0, 0, 0, 0)) // 0x90 & 0xff = 0x90: not zero, top bit 0
  })

  it('and word ptr [rsp], 0xff changes only 2 bytes', () => {
    const emu = bootMain(['and word ptr [rsp], 0xff', 'ret'])
    emu.step()
    expect(emu.readMemory(START_RSP, 8)).toEqual([0x90, 0x00, 0xc2, 0xf7, 0xff, 0x7f, 0, 0])
  })
})

describe('3g. movzx and movsx', () => {
  const rows: {
    code: string
    regs: Partial<Record<Reg64, bigint>>
    read: string
    result: bigint
  }[] = [
    { code: 'movzx eax, bl', regs: { rbx: 0x80n }, read: 'rax', result: 0x80n },
    { code: 'movsx eax, bl', regs: { rbx: 0x80n }, read: 'rax', result: 0xffffff80n },
    { code: 'movsx rax, bl', regs: { rbx: 0x80n }, read: 'rax', result: 0xffffffffffffff80n },
    { code: 'movzx rax, bl', regs: { rax: MASK[64], rbx: 0x80n }, read: 'rax', result: 0x80n },
    { code: 'movzx ecx, bl', regs: { rbx: 0x7fn }, read: 'rcx', result: 0x7fn },
    { code: 'movsx ecx, bl', regs: { rbx: 0x7fn }, read: 'rcx', result: 0x7fn },
    { code: 'movsx rcx, bl', regs: { rcx: MASK[64], rbx: 0x7fn }, read: 'rcx', result: 0x7fn },
    { code: 'movzx eax, bx', regs: { rbx: 0x8000n }, read: 'rax', result: 0x8000n },
    { code: 'movsx eax, bx', regs: { rbx: 0x8000n }, read: 'rax', result: 0xffff8000n },
    { code: 'movsx rax, bx', regs: { rbx: 0x8000n }, read: 'rax', result: 0xffffffffffff8000n },
    { code: 'movsx edx, bx', regs: { rbx: 0x7fffn }, read: 'rdx', result: 0x7fffn },
    {
      code: 'movsx ax, bl',
      regs: { rax: 0x1111222233334444n, rbx: 0x80n },
      read: 'rax',
      result: 0x111122223333ff80n,
    },
    {
      code: 'movzx ax, bl',
      regs: { rax: 0x1111222233334444n, rbx: 0x80n },
      read: 'rax',
      result: 0x1111222233330080n,
    },
    {
      code: 'movsx rax, ebx',
      regs: { rbx: 0x80000000n },
      read: 'rax',
      result: 0xffffffff80000000n,
    },
    {
      code: 'movsx rax, ebx',
      regs: { rax: 1n, rbx: 0x7fffffffn },
      read: 'rax',
      result: 0x7fffffffn,
    },
    { code: 'movzx eax, bh', regs: { rbx: 0x8000n }, read: 'rax', result: 0x80n },
    { code: 'movsx eax, ah', regs: { rax: 0xff00n }, read: 'rax', result: 0xffffffffn },
    { code: 'movzx eax, byte ptr [rsp]', regs: {}, read: 'rax', result: 0x90n },
    { code: 'movsx eax, byte ptr [rsp]', regs: {}, read: 'rax', result: 0xffffff90n },
    { code: 'movzx ecx, word ptr [rsp]', regs: {}, read: 'rcx', result: 0x9d90n },
    { code: 'movsx rcx, word ptr [rsp]', regs: {}, read: 'rcx', result: 0xffffffffffff9d90n },
    { code: 'movsx rdx, dword ptr [rsp]', regs: {}, read: 'rdx', result: 0xfffffffff7c29d90n },
  ]
  it.each(rows)('`$code` gives $result', ({ code, regs, read, result }) => {
    const emu = bootMain([code, 'ret'], { initialRegisters: regs, initialFlags: F(1, 1, 1, 1) })
    expect(emu.step().status).toBe('running')
    expect(reg(emu, read)).toBe(result)
    expect(snap(emu).flags).toEqual(F(1, 1, 1, 1)) // no flags change
  })
})

describe('3h. lea', () => {
  const before = [
    '.equ count, -8',
    'message: .string "Hi"',
    '.data',
    'arr: .quad 1, 2, 3, 4',
    '.text',
  ]
  const regs = { rbx: 0x1000n, rcx: 3n, rbp: 0x2000n }
  const rows: { code: string; result: bigint }[] = [
    { code: 'lea rax, [rbx]', result: 0x1000n },
    { code: 'lea rax, [rbx+8]', result: 0x1008n },
    { code: 'lea rax, [rbx-8]', result: 0xff8n },
    { code: 'lea rax, -8[rbx]', result: 0xff8n },
    { code: 'lea rax, 8[rbx]', result: 0x1008n },
    { code: 'lea rax, [rbx+rcx]', result: 0x1003n },
    { code: 'lea rax, [rbx+rcx*4]', result: 0x100cn },
    { code: 'lea rax, [rbx+rcx*8+16]', result: 0x1028n },
    { code: 'lea rax, [rcx*2]', result: 6n },
    { code: 'lea rax, [rcx*8+5]', result: 29n },
    { code: 'lea rax, count[rbp]', result: 0x1ff8n },
    { code: 'lea rax, count+8[rbp]', result: 0x2000n },
    { code: 'lea rax, [rbp+count]', result: 0x1ff8n },
    { code: 'lea rdi, message[rip]', result: RODATA_BASE },
    { code: 'lea rsi, arr[rcx*8]', result: DATA_BASE + 24n },
    { code: 'lea rdx, arr+8[rip]', result: DATA_BASE + 8n },
  ]
  it.each(rows)('`$code` = $result', ({ code, result }) => {
    const emu = bootMain(
      [code, 'ret'],
      { initialRegisters: regs, initialFlags: F(1, 0, 1, 0) },
      before,
    )
    const r = emu.step()
    expect(r.status).toBe('running')
    expect(reg(emu, code.slice(4, 7))).toBe(result)
    expect(snap(emu).flags).toEqual(F(1, 0, 1, 0))
  })

  it('lea never touches memory: a wild address does not fault and gives no note', () => {
    const emu = bootMain(['lea rax, [rbx+8]', 'lea rcx, [rsp-64]', 'ret'], {
      initialRegisters: { rbx: 0x123n },
    })
    const [r1, r2] = stepN(emu, 2)
    expect(r1?.status).toBe('running')
    expect(r1?.notes).toEqual([])
    expect(r2?.notes).toEqual([])
    expect(reg(emu, 'rax')).toBe(0x12bn)
    expect(reg(emu, 'rcx')).toBe(START_RSP - 64n)
  })

  it('lea wraps to 64 bits', () => {
    const emu = bootMain(['lea rax, [rbx-16]', 'ret'], { initialRegisters: { rbx: 8n } })
    emu.step()
    expect(reg(emu, 'rax')).toBe(0xfffffffffffffff8n)
  })

  it('lea into a 32-bit register keeps the low 32 bits and clears the top half', () => {
    const emu = bootMain(['lea eax, [rbx+8]', 'ret'], {
      initialRegisters: { rax: MASK[64], rbx: 0x1234567800000010n },
    })
    emu.step()
    expect(reg(emu, 'rax')).toBe(0x18n)
  })
})

describe('3i. mov', () => {
  const rows: {
    code: string
    regs?: Partial<Record<Reg64, bigint>>
    read: string
    result: bigint
  }[] = [
    { code: 'mov rax, 0x1122334455667788', read: 'rax', result: 0x1122334455667788n },
    { code: 'mov rax, -1', read: 'rax', result: MASK[64] },
    { code: 'mov rax, 0x80000000', read: 'rax', result: 0x80000000n },
    { code: 'mov rax, 0xffffffff', read: 'rax', result: 0xffffffffn },
    { code: 'mov rax, -0x80000000', read: 'rax', result: 0xffffffff80000000n },
    { code: 'mov rax, 0xffffffffffffffff', read: 'rax', result: MASK[64] },
    { code: 'mov eax, -1', regs: { rax: 0x1111222233334444n }, read: 'rax', result: 0xffffffffn },
    { code: 'mov ax, -1', read: 'rax', result: 0xffffn },
    { code: 'mov al, 255', read: 'rax', result: 0xffn },
    { code: 'mov al, -1', read: 'rax', result: 0xffn },
    { code: "mov cl, 'A'", read: 'rcx', result: 0x41n },
    { code: 'mov rbx, rax', regs: { rax: 0xdeadbeefcafen }, read: 'rbx', result: 0xdeadbeefcafen },
    { code: 'mov r10, 0x7fffffffffffffff', read: 'r10', result: MAX64 },
    {
      code: 'mov r11d, r10d',
      regs: { r10: 0x1234567890n, r11: MASK[64] },
      read: 'r11',
      result: 0x34567890n,
    },
    { code: 'mov rax, [rsp]', read: 'rax', result: OS_RET },
  ]
  it.each(rows)('`$code`', ({ code, regs, read, result }) => {
    const emu = bootMain([code, 'ret'], {
      initialRegisters: regs ?? {},
      initialFlags: F(1, 1, 1, 1),
    })
    expect(emu.step().status).toBe('running')
    expect(reg(emu, read)).toBe(result)
    expect(snap(emu).flags).toEqual(F(1, 1, 1, 1))
  })

  const memRows: { code: string; bytes: (number | null)[] }[] = [
    { code: 'mov qword ptr [rsp-8], -1', bytes: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] },
    { code: 'mov qword ptr [rsp-8], 0x7fffffff', bytes: [0xff, 0xff, 0xff, 0x7f, 0, 0, 0, 0] },
    { code: 'mov qword ptr [rsp-8], -0x80000000', bytes: [0, 0, 0, 0x80, 0xff, 0xff, 0xff, 0xff] },
    { code: 'mov dword ptr [rsp-8], -1', bytes: [0xff, 0xff, 0xff, 0xff, null, null, null, null] },
    {
      code: 'mov word ptr [rsp-8], 0x1234',
      bytes: [0x34, 0x12, null, null, null, null, null, null],
    },
    { code: 'mov byte ptr [rsp-8], 0x41', bytes: [0x41, null, null, null, null, null, null, null] },
    { code: 'mov [rsp-8], rax', bytes: [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11] },
    { code: 'mov [rsp-8], eax', bytes: [0x88, 0x77, 0x66, 0x55, null, null, null, null] },
    { code: 'mov [rsp-8], ax', bytes: [0x88, 0x77, null, null, null, null, null, null] },
    { code: 'mov [rsp-8], ah', bytes: [0x77, null, null, null, null, null, null, null] },
  ]
  it.each(memRows)('`$code` writes the right bytes', ({ code, bytes }) => {
    const emu = bootMain([code, 'ret'], { initialRegisters: { rax: 0x1122334455667788n } })
    expect(emu.step().status).toBe('running')
    expect(emu.readMemory(START_RSP - 8n, 8)).toEqual(bytes)
  })

  it('nop changes nothing but rip', () => {
    const emu = bootMain(['nop', 'endbr64', 'ret'])
    const before = snap(emu)
    const [r1, r2] = stepN(emu, 2)
    expect(r1?.diff.registers).toEqual([])
    expect(r2?.diff.registers).toEqual([])
    expect(snap(emu).rip).toBe(instr(emu, 2).address)
    expect(instr(emu, 1).address - instr(emu, 0).address).toBe(1n) // nop = 1 byte
    expect(instr(emu, 2).address - instr(emu, 1).address).toBe(4n) // endbr64 = 4 bytes
    expect(deepDiff(snap(emu).registers, before.registers)).toEqual([])
  })
})

/* ═══════════════════════════════════ 4. Memory ═══════════════════════════════════ */

/** Step once and check the contract's "atomic fault" rules. */
function expectAtomicFault(emu: EmulatorApi, code: string): StepResult {
  const before = snap(emu)
  const index = must(emu.program.addressToIndex.get(before.rip), 'faulting instruction')
  const r = emu.step()
  const after = snap(emu)
  expect(r.executed).toBe(true)
  expect(r.status).toBe('error')
  expect(r.error?.code).toBe(code)
  expect(r.error?.line).toBe(instr(emu, index).line)
  expect(r.error?.message ?? '').not.toBe('')
  expect(after.status).toBe('error')
  expect(after.error?.code).toBe(code)
  expect(after.stepCount).toBe(before.stepCount + 1)
  expect(after.rip).toBe(before.rip)
  expect(r.diff.registers).toEqual([])
  expect(r.diff.flags).toEqual([])
  expect(r.diff.memory).toEqual([])
  expect(r.diff.rip.before).toBe(r.diff.rip.after)
  expect(deepDiff(after.registers, before.registers)).toEqual([])
  expect(deepDiff(after.flags, before.flags)).toEqual([])
  expect(
    deepDiff(
      after.stack.map((b) => b.bytes),
      before.stack.map((b) => b.bytes),
    ),
  ).toEqual([])
  return r
}

describe('4. Memory', () => {
  it('stores 0x1122334455667788 little-endian and reads it back byte by byte', () => {
    const lines = ['sub rsp, 16', 'mov rax, 0x1122334455667788', 'mov [rsp], rax']
    for (let i = 0; i < 8; i++) lines.push(`mov cl, byte ptr [rsp+${i}]`)
    const emu = bootMain([...lines, 'add rsp, 16', 'ret'])
    stepN(emu, 3)
    const expected = [0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11]
    expect(emu.readMemory(0x7ffffffddfe8n, 8)).toEqual(expected)
    for (const byte of expected) {
      emu.step()
      expect(reg(emu, 'cl')).toBe(BigInt(byte))
    }
  })

  it('a dword ptr store changes 4 bytes and leaves the other 4 untouched', () => {
    const emu = bootMain([
      'sub rsp, 16',
      'mov rax, -1',
      'mov [rsp], rax',
      'mov dword ptr [rsp], 0x11223344',
      'ret',
    ])
    stepN(emu, 4)
    expect(emu.readMemory(0x7ffffffddfe8n, 8)).toEqual([
      0x44, 0x33, 0x22, 0x11, 0xff, 0xff, 0xff, 0xff,
    ])
  })

  it('a word ptr store in the middle of a box changes only those 2 bytes', () => {
    const emu = bootMain([
      'sub rsp, 16',
      'mov rax, -1',
      'mov [rsp], rax',
      'mov word ptr [rsp+2], 0xbeef',
      'ret',
    ])
    stepN(emu, 4)
    expect(emu.readMemory(0x7ffffffddfe8n, 8)).toEqual([
      0xff, 0xff, 0xef, 0xbe, 0xff, 0xff, 0xff, 0xff,
    ])
  })

  it('.equ offsets with name[rbp] address the boxes below rbp', () => {
    const emu = bootMain(
      [
        'push rbp',
        'mov rbp, rsp',
        'sub rsp, 16',
        'mov qword ptr count[rbp], 5',
        'mov qword ptr total[rbp], 7',
        'mov rax, count[rbp]',
        'add rax, total[rbp]',
        'leave',
        'ret',
      ],
      {},
      ['.equ count, -8', '.equ total, -16'],
    )
    stepN(emu, 5)
    expect(emu.readMemory(0x7ffffffddfe8n, 8)).toEqual(le(5n, 8))
    expect(emu.readMemory(0x7ffffffddfe0n, 8)).toEqual(le(7n, 8))
    emu.step()
    expect(reg(emu, 'rax')).toBe(5n)
    emu.step()
    expect(reg(emu, 'rax')).toBe(12n)
  })

  it('[rbp-8], -8[rbp], [rbx], 8[rsp] and [rsp+8] can name the same box', () => {
    const emu = bootMain([
      'push rbp',
      'mov rbp, rsp',
      'sub rsp, 16',
      'mov qword ptr [rbp-8], 11',
      'mov rax, -8[rbp]',
      'lea rbx, [rbp-8]',
      'mov rcx, [rbx]',
      'mov rdx, 8[rsp]',
      'mov rsi, [rsp+8]',
      'leave',
      'ret',
    ])
    stepN(emu, 9)
    expect(reg(emu, 'rbx')).toBe(0x7ffffffddfe8n)
    for (const name of ['rax', 'rcx', 'rdx', 'rsi']) expect(reg(emu, name), name).toBe(11n)
  })

  it('index and scale: [rbx+rcx*8], arr[rcx*8], [rbx+rcx*8+8], a bare label and arr+24[rip]', () => {
    const emu = bootMain(
      [
        'mov ecx, 2',
        'lea rbx, arr[rip]',
        'mov rax, [rbx+rcx*8]',
        'mov rdx, arr[rcx*8]',
        'mov rsi, [rbx+rcx*8+8]',
        'mov edi, dword ptr [rbx+rcx*4]',
        'mov r8, arr',
        'mov r9, arr+24[rip]',
        'ret',
      ],
      {},
      ['.data', 'arr: .quad 10, 20, 30, 40', '.text'],
    )
    stepN(emu, 8)
    expect(reg(emu, 'rbx')).toBe(DATA_BASE)
    expect(reg(emu, 'rax')).toBe(30n)
    expect(reg(emu, 'rdx')).toBe(30n)
    expect(reg(emu, 'rsi')).toBe(40n)
    expect(reg(emu, 'rdi')).toBe(20n)
    expect(reg(emu, 'r8')).toBe(10n)
    expect(reg(emu, 'r9')).toBe(40n)
  })

  it('message[rip] reads a .string byte by byte, including the ending 0', () => {
    const emu = bootMain(
      [
        'movzx eax, byte ptr message[rip]',
        'movzx ebx, byte ptr message+1[rip]',
        'movzx ecx, byte ptr message+2[rip]',
        'movzx edx, byte ptr message+3[rip]',
        'ret',
      ],
      { initialRegisters: { rdx: 9n } },
      ['message: .string "Hi!"'],
    )
    stepN(emu, 4)
    expect([reg(emu, 'rax'), reg(emu, 'rbx'), reg(emu, 'rcx'), reg(emu, 'rdx')]).toEqual([
      0x48n,
      0x69n,
      0x21n,
      0n,
    ])
  })

  it('a loop counts the characters of a .string', () => {
    const emu = bootMain(
      [
        'lea rsi, message[rip]',
        'mov ecx, 0',
        'next:',
        'movzx eax, byte ptr [rsi+rcx]',
        'test al, al',
        'je done',
        'inc ecx',
        'jmp next',
        'done:',
        'ret',
      ],
      {},
      ['message: .string "Hello"'],
    )
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(reg(emu, 'rcx')).toBe(5n)
  })

  it('.data is writable', () => {
    const emu = bootMain(
      [
        'add qword ptr counter[rip], 5',
        'mov rax, counter',
        'inc rax',
        'mov counter[rip], rax',
        'ret',
      ],
      {},
      ['.data', 'counter: .quad 7', '.text'],
    )
    emu.step()
    expect(emu.readMemory(DATA_BASE, 8)).toEqual(le(12n, 8))
    stepN(emu, 3)
    expect(emu.readMemory(DATA_BASE, 8)).toEqual(le(13n, 8))
    expect(snap(emu).status).toBe('running')
  })

  it('reading an unmapped address is bad-memory-read, and the step is atomic', () => {
    const emu = bootMain(['mov rbx, 0x10', 'mov rax, [rbx]', 'ret'], {
      initialRegisters: { rax: 0x55n },
    })
    emu.step()
    expectAtomicFault(emu, 'bad-memory-read')
    expect(reg(emu, 'rax')).toBe(0x55n)
  })

  it('writing an unmapped address is bad-memory-write, and the step is atomic', () => {
    const emu = bootMain(['mov rbx, 0x10', 'mov [rbx], rax', 'ret'])
    emu.step()
    expectAtomicFault(emu, 'bad-memory-write')
    expect(emu.readMemory(0x10n, 8)).toEqual([null, null, null, null, null, null, null, null])
  })

  it('writing a .string in .text is write-read-only, and the step is atomic', () => {
    const emu = bootMain(['mov byte ptr message[rip], 0x41', 'ret'], {}, ['message: .string "Hi"'])
    expectAtomicFault(emu, 'write-read-only')
    expect(emu.readMemory(RODATA_BASE, 3)).toEqual([0x48, 0x69, 0])
  })

  it('writing into the code is write-read-only', () => {
    const emu = bootMain(['lea rbx, main[rip]', 'mov byte ptr [rbx], 0', 'ret'])
    emu.step()
    expect(reg(emu, 'rbx')).toBe(TEXT_BASE)
    expectAtomicFault(emu, 'write-read-only')
  })

  it('inc on read-only data reads fine but the write faults: write-read-only', () => {
    const emu = bootMain(['inc byte ptr message[rip]', 'ret'], { initialFlags: F(1, 1, 1, 1) }, [
      'message: .string "Hi"',
    ])
    expectAtomicFault(emu, 'write-read-only')
    expect(snap(emu).flags).toEqual(F(1, 1, 1, 1))
  })

  it('pop with rsp at an unmapped address is bad-memory-read and rsp does not move', () => {
    const emu = bootMain(['mov rsp, 0x10', 'pop rax', 'ret'], { initialRegisters: { rax: 3n } })
    emu.step()
    expectAtomicFault(emu, 'bad-memory-read')
    expect(reg(emu, 'rsp')).toBe(0x10n)
    expect(reg(emu, 'rax')).toBe(3n)
  })

  it('add to an unmapped address faults atomically', () => {
    const emu = bootMain(['mov rbx, 0x10', 'add qword ptr [rbx], 1', 'ret'])
    emu.step()
    const before = snap(emu)
    const r = emu.step()
    expect(r.status).toBe('error')
    // The read happens first on a real CPU; the contract does not say which code wins.
    expect(['bad-memory-read', 'bad-memory-write']).toContain(r.error?.code)
    expect(snap(emu).rip).toBe(before.rip)
    expect(r.diff.registers).toEqual([])
  })

  it('reading a stack box nobody wrote gives 0 and a warning note', () => {
    const emu = bootMain(['sub rsp, 16', 'mov rax, [rsp]', 'add rsp, 16', 'ret'], {
      initialRegisters: { rax: 0x55n },
    })
    emu.step()
    const r = emu.step()
    expect(r.status).toBe('running')
    expect(reg(emu, 'rax')).toBe(0n)
    expect(notesOf(r, 'warning').some((n) => /never|junk/i.test(n.text))).toBe(true)
  })

  it('reading code bytes is allowed and reads 0 (contract rule)', () => {
    const emu = bootMain(['lea rbx, main[rip]', 'mov rax, [rbx]', 'ret'], {
      initialRegisters: { rax: 0x55n },
    })
    stepN(emu, 2)
    expect(snap(emu).status).toBe('running')
    expect(reg(emu, 'rax')).toBe(0n)
  })

  it('readMemory gives null for unmapped and never-written bytes and never throws', () => {
    const emu = bootMain(['ret'])
    expect(emu.readMemory(0n, 4)).toEqual([null, null, null, null])
    expect(emu.readMemory(START_RSP - 8n, 2)).toEqual([null, null])
    expect(emu.readMemory(START_RSP + 6n, 4)).toEqual([0, 0, null, null])
  })
})

/* ═════════════════════════ 5. push / pop / call / ret / leave ═════════════════════════ */

describe('5. push, pop, call, ret, leave', () => {
  it('push moves rsp down by exactly 8 and stores the value little-endian', () => {
    const emu = bootMain(['push rbx', 'pop rbx', 'ret'], {
      initialRegisters: { rbx: 0x1122334455667788n },
    })
    emu.step()
    expect(reg(emu, 'rsp')).toBe(0x7ffffffddff0n)
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual(le(0x1122334455667788n, 8))
  })

  it('pop loads the top box and moves rsp up by exactly 8', () => {
    const emu = bootMain(['push rbx', 'pop rcx', 'ret'], { initialRegisters: { rbx: 0xabcn } })
    stepN(emu, 2)
    expect(reg(emu, 'rcx')).toBe(0xabcn)
    expect(reg(emu, 'rsp')).toBe(START_RSP)
  })

  it('pops in the same order as the pushes swap two values', () => {
    const emu = bootMain(['push rax', 'push rcx', 'pop rax', 'pop rcx', 'ret'], {
      initialRegisters: { rax: 1n, rcx: 2n },
    })
    stepN(emu, 4)
    expect(reg(emu, 'rax')).toBe(2n)
    expect(reg(emu, 'rcx')).toBe(1n)
    expect(reg(emu, 'rsp')).toBe(START_RSP)
  })

  it('pops in reverse order restore two values', () => {
    const emu = bootMain(
      ['push rax', 'push rcx', 'mov rax, 100', 'mov rcx, 200', 'pop rcx', 'pop rax', 'ret'],
      { initialRegisters: { rax: 1n, rcx: 2n } },
    )
    stepN(emu, 6)
    expect(reg(emu, 'rax')).toBe(1n)
    expect(reg(emu, 'rcx')).toBe(2n)
  })

  it('push r12 and pop r15 work with extended registers', () => {
    const emu = bootMain(['push r12', 'pop r15', 'ret'], { initialRegisters: { r12: 0x1212n } })
    stepN(emu, 2)
    expect(reg(emu, 'r15')).toBe(0x1212n)
  })

  it('call pushes (call address + call size) and jumps to the label', () => {
    const emu = bootMain(['call f', 'ret', 'f:', 'mov eax, 9', 'ret'])
    const call = instr(emu, 0)
    expect(call.size).toBe(5)
    emu.step()
    expect(reg(emu, 'rsp')).toBe(0x7ffffffddff0n)
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual(le(call.address + BigInt(call.size), 8))
    expect(call.address + BigInt(call.size)).toBe(instr(emu, 1).address)
    expect(snap(emu).rip).toBe(instr(emu, 2).address)
  })

  it('ret puts the return address in rip and moves rsp up by 8', () => {
    const emu = bootMain(['call f', 'ret', 'f:', 'mov eax, 9', 'ret'])
    stepN(emu, 3)
    expect(snap(emu).rip).toBe(instr(emu, 1).address)
    expect(reg(emu, 'rsp')).toBe(START_RSP)
    expect(snap(emu).status).toBe('running')
    emu.step()
    expect(snap(emu).status).toBe('halted')
    expect(reg(emu, 'rax')).toBe(9n)
  })

  it('nested calls stack up return addresses and call frames', () => {
    const emu = bootMain(['call f', 'ret', 'f:', 'call g', 'ret', 'g:', 'ret'])
    const callF = instr(emu, 0)
    const callG = instr(emu, 2)
    emu.step()
    expect(snap(emu).callStack).toEqual([
      { functionName: 'main', callLine: 0, returnAddress: OS_RET, slotAddress: START_RSP },
      {
        functionName: 'f',
        callLine: callF.line,
        returnAddress: instr(emu, 1).address,
        slotAddress: 0x7ffffffddff0n,
      },
    ])
    emu.step()
    expect(snap(emu).callStack).toHaveLength(3)
    expect(snap(emu).callStack[2]).toEqual({
      functionName: 'g',
      callLine: callG.line,
      returnAddress: instr(emu, 3).address,
      slotAddress: 0x7ffffffddfe8n,
    })
    expect(emu.readMemory(0x7ffffffddfe8n, 8)).toEqual(le(instr(emu, 3).address, 8))
    emu.step() // g: ret
    expect(snap(emu).rip).toBe(instr(emu, 3).address)
    expect(snap(emu).callStack).toHaveLength(2)
    emu.step() // f: ret
    expect(snap(emu).rip).toBe(instr(emu, 1).address)
    expect(snap(emu).callStack).toHaveLength(1)
    emu.step()
    expect(snap(emu).status).toBe('halted')
  })

  it('push rsp stores the OLD rsp', () => {
    const emu = bootMain(['push rsp', 'pop rax', 'ret'])
    emu.step()
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual(le(START_RSP, 8))
    emu.step()
    expect(reg(emu, 'rax')).toBe(START_RSP)
  })

  it('pop rsp leaves rsp = the popped value (no extra +8)', () => {
    const emu = bootMain(['mov rax, 0x7ffffffddfd0', 'push rax', 'pop rsp', 'ret'])
    stepN(emu, 3)
    expect(reg(emu, 'rsp')).toBe(0x7ffffffddfd0n)
  })

  const pushImmRows: { code: string; value: bigint }[] = [
    { code: 'push -2', value: 0xfffffffffffffffen },
    { code: 'push 0x7f', value: 0x7fn },
    { code: 'push 0x80', value: 0x80n },
    { code: 'push -129', value: 0xffffffffffffff7fn },
    { code: 'push 0x7fffffff', value: 0x7fffffffn },
    { code: 'push -0x80000000', value: 0xffffffff80000000n },
    { code: "push 'A'", value: 0x41n },
  ]
  it.each(pushImmRows)(
    '`$code` pushes the immediate sign-extended to 64 bits',
    ({ code, value }) => {
      const emu = bootMain([code, 'pop rax', 'ret'])
      emu.step()
      expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual(le(value, 8))
      emu.step()
      expect(reg(emu, 'rax')).toBe(value)
    },
  )

  it('leave sets rsp = rbp, then pops rbp', () => {
    const emu = bootMain(['push rbp', 'mov rbp, rsp', 'sub rsp, 32', 'leave', 'ret'], {
      initialRegisters: { rbp: 0x1234n },
    })
    stepN(emu, 3)
    expect(reg(emu, 'rsp')).toBe(0x7ffffffddfd0n)
    emu.step()
    expect(reg(emu, 'rsp')).toBe(START_RSP)
    expect(reg(emu, 'rbp')).toBe(0x1234n)
    emu.step()
    expect(snap(emu).status).toBe('halted')
  })

  it('after pop the old box keeps its value and is dead', () => {
    const emu = bootMain(['push rbx', 'pop rcx', 'ret'], { initialRegisters: { rbx: 5n } })
    stepN(emu, 2)
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual(le(5n, 8))
    const b = box(snap(emu), 0x7ffffffddff0n)
    expect(b.value).toBe(5n)
    expect(b.dead).toBe(true)
    expect(b.isRsp).toBe(false)
  })

  it('push, pop, call and ret do not change the flags', () => {
    const emu = bootMain(['push rbx', 'pop rbx', 'call f', 'ret', 'f:', 'ret'], {
      initialFlags: F(1, 1, 1, 1),
    })
    const steps = stepN(emu, 4)
    for (const r of steps) expect(r.diff.flags).toEqual([])
    expect(snap(emu).flags).toEqual(F(1, 1, 1, 1))
  })

  it('pushing forever ends with stack-overflow; the failing push changes nothing', () => {
    const emu = bootMain(['again:', 'push rax', 'jmp again'], {
      stackSize: 0x2000,
      maxSteps: 100_000,
    })
    const result = emu.run()
    expect(result.reason).toBe('error')
    const s = snap(emu)
    expect(s.error?.code).toBe('stack-overflow')
    expect(s.rip).toBe(instr(emu, 0).address)
    const failing = must(s.lastStep, 'lastStep')
    expect(failing.executed).toBe(true)
    expect(failing.diff.registers).toEqual([])
    expect(failing.diff.memory).toEqual([])
    // The box below rsp is outside the stack region.
    expect(emu.readMemory(s.registers.rsp - 8n, 8)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
    // The region holds at most 0x2000 bytes: at most 1024 pushes worked.
    expect(START_RSP - s.registers.rsp).toBeLessThanOrEqual(0x2000n)
  })

  it('endless recursion with call ends with stack-overflow', () => {
    const emu = bootMain(['call main'], { stackSize: 0x2000, maxSteps: 100_000 })
    const result = emu.run()
    expect(result.reason).toBe('error')
    expect(snap(emu).error?.code).toBe('stack-overflow')
  })
})

/* ═══════════════════════════════════ 6. Jumps ═══════════════════════════════════ */

describe('6. Jumps', () => {
  interface Pair {
    size: 8 | 32 | 64
    a: bigint
    b: bigint
    /** Flags after `cmp a, b`, worked out by hand. */
    flags: Flags
  }
  const PAIRS = {
    negVsOne: { size: 32, a: 0xffffffffn, b: 1n, flags: F(0, 0, 1, 0) },
    oneVsNeg: { size: 32, a: 1n, b: 0xffffffffn, flags: F(1, 0, 0, 0) },
    equal: { size: 32, a: 5n, b: 5n, flags: F(0, 1, 0, 0) },
    minVsOne: { size: 32, a: 0x80000000n, b: 1n, flags: F(0, 0, 0, 1) },
    maxVsNeg: { size: 32, a: 0x7fffffffn, b: 0xffffffffn, flags: F(1, 0, 1, 1) },
    twoVsSeven: { size: 32, a: 2n, b: 7n, flags: F(1, 0, 1, 0) },
    byteNegVsOne: { size: 8, a: 0xffn, b: 1n, flags: F(0, 0, 1, 0) },
    quadNegVsOne: { size: 64, a: MASK[64], b: 1n, flags: F(0, 0, 1, 0) },
  } as const satisfies Record<string, Pair>
  type PairName = keyof typeof PAIRS
  const REGS = { 8: ['al', 'bl'], 32: ['eax', 'ebx'], 64: ['rax', 'rbx'] } as const

  const table: [string, PairName, boolean][] = [
    ['je', 'equal', true],
    ['je', 'negVsOne', false],
    ['jz', 'equal', true],
    ['jne', 'negVsOne', true],
    ['jne', 'equal', false],
    ['jnz', 'equal', false],
    ['jg', 'oneVsNeg', true],
    ['jg', 'maxVsNeg', true],
    ['jg', 'negVsOne', false],
    ['jg', 'equal', false],
    ['jg', 'quadNegVsOne', false],
    ['jnle', 'oneVsNeg', true],
    ['jge', 'equal', true],
    ['jge', 'maxVsNeg', true],
    ['jge', 'negVsOne', false],
    ['jge', 'minVsOne', false],
    ['jnl', 'minVsOne', false],
    ['jl', 'negVsOne', true],
    ['jl', 'minVsOne', true],
    ['jl', 'byteNegVsOne', true],
    ['jl', 'oneVsNeg', false],
    ['jl', 'maxVsNeg', false],
    ['jnge', 'negVsOne', true],
    ['jle', 'equal', true],
    ['jle', 'negVsOne', true],
    ['jle', 'oneVsNeg', false],
    ['jle', 'maxVsNeg', false],
    ['jng', 'oneVsNeg', false],
    ['ja', 'negVsOne', true],
    ['ja', 'minVsOne', true],
    ['ja', 'byteNegVsOne', true],
    ['ja', 'quadNegVsOne', true],
    ['ja', 'oneVsNeg', false],
    ['ja', 'equal', false],
    ['jnbe', 'equal', false],
    ['jae', 'equal', true],
    ['jae', 'negVsOne', true],
    ['jae', 'oneVsNeg', false],
    ['jae', 'twoVsSeven', false],
    ['jnb', 'negVsOne', true],
    ['jnc', 'oneVsNeg', false],
    ['jb', 'oneVsNeg', true],
    ['jb', 'twoVsSeven', true],
    ['jb', 'negVsOne', false],
    ['jb', 'equal', false],
    ['jc', 'twoVsSeven', true],
    ['jnae', 'equal', false],
    ['jbe', 'equal', true],
    ['jbe', 'oneVsNeg', true],
    ['jbe', 'negVsOne', false],
    ['jbe', 'minVsOne', false],
    ['jna', 'equal', true],
    ['js', 'negVsOne', true],
    ['js', 'oneVsNeg', false],
    ['js', 'minVsOne', false],
    ['jns', 'oneVsNeg', true],
    ['jns', 'minVsOne', true],
    ['jns', 'negVsOne', false],
    ['jo', 'minVsOne', true],
    ['jo', 'maxVsNeg', true],
    ['jo', 'negVsOne', false],
    ['jno', 'negVsOne', true],
    ['jno', 'minVsOne', false],
  ]
  const rows = table.map(([jcc, pair, taken]) => ({
    name: `${jcc} after cmp ${pair}: ${taken ? 'taken' : 'not taken'}`,
    jcc,
    pair: PAIRS[pair],
    taken,
  }))

  it.each(rows)('$name', ({ jcc, pair, taken }) => {
    const [a, b] = REGS[pair.size]
    const emu = bootMain(
      [`cmp ${a}, ${b}`, `${jcc} yes`, 'mov ecx, 1', 'ret', 'yes:', 'mov ecx, 2', 'ret'],
      {
        initialRegisters: { rax: pair.a, rbx: pair.b },
      },
    )
    emu.step()
    expect(snap(emu).flags).toEqual(pair.flags)
    const r = emu.step()
    expect(r.diff.flags).toEqual([])
    expect(snap(emu).rip).toBe(taken ? instr(emu, 4).address : instr(emu, 2).address)
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(reg(emu, 'rcx')).toBe(taken ? 2n : 1n)
  })

  it('jmp always jumps', () => {
    const emu = bootMain(['jmp skip', 'mov eax, 1', 'skip:', 'ret'])
    emu.step()
    expect(snap(emu).rip).toBe(instr(emu, 2).address)
  })

  it('a counting loop runs 10 times: 32 steps in all', () => {
    const emu = bootMain(['mov ecx, 0', 'again:', 'inc ecx', 'cmp ecx, 10', 'jl again', 'ret'])
    const result = emu.run()
    expect(result.reason).toBe('halted')
    expect(result.stepsRun).toBe(32)
    expect(reg(emu, 'rcx')).toBe(10n)
  })

  it('a countdown loop with dec and jne adds 5+4+3+2+1', () => {
    const emu = bootMain([
      'mov ecx, 5',
      'mov eax, 0',
      'again:',
      'add eax, ecx',
      'dec ecx',
      'jne again',
      'ret',
    ])
    const result = emu.run()
    expect(result.reason).toBe('halted')
    expect(result.stepsRun).toBe(18)
    expect(reg(emu, 'rax')).toBe(15n)
    expect(reg(emu, 'rcx')).toBe(0n)
  })

  it('a label may be called `loop`', () => {
    const emu = bootMain(['mov ecx, 3', 'loop:', 'dec ecx', 'jnz loop', 'ret'])
    expect(emu.run().reason).toBe('halted')
    expect(reg(emu, 'rcx')).toBe(0n)
  })

  it('a loop over an array with cmp and jb', () => {
    const emu = bootMain(
      [
        'lea rsi, nums[rip]',
        'mov ecx, 0',
        'mov eax, 0',
        'next:',
        'add rax, [rsi+rcx*8]',
        'inc ecx',
        'cmp ecx, 4',
        'jb next',
        'ret',
      ],
      {},
      ['.data', 'nums: .quad 1, 10, 100, 1000', '.text'],
    )
    expect(emu.run().reason).toBe('halted')
    expect(reg(emu, 'rax')).toBe(1111n)
  })
})

/* ═════════════════════════════ 7. The end of the program ═════════════════════════════ */

describe('7. The end of the program', () => {
  it('ret from main halts the program', () => {
    const emu = bootMain(['mov eax, 3', 'ret'])
    emu.step()
    const r = emu.step()
    expect(r.executed).toBe(true)
    expect(r.status).toBe('halted')
    const s = snap(emu)
    expect(s.status).toBe('halted')
    expect(s.error).toBeNull()
    expect(s.registers.rsp).toBe(STACK_BASE)
    expect(s.nextLine).toBeNull()
  })

  it('no ret at the end: ran-off-end, the step is still applied', () => {
    const emu = bootMain(['mov eax, 1'])
    const r = emu.step()
    expect(r.executed).toBe(true)
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('ran-off-end')
    expect(r.error?.message ?? '').toContain('ret')
    expect(reg(emu, 'rax')).toBe(1n)
    expect(r.diff.registers).toEqual([{ reg: 'rax', before: 0n, after: 1n }])
    expect(snap(emu).rip).toBe(emu.program.layout.textEnd)
    expect(snap(emu).status).toBe('error')
  })

  it('ret after an unbalanced push: bad-jump, and the message talks about push and pop', () => {
    const emu = bootMain(['push rbx', 'ret'], { initialRegisters: { rbx: 5n } })
    emu.step()
    const r = emu.step()
    expect(r.executed).toBe(true)
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('bad-jump')
    expect(r.error?.message ?? '').toMatch(/return address/i)
    expect(r.error?.message ?? '').toMatch(/push/i)
    expect(reg(emu, 'rsp')).toBe(START_RSP) // the ret was applied
    expect(snap(emu).rip).toBe(5n)
  })

  it('jmp to a label at the very end of the code is bad-jump (it is a jump, not a fall-through)', () => {
    const emu = bootMain(['jmp end', 'ret', 'end:'])
    const r = emu.step()
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('bad-jump')
    expect(snap(emu).rip).toBe(emu.program.layout.textEnd)
  })

  it('exit ends the program in its library step, with the exit code in the explanation', () => {
    const emu = bootMain(['mov edi, 3', 'call exit'])
    stepN(emu, 2)
    expect(snap(emu).inLibrary?.name).toBe('exit')
    const r = emu.step()
    expect(r.kind).toBe('library')
    expect(r.status).toBe('halted')
    expect(snap(emu).status).toBe('halted')
    expect(r.explanation).toMatch(/\b3\b/)
  })

  it('exit with edi = -1 gives the code -1', () => {
    const emu = bootMain(['mov edi, -1', 'call exit'])
    stepN(emu, 2)
    const r = emu.step()
    expect(r.status).toBe('halted')
    expect(r.explanation).toContain('-1')
  })

  it('step() after the end does nothing', () => {
    const emu = bootMain(['ret'])
    emu.step()
    const before = snap(emu)
    const r = emu.step()
    expect(r.executed).toBe(false)
    expect(r.status).toBe('halted')
    expect(r.diff.registers).toEqual([])
    expect(r.diff.flags).toEqual([])
    expect(r.diff.memory).toEqual([])
    expect(r.explanation).toMatch(/end|finish|halt|stop|over/i)
    expect(snap(emu)).toBe(before) // no state change: the same snapshot object
    expect(snap(emu).stepCount).toBe(1)
  })

  it('step() after an error does nothing and repeats the error', () => {
    const emu = bootMain(['mov rbx, 0x10', 'mov rax, [rbx]', 'ret'])
    stepN(emu, 2)
    const before = snap(emu)
    const message = must(before.error, 'error').message
    const r = emu.step()
    expect(r.executed).toBe(false)
    expect(r.status).toBe('error')
    expect(r.diff.registers).toEqual([])
    expect(snap(emu)).toBe(before)
    const core = message.replace(/^Line \d+: /, '')
    expect(r.explanation.includes(core) || r.explanation.includes(message)).toBe(true)
  })

  it('step() inside a library function runs the library step', () => {
    const emu = bootMain(['push rbp', 'mov edi, 65', 'call putchar@PLT', 'pop rbp', 'ret'])
    stepN(emu, 3)
    const r = emu.step()
    expect(r.kind).toBe('library')
    expect(r.output).toBe('A')
  })
})

/* ═══════════════════════════════════ 8. stepBack ═══════════════════════════════════ */

const HELLO = mainProg(
  [
    'push rbp',
    'lea rdi, msg[rip]',
    'mov eax, 0',
    'call printf@PLT',
    'mov eax, 0',
    'pop rbp',
    'ret',
  ],
  ['msg: .string "Hi\\n"'],
)

describe('8. stepBack', () => {
  const kinds: {
    name: string
    body: string[]
    steps: number
    before?: string[]
    options?: EmulatorOptions
  }[] = [
    { name: 'mov to a register', body: ['mov rax, 7', 'ret'], steps: 1 },
    {
      name: 'add (flags)',
      body: ['add al, 1', 'ret'],
      steps: 1,
      options: { initialRegisters: { rax: 0xffn } },
    },
    {
      name: 'push',
      body: ['push rbx', 'pop rbx', 'ret'],
      steps: 1,
      options: { initialRegisters: { rbx: 9n } },
    },
    {
      name: 'pop',
      body: ['push rbx', 'pop rcx', 'ret'],
      steps: 2,
      options: { initialRegisters: { rbx: 9n } },
    },
    { name: 'call', body: ['call f', 'ret', 'f:', 'ret'], steps: 1 },
    { name: 'ret from a function', body: ['call f', 'ret', 'f:', 'ret'], steps: 2 },
    { name: 'jmp', body: ['jmp done', 'nop', 'done:', 'ret'], steps: 1 },
    { name: 'taken jcc', body: ['cmp eax, 0', 'je done', 'nop', 'done:', 'ret'], steps: 2 },
    { name: 'mov to memory', body: ['mov qword ptr [rsp-8], 3', 'ret'], steps: 1 },
    {
      name: 'mov to .data',
      body: ['mov qword ptr x[rip], 3', 'ret'],
      steps: 1,
      before: ['.data', 'x: .quad 1', '.text'],
    },
    { name: 'inc', body: ['inc rax', 'ret'], steps: 1 },
    {
      name: 'imul',
      body: ['imul eax, eax', 'ret'],
      steps: 1,
      options: { initialRegisters: { rax: 0x10000n } },
    },
    { name: 'leave', body: ['push rbp', 'mov rbp, rsp', 'leave', 'ret'], steps: 3 },
    {
      name: 'library call (printf)',
      body: ['push rbp', 'lea rdi, msg[rip]', 'call printf@PLT', 'pop rbp', 'ret'],
      steps: 4,
      before: ['msg: .string "Hi"'],
    },
    { name: 'fault', body: ['mov rbx, 0x10', 'mov rax, [rbx]', 'ret'], steps: 2 },
    { name: 'halt', body: ['ret'], steps: 1 },
    { name: 'ran-off-end', body: ['nop'], steps: 1 },
  ]

  it.each(kinds)(
    'stepBack after: $name gives back the snapshot from before',
    ({ body, steps, before, options }) => {
      const emu = bootMain(body, options ?? {}, before ?? [])
      stepN(emu, steps - 1)
      const previous = snap(emu)
      const r = emu.step()
      expect(r.executed).toBe(true)
      expect(emu.stepBack()).toBe(true)
      expectSameState(snap(emu), previous)
    },
  )

  it.each(EXAMPLES.map((e) => ({ id: e.id, example: e })))(
    '$id: N steps forward then N back equals the fresh snapshot, for every N',
    ({ example }) => {
      const options = example.stdin === undefined ? {} : { stdin: example.stdin }
      const emu = boot(example.source, options)
      const fresh = snap(emu)
      const total = runToEnd(emu).length
      for (let n = total; n >= 1; n -= Math.max(1, Math.floor(total / 7))) {
        emu.reset()
        stepN(emu, n)
        for (let i = 0; i < n; i++) expect(emu.stepBack()).toBe(true)
        expectSameState(snap(emu), fresh)
      }
    },
  )

  it('back then forward gives the same StepResult again, for every step of a program', () => {
    const emu = boot(HELLO)
    const total = runToEnd(boot(HELLO)).length
    for (let i = 0; i < total; i++) {
      const first = emu.step()
      expect(emu.stepBack()).toBe(true)
      const again = emu.step()
      expect(deepDiff(again, first)).toEqual([])
    }
    expect(snap(emu).status).toBe('halted')
  })

  it('stepBack at the start returns false and changes nothing', () => {
    const emu = boot(HELLO)
    const before = snap(emu)
    expect(emu.stepBack()).toBe(false)
    expect(snap(emu)).toBe(before)
  })

  it('stepBack makes a written stack box "never written" again', () => {
    const emu = bootMain(['push rbx', 'pop rbx', 'ret'], { initialRegisters: { rbx: 9n } })
    emu.step()
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual(le(9n, 8))
    emu.stepBack()
    expect(emu.readMemory(0x7ffffffddff0n, 8)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it('stepBack shrinks the output back', () => {
    const emu = boot(HELLO)
    stepN(emu, 5)
    expect(snap(emu).output).toBe('Hi\n')
    emu.stepBack()
    expect(snap(emu).output).toBe('')
  })

  it('stepBack across a library step puts the return address, inLibrary and the registers back', () => {
    const emu = boot(HELLO)
    stepN(emu, 4)
    const inside = snap(emu)
    emu.step()
    expect(snap(emu).inLibrary).toBeNull()
    emu.stepBack()
    const s = snap(emu)
    expect(s.inLibrary).toEqual({ name: 'printf', callLine: instr(emu, 3).line })
    expect(s.rip).toBe(PRINTF)
    expect(s.registers.rsp).toBe(0x7ffffffddfe8n)
    expectSameState(s, inside)
  })

  it('stepBack across a fault clears the error; stepping again faults again', () => {
    const emu = bootMain(['mov rbx, 0x10', 'mov rax, [rbx]', 'ret'])
    stepN(emu, 2)
    expect(snap(emu).status).toBe('error')
    emu.stepBack()
    expect(snap(emu).status).toBe('running')
    expect(snap(emu).error).toBeNull()
    expect(snap(emu).stepCount).toBe(1)
    expect(emu.step().error?.code).toBe('bad-memory-read')
  })

  it('stepBack across the halt makes the program runnable again', () => {
    const emu = bootMain(['mov eax, 2', 'ret'])
    stepN(emu, 2)
    expect(snap(emu).status).toBe('halted')
    emu.stepBack()
    expect(snap(emu).status).toBe('running')
    expect(snap(emu).rip).toBe(instr(emu, 1).address)
    expect(snap(emu).registers.rsp).toBe(START_RSP)
    expect(emu.step().status).toBe('halted')
  })

  it('stepBack sets lastStep to the step before (or null at the start)', () => {
    const emu = bootMain(['mov eax, 1', 'mov ebx, 2', 'ret'])
    const first = emu.step()
    emu.step()
    emu.stepBack()
    expect(deepDiff(snap(emu).lastStep, first)).toEqual([])
    expect(snap(emu).canStepBack).toBe(true)
    emu.stepBack()
    expect(snap(emu).lastStep).toBeNull()
    expect(snap(emu).canStepBack).toBe(false)
  })

  it('text given with provideInput is not forgotten by stepBack', () => {
    const emu = boot(scanfProgram('%d'))
    stepToLibrary(emu)
    expect(emu.step().executed).toBe(false)
    emu.provideInput('31')
    const read = emu.step()
    expect(read.executed).toBe(true)
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(31n, 4))
    emu.stepBack()
    expect(emu.readMemory(LOCAL_8, 4)).toEqual([null, null, null, null])
    const again = emu.step()
    expect(again.executed).toBe(true)
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(31n, 4))
  })

  it('keeps at least 20 000 steps of history', () => {
    const emu = bootMain(['again:', 'jmp again'], { maxSteps: 20_000 })
    const fresh = snap(emu)
    expect(emu.run().stepsRun).toBe(20_000)
    for (let i = 0; i < 20_000; i++) {
      if (!emu.stepBack()) throw new Error(`stepBack failed after ${i} steps back`)
    }
    expectSameState(snap(emu), fresh)
  }, 60_000)
})

/* ═════════════════ 9. run / breakpoints / reset / subscribe / snapshots ═════════════════ */

describe('9. run, breakpoints, reset, subscribe, snapshots', () => {
  const four = mainProg(['mov eax, 1', 'mov ebx, 2', 'mov ecx, 3', 'ret'])

  it('run() to the end: reason halted, stepsRun counts the steps, message is a sentence', () => {
    const emu = boot(four)
    const result = emu.run()
    expect(result.reason).toBe('halted')
    expect(result.stepsRun).toBe(4)
    expect(result.message.length).toBeGreaterThan(0)
    expect(snap(emu).stepCount).toBe(4)
  })

  it('run() stops at an error', () => {
    const result = bootMain(['mov rbx, 0x10', 'mov rax, [rbx]', 'ret']).run()
    expect(result.reason).toBe('error')
    expect(result.stepsRun).toBe(2)
  })

  it('run() stops before a breakpoint line and does not run it', () => {
    const emu = boot(four)
    const third = instr(emu, 2)
    emu.setBreakpoints([third.line])
    const result = emu.run()
    expect(result.reason).toBe('breakpoint')
    expect(result.stepsRun).toBe(2)
    expect(snap(emu).rip).toBe(third.address)
    expect(snap(emu).nextLine).toBe(third.line)
    expect(reg(emu, 'rcx')).toBe(0n)
  })

  it('run() while standing on a breakpoint moves on', () => {
    const emu = boot(four)
    emu.setBreakpoints([instr(emu, 2).line])
    emu.run()
    const result = emu.run()
    expect(result.reason).toBe('halted')
    expect(result.stepsRun).toBe(2)
  })

  it('a breakpoint on the first line does not stop a fresh run() at once', () => {
    const emu = boot(four)
    emu.setBreakpoints([instr(emu, 0).line])
    const result = emu.run()
    expect(result.reason).toBe('halted')
    expect(result.stepsRun).toBe(4)
  })

  it('a breakpoint inside a loop stops on every pass', () => {
    const emu = bootMain(['mov ecx, 0', 'again:', 'inc ecx', 'cmp ecx, 3', 'jl again', 'ret'])
    emu.setBreakpoints([instr(emu, 1).line])
    expect(emu.run()).toMatchObject({ reason: 'breakpoint', stepsRun: 1 })
    expect(emu.run()).toMatchObject({ reason: 'breakpoint', stepsRun: 3 })
    expect(reg(emu, 'rcx')).toBe(1n)
    expect(emu.run()).toMatchObject({ reason: 'breakpoint', stepsRun: 3 })
    expect(reg(emu, 'rcx')).toBe(2n)
    expect(emu.run()).toMatchObject({ reason: 'halted', stepsRun: 4 })
    expect(reg(emu, 'rcx')).toBe(3n)
  })

  it('breakpoints are checked only for instruction steps, not for the library step', () => {
    const emu = boot(HELLO)
    const call = instr(emu, 3)
    emu.setBreakpoints([call.line])
    expect(emu.run()).toMatchObject({ reason: 'breakpoint', stepsRun: 3 })
    const result = emu.run()
    expect(result.reason).toBe('halted')
    expect(result.stepsRun).toBe(5) // call, library, mov, pop, ret
    expect(snap(emu).output).toBe('Hi\n')
  })

  it('run() stops when scanf needs input', () => {
    const emu = boot(scanfProgram('%d'))
    const result = emu.run()
    expect(result.reason).toBe('waiting-input')
    expect(snap(emu).status).toBe('waiting-input')
    expect(result.stepsRun).toBe(7) // push, mov, sub, lea, lea, mov, call
  })

  it('run() stops after 10 000 steps of an endless loop, and the message mentions a loop', () => {
    const emu = bootMain(['again:', 'jmp again'])
    const result = emu.run()
    expect(result.reason).toBe('step-limit')
    expect(result.stepsRun).toBe(10_000)
    expect(result.message).toMatch(/loop/i)
    expect(snap(emu).status).toBe('running')
  })

  it('the maxSteps option changes the run limit', () => {
    const result = bootMain(['again:', 'jmp again'], { maxSteps: 50 }).run()
    expect(result.reason).toBe('step-limit')
    expect(result.stepsRun).toBe(50)
  })

  it('run() on a halted or errored program runs 0 steps and returns that reason', () => {
    const halted = boot(four)
    halted.run()
    expect(halted.run()).toMatchObject({ reason: 'halted', stepsRun: 0 })
    const failed = bootMain(['mov rbx, 0x10', 'mov rax, [rbx]', 'ret'])
    failed.run()
    expect(failed.run()).toMatchObject({ reason: 'error', stepsRun: 0 })
  })

  it('breakpoints are sorted, unique, and toggle on and off', () => {
    const emu = boot(four)
    emu.setBreakpoints([9, 5, 9, 7])
    expect(snap(emu).breakpoints).toEqual([5, 7, 9])
    emu.toggleBreakpoint(6)
    expect(snap(emu).breakpoints).toEqual([5, 6, 7, 9])
    emu.toggleBreakpoint(5)
    expect(snap(emu).breakpoints).toEqual([6, 7, 9])
    emu.setBreakpoints([])
    expect(snap(emu).breakpoints).toEqual([])
  })

  it('a breakpoint on a line without an instruction is accepted and never hit', () => {
    const emu = boot(four)
    emu.setBreakpoints([1, 1000])
    expect(snap(emu).breakpoints).toEqual([1, 1000])
    expect(emu.run().reason).toBe('halted')
  })

  it('reset returns to the starting state, keeps breakpoints and clears output', () => {
    const emu = boot(HELLO)
    const popLine = instr(emu, 5).line
    emu.setBreakpoints([popLine])
    expect(emu.run().reason).toBe('breakpoint')
    expect(snap(emu).output).toBe('Hi\n')
    emu.reset()
    const s = snap(emu)
    expect(s.output).toBe('')
    expect(s.breakpoints).toEqual([popLine])
    expect(s.canStepBack).toBe(false)
    const fresh = boot(HELLO)
    fresh.setBreakpoints([popLine])
    expectSameState(s, snap(fresh))
  })

  it('reset keeps options.stdin', () => {
    const emu = boot(scanfProgram('%d'), { stdin: '8\n' })
    expect(emu.run().reason).toBe('halted')
    emu.reset()
    expect(emu.run().reason).toBe('halted')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(8n, 4))
  })

  it('reset forgets text given with provideInput', () => {
    const emu = boot(scanfProgram('%d'))
    expect(emu.run().reason).toBe('waiting-input')
    emu.provideInput('5')
    emu.reset()
    expect(emu.run().reason).toBe('waiting-input')
  })

  it('a listener is called once per run(), not once per step', () => {
    const emu = boot(four)
    let calls = 0
    emu.subscribe(() => {
      calls++
    })
    emu.run()
    expect(calls).toBe(1)
  })

  it('a listener is called after step, stepBack, reset, breakpoint changes and provideInput', () => {
    const emu = boot(scanfProgram('%d'))
    let calls = 0
    emu.subscribe(() => {
      calls++
    })
    emu.step()
    expect(calls).toBe(1)
    emu.stepBack()
    expect(calls).toBe(2)
    emu.setBreakpoints([3])
    expect(calls).toBe(3)
    emu.toggleBreakpoint(4)
    expect(calls).toBe(4)
    emu.run() // stops waiting for input
    expect(calls).toBe(5)
    emu.provideInput('1')
    expect(calls).toBe(6)
    emu.reset()
    expect(calls).toBe(7)
  })

  it('unsubscribe stops the calls', () => {
    const emu = boot(four)
    let calls = 0
    const unsubscribe = emu.subscribe(() => {
      calls++
    })
    emu.step()
    unsubscribe()
    emu.step()
    emu.run()
    expect(calls).toBe(1)
  })

  it('getSnapshot returns the same object until something changes, then a newer one', () => {
    const emu = boot(four)
    const a = snap(emu)
    expect(snap(emu)).toBe(a)
    emu.step()
    const b = snap(emu)
    expect(b).not.toBe(a)
    expect(b.version).toBeGreaterThan(a.version)
    expect(snap(emu)).toBe(b)
  })

  it('earlier snapshots are not changed by later steps', () => {
    const emu = boot(HELLO)
    const s0 = snap(emu)
    const copy0 = structuredClone(s0)
    stepN(emu, 3)
    const s3 = snap(emu)
    const copy3 = structuredClone(s3)
    runToEnd(emu)
    emu.stepBack()
    emu.reset()
    expect(deepDiff(s0, copy0)).toEqual([])
    expect(deepDiff(s3, copy3)).toEqual([])
  })
})

/* ═══════════════════════════════════ 10. Library calls ═══════════════════════════════════ */

type PrintfArg = bigint | { label: string }
const ARG_REGS = ['rsi', 'rdx', 'rcx', 'r8', 'r9'] as const

/** main: push rbp (aligns rsp), load up to 5 arguments, printf(fmt, …), pop rbp, ret. */
function printfProgram(format: string, args: readonly PrintfArg[]): string {
  const setup = args.map((arg, i) => {
    const r = ARG_REGS[i]
    return typeof arg === 'bigint' ? `mov ${r}, ${arg.toString()}` : `lea ${r}, ${arg.label}[rip]`
  })
  return mainProg(
    [
      'push rbp',
      'mov rbp, rsp',
      ...setup,
      'lea rdi, fmt[rip]',
      'mov eax, 0',
      'call printf@PLT',
      'pop rbp',
      'ret',
    ],
    [`fmt: .string "${asmString(format)}"`, 's1: .string "abc"'],
  )
}

function runPrintf(format: string, args: readonly PrintfArg[], options: EmulatorOptions = {}) {
  const emu = boot(printfProgram(format, args), options)
  const call = stepToLibrary(emu)
  const before = snap(emu)
  const r = emu.step()
  return { emu, call, before, r }
}

const CALLER_SAVED = ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11'] as const
const CALLEE_SAVED = ['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15'] as const

describe('10a. The two-step library protocol', () => {
  it('step 1 (the call) pushes the return address, jumps into printf and sets inLibrary', () => {
    const emu = boot(HELLO)
    stepN(emu, 3)
    const call = instr(emu, 3)
    const r = emu.step()
    expect(r.kind).toBe('instruction')
    const s = snap(emu)
    expect(s.rip).toBe(PRINTF)
    expect(s.registers.rsp).toBe(0x7ffffffddfe8n)
    expect(s.inLibrary).toEqual({ name: 'printf', callLine: call.line })
    expect(s.nextLine).toBeNull()
    const ret = call.address + BigInt(call.size)
    expect(emu.readMemory(0x7ffffffddfe8n, 8)).toEqual(le(ret, 8))
    const b = box(s, 0x7ffffffddfe8n)
    expect(b.kind).toBe('return-address')
    expect(b.value).toBe(ret)
    expect(b.label ?? '').toContain('return address')
    expect(b.label ?? '').toContain(`line ${instr(emu, 4).line}`)
  })

  it('step 2 (the library step) prints, sets eax and returns', () => {
    const emu = boot(HELLO)
    stepN(emu, 4)
    const call = instr(emu, 3)
    const r = emu.step()
    expect(r.executed).toBe(true)
    expect(r.kind).toBe('library')
    expect(r.line).toBe(call.line)
    expect(r.address).toBe(PRINTF)
    expect(r.text).toContain('printf')
    expect(r.text).toContain('library code')
    expect(r.output).toBe('Hi\n')
    expect(r.status).toBe('running')
    const s = snap(emu)
    expect(s.output).toBe('Hi\n')
    expect(s.registers.rax).toBe(3n)
    expect(s.rip).toBe(instr(emu, 4).address)
    expect(s.registers.rsp).toBe(0x7ffffffddff0n)
    expect(s.inLibrary).toBeNull()
    expect(s.nextLine).toBe(instr(emu, 4).line)
    expect(s.stepCount).toBe(5)
  })

  it('the count goes in eax and the top half of rax is cleared', () => {
    const emu = bootMain(
      ['push rbp', 'lea rdi, msg[rip]', 'mov rax, -1', 'call printf@PLT', 'pop rbp', 'ret'],
      {},
      ['msg: .string "Hello World!\\n"'],
    )
    stepToLibrary(emu)
    emu.step()
    expect(reg(emu, 'rax')).toBe(13n)
  })

  it('junk goes into the eight caller-saved registers: changed, not 0, the same every run', () => {
    const body = [
      'push rbp',
      'mov rbp, rsp',
      'mov rcx, 0x1111',
      'mov rdx, 0x2222',
      'mov rsi, 0x3333',
      'mov r8, 0x8888',
      'mov r9, 0x9999',
      'mov r10, 0xaaaa',
      'mov r11, 0xbbbb',
      'lea rdi, msg[rip]',
      'call printf@PLT',
      'pop rbp',
      'ret',
    ]
    const before = ['msg: .string "Hi"']
    const junk = () => {
      const emu = bootMain(body, {}, before)
      stepToLibrary(emu)
      const inside = snap(emu)
      const r = emu.step()
      return { inside, after: snap(emu), r }
    }
    const one = junk()
    const two = junk()
    for (const name of CALLER_SAVED) {
      expect(one.after.registers[name], name).not.toBe(one.inside.registers[name])
      expect(one.after.registers[name], name).not.toBe(0n)
      expect(two.after.registers[name], name).toBe(one.after.registers[name])
    }
    const tips = notesOf(one.r, 'tip')
    expect(tips.length).toBeGreaterThan(0)
    const text = tips.map((n) => n.text).join(' ')
    for (const name of ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r11']) expect(text, name).toContain(name)
  })

  it('with clobberCallerSaved: false the caller-saved registers keep their values and there is no tip', () => {
    const emu = bootMain(
      [
        'push rbp',
        'mov rcx, 0x1111',
        'mov r11, 0xbbbb',
        'lea rdi, msg[rip]',
        'call printf@PLT',
        'pop rbp',
        'ret',
      ],
      { clobberCallerSaved: false },
      ['msg: .string "Hi"'],
    )
    stepToLibrary(emu)
    const inside = snap(emu)
    const r = emu.step()
    for (const name of CALLER_SAVED)
      expect(snap(emu).registers[name], name).toBe(inside.registers[name])
    expect(notesOf(r, 'tip')).toEqual([])
    expect(reg(emu, 'rax')).toBe(2n)
  })

  it('callee-saved registers and rsp (after the return) are never changed by a library function', () => {
    const emu = bootMain(
      [
        'push rbp',
        'mov rbp, rsp',
        'mov rbx, 0xb0b',
        'mov r12, 12',
        'mov r13, 13',
        'mov r14, 14',
        'mov r15, 15',
        'lea rdi, msg[rip]',
        'call printf@PLT',
        'pop rbp',
        'ret',
      ],
      {},
      ['msg: .string "Hi"'],
    )
    stepToLibrary(emu)
    const inside = snap(emu)
    emu.step()
    for (const name of CALLEE_SAVED)
      expect(snap(emu).registers[name], name).toBe(inside.registers[name])
    expect(reg(emu, 'rsp')).toBe(0x7ffffffddff0n) // rsp before the call
  })

  it('the alignment warning appears when rsp is not a multiple of 16 at a library call', () => {
    const emu = bootMain(['lea rdi, msg[rip]', 'call puts@PLT', 'ret'], {}, ['msg: .string "Hi"'])
    const call = stepToLibrary(emu)
    expect(notesOf(call, 'warning').some((n) => n.text.includes('16'))).toBe(true)
  })

  it('there is no alignment warning when rsp is a multiple of 16', () => {
    const emu = boot(HELLO)
    const call = stepToLibrary(emu)
    expect(notesOf(call, 'warning')).toEqual([])
  })

  it('there is no alignment warning for a call to the program’s own function', () => {
    const emu = bootMain(['call f', 'ret', 'f:', 'ret'])
    const r = emu.step()
    expect(notesOf(r, 'warning')).toEqual([])
  })
})

describe('10b. printf conversions', () => {
  const s1 = { label: 's1' }
  const rows: { format: string; args: PrintfArg[]; expected: string }[] = [
    { format: '%d', args: [42n], expected: '42' },
    { format: '%d', args: [-5n], expected: '-5' },
    { format: '%d', args: [0x100000005n], expected: '5' },
    { format: '%d', args: [0x80000000n], expected: '-2147483648' },
    { format: '%i', args: [-7n], expected: '-7' },
    { format: '%u', args: [0xffffffffn], expected: '4294967295' },
    { format: '%u', args: [-1n], expected: '4294967295' },
    { format: '%x', args: [0xdeadbeefn], expected: 'deadbeef' },
    { format: '%X', args: [0xdeadbeefn], expected: 'DEADBEEF' },
    { format: '%x', args: [0x1234567890n], expected: '34567890' },
    { format: '%x', args: [0n], expected: '0' },
    { format: '%c', args: [65n], expected: 'A' },
    { format: '%c', args: [0x141n], expected: 'A' },
    { format: '%s', args: [s1], expected: 'abc' },
    { format: '%p', args: [0x7ffffffddff0n], expected: '0x7ffffffddff0' },
    { format: '%p', args: [0x10n], expected: '0x10' },
    { format: '%%', args: [], expected: '%' },
    { format: '100%%', args: [], expected: '100%' },
    { format: '%ld', args: [-2n], expected: '-2' },
    { format: '%ld', args: [0x100000005n], expected: '4294967301' },
    { format: '%li', args: [-9n], expected: '-9' },
    { format: '%lu', args: [-1n], expected: '18446744073709551615' },
    { format: '%lx', args: [0x1122334455667788n], expected: '1122334455667788' },
    { format: '%lX', args: [0xabcdef0123456789n], expected: 'ABCDEF0123456789' },
    { format: '%lld', args: [-3n], expected: '-3' },
    { format: '%llu', args: [MIN64], expected: '9223372036854775808' },
    { format: '%zu', args: [0x100000000n], expected: '4294967296' },
    { format: '%jd', args: [-1n], expected: '-1' },
    { format: '%hd', args: [0x12348000n], expected: '-32768' },
    { format: '%hu', args: [0x12348000n], expected: '32768' },
    { format: '%hx', args: [0x12345678n], expected: '5678' },
    { format: '%hhd', args: [0x1ffn], expected: '-1' },
    { format: '%hhu', args: [0x1ffn], expected: '255' },
    { format: '%hhx', args: [0xabcn], expected: 'bc' },
    { format: '%5d', args: [42n], expected: '   42' },
    { format: '%-5d|', args: [42n], expected: '42   |' },
    { format: '%05d', args: [42n], expected: '00042' },
    { format: '%05d', args: [-42n], expected: '-0042' },
    { format: '%-3d|', args: [-1n], expected: '-1 |' },
    { format: '%02x', args: [5n], expected: '05' },
    { format: '%08X', args: [0xbeefn], expected: '0000BEEF' },
    { format: '%016lx', args: [0xdeadbeefn], expected: '00000000deadbeef' },
    { format: '%5ld', args: [-12n], expected: '  -12' },
    { format: '%2d', args: [12345n], expected: '12345' },
    { format: '%5s|', args: [s1], expected: '  abc|' },
    { format: '%-5s|', args: [s1], expected: 'abc  |' },
    { format: '%3c|', args: [65n], expected: '  A|' },
    {
      format: 'a=%d, b=%d, c=%d, d=%d, e=%d',
      args: [1n, 2n, 3n, 4n, 5n],
      expected: 'a=1, b=2, c=3, d=4, e=5',
    },
    { format: 'plain text\n', args: [], expected: 'plain text\n' },
    { format: '%s and %c\t%u\n', args: [s1, 0x7an, 7n], expected: 'abc and z\t7\n' },
  ]
  it.each(rows)('printf $format → $expected', ({ format, args, expected }) => {
    const { emu, r } = runPrintf(format, args)
    expect(r.kind).toBe('library')
    expect(r.status).toBe('running')
    expect(r.output).toBe(expected)
    expect(snap(emu).output).toBe(expected)
    expect(reg(emu, 'rax')).toBe(BigInt(expected.length))
  })

  it('a 6th and 7th argument come from the stack, just above the return address', () => {
    const emu = bootMain(
      [
        'push rbp',
        'mov rbp, rsp',
        'push 7',
        'push 6',
        'mov r9d, 5',
        'mov r8d, 4',
        'mov ecx, 3',
        'mov edx, 2',
        'mov esi, 1',
        'lea rdi, fmt[rip]',
        'mov eax, 0',
        'call printf@PLT',
        'add rsp, 16',
        'pop rbp',
        'ret',
      ],
      {},
      ['fmt: .string "%d %d %d %d %d %d %d\\n"'],
    )
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(snap(emu).output).toBe('1 2 3 4 5 6 7\n')
  })

  it('printf with rdi not holding the address of text: library-error, atomic', () => {
    const emu = bootMain([
      'push rbp',
      'mov edi, 16',
      'mov eax, 0',
      'call printf@PLT',
      'pop rbp',
      'ret',
    ])
    stepToLibrary(emu)
    const before = snap(emu)
    const r = emu.step()
    expect(r.executed).toBe(true)
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('library-error')
    expect(r.error?.message ?? '').toMatch(/address/i)
    expect(r.error?.message ?? '').toContain('lea rdi')
    expect(r.output).toBe('')
    const s = snap(emu)
    expect(s.output).toBe('')
    expect(s.rip).toBe(PRINTF)
    expect(s.registers.rsp).toBe(before.registers.rsp)
    expect(emu.readMemory(s.registers.rsp, 8)).toEqual(emu.readMemory(before.registers.rsp, 8))
    expect(deepDiff(s.registers, before.registers)).toEqual([])
    expect(s.stepCount).toBe(before.stepCount + 1)
  })

  it('printf %s with an argument that is not a readable address: library-error', () => {
    const { emu, r } = runPrintf('%s', [16n])
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('library-error')
    expect(snap(emu).output).toBe('')
  })

  it('printf with an unknown conversion %f: library-error that names it and lists the supported ones', () => {
    const { emu, r } = runPrintf('x=%f', [1n])
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('library-error')
    expect(r.error?.message ?? '').toContain('%f')
    expect(r.error?.message ?? '').toContain('%d')
    expect(snap(emu).output).toBe('')
  })
})

describe('10c. scanf', () => {
  function readInput(format: string, args: string[], stdin: string) {
    const emu = boot(scanfProgram(format, args), { stdin })
    stepToLibrary(emu)
    const r = emu.step()
    return { emu, r }
  }

  it('reads a number from options.stdin: 4 bytes at the address in rsi, eax = 1', () => {
    const { emu, r } = readInput('%d', ['lea rsi, -8[rbp]'], '42\n')
    expect(r.executed).toBe(true)
    expect(emu.readMemory(LOCAL_8, 8)).toEqual([42, 0, 0, 0, null, null, null, null])
    expect(reg(emu, 'rax')).toBe(1n)
    expect(snap(emu).rip).toBe(instrAfterCall(emu))
  })

  it('pauses for input, then reads what provideInput gives', () => {
    const emu = boot(scanfProgram('%d'))
    stepToLibrary(emu)
    const count = snap(emu).stepCount
    const r = emu.step()
    expect(r.executed).toBe(false)
    expect(r.status).toBe('waiting-input')
    const waiting = snap(emu)
    expect(waiting.status).toBe('waiting-input')
    expect(waiting.inputRequest?.prompt ?? '').not.toBe('')
    expect(waiting.stepCount).toBe(count)
    expect(emu.step().executed).toBe(false) // still no input
    emu.provideInput('42')
    expect(snap(emu).status).toBe('running')
    expect(snap(emu).inputRequest).toBeNull()
    const read = emu.step()
    expect(read.executed).toBe(true)
    expect(read.kind).toBe('library')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(42n, 4))
    expect(reg(emu, 'rax')).toBe(1n)
  })

  it('reads two numbers', () => {
    const { emu } = readInput('%d %d', ['lea rsi, -8[rbp]', 'lea rdx, -4[rbp]'], '3 4\n')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(3n, 4))
    expect(emu.readMemory(LOCAL_4, 4)).toEqual(le(4n, 4))
    expect(reg(emu, 'rax')).toBe(2n)
  })

  it('two numbers on separate provideInput calls: nothing is read until both are there', () => {
    const emu = boot(scanfProgram('%d %d', ['lea rsi, -8[rbp]', 'lea rdx, -4[rbp]']))
    stepToLibrary(emu)
    emu.step()
    emu.provideInput('3')
    const r = emu.step()
    expect(r.executed).toBe(false)
    expect(snap(emu).status).toBe('waiting-input')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual([null, null, null, null])
    emu.provideInput('4')
    expect(emu.step().executed).toBe(true)
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(3n, 4))
    expect(emu.readMemory(LOCAL_4, 4)).toEqual(le(4n, 4))
    expect(reg(emu, 'rax')).toBe(2n)
  })

  it('reads a negative number', () => {
    const { emu } = readInput('%d', ['lea rsi, -8[rbp]'], '-17\n')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual([0xef, 0xff, 0xff, 0xff])
  })

  // Corrected by the emulator owner: the contract said "the rest of that input line is thrown
  // away", but real C (glibc) leaves the characters it could not read in the input, so the
  // next scanf("%d") fails on them again. The emulator follows real C now.
  it('bad input: eax = 0, nothing stored, a warning, and the bad input stays for the next scanf', () => {
    const emu = boot(
      mainProg(
        [
          'push rbp',
          'mov rbp, rsp',
          'sub rsp, 16',
          'lea rsi, -8[rbp]',
          'lea rdi, fmt[rip]',
          'call scanf@PLT',
          'mov r12d, eax',
          'lea rsi, -4[rbp]',
          'lea rdi, fmt[rip]',
          'call scanf@PLT',
          'leave',
          'ret',
        ],
        ['fmt: .string "%d"'],
      ),
      { stdin: 'abc 9\n5\n' },
    )
    stepToLibrary(emu)
    const bad = emu.step()
    expect(bad.executed).toBe(true)
    expect(reg(emu, 'rax')).toBe(0n)
    expect(notesOf(bad, 'warning').length).toBeGreaterThan(0)
    expect(emu.readMemory(LOCAL_8, 4)).toEqual([null, null, null, null])
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(reg(emu, 'r12')).toBe(0n)
    // "abc" is still first in the input, so the second scanf stores nothing either.
    expect(reg(emu, 'rax')).toBe(0n)
    expect(emu.readMemory(LOCAL_4, 4)).toEqual([null, null, null, null])
  })

  it('a destination that is not writable memory: library-error, atomic, suggests lea rsi', () => {
    const emu = boot(scanfProgram('%d', ['mov esi, 16']), { stdin: '5\n' })
    stepToLibrary(emu)
    const before = snap(emu)
    const r = emu.step()
    expect(r.status).toBe('error')
    expect(r.error?.code).toBe('library-error')
    expect(r.error?.message ?? '').toMatch(/address/i)
    expect(r.error?.message ?? '').toContain('lea rsi')
    expect(snap(emu).rip).toBe(SCANF)
    expect(deepDiff(snap(emu).registers, before.registers)).toEqual([])
  })

  it('%ld writes 8 bytes', () => {
    const { emu } = readInput('%ld', ['lea rsi, -8[rbp]'], '-5\n')
    expect(emu.readMemory(LOCAL_8, 8)).toEqual(le(-5n, 8))
  })

  it('%c reads one byte and does not skip white space', () => {
    const { emu } = readInput('%c', ['lea rsi, -8[rbp]'], ' a\n')
    expect(emu.readMemory(LOCAL_8, 2)).toEqual([0x20, null])
    expect(reg(emu, 'rax')).toBe(1n)
  })

  it('%s reads one word and adds a 0 byte', () => {
    const { emu } = readInput('%s', ['lea rsi, -16[rbp]'], 'hello world\n')
    expect(emu.readMemory(0x7ffffffddfe0n, 7)).toEqual([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0, null])
    expect(reg(emu, 'rax')).toBe(1n)
  })

  it('%x reads hex and %u reads an unsigned number, 4 bytes each', () => {
    const { emu } = readInput('%x %u', ['lea rsi, -8[rbp]', 'lea rdx, -4[rbp]'], 'ff 4000000000\n')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(0xffn, 4))
    expect(emu.readMemory(LOCAL_4, 4)).toEqual([0x00, 0x28, 0x6b, 0xee])
  })

  it('%hd writes 2 bytes', () => {
    const { emu } = readInput('%hd', ['lea rsi, -8[rbp]'], '-2\n')
    expect(emu.readMemory(LOCAL_8, 3)).toEqual([0xfe, 0xff, null])
  })
})

/** Address of the instruction right after the (only) `call` in a program. */
function instrAfterCall(emu: EmulatorApi): bigint {
  const call = must(
    emu.program.instructions.find((i) => i.mnemonic === 'call'),
    'call instruction',
  )
  return call.address + BigInt(call.size)
}

describe('10d. puts, putchar', () => {
  it('puts prints the text and a newline; eax = bytes printed', () => {
    const emu = bootMain(['push rbp', 'lea rdi, msg[rip]', 'call puts@PLT', 'pop rbp', 'ret'], {}, [
      'msg: .string "Hi"',
    ])
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(snap(emu).output).toBe('Hi\n')
    expect(reg(emu, 'rax')).toBe(3n)
  })

  it('putchar prints the low 8 bits of edi; eax = that character code', () => {
    const emu = bootMain(['push rbp', 'mov edi, 0x141', 'call putchar@PLT', 'pop rbp', 'ret'])
    runToEnd(emu)
    expect(snap(emu).output).toBe('A')
    expect(reg(emu, 'rax')).toBe(0x41n)
  })
})

/* ═════════════════════════════ 11. The ten example programs ═════════════════════════════ */

function exampleOptions(stdin: string | undefined): EmulatorOptions {
  return stdin === undefined ? {} : { stdin }
}

function exampleSource(id: string): { source: string; options: EmulatorOptions } {
  const example = must(
    EXAMPLES.find((e) => e.id === id),
    `example ${id}`,
  )
  return { source: example.source, options: exampleOptions(example.stdin) }
}

describe('11. The ten example programs', () => {
  const cases = EXAMPLES.map((example) => ({ id: example.id, example }))

  it('there are ten examples', () => {
    expect(EXAMPLES).toHaveLength(10)
  })

  it.each(cases)(
    '$id halts with exactly its expected output; every step is explained',
    ({ example }) => {
      const emu = boot(example.source, exampleOptions(example.stdin))
      const steps = runToEnd(emu)
      const s = snap(emu)
      expect(s.status).toBe('halted')
      expect(s.error).toBeNull()
      expect(s.output).toBe(example.expectedOutput)
      expect(steps.length).toBeLessThan(10_000)
      for (const r of steps) {
        expect(r.executed).toBe(true)
        expect(r.explanation.trim()).not.toBe('')
      }
    },
  )

  it.each(cases)('$id gives the same output with run()', ({ example }) => {
    const emu = boot(example.source, exampleOptions(example.stdin))
    const result = emu.run()
    expect(result.reason).toBe('halted')
    expect(result.stepsRun).toBeLessThan(10_000)
    expect(snap(emu).output).toBe(example.expectedOutput)
  })

  it.each(cases)(
    '$id: each explanation starts with the instruction text in backticks',
    ({ example }) => {
      const emu = boot(example.source, exampleOptions(example.stdin))
      for (const r of runToEnd(emu)) {
        if (r.kind === 'instruction') {
          expect(r.explanation.startsWith('`' + r.text + '`'), r.explanation).toBe(true)
        } else {
          // The contract does not say whether the function name of a library step is in
          // backticks, so both forms are accepted (see the report).
          const name = must(/printf|scanf|puts|putchar|exit/.exec(r.text), 'function name')[0]
          expect(r.explanation.replace(/^`/, '').startsWith(name), r.explanation).toBe(true)
          expect(r.explanation).toContain('(library code)')
        }
      }
    },
  )

  it.each(cases)(
    '$id: a correct program gets only junk-register tips, no warnings',
    ({ example }) => {
      const emu = boot(example.source, exampleOptions(example.stdin))
      for (const r of runToEnd(emu)) {
        expect(notesOf(r, 'warning'), r.text).toEqual([])
        if (r.kind === 'instruction') expect(r.notes, r.text).toEqual([])
      }
    },
  )
})

/* ═══════════════════════════════════ 12. Diffs ═══════════════════════════════════ */

/** Replay every diff onto copies of the first snapshot and compare with each new snapshot. */
function replayDiffs(source: string, options: EmulatorOptions): number {
  const emu = boot(source, options)
  const fresh = boot(source, options)
  const first = snap(emu)
  const regs: Record<Reg64, bigint> = { ...first.registers }
  const flags: Flags = { ...first.flags }
  let rip = first.rip
  const memory = new Map<bigint, number | null>()
  let steps = 0
  while (snap(emu).status === 'running' && steps < 10_000) {
    const r = emu.step()
    steps++
    expect(r.diff.rip.before).toBe(rip)
    for (const c of r.diff.registers) {
      expect(c.before).not.toBe(c.after)
      expect(regs[c.reg]).toBe(c.before)
      regs[c.reg] = c.after
      expect(r.diff.written.registers).toContain(c.reg)
    }
    for (const c of r.diff.flags) {
      expect(c.before).not.toBe(c.after)
      expect(flags[c.flag]).toBe(c.before)
      flags[c.flag] = c.after
      expect(r.diff.written.flags).toContain(c.flag)
    }
    for (const m of r.diff.memory) {
      expect(m.before).toHaveLength(m.after.length)
      expect(m.before.some((b, i) => b !== m.after[i])).toBe(true)
      m.after.forEach((byte, i) => {
        const address = m.address + BigInt(i)
        const current = memory.has(address) ? memory.get(address) : fresh.readMemory(address, 1)[0]
        expect(m.before[i]).toBe(current)
        memory.set(address, byte)
      })
      const end = m.address + BigInt(m.after.length)
      const covered = r.diff.written.memory.some(
        (w) => w.address <= m.address && end <= w.address + BigInt(w.bytes),
      )
      expect(covered).toBe(true)
    }
    rip = r.diff.rip.after
    const s = snap(emu)
    expect(s.rip).toBe(rip)
    expect(deepDiff(s.registers, regs)).toEqual([])
    expect(deepDiff(s.flags, flags)).toEqual([])
  }
  for (const [address, byte] of memory) expect(emu.readMemory(address, 1)[0]).toBe(byte)
  return steps
}

describe('12. Diffs', () => {
  it.each(['push-pop', 'locals', 'nested-call', 'array-max', 'read-number'])(
    '%s: replaying the diffs by hand reproduces every snapshot',
    (id) => {
      const { source, options } = exampleSource(id)
      expect(replayDiffs(source, options)).toBeGreaterThan(5)
    },
  )

  it('cmp lists all four flags as written, even when none of them changes', () => {
    const emu = bootMain(['cmp rax, rax', 'cmp rax, rax', 'ret'])
    const [r1, r2] = stepN(emu, 2)
    expect(r1?.diff.flags).toEqual([{ flag: 'ZF', before: 0, after: 1 }])
    expect([...(r2?.diff.written.flags ?? [])].sort()).toEqual(['CF', 'OF', 'SF', 'ZF'])
    expect(r2?.diff.flags).toEqual([])
  })

  it('inc does not list CF as written', () => {
    const r = bootMain(['inc rax', 'ret']).step()
    expect([...r.diff.written.flags].sort()).toEqual(['OF', 'SF', 'ZF'])
  })

  it('mov rax, 5 when rax is already 5: written but not changed', () => {
    const r = bootMain(['mov rax, 5', 'ret'], { initialRegisters: { rax: 5n } }).step()
    expect(r.diff.written.registers).toContain('rax')
    expect(r.diff.registers).toEqual([])
  })

  it('push lists rsp and the 8 bytes it wrote', () => {
    const r = bootMain(['push rbx', 'pop rbx', 'ret'], { initialRegisters: { rbx: 0x66n } }).step()
    expect(r.diff.written.registers).toContain('rsp')
    expect(r.diff.written.memory).toEqual([{ address: 0x7ffffffddff0n, bytes: 8 }])
    expect(r.diff.memory).toEqual([
      {
        address: 0x7ffffffddff0n,
        before: [null, null, null, null, null, null, null, null],
        after: le(0x66n, 8),
      },
    ])
    expect(r.diff.registers).toEqual([{ reg: 'rsp', before: START_RSP, after: 0x7ffffffddff0n }])
  })

  it('storing the value a box already holds: written, but no memory change', () => {
    const r = bootMain(['mov [rsp], rax', 'ret'], { initialRegisters: { rax: OS_RET } }).step()
    expect(r.diff.written.memory).toEqual([{ address: START_RSP, bytes: 8 }])
    expect(r.diff.memory).toEqual([])
  })

  it('a conditional jump writes no flags and no registers', () => {
    const emu = bootMain(['cmp eax, 0', 'je done', 'nop', 'done:', 'ret'])
    emu.step()
    const r = emu.step()
    expect(r.diff.written.flags).toEqual([])
    expect(r.diff.written.registers).toEqual([])
    expect(r.diff.rip).toEqual({ before: instr(emu, 1).address, after: instr(emu, 3).address })
  })
})

/* ═════════════════════════════ 13. Stack view and data view ═════════════════════════════ */

function expectContiguous(s: MachineState): void {
  expect(s.stack.length).toBeGreaterThan(0)
  s.stack.forEach((b, i) => {
    expect(b.address % 8n).toBe(0n)
    expect(b.bytes).toHaveLength(8)
    if (i > 0) expect(must(s.stack[i - 1], 'box above').address - b.address).toBe(8n)
  })
}

describe('13. Stack view and data view', () => {
  it.each(['locals', 'nested-call', 'read-number'])(
    '%s: at every step the boxes are contiguous, highest first, and cover rsp, rbp and the OS box',
    (id) => {
      const { source, options } = exampleSource(id)
      const emu = boot(source, options)
      for (;;) {
        const s = snap(emu)
        expectContiguous(s)
        expect(s.stack.some((b) => b.address === START_RSP)).toBe(true)
        const rspBox = s.stack.find((b) => b.address === (s.registers.rsp & ~7n))
        expect(rspBox?.isRsp).toBe(true)
        expect(s.stack.filter((b) => b.isRsp)).toHaveLength(1)
        const rbp = s.registers.rbp
        if (rbp > 0x7ffffff00000n && rbp < STACK_BASE) {
          expect(s.stack.find((b) => b.address === (rbp & ~7n))?.isRbp).toBe(true)
        }
        for (const b of s.stack) expect(b.dead).toBe(b.address + 8n <= s.registers.rsp)
        if (s.status !== 'running') break
        emu.step()
      }
      expect(snap(emu).status).toBe('halted')
    },
  )

  it('a call box: kind return-address, label with "return address" and the line it returns to', () => {
    const emu = bootMain(['call f', 'ret', 'f:', 'ret'])
    emu.step()
    const b = box(snap(emu), 0x7ffffffddff0n)
    expect(b.kind).toBe('return-address')
    expect(b.label ?? '').toContain('return address')
    expect(b.label ?? '').toContain(`line ${instr(emu, 1).line}`)
    expect(b.value).toBe(instr(emu, 1).address)
    expect(b.isRsp).toBe(true)
    expect(b.changed).toBe(true)
    expect(box(snap(emu), START_RSP).changed).toBe(false)
  })

  it('push rbp: kind saved-register, label contains "saved rbp"', () => {
    const emu = bootMain(['push rbp', 'pop rbp', 'ret'])
    emu.step()
    const b = box(snap(emu), 0x7ffffffddff0n)
    expect(b.kind).toBe('saved-register')
    expect(b.label ?? '').toContain('saved rbp')
  })

  it('push rbx: kind saved-register, label names rbx', () => {
    const emu = bootMain(['push rbx', 'pop rbx', 'ret'], { initialRegisters: { rbx: 2n } })
    emu.step()
    const b = box(snap(emu), 0x7ffffffddff0n)
    expect(b.kind).toBe('saved-register')
    expect(b.label ?? '').toContain('rbx')
  })

  it('an .equ local written through count[rbp]: kind local, label count', () => {
    const emu = bootMain(
      ['push rbp', 'mov rbp, rsp', 'sub rsp, 16', 'mov qword ptr count[rbp], 5', 'leave', 'ret'],
      {},
      ['.equ count, -8'],
    )
    stepN(emu, 4)
    const b = box(snap(emu), 0x7ffffffddfe8n)
    expect(b.kind).toBe('local')
    expect(b.label).toBe('count')
    expect(b.value).toBe(5n)
    expect(b.changed).toBe(true)
  })

  it('a local whose address was taken with lea: kind local, label = the .equ name', () => {
    const emu = bootMain(
      ['push rbp', 'mov rbp, rsp', 'sub rsp, 16', 'lea rsi, number[rbp]', 'leave', 'ret'],
      {},
      ['.equ number, -8'],
    )
    stepN(emu, 4)
    const b = box(snap(emu), 0x7ffffffddfe8n)
    expect(b.kind).toBe('local')
    expect(b.label).toBe('number')
  })

  it('isRsp and isRbp after push rbp; mov rbp, rsp', () => {
    const emu = bootMain(['push rbp', 'mov rbp, rsp', 'pop rbp', 'ret'])
    stepN(emu, 2)
    const s = snap(emu)
    const top = box(s, 0x7ffffffddff0n)
    expect(top.isRsp).toBe(true)
    expect(top.isRbp).toBe(true)
    expect(box(s, START_RSP).isRsp).toBe(false)
    expect(box(s, START_RSP).isRbp).toBe(false)
  })

  it('rbp pointing into the middle of a box marks that box, and a far rbp extends the view', () => {
    const emu = bootMain(['lea rbp, [rsp-4]', 'lea rbp, [rsp-64]', 'ret'])
    emu.step()
    expect(box(snap(emu), 0x7ffffffddff0n).isRbp).toBe(true)
    emu.step()
    const s = snap(emu)
    expect(box(s, START_RSP - 64n).isRbp).toBe(true)
    expectContiguous(s)
  })

  it('after pop: the old box is dead, keeps its value, and was not changed by the pop', () => {
    const emu = bootMain(['push rbx', 'pop rcx', 'ret'], { initialRegisters: { rbx: 5n } })
    emu.step()
    expect(box(snap(emu), 0x7ffffffddff0n).changed).toBe(true)
    emu.step()
    const b = box(snap(emu), 0x7ffffffddff0n)
    expect(b.dead).toBe(true)
    expect(b.value).toBe(5n)
    expect(b.changed).toBe(false)
  })

  it('a dword ptr write into a fresh box: value with the other bytes as 0, bytes with nulls', () => {
    const emu = bootMain(['sub rsp, 16', 'mov dword ptr [rsp], 0x11223344', 'add rsp, 16', 'ret'])
    stepN(emu, 2)
    const b = box(snap(emu), 0x7ffffffddfe8n)
    expect(b.value).toBe(0x11223344n)
    expect(b.bytes).toEqual([0x44, 0x33, 0x22, 0x11, null, null, null, null])
    expect(b.kind).toBe('value')
    expect(b.label).toBeNull()
  })

  it('boxes nobody wrote between rsp and the OS box are empty with value null', () => {
    const emu = bootMain(['sub rsp, 16', 'add rsp, 16', 'ret'])
    emu.step()
    const s = snap(emu)
    for (const address of [0x7ffffffddfe8n, 0x7ffffffddff0n]) {
      const b = box(s, address)
      expect(b.kind).toBe('empty')
      expect(b.value).toBeNull()
      expect(b.bytes).toEqual([null, null, null, null, null, null, null, null])
    }
    expect(box(s, 0x7ffffffddfe8n).isRsp).toBe(true)
  })

  it('a push over an old return address makes the box a saved register', () => {
    const emu = bootMain(['call f', 'push rbx', 'pop rbx', 'ret', 'f:', 'ret'], {
      initialRegisters: { rbx: 3n },
    })
    emu.step()
    expect(box(snap(emu), 0x7ffffffddff0n).kind).toBe('return-address')
    stepN(emu, 2) // ret from f, then push rbx
    const b = box(snap(emu), 0x7ffffffddff0n)
    expect(b.kind).toBe('saved-register')
    expect(b.label ?? '').toContain('rbx')
    expect(b.value).toBe(3n)
  })

  it('the data view shows .string and .quad items, before and after writes', () => {
    const emu = bootMain(
      [
        'mov qword ptr nums+8[rip], 9',
        "mov byte ptr pet[rip], 'c'",
        'mov byte ptr pet+1[rip], 0',
        'ret',
      ],
      {},
      [
        'msg: .string "abc"',
        '.data',
        'nums: .quad 1, 2',
        'pet: .string "hat"',
        'longs: .long -1, 7',
        '.text',
      ],
    )
    let data = snap(emu).data
    expect(data).toHaveLength(4)
    expect(data[0]).toEqual({
      label: 'msg',
      address: RODATA_BASE,
      directive: '.string',
      readOnly: true,
      elementSize: 1,
      values: [0x61n, 0x62n, 0x63n, 0n],
      text: 'abc',
    })
    expect(data[1]).toEqual({
      label: 'nums',
      address: DATA_BASE,
      directive: '.quad',
      readOnly: false,
      elementSize: 8,
      values: [1n, 2n],
      text: null,
    })
    expect(data[2]?.address).toBe(DATA_BASE + 16n)
    expect(data[2]?.text).toBe('hat')
    expect(data[2]?.readOnly).toBe(false)
    expect(data[3]?.address).toBe(DATA_BASE + 20n)
    expect(data[3]?.elementSize).toBe(4)
    expect(data[3]?.values).toEqual([0xffffffffn, 7n])
    emu.step()
    data = snap(emu).data
    expect(data[1]?.values).toEqual([1n, 9n])
    emu.step()
    expect(snap(emu).data[2]?.text).toBe('cat')
    emu.step()
    data = snap(emu).data
    expect(data[2]?.text).toBe('c')
    expect(data[2]?.values).toEqual([0x63n, 0n, 0x74n, 0n])
  })
})

/* ═══════════════════════════════════ 14. Notes ═══════════════════════════════════ */

describe('14. Notes', () => {
  it('a library call with rsp not a multiple of 16 warns, and the warning mentions 16', () => {
    const emu = bootMain(['lea rdi, msg[rip]', 'call puts@PLT', 'ret'], {}, ['msg: .string "Hi"'])
    const call = stepToLibrary(emu)
    const warnings = notesOf(call, 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text ?? '').toContain('16')
  })

  it('the same library call with rsp aligned does not warn', () => {
    const emu = bootMain(['push rbp', 'lea rdi, msg[rip]', 'call puts@PLT', 'pop rbp', 'ret'], {}, [
      'msg: .string "Hi"',
    ])
    expect(stepToLibrary(emu).notes).toEqual([])
  })

  it('a misaligned call to the program’s own function does not warn', () => {
    expect(bootMain(['call f', 'ret', 'f:', 'ret']).step().notes).toEqual([])
  })

  it('a library step that put junk in the caller-saved registers gives a tip naming them', () => {
    const emu = boot(HELLO)
    stepToLibrary(emu)
    const tips = notesOf(emu.step(), 'tip')
    expect(tips).toHaveLength(1)
    for (const name of ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r11'])
      expect(tips[0]?.text ?? '').toContain(name)
  })

  it('with clobberCallerSaved: false the library step gives no tip', () => {
    const emu = boot(HELLO, { clobberCallerSaved: false })
    stepToLibrary(emu)
    expect(emu.step().notes).toEqual([])
  })

  it('reading stack bytes that were never written warns', () => {
    const emu = bootMain(['sub rsp, 16', 'mov rax, [rsp+8]', 'add rsp, 16', 'ret'])
    emu.step()
    const warnings = notesOf(emu.step(), 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text ?? '').toMatch(/never|junk/i)
  })

  it('reading a stack box that was written first does not warn', () => {
    const emu = bootMain([
      'sub rsp, 16',
      'mov qword ptr [rsp+8], 1',
      'mov rax, [rsp+8]',
      'add rsp, 16',
      'ret',
    ])
    stepN(emu, 2)
    expect(emu.step().notes).toEqual([])
  })

  it('lea of a never-written box does not warn (lea reads no memory)', () => {
    const emu = bootMain(['sub rsp, 16', 'lea rax, [rsp+8]', 'add rsp, 16', 'ret'])
    emu.step()
    expect(emu.step().notes).toEqual([])
  })

  const retBody = (change: string) => [
    'call f',
    'mov eax, 1',
    'ret',
    'other:',
    'mov eax, 2',
    'ret',
    'f:',
    'lea rcx, other[rip]',
    change,
    'ret',
  ]

  it('ret to a valid instruction that is not the saved return address warns, and jumps there', () => {
    const emu = bootMain(retBody('mov [rsp], rcx'))
    stepN(emu, 3)
    const r = emu.step()
    expect(r.status).toBe('running')
    expect(notesOf(r, 'warning')).toHaveLength(1)
    expect(snap(emu).rip).toBe(instr(emu, 3).address)
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(reg(emu, 'rax')).toBe(2n)
  })

  it('a normal ret does not warn', () => {
    const emu = bootMain(retBody('mov rdx, rcx'))
    stepN(emu, 3)
    expect(emu.step().notes).toEqual([])
    runToEnd(emu)
    expect(reg(emu, 'rax')).toBe(1n)
  })

  it('scanf that cannot read the wanted kind of value warns', () => {
    const emu = boot(scanfProgram('%d'), { stdin: 'xyz\n' })
    stepToLibrary(emu)
    expect(notesOf(emu.step(), 'warning').length).toBeGreaterThan(0)
  })

  it('scanf that reads its value does not warn', () => {
    const emu = boot(scanfProgram('%d'), { stdin: '12\n' })
    stepToLibrary(emu)
    expect(notesOf(emu.step(), 'warning')).toEqual([])
  })

  const imulProgram = (between: string[], jcc: string) =>
    mainProg(['mov eax, 3', 'imul eax, eax', ...between, `${jcc} done`, 'nop', 'done:', 'ret'])
  const imulWarning = (r: StepResult) =>
    notesOf(r, 'warning').some((n) => n.text.includes('imul') && /\bcmp\b|\btest\b/.test(n.text))

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
    'jnl',
    'jnge',
    'jng',
    'jnbe',
    'jna',
  ])('imul then %s (reads ZF or SF) warns about imul and cmp/test', (jcc) => {
    const emu = boot(imulProgram([], jcc))
    const r = lastOf(stepN(emu, 3))
    expect(r.text.startsWith(jcc)).toBe(true)
    expect(imulWarning(r)).toBe(true)
  })

  it.each(['jo', 'jno', 'jb', 'jae', 'jc', 'jnc', 'jnb', 'jnae'])(
    'imul then %s (reads only CF or OF) does not warn',
    (jcc) => {
      const emu = boot(imulProgram([], jcc))
      const r = lastOf(stepN(emu, 3))
      expect(r.notes).toEqual([])
    },
  )

  it('imul, cmp, then je does not warn', () => {
    const r = lastOf(stepN(boot(imulProgram(['cmp eax, 9'], 'je')), 4))
    expect(r.notes).toEqual([])
  })

  it('imul, test, then jl does not warn', () => {
    const r = lastOf(stepN(boot(imulProgram(['test eax, eax'], 'jl')), 4))
    expect(r.notes).toEqual([])
  })

  it('imul, mov, then je still warns (mov writes no flags)', () => {
    const r = lastOf(stepN(boot(imulProgram(['mov ebx, 1'], 'je')), 4))
    expect(imulWarning(r)).toBe(true)
  })

  it('imul, inc, then je does not warn (inc wrote ZF and SF)', () => {
    const r = lastOf(stepN(boot(imulProgram(['inc ebx'], 'je')), 4))
    expect(r.notes).toEqual([])
  })

  it('add, then je does not warn', () => {
    const emu = bootMain(['add eax, 1', 'je done', 'nop', 'done:', 'ret'])
    expect(lastOf(stepN(emu, 2)).notes).toEqual([])
  })
})

/* ═══════════════════════════════════ 15. Explanations ═══════════════════════════════════ */

/** The explanation after the leading `instruction text`. */
function afterText(r: StepResult): string {
  const head = '`' + r.text + '`'
  expect(r.explanation.startsWith(head), r.explanation).toBe(true)
  return r.explanation.slice(head.length)
}

function hasFull(text: string, value: bigint): boolean {
  return text.includes(hex64(value)) || text.includes(groupHex(value))
}

describe('15. Explanations', () => {
  it('push: rsp before and after, and the value pushed', () => {
    const emu = bootMain(['push rbx', 'pop rcx', 'ret'], { initialRegisters: { rbx: 5n } })
    const r = emu.step()
    const text = afterText(r)
    expect(mentionsAddress(text, START_RSP)).toBe(true)
    expect(mentionsAddress(text, 0x7ffffffddff0n)).toBe(true)
    expect(mentionsValue(text, 5n)).toBe(true)
  })

  it('pop: the value popped, rsp before and after', () => {
    const emu = bootMain(['push rbx', 'pop rcx', 'ret'], { initialRegisters: { rbx: 0x5an } })
    emu.step()
    const text = afterText(emu.step())
    expect(mentionsValue(text, 0x5an)).toBe(true)
    expect(mentionsAddress(text, 0x7ffffffddff0n)).toBe(true)
    expect(mentionsAddress(text, START_RSP)).toBe(true)
  })

  it('call: rsp before and after, the return address, and where it jumped', () => {
    const emu = bootMain(['call helper', 'ret', 'helper:', 'ret'])
    const text = afterText(emu.step())
    expect(mentionsAddress(text, START_RSP)).toBe(true)
    expect(mentionsAddress(text, 0x7ffffffddff0n)).toBe(true)
    expect(mentionsAddress(text, instr(emu, 1).address)).toBe(true)
    expect(text.includes('helper') || mentionsAddress(text, instr(emu, 2).address)).toBe(true)
  })

  it('ret: the address popped into rip, rsp before and after', () => {
    const emu = bootMain(['call helper', 'ret', 'helper:', 'ret'])
    emu.step()
    const text = afterText(emu.step())
    expect(mentionsAddress(text, instr(emu, 1).address)).toBe(true)
    expect(mentionsAddress(text, 0x7ffffffddff0n)).toBe(true)
    expect(mentionsAddress(text, START_RSP)).toBe(true)
  })

  it('mov eax, 7 on a full rax: says the top half was cleared, with the full value before and after', () => {
    const emu = bootMain(['mov eax, 7', 'ret'], { initialRegisters: { rax: 0x1111222233334444n } })
    const text = afterText(emu.step())
    expect(hasFull(text, 0x1111222233334444n)).toBe(true)
    expect(hasFull(text, 7n)).toBe(true)
    expect(text).toMatch(/top|upper|high/i)
  })

  it('mov al, 7: says the other bits did not change and shows the full new value', () => {
    const emu = bootMain(['mov al, 7', 'ret'], { initialRegisters: { rax: 0x1111222233334444n } })
    const text = afterText(emu.step())
    expect(hasFull(text, 0x1111222233334407n)).toBe(true)
    expect(text).toMatch(/not change|unchanged|did not change|didn't change|stay|kept|same/i)
  })

  it('a memory operand: the address that was worked out', () => {
    const emu = bootMain([
      'push rbp',
      'mov rbp, rsp',
      'sub rsp, 16',
      'mov qword ptr [rbp-8], 7',
      'mov rax, [rbp-8]',
      'leave',
      'ret',
    ])
    stepN(emu, 3)
    const store = afterText(emu.step())
    expect(mentionsAddress(store, 0x7ffffffddfe8n)).toBe(true)
    const load = afterText(emu.step())
    expect(mentionsAddress(load, 0x7ffffffddfe8n)).toBe(true)
    expect(mentionsValue(load, 7n)).toBe(true)
    expect(load).toContain('rbp')
  })

  it('lea: the address, and that lea does not read memory', () => {
    const emu = bootMain(['lea rax, [rsp-8]', 'ret'])
    const text = afterText(emu.step())
    expect(mentionsAddress(text, 0x7ffffffddff0n)).toBe(true)
    expect(text).toMatch(/read/i)
    expect(text).toMatch(/\bnot\b|\bnever\b|n['’]t\b|\bwithout\b|\bno\b/i)
  })

  it('add: both inputs, the result, and the flags', () => {
    const emu = bootMain(['add rax, rbx', 'ret'], { initialRegisters: { rax: 0x15n, rbx: 0x23n } })
    const text = afterText(emu.step())
    expect(mentionsValue(text, 0x15n)).toBe(true)
    expect(mentionsValue(text, 0x23n)).toBe(true)
    expect(mentionsValue(text, 0x38n)).toBe(true)
    for (const flag of ['CF', 'ZF', 'SF', 'OF']) expect(text).toContain(flag)
  })

  it('inc: says CF is not changed', () => {
    const emu = bootMain(['inc rax', 'ret'], { initialRegisters: { rax: 0x41n } })
    const text = afterText(emu.step())
    expect(mentionsValue(text, 0x41n)).toBe(true)
    expect(mentionsValue(text, 0x42n)).toBe(true)
    expect(text).toContain('CF')
    expect(text).toMatch(/not|unchanged|no change|same|kept|stay/i)
  })

  it('cmp: both values, that nothing is stored, and the flags', () => {
    const emu = bootMain(['cmp rax, rbx', 'ret'], { initialRegisters: { rax: 0x15n, rbx: 0x27n } })
    const text = afterText(emu.step())
    expect(mentionsValue(text, 0x15n)).toBe(true)
    expect(mentionsValue(text, 0x27n)).toBe(true)
    expect(text).toMatch(
      /nothing|without storing|without saving|not stored|not saved|not kept|no result|does not store|doesn't store|thrown away|only the flags/i,
    )
    for (const flag of ['CF', 'ZF', 'SF', 'OF']) expect(text).toContain(flag)
  })

  it('test: both values and the flags', () => {
    const emu = bootMain(['test eax, ebx', 'ret'], { initialRegisters: { rax: 0xf0n, rbx: 0x3cn } })
    const text = afterText(emu.step())
    expect(mentionsValue(text, 0xf0n)).toBe(true)
    expect(mentionsValue(text, 0x3cn)).toBe(true)
    for (const flag of ['ZF', 'SF']) expect(text).toContain(flag)
  })

  it('a taken jcc says "jumped to" and the label, and names the flag it read', () => {
    const emu = bootMain(['cmp eax, 0', 'je done', 'nop', 'done:', 'ret'])
    emu.step()
    const text = afterText(emu.step())
    expect(text).toContain('jumped to')
    expect(text).toContain('done')
    expect(text).toContain('ZF')
  })

  it('a jcc that is not taken says "did not jump"', () => {
    const emu = bootMain(['cmp eax, 1', 'je done', 'nop', 'done:', 'ret'])
    emu.step()
    const text = afterText(emu.step())
    expect(text).toContain('did not jump')
    expect(text).toContain('ZF')
  })

  it('jg names the three flags of its rule', () => {
    const emu = bootMain(['cmp eax, 1', 'jg done', 'nop', 'done:', 'ret'], {
      initialRegisters: { rax: 2n },
    })
    emu.step()
    const text = afterText(emu.step())
    for (const flag of ['ZF', 'SF', 'OF']) expect(text).toContain(flag)
    expect(text).toContain('jumped to')
  })

  it('a library step: the function, what it did, eax, and the return', () => {
    const emu = boot(HELLO)
    stepToLibrary(emu)
    const r = emu.step()
    // Backticks around the function name: not settled by the contract (see the report).
    expect(r.explanation.replace(/^`/, '').startsWith('printf'), r.explanation).toBe(true)
    expect(r.explanation).toContain('(library code)')
    expect(mentionsValue(r.explanation, 3n)).toBe(true)
    expect(mentionsAddress(r.explanation, instr(emu, 4).address)).toBe(true)
    expect(mentionsAddress(r.explanation, 0x7ffffffddfe8n)).toBe(true)
    expect(mentionsAddress(r.explanation, 0x7ffffffddff0n)).toBe(true)
  })

  it('the step that ends the program says so and gives the value in eax', () => {
    const emu = bootMain(['mov eax, 3', 'ret'])
    emu.step()
    const text = afterText(emu.step())
    expect(text).toMatch(/end|finish|halt|stop|over|done/i)
    expect(mentionsValue(text, 3n) || /\b3\b/.test(text)).toBe(true)
  })

  it('the explanation starts with the tidy instruction text', () => {
    const emu = boot(asm('main:', '    MOV   EAX,7', '    ret'))
    const r = emu.step()
    expect(r.text).toBe('mov eax, 7')
    expect(r.explanation.startsWith('`mov eax, 7`')).toBe(true)
  })
})

/* ═════════════════════════════ More edge cases, by group ═════════════════════════════ */

describe('3j. Immediates at every width (sign extension)', () => {
  const rows: AluRow[] = [
    {
      name: 'cmp rax, -1 on 0xffffffffffffffff: equal (sign-extended)',
      code: 'cmp rax, -1',
      regs: { rax: MASK[64] },
      read: 'rax',
      result: MASK[64],
      flags: F(0, 1, 0, 0),
    },
    {
      name: 'cmp rax, -1 on 0xffffffff: not equal, borrow',
      code: 'cmp rax, -1',
      regs: { rax: 0xffffffffn },
      read: 'rax',
      result: 0xffffffffn,
      flags: F(1, 0, 0, 0),
    },
    {
      name: 'add ax, -1 on 5 (16-bit immediate)',
      code: 'add ax, -1',
      regs: { rax: 5n },
      read: 'ax',
      result: 4n,
      flags: F(1, 0, 0, 0),
    },
    {
      name: 'sub ax, -1 on 0x7fff overflows',
      code: 'sub ax, -1',
      regs: { rax: 0x7fffn },
      read: 'ax',
      result: 0x8000n,
      flags: F(1, 0, 1, 1),
    },
    {
      name: 'add al, -128 on 0x80',
      code: 'add al, -128',
      regs: { rax: 0x80n },
      read: 'al',
      result: 0n,
      flags: F(1, 1, 0, 1),
    },
    {
      name: 'xor eax, -1 flips the low 32 bits and clears the top',
      code: 'xor eax, -1',
      regs: { rax: 0xaaaaaaaa0f0f0f0fn },
      read: 'rax',
      result: 0xf0f0f0f0n,
      flags: F(0, 0, 1, 0),
    },
    {
      name: 'add rax, 0x7fffffff',
      code: 'add rax, 0x7fffffff',
      regs: { rax: 1n },
      read: 'rax',
      result: 0x80000000n,
      flags: F(0, 0, 0, 0),
    },
    {
      name: 'sub rax, -0x80000000 on 0',
      code: 'sub rax, -0x80000000',
      read: 'rax',
      result: 0x80000000n,
      flags: F(1, 0, 0, 0),
    },
  ]
  it.each(rows)('$name', (row) => {
    runAluRow(row)
  })
})

describe('4b. More memory and stack-view edges', () => {
  it('an unaligned 8-byte store across two boxes marks both boxes as changed', () => {
    const emu = bootMain(['sub rsp, 16', 'mov qword ptr [rsp+4], -1', 'add rsp, 16', 'ret'])
    stepN(emu, 2)
    const s = snap(emu)
    const low = box(s, 0x7ffffffddfe8n)
    const high = box(s, 0x7ffffffddff0n)
    expect(low.bytes).toEqual([null, null, null, null, 0xff, 0xff, 0xff, 0xff])
    expect(low.value).toBe(0xffffffff00000000n)
    expect(high.bytes).toEqual([0xff, 0xff, 0xff, 0xff, null, null, null, null])
    expect(high.value).toBe(0xffffffffn)
    expect(low.changed).toBe(true)
    expect(high.changed).toBe(true)
    expect(box(s, START_RSP).changed).toBe(false)
  })

  it('an .equ name with base rsp labels the box as a local too', () => {
    const emu = bootMain(['sub rsp, 16', 'mov qword ptr slot[rsp], 4', 'add rsp, 16', 'ret'], {}, [
      '.equ slot, 8',
    ])
    stepN(emu, 2)
    const b = box(snap(emu), 0x7ffffffddff0n)
    expect(b.kind).toBe('local')
    expect(b.label).toBe('slot')
    expect(b.value).toBe(4n)
  })

  it('extended registers as base and index: [r12+r13*2+3] and [r12+8]', () => {
    const emu = bootMain(['lea rax, [r12+r13*2+3]', 'mov rbx, [r12+8]', 'ret'], {
      initialRegisters: { r12: 0x7ffffffddff0n, r13: 4n },
    })
    stepN(emu, 2)
    expect(reg(emu, 'rax')).toBe(0x7ffffffddff0n + 11n)
    expect(reg(emu, 'rbx')).toBe(OS_RET)
  })

  it('a 32-bit store into a .quad element updates the data view', () => {
    const emu = bootMain(['mov dword ptr nums[rip], -1', 'ret'], {}, [
      '.data',
      'nums: .quad 0x1122334455667788',
      '.text',
    ])
    emu.step()
    expect(snap(emu).data[0]?.values).toEqual([0x11223344ffffffffn])
  })
})

describe('7b. StepResult fields', () => {
  it('stepNumber, kind, line, address, text and output of instruction steps', () => {
    const emu = bootMain(['mov eax, 1', 'add eax, 2', 'ret'])
    const steps = runToEnd(emu)
    expect(steps).toHaveLength(3)
    steps.forEach((r, i) => {
      const ins = instr(emu, i)
      expect(r.stepNumber).toBe(i + 1)
      expect(r.kind).toBe('instruction')
      expect(r.line).toBe(ins.line)
      expect(r.address).toBe(ins.address)
      expect(r.text).toBe(ins.text)
      expect(r.output).toBe('')
      expect(r.error).toBeNull()
    })
  })

  it('the library step is numbered like any other step', () => {
    const steps = runToEnd(boot(HELLO))
    expect(steps.map((r) => r.stepNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(steps.map((r) => r.kind)).toEqual([
      'instruction',
      'instruction',
      'instruction',
      'instruction',
      'library',
      'instruction',
      'instruction',
      'instruction',
    ])
  })

  it('snapshot.lastStep is the StepResult the step returned', () => {
    const emu = bootMain(['mov eax, 1', 'ret'])
    const r = emu.step()
    expect(deepDiff(snap(emu).lastStep, r)).toEqual([])
  })
})

describe('9b. More run, listener and input edges', () => {
  it('step() on a halted program does not call the listener', () => {
    const emu = bootMain(['ret'])
    emu.step()
    let calls = 0
    emu.subscribe(() => {
      calls++
    })
    emu.step()
    expect(calls).toBe(0)
  })

  it('text given with provideInput before the pause is read without waiting', () => {
    const emu = boot(scanfProgram('%d'))
    emu.provideInput('7')
    expect(emu.run().reason).toBe('halted')
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(7n, 4))
  })

  it('run() again while still waiting for input runs 0 steps', () => {
    const emu = boot(scanfProgram('%d'))
    emu.run()
    expect(emu.run()).toMatchObject({ reason: 'waiting-input', stepsRun: 0 })
  })

  it('reset after an error gives a runnable program again', () => {
    const emu = bootMain(['mov rbx, 0x10', 'mov rax, [rbx]', 'ret'])
    emu.run()
    emu.reset()
    const s = snap(emu)
    expect(s.status).toBe('running')
    expect(s.error).toBeNull()
    expect(s.stepCount).toBe(0)
  })

  it('a breakpoint just after a library call stops right after the library step', () => {
    const emu = boot(HELLO)
    emu.setBreakpoints([instr(emu, 4).line])
    expect(emu.run()).toMatchObject({ reason: 'breakpoint', stepsRun: 5 })
    expect(snap(emu).output).toBe('Hi\n')
  })
})

describe('10e. More library edges', () => {
  it('scanf skips newlines and spaces before a number, and accepts a + sign', () => {
    const emu = boot(scanfProgram('%d'), { stdin: '\n\n   +5\n' })
    stepToLibrary(emu)
    emu.step()
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(5n, 4))
    expect(reg(emu, 'rax')).toBe(1n)
  })

  it('scanf with a bad second number: the first is stored, eax = 1, and a warning', () => {
    const emu = boot(scanfProgram('%d %d', ['lea rsi, -8[rbp]', 'lea rdx, -4[rbp]']), {
      stdin: '3 x\n',
    })
    stepToLibrary(emu)
    const r = emu.step()
    expect(r.executed).toBe(true)
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(3n, 4))
    expect(emu.readMemory(LOCAL_4, 4)).toEqual([null, null, null, null])
    expect(reg(emu, 'rax')).toBe(1n)
    expect(notesOf(r, 'warning').length).toBeGreaterThan(0)
  })

  it('scanf %lx reads hex into 8 bytes', () => {
    const emu = boot(scanfProgram('%lx'), { stdin: '1122334455667788\n' })
    stepToLibrary(emu)
    emu.step()
    expect(emu.readMemory(LOCAL_8, 8)).toEqual(le(0x1122334455667788n, 8))
  })

  it('stepBack after a printf error goes back inside the library, ready to run', () => {
    const emu = boot(printfProgram('%f', [1n]))
    stepToLibrary(emu)
    const inside = snap(emu)
    expect(emu.step().status).toBe('error')
    expect(emu.stepBack()).toBe(true)
    expectSameState(snap(emu), inside)
  })
})

describe('15b. More explanations', () => {
  it('movsx into a register gives the new value', () => {
    const emu = bootMain(['movsx eax, bl', 'ret'], { initialRegisters: { rbx: 0x80n } })
    expect(mentionsValue(afterText(emu.step()), 0xffffff80n)).toBe(true)
  })

  it('dec says CF is not changed', () => {
    const text = afterText(
      bootMain(['dec ecx', 'ret'], { initialRegisters: { rcx: 0x10n } }).step(),
    )
    expect(mentionsValue(text, 0x10n)).toBe(true)
    expect(mentionsValue(text, 0xfn)).toBe(true)
    expect(text).toContain('CF')
    expect(text).toMatch(/not|unchanged|no change|same|kept|stay/i)
  })

  it('imul gives both inputs, the result and the flags', () => {
    const emu = bootMain(['imul eax, ebx', 'ret'], { initialRegisters: { rax: 6n, rbx: 7n } })
    const text = afterText(emu.step())
    expect(mentionsValue(text, 6n)).toBe(true)
    expect(mentionsValue(text, 7n)).toBe(true)
    expect(mentionsValue(text, 0x2an)).toBe(true)
    for (const flag of ['CF', 'OF']) expect(text).toContain(flag)
  })

  it('push of an immediate gives the sign-extended value', () => {
    const text = afterText(bootMain(['push -2', 'pop rax', 'ret']).step())
    expect(mentionsValue(text, 0xfffffffffffffffen)).toBe(true)
  })

  it('a scanf library step tells the value it read and the value left in eax', () => {
    const emu = boot(scanfProgram('%d'), { stdin: '42\n' })
    stepToLibrary(emu)
    const r = emu.step()
    expect(r.explanation).toMatch(/\b42\b|0x2a\b/)
    expect(r.explanation).toContain('eax')
    expect(mentionsValue(r.explanation, 1n) || /eax[^.]*\b1\b/.test(r.explanation)).toBe(true)
  })
})

describe('1b. More starting-state options', () => {
  it('the stackBase option moves the starting rsp to stackBase - 8', () => {
    const emu = bootMain(['ret'], { stackBase: 0x800000n })
    expect(snap(emu).registers.rsp).toBe(0x7ffff8n)
    expect(emu.readMemory(0x7ffff8n, 8)).toEqual(le(OS_RET, 8))
    emu.step()
    expect(snap(emu).status).toBe('halted')
  })

  it('1- and 2-byte initialMemory cells are loaded little-endian', () => {
    const emu = bootMain(['ret'], {
      initialMemory: [
        { address: 0x7ffffffddfe0n, bytes: 1, value: 0xabn },
        { address: 0x7ffffffddfe2n, bytes: 2, value: 0x1234n },
      ],
    })
    expect(emu.readMemory(0x7ffffffddfe0n, 4)).toEqual([0xab, null, 0x34, 0x12])
  })
})

describe('8b. stepBack while scanf waits', () => {
  it('stepBack while waiting for input undoes the call', () => {
    const emu = boot(scanfProgram('%d'))
    expect(emu.run()).toMatchObject({ reason: 'waiting-input', stepsRun: 7 })
    const call = must(
      emu.program.instructions.find((i) => i.mnemonic === 'call'),
      'call',
    )
    expect(emu.stepBack()).toBe(true)
    const s = snap(emu)
    expect(s.stepCount).toBe(6)
    expect(s.status).toBe('running')
    expect(s.inputRequest).toBeNull()
    expect(s.inLibrary).toBeNull()
    expect(s.rip).toBe(call.address)
  })
})

describe('10g. More library edges', () => {
  const s1 = { label: 's1' }
  const rows: { format: string; args: PrintfArg[]; expected: string }[] = [
    { format: '%x', args: [-1n], expected: 'ffffffff' },
    { format: '%lx', args: [-1n], expected: 'ffffffffffffffff' },
    // Corrected by the emulator owner: real C on Linux (glibc) prints a null pointer as
    // "(nil)", and the emulator follows it (the contract said "0x0").
    { format: '%p', args: [0n], expected: '(nil)' },
    { format: '%-05d|', args: [42n], expected: '42   |' },
    { format: '[%s]', args: [s1], expected: '[abc]' },
  ]
  it.each(rows)('printf $format → $expected', ({ format, args, expected }) => {
    const { emu, r } = runPrintf(format, args)
    expect(r.status).toBe('running')
    expect(r.output).toBe(expected)
    expect(reg(emu, 'rax')).toBe(BigInt(expected.length))
  })

  it('call printf without @PLT works the same', () => {
    const emu = bootMain(['push rbp', 'lea rdi, msg[rip]', 'call printf', 'pop rbp', 'ret'], {}, [
      'msg: .string "ok"',
    ])
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(snap(emu).output).toBe('ok')
  })

  it('call __isoc99_scanf@PLT is scanf', () => {
    const emu = bootMain(
      [
        'push rbp',
        'mov rbp, rsp',
        'sub rsp, 16',
        'lea rsi, -8[rbp]',
        'lea rdi, fmt[rip]',
        'call __isoc99_scanf@PLT',
        'leave',
        'ret',
      ],
      { stdin: '9\n' },
      ['fmt: .string "%d"'],
    )
    stepToLibrary(emu)
    expect(snap(emu).inLibrary?.name).toBe('scanf')
    emu.step()
    expect(emu.readMemory(LOCAL_8, 4)).toEqual(le(9n, 4))
  })

  it('after exit the program is halted and nextLine is null', () => {
    const emu = bootMain(['mov edi, 0', 'call exit'])
    runToEnd(emu)
    expect(snap(emu).status).toBe('halted')
    expect(snap(emu).nextLine).toBeNull()
  })
})

describe('13b. Stack view coverage for far writes', () => {
  it('a write far below rsp adds a dead box there, with no gaps', () => {
    const emu = bootMain(['mov qword ptr [rsp-64], 1', 'ret'])
    emu.step()
    const s = snap(emu)
    expectContiguous(s)
    const b = box(s, START_RSP - 64n)
    expect(b.value).toBe(1n)
    expect(b.kind).toBe('value')
    expect(b.dead).toBe(true)
  })

  it('a write above the starting rsp adds that box at the top of the view', () => {
    const emu = bootMain(['mov qword ptr [rsp+16], 1', 'ret'])
    emu.step()
    const s = snap(emu)
    expectContiguous(s)
    expect(s.stack[0]?.address).toBe(START_RSP + 16n)
    expect(box(s, START_RSP + 16n).value).toBe(1n)
    expect(box(s, START_RSP + 8n).kind).toBe('empty')
  })

  it('pop of a box nobody wrote warns (never written)', () => {
    const emu = bootMain(['sub rsp, 8', 'pop rax', 'ret'])
    emu.step()
    const warnings = notesOf(emu.step(), 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.text ?? '').toMatch(/never|junk/i)
  })
})
