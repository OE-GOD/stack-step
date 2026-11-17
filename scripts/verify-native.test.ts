/**
 * Tests for the pure parts of `npm run verify:native`: reading debugger output, the
 * comparison rules, the rewrite for macOS, the built-in tracer's file format.
 *
 * None of this needs a compiler or a debugger. The gdb and lldb text below is written
 * in the exact format those tools print (gdb: `info registers`, lldb: `register read`).
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OPTIONS,
  REG64_NAMES,
  type EmulatorApi,
  type Flags,
  type Instruction,
  type MachineState,
  type Reg64,
  type RegisterFile,
  type StepResult,
} from '../src/emulator/types'
import { EXAMPLES, exampleById } from '../src/examples/index'
import { compareRuns } from './lib/native/compare'
import {
  gdbCommands,
  lldbCommands,
  parseGdbRegisterLine,
  parseGdbTrace,
  parseLldbRegisterLine,
  parseLldbTrace,
  parseNm,
} from './lib/native/debuggers'
import {
  FULL_MASK,
  runInEmulator,
  writtenMask,
  type CreateEmulator,
  type EmulatorLayout,
  type EmulatorPoint,
} from './lib/native/emulator'
import { rewriteForMacOS, withTextMarkers } from './lib/native/macos-source'
import { differenceLines, programLine, summaryLines, type ProgramReport } from './lib/native/report'
import { flagsFromRflags, type NativeState } from './lib/native/state'
import { parseTracerOutput, tracerStates } from './lib/native/tracer'
import { fuzzProgramSource, parseOptions } from './lib/native/verify'
import { descendantsFromListing } from './lib/proc'

/* ───────────────────────────── canned gdb output ───────────────────────────── */

/** One `info registers …` block exactly as gdb prints it. */
function gdbBlock(
  values: Partial<Record<Reg64, bigint>>,
  rip: bigint,
  where: string,
  eflags: bigint,
): string {
  const lines: string[] = []
  const row = (name: string, value: bigint, natural: string): void => {
    lines.push(`${name.padEnd(15)}${`0x${value.toString(16)}`.padEnd(19)}${natural}`)
  }
  for (const name of REG64_NAMES) {
    const value = values[name] ?? 0n
    // gdb shows rsp and rbp as pointers, the others as decimal numbers.
    row(
      name,
      value,
      name === 'rsp' || name === 'rbp' ? `0x${value.toString(16)}` : value.toString(),
    )
  }
  row('rip', rip, `0x${rip.toString(16)} <${where}>`)
  row('eflags', eflags, eflags === 0x246n ? '[ PF ZF IF ]' : '[ IF ]')
  return lines.join('\n')
}

const GDB_START: Partial<Record<Reg64, bigint>> = {
  rax: 0x555555555129n,
  rcx: 0x555555557df8n,
  rdx: 0x7fffffffe0b8n,
  rsp: 0x7fffffffdf98n,
  rbp: 0x1n,
  rsi: 0x7fffffffe0a8n,
  rdi: 0x1n,
  r12: 0x7fffffffe0a8n,
}

/** A whole gdb session for: push rbp / mov rbp, rsp / mov eax, 7 (three steps). */
const GDB_SESSION = [
  'Breakpoint 1 at 0x1129',
  '[Thread debugging using libthread_db enabled]',
  'Using host libthread_db library "/lib/x86_64-linux-gnu/libthread_db.so.1".',
  '',
  'Breakpoint 1, 0x0000555555555129 in main ()',
  '@@STATE 0',
  gdbBlock(GDB_START, 0x555555555129n, 'main', 0x246n),
  '0x000055555555512a in main ()',
  '@@STATE 1',
  gdbBlock({ ...GDB_START, rsp: 0x7fffffffdf90n }, 0x55555555512an, 'main+1', 0x246n),
  '0x000055555555512d in main ()',
  '@@STATE 2',
  gdbBlock(
    { ...GDB_START, rsp: 0x7fffffffdf90n, rbp: 0x7fffffffdf90n },
    0x55555555512dn,
    'main+4',
    0x246n,
  ),
  '0x0000555555555132 in main ()',
  '@@STATE 3',
  gdbBlock(
    { ...GDB_START, rax: 7n, rsp: 0x7fffffffdf90n, rbp: 0x7fffffffdf90n },
    0x555555555132n,
    'main+9',
    0x246n,
  ),
  '',
].join('\n')

describe('gdb: the command file', () => {
  const text = gdbCommands(['into', 'over', 'into'], {
    stdin: "/tmp/it's here/stdin.txt",
    stdout: '/tmp/out.txt',
  })
  const lines = text.split('\n')

  it('stops at the very first instruction of main and feeds the input file', () => {
    expect(lines).toContain('break *main')
    expect(lines).toContain(`run < '/tmp/it'\\''s here/stdin.txt' > '/tmp/out.txt'`)
  })

  it('steps into ordinary instructions and over library calls', () => {
    expect(lines.filter((line) => line === 'stepi' || line === 'nexti')).toEqual([
      'stepi',
      'nexti',
      'stepi',
    ])
  })

  it('prints a mark and all registers before the first step and after every step', () => {
    expect(lines.filter((line) => line.startsWith('echo @@STATE'))).toEqual([
      'echo @@STATE 0\\n',
      'echo @@STATE 1\\n',
      'echo @@STATE 2\\n',
      'echo @@STATE 3\\n',
    ])
    const dumps = lines.filter((line) => line.startsWith('info registers '))
    expect(dumps).toHaveLength(4)
    expect(dumps[0]).toBe(
      'info registers rax rcx rdx rbx rsp rbp rsi rdi r8 r9 r10 r11 r12 r13 r14 r15 rip eflags',
    )
  })
})

describe('gdb: reading `info registers`', () => {
  it('reads a general register line', () => {
    expect(parseGdbRegisterLine('rax            0x555555555129      93824992235817')).toEqual({
      name: 'rax',
      value: 0x555555555129n,
      rest: '93824992235817',
    })
  })

  it('reads rip with its symbol and eflags with its flag names', () => {
    expect(
      parseGdbRegisterLine('rip            0x55555555512d      0x55555555512d <main+4>'),
    ).toEqual({ name: 'rip', value: 0x55555555512dn, rest: '0x55555555512d <main+4>' })
    expect(parseGdbRegisterLine('eflags         0x246               [ PF ZF IF ]')?.value).toBe(
      0x246n,
    )
  })

  it('ignores everything that is not a register line', () => {
    for (const line of [
      'Breakpoint 1, 0x0000555555555129 in main ()',
      '0x000055555555512a in main ()',
      '@@STATE 3',
      '[Inferior 1 (process 4242) exited normally]',
      '',
    ]) {
      expect(parseGdbRegisterLine(line), line).toBeNull()
    }
  })
})

