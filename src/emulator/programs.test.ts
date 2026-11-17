/**
 * Whole programs.
 *
 * - Every program of the Examples menu runs to the end and prints exactly its
 *   `expectedOutput` (that output was confirmed on a real x86-64 CPU).
 * - Programs of the kind students write: loops, functions, locals, recursion.
 * - Properties that must hold for ANY program, checked on the examples and on random
 *   programs from the CPU fixture: `run()` equals stepping, `stepBack()` brings back
 *   every earlier state, and every explanation follows the rules.
 */
import { describe, expect, it } from 'vitest'
import { EXAMPLES, exampleById } from '../examples'
import { createEmulator, type Emulator } from './index'
import type { EmulatorOptions, MachineState, StepResult } from './types'

/* ───────────────────────────── helpers ───────────────────────────── */

const RSP0 = 0x7ffffffddff8n

function emulatorFor(text: string, options?: EmulatorOptions): Emulator {
  const made = createEmulator(text, options)
  if (!made.ok) throw new Error(made.diagnostics.map((item) => item.message).join('\n'))
  return made.emulator
}

/** The example with this id, as an emulator that already has its input. */
function exampleEmulator(id: string, options: EmulatorOptions = {}): Emulator {
  const example = exampleById(id)
  if (example === undefined) throw new Error(`no example called ${id}`)
  return emulatorFor(example.source, { stdin: example.stdin, ...options })
}

/** Step to the end and give back every step that ran. */
function allSteps(emulator: Emulator, limit = 5000): StepResult[] {
  const results: StepResult[] = []
  for (let i = 0; i < limit; i++) {
    const step = emulator.step()
    if (!step.executed) break
    results.push(step)
  }
  return results
}

function withoutVersion(state: MachineState): Omit<MachineState, 'version'> {
  const { version: _version, ...rest } = state
  return rest
}

