/**
 * The contract for practice problems.
 *
 * A generator turns a seed into a `Problem`. It builds a tiny program, RUNS IT IN THE
 * EMULATOR to get the answer key, and predicts the wrong answers that common mistakes
 * would produce. Problems are plain data plus one function (`diagnose`), so they can be
 * unit-tested without React.
 */
import type { TopicId } from '../../content/topics'
import type { EmulatorOptions } from '../../emulator'

/**
 * The most characters an answer field takes. A whole register written with a gap between
 * every digit ("0x 0 0 0 0 …") still fits; a longer text is never a real answer. The
 * answer fields stop typing there, and a quiz kept in the tab cuts a longer text to it.
 */
export const MAX_ANSWER_LENGTH = 64

/** The mistakes the site can recognise and name. */
export type MistakeCode =
  | 'unanswered' // a part of the question was left blank
  | 'missing-digits' // fewer hex digits than the question asked for
  | 'forgot-zero-upper' // 32-bit write: kept the old top half
  | 'cleared-upper-wrongly' // 8/16-bit write: cleared bits that should stay
  | 'wrong-byte' // mixed up ah-style (bits 15–8) and al-style (bits 7–0)
  | 'decimal-arithmetic' // did hex arithmetic in decimal (0x200 − 8 = 0x192)
  | 'decimal-immediate' // read the 16 in `sub rsp, 16` as 0x16
  | 'rsp-wrong-direction' // push went up / pop went down
  | 'rsp-wrong-amount' // moved rsp by something other than 8
  | 'call-ret-forgot-stack' // forgot that call pushes or that ret pops
  | 'return-address-in-rip' // swapped "what goes on the stack" and "what goes in rip"
  | 'return-address-is-call' // used the address of the call itself, not the next one
  | 'rip-is-current' // gave the instruction's own address for rip
  | 'address-vs-contents' // gave the address when the contents were asked (or the reverse)
  | 'wrong-offset-direction' // used rbp+8 for -8[rbp]
  | 'stale-value' // used an old register value instead of the newest
  | 'wrong-register-family' // r9x, e9, …: not how that family is named
  | 'wrong-part' // right register, wrong size
  | 'bits-vs-bytes'
  | 'wrong-legality' // called a legal mov illegal, or the reverse
  | 'wrong-reason' // illegal, but for a different reason

export interface Mistake {
  code: MistakeCode
  /** One or two plain sentences that name the mistake and say the rule. */
  message: string
}

export type FieldKind =
  /** A number typed in hex. `digits` = the exact number of hex digits required (16 for a full register). */
  | { type: 'hex'; digits?: number }
  /** A short word such as a register name. Compared case-insensitively. */
  | { type: 'text' }
  /** A number typed in decimal. */
  | { type: 'decimal' }
  /** Pick one. */
  | { type: 'choice'; choices: readonly { id: string; label: string }[] }
  /** Filled by dragging (or tapping) a chip in the trace table. The value is the chip id. */
  | { type: 'chip' }

export interface Field {
  id: string
  /** Shown next to the input, e.g. "rsp after step 3". */
  label: string
  kind: FieldKind
  /**
   * The right answer in canonical form:
   * hex → lower-case hex digits, no prefix, no leading zeros ("1f8"; zero is "0");
   * text → lower-case, trimmed; decimal → digits (with "-" if negative);
   * choice / chip → the id.
   */
  expected: string
  /** The right answer as shown to the student: "0x1f8", "r9w", "Illegal: memory to memory". */
  expectedDisplay: string
}

/** A piece of the question. Text may contain `code` in backticks. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | {
      type: 'code'
      lines: readonly string[]
      /** Address shown in front of each line ("0x4000"), when the question needs them. */
      addresses?: readonly string[]
    }
  | { type: 'registers'; title?: string; rows: readonly { name: string; value: string }[] }
  | {
      type: 'stack'
      title?: string
      /** Highest address first. `marker` is "rsp", "rbp" or "rsp, rbp". */
      rows: readonly { address: string; value: string; marker?: string }[]
    }
  /** Executed instructions in order, each with its own answer field beside it. */
  | { type: 'trace'; rows: readonly { step: number; text: string; fieldId: string }[] }

/** An answer chip for the trace table. */
export interface Chip {
  id: string
  /** e.g. "rax = 0x0000000000000005" */
  label: string
}

export interface Problem {
  /** `${topic}-${seed}` */
  id: string
  topic: TopicId
  seed: number
  /** 'form' = prompt + input fields; 'trace-table' = the homework-style table with chips. */
  view: 'form' | 'trace-table'
  prompt: readonly PromptBlock[]
  fields: readonly Field[]
  /** Only for 'trace-table': the right chips and the tempting wrong ones, already shuffled. */
  chips?: readonly Chip[]
  /** Why the right answer is right, in one line. Shown after every check. */
  reason: string
  /** The exact problem as a program for the stepper ("Show me"). Same shape as StepperPayload. */
  stepper: { code: string; options?: EmulatorOptions; note?: string }
  /**
   * Look at the student's answers (canonical form, '' for blank; one entry per field id)
   * and name a known mistake, or return null. Only called when the answer is wrong.
   */
  diagnose(answers: Readonly<Record<string, string>>): Mistake | null
}

/** Builds one problem. The same seed always gives the same problem. */
export type ProblemGenerator = (seed: number) => Problem

export interface FieldResult {
  fieldId: string
  correct: boolean
  /** What the student typed, tidied for display ('' when blank). */
  given: string
  expectedDisplay: string
}

export interface CheckResult {
  correct: boolean
  fields: readonly FieldResult[]
  mistake: Mistake | null
  reason: string
}

/** Props of a component that shows one problem and collects the answers. */
export interface ProblemViewProps {
  problem: Problem
  /** Current answers: field id → raw text ('' when empty). */
  answers: Readonly<Record<string, string>>
  onChange: (fieldId: string, value: string) => void
  /** True after Check: inputs are locked. */
  locked: boolean
  /** The result after Check, else null (used to mark each field right or wrong). */
  result: CheckResult | null
}
