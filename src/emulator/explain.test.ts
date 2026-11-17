/**
 * The words: explanations, notes, stack labels and run messages
 * (behaviour contract, sections 7 and 8).
 *
 * The tests check the FACTS a sentence must hold (the real numbers, the names, the key
 * words), not the exact wording, so the wording can be polished without breaking them.
 */
import { describe, expect, it } from 'vitest'
import { describeCondition, type JumpCondition } from './alu'
import {
  describeNumber,
  explainEnded,
  explainFault,
  explainWaiting,
  inputPrompt,
  joinExplanation,
  libraryStepText,
  MAX_SENTENCES,
  notesFor,
  osReturnLabel,
  runMessage,
  stackLabelText,
  type ExplainContext,
} from './explain'
import type { ScanKind } from './executor'
import { hex, hex64, shortAddress } from './format'
import { createEmulator, type Emulator } from './index'
import type { MissingValue } from './libc'
import {
  badMemoryRead,
  badMemoryWrite,
  internalProblem,
  libraryError,
  writeReadOnly,
} from './runtimeErrors'
import type { EmulatorOptions, StepResult } from './types'

/* ───────────────────────────── helpers ───────────────────────────── */

const RSP0 = 0x7ffffffddff8n
const TEXT = 0x401126n
const PATTERN = 0x1111222233334444n

/** Three header lines, then the given lines: the first given line is LINE 4. */
function source(...lines: string[]): string {
  return ['.intel_syntax noprefix', '.text', 'main:', ...lines, ''].join('\n')
}

function emulatorFor(text: string, options?: EmulatorOptions): Emulator {
  const made = createEmulator(text, options)
  if (!made.ok) throw new Error(made.diagnostics.map((item) => item.message).join('\n'))
  return made.emulator
}

/** Run every step of the program and give the results back. */
function allSteps(emulator: Emulator): StepResult[] {
  const results: StepResult[] = []
  for (let i = 0; i < 500; i++) {
    const step = emulator.step()
    if (!step.executed) break
    results.push(step)
  }
  return results
}

/** The results of running `source(...lines)` to the end. */
function stepsOf(lines: string[], options?: EmulatorOptions): StepResult[] {
  return allSteps(emulatorFor(source(...lines), options))
}

/** The explanation of the step whose instruction text is `text`. */
function explanationOf(results: StepResult[], text: string): string {
  const step = results.find((result) => result.text === text)
  if (step === undefined) throw new Error(`no step with the text ${text}`)
  return step.explanation
}

