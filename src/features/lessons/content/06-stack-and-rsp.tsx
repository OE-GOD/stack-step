import { createEmulator, groupHex } from '../../../emulator'
import { Code, Steps, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
const example = String.raw`  mov     rax, 1  # rax = 1
  mov     rbx, 2  # rbx = 2
  push    rax     # box = 1
  push    rbx     # box = 2
  pop     rax     # rax = 2
  pop     rbx     # rbx = 1
  ret             # end
`

// The check question: rsp after one push. The start is not a value from the example, so
// the answer is not printed anywhere on the page.
const RSP_BEFORE = 0x7ffffffdd7a0n
const checkCode = ['  push    rbx']

/**
 * The right answer: run the push in the emulator, starting with rsp = RSP_BEFORE, and read
 * rsp after that one step. (The pop and the ret only let the program end cleanly.)
 */
function rspAfterPush(): bigint {
  const source = `${checkCode.join('\n')}\n  pop     rbx\n  ret\n`
  const made = createEmulator(source, { initialRsp: RSP_BEFORE })
  if (!made.ok) throw new Error('The check program of lesson 6 does not assemble.')
  made.emulator.step()
  return made.emulator.readRegister('rsp')
}

/**
 * Subtracting 8 from a last digit of 0 needs a borrow. Borrowing 10 (decimal) instead of
 * 16 (hex) makes the last digit 2 instead of 8: 6 less than the right answer.
 */
const DECIMAL_BORROW_SLIP = 6n

const lesson: LessonContent = {
  id: 'stack-and-rsp',
  idea: '`rsp` points to the top box of the stack: `push` adds a box (rsp goes down 8), and `pop` takes it off (rsp goes up 8).',
  analogy: {
    title: 'A pile of plates',
    text: 'In a pile of plates, you add a plate on top and take a plate from the top. The last plate you put on is the first one you take off. One difference: the stack grows toward lower addresses. Our pictures draw high addresses at the top, so the newest box is drawn lowest.',
  },
  body: (
    <>
      <p>
        The <Term>stack</Term> is a part of memory that works like a pile of boxes. Each{' '}
        <Term>box</Term> is 8 bytes. <Code>rsp</Code> holds the address of the newest box: the{' '}
        <Term>top of the stack</Term>.
      </p>
      <p>
        <Code>push rbx</Code> adds a box in two steps:
      </p>
      <Steps
        items={['rsp goes down by 8.', 'The value of `rbx` is copied into the new top box.']}
      />
      <p>
        <Code>pop rbx</Code> takes the top box off, in the opposite order:
      </p>
      <Steps items={['The top box is copied into `rbx`.', 'rsp goes up by 8.']} />
      <p>
        After a pop, the old box still holds its value, but it is no longer part of the stack. The
        Stack panel marks it as a leftover.
      </p>
      <p>
        <Code>push</Code> and <Code>pop</Code> work with 64-bit registers such as <Code>rax</Code>.{' '}
        <Code>push eax</Code> is an error.
      </p>
      <p>
        The last box pushed is the first box popped. Pop in the reverse order of the pushes, and
        each value goes back where it was. Push two registers and pop them in the same order, and
        their values swap. The example does this.
      </p>
    </>
  ),
  example: {
    intro:
      'Press Step until the program ends: 7 steps. Watch `rsp` and the Stack panel. The “return address” box is there from the start: lesson 8 explains it.',
    stepper: { source: example, registers: ['rax', 'rbx', 'rsp'], showStack: true },
    watchFor: [
      'Line 3: rsp goes from `0x7fff fffd dff8` to `0x7fff fffd dff0`, 8 less. The explanation writes these short, as `0x…dff8` and `0x…dff0`. The new box holds 1.',
      'Line 4 adds a box below it, and rsp is `0x7fff fffd dfe8`. The newest box is drawn lowest.',
      'Line 5 copies the top box (2) into `rax`, then rsp goes up to `0x7fff fffd dff0`. The old box is now a leftover.',
      'After line 6, `rax` is 2 and `rbx` is 1. Popping in the same order swapped them.',
    ],
  },
  check: {
    kind: 'hex',
    prompt: `rsp is \`0x${groupHex(RSP_BEFORE, 0)}\`. Then this line runs. What is rsp now?`,
    code: checkCode,
    label: 'rsp after the push',
    answer: rspAfterPush,
    wrongAnswers: [
      {
        value: () => RSP_BEFORE + 8n,
        feedback:
          'rsp went the wrong way. The stack grows toward lower addresses, so `push` makes rsp go down by 8.',
      },
      {
        value: () => rspAfterPush() - DECIMAL_BORROW_SLIP,
        feedback:
          'You subtracted as in decimal. In hex, `0x10` − 8 = 8, so `a0` − 8 = `98`, not `92`.',
      },
      {
        value: () => RSP_BEFORE,
        feedback:
          '`push` always moves rsp. First rsp goes down by 8, then the value is copied into the new top box.',
      },
      {
        value: () => RSP_BEFORE - 1n,
        feedback: 'rsp moves by one whole box: 8 bytes, not 1.',
      },
    ],
    rightFeedback: '`push` makes rsp go down by 8, and in hex `a0` − 8 = `98`.',
    hint: 'Start from the value of rsp. Which way does it move, and by how many bytes?',
  },
  recap: [
    'A box is 8 bytes. rsp points to the top box: the top of the stack.',
    '`push`: rsp goes down 8, then the value is copied into the new top box.',
    '`pop`: the top box is copied into the register, then rsp goes up 8.',
    'Pop in reverse order to restore values. Pop in the same order to swap them.',
  ],
  practiceTopic: 'rsp-tracker',
}

export default lesson
