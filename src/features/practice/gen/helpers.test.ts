import { describe, expect, it } from 'vitest'
import { createRng } from '../../../lib/rng'
import { checkProblem } from '../check'
import type { Problem } from '../types'
import {
  answerIs,
  canonicalHex,
  chipField,
  choiceField,
  codeBlock,
  decimalField,
  decimalSlip,
  FREE_REGISTERS,
  hexField,
  instructionAtLine,
  lineAddresses,
  pickRegisters,
  random64,
  readAsHex,
  registersBlock,
  runProgram,
  show,
  show64,
  SMALL_WORLD,
  smallWorld,
  stackBlock,
  stepAtLine,
  textBlock,
  textField,
} from './helpers'

describe('numbers as text', () => {
  it('shows values the way a question prints them', () => {
    expect(show(0x1f8n)).toBe('0x1f8')
    expect(show(0n)).toBe('0x0')
    expect(show64(9n)).toBe('0x0000000000000009')
    expect(show64(0x1111222233334444n)).toBe('0x1111222233334444')
  })

  it('gives the canonical form the checker compares against', () => {
    expect(canonicalHex(0x1f8n)).toBe('1f8')
    expect(canonicalHex(0n)).toBe('0')
    expect(canonicalHex(0xabcdefn)).toBe('abcdef')
    expect(canonicalHex(-1n)).toBe('ffffffffffffffff')
  })

  it('compares a canonical answer with a value', () => {
    expect(answerIs('1f8', 0x1f8n)).toBe(true)
    expect(answerIs('1f8', 0x208n)).toBe(false)
    expect(answerIs('', 0n)).toBe(false)
    expect(answerIs(undefined, 0n)).toBe(false)
    expect(answerIs('0', 0n)).toBe(true)
  })
})

describe('fields work with checkProblem', () => {
  function problemWith(fields: Problem['fields']): Problem {
    return {
      id: 'rip-1',
      topic: 'rip',
      seed: 1,
      view: 'form',
      prompt: [textBlock('A test problem.')],
      fields,
      reason: 'A reason.',
      stepper: { code: 'ret\n' },
      diagnose: () => null,
    }
  }

  it('hex field without a digit rule', () => {
    const field = hexField('rsp', 'rsp after step 1', 0x1f8n)
    expect(field).toEqual({
      id: 'rsp',
      label: 'rsp after step 1',
      kind: { type: 'hex' },
      expected: '1f8',
      expectedDisplay: '0x1f8',
    })
    const problem = problemWith([field])
    expect(checkProblem(problem, { rsp: '0x1F8' }).correct).toBe(true)
    expect(checkProblem(problem, { rsp: '1f8' }).correct).toBe(true)
    expect(checkProblem(problem, { rsp: '0x208' }).correct).toBe(false)
  })

  it('hex field that wants all 16 digits', () => {
    const field = hexField('after', 'rdi', 9n, { digits: 16 })
    expect(field.kind).toEqual({ type: 'hex', digits: 16 })
    expect(field.expected).toBe('9')
    expect(field.expectedDisplay).toBe('0x0000000000000009')
    const problem = problemWith([field])
    expect(checkProblem(problem, { after: field.expectedDisplay }).correct).toBe(true)
    expect(checkProblem(problem, { after: '0x9' }).mistake?.code).toBe('missing-digits')
  })

  it('the expected text of every field kind is already canonical', () => {
    const fields = [
      hexField('a', 'a', 0xabcn),
      hexField('b', 'b', 0n, { digits: 16 }),
      textField('c', 'c', ' R9W '),
      decimalField('d', 'd', 16),
      decimalField('e', 'e', -8n),
      choiceField('f', 'f', [{ id: 'legal', label: 'Legal' }], 'legal'),
      chipField('g', 'g', { id: 'chip-1', label: 'rax = 0x0000000000000005' }),
    ]
    const answers: Record<string, string> = {}
    for (const field of fields) answers[field.id] = field.expectedDisplay
    // Choice and chip fields are answered with the id, not the label.
    answers.f = 'legal'
    answers.g = 'chip-1'
    const result = checkProblem(problemWith(fields), answers)
    expect(result.fields.filter((field) => !field.correct)).toEqual([])
    expect(result.correct).toBe(true)
    expect(fields[2].expected).toBe('r9w')
    expect(fields[4].expected).toBe('-8')
    expect(fields[6].expectedDisplay).toBe('rax = 0x0000000000000005')
  })

  it('choiceField refuses an expected id that is not a choice', () => {
    expect(() => choiceField('f', 'f', [{ id: 'legal', label: 'Legal' }], 'illegal')).toThrow()
  })
})