/** How many sentences a text has. Code in backticks does not count. */
function sentenceCount(text: string): number {
  const plain = text.replace(/`[^`]*`/g, 'code')
  return (plain.match(/[.?!](?=\s|$)/g) ?? []).length
}

const context: ExplainContext = {
  stackStart: 0x7fffffede000n,
  stackEnd: 0x7ffffffdf000n,
  textBase: TEXT,
  textEnd: TEXT + 0x40n,
}

/* ───────────────────────── numbers in the house style ───────────────────────── */

describe('describeNumber', () => {
  it.each<[bigint, 8 | 16 | 32 | 64, string]>([
    [0n, 64, '0x0'],
    [5n, 64, '0x5'],
    [9n, 64, '0x9'],
    [10n, 64, '0xa (10)'],
    [55n, 32, '0x37 (55)'],
    // 8 and 16 bits with the top bit set: both readings, so signed arithmetic can be followed.
    [255n, 8, '0xff (255 or -1)'],
    [0x80n, 8, '0x80 (128 or -128)'],
    [0x7fn, 8, '0x7f (127)'],
    [0xffn, 16, '0xff (255)'],
    [0xffn, 64, '0xff (255)'],
    [0xfffbn, 16, '0xfffb (65531 or -5)'],
    [99_999n, 64, '0x1869f (99999)'],
    [100_000n, 64, '0x186a0'],
    [0xffffffffn, 32, '0xffffffff (-1)'],
    [0xffffffffn, 64, '0xffffffff'],
    [0xfffffff7n, 32, '0xfffffff7 (-9)'],
    [0xffffffffffffffffn, 64, '0xffffffffffffffff (-1)'],
    [0x8000n, 16, '0x8000 (32768 or -32768)'],
    [0x7fffn, 16, '0x7fff (32767)'],
    [0x80000000n, 32, '0x80000000'],
    [0x1122334455667788n, 64, '0x1122334455667788'],
  ])('%s as a %s-bit value is %s', (value, size, expected) => {
    expect(describeNumber(value, size)).toBe(expected)
  })
})

/* ─────────────────────── the facts in each explanation ─────────────────────── */

describe('explanations: push, pop, call, ret', () => {
  it('push: rsp before and after, and the value pushed', () => {
    const [step] = stepsOf(['push rbx', 'pop rbx', 'ret'], { initialRegisters: { rbx: 5n } })
    expect(step.explanation.startsWith('`push rbx`:')).toBe(true)
    expect(step.explanation).toContain(shortAddress(RSP0))
    expect(step.explanation).toContain(shortAddress(RSP0 - 8n))
    expect(step.explanation).toContain('0x…dff8 → 0x…dff0')
    expect(step.explanation).toContain('0x5')
    expect(step.explanation).toContain('rbx')
    expect(step.explanation).toContain('rsp went down by 8')
    expect(step.explanation).toMatch(/top box/)
  })

  it('push of a number and of rsp itself', () => {
    const results = stepsOf(['push 100', 'push rsp', 'add rsp, 16', 'ret'])
    expect(results[0].explanation).toContain('0x64 (100)')
    expect(results[1].explanation).toContain(shortAddress(RSP0 - 8n))
    expect(results[1].explanation).toMatch(/old value of rsp/)
  })

  it('pop: the value popped, rsp before and after', () => {
    const results = stepsOf(['push rbx', 'pop rcx', 'ret'], { initialRegisters: { rbx: 0x2dn } })
    const text = results[1].explanation
    expect(text.startsWith('`pop rcx`:')).toBe(true)
    expect(text).toContain('0x2d (45)')
    expect(text).toContain('0x…dff0 → 0x…dff8')
    expect(text).toContain('rsp went up by 8')
    expect(text).toMatch(/not part of the stack/)
  })

  it('call: rsp before and after, the return address, and where it jumped', () => {
    const results = stepsOf(['call helper', 'ret', 'helper:', 'ret'])
    const text = results[0].explanation
    expect(text.startsWith('`call helper`:')).toBe(true)
    expect(text).toContain('0x…dff8 → 0x…dff0')
    expect(text).toContain(shortAddress(TEXT + 5n))
    expect(text).toContain('`helper`')
    expect(text).toContain('line 7')
    expect(text).toMatch(/return address/)
  })

  it('ret: the address popped into rip, rsp before and after, and the next line', () => {
    const results = stepsOf(['call helper', 'ret', 'helper:', 'ret'])
    const text = results[1].explanation
    expect(text.startsWith('`ret`:')).toBe(true)
    expect(text).toContain(shortAddress(TEXT + 5n))
    expect(text).toContain('0x…dff0 → 0x…dff8')
    expect(text).toContain('line 5')
    expect(text).toMatch(/rip/)
  })

  it('the step that ends the program says so, and gives the value in eax', () => {
    const results = stepsOf(['mov eax, 55', 'ret'])
    const text = results[1].explanation
    expect(text).toMatch(/program ended/)
    expect(text).toContain('`main` returned 0x37 (exit code 55), the value in eax.')
    // The address of the "OS" is not a stack or code address: it is written in full.
    expect(text).toContain('0x7ffff7c29d90')
    expect(text).toContain('0x…dff8 → 0x…e000')
  })

  it('the program ends because `ret` went back to the code that started main', () => {
    const [, end] = stepsOf(['mov eax, 3', 'ret'])
    expect(end.explanation).toContain(
      'This address goes back to the code that started `main`, so the program ended.',
    )
    // Not "because the address is outside the program": `push 5` / `ret` leaves it too.
    expect(end.explanation).not.toMatch(/outside the program/)

    const nameless = allSteps(
      emulatorFor(['.intel_syntax noprefix', 'start:', 'mov eax, 3', 'ret', ''].join('\n')),
    )
    expect(nameless[1].explanation).toContain(
      'This address goes back to the code that started the program, so the program ended.',
    )
    expect(nameless[1].explanation).toContain('The program returned 0x3 (exit code 3)')
  })

  it('a value that main returns is written in full, even when it looks like an address', () => {
    const [, end] = stepsOf(['mov eax, 0x40113a', 'ret'])
    expect(end.explanation).toContain('`main` returned 0x40113a, the value in eax.')
    expect(end.explanation).not.toContain('0x…113a')
  })

  it('ret says "the value", not "the return address", when no `call` saved it', () => {
    const results = stepsOf([
      'call f',
      'ret',
      'f:',
      'lea rax, there[rip]',
      'push rax',
      'ret',
      'there:',
      'ret',
    ])
    const wrong = results[3]
    expect(wrong.text).toBe('ret')
    expect(wrong.explanation).toMatch(
      /^`ret`: the value 0x…[0-9a-f]{4} was popped from the top box/,
    )
    expect(wrong.explanation).not.toContain('return address')
    expect(wrong.notes.map((note) => note.kind)).toEqual(['warning'])
    // The right one is still a return address.
    expect(results[4].explanation).toMatch(/^`ret`: the return address 0x…/)
  })

  it('leave: both steps of it, with the numbers', () => {
    const results = stepsOf(['push rbp', 'mov rbp, rsp', 'sub rsp, 32', 'leave', 'ret'], {
      initialRegisters: { rbp: 0x77n },
    })
    const text = results[3].explanation
    expect(text.startsWith('`leave`:')).toBe(true)
    expect(text).toContain(shortAddress(RSP0 - 8n))
    expect(text).toContain('0x77 (119)')
    expect(text).toContain('0x…dff0 → 0x…dff8')
    // The old rsp is shown too, so the freed local boxes can be seen; and "copied", as for mov.
    expect(text).toContain("first rbp's value, 0x…dff0, was copied into rsp (rsp was 0x…dfd0).")
    expect(text).toContain('was copied into rbp, and rsp went up by 8')
  })

  it('call and the library step name the line the return address goes back to', () => {
    const results = allSteps(
      emulatorFor(
        [
          '.intel_syntax noprefix',
          'message: .string "hi"',
          'main:',
          'sub rsp, 8',
          'lea rdi, message[rip]',
          'call printf@PLT',
          'add rsp, 8',
          'ret',
          '',
        ].join('\n'),
      ),
    )
    const [call, library] = [results[2], results[3]]
    expect(call.explanation).toContain(
      `the return address ${shortAddress(TEXT + 16n)} (line 7, the next instruction) was saved in the new top box`,
    )
    expect(call.explanation).toContain(
      'Then the program jumped into the library function `printf`.',
    )
    expect(library.explanation).toContain(
      `Then it returned to line 7: the return address ${shortAddress(TEXT + 16n)} was popped into rip`,
    )
  })
})

describe('explanations: mov, movzx, movsx, lea', () => {
  it('mov into a register: the new value', () => {
    const results = stepsOf(['mov rax, 0x1234', 'mov rbx, rax', 'ret'])
    expect(results[0].explanation).toBe('`mov rax, 0x1234`: copied 0x1234 (4660) into rax.')
    expect(results[1].explanation).toContain('0x1234 (4660)')
    expect(results[1].explanation).toContain('rax')
    expect(results[1].explanation).toContain('rbx')
    expect(results[1].explanation).toMatch(/copied/)
  })

  it('a 32-bit write that cleared a top half: says so, with all 16 digits before and after', () => {
    const [step] = stepsOf(['mov eax, 7', 'ret'], { initialRegisters: { rax: PATTERN } })
    expect(step.explanation).toContain('0x7')
    expect(step.explanation).toContain(
      `Writing eax also sets the top 32 bits of rax to 0, so rax went from ${hex64(PATTERN)} to 0x0000000000000007.`,
    )
  })

  it('every 32-bit write over a top half that was not 0 says the top half became 0', () => {
    const start = { initialRegisters: { rax: 0xffffffffffffffffn, rsi: PATTERN } }
    const results = stepsOf(
      [
        'push rbp',
        'mov rbp, rsp',
        'mov dword ptr [rbp-4], 1',
        'add eax, [rbp-4]',
        'mov rax, -1',
        'imul eax, [rbp-4]',
        'mov rax, -1',
        'xor eax, eax',
        'mov rax, -1',
        'sub eax, 1',
        'movzx esi, al',
        'pop rbp',
        'ret',
      ],
      start,
    )
    // With a memory operand the result sentence carries the rule (no room for a fourth sentence).
    expect(explanationOf(results, 'add eax, [rbp-4]')).toContain(
      'stored in eax, and the top 32 bits of rax were set to 0.',
    )
    expect(explanationOf(results, 'imul eax, [rbp-4]')).toContain(
      'stored in eax, and the top 32 bits of rax were set to 0.',
    )
    expect(explanationOf(results, 'xor eax, eax')).toContain(
      'A value XOR itself is always 0, and writing eax also sets the top 32 bits of rax to 0, so all of rax is 0 now.',
    )
    expect(explanationOf(results, 'sub eax, 1')).toContain(
      'and the top 32 bits of rax were set to 0',
    )
    expect(explanationOf(results, 'movzx esi, al')).toContain(
      `Writing esi also sets the top 32 bits of rsi to 0, so rsi went from ${hex64(PATTERN)} to`,
    )
  })

  it('a 32-bit write over a top half that was 0 says nothing extra', () => {
    const [step] = stepsOf(['mov eax, 7', 'ret'], { initialRegisters: { rax: 0xffffn } })
    expect(step.explanation).toBe('`mov eax, 7`: copied 0x7 into eax.')
  })

  it.each<[string, string, string]>([
    ['mov al, 7', '0x1111222233334407', 'lowest 8 bits'],
    ['mov ax, 7', '0x1111222233330007', 'lowest 16 bits'],
    ['mov ah, 7', '0x1111222233330744', 'bits 8 to 15'],
  ])('%s: the other bits did not change, with the full new value', (line, full, part) => {
    const [step] = stepsOf([line, 'ret'], { initialRegisters: { rax: PATTERN } })
    expect(step.explanation).toContain('0x7')
    expect(step.explanation).toContain(full)
    expect(step.explanation).toContain(part)
    expect(step.explanation).toMatch(/other bits did not change/)
  })

  it('a memory operand: the address and how it was worked out', () => {
    const results = stepsOf(
      ['push rbp', 'mov rbp, rsp', 'push rbx', 'mov rax, -8[rbp]', 'pop rbx', 'pop rbp', 'ret'],
      {
        initialRegisters: { rbx: 5n },
      },
    )
    const text = results[3].explanation
    expect(text).toContain('rbp − 8 = 0x…dfe8')
    expect(text).toContain('0x5')
    expect(text).toContain('8 bytes')
    expect(text).toContain('rax')
  })

  it('an `.equ` name in a memory operand is shown with its value', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.equ count, -8',
        'main:',
        'push rbp',
        'mov rbp, rsp',
        'sub rsp, 16',
        'mov qword ptr count[rbp], 5',
        'leave',
        'ret',
        '',
      ].join('\n'),
    )
    const text = explanationOf(allSteps(emulator), 'mov qword ptr count[rbp], 5')
    expect(text).toContain('rbp + count = rbp − 8 = 0x…dfe8')
    expect(text).toContain('0x5')
    expect(text).toContain('8 bytes')
  })

  it.each<[string, string]>([
    ['mov rax, [rbx]', 'rbx'],
    ['mov rax, [rbx+rcx*8]', 'rbx + rcx×8 = '],
    ['mov rax, 16[rbx]', 'rbx + 0x10 (16) = '],
    ['mov rax, [rbx+rcx-8]', 'rbx + rcx − 8 = '],
  ])('%s shows the parts of the address', (line, expected) => {
    // rbx points at the top box and rcx is 0, so every address is in the stack.
    const [step] = stepsOf([line, 'ret'], { initialRegisters: { rbx: RSP0 } })
    expect(step.explanation).toContain(expected)
    expect(step.explanation).toMatch(/0x…[0-9a-f]{4}/)
  })

  it('a data address is written in full', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'numbers: .quad 12, 7',
        '.text',
        'main:',
        'mov rax, numbers+8[rip]',
        'lea rdi, numbers[rip]',
        'ret',
        '',
      ].join('\n'),
    )
    const [read, lea] = allSteps(emulator)
    expect(read.explanation).toContain('`numbers` (0x404030) + 8 = 0x404038')
    expect(read.explanation).toContain('0x7')
    expect(lea.explanation).toContain('`numbers`')
    expect(lea.explanation).toContain('0x404030')
  })

  it('an index register in an address is shown with its value, so the sum can be checked', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.data',
        'array: .quad 10, 20, 30, 40',
        '.text',
        'main:',
        'mov ecx, 2',
        'mov rax, array[rcx*8]',
        'lea rbx, array[rip]',
        'mov rax, [rbx+rcx*8+8]',
        'ret',
        '',
      ].join('\n'),
    )
    const results = allSteps(emulator)
    expect(explanationOf(results, 'mov rax, array[rcx*8]')).toContain(
      'the address is `array` (0x404030) + rcx×8 = 0x404030 + 0x2×8 = 0x404040.',
    )
    expect(explanationOf(results, 'mov rax, [rbx+rcx*8+8]')).toContain(
      'the address is rbx + rcx×8 + 8 = 0x404030 + 0x2×8 + 8 = 0x404048.',
    )
  })

  it('a number the student typed is written in full, even when it looks like a code address', () => {
    const results = stepsOf(['mov rax, 0x401130', 'mov ebx, 4198700', 'ret'])
    expect(results[0].explanation).toBe('`mov rax, 0x401130`: copied 0x401130 into rax.')
    expect(results[1].explanation).toBe('`mov ebx, 4198700`: copied 0x40112c into ebx.')
  })

  it('lea: the address, and that it does not read memory', () => {
    const [step] = stepsOf(['lea rdi, 8[rsp]', 'ret'])
    expect(step.explanation.startsWith('`lea rdi, 8[rsp]`:')).toBe(true)
    expect(step.explanation).toContain('rsp + 8 = 0x…e000')
    expect(step.explanation).toContain('rdi')
    expect(step.explanation).toMatch(/does not read memory/)
    // No phrasal verb ("worked out"): "calculated".
    expect(step.explanation).toContain('calculated the address')
    expect(step.explanation).not.toMatch(/worked out/)
  })

  it('movzx and movsx: the value copied and the new value of the destination', () => {
    const results = stepsOf(['movzx eax, bl', 'movsx ecx, bl', 'movsx rdx, bl', 'ret'], {
      initialRegisters: { rbx: 0x80n },
    })
    expect(results[0].explanation).toContain('0x80 (128)')
    expect(results[0].explanation).toMatch(/eax = 0x80 \(128\)/)
    expect(results[1].explanation).toContain('0xffffff80 (-128)')
    expect(results[1].explanation).toMatch(/top bit/)
    expect(results[2].explanation).toContain('0xffffffffffffff80 (-128)')
  })

  it('movsx shows the SIGNED value of the source, so it keeps -128 as -128', () => {
    const results = stepsOf(
      [
        'movsx eax, bl',
        'movsx cx, bl',
        'sub rsp, 8',
        'mov word ptr [rsp], -5',
        'movsx rdx, word ptr [rsp]',
        'add rsp, 8',
        'ret',
      ],
      { initialRegisters: { rbx: 0x80n } },
    )
    expect(results[0].explanation).toBe(
      "`movsx eax, bl`: copied bl's value 0x80 (-128) into eax and filled the upper bits with copies of its top bit (1), so eax = 0xffffff80 (-128).",
    )
    expect(results[1].explanation).toContain('so cx = 0xff80 (-128).')
    expect(results[4].explanation).toContain(
      'The 2 bytes stored there, 0xfffb (-5), were copied into rdx, and the upper bits were filled with copies of their top bit (1), so rdx = 0xfffffffffffffffb (-5).',
    )
    // movzx keeps the unsigned value.
    const [zero] = stepsOf(['movzx eax, bl', 'ret'], { initialRegisters: { rbx: 0x80n } })
    expect(zero.explanation).toContain("bl's value 0x80 (128)")
    expect(zero.explanation).toContain('eax = 0x80 (128)')
  })

  it('a store to memory: the value and the number of bytes', () => {
    const results = stepsOf(
      ['sub rsp, 8', 'mov dword ptr [rsp], 300', 'mov [rsp], bl', 'add rsp, 8', 'ret'],
      {
        initialRegisters: { rbx: 0x41n },
      },
    )
    expect(results[1].explanation).toContain('0x12c (300)')
    expect(results[1].explanation).toContain('4 bytes')
    expect(results[1].explanation).toContain(shortAddress(RSP0 - 8n))
    expect(results[2].explanation).toContain('0x41 (65)')
    expect(results[2].explanation).toMatch(/the byte at that address/)
  })

  it('names the character a number was written as', () => {
    const [step] = stepsOf(["mov esi, 'A'", 'ret'])
    expect(step.explanation).toBe(
      "`mov esi, 'A'`: copied 0x41 (65), the character code of `'A'`, into esi.",
    )
  })

  it('names an `.equ` constant and the address of a label', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.equ HOW_MANY, 5',
        'message: .string "hi"',
        'main:',
        'mov ecx, HOW_MANY',
        'mov rax, offset message',
        'ret',
        '',
      ].join('\n'),
    )
    const [constant, address] = allSteps(emulator)
    expect(constant.explanation).toContain('0x5')
    expect(constant.explanation).toContain('`HOW_MANY`')
    expect(address.explanation).toContain('0x402010')
    expect(address.explanation).toContain('`message`')
    expect(address.explanation).toMatch(/address of/)
  })
})

describe('explanations: arithmetic, compares and jumps', () => {
  it('add: both inputs, the result and the four flags', () => {
    const [step] = stepsOf(['add eax, ecx', 'ret'], { initialRegisters: { rax: 45n, rcx: 10n } })
    expect(step.explanation).toBe(
      '`add eax, ecx`: 0x2d (45) + 0xa (10) = 0x37 (55), stored in eax. Flags: CF=0, ZF=0, SF=0, OF=0.',
    )
  })

  it.each<[string, string[]]>([
    ['sub eax, ecx', ['0x2d (45)', '0xa (10)', '0x23 (35)', '−', 'CF=0', 'ZF=0', 'SF=0', 'OF=0']],
    ['imul eax, ecx', ['0x2d (45)', '0xa (10)', '0x1c2 (450)', '×']],
    ['and eax, ecx', ['0x2d (45)', '0xa (10)', '0x8', 'AND', 'CF=0', 'OF=0']],
    ['or eax, ecx', ['0x2d (45)', '0xa (10)', '0x2f (47)', 'OR']],
    ['xor eax, ecx', ['0x2d (45)', '0xa (10)', '0x27 (39)', 'XOR']],
  ])('%s shows its numbers', (line, facts) => {
    const [step] = stepsOf([line, 'ret'], { initialRegisters: { rax: 45n, rcx: 10n } })
    for (const fact of facts) expect(step.explanation).toContain(fact)
    expect(step.explanation).toMatch(/stored in eax/)
  })

  it('shows the flags an addition sets', () => {
    const [step] = stepsOf(['add al, 1', 'ret'], { initialRegisters: { rax: 0xffn } })
    expect(step.explanation).toContain('CF=1, ZF=1, SF=0, OF=0')
    expect(step.explanation).toContain('0xff (255 or -1)')
    expect(step.explanation).toContain('0x0')
  })

  it('8- and 16-bit values show both readings, so the flags make sense', () => {
    const results = stepsOf(['cmp al, 0x80', 'dec cx', 'ret'], {
      initialRegisters: { rax: 0x7fn, rcx: 0x8000n },
    })
    // 127 − (−128) does not fit in a signed byte: that is why OF=1.
    expect(results[0].explanation).toContain(
      'compared 0x7f (127) with 0x80 (128 or -128) by computing 0x7f − 0x80 = 0xff (255 or -1)',
    )
    expect(results[0].explanation).toContain('OF=1')
    expect(results[1].explanation).toContain('0x8000 (32768 or -32768) − 1 = 0x7fff (32767)')
    expect(results[1].explanation).toContain('OF=1')
  })

  it('inc and dec: the numbers, three flags, and that CF is not changed', () => {
    const results = stepsOf(['inc ecx', 'dec ecx', 'ret'], { initialRegisters: { rcx: 10n } })
    expect(results[0].explanation).toContain('0xa (10) + 1 = 0xb (11)')
    expect(results[0].explanation).toContain('ZF=0, SF=0, OF=0')
    expect(results[0].explanation).toMatch(/CF is not changed/)
    expect(results[0].explanation).not.toMatch(/CF=/)
    expect(results[1].explanation).toContain('0xb (11) − 1 = 0xa (10)')
    expect(results[1].explanation).toMatch(/CF is not changed/)
  })

  it('arithmetic on memory: the address, the old value, the result', () => {
    const results = stepsOf(['push rbx', 'add qword ptr [rsp], 5', 'pop rbx', 'ret'], {
      initialRegisters: { rbx: 100n },
    })
    const text = results[1].explanation
    expect(text).toContain(shortAddress(RSP0 - 8n))
    expect(text).toContain('0x64 (100)')
    expect(text).toContain('0x5')
    expect(text).toContain('0x69 (105)')
    expect(text).toContain('CF=0, ZF=0, SF=0, OF=0')
  })

  it('`xor eax, eax` explains the idiom', () => {
    const [step] = stepsOf(['xor eax, eax', 'ret'], { initialRegisters: { rax: 5n } })
    expect(step.explanation).toContain('0x5 XOR 0x5 = 0x0')
    expect(step.explanation).toContain('ZF=1')
    expect(step.explanation).toMatch(/always 0/)
  })

  it('an imul that does not fit says so', () => {
    const [step] = stepsOf(['imul eax, ebx', 'ret'], {
      initialRegisters: { rax: 0x7fffffffn, rbx: 2n },
    })
    expect(step.explanation).toContain('0xfffffffe (-2)')
    expect(step.explanation).toContain('CF=1')
    expect(step.explanation).toContain('OF=1')
    expect(step.explanation).toContain(
      'As a signed number, the full answer is too big for 32 bits, so only its low 32 bits were kept.',
    )
  })

  it.each<[string, bigint]>([
    // 0x80000000 is the whole answer and fits in 32 bits, but NOT as a signed number.
    ['0x40000000 × 2', 0x40000000n],
    ['0x10000 × 0x10000', 0x10000n],
  ])('imul %s: CF and OF are about the SIGNED answer', (_name, value) => {
    const other = value === 0x40000000n ? 2n : 0x10000n
    const [step] = stepsOf(['imul eax, ebx', 'ret'], {
      initialRegisters: { rax: value, rbx: other },
    })
    expect(step.explanation).toContain('CF=1, OF=1')
    expect(step.explanation).toContain('As a signed number, the full answer is too big for 32 bits')
    expect(step.explanation).not.toMatch(/does not fit/)
  })

  it('imul names CF and OF, and says that ZF and SF are this emulator’s choice', () => {
    const [step] = stepsOf(['imul eax, ecx', 'ret'], { initialRegisters: { rax: 1n, rcx: 5n } })
    expect(step.explanation).toBe(
      '`imul eax, ecx`: 0x1 × 0x5 = 0x5, stored in eax. Flags: CF=0, OF=0 (this emulator also set ZF=0 and SF=0; on a real CPU, they are not defined after `imul`).',
    )
  })

  it('cmp: both values, that nothing is stored, and the flags', () => {
    const [step] = stepsOf(['cmp ecx, edx', 'ret'], { initialRegisters: { rcx: 11n, rdx: 10n } })
    expect(step.explanation.startsWith('`cmp ecx, edx`:')).toBe(true)
    expect(step.explanation).toContain('0xb (11)')
    expect(step.explanation).toContain('0xa (10)')
    expect(step.explanation).toMatch(/without storing/)
    expect(step.explanation).toContain('Flags: CF=0, ZF=0, SF=0, OF=0.')
  })

  it('test: both values, that nothing is stored, and the flags', () => {
    const [step] = stepsOf(['test eax, ebx', 'ret'], { initialRegisters: { rax: 12n, rbx: 10n } })
    expect(step.explanation).toContain('0xc (12)')
    expect(step.explanation).toContain('0xa (10)')
    expect(step.explanation).toContain('0x8')
    expect(step.explanation).toMatch(/without storing/)
    expect(step.explanation).toContain('CF=0, ZF=0, SF=0, OF=0')
  })

  it('a taken jump: the rule, the flags it looked at, and "jumped to" the label', () => {
    const results = stepsOf(['cmp ecx, edx', 'jg bigger', 'nop', 'bigger:', 'ret'], {
      initialRegisters: { rcx: 11n, rdx: 10n },
    })
    const text = results[1].explanation
    expect(text.startsWith('`jg bigger`:')).toBe(true)
    expect(text).toContain('ZF=0 and SF=OF')
    expect(text).toContain('ZF=0, SF=0, OF=0')
    expect(text).toContain('jumped to `bigger`')
    expect(text).toContain('line 8')
    expect(text).not.toMatch(/CF=/)
  })

  it('a jump that is not taken: "did not jump"', () => {
    const results = stepsOf(['cmp ecx, edx', 'jg bigger', 'nop', 'bigger:', 'ret'], {
      initialRegisters: { rcx: 1n, rdx: 10n },
    })
    const text = results[1].explanation
    expect(text).toContain('did not jump')
    expect(text).toContain('ZF=0, SF=1, OF=0')
    expect(text).toContain('line 6')
  })

  it.each<[string, string, string]>([
    ['je', 'ZF=1', 'ZF=0'],
    ['jne', 'ZF=0', 'ZF=0'],
    ['jl', 'SF≠OF', 'SF=0, OF=0'],
    ['jle', 'ZF=1 or SF≠OF', 'ZF=0, SF=0, OF=0'],
    ['jge', 'SF=OF', 'SF=0, OF=0'],
    ['ja', 'CF=0 and ZF=0', 'CF=0, ZF=0'],
    ['jae', 'CF=0', 'CF=0'],
    ['jb', 'CF=1', 'CF=0'],
    ['jbe', 'CF=1 or ZF=1', 'CF=0, ZF=0'],
    ['js', 'SF=1', 'SF=0'],
    ['jns', 'SF=0', 'SF=0'],
    ['jo', 'OF=1', 'OF=0'],
    ['jno', 'OF=0', 'OF=0'],
  ])('%s names its rule (%s) and shows only the flags it reads', (written, rule, looked) => {
    const [step] = stepsOf([`${written} done`, 'done:', 'ret'])
    expect(step.explanation).toContain(`\`${written}\` jumps when ${rule}`)
    expect(step.explanation).toContain(`Now ${looked},`)
    expect(step.explanation).toMatch(/jumped to|did not jump/)
  })

  it('uses the spelling the student typed', () => {
    const [step] = stepsOf(['jz done', 'done:', 'ret'], { initialFlags: { ZF: 1 } })
    expect(step.explanation.startsWith('`jz done`: `jz` jumps when ZF=1')).toBe(true)
    expect(step.explanation).toContain('jumped to `done`')
  })

  it('jmp says where it went', () => {
    const [step] = stepsOf(['jmp done', 'nop', 'done:', 'ret'])
    // rip does not jump: the program jumps, and rip gets the new address.
    expect(step.explanation).toBe(
      `\`jmp done\`: the program jumped to \`done\` (line 7), so rip = ${shortAddress(TEXT + 3n)}.`,
    )
  })

  // After `cmp`, the comparison comes first (a student reads it on every loop pass), then
  // the flag rule. The jumps that look at one result keep the rule first.
  it.each<[string, number, string]>([
    ['je', 0, '`je done`: after `cmp ecx, edx`, it jumps when ecx = edx.'],
    ['jne', 0, '`jne done`: after `cmp ecx, edx`, it jumps when ecx ≠ edx.'],
    ['jg', 0, '`jg done`: after `cmp ecx, edx`, it jumps when ecx > edx (as signed numbers).'],
    ['jge', 0, '`jge done`: after `cmp ecx, edx`, it jumps when ecx ≥ edx (as signed numbers).'],
    ['jl', 0, '`jl done`: after `cmp ecx, edx`, it jumps when ecx < edx (as signed numbers).'],
    ['jle', 0, '`jle done`: after `cmp ecx, edx`, it jumps when ecx ≤ edx (as signed numbers).'],
    ['ja', 0, '`ja done`: after `cmp ecx, edx`, it jumps when ecx > edx (as unsigned numbers).'],
    ['jae', 0, '`jae done`: after `cmp ecx, edx`, it jumps when ecx ≥ edx (as unsigned numbers).'],
    ['jb', 0, '`jb done`: after `cmp ecx, edx`, it jumps when ecx < edx (as unsigned numbers).'],
    ['jbe', 0, '`jbe done`: after `cmp ecx, edx`, it jumps when ecx ≤ edx (as unsigned numbers).'],
    ['js', 1, 'This means the result was negative (its top bit is 1).'],
    ['jns', 1, 'This means the result was not negative (its top bit is 0).'],
    ['jo', 1, 'This means the result did not fit as a signed number.'],
    ['jno', 1, 'This means the result fit as a signed number.'],
  ])('%s says what its rule means for the two compared values', (written, at, meaning) => {
    const [, jump] = stepsOf(['cmp ecx, edx', `${written} done`, 'done:', 'ret'], {
      initialRegisters: { rcx: 0xffffffffn, rdx: 1n },
    })
    const sentences = jump.explanation.split(/(?<=\.) /)
    expect(sentences[at]).toBe(meaning)
    expect(sentenceCount(jump.explanation)).toBe(3)
    if (at === 0) {
      // The flag rule follows the comparison, then the flags and what happened.
      const { rule } = describeCondition(written as JumpCondition)
      const flagRule = rule.replaceAll(' = ', '=').replaceAll(' ≠ ', '≠')
      expect(sentences[1]).toBe(`It checks this with the flags: ${flagRule}.`)
      expect(sentences[2]).toMatch(/^Now .*, so it (jumped to `done`|did not jump)/)
    }
  })

  it('the jg explanation of a loop is shorter than before (about 45 words then)', () => {
    const [, jump] = stepsOf(['cmp ecx, edx', 'jg done', 'nop', 'done:', 'ret'], {
      initialRegisters: { rcx: 1n, rdx: 10n },
    })
    expect(jump.explanation).toBe(
      '`jg done`: after `cmp ecx, edx`, it jumps when ecx > edx (as signed numbers). It checks this with the flags: ZF=0 and SF=OF. Now ZF=0, SF=1, OF=0, so it did not jump, and the program continues at line 6.',
    )
    expect(jump.explanation.split(/\s+/).length).toBeLessThanOrEqual(40)
  })

  it('after test, je and jne say what was tested; after other instructions, what the result was', () => {
    const tested = stepsOf(['test eax, eax', 'je done', 'done:', 'ret'])
    expect(tested[1].explanation).toBe(
      '`je done`: after `test eax, eax`, it jumps when eax is 0. It checks this with the flags: ZF=1. Now ZF=1, so it jumped to `done` (line 7).',
    )
    const both = stepsOf(['test eax, ebx', 'jne done', 'done:', 'ret'])
    expect(both[1].explanation).toContain(
      '`jne done`: after `test eax, ebx`, it jumps when eax AND ebx is not 0.',
    )
    const added = stepsOf(['add eax, 1', 'je done', 'done:', 'ret'])
    expect(added[1].explanation).toContain(
      'After `cmp a, b`, this means a = b; after other instructions, it means the result was 0.',
    )
  })

  it('ja after a compare with -1 says that ja reads the numbers as never negative', () => {
    const [cmp, jump] = stepsOf(['cmp ecx, edx', 'ja done', 'done:', 'ret'], {
      initialRegisters: { rcx: 0xffffffffn, rdx: 1n },
    })
    expect(cmp.explanation).toContain('0xffffffff (-1)')
    expect(jump.explanation).toContain('it jumps when ecx > edx (as unsigned numbers)')
    expect(jump.explanation).toContain('so it jumped to `done`')
  })

  it('a compare with a constant or a character names it', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        '.equ LIMIT, 100',
        'main:',
        'mov eax, 5',
        'cmp eax, LIMIT',
        'ret',
        '',
      ].join('\n'),
    )
    const [, cmp] = allSteps(emulator)
    expect(cmp.explanation).toContain(
      'compared 0x5 with 0x64 (100), the value of `LIMIT`, by computing',
    )
  })
})

