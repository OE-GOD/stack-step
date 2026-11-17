import { describe, expect, it } from 'vitest'
import { assemble, createEmulator, hex, hex64, type StackSlot } from '../../emulator'
import { exampleById } from '../../examples'
import { summarizeMachine } from './machineSummary'

/*
 * The sentences inside the summary (explanations, notes, stack labels, errors, prompts)
 * come from the emulator, and their wording changes from time to time. These tests check
 * that the summary carries them and the facts around them (numbers, lines, registers),
 * not the exact words.
 */

function emulatorFor(id: string, options = {}) {
  const example = exampleById(id)
  if (example === undefined) throw new Error(`No example ${id}`)
  const created = createEmulator(example.source, options)
  if (!created.ok) throw new Error('The example did not assemble.')
  return created.emulator
}

/** The summary line of one stack box, as `summarizeMachine` writes it. */
function boxLine(slot: StackSlot, pointers: string): string {
  const value = slot.value === null ? 'not set yet' : hex64(slot.value)
  const label = slot.label === null ? '' : ` (${slot.label})`
  return `- ${hex(slot.address)}: ${value}${label}${pointers}`
}

describe('summarizeMachine', () => {
  it('describes a fresh program', () => {
    const emulator = emulatorFor('hello-world')
    const machine = emulator.getSnapshot()
    const text = summarizeMachine(machine, { program: emulator.program })
    expect(text).toContain('Status: ready, no step has run yet.')
    expect(text).toContain('Next: line 11, `push rbp`.')
    // Only rsp is not 0 at the start.
    expect(text).toContain('Registers that are not 0: rsp = 0x00007ffffffddff8. All others are 0.')
    expect(text).toContain('rip = 0x401126')
    expect(text).toContain('Flags: CF=0, ZF=0, SF=0, OF=0.')
    // The one box: the return address into the "OS", where rsp points.
    const top = machine.stack.find((slot) => slot.isRsp)
    expect(top?.value).toBe(0x7ffff7c29d90n)
    if (top === undefined) throw new Error('rsp points at no box')
    expect(text).toContain(boxLine(top, ' <- rsp'))
    expect(text).toContain('Printed so far: nothing.')
    expect(text).not.toContain('Last step')
  })

  it('lists the top four boxes, the last step, its notes and the output', () => {
    const emulator = emulatorFor('nested-call')
    // Up to and including the library step of printf inside show_double.
    for (let i = 0; i < 13; i++) emulator.step()
    const machine = emulator.getSnapshot()
    const step = machine.lastStep
    expect(step?.kind).toBe('library')
    if (step === null) throw new Error('no step ran')
    const text = summarizeMachine(machine, { program: emulator.program })

    expect(text).toMatch(/^Status: paused at line \d+, after 13 steps\./)
    const stackLines = text.split('\n').filter((line) => line.startsWith('- 0x'))
    expect(stackLines).toHaveLength(4)
    expect(stackLines[0]).toContain('<- rsp and rbp')
    // The return address of the call on line 29 is one of the four boxes.
    const back = machine.stack.find(
      (slot) => slot.kind === 'return-address' && slot.label?.includes('29') === true,
    )
    expect(back).toBeDefined()
    expect(stackLines.some((line) => back !== undefined && line === boxLine(back, ''))).toBe(true)
    // The explanation of the step and its notes, as the emulator wrote them.
    expect(text).toContain(`Last step (step 13, line ${step.line}): ${step.explanation}`)
    expect(step.explanation).toContain('printf')
    expect(step.notes.length).toBeGreaterThan(0)
    for (const note of step.notes) {
      expect(text).toContain(`${note.kind === 'tip' ? 'Tip' : 'Warning'}: ${note.text}`)
    }
    expect(text).toContain('Printed so far: "Double of 21 is 42.\\n"')
  })

  it('names the error and the end of the program', () => {
    const created = createEmulator('main:\n    push 5\n    ret\n')
    if (!created.ok) throw new Error('did not assemble')
    created.emulator.run()
    const machine = created.emulator.getSnapshot()
    const text = summarizeMachine(machine)
    expect(text).toContain('Status: the program stopped with an error after 2 steps.')
    expect(machine.error?.line).toBe(3)
    expect(text).toContain(`Error: ${machine.error?.message ?? '(none)'}`)

    const done = emulatorFor('hello-world')
    done.run()
    expect(summarizeMachine(done.getSnapshot())).toContain(
      'Status: the program ended after 9 steps.',
    )
  })

  it('says when scanf waits for input', () => {
    const emulator = emulatorFor('read-number')
    emulator.run()
    const machine = emulator.getSnapshot()
    const text = summarizeMachine(machine)
    expect(text).toContain('Status: scanf is waiting for input')
    expect(machine.inputRequest).not.toBeNull()
    expect(text).toContain(`Input wanted: ${machine.inputRequest?.prompt ?? '(none)'}`)
  })

  it('lists the errors when the program cannot run', () => {
    const result = assemble('main:\n    mov [rax], [rbx]\n')
    const text = summarizeMachine(null, { diagnostics: result.diagnostics })
    expect(text).toContain('Status: the program has errors, so it cannot run yet.')
    const [first] = result.diagnostics
    expect(first?.line).toBe(2)
    expect(text).toContain(`- ${first?.message ?? '(none)'}`)
  })

  it('cuts very long output from the front', () => {
    const emulator = emulatorFor('hello-world')
    const machine = { ...emulator.getSnapshot(), output: 'x'.repeat(5000) }
    const text = summarizeMachine(machine)
    expect(text.length).toBeLessThan(2000)
    expect(text).toContain('Printed so far: "…xxx')
  })
})
