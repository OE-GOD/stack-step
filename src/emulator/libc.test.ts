/**
 * The library functions: printf, scanf, puts, putchar and exit
 * (behaviour contract, section 6, and the notes of section 7 that belong to them).
 *
 * Every test runs a real program that calls the function, the way a student's program
 * does: the `call` is one step, the library function is the next one.
 */
import { describe, expect, it } from 'vitest'
import { createEmulator, type Emulator } from './index'
import { CALLER_SAVED, decodeUtf8, junkValue } from './libc'
import {
  DEFAULT_OPTIONS,
  LIBRARY_FUNCTIONS,
  type EmulatorOptions,
  type Reg64,
  type StepResult,
} from './types'

/* ───────────────────────────── helpers ───────────────────────────── */

const RSP0 = 0x7ffffffddff8n
const PATTERN = 0x1111222233334444n

function emulatorFor(text: string, options?: EmulatorOptions): Emulator {
  const made = createEmulator(text, options)
  if (!made.ok) throw new Error(made.diagnostics.map((item) => item.message).join('\n'))
  return made.emulator
}

/** Step until a library step ran (or tried to run), and give that step back. */
function stepIntoLibrary(emulator: Emulator): StepResult {
  for (let i = 0; i < 200; i++) {
    const step = emulator.step()
    if (step.kind === 'library') return step
    if (!step.executed || step.status !== 'running') {
      throw new Error(`the program stopped before a library call: ${step.explanation}`)
    }
  }
  throw new Error('no library call in 200 steps')
}

/** The registers that carry the values after the text, in order. */
const VALUE_REGISTERS: Reg64[] = ['rsi', 'rdx', 'rcx', 'r8', 'r9']

/**
 * A program that calls printf with `format` (written as in assembly, so `\\n` is a new
 * line) and returns. `extra` lines run right before the call. The stack is lined up to
 * 16 bytes at the call when `stackValues` is even.
 */
function printfSource(format: string, extra: string[] = [], pad = true): string {
  return [
    '.intel_syntax noprefix',
    '.text',
    `format: .string "${format}"`,
    'sample: .string "abc"',
    'main:',
    ...(pad ? ['    sub rsp, 8'] : []),
    ...extra.map((line) => `    ${line}`),
    '    lea rdi, format[rip]',
    '    mov eax, 0',
    '    call printf@PLT',
    '    mov rbx, rax',
    '    add rsp, 8',
    '    ret',
    '',
  ].join('\n')
}

interface Printed {
  output: string
  /** The whole of rax right after printf returned. */
  rax: bigint
  step: StepResult
  emulator: Emulator
}

/** Call printf with `format` and the values (the first five in registers, the rest on the stack). */
function printf(format: string, values: bigint[] = [], options: EmulatorOptions = {}): Printed {
  const inRegisters: Partial<Record<Reg64, bigint>> = { ...options.initialRegisters }
  values.slice(0, 5).forEach((value, i) => {
    inRegisters[VALUE_REGISTERS[i]] = value
  })
  // The 6th value and later ones go on the stack, the last one first.
  const onStack = values.slice(5)
  const pushes = [...onStack].reverse().flatMap((value) => [`mov rax, ${value}`, 'push rax'])
  const emulator = emulatorFor(printfSource(format, pushes, onStack.length % 2 === 0), {
    ...options,
    initialRegisters: inRegisters,
  })
  const step = stepIntoLibrary(emulator)
  return {
    output: emulator.getSnapshot().output,
    rax: emulator.readRegister('rax'),
    step,
    emulator,
  }
}

/** The address of the five 8-byte boxes that the scanf programs use as destinations. */
const DESTINATION = RSP0 - 40n

/** A program that calls scanf with `format` and five destinations: rsp, rsp+8, … rsp+32. */
function scanfSource(format: string, name = 'scanf'): string {
  return [
    '.intel_syntax noprefix',
    '.text',
    `format: .string "${format}"`,
    'main:',
    '    sub rsp, 40',
    '    lea rsi, [rsp]',
    '    lea rdx, 8[rsp]',
    '    lea rcx, 16[rsp]',
    '    lea r8, 24[rsp]',
    '    lea r9, 32[rsp]',
    '    lea rdi, format[rip]',
    '    mov eax, 0',
    `    call ${name}@PLT`,
    '    add rsp, 40',
    '    ret',
    '',
  ].join('\n')
}

interface Scanned {
  step: StepResult
  emulator: Emulator
  /** The bytes of destination `index` (8 of them). */
  box: (index: number) => (number | null)[]
}

function scanf(format: string, stdin?: string, options: EmulatorOptions = {}): Scanned {
  const emulator = emulatorFor(scanfSource(format), { ...options, stdin })
  const step = stepIntoLibrary(emulator)
  return {
    step,
    emulator,
    box: (index) => emulator.readMemory(DESTINATION + 8n * BigInt(index), 8),
  }
}

const UNWRITTEN = [null, null, null, null, null, null, null, null]

/* ──────────────────────────────── printf ──────────────────────────────── */

