import { Fragment, type ReactNode } from 'react'
import { PageContainer, PageHeader } from '../../components/layout/Page'
import { Callout } from '../../components/ui/Callout'
import { InlineCode } from '../../components/ui/InlineCode'
import { NoWrap } from '../../components/ui/NoWrap'
import { RichText } from '../../components/ui/RichText'
import { TextLink } from '../../components/ui/TextLink'

/**
 * Code words in the code font, with commas between them: <Codes items={['mov', 'lea']} />.
 * `end` is the mark after the last word, for a list that ends a sentence (`end="."`).
 *
 * Each comma is kept on the same line as the word in front of it, so a line never starts
 * with a comma.
 */
function Codes({ items, end = '' }: { items: readonly string[]; end?: string }): ReactNode {
  return items.map((item, index) => {
    const isLast = index === items.length - 1
    const mark = isLast ? end : ','
    return (
      <Fragment key={item}>
        {mark === '' ? (
          <InlineCode>{item}</InlineCode>
        ) : (
          <NoWrap>
            <InlineCode>{item}</InlineCode>
            {mark}
          </NoWrap>
        )}
        {!isLast && ' '}
      </Fragment>
    )
  })
}

interface Group {
  name: string
  items: readonly string[]
  /** One plain sentence; code in backticks. */
  note?: string
}

