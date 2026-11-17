import { createEmulator } from '../../../emulator'
import { Code, FactTable, Note } from '../components'
import type { LessonContent } from '../types'

// No comments: the `lea` line alone is 27 characters, the most that fits in the MiniStepper's
// code box on a phone (limits: components/index.ts). The explanation under the code says
// what each line did.
const example = String.raw`  .data
numbers:
  .quad   0x11, 0x22, 0x33
  .text
main:
  lea     rdi, numbers[rip]
  mov     rax, [rdi]
  mov     rcx, [rdi+8]
  mov     rdx, 16[rdi]
  ret
`

// The check question: three numbers at `values`, and a read 8 bytes after the start.
const CHECK_LINES = [
  '  .data',
  'values:',
  '  .quad   5, 7, 9',
  '  .text',
  '  lea     rbx, values[rip]',
  '  mov     rax, [rbx+8]',
] as const

/** The address of `values` that the prompt gives. */
const VALUES_ADDRESS = 0x404030n

interface CheckRun {
  rax: bigint
  rbx: bigint
  /** The first number of `values`: the memory at `[rbx]`. */
  first: bigint
}

/**
 * Run the lines of the question (plus a `ret` to end them) in the emulator. Throws if
 * `values` is not at the address the prompt gives.
 */
function runCheck(): CheckRun {
  const made = createEmulator(`${CHECK_LINES.join('\n')}\n  ret\n`)
  if (!made.ok) throw new Error('The program of the check question does not assemble.')
  const { emulator } = made
  const run = emulator.run()
  if (run.reason !== 'halted') throw new Error(run.message)
  const rbx = emulator.readRegister('rbx')
  const first = emulator.getSnapshot().data.at(0)?.values.at(0)
  if (rbx !== VALUES_ADDRESS || first === undefined) {
    throw new Error('The program of the check question does not match its prompt.')
  }
  return { rax: emulator.readRegister('rax'), rbx, first }
}

const ADDED_TO_THE_NUMBER =
  'The 8 is added to the address, not to the number stored there. `[rbx+8]` is the memory 8 bytes after the address in `rbx`.'

const lesson: LessonContent = {
  id: 'indirect-addressing',
  idea: 'Square brackets mean “the memory at this address”: `[rdi]` uses the value in `rdi` as an address and works with what is stored there.',
  analogy: {
    title: 'An address on a card',
    text: 'A card has a house address written on it. The card is `rdi`: it holds only the address. `[rdi]` means: go to that house and look inside. Each house holds one byte, so `[rdi+8]` is 8 houses further along the street.',
  },
  body: (
    <>
      <p>
        Square brackets around a register mean: the memory at this address. In{' '}
        <Code>mov rax, [rdi]</Code>, the CPU uses the value in <Code>rdi</Code> as an address. It
        copies the 8 bytes stored at that address into <Code>rax</Code>. <Code>rdi</Code> itself
        does not change.
      </p>
      <FactTable
        caption="Square brackets and what they mean"
        head={['Written', 'The memory at']}
        rows={[
          ['`[rdi]`', 'the address in `rdi`'],
          ['`[rdi+8]`', 'the address in `rdi`, plus 8'],
          ['`[rbp-8]`', 'the address in `rbp`, minus 8'],
          ['`8[rdi]`', 'the same as `[rdi+8]`'],
          ['`-8[rbp]`', 'the same as `[rbp-8]`'],
          ['`x[rip]`', 'the address of the variable `x`'],
        ]}
      />
      <p>
        gcc often writes the number in front, as in <Code>-8[rbp]</Code>.
      </p>
      <p>
        The number changes the address, not the value stored there. In the example,{' '}
        <Code>.quad</Code> stores three numbers of 8 bytes each. So the second number starts 8 bytes
        after the first, and <Code>[rdi+8]</Code> reads it.
      </p>
      <p>
        <strong>How many bytes?</strong> The register on the other side decides.{' '}
        <Code>mov rax, [rdi]</Code> reads 8 bytes, <Code>mov eax, [rdi]</Code> reads 4, and{' '}
        <Code>mov al, [rdi]</Code> reads 1. With a number on the other side, you must write the
        size, as in <Code>mov qword ptr [rdi], 5</Code> (lesson 5).
      </p>
      <Note>
        The first line of the example, <Code>lea rdi, numbers[rip]</Code>, puts the address of{' '}
        <Code>numbers</Code> in <Code>rdi</Code>. Lesson 11 explains <Code>lea</Code>.
      </Note>
    </>
  ),
  example: {
    intro:
      'Press Step until the program ends: 5 steps. Compare the address in `rdi` with the numbers that each line copies from the Data panel.',
    stepper: {
      source: example,
      registers: ['rdi', 'rax', 'rcx', 'rdx'],
      showData: true,
    },
    watchFor: [
      'After line 6, `rdi` is `0x404030`: the address of `numbers` in the Data panel, not one of the numbers.',
      'Line 7 copies the 8 bytes at that address: `rax` becomes `0x11`.',
      '`[rdi+8]` is the memory at `0x404038`, so `rcx` becomes `0x22`. `16[rdi]` is at `0x404040`, so `rdx` becomes `0x33`.',
      '`rdi` itself never changes: it still holds `0x404030`.',
    ],
  },
  check: {
    kind: 'hex',
    prompt:
      '`values` starts at address `0x404030`, and each `.quad` number takes 8 bytes. What is in `rax` after these lines run?',
    code: CHECK_LINES,
    label: '`rax` =',
    answer: () => runCheck().rax,
    wrongAnswers: [
      {
        value: () => runCheck().rbx + 8n,
        feedback:
          '`0x404038` is the address `rbx+8`. The brackets mean: go to that address and copy the number stored there.',
      },
      {
        value: () => runCheck().rbx,
        feedback:
          '`0x404030` is the address in `rbx`. The brackets mean: go to the address `rbx+8` and copy the number stored there.',
      },
      {
        value: () => runCheck().first,
        feedback: '5 is the number at `[rbx]`. The `+8` moves 8 bytes further, to the next number.',
      },
      { value: () => runCheck().first + 8n, feedback: ADDED_TO_THE_NUMBER },
      // The same slip, with 5 + 8 = 13 worked out in decimal and typed as hex digits.
      { value: () => BigInt(`0x${runCheck().first + 8n}`), feedback: ADDED_TO_THE_NUMBER },
    ],
    rightFeedback:
      '`rbx+8` = `0x404038`, the address of the second number. `mov` copies the number stored there: 7.',
    hint: 'First work out the address `rbx+8`. Then find the number stored at that address.',
  },
  recap: [
    '`[rdi]` means the memory at the address in `rdi`.',
    '`[rdi+8]` and `8[rdi]` mean the same: the memory 8 bytes after the address in `rdi`.',
    'The number changes the address, not the value stored there.',
    'The register on the other side gives the size: `rax` 8 bytes, `eax` 4, `al` 1.',
  ],
  practiceTopic: 'indirect-addressing',
}

export default lesson
