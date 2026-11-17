import { Code, Steps, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
// A line with `dword ptr` would be too long, so the 4-byte writes copy `eax`. With 12
// lines, the code box needs no scrolling at all. `count` holds a 2-byte number, so its
// box shows the byte order; it is the box to open (the bytes of the lowest box, `total`,
// open below the part of the Stack panel that is in view).
const example = String.raw`  .equ    count, -8
  .equ    total, -16
  push    rbp
  mov     rbp, rsp
  sub     rsp, 16
  mov     eax, 0x1234
  mov     count[rbp], eax
  add     eax, 0x1000
  mov     total[rbp], eax
  mov     rsp, rbp
  pop     rbp
  ret
`

const lesson: LessonContent = {
  id: 'local-variables',
  idea: 'A function keeps its variables in boxes on the stack, at fixed distances below `rbp`, which stays still while it runs.',
  analogy: {
    title: 'A flag at a campsite',
    text: 'When you arrive at a campsite, you put a flag in the ground. You leave your bag 8 steps from the flag and your food 16 steps from it. People come and go, but the flag stays, so you always find your things. In a function, `rbp` is the flag.',
  },
  body: (
    <>
      <p>
        A function keeps its own variables, its <Term>local variables</Term>, in boxes on the stack.
        Three opening lines make room for them:
      </p>
      <Steps
        items={[
          '`push rbp` saves the old value of `rbp` in a new box.',
          '`mov rbp, rsp` makes `rbp` point at that box. `rbp` now stays still until the function ends.',
          '`sub rsp, 16` makes `rsp` go down 16 bytes: room for 2 new boxes.',
        ]}
      />
      <p>
        The variables are at fixed distances below <Code>rbp</Code>. Here, the first is at{' '}
        <Code>-8[rbp]</Code> and the second at <Code>-16[rbp]</Code>. <Code>rsp</Code> may move, but{' '}
        <Code>rbp</Code> does not, so these distances always work. After <Code>.equ count, -8</Code>
        , you can write <Code>count[rbp]</Code> instead of <Code>-8[rbp]</Code>.
      </p>
      <p>
        <Code>eax</Code> is 4 bytes, so <Code>mov count[rbp], eax</Code> writes only 4 bytes of the
        box. A line with <Code>dword ptr</Code> writes 4 bytes too. The lowest byte goes first, at
        the lowest address.
      </p>
      <p>Three closing lines undo them and go back:</p>
      <Steps
        items={[
          '`mov rsp, rbp` makes `rsp` go back up to `rbp`. The variables are now leftovers.',
          '`pop rbp` gives `rbp` its old value back.',
          '`ret` goes back, as in lesson 8.',
        ]}
      />
      <p>
        Subtract a multiple of 16: 16, 32, 48 and so on. After <Code>push rbp</Code>,{' '}
        <Code>rsp</Code> ends in 0 (in hex). A multiple of 16 keeps it that way, if the function
        pushes nothing else. So <Code>rsp</Code> still ends in 0 when the function makes a{' '}
        <Code>call</Code>. The real <Code>printf</Code> can crash if it does not.
      </p>
    </>
  ),
  example: {
    intro:
      'Press Step until the program ends: 10 steps. Watch `rbp`, `rsp` and the boxes in the Stack panel.',
    stepper: { source: example, registers: ['rbp', 'rsp', 'rax'], showStack: true },
    watchFor: [
      'After line 5, `rsp` is `0x…dfe0`, which ends in 0. The 2 new boxes below `rbp` are “not set yet”.',
      'Lines 7 and 9 copy the 4 bytes of `eax` into the boxes. The Stack panel names them `count` and `total`.',
      'After line 7, press the box `count` to open it. Its first 4 bytes are `34 12 00 00`: the lowest byte of `0x1234` comes first. The other 4 bytes are not set.',
      '`rbp` stays at `0x…dff0` until line 11, so `count[rbp]` and `total[rbp]` always find the same boxes.',
    ],
  },
  check: {
    kind: 'choice',
    prompt:
      'A function needs 3 boxes for its variables, and it calls `printf`. Which of these lines should come after `push rbp` and `mov rbp, rsp`?',
    code: ['  sub     rsp, 3', '  sub     rsp, 24', '  sub     rsp, 32', '  add     rsp, 32'],
    options: [
      {
        id: 'line-1',
        label: 'Line 1',
        feedback:
          '`sub rsp, 3` counts boxes, but `rsp` counts bytes. 3 boxes need 24 bytes, and then you round up to a multiple of 16.',
      },
      {
        id: 'line-2',
        label: 'Line 2',
        feedback:
          '24 bytes is enough room, but 24 is not a multiple of 16. `rsp` would end in 8 at the `call`, and `printf` can crash.',
      },
      {
        id: 'line-3',
        label: 'Line 3',
        correct: true,
        feedback:
          '32 bytes is room for 4 boxes, enough for 3. And 32 is a multiple of 16, so `rsp` still ends in 0 at the `call`.',
      },
      {
        id: 'line-4',
        label: 'Line 4',
        feedback:
          'With `add`, `rsp` goes up. The stack grows down, so to make room, `rsp` must go down: subtract.',
      },
    ],
  },
  recap: [
    'Opening lines: `push rbp`, `mov rbp, rsp`, `sub rsp, 16`.',
    'Local variables are below `rbp`: `-8[rbp]`, `-16[rbp]`, and so on.',
    'Closing lines: `mov rsp, rbp`, `pop rbp`, `ret`.',
    'Subtract a multiple of 16 (if nothing else is pushed), so that `rsp` ends in 0 before a `call`.',
  ],
}

export default lesson