describe('printf', () => {
  it('prints the text and returns the number of bytes in eax', () => {
    const { output, rax, step } = printf('Hello World!\\n', [], {
      initialRegisters: { rax: PATTERN },
    })
    expect(output).toBe('Hello World!\n')
    expect(step.output).toBe('Hello World!\n')
    // A 32-bit write: the top half of rax is 0.
    expect(rax).toBe(13n)
  })

  it.each<[string, bigint[], string]>([
    ['%d', [42n], '42'],
    ['%d', [0n], '0'],
    ['%d', [0xffffffffn], '-1'],
    ['%d', [0x80000000n], '-2147483648'],
    ['%d', [0x7fffffffn], '2147483647'],
    // Only the low 32 bits count.
    ['%d', [0x1234567800000007n], '7'],
    ['%i', [0xfffffffen], '-2'],
    ['%u', [0xffffffffn], '4294967295'],
    ['%u', [0x100000005n], '5'],
    ['%x', [255n], 'ff'],
    ['%x', [0xdeadbeefn], 'deadbeef'],
    ['%x', [0x1200000abcn], 'abc'],
    ['%X', [0xdeadbeefn], 'DEADBEEF'],
    ['%c', [0x41n], 'A'],
    ['%c', [0x141n], 'A'],
    ['%p', [0x7ffffffddff8n], '0x7ffffffddff8'],
    // As in C on Linux (glibc), a null pointer prints as "(nil)".
    ['%p', [0n], '(nil)'],
    ['[%7p]', [0n], '[  (nil)]'],
    ['%%', [], '%'],
    ['100%%', [], '100%'],
    ['%d%%', [50n], '50%'],
  ])('"%s" with %s prints "%s"', (format, values, expected) => {
    const { output, rax } = printf(format, values)
    expect(output).toBe(expected)
    expect(rax).toBe(BigInt(expected.length))
  })

  it.each<[string, bigint[], string]>([
    ['%ld', [0xffffffffffffffffn], '-1'],
    ['%ld', [0x100000000n], '4294967296'],
    ['%li', [0x8000000000000000n], '-9223372036854775808'],
    ['%lu', [0xffffffffffffffffn], '18446744073709551615'],
    ['%lx', [0xffffffffffffffffn], 'ffffffffffffffff'],
    ['%lX', [0xabcdef0123n], 'ABCDEF0123'],
    ['%lld', [0xfffffffffffffffen], '-2'],
    ['%llu', [0x100000000n], '4294967296'],
    ['%llx', [0x123456789an], '123456789a'],
    ['%zu', [0x100000000n], '4294967296'],
    ['%zd', [0xffffffffffffffffn], '-1'],
    ['%jd', [0xffffffffffffffffn], '-1'],
    ['%hd', [0x18000n], '-32768'],
    ['%hu', [0x18000n], '32768'],
    ['%hx', [0x1abcdn], 'abcd'],
    ['%hhd', [0x1ffn], '-1'],
    ['%hhu', [0x1ffn], '255'],
    ['%hhx', [0x1f0n], 'f0'],
  ])('"%s" with %s uses the right number of bits: "%s"', (format, values, expected) => {
    expect(printf(format, values).output).toBe(expected)
  })

  it.each<[string, bigint[], string]>([
    ['%5d', [42n], '   42'],
    ['%-5d|', [42n], '42   |'],
    ['%05d', [42n], '00042'],
    ['%05d', [0xffffffd6n], '-0042'],
    ['%02x', [5n], '05'],
    ['%02x', [0xabcn], 'abc'],
    ['%3d', [12345n], '12345'],
    ['%8x|', [0xffn], '      ff|'],
    ['%-8x|', [0xffn], 'ff      |'],
    ['%08lx', [0xabcdn], '0000abcd'],
    ['%3c|', [0x41n], '  A|'],
    ['%-3c|', [0x41n], 'A  |'],
    ['%10u', [7n], '         7'],
    ['%1d', [7n], '7'],
    ['%+d', [42n], '+42'],
    ['% d', [42n], ' 42'],
    ['%#x', [255n], '0xff'],
    ['%.3d', [7n], '007'],
    ['%*d', [5n, 42n], '   42'],
  ])('"%s" with %s pads like C: "%s"', (format, values, expected) => {
    expect(printf(format, values).output).toBe(expected)
  })

  it('prints the text at an address with %s, and pads it', () => {
    const run = (format: string): string => {
      const setup = ['lea rsi, sample[rip]', 'lea rdx, format[rip]']
      const emulator = emulatorFor(printfSource(format, setup))
      stepIntoLibrary(emulator)
      return emulator.getSnapshot().output
    }
    expect(run('%s')).toBe('abc')
    expect(run('[%5s]')).toBe('[  abc]')
    expect(run('[%-5s]')).toBe('[abc  ]')
    expect(run('[%.2s]')).toBe('[ab]')
    // The second value is the address of the format text itself.
    expect(run('%s and %s')).toBe('abc and %s and %s')
  })

  it('takes its values from rsi, rdx, rcx, r8, r9 in that order', () => {
    const { output, rax } = printf('%d %d %d %d %d\\n', [1n, 2n, 3n, 4n, 5n])
    expect(output).toBe('1 2 3 4 5\n')
    expect(rax).toBe(10n)
  })

  it('takes the 6th value and later ones from the stack, above the return address', () => {
    const { output } = printf('%d %d %d %d %d %d %d %d', [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n])
    expect(output).toBe('1 2 3 4 5 6 7 8')
    const one = printf('%d-%d-%d-%d-%d-%ld', [1n, 2n, 3n, 4n, 5n, 0x100000000n])
    expect(one.output).toBe('1-2-3-4-5-4294967296')
  })

  it('prints everything else in the text as it is', () => {
    expect(printf('a\\tb\\\\c \\"d\\"\\n').output).toBe('a\tb\\c "d"\n')
    expect(printf('no values here').output).toBe('no values here')
    expect(printf('').output).toBe('')
    expect(printf('').rax).toBe(0n)
  })

  it('counts bytes, not characters, for text outside ASCII', () => {
    const { output, rax, step } = printf('¡Hola!')
    expect(output).toBe('¡Hola!')
    expect(rax).toBe(7n)
    expect(step.explanation).toMatch(/6 characters/)
    expect(step.explanation).toMatch(/7 bytes/)
  })

  it('adds to the output of the calls before it', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'first: .string "one "',
        'second: .string "two\\n"',
        'main:',
        'sub rsp, 8',
        'lea rdi, first[rip]',
        'call printf@PLT',
        'lea rdi, second[rip]',
        'call printf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe('one two\n')
    const outputs = [emulator.getSnapshot().lastStep?.output]
    expect(outputs).toEqual([''])
  })

  it('returns to the instruction after the `call` and moves rsp up 8', () => {
    const { step, emulator } = printf('hi')
    const call = emulator.program.instructions.find(
      (instruction) => instruction.mnemonic === 'call',
    )
    if (call === undefined) throw new Error('no call')
    expect(step.diff.rip).toEqual({
      before: LIBRARY_FUNCTIONS.printf,
      after: call.address + BigInt(call.size),
    })
    expect(emulator.readRegister('rsp')).toBe(RSP0 - 8n)
    expect(emulator.getSnapshot().inLibrary).toBeNull()
    expect(emulator.getSnapshot().nextLine).toBe(call.line + 1)
    expect(emulator.getSnapshot().callStack).toHaveLength(1)
  })

  it('does not change the flags', () => {
    // `cmp` sets CF and SF right before the call.
    const emulator = emulatorFor(printfSource('hi', ['mov eax, 1', 'cmp eax, 2']))
    for (let i = 0; i < 6; i++) emulator.step()
    expect(emulator.getSnapshot().inLibrary?.name).toBe('printf')
    const before = emulator.getSnapshot().flags
    expect(before).toEqual({ CF: 1, ZF: 0, SF: 1, OF: 0 })
    const step = emulator.step()
    expect(step.kind).toBe('library')
    expect(step.diff.flags).toEqual([])
    expect(step.diff.written.flags).toEqual([])
    expect(emulator.getSnapshot().flags).toEqual(before)
  })
})