describe('gdb: reading a whole session', () => {
  const trace = parseGdbTrace(GDB_SESSION, 3)

  it('finds one state per mark, in order', () => {
    expect(trace.problem).toBeNull()
    expect(trace.states).toHaveLength(4)
    expect(trace.states.map((state) => state.rip)).toEqual([
      0x555555555129n,
      0x55555555512an,
      0x55555555512dn,
      0x555555555132n,
    ])
  })

  it('reads every register, the flags and where rip is', () => {
    const [start, afterPush, , afterMov] = trace.states
    expect(start?.registers.rsp).toBe(0x7fffffffdf98n)
    expect(start?.registers.rdi).toBe(1n)
    expect(start?.location).toEqual({ symbol: 'main', offset: 0 })
    expect(afterPush?.registers.rsp).toBe(0x7fffffffdf90n)
    expect(afterPush?.location).toEqual({ symbol: 'main', offset: 1 })
    expect(afterMov?.registers.rax).toBe(7n)
    // 0x246 = IF + ZF + PF + the always-set bit 1.
    expect(start?.flags).toEqual({ CF: 0, ZF: 1, SF: 0, OF: 0 })
  })

  it('says so when the program ended before all planned steps', () => {
    const shorter = parseGdbTrace(GDB_SESSION, 5)
    expect(shorter.states).toHaveLength(4)
    expect(shorter.problem).toContain('3 of 5 steps')
  })

  it('stops at a state that is cut off', () => {
    const cut = GDB_SESSION.split('\n').slice(0, -6).join('\n')
    expect(parseGdbTrace(cut, 3).states).toHaveLength(3)
  })

  it('reports a breakpoint that was not reached', () => {
    const failed = [
      'Breakpoint 1 at 0x1129',
      'warning: Error disabling address space randomization: Operation not permitted',
      'Cannot insert breakpoint 1.',
      'Cannot access memory at address 0x1129',
      '',
    ].join('\n')
    const trace_ = parseGdbTrace(failed, 3)
    expect(trace_.states).toHaveLength(0)
    expect(trace_.problem).toContain('gdb did not stop at main')
    expect(trace_.problem).toContain('Cannot access memory at address 0x1129')
  })

  it('refuses a trace that starts after the first instruction of main', () => {
    const late = GDB_SESSION.replace('<main>', '<main+4>')
    const trace_ = parseGdbTrace(late, 3)
    expect(trace_.states).toHaveLength(0)
    expect(trace_.problem).toContain('main+4')
  })
})

/* ───────────────────────────── canned lldb output ───────────────────────────── */

/**
 * A real lldb session, copied from this project's own run on an Apple Silicon Mac
 * (lldb-2100, the hello-world example through Rosetta 2): the stop at main and the
 * first two steps, `push rbp` and `mov rbp, rsp`. Only the folder name was shortened.
 */
const LLDB_SESSION = [
  '(lldb) target create "hello-world"',
  "Current executable set to '/tmp/build/hello-world/hello-world' (x86_64).",
  "(lldb) command source -s 0 'commands.lldb'",
  "Executing commands in '/tmp/build/hello-world/commands.lldb'.",
  '(lldb) settings set auto-confirm true',
  '(lldb) settings set stop-disassembly-display never',
  '(lldb) breakpoint set --name main --skip-prologue false',
  'Breakpoint 1: where = hello-world`main, address = 0x00000001000003de',
  '(lldb) process launch --stdin "/tmp/build/hello-world/stdin.txt" --stdout "/tmp/build/hello-world/lldb-stdout.txt"',
  "warning: libobjc.A.dylib is being read from process memory. This indicates that LLDB could not read from the host's in-memory shared cache. This will likely reduce debugging performance.",
  '',
  "Process 2533 launched: '/tmp/build/hello-world/hello-world' (x86_64)",
  'Process 2533 stopped',
  "* thread #1, queue = 'com.apple.main-thread', stop reason = breakpoint 1.1",
  '    frame #0: 0x00000001000003de hello-world`main',
  'Target 0: (hello-world) stopped.',
  '(lldb) register read rax rcx rdx rbx rsp rbp rsi rdi r8 r9 r10 r11 r12 r13 r14 r15 rip rflags',
  '     rax = 0x00000002000b9b00  dyld`lsl::sPoolBytes + 2672',
  '     rcx = 0x000000030413e1f8',
  '     rdx = 0x000000030413e000',
  '     rbx = 0x00000002000dbd88  dyld`lsl::sMemoryManagerBuffer',
  '     rsp = 0x000000030413d948',
  '     rbp = 0x000000030413dfd0',
  '     rsi = 0x000000030413dff0',
  '     rdi = 0x0000000000000001',
  '      r8 = 0x0000000000000702',
  '      r9 = 0x0000000108642000',
  '     r10 = 0x0000000000000000',
  '     r11 = 0x00000002000bb2a0  dyld`lsl::sPoolBytes + 8720',
  '     r12 = 0x000000030413ded8',
  '     r13 = 0x000000030413dfe0',
  '     r14 = 0x000000030413dd80',
  '     r15 = 0x000000030413de90',
  '     rip = 0x00000001000003de  hello-world`main',
  '  rflags = 0x0000000000000202',
  '(lldb) thread step-inst',
  'Process 2533 stopped',
  "* thread #1, queue = 'com.apple.main-thread', stop reason = instruction step into",
  '    frame #0: 0x00000001000003df hello-world`main + 1',
  'Target 0: (hello-world) stopped.',
  '(lldb) register read rax rcx rdx rbx rsp rbp rsi rdi r8 r9 r10 r11 r12 r13 r14 r15 rip rflags',
  '     rax = 0x00000002000b9b00  dyld`lsl::sPoolBytes + 2672',
  '     rcx = 0x000000030413e1f8',
  '     rdx = 0x000000030413e000',
  '     rbx = 0x00000002000dbd88  dyld`lsl::sMemoryManagerBuffer',
  '     rsp = 0x000000030413d940',
  '     rbp = 0x000000030413dfd0',
  '     rsi = 0x000000030413dff0',
  '     rdi = 0x0000000000000001',
  '      r8 = 0x0000000000000702',
  '      r9 = 0x0000000108642000',
  '     r10 = 0x0000000000000000',
  '     r11 = 0x00000002000bb2a0  dyld`lsl::sPoolBytes + 8720',
  '     r12 = 0x000000030413ded8',
  '     r13 = 0x000000030413dfe0',
  '     r14 = 0x000000030413dd80',
  '     r15 = 0x000000030413de90',
  '     rip = 0x00000001000003df  hello-world`main + 1',
  '  rflags = 0x0000000000000202',
  '(lldb) thread step-inst',
  'Process 2533 stopped',
  "* thread #1, queue = 'com.apple.main-thread', stop reason = instruction step into",
  '    frame #0: 0x00000001000003e2 hello-world`main + 4',
  'Target 0: (hello-world) stopped.',
  '(lldb) register read rax rcx rdx rbx rsp rbp rsi rdi r8 r9 r10 r11 r12 r13 r14 r15 rip rflags',
  '     rax = 0x00000002000b9b00  dyld`lsl::sPoolBytes + 2672',
  '     rcx = 0x000000030413e1f8',
  '     rdx = 0x000000030413e000',
  '     rbx = 0x00000002000dbd88  dyld`lsl::sMemoryManagerBuffer',
  '     rsp = 0x000000030413d940',
  '     rbp = 0x000000030413d940',
  '     rsi = 0x000000030413dff0',
  '     rdi = 0x0000000000000001',
  '      r8 = 0x0000000000000702',
  '      r9 = 0x0000000108642000',
  '     r10 = 0x0000000000000000',
  '     r11 = 0x00000002000bb2a0  dyld`lsl::sPoolBytes + 8720',
  '     r12 = 0x000000030413ded8',
  '     r13 = 0x000000030413dfe0',
  '     r14 = 0x000000030413dd80',
  '     r15 = 0x000000030413de90',
  '     rip = 0x00000001000003e2  hello-world`main + 4',
  '  rflags = 0x0000000000000202',
  '(lldb) process kill',
  'Process 2533 exited with status = 9 (0x00000009) killed',
  '',
].join('\n')