/** A small table: the name of a group on the left, its code words on the right. */
function GroupTable({ groups }: { groups: readonly Group[] }): ReactNode {
  return (
    <dl className="rounded-xl border border-line bg-surface text-base">
      {groups.map((group) => (
        <div
          key={group.name}
          className="grid gap-x-4 gap-y-1 border-b border-line px-4 py-3 last:border-b-0 sm:grid-cols-[9.5rem_minmax(0,1fr)]"
        >
          <dt className="font-semibold">{group.name}</dt>
          <dd>
            <Codes items={group.items} />
            {group.note !== undefined && (
              <p className="mt-1.5 text-[0.9375rem] leading-snug text-muted">
                <RichText text={group.note} />
              </p>
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

const INSTRUCTIONS: readonly Group[] = [
  { name: 'Copy and addresses', items: ['mov', 'movzx', 'movsx', 'movsxd', 'lea'] },
  { name: 'Stack', items: ['push', 'pop', 'leave'] },
  {
    name: 'Math',
    items: ['add', 'sub', 'inc', 'dec', 'imul'],
    note: '`imul` works in the form with two operands.',
  },
  { name: 'Compare and bit logic', items: ['cmp', 'test', 'and', 'or', 'xor'] },
  {
    name: 'Jumps',
    items: [
      'jmp',
      'je',
      'jne',
      'jg',
      'jge',
      'jl',
      'jle',
      'ja',
      'jae',
      'jb',
      'jbe',
      'js',
      'jns',
      'jo',
      'jno',
    ],
    note: 'Other spellings of the same jumps also work, such as `jz`, `jnz`, `jnle` and `jc`.',
  },
  { name: 'Functions', items: ['call', 'ret'] },
  {
    name: 'Do nothing',
    items: ['nop', 'endbr64'],
    note: 'Many Linux versions of `gcc` write `endbr64` at the start of each function. Here it does nothing.',
  },
]

/**
 * Directives that the emulator reads past without a word and that do not change what a
 * short program does (IGNORED_DIRECTIVES in src/emulator/parser.ts also has the `.align`
 * family, which the page explains on its own line).
 */
const SKIPPED_DIRECTIVES = [
  '.file',
  '.ident',
  '.size',
  '.loc',
  '.weak',
  '.local',
  '.addrsig',
  '.addrsig_sym',
] as const

const DIRECTIVES: readonly Group[] = [
  { name: 'Syntax and sections', items: ['.intel_syntax noprefix', '.text', '.data', '.section'] },
  {
    name: 'Names',
    items: ['.globl', '.global', '.type', '.equ', '.set'],
    note: 'You can also write a constant as `name = value`.',
  },
  {
    name: 'Data',
    items: [
      '.string',
      '.asciz',
      '.ascii',
      '.quad',
      '.long',
      '.int',
      '.word',
      '.short',
      '.byte',
      '.zero',
      '.space',
      '.skip',
    ],
  },
]

export default function AboutPage(): ReactNode {
  return (
    <PageContainer width="text">
      <PageHeader
        title="About Stack Step"
        lead={
          <>
            Stack Step is a learning tool for beginner <NoWrap>x86-64</NoWrap> assembly. It runs in
            your browser, and you do not need an account.
          </>
        }
      />

      <div className="prose">
        <Callout tone="info" label="Important">
          <p>
            The emulator covers a <strong>teaching subset</strong> of <NoWrap>x86-64</NoWrap>. It is{' '}
            <strong>not a full CPU</strong>.
          </p>
        </Callout>

        <h2>What Stack Step is</h2>
        <p>
          An emulator is a program that acts like a CPU. The emulator in Stack Step reads your
          assembly code and runs it one step at a time. After each step, it shows the registers, the
          stack and the flags.
        </p>
        <p>
          A teaching subset is a small part of <NoWrap>x86-64</NoWrap>: the part that a first
          assembly course uses. Stack Step helps you learn that part and check your thinking. For
          homework that gets a grade, also run your code on the real machine that your course uses.
        </p>

        <h2>What the emulator supports</h2>
        <p>
          Stack Step reads Intel syntax, the way <InlineCode>gcc</InlineCode> and the GNU assembler
          write it.
        </p>

        <h3>Registers and flags</h3>
        <ul>
          <li>
            The 16 general registers, from <InlineCode>rax</InlineCode> to{' '}
            <NoWrap>
              <InlineCode>r15</InlineCode>,
            </NoWrap>{' '}
            and every smaller name inside them, such as{' '}
            <Codes items={['eax', 'ax', 'ah', 'al']} end="." />
          </li>
          <li>
            The register{' '}
            <NoWrap>
              <InlineCode>rip</InlineCode>,
            </NoWrap>{' '}
            which holds the address of the next instruction.
          </li>
          <li>
            Four flags: <Codes items={['CF', 'ZF', 'SF', 'OF']} end="." />
          </li>
        </ul>

        <h3>Instructions</h3>
        <GroupTable groups={INSTRUCTIONS} />

        <h3>Numbers and memory operands</h3>
        <ul>
          <li>
            Numbers can be decimal{' '}
            <NoWrap>
              (<InlineCode>42</InlineCode>),
            </NoWrap>{' '}
            hex{' '}
            <NoWrap>
              (<InlineCode>0x2a</InlineCode>),
            </NoWrap>{' '}
            binary{' '}
            <NoWrap>
              (<InlineCode>0b101010</InlineCode>)
            </NoWrap>{' '}
            or one character{' '}
            <NoWrap>
              (<InlineCode>&apos;A&apos;</InlineCode>).
            </NoWrap>
          </li>
          <li>
            Memory operands can have every form that a first assembly course uses:{' '}
            <Codes
              items={[
                '[rax]',
                '[rbp-8]',
                '-8[rbp]',
                'count[rbp]',
                'message[rip]',
                '[rax+rbx*8+16]',
              ]}
              end="."
            />
          </li>
          <li>
            You can write a size in front of a memory operand:{' '}
            <Codes items={['byte ptr', 'word ptr', 'dword ptr', 'qword ptr']} end="." />
          </li>
        </ul>

        <h3>Library functions</h3>
        <ul>
          <li>
            You can call <Codes items={['printf', 'scanf', 'puts', 'putchar', 'exit']} end="." />
          </li>
          <li>
            <InlineCode>printf</InlineCode> understands{' '}
            <Codes items={['%d', '%i', '%u', '%x', '%X', '%c', '%s', '%p', '%%']} end="." /> You can
            put <Codes items={['l', 'll', 'h']} /> or <InlineCode>hh</InlineCode> in front{' '}
            <NoWrap>
              (like <InlineCode>%ld</InlineCode>)
            </NoWrap>{' '}
            and a width{' '}
            <NoWrap>
              (like <InlineCode>%5d</InlineCode>,
            </NoWrap>{' '}
            <InlineCode>%05d</InlineCode> or{' '}
            <NoWrap>
              <InlineCode>%-5d</InlineCode>).
            </NoWrap>
          </li>
          <li>
            <InlineCode>scanf</InlineCode> understands{' '}
            <Codes items={['%d', '%i', '%u', '%x', '%ld', '%c', '%s']} end="." />
          </li>
        </ul>

        <h3>Directives</h3>
        <GroupTable groups={DIRECTIVES} />
        <ul>
          <li>
            The emulator skips <Codes items={SKIPPED_DIRECTIVES} /> and every directive that starts
            with{' '}
            <NoWrap>
              <InlineCode>.cfi_</InlineCode>.
            </NoWrap>{' '}
            A short program gives the same results without them.
          </li>
          <li>
            On a real machine, <Codes items={['.align', '.p2align']} /> and{' '}
            <InlineCode>.balign</InlineCode> move the next item to an address that is a multiple of
            a number, such as 8. The emulator skips them, so the address of some data can differ
            from a real program.
          </li>
          <li>
            <InlineCode>.comm</InlineCode> does not work. Put the variable after{' '}
            <InlineCode>.data</InlineCode> instead, and make room for it with{' '}
            <NoWrap>
              <InlineCode>.zero</InlineCode>.
            </NoWrap>
          </li>
          <li>Any other directive gives a warning, and the emulator skips it.</li>
        </ul>

        <h2>What the emulator does not support</h2>
        <ul>
          <li>
            <strong>Floating point and SSE.</strong> There are no <InlineCode>xmm</InlineCode>{' '}
            registers and no instructions for numbers with a decimal point.
          </li>
          <li>
            <strong>System calls.</strong> The instruction <InlineCode>syscall</InlineCode> does not
            work.
          </li>
          <li>
            <strong>Most instructions.</strong> <NoWrap>x86-64</NoWrap> has many hundreds of
            instructions. Stack Step runs only the instructions in the table above.
          </li>
          <li>
            <strong>Real machine code.</strong> The emulator knows how many bytes each instruction
            takes, but it does not build the bytes.
          </li>
          <li>
            <strong>The exact behavior of the C library (libc).</strong> The library functions in
            Stack Step are simple versions. They handle the common cases only.
          </li>
          <li>
            <strong>AT&amp;T syntax.</strong> Code such as <InlineCode>movq %rax, %rbx</InlineCode>{' '}
            gives an error that explains the problem.
          </li>
        </ul>

        <h2>Where it differs from a real machine</h2>
        <ul>
          <li>
            <strong>Junk after a library call.</strong> A library function is allowed to change the
            registers <Codes items={['rcx', 'rdx', 'rsi', 'rdi']} /> and <InlineCode>r8</InlineCode>{' '}
            to{' '}
            <NoWrap>
              <InlineCode>r11</InlineCode>.
            </NoWrap>{' '}
            After a call such as{' '}
            <NoWrap>
              <InlineCode>call printf</InlineCode>,
            </NoWrap>{' '}
            Stack Step puts junk values (numbers with no meaning) in these registers. On a real
            machine they may change too, to other values.
          </li>
          <li>
            <strong>
              ZF and SF after{' '}
              <NoWrap>
                <InlineCode>imul</InlineCode>.
              </NoWrap>
            </strong>{' '}
            On a real CPU, ZF and SF have no defined value after{' '}
            <NoWrap>
              <InlineCode>imul</InlineCode>.
            </NoWrap>{' '}
            Stack Step sets them from the result, and it warns you when a jump reads them.
          </li>
          <li>
            <strong>Stack memory that nobody wrote.</strong> Stack Step reads it as 0 and shows a
            note. On a real machine it holds old values.
          </li>
          <li>
            <strong>Numbers that start with 0.</strong> A number such as{' '}
            <InlineCode>010</InlineCode> is an error in Stack Step. The real assembler reads it as
            the number 8, and that is almost never what you want.
          </li>
          <li>
            <strong>Library functions run as one step.</strong> On a real machine,{' '}
            <InlineCode>printf</InlineCode> is many instructions long.
          </li>
          <li>
            <strong>Addresses.</strong> The addresses look like the addresses on a Linux machine,
            but your real machine will probably show other numbers.
          </li>
        </ul>

        <h2>Lessons and practice problems</h2>
        <ul>
          <li>
            All lesson text and all practice problems are original. They were written for Stack
            Step.
          </li>
          <li>
            Stack Step makes a new practice problem every time, so you can practice as much as you
            want.
          </li>
          <li>
            Stack Step runs each problem in the same emulator to find the correct answer. Then it
            compares your answer with it. So the lessons, the practice problems and the stepper
            always agree.
          </li>
        </ul>

        <h2>Your data</h2>
        <ul>
          <li>
            Your progress is saved in this browser only, in a place called{' '}
            <NoWrap>
              <InlineCode>localStorage</InlineCode>.
            </NoWrap>{' '}
            It does not leave your device.
          </li>
          <li>
            If you clear your browser data, or use another browser or device, your progress starts
            again. You can also erase it on the <TextLink to="/progress">Progress page</TextLink>.
          </li>
          <li>
            Stack Step can have an AI tutor. The tutor is off unless the person who hosts the site
            turns it on. When it is on and you ask it a question, these things leave your browser:
            your question, the earlier questions and replies in this chat, your code, and what the
            page shows (the register values, and on a practice page the problem and your answers).
            They go to the server of this site, and from there to the company that runs the AI
            model. The tutor needs them to answer.
          </li>
        </ul>
      </div>
    </PageContainer>
  )
}