describe('printf errors', () => {
  /** Run until the program stops, and give back the failing library step. */
  function failing(
    text: string,
    options?: EmulatorOptions,
  ): { step: StepResult; emulator: Emulator } {
    const emulator = emulatorFor(text, options)
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('error')
    return { step, emulator }
  }

  it('rdi that is not an address: says it needs the ADDRESS and shows `lea`', () => {
    const { step, emulator } = failing(
      [
        '.intel_syntax noprefix',
        'main:',
        'sub rsp, 8',
        'mov rdi, 5',
        'call printf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.line).toBe(5)
    expect(step.error?.message).toContain('ADDRESS')
    expect(step.error?.message).toContain('lea rdi, message[rip]')
    expect(step.error?.message).toContain('0x5')
    expect(emulator.getSnapshot().error).toEqual(step.error)
  })

  it('`mov` where `lea` was needed: names the label that was copied', () => {
    const { step } = failing(
      [
        '.intel_syntax noprefix',
        'greeting: .string "Hello World!\\n"',
        'main:',
        'sub rsp, 8',
        'mov rdi, greeting[rip]',
        'call printf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toContain('ADDRESS')
    expect(step.error?.message).toContain('`lea rdi, greeting[rip]`')
    expect(step.error?.message).toContain('`mov`')
  })

  it('is atomic: nothing is printed, the return address stays, rip stays in the library', () => {
    const { step, emulator } = failing(printfSource('before %s after'), {
      initialRegisters: { rsi: 0x10n, rbx: 77n, rcx: 5n },
    })
    expect(step.error?.code).toBe('library-error')
    expect(step.executed).toBe(true)
    expect(step.kind).toBe('library')
    expect(step.output).toBe('')
    expect(step.diff.registers).toEqual([])
    expect(step.diff.rip).toEqual({
      before: LIBRARY_FUNCTIONS.printf,
      after: LIBRARY_FUNCTIONS.printf,
    })
    const state = emulator.getSnapshot()
    expect(state.output).toBe('')
    expect(state.rip).toBe(LIBRARY_FUNCTIONS.printf)
    expect(state.inLibrary).toEqual({ name: 'printf', callLine: 9 })
    expect(state.registers.rsp).toBe(RSP0 - 16n)
    expect(state.registers.rcx).toBe(5n)
    expect(state.registers.rax).toBe(0n)
    expect(state.stack.at(-1)?.kind).toBe('return-address')
    // And it can be undone.
    expect(emulator.stepBack()).toBe(true)
    expect(emulator.getSnapshot().status).toBe('running')
  })

  it('%s with a value that is not an address', () => {
    const { step } = failing(printfSource('%s'), { initialRegisters: { rsi: 42n } })
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toContain('`%s`')
    expect(step.error?.message).toContain('ADDRESS')
    expect(step.error?.message).toContain('rsi')
    expect(step.error?.message).toContain('0x2a')
  })

  it.each(['%f', '%e', '%g', '%o', '%n', '%q', '%5.2f', '%Lf'])(
    'an item it does not know (%s): names it and lists the ones it knows',
    (conversion) => {
      const { step } = failing(printfSource(`value: ${conversion}`))
      expect(step.error?.code).toBe('library-error')
      expect(step.error?.message).toContain(`\`${conversion}\``)
      for (const known of ['%d', '%u', '%x', '%c', '%s', '%p']) {
        expect(step.error?.message).toContain(known)
      }
      expect(step.error?.message).toContain('`l`, `ll`, `h` or `hh`')
    },
  )

  it('a `%` at the very end: says how to print a percent sign', () => {
    const { step } = failing(printfSource('100%'))
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toBe(
      'Line 9: the text of `printf` ends with a `%` that has no letter after it. To print a percent sign, write `%%`.',
    )
  })

  it('a width that is far too big', () => {
    const { step } = failing(printfSource('%99999d'))
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toContain('`%99999d`')
  })

  it('text that runs into memory the program does not own', () => {
    // `.ascii` has no 0 at the end, and here it ends exactly at the end of a 4 KiB page:
    // the read-only data is 0x402010 … 0x403000, and nothing is mapped after it.
    const { step, emulator } = failing(
      [
        '.intel_syntax noprefix',
        'fill: .zero 4074',
        'open: .ascii "no end"',
        'main:',
        'lea rdi, open[rip]',
        'call puts@PLT',
        'ret',
        '',
      ].join('\n'),
    )
    expect(emulator.program.layout.rodataEnd).toBe(0x403000n)
    expect(step.error?.code).toBe('library-error')
    // rdi does point at the program's memory: the message says the TEXT runs out of it.
    expect(step.error?.message).toBe(
      'Line 6: `puts` read the text at 0x402ffa, but the text has no 0 byte at its end: it runs into memory your program does not own, at 0x403000. Write the text with `.string`: it adds the 0 byte.',
    )
    expect(step.output).toBe('')
  })

  it('text with no 0 byte at the end of the data: printed up to the end, with a warning', () => {
    // A real machine gives memory in whole 4 KiB pages: the rest of the page reads as 0 here.
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'open: .ascii "no end"',
        'main:',
        'sub rsp, 8',
        'lea rdi, open[rip]',
        'call puts@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('running')
    expect(step.output).toBe('no end\n')
    const warnings = step.notes.filter((note) => note.kind === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].text).toContain("read past the last byte of the program's data, to 0x402016")
    expect(warnings[0].text).toContain('Write the text with `.string`')
  })

  it('%s of text that runs out of the program’s memory is an error that says so', () => {
    const { step } = failing(
      [
        '.intel_syntax noprefix',
        'format: .string "%s"',
        'fill: .zero 4074',
        'open: .ascii "abc"',
        'main:',
        'sub rsp, 8',
        'lea rsi, open[rip]',
        'lea rdi, format[rip]',
        'call printf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    expect(step.error?.message).toContain('`printf` read the text at 0x402ffd')
    expect(step.error?.message).toContain('at 0x403000')
  })

  it('`mov` where `lea` was needed, with a short string: the read works, and printf names the mistake', () => {
    // The 8 bytes at a 3-byte string run past the program's data: on a real machine they are
    // still in the same page, so `mov` works and only printf fails.
    const { step, emulator } = failing(
      [
        '.intel_syntax noprefix',
        'msg: .string "Hi"',
        'main:',
        'push rbp',
        'mov rdi, msg',
        'mov eax, 0',
        'call printf@PLT',
        'pop rbp',
        'ret',
        '',
      ].join('\n'),
    )
    expect(emulator.getSnapshot().stepCount).toBe(5)
    // "Hi" reads the same with 4 and with 8 bytes, so the message gives no count.
    expect(step.error?.message).toContain('rdi holds 0x6948: the first bytes stored at `msg`.')
    expect(step.error?.message).toContain(
      '`mov` copied those bytes into rdi, not the address of `msg`.',
    )
    expect(step.error?.message).toContain('write `lea rdi, msg[rip]`')
  })

  /** A program that copies the text at `msg` into rdi or edi with `mov`, then calls puts. */
  function movInsteadOfLea(text: string, destination: 'rdi' | 'edi'): StepResult {
    return failing(
      [
        '.intel_syntax noprefix',
        `msg: .string "${text}"`,
        'main:',
        'push rbp',
        `mov ${destination}, msg`,
        'call puts@PLT',
        'pop rbp',
        'ret',
        '',
      ].join('\n'),
    ).step
  }

  it.each<['rdi' | 'edi', string, bigint, string]>([
    // A long text: the 8-byte and the 4-byte value differ, so the count is known.
    ['rdi', 'Hello World!', 0x6f57206f6c6c6548n, 'the 8 bytes stored at `msg`.'],
    ['edi', 'Hello World!', 0x6c6c6548n, 'the 4 bytes stored at `msg`.'],
    // A short text: the bytes after it read as 0, so 4 and 8 bytes give the same value.
    ['edi', 'Hi', 0x6948n, 'the first bytes stored at `msg`.'],
    ['rdi', 'Hi', 0x6948n, 'the first bytes stored at `msg`.'],
    ['edi', 'abc', 0x636261n, 'the first bytes stored at `msg`.'],
  ])(
    '`mov %s, msg` with "%s": the message gives the right count of bytes',
    (destination, text, value, words) => {
      const step = movInsteadOfLea(text, destination)
      expect(step.error?.code).toBe('library-error')
      const message = step.error?.message ?? ''
      expect(message).toContain(`rdi holds 0x${value.toString(16)}: ${words}`)
      expect(message).toContain('`mov` copied those bytes into rdi, not the address of `msg`.')
      if (words.startsWith('the first')) expect(message).not.toMatch(/\b[48] bytes\b/)
    },
  )

  it('rdi that points at the code of the program', () => {
    const { step } = failing(
      ['.intel_syntax noprefix', 'main:', 'lea rdi, main[rip]', 'call puts@PLT', 'ret', ''].join(
        '\n',
      ),
    )
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toMatch(/instruction/)
  })
})

/* ───────────────────────── junk in the caller-saved registers ───────────────────────── */

describe('the registers after a library call', () => {
  const start: Partial<Record<Reg64, bigint>> = {
    rbx: 1n,
    rbp: 2n,
    r12: 12n,
    r13: 13n,
    r14: 14n,
    r15: 15n,
    rcx: 100n,
    rdx: 101n,
    rsi: 102n,
    r8: 103n,
    r9: 104n,
    r10: 105n,
    r11: 106n,
  }

  it('rcx, rdx, rsi, rdi, r8 to r11 hold junk: not 0 and not their old value', () => {
    const { emulator, step } = printf('hi', [], { initialRegisters: start })
    const before = emulatorFor(printfSource('hi'), { initialRegisters: start })
    for (let i = 0; i < 4; i++) before.step()
    for (const name of CALLER_SAVED) {
      const junk = emulator.readRegister(name)
      expect(junk, name).not.toBe(0n)
      expect(junk, name).not.toBe(before.readRegister(name))
    }
    expect(CALLER_SAVED).toEqual(['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11'])
    expect(step.diff.written.registers).toEqual(['rax', ...CALLER_SAVED, 'rsp'])
  })

  it('the junk looks like addresses inside the C library', () => {
    const { emulator } = printf('hi')
    for (const name of CALLER_SAVED) {
      const junk = emulator.readRegister(name)
      expect(junk >= 0x7ffff7e00000n && junk < 0x7ffff7f00000n, name).toBe(true)
    }
  })

  it('rbx, rbp and r12 to r15 keep their values, and rsp is back', () => {
    const { emulator } = printf('hi', [], { initialRegisters: start })
    expect(emulator.readRegister('rbx')).toBe(1n)
    expect(emulator.readRegister('rbp')).toBe(2n)
    expect(emulator.readRegister('r12')).toBe(12n)
    expect(emulator.readRegister('r13')).toBe(13n)
    expect(emulator.readRegister('r14')).toBe(14n)
    expect(emulator.readRegister('r15')).toBe(15n)
    expect(emulator.readRegister('rsp')).toBe(RSP0 - 8n)
  })

  it('the same program gets the same junk every time', () => {
    const first = printf('hi').emulator.getSnapshot().registers
    const second = printf('hi').emulator.getSnapshot().registers
    expect(second).toEqual(first)
  })

  it('adds a tip that names the registers', () => {
    const { step } = printf('hi')
    expect(step.notes).toHaveLength(1)
    expect(step.notes[0].kind).toBe('tip')
    for (const name of CALLER_SAVED) expect(step.notes[0].text).toContain(name)
  })

  it('with clobberCallerSaved: false the registers keep their values and there is no tip', () => {
    const { emulator, step } = printf('hi', [], {
      initialRegisters: start,
      clobberCallerSaved: false,
    })
    expect(emulator.readRegister('rcx')).toBe(100n)
    expect(emulator.readRegister('rdx')).toBe(101n)
    expect(emulator.readRegister('rsi')).toBe(102n)
    expect(emulator.readRegister('r8')).toBe(103n)
    expect(emulator.readRegister('r11')).toBe(106n)
    expect(emulator.readRegister('rdi')).toBe(0x402010n)
    expect(step.notes).toEqual([])
    expect(step.diff.written.registers).toEqual(['rax', 'rsp'])
  })

  it('a correct program has only the junk tips as notes', () => {
    const emulator = emulatorFor(printfSource('%d\\n'))
    const notes: string[] = []
    for (;;) {
      const step = emulator.step()
      if (!step.executed) break
      notes.push(...step.notes.map((note) => note.kind))
    }
    expect(notes).toEqual(['tip'])
  })

  it('junkValue is never 0 and never the value the register has', () => {
    for (let stepNumber = 0; stepNumber < 200; stepNumber++) {
      for (let position = 0; position < 8; position++) {
        const junk = junkValue(stepNumber, position, 0n)
        expect(junk).not.toBe(0n)
        expect(junkValue(stepNumber, position, 0n)).toBe(junk)
        // Asking again with that very value in the register gives another one.
        expect(junkValue(stepNumber, position, junk)).not.toBe(junk)
        expect(junk % 8n).toBe(0n)
      }
    }
  })
})

/* ───────────────────────────── the alignment warning ───────────────────────────── */

describe('the stack alignment warning', () => {
  it('warns when rsp is not a multiple of 16 at a call into the library', () => {
    // No `sub rsp, 8`: rsp still ends in 8.
    const emulator = emulatorFor(printfSource('hi', [], false))
    const call = emulator.step()
    emulator.step()
    const warned = emulator.step()
    expect(call.notes).toEqual([])
    expect(warned.text).toBe('call printf@PLT')
    expect(warned.notes).toHaveLength(1)
    expect(warned.notes[0].kind).toBe('warning')
    expect(warned.notes[0].text).toContain('16')
    // The call still works.
    expect(emulator.step().output).toBe('hi')
  })

  it('does not warn when the stack is lined up', () => {
    const emulator = emulatorFor(printfSource('hi'))
    const results = [emulator.step(), emulator.step(), emulator.step(), emulator.step()]
    expect(results[3].text).toBe('call printf@PLT')
    expect(results.flatMap((result) => result.notes)).toEqual([])
  })

  it('does not warn for a call to a function of the program', () => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', 'main:', 'call helper', 'ret', 'helper:', 'ret', ''].join('\n'),
    )
    expect(emulator.step().notes).toEqual([])
  })
})

/* ──────────────────────────────── scanf ──────────────────────────────── */

describe('scanf', () => {
  it('reads one number, stores 4 bytes, and returns 1', () => {
    const { step, emulator, box } = scanf('%d', '41\n', { initialRegisters: { rax: PATTERN } })
    expect(step.executed).toBe(true)
    expect(step.kind).toBe('library')
    expect(step.status).toBe('running')
    expect(box(0)).toEqual([41, 0, 0, 0, null, null, null, null])
    expect(emulator.readRegister('rax')).toBe(1n)
    expect(step.diff.memory).toEqual([
      { address: DESTINATION, before: [null, null, null, null], after: [41, 0, 0, 0] },
    ])
    expect(emulator.readRegister('rsp')).toBe(RSP0 - 40n)
  })

  it('reads two numbers', () => {
    const { emulator, box } = scanf('%d %d', '3 4\n')
    expect(box(0).slice(0, 4)).toEqual([3, 0, 0, 0])
    expect(box(1).slice(0, 4)).toEqual([4, 0, 0, 0])
    expect(emulator.readRegister('rax')).toBe(2n)
  })

  it.each<[string, string, number[][]]>([
    ['%d', '-5\n', [[0xfb, 0xff, 0xff, 0xff]]],
    ['%d', '+7\n', [[7, 0, 0, 0]]],
    ['%d', '   \n\t 12\n', [[12, 0, 0, 0]]],
    ['%d', '41', [[41, 0, 0, 0]]],
    [
      '%d%d',
      '1\n2\n',
      [
        [1, 0, 0, 0],
        [2, 0, 0, 0],
      ],
    ],
    [
      '%d,%d',
      '8,9\n',
      [
        [8, 0, 0, 0],
        [9, 0, 0, 0],
      ],
    ],
    ['%i', '0x10\n', [[16, 0, 0, 0]]],
    ['%i', '25\n', [[25, 0, 0, 0]]],
    ['%u', '4294967295\n', [[0xff, 0xff, 0xff, 0xff]]],
    ['%x', 'ff\n', [[0xff, 0, 0, 0]]],
    ['%x', '0x1F\n', [[0x1f, 0, 0, 0]]],
    ['%ld', '-2\n', [[0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]]],
    ['%lld', '4294967296\n', [[0, 0, 0, 0, 1, 0, 0, 0]]],
    ['%lu', '1\n', [[1, 0, 0, 0, 0, 0, 0, 0]]],
    ['%lx', 'abcdef0123\n', [[0x23, 0x01, 0xef, 0xcd, 0xab, 0, 0, 0]]],
    ['%hd', '-2\n', [[0xfe, 0xff]]],
    ['%hhd', '65\n', [[65]]],
    ['%c', 'x\n', [[0x78]]],
    ['%c', '\nx', [[0x0a]]],
    [' %c', '\n  x\n', [[0x78]]],
    ['%c%c', 'ab\n', [[0x61], [0x62]]],
    ['%s', '  hello world\n', [[0x68, 0x65, 0x6c, 0x6c, 0x6f, 0]]],
    [
      '%d %s',
      '5 ok\n',
      [
        [5, 0, 0, 0],
        [0x6f, 0x6b, 0],
      ],
    ],
    [
      '%2d%d',
      '1234\n',
      [
        [12, 0, 0, 0],
        [34, 0, 0, 0],
      ],
    ],
    ['%*d %d', '1 2\n', [[2, 0, 0, 0]]],
  ])('"%s" with the input %j', (format, stdin, expected) => {
    const { step, emulator, box } = scanf(format, stdin)
    expect(step.executed).toBe(true)
    expected.forEach((bytes, index) => {
      // Exactly these bytes are written; the rest of the box is untouched.
      const rest = new Array<null>(8 - bytes.length).fill(null)
      expect(box(index), `destination ${index}`).toEqual([...bytes, ...rest])
    })
    expect(box(expected.length)).toEqual(UNWRITTEN)
    expect(emulator.readRegister('rax')).toBe(BigInt(expected.length))
    expect(step.notes.filter((note) => note.kind === 'warning')).toEqual([])
  })

  it('accepts `__isoc99_scanf`, the name gcc uses', () => {
    const emulator = emulatorFor(scanfSource('%d', '__isoc99_scanf'), { stdin: '9\n' })
    const step = stepIntoLibrary(emulator)
    expect(step.text).toContain('scanf')
    expect(emulator.readMemory(DESTINATION, 1)).toEqual([9])
  })

  it('with no input: nothing happens, and the emulator waits', () => {
    const { step, emulator, box } = scanf('%d')
    expect(step.executed).toBe(false)
    expect(step.status).toBe('waiting-input')
    expect(step.diff.registers).toEqual([])
    const state = emulator.getSnapshot()
    expect(state.status).toBe('waiting-input')
    expect(state.inputRequest).not.toBeNull()
    expect(state.inputRequest?.prompt).toMatch(/number/)
    expect(state.inLibrary).toEqual({ name: 'scanf', callLine: 13 })
    expect(state.stepCount).toBe(9)
    expect(box(0)).toEqual(UNWRITTEN)
    expect(state.registers.rax).toBe(0n)
  })

  it('goes on after provideInput (a new line is added when it is missing)', () => {
    const { emulator, box } = scanf('%d')
    emulator.provideInput('42')
    const state = emulator.getSnapshot()
    expect(state.status).toBe('running')
    expect(state.inputRequest).toBeNull()
    const step = emulator.step()
    expect(step.executed).toBe(true)
    expect(step.kind).toBe('library')
    expect(box(0).slice(0, 4)).toEqual([42, 0, 0, 0])
    expect(emulator.run().reason).toBe('halted')
  })

  it('takes input that was given before the pause', () => {
    const emulator = emulatorFor(scanfSource('%d'))
    emulator.provideInput('17')
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.readMemory(DESTINATION, 4)).toEqual([17, 0, 0, 0])
  })

  it('waits again when the input is still not enough, and uses nothing until then', () => {
    const { emulator, box } = scanf('%d %d', '5\n')
    expect(emulator.getSnapshot().status).toBe('waiting-input')
    expect(box(0)).toEqual(UNWRITTEN)
    emulator.provideInput('')
    expect(emulator.step().executed).toBe(false)
    expect(emulator.getSnapshot().status).toBe('waiting-input')
    emulator.provideInput('6')
    expect(emulator.step().executed).toBe(true)
    expect(box(0).slice(0, 4)).toEqual([5, 0, 0, 0])
    expect(box(1).slice(0, 4)).toEqual([6, 0, 0, 0])
  })

  it('leaves the rest of the input for the next scanf', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d"',
        'main:',
        'sub rsp, 24',
        'lea rsi, [rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'lea rsi, 8[rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 24',
        'ret',
        '',
      ].join('\n'),
      { stdin: '1 2\n' },
    )
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.readMemory(RSP0 - 24n, 4)).toEqual([1, 0, 0, 0])
    expect(emulator.readMemory(RSP0 - 16n, 4)).toEqual([2, 0, 0, 0])
  })

  it('input that is not a number: stops, returns 0, warns, and leaves the input there (as C does)', () => {
    const { step, emulator, box } = scanf('%d', 'abc\n7\n')
    expect(step.executed).toBe(true)
    expect(step.status).toBe('running')
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(box(0)).toEqual(UNWRITTEN)
    const warnings = step.notes.filter((note) => note.kind === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0].text).toBe(
      '`scanf` wanted a whole number, but it found `abc`. It stopped there and stored nothing. `abc` stays in the input, so the next `scanf` starts there.',
    )
    expect(step.diff.memory).toEqual([])
  })

  it('after bad input the next scanf meets the same bad input again (as in C)', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d"',
        'main:',
        'sub rsp, 8',
        'lea rsi, [rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'mov ebx, eax',
        'lea rsi, [rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
      { stdin: 'oops 1\n7\n' },
    )
    expect(emulator.run().reason).toBe('halted')
    // glibc leaves "oops" in the input, so the second scanf fails on it too. (A loop that
    // reads until it gets a number never ends: the classic scanf bug, shown as it is.)
    expect(emulator.readRegister('rbx')).toBe(0n)
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(emulator.readMemory(RSP0 - 8n, 4)).toEqual([null, null, null, null])
  })

  it('a loop that reads until it gets a number never ends on bad input, as in C', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d"',
        'main:',
        'sub rsp, 8',
        'again:',
        'lea rsi, [rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'cmp eax, 1',
        'jne again',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
      { stdin: 'x\n', maxSteps: 200 },
    )
    const run = emulator.run()
    expect(run.reason).toBe('step-limit')
    expect(run.message).toMatch(/loop/)
  })

  it('a sign with no digit after it: the sign is read, the rest stays', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d"',
        'f_word: .string "%s"',
        'main:',
        'sub rsp, 24',
        'lea rsi, [rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'lea rsi, 8[rsp]',
        'lea rdi, f_word[rip]',
        'call scanf@PLT',
        'add rsp, 24',
        'ret',
        '',
      ].join('\n'),
      { stdin: '-x\n' },
    )
    const first = stepIntoLibrary(emulator)
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(first.notes[0].text).toContain('it found `x`')
    stepIntoLibrary(emulator)
    // C read the "-" and put back only the "x".
    expect(emulator.readMemory(RSP0 - 16n, 2)).toEqual([0x78, 0])
  })

  it('keeps the values it read before the bad one', () => {
    const { step, emulator, box } = scanf('%d %d %d', '5 x 6\n')
    expect(emulator.readRegister('rax')).toBe(1n)
    expect(box(0).slice(0, 4)).toEqual([5, 0, 0, 0])
    expect(box(1)).toEqual(UNWRITTEN)
    expect(step.notes.some((note) => note.kind === 'warning')).toBe(true)
  })

  it('a destination that is not an address: says it needs the ADDRESS and shows `lea rsi`', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d"',
        'main:',
        'sub rsp, 8',
        'mov rsi, 5',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
      { stdin: '1\n' },
    )
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('error')
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.line).toBe(7)
    expect(step.error?.message).toContain('ADDRESS')
    expect(step.error?.message).toContain('lea rsi, ')
    expect(step.error?.message).toContain('0x5')
    // Atomic: rip is still in the library and nothing was read.
    expect(emulator.getSnapshot().rip).toBe(LIBRARY_FUNCTIONS.scanf)
    expect(step.diff.registers).toEqual([])
    emulator.stepBack()
    emulator.stepBack()
    expect(emulator.getSnapshot().nextLine).toBe(7)
  })

  it('a wrong destination is reported before the emulator asks for input', () => {
    const emulator = emulatorFor(scanfSource('%d %d'), {})
    for (let i = 0; i < 9; i++) emulator.step()
    // Break the second destination after the program set it up... by starting over with rdx = 0.
    const broken = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d %d"',
        'main:',
        'sub rsp, 8',
        'lea rsi, [rsp]',
        'mov rdx, 0',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    const step = stepIntoLibrary(broken)
    expect(step.status).toBe('error')
    expect(step.error?.message).toContain('rdx')
    expect(broken.readMemory(RSP0 - 8n, 4)).toEqual([null, null, null, null])
  })

  it('a destination in read-only memory is an error too', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d"',
        'main:',
        'sub rsp, 8',
        'lea rsi, pattern[rip]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
      { stdin: '1\n' },
    )
    const step = stepIntoLibrary(emulator)
    expect(step.error?.code).toBe('library-error')
    expect(emulator.readMemory(0x402010n, 3)).toEqual([0x25, 0x64, 0])
  })

  it('an item it does not know is an error that names it', () => {
    const { step } = scanf('%f', '1.5\n')
    expect(step.status).toBe('error')
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toContain('`%f`')
    expect(step.error?.message).toContain('%d')
  })

  it('the prompt says what to type', () => {
    const prompt = (format: string, stdin?: string): string | undefined =>
      scanf(format, stdin).emulator.getSnapshot().inputRequest?.prompt
    expect(prompt('%d')).toBe('Type a whole number, like 42 or -7, and press Enter.')
    expect(prompt('%d %d')).toBe('Type 2 whole numbers with a space between them, like 3 4.')
    // After the first of two numbers: the typed number was not ignored, one more is needed.
    expect(prompt('%d %d', '1\n')).toBe('Type 1 more whole number.')
    expect(prompt('%s')).toBe('Type one word with no spaces, and press Enter.')
    expect(prompt('%c')).toBe('Type one character and press Enter.')
    expect(prompt('%c%c')).toBe('Type 2 characters.')
    expect(prompt('%x')).toBe('Type a hex number, like 1f, and press Enter.')
    expect(prompt('%d %x')).toBe('Type 2 values: a whole number, then a hex number.')
    expect(prompt('%d %s')).toBe('Type 2 values: a whole number, then a word.')
  })

  it('names what it found where it wanted something else: a space is not "the end of the line"', () => {
    const { step, emulator, box } = scanf('%d,%d', '3 4\n')
    expect(emulator.readRegister('rax')).toBe(1n)
    expect(box(0).slice(0, 4)).toEqual([3, 0, 0, 0])
    expect(box(1)).toEqual(UNWRITTEN)
    expect(step.notes[0].text).toBe(
      '`scanf` wanted `,` next in the input, but it found a space. It stopped there and stored only 1 value.',
    )
    expect(scanf('%d,%d', '3\t4\n').step.notes[0].text).toContain('it found a tab.')
    expect(scanf('%d,%d', '3\n4\n').step.notes[0].text).toContain('it found the end of the line.')
    expect(scanf('%d,%d', '3;4\n').step.notes[0].text).toContain('it found `;4`.')
  })

  it('stores every value of the format and gives no warning when only text after them differs', () => {
    // "%d," with "5": the one conversion was stored; glibc returns 1 and says nothing.
    const { step, emulator, box } = scanf('%d,', '5\n')
    expect(emulator.readRegister('rax')).toBe(1n)
    expect(box(0).slice(0, 4)).toEqual([5, 0, 0, 0])
    expect(step.notes.filter((note) => note.kind === 'warning')).toEqual([])
    expect(step.explanation).toContain('eax = 0x1, the number of values it stored')
    expect(step.explanation).not.toMatch(/could not read/)
  })

  it('a format with no conversion at all: no value was wanted, and the sentence says so', () => {
    const { step, emulator } = scanf(' ', '5\n')
    expect(emulator.readRegister('rax')).toBe(0n)
    expect(step.explanation).toContain(
      '`scanf` (library code) has no `%` item that stores a value in its format text, so it stored nothing and eax = 0x0.',
    )
  })

  it('stepBack gives the input back, and the label of a variable stays', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.equ number, -8',
        'pattern: .string "%d"',
        'main:',
        'push rbp',
        'mov rbp, rsp',
        'sub rsp, 16',
        'lea rsi, number[rbp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'lea rsi, number[rbp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'leave',
        'ret',
        '',
      ].join('\n'),
      { stdin: '1\n2\n' },
    )
    const first = stepIntoLibrary(emulator)
    const variable = RSP0 - 16n
    const slot = (): unknown => emulator.getSnapshot().stack.find((box) => box.address === variable)
    expect(slot()).toMatchObject({ label: 'number', kind: 'local', value: 1n, changed: true })
    emulator.stepBack()
    expect(slot()).toMatchObject({ label: 'number', kind: 'local', value: null })
    expect(emulator.step()).toEqual(first)
    stepIntoLibrary(emulator)
    expect(slot()).toMatchObject({ label: 'number', value: 2n })
    expect(emulator.run().reason).toBe('halted')
  })
})

