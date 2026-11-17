/**
 * The fixed sentences of the machine panels, in one place. (The explanations of the steps
 * come from the emulator.)
 */
import type { FlagName } from '../../emulator'

export const BEFORE_FIRST_STEP = 'Press Step to run the first instruction.'
export const PROGRAM_ENDED = 'The program ended.'
export const FIX_THE_CODE = 'Fix the problem in the code to run it.'
/** FIX_THE_CODE when the code has more than one problem. */
export const FIX_THE_PROBLEMS = 'Fix the problems in the code to run it.'

/** The sentence for a program that cannot run: one problem or several. */
export function fixTheCode(errorCount: number): string {
  return errorCount > 1 ? FIX_THE_PROBLEMS : FIX_THE_CODE
}

export const NOTHING_PRINTED = 'Nothing printed yet.'
export const STACK_CAPTION = 'High addresses at the top. The stack grows down.'
export const RESTARTED_BY_EDIT = 'You changed the code, so the program started again from the top.'

/** After an edit of a comment or of spaces: the program does the same, so the place stays. */
export function keptPlaceSentence(steps: number): string {
  return `Your change did not change the program, so you are still at step ${steps}.`
}

/** Under a run-time error: what the student can do now. */
export const AFTER_ERROR =
  'Press Back to go one step back. Or change the code: then the program starts again.'

/** In place of a part of the page that crashed (a mistake in the site, not the student's). */
export const CANNOT_SHOW_PART =
  'This part could not be shown. Your code is safe. Press Step or change the code to try again.'
/** The same for a MiniStepper in a lesson, which has no editor and maybe no Step button. */
export const CANNOT_SHOW_EXAMPLE = 'This example could not be shown. The rest of the page works.'

/**
 * What each flag means, in plain words. CF and OF name the instructions they are about:
 * other instructions write them too (`and`, `or`, `xor` and `test` set both to 0; `imul`
 * sets both to 1 when the signed result does not fit; `inc` and `dec` leave CF alone).
 */
export const FLAG_EXPLANATIONS: Readonly<Record<FlagName, string>> = {
  CF: 'Carry flag. After add, sub or cmp: 1 when the result did not fit as an unsigned number.',
  ZF: 'Zero flag. 1 when the last result was 0.',
  SF: 'Sign flag. 1 when the last result was negative (its top bit is 1).',
  OF: 'Overflow flag. After add, sub, cmp, inc or dec: 1 when the result did not fit as a signed number.',
}

/** The short caption under each flag light. */
export const FLAG_CAPTIONS: Readonly<Record<FlagName, string>> = {
  CF: 'carry',
  ZF: 'zero',
  SF: 'sign',
  OF: 'overflow',
}
