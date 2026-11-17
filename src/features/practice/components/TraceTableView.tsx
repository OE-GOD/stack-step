/**
 * The homework-style trace table.
 *
 * It shows the starting registers, then one row per line of code. The student fills
 * the "What changed" cell of each row with an answer chip, in one of three ways:
 *
 * - drag a chip with the mouse (or press and hold it on a touch screen, then drag);
 * - tap or click a chip to select it, then tap or click a line;
 * - with the keyboard: Enter or Space on a chip, then Enter or Space on a line.
 *
 * The view is controlled. `answers[fieldId]` is the id of the chip in that line's cell
 * ('' when empty) and every move goes out through `onChange`. The tray is "every chip
 * that is in no cell". The view keeps no copy of where the chips are: its own state is
 * only which chip is selected, the last message for screen readers, and where the
 * keyboard focus should go next.
 *
 * The rules live in `trace/placement.ts`, the words in `trace/words.ts`, and the
 * drag-and-drop set-up in `trace/dnd.ts`.
 */
import {
  DndContext,
  DragOverlay,
  TouchSensor,
  useDndContext,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from '../../../components/ui/cx'
import { RichText } from '../../../components/ui/RichText'
import type { Chip, ProblemViewProps } from '../types'
import { ChipLabel } from './trace/ChipLabel'
import { CHIP_BOX, CHIP_LIFTED, CHIP_TEXT, TAG } from './trace/chipStyles'
import { ChipTray } from './trace/ChipTray'
import {
  AUTO_SCROLL,
  distance,
  DROP_ANIMATION,
  isTouchDrag,
  landingOf,
  MainButtonMouseSensor,
  MOUSE_DRAG_DISTANCE,
  pointerCollision,
  pointOf,
  prefersReducedMotion,
  readDropZones,
  TAP_SLOP,
  targetAt,
  TOUCH_DRAG_DELAY,
  TOUCH_DRAG_TOLERANCE,
  TRAY_DROP_ID,
  watchRelease,
  type Point,
  type ReleaseWatch,
} from './trace/dnd'
import { cellOfChip, chipInCell, chipsInTray, planMove, type MoveTarget } from './trace/placement'
import { readPrompt } from './trace/prompt'
import { StartingValues } from './trace/StartingValues'
import { TraceRow } from './trace/TraceRow'
import { watchTrayHeight } from './trace/trayHeight'
import {
  cancelledMessage,
  CHOOSE_A_CHIP_FIRST,
  dragTag,
  outcomeMessage,
  selectedMessage,
  stillSelectedMessage,
  WORDS,
  type How,
} from './trace/words'

const NO_CHIPS: readonly Chip[] = []

/** A mouse drag starts after a few pixels, so a plain click stays a click. */
const MOUSE_OPTIONS = { activationConstraint: { distance: MOUSE_DRAG_DISTANCE } }

/** A touch drag starts after a long press, so a swipe on a chip still scrolls the page. */
const TOUCH_OPTIONS = {
  activationConstraint: { delay: TOUCH_DRAG_DELAY, tolerance: TOUCH_DRAG_TOLERANCE },
}

/**
 * dnd-kit says nothing by itself: the table has its own polite live region, which also
 * covers taps and the keyboard, so nothing is read out twice.
 */
const SILENT: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
}
const ACCESSIBILITY = {
  announcements: SILENT,
  screenReaderInstructions: { draggable: '' },
  restoreFocus: false,
}

/** Where the keyboard focus goes after a move took the focused button away. */
type FocusRequest = ({ kind: 'cell'; fieldId: string } | { kind: 'chip'; chipId: string }) & {
  /** Do not scroll to it (the move was made with a mouse or a finger). */
  quiet: boolean
}

/** A drag that dnd-kit has started and that has not ended yet. */
interface OpenDrag {
  chipId: string
  /** Where the press began. */
  start: Point | null
  how: How
  /** The chip was the selected one when the drag began. */
  wasSelected: boolean
  watch: ReleaseWatch
}

type FinishDrag = (
  drag: Pick<OpenDrag, 'chipId' | 'how' | 'wasSelected'>,
  moved: number,
  target: MoveTarget | null,
) => void

