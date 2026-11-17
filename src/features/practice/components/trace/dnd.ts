/**
 * The drag-and-drop set-up of the trace table (dnd-kit), without React.
 *
 * Three things are decided here and nowhere else:
 *
 * 1. What is under the pointer. The answer comes from where the pieces are on the screen
 *    at that moment (`getBoundingClientRect`), not from measurements taken when the drag
 *    started. So it stays right when the page scrolls during a drag, and for the tray,
 *    which sticks to the bottom of a phone screen and so does not move with the page.
 * 2. Where a chip lands. The release is read from the `mouseup` / `touchend` event
 *    itself (`watchRelease`), so a fast drag lands where the pointer really is, even
 *    when dnd-kit has not drawn the newest position yet.
 * 3. When a drag starts at all: a mouse drag only with the main button, a touch drag only
 *    after a long press (`TOUCH_DRAG_DELAY`), so a swipe scrolls the page.
 */
import {
  defaultDropAnimationSideEffects,
  MouseSensor,
  type CollisionDetection,
  type DropAnimation,
  type MouseSensorOptions,
} from '@dnd-kit/core'
import type { MoveTarget } from './placement'

/** The id of the tray as a place to drop a chip. (Cells use their field id.) */
export const TRAY_DROP_ID = 'trace-table:tray'

/** The id a draggable gets when it holds no chip that can be dragged. */
export function idleDragId(fieldId: string): string {
  return `trace-table:idle:${fieldId}`
}

/** A mouse drag starts after this many pixels, so a plain click is never a drag. */
export const MOUSE_DRAG_DISTANCE = 6

/**
 * A touch drag starts after the finger rests on a chip this long (milliseconds) without
 * moving more than `TOUCH_DRAG_TOLERANCE` pixels. A swipe moves at once, so it scrolls
 * the page as usual.
 *
 * It is the long-press time of the phones (half a second on iOS), not shorter: people
 * often rest a thumb on the screen for a moment before they swipe. With 250 ms, a thumb
 * that rested 0.3 s on a chip picked it up, and the swipe that followed dropped it on a
 * line instead of scrolling the page.
 */
export const TOUCH_DRAG_DELAY = 500
export const TOUCH_DRAG_TOLERANCE = 8

/** True when the drag was started by a finger (dnd-kit's `activatorEvent`). */
export function isTouchDrag(activatorEvent: Event | null): boolean {
  return activatorEvent?.type.startsWith('touch') === true
}

/**
 * Where a dragged chip lands when it is let go over `target` (null: over no line and not
 * over the tray).
 *
 * With a mouse, letting go over nothing puts a chip from a line back in the tray. With a
 * finger it changes nothing (the chip stays where it was): a finger that picked up a chip
 * by mistake and slid off to scroll the page must never lose an answer. To put a chip
 * back with a finger, drop it on the tray (or tap it, then tap "put it back").
 */
export function landingOf(target: MoveTarget | null, touch: boolean): MoveTarget | null {
  if (target !== null) return target
  return touch ? null : { kind: 'tray' }
}

/**
 * dnd-kit's mouse sensor, started by the main button only. dnd-kit itself turns away only
 * the right button, so a press with the middle button started a drag (and, on Windows,
 * the browser's own middle-click scrolling at the same time).
 */
export class MainButtonMouseSensor extends MouseSensor {
  static override activators = [
    {
      eventName: 'onMouseDown' as const,
      handler: (
        { nativeEvent }: { nativeEvent: MouseEvent },
        options: MouseSensorOptions,
      ): boolean => {
        if (nativeEvent.button !== 0) return false
        options.onActivation?.({ event: nativeEvent })
        return true
      },
    },
  ]
}

/**
 * A drag that ends this close (pixels) to where it started is a tap: a slow tap or a
 * click with a shaky hand selects the chip, like a quick one does.
 */
export const TAP_SLOP = 10

/**
 * While a chip is held close to the top or the bottom edge of the window, the page
 * scrolls, so a line that is out of sight can still be reached. Never sideways.
 *
 * The band at each edge is thin: 8 % of the window, about 60 px on a phone. With the
 * dnd-kit default (20 %), lines 1 and 2 are inside the band when the table is at the top
 * of a phone screen, and the page slid away under a chip that was held over them.
 * dnd-kit scrolls only in a direction the pointer has moved in during this drag, so a
 * chip that is picked up in the tray and moved up does not scroll the page down.
 * `acceleration` 5 is half the default speed: at most about 1000 px a second.
 *
 * No layout-shift compensation: when a drag starts, the words above the chips change ("Drop
 * the chip on a line."), and the chips move a little. dnd-kit would scroll the whole page
 * to keep the picked-up chip where it was, so on the practice page (where the tray is the
 * taller column on a laptop) the table jumped about 20 px under the pointer at every drag.
 */
export const AUTO_SCROLL = {
  threshold: { x: 0, y: 0.08 },
  acceleration: 5,
  layoutShiftCompensation: false,
}

