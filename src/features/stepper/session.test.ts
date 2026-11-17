import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmulator, runStopMessage } from '../../emulator'
import { exampleById } from '../../examples'
import {
  AUTO_PLAY_MAX_STEPS,
  clampSpeed,
  DEFAULT_SPEED,
  MAX_SPEED,
  safeOptions,
  StepperSession,
  stepDelay,
  type SessionTimers,
} from './session'

function source(id: string): string {
  const example = exampleById(id)
  if (example === undefined) throw new Error(`No example ${id}`)
  return example.source
}

const HELLO = source('hello-world')
const FACTORIAL = source('factorial')
const READ_NUMBER = source('read-number')

/** Three instructions; `ret` pops the 5 that was pushed: a run-time error on line 4. */
const BAD_RET = `main:
    push 5
    nop
    ret
`

const BROKEN = `main:
    mov [rax], [rbx]
    ret
`

/** The same program with a `nop` before its first `ret`: it does something else now. */
function withNop(text: string): string {
  const changed = text.replace(/^(\s*)ret\b/m, '$1nop\n$1ret')
  if (changed === text) throw new Error('The program has no ret.')
  return changed
}

/** The line of the first line of `text` that contains `needle` (1-based). */
function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle))
  if (index < 0) throw new Error(`"${needle}" is not in the program`)
  return index + 1
}

/** What the emulator's own `run()` gives for a program, from the start. */
function emulatorRun(text: string) {
  const created = createEmulator(text)
  if (!created.ok) throw new Error('The program did not assemble.')
  return created.emulator.run()
}

function machineOf(session: StepperSession) {
  const machine = session.getState().machine
  if (machine === null) throw new Error('The program did not assemble.')
  return machine
}

/** Timers the test moves by hand. */
function manualTimers(): SessionTimers & {
  pending: () => number
  fire: () => void
  delays: number[]
} {
  let queue: { id: number; callback: () => void }[] = []
  let nextId = 1
  const delays: number[] = []
  return {
    setTimeout(callback, ms) {
      delays.push(ms)
      const id = nextId++
      queue.push({ id, callback })
      return id
    },
    clearTimeout(handle) {
      queue = queue.filter((entry) => entry.id !== handle)
    },
    pending: () => queue.length,
    fire() {
      const first = queue.shift()
      first?.callback()
    },
    delays,
  }
}

describe('speed', () => {
  it('maps the slider to the wait between steps', () => {
    expect(stepDelay(1)).toBe(1500)
    expect(stepDelay(5)).toBe(350)
    expect(stepDelay(9)).toBe(40)
    expect(stepDelay(10)).toBe(0)
    for (let speed = 1; speed < 9; speed++) {
      expect(stepDelay(speed)).toBeGreaterThan(stepDelay(speed + 1))
    }
  })

  it('keeps the speed a whole number from 1 to 10', () => {
    expect(clampSpeed(0)).toBe(1)
    expect(clampSpeed(42)).toBe(10)
    expect(clampSpeed(4.6)).toBe(5)
    expect(clampSpeed(Number.NaN)).toBe(DEFAULT_SPEED)
  })
})