describe('prompt blocks', () => {
  it('code block with and without addresses', () => {
    expect(codeBlock(['push rbx', 'ret'])).toEqual({ type: 'code', lines: ['push rbx', 'ret'] })
    expect(codeBlock(['push rbx', 'ret'], [0x4000n, 0x4001n])).toEqual({
      type: 'code',
      lines: ['push rbx', 'ret'],
      addresses: ['0x4000', '0x4001'],
    })
    expect(() => codeBlock(['ret'], [])).toThrow()
  })

  it('registers block', () => {
    expect(registersBlock([{ name: 'rdi', value: 0x1111222233334444n }])).toEqual({
      type: 'registers',
      title: undefined,
      rows: [{ name: 'rdi', value: '0x1111222233334444' }],
    })
    expect(
      registersBlock([{ name: 'rsp', value: 0x200n }], { title: 'Before', short: true }),
    ).toEqual({ type: 'registers', title: 'Before', rows: [{ name: 'rsp', value: '0x200' }] })
  })

  it('stack block puts the highest address first', () => {
    const block = stackBlock([
      { address: 0x1f0n, value: 5n, marker: 'rsp' },
      { address: 0x200n, value: 7n, marker: 'rbp' },
      { address: 0x1f8n, value: 0x1f0n },
    ])
    expect(block).toEqual({
      type: 'stack',
      title: undefined,
      rows: [
        { address: '0x200', value: '0x7', marker: 'rbp' },
        { address: '0x1f8', value: '0x1f0', marker: undefined },
        { address: '0x1f0', value: '0x5', marker: 'rsp' },
      ],
    })
  })
})

describe('the classic decimal slips', () => {
  it('subtracting 8 in decimal', () => {
    expect(decimalSlip(0x200n, -8n)).toBe(0x192n)
    expect(decimalSlip(0x1000n, -8n)).toBe(0x992n)
    expect(decimalSlip(0x4009n, 8n)).toBe(0x4017n)
    expect(decimalSlip(0x100n, -16n)).toBe(0x84n)
  })

  it('is null when the slip gives the right answer anyway', () => {
    // 0x208 − 8 = 0x200 and 208 − 8 = 200: the same digits.
    expect(decimalSlip(0x208n, -8n)).toBeNull()
    expect(decimalSlip(0x10n, 1n)).toBeNull()
  })

  it('is null when the start has a letter digit or the result is negative', () => {
    expect(decimalSlip(0x1f8n, -8n)).toBeNull()
    expect(decimalSlip(0xa0n, 8n)).toBeNull()
    expect(decimalSlip(0x4n, -8n)).toBeNull()
    expect(decimalSlip(-8n, 8n)).toBeNull()
  })

  it('never returns the right answer', () => {
    for (let start = 0n; start < 0x1000n; start += 8n) {
      for (const change of [-48n, -16n, -8n, 8n, 16n, 24n]) {
        const slip = decimalSlip(start, change)
        if (slip !== null) expect(slip).not.toBe(start + change)
      }
    }
  })

  it('reading a decimal number as hex', () => {
    expect(readAsHex(16n)).toBe(0x16n)
    expect(readAsHex(32n)).toBe(0x32n)
    expect(readAsHex(48n)).toBe(0x48n)
    expect(readAsHex(8n)).toBeNull()
    expect(readAsHex(0n)).toBeNull()
    expect(readAsHex(-16n)).toBeNull()
  })
})

describe('random pieces', () => {
  it('pickRegisters gives different registers and never rsp or rbp', () => {
    expect(FREE_REGISTERS).toHaveLength(14)
    for (let seed = 0; seed < 200; seed++) {
      const picked = pickRegisters(createRng(seed), 4)
      expect(new Set(picked).size).toBe(4)
      expect(picked).not.toContain('rsp')
      expect(picked).not.toContain('rbp')
    }
    expect(pickRegisters(createRng(1), 2, ['rax', 'rbx'])).toHaveLength(2)
    expect(() => pickRegisters(createRng(1), 3, ['rax', 'rbx'])).toThrow()
  })

  it('pickRegisters is the same for the same seed', () => {
    expect(pickRegisters(createRng(42), 5)).toEqual(pickRegisters(createRng(42), 5))
  })

  it('random64 has 8 different bytes, none 0x00 or 0xff', () => {
    for (let seed = 0; seed < 500; seed++) {
      const value = random64(createRng(seed))
      const text = value.toString(16).padStart(16, '0')
      expect(text).toHaveLength(16)
      const bytes = text.match(/../g) ?? []
      expect(new Set(bytes).size).toBe(8)
      expect(bytes).not.toContain('00')
      expect(bytes).not.toContain('ff')
      expect(value >> 32n).not.toBe(0n)
    }
  })
})

