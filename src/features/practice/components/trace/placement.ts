/**
 * The rules of the trace table, without React: where every chip is, and what a move
 * changes.
 *
 * The page owns the answers (`answers[fieldId]` is the id of the chip in that line's
 * cell, '' when the cell is empty). Nothing here keeps a copy: every function reads the
 * answers it is given and says which `onChange(fieldId, value)` calls a move needs.
 */
import type { Chip } from '../../types'

/** Field id → chip id ('' or missing = the cell is empty). */
export type Answers = Readonly<Record<string, string>>

/** One call of `onChange(fieldId, value)`. `value` is a chip id, or '' to empty the cell. */
export interface AnswerChange {
  fieldId: string
  value: string
}

/** Where a chip can be put: the cell of one line, or back with the unplaced chips. */
export type MoveTarget = { kind: 'cell'; fieldId: string } | { kind: 'tray' }

/** What a move did, for the message that screen readers hear. */
export type MoveOutcome =
  | {
      type: 'placed'
      chipId: string
      fieldId: string
      /** The cell the chip came from, or null when it came from the tray. */
      fromFieldId: string | null
      /** The chip that was in the cell before. It is back in the tray now. */
      replacedChipId: string | null
    }
  | { type: 'returned'; chipId: string; fromFieldId: string }

export interface MovePlan {
  /** The `onChange` calls to make, in this order. Empty when the move changes nothing. */
  changes: readonly AnswerChange[]
  outcome: MoveOutcome | null
}

const NOTHING: MovePlan = { changes: [], outcome: null }

/**
 * The chip in the cell of one field, or null when the cell is empty. An answer that
 * names a chip that does not exist counts as empty.
 */
export function chipInCell(chips: readonly Chip[], answers: Answers, fieldId: string): Chip | null {
  const chipId = answers[fieldId] ?? ''
  if (chipId === '') return null
  return chips.find((chip) => chip.id === chipId) ?? null
}

/** The field whose cell holds the chip (the first one), or null when the chip is in the tray. */
export function cellOfChip(
  fieldIds: readonly string[],
  answers: Answers,
  chipId: string,
): string | null {
  if (chipId === '') return null
  return fieldIds.find((fieldId) => answers[fieldId] === chipId) ?? null
}

/** The chips that are in no cell, in the order the problem lists them. */
export function chipsInTray(
  chips: readonly Chip[],
  fieldIds: readonly string[],
  answers: Answers,
): Chip[] {
  const placed = new Set(fieldIds.map((fieldId) => answers[fieldId] ?? ''))
  return chips.filter((chip) => !placed.has(chip.id))
}

/**
 * What it takes to put a chip somewhere.
 *
 * - Onto a cell: the chip leaves the cell it was in (if any) and takes the new one. A
 *   chip that was already there is replaced; because the tray is "every chip that is in
 *   no cell", the replaced chip is back in the tray without a call of its own.
 * - Onto the tray: the chip leaves its cell. A chip that is already in the tray stays.
 *
 * A move from one cell to another is two calls: first the old cell is emptied, then the
 * new one is filled, so a chip is never in two cells at once.
 */
export function planMove(
  chips: readonly Chip[],
  fieldIds: readonly string[],
  answers: Answers,
  chipId: string,
  target: MoveTarget,
): MovePlan {
  if (!chips.some((chip) => chip.id === chipId)) return NOTHING

  // Every cell that holds the chip. More than one would be a mistake of the page; the
  // move then tidies it up.
  const holders = fieldIds.filter((fieldId) => answers[fieldId] === chipId)
  const fromFieldId = holders[0] ?? null

  if (target.kind === 'tray') {
    if (fromFieldId === null) return NOTHING
    return {
      changes: holders.map((fieldId) => ({ fieldId, value: '' })),
      outcome: { type: 'returned', chipId, fromFieldId },
    }
  }

  const { fieldId } = target
  if (!fieldIds.includes(fieldId)) return NOTHING
  const others = holders.filter((holder) => holder !== fieldId)
  if (others.length === 0 && holders.length > 0) return NOTHING // It is already there.

  const changes: AnswerChange[] = others.map((holder) => ({ fieldId: holder, value: '' }))
  if (answers[fieldId] !== chipId) changes.push({ fieldId, value: chipId })

  const replaced = chipInCell(chips, answers, fieldId)
  return {
    changes,
    outcome: {
      type: 'placed',
      chipId,
      fieldId,
      fromFieldId: others[0] ?? null,
      replacedChipId: replaced !== null && replaced.id !== chipId ? replaced.id : null,
    },
  }
}
