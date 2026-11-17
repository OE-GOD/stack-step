import { Code, Steps, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
// The program starts at `main:`, so line 5 runs first.
const example = String.raw`set_five:
  mov     eax, 5   # eax = 5
  ret              # go back
main:
  call    set_five # run it
  mov     ebx, eax # ebx = 5
  ret              # end
`

const lesson: LessonContent = {
  id: 'call-and-ret',
  idea: '`call` pushes the address of the next instruction and jumps to the function; `ret` pops that address back into `rip`.',
  analogy: {
    title: 'A note on a pile',
    text: 'You are working at your desk when a friend asks for help. Before you go, you write down where you stopped and put the note on top of a pile. When you finish helping, you take the top note and go back to that place. If you left something else on top of the pile, you read the wrong note.',
  },
  body: (
    <>
      <p>
        A <Term>function</Term> is a piece of code that starts with a label. You run it with{' '}
        <Code>call</Code> and the name of the label, as in <Code>call set_five</Code>. The{' '}
        <Code>ret</Code> at its end goes back to the instruction after the <Code>call</Code>.
      </p>
      <p>
        The address of that instruction is the <Term>return address</Term>. <Code>call</Code> does
        two things:
      </p>
      <Steps
        items={[
          '`rsp` goes down 8, and the return address is copied into the new top box. This is a `push`.',
          '`rip` gets the address of the function, so the function runs next.',
        ]}
      />
      <p>
        <Code>ret</Code> does the opposite. It is a <Code>pop</Code> into <Code>rip</Code>:
      </p>
      <Steps
        items={[
          'The top box is copied into `rip`.',
          '`rsp` goes up 8. The program goes on at the return address.',
        ]}
      />
      <p>
        Why the instruction after the <Code>call</Code>? Lesson 7 showed that while an instruction
        runs, <Code>rip</Code> already holds the address of the next one. That is the value{' '}
        <Code>call</Code> pushes.
      </p>
      <p>
        <strong>One rule:</strong> before <Code>ret</Code>, a function must leave the stack as it
        found it. If it pushed a box, it must take that box off again. If a box is left on top,{' '}
        <Code>ret</Code> takes that box as the return address. Then the program jumps to the wrong
        place.
      </p>
    </>
  ),
  example: {
    intro:
      'Press Step until the program ends: 5 steps. Watch the Stack panel: the `call` adds a box, and the `ret` of `set_five` uses it.',
    stepper: {
      source: example,
      registers: ['rax', 'rbx', 'rsp'],
      showRip: true,
      showStack: true,
    },
    watchFor: [
      'Step 1 runs the `call` on line 5. `rsp` goes down 8, to `0x…dff0`, and the new top box holds `0x401131`: the address of line 6.',
      '`rip` is now `0x401126`, so line 2, the first instruction of `set_five`, runs next.',
      'Step 3 runs `ret`: `0x401131` goes back into `rip`, and `rsp` goes up to `0x…dff8`. Line 6 runs next.',
      'The last `ret` takes the box that was on the stack from the start, and the program ends.',
    ],
  },
  check: {
    kind: 'choice',
    prompt: 'Line 2 runs `call set_one`. What does it save on the stack?',
    code: [
      'main:',
      '  call    set_one',
      '  mov     ebx, eax',
      '  ret',
      'set_one:',
      '  mov     eax, 1',
      '  ret',
    ],
    options: [
      {
        id: 'call-line',
        label: 'The address of line 2',
        feedback:
          'If `ret` went back to line 2, the `call` would run again and again. `call` saves the address of the next instruction.',
      },
      {
        id: 'next-line',
        label: 'The address of line 3',
        correct: true,
        feedback:
          'Line 3 is the instruction after the `call`. `ret` takes this address off the stack and goes back there.',
      },
      {
        id: 'function',
        label: 'The address of `set_one`',
        feedback:
          'The address of `set_one` goes into `rip`, so the function runs next. The stack keeps the way back: the address of line 3.',
      },
      {
        id: 'nothing',
        label: 'Nothing: `call` only changes `rip`',
        feedback:
          'That is what a jump does. `call` also pushes the return address, so `rsp` goes down 8.',
      },
    ],
  },
  recap: [
    '`call`: push the return address, so `rsp` goes down 8. Then jump to the function.',
    '`ret`: pop the top box into `rip`, so `rsp` goes up 8.',
    'The return address is the address of the instruction after the `call`.',
    'Before `ret`, a function must leave the stack as it found it.',
  ],
  practiceTopic: 'call-ret',
}

export default lesson
