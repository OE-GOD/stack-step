import { describe, expect, it } from 'vitest'
import { exampleById } from '../../examples'
import { encodePayload } from '../../lib/share'
import {
  EARLIER_PROGRAM,
  exampleWithSource,
  initialProgram,
  isOwnProgram,
  LINK_PROGRAM,
  MAX_NOTE_LENGTH,
  optionsFromText,
  optionsToText,
  OWN_PROGRAM,
  programMenu,
  savedOwnProgram,
  shortNote,
} from './initialProgram'
import { StepperSession } from './session'
import { statusOf, stepsText } from './status'

const HELLO = exampleById('hello-world')?.source ?? ''
const FACTORIAL = exampleById('factorial')?.source ?? ''
const MINE = 'main:\n    mov rax, 1\n    ret\n'

describe('initialProgram', () => {
  it('opens a shared link with its options and note', () => {
    const s = encodePayload({
      code: MINE,
      options: { initialRegisters: { rbx: 5n } },
      note: 'This is the problem you just tried.',
    })
    const program = initialProgram({ s, example: 'factorial' }, 'saved code')
    expect(program.code).toBe(MINE)
    expect(program.options).toEqual({ initialRegisters: { rbx: 5n } })
    expect(program.note).toBe('This is the problem you just tried.')
    expect(program.notice).toBeNull()
  })

  it('a damaged link falls back to the example, the saved program, then Hello World', () => {
    expect(initialProgram({ s: 'v1.@@@', example: 'factorial' }, null)).toEqual({
      code: FACTORIAL,
      note: null,
      notice:
        'This link is damaged, so its program could not be opened. Here is the example “Factorial (loop)”.',
    })
    expect(initialProgram({ s: 'nonsense', example: null }, MINE)).toEqual({
      code: MINE,
      note: null,
      notice:
        'This link is damaged, so its program could not be opened. Here is your last program.',
    })
    expect(initialProgram({ s: '', example: null }, null).code).toBe(HELLO)
  })

  it('opens an example by id, and says so when the id is unknown', () => {
    expect(initialProgram({ s: null, example: 'factorial' }, MINE).code).toBe(FACTORIAL)
    const unknown = initialProgram({ s: null, example: 'nope' }, null)
    expect(unknown.code).toBe(HELLO)
    expect(unknown.notice).toBe(
      'This link asks for an example that does not exist. Here is the Hello World example.',
    )
  })

  it('opens the saved program, else Hello World', () => {
    expect(initialProgram({ s: null, example: null }, MINE)).toEqual({
      code: MINE,
      note: null,
      notice: null,
    })
    expect(initialProgram({ s: null, example: null }, '   \n').code).toBe(HELLO)
    expect(initialProgram({ s: null, example: null }, null).code).toBe(HELLO)
  })

  it('opens the saved program with its saved starting state', () => {
    const options = { initialRegisters: { rbx: 7n }, initialRsp: 0x7ffffffddfe0n }
    const program = initialProgram({ s: null, example: null }, MINE, optionsToText(options))
    expect(program.code).toBe(MINE)
    expect(program.options).toEqual(options)
    // A broken or missing state: the usual start.
    expect(initialProgram({ s: null, example: null }, MINE, 'broken').options).toBeUndefined()
    expect(initialProgram({ s: null, example: null }, MINE, null).options).toBeUndefined()
    // The state belongs to the saved program only, not to Hello World.
    expect(
      initialProgram({ s: null, example: null }, null, optionsToText(options)).options,
    ).toBeUndefined()
  })

  it('saves no text for the usual starting state, and reads back what it saved', () => {
    expect(optionsToText(undefined)).toBeNull()
    expect(optionsFromText(null)).toBeUndefined()
    const options = { initialFlags: { ZF: 1 as const }, stdin: '41\n' }
    expect(optionsFromText(optionsToText(options))).toEqual(options)
  })

  it('cuts a very long note, so a crafted link cannot push the code off the screen', () => {
    const long = 'Watch rax. '.repeat(600)
    const program = initialProgram(
      { s: encodePayload({ code: MINE, note: long }), example: null },
      null,
    )
    expect(program.note?.length).toBe(MAX_NOTE_LENGTH)
    expect(program.note?.endsWith('…')).toBe(true)
    expect(shortNote('  Step once and watch `rax`.  ')).toBe('Step once and watch `rax`.')
  })

  it('finds the example whose program is exactly the code', () => {
    expect(exampleWithSource(FACTORIAL)?.id).toBe('factorial')
    expect(exampleWithSource(`${FACTORIAL}\n`)).toBeUndefined()
  })
})