describe('lldb: the command file', () => {
  const lines = lldbCommands(['into', 'over'], {
    stdin: '/tmp/x/stdin.txt',
    stdout: '/tmp/x/out.txt',
  }).split('\n')

  it('stops at the first instruction of main, without skipping the prologue', () => {
    expect(lines).toContain('breakpoint set --name main --skip-prologue false')
    expect(lines).toContain('process launch --stdin "/tmp/x/stdin.txt" --stdout "/tmp/x/out.txt"')
  })

  it('steps into ordinary instructions and over library calls', () => {
    expect(lines.filter((line) => line.startsWith('thread '))).toEqual([
      'thread step-inst',
      'thread step-inst-over',
    ])
    expect(lines.filter((line) => line.startsWith('register read '))).toHaveLength(3)
  })
})

describe('lldb: reading `register read`', () => {
  it('reads a register line with and without a symbol after it', () => {
    expect(parseLldbRegisterLine('     rbx = 0x0000000000000000')).toEqual({
      name: 'rbx',
      value: 0n,
      rest: '',
    })
    expect(parseLldbRegisterLine('     rip = 0x00000001000003e2  hello-world`main + 4')).toEqual({
      name: 'rip',
      value: 0x1000003e2n,
      rest: 'hello-world`main + 4',
    })
    expect(parseLldbRegisterLine('  rflags = 0x0000000000000246')?.name).toBe('rflags')
  })

  it('ignores prompts, stop reports and disassembly', () => {
    for (const line of [
      '(lldb) thread step-inst',
      'Process 4242 stopped',
      '    frame #0: 0x00000001000003df hello-world`main + 1',
      '->  0x1000003df <+1>: movq   %rsp, %rbp',
    ]) {
      expect(parseLldbRegisterLine(line), line).toBeNull()
    }
  })
})

describe('lldb: reading a whole session', () => {
  const trace = parseLldbTrace(LLDB_SESSION, 2)

  it('finds one state per register dump', () => {
    expect(trace.problem).toBeNull()
    expect(trace.states.map((state) => state.rip)).toEqual([
      0x1000003den,
      0x1000003dfn,
      0x1000003e2n,
    ])
    expect(trace.states[0]?.location).toEqual({ symbol: 'main', offset: 0 })
    expect(trace.states[2]?.location).toEqual({ symbol: 'main', offset: 4 })
  })

  it('reads the registers and the flags', () => {
    // push rbp moved rsp down by 8; mov rbp, rsp copied it.
    expect(trace.states[0]?.registers.rsp).toBe(0x30413d948n)
    expect(trace.states[1]?.registers.rsp).toBe(0x30413d940n)
    expect(trace.states[2]?.registers.rbp).toBe(0x30413d940n)
    // A value with a symbol after it, and one without.
    expect(trace.states[0]?.registers.rax).toBe(0x2000b9b00n)
    expect(trace.states[0]?.registers.r8).toBe(0x702n)
    // 0x202 = IF + the always-set bit 1: none of the four flags.
    expect(trace.states[2]?.flags).toEqual({ CF: 0, ZF: 0, SF: 0, OF: 0 })
  })

  it('says so when lldb gave fewer steps than planned', () => {
    const shorter = parseLldbTrace(LLDB_SESSION, 9)
    expect(shorter.states).toHaveLength(3)
    expect(shorter.problem).toContain('2 of 9 steps')
  })

  it('reports a launch that never stopped at main', () => {
    // Everything up to `process launch`: what lldb prints while macOS waits for a password.
    const waiting = LLDB_SESSION.split('\n').slice(0, 9).join('\n')
    const trace_ = parseLldbTrace(waiting, 2)
    expect(trace_.states).toHaveLength(0)
    expect(trace_.problem).toContain('lldb did not stop at main')
  })

  it('refuses a trace that starts after the prologue', () => {
    const late = LLDB_SESSION.replace(
      'hello-world`main\n  rflags',
      'hello-world`main + 4\n  rflags',
    )
    expect(late).not.toBe(LLDB_SESSION)
    expect(parseLldbTrace(late, 2).problem).toContain('main + 4')
  })
})

describe('nm: label addresses', () => {
  it('reads macOS and Linux listings, without undefined names and constants', () => {
    const listing = [
      '                 U _printf',
      '0000000000000005 a HOW_MANY',
      '0000000100000000 T __mh_execute_header',
      '0000000100000468 t report',
      '0000000100000484 T _main',
      '0000000100002000 d numbers',
      '0000000000401126 T main',
      '',
    ].join('\n')
    const symbols = parseNm(listing)
    expect(symbols.get('_main')).toBe(0x100000484n)
    expect(symbols.get('report')).toBe(0x100000468n)
    expect(symbols.get('numbers')).toBe(0x100002000n)
    expect(symbols.get('main')).toBe(0x401126n)
    expect(symbols.has('_printf')).toBe(false)
    expect(symbols.has('HOW_MANY')).toBe(false)
  })
})

/* ─────────────────────────── the built-in tracer ─────────────────────────── */

function tracerLine(
  from: bigint,
  rip: bigint,
  rflags: bigint,
  registers: Partial<Record<Reg64, bigint>>,
): string {
  const columns = REG64_NAMES.map((name) => (registers[name] ?? 0n).toString(16))
  return ['step', from.toString(16), rip.toString(16), rflags.toString(16), ...columns].join(' ')
}

/** main = 0x1000, program text 0x0f00–0x1100; the driver and the library are elsewhere. */
function tracerFile(steps: string[], returned: boolean): string {
  return [
    'main 1000',
    'text f00 1100',
    'traps 9000',
    `returned ${returned ? 1 : 0}`,
    'overflowed 0',
    ...steps,
    'end',
    '',
  ].join('\n')
}

describe('built-in tracer: reading the trace file', () => {
  const steps = [
    tracerLine(0n, 0x1000n, 0x302n, { rsp: 0x7000n }), // start of main
    tracerLine(0x1000n, 0x1001n, 0x302n, { rsp: 0x6ff8n }), // push rbp
    tracerLine(0x1001n, 0x9000n, 0x302n, { rsp: 0x6ff0n }), // call printf: now in the library
    tracerLine(0x9abcn, 0x1006n, 0x393n, { rsp: 0x6ff8n, rax: 13n }), // back from printf
    tracerLine(0x1006n, 0x1007n, 0x393n, { rsp: 0x7000n, rax: 13n }), // pop rbp
    tracerLine(0x1007n, 0x8000n, 0x393n, { rsp: 0x7008n, rax: 13n }), // ret, back in the driver
  ]

  it('reads the header and every step', () => {
    const output = parseTracerOutput(tracerFile(steps, true))
    expect(output).not.toBeNull()
    expect(output?.main).toBe(0x1000n)
    expect(output?.textStart).toBe(0xf00n)
    expect(output?.textEnd).toBe(0x1100n)
    expect(output?.traps).toBe(9000)
    expect(output?.returned).toBe(true)
    expect(output?.entries).toHaveLength(6)
    expect(output?.entries[3]?.state.registers.rax).toBe(13n)
    // 0x393 = TF + IF + SF + AF + CF + bit 1.
    expect(output?.entries[3]?.state.flags).toEqual({ CF: 1, ZF: 0, SF: 1, OF: 0 })
  })

  it('keeps the states that line up with emulator steps', () => {
    const output = parseTracerOutput(tracerFile(steps, true))
    if (output === null) throw new Error('trace did not parse')
    // The state inside the library is dropped; the one after main's ret is kept.
    expect(tracerStates(output).map((state) => state.rip)).toEqual([
      0x1000n,
      0x1001n,
      0x1006n,
      0x1007n,
      0x8000n,
    ])
  })

  it('drops the last state when the program ended inside exit()', () => {
    const output = parseTracerOutput(tracerFile(steps.slice(0, 3), false))
    if (output === null) throw new Error('trace did not parse')
    expect(tracerStates(output).map((state) => state.rip)).toEqual([0x1000n, 0x1001n])
  })

  it('rejects a file that was not written to the end', () => {
    const whole = tracerFile(steps, true)
    expect(parseTracerOutput(whole.replace('end\n', ''))).toBeNull()
    expect(parseTracerOutput('')).toBeNull()
    expect(parseTracerOutput(whole.replace('step 0 1000 302', 'step 0 1000'))).toBeNull()
  })
})

