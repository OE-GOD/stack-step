/**
 * The page of the tutor harness: something that looks like a stepper page (or a practice
 * page), with the tutor mounted on it, so that the button and the drawer can be judged
 * over real-looking content, at any width, in both themes.
 *
 * Tests read what the page gives to the tutor:
 *
 *   window.__tutorHarness.context   // the TutorContext that getContext() returns
 */
import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Callout } from '../../components/ui/Callout'
import { Panel } from '../../components/ui/Panel'
import { RichText } from '../../components/ui/RichText'
import { TutorMount, type TutorContext } from './TutorMount'

declare global {
  interface Window {
    __tutorHarness?: { context: TutorContext }
  }
}

const QUERY = new URLSearchParams(window.location.search)
const IS_PRACTICE = QUERY.get('page') === 'practice'
const HAS_BAR = QUERY.get('bar') === '1'
/** The height of the pretend control bar, and what the page tells the tutor's button. */
const BAR_HEIGHT = '64px'

/** A short program with the classic mistake: `push` without `pop` before `ret`. */
const STEPPER_CODE = `    .intel_syntax noprefix
    .globl main
main:
    push rbx
    mov ebx, 5
    mov eax, ebx
    add eax, 2
    ret
`

const STEPPER_MACHINE = `Status: stopped with an error
Registers: rax = 0x7, rbx = 0x5, rsp = 0x7ffffffddff8, rbp = 0x0, rip = 0x0
Flags: CF = 0, ZF = 0, SF = 0, OF = 0
Top of the stack: 0x7ffffffddff8 holds 0x7ffff7c29d90 (return address)
Last step, line 8: \`ret\` popped 0x0 into rip. The top of the stack did not hold a return address. Did you push something and forget to pop it?`

const EXPLANATION =
  'Line 8: `ret` popped 0x0 into rip. The top of the stack did not hold a return address. Did you push something and forget to pop it?'

const PRACTICE_CODE = `mov rax, 0x1122334455667788
mov eax, -1
`

const PRACTICE_PROBLEM =
  'What is in `rax` after these two lines? Type the answer in hex, starting with 0x.'

const CONTEXT: TutorContext = IS_PRACTICE
  ? { page: 'practice', code: PRACTICE_CODE, machine: '', problem: PRACTICE_PROBLEM }
  : { page: 'stepper', code: STEPPER_CODE, machine: STEPPER_MACHINE, problem: null }

const REGISTERS: [string, string][] = [
  ['rax', '0x7'],
  ['rbx', '0x5'],
  ['rcx', '0x0'],
  ['rdx', '0x0'],
  ['rsi', '0x0'],
  ['rdi', '0x0'],
  ['rbp', '0x0'],
  ['rsp', '0x7ffffffddff8'],
]

function getContext(): TutorContext {
  return CONTEXT
}

export function TutorDemoPage(): ReactNode {
  useEffect(() => {
    window.__tutorHarness = { context: CONTEXT }
    return () => {
      delete window.__tutorHarness
    }
  }, [])

  // A page with a bar at the bottom tells the tutor's button how far to move up.
  const pageStyle = HAS_BAR ? ({ '--tutor-bottom-offset': BAR_HEIGHT } as CSSProperties) : undefined

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6" style={pageStyle}>
      <h1 className="text-3xl leading-tight font-extrabold tracking-tight">Tutor harness</h1>
      <p className="mt-3 max-w-2xl text-lg text-muted">
        A pretend {IS_PRACTICE ? 'practice' : 'stepper'} page. The tutor's button shows up at the
        bottom right when the tutor function says that the tutor is on.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-[3fr_2fr]">
        <Panel title={IS_PRACTICE ? 'Problem' : 'Code'} actions={<Badge>Example</Badge>}>
          {IS_PRACTICE && (
            <p className="mb-3">
              <RichText text={PRACTICE_PROBLEM} />
            </p>
          )}
          <pre className="overflow-x-auto rounded-lg bg-code-bg p-3 font-mono text-sm leading-6">
            {CONTEXT.code}
          </pre>
          <p className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary">Step</Button>
            <Button>Back</Button>
            <Button>Reset</Button>
          </p>
        </Panel>

        <Panel title="Registers">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
            {REGISTERS.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="font-semibold">{name}</dt>
                <dd className="[overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      <Callout tone="warn" label="The program stopped" className="mt-4">
        <p>
          <RichText text={EXPLANATION} />
        </p>
      </Callout>

      <div className="prose mt-8">
        <h2>Filler text</h2>
        {Array.from({ length: 14 }, (_, index) => (
          <p key={index}>
            Paragraph {index + 1}. This text makes the page long enough to scroll, so that you can
            see the button stay in its corner, and see that the page behind the drawer does not move
            on a phone.
          </p>
        ))}
      </div>

      {HAS_BAR && (
        <div
          className="fixed inset-x-0 bottom-0 z-10 flex items-center justify-center gap-2 border-t border-line-strong bg-surface"
          style={{ height: BAR_HEIGHT }}
          data-testid="control-bar"
        >
          <Button variant="primary">Step</Button>
          <Button>Back</Button>
          <Button>Run</Button>
        </div>
      )}

      <TutorMount getContext={getContext} />
    </main>
  )
}