describe('assembling', () => {
  it('starts with a ready machine for a good program', () => {
    const session = new StepperSession({ source: HELLO })
    const state = session.getState()
    expect(state.ok).toBe(true)
    expect(state.machine?.stepCount).toBe(0)
    expect(state.program?.instructions.length).toBeGreaterThan(0)
    expect(state.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(state.playing).toBe(false)
    expect(state.speed).toBe(DEFAULT_SPEED)
  })

  it('has no machine while the program has errors, and gets one back when they are fixed', () => {
    const session = new StepperSession({ source: HELLO })
    session.setSource(BROKEN)
    let state = session.getState()
    expect(state.ok).toBe(false)
    expect(state.machine).toBeNull()
    expect(state.program).toBeNull()
    expect(state.diagnostics[0]?.severity).toBe('error')
    expect(state.diagnostics[0]?.message).toMatch(/^Line 2: /)

    // The controls do nothing while there is no machine.
    session.step()
    session.play()
    expect(session.getState()).toBe(state)

    session.setSource(HELLO)
    state = session.getState()
    expect(state.ok).toBe(true)
    expect(state.machine?.stepCount).toBe(0)
  })

  it('keeps the same state object until something changes', () => {
    const session = new StepperSession({ source: HELLO })
    const first = session.getState()
    expect(session.getState()).toBe(first)
    session.setSource(HELLO)
    session.pause()
    expect(session.getState()).toBe(first)
    session.step()
    expect(session.getState()).not.toBe(first)
  })

  it('calls listeners on changes until they unsubscribe', () => {
    const session = new StepperSession({ source: HELLO })
    const listener = vi.fn()
    const stop = session.subscribe(listener)
    session.step()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    session.step()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('uses the starting options, and setOptions starts the program again with new ones', () => {
    const session = new StepperSession({
      source: 'main:\n    mov rax, rbx\n    ret\n',
      options: { initialRegisters: { rbx: 7n } },
    })
    session.step()
    expect(machineOf(session).registers.rax).toBe(7n)
    session.setOptions({ initialRegisters: { rbx: 9n } })
    expect(machineOf(session).stepCount).toBe(0)
    session.step()
    expect(machineOf(session).registers.rax).toBe(9n)
    expect(session.getOptions()).toEqual({ initialRegisters: { rbx: 9n } })
  })
})

describe('step, back and reset', () => {
  it('steps forward and back', () => {
    const session = new StepperSession({ source: HELLO })
    session.step()
    session.step()
    expect(machineOf(session).stepCount).toBe(2)
    expect(machineOf(session).registers.rbp).toBe(machineOf(session).registers.rsp)

    session.back()
    expect(machineOf(session).stepCount).toBe(1)
    expect(machineOf(session).registers.rbp).toBe(0n)

    session.back()
    session.back() // already at the start: nothing happens
    expect(machineOf(session).stepCount).toBe(0)
    expect(machineOf(session).canStepBack).toBe(false)
  })

  it('reset goes back to the start and keeps the breakpoints', () => {
    const session = new StepperSession({ source: HELLO })
    session.toggleBreakpoint(lineOf(HELLO, 'call'))
    for (let i = 0; i < 4; i++) session.step()
    session.reset()
    expect(machineOf(session).stepCount).toBe(0)
    expect(session.getState().breakpoints).toEqual([lineOf(HELLO, 'call')])
    expect(machineOf(session).breakpoints).toEqual([lineOf(HELLO, 'call')])
  })

  it('does nothing when the program has ended', () => {
    const session = new StepperSession({ source: HELLO })
    for (let i = 0; i < 20; i++) session.step()
    const ended = session.getState()
    expect(ended.machine?.status).toBe('halted')
    expect(ended.machine?.output).toBe('Hello World!\n')
    session.step()
    expect(session.getState()).toBe(ended)
  })
})

describe('breakpoints', () => {
  it('survive edits; lines past the new end are dropped', () => {
    const session = new StepperSession({ source: HELLO })
    const call = lineOf(HELLO, 'call')
    session.toggleBreakpoint(call)
    session.toggleBreakpoint(19)
    expect(session.getState().breakpoints).toEqual([call, 19])

    // One line shorter at the end: line 19 no longer exists.
    const shorter = HELLO.replace(/\n$/, '')
    session.setSource(shorter)
    expect(session.getState().breakpoints).toEqual([call])
    expect(machineOf(session).breakpoints).toEqual([call])

    // While the program has errors the breakpoints wait, then come back.
    session.setSource(shorter.replace('push    rbp', 'push    [rbp]'))
    expect(session.getState().ok).toBe(false)
    expect(session.getState().breakpoints).toEqual([call])
    session.setSource(shorter)
    expect(machineOf(session).breakpoints).toEqual([call])
  })

  it('toggling twice removes the breakpoint; bad lines are ignored', () => {
    const session = new StepperSession({ source: HELLO })
    session.toggleBreakpoint(12)
    session.toggleBreakpoint(12)
    session.toggleBreakpoint(0)
    session.toggleBreakpoint(2.5)
    expect(session.getState().breakpoints).toEqual([])
  })

  it('setBreakpoints replaces them all (the editor moved them), sorted, without repeats', () => {
    const session = new StepperSession({ source: HELLO })
    session.toggleBreakpoint(12)
    session.setBreakpoints([16, 13, 16, 0, 2.5])
    expect(session.getState().breakpoints).toEqual([13, 16])
    expect(machineOf(session).breakpoints).toEqual([13, 16])
    // The same list again changes nothing.
    const state = session.getState()
    session.setBreakpoints([16, 13])
    expect(session.getState()).toBe(state)
  })

  it('load() replaces the program and clears the breakpoints', () => {
    const session = new StepperSession({ source: HELLO })
    session.toggleBreakpoint(12)
    session.step()
    session.load(FACTORIAL)
    const state = session.getState()
    expect(state.source).toBe(FACTORIAL)
    expect(state.breakpoints).toEqual([])
    expect(state.restartedByEdit).toBe(false)
    expect(state.machine?.stepCount).toBe(0)
  })
})

describe('editing while running', () => {
  /** Hello World with one more instruction: a program that does something else. */
  const CHANGED = withNop(HELLO)

  it('restarts a changed program and says so until the machine moves again', () => {
    const session = new StepperSession({ source: HELLO })
    session.setSource(CHANGED)
    expect(session.getState().restartedByEdit).toBe(false)

    session.step()
    session.step()
    session.setSource(HELLO)
    expect(session.getState().restartedByEdit).toBe(true)
    expect(session.getState().keptPlaceAfterEdit).toBe(false)
    expect(machineOf(session).stepCount).toBe(0)

    // More typing keeps the message.
    session.setSource(`${HELLO}# a comment\n`)
    expect(session.getState().restartedByEdit).toBe(true)

    session.step()
    expect(session.getState().restartedByEdit).toBe(false)
  })

  it('an edit that changes only comments or spaces keeps the machine at its step', () => {
    const session = new StepperSession({ source: HELLO })
    for (let i = 0; i < 5; i++) session.step()
    const before = machineOf(session)
    session.setSource(HELLO.replace('# print the text', '# print the text!'))
    const state = session.getState()
    expect(state.keptPlaceAfterEdit).toBe(true)
    expect(state.restartedByEdit).toBe(false)
    expect(machineOf(session).stepCount).toBe(5)
    expect(machineOf(session).registers).toEqual(before.registers)
    expect(machineOf(session).inLibrary).toEqual(before.inLibrary)

    // A new line above moves the lines, but the program does the same: still step 5.
    session.setSource(`# my notes\n${HELLO}`)
    expect(machineOf(session).stepCount).toBe(5)
    expect(machineOf(session).lastStep?.line).toBe((before.lastStep?.line ?? 0) + 1)

    // The next step clears the note.
    session.step()
    expect(session.getState().keptPlaceAfterEdit).toBe(false)
  })

  it('a typo that is fixed again comes back to the same step', () => {
    const session = new StepperSession({ source: HELLO })
    for (let i = 0; i < 3; i++) session.step()
    session.setSource(HELLO.replace('push    rbp', 'pusj    rbp'))
    expect(session.getState().machine).toBeNull()
    session.setSource(HELLO.replace('# save the', '#  save the'))
    expect(machineOf(session).stepCount).toBe(3)
    expect(session.getState().keptPlaceAfterEdit).toBe(true)
  })

  it('a moved label that changes where a jump goes starts the program again', () => {
    const loop = 'main:\n    mov ecx, 3\nagain:\n    dec ecx\n    jne again\n    ret\n'
    const moved = 'main:\nagain:\n    mov ecx, 3\n    dec ecx\n    jne again\n    ret\n'
    const session = new StepperSession({ source: loop })
    session.step()
    session.step()
    session.setSource(moved)
    expect(machineOf(session).stepCount).toBe(0)
    expect(session.getState().restartedByEdit).toBe(true)
  })
})

describe('auto-play', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the first step at once, then one step per delay, and stops at the end', () => {
    const session = new StepperSession({ source: HELLO, speed: 5 })
    session.play()
    expect(session.getState().playing).toBe(true)
    expect(machineOf(session).stepCount).toBe(1)

    vi.advanceTimersByTime(349)
    expect(machineOf(session).stepCount).toBe(1)
    vi.advanceTimersByTime(1)
    expect(machineOf(session).stepCount).toBe(2)

    vi.advanceTimersByTime(350 * 20)
    const state = session.getState()
    expect(state.playing).toBe(false)
    expect(state.machine?.status).toBe('halted')
    expect(state.runStop).toBe('halted')
    expect(state.runMessage).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops at a breakpoint, and Run again moves on from it', () => {
    const session = new StepperSession({ source: HELLO, speed: 9 })
    const line = lineOf(HELLO, 'mov     eax, 0')
    session.toggleBreakpoint(line)
    session.play()
    vi.advanceTimersByTime(1000)
    let state = session.getState()
    expect(state.playing).toBe(false)
    expect(state.machine?.nextLine).toBe(line)
    expect(state.runStop).toBe('breakpoint')
    expect(state.runMessage).toMatch(new RegExp(`\\b${line}\\b`))

    session.play()
    vi.advanceTimersByTime(5000)
    state = session.getState()
    expect(state.machine?.status).toBe('halted')
  })

  it('stops when scanf needs input, and goes on after the input', () => {
    const session = new StepperSession({ source: READ_NUMBER, speed: 9 })
    session.play()
    vi.advanceTimersByTime(5000)
    let state = session.getState()
    expect(state.playing).toBe(false)
    expect(state.machine?.status).toBe('waiting-input')
    expect(state.machine?.inputRequest).not.toBeNull()
    expect(state.runStop).toBe('waiting-input')

    session.provideInput('41')
    // scanf ran at once, and auto-play goes on because Run stopped for the input.
    state = session.getState()
    expect(state.playing).toBe(true)
    vi.advanceTimersByTime(5000)
    state = session.getState()
    expect(state.machine?.status).toBe('halted')
    expect(state.machine?.output).toBe('Type a number: 41 plus 1 is 42.\n')
  })

  it('stops on a run-time error', () => {
    const session = new StepperSession({ source: BAD_RET, speed: 9 })
    session.play()
    vi.advanceTimersByTime(1000)
    const state = session.getState()
    expect(state.playing).toBe(false)
    expect(state.machine?.status).toBe('error')
    expect(state.runStop).toBe('error')
    expect(state.runMessage).toMatch(/\b4\b/)
  })

  it('stops a loop that never ends after maxSteps steps', () => {
    const session = new StepperSession({
      source: 'main:\n    jmp main\n',
      speed: 9,
      options: { maxSteps: 25 },
    })
    session.play()
    vi.advanceTimersByTime(40 * 100)
    const state = session.getState()
    expect(state.playing).toBe(false)
    expect(state.machine?.stepCount).toBe(25)
    expect(state.runStop).toBe('step-limit')
    expect(state.runMessage).toMatch(/\b25\b/)
  })

  it('pause stops it; step, back and reset stop it too', () => {
    const session = new StepperSession({ source: FACTORIAL, speed: 5 })
    session.play()
    session.pause()
    expect(session.getState().playing).toBe(false)
    vi.advanceTimersByTime(5000)
    expect(machineOf(session).stepCount).toBe(1)

    for (const action of ['step', 'back', 'reset'] as const) {
      session.play()
      expect(session.getState().playing).toBe(true)
      session[action]()
      expect(session.getState().playing).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('an edit stops it', () => {
    const session = new StepperSession({ source: FACTORIAL, speed: 5 })
    session.play()
    session.setSource(withNop(FACTORIAL))
    expect(session.getState().playing).toBe(false)
    expect(session.getState().restartedByEdit).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    // An edit of a comment stops it too, and keeps the step.
    session.play()
    vi.advanceTimersByTime(350 * 3)
    const steps = machineOf(session).stepCount
    session.setSource(`${session.getState().source}# a note\n`)
    expect(session.getState().playing).toBe(false)
    expect(machineOf(session).stepCount).toBe(steps)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops after 1,000 steps, far sooner than the 10,000 steps of Run at "instant"', () => {
    const timers = manualTimers()
    const session = new StepperSession({ source: 'main:\n    jmp main\n', speed: 9, timers })
    session.play()
    for (let i = 0; i < 2000 && timers.pending() > 0; i++) timers.fire()
    const state = session.getState()
    expect(state.playing).toBe(false)
    expect(state.machine?.stepCount).toBe(AUTO_PLAY_MAX_STEPS)
    expect(state.runStop).toBe('step-limit')
    expect(state.runMessage).toContain('1,000 steps')
  })

  it('speed 10 runs to the end at once', () => {
    const session = new StepperSession({ source: FACTORIAL, speed: MAX_SPEED })
    session.play()
    const state = session.getState()
    expect(state.playing).toBe(false)
    expect(state.machine?.status).toBe('halted')
    expect(state.machine?.output).toBe('5! = 120\n')
    // The emulator's own sentence, whatever its words are today.
    expect(state.runStop).toBe('halted')
    expect(state.runMessage).toBe(emulatorRun(FACTORIAL).message)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a new speed counts at once; moving to 10 while playing runs to the end', () => {
    const timers = manualTimers()
    const session = new StepperSession({ source: FACTORIAL, speed: 1, timers })
    session.play()
    expect(timers.delays).toEqual([1500])
    session.setSpeed(9)
    expect(timers.pending()).toBe(1)
    expect(timers.delays).toEqual([1500, 40])
    timers.fire()
    expect(machineOf(session).stepCount).toBe(2)

    session.setSpeed(10)
    expect(timers.pending()).toBe(0)
    expect(session.getState().playing).toBe(false)
    expect(machineOf(session).status).toBe('halted')
  })

  it('uses the injected timers, and dispose stops them', () => {
    const timers = manualTimers()
    const session = new StepperSession({ source: FACTORIAL, speed: 3, timers })
    session.play()
    expect(timers.pending()).toBe(1)
    expect(timers.delays).toEqual([700])
    timers.fire()
    expect(machineOf(session).stepCount).toBe(2)

    session.dispose()
    expect(timers.pending()).toBe(0)
    expect(session.getState().playing).toBe(false)
    expect(machineOf(session).stepCount).toBe(2)

    // The session still works after dispose (React StrictMode mounts twice).
    session.step()
    expect(machineOf(session).stepCount).toBe(3)
  })
})

describe('input', () => {
  it('runs the waiting scanf step as soon as the input arrives', () => {
    const session = new StepperSession({ source: READ_NUMBER })
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    expect(machineOf(session).status).toBe('waiting-input')
    const before = machineOf(session).stepCount

    session.provideInput('41')
    const machine = machineOf(session)
    expect(machine.status).toBe('running')
    expect(machine.stepCount).toBe(before + 1)
    expect(machine.lastStep?.kind).toBe('library')
    expect(session.getState().playing).toBe(false)

    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    expect(machineOf(session).output).toBe('Type a number: 41 plus 1 is 42.\n')
  })

  it('Back over the step that read the input takes the input back: Step asks again', () => {
    const session = new StepperSession({ source: READ_NUMBER })
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    const waitingAt = machineOf(session).stepCount
    session.provideInput('abc')
    expect(machineOf(session).stepCount).toBe(waitingAt + 1)

    session.back()
    expect(machineOf(session).stepCount).toBe(waitingAt)
    expect(machineOf(session).status).toBe('running')
    session.step()
    expect(machineOf(session).status).toBe('waiting-input')

    // Another answer this time.
    session.provideInput('41')
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    expect(machineOf(session).output).toBe('Type a number: 41 plus 1 is 42.\n')
  })

  it('Back over other steps keeps the input that was typed before them', () => {
    const session = new StepperSession({ source: READ_NUMBER })
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    session.provideInput('41')
    session.step()
    session.step()
    const at = machineOf(session).stepCount
    session.back()
    expect(machineOf(session).stepCount).toBe(at - 1)
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    expect(machineOf(session).output).toBe('Type a number: 41 plus 1 is 42.\n')
  })
})

describe('undo after Reset', () => {
  it('goes back to the same step, with the same input', () => {
    const session = new StepperSession({ source: READ_NUMBER })
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    session.provideInput('41')
    session.step()
    session.step()
    const before = machineOf(session)

    session.reset()
    expect(machineOf(session).stepCount).toBe(0)
    expect(session.getState().undoResetTo).toBe(before.stepCount)

    session.undoReset()
    const after = machineOf(session)
    expect(after.stepCount).toBe(before.stepCount)
    expect(after.registers).toEqual(before.registers)
    expect(after.output).toBe(before.output)
    expect(session.getState().undoResetTo).toBeNull()
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) session.step()
    expect(machineOf(session).output).toBe('Type a number: 41 plus 1 is 42.\n')
  })

  it('comes back to an end, an error and a wait for input', () => {
    for (const [text, status] of [
      [HELLO, 'halted'],
      [BAD_RET, 'error'],
      [READ_NUMBER, 'waiting-input'],
    ] as const) {
      const session = new StepperSession({ source: text })
      for (let i = 0; i < 40 && machineOf(session).status === 'running'; i++) session.step()
      expect(machineOf(session).status).toBe(status)
      const steps = machineOf(session).stepCount
      session.reset()
      session.undoReset()
      expect(machineOf(session).status).toBe(status)
      expect(machineOf(session).stepCount).toBe(steps)
    }
  })

  it('is possible only until the machine moves again', () => {
    const session = new StepperSession({ source: HELLO })
    session.step()
    session.step()
    session.reset()
    session.step()
    expect(session.getState().undoResetTo).toBeNull()
    session.undoReset()
    expect(machineOf(session).stepCount).toBe(1)
    // A Reset at the start has nothing to undo.
    session.reset()
    session.reset()
    expect(session.getState().undoResetTo).toBeNull()
  })
})

describe('breakpoints on lines without an instruction', () => {
  const LOOP = 'main:\n    mov ecx, 3\n# the loop\nagain:\n    dec ecx\n    jne again\n    ret\n'

  it('go on the next line that has an instruction, as gdb does', () => {
    const session = new StepperSession({ source: LOOP })
    session.toggleBreakpoint(4) // `again:`
    expect(session.getState().breakpoints).toEqual([5])
    session.toggleBreakpoint(3) // the comment: the same instruction, so it goes away
    expect(session.getState().breakpoints).toEqual([])
    // After the last instruction there is nothing to move to: the line stays.
    session.toggleBreakpoint(8)
    expect(session.getState().breakpoints).toEqual([8])
  })

  it('Run stops at the moved breakpoint', () => {
    const session = new StepperSession({ source: LOOP, speed: MAX_SPEED })
    session.toggleBreakpoint(4)
    session.play()
    expect(session.getState().runStop).toBe('breakpoint')
    expect(machineOf(session).nextLine).toBe(5)
  })

  it('stay where they are while the program has errors (nothing is known then)', () => {
    const session = new StepperSession({ source: 'main:\n    mov [rax], [rbx]\n    ret\n' })
    session.toggleBreakpoint(1)
    expect(session.getState().breakpoints).toEqual([1])
  })
})

describe('limits from outside', () => {
  it('a starting state cannot raise the step limit of Run at "instant" or the stack size', () => {
    expect(safeOptions({ maxSteps: 9_007_199_254_740_991, stackSize: 1e12 })).toEqual({
      maxSteps: 10_000,
      stackSize: 0x100000,
    })
    expect(safeOptions({ maxSteps: 25 })).toEqual({ maxSteps: 25 })
    expect(safeOptions({ maxSteps: Number.NaN })?.maxSteps).toBe(10_000)
    expect(safeOptions(undefined)).toBeUndefined()
  })

  it('the options are part of the state', () => {
    const options = { initialRegisters: { rax: 7n } }
    const session = new StepperSession({ source: HELLO, options })
    expect(session.getState().options).toEqual(options)
    session.load(FACTORIAL)
    expect(session.getState().options).toBeUndefined()
  })
})

describe('the tip about junk registers', () => {
  it('is new at the first library call of a run and repeated at the next ones', () => {
    // This example calls printf twice.
    const session = new StepperSession({ source: source('hello-count') })
    const libraryTips: boolean[] = []
    for (let i = 0; i < 30 && machineOf(session).status === 'running'; i++) {
      session.step()
      const step = machineOf(session).lastStep
      if (step?.kind === 'library') libraryTips.push(session.getState().repeatedTip)
    }
    expect(libraryTips).toEqual([false, true])

    // Back to the first call: new again. A Reset starts a new run.
    session.reset()
    for (let i = 0; i < 6; i++) session.step()
    expect(machineOf(session).lastStep?.kind).toBe('library')
    expect(session.getState().repeatedTip).toBe(false)
  })
})

describe('why Run stopped: the sentences of the emulator', () => {
  it('says what the emulator says, for every reason auto-play can stop', () => {
    const timers = manualTimers()
    const fire = () => {
      for (let i = 0; i < 2000 && timers.pending() > 0; i++) timers.fire()
    }

    const ended = new StepperSession({ source: HELLO, speed: 9, timers })
    ended.play()
    fire()
    expect(ended.getState().runMessage).toBe(runStopMessage('halted', { line: null, steps: 0 }))
    // Run at "instant" speed says the same.
    expect(ended.getState().runMessage).toBe(emulatorRun(HELLO).message)

    const breakpoint = new StepperSession({ source: HELLO, speed: 9, timers })
    const line = lineOf(HELLO, 'mov     eax, 0')
    breakpoint.toggleBreakpoint(line)
    breakpoint.play()
    fire()
    expect(breakpoint.getState().runMessage).toBe(runStopMessage('breakpoint', { line, steps: 0 }))

    const failed = new StepperSession({ source: BAD_RET, speed: 9, timers })
    failed.play()
    fire()
    expect(failed.getState().runMessage).toBe(runStopMessage('error', { line: 4, steps: 0 }))
    expect(failed.getState().runMessage).toBe(emulatorRun(BAD_RET).message)

    const waiting = new StepperSession({ source: READ_NUMBER, speed: 9, timers })
    waiting.play()
    fire()
    expect(waiting.getState().runMessage).toBe(
      runStopMessage('waiting-input', { line: null, steps: 0 }),
    )

    const endless = new StepperSession({ source: 'main:\n    jmp main\n', speed: 9, timers })
    endless.play()
    fire()
    expect(endless.getState().runMessage).toBe(
      runStopMessage('step-limit', { line: null, steps: AUTO_PLAY_MAX_STEPS }),
    )
  })
})

describe('moves: the count of times a control moved the machine', () => {
  it('goes up on Step, Back, Run, Reset, undo Reset and scanf input, and only then', () => {
    const session = new StepperSession({ source: READ_NUMBER, speed: MAX_SPEED })
    const moves = () => session.getState().moves
    expect(moves()).toBe(0)
    session.step()
    expect(moves()).toBe(1)
    session.back()
    expect(moves()).toBe(2)
    // Back at the start: nothing moves, nothing is counted.
    session.back()
    expect(moves()).toBe(2)
    session.step()
    session.step()
    session.reset()
    expect(moves()).toBe(5)
    session.undoReset()
    expect(moves()).toBe(6)

    // Breakpoints and edits that keep the place are not moves.
    session.toggleBreakpoint(lineOf(READ_NUMBER, 'call'))
    session.toggleBreakpoint(lineOf(READ_NUMBER, 'call'))
    session.setSource(`${READ_NUMBER}# a note\n`)
    expect(moves()).toBe(6)

    session.play()
    expect(machineOf(session).status).toBe('waiting-input')
    expect(moves()).toBe(7)
    // The input runs scanf, and Run goes on after it: two moves.
    session.provideInput('41')
    expect(moves()).toBe(9)
  })
})