describe('flags register', () => {
  it('takes CF, ZF, SF and OF from bits 0, 6, 7 and 11', () => {
    expect(flagsFromRflags(0x0n)).toEqual({ CF: 0, ZF: 0, SF: 0, OF: 0 })
    expect(flagsFromRflags(0x1n)).toEqual({ CF: 1, ZF: 0, SF: 0, OF: 0 })
    expect(flagsFromRflags(0x40n)).toEqual({ CF: 0, ZF: 1, SF: 0, OF: 0 })
    expect(flagsFromRflags(0x80n)).toEqual({ CF: 0, ZF: 0, SF: 1, OF: 0 })
    expect(flagsFromRflags(0x800n)).toEqual({ CF: 0, ZF: 0, SF: 0, OF: 1 })
    expect(flagsFromRflags(0xa97n)).toEqual({ CF: 1, ZF: 0, SF: 1, OF: 1 })
  })
})

/* ─────────────────────────── rewriting for macOS ─────────────────────────── */

function macLines(id: string): string[] {
  const example = exampleById(id)
  if (!example) throw new Error(`no example ${id}`)
  return rewriteForMacOS(example.source, '_main').source.split('\n')
}

describe('rewriting a program for macOS', () => {
  it('renames main, library calls and drops .type in every example', () => {
    for (const example of EXAMPLES) {
      const mac = rewriteForMacOS(example.source, '_main')
      const code = mac.source
        .split('\n')
        .map((line) => line.replace(/#.*$/, ''))
        .join('\n')
      expect(code, example.id).toContain('_main:')
      expect(code, example.id).toMatch(/\.globl _main\b/)
      expect(code, example.id).not.toMatch(/@PLT/i)
      expect(code, example.id).not.toContain('.type')
      expect(code, example.id).not.toMatch(/\bcall\s+(printf|scanf)\b/)
      expect(mac.labels.get('main')).toBe('_main')
    }
  })

  it('keeps comments and strings exactly as they were', () => {
    const lines = macLines('nested-call')
    expect(lines).toContain('    ret  # go back to main')
    expect(lines).toContain('    .string "Double of %d is %d.\\n"')
    expect(macLines('hello-world')).toContain('# Hello World: print one line of text.')
  })

  it('turns labels that are only jumped to into assembler-local labels', () => {
    const lines = macLines('sum-loop')
    expect(lines).toContain('Lss_loop_start:')
    expect(lines).toContain('Lss_loop_end:')
    expect(lines).toContain('    jg Lss_loop_end  # bigger than high? then stop')
    expect(lines).toContain('    jmp Lss_loop_start')
    const mac = rewriteForMacOS(exampleById('array-max')?.source ?? '', '_main')
    expect([...mac.localLabels].sort()).toEqual(['loop_end', 'loop_start', 'not_bigger'])
  })

  it('keeps labels that are called or used as data', () => {
    const example = exampleById('nested-call')
    const mac = rewriteForMacOS(example?.source ?? '', '_main')
    expect(mac.labels.get('show_double')).toBe('show_double')
    expect(mac.labels.get('report')).toBe('report')
    expect(mac.source).toContain('    call show_double')
    expect(mac.source).toContain('    call _printf')
    expect(mac.source).toContain('    lea rdi, report[rip]')
    expect(mac.localLabels.size).toBe(0)
  })

  it('handles the forms the examples do not use', () => {
    const source = [
      '    .intel_syntax noprefix',
      '    .section .rodata',
      'list: .quad 1, 2      # a label that starts with l',
      'text: .string "main # not a comment", "call printf@PLT"',
      '    .text',
      '    .globl main',
      '    .type main, @function',
      'main:',
      '    .cfi_startproc',
      '    lea rdi, list[rip]',
      '    movsx rax, eax',
      '    movsx rdx, dword ptr [rdi]',
      '    movsx ecx, byte ptr [rdi]',
      '    test rax, rax',
      '    je test',
      '    call __isoc99_scanf@PLT',
      'test:',
      '    mov edi, 0',
      '    call exit',
      '    .size main, .-main',
      '    .section .note.GNU-stack,"",@progbits',
    ].join('\n')
    const mac = rewriteForMacOS(source, '_main')
    const lines = mac.source.split('\n')
    expect(lines).toContain('    .section __TEXT,__const')
    expect(lines).toContain('ss_list: .quad 1, 2  # a label that starts with l')
    expect(lines).toContain('text: .string "main # not a comment", "call printf@PLT"')
    expect(lines).toContain('    lea rdi, ss_list[rip]')
    expect(lines).toContain('    movsxd rax, eax')
    expect(lines).toContain('    movsxd rdx, dword ptr [rdi]')
    expect(lines).toContain('    movsx ecx, byte ptr [rdi]')
    // `test` the instruction stays; `test` the label becomes a local label.
    expect(lines).toContain('    test rax, rax')
    expect(lines).toContain('    je Lss_test')
    expect(lines).toContain('Lss_test:')
    expect(lines).toContain('    call _scanf')
    expect(lines).toContain('    call _exit')
    expect(mac.source).not.toMatch(/\.(type|size|cfi_startproc|note)/)
  })

  it('can give main another name and bracket the code for the tracer', () => {
    const mac = rewriteForMacOS(exampleById('push-pop')?.source ?? '', '_ss_program_main')
    expect(mac.source).toContain('_ss_program_main:')
    expect(mac.source).toContain('.globl _ss_program_main')
    const marked = withTextMarkers(mac.source, '_ss_text_start', '_ss_text_end').split('\n')
    expect(marked.slice(0, 3)).toEqual([
      '    .text',
      '    .globl _ss_text_start',
      '_ss_text_start:',
    ])
    expect(marked.slice(-4)).toEqual(['    .text', '    .globl _ss_text_end', '_ss_text_end:', ''])
  })
})

/* ───────────────────────────── comparison rules ───────────────────────────── */

const EMU_RSP = 0x7ffffffddff8n
const REAL_RSP = 0x7ff7bfeff5a8n
const EMU_MAIN = 0x401126n
const REAL_MAIN = 0x1000003den
const EMU_MESSAGE = 0x402010n
const REAL_MESSAGE = 0x1000003d0n

const LAYOUT: EmulatorLayout = {
  main: EMU_MAIN,
  regions: [
    { name: 'code', low: 0x401126n, high: 0x401200n },
    { name: 'read-only data', low: 0x402010n, high: 0x402040n },
    { name: 'data', low: 0x404030n, high: 0x404030n },
  ],
  stack: { low: EMU_RSP - 0x100000n, high: EMU_RSP + 0x10000n },
  symbols: [
    { name: 'main', address: EMU_MAIN },
    { name: 'message', address: EMU_MESSAGE },
  ],
}

function registerFile(values: Partial<Record<Reg64, bigint>>): RegisterFile {
  const file = {} as RegisterFile
  for (const name of REG64_NAMES) file[name] = values[name] ?? 0n
  return file
}

const NO_FLAGS: Flags = { CF: 0, ZF: 0, SF: 0, OF: 0 }

/** A point of the emulator's run: only what differs from "nothing happened" is given. */
type PointPart = Omit<Partial<EmulatorPoint>, 'registers' | 'rip'> & {
  /** Registers that are not 0 (rsp is at its starting value unless given). */
  registers: Partial<Record<Reg64, bigint>>
  /** Where rip is, as a distance from main. */
  offset: bigint
}

function point(part: PointPart): EmulatorPoint {
  const { registers, offset, ...rest } = part
  return {
    nativeStep: 'into',
    line: 1,
    text: 'nop',
    mnemonic: 'nop',
    library: null,
    flags: NO_FLAGS,
    status: 'running',
    written: [],
    writtenFlags: [],
    ...rest,
    registers: registerFile({ rsp: EMU_RSP, ...registers }),
    rip: EMU_MAIN + offset,
  }
}

function real(
  values: Partial<Record<Reg64, bigint>>,
  offset: bigint,
  flags: Flags = NO_FLAGS,
): NativeState {
  return {
    registers: registerFile({ rsp: REAL_RSP, ...values }),
    rip: REAL_MAIN + offset,
    flags,
    location: null,
  }
}

/** What the real machine has in its registers when main starts: not zeros. */
const INHERITED: Partial<Record<Reg64, bigint>> = {
  rax: REAL_MAIN,
  rbx: 0x7ff7bfeff6d8n,
  rbp: 0x7ff7bfeff5b0n,
  rdi: 1n,
  rsi: 0x7ff7bfeff6c8n,
  r12: 0x1234n,
}

const START = point({
  nativeStep: 'start',
  registers: {},
  offset: 0n,
  line: 0,
  text: '',
  mnemonic: null,
})
const REAL_START = real(INHERITED, 0n)

function compare(points: EmulatorPoint[], native: NativeState[], ignoreSfAfterImul = false) {
  return compareRuns({
    points: [START, ...points],
    native: [REAL_START, ...native],
    layout: LAYOUT,
    nativeSymbol: (label) =>
      label === 'message' ? REAL_MESSAGE : label === 'main' ? REAL_MAIN : null,
    ignoreSfAfterImul,
  })
}

describe('comparison: registers', () => {
  it('accepts registers that still hold what they had when main started', () => {
    const result = compare([], [])
    expect(result).toEqual({ stepsCompared: 1, differences: [], lengthProblem: null })
  })

  it('accepts equal numbers and reports different ones', () => {
    const step = point({
      registers: { rcx: 5n },
      offset: 5n,
      line: 9,
      text: 'mov ecx, 5',
      mnemonic: 'mov',
      written: [{ reg: 'rcx', mask: FULL_MASK }],
    })
    expect(compare([step], [real({ ...INHERITED, rcx: 5n }, 5n)]).differences).toEqual([])

    const wrong = compare([step], [real({ ...INHERITED, rcx: 6n }, 5n)])
    expect(wrong.stepsCompared).toBe(2)
    expect(wrong.differences).toEqual([
      {
        step: 1,
        line: 9,
        text: 'mov ecx, 5',
        what: 'rcx',
        emulator: '0x0000000000000005',
        native: '0x0000000000000006',
      },
    ])
  })

  it('reports a register the emulator forgot to write', () => {
    // The real program wrote rcx; the emulator still has its starting 0.
    const step = point({ registers: {}, offset: 5n, text: 'mov ecx, 5', mnemonic: 'mov' })
    const result = compare([step], [real({ ...INHERITED, rcx: 5n }, 5n)])
    expect(result.differences.map((item) => item.what)).toEqual(['rcx'])
  })

  it('compares rsp as a distance from where it started', () => {
    const push = point({ registers: { rsp: EMU_RSP - 8n }, offset: 1n, text: 'push rbp' })
    expect(compare([push], [real({ ...INHERITED, rsp: REAL_RSP - 8n }, 1n)]).differences).toEqual(
      [],
    )
    const wrong = compare([push], [real({ ...INHERITED, rsp: REAL_RSP - 16n }, 1n)])
    expect(wrong.differences).toEqual([
      expect.objectContaining({ what: 'rsp', emulator: 'start-0x8', native: 'start-0x10' }),
    ])
  })

  it('compares rip as a distance from main, which checks instruction sizes', () => {
    const step = point({ registers: {}, offset: 2n, text: 'jg done' })
    expect(compare([step], [real(INHERITED, 2n)]).differences).toEqual([])
    // A jump that the real assembler made 6 bytes long.
    const wrong = compare([step], [real(INHERITED, 6n)])
    expect(wrong.differences).toEqual([
      expect.objectContaining({ what: 'rip', emulator: 'main+0x2', native: 'main+0x6' }),
    ])
  })

  it('accepts a stack address at the same distance from the starting rsp', () => {
    const step = point({
      registers: { rsp: EMU_RSP - 8n, rbp: EMU_RSP - 8n },
      offset: 4n,
      text: 'mov rbp, rsp',
      written: [{ reg: 'rbp', mask: FULL_MASK }],
    })
    const good = real({ ...INHERITED, rsp: REAL_RSP - 8n, rbp: REAL_RSP - 8n }, 4n)
    expect(compare([step], [good]).differences).toEqual([])
    const bad = real({ ...INHERITED, rsp: REAL_RSP - 8n, rbp: REAL_RSP - 16n }, 4n)
    expect(compare([step], [bad]).differences.map((item) => item.what)).toEqual(['rbp'])
  })

  it('accepts a saved register that was put back (pop rbp)', () => {
    const steps = [
      point({ registers: { rsp: EMU_RSP - 8n }, offset: 1n, text: 'push rbp' }),
      point({
        registers: { rsp: EMU_RSP - 8n, rbp: EMU_RSP - 8n },
        offset: 4n,
        text: 'mov rbp, rsp',
        written: [{ reg: 'rbp', mask: FULL_MASK }],
      }),
      point({
        registers: { rbp: 0n },
        offset: 5n,
        text: 'pop rbp',
        written: [
          { reg: 'rbp', mask: FULL_MASK },
          { reg: 'rsp', mask: FULL_MASK },
        ],
      }),
    ]
    const native = [
      real({ ...INHERITED, rsp: REAL_RSP - 8n }, 1n),
      real({ ...INHERITED, rsp: REAL_RSP - 8n, rbp: REAL_RSP - 8n }, 4n),
      real(INHERITED, 5n),
    ]
    expect(compare(steps, native)).toEqual({
      stepsCompared: 4,
      differences: [],
      lengthProblem: null,
    })
    // If the real rbp did not come back to its starting value, that is a difference.
    const broken = [...native.slice(0, 2), real({ ...INHERITED, rbp: 0x999n }, 5n)]
    expect(compare(steps, broken).differences.map((item) => item.what)).toEqual(['rbp'])
  })

  it('accepts the address of a label when the real register points at the same label', () => {
    const step = point({
      registers: { rdi: EMU_MESSAGE + 4n },
      offset: 7n,
      text: 'lea rdi, message+4[rip]',
      written: [{ reg: 'rdi', mask: FULL_MASK }],
    })
    expect(
      compare([step], [real({ ...INHERITED, rdi: REAL_MESSAGE + 4n }, 7n)]).differences,
    ).toEqual([])
    const wrong = compare([step], [real({ ...INHERITED, rdi: REAL_MESSAGE + 5n }, 7n)])
    expect(wrong.differences.map((item) => item.what)).toEqual(['rdi'])
  })

  it('accepts any nearby address when the label is not in the symbol table', () => {
    const step = point({
      registers: { rdi: EMU_MESSAGE },
      offset: 7n,
      written: [{ reg: 'rdi', mask: FULL_MASK }],
    })
    const run = (rdi: bigint) =>
      compareRuns({
        points: [START, step],
        native: [REAL_START, real({ ...INHERITED, rdi }, 7n)],
        layout: LAYOUT,
        nativeSymbol: () => null,
        ignoreSfAfterImul: false,
      })
    expect(run(REAL_MAIN - 0x20n).differences).toEqual([])
    expect(run(5n).differences.map((item) => item.what)).toEqual(['rdi'])
  })
})

describe('comparison: library calls', () => {
  const call = point({
    nativeStep: 'over',
    registers: { rax: 13n, rcx: 0x7ffff7e00111n, rdx: 0x7ffff7e00222n, rdi: 0x7ffff7e00333n },
    offset: 0x13n,
    line: 12,
    text: 'call printf@PLT',
    mnemonic: 'call',
    library: 'printf',
  })
  const realAfterCall = real(
    {
      ...INHERITED,
      rax: 0xdead00000000000dn,
      rcx: 0x1111n,
      rdx: 0x2222n,
      rdi: 0x3333n,
      rsi: 0x4444n,
    },
    0x13n,
    { CF: 1, ZF: 1, SF: 1, OF: 1 },
  )

  it('skips the registers a library function may change, and the flags', () => {
    expect(compare([call], [realAfterCall]).differences).toEqual([])
  })

  it('compares the result in eax (the low 32 bits of rax)', () => {
    const wrong = compare([call], [real({ ...INHERITED, rax: 14n }, 0x13n)])
    expect(wrong.differences).toEqual([
      expect.objectContaining({ what: 'rax (bits 0x00000000ffffffff)', line: 12 }),
    ])
  })

  it('does not compare the result of puts, which differs between systems', () => {
    const puts = { ...call, library: 'puts', text: 'call puts@PLT' }
    expect(compare([puts], [real({ ...INHERITED, rax: 10n }, 0x13n)]).differences).toEqual([])
  })

  it('compares a junk register again once the program writes it', () => {
    const write = point({
      registers: { rax: 13n, rcx: 13n, rdx: 0x7ffff7e00222n, rdi: 0x7ffff7e00333n },
      offset: 0x15n,
      text: 'mov ecx, eax',
      mnemonic: 'mov',
      written: [{ reg: 'rcx', mask: FULL_MASK }],
    })
    const good = real({ ...realAfterCall.registers, rcx: 13n }, 0x15n)
    expect(compare([call, write], [realAfterCall, good]).differences).toEqual([])
    const bad = real({ ...realAfterCall.registers, rcx: 99n }, 0x15n)
    expect(
      compare([call, write], [realAfterCall, bad]).differences.map((item) => item.what),
    ).toEqual(['rcx'])
  })

  it('after a write to cl, compares only the low byte of rcx', () => {
    const write = point({
      registers: { rax: 13n, rcx: 0x7ffff7e00107n, rdx: 0x7ffff7e00222n, rdi: 0x7ffff7e00333n },
      offset: 0x15n,
      text: 'mov cl, 7',
      mnemonic: 'mov',
      written: [{ reg: 'rcx', mask: 0xffn }],
    })
    const good = real({ ...realAfterCall.registers, rcx: 0x1107n }, 0x15n)
    expect(compare([call, write], [realAfterCall, good]).differences).toEqual([])
    const bad = real({ ...realAfterCall.registers, rcx: 0x1108n }, 0x15n)
    expect(compare([call, write], [realAfterCall, bad]).differences).toEqual([
      expect.objectContaining({ what: 'rcx (bits 0x00000000000000ff)' }),
    ])
  })

  it('accepts a real trace that is one step shorter when the program ended in exit()', () => {
    const exit = point({
      nativeStep: 'over',
      registers: {},
      offset: 0x20n,
      text: 'call exit@PLT',
      mnemonic: 'call',
      library: 'exit',
      status: 'halted',
    })
    expect(compare([exit], []).lengthProblem).toBeNull()
    const other = point({ registers: {}, offset: 0x20n })
    expect(compare([other], []).lengthProblem).toContain('the real program ran 0 steps')
  })
})

describe('comparison: flags', () => {
  const cmp = (flags: Flags) =>
    point({
      registers: {},
      offset: 2n,
      line: 4,
      text: 'cmp ecx, edx',
      mnemonic: 'cmp',
      flags,
      writtenFlags: ['CF', 'ZF', 'SF', 'OF'],
    })

  it('does not compare flags the program has not written yet', () => {
    const step = point({ registers: {}, offset: 1n })
    const result = compare([step], [real(INHERITED, 1n, { CF: 1, ZF: 1, SF: 1, OF: 1 })])
    expect(result.differences).toEqual([])
  })

  it('compares all four flags after cmp', () => {
    const flags: Flags = { CF: 1, ZF: 0, SF: 1, OF: 0 }
    expect(compare([cmp(flags)], [real(INHERITED, 2n, flags)]).differences).toEqual([])
    const wrong = compare([cmp(flags)], [real(INHERITED, 2n, { CF: 1, ZF: 0, SF: 0, OF: 1 })])
    expect(wrong.differences.map((item) => `${item.what} ${item.emulator}/${item.native}`)).toEqual(
      ['SF 1/0', 'OF 0/1'],
    )
  })

  it('keeps CF out of the comparison after inc until something writes CF', () => {
    const inc = point({
      registers: {},
      offset: 2n,
      text: 'inc ecx',
      mnemonic: 'inc',
      writtenFlags: ['ZF', 'SF', 'OF'],
    })
    expect(
      compare([inc], [real(INHERITED, 2n, { CF: 1, ZF: 0, SF: 0, OF: 0 })]).differences,
    ).toEqual([])
  })

  it('skips ZF after imul, and SF too when asked (Rosetta)', () => {
    const imul = point({
      registers: {},
      offset: 3n,
      text: 'imul eax, ecx',
      mnemonic: 'imul',
      flags: { CF: 0, ZF: 1, SF: 1, OF: 0 },
      writtenFlags: ['CF', 'ZF', 'SF', 'OF'],
    })
    const rosetta = real(INHERITED, 3n, { CF: 0, ZF: 0, SF: 0, OF: 0 })
    expect(compare([imul], [rosetta]).differences.map((item) => item.what)).toEqual(['SF'])
    expect(compare([imul], [rosetta], true).differences).toEqual([])
    // CF and OF are always compared.
    const overflow = real(INHERITED, 3n, { CF: 1, ZF: 0, SF: 0, OF: 1 })
    expect(compare([imul], [overflow], true).differences.map((item) => item.what)).toEqual([
      'CF',
      'OF',
    ])
  })

  it('forgets the flags after a library call', () => {
    const call = point({
      nativeStep: 'over',
      registers: { rax: 13n },
      offset: 7n,
      library: 'printf',
      mnemonic: 'call',
    })
    const flags: Flags = { CF: 0, ZF: 1, SF: 0, OF: 0 }
    const afterCall = real({ ...INHERITED, rax: 13n }, 7n, { CF: 1, ZF: 0, SF: 1, OF: 1 })
    const result = compare([cmp(flags), call], [real(INHERITED, 2n, flags), afterCall])
    expect(result.differences).toEqual([])
  })
})

describe('comparison: the end of the program', () => {
  it('does not compare rip after main returned, only rsp and the registers', () => {
    const ret = point({
      registers: { rsp: EMU_RSP + 8n },
      offset: 0n,
      text: 'ret',
      mnemonic: 'ret',
      status: 'halted',
    })
    // The emulator's rip is its fake return address; the real one is somewhere in libc.
    ret.rip = 0x7ffff7c29d90n
    const native = real({ ...INHERITED, rsp: REAL_RSP + 8n }, 0x7000n)
    expect(compare([ret], [native])).toEqual({
      stepsCompared: 2,
      differences: [],
      lengthProblem: null,
    })
  })

  it('stops at the first step that differs', () => {
    const steps = [1n, 2n, 3n].map((offset) => point({ registers: {}, offset }))
    const native = [real(INHERITED, 1n), real(INHERITED, 9n), real(INHERITED, 9n)]
    const result = compare(steps, native)
    expect(result.stepsCompared).toBe(3)
    expect(result.differences).toHaveLength(1)
    expect(result.differences[0]?.step).toBe(2)
  })
})

/* ─────────────────────── collecting the emulator's steps ─────────────────────── */

describe('which bits of a register an instruction writes', () => {
  const instruction = (name: string, size: 8 | 16 | 32 | 64, shift: 0 | 8): Instruction =>
    ({
      mnemonic: 'mov',
      operands: [
        {
          kind: 'reg',
          text: name,
          reg: { name, base: 'rcx', size, shift, highByte: shift === 8, needsRex: false },
        },
        { kind: 'imm', value: 1n, symbol: null, text: '1' },
      ],
    }) as unknown as Instruction

  it('follows the x86-64 write rules', () => {
    expect(writtenMask(instruction('cl', 8, 0), 'rcx')).toBe(0xffn)
    expect(writtenMask(instruction('ch', 8, 8), 'rcx')).toBe(0xff00n)
    expect(writtenMask(instruction('cx', 16, 0), 'rcx')).toBe(0xffffn)
    // A 32-bit write clears the top half, so all 64 bits are known afterwards.
    expect(writtenMask(instruction('ecx', 32, 0), 'rcx')).toBe(FULL_MASK)
    expect(writtenMask(instruction('rcx', 64, 0), 'rcx')).toBe(FULL_MASK)
  })

  it('treats registers written implicitly (rsp by push) as fully written', () => {
    expect(writtenMask(instruction('cl', 8, 0), 'rsp')).toBe(FULL_MASK)
    expect(writtenMask(undefined, 'rax')).toBe(FULL_MASK)
  })
})

/**
 * A scripted stand-in for the emulator: `hello`-like program with one library call.
 * It only implements what `runInEmulator` uses.
 */
function scriptedEmulator(script: {
  instructions: { mnemonic: string; target?: string; external?: boolean; text: string }[]
  /** What happens at each step(): which instruction ran, and the status afterwards. */
  steps: {
    kind: 'instruction' | 'library'
    index: number
    status?: string
    executed?: boolean
    rax?: bigint
  }[]
}): CreateEmulator {
  return () => {
    const base = 0x401126n
    const instructions = script.instructions.map((item, index) => ({
      index,
      line: index + 10,
      address: base + BigInt(index),
      size: 1,
      mnemonic: item.mnemonic,
      written: item.mnemonic,
      operands:
        item.target === undefined
          ? []
          : [
              {
                kind: 'target',
                name: item.target,
                address: 0n,
                external: item.external ?? false,
                text: item.target,
              },
            ],
      opSize: null,
      text: item.text,
    }))
    let taken = 0
    let state = {
      status: 'running',
      rip: base,
      registers: registerFile({ rsp: EMU_RSP, rdi: 3n }),
      flags: NO_FLAGS,
      output: '',
      error: null as { message: string } | null,
    }
    const emulator = {
      program: {
        instructions,
        addressToIndex: new Map(instructions.map((item) => [item.address, item.index])),
        layout: {
          textBase: base,
          textEnd: base + BigInt(instructions.length),
          rodataBase: DEFAULT_OPTIONS.rodataBase,
          rodataEnd: DEFAULT_OPTIONS.rodataBase,
          dataBase: DEFAULT_OPTIONS.dataBase,
          dataEnd: DEFAULT_OPTIONS.dataBase,
        },
        symbols: new Map([
          ['main', { name: 'main', address: base, kind: 'code', line: 10 }],
          ['printf', { name: 'printf', address: 0x7ffff7c606f0n, kind: 'external', line: null }],
        ]),
        entry: base,
      },
      getSnapshot: () => state as unknown as MachineState,
      step: () => {
        const next = script.steps[taken]
        if (next === undefined) throw new Error('script ran out')
        taken += 1
        const item = instructions[next.index]
        const executed = next.executed ?? true
        if (executed) {
          const inLibrary = next.kind === 'instruction' && item?.operands[0]?.external === true
          state = {
            ...state,
            status: next.status ?? 'running',
            rip: inLibrary ? 0x7ffff7c606f0n : base + BigInt(next.index + 1),
            registers: registerFile({ ...state.registers, rax: next.rax ?? state.registers.rax }),
            output: next.kind === 'library' ? `${state.output}Hello\n` : state.output,
            error: next.status === 'error' ? { message: 'Line 12: bad memory read.' } : null,
          }
        } else {
          state = { ...state, status: next.status ?? state.status }
        }
        return {
          executed,
          kind: next.kind,
          line: item?.line ?? 0,
          text: item?.text ?? '',
          diff: {
            written: { registers: next.rax === undefined ? [] : ['rax'], flags: [], memory: [] },
          },
        } as unknown as StepResult
      },
    }
    return { ok: true, emulator: emulator as unknown as EmulatorApi, diagnostics: [] }
  }
}

describe('collecting the emulator steps', () => {
  const instructions = [
    { mnemonic: 'mov', text: 'mov eax, 0' },
    { mnemonic: 'call', target: 'printf', external: true, text: 'call printf@PLT' },
    { mnemonic: 'mov', text: 'mov eax, 5' },
    { mnemonic: 'ret', text: 'ret' },
  ]

  it('makes one point per instruction and folds a library call into one point', () => {
    const create = scriptedEmulator({
      instructions,
      steps: [
        { kind: 'instruction', index: 0, rax: 0n },
        { kind: 'instruction', index: 1 },
        { kind: 'library', index: 1, rax: 6n },
        { kind: 'instruction', index: 2, rax: 5n },
        { kind: 'instruction', index: 3, status: 'halted' },
      ],
    })
    const result = runInEmulator(create, 'source', '')
    if (!result.ok) throw new Error(result.reason)
    const { points, output, exitCode, problem, layout } = result.run
    expect(points.map((item) => item.nativeStep)).toEqual(['start', 'into', 'over', 'into', 'into'])
    expect(points.map((item) => item.text)).toEqual([
      '',
      'mov eax, 0',
      'call printf@PLT',
      'mov eax, 5',
      'ret',
    ])
    expect(points[2]?.library).toBe('printf')
    expect(points[2]?.registers.rax).toBe(6n)
    expect(points[3]?.written).toEqual([{ reg: 'rax', mask: FULL_MASK }])
    expect(points[4]?.status).toBe('halted')
    expect(output).toBe('Hello\n')
    expect(exitCode).toBe(5)
    expect(problem).toBeNull()
    expect(layout.main).toBe(0x401126n)
    expect(layout.symbols).toEqual([{ name: 'main', address: 0x401126n }])
    expect(layout.stack.low < EMU_RSP && EMU_RSP < layout.stack.high).toBe(true)
  })

  it('takes the exit code from edi when the program ends in exit()', () => {
    const create = scriptedEmulator({
      instructions: [{ mnemonic: 'call', target: 'exit', external: true, text: 'call exit@PLT' }],
      steps: [
        { kind: 'instruction', index: 0 },
        { kind: 'library', index: 0, status: 'halted' },
      ],
    })
    const result = runInEmulator(create, 'source', '')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.exitCode).toBe(3)
    expect(result.run.points.at(-1)?.library).toBe('exit')
    expect(result.run.problem).toBeNull()
  })

  it('says so when scanf waits for input the example does not give', () => {
    const create = scriptedEmulator({
      instructions: [{ mnemonic: 'call', target: 'scanf', external: true, text: 'call scanf@PLT' }],
      steps: [
        { kind: 'instruction', index: 0 },
        { kind: 'library', index: 0, status: 'waiting-input', executed: false },
      ],
    })
    const result = runInEmulator(create, 'source', '')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.problem).toContain('more input')
    expect(result.run.exitCode).toBeNull()
  })

  it('reports an emulator error with its message', () => {
    const create = scriptedEmulator({
      instructions,
      steps: [{ kind: 'instruction', index: 0, status: 'error' }],
    })
    const result = runInEmulator(create, 'source', '')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.problem).toContain('Line 12: bad memory read.')
  })

  it('survives an emulator that throws, and says so', () => {
    // The script has one step fewer than the program needs: the stand-in throws.
    const create = scriptedEmulator({
      instructions,
      steps: [{ kind: 'instruction', index: 0, rax: 0n }],
    })
    const result = runInEmulator(create, 'source', '')
    if (!result.ok) throw new Error(result.reason)
    expect(result.run.problem).toBe('the emulator threw an exception: script ran out')
    expect(result.run.points).toHaveLength(2)
    expect(result.run.exitCode).toBeNull()
  })

  it('reports a program that does not assemble', () => {
    const create: CreateEmulator = () => ({
      ok: false,
      emulator: null,
      diagnostics: [
        {
          severity: 'error',
          code: 'unknown-instruction',
          line: 3,
          message: 'Line 3: `mvo` is not an instruction.',
        },
      ],
    })
    expect(runInEmulator(create, 'source', '')).toEqual({
      ok: false,
      reason: 'the emulator could not assemble it: Line 3: `mvo` is not an instruction.',
    })
  })
})

