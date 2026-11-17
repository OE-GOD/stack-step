/**
 * Three hand-written trace-table problems, in the shape that the `homework-table`
 * generator will produce. They are used by the harness page (demo.html) and by the tests
 * of the view. They are NOT part of the site: real problems come from the generator,
 * which gets its answer key from the emulator.
 *
 * Every value below was worked out by hand with the write rules of x86-64:
 * - a 32-bit name (`eax`, `edi`) clears the top 32 bits of its register;
 * - an 8-bit or 16-bit name (`cl`, `bx`, `r10b`, `r10w`) changes only its own bits.
 * `sampleProblems.test.ts` repeats the arithmetic with plain BigInt maths.
 */
import type { Chip, Field, Mistake, Problem } from '../../types'

/** A wrong chip that stands for a known mistake when it sits on "its" line. */
interface Trap {
  chipId: string
  fieldId: string
  mistake: Mistake
}

interface Sample {
  seed: number
  /** The sentence of the question, or null for a problem that has none. */
  text: string | null
  /** The heading of the table of starting values, or undefined for the default one. */
  registersTitle?: string
  registers: readonly { name: string; value: string }[]
  /** The five instructions. */
  lines: readonly string[]
  /** The id of the right chip of each line, in line order. */
  right: readonly string[]
  /** All chips, in the order the tray shows them (mixed up by hand). */
  chips: readonly Chip[]
  /** In the order of the specification: the first trap that matches is named. */
  traps: readonly Trap[]
  reason: string
  stepperNote: string
  initialRegisters: InitialRegisters
}

/** The starting register values of the stepper payload (register name → value). */
type InitialRegisters = NonNullable<NonNullable<Problem['stepper']['options']>['initialRegisters']>

function build(sample: Sample): Problem {
  const fields: Field[] = sample.right.map((chipId, index) => ({
    id: `line${index + 1}`,
    label: `Line ${index + 1}`,
    kind: { type: 'chip' },
    expected: chipId,
    expectedDisplay: sample.chips.find((chip) => chip.id === chipId)?.label ?? chipId,
  }))

  const prompt: Problem['prompt'] = [
    ...(sample.text === null ? [] : [{ type: 'text' as const, text: sample.text }]),
    { type: 'registers', title: sample.registersTitle, rows: sample.registers },
    { type: 'code', lines: sample.lines },
  ]

  return {
    id: `homework-table-${sample.seed}`,
    topic: 'homework-table',
    seed: sample.seed,
    view: 'trace-table',
    prompt,
    fields,
    chips: sample.chips,
    reason: sample.reason,
    stepper: {
      code: [
        '.intel_syntax noprefix',
        '.globl main',
        'main:',
        ...sample.lines.map((line) => `    ${line}`),
        '    ret',
        '',
      ].join('\n'),
      options: { initialRegisters: sample.initialRegisters },
      note: sample.stepperNote,
    },
    diagnose(answers) {
      const trap = sample.traps.find((entry) => answers[entry.fieldId] === entry.chipId)
      return trap?.mistake ?? null
    },
  }
}

const QUESTION =
  'Follow the code one line at a time. For each line, place the chip that says which register changed and what it holds after the line.'

/*
 * Problem 1
 *   rax = 0x1111222233334444   rbx = 0x0000000000000010   rcx = 0xaaaabbbbccccdddd
 *
 *   1  mov eax, 5     eax is 32 bits: the top half of rax becomes 0.   rax = 0x0000000000000005
 *   2  add rbx, rax   0x10 + 0x5 = 0x15 (rax is 5 since line 1).       rbx = 0x0000000000000015
 *   3  mov cl, 0x7f   cl is 8 bits: only the last two digits change.   rcx = 0xaaaabbbbccccdd7f
 *   4  inc rax        0x5 + 1 = 0x6.                                   rax = 0x0000000000000006
 *   5  xor ebx, ebx   a value xor itself is 0; ebx clears the top.     rbx = 0x0000000000000000
 *
 * Tempting wrong chips
 *   p1-keep   rax = 0x1111222200000005   line 1 with the old top half kept (forgot-zero-upper)
 *   p1-stale  rbx = 0x1111222233334454   line 2 with the old rax: 0x10 + 0x1111222233334444 (stale-value)
 *   p1-clear  rcx = 0x000000000000007f   line 3 with the other 56 bits cleared (cleared-upper-wrongly)
 *   p1-other  rax = 0x0000000000000015   the right value of line 2 on the wrong register (no named mistake)
 */
