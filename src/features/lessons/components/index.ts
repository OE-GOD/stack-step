/**
 * The prose helpers for lesson files. Import them from here:
 *
 *   import { Code, CodeBlock, FactTable, Note, Steps, Term } from '../components'
 *
 * Only `body` is JSX; every other field of a lesson is a plain string. In the body,
 * plain <p>, <ul>, <li> and <strong> are fine: the page styles them. Do not put headings
 * in the body (the page has its own), and do not style anything yourself.
 *
 * Code has one rule. In JSX, wrap it in <Code>. In a string (every field except `body`,
 * and the strings given to Steps, FactTable and a caption), wrap it in backticks.
 *
 * Long hex values: write a value of 8 or more digits in groups of four, cut from the
 * right, as the machine panels show it: `0x0000 0000 0000 002a`, `0x7fff fffd dff8`,
 * `0x5566 7788`. Shorter values stay as they are: `0x2a`, `0x404030`. For a value the
 * lesson computes, use `0x${groupHex(value)}` (16 digits) or `0x${groupHex(value, 0)}`
 * (no zeros in front). Code itself (the example, a question's code) stays as the
 * assembler reads it. The content tests check this rule.
 *
 * Code: a short piece of code inside a sentence.
 *
 *   <p>There are 16 general registers, such as <Code>rax</Code> and <Code>rbx</Code>.</p>
 *
 * Term: the word that the sentence defines. Bold, no tooltip. Once per word.
 *
 *   <p>A <Term>register</Term> is a small, very fast storage place inside the CPU.</p>
 *
 * FactTable: a small table with a caption. The first cell of each row names the row.
 *
 *   <FactTable
 *     caption="Two parts of `rax`"
 *     head={['Name', 'Bits']}
 *     rows={[
 *       ['`eax`', '32'],
 *       ['`al`', '8'],
 *     ]}
 *   />
 *
 * Steps: a numbered list, for things that happen in a fixed order.
 *
 *   <Steps items={['rsp goes down by 8.', 'The value of `rbx` is copied into the new top box.']} />
 *
 * CodeBlock: a few lines of code that do not run, colored like the editor, with line
 * numbers. Same style as the examples: one short `#` comment per line.
 *
 *   <CodeBlock>{`
 *     mov     rax, 5    # rax = 5
 *     mov     rbx, rax  # copy rax
 *   `}</CodeBlock>
 *
 * Note: a quiet aside, such as a pointer to a later lesson.
 *
 *   <Note>You will use this in lesson 12.</Note>
 *
 * Code style: as in `src/examples/index.ts` (the instruction name in a column 8 wide, `#`
 * comments), but indented by 2 spaces, not 4, so that a line fits on a phone.
 *
 * Line length. On a 360 px phone, with code at 14 px, the MiniStepper's code box shows 28
 * characters per line (27 when the line numbers have two digits), the box of a question's
 * code shows 27, and a CodeBlock in the body 31. A longer line is cut off. So:
 *   - the example (`example.stepper.source`): at most 28 characters, indent included, or
 *     27 when it has 10 lines or more;
 *   - the code of a question (`check.code`): at most 27 characters;
 *   - a CodeBlock in the body: at most 31 characters.
 * Short comments (or none) keep lines short. A long number can go in the starting state
 * (`options: { initialRegisters: … }`) and be named in the intro instead. The content tests
 * check all three limits and the indent.
 */
export { Code, CodeBlock, FactTable, Note, Steps, Term } from './prose'
export type { CodeBlockProps, FactTableProps, StepsProps } from './prose'