/* ───────────────────────────── puts, putchar, exit ───────────────────────────── */

describe('puts, putchar and exit', () => {
  function program(lines: string[]): string {
    return [
      '.intel_syntax noprefix',
      'text: .string "Hello"',
      'main:',
      'sub rsp, 8',
      ...lines,
      'add rsp, 8',
      'ret',
      '',
    ].join('\n')
  }

  it('puts prints the text and a new line, and returns the number of bytes', () => {
    const emulator = emulatorFor(program(['lea rdi, text[rip]', 'call puts@PLT']))
    const step = stepIntoLibrary(emulator)
    expect(step.output).toBe('Hello\n')
    expect(step.text).toContain('puts')
    expect(emulator.readRegister('rax')).toBe(6n)
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe('Hello\n')
  })

  it('puts does not treat % as special', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'text: .string "100%d"',
        'main:',
        'lea rdi, text[rip]',
        'call puts@PLT',
        'ret',
        '',
      ].join('\n'),
    )
    expect(stepIntoLibrary(emulator).output).toBe('100%d\n')
  })

  it('putchar prints the low 8 bits of edi and returns that character code', () => {
    const emulator = emulatorFor(program(['mov edi, 0x141', 'call putchar@PLT']), {
      initialRegisters: { rax: PATTERN },
    })
    const step = stepIntoLibrary(emulator)
    expect(step.output).toBe('A')
    expect(emulator.readRegister('rax')).toBe(0x41n)
    expect(step.explanation).toContain('`A`')
  })

  it('putchar prints a new line', () => {
    const emulator = emulatorFor(program(['mov edi, 10', 'call putchar@PLT']))
    const step = stepIntoLibrary(emulator)
    expect(step.output).toBe('\n')
    expect(emulator.readRegister('rax')).toBe(10n)
  })

  it('exit ends the program and does not return', () => {
    const emulator = emulatorFor(program(['mov edi, 3', 'call exit@PLT', 'mov ebx, 99']))
    const step = stepIntoLibrary(emulator)
    expect(step.executed).toBe(true)
    expect(step.status).toBe('halted')
    expect(step.error).toBeNull()
    expect(step.explanation).toContain('3')
    expect(step.explanation).toMatch(/ended/)
    expect(step.notes).toEqual([])
    const state = emulator.getSnapshot()
    expect(state.status).toBe('halted')
    expect(state.nextLine).toBeNull()
    expect(state.rip).toBe(LIBRARY_FUNCTIONS.exit)
    // No return: the return address is still on the stack, and the next line never ran.
    expect(state.registers.rsp).toBe(RSP0 - 16n)
    expect(state.registers.rbx).toBe(0n)
    expect(emulator.run()).toMatchObject({ reason: 'halted', stepsRun: 0 })
    expect(emulator.stepBack()).toBe(true)
    expect(emulator.getSnapshot().status).toBe('running')
  })

  it('exit shows the code as a signed number', () => {
    const emulator = emulatorFor(program(['mov edi, -1', 'call exit@PLT']))
    expect(stepIntoLibrary(emulator).explanation).toContain('-1')
  })

  it('every library function is its own step with its own text', () => {
    const emulator = emulatorFor(
      program([
        'lea rdi, text[rip]',
        'call puts@PLT',
        'mov edi, 65',
        'call putchar@PLT',
        'mov edi, 0',
        'call exit@PLT',
      ]),
    )
    const texts: string[] = []
    for (;;) {
      const step = emulator.step()
      if (!step.executed) break
      if (step.kind === 'library') {
        texts.push(step.text)
        // The explanation starts with the name in backticks, then "(library code)".
        const name = step.text.split(' ')[0]
        expect(step.explanation.startsWith(`\`${name}\` (library code)`)).toBe(true)
      }
    }
    expect(texts).toEqual(['puts (library code)', 'putchar (library code)', 'exit (library code)'])
    expect(emulator.getSnapshot().output).toBe('Hello\nA')
  })
})