/** How many sentences a text has. Code in backticks does not count. */
function sentenceCount(text: string): number {
  const plain = text.replace(/`[^`]*`/g, 'code')
  return (plain.match(/[.?!](?=\s|$)/g) ?? []).length
}

/** The rules every explanation follows (contract, section 8). */
function checkExplanation(step: StepResult): void {
  const where = `${step.text} → ${step.explanation}`
  if (step.kind === 'library') {
    expect(step.text, where).toMatch(/^(printf|scanf|puts|putchar|exit) \(library code\)$/)
    // The function name is code, so the explanation puts it in backticks: "`printf` (library code)".
    const name = step.text.split(' ')[0]
    expect(step.explanation.startsWith(`\`${name}\` (library code)`), where).toBe(true)
  } else {
    expect(step.explanation.startsWith(`\`${step.text}\`: `), where).toBe(true)
  }
  const count = sentenceCount(step.explanation)
  expect(count, where).toBeGreaterThanOrEqual(1)
  expect(count, where).toBeLessThanOrEqual(3)
  expect(step.explanation, where).not.toMatch(/undefined|NaN|\[object|\$\{|null/)
  expect(step.explanation, where).toMatch(/0x[0-9a-f…]|line \d|nothing|marker/)
}

/* ───────────────────────────── the Examples menu ───────────────────────────── */

describe('every example program', () => {
  it('there are ten of them, with different ids', () => {
    expect(EXAMPLES).toHaveLength(10)
    expect(new Set(EXAMPLES.map((example) => example.id)).size).toBe(10)
  })

  it.each(EXAMPLES)('$id runs to the end and prints exactly its expected output', (example) => {
    const made = createEmulator(example.source, { stdin: example.stdin })
    expect(made.diagnostics).toEqual([])
    if (!made.ok) throw new Error('the example does not assemble')
    const run = made.emulator.run()
    const state = made.emulator.getSnapshot()
    expect(run.reason, state.error?.message).toBe('halted')
    expect(state.status).toBe('halted')
    expect(state.output).toBe(example.expectedOutput)
    expect(state.error).toBeNull()
    // main returns 0, and the stack is back where it started (one box above, after `ret`).
    expect(state.registers.rax).toBe(0n)
    expect(state.registers.rsp).toBe(RSP0 + 8n)
    expect(state.callStack).toEqual([])
  })

  it.each(EXAMPLES)('$id: stepping gives the same end state as run()', (example) => {
    const stepped = emulatorFor(example.source, { stdin: example.stdin })
    const results = allSteps(stepped)
    const ran = emulatorFor(example.source, { stdin: example.stdin })
    const run = ran.run()
    expect(run.stepsRun).toBe(results.length)
    expect(withoutVersion(stepped.getSnapshot())).toEqual(withoutVersion(ran.getSnapshot()))
    expect(results.map((step) => step.output).join('')).toBe(example.expectedOutput)
    expect(results.map((step) => step.stepNumber)).toEqual(results.map((_, i) => i + 1))
  })

  it.each(EXAMPLES)(
    '$id: a correct program has no warnings, only the junk-register tips',
    (example) => {
      const emulator = emulatorFor(example.source, { stdin: example.stdin })
      const results = allSteps(emulator)
      const notes = results.flatMap((step) => step.notes)
      expect(notes.filter((note) => note.kind === 'warning')).toEqual([])
      const libraryReturns = results.filter(
        (step) => step.kind === 'library' && step.status === 'running',
      )
      expect(notes).toHaveLength(libraryReturns.length)
      expect(notes.every((note) => note.kind === 'tip' && note.text.includes('r11'))).toBe(true)
    },
  )

  it.each(EXAMPLES)('$id: every explanation follows the rules', (example) => {
    const emulator = emulatorFor(example.source, { stdin: example.stdin })
    const results = allSteps(emulator)
    expect(results.length).toBeGreaterThan(5)
    for (const step of results) checkExplanation(step)
    expect(results.at(-1)?.explanation).toMatch(/program ended/)
  })

  it.each(EXAMPLES)('$id: stepBack brings back every earlier state', (example) => {
    const emulator = emulatorFor(example.source, { stdin: example.stdin })
    const states = [emulator.getSnapshot()]
    const results = allSteps(emulator)
    // Walk forward again from the start to collect the state after each step.
    emulator.reset()
    states.length = 0
    states.push(emulator.getSnapshot())
    for (let i = 0; i < results.length; i++) {
      emulator.step()
      states.push(emulator.getSnapshot())
    }
    for (let i = results.length - 1; i >= 0; i--) {
      expect(emulator.stepBack()).toBe(true)
      expect(withoutVersion(emulator.getSnapshot()), `back to step ${i}`).toEqual(
        withoutVersion(states[i]),
      )
    }
    expect(emulator.stepBack()).toBe(false)
    // And forward once more: the same steps, word for word.
    expect(allSteps(emulator)).toEqual(results)
  })

  it.each(EXAMPLES.filter((example) => example.stdin !== undefined))(
    '$id waits for input, then goes on when the input is given',
    (example) => {
      const emulator = emulatorFor(example.source)
      const first = emulator.run()
      expect(first.reason).toBe('waiting-input')
      const waiting = emulator.getSnapshot()
      expect(waiting.status).toBe('waiting-input')
      expect(waiting.inputRequest?.prompt).toMatch(/\w/)
      expect(waiting.inLibrary?.name).toBe('scanf')

      emulator.provideInput(example.stdin ?? '')
      expect(emulator.getSnapshot().status).toBe('running')
      const second = emulator.run()
      expect(second.reason).toBe('halted')
      expect(emulator.getSnapshot().output).toBe(example.expectedOutput)
    },
  )

  it.each(EXAMPLES)('$id runs the same with the caller-saved junk turned off', (example) => {
    const emulator = emulatorFor(example.source, {
      stdin: example.stdin,
      clobberCallerSaved: false,
    })
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe(example.expectedOutput)
  })
})

describe('what the examples show', () => {
  it('hello-count: printf leaves 13 in eax, and the program prints it', () => {
    const emulator = exampleEmulator('hello-count')
    const results = allSteps(emulator)
    const [first, second] = results.filter((step) => step.kind === 'library')
    expect(first.output).toBe('Hello World!\n')
    expect(first.diff.registers.find((change) => change.reg === 'rax')?.after).toBe(13n)
    expect(second.output).toBe('printf printed 13 characters.\n')
    expect(second.diff.registers.find((change) => change.reg === 'rax')?.after).toBe(30n)
  })

  it('push-pop: the same order swaps, the reverse order restores', () => {
    const emulator = exampleEmulator('push-pop')
    const registers = (): [bigint, bigint] => [
      emulator.readRegister('rax'),
      emulator.readRegister('rcx'),
    ]
    for (let i = 0; i < 2; i++) emulator.step()
    expect(registers()).toEqual([1n, 2n])
    for (let i = 0; i < 4; i++) emulator.step()
    expect(registers()).toEqual([2n, 1n])
    for (let i = 0; i < 4; i++) emulator.step()
    expect(registers()).toEqual([100n, 200n])
    for (let i = 0; i < 2; i++) emulator.step()
    expect(registers()).toEqual([2n, 1n])
    expect(emulator.readRegister('rsp')).toBe(RSP0)
  })

  it('locals: two named boxes below rbp', () => {
    const emulator = exampleEmulator('locals')
    for (let i = 0; i < 7; i++) emulator.step()
    const state = emulator.getSnapshot()
    const labelled = state.stack.filter((slot) => slot.kind === 'local')
    expect(labelled.map((slot) => [slot.label, slot.value])).toEqual([
      ['count', 5n],
      ['total', 105n],
    ])
    expect(state.stack.find((slot) => slot.isRbp)?.label).toBe('saved rbp')
  })

  it('sum-loop: the loop runs ten times and the sum is 55', () => {
    const emulator = exampleEmulator('sum-loop')
    const results = allSteps(emulator)
    const adds = results.filter((step) => step.text === 'add eax, ecx')
    expect(adds).toHaveLength(10)
    expect(adds.at(-1)?.diff.registers).toEqual([{ reg: 'rax', before: 45n, after: 55n }])
    const jumps = results.filter((step) => step.text === 'jg loop_end')
    expect(jumps).toHaveLength(11)
    expect(jumps.filter((step) => step.explanation.includes('did not jump'))).toHaveLength(10)
    expect(jumps.at(-1)?.explanation).toContain('jumped to `loop_end`')
  })

  it('factorial and power: imul inside a loop', () => {
    const factorial = exampleEmulator('factorial')
    const products = allSteps(factorial)
      .filter((step) => step.text === 'imul eax, ecx')
      .map((step) => step.diff.registers[0]?.after)
    expect(products).toEqual([5n, 20n, 60n, 120n])

    const power = exampleEmulator('power')
    const powers = allSteps(power).filter((step) => step.text === 'imul eax, esi')
    expect(powers).toHaveLength(10)
    expect(powers.at(-1)?.diff.registers[0]?.after).toBe(1024n)
  })

  it('array-max: walks five numbers in memory and keeps the biggest', () => {
    const emulator = exampleEmulator('array-max')
    const results = allSteps(emulator)
    const reads = results.filter((step) => step.text === 'mov rdx, [rdi]')
    expect(reads.map((step) => step.diff.registers[0]?.after)).toEqual([7n, 41n, 3n, 25n])
    expect(emulator.getSnapshot().data[0]).toMatchObject({
      label: 'numbers',
      values: [12n, 7n, 41n, 3n, 25n],
      readOnly: false,
    })
  })

  it('nested-call: two return addresses are on the stack inside printf', () => {
    const emulator = exampleEmulator('nested-call')
    while (emulator.getSnapshot().inLibrary === null) emulator.step()
    const state = emulator.getSnapshot()
    expect(state.inLibrary).toEqual({ name: 'printf', callLine: 20 })
    expect(state.callStack.map((frame) => frame.functionName)).toEqual(['main', 'show_double'])
    expect(state.stack.map((slot) => slot.kind)).toEqual([
      'return-address',
      'saved-register',
      'return-address',
      'saved-register',
      'return-address',
    ])
    expect(state.stack.map((slot) => slot.label)).toEqual([
      expect.stringContaining('return address') as string,
      'saved rbp',
      'return address (back to line 29)',
      'saved rbp',
      'return address (back to line 21)',
    ])
  })

  it('read-number: scanf stores the number in the box named `number`', () => {
    const emulator = exampleEmulator('read-number')
    const results = allSteps(emulator)
    const scanf = results.find((step) => step.text === 'scanf (library code)')
    expect(scanf?.diff.memory).toEqual([
      { address: RSP0 - 16n, before: [null, null, null, null], after: [41, 0, 0, 0] },
    ])
    expect(scanf?.explanation).toContain('41')
    expect(emulator.getSnapshot().output).toBe('Type a number: 41 plus 1 is 42.\n')
  })

  it('read-number with other input', () => {
    const negative = exampleEmulator('read-number', { stdin: '-1\n' })
    negative.run()
    expect(negative.getSnapshot().output).toBe('Type a number: -1 plus 1 is 0.\n')
    const big = exampleEmulator('read-number', { stdin: '2147483647\n' })
    big.run()
    expect(big.getSnapshot().output).toBe('Type a number: 2147483647 plus 1 is -2147483648.\n')
  })
})

/* ───────────────────────────── programs students write ───────────────────────────── */

describe('programs of the kind students write', () => {
  it('recursive factorial: 6! = 720', () => {
    const emulator = emulatorFor(
      [
        '    .intel_syntax noprefix',
        '    .text',
        '    .globl main',
        'report: .string "6! = %d\\n"',
        '# factorial(n): n arrives in edi, the answer goes back in eax',
        'factorial:',
        '    push rbp',
        '    mov rbp, rsp',
        '    push rbx                 # rbx is saved: we use it across the call',
        '    sub rsp, 8               # keep rsp a multiple of 16',
        '    mov ebx, edi',
        '    cmp ebx, 1',
        '    jle base_case',
        '    lea edi, [rbx-1]',
        '    call factorial',
        '    imul eax, ebx',
        '    jmp done',
        'base_case:',
        '    mov eax, 1',
        'done:',
        '    add rsp, 8',
        '    pop rbx',
        '    pop rbp',
        '    ret',
        'main:',
        '    push rbp',
        '    mov rbp, rsp',
        '    mov edi, 6',
        '    call factorial',
        '    mov esi, eax',
        '    lea rdi, report[rip]',
        '    mov eax, 0',
        '    call printf@PLT',
        '    mov eax, 0',
        '    pop rbp',
        '    ret',
        '',
      ].join('\n'),
    )
    let deepest = 0
    const results: StepResult[] = []
    for (;;) {
      const step = emulator.step()
      if (!step.executed) break
      results.push(step)
      deepest = Math.max(deepest, emulator.getSnapshot().callStack.length)
    }
    expect(emulator.getSnapshot().output).toBe('6! = 720\n')
    expect(emulator.getSnapshot().status).toBe('halted')
    // main, then factorial six times.
    expect(deepest).toBe(7)
    expect(results.flatMap((step) => step.notes).filter((note) => note.kind === 'warning')).toEqual(
      [],
    )
  })

  it('sum of an array with an index register', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'values: .long 3, 1, 4, 1, 5, 9, 2, 6',
        '.equ COUNT, 8',
        '.text',
        'main:',
        '    lea rsi, values[rip]',
        '    mov ecx, 0',
        '    mov eax, 0',
        'next:',
        '    cmp ecx, COUNT',
        '    jae finished',
        '    add eax, [rsi+rcx*4]',
        '    inc ecx',
        '    jmp next',
        'finished:',
        '    ret',
        '',
      ].join('\n'),
    )
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.readRegister('eax')).toBe(31n)
    expect(emulator.readRegister('ecx')).toBe(8n)
  })

  it('counts the characters of a string, byte by byte', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'text: .string "assembly"',
        'main:',
        '    lea rdi, text[rip]',
        '    xor eax, eax',
        'again:',
        '    cmp byte ptr [rdi+rax], 0',
        '    je end',
        '    inc rax',
        '    jmp again',
        'end:',
        '    ret',
        '',
      ].join('\n'),
    )
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.readRegister('rax')).toBe(8n)
  })

  it('a swap of two variables in memory', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'first: .quad 111',
        'second: .quad 222',
        '.text',
        'main:',
        '    mov rax, first[rip]',
        '    mov rbx, second[rip]',
        '    mov first[rip], rbx',
        '    mov second[rip], rax',
        '    ret',
        '',
      ].join('\n'),
    )
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().data.map((view) => view.values)).toEqual([[222n], [111n]])
  })

  it('prints a triangle with putchar in two loops', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'main:',
        '    push rbx',
        '    push r12',
        '    sub rsp, 8',
        '    mov ebx, 1',
        'row:',
        '    cmp ebx, 3',
        '    jg stop',
        '    mov r12d, ebx',
        'star:',
        '    mov edi, 42',
        '    call putchar@PLT',
        '    dec r12d',
        '    jne star',
        '    mov edi, 10',
        '    call putchar@PLT',
        '    inc ebx',
        '    jmp row',
        'stop:',
        '    add rsp, 8',
        '    pop r12',
        '    pop rbx',
        '    mov eax, 0',
        '    ret',
        '',
      ].join('\n'),
    )
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe('*\n**\n***\n')
  })

  it('a loop counter in rcx does not survive printf (the classic bug)', () => {
    const text = [
      '.intel_syntax noprefix',
      'line: .string "x\\n"',
      'main:',
      '    sub rsp, 8',
      '    mov ecx, 3',
      'top:',
      '    lea rdi, line[rip]',
      '    mov eax, 0',
      '    call printf@PLT',
      '    dec ecx',
      '    jne top',
      '    add rsp, 8',
      '    ret',
      '',
    ].join('\n')
    // With the realistic junk the count is lost, and the loop does not stop after 3 lines.
    const real = emulatorFor(text, { maxSteps: 60 })
    expect(real.run().reason).toBe('step-limit')
    expect(real.getSnapshot().output.startsWith('x\nx\nx\nx\n')).toBe(true)
    // With the junk turned off the same program "works".
    const lucky = emulatorFor(text, { clobberCallerSaved: false })
    expect(lucky.run().reason).toBe('halted')
    expect(lucky.getSnapshot().output).toBe('x\nx\nx\n')
  })

  it('gcc-style output with directives the emulator skips', () => {
    const emulator = emulatorFor(
      [
        '\t.file\t"hello.c"',
        '\t.intel_syntax noprefix',
        '\t.text',
        '\t.section\t.rodata',
        '.LC0:',
        '\t.string\t"Hello"',
        '\t.text',
        '\t.globl\tmain',
        '\t.type\tmain, @function',
        'main:',
        '\tendbr64',
        '\tpush\trbp',
        '\tmov\trbp, rsp',
        '\tlea\trax, .LC0[rip]',
        '\tmov\trdi, rax',
        '\tcall\tputs@PLT',
        '\tmov\teax, 0',
        '\tpop\trbp',
        '\tret',
        '\t.size\tmain, .-main',
        '\t.ident\t"GCC: (GNU) 13.2.0"',
        '\t.section\t.note.GNU-stack,"",@progbits',
        '',
      ].join('\n'),
    )
    expect(emulator.run().reason).toBe('halted')
    expect(emulator.getSnapshot().output).toBe('Hello\n')
  })

  it('a practice problem with small addresses: where is rsp after two pushes and a call?', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'main:',
        'push rax',
        'push rbx',
        'call f',
        'ret',
        'f:',
        'ret',
        '',
      ].join('\n'),
      { textBase: 0x4000n, stackBase: 0x1000n, initialRsp: 0x200n, osReturnAddress: 0x3ff0n },
    )
    const rsp: bigint[] = []
    for (let i = 0; i < 4; i++) {
      emulator.step()
      rsp.push(emulator.readRegister('rsp'))
    }
    expect(rsp).toEqual([0x1f8n, 0x1f0n, 0x1e8n, 0x1f0n])
    expect(emulator.getSnapshot().rip).toBe(0x4007n)
    expect(emulator.readMemory(0x1e8n, 2)).toEqual([0x07, 0x40])
  })
})