export interface Point {
  x: number
  y: number
}

/** The parts of a rectangle that hit-testing needs (a `DOMRect` fits). */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** Where a chip can be dropped, as rectangles on the screen. */
export interface DropZones {
  /** The tray. It is checked first, because on a phone it lies on top of the table. */
  tray: Box | null
  rows: readonly { fieldId: string; box: Box }[]
}

export function isInside(point: Point, box: Box): boolean {
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** What lies under a point: the tray, the cell of a line, or nothing (null). */
export function targetAt(point: Point, zones: DropZones): MoveTarget | null {
  if (zones.tray !== null && isInside(point, zones.tray)) return { kind: 'tray' }
  const row = zones.rows.find((entry) => isInside(point, entry.box))
  return row === undefined ? null : { kind: 'cell', fieldId: row.fieldId }
}

/**
 * Read the drop zones of one trace table from the page. The tray carries
 * `data-trace-tray` and every row of the table `data-trace-field="<field id>"`.
 */
export function readDropZones(root: ParentNode): DropZones {
  const tray = root.querySelector('[data-trace-tray]')
  const rows = [...root.querySelectorAll<HTMLElement>('[data-trace-field]')].map((row) => ({
    fieldId: row.dataset.traceField ?? '',
    box: row.getBoundingClientRect(),
  }))
  return { tray: tray === null ? null : tray.getBoundingClientRect(), rows }
}

/**
 * dnd-kit asks this while a chip is dragged: which drop place is the pointer over?
 * It gives the tray when the pointer is over the tray, else the row under the pointer.
 */
export const pointerCollision: CollisionDetection = ({
  droppableContainers,
  pointerCoordinates,
}) => {
  if (pointerCoordinates === null) return []
  let row: (typeof droppableContainers)[number] | null = null
  for (const container of droppableContainers) {
    const node = container.node.current
    if (node === null || !isInside(pointerCoordinates, node.getBoundingClientRect())) continue
    if (container.id === TRAY_DROP_ID) return [{ id: container.id }]
    row ??= container
  }
  return row === null ? [] : [{ id: row.id }]
}

/** Where the pointer was when a mouse or touch event happened, or null if it cannot be told. */
export function pointOf(event: Event): Point | null {
  if ('changedTouches' in event) {
    const touches = (event as TouchEvent).changedTouches
    const touch = touches.length > 0 ? touches[0] : undefined
    return touch === undefined ? null : { x: touch.clientX, y: touch.clientY }
  }
  if ('clientX' in event) {
    const mouse = event as MouseEvent
    return { x: mouse.clientX, y: mouse.clientY }
  }
  return null
}

export interface ReleaseWatch {
  /** Stop watching. Safe to call more than once. */
  stop: () => void
}

/**
 * Watch for the end of the drag that `activator` (a `mousedown` or `touchstart`)
 * started. Exactly one of the two callbacks runs, once:
 *
 * - `onRelease(point)` when the button or the finger goes up (`point` is where);
 * - `onCancel()` when the drag is given up: Escape, a cancelled touch, the window
 *   changing size or going to the background (the moments dnd-kit cancels a drag too).
 *
 * The listeners run in the capture phase, so they see the event before dnd-kit does.
 */
export function watchRelease(
  activator: Event,
  onRelease: (point: Point | null) => void,
  onCancel: () => void,
): ReleaseWatch {
  const touch = activator.type.startsWith('touch')
  const view = document.defaultView
  let watching = true

  const stop = () => {
    if (!watching) return
    watching = false
    document.removeEventListener(touch ? 'touchend' : 'mouseup', release, true)
    document.removeEventListener('touchcancel', cancel, true)
    document.removeEventListener('keydown', escape, true)
    document.removeEventListener('visibilitychange', cancel, true)
    view?.removeEventListener('resize', cancel)
  }
  function release(event: Event) {
    stop()
    onRelease(pointOf(event))
  }
  function cancel() {
    stop()
    onCancel()
  }
  function escape(event: KeyboardEvent) {
    if (event.code === 'Escape' || event.key === 'Escape') cancel()
  }

  document.addEventListener(touch ? 'touchend' : 'mouseup', release, true)
  document.addEventListener('touchcancel', cancel, true)
  document.addEventListener('keydown', escape, true)
  document.addEventListener('visibilitychange', cancel, true)
  view?.addEventListener('resize', cancel)
  return { stop }
}

/** True when the student asked the device for less motion. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * After a drop the chip glides the last bit into its place. While it glides, the real
 * chip under it is hidden (so the chip is not seen twice) and the gliding copy lets
 * clicks through (so the chip can be picked up again at once).
 */
export const DROP_ANIMATION: DropAnimation = {
  duration: 160,
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  sideEffects: defaultDropAnimationSideEffects({
    styles: { active: { opacity: '0' } },
    className: { dragOverlay: 'pointer-events-none' },
  }),
}