const PROBLEM_1 = build({
  seed: 1,
  text: QUESTION,
  registersTitle: 'Starting values',
  registers: [
    { name: 'rax', value: '0x1111222233334444' },
    { name: 'rbx', value: '0x0000000000000010' },
    { name: 'rcx', value: '0xaaaabbbbccccdddd' },
  ],
  lines: ['mov eax, 5', 'add rbx, rax', 'mov cl, 0x7f', 'inc rax', 'xor ebx, ebx'],
  right: ['p1-a', 'p1-b', 'p1-c', 'p1-d', 'p1-e'],
  chips: [
    { id: 'p1-b', label: 'rbx = 0x0000000000000015' },
    { id: 'p1-keep', label: 'rax = 0x1111222200000005' },
    { id: 'p1-c', label: 'rcx = 0xaaaabbbbccccdd7f' },
    { id: 'p1-a', label: 'rax = 0x0000000000000005' },
    { id: 'p1-other', label: 'rax = 0x0000000000000015' },
    { id: 'p1-e', label: 'rbx = 0x0000000000000000' },
    { id: 'p1-clear', label: 'rcx = 0x000000000000007f' },
    { id: 'p1-d', label: 'rax = 0x0000000000000006' },
    { id: 'p1-stale', label: 'rbx = 0x1111222233334454' },
  ],
  traps: [
    {
      chipId: 'p1-keep',
      fieldId: 'line1',
      mistake: {
        code: 'forgot-zero-upper',
        message:
          'You kept the top half of rax. Writing a 32-bit name such as `eax` always clears the top 32 bits.',
      },
    },
    {
      chipId: 'p1-stale',
      fieldId: 'line2',
      mistake: {
        code: 'stale-value',
        message: 'You used an old value of rax. Line 1 changed rax to 0x5.',
      },
    },
    {
      chipId: 'p1-clear',
      fieldId: 'line3',
      mistake: {
        code: 'cleared-upper-wrongly',
        message:
          'You cleared the other bits of rcx. Writing an 8-bit name such as `cl` changes only the lowest 8 bits.',
      },
    },
  ],
  reason:
    'Writing `eax` (32 bits) clears the top 32 bits of rax, so only 0x5 is left. Writing `cl` (8 bits) changes only the lowest 8 bits of rcx.',
  stepperNote: 'Step one line at a time and watch which register changes.',
  initialRegisters: { rax: 0x1111222233334444n, rbx: 0x10n, rcx: 0xaaaabbbbccccddddn },
})

/*
 * Problem 2 (four registers, no sentence, no heading of its own)
 *   rax = 0x00000000000000ff   rbx = 0x5555666677778888
 *   rdx = 0x0000000000000020   rsi = 0x9999aaaabbbbcccc
 *
 *   1  mov bx, 0x1234       bx is 16 bits: only the last four digits change.  rbx = 0x5555666677771234
 *   2  movzx edx, bl        bl is 0x34 since line 1; edx clears the top.      rdx = 0x0000000000000034
 *   3  add eax, edx         0xff + 0x34 = 0x133.                              rax = 0x0000000000000133
 *   4  lea rsi, [rax+rdx]   0x133 + 0x34 = 0x167 (lea reads no memory).       rsi = 0x0000000000000167
 *   5  and ebx, 0xff        0x77771234 and 0xff = 0x34; ebx clears the top.   rbx = 0x0000000000000034
 *
 * Tempting wrong chips
 *   p2-clear  rbx = 0x0000000000001234   line 1 with the other 48 bits cleared (cleared-upper-wrongly)
 *   p2-stale  rdx = 0x0000000000000088   line 2 with the old bl, 0x88 (stale-value)
 *   p2-keep   rbx = 0x5555666600000034   line 5 with the old top half kept (forgot-zero-upper)
 *   p2-other  rax = 0x0000000000000167   the right value of line 4 on the wrong register (no named mistake)
 */
const PROBLEM_2 = build({
  seed: 2,
  text: null,
  registers: [
    { name: 'rax', value: '0x00000000000000ff' },
    { name: 'rbx', value: '0x5555666677778888' },
    { name: 'rdx', value: '0x0000000000000020' },
    { name: 'rsi', value: '0x9999aaaabbbbcccc' },
  ],
  lines: ['mov bx, 0x1234', 'movzx edx, bl', 'add eax, edx', 'lea rsi, [rax+rdx]', 'and ebx, 0xff'],
  right: ['p2-a', 'p2-b', 'p2-c', 'p2-d', 'p2-e'],
  chips: [
    { id: 'p2-stale', label: 'rdx = 0x0000000000000088' },
    { id: 'p2-e', label: 'rbx = 0x0000000000000034' },
    { id: 'p2-a', label: 'rbx = 0x5555666677771234' },
    { id: 'p2-other', label: 'rax = 0x0000000000000167' },
    { id: 'p2-c', label: 'rax = 0x0000000000000133' },
    { id: 'p2-clear', label: 'rbx = 0x0000000000001234' },
    { id: 'p2-b', label: 'rdx = 0x0000000000000034' },
    { id: 'p2-keep', label: 'rbx = 0x5555666600000034' },
    { id: 'p2-d', label: 'rsi = 0x0000000000000167' },
  ],
  traps: [
    {
      chipId: 'p2-keep',
      fieldId: 'line5',
      mistake: {
        code: 'forgot-zero-upper',
        message:
          'You kept the top half of rbx. Writing a 32-bit name such as `ebx` always clears the top 32 bits.',
      },
    },
    {
      chipId: 'p2-stale',
      fieldId: 'line2',
      mistake: {
        code: 'stale-value',
        message: 'You used an old value of `bl`. Line 1 changed `bl` to 0x34.',
      },
    },
    {
      chipId: 'p2-clear',
      fieldId: 'line1',
      mistake: {
        code: 'cleared-upper-wrongly',
        message:
          'You cleared the other bits of rbx. Writing a 16-bit name such as `bx` changes only the lowest 16 bits.',
      },
    },
  ],
  reason:
    'Writing `bx` (16 bits) changes only the lowest 16 bits of rbx. Writing `ebx` (32 bits) on line 5 clears the top 32 bits, so only 0x34 is left.',
  stepperNote: 'Step one line at a time and watch rbx on lines 1 and 5.',
  initialRegisters: {
    rax: 0xffn,
    rbx: 0x5555666677778888n,
    rdx: 0x20n,
    rsi: 0x9999aaaabbbbccccn,
  },
})