/* ──────────────────────────────── text ──────────────────────────────── */

describe('decodeUtf8', () => {
  it('reads plain ASCII', () => {
    expect(decodeUtf8([0x48, 0x69, 0x21])).toBe('Hi!')
    expect(decodeUtf8([])).toBe('')
  })

  it('reads characters of 2, 3 and 4 bytes', () => {
    expect(decodeUtf8([0xc2, 0xa1])).toBe('¡')
    expect(decodeUtf8([0xe2, 0x82, 0xac])).toBe('€')
    expect(decodeUtf8([0xf0, 0x9f, 0x99, 0x82])).toBe('🙂')
    expect(decodeUtf8([0x61, 0xc3, 0xa9, 0x62])).toBe('aéb')
  })

  it('shows a replacement character for bytes that are not UTF-8', () => {
    expect(decodeUtf8([0xff])).toBe('\ufffd')
    expect(decodeUtf8([0x80, 0x41])).toBe('\ufffdA')
    expect(decodeUtf8([0xc3])).toBe('\ufffd')
    expect(decodeUtf8([0xe2, 0x82])).toBe('\ufffd\ufffd')
    // An over-long form of "/" must not be read as "/".
    expect(decodeUtf8([0xc0, 0xaf])).toBe('\ufffd\ufffd')
    expect(decodeUtf8([0xed, 0xa0, 0x80])).toBe('\ufffd\ufffd\ufffd')
  })
})

