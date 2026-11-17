import { useDraggable, useDroppable } from '@dnd-kit/core'
import type { KeyboardEvent, ReactNode } from 'react'
import { cx } from '../../../../components/ui/cx'
import { CheckCircleIcon, XCircleIcon } from '../../../../components/ui/icons'
import type { Chip, Field, FieldResult } from '../../types'
import { ChipLabel } from './ChipLabel'
import {
  CELL_WIDTH,
  CHIP_BOX,
  CHIP_GHOST,
  CHIP_GRAB,
  CHIP_IDLE,
  CHIP_LOCKED,
  CHIP_OVER,
  CHIP_REPLACE,
  CHIP_SELECTED,
  CHIP_TEXT,
  CLEAR_OF_TRAY,
  NO_TOUCH_EXTRAS,
  SLOT_BOX,
  SLOT_IDLE,
  SLOT_OPEN,
  SLOT_OVER,
  SLOT_READY,
  TAG,
} from './chipStyles'
import { CodeLine } from './CodeLine'
import { idleDragId } from './dnd'
import { howOfClick } from './input'
import { cellName, placeHereHint, replaceHint, WORDS, type How } from './words'

export interface TraceRowProps {
  /** The number of the line, starting at 1. */
  line: number
  /** The instruction on this line. */
  code: string
  /** The answer field of this line, or null when the line has no cell to fill. */
  field: Field | null
  /** The chip in the cell, or null when the cell is empty. */
  chip: Chip | null
  /**
   * False when the same chip also shows in an earlier line (the page handed over odd
   * answers). Such a copy can still be selected, but not dragged.
   */
  canDrag: boolean
  /** The selected chip, if any, and how it was selected. */
  selection: { chip: Chip; how: How } | null
  /** After Check: nothing can move. */
  locked: boolean
  /** After Check: how this line was marked. */
  outcome: FieldResult | null
  /** The text of the right chip, shown under a wrong line. */
  rightLabel: string
  /** The cell was clicked, tapped, or chosen with Enter or Space. */
  onActivate: (fieldId: string, how: How) => void
  /** Backspace or Delete on a filled cell. */
  onClear: (fieldId: string) => void
}

const ROW = 'border-b border-line last:border-b-0'
/**
 * In a narrow table (a phone) the cells keep little room around their text: the "changed"
 * cell must hold a whole register (19 characters), and the code column must still hold a
 * 32-bit number such as `0x181f3fba` on one line (at 360 px it is about 90 px wide).
 */
const LINE_CELL = 'px-1 py-2 text-center align-middle font-mono text-sm @lg:px-3'
const LINE_CELL_IDLE = 'font-normal text-muted'
/** The line under the dragged chip: a blue bar at its left edge and a bold number. */
const LINE_CELL_OVER = 'font-bold text-primary shadow-[inset_4px_0_0_0_var(--c-primary)]'
const CODE_CELL = 'w-full px-1 py-2 align-middle @lg:px-3'
const ANSWER_CELL = 'py-1 pr-1 pl-0.5 align-middle @lg:p-2'

/** One line of the trace table: its number, the instruction, and the "changed" cell. */
export function TraceRow(props: TraceRowProps): ReactNode {
  const { line, code, field } = props
  if (field === null) {
    return (
      <tr data-trace-row={line} className={ROW}>
        <th scope="row" className={cx(LINE_CELL, LINE_CELL_IDLE)}>
          {line}
        </th>
        <td className={CODE_CELL}>
          <CodeLine text={code} />
        </td>
        <td className={ANSWER_CELL} />
      </tr>
    )
  }
  return props.locked ? (
    <LockedRow {...props} field={field} />
  ) : (
    <OpenRow {...props} field={field} />
  )
}

type RowWithField = TraceRowProps & { field: Field }

