import { Code, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
const example = String.raw`  mov     rax, 0x2a  # 42
  mov     rbx, 0xff  # 255
  mov     rcx, rax   # copy
  ret                # end
`

/** "64 ÷ 4 = 16" with spaces that never break, so the sum stays on one line. */
const SIXTEEN = '64 ÷ 4 = 16'

const lesson: LessonContent = {
  id: 'registers-and-memory',
  idea: 'The CPU works on values held in a few fast registers, and it keeps everything else in memory.',
  analogy: {
    title: 'Cooking in a kitchen',
    text: 'When you cook, your hands hold the few things you are working with right now. The fridge holds everything else. To use something from the fridge, you first take it in your hands. One difference: the CPU takes a copy, so the value also stays in memory.',
  },
  body: (
    <>
      <p>
        A <Term>register</Term> is a small, very fast storage place inside the CPU. There are 16
        general registers, with names such as <Code>rax</Code>, <Code>rbx</Code> and{' '}
        <Code>rcx</Code>.
      </p>
      <p>
        <Term>Memory</Term> is much bigger, but slower. It is one long row of bytes. Every byte has
        a number, its <Term>address</Term>, so the CPU can find it.
      </p>
      <p>
        Register values and addresses are usually written in <Term>hex</Term> (base 16). A hex
        number starts with <Code>0x</Code>. Its digits are 0 to 9, then a (10) to f (15):{' '}
        <Code>0x2a</Code> is 42.
      </p>
      <ul>
        <li>
          A <Term>bit</Term> is 0 or 1.
        </li>
        <li>
          A <Term>byte</Term> is 8 bits.
        </li>
        <li>One hex digit is 4 bits, so one byte is 2 hex digits.</li>
        <li>A register is 64 bits: that is 8 bytes, or 16 hex digits.</li>
      </ul>
    </>
  ),
  example: {
    intro:
      'Press Step until the program ends: 4 steps. Watch the values in `rax`, `rbx` and `rcx`.',
    stepper: { source: example, registers: ['rax', 'rbx', 'rcx'] },
    watchFor: [
      'After line 1, `rax` is `0x0000 0000 0000 002a`: 16 hex digits, most of them 0. The gaps only help you count the digits.',
      'After line 2, `rbx` is `0x0000 0000 0000 00ff`: `0xff` is one full byte.',
      'Line 3 copies: `rcx` becomes `0x0000 0000 0000 002a`, and `rax` keeps its value.',
    ],
  },
  check: {
    kind: 'choice',
    prompt: 'How many hex digits does a 64-bit register have?',
    options: [
      {
        id: 'four',
        label: '4',
        feedback: `4 is the number of bits in one hex digit. A register has 64 bits, and ${SIXTEEN}.`,
      },
      {
        id: 'eight',
        label: '8',
        feedback:
          '8 is the number of bytes in a register. Each byte is 2 hex digits, so 8 bytes are 16 hex digits.',
      },
      {
        id: 'sixteen',
        label: '16',
        correct: true,
        feedback: `Each hex digit is 4 bits, and ${SIXTEEN}.`,
      },
      {
        id: 'sixty-four',
        label: '64',
        feedback:
          '64 is the number of bits. One hex digit holds 4 bits, so 64 bits are 16 hex digits.',
      },
    ],
  },
  recap: [
    'Registers are few, small and fast. Memory is big, and every byte has an address.',
    'A byte is 8 bits, or 2 hex digits.',
    'A register is 64 bits: 8 bytes, or 16 hex digits.',
    'Hex numbers start with `0x`.',
  ],
  practiceTopic: 'register-names',
}

export default lesson