describe('runProgram', () => {
  it('keeps the machine after every step', () => {
    const run = runProgram('    mov eax, 7\n    add eax, 3\n    ret\n')
    expect(run.steps).toHaveLength(3)
    expect(run.start.stepCount).toBe(0)
    expect(run.steps[0].after.registers.rax).toBe(7n)
    expect(run.steps[1].after.registers.rax).toBe(10n)
    expect(run.steps[0].result.line).toBe(1)
    expect(run.steps[1].result.text).toContain('add')
    expect(run.end.status).toBe('halted')
    expect(run.end.registers.rax).toBe(10n)
    expect(run.emulator.readRegister('al')).toBe(10n)
  })

  it('applies the starting registers', () => {
    const run = runProgram('    mov edi, 9\n    ret\n', {
      initialRegisters: { rdi: 0x1111222233334444n },
    })
    expect(run.start.registers.rdi).toBe(0x1111222233334444n)
    expect(run.steps[0].after.registers.rdi).toBe(9n)
  })

  it('throws with the message when the program does not assemble', () => {
    expect(() => runProgram('    mov [rax], [rbx]\n    ret\n')).toThrow(/did not assemble/)
    expect(() => runProgram('    mov [rax], [rbx]\n    ret\n')).toThrow(/memory into memory/)
  })

  it('throws when the program does not end cleanly', () => {
    expect(() => runProgram('    mov rax, [rbx]\n    ret\n')).toThrow(/did not end cleanly/)
    expect(() => runProgram('top:\n    jmp top\n')).toThrow(/did not end cleanly/)
  })

  it('can stop early when asked', () => {
    const run = runProgram(
      'top:\n    inc eax\n    jmp top\n',
      {},
      {
        maxSteps: 6,
        allowUnfinished: true,
      },
    )
    expect(run.steps).toHaveLength(6)
    expect(run.end.status).toBe('running')
    expect(run.end.registers.rax).toBe(3n)

    const faulting = runProgram('    mov rax, [rbx]\n    ret\n', {}, { allowUnfinished: true })
    expect(faulting.end.status).toBe('error')
  })

  it('finds the instruction on a line', () => {
    const run = runProgram('main:\n    mov eax, 7\n\n    ret\n')
    expect(instructionAtLine(run.program, 2).mnemonic).toBe('mov')
    expect(instructionAtLine(run.program, 4).mnemonic).toBe('ret')
    expect(() => instructionAtLine(run.program, 3)).toThrow()
  })
})

describe('a listing with an address column', () => {
  // main at 0x4000: mov edi, 5 (5 bytes), call helper (5), ret (1); helper at 0x400b.
  const lines = ['main:', '    mov edi, 5', '    call helper', '    ret', 'helper:', '    ret']
  const run = runProgram(`${lines.join('\n')}\n`, smallWorld())

  it('gives each line the address of its instruction, and a label line the address of its label', () => {
    expect(lineAddresses(run.program, lines)).toEqual([
      0x4000n,
      0x4000n,
      0x4005n,
      0x400an,
      0x400bn,
      0x400bn,
    ])
    // Only the first lines of the program may be listed.
    expect(lineAddresses(run.program, lines.slice(0, 3))).toEqual([0x4000n, 0x4000n, 0x4005n])
  })

  it('refuses a line that has no address (a directive, a blank line)', () => {
    const source = ['    .intel_syntax noprefix', 'main:', '    ret']
    const program = runProgram(`${source.join('\n')}\n`, smallWorld()).program
    expect(() => lineAddresses(program, source)).toThrow(/Line 1 of the listing has no address/)
    const withBlank = ['main:', '', '    ret']
    const blankRun = runProgram(`${withBlank.join('\n')}\n`, smallWorld())
    expect(() => lineAddresses(blankRun.program, withBlank)).toThrow(/Line 2 of the listing/)
  })

  it('finds the step that ran a line (the first time it ran)', () => {
    // Steps: mov (line 2), call (line 3), helper's ret (line 6), main's ret (line 4).
    expect(stepAtLine(run, 2)).toBe(0)
    expect(stepAtLine(run, 3)).toBe(1)
    expect(stepAtLine(run, 6)).toBe(2)
    expect(stepAtLine(run, 4)).toBe(3)
    expect(() => stepAtLine(run, 1)).toThrow(/Line 1 never ran/)
    expect(() => stepAtLine(run, 99)).toThrow(/Line 99 never ran/)
  })

  it('finds the first run of a line that runs twice', () => {
    const loop = runProgram(
      ['    mov ecx, 2', 'top:', '    dec ecx', '    jnz top', '    ret', ''].join('\n'),
      smallWorld(),
    )
    // mov, dec, jnz, dec, jnz, ret: line 3 first ran in step index 1.
    expect(stepAtLine(loop, 3)).toBe(1)
    expect(loop.steps.filter((step) => step.result.line === 3)).toHaveLength(2)
  })
})

