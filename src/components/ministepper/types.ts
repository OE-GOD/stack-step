/**
 * The contract of the MiniStepper: the small embedded stepper that lessons and practice
 * use to show one short program running.
 *
 * Lessons are written against this file, so it changes only through the lead.
 */
import type { EmulatorOptions, Reg64 } from '../../emulator'

export interface MiniStepperProps {
  /** The program (short). */
  source: string
  /** Starting state: registers, rsp, memory, … */
  options?: EmulatorOptions
  /** Registers to show, in this order. Default: the registers the program mentions, at most 6. */
  registers?: readonly Reg64[]
  /**
   * Which panels to show. Defaults: stack false, flags false, rip false, data only if the
   * program has data items, output only if the program calls a library function.
   */
  showStack?: boolean
  showFlags?: boolean
  showOutput?: boolean
  /** Show the Data panel (labels in `.data` / `.string` items and their current values). */
  showData?: boolean
  /** Show a compact rip row (address of the next instruction). */
  showRip?: boolean
  /** Text typed into scanf ahead of time, for examples that read input. */
  stdin?: string
  /** Shown above the code, e.g. "Try it". */
  title?: string
  /** Show a link that opens this program in the full stepper (default true). */
  openInStepper?: boolean
}
