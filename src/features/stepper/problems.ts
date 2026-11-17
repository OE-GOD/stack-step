import type { AssembleCode, Program } from '../../emulator'

/**
 * Warnings about whole programs (no `.intel_syntax noprefix` line, no `main:` label). They
 * are noise for a piece of a program: a lesson snippet, or a practice problem, whose code
 * is shown exactly as the problem wrote it. Pass them to the problems list as
 * `hideWarnings` there.
 */
export const WHOLE_PROGRAM_WARNINGS: readonly AssembleCode[] = ['no-main', 'missing-intel-syntax']

/**
 * The breakpoints the program can never stop at, as quiet notes for the problems list: a
 * breakpoint stops the program before the instruction of its line, so a line without one
 * (a comment, a blank line, a label with no instruction after it) is never reached.
 * (A click on such a line puts the breakpoint on the next instruction when there is one;
 * an edit can leave one behind, on a line that lost its instruction.)
 */
export function unreachedBreakpoints(
  program: Program | null,
  breakpoints: readonly number[],
): { line: number; message: string }[] {
  if (program === null) return []
  return breakpoints
    .filter((line) => !program.lineToIndex.has(line))
    .map((line) => ({
      line,
      message: `Line ${line}: this line has no instruction, so the program never stops at its breakpoint.`,
    }))
}
