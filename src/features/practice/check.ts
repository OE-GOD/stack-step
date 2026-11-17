/**
 * Checking a practice answer.
 *
 * One function for every problem type: turn what the student typed into canonical
 * form, compare it with the answer key (which came from the emulator), and if it is
 * wrong, name the mistake when we can.
 */
import { countHexDigits, parseHexAnswer } from '../../emulator'
import type { CheckResult, Field, FieldResult, Mistake, Problem } from './types'

type SizeUnit = 'bits' | 'bytes'

/**
 * A decimal answer, maybe with a unit word after it, as students often type it:
 * "4", "4 bytes", "4bytes", "32 bits", "1 byte". null when it is not such a number.
 */
function readDecimal(text: string): { value: string; unit: SizeUnit | null } | null {
  const match = /^([+-]?[\d\s_,]*\d)\s*(bits?|bytes?)?$/i.exec(text)
  if (match === null) return null
  const digits = (match[1] ?? '').replace(/[\s_,]/g, '')
  if (!/^[+-]?\d+$/.test(digits)) return null
  const word = match[2]?.toLowerCase()
  const unit = word === undefined ? null : word.startsWith('byte') ? 'bytes' : 'bits'
  return { value: BigInt(digits).toString(), unit }
}

/** The unit a field asks for, read from its label ("Size in bytes" → 'bytes'), or null. */
function unitAskedFor(field: Field): SizeUnit | null {
  if (/\bbytes?\b/i.test(field.label)) return 'bytes'
  if (/\bbits?\b/i.test(field.label)) return 'bits'
  return null
}

/**
 * For a decimal field that asks for bits or bytes: what the student typed when they wrote
 * the OTHER unit ("32 bits" for "Size in bytes"). null otherwise.
 */
function otherUnitTyped(
  field: Field,
  raw: string,
): { value: string; unit: SizeUnit; asked: SizeUnit } | null {
  if (field.kind.type !== 'decimal') return null
  const read = readDecimal(raw.trim())
  const asked = unitAskedFor(field)
  if (read === null || read.unit === null || asked === null || read.unit === asked) return null
  return { value: read.value, unit: read.unit, asked }
}

/**
 * The canonical form of what the student typed for one field.
 *
 * - '' when the field is blank
 * - hex: lower-case digits without prefix or leading zeros ("1f8"; zero is "0")
 * - decimal: digits without leading zeros, "-" kept ("-8"). A unit word after the number
 *   is fine ("4 bytes" → "4"), unless it is the other unit than the one the field's label
 *   asks for: "4 bits" for "Size in bytes" stays "4 bits", so it is never right.
 * - text: lower-case, trimmed, inner spaces removed ("r9w")
 * - choice / chip: the id as given
 *
 * Text that cannot be read as the wanted kind (letters in a hex field) comes back
 * lower-cased and trimmed, so it never equals a right answer but can still be shown.
 */
export function canonicalAnswer(field: Field, raw: string): string {
  const text = raw.trim()
  if (text === '') return ''

  switch (field.kind.type) {
    case 'hex': {
      const value = parseHexAnswer(text)
      return value === null ? text.toLowerCase() : value.toString(16)
    }
    case 'decimal': {
      const read = readDecimal(text)
      if (read === null) return text.toLowerCase()
      const other = otherUnitTyped(field, text)
      return other === null ? read.value : `${other.value} ${other.unit}`
    }
    case 'text':
      return text.toLowerCase().replace(/\s+/g, '')
    case 'choice':
    case 'chip':
      return text
  }
}

/** How a student's answer is shown back to them. */
function displayGiven(field: Field, raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  if (field.kind.type === 'choice') {
    return field.kind.choices.find((choice) => choice.id === text)?.label ?? text
  }
  return text
}

/**
 * For a hex field that asks for an exact number of digits: how many the student typed,
 * when that number is wrong. null when the field has no such rule, is blank, is not
 * hex at all, or has the right number of digits.
 */
function wrongDigitCount(field: Field, raw: string): number | null {
  if (field.kind.type !== 'hex' || field.kind.digits === undefined) return null
  if (raw.trim() === '') return null
  const typed = countHexDigits(raw)
  if (typed === null || typed === field.kind.digits) return null
  return typed
}