describe('the fake addresses of the library', () => {
  it('are outside the program, so a jump there is only possible with `call`', () => {
    for (const address of Object.values(LIBRARY_FUNCTIONS)) {
      expect(address > DEFAULT_OPTIONS.dataBase).toBe(true)
      expect(address < 0x7ffffffde000n - BigInt(DEFAULT_OPTIONS.stackSize)).toBe(true)
    }
  })

  it('a `ret` to the address of a library function is a bad jump', () => {
    const emulator = emulatorFor(
      ['.intel_syntax noprefix', 'main:', 'mov rax, 0x7ffff7c606f0', 'push rax', 'ret', ''].join(
        '\n',
      ),
    )
    emulator.run()
    expect(emulator.getSnapshot().error?.code).toBe('bad-jump')
    expect(emulator.getSnapshot().inLibrary).toBeNull()
  })
})

/* ───────────────────────────── the flags after a call ───────────────────────────── */

describe('the flags after a library call', () => {
  /** cmp sets ZF, then printf runs, then a jump reads the flags. */
  function jumpAfterCall(before: string, options: EmulatorOptions = {}): StepResult {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'text: .string "x"',
        'main:',
        'sub rsp, 8',
        'mov eax, 5',
        before,
        'lea rdi, text[rip]',
        'call printf@PLT',
        'je done',
        'done:',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
      options,
    )
    for (;;) {
      const step = emulator.step()
      if (step.text === 'je done') return step
      if (!step.executed || step.status !== 'running') throw new Error(step.explanation)
    }
  }

  it('a jump that reads flags from before the call warns: library code may change them', () => {
    const jump = jumpAfterCall('cmp eax, 5')
    expect(jump.notes).toHaveLength(1)
    expect(jump.notes[0].kind).toBe('warning')
    expect(jump.notes[0].text).toBe(
      'This jump looked at flags from before the call to `printf` on line 8. Library code may change the flags, so on a real machine the jump may go the other way. Put `cmp` or `test` after the call, just before `je`.',
    )
  })

  it('after imul and a call, the warning is about the call, not about imul', () => {
    const jump = jumpAfterCall('imul eax, eax')
    expect(jump.notes).toHaveLength(1)
    expect(jump.notes[0].text).toMatch(
      /^This jump looked at flags from before the call to `printf`/,
    )
  })

  it('with the realism switched off, the flags count as kept: no warning', () => {
    expect(jumpAfterCall('cmp eax, 5', { clobberCallerSaved: false }).notes).toEqual([])
    // And the imul warning is still due then.
    const imul = jumpAfterCall('imul eax, eax', { clobberCallerSaved: false })
    expect(imul.notes.map((note) => note.text)).toEqual([expect.stringMatching(/`imul` wrote/)])
  })

  it('a cmp after the call ends the warning', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'text: .string "x"',
        'main:',
        'sub rsp, 8',
        'lea rdi, text[rip]',
        'call printf@PLT',
        'cmp eax, 1',
        'je done',
        'done:',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    let warnings = 0
    for (;;) {
      const step = emulator.step()
      if (!step.executed) break
      warnings += step.notes.filter((note) => note.kind === 'warning').length
    }
    expect(emulator.getSnapshot().status).toBe('halted')
    expect(warnings).toBe(0)
  })
})

