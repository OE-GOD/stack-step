/**
 * Checking the answer to a lesson's check question. Pure functions, no React.
 *
 * Every check gives a `Verdict`:
 * - 'right':  the answer is right;
 * - 'wrong':  a real answer, but not the right one (the message names the mistake, or
 *             is the question's hint);
 * - 'retry':  not an answer yet (nothing chosen, a blank, not hex, too few digits, only the
 *             end of the value). The message says what to fix.
 * The page shows 'right' as "Correct", 'wrong' as "Not yet", and 'retry' as a neutral note.
 */
import { countHexDigits, parseHexAnswer } from '../../emulator'
import type { ChoiceQuestion, HexQuestion, TextQuestion } from './types'

export type Verdict =
  | { result: 'right'; message: string }
  | { result: 'wrong'; message: string }
  | { result: 'retry'; message: string }

const TYPE_FIRST = 'Type your answer first.'

/* ──────────────────────────────── choice ──────────────────────────────── */

/** `optionId` is the id of the chosen option, or null when none is chosen. */
export function checkChoice(question: ChoiceQuestion, optionId: string | null): Verdict {
  const option = question.options.find((candidate) => candidate.id === optionId)
  if (option === undefined) return { result: 'retry', message: 'Pick one of the answers first.' }
  return { result: option.correct === true ? 'right' : 'wrong', message: option.feedback }
}

/* ────────────────────────────────── hex ───────────────────────────────── */

/** The numbers a hex question is checked against, computed once. */
export interface HexKey {
  answer: bigint
  wrongAnswers: readonly { value: bigint; feedback: string }[]
}

export type HexKeyResult = { ok: true; key: HexKey } | { ok: false; error: unknown }

/**
 * Run the question's `answer()` once (it runs a program in the emulator) and work out the
 * known wrong values. A throwing `answer()` gives `ok: false`: the page then says that the
 * question has a problem. A known wrong value that throws, or that equals the right
 * answer, is left out (the content tests report both).
 */
export function makeHexKey(question: HexQuestion): HexKeyResult {
  let answer: bigint
  try {
    answer = question.answer()
  } catch (error) {
    return { ok: false, error }
  }
  if (typeof answer !== 'bigint') {
    return { ok: false, error: new Error('answer() did not return a bigint.') }
  }
  const wrongAnswers: { value: bigint; feedback: string }[] = []
  for (const wrong of question.wrongAnswers ?? []) {
    try {
      const value = wrong.value()
      if (typeof value === 'bigint' && value !== answer) {
        wrongAnswers.push({ value, feedback: wrong.feedback })
      }
    } catch {
      // Left out: the question still works without this one.
    }
  }
  return { ok: true, key: { answer, wrongAnswers } }
}

export function checkHex(question: HexQuestion, key: HexKey, typed: string): Verdict {
  if (typed.trim() === '') return { result: 'retry', message: TYPE_FIRST }
  const value = parseHexAnswer(typed)
  const count = countHexDigits(typed)
  if (value === null || count === null) {
    return {
      result: 'retry',
      message: 'That is not a hex number. Use the digits 0 to 9 and the letters a to f.',
    }
  }
  const { digits } = question
  if (digits !== undefined && count < digits) {
    return {
      result: 'retry',
      message: `Type all ${digits} hex digits, also the zeros at the start. You typed ${count}.`,
    }
  }
  if (digits !== undefined && count > digits) {
    return {
      result: 'retry',
      message: `Type exactly ${digits} hex digits. You typed ${count}.`,
    }
  }
  if (value === key.answer) return { result: 'right', message: question.rightFeedback }
  const known = key.wrongAnswers.find((wrong) => wrong.value === value)
  if (known !== undefined) return { result: 'wrong', message: known.feedback }
  if (digits === undefined && isEndOf(key.answer, value, count)) {
    return {
      result: 'retry',
      message: `Type the whole value, not only its last digits. You typed ${count}.`,
    }
  }
  return { result: 'wrong', message: question.hint }
}

/**
 * True when the typed digits are only the last digits of the answer, such as `d798` for
 * `0x7ffffffdd798`: the student has the right idea but did not type the whole value.
 */
function isEndOf(answer: bigint, typed: bigint, typedDigitCount: number): boolean {
  const answerDigits = answer.toString(16)
  const typedDigits = typed.toString(16).padStart(typedDigitCount, '0')
  return typedDigits.length < answerDigits.length && answerDigits.endsWith(typedDigits)
}

/* ───────────────────────────────── text ───────────────────────────────── */

/**
 * How a typed word is compared: letter case, spaces and a period at the end do not count,
 * so "R10W", "r10 w" and "r10w." are all "r10w".
 */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/\.+$/, '')
}

export function checkText(question: TextQuestion, typed: string): Verdict {
  const answer = normalizeText(typed)
  if (answer === '') return { result: 'retry', message: TYPE_FIRST }
  if (question.answers.some((right) => normalizeText(right) === answer)) {
    return { result: 'right', message: question.rightFeedback }
  }
  const known = question.wrongAnswers?.find((wrong) => normalizeText(wrong.value) === answer)
  return { result: 'wrong', message: known?.feedback ?? question.hint }
}