/*
 * Problem 3 (eight chips, long instructions, a register with a short and a long name)
 *   rdi = 0xdeadbeef00000007   rsi = 0x0000000000000003   r10 = 0xffffffffffffff00
 *
 *   1  lea rsi, [rdi+rsi*8+16]   0x…07 + 3×8 + 16 = 0x…07 + 0x18 + 0x10.     rsi = 0xdeadbeef0000002f
 *   2  mov edi, 0x12345678       edi is 32 bits: the top half becomes 0.     rdi = 0x0000000012345678
 *   3  mov r10b, 0x2a            r10b is 8 bits: only the last two digits.   r10 = 0xffffffffffffff2a
 *   4  add rdi, rsi              0x12345678 + 0xdeadbeef0000002f.            rdi = 0xdeadbeef123456a7
 *   5  dec r10w                  0xff2a − 1 = 0xff29; 16 bits change.        r10 = 0xffffffffffffff29
 *
 * Tempting wrong chips
 *   p3-keep   rdi = 0xdeadbeef12345678   line 2 with the old top half kept (forgot-zero-upper)
 *   p3-stale  rdi = 0x000000001234567b   line 4 with the old rsi: 0x12345678 + 3 (stale-value)
 *   p3-clear  r10 = 0x000000000000002a   line 3 with the other 56 bits cleared (cleared-upper-wrongly)
 */
const PROBLEM_3 = build({
  seed: 3,
  text: QUESTION,
  registers: [
    { name: 'rdi', value: '0xdeadbeef00000007' },
    { name: 'rsi', value: '0x0000000000000003' },
    { name: 'r10', value: '0xffffffffffffff00' },
  ],
  lines: [
    'lea rsi, [rdi+rsi*8+16]',
    'mov edi, 0x12345678',
    'mov r10b, 0x2a',
    'add rdi, rsi',
    'dec r10w',
  ],
  right: ['p3-a', 'p3-b', 'p3-c', 'p3-d', 'p3-e'],
  chips: [
    { id: 'p3-c', label: 'r10 = 0xffffffffffffff2a' },
    { id: 'p3-keep', label: 'rdi = 0xdeadbeef12345678' },
    { id: 'p3-d', label: 'rdi = 0xdeadbeef123456a7' },
    { id: 'p3-clear', label: 'r10 = 0x000000000000002a' },
    { id: 'p3-a', label: 'rsi = 0xdeadbeef0000002f' },
    { id: 'p3-stale', label: 'rdi = 0x000000001234567b' },
    { id: 'p3-e', label: 'r10 = 0xffffffffffffff29' },
    { id: 'p3-b', label: 'rdi = 0x0000000012345678' },
  ],
  traps: [
    {
      chipId: 'p3-keep',
      fieldId: 'line2',
      mistake: {
        code: 'forgot-zero-upper',
        message:
          'You kept the top half of rdi. Writing a 32-bit name such as `edi` always clears the top 32 bits.',
      },
    },
    {
      chipId: 'p3-stale',
      fieldId: 'line4',
      mistake: {
        code: 'stale-value',
        message: 'You used an old value of rsi. Line 1 changed rsi to 0xdeadbeef0000002f.',
      },
    },
    {
      chipId: 'p3-clear',
      fieldId: 'line3',
      mistake: {
        code: 'cleared-upper-wrongly',
        message:
          'You cleared the other bits of r10. Writing an 8-bit name such as `r10b` changes only the lowest 8 bits.',
      },
    },
  ],
  reason:
    'Writing `edi` (32 bits) clears the top 32 bits of rdi, so only 0x12345678 is left. `r10b` and `r10w` change only their own bits of r10.',
  stepperNote: 'Step one line at a time and watch rdi on line 2 and r10 on line 3.',
  initialRegisters: { rdi: 0xdeadbeef00000007n, rsi: 0x3n, r10: 0xffffffffffffff00n },
})

/** The sample problems: `?problem=1`, `2` and `3` on the harness page. */
export const SAMPLE_PROBLEMS: readonly Problem[] = [PROBLEM_1, PROBLEM_2, PROBLEM_3]