/* ───────────────────────── random programs from a real CPU ───────────────────────── */

interface FuzzProgram {
  id: string
  body: string
}

// The same fixture `cpu-fuzz.test.ts` replays: random straight-line programs that a real
// CPU ran. Here they are used for properties that need many different instructions.
const fixtureFiles = import.meta.glob<string>('./__fixtures__/cpu-fuzz.json', {
  query: '?raw',
  import: 'default',
  eager: true,
})
const fixtureText = fixtureFiles['./__fixtures__/cpu-fuzz.json']

function fuzzPrograms(count: number): FuzzProgram[] {
  if (fixtureText === undefined) return []
  const data = JSON.parse(fixtureText) as { programs: FuzzProgram[] }
  // Every tenth program, so the sample covers the whole fixture.
  return data.programs.filter((_, index) => index % 10 === 0).slice(0, count)
}

function fuzzSource(body: string): string {
  return [
    '.intel_syntax noprefix',
    '.data',
    'scratch: .zero 256',
    '.text',
    'main:',
    body,
    '    ret',
    '',
  ].join('\n')
}

const sample = fuzzPrograms(60)

describe.skipIf(sample.length === 0)('properties on random programs', () => {
  it.each(sample)('$id: stepBack after every step brings back the exact state', (program) => {
    const emulator = emulatorFor(fuzzSource(program.body))
    const states = [emulator.getSnapshot()]
    const results = allSteps(emulator)
    expect(emulator.getSnapshot().status).toBe('halted')

    emulator.reset()
    for (let i = 0; i < results.length; i++) {
      const step = emulator.step()
      expect(step).toEqual(results[i])
      states.push(emulator.getSnapshot())
      // One step back and forward again lands in the same place.
      if (i % 7 === 0) {
        emulator.stepBack()
        expect(withoutVersion(emulator.getSnapshot())).toEqual(withoutVersion(states[i]))
        emulator.step()
        expect(withoutVersion(emulator.getSnapshot())).toEqual(withoutVersion(states[i + 1]))
      }
    }
    for (let i = results.length - 1; i >= 0; i--) emulator.stepBack()
    expect(withoutVersion(emulator.getSnapshot())).toEqual(withoutVersion(states[0]))
    expect(emulator.getSnapshot().canStepBack).toBe(false)
  })

  it.each(sample)('$id: the diff of every step is exactly what changed', (program) => {
    const emulator = emulatorFor(fuzzSource(program.body))
    let before = emulator.getSnapshot()
    for (;;) {
      const step = emulator.step()
      if (!step.executed) break
      const after = emulator.getSnapshot()
      checkExplanation(step)
      // Registers: the diff lists every register that differs, and no other.
      const changed = Object.keys(after.registers).filter(
        (name) =>
          after.registers[name as keyof typeof after.registers] !==
          before.registers[name as keyof typeof before.registers],
      )
      expect(step.diff.registers.map((change) => change.reg).sort()).toEqual(changed.sort())
      for (const change of step.diff.registers) {
        expect(change.before).toBe(before.registers[change.reg])
        expect(change.after).toBe(after.registers[change.reg])
        expect(step.diff.written.registers).toContain(change.reg)
      }
      for (const change of step.diff.flags) {
        expect(change.before).toBe(before.flags[change.flag])
        expect(change.after).toBe(after.flags[change.flag])
        expect(change.before).not.toBe(change.after)
        expect(step.diff.written.flags).toContain(change.flag)
      }
      const flagsChanged = (['CF', 'ZF', 'SF', 'OF'] as const).filter(
        (name) => after.flags[name] !== before.flags[name],
      )
      expect(step.diff.flags.map((change) => change.flag)).toEqual(flagsChanged)
      for (const change of step.diff.memory) {
        expect(emulator.readMemory(change.address, change.after.length)).toEqual(change.after)
        expect(change.before).not.toEqual(change.after)
      }
      expect(step.diff.rip).toEqual({ before: before.rip, after: after.rip })
      before = after
    }
    expect(before.status).toBe('halted')
  })
})
