import { useDndContext, useDroppable } from '@dnd-kit/core'
import { useId, type ReactNode } from 'react'
import { cx } from '../../../../components/ui/cx'
import { Kbd } from '../../../../components/ui/Kbd'
import type { Chip } from '../../types'
import { ChipLabel } from './ChipLabel'
import {
  CHIP_BOX,
  CHIP_LOCKED,
  CHIP_TEXT,
  NO_TOUCH_EXTRAS,
  SLOT_BOX,
  SLOT_OPEN,
  SLOT_OVER,
  SLOT_READY,
  TRAY_GRID,
  TRAY_STICKY,
} from './chipStyles'
import { isTouchDrag, landingOf, TRAY_DROP_ID } from './dnd'
import { howOfClick } from './input'
import { TrayChip } from './TrayChip'
import { nextStepHelp, putBackHint, putBackName, WORDS, type How } from './words'

export interface ChipTrayProps {
  /** The chips that are in no cell, in the order of the problem. */
  chips: readonly Chip[]
  /** How many chips the problem has in all. */
  total: number
  /** The ids of the chips that sit in a cell. */
  placedIds: ReadonlySet<string>
  /** The selected chip, if any, and how it was selected. */
  selection: { chip: Chip; how: How } | null
  /** Show "First choose a chip" (an empty cell was chosen with no chip selected). */
  chooseChipFirst: boolean
  /** After Check: the chips are only shown. */
  locked: boolean
  /** The id of the keyboard instructions, for `aria-describedby`. */
  keyboardHelpId: string
  onPick: (chipId: string, how: How) => void
  /** Take the selected chip off its line. */
  onPutBack: (how: How) => void
}

/** The tray sticks to the bottom of a phone screen (see TRAY_STICKY), with a soft shadow above it. */
const STICKY = cx(TRAY_STICKY, 'shadow-[0_-10px_14px_-12px_rgb(0_0_0/0.35)] @min-[44rem]:shadow-xs')

/**
 * The tray: every chip that is in no cell. It is also a place to drop a chip that was on
 * a line, and it says in a few words what to do next.
 */
export function ChipTray({
  chips,
  total,
  placedIds,
  selection,
  chooseChipFirst,
  locked,
  keyboardHelpId,
  onPick,
  onPutBack,
}: ChipTrayProps): ReactNode {
  const labelId = useId()
  const helpId = useId()
  const { setNodeRef, active, over, isOver } = useDroppable({ id: TRAY_DROP_ID, disabled: locked })
  const { activatorEvent } = useDndContext()

  const dragging = !locked && active !== null
  // A chip that was on a line is in the air. Letting go of it over the tray puts it back
  // here; so does letting go over nothing at all, with a mouse (see `landingOf`).
  const draggedFromLine = !locked && active !== null && placedIds.has(String(active.id))
  const overNothingPutsBack = landingOf(null, isTouchDrag(activatorEvent)) !== null
  const wouldLandHere = draggedFromLine && (isOver || (over === null && overNothingPutsBack))
  const selectedOnLine = selection !== null && placedIds.has(selection.chip.id)

  let help: ReactNode
  if (dragging) help = WORDS.helpDragging
  else if (selection !== null) help = nextStepHelp(selection.how, selectedOnLine)
  else if (chooseChipFirst) help = WORDS.helpChooseChip
  else {
    help = (
      <>
        <span className="pointer-coarse:hidden">{WORDS.helpMouse}</span>
        <span className="hidden pointer-coarse:inline">{WORDS.helpTouch}</span>
      </>
    )
  }

  return (
    <div
      ref={setNodeRef}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={locked ? undefined : `${helpId} ${keyboardHelpId}`}
      data-trace-tray=""
      className={cx(
        'mt-4 border-t border-line-strong bg-bg pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        '@min-[44rem]:mt-0 @min-[44rem]:rounded-xl @min-[44rem]:border @min-[44rem]:border-line @min-[44rem]:bg-surface @min-[44rem]:p-3',
        !locked && STICKY,
      )}
    >
      <p className="mb-1.5 text-sm leading-snug text-muted">
        <span id={labelId} className="mr-1.5 text-sm font-bold text-ink">
          {locked ? WORDS.chipsNotUsed : WORDS.chips}
        </span>
        {/* A real space, so a screen reader does not run the two together ("ChipsDrag"). */}{' '}
        {!locked && (
          <span id={helpId} data-trace-help="">
            {help}
          </span>
        )}
      </p>

      {chips.length === 0 && !selectedOnLine && !draggedFromLine ? (
        <p className="py-2 text-sm text-muted">{total === 0 ? WORDS.noChips : WORDS.noChipsLeft}</p>
      ) : (
        <div className={cx(CHIP_TEXT, TRAY_GRID)}>
          {selection !== null && selectedOnLine && (
            <button
              type="button"
              aria-label={putBackName(selection.chip.label, selection.how)}
              data-trace-put-back=""
              className={cx(SLOT_BOX, SLOT_READY, NO_TOUCH_EXTRAS)}
              onClick={(event) => onPutBack(howOfClick(event))}
            >
              {putBackHint(selection.how)}
            </button>
          )}
          {draggedFromLine && (
            <div
              data-trace-put-back-hint={wouldLandHere ? 'over' : 'open'}
              className={cx(SLOT_BOX, wouldLandHere ? SLOT_OVER : SLOT_OPEN)}
            >
              {WORDS.dropToPutBack}
            </div>
          )}
          {chips.map((chip) =>
            locked ? (
              <div
                key={chip.id}
                data-chip-id={chip.id}
                data-chip-in="tray"
                className={cx(CHIP_BOX, CHIP_LOCKED, 'opacity-70')}
              >
                <ChipLabel label={chip.label} />
              </div>
            ) : (
              <TrayChip
                key={chip.id}
                chip={chip}
                selected={selection?.chip.id === chip.id}
                onPick={onPick}
              />
            ),
          )}
        </div>
      )}

      {!locked && (
        <p className="mt-2 hidden text-sm leading-relaxed text-muted pointer-fine:block">
          <Kbd>Enter</Kbd> select or place · <Kbd>Esc</Kbd> cancel · <Kbd>Backspace</Kbd> clear a
          line
        </p>
      )}
    </div>
  )
}
