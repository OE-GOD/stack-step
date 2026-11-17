import { createEmulator } from '../../../emulator'
import { Code, Note, Steps, Term } from '../components'
import type { LessonContent } from '../types'

// Five instructions of five different sizes. The comments give the sizes. Every line fits in
// the MiniStepper's code box on a phone (limits: components/index.ts).
const example = String.raw`  mov     eax, 7   # 5 bytes
  mov     rbx, rax # 3 bytes
  mov     cl, 2    # 2 bytes
  mov     rdx, 9   # 7 bytes
  ret              # 1 byte
`

// The check question: a 5-byte instruction that starts at 0x401145.
const CHECK_START = 0x401145n
const CHECK_SIZE = 5
const CHECK_SOURCE = String.raw`  mov     ebx, 1
  ret
`

/**
 * rip while the instruction of the question runs: the value of rip right after the
 * emulator ran it. Throws if the assembler does not put a 5-byte instruction at
 * 0x401145, so the question can never state a wrong address or size.
 */
function ripWhileItRuns(): bigint {
  const made = createEmulator(CHECK_SOURCE, { textBase: CHECK_START })
  if (!made.ok) throw new Error('The program of the check question does not assemble.')
  const first = made.emulator.program.instructions.at(0)
  if (first?.address !== CHECK_START || first.size !== CHECK_SIZE) {
    throw new Error('The program of the check question does not match its prompt.')
  }
  made.emulator.step()
  return made.emulator.getSnapshot().rip
}

/** The slip of adding in decimal: the hex digits read as a decimal number (45 + 5 = 50). */
function addedInDecimal(start: bigint, size: number): bigint {
  return BigInt(`0x${Number(start.toString(16)) + size}`)
}

const lesson: LessonContent = {
  id: 'rip-cycle',
  idea: '`rip` holds the address of the next instruction, and the CPU repeats three things: fetch the instruction at `rip`, move `rip` past it, run it.',
  analogy: {
    title: 'A finger on a recipe',
    text: 'You cook from a recipe and keep your finger on the page. You read a step, move your finger to the next step, and then do the step you read. While you work, your finger already points at the next step. A long step moves your finger farther down the page.',
  },
  body: (
    <>
      <p>
        Instructions are stored in memory as bytes, so each instruction has an address.{' '}
        <Code>rip</Code> is a special register: it holds the address of the next instruction. The
        CPU runs a program by doing these three things again and again:
      </p>
      <Steps
        items={[
          <>
            <Term>Fetch</Term>: read the instruction at the address in <Code>rip</Code>.
          </>,
          <>
            <Term>Move</Term>: add the size of that instruction to <Code>rip</Code>. Now{' '}
            <Code>rip</Code> holds the address of the next instruction.
          </>,
          <>
            <Term>Run</Term>: do what the instruction says.
          </>,
        ]}
      />
      <p>
        Instructions do not all have the same size: each one is 1 to 15 bytes long. So{' '}
        <Code>rip</Code> does not always move by the same amount. You do not need to remember the
        sizes: practice problems give them.
      </p>
      <p>
        While an instruction runs, <Code>rip</Code> already holds the address of the next one: its
        own address plus its size. For example, a 5-byte instruction at <Code>0x401126</Code> runs
        while <Code>rip</Code> is <Code>0x40112b</Code>.
      </p>
      <p>
        Jumps, <Code>call</Code> and <Code>ret</Code> go through the same three steps. But when they
        run, they can put a new address in <Code>rip</Code>. Then the next instruction is somewhere
        else.
      </p>
      <Note>
        Lesson 8 shows <Code>call</Code> and <Code>ret</Code>. Lesson 13 shows jumps.
      </Note>
    </>
  ),
  example: {
    intro:
      'Press Step until the program ends: 5 steps. Before each Step, add the size of the line (in its comment) to `rip` and guess the new value.',
    stepper: { source: example, registers: [], showRip: true },
    watchFor: [
      'Before the first Step, `rip` is `0x401126`: the address of line 1, the next instruction.',
      'Line 1 is 5 bytes: `0x401126` + 5 = `0x40112b`, the new value of `rip`. It already held this value while line 1 ran.',
      'Then `rip` becomes `0x40112e` (+ 3), `0x401130` (+ 2) and `0x401137` (+ 7).',
      '`ret` goes through the same cycle: first `rip` moves past it. Then `ret` runs and puts a new address in `rip`, `0x7fff f7c2 9d90`, and the program ends.',
    ],
  },
  check: {
    kind: 'hex',
    prompt:
      'An instruction starts at address `0x401145`. It is 5 bytes long. While it runs, what is in `rip`?',
    label: '`rip` while the instruction runs',
    answer: ripWhileItRuns,
    wrongAnswers: [
      {
        value: () => CHECK_START,
        feedback:
          '`0x401145` is the address of the instruction itself. While it runs, `rip` already points past it, at the next instruction.',
      },
      {
        value: () => CHECK_START + 1n,
        feedback:
          '`rip` does not move by 1. It moves by the size of the instruction: here, 5 bytes.',
      },
      {
        value: () => addedInDecimal(CHECK_START, CHECK_SIZE),
        feedback: 'It looks like you added in decimal (45 + 5 = 50). In hex, 5 + 5 is `a`, not 10.',
      },
      {
        value: () => CHECK_START - BigInt(CHECK_SIZE),
        feedback: '`rip` goes up through the code, not down. Add the size to the address.',
      },
    ],
    rightFeedback:
      'While an instruction runs, `rip` holds the next address: `0x401145` + 5 = `0x40114a`.',
    hint: 'Start from the address, `0x401145`, and add the size, 5, in hex.',
  },
  recap: [
    '`rip` holds the address of the next instruction.',
    'The cycle: fetch the instruction at `rip`, add its size to `rip`, run it.',
    'While an instruction runs, `rip` = its address + its size.',
    'Jumps, `call` and `ret` can put a new address in `rip`.',
  ],
  practiceTopic: 'rip',
}

export default lesson