/* ─────────────────────────────── the report ─────────────────────────────── */

describe('report', () => {
  const ok: ProgramReport = {
    id: 'hello-world',
    mode: 'trace',
    stepsCompared: 9,
    differences: [],
    problems: [],
    notes: [],
    emulatorCompared: true,
    nativeExitCode: 0,
  }
  const different: ProgramReport = {
    ...ok,
    id: 'factorial',
    stepsCompared: 14,
    differences: [
      {
        step: 13,
        line: 20,
        text: 'imul eax, ecx',
        what: 'rax',
        emulator: '0x0000000000000014',
        native: '0x0000000000000078',
      },
    ],
    problems: ['output: the emulator printed "5! = 20\\n", the real program printed "5! = 120\\n"'],
  }

  it('prints one line per program', () => {
    expect(programLine(ok)).toBe(
      '  hello-world   ok         9 steps compared, output and exit code match',
    )
    expect(programLine(different)).toBe(
      '  factorial     DIFFERENT  step 13 differs (line 20: imul eax, ecx)',
    )
    expect(programLine({ ...ok, mode: 'output', emulatorCompared: false })).toBe(
      '  hello-world   ok         prints the expected output (exit code 0)',
    )
  })

  it('prints a table of the differences', () => {
    expect(differenceLines([ok])).toEqual([])
    const lines = differenceLines([ok, different])
    expect(lines).toContain(
      '  program    step  line  instruction    what  emulator            real CPU',
    )
    expect(lines).toContain(
      '  factorial  13    20    imul eax, ecx  rax   0x0000000000000014  0x0000000000000078',
    )
    expect(lines.at(-1)).toContain('factorial: output: the emulator printed')
  })

  it('prints the summary with the mode, the programs and the steps', () => {
    const [, line] = summaryLines({
      mode: 'trace',
      modeDetail: 'clang, x86-64 through Rosetta 2',
      programs: 10,
      stepsCompared: 412,
      failed: 0,
      emulatorCompared: true,
    })
    expect(line).toBe(
      'Summary: mode "clang + built-in single-step tracer" (clang, x86-64 through Rosetta 2); ' +
        '10 programs; 412 steps compared; everything matched the emulator.',
    )
    const [, failed] = summaryLines({
      mode: 'gdb',
      modeDetail: 'gcc',
      programs: 10,
      stepsCompared: 80,
      failed: 2,
      emulatorCompared: true,
    })
    expect(failed).toContain('2 of 10 programs differ from the emulator')
  })
})

