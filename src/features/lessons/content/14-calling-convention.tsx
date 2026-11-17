import { Code, FactTable, Note, Term } from '../components'
import type { LessonContent } from '../types'

// Every line fits in the MiniStepper's code box on a phone (limits: components/index.ts).
const example = String.raw`main:
  push    rbp
  mov     rbp, rsp
  mov     edi, 20 # 1st
  mov     esi, 22 # 2nd
  call    add_two
  pop     rbp
  ret
add_two:
  push    rbx     # save
  mov     ebx, edi
  add     ebx, esi
  mov     eax, ebx
  pop     rbx     # restore
  ret
`

const lesson: LessonContent = {
  id: 'calling-convention',
  idea: 'On Linux, arguments go in `rdi`, `rsi`, `rdx`, `rcx`, `r8`, `r9`, the result comes back in `rax`, and some registers are handed back unchanged.',
  analogy: {
    title: 'Scratch paper and borrowed tools',
    text: 'When you help a friend at their desk, you may write on their scratch paper. But if you borrow a tool, you put it back exactly as you found it. Some registers are scratch paper. Others, such as `rbx`, are borrowed tools.',
  },
  body: (
    <>
      <p>
        When one function calls another, the function that makes the call is the <Term>caller</Term>
        . The function it calls is the <Term>callee</Term>. On Linux, all functions follow the same
        rules, the <Term>calling convention</Term>, so any function can call any other.
      </p>
      <FactTable
        caption="The six argument registers"
        head={['Argument', 'Register']}
        rows={[
          ['1st', '`rdi`'],
          ['2nd', '`rsi`'],
          ['3rd', '`rdx`'],
          ['4th', '`rcx`'],
          ['5th', '`r8`'],
          ['6th', '`r9`'],
        ]}
      />
      <p>
        The result comes back in <Code>rax</Code>. A 32-bit number uses the 32-bit part of the
        register: <Code>edi</Code> instead of <Code>rdi</Code>, <Code>eax</Code> instead of{' '}
        <Code>rax</Code>.
      </p>
      <p>The registers also come in two groups:</p>
      <ul>
        <li>
          <Term>Scratch registers</Term>: <Code>rax</Code>, <Code>rcx</Code>, <Code>rdx</Code>,{' '}
          <Code>rsi</Code>, <Code>rdi</Code> and <Code>r8</Code> to <Code>r11</Code>. A callee may
          change them, so after any <Code>call</Code>, treat them as changed.
        </li>
        <li>
          <strong>Registers to hand back</strong>: <Code>rbx</Code>, <Code>rbp</Code> and{' '}
          <Code>r12</Code> to <Code>r15</Code>. A callee may use them, but it must put the old
          values back before <Code>ret</Code>. As lesson 8 showed, <Code>rsp</Code> too must be back
          where it was.
        </li>
      </ul>
      <p>
        To use <Code>rbx</Code>, save it with <Code>push rbx</Code> at the start and restore it with{' '}
        <Code>pop rbx</Code> at the end. If you save two registers, pop them in reverse order. The
        opening and closing lines from lesson 12 do the same for <Code>rbp</Code>.
      </p>
      <Note>
        Each extra <Code>push</Code> makes <Code>rsp</Code> go down by 8. After{' '}
        <Code>push rbp</Code> and <Code>push rbx</Code>, subtract 8, 24, 40 and so on, so that{' '}
        <Code>rsp</Code> still ends in 0 at a <Code>call</Code>.
      </Note>
      <Note>
        After <Code>printf</Code>, the stepper puts its result in <Code>rax</Code> and junk in the
        other scratch registers. A real <Code>printf</Code> may change them too.
      </Note>
    </>
  ),
  example: {
    intro:
      '`rbx` starts with `0x7` in it. Press Step until the program ends: 13 steps. Watch the registers and the stack.',
    stepper: {
      source: example,
      options: { initialRegisters: { rbx: 0x7n } },
      registers: ['rdi', 'rsi', 'rax', 'rbx'],
      showStack: true,
    },
    watchFor: [
      'Lines 4 and 5 put the arguments in `edi` and `esi`: 20 and 22, or `0x14` and `0x16` in hex. Then `call` jumps to `add_two`.',
      'Line 10 saves the value of `rbx`, `0x7`, in a box. Lines 11 and 12 use `rbx` for the sum.',
      'Line 14 restores `rbx`: it is `0x7` again before `ret`.',
      'Back in `main`, `eax` holds the result: `0x2a` (42).',
    ],
  },
  check: {
    kind: 'choice',
    prompt:
      'Your function counts in a loop and calls `printf` inside the loop. Where should it keep the count, so that the count is still there after each `call`?',
    options: [
      {
        id: 'rcx',
        label: 'Keep the count in `rcx`',
        feedback:
          '`rcx` is a scratch register, so `printf` may change it. That is why the stepper shows junk in `rcx` after `printf`.',
      },
      {
        id: 'rsi',
        label: 'Keep the count in `rsi`',
        feedback:
          '`rsi` is a scratch register, and `printf` reads its 2nd argument from it. After the call it may hold anything.',
      },
      {
        id: 'rax',
        label: 'Keep the count in `rax`',
        feedback:
          '`printf` puts its result in `eax`, a part of `rax`, so the count would be gone after the call.',
      },
      {
        id: 'rbx',
        label: 'Keep the count in `rbx`',
        correct: true,
        feedback:
          'Every function, `printf` too, must hand `rbx` back unchanged. Your own function must save `rbx` with `push` at its start and restore it with `pop` at its end.',
      },
    ],
  },
  recap: [
    'Arguments go in `rdi`, `rsi`, `rdx`, `rcx`, `r8`, `r9`. The result comes back in `rax`.',
    'After any `call`, treat the scratch registers as changed.',
    'To use `rbx`, `rbp` or `r12`–`r15`: `push` at the start, `pop` at the end, in reverse order.',
  ],
}

export default lesson