describe('the small world', () => {
  it('has short addresses everywhere', () => {
    const run = runProgram(
      [
        'main:',
        '    push rbx',
        '    call helper',
        '    pop rbx',
        '    ret',
        'helper:',
        '    ret',
        '',
      ].join('\n'),
      smallWorld(),
    )
    expect(run.start.registers.rsp).toBe(0x1f8n)
    expect(run.start.rip).toBe(0x4000n)
    // push: 0x1f8 − 8
    expect(run.steps[0].after.registers.rsp).toBe(0x1f0n)
    // call: another 8 down, and rip is now inside the helper
    expect(run.steps[1].after.registers.rsp).toBe(0x1e8n)
    expect(run.steps[1].after.rip).toBeGreaterThan(0x4000n)
    expect(run.steps[1].after.rip).toBeLessThan(0x4100n)
    expect(run.end.status).toBe('halted')
    expect(run.end.registers.rsp).toBe(0x200n)
  })

  it('starts rsp at an address that ends in 8, so an aligned call gets no alignment note', () => {
    expect(SMALL_WORLD.initialRsp % 16n).toBe(8n)
    // `main` keeps the stack aligned the usual way (push rbp), then calls a library
    // function: the stepper warns when rsp is not a multiple of 16 at such a call.
    const source = [
      'main:',
      '    push rbp',
      '    mov edi, 65',
      '    call putchar@PLT',
      '    pop rbp',
      '    ret',
      '',
    ].join('\n')
    const alignmentNotes = (rsp?: bigint) =>
      runProgram(source, smallWorld({ rsp }))
        .steps.flatMap((step) => step.result.notes.map((note) => note.text))
        .filter((text) => text.includes('multiple of 16'))

    const run = runProgram(source, smallWorld())
    expect(run.steps[0].after.registers.rsp % 16n).toBe(0n)
    expect(run.end.output).toBe('A')
    expect(alignmentNotes()).toEqual([])
    // The old start (0x200, ending in 0) made the same correct program look misaligned.
    expect(alignmentNotes(0x200n)).toHaveLength(1)
  })

  it('takes another code address and another rsp', () => {
    const run = runProgram(
      '    push rax\n    pop rax\n    ret\n',
      smallWorld({ textBase: 0x4a30n, rsp: 0xff8n }),
    )
    expect(run.start.rip).toBe(0x4a30n)
    expect(run.start.registers.rsp).toBe(0xff8n)
    expect(run.steps[0].after.registers.rsp).toBe(0xff0n)
    expect(run.end.status).toBe('halted')
  })

  it('lets extra options through', () => {
    const options = smallWorld({
      rsp: 0x300n,
      extra: {
        initialRegisters: { rbp: 0x320n },
        initialMemory: [{ address: 0x318n, bytes: 8, value: 0x2an, label: 'x' }],
      },
    })
    const run = runProgram('    mov rax, -8[rbp]\n    lea rcx, -8[rbp]\n    ret\n', options)
    expect(run.steps[0].after.registers.rax).toBe(0x2an)
    expect(run.steps[1].after.registers.rcx).toBe(0x318n)
    expect(options.clobberCallerSaved).toBe(false)
    expect(options.stackBase).toBe(SMALL_WORLD.stackBase)
  })

  it('can go down to the lowest allowed rsp', () => {
    const run = runProgram(
      '    push rax\n    push rax\n    add rsp, 16\n    ret\n',
      smallWorld({ rsp: 0x100n }),
    )
    expect(run.steps[1].after.registers.rsp).toBe(0xf0n)
    expect(run.end.status).toBe('halted')
  })
})