function isFieldCorrect(field: Field, raw: string): boolean {
  if (canonicalAnswer(field, raw) !== field.expected) return false
  return wrongDigitCount(field, raw) === null
}

/**
 * Check every field of a problem.
 *
 * `rawAnswers` maps field id → the text the student typed (missing = blank).
 * The answer is correct only when every field is correct.
 */
export function checkProblem(
  problem: Problem,
  rawAnswers: Readonly<Record<string, string>>,
): CheckResult {
  const canonical: Record<string, string> = {}
  const fields: FieldResult[] = problem.fields.map((field) => {
    const raw = rawAnswers[field.id] ?? ''
    canonical[field.id] = canonicalAnswer(field, raw)
    return {
      fieldId: field.id,
      correct: isFieldCorrect(field, raw),
      given: displayGiven(field, raw),
      expectedDisplay: field.expectedDisplay,
    }
  })

  const correct = fields.every((result) => result.correct)
  return {
    correct,
    fields,
    mistake: correct ? null : findMistake(problem, rawAnswers, canonical),
    reason: problem.reason,
  }
}

function findMistake(
  problem: Problem,
  rawAnswers: Readonly<Record<string, string>>,
  canonical: Readonly<Record<string, string>>,
): Mistake | null {
  // 1. A part of the question was left blank.
  const blank = problem.fields.filter((field) => canonical[field.id] === '')
  if (blank.length === problem.fields.length) {
    return {
      code: 'unanswered',
      message:
        problem.fields.length !== 1
          ? 'You did not answer any part of the question yet.'
          : problem.fields[0]?.kind.type === 'choice'
            ? 'You did not choose an answer yet.'
            : 'You did not type an answer yet.',
    }
  }
  if (blank.length > 0) {
    const labels = blank.map((field) => `"${field.label}"`).join(', ')
    return {
      code: 'unanswered',
      message:
        blank.length === 1
          ? `You left one part blank: ${labels}. Every part needs an answer.`
          : `You left ${blank.length} parts blank: ${labels}. Every part needs an answer.`,
    }
  }

  // 2. Right idea, but not all the digits the question asked for (or too many).
  for (const field of problem.fields) {
    const typed = wrongDigitCount(field, rawAnswers[field.id] ?? '')
    if (typed !== null && field.kind.type === 'hex' && field.kind.digits !== undefined) {
      const wanted = field.kind.digits
      return {
        code: 'missing-digits',
        message:
          typed < wanted
            ? `Type all ${wanted} hex digits for "${field.label}". You typed ${typed}.`
            : `Type exactly ${wanted} hex digits for "${field.label}". You typed ${typed}.`,
      }
    }
  }

  // 3. A size in the other unit: "32 bits" when the question asks for bytes.
  for (const field of problem.fields) {
    const other = otherUnitTyped(field, rawAnswers[field.id] ?? '')
    if (other !== null) return unitMistake(field, other)
  }

  // 4. A mistake this problem knows how to recognise.
  try {
    return problem.diagnose(canonical)
  } catch {
    // A bug in a generator's diagnose() must never break checking.
    return null
  }
}

/** "1 byte", "4 bytes", "32 bits". */
function amount(value: bigint, unit: SizeUnit): string {
  return `${value} ${value === 1n ? unit.slice(0, -1) : unit}`
}

/** The message for a size typed in the other unit, with the conversion when it is exact. */
function unitMistake(
  field: Field,
  typed: { value: string; unit: SizeUnit; asked: SizeUnit },
): Mistake {
  const value = BigInt(typed.value)
  const converted = typed.asked === 'bits' ? value * 8n : value % 8n === 0n ? value / 8n : null
  const rule =
    converted === null
      ? 'A byte is 8 bits.'
      : `A byte is 8 bits, so ${amount(value, typed.unit)} ${value === 1n ? 'is' : 'are'} ${amount(converted, typed.asked)}.`
  return {
    code: 'bits-vs-bytes',
    message: `"${field.label}" asks for ${typed.asked}, but you wrote ${typed.unit}. ${rule}`,
  }
}
