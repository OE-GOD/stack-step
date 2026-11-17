import { useDraggable } from '@dnd-kit/core'
import type { ReactNode } from 'react'
import { cx } from '../../../../components/ui/cx'
import type { Chip } from '../../types'
import { ChipLabel } from './ChipLabel'
import {
  CHIP_BOX,
  CHIP_GHOST,
  CHIP_GRAB,
  CHIP_IDLE,
  CHIP_SELECTED,
  CHIP_TEXT,
  NO_TOUCH_EXTRAS,
  TAG,
} from './chipStyles'
import { howOfClick } from './input'
import { WORDS, type How } from './words'

export interface TrayChipProps {
  chip: Chip
  selected: boolean
  /** The chip was clicked, tapped, or chosen with Enter or Space. */
  onPick: (chipId: string, how: How) => void
}

/**
 * A chip that waits in the tray. It is a real button (so Tab reaches it and Enter or
 * Space select it) that can also be dragged.
 */
export function TrayChip({ chip, selected, onPick }: TrayChipProps): ReactNode {
  const { setNodeRef, listeners, isDragging } = useDraggable({ id: chip.id })
  return (
    <button
      ref={setNodeRef}
      type="button"
      aria-label={chip.label}
      aria-pressed={selected}
      data-chip-id={chip.id}
      data-chip-in="tray"
      className={cx(
        CHIP_BOX,
        CHIP_TEXT,
        CHIP_GRAB,
        NO_TOUCH_EXTRAS,
        selected ? CHIP_SELECTED : CHIP_IDLE,
        isDragging && CHIP_GHOST,
      )}
      onClick={(event) => onPick(chip.id, howOfClick(event))}
      {...listeners}
    >
      <ChipLabel label={chip.label} />
      {selected && (
        <span data-trace-tag="" className={TAG}>
          {WORDS.selected}
        </span>
      )}
    </button>
  )
}
