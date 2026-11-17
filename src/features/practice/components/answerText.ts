/**
 * Small pure helpers for showing numbers and answers on the practice pages.
 *
 * What counts as a typed hex number, and how many digits it has, is the checker's own
 * rule (`parseHexAnswer` and `countHexDigits` of the emulator), so the digit counter under
 * a field and the "Type all 16 hex digits" message can never disagree.
 */
import { countHexDigits, groupHex, parseHexAnswer } from '../../../emulator'
import type { Field, FieldResult, Problem } from '../types'

/** '0x1f8' → '1f8'. null when the text is not one hex number (with an optional 0x). */
export function shownHexDigits(text: string): string | null {
  const digits = text.trim().replace(/^0x/i, '')
  return /^[0-9a-f]+$/i.test(digits) ? digits.toLowerCase() : null
}

/** The digits in groups of four, cut from the right: '1234567' → ['123', '4567']. */
export function groupsOfFour(digits: string): string[] {
  return groupHex(BigInt(`0x${digits}`), digits.length).split(' ')
}

/**
 * The hex digits a student typed, as the checker reads them (0x, spaces and underscores
 * taken out, lower case, leading zeros kept); null if it is not a hex number.
 */
export function typedHexDigits(text: string): string | null {
  const value = parseHexAnswer(text)
  const count = countHexDigits(text)
  return value === null || count === null ? null : value.toString(16).padStart(count, '0')
}

/**
 * How the in-field grouping lines up with what was typed: the number of characters in
 * front of the first digit (2 for a typed `0x`), or null when the text has spaces,
 * underscores or other characters (the student groups it their own way then).
 */
export function digitsStartAt(text: string): number | null {
  if (!/^(0x)?[0-9a-f]*$/i.test(text)) return null
  return /^0x/i.test(text) ? 2 : 0
}

/** A whole-register hint under a hex field: "12 of 16 digits", or "17 digits: 1 too many". */
export function digitCountText(text: string, wanted: number): string {
  const count = countHexDigits(text) ?? 0
  return count > wanted
    ? `${count} digits: ${count - wanted} too many`
    : `${count} of ${wanted} digits`
}

/** True when a hex field holds something that is not a hex number. */
export function hasNonHex(text: string): boolean {
  return text.trim() !== '' && countHexDigits(text) === null
}

/** The label of a chip id, for showing a trace-table answer. */
export function chipLabel(problem: Problem, chipId: string): string {
  return problem.chips?.find((chip) => chip.id === chipId)?.label ?? chipId
}

/** What the student gave for a field, ready to show ('' when blank). */
export function givenText(problem: Problem, field: Field, result: FieldResult): string {
  if (result.given === '') return ''
  if (field.kind.type === 'chip') return chipLabel(problem, result.given)
  if (field.kind.type === 'hex') {
    const digits = typedHexDigits(result.given)
    return digits === null ? result.given : `0x${digits}`
  }
  return result.given
}

/** The fields in the order the student meets them: trace rows first (in prompt order), then the rest. */
export function fieldsInOrder(problem: Problem): Field[] {
  const byId = new Map(problem.fields.map((field) => [field.id, field]))
  const ordered: Field[] = []
  const placed = new Set<string>()
  for (const block of problem.prompt) {
    if (block.type !== 'trace') continue
    for (const row of block.rows) {
      const field = byId.get(row.fieldId)
      if (field !== undefined && !placed.has(field.id)) {
        ordered.push(field)
        placed.add(field.id)
      }
    }
  }
  for (const field of problem.fields) if (!placed.has(field.id)) ordered.push(field)
  return ordered
}

/** Field ids that a trace block places inside its rows. */
export function fieldsInTrace(problem: Problem): Set<string> {
  const ids = new Set<string>()
  for (const block of problem.prompt) {
    if (block.type === 'trace') for (const row of block.rows) ids.add(row.fieldId)
  }
  return ids
}
