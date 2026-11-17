import { createEmulator } from '../../../emulator'
import { Code, CodeBlock, FactTable, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
// The comments did not fit, so the intro says what `ecx` and `eax` hold.
const example = String.raw`  mov     ecx, 1
  mov     eax, 0
loop_start:
  cmp     ecx, 3
  jg      loop_end
  add     eax, ecx
  inc     ecx
  jmp     loop_start
loop_end:
  ret
`

/** The code of the check question. The answer comes from running exactly these lines. */
const CHECK_CODE = [
  '  mov     eax, 0',
  '  mov     ecx, 3',
  'loop_start:',
  '  cmp     ecx, 0',
  '  je      loop_end',
  '  add     eax, 3',
  '  dec     ecx',
  '  jmp     loop_start',
  'loop_end:',
] as const

/** What `add eax, 3` adds on each pass of the loop. */
const PER_PASS = 3n

/** The value of `eax` when the check code reaches `loop_end`, from the emulator. */
function eaxAtLoopEnd(): bigint {
  const made = createEmulator(`${CHECK_CODE.join('\n')}\n  ret\n`)
  if (!made.ok) throw new Error('The check code of lesson 13 does not assemble.')
  const run = made.emulator.run()
  if (run.reason !== 'halted') throw new Error(run.message)
  return made.emulator.readRegister('eax')
}

const lesson: LessonContent = {
  id: 'loops-and-ifs',
  idea: 'A conditional jump after `cmp` jumps only when its test is true, and a jump backward makes a loop.',
  analogy: {
    title: 'A sign at a fork in the road',
    text: 'You walk to a fork in the road. A sign there asks a question. If the answer is yes, you take the other road. If it is no, you keep walking straight. A loop is a road that brings you back to the same sign.',
  },
  body: (
    <>
      <p>
        <Code>cmp a, b</Code> calculates a − b, like <Code>sub</Code>. But it only sets the flags: a
        keeps its value. A <Term>conditional jump</Term> right after it reads those flags. It jumps
        to its label only when its test is true. If not, the program goes on to the next line.
      </p>
      <FactTable
        caption="Jumps after `cmp a, b`"
        head={['Jump when', 'Signed', 'Unsigned']}
        rows={[
          ['a = b', '`je`', '`je`'],
          ['a ≠ b', '`jne`', '`jne`'],
          ['a > b', '`jg`', '`ja`'],
          ['a ≥ b', '`jge`', '`jae`'],
          ['a < b', '`jl`', '`jb`'],
          ['a ≤ b', '`jle`', '`jbe`'],
        ]}
      />
      <p>
        Signed numbers can be negative. Unsigned numbers cannot. <Code>jmp</Code> has no test: it
        always jumps.
      </p>
      <p>
        An <strong>if</strong> skips some lines with a jump. Here, <Code>jge</Code> jumps over the{' '}
        <Code>mov</Code> when <Code>eax</Code> ≥ 0. So <Code>mov eax, 0</Code> runs only when{' '}
        <Code>eax</Code> is negative:
      </p>
      <CodeBlock>{`
  cmp     eax, 0
  jge     done
  mov     eax, 0
done:
`}</CodeBlock>
      <p>
        A <strong>loop</strong> jumps back. In the example below, the test is at the top, and a{' '}
        <Code>jmp</Code> at the bottom goes back to it.
      </p>
      <p>
        A jump does not save a return address, so it does not come back by itself. That is the
        difference from <Code>call</Code>.
      </p>
    </>
  ),
  example: {
    intro:
      '`ecx` holds the next number to add, and `eax` holds the sum. Press Step until the program ends: 20 steps. Watch the `rcx` and `rax` rows and the flags.',
    stepper: { source: example, registers: ['rcx', 'rax'], showFlags: true },
    watchFor: [
      '`cmp ecx, 3` changes only the flags. When `ecx` is 3, it sets ZF to 1, because 3 − 3 = 0.',
      '`jg loop_end` does not jump while `ecx` is 1, 2 or 3. It jumps at step 19, when `ecx` is 4.',
      '`jmp loop_start` always jumps back to line 4.',
      'At the end, `eax` is `0x6`, the sum of 1, 2 and 3.',
    ],
  },
  check: {
    kind: 'hex',
    prompt: 'What is in `eax` when this code reaches `loop_end`?',
    code: CHECK_CODE,
    label: '`eax` at `loop_end`',
    answer: eaxAtLoopEnd,
    wrongAnswers: [
      {
        value: () => eaxAtLoopEnd() + PER_PASS,
        feedback:
          'That is one pass too many. When `ecx` is 0, `je` jumps before `add` runs. The loop adds 3 only for `ecx` = 3, 2 and 1.',
      },
      {
        value: () => eaxAtLoopEnd() - PER_PASS,
        feedback:
          'That is one pass too few. `je` jumps only when `ecx` is 0, so the loop also runs when `ecx` is 1.',
      },
      {
        value: () => PER_PASS,
        feedback:
          'The loop runs more than once: `jmp loop_start` goes back to the test, again and again, until `ecx` is 0.',
      },
      {
        value: () => 0n,
        feedback:
          '`je` jumps only when `ecx` is 0. `ecx` starts at 3, so the first test does not jump.',
      },
    ],
    rightFeedback: 'The loop adds 3 for `ecx` = 3, 2 and 1. Then `ecx` is 0, and `je` jumps out.',
    hint: 'Write down `ecx` and `eax` after each pass. `je` jumps only when `ecx` is 0.',
  },
  recap: [
    '`cmp a, b` calculates a − b and only sets the flags.',
    'A conditional jump right after `cmp` jumps only when its test is true.',
    '`jg` `jge` `jl` `jle` are for signed numbers. `ja` `jae` `jb` `jbe` are for unsigned ones.',
    'The loop shape: the test at the top, a `jmp` back to it at the bottom.',
  ],
}

export default lesson
