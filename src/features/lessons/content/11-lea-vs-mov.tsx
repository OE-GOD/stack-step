import { createEmulator } from '../../../emulator'
import { Code, FactTable, Note } from '../components'
import type { LessonContent } from '../types'

// The same data as lesson 10. No comments: the `lea` line alone is 27 characters, the most
// that fits in the MiniStepper's code box on a phone (limits: components/index.ts). The
// explanation under the code says what each line did.
const example = String.raw`  .data
numbers:
  .quad   0x11, 0x22, 0x33
  .text
main:
  lea     rax, numbers[rip]
  mov     rcx, numbers[rip]
  lea     rdx, 8[rax]
  mov     rsi, 8[rax]
  ret
`

// The check question: the same data, and `lea` with a number in front of the brackets. It
// adds 16, not 8 as the example does, so its answer is not printed anywhere on the page.
const CHECK_CODE = [
  '  .data',
  'numbers:',
  '  .quad   0x11, 0x22, 0x33',
  '  .text',
  '  lea     rbx, numbers[rip]',
  '  lea     rax, 16[rbx]',
] as const

/** The address of `numbers` that the prompt gives. */
const NUMBERS_ADDRESS = 0x404030n

interface CheckRun {
  /** What `lea rax, 16[rbx]` put in `rax`: the right answer. */
  rax: bigint
  /** The address in `rbx`. */
  rbx: bigint
  /** The number stored at `rbx`. */
  atRbx: bigint
  /** The number stored at `rbx` + 16: what `mov rax, 16[rbx]` would copy. */
  atRbxPlus16: bigint
}

/**
 * Run the lines of the question in the emulator. Two more lines, which the question does
 * not show, read the numbers that a student who thinks `lea` reads memory would give.
 * Throws if `numbers` is not at the address the prompt gives.
 */
function runCheck(): CheckRun {
  const hidden = ['  mov     rcx, 16[rbx]', '  mov     rdx, [rbx]', '  ret']
  const made = createEmulator(`${[...CHECK_CODE, ...hidden].join('\n')}\n`)
  if (!made.ok) throw new Error('The check code of lesson 11 does not assemble.')
  const { emulator } = made
  const run = emulator.run()
  if (run.reason !== 'halted') throw new Error(run.message)
  const rbx = emulator.readRegister('rbx')
  if (rbx !== NUMBERS_ADDRESS)
    throw new Error('The check code of lesson 11 does not match its prompt.')
  return {
    rax: emulator.readRegister('rax'),
    rbx,
    atRbx: emulator.readRegister('rdx'),
    atRbxPlus16: emulator.readRegister('rcx'),
  }
}

const lesson: LessonContent = {
  id: 'lea-vs-mov',
  idea: 'With brackets, `mov` copies what is stored at the address, but `lea` puts the address itself in the register.',
  analogy: {
    title: 'The address, or what is inside',
    text: 'Memory is a long street of houses, and each house has an address. `lea` writes an address on a card: it never goes to the house. `mov` goes to the house and brings back a copy of what is inside.',
  },
  body: (
    <>
      <p>
        Lesson 10 showed that brackets mean “the memory at this address”. <Code>lea</Code>{' '}
        calculates the same address, but then it stops. It puts the address itself in the register
        and never reads memory.
      </p>
      <FactTable
        caption="Same operand, `numbers[rip]`, two results"
        head={['Instruction', 'What goes in the register']}
        rows={[
          ['`mov`', '`0x11`: the number stored at `numbers`'],
          ['`lea`', '`0x404030`: the address of `numbers`'],
        ]}
      />
      <p>
        Because <Code>lea</Code> only does the math, it can also add. <Code>lea rdx, 8[rax]</Code>{' '}
        puts <Code>rax</Code> + 8 in <Code>rdx</Code>, and no memory is read.
      </p>
      <p>
        Why would you want an address? Some functions need to know <strong>where</strong> something
        is:
      </p>
      <ul>
        <li>
          <Code>printf</Code> needs the address of its text. So you write{' '}
          <Code>lea rdi, message[rip]</Code> before the call.
        </li>
        <li>
          <Code>scanf</Code> needs the address of a variable. It stores the number it reads at that
          address.
        </li>
      </ul>
      <Note>
        Lesson 14 explains why the address goes in <Code>rdi</Code>.
      </Note>
    </>
  ),
  example: {
    intro: 'Press Step until the program ends: 5 steps. Compare each register with the Data panel.',
    stepper: { source: example, registers: ['rax', 'rcx', 'rdx', 'rsi'], showData: true },
    watchFor: [
      'After line 6, `rax` is `0x404030`: the address of `numbers`. The Data panel shows the same address.',
      'Line 7 has the same operand, but `mov` reads memory: `rcx` gets `0x11`.',
      'Line 8 puts `0x404038` in `rdx`: 8 more than `rax`. No memory is read.',
      'Line 9 reads the 8 bytes at `0x404038`: `rsi` gets `0x22`.',
    ],
  },
  check: {
    kind: 'hex',
    prompt: '`numbers` is at address `0x404030`. What is in `rax` after these lines run?',
    code: CHECK_CODE,
    label: '`rax` =',
    answer: () => runCheck().rax,
    wrongAnswers: [
      {
        value: () => runCheck().atRbxPlus16,
        feedback:
          'That is the number stored at `rbx` + 16. `mov rax, 16[rbx]` would copy it, but `lea` never reads memory. It gives the address.',
      },
      {
        value: () => runCheck().atRbx + 16n,
        feedback:
          'That adds 16 to `0x11`, the number stored at the address in `rbx`. `lea` reads no number at all: it adds 16 to the address itself.',
      },
      {
        value: () => runCheck().rbx,
        feedback: 'That is the address in `rbx`, without the 16. `lea` does the math: `rbx` + 16.',
      },
      {
        value: () => runCheck().rbx + 0x16n,
        feedback:
          'You added `0x16`. The 16 in `16[rbx]` is a decimal number: in hex, it is `0x10`.',
      },
    ],
    rightFeedback:
      '`lea` calculates `rbx` + 16 = `0x404040` and puts that address in `rax`. It does not read memory.',
    hint: 'First find the address in `rbx`. Then remember that `lea` only does the math: it reads no memory.',
  },
  recap: [
    'With brackets, `mov` copies what is stored at the address.',
    '`lea` puts the address itself in the register. It never reads memory.',
    '`printf` and `scanf` need addresses, so you get them with `lea`.',
  ],
  practiceTopic: 'indirect-addressing',
}

export default lesson