/* ───────────────────────────── limits on printed text ───────────────────────────── */

describe('limits on printed text', () => {
  it('one call that prints far too much stops with a friendly error, and prints nothing', () => {
    // 80 × `%1000d` is 80 000 characters: more than one call may print (64 KiB).
    const format = '%1000d'.repeat(80)
    const emulator = emulatorFor(printfSource(format))
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('error')
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toContain(
      '`printf` tried to print more than 65,536 characters in one call.',
    )
    expect(step.output).toBe('')
    expect(emulator.getSnapshot().output).toBe('')
    expect(emulator.getSnapshot().rip).toBe(LIBRARY_FUNCTIONS.printf)
  })

  /**
   * A program that calls printf once, with `count` × `%s` and then `tail` as plain text.
   * The first `values` values after the format (5 registers, then stack boxes) are the
   * address of `text`. rsp is lined up to 16 at the call.
   */
  function manyTexts(text: string, count: number, tail = '', values = count): Emulator {
    const onStack = Math.max(0, values - 5)
    return emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        `big: .string "${text}"`,
        '.text',
        `format: .string "${'%s'.repeat(count)}${tail}"`,
        'main:',
        'push rbp',
        'mov rbp, rsp',
        ...(onStack % 2 === 1 ? ['sub rsp, 8'] : []),
        'lea rax, big[rip]',
        ...Array.from({ length: onStack }, () => 'push rax'),
        'lea rsi, big[rip]',
        'mov rdx, rsi',
        'mov rcx, rsi',
        'mov r8, rsi',
        'mov r9, rsi',
        'lea rdi, format[rip]',
        'mov eax, 0',
        'call printf@PLT',
        'leave',
        'ret',
        '',
      ].join('\n'),
    )
  }

  const CALL_LIMIT = '`printf` tried to print more than 65,536 characters in one call.'

  it('plain text after the last `%` item counts too: 65,536 characters print, 65,537 do not', () => {
    const text = 'A'.repeat(4095)
    // 16 × 4 095 = 65 520 characters from `%s`, then the plain text.
    const exact = manyTexts(text, 16, 'z'.repeat(16))
    const printed = stepIntoLibrary(exact)
    expect(printed.status).toBe('running')
    expect(printed.output.length).toBe(65_536)
    expect(printed.output.endsWith(`A${'z'.repeat(16)}`)).toBe(true)
    expect(exact.readRegister('rax')).toBe(65_536n)
    expect(exact.run().reason).toBe('halted')

    for (const tail of [17, 2000]) {
      const emulator = manyTexts(text, 16, 'z'.repeat(tail))
      const step = stepIntoLibrary(emulator)
      expect(step.status).toBe('error')
      expect(step.error?.code).toBe('library-error')
      expect(step.error?.message).toContain(CALL_LIMIT)
      expect(step.output).toBe('')
      expect(emulator.getSnapshot().output).toBe('')
      expect(emulator.getSnapshot().rip).toBe(LIBRARY_FUNCTIONS.printf)
    }
  })

  it('the limit counts characters, not bytes', () => {
    // 17 × 1 365 euro signs: 23 205 characters, but 69 615 bytes (3 bytes each).
    const euros = manyTexts('€'.repeat(1365), 17)
    const step = stepIntoLibrary(euros)
    expect(step.status).toBe('running')
    expect(step.output).toBe('€'.repeat(17 * 1365))
    // printf returns the number of BYTES it printed, like the real one.
    expect(euros.readRegister('rax')).toBe(BigInt(17 * 4095))
    expect(step.explanation).toContain('printed 23205 characters (69615 bytes)')
    expect(euros.run().reason).toBe('halted')

    // 2-byte characters right at the limit: 32 × 2 047 + 32 = 65 536 characters (131 072 bytes).
    const atLimit = manyTexts('é'.repeat(2047), 32, 'é'.repeat(32))
    const fits = stepIntoLibrary(atLimit)
    expect(fits.status).toBe('running')
    expect(fits.output.length).toBe(65_536)
    expect(atLimit.readRegister('rax')).toBe(131_072n)
    const overLimit = manyTexts('é'.repeat(2047), 32, 'é'.repeat(33))
    const over = stepIntoLibrary(overLimit)
    expect(over.status).toBe('error')
    expect(over.error?.message).toContain(CALL_LIMIT)
    expect(over.output).toBe('')
  })

  it('a call that would print megabytes stops early, before it reads the rest of its values', () => {
    // 2 000 × `%s` of 4 095 bytes would be 8 MB. Only the first 75 values are addresses of
    // text: the 76th is the saved rbp (0), so a printf that went on would stop with a
    // different error. The early stop comes after 65 values (more than 4 × 65 536 bytes).
    const emulator = manyTexts('A'.repeat(4095), 2000, '', 75)
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('error')
    expect(step.error?.code).toBe('library-error')
    expect(step.error?.message).toContain(CALL_LIMIT)
    expect(step.output).toBe('')
  })

  it('a program that prints more than a mebibyte in all is stopped', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        `format: .string "${'%1000d'.repeat(60)}"`,
        'main:',
        'sub rsp, 8',
        'again:',
        'lea rdi, format[rip]',
        'call printf@PLT',
        'jmp again',
        '',
      ].join('\n'),
      { maxSteps: 1000 },
    )
    const run = emulator.run()
    expect(run.reason).toBe('error')
    const state = emulator.getSnapshot()
    // 17 calls printed 60 000 characters each. The 18th would go past the limit.
    expect(state.output.length).toBe(17 * 60_000)
    expect(state.error?.message).toBe(
      "Line 7: `printf` tried to print 60,000 characters, but that would make the program's output longer than 1,048,576 characters. So this emulator stopped the program. Check for a loop that prints and never ends.",
    )
  })

  it('the message says what the call tried to do: the program has printed less than the limit', () => {
    // puts prints 4 001 characters each time (the text and a new line).
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        `big: .string "${'B'.repeat(4000)}"`,
        'main:',
        'push rbx',
        'mov ebx, 400',
        'again:',
        'lea rdi, big[rip]',
        'call puts@PLT',
        'dec ebx',
        'jnz again',
        'pop rbx',
        'ret',
        '',
      ].join('\n'),
      { maxSteps: 100_000 },
    )
    const run = emulator.run()
    expect(run.reason).toBe('error')
    const state = emulator.getSnapshot()
    expect(state.output.length).toBe(262 * 4001)
    expect(state.output.length).toBeLessThan(1 << 20)
    const step = state.lastStep
    expect(step?.kind).toBe('library')
    expect(step?.output).toBe('')
    expect(state.error?.code).toBe('library-error')
    expect(state.error?.message).toBe(
      "Line 8: `puts` tried to print 4,001 characters, but that would make the program's output longer than 1,048,576 characters. So this emulator stopped the program. Check for a loop that prints and never ends.",
    )
    expect(step?.explanation).toBe(
      "`puts` (library code) stopped with an error before it changed anything. `puts` tried to print 4,001 characters, but that would make the program's output longer than 1,048,576 characters.",
    )
    for (const text of [state.error?.message, step?.explanation]) {
      expect(text).not.toMatch(/has printed|in all/)
    }
  })
})

/* ───────────────────────────── scanf over its own return address ───────────────────────────── */

describe('scanf that stores over its own return address', () => {
  it('returns to the value it stored, as a real machine would, and says what went wrong', () => {
    // rsi points at the box where the `call` will save the return address.
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%ld"',
        'main:',
        'sub rsp, 8',
        'lea rsi, -8[rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
      { stdin: '5\n' },
    )
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('error')
    expect(step.error?.code).toBe('bad-jump')
    expect(step.error?.message).toBe(
      'Line 7: `scanf` stored a value over its own return address on the stack, so it tried to return to 0x5, but that is not an instruction. Check the addresses you gave `scanf`: each one must point at a variable.',
    )
    expect(step.explanation).toContain('Then it returned: the value 0x5 was popped into rip')
  })
})

/* ───────────────────────────── M8 fixes ───────────────────────────── */