describe('statusOf', () => {
  it('names every state', () => {
    const session = new StepperSession({ source: HELLO })
    expect(statusOf(session.getState())).toEqual({ kind: 'ready', text: 'Ready' })

    session.step()
    expect(statusOf(session.getState())).toEqual({ kind: 'paused', text: 'Paused at line 12' })

    session.toggleBreakpoint(13)
    session.step()
    expect(statusOf(session.getState()).text).toBe('Paused at line 13 (breakpoint)')

    // lea, mov eax, then the call: rip is inside printf.
    for (let i = 0; i < 3; i++) session.step()
    expect(statusOf(session.getState()).text).toBe('Paused inside printf')

    for (let i = 0; i < 10; i++) session.step()
    expect(statusOf(session.getState())).toEqual({ kind: 'ended', text: 'Ended' })

    session.setSource('main:\n    push 5\n    ret\n')
    session.step()
    session.step()
    expect(statusOf(session.getState())).toEqual({ kind: 'error', text: 'Error' })

    session.setSource('main:\n    mov [rax], [rbx]\n')
    expect(statusOf(session.getState())).toEqual({ kind: 'problems', text: 'Error' })
  })

  it('says Running while auto-play is on, and Waiting for input for scanf', () => {
    const session = new StepperSession({ source: exampleById('read-number')?.source ?? '' })
    session.play()
    expect(statusOf(session.getState()).kind).toBe('running')
    session.pause()
    session.setSpeed(10)
    session.play()
    expect(statusOf(session.getState())).toEqual({ kind: 'waiting', text: 'Waiting for input' })
  })

  it('counts steps in words, with a comma every three digits', () => {
    expect(stepsText(0)).toBe('0 steps')
    expect(stepsText(1)).toBe('1 step')
    expect(stepsText(12)).toBe('12 steps')
    expect(stepsText(10000)).toBe('10,000 steps')
  })

  it('says Stopped, not Paused, when the loop guard stopped Run', () => {
    const session = new StepperSession({ source: 'main:\n    jmp main\n', speed: 10 })
    session.play()
    expect(session.getState().runStop).toBe('step-limit')
    expect(statusOf(session.getState()).text).toBe('Stopped at line 2')
    expect(session.getState().runMessage).toContain('10,000 steps')
  })
})

describe("the student's programs", () => {
  it('knows a program the student wrote from an example and from nothing', () => {
    expect(isOwnProgram(MINE)).toBe(true)
    expect(isOwnProgram(HELLO)).toBe(false)
    expect(isOwnProgram('  \n ')).toBe(false)
  })

  it('keeps the saved program aside when a link opens another one, with its starting state', () => {
    const options = optionsToText({ initialRegisters: { rbx: 3n } })
    expect(savedOwnProgram(MINE, options, FACTORIAL)).toEqual({
      code: MINE,
      options: { initialRegisters: { rbx: 3n } },
    })
    // Nothing to keep: no saved program, an example, the link's own program.
    expect(savedOwnProgram(null, null, FACTORIAL)).toBeNull()
    expect(savedOwnProgram(HELLO, null, FACTORIAL)).toBeNull()
    expect(savedOwnProgram(MINE, null, MINE)).toBeNull()
  })

  it('offers the other program in the Example menu, by the program in the editor', () => {
    // An example: its title is chosen; "Your own program" when there is one to come back to.
    expect(programMenu({ source: FACTORIAL, linkProgram: false, hasOther: true })).toEqual({
      value: 'factorial',
      choices: [{ value: OWN_PROGRAM, label: 'Your own program' }],
    })
    expect(programMenu({ source: FACTORIAL, linkProgram: false, hasOther: false }).choices).toEqual(
      [],
    )
    // A link's program, not changed yet.
    expect(programMenu({ source: MINE, linkProgram: true, hasOther: true })).toEqual({
      value: LINK_PROGRAM,
      choices: [
        { value: LINK_PROGRAM, label: 'Program from the link' },
        { value: OWN_PROGRAM, label: 'Your own program' },
      ],
    })
    // The student's own program, and the other one kept aside.
    expect(programMenu({ source: MINE, linkProgram: false, hasOther: true })).toEqual({
      value: OWN_PROGRAM,
      choices: [
        { value: OWN_PROGRAM, label: 'Your own program' },
        { value: EARLIER_PROGRAM, label: 'Your earlier program' },
      ],
    })
    expect(programMenu({ source: MINE, linkProgram: false, hasOther: false }).choices).toEqual([
      { value: OWN_PROGRAM, label: 'Your own program' },
    ])
  })
})
