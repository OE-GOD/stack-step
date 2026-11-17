import { Code, FactTable } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
// The long number does not fit on a line, so `rax` starts with it (see `options`).
const example = String.raw`  mov     rsi, rax   # copy
  mov     r8, rax    # copy
  ret                # end
`

const lesson: LessonContent = {
  id: 'register-names',
  idea: 'Each 64-bit register also has names for its lowest 32, 16 and 8 bits.',
  analogy: {
    title: 'A row of lockers',
    text: 'Picture a register as a row of 8 lockers, one byte in each. `rax` is the whole row. `eax` is the 4 lockers at the right end, `ax` the last 2, and `al` the last one. `ah` is the locker next to `al`.',
  },
  body: (
    <>
      <p>
        Each smaller name is a part of a 64-bit register, most often its lowest 32, 16 or 8 bits.
        The names follow three patterns.
      </p>
      <FactTable
        caption="Three registers and their parts"
        head={['Part', '`rax`', '`rsi`', '`r8`']}
        rows={[
          ['all 64 bits', '`rax`', '`rsi`', '`r8`'],
          ['lowest 32 bits', '`eax`', '`esi`', '`r8d`'],
          ['lowest 16 bits', '`ax`', '`si`', '`r8w`'],
          ['lowest 8 bits', '`al`', '`sil`', '`r8b`'],
        ]}
      />
      <ul>
        <li>
          <Code>rbx</Code>, <Code>rcx</Code> and <Code>rdx</Code> work like <Code>rax</Code>: for
          example <Code>ebx</Code>, <Code>bx</Code>, <Code>bl</Code>.
        </li>
        <li>
          <Code>rdi</Code>, <Code>rbp</Code> and <Code>rsp</Code> work like <Code>rsi</Code>: for
          example <Code>edi</Code>, <Code>di</Code>, <Code>dil</Code>.
        </li>
        <li>
          <Code>r9</Code> to <Code>r15</Code> work like <Code>r8</Code>. The last letter gives the
          size in bits: <Code>d</Code> 32, <Code>w</Code> 16, <Code>b</Code> 8.
        </li>
      </ul>
      <p>
        <Code>ah</Code> is 8 bits too: the byte just above <Code>al</Code>. Only <Code>rax</Code>,{' '}
        <Code>rbx</Code>, <Code>rcx</Code> and <Code>rdx</Code> have such a name: <Code>ah</Code>,{' '}
        <Code>bh</Code>, <Code>ch</Code> and <Code>dh</Code>.
      </p>
      <p>
        The parts are not separate registers. <Code>al</Code> is the same 8 bits as the lowest 8
        bits of <Code>rax</Code>. Lesson 3 shows what happens when you write to a part.
      </p>
    </>
  ),
  example: {
    intro:
      '`rax` starts with `0x1122 3344 5566 7788`. Press the `rax` row to open it and see its parts. Then press Step until the program ends: 3 steps.',
    stepper: {
      source: example,
      options: { initialRegisters: { rax: 0x1122334455667788n } },
      registers: ['rax', 'rsi', 'r8'],
    },
    watchFor: [
      'Open `rax`: `eax` is `0x5566 7788` and `ax` is `0x7788`.',
      '`ah` is `0x77` and `al` is `0x88`: the two lowest bytes.',
      'After the steps, open `rsi` and `r8`: `sil` and `r8b` are `0x88` too. They are other registers: lines 1 and 2 copied the value into them.',
    ],
  },
  check: {
    kind: 'text',
    prompt: 'What is the name of the lowest 16 bits of `r10`?',
    label: '16-bit part of `r10`',
    answers: ['r10w'],
    wrongAnswers: [
      {
        value: 'r10d',
        feedback: '`r10d` is the 32-bit part: it ends in `d`. The 16-bit part ends in `w`.',
      },
      {
        value: 'r10b',
        feedback: '`r10b` is the 8-bit part: it ends in `b`. The 16-bit part ends in `w`.',
      },
      {
        value: 'r10',
        feedback: '`r10` is the whole 64-bit register. The name of a part has a letter at the end.',
      },
      {
        value: 'r10x',
        feedback:
          'There is no `r10x`. The `rax` pattern does not work for `r8` to `r15`: they add `d`, `w` or `b`.',
      },
      {
        value: 'ax',
        feedback: '`ax` is the 16-bit part of `rax`, not of `r10`. Look at the `r8` pattern.',
      },
    ],
    rightFeedback: '`r10` works like `r8`, and `w` marks the 16-bit part.',
    hint: 'Look at the `r8` column of the table. `r10` works the same way.',
  },
  recap: [
    'A smaller name is a part of a 64-bit register, most often its lowest 32, 16 or 8 bits.',
    '`rax` → `eax`, `ax`, `al`, and `ah` is the byte above `al`.',
    '`rsi` → `esi`, `si`, `sil`. `r8` → `r8d`, `r8w`, `r8b`.',
    'A part is not a separate register. It is the same bits.',
  ],
  practiceTopic: 'register-names',
}

export default lesson
