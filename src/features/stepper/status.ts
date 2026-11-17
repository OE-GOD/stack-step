/**
 * The one status word of the stepper (Ready · Running · Paused at line N · Waiting for
 * input · Ended · Error) and the step count, from the session state.
 */
import { nextPlace } from '../../components/machine/nextText'
import { groupDigits } from '../../emulator'
import type { SessionState } from './session'

export type StatusKind =
  | 'ready'
  | 'running'
  | 'paused'
  | 'waiting'
  | 'ended'
  | 'error'
  /** The code has problems, so there is no machine. */
  | 'problems'

export interface StatusInfo {
  kind: StatusKind
  /** "Paused at line 14 (breakpoint)". */
  text: string
}

export function statusOf(state: SessionState): StatusInfo {
  const { machine } = state
  if (machine === null) return { kind: 'problems', text: 'Error' }
  if (state.playing) return { kind: 'running', text: 'Running' }
  switch (machine.status) {
    case 'waiting-input':
      return { kind: 'waiting', text: 'Waiting for input' }
    case 'halted':
      return { kind: 'ended', text: 'Ended' }
    case 'error':
      return { kind: 'error', text: 'Error' }
    case 'running':
      break
  }
  if (machine.stepCount === 0) return { kind: 'ready', text: 'Ready' }
  // The endless-loop guard stopped Run: the program did not pause by itself.
  const word = state.runStop === 'step-limit' ? 'Stopped' : 'Paused'
  const place = nextPlace(machine)
  switch (place.kind) {
    case 'library':
      return { kind: 'paused', text: `${word} inside ${place.name}` }
    case 'line': {
      const breakpoint = state.breakpoints.includes(place.line) ? ' (breakpoint)' : ''
      return { kind: 'paused', text: `${word} at line ${place.line}${breakpoint}` }
    }
    case 'ended':
    case 'error':
    case 'nowhere':
      return { kind: 'paused', text: word }
  }
}

/** "1 step", "12 steps", "10,000 steps". */
export function stepsText(count: number): string {
  return count === 1 ? '1 step' : `${groupDigits(count)} steps`
}