describe('explanations: library steps', () => {
  const hello = [
    '.intel_syntax noprefix',
    'message: .string "Hello World!\\n"',
    'main:',
    'sub rsp, 8',
    'lea rdi, message[rip]',
    'call printf@PLT',
    'add rsp, 8',
    'ret',
    '',
  ].join('\n')

  it('the call into the library says where rip went', () => {
    const results = allSteps(emulatorFor(hello))
    const call = results[2]
    expect(call.explanation.startsWith('`call printf@PLT`:')).toBe(true)
    expect(call.explanation).toContain('0x…dff0 → 0x…dfe8')
    expect(call.explanation).toContain(shortAddress(TEXT + 16n))
    expect(call.explanation).toContain('`printf`')
    expect(call.explanation).toMatch(/library/)
  })

  it('printf: how many characters, the value left in eax, and the return', () => {
    const results = allSteps(emulatorFor(hello))
    const library = results[3]
    expect(library.kind).toBe('library')
    // The name is code, so it is in backticks; the step's `text` stays plain.
    expect(library.text).toBe('printf (library code)')
    expect(library.explanation.startsWith('`printf` (library code) printed 13 characters')).toBe(
      true,
    )
    expect(library.explanation).toContain('13 characters')
    expect(library.explanation).toContain('eax = 0xd (13)')
    expect(library.explanation).toContain(shortAddress(TEXT + 16n))
    expect(library.explanation).toContain('0x…dfe8 → 0x…dff0')
    expect(library.explanation).toContain('Then it returned to line 7:')
  })

  it('scanf: which values were read, where they went, eax, and the return', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d %d"',
        'main:',
        'sub rsp, 24',
        'lea rsi, [rsp]',
        'lea rdx, 8[rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 24',
        'ret',
        '',
      ].join('\n'),
      { stdin: '41 -5\n' },
    )
    const library = allSteps(emulator).find((step) => step.kind === 'library')
    if (library === undefined) throw new Error('no library step')
    expect(library.explanation.startsWith('`scanf` (library code)')).toBe(true)
    expect(library.explanation).toContain(
      `read 2 numbers, 41 and -5, and stored them at ${shortAddress(RSP0 - 24n)} and ${shortAddress(RSP0 - 16n)}`,
    )
    // eax counts the values that were stored, and the sentence says so.
    expect(library.explanation).toContain('eax = 0x2, the number of values it stored')
    expect(library.explanation).toContain('0x…dfd8 → 0x…dfe0')
  })

  it('scanf: one value, characters, a new line, a word and an octal %i, each in plain words', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'f_one: .string "%d"',
        'f_three: .string "%3c"',
        'f_char: .string "%c"',
        'f_word: .string "%s"',
        'f_octal: .string "%i"',
        'main:',
        'sub rsp, 24',
        ...['f_one', 'f_three', 'f_char', 'f_word', 'f_octal'].flatMap((format) => [
          'lea rsi, [rsp]',
          `lea rdi, ${format}[rip]`,
          'call scanf@PLT',
        ]),
        'add rsp, 24',
        'ret',
        '',
      ].join('\n'),
      { stdin: '41 abc\nhello 010\n' },
    )
    const texts = allSteps(emulator)
      .filter((step) => step.kind === 'library')
      .map((step) => step.explanation)
    const box = shortAddress(RSP0 - 24n)
    expect(texts[0]).toContain(
      `read the number 41 and stored it as 0x29 (41) in the 4 bytes at ${box}, so eax = 0x1, the number of values it stored.`,
    )
    // %3c does not skip the space after 41.
    expect(texts[1]).toContain(
      `read 3 characters, \` ab\`, and stored them in the 3 bytes at ${box}`,
    )
    expect(texts[2]).toContain(`read the character \`c\` and stored it in the byte at ${box}`)
    expect(texts[3]).toContain(
      `read the word \`hello\` and stored it in the 6 bytes at ${box} (the text and a 0 byte at the end)`,
    )
    expect(texts[4]).toContain('read the number 8 (`%i` reads `010` as octal, base 8)')
  })

  it('puts and putchar say what they printed', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'message: .string "Hi"',
        'main:',
        'sub rsp, 8',
        'lea rdi, message[rip]',
        'call puts@PLT',
        'mov edi, 33',
        'call putchar@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    const [puts, putchar] = allSteps(emulator).filter((step) => step.kind === 'library')
    expect(puts.explanation.startsWith('`puts` (library code)')).toBe(true)
    expect(puts.explanation).toContain('3 characters')
    expect(puts.explanation).toContain('eax = 0x3')
    expect(putchar.explanation.startsWith('`putchar` (library code)')).toBe(true)
    expect(putchar.explanation).toContain('`!`')
    expect(putchar.explanation).toContain('eax = 0x21 (33)')
  })

  it('a scanf that waits says what to type', () => {
    const emulator = emulatorFor(
      [
        '.intel_syntax noprefix',
        'pattern: .string "%d"',
        'main:',
        'sub rsp, 8',
        'lea rsi, [rsp]',
        'lea rdi, pattern[rip]',
        'call scanf@PLT',
        'add rsp, 8',
        'ret',
        '',
      ].join('\n'),
    )
    for (let i = 0; i < 4; i++) emulator.step()
    const waiting = emulator.step()
    expect(waiting.executed).toBe(false)
    expect(waiting.explanation).toBe(
      '`scanf` (library code) is waiting for input. Type a whole number, like 42 or -7, and press Enter.',
    )
  })

  it('libraryStepText is the text of a library step', () => {
    expect(libraryStepText('printf')).toBe('printf (library code)')
    expect(libraryStepText('scanf')).toMatch(/^scanf .*library code/)
  })
})

