import { Code, CodeBlock, FactTable } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
// One space after the instruction name: with the usual wide gap, the `qword ptr` line would
// be too long. Every line here is a `mov`, so the operands still line up.
const example = String.raw`  .data
x:
  .quad 5
  .text
  mov rax, 7
  mov rbx, rax
  mov rcx, x[rip]
  mov x[rip], rbx
  mov qword ptr x[rip], 9
  ret
`

const lesson: LessonContent = {
  id: 'mov',
  idea: '`mov destination, source` copies a value into a register or into memory, and the source keeps its value.',
  analogy: {
    title: 'A photocopier',
    text: 'A photocopier copies a page, and the original stays as it was. `mov` works the same way: the source keeps its value. One difference: the copy does not go on a new sheet. It goes over the old value of the destination, and that old value is lost.',
  },
  body: (
    <>
      <p>
        The destination comes first and gets the copy. The source can be a register, a number or
        memory. In the example, <Code>x</Code> is a variable: 8 bytes of memory. gcc writes it as{' '}
        <Code>x[rip]</Code>, which means the memory at <Code>x</Code>. Lesson 10 explains the
        brackets.
      </p>
      <FactTable
        caption="The five legal forms of `mov`"
        head={['Line', 'It copies']}
        rows={[
          ['`mov rbx, rax`', 'a register into a register'],
          ['`mov rax, 7`', 'a number into a register'],
          ['`mov rcx, x[rip]`', 'memory into a register'],
          ['`mov x[rip], rbx`', 'a register into memory'],
          ['`mov qword ptr x[rip], 9`', 'a number into memory'],
        ]}
      />
      <p>
        When a number goes into memory, the line must say how many bytes to write:{' '}
        <Code>byte ptr</Code> (1), <Code>word ptr</Code> (2), <Code>dword ptr</Code> (4) or{' '}
        <Code>qword ptr</Code> (8). In the other forms, the register gives the size.
      </p>
      <p>These forms are illegal. The assembler stops with an error:</p>
      <ul>
        <li>
          Memory into memory, such as <Code>mov x[rip], y[rip]</Code>.
        </li>
        <li>
          A number as the destination, such as <Code>mov 5, rax</Code>. A number is not a place that
          can hold a value.
        </li>
        <li>
          Two sizes that do not match, such as <Code>mov eax, rbx</Code> (32 bits and 64 bits).
        </li>
      </ul>
      <p>
        To copy memory into memory, go through a register. Remember lesson 1: food goes from the
        fridge into your hands first.
      </p>
      <CodeBlock label="Copy y into x">{`
  mov rax, y[rip]  # rax = y
  mov x[rip], rax  # x = rax
`}</CodeBlock>
    </>
  ),
  example: {
    intro:
      'Press Step until the program ends: 6 steps. Watch the registers and the value of `x` in the Data panel.',
    stepper: { source: example, registers: ['rax', 'rbx', 'rcx'], showData: true },
    watchFor: [
      'Line 6 copies `rax` into `rbx`: both hold 7 now. The source keeps its value.',
      'Line 7 copies `x` into `rcx`: `rcx` becomes 5, and `x` still holds 5.',
      'Line 8 copies `rbx` into memory: `x` becomes 7.',
      'Line 9 copies the number 9 into all 8 bytes of `x`.',
    ],
  },
  check: {
    kind: 'choice',
    prompt: '`x` and `y` are variables in memory. Which line is illegal?',
    code: [
      '  mov rcx, x[rip]',
      '  mov qword ptr x[rip], 9',
      '  mov x[rip], y[rip]',
      '  mov x[rip], rbx',
    ],
    options: [
      {
        id: 'line-1',
        label: 'Line 1',
        feedback:
          'Line 1 is legal: it copies memory into a register. One `mov` may read memory or write memory, but not both.',
      },
      {
        id: 'line-2',
        label: 'Line 2',
        feedback:
          'Line 2 is legal. A number may go into memory when a size word, here `qword ptr`, says how many bytes to write.',
      },
      {
        id: 'line-3',
        label: 'Line 3',
        correct: true,
        feedback:
          'Both operands are memory, and one `mov` cannot copy memory into memory. Go through a register: `mov rax, y[rip]`, then `mov x[rip], rax`.',
      },
      {
        id: 'line-4',
        label: 'Line 4',
        feedback:
          'Line 4 is legal: memory can be the destination when the source is a register. Memory may be on one side of `mov`, not on both.',
      },
    ],
  },
  recap: [
    '`mov destination, source` copies. The source keeps its value.',
    'A number that goes into memory needs a size, such as `qword ptr`.',
    'Illegal: memory into memory, a number as the destination, sizes that do not match.',
    'To copy memory into memory, go through a register.',
  ],
  practiceTopic: 'mov-legality',
}

export default lesson
