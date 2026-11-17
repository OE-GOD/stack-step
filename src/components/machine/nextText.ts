/**
 * What runs next, worked out once from a machine snapshot. The panels and the status line
 * each say it in their own few words, from the same answer:
 *
 *   Explanation:  "Next: line 14 · `mov eax, 0`"   "Next: inside `printf` (library code)"
 *   rip row:      "line 14"                         "inside printf"
 *   status line:  "Paused at line 14"               "Paused inside printf"
 */
import type { MachineState, Program } from '../../emulator'
import { instructionText } from './machineView'

export type NextPlace =
  /** The instruction on this line runs next. */
  | { kind: 'line'; line: number }
  /** The program is inside a library function (the second half of a call). */
  | { kind: 'library'; name: string }
  /** The program ended normally. */
  | { kind: 'ended' }
  /** A run-time error stopped the program. */
  | { kind: 'error' }
  /** rip is not on an instruction of the program (it ran off the end, for example). */
  | { kind: 'nowhere' }

export function nextPlace(machine: MachineState): NextPlace {
  if (machine.status === 'halted') return { kind: 'ended' }
  if (machine.status === 'error') return { kind: 'error' }
  if (machine.inLibrary !== null) return { kind: 'library', name: machine.inLibrary.name }
  if (machine.nextLine !== null) return { kind: 'line', line: machine.nextLine }
  return { kind: 'nowhere' }
}

/** "Next: line 14 · `mov eax, 0`" or "Next: inside `printf` (library code)"; null at the end. */
export function nextSentence(machine: MachineState, program: Program | null): string | null {
  const place = nextPlace(machine)
  switch (place.kind) {
    case 'library':
      return `Next: inside \`${place.name}\` (library code)`
    case 'line': {
      const text = instructionText(program, place.line)
      return text === null ? `Next: line ${place.line}` : `Next: line ${place.line} · \`${text}\``
    }
    case 'ended':
    case 'error':
    case 'nowhere':
      return null
  }
}

/** The few words beside rip: "line 14", "inside printf", "ended". */
export function nextWords(machine: MachineState): string {
  const place = nextPlace(machine)
  switch (place.kind) {
    case 'line':
      return `line ${place.line}`
    case 'library':
      return `inside ${place.name}`
    case 'ended':
      return 'ended'
    case 'error':
      // A fault (a bad memory read, for example) leaves rip on the instruction that failed.
      return machine.nextLine === null ? 'not an instruction' : `line ${machine.nextLine}`
    case 'nowhere':
      return 'not an instruction'
  }
}