describe('M8: an address inside the code page that is not an instruction', () => {
  /** rdi (or rsi for `%s`) holds the address of `main` plus `offset`. */
  function pointing(offset: number, how: 'puts' | 'printf %s'): StepResult {
    const call =
      how === 'puts'
        ? ['lea rdi, main[rip]', `add rdi, ${offset}`, 'call puts@PLT']
        : [
            'lea rsi, main[rip]',
            `add rsi, ${offset}`,
            'lea rdi, format[rip]',
            'mov eax, 0',
            'call printf@PLT',
          ]
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'format: .string "%s"',
        'main:',
        '    push rbp',
        ...call.map((line) => `    ${line}`),
        '    pop rbp',
        '    ret',
        '',
      ].join('\n'),
    )
    return stepIntoLibrary(emulator)
  }

  it('calls it "the address of an instruction" only when an instruction starts there', () => {
    const atInstruction = pointing(1, 'puts') // `push rbp` is 1 byte: main + 1 is the next one
    expect(atInstruction.error?.message).toContain(
      'but rdi holds 0x401127, which is the address of an instruction.',
    )
    const inCode = pointing(0x400, 'puts')
    expect(inCode.error?.code).toBe('library-error')
    expect(inCode.error?.message).toContain(
      'but rdi holds 0x401526, which is an address inside the code of the program.',
    )
    expect(inCode.error?.message).not.toContain('address of an instruction')
  })

  it('says the same for a `%s` value', () => {
    expect(pointing(0, 'printf %s').error?.message).toContain(
      'rsi holds 0x401126, which is the address of an instruction.',
    )
    expect(pointing(0x400, 'printf %s').error?.message).toContain(
      'rsi holds 0x401526, which is an address inside the code of the program.',
    )
  })
})

describe('M8: the output limits count real characters (an emoji is one)', () => {
  it('one call may print 33 000 emoji (66 000 UTF-16 units): they are 33 000 characters', () => {
    const emoji = '😀'.repeat(1000)
    const emulator = emulatorForTexts(emoji, 33)
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('running')
    expect([...step.output]).toHaveLength(33_000)
    expect(step.explanation).toContain('printed 33000 characters (132000 bytes)')
  })

  it('more than 65 536 emoji in one call is still too much, and the message is true', () => {
    const emulator = emulatorForTexts('😀'.repeat(1000), 66)
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('error')
    expect(step.error?.message).toContain(
      '`printf` tried to print more than 65,536 characters in one call.',
    )
    expect(step.output).toBe('')
  })

  it('the limit for the whole program counts emoji once each too', () => {
    // Each puts prints 1 001 characters (1 000 emoji and a new line) but 2 001 UTF-16
    // units. 1 047 calls make 1 048 047 characters; the 1 048th would pass 1 048 576.
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        `big: .string "${'😀'.repeat(1000)}"`,
        'main:',
        'push rbx',
        'mov ebx, 2000',
        'again:',
        'lea rdi, big[rip]',
        'call puts@PLT',
        'dec ebx',
        'jnz again',
        'pop rbx',
        'ret',
        '',
      ].join('\n'),
      { maxSteps: 100_000 },
    )
    expect(emulator.run().reason).toBe('error')
    const state = emulator.getSnapshot()
    expect(state.output.split('\n').length - 1).toBe(1047)
    expect(state.error?.message).toContain(
      '`puts` tried to print 1,001 characters, but that would make the program',
    )
    // Stepping back over the stopped call and the calls before it keeps the count right.
    for (let i = 0; i < 6; i++) emulator.stepBack()
    expect(emulator.run().reason).toBe('error')
    expect(emulator.getSnapshot().output.split('\n').length - 1).toBe(1047)
  })

  /** printf with `count` × `%s`, each the address of `text` (5 in registers, the rest on the stack). */
  function emulatorForTexts(text: string, count: number): Emulator {
    const onStack = Math.max(0, count - 5)
    return emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        `big: .string "${text}"`,
        '.text',
        `format: .string "${'%s'.repeat(count)}"`,
        'main:',
        'push rbp',
        'mov rbp, rsp',
        ...(onStack % 2 === 1 ? ['sub rsp, 8'] : []),
        'lea rax, big[rip]',
        ...Array.from({ length: onStack }, () => 'push rax'),
        'lea rsi, big[rip]',
        'mov rdx, rsi',
        'mov rcx, rsi',
        'mov r8, rsi',
        'mov r9, rsi',
        'lea rdi, format[rip]',
        'mov eax, 0',
        'call printf@PLT',
        'leave',
        'ret',
        '',
      ].join('\n'),
    )
  }
})

describe('M8: puts with text outside ASCII says how many bytes it printed', () => {
  it('eax counts bytes, and the explanation says so', () => {
    const emulator = emulatorFor(
      '.intel_syntax noprefix\nm: .string "héé"\nmain:\n    push rbp\n    lea rdi, m[rip]\n    call puts@PLT\n    pop rbp\n    ret\n',
    )
    const step = stepIntoLibrary(emulator)
    expect(step.explanation).toContain(
      '`puts` (library code) printed 4 characters (the text and a new line, 6 bytes), so eax = 0x6.',
    )
    expect(emulator.readRegister('eax')).toBe(6n)
  })

  it('plain ASCII needs no byte count', () => {
    const emulator = emulatorFor(
      '.intel_syntax noprefix\nm: .string "hi"\nmain:\n    push rbp\n    lea rdi, m[rip]\n    call puts@PLT\n    pop rbp\n    ret\n',
    )
    expect(stepIntoLibrary(emulator).explanation).toContain(
      'printed 3 characters (the text and a new line), so eax = 0x3.',
    )
  })
})

describe('M8: the exit code the shell sees', () => {
  it.each([
    ['7', 'The exit code is 7, the value in edi.'],
    ['255', 'The exit code is 255, the value in edi.'],
    ['300', 'edi holds 300, so the exit code is 44: the shell sees only the lowest 8 bits.'],
    ['-1', 'edi holds -1, so the exit code is 255: the shell sees only the lowest 8 bits.'],
    ['256', 'edi holds 256, so the exit code is 0: the shell sees only the lowest 8 bits.'],
  ])('exit with edi = %s', (value, sentence) => {
    const emulator = emulatorFor(
      `.intel_syntax noprefix\nmain:\n    push rbp\n    mov edi, ${value}\n    call exit@PLT\n`,
    )
    const step = stepIntoLibrary(emulator)
    expect(step.status).toBe('halted')
    expect(step.explanation).toBe(`\`exit\` (library code) ended the program. ${sentence}`)
  })
})

describe('M8: scanf with many values names three and counts the rest', () => {
  it('7 numbers', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'f: .string "%d %d %d %d %d %d %d"',
        'main:',
        '    push rbp',
        '    mov rbp, rsp',
        '    sub rsp, 64',
        '    lea rdi, f[rip]',
        '    lea rsi, -8[rbp]',
        '    lea rdx, -16[rbp]',
        '    lea rcx, -24[rbp]',
        '    lea r8, -32[rbp]',
        '    lea r9, -40[rbp]',
        '    lea rax, -48[rbp]',
        '    mov qword ptr [rsp], rax',
        '    lea rax, -56[rbp]',
        '    mov qword ptr 8[rsp], rax',
        '    mov eax, 0',
        '    call scanf@PLT',
        '    leave',
        '    ret',
        '',
      ].join('\n'),
      { stdin: '1 2 3 4 5 6 7\n' },
    )
    const step = stepIntoLibrary(emulator)
    expect(step.explanation).toContain(
      '`scanf` (library code) read 7 numbers, 1, 2, 3 and 4 more, and stored them at 0x…dfe8, 0x…dfe0, 0x…dfd8 and 4 more, so eax = 0x7, the number of values it stored.',
    )
  })

  it('4 numbers are all named', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'f: .string "%d %d %d %d"',
        'main:',
        '    push rbp',
        '    mov rbp, rsp',
        '    sub rsp, 32',
        '    lea rdi, f[rip]',
        '    lea rsi, -8[rbp]',
        '    lea rdx, -16[rbp]',
        '    lea rcx, -24[rbp]',
        '    lea r8, -32[rbp]',
        '    mov eax, 0',
        '    call scanf@PLT',
        '    leave',
        '    ret',
        '',
      ].join('\n'),
      { stdin: '1 2 3 4\n' },
    )
    expect(stepIntoLibrary(emulator).explanation).toContain(
      'read 4 numbers, 1, 2, 3 and 4, and stored them at 0x…dfe8, 0x…dfe0, 0x…dfd8 and 0x…dfd0',
    )
  })
})
