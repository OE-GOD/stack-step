/**
 * The contract of a lesson.
 *
 * A lesson is one file `content/NN-<lessonId>.tsx` whose default export is a
 * `LessonContent` object. It holds content only: text, one short program, one question.
 * The lesson page decides how everything looks.
 *
 * Short pieces of text are plain strings. In a string, wrap code in backticks
 * ("`mov` copies a value."): the page shows those parts in a code font.
 * Only `body` is JSX, so it can hold a small table or a list.
 */
import type { ReactNode } from 'react'
import type { MiniStepperProps } from '../../components/ministepper/types'
import type { LessonId } from '../../content/lessonList'
import type { TopicId } from '../../content/topics'

export interface LessonContent {
  /** Must equal the id in the file name and in `src/content/lessonList.ts`. */
  id: LessonId
  /** The one idea of the lesson, in one sentence. */
  idea: string
  /** One everyday analogy: a short title ("A row of lockers") and 2–4 short sentences. */
  analogy: { title: string; text: string }
  /** The explanation. Under about 250 words. Use the prose helpers in `components/`. */
  body: ReactNode
  /** The tiny live example. */
  example: LessonExample
  /** Exactly one question about the one idea. */
  check: CheckQuestion
  /** 2–4 short lines to remember. */
  recap: readonly string[]
  /** The practice topic that goes with this lesson, when there is one. */
  practiceTopic?: TopicId
}

export interface LessonExample {
  /** What to do: "Press Step four times and watch rsp." */
  intro: string
  /** The program and which panels of the MiniStepper to show. */
  stepper: MiniStepperProps
  /** 2–4 concrete things to notice, with the real values from running the program. */
  watchFor: readonly string[]
}

export type CheckQuestion = ChoiceQuestion | HexQuestion | TextQuestion

/** Pick one of 3 or 4 options. */
export interface ChoiceQuestion {
  kind: 'choice'
  /** The question. */
  prompt: string
  /** Optional code shown under the question, one string per line. */
  code?: readonly string[]
  /** 3 or 4 options; exactly one has `correct: true`. */
  options: readonly ChoiceOption[]
}

export interface ChoiceOption {
  /** Short and unique inside the question: 'a', 'b', … or a word. */
  id: string
  label: string
  correct?: boolean
  /**
   * Shown when the student picks this option. For a wrong option: name the mistake and
   * give the rule. For the right one: confirm it and say why in one sentence.
   */
  feedback: string
}

/** Type a number in hex. */
export interface HexQuestion {
  kind: 'hex'
  prompt: string
  code?: readonly string[]
  /** Label of the input box: "rax = " or "rsp after line 3". */
  label: string
  /** Exact number of hex digits wanted (16 for a whole register). Leave out for "any". */
  digits?: number
  /**
   * The right answer, COMPUTED by running a program in the emulator. Never a literal.
   * Called once when the lesson is shown, and by the content tests.
   */
  answer: () => bigint
  /** Predictable wrong answers, each with feedback that names the mistake. */
  wrongAnswers?: readonly { value: () => bigint; feedback: string }[]
  /** Shown for the right answer: confirm it and say why in one sentence. */
  rightFeedback: string
  /** Shown for any other wrong answer: a nudge, not the answer. */
  hint: string
}

/** Type a short word, such as a register name. Compared without regard to case. */
export interface TextQuestion {
  kind: 'text'
  prompt: string
  code?: readonly string[]
  label: string
  /** Every spelling that counts as right (lower case). At least one. */
  answers: readonly string[]
  wrongAnswers?: readonly { value: string; feedback: string }[]
  rightFeedback: string
  hint: string
}
