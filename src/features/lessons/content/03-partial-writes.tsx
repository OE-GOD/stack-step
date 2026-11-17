import { createEmulator, groupHex, hex } from '../../../emulator'
import { Code, FactTable } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
// The long number does not fit on a line, so `rax` starts with it (see `options`).
const example = String.raw`  mov     al, 7   # 8 bits
  mov     ah, 5   # 8 bits
  mov     ax, 9   # 16 bits
  mov     eax, 7  # 32 bits
  ret
`
const EXAMPLE_START = 0x1111222233334444n

// The check question: a 32-bit write onto a register whose top half is not 0. The long
// starting value is in the prompt, so the code line is short enough for a phone.
const START = 0xaaaabbbbccccddddn
const WRITTEN = 0x99n
const checkCode = [`  mov     ecx, ${hex(WRITTEN)}`]

/** The right answer: run the line in the emulator, starting with rcx = START, and read rcx. */
function rcxAfterCheck(): bigint {
  const made = createEmulator(`${checkCode.join('\n')}\n  ret\n`, {
    initialRegisters: { rcx: START },
  })
  if (!made.ok) throw new Error('The check program of lesson 3 does not assemble.')
  made.emulator.run()
  return made.emulator.readRegister('rcx')
}

const TOP_32_BITS = 0xffffffff00000000n
const LOWEST_BYTE = 0xffn
const LOWEST_16_BITS = 0xffffn

const lesson: LessonContent = {
  id: 'partial-writes',
  idea: 'An 8-bit or 16-bit write changes only its own bits, but a 32-bit write also sets the top 32 bits to 0.',
  analogy: {
    title: 'A whiteboard with 16 digits',
    text: 'Picture `rax` as a whiteboard with 16 hex digits. To write `al`, you change only the last 2 digits. To write `ax`, you change only the last 4. To write `eax`, you change the last 8 and also write zeros over the 8 on the left.',
  },
  body: (
    <>
      <p>
        In hex, <Code>rax</Code> has 16 digits. When you write to a part of <Code>rax</Code>, that
        part gets the new value. What happens to the other digits depends on the size of the part.
      </p>
      <FactTable
        caption="Writing to a part of `rax`"
        head={['Part', 'Bits', 'Digits it writes', 'The other digits']}
        rows={[
          ['`al`', '8', 'the last 2', 'stay the same'],
          ['`ah`', '8', 'the 2 before the last 2', 'stay the same'],
          ['`ax`', '16', 'the last 4', 'stay the same'],
          ['`eax`', '32', 'the last 8', 'become 0'],
        ]}
      />
      <p>
        The same rules work for every register, for example <Code>bl</Code>, <Code>si</Code>,{' '}
        <Code>r8w</Code> and <Code>r8d</Code>. Be careful with <Code>ah</Code>: it is the second
        byte from the right, not the top byte of <Code>rax</Code>.
      </p>
      <p>
        The 32-bit write is different. It also sets the top 32 bits to 0: the 8 digits on the left.
        Many beginners expect those digits to stay. It is the most common mistake with registers.
      </p>
      <p>
        The rule is also useful. <Code>mov eax, 0</Code> sets all 64 bits of <Code>rax</Code> to 0.
        You will see this line in many programs.
      </p>
    </>
  ),
  example: {
    intro: `\`rax\` starts with \`0x${groupHex(EXAMPLE_START)}\`. Press the \`rax\` row to open it and see its parts. Then press Step until the program ends: 5 steps.`,
    stepper: {
      source: example,
      options: { initialRegisters: { rax: EXAMPLE_START } },
      registers: ['rax'],
    },
    watchFor: [
      'Line 1 writes `al`: the last 2 digits of `rax` become `07`. The other 14 stay.',
      'Line 2 writes `ah`: digits 3 and 4 from the right become `05`. Line 3 writes `ax`: the last 4 become `0009`.',
      'Line 4 writes `eax`: `rax` becomes `0x0000 0000 0000 0007`. The 8 digits on the left are now zeros.',
      'With the row open, line 4 also shows a warning and the value from before the step.',
    ],
  },
  check: {
    kind: 'hex',
    prompt: `\`rcx\` holds \`0x${groupHex(START)}\`. Then this line runs. What does \`rcx\` hold now?`,
    code: checkCode,
    label: '`rcx` now',
    digits: 16,
    answer: rcxAfterCheck,
    wrongAnswers: [
      {
        value: () => (START & TOP_32_BITS) | WRITTEN,
        feedback:
          'You kept the left half. A write to `ecx` (32 bits) also sets the top 32 bits of `rcx` to 0.',
      },
      {
        value: () => (START & ~LOWEST_BYTE) | WRITTEN,
        feedback:
          'You changed only the last 2 digits, as a write to `cl` would. The register name sets the size, not the number: `ecx` writes 32 bits.',
      },
      {
        value: () => (START & ~LOWEST_16_BITS) | WRITTEN,
        feedback:
          'You changed only the last 4 digits, as a write to `cx` would. `ecx` writes 32 bits, and the top 32 bits of `rcx` become 0.',
      },
    ],
    rightFeedback:
      '`ecx` is 32 bits, so it becomes `0x0000 0099`, and the top 32 bits of `rcx` become 0.',
    hint: 'Start from the 16 digits of `rcx`. Then use the rule for a 32-bit name.',
  },
  recap: [
    'An 8-bit or 16-bit write changes only its own bits.',
    'A 32-bit write also sets the top 32 bits to 0.',
    '`ah` is the second byte from the right.',
    '`mov eax, 0` sets all of `rax` to 0.',
  ],
  practiceTopic: 'subregister-writes',
}

export default lesson
