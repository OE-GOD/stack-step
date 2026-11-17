import { Code, FactTable, Note, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
const example = String.raw`  mov     al, 0x7f # 127
  add     al, 1    # 127 + 1
  mov     al, 0xff # 255
  add     al, 1    # 255 + 1
  mov     eax, 5   # eax = 5
  sub     eax, 5   # 5 - 5
  ret              # end
`

const lesson: LessonContent = {
  id: 'add-sub-flags',
  idea: '`add` and `sub` change the destination, and they also set four one-bit flags that describe the result.',
  analogy: {
    title: 'Lights on a dashboard',
    text: 'A car has small lights on its dashboard. They do not drive the car: they tell you what just happened, for example that the fuel is low. The flags work like these lights. Each `add` or `sub` turns each flag on (1) or off (0) to describe its result.',
  },
  body: (
    <>
      <p>
        <Code>add</Code> and <Code>sub</Code> work on two operands. The result goes into the first
        one, the destination:
      </p>
      <ul>
        <li>
          <Code>add rax, rbx</Code> means <Code>rax</Code> = <Code>rax</Code> + <Code>rbx</Code>.
        </li>
        <li>
          <Code>sub rax, rbx</Code> means <Code>rax</Code> = <Code>rax</Code> − <Code>rbx</Code>.
        </li>
      </ul>
      <p>
        They also set four <Term>flags</Term>. A flag is one bit: 0 or 1. Each flag says one thing
        about the result.
      </p>
      <FactTable
        caption="The four flags"
        head={['Flag', 'Name', 'It is 1 when the result …']}
        rows={[
          ['ZF', 'zero', 'is 0'],
          ['SF', 'sign', 'is negative: its top bit is 1'],
          ['CF', 'carry', 'did not fit as an unsigned number'],
          ['OF', 'overflow', 'did not fit as a signed number'],
        ]}
      />
      <p>
        The same bits can be read in two ways. As an <Term>unsigned</Term> number, a byte is 0 to
        255. As a <Term>signed</Term> number, the top bit gives the sign, and 1 means negative. Then
        a byte is −128 to 127, and <Code>0xff</Code> is −1.
      </p>
      <p>
        <Code>inc</Code> adds 1 and <Code>dec</Code> subtracts 1. They set ZF, SF and OF, but they
        do not change CF. <Code>mov</Code> does not change any flag.
      </p>
      <Note>Lesson 13 uses the flags to decide which line runs next.</Note>
    </>
  ),
  example: {
    intro: 'Press Step until the program ends: 7 steps. After each line, look at the four flags.',
    stepper: { source: example, registers: ['rax'], showFlags: true },
    watchFor: [
      'Line 2: `0x7f` + 1 = `0x80`. As signed, 127 + 1 does not fit, and `0x80` reads as −128: OF = 1, SF = 1. As unsigned, 128 fits: CF = 0.',
      'Line 3 is a `mov`, so the flags do not change.',
      'Line 4: `0xff` + 1 = `0x100`, which needs 9 bits. `al` keeps only the lowest 8 bits, `0x00`: CF = 1, ZF = 1. As signed, −1 + 1 = 0 fits: OF = 0.',
      'Line 6: 5 − 5 = 0, so ZF = 1 and the other three flags are 0.',
    ],
  },
  check: {
    kind: 'choice',
    prompt: 'After these two lines run, which flag is 1?',
    code: ['  mov     ecx, 9', '  sub     ecx, 9'],
    options: [
      {
        id: 'zf',
        label: 'ZF',
        correct: true,
        feedback: 'The result is 0, and ZF is 1 exactly when the result is 0.',
      },
      {
        id: 'sf',
        label: 'SF',
        feedback: 'SF is 1 when the result is negative. 0 is not negative, so SF is 0.',
      },
      {
        id: 'cf',
        label: 'CF',
        feedback:
          'CF is 1 when the result does not fit as an unsigned number, as in 3 − 5. 9 − 9 = 0 fits, so CF is 0.',
      },
      {
        id: 'none',
        label: 'None of them',
        feedback:
          'A result of 0 does set a flag. ZF, the zero flag, is 1 exactly when the result is 0.',
      },
    ],
  },
  recap: [
    '`add rax, rbx`: rax = rax + rbx. `sub rax, rbx`: rax = rax − rbx.',
    'ZF = 1: the result is 0. SF = 1: its top bit is 1 (negative).',
    'CF = 1: it did not fit as unsigned. OF = 1: it did not fit as signed.',
    '`mov` never changes the flags. `inc` and `dec` do not change CF.',
  ],
  practiceTopic: 'homework-table',
}

export default lesson