/* ─────────────────────────────── small pieces ─────────────────────────────── */

describe('options', () => {
  it('has sensible defaults', () => {
    expect(parseOptions([])).toEqual({
      mode: 'auto',
      only: null,
      fuzz: null,
      timeoutMs: 20_000,
      showSteps: false,
      keep: false,
      help: false,
    })
  })

  it('reads every option', () => {
    expect(
      parseOptions([
        '--mode',
        'trace',
        '--only',
        'sum-loop, power',
        '--fuzz',
        'p0042,p0007',
        '--timeout',
        '5',
        '--show-steps',
        '--keep',
      ]),
    ).toEqual({
      mode: 'trace',
      only: ['sum-loop', 'power'],
      fuzz: ['p0042', 'p0007'],
      timeoutMs: 5000,
      showSteps: true,
      keep: true,
      help: false,
    })
  })

  it('refuses what it does not know', () => {
    expect(parseOptions(['--mode', 'fast'])).toEqual({
      error: '--mode must be one of: auto, gdb, lldb, trace, output',
    })
    expect(parseOptions(['--frobnicate'])).toEqual({ error: 'unknown option --frobnicate' })
    expect(parseOptions(['--timeout', 'soon'])).toHaveProperty('error')
  })
})

describe('finding the processes a debugger started', () => {
  it('follows parent links to every generation', () => {
    const listing = [
      '    1     0',
      '  100     1',
      '  200   100',
      '  201   100',
      '  300   200',
      '  999     1',
      '',
    ].join('\n')
    expect(descendantsFromListing(listing, 100).sort((a, b) => a - b)).toEqual([200, 201, 300])
    expect(descendantsFromListing(listing, 300)).toEqual([])
  })
})

describe('a fuzz program as a real program', () => {
  it('saves and restores the registers a function must keep, around the fixture body', () => {
    const lines = fuzzProgramSource('    mov rbx, 0x5\n    push rbx\n    pop r12').split('\n')
    expect(lines.slice(0, 6)).toEqual([
      '    .intel_syntax noprefix',
      '    .data',
      'scratch: .zero 256',
      '    .text',
      '    .globl main',
      'main:',
    ])
    expect(lines.slice(6, 12)).toEqual(
      ['rbx', 'rbp', 'r12', 'r13', 'r14', 'r15'].map((reg) => `    push ${reg}`),
    )
    expect(lines.slice(12, 15)).toEqual(['    mov rbx, 0x5', '    push rbx', '    pop r12'])
    expect(lines.slice(15)).toEqual([
      ...['r15', 'r14', 'r13', 'r12', 'rbp', 'rbx'].map((reg) => `    pop ${reg}`),
      '    mov eax, 0',
      '    ret',
      '',
    ])
  })
})