/** A line that can still be filled: the row is a place to drop, the cell is a button. */
function OpenRow({
  line,
  code,
  field,
  chip,
  canDrag,
  selection,
  onActivate,
  onClear,
}: RowWithField): ReactNode {
  const { setNodeRef: setRowRef, isOver, active } = useDroppable({ id: field.id })
  const {
    setNodeRef: setChipRef,
    listeners,
    isDragging,
  } = useDraggable({
    id: chip !== null && canDrag ? chip.id : idleDragId(field.id),
    disabled: chip === null || !canDrag,
  })

  // "Over" means: a chip from somewhere else is held over this line.
  const over = isOver && !isDragging
  const someChipInTheAir = active !== null
  const selectedHere = chip !== null && selection?.chip.id === chip.id

  let look: string
  let tag: string | null = null
  let words: string | null = null
  if (chip === null) {
    if (over) {
      look = SLOT_OVER
      words = WORDS.dropHere
    } else if (someChipInTheAir) {
      look = SLOT_OPEN
      words = WORDS.emptyCellWhileDragging
    } else if (selection !== null) {
      look = SLOT_READY
      words = placeHereHint(selection.how)
    } else {
      look = SLOT_IDLE
      words = WORDS.emptyCell
    }
  } else if (isDragging) {
    look = cx(CHIP_IDLE, CHIP_GHOST)
  } else if (over) {
    look = CHIP_OVER
    tag = WORDS.dropToReplace
  } else if (selectedHere) {
    look = cx(CHIP_SELECTED, 'cursor-pointer')
    tag = WORDS.selected
  } else if (selection !== null) {
    look = CHIP_REPLACE
    tag = replaceHint(selection.how)
  } else {
    look = cx(CHIP_IDLE, canDrag ? CHIP_GRAB : 'cursor-pointer')
  }
  // What the label on a filled cell says is part of the cell's name ("tap to replace"),
  // except "selected": the button says that with aria-pressed.
  const hint = tag === WORDS.selected ? null : tag

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (chip === null || (event.key !== 'Backspace' && event.key !== 'Delete')) return
    event.preventDefault()
    onClear(field.id)
  }

  return (
    <tr
      ref={setRowRef}
      data-trace-row={line}
      data-trace-field={field.id}
      data-state={chip === null ? 'empty' : 'filled'}
      data-over={over ? '' : undefined}
      className={cx(ROW, 'transition-colors', over && 'bg-primary-soft')}
    >
      <th scope="row" className={cx(LINE_CELL, over ? LINE_CELL_OVER : LINE_CELL_IDLE)}>
        {line}
      </th>
      <td className={CODE_CELL}>
        <CodeLine text={code} />
      </td>
      <td className={ANSWER_CELL}>
        <div className={cx(CHIP_TEXT, CELL_WIDTH)}>
          <button
            ref={setChipRef}
            type="button"
            aria-label={cellName(line, chip?.label ?? null, chip === null ? words : hint)}
            aria-pressed={chip === null ? undefined : selectedHere}
            data-chip-id={chip?.id}
            data-chip-in={chip === null ? undefined : 'cell'}
            className={cx(
              chip === null ? SLOT_BOX : CHIP_BOX,
              NO_TOUCH_EXTRAS,
              CLEAR_OF_TRAY,
              look,
            )}
            onClick={(event) => onActivate(field.id, howOfClick(event))}
            onKeyDown={onKeyDown}
            {...listeners}
          >
            {chip === null ? words : <ChipLabel label={chip.label} />}
            {tag !== null && (
              <span data-trace-tag="" className={TAG}>
                {tag}
              </span>
            )}
          </button>
        </div>
      </td>
    </tr>
  )
}

/** A line after Check: the chip stays where it is, with the mark under it. */
function LockedRow({ line, code, field, chip, outcome, rightLabel }: RowWithField): ReactNode {
  const mark = outcome === null ? null : outcome.correct ? 'right' : 'wrong'
  return (
    <tr
      data-trace-row={line}
      data-trace-field={field.id}
      data-state={chip === null ? 'empty' : 'filled'}
      data-result={mark ?? undefined}
      className={cx(
        ROW,
        mark === 'right' && 'bg-good-soft/50',
        mark === 'wrong' && 'bg-bad-soft/50',
      )}
    >
      <th scope="row" className={cx(LINE_CELL, LINE_CELL_IDLE)}>
        {line}
      </th>
      <td className={CODE_CELL}>
        <CodeLine text={code} />
      </td>
      <td className={ANSWER_CELL}>
        <div className={cx(CHIP_TEXT, CELL_WIDTH)}>
          {chip === null ? (
            <div className={cx(SLOT_BOX, SLOT_IDLE)}>{WORDS.noChip}</div>
          ) : (
            <div data-chip-id={chip.id} data-chip-in="cell" className={cx(CHIP_BOX, CHIP_LOCKED)}>
              <ChipLabel label={chip.label} />
            </div>
          )}
          {mark === 'right' && (
            <p className="mt-1.5 flex items-center gap-1 font-sans text-sm font-bold text-good">
              <CheckCircleIcon size={16} />
              {WORDS.right}
            </p>
          )}
          {mark === 'wrong' && (
            <>
              <p className="mt-1.5 flex items-center gap-1 font-sans text-sm font-bold text-bad">
                <XCircleIcon size={16} />
                {chip === null ? WORDS.blank : WORDS.wrong}
              </p>
              <p className="mt-1 font-sans text-sm text-muted">{WORDS.rightAnswer}</p>
              <p className="font-semibold text-ink" data-trace-right-answer="">
                <ChipLabel label={rightLabel} />
              </p>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}
