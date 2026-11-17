/**
 * A short text picture of the machine, for the optional AI tutor (the `machine` field of
 * the tutor context). The stepper page and the practice pages use the same function.
 *
 *   summarizeMachine(state.machine, { diagnostics, program })
 *
 * It lists the status, the registers that are not 0, rip, the flags, the top four stack
 * boxes, the last step's explanation (with its notes and any error), and what was
 * printed. Numbers are in hex with `0x`, as everywhere on the site.
 */
import {
  FLAG_NAMES,
  hex,
  hex64,
  REG64_DISPLAY_ORDER,
  type Diagnostic,
  type MachineState,
  type Program,
} from '../../emulator'

export interface SummaryExtras {
  /** Problems from the assembler: listed when the program cannot run. */
  diagnostics?: readonly Diagnostic[]
  /** For the text of the instruction that runs next. */
  program?: Program | null
}

/** How many stack boxes the summary lists, from the top of the stack down. */
const STACK_BOXES = 4
/** Printed text longer than this is cut (the end is kept: it is the newest). */
const MAX_OUTPUT = 600

function statusLine(machine: MachineState): string {
  const steps = machine.stepCount === 1 ? '1 step' : `${machine.stepCount} steps`
  switch (machine.status) {
    case 'halted':
      return `Status: the program ended after ${steps}.`
    case 'error':
      return `Status: the program stopped with an error after ${steps}.`
    case 'waiting-input':
      return `Status: scanf is waiting for input (after ${steps}).`
    case 'running':
      if (machine.stepCount === 0) return 'Status: ready, no step has run yet.'
      if (machine.inLibrary !== null) {
        return `Status: paused inside ${machine.inLibrary.name} (library code), after ${steps}.`
      }
      return `Status: paused at line ${machine.nextLine ?? '?'}, after ${steps}.`
  }
}

function nextLine(machine: MachineState, program: Program | null): string | null {
  if (machine.status === 'halted' || machine.status === 'error') return null
  if (machine.inLibrary !== null) {
    return `Next: the library code of ${machine.inLibrary.name} (called on line ${machine.inLibrary.callLine}).`
  }
  if (machine.nextLine === null) return null
  const index = program?.lineToIndex.get(machine.nextLine)
  const text = index === undefined ? undefined : program?.instructions[index]?.text
  return text === undefined
    ? `Next: line ${machine.nextLine}.`
    : `Next: line ${machine.nextLine}, \`${text}\`.`
}

function registersLine(machine: MachineState): string {
  const shown = REG64_DISPLAY_ORDER.filter((name) => machine.registers[name] !== 0n).map(
    (name) => `${name} = ${hex64(machine.registers[name])}`,
  )
  return shown.length === 0
    ? 'Registers: all 0.'
    : `Registers that are not 0: ${shown.join(', ')}. All others are 0.`
}

function flagsLine(machine: MachineState): string {
  return `Flags: ${FLAG_NAMES.map((name) => `${name}=${machine.flags[name]}`).join(', ')}.`
}

function stackLines(machine: MachineState): string[] {
  const top = machine.stack.findIndex((slot) => slot.isRsp)
  if (top === -1) return [`Stack: rsp (${hex(machine.registers.rsp)}) is outside the stack.`]
  // The top of the stack is where rsp points; the boxes above it hold older values.
  const boxes = machine.stack.slice(Math.max(0, top - STACK_BOXES + 1), top + 1).reverse()
  const lines = boxes.map((slot) => {
    const value = slot.value === null ? 'not set yet' : hex64(slot.value)
    const pointers = [slot.isRsp ? 'rsp' : null, slot.isRbp ? 'rbp' : null].filter(Boolean)
    const label = slot.label === null ? '' : ` (${slot.label})`
    const marks = pointers.length > 0 ? ` <- ${pointers.join(' and ')}` : ''
    return `- ${hex(slot.address)}: ${value}${label}${marks}`
  })
  return [`Top of the stack (the first box is where rsp points):`, ...lines]
}

function outputLine(machine: MachineState): string {
  if (machine.output === '') return 'Printed so far: nothing.'
  const output =
    machine.output.length > MAX_OUTPUT ? `…${machine.output.slice(-MAX_OUTPUT)}` : machine.output
  return `Printed so far: ${JSON.stringify(output)}`
}

/** The summary as plain text, one fact per line. */
export function summarizeMachine(machine: MachineState | null, extras: SummaryExtras = {}): string {
  if (machine === null) {
    const errors = (extras.diagnostics ?? []).filter((item) => item.severity === 'error')
    return [
      'Status: the program has errors, so it cannot run yet.',
      ...errors.map((item) => `- ${item.message}`),
    ].join('\n')
  }

  const lines = [statusLine(machine)]
  const next = nextLine(machine, extras.program ?? null)
  if (next !== null) lines.push(next)
  lines.push(registersLine(machine))
  lines.push(`rip = ${hex(machine.rip)}`)
  lines.push(flagsLine(machine))
  lines.push(...stackLines(machine))

  const step = machine.lastStep
  if (step !== null) {
    lines.push(`Last step (step ${step.stepNumber}, line ${step.line}): ${step.explanation}`)
    for (const note of step.notes) {
      lines.push(`${note.kind === 'tip' ? 'Tip' : 'Warning'}: ${note.text}`)
    }
  }
  if (machine.error !== null) lines.push(`Error: ${machine.error.message}`)
  if (machine.inputRequest !== null) lines.push(`Input wanted: ${machine.inputRequest.prompt}`)
  lines.push(outputLine(machine))
  return lines.join('\n')
}