function focusedInside(root: HTMLElement | null): HTMLElement | null {
  const focused = document.activeElement
  return root !== null && focused instanceof HTMLElement && root.contains(focused) ? focused : null
}

function findFocusTarget(root: HTMLElement, request: FocusRequest): HTMLElement | null {
  if (request.kind === 'cell') {
    const row = [...root.querySelectorAll<HTMLElement>('[data-trace-field]')].find(
      (entry) => entry.dataset.traceField === request.fieldId,
    )
    return row?.querySelector<HTMLElement>('button') ?? null
  }
  return (
    [...root.querySelectorAll<HTMLElement>('button[data-chip-in="tray"]')].find(
      (entry) => entry.dataset.chipId === request.chipId,
    ) ?? null
  )
}

/**
 * The view of a problem with `view: 'trace-table'`. It shows the whole prompt of the
 * problem (sentences, starting values, code), so the page does not render the prompt.
 */
export default function TraceTableView(props: ProblemViewProps): ReactNode {
  // A new problem gets a new board: nothing selected, no drag left over from the old one.
  return <TraceBoard key={props.problem.id} {...props} />
}

function TraceBoard({ problem, answers, onChange, locked, result }: ProblemViewProps): ReactNode {
  const chips = problem.chips ?? NO_CHIPS
  const fields = problem.fields
  const fieldIds = fields.map((field) => field.id)
  const prompt = readPrompt(problem.prompt)

  const rootRef = useRef<HTMLDivElement>(null)
  const keyboardHelpId = useId()
  const [picked, setPicked] = useState<{ chipId: string; how: How } | null>(null)
  const [chooseChipFirst, setChooseChipFirst] = useState(false)
  const [spoken, setSpoken] = useState({ text: '', count: 0 })
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)

  // Check locks the table and "Try again" opens the same problem again. Both start with
  // nothing selected, so a chip chosen before Check does not come back selected, and with
  // nothing in the live region, so a screen reader that reads the page after Check finds
  // no old instruction under the table.
  const [wasLocked, setWasLocked] = useState(locked)
  if (locked !== wasLocked) {
    setWasLocked(locked)
    setPicked(null)
    setChooseChipFirst(false)
    setSpoken((previous) => ({ text: '', count: previous.count }))
  }

  // The selection only counts while the chip exists and the table is open.
  const pickedChip =
    locked || picked === null ? undefined : chips.find((chip) => chip.id === picked.chipId)
  const selection =
    picked === null || pickedChip === undefined ? null : { chip: pickedChip, how: picked.how }

  // Which chips sit in a cell, and the first line that shows each of them.
  const placedIds = new Set<string>()
  const firstCell = new Map<string, string>()
  for (const field of fields) {
    const chip = chipInCell(chips, answers, field.id)
    if (chip === null) continue
    placedIds.add(chip.id)
    if (!firstCell.has(chip.id)) firstCell.set(chip.id, field.id)
  }

  const labelOf = (chipId: string) => chips.find((chip) => chip.id === chipId)?.label ?? chipId
  const lineOf = (fieldId: string) => fieldIds.indexOf(fieldId) + 1
  const say = (text: string) => setSpoken((previous) => ({ text, count: previous.count + 1 }))

  /* ───────────────────────── Selecting ───────────────────────── */

  const select = (chipId: string, how: How) => {
    setChooseChipFirst(false)
    setPicked({ chipId, how })
    const cell = cellOfChip(fieldIds, answers, chipId)
    say(selectedMessage(labelOf(chipId), cell === null ? null : lineOf(cell)))
  }

  const unselect = (chipId: string) => {
    // The "put it back" button goes away with the selection. If the focus was on it,
    // move the focus to the chip it was about.
    const focused = focusedInside(rootRef.current)
    const cell = cellOfChip(fieldIds, answers, chipId)
    if (focused?.hasAttribute('data-trace-put-back') === true && cell !== null) {
      setFocusRequest({ kind: 'cell', fieldId: cell, quiet: false })
    }
    setChooseChipFirst(false)
    setPicked(null)
    say(cancelledMessage(labelOf(chipId)))
  }

  /** A chip was tapped, clicked, or chosen with Enter or Space. */
  const pickChip = (chipId: string, how: How) => {
    if (selection?.chip.id === chipId) unselect(chipId)
    else select(chipId, how)
  }

  /* ─────────────────────────── Moving ─────────────────────────── */

  /**
   * Put a chip somewhere. The move uses up the selection, unless `keepSelection` says the
   * selected chip has nothing to do with it.
   */
  const move = (chipId: string, target: MoveTarget, how: How, keepSelection = false) => {
    const kept = keepSelection ? selection : null
    if (kept === null) setPicked(null)
    setChooseChipFirst(false)
    const plan = planMove(chips, fieldIds, answers, chipId, target)
    if (plan.outcome === null) return

    // A move can take away the button that has the focus (the chip leaves the tray, or
    // the "put it back" button goes away). The focus follows the chip, so it is never lost.
    const focused = focusedInside(rootRef.current)
    const quiet = how !== 'keyboard'
    if (plan.outcome.type === 'placed') {
      if (focused?.dataset.chipIn === 'tray' && focused.dataset.chipId === chipId) {
        setFocusRequest({ kind: 'cell', fieldId: plan.outcome.fieldId, quiet })
      }
    } else if (focused?.hasAttribute('data-trace-put-back') === true) {
      setFocusRequest({ kind: 'chip', chipId, quiet })
    }

    for (const change of plan.changes) onChange(change.fieldId, change.value)
    const done = outcomeMessage(plan.outcome, labelOf, lineOf)
    // A move usually uses up the selection, so say so when it did not.
    say(kept === null ? done : `${done} ${stillSelectedMessage(kept.chip.label)}`)
  }

  /** A cell was tapped, clicked, or chosen with Enter or Space. */
  const activateCell = (fieldId: string, how: How) => {
    const here = chipInCell(chips, answers, fieldId)
    if (selection === null) {
      if (here !== null) {
        select(here.id, how)
      } else {
        setChooseChipFirst(true)
        say(CHOOSE_A_CHIP_FIRST)
      }
      return
    }
    if (here?.id === selection.chip.id) {
      unselect(here.id)
      return
    }
    move(selection.chip.id, { kind: 'cell', fieldId }, how)
  }

  /**
   * Backspace or Delete on a filled cell. A chip that is selected somewhere else stays
   * selected: the student may clear a line on the way to the line it is meant for.
   */
  const clearCell = (fieldId: string) => {
    const here = chipInCell(chips, answers, fieldId)
    if (here === null) return
    const keepSelection = selection !== null && selection.chip.id !== here.id
    move(here.id, { kind: 'tray' }, 'keyboard', keepSelection)
  }

  const putSelectedBack = (how: How) => {
    if (selection !== null) move(selection.chip.id, { kind: 'tray' }, how)
  }

  /* ────────────────────────── Dragging ────────────────────────── */

  const openDrag = useRef<OpenDrag | null>(null)

  /**
   * The end of a drag. `moved` is how far the pointer went from where it was pressed,
   * `target` is what it was over when it let go (null = nothing).
   */
  const finishDrag: FinishDrag = (drag, moved, target) => {
    if (locked) return
    if (moved <= TAP_SLOP) {
      // Pressed and let go on the spot: that is a tap, even when it was slow.
      if (drag.wasSelected) unselect(drag.chipId)
      else select(drag.chipId, drag.how)
      return
    }
    // Let go over nothing: with a mouse, a chip from a line goes back to the tray (a chip
    // from the tray stays there); with a finger, nothing changes (see `landingOf`).
    const landing = landingOf(target, drag.how === 'touch')
    if (landing !== null) move(drag.chipId, landing, drag.how)
  }

  // The release is watched outside React (see `watchRelease`), so it must find the
  // newest `finishDrag`: the one that knows the current answers.
  const finishDragRef = useRef<FinishDrag>(finishDrag)
  useLayoutEffect(() => {
    finishDragRef.current = finishDrag
  })

  const handleDragStart = (event: DragStartEvent) => {
    openDrag.current?.watch.stop()
    const activator = event.activatorEvent
    const chipId = String(event.active.id)
    const start = pointOf(activator)
    const drag: OpenDrag = {
      chipId,
      start,
      how: isTouchDrag(activator) ? 'touch' : 'mouse',
      wasSelected: selection?.chip.id === chipId,
      watch: watchRelease(
        activator,
        (point) => {
          const root = rootRef.current
          // No position, or the table is gone: leave it to `handleDragEnd`.
          if (root === null || point === null || openDrag.current !== drag) return
          openDrag.current = null
          const moved = start === null ? Number.POSITIVE_INFINITY : distance(start, point)
          finishDragRef.current(drag, moved, targetAt(point, readDropZones(root)))
        },
        () => {
          if (openDrag.current === drag) openDrag.current = null
        },
      ),
    }
    openDrag.current = drag
    // A chip in the air replaces a chip that was only selected.
    setPicked(null)
    setChooseChipFirst(false)
  }

  /**
   * dnd-kit reports the end of the drag. `watchRelease` saw the same mouseup or touchend
   * first and has done the move already. This is the net under it: when the release did
   * not reach the watcher, finish with what dnd-kit knows.
   */
  const handleDragEnd = (event: DragEndEvent) => {
    const drag = openDrag.current
    if (drag === null) return
    drag.watch.stop()
    openDrag.current = null
    const overId = event.over === null ? null : String(event.over.id)
    const target: MoveTarget | null =
      overId === null
        ? null
        : overId === TRAY_DROP_ID
          ? { kind: 'tray' }
          : { kind: 'cell', fieldId: overId }
    finishDrag(drag, Math.hypot(event.delta.x, event.delta.y), target)
  }

  const handleDragCancel = () => {
    openDrag.current?.watch.stop()
    openDrag.current = null
  }

  // Leaving the page in the middle of a drag: stop watching for the release.
  useEffect(
    () => () => {
      openDrag.current?.watch.stop()
      openDrag.current = null
    },
    [],
  )

  const sensors = useSensors(
    useSensor(MainButtonMouseSensor, MOUSE_OPTIONS),
    useSensor(TouchSensor, TOUCH_OPTIONS),
  )

  /* ───────────────────── Keyboard and focus ───────────────────── */

  // While the tray sticks to the bottom of a phone screen, a cell that gets the keyboard
  // focus is scrolled out from under it: the cells read the tray's height (CLEAR_OF_TRAY).
  useEffect(() => {
    const root = rootRef.current
    return root === null ? undefined : watchTrayHeight(root)
  }, [])

  // Escape cancels the selection, wherever the focus is.
  useEffect(() => {
    if (selection === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') unselect(selection.chip.id)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  useEffect(() => {
    const root = rootRef.current
    if (focusRequest === null || root === null) return
    findFocusTarget(root, focusRequest)?.focus({ preventScroll: focusRequest.quiet })
  }, [focusRequest])

  /* ─────────────────────────── Drawing ─────────────────────────── */

  const rowCount = Math.max(prompt.lines.length, fields.length)
  const rows = Array.from({ length: rowCount }, (_, index) => {
    const field = fields[index] ?? null
    const chip = field === null ? null : chipInCell(chips, answers, field.id)
    const outcome =
      !locked || field === null
        ? null
        : (result?.fields.find((entry) => entry.fieldId === field.id) ?? null)
    const rightChip =
      field === null ? undefined : chips.find((entry) => entry.id === field.expected)
    return (
      <TraceRow
        key={field?.id ?? `line-${index}`}
        line={index + 1}
        code={prompt.lines[index] ?? ''}
        field={field}
        chip={chip}
        canDrag={chip !== null && field !== null && firstCell.get(chip.id) === field.id}
        selection={selection}
        locked={locked}
        outcome={outcome}
        rightLabel={rightChip?.label ?? outcome?.expectedDisplay ?? field?.expectedDisplay ?? ''}
        onActivate={activateCell}
        onClear={clearCell}
      />
    )
  })

  return (
    <div
      ref={rootRef}
      data-trace-table=""
      data-locked={locked ? '' : undefined}
      className="@container"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={pointerCollision}
        autoScroll={AUTO_SCROLL}
        accessibility={ACCESSIBILITY}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        {prompt.texts.map((text, index) => (
          <p key={index} className="mb-3 max-w-prose text-pretty text-ink">
            <RichText text={text} />
          </p>
        ))}
        <p id={keyboardHelpId} className="sr-only">
          {WORDS.keyboardHelp}
        </p>

        <div className="@min-[44rem]:grid @min-[44rem]:grid-cols-[minmax(0,1fr)_17rem] @min-[44rem]:items-start @min-[44rem]:gap-6 @min-[68rem]:grid-cols-[minmax(0,1fr)_32rem]">
          <div className="min-w-0 space-y-4">
            {prompt.registers.map((part, index) => (
              <StartingValues key={index} title={part.title} rows={part.rows} />
            ))}
            <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
              <table
                className="w-full text-left"
                aria-describedby={locked ? undefined : keyboardHelpId}
              >
                <caption className="sr-only">{WORDS.traceTable}</caption>
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-sm text-muted">
                    <th scope="col" className="px-1.5 py-1.5 font-semibold @lg:px-3">
                      <span className="@max-lg:sr-only">{WORDS.line}</span>
                    </th>
                    <th scope="col" className="px-1.5 py-1.5 font-semibold @lg:px-3">
                      {WORDS.code}
                    </th>
                    <th scope="col" className="px-1.5 py-1.5 font-semibold @lg:px-2">
                      {WORDS.changed}
                    </th>
                  </tr>
                </thead>
                <tbody>{rows}</tbody>
              </table>
            </div>
          </div>

          <ChipTray
            chips={chipsInTray(chips, fieldIds, answers)}
            total={chips.length}
            placedIds={placedIds}
            selection={selection}
            chooseChipFirst={chooseChipFirst}
            locked={locked}
            keyboardHelpId={keyboardHelpId}
            onPick={pickChip}
            onPutBack={putSelectedBack}
          />
        </div>

        <DraggedChip chips={chips} fieldIds={fieldIds} placedIds={placedIds} />
      </DndContext>

      {/* What just happened, for screen readers. The extra space makes the same sentence
          count as new when it comes twice in a row. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="trace-announcer"
        className="sr-only"
      >
        {spoken.text}
        {spoken.text !== '' && spoken.count % 2 === 1 ? '\u00a0' : ''}
      </p>
    </div>
  )
}

/**
 * The chip under the pointer while it is dragged. It is drawn in <body>, outside the
 * table, so no box on the page can clip it or shift it. A small label on it says where
 * a drop would put it ("line 2", "put back").
 */
function DraggedChip({
  chips,
  fieldIds,
  placedIds,
}: {
  chips: readonly Chip[]
  fieldIds: readonly string[]
  placedIds: ReadonlySet<string>
}): ReactNode {
  const { active, activatorEvent, over } = useDndContext()
  const chip = active === null ? undefined : chips.find((entry) => entry.id === active.id)
  if (typeof document === 'undefined') return null

  const overLine = over === null ? 0 : fieldIds.indexOf(String(over.id)) + 1
  // A chip from a line goes back to the tray when it is let go over the tray, and (with
  // a mouse only) over nothing: see `landingOf`.
  const overTray = over !== null && over.id === TRAY_DROP_ID
  const overNothingPutsBack = landingOf(null, isTouchDrag(activatorEvent)) !== null
  const putsBack =
    chip !== undefined &&
    placedIds.has(chip.id) &&
    (overTray || (over === null && overNothingPutsBack))
  const tag = chip === undefined ? null : dragTag(overLine > 0 ? overLine : null, putsBack)
  return createPortal(
    <DragOverlay dropAnimation={prefersReducedMotion() ? null : DROP_ANIMATION}>
      {chip === undefined ? null : (
        <div data-trace-overlay="" className={cx(CHIP_BOX, CHIP_TEXT, CHIP_LIFTED)}>
          <ChipLabel label={chip.label} />
          {tag !== null && (
            <span data-trace-drag-tag="" className={TAG}>
              {tag}
            </span>
          )}
        </div>
      )}
    </DragOverlay>,
    document.body,
  )
}
