/**
 * What a page tells the tutor. The type lives in this plain file so that code without
 * React (and the tests of the tutor function) can use it; pages import it from
 * TutorMount.tsx, which passes it on.
 */

/** What the page tells the tutor about the thing the student is looking at. */
export interface TutorContext {
  page: 'stepper' | 'practice'
  /** The program in the editor, or the code of the practice problem. */
  code: string
  /** Short text summary of the machine (registers, flags, top of stack, last explanation). */
  machine: string
  /** The practice problem as text, when on a practice page. */
  problem: string | null
}
