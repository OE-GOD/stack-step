import { useId, type ReactNode } from 'react'
import { MiniStepper } from '../../components/ministepper/MiniStepper'

/*
 * A reference for the people who write lessons: what a MiniStepper looks like with
 * different panels. Shown under the stepper only with `#/stepper?demo=ministepper`
 * (nothing links to it).
 */

const SUB_REGISTERS = `    mov     rax, -1          # all 64 bits are 1
    mov     eax, 5           # a 32-bit write clears the top half
    mov     ah, 0x12         # an 8-bit write keeps the other bits
    ret
`

const PUSH_POP = `    mov     rax, 7
    push    rax              # rsp goes down 8, then 7 goes into the new top box
    pop     rbx              # the top box goes into rbx, then rsp goes up 8
    cmp     rbx, 7
    ret
`

const PRINT = `    .intel_syntax noprefix
message:
    .string "Hi!\\n"
main:
    push    rbp              # keeps the stack lined up to 16 for the call
    lea     rdi, message[rip]
    mov     eax, 0
    call    printf@PLT
    pop     rbp
    ret
`

export function MiniStepperDemo(): ReactNode {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="mx-auto w-full max-w-[45rem] px-4 pt-10 pb-12 md:px-6"
    >
      <h2 id={headingId} className="text-xl font-bold text-ink">
        MiniStepper demo
      </h2>
      <p className="mt-1 text-sm text-muted">
        For lesson writers: the small stepper that lessons and practice use. Only this address shows
        it.
      </p>
      <div className="mt-5 space-y-6">
        <MiniStepper title="Try it: parts of rax" source={SUB_REGISTERS} registers={['rax']} />
        <MiniStepper title="Try it: push and pop" source={PUSH_POP} showStack showFlags showRip />
        <MiniStepper title="Try it: printf" source={PRINT} registers={['rax', 'rdi']} />
      </div>
    </section>
  )
}
