import { Code, CodeBlock, FactTable, Note, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
const example = String.raw`# Print one line of text.
  .intel_syntax noprefix
  .text
  .globl  main
  .type   main, @function

message:
  .string "Hello World!\n"

main:
  push    rbp    # save rbp
  mov     rbp, rsp
  # rdi: where the text is
  lea     rdi, message[rip]
  mov     eax, 0
  call    printf@PLT
  mov     eax, 0 # return 0
  pop     rbp    # rbp back
  ret            # end
`

const lesson: LessonContent = {
  id: 'line-format',
  idea: 'Only instructions are steps for the CPU; directives, which start with a dot, are notes for the assembler.',
  analogy: {
    title: 'A recipe card',
    text: 'A recipe card has notes, such as how many people it serves, and numbered steps. You cook only the steps. In a program, directives are the notes: they are for the assembler. Instructions are the steps: the CPU runs them.',
  },
  body: (
    <>
      <p>
        The <Term>assembler</Term> is the program that turns your text into bytes the CPU can run. A
        line has up to four parts, in this order. Each part may be left out.
      </p>
      <CodeBlock label="A line with all four parts">{`
start:  mov     rax, rbx # copy
`}</CodeBlock>
      <ul>
        <li>
          A <Term>label</Term> ends with a colon. It names a place in the program.
        </li>
        <li>
          The <Term>instruction</Term> is one step for the CPU. Its name, here <Code>mov</Code>,
          says what to do.
        </li>
        <li>
          The <Term>operands</Term> come after the name, with a comma between them. The destination
          comes first: <Code>mov destination, source</Code>.
        </li>
        <li>
          A <Term>comment</Term> starts with <Code>#</Code>. The assembler ignores the rest of the
          line.
        </li>
      </ul>
      <p>
        A <Term>directive</Term> starts with a dot and goes in the place of an instruction. It is a
        note for the assembler, not a step for the CPU.
      </p>
      <FactTable
        caption="Directives you will see often"
        head={['Directive', 'What it tells the assembler']}
        rows={[
          ['`.intel_syntax noprefix`', 'Intel style: destination first.'],
          ['`.text`', 'Code comes next. Text that never changes can go here too.'],
          ['`.data`', 'Data comes next.'],
          ['`.globl main`', 'Code outside this file may use `main`.'],
          ['`.type main, @function`', '`main` is a function.'],
          ['`.string "Hi"`', 'Store the text as bytes, then a 0 byte.'],
          ['`.equ limit, 10`', '`limit` means the number 10.'],
        ]}
      />
      <p>
        Your program starts at the label <Code>main</Code>. From there, the CPU runs instructions
        only.
      </p>
      <Note>
        Labels from gcc can start with a dot too, such as <Code>.L2:</Code>. The colon shows that it
        is a label.
      </Note>
    </>
  ),
  example: {
    intro: 'Press Step until the program ends: 9 steps. Watch which lines the arrow visits.',
    stepper: { source: example, registers: [], showOutput: true, showData: true },
    watchFor: [
      'Before the first Step, the arrow is on line 11, `push rbp`. Lines 1 to 10 have no instructions.',
      'Line 13 is a comment on its own line, so the arrow jumps from line 12 to line 14.',
      'The Data panel shows the text of line 8 from the start. The Output panel shows it after `printf` runs.',
    ],
  },
  check: {
    kind: 'choice',
    prompt: 'Which line of this code does the CPU run?',
    code: ['  .globl  main', 'main:', '  push    rbp    # save rbp', '  # mov rbp, rsp'],
    options: [
      {
        id: 'line-1',
        label: 'Line 1',
        feedback:
          'Line 1, `.globl main`, starts with a dot, so it is a directive. It is a note for the assembler, and the CPU never runs it.',
      },
      {
        id: 'line-2',
        label: 'Line 2',
        feedback:
          'Line 2, `main:`, is a label: a name for a place in the program. The CPU runs the instruction after it, not the label.',
      },
      {
        id: 'line-3',
        label: 'Line 3',
        correct: true,
        feedback:
          '`push rbp` is an instruction, a step for the CPU. The comment after it does not change that.',
      },
      {
        id: 'line-4',
        label: 'Line 4',
        feedback:
          'Line 4 starts with `#`, so all of it is a comment, even the code after `#`. The assembler ignores it.',
      },
    ],
  },
  recap: [
    'A line: `label: instruction operands # comment`. Each part may be left out.',
    'A directive starts with a dot. It is a note for the assembler, not a step for the CPU.',
    'A label ends with `:`. A comment starts with `#`.',
    'The destination comes first: `mov destination, source`.',
  ],
}

export default lesson