/* ───────────────────────── rules for every explanation ───────────────────────── */

describe('every explanation', () => {
  /** Programs that reach every kind of step, also the ones that stop with an error. */
  const programs: [string, string[], EmulatorOptions?][] = [
    [
      'moves',
      ['mov rax, 5', 'mov al, 1', 'mov ax, 2', 'mov eax, 3', 'mov rbx, rax', 'mov bh, al', 'ret'],
      { initialRegisters: { rax: PATTERN, rbx: PATTERN } },
    ],
    [
      'extends',
      ['movzx eax, bl', 'movsx rax, bl', 'movsx ax, bl', 'movzx ecx, bx', 'movsx rcx, ebx', 'ret'],
      { initialRegisters: { rax: PATTERN, rbx: 0xfffffff0n, rcx: PATTERN } },
    ],
    [
      'memory',
      [
        'push rbp',
        'mov rbp, rsp',
        'sub rsp, 16',
        'mov qword ptr [rbp-8], 5',
        'mov dword ptr [rbp-12], 7',
        'mov byte ptr [rbp-16], 1',
        'mov rax, [rbp-8]',
        'mov eax, [rbp-12]',
        'mov al, [rbp-16]',
        'movzx ebx, byte ptr [rbp-16]',
        'movsx rcx, dword ptr [rbp-12]',
        'add [rbp-8], rax',
        'add eax, [rbp-12]',
        'sub qword ptr [rbp-8], 1',
        'inc dword ptr [rbp-12]',
        'dec byte ptr [rbp-16]',
        'cmp qword ptr [rbp-8], 3',
        'test [rbp-8], rax',
        'imul eax, [rbp-12]',
        'and byte ptr [rbp-16], 1',
        'lea rdx, [rbp-8]',
        'lea edx, [rbp+rax*2]',
        'leave',
        'ret',
      ],
      { initialRegisters: { rax: PATTERN, rdx: PATTERN } },
    ],
    [
      'arithmetic',
      [
        'add rax, rbx',
        'add eax, 1',
        'sub al, 1',
        'sub ax, bx',
        'imul rax, rbx',
        'imul eax, 3',
        'imul ax, bx',
        'and rax, -8',
        'or eax, 1',
        'xor al, al',
        'xor rax, rax',
        'inc rax',
        'inc al',
        'dec eax',
        'dec ax',
        'cmp rax, rbx',
        'cmp al, 1',
        'test eax, eax',
        'test al, 1',
        'ret',
      ],
      { initialRegisters: { rax: 0x7fffffffffffffffn, rbx: 0x1234n } },
    ],
    [
      'stack',
      [
        'push rax',
        'push 5',
        'push -1',
        'push rsp',
        'pop rbx',
        'pop rcx',
        'pop rdx',
        'pop rsi',
        'push rax',
        'pop rsp',
        'ret',
      ],
      { initialRegisters: { rax: RSP0 } },
    ],
    [
      'jumps',
      [
        'cmp eax, 1',
        'je a',
        'jne a',
        'a:',
        'jg b',
        'jle b',
        'b:',
        'jmp c',
        'nop',
        'c:',
        'endbr64',
        'nop',
        'ret',
      ],
    ],
    [
      'calls',
      ['call f', 'call g', 'ret', 'f:', 'push rbp', 'mov rbp, rsp', 'leave', 'ret', 'g:', 'ret'],
    ],
    ['imul then jump', ['imul eax, ebx', 'jle done', 'done:', 'ret']],
    [
      'never written',
      ['sub rsp, 16', 'mov rax, [rsp]', 'mov bl, [rsp+9]', 'pop rcx', 'add rsp, 8', 'ret'],
    ],
    ['runs off the end', ['mov eax, 1', 'add qword ptr [rsp], 0']],
    ['bad jump', ['push 5', 'ret']],
    ['jump to the end', ['jmp end', 'end:']],
    ['bad read', ['mov rax, [rbx]']],
    ['bad write', ['mov [rbx], rax']],
    ['read-only write', ['mov qword ptr main[rip], 1']],
    ['stack overflow', ['push rax'], { stackSize: 8 }],
    ['pop outside the stack', ['mov rsp, 8', 'pop rax']],
    ['code read', ['mov rax, main', 'ret']],
    ['ret mismatch', ['push offset there', 'ret', 'there:', 'ret']],
  ]

  it.each(programs)(
    '%s: starts with the instruction, has 1 to 3 sentences',
    (_name, lines, options) => {
      const results = stepsOf(lines, options)
      expect(results.length).toBeGreaterThan(0)
      for (const step of results) {
        const where = `${step.text} → ${step.explanation}`
        expect(step.explanation.startsWith(`\`${step.text}\`: `), where).toBe(true)
        const count = sentenceCount(step.explanation)
        expect(count, where).toBeGreaterThanOrEqual(1)
        expect(count, where).toBeLessThanOrEqual(MAX_SENTENCES)
        expect(step.explanation, where).toMatch(/[.?]$/)
        expect(step.explanation, where).not.toMatch(/undefined|NaN|\[object|\$\{|null/)
        expect(step.explanation, where).not.toMatch(/ {2}/)
        for (const note of step.notes) {
          expect(note.text, where).toMatch(/\.$/)
          expect(note.text, where).not.toMatch(/undefined|NaN|\[object|\$\{|null/)
        }
      }
    },
  )

  it('a step that stops the program says so', () => {
    const offEnd = stepsOf(['mov eax, 1'])
    expect(offEnd[0].explanation).toMatch(/copied 0x1 into eax/)
    expect(offEnd[0].explanation).toMatch(/last instruction/)
    expect(offEnd[0].explanation).toMatch(/stopped with an error/)

    const badJump = stepsOf(['push 5', 'ret'])
    expect(badJump[1].explanation).toContain('0x5')
    expect(badJump[1].explanation).toMatch(/No instruction starts at that address/)
  })

  it('a faulting step says what it tried, and that nothing changed', () => {
    const [step] = stepsOf(['mov rax, [rbx]'], { initialRegisters: { rbx: 0x10n } })
    expect(step.explanation.startsWith('`mov rax, [rbx]`: ')).toBe(true)
    expect(step.explanation).toContain('0x10')
    expect(step.explanation).toMatch(/Nothing changed/)
    expect(sentenceCount(step.explanation)).toBe(2)
  })

  it('code with a backtick in it does not break the code font', () => {
    const [step] = stepsOf(["mov al, '`'", 'ret'])
    expect(step.text).toBe("mov al, '`'")
    expect(step.explanation.startsWith("`mov al, '''`: ")).toBe(true)
    expect((step.explanation.match(/`/g) ?? []).length % 2).toBe(0)
  })
})

/* ─────────────────── the step that stops the program (contract, section 8) ─────────────────── */

describe('the step that stops the program with an error always says so', () => {
  const RAN_OFF =
    'This was the last instruction, so the program ran past the end of its code and stopped with an error.'
  const RAN_OFF_SHORT = 'This was the last instruction, so the program stopped with an error.'
  const BAD_JUMP = 'No instruction starts at that address, so the program stopped with an error.'

  /** The last step of `source(...lines)`, which must stop the program with `code`. */
  function stoppingStep(lines: string[], code: string, options?: EmulatorOptions): StepResult {
    const results = stepsOf(lines, options)
    const last = results[results.length - 1]
    expect(last.status).toBe('error')
    expect(last.error?.code).toBe(code)
    expect(sentenceCount(last.explanation), last.explanation).toBeLessThanOrEqual(MAX_SENTENCES)
    expect(last.explanation.length, last.explanation).toBeLessThanOrEqual(400)
    return last
  }

  it('a loop at the end of main with no `ret`: the last `jnz` gives its rule, the flag and the stop', () => {
    const last = stoppingStep(['mov ecx, 2', 'again:', 'dec ecx', 'jnz again'], 'ran-off-end')
    expect(last.explanation).toBe(
      `\`jnz again\`: \`jnz\` jumps when ZF=0. Now ZF=1, so it did not jump. ${RAN_OFF}`,
    )
  })

  it('a jump to a label with no instruction after it: it jumped, and then the program stopped', () => {
    const last = stoppingStep(['cmp eax, eax', 'je done', 'done:'], 'bad-jump')
    // The flag rule is joined to the comparison, so every fact stays.
    expect(last.explanation).toBe(
      `\`je done\`: after \`cmp eax, eax\`, it jumps when eax = eax; it checks this with the flags: ZF=1. Now ZF=1, so it jumped to \`done\` (${shortAddress(TEXT + 4n)}). ${BAD_JUMP}`,
    )
  })

  /** For each condition: flags that make it hold, and flags that make it fail. */
  const CONDITIONS: [
    string,
    string,
    EmulatorOptions['initialFlags'],
    EmulatorOptions['initialFlags'],
  ][] = [
    ['je', 'ZF=1', { ZF: 1 }, { ZF: 0 }],
    ['jne', 'ZF=0', { ZF: 0 }, { ZF: 1 }],
    ['jg', 'ZF=0 and SF=OF', {}, { ZF: 1 }],
    ['jge', 'SF=OF', {}, { SF: 1 }],
    ['jl', 'SF≠OF', { SF: 1 }, {}],
    ['jle', 'ZF=1 or SF≠OF', { ZF: 1 }, {}],
    ['ja', 'CF=0 and ZF=0', {}, { CF: 1 }],
    ['jae', 'CF=0', {}, { CF: 1 }],
    ['jb', 'CF=1', { CF: 1 }, {}],
    ['jbe', 'CF=1 or ZF=1', { CF: 1 }, {}],
    ['js', 'SF=1', { SF: 1 }, {}],
    ['jns', 'SF=0', {}, { SF: 1 }],
    ['jo', 'OF=1', { OF: 1 }, {}],
    ['jno', 'OF=0', {}, { OF: 1 }],
    ['jz', 'ZF=1', { ZF: 1 }, {}],
    ['jnae', 'CF=1', { CF: 1 }, {}],
  ]

  it.each(CONDITIONS)(
    '`%s` as the last instruction: taken or not, it gives its rule and says the program stopped',
    (written, rule, holds, fails) => {
      const notTaken = stoppingStep([`${written} done`, 'done:'], 'ran-off-end', {
        initialFlags: fails,
      })
      expect(
        notTaken.explanation.startsWith(
          `\`${written} done\`: \`${written}\` jumps when ${rule}. Now `,
        ),
      ).toBe(true)
      expect(notTaken.explanation).toContain(', so it did not jump.')
      expect(notTaken.explanation.endsWith(` ${RAN_OFF}`)).toBe(true)

      const taken = stoppingStep([`${written} done`, 'done:'], 'bad-jump', { initialFlags: holds })
      expect(
        taken.explanation.startsWith(
          `\`${written} done\`: \`${written}\` jumps when ${rule}. Now `,
        ),
      ).toBe(true)
      expect(taken.explanation).toContain(', so it jumped to `done`')
      expect(taken.explanation.endsWith(` ${BAD_JUMP}`)).toBe(true)
    },
  )

  it('the meaning of the rule is still there when the program goes on', () => {
    const [, jump] = stepsOf(['cmp eax, eax', 'je done', 'done:', 'ret'])
    expect(jump.explanation).toBe(
      `\`je done\`: after \`cmp eax, eax\`, it jumps when eax = eax. It checks this with the flags: ZF=1. Now ZF=1, so it jumped to \`done\` (line 7).`,
    )
  })

  const FRAME = ['push rbp', 'mov rbp, rsp', 'mov dword ptr [rbp-4], 5']

  it('arithmetic with a memory operand: the flags join the result, so every fact stays', () => {
    const last = stoppingStep([...FRAME, 'add eax, dword ptr [rbp-4]'], 'ran-off-end')
    expect(last.explanation).toBe(
      `\`add eax, dword ptr [rbp-4]\`: the address is rbp − 4 = ${shortAddress(RSP0 - 12n)}, and the 4 bytes stored there hold 0x5. 0x0 + 0x5 = 0x5, stored in eax; flags: CF=0, ZF=0, SF=0, OF=0. ${RAN_OFF}`,
    )
  })

  it('cmp and test with a memory operand keep the address, the values and the flags', () => {
    const cmp = stoppingStep([...FRAME, 'cmp eax, dword ptr [rbp-4]'], 'ran-off-end')
    expect(cmp.explanation).toContain(`the address is rbp − 4 = ${shortAddress(RSP0 - 12n)}`)
    expect(cmp.explanation).toContain(
      'Compared 0x0 with 0x5 by computing 0x0 − 0x5 = 0xfffffffb (-5), without storing the result; flags: CF=1, ZF=0, SF=1, OF=0.',
    )
    expect(cmp.explanation.endsWith(` ${RAN_OFF}`)).toBe(true)
    const test = stoppingStep([...FRAME, 'test dword ptr [rbp-4], 4'], 'ran-off-end')
    expect(test.explanation).toContain('without storing the result; flags: CF=0, ZF=0, SF=0, OF=0.')
    expect(test.explanation.endsWith(` ${RAN_OFF}`)).toBe(true)
  })

  it('a 32-bit load at the end still shows the whole register before and after', () => {
    const last = stoppingStep([...FRAME, 'mov eax, dword ptr [rbp-4]'], 'ran-off-end', {
      initialRegisters: { rax: PATTERN },
    })
    expect(last.explanation).toBe(
      `\`mov eax, dword ptr [rbp-4]\`: the address is rbp − 4 = ${shortAddress(RSP0 - 12n)}. The 4 bytes stored there, 0x5, were copied into eax; writing eax also sets the top 32 bits of rax to 0, so rax went from ${hex64(PATTERN)} to 0x0000000000000005. ${RAN_OFF}`,
    )
  })

  it('`xor eax, eax` at the end keeps the sentence about the top 32 bits', () => {
    const cleared = stoppingStep(['xor eax, eax'], 'ran-off-end', {
      initialRegisters: { rax: PATTERN },
    })
    expect(cleared.explanation).toBe(
      `\`xor eax, eax\`: 0x33334444 XOR 0x33334444 = 0x0, stored in eax; flags: CF=0, ZF=1, SF=0, OF=0. A value XOR itself is always 0, and writing eax also sets the top 32 bits of rax to 0, so all of rax is 0 now. ${RAN_OFF}`,
    )
    // With nothing to say about the top half, the short remark is the part left out.
    const plain = stoppingStep(['mov eax, 5', 'xor eax, eax'], 'ran-off-end')
    expect(plain.explanation).toBe(
      `\`xor eax, eax\`: 0x5 XOR 0x5 = 0x0, stored in eax. Flags: CF=0, ZF=1, SF=0, OF=0. ${RAN_OFF}`,
    )
  })

  it('a long step uses the short stop sentence and stays within 400 characters', () => {
    const lines = [
      'push rbp',
      'mov rbp, rsp',
      'mov byte ptr [rbp-1], -3',
      'movsx esi, byte ptr [rbp-1]',
    ]
    const last = stoppingStep(lines, 'ran-off-end', { initialRegisters: { rsi: PATTERN } })
    expect(last.explanation).toContain(
      `writing esi also sets the top 32 bits of rsi to 0, so rsi went from ${hex64(PATTERN)} to 0x00000000fffffffd.`,
    )
    expect(last.explanation.endsWith(` ${RAN_OFF_SHORT}`)).toBe(true)
    const lea = stoppingStep(['lea eax, [rbx+rcx*8+16]'], 'ran-off-end', {
      initialRegisters: { rax: PATTERN, rbx: PATTERN, rcx: 2n },
    })
    expect(lea.explanation).toContain('in eax; `lea` does not read memory.')
    expect(lea.explanation).toContain(`so rax went from ${hex64(PATTERN)} to 0x0000000033334464.`)
    expect(lea.explanation.endsWith(` ${RAN_OFF_SHORT}`)).toBe(true)
  })

  it('every other kind of last step says so too', () => {
    const cases: [string[], string, string][] = [
      [['push rbp', 'pop rbp'], 'ran-off-end', RAN_OFF],
      [['push rbp', 'mov rbp, rsp', 'leave'], 'ran-off-end', RAN_OFF],
      [['endbr64'], 'ran-off-end', RAN_OFF],
      [['inc eax'], 'ran-off-end', RAN_OFF],
      [['mov eax, 0x40000000', 'imul eax, eax'], 'ran-off-end', RAN_OFF],
      [['call done', 'done:'], 'bad-jump', BAD_JUMP],
      [['jmp done', 'done:'], 'bad-jump', BAD_JUMP],
      [['push 5', 'ret'], 'bad-jump', BAD_JUMP],
    ]
    for (const [lines, code, stop] of cases) {
      const last = stoppingStep(lines, code)
      expect(last.explanation.endsWith(` ${stop}`), last.explanation).toBe(true)
    }
    const library = stoppingStep(
      ['sub rsp, 8', 'lea rdi, msg[rip]', 'call puts@PLT', 'msg: .string "hi"'],
      'ran-off-end',
    )
    expect(library.kind).toBe('library')
    expect(
      library.explanation.endsWith(
        ' The `call` was the last instruction, so the program ran past the end of its code and stopped with an error.',
      ),
    ).toBe(true)
  })
})

/* ──────────────────────────────── notes ──────────────────────────────── */

describe('notes', () => {
  it('a misaligned call mentions 16 and the address of rsp', () => {
    const [note] = notesFor(
      [{ kind: 'misaligned-call', rsp: RSP0, functionName: 'printf' }],
      context,
    )
    expect(note.kind).toBe('warning')
    expect(note.text).toContain('16')
    expect(note.text).toContain(shortAddress(RSP0))
    expect(note.text).toContain('`printf`')
  })

  it('junk registers is a tip that names every register', () => {
    const registers = ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11'] as const
    const [note] = notesFor([{ kind: 'junk-registers', functionName: 'scanf', registers }], context)
    expect(note.kind).toBe('tip')
    for (const name of registers) expect(note.text).toContain(name)
    expect(note.text).toContain('rcx, rdx, rsi, rdi, r8, r9, r10 and r11')
    expect(note.text).toMatch(/junk/)
  })

  it.each<[number, number, RegExp]>([
    [8, 8, /stack box at 0x…dfe8 was never written/],
    [4, 4, /4 bytes at 0x…dfe8 on the stack were never written/],
    [1, 1, /byte at 0x…dfe8 on the stack was never written/],
    [8, 4, /4 of the 8 bytes at 0x…dfe8 on the stack were never written/],
  ])('a read of %s bytes with %s never written', (bytes, missing, expected) => {
    const [note] = notesFor(
      [{ kind: 'uninitialized-read', address: RSP0 - 16n, bytes, missing }],
      context,
    )
    expect(note.kind).toBe('warning')
    expect(note.text).toMatch(expected)
    expect(note.text).toMatch(/real machine/)
    expect(note.text).toMatch(/junk/)
  })

  it('a wrong return address shows both addresses', () => {
    const [note] = notesFor(
      [{ kind: 'return-mismatch', used: TEXT + 8n, saved: TEXT + 5n }],
      context,
    )
    expect(note.kind).toBe('warning')
    expect(note.text).toContain(shortAddress(TEXT + 8n))
    expect(note.text).toContain(shortAddress(TEXT + 5n))
    expect(note.text).toContain('`ret`')
    const [unknown] = notesFor([{ kind: 'return-mismatch', used: TEXT + 8n, saved: null }], context)
    expect(unknown.text).toContain(shortAddress(TEXT + 8n))
  })

  it('flags after imul: mentions imul, cmp and test', () => {
    const [note] = notesFor([{ kind: 'imul-flags', written: 'jz' }], context)
    expect(note.kind).toBe('warning')
    expect(note.text).toContain('`imul`')
    expect(note.text).toContain('`cmp`')
    expect(note.text).toContain('`test`')
    expect(note.text).toContain('`jz`')
    expect(note.text).toMatch(/ZF and SF/)
  })

  it('scanf with bad input says what it wanted and what it found', () => {
    const [none] = notesFor(
      [
        {
          kind: 'scanf-mismatch',
          wanted: 'decimal',
          found: { kind: 'text', text: 'abc' },
          stored: 0,
        },
      ],
      context,
    )
    expect(none.kind).toBe('warning')
    expect(none.text).toBe(
      '`scanf` wanted a whole number, but it found `abc`. It stopped there and stored nothing. `abc` stays in the input, so the next `scanf` starts there.',
    )
    // As in C, the text it could not read is NOT thrown away.
    expect(none.text).not.toMatch(/thrown away/)
    const [one] = notesFor(
      [{ kind: 'scanf-mismatch', wanted: { literal: ',' }, found: { kind: 'space' }, stored: 1 }],
      context,
    )
    expect(one.text).toBe(
      '`scanf` wanted `,` next in the input, but it found a space. It stopped there and stored only 1 value.',
    )
  })

  it.each<
    [{ kind: 'space' } | { kind: 'tab' } | { kind: 'line-end' } | { kind: 'white-space' }, string]
  >([
    [{ kind: 'space' }, 'it found a space.'],
    [{ kind: 'tab' }, 'it found a tab.'],
    [{ kind: 'line-end' }, 'it found the end of the line.'],
    [{ kind: 'white-space' }, 'it found white space.'],
  ])('scanf names what it found: %j', (found, expected) => {
    const [note] = notesFor([{ kind: 'scanf-mismatch', wanted: 'hex', found, stored: 2 }], context)
    expect(note.text).toContain(expected)
    expect(note.text).toContain('wanted a hex number')
    expect(note.text).toContain('stored only 2 values')
  })

  it('text with no 0 byte at its end: into the stack, or past the data of the program', () => {
    const [stack] = notesFor(
      [
        {
          kind: 'unterminated-text',
          start: RSP0 - 24n,
          at: RSP0 - 22n,
          ranInto: 'stack',
          functionName: 'printf',
        },
      ],
      context,
    )
    expect(stack.kind).toBe('warning')
    expect(stack.text).toContain('no 0 byte at its end')
    expect(stack.text).toContain('stack byte at 0x…dfe2, which was never written')
    const [data] = notesFor(
      [
        {
          kind: 'unterminated-text',
          start: 0x402010n,
          at: 0x402016n,
          ranInto: 'data',
          functionName: 'puts',
        },
      ],
      context,
    )
    expect(data.text).toBe(
      "The text at 0x402010 has no 0 byte at its end, so `puts` read past the last byte of the program's data, to 0x402016. On a real machine, `puts` would print whatever bytes come next, up to the first 0 byte. Write the text with `.string`: it adds the 0 byte.",
    )
  })

  it('a never-written read says what to do about it', () => {
    const [note] = notesFor(
      [{ kind: 'uninitialized-read', address: RSP0 - 16n, bytes: 8, missing: 8 }],
      context,
    )
    expect(note.text).toContain('Store a value there before you read it.')
    const [one] = notesFor(
      [{ kind: 'uninitialized-read', address: RSP0 - 16n, bytes: 8, missing: 1 }],
      context,
    )
    // Singular verbs after "1".
    expect(one.text).toContain(
      '1 of the 8 bytes at 0x…dfe8 on the stack was never written, so the emulator read 0 for it.',
    )
    expect(one.text).toContain('On a real machine it holds junk')
  })

  it('the alignment warning says what to do, without an idiom', () => {
    const [note] = notesFor(
      [{ kind: 'misaligned-call', rsp: RSP0, functionName: 'printf' }],
      context,
    )
    expect(note.text).toContain('rsp was 0x…dff8 before this `call`.')
    expect(note.text).toContain(
      'On a real machine, `printf` can crash when rsp is not a multiple of 16 at a `call`.',
    )
    expect(note.text).toContain(
      'Move rsp down by 8 more before the call (`sub rsp, 8`), and back up after it (`add rsp, 8`).',
    )
    expect(note.text).not.toMatch(/lined up/)
  })

  it('the junk-register tip does not suggest one push (that breaks the alignment)', () => {
    const registers = ['rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11'] as const
    const [note] = notesFor(
      [{ kind: 'junk-registers', functionName: 'printf', registers }],
      context,
    )
    expect(note.text).toBe(
      '`printf` may change rcx, rdx, rsi, rdi, r8, r9, r10 and r11, so they hold junk now. To keep a value until after the call, store it in a local variable on the stack, or in rbx or r12 to r15 (restore those before `ret`).',
    )
    expect(note.text).not.toMatch(/push/)
    expect(note.text).not.toMatch(/across/)
  })

  it('flags from before a library call: names the function and its line', () => {
    const [note] = notesFor(
      [{ kind: 'library-flags', written: 'je', functionName: 'printf', callLine: 9 }],
      context,
    )
    expect(note.kind).toBe('warning')
    expect(note.text).toContain('the call to `printf` on line 9')
    expect(note.text).toContain('Library code may change the flags')
    expect(note.text).toContain('`cmp`')
    expect(note.text).toContain('`je`')
  })

  it('a read of the code says the emulator stores no instruction bytes', () => {
    const [plain] = notesFor([{ kind: 'code-read', address: TEXT, bytes: 8, label: null }], context)
    expect(plain.kind).toBe('warning')
    expect(plain.text).toContain(shortAddress(TEXT))
    expect(plain.text).toMatch(/does not store/)
    // And what a real machine does instead: it reads the machine code.
    expect(plain.text).toContain('A real machine gives the machine code that is stored there.')
    const [one] = notesFor([{ kind: 'code-read', address: TEXT, bytes: 1, label: null }], context)
    expect(one.text).toContain('This instruction read 1 byte from the code of the program')
    const [labelled] = notesFor(
      [{ kind: 'code-read', address: TEXT, bytes: 8, label: 'loop' }],
      context,
    )
    expect(labelled.text).toContain('`loop[rip]`')
    expect(labelled.text).toContain('`lea`')
  })

  it('keeps the order of the notes', () => {
    const notes = notesFor(
      [
        { kind: 'imul-flags', written: 'je' },
        { kind: 'misaligned-call', rsp: RSP0, functionName: 'puts' },
      ],
      context,
    )
    expect(notes.map((note) => note.kind)).toEqual(['warning', 'warning'])
    expect(notes[0].text).toContain('imul')
    expect(notes[1].text).toContain('16')
    expect(notesFor([], context)).toEqual([])
  })
})

/* ───────────────────────────── labels and messages ───────────────────────────── */

describe('stack labels', () => {
  it('a return address says where it goes back to', () => {
    expect(stackLabelText({ kind: 'return-address', line: 12 })).toBe(
      'return address (back to line 12)',
    )
    expect(stackLabelText({ kind: 'return-address', line: null })).toBe('return address')
    expect(osReturnLabel()).toContain('return address')
  })

  it('a saved register names the register', () => {
    expect(stackLabelText({ kind: 'saved-register', register: 'rbp' })).toBe('saved rbp')
    expect(stackLabelText({ kind: 'saved-register', register: 'r12' })).toBe('saved r12')
  })

  it('a local is its `.equ` name, with the distance when it is not exact', () => {
    expect(stackLabelText({ kind: 'local', names: ['count'], offset: 0n })).toBe('count')
    expect(stackLabelText({ kind: 'local', names: ['count'], offset: 8n })).toBe('count+8')
    expect(stackLabelText({ kind: 'local', names: ['count'], offset: -4n })).toBe('count-4')
    expect(stackLabelText({ kind: 'local', names: ['a', 'b'], offset: 0n })).toBe('a+b')
  })
})

describe('messages of run() and of a step that ran nothing', () => {
  it.each<[Parameters<typeof runMessage>[0], number | null, RegExp]>([
    ['halted', null, /ended/],
    ['error', 9, /error on line 9/],
    ['error', null, /error/],
    ['breakpoint', 12, /breakpoint on line 12/],
    ['waiting-input', null, /waiting for input/],
    ['step-limit', null, /loop that never ends/],
  ])('%s', (reason, line, expected) => {
    const message = runMessage(reason, { line, steps: 10_000 })
    expect(message).toMatch(expected)
    expect(message).toMatch(/^[A-Z]/)
    expect(sentenceCount(message)).toBe(1)
  })

  it('the step limit message says how many steps ran, and what to check', () => {
    expect(runMessage('step-limit', { line: null, steps: 250 })).toContain('250 steps')
    expect(runMessage('step-limit', { line: null, steps: 10_000 })).toBe(
      'The program ran 10,000 steps without ending, so it may be stuck in a loop that never ends: check the jump that should end it.',
    )
    // "1 step", not "1 steps".
    expect(runMessage('step-limit', { line: null, steps: 1 })).toContain('ran 1 step without')
  })

  /** A list of wanted kinds, as `inputPrompt` takes it. */
  const wants = (...kinds: ScanKind[]): MissingValue[] =>
    kinds.map((kind) => ({ kind, width: null }))

  it.each<[MissingValue[], string]>([
    [wants('decimal'), 'Type a whole number, like 42 or -7, and press Enter.'],
    [wants('integer'), 'Type a whole number, like 42 or -7, and press Enter.'],
    [wants('unsigned'), 'Type a whole number, like 42, and press Enter.'],
    [wants('hex'), 'Type a hex number, like 1f, and press Enter.'],
    [wants('character'), 'Type one character and press Enter.'],
    [wants('word'), 'Type one word with no spaces, and press Enter.'],
    [wants('decimal', 'decimal'), 'Type 2 whole numbers with a space between them, like 3 4.'],
    [
      wants('decimal', 'integer', 'unsigned'),
      'Type 3 whole numbers with a space between them, like 3 4 5.',
    ],
    [wants('hex', 'hex'), 'Type 2 hex numbers with a space between them, like 1f 2a.'],
    [wants('decimal', 'hex'), 'Type 2 values: a whole number, then a hex number.'],
    [wants('decimal', 'word'), 'Type 2 values: a whole number, then a word.'],
    [wants('character', 'character'), 'Type 2 characters.'],
    [[{ kind: 'character', width: 3 }], 'Type 3 characters.'],
    [[], 'Type your input and press Enter.'],
  ])('the prompt for %j says what to type', (missing, expected) => {
    const prompt = inputPrompt(missing)
    expect(prompt).toBe(expected)
    expect(sentenceCount(prompt)).toBe(1)
  })

  it('after part of the input, the prompt asks for the rest', () => {
    expect(inputPrompt(wants('decimal'), true)).toBe('Type 1 more whole number.')
    expect(inputPrompt(wants('decimal', 'decimal'), true)).toBe(
      'Type 2 more whole numbers with a space between them, like 3 4.',
    )
    expect(inputPrompt(wants('character'), true)).toBe('Type 1 more character.')
  })

  it('says that the program has ended, or that scanf waits', () => {
    expect(explainEnded()).toMatch(/ended/)
    const waiting = explainWaiting('scanf', inputPrompt(wants('decimal')))
    expect(waiting).toBe(
      '`scanf` (library code) is waiting for input. Type a whole number, like 42 or -7, and press Enter.',
    )
  })

  it('joinExplanation keeps at most three sentences, and never leaves out the stop sentence', () => {
    const stop = { text: 'Stop here.', short: 'Stop.', tiny: 'S.' }
    expect(joinExplanation(['One.', 'Two.'])).toBe('One. Two.')
    expect(joinExplanation(['One.', 'Two.'], stop)).toBe('One. Two. Stop here.')
    expect(joinExplanation(['One.', '', 'Two.'])).toBe('One. Two.')
    // An extra sentence is left out first, the last one first.
    expect(joinExplanation(['One.', { text: 'Two.', fit: 'extra' }, 'Three.'], stop)).toBe(
      'One. Three. Stop here.',
    )
    expect(joinExplanation(['One.', { text: 'Two.', fit: 'extra' }, 'Three.'])).toBe(
      'One. Two. Three.',
    )
    expect(
      joinExplanation([
        'One.',
        { text: 'Two.', fit: 'extra' },
        'Three.',
        { text: 'Four.', fit: 'extra' },
      ]),
    ).toBe('One. Two. Three.')
    // Then a tail sentence is joined to the sentence before it, so its facts stay.
    expect(joinExplanation(['One.', 'Two.', { text: 'Flags: CF=0.', fit: 'tail' }], stop)).toBe(
      'One. Two; flags: CF=0. Stop here.',
    )
    expect(
      joinExplanation(
        ['One.', { text: 'Two.', fit: 'tail' }, { text: 'Three.', fit: 'tail' }],
        stop,
      ),
    ).toBe('One; two. Three. Stop here.')
    // A name in capitals keeps them.
    expect(joinExplanation(['One.', 'Two.', { text: 'ZF=1 now.', fit: 'tail' }], stop)).toBe(
      'One. Two; ZF=1 now. Stop here.',
    )
    // With nothing to leave out or to join, the last two sentences are joined.
    expect(joinExplanation(['One.', 'Two.', 'Three.'], stop)).toBe('One. Two; three. Stop here.')
    expect(joinExplanation(['One.', 'Two.', 'Three.', 'Four.'])).toBe('One. Two. Three; four.')
    // The first sentence starts with the instruction: it is never left out.
    expect(
      joinExplanation(
        [{ text: 'One.', fit: 'extra' }, 'Two.', { text: 'Three.', fit: 'extra' }],
        stop,
      ),
    ).toBe('One. Two. Stop here.')
  })

  it('joinExplanation uses the short stop sentence only when the full one makes it too long', () => {
    const stop = { text: 'Full stop sentence.', short: 'Short.', tiny: 'S.' }
    // 380 + 1 + 19 = 400 characters: still short enough for the full sentence.
    const fits = `${'x'.repeat(379)}.`
    expect(joinExplanation([fits], stop)).toBe(`${fits} Full stop sentence.`)
    const long = `${'x'.repeat(380)}.`
    expect(joinExplanation([long], stop)).toBe(`${long} Short.`)
    // 393 + 1 + 6 = 400 fits with the short one; one more character needs the tiny one.
    const longer = `${'x'.repeat(392)}.`
    expect(joinExplanation([longer], stop)).toBe(`${longer} Short.`)
    const longest = `${'x'.repeat(393)}.`
    expect(joinExplanation([longest], stop)).toBe(`${longest} S.`)
  })
})

/* ───────────────────────────── run-time messages ───────────────────────────── */

describe('run-time error messages', () => {
  it('start with the line, and the summary is their first sentence', () => {
    const problem = badMemoryRead(6, {
      text: 'mov rax, [rbx]',
      address: 0n,
      bytes: 8,
      faultAddress: 0n,
      access: { via: 'operand', registers: [{ name: 'rbx', value: 0n }] },
    })
    expect(problem.error).toMatchObject({ code: 'bad-memory-read', line: 6 })
    expect(
      problem.error.message.startsWith('Line 6: this instruction tried to read memory at 0x0'),
    ).toBe(true)
    expect(problem.error.message).toMatch(/segmentation fault/)
    expect(problem.error.message).toContain('rbx')
    expect(problem.error.message.slice('Line 6: '.length).startsWith(problem.summary)).toBe(true)
    expect(sentenceCount(problem.summary)).toBe(1)
    expect(sentenceCount(problem.error.message)).toBe(3)
  })

  it('without a line the message starts with a capital letter', () => {
    const problem = internalProblem(null)
    expect(problem.error.line).toBeNull()
    expect(problem.error.message).toMatch(/^The emulator hit an internal problem/)
    expect(internalProblem(4).error.message).toMatch(/^Line 4: the emulator/)
  })

  it('explainFault repeats the summary after the instruction or the function name', () => {
    const read = badMemoryRead(6, {
      text: 'pop rax',
      address: 0x40n,
      bytes: 8,
      faultAddress: 0x40n,
      access: { via: 'stack-top' },
    })
    const instruction = explainFault({ kind: 'instruction', text: 'pop rax' }, read)
    // The instruction is named once: after it, the summary says "it".
    expect(instruction).toBe(
      '`pop rax`: it tried to read the top box at 0x40, but your program does not own that address. Nothing changed, and the program stopped.',
    )
    expect(read.error.message).toBe(
      'Line 6: `pop rax` tried to read the top box at 0x40, but your program does not own that address. On a real machine this is called a segmentation fault. Check rsp: it must point into the stack.',
    )

    const text = libraryError(9, {
      reason: 'text-address',
      name: 'printf',
      value: 5n,
      copiedFrom: null,
      pointsAtCode: null,
    })
    const library = explainFault({ kind: 'library', name: 'printf' }, text)
    expect(library.startsWith('`printf` (library code) stopped with an error')).toBe(true)
    expect(library).toContain('ADDRESS')
    expect(sentenceCount(library)).toBe(2)
  })

  it('a write fault says "write to memory", and a partly owned access points at the size', () => {
    const write = badMemoryWrite(5, {
      text: 'mov [rax], rbx',
      address: 0x10n,
      bytes: 8,
      faultAddress: 0x10n,
      access: { via: 'operand', registers: [{ name: 'rax', value: 0x10n }] },
    })
    expect(write.error.message).toContain('this instruction tried to write to memory at 0x10')
    const partial = badMemoryRead(6, {
      text: 'mov rax, [rbx]',
      address: 0x7ffffffdeffcn,
      bytes: 8,
      faultAddress: 0x7ffffffdf000n,
      access: { via: 'operand', registers: [{ name: 'rbx', value: 0x7ffffffdeffcn }] },
    })
    expect(partial.error.message).toBe(
      'Line 6: this instruction tried to read 8 bytes at 0x7ffffffdeffc, but only the first 4 of them belong to your program. On a real machine this is called a segmentation fault. Read fewer bytes, or check the address in this instruction.',
    )
  })

  it('push or call with rsp in read-only memory: the advice is about rsp', () => {
    const problem = writeReadOnly(6, {
      text: 'push rax',
      address: 0x402010n,
      region: 'rodata',
      label: 'msg',
      via: 'stack-top',
    })
    expect(problem.error.message).toBe(
      'Line 6: `push rax` tried to write a new top box at 0x402010, but that memory is read-only. Check rsp: it must point into the stack.',
    )
    expect(problem.error.message).not.toContain('.data')
    expect(problem.stepSummary).toBe(
      'it tried to write a new top box at 0x402010, but that memory is read-only.',
    )
  })

  it.each<[Parameters<typeof libraryError>[1], string]>([
    [
      { reason: 'unknown-conversion', name: 'printf', conversion: '%f' },
      'You can also put `l`, `ll`, `h` or `hh` before the letter, for example `%ld`.',
    ],
    [
      { reason: 'lone-percent', name: 'printf' },
      'Line 7: the text of `printf` ends with a `%` that has no letter after it. To print a percent sign, write `%%`.',
    ],
    [
      { reason: 'text-address', name: 'scanf', value: 5n, copiedFrom: null, pointsAtCode: null },
      'Line 7: `scanf` needs the ADDRESS of its format text (like `"%d"`) in rdi, but rdi holds 0x5, and your program does not own that address. Load the address with `lea`, for example `lea rdi, pattern[rip]`.',
    ],
    [
      {
        reason: 'text-address',
        name: 'printf',
        value: 0x6948n,
        copiedFrom: { label: 'msg', bytes: 8 },
        pointsAtCode: null,
      },
      '`printf` needs the ADDRESS of its text in rdi, but rdi holds 0x6948: the 8 bytes stored at `msg`. `mov` copied those bytes into rdi, not the address of `msg`. To put the address in rdi, write `lea rdi, msg[rip]`.',
    ],
    [
      // The value does not show how many bytes `mov` copied: no count.
      {
        reason: 'text-address',
        name: 'puts',
        value: 0x6948n,
        copiedFrom: { label: 'msg', bytes: null },
        pointsAtCode: null,
      },
      'Line 7: `puts` needs the ADDRESS of its text in rdi, but rdi holds 0x6948: the first bytes stored at `msg`. `mov` copied those bytes into rdi, not the address of `msg`. To put the address in rdi, write `lea rdi, msg[rip]`.',
    ],
    [
      // Nothing was printed: the message says what the call tried to do.
      { reason: 'total-output', name: 'putchar', count: 1 },
      "Line 7: `putchar` tried to print 1 character, but that would make the program's output longer than 1,048,576 characters. So this emulator stopped the program. Check for a loop that prints and never ends.",
    ],
    [
      { reason: 'total-output', name: 'printf', count: 12_345 },
      "Line 7: `printf` tried to print 12,345 characters, but that would make the program's output longer than 1,048,576 characters.",
    ],
  ])('library error %#: plain and true', (detail, expected) => {
    expect(libraryError(7, detail).error.message).toContain(expected)
  })

  it('numbers in messages are written in full', () => {
    expect(hex(0x7ffffffddff8n)).toBe('0x7ffffffddff8')
    const problem = badMemoryRead(1, {
      text: 'mov rax, [rbx]',
      address: 0x7ffffffe0000n,
      bytes: 8,
      faultAddress: 0x7ffffffe0000n,
      access: { via: 'operand', registers: [] },
    })
    expect(problem.error.message).toContain('0x7ffffffe0000')
    expect(problem.error.message).not.toContain('…')
  })
})

/* ───────────────────────────── M8: long explanations ───────────────────────────── */

describe('M8: a long last step still fits in 400 characters', () => {
  /** The last step of a program whose last line is `last`; it stops with ran-off-end. */
  function lastStep(last: string): StepResult {
    const results = stepsOf([
      '.data',
      'arr: .long 1, 2, 3, 4, 5, 6, 7, 8',
      'very_long_array_name_here: .long 1, 2, 3, 4',
      '.text',
      'mov rsi, 0x1111222233334444',
      'mov r12, 0x1111222233334444',
      'mov ecx, 2',
      'mov ebx, 4',
      last,
    ])
    const step = results[results.length - 1]
    expect(step.error?.code).toBe('ran-off-end')
    expect(step.explanation.length, step.explanation).toBeLessThanOrEqual(400)
    expect(sentenceCount(step.explanation), step.explanation).toBeLessThanOrEqual(MAX_SENTENCES)
    return step
  }

  it('first with the shortest stop sentence: every fact of the step stays', () => {
    const step = lastStep('movsx esi, byte ptr arr[rcx*1+3]')
    expect(step.explanation).toContain('= 0x404030 + 0x2 + 3 = 0x404035')
    expect(step.explanation).toContain('so rsi went from 0x1111222233334444 to 0x0000000000000000')
    expect(step.explanation.endsWith(' Then the program stopped with an error.')).toBe(true)
  })

  it('then without the values of the address sum (the address itself stays)', () => {
    const step = lastStep('movsx esi, word ptr arr[rbx+rcx*2+2]')
    expect(step.explanation).toContain('the address is 0x404030 + rbx + rcx×2 + 2 = 0x40403a.')
    expect(step.explanation).toContain('so rsi went from 0x1111222233334444 to 0x0000000000000000')
    expect(step.explanation.endsWith(' Then the program stopped with an error.')).toBe(true)
  })

  it('a long label name is left out of the sum in the compact form: it is in the instruction', () => {
    const step = lastStep('movsx esi, word ptr very_long_array_name_here[rbx+rcx*2+2]')
    expect(step.explanation).toContain('the address is 0x404050 + rbx + rcx×2 + 2 = 0x40405a.')
  })

  it('a step that fits keeps the full form', () => {
    const results = stepsOf([
      '.data',
      'arr: .long 1, 2, 3, 4',
      '.text',
      'mov ecx, 2',
      'mov eax, dword ptr arr[rcx*4]',
      'ret',
    ])
    expect(explanationOf(results, 'mov eax, dword ptr arr[rcx*4]')).toContain(
      'the address is `arr` (0x404030) + rcx×4 = 0x404030 + 0x2×4 = 0x404038.',
    )
  })
})
