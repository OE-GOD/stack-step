/**
 * The public face of the emulator. Import from here, not from the single files:
 *
 *   import { assemble, type Program } from '../emulator'
 */
export * from './types'
export * from './bits'
export * from './registers'
export * from './format'
export {
  conditionHolds,
  describeCondition,
  isJumpCondition,
  JUMP_CONDITIONS,
  type JumpCondition,
} from './alu'
export { assemble } from './assembler'
/** The sentence for why a run stopped ("The program stopped at the breakpoint on line 7."). */
export { runMessage as runStopMessage } from './explain'
export { createEmulator, Emulator, type CreateEmulatorResult } from './emulator'
