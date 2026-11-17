/**
 * Review of milestone 3: tests that show bugs in the session store (and in what it is
 * given). Each test here FAILS on the code as reviewed; the review report says why and
 * how to fix it. Delete a test only together with the fix that makes it pass.
 */
import { describe, expect, it } from 'vitest'
import { exampleById } from '../../examples'
import { decodePayload, encodePayload } from '../../lib/share'
import { StepperSession, type SessionTimers } from './session'

function source(id: string): string {
  const example = exampleById(id)
  if (example === undefined) throw new Error(`No example ${id}`)
  return example.source
}

const READ_NUMBER = source('read-number')

/** The 1-based line of the first line of `text` that contains `needle`. */
function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle))
  if (index < 0) throw new Error(`"${needle}" is not in the program`)
  return index + 1
}

/** Timers the test fires by hand. */
function manualTimers(): SessionTimers & {
  pending: () => number
  fireAll: (limit?: number) => void
} {
  let queue: { id: number; callback: () => void }[] = []
  let nextId = 1
  return {
    setTimeout(callback) {
      const id = nextId++
      queue.push({ id, callback })
      return id
    },
    clearTimeout(handle) {
      queue = queue.filter((entry) => entry.id !== handle)
    },
    pending: () => queue.length,
    fireAll(limit = 1000) {
      for (let i = 0; i < limit && queue.length > 0; i++) queue.shift()?.callback()
    },
  }
}

describe('auto-play that goes on after scanf input', () => {
  // The line right after `call scanf@PLT`: the first line that runs once the input is read.
  const afterScanf = lineOf(READ_NUMBER, 'mov     esi, number[rbp]')

  for (const speed of [9, 10]) {
    it(`stops at a breakpoint on the line right after the scanf call (speed ${speed})`, () => {
      const timers = manualTimers()
      const session = new StepperSession({ source: READ_NUMBER, speed, timers })
      session.toggleBreakpoint(afterScanf)
      session.play()
      timers.fireAll()
      expect(session.getState().machine?.status).toBe('waiting-input')

      // The input makes scanf return; Run goes on because it was Run that stopped for it.
      session.provideInput('41')
      timers.fireAll()

      // Expected: stopped at the breakpoint, before line `afterScanf` runs, as Run does at
      // every other breakpoint. Today the resumed run executes that line first (play()
      // steps before it checks), so it runs on to the end and prints the answer.
      const state = session.getState()
      expect(state.machine?.nextLine).toBe(afterScanf)
      expect(state.runStop).toBe('breakpoint')
      expect(state.machine?.output).toBe('Type a number: ')
    })
  }
})

describe('starting state from a share link', () => {
  it('cannot make Run at "instant" run more than the usual 10 000 steps', () => {
    // A crafted link: an endless loop and `maxSteps` far above the guard. decodePayload
    // accepts any safe integer (up to 9 007 199 254 740 991), and Run at "instant" then
    // blocks the page until that many steps have run (measured: 2 000 000 steps = 2 s in
    // the production build, so the largest value never ends). 300 000 keeps this test short.
    const link = encodePayload({
      code: '    .intel_syntax noprefix\nmain:\n    jmp main\n',
      options: { maxSteps: 300_000 },
    })
    const options = decodePayload(link)?.options
    const session = new StepperSession({
      source: '    .intel_syntax noprefix\nmain:\n    jmp main\n',
      options,
      speed: 10,
    })
    session.play()
    expect(session.getState().runStop).toBe('step-limit')
    expect(session.getState().machine?.stepCount).toBeLessThanOrEqual(10_000)
  })
})

describe('re-entrancy', () => {
  it('a listener that pauses auto-play leaves no timer behind', () => {
    const timers = manualTimers()
    const session = new StepperSession({ source: source('factorial'), speed: 5, timers })
    session.play()
    // A listener (another view of the session, a test, the tutor) pauses on the next step.
    let paused = false
    session.subscribe(() => {
      if (!paused && session.getState().playing) {
        paused = true
        session.pause()
      }
    })
    timers.fireAll(1)
    expect(session.getState().playing).toBe(false)
    // `advance` schedules the next step after `sync()` returns, without looking at
    // `playing` again, so one timer stays queued although auto-play is off.
    expect(timers.pending()).toBe(0)
  })
})
