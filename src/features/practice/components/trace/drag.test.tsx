// @vitest-environment jsdom
/**
 * The logic of a drag, without a real browser.
 *
 * jsdom has no layout, so this file gives the rows and the tray made-up places on the
 * screen and sends the events a drag is made of: `mousedown` on a chip, `mousemove` and
 * `mouseup` on the page; or `touchstart`, a wait, `touchmove` and `touchend` on the chip.
 * That runs the real dnd-kit sensors and the real drop rules. Whether a drag looks and
 * feels right is checked in a browser (e2e/trace-table.spec.ts).
 *
 *        x: 0 ……… 300        400 ……… 700
 *   y: 100–200  line 1        ┌─────────┐
 *      200–300  line 2        │  tray   │ y: 0–600
 *        …                    └─────────┘
 *      500–600  line 5
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode, useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Problem } from '../../types'
import TraceTableView from '../TraceTableView'
import {
  pointerCollision,
  pointOf,
  prefersReducedMotion,
  readDropZones,
  TOUCH_DRAG_DELAY,
  TRAY_DROP_ID,
  watchRelease,
} from './dnd'
import { howOfClick } from './input'
import { SAMPLE_PROBLEMS } from './sampleProblems'

// Count how often the rows are drawn: every row draws one <CodeLine>.
const drawn = vi.hoisted(() => ({ codeLines: 0 }))
vi.mock('./CodeLine', () => ({
  CodeLine: ({ text }: { text: string }) => {
    drawn.codeLines += 1
    return <code>{text}</code>
  },
}))

function sampleProblem(index: number): Problem {
  const problem = SAMPLE_PROBLEMS[index]
  if (problem === undefined) throw new Error(`There is no sample problem ${index + 1}.`)
  return problem
}

const P1 = sampleProblem(0)
const A = 'rax = 0x0000000000000005'
const B = 'rbx = 0x0000000000000015'
const C = 'rcx = 0xaaaabbbbccccdd7f'
/** The name of line 1 when it is empty and nothing is selected or dragged. */
const EMPTY_1 = 'Line 1, changed: empty, put a chip here'

function box(left: number, top: number, width: number, height: number): DOMRect {
  const rect = {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  }
  return { ...rect, toJSON: () => rect }
}

beforeEach(() => {
  // After a drag, dnd-kit swallows clicks for 50 ms (a timer). With fake timers the
  // tests can run that time out at once, so one test never leaks into the next.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  drawn.codeLines = 0
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('[data-trace-tray]')) return box(400, 0, 300, 600)
    if (this.matches('[data-trace-field]')) {
      const line = Number((this as HTMLElement).dataset.traceRow)
      return box(0, line * 100, 300, 100)
    }
    return box(0, 0, 0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** The middle of a line of the table, the middle of the tray, and a place that is neither. */
const lineAt = (line: number) => ({ clientX: 150, clientY: line * 100 + 50 })
const TRAY_AT = { clientX: 550, clientY: 300 }
const NOWHERE = { clientX: 350, clientY: 30 }

function Page({
  start = {},
  locked = false,
  onCall,
}: {
  start?: Record<string, string>
  locked?: boolean
  onCall?: (fieldId: string, value: string) => void
}): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>(start)
  return (
    <StrictMode>
      <TraceTableView
        problem={P1}
        answers={answers}
        onChange={(fieldId, value) => {
          onCall?.(fieldId, value)
          setAnswers((old) => ({ ...old, [fieldId]: value }))
        }}
        locked={locked}
        result={null}
      />
    </StrictMode>
  )
}

function tray(): HTMLElement {
  return screen.getByRole('group', { name: /^Chips/ })
}
function trayChip(label: string): HTMLElement {
  return within(tray()).getByRole('button', { name: label })
}
function cell(line: number): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^Line ${line}, changed:`) })
}
function row(line: number): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-trace-row="${line}"]`)
  if (found === null) throw new Error(`No row ${line}.`)
  return found
}
function heard(): string {
  return (screen.getByTestId('trace-announcer').textContent ?? '').replace(/\u00a0/g, '')
}
function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-trace-overlay]')
}

type At = { clientX: number; clientY: number }

/** Press the mouse on a chip and move far enough for the drag to start. */
function pickUp(chip: HTMLElement, from: At): void {
  fireEvent.mouseDown(chip, { button: 0, ...from })
  fireEvent.mouseMove(document.body, { clientX: from.clientX + 20, clientY: from.clientY + 5 })
}
function moveTo(to: At): void {
  fireEvent.mouseMove(document.body, to)
}
function letGo(at: At): void {
  fireEvent.mouseUp(document.body, at)
}
function drag(chip: HTMLElement, from: At, to: At): void {
  pickUp(chip, from)
  moveTo(to)
  letGo(to)
}
/** Let the chip under the pointer go away (dnd-kit removes it a moment after the drop). */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
/** Something that happens to the page from outside while a drag is going on. */
function happen(name: string): void {
  act(() => {
    window.dispatchEvent(new Event(name))
  })
}

describe('dragging with the mouse', () => {
  it('drops a chip from the tray on a line', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    drag(trayChip(A), TRAY_AT, lineAt(2))

    expect(onCall.mock.calls).toEqual([['line2', 'p1-a']])
    expect(cell(2).getAttribute('aria-label')).toBe(`Line 2, changed: ${A}`)
    expect(within(tray()).queryByRole('button', { name: A })).toBeNull()
    expect(heard()).toBe(`${A} placed on line 2.`)
  })

  it('shows the chip under the pointer, marks the line and names it on the chip', async () => {
    render(<Page />)
    pickUp(trayChip(A), TRAY_AT)
    expect(overlay()?.textContent).toContain(A)
    expect(trayChip(A).className).toContain('opacity-40')
    expect(tray().textContent).toContain('Drop the chip on a line.')
    expect(cell(1).textContent).toBe('drop a chip here')

    moveTo(lineAt(3))
    expect(row(3).hasAttribute('data-over')).toBe(true)
    expect(cell(3).textContent).toBe('drop it here')
    expect(cell(3).className).toContain('border-solid')
    expect(row(2).hasAttribute('data-over')).toBe(false)
    expect(overlay()?.querySelector('[data-trace-drag-tag]')?.textContent).toBe('line 3')

    moveTo(NOWHERE)
    expect(row(3).hasAttribute('data-over')).toBe(false)
    expect(overlay()?.querySelector('[data-trace-drag-tag]')).toBeNull()

    letGo(NOWHERE)
    await settle()
    expect(overlay()).toBeNull()
    expect(trayChip(A).className).not.toContain('opacity-40')
  })

  it('replaces the chip of a filled line; the old chip is back in the tray', () => {
    const onCall = vi.fn()
    render(<Page start={{ line2: 'p1-b' }} onCall={onCall} />)
    pickUp(trayChip(A), TRAY_AT)
    moveTo(lineAt(2))
    expect(cell(2).textContent).toContain('drop to replace')
    letGo(lineAt(2))

    expect(onCall.mock.calls).toEqual([['line2', 'p1-a']])
    expect(trayChip(B)).toBeTruthy()
    expect(heard()).toBe(`${A} placed on line 2. ${B} is back with the other chips.`)
  })

  it('moves a placed chip to another line with two calls', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)
    drag(cell(1), lineAt(1), lineAt(4))

    expect(onCall.mock.calls).toEqual([
      ['line1', ''],
      ['line4', 'p1-a'],
    ])
    expect(cell(1).getAttribute('aria-label')).toBe(EMPTY_1)
    expect(cell(4).getAttribute('aria-label')).toBe(`Line 4, changed: ${A}`)
    expect(heard()).toBe(`${A} moved from line 1 to line 4.`)
  })

  it('puts a placed chip back when it is dropped on the tray', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)
    pickUp(cell(1), lineAt(1))
    moveTo(TRAY_AT)
    const hint = tray().querySelector('[data-trace-put-back-hint]')
    expect(hint?.textContent).toBe('drop here to put it back')
    expect(hint?.getAttribute('data-trace-put-back-hint')).toBe('over')
    expect(overlay()?.querySelector('[data-trace-drag-tag]')?.textContent).toBe('put back')
    letGo(TRAY_AT)

    expect(onCall.mock.calls).toEqual([['line1', '']])
    expect(trayChip(A)).toBeTruthy()
    expect(heard()).toBe(`Line 1 cleared. ${A} is back with the other chips.`)
  })

  it('puts a placed chip back when it is dropped outside every line', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)
    drag(cell(1), lineAt(1), NOWHERE)
    expect(onCall.mock.calls).toEqual([['line1', '']])
    expect(trayChip(A)).toBeTruthy()
  })

  it('changes nothing when a chip from the tray is dropped on the tray or outside', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    drag(trayChip(A), TRAY_AT, NOWHERE)
    drag(trayChip(A), TRAY_AT, { clientX: 600, clientY: 500 })
    expect(onCall).not.toHaveBeenCalled()
    expect(heard()).toBe('')
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
  })

  it('changes nothing when a placed chip is dropped on its own line', () => {
    const onCall = vi.fn()
    render(<Page start={{ line2: 'p1-b' }} onCall={onCall} />)
    drag(cell(2), lineAt(2), { clientX: 30, clientY: 290 })
    expect(onCall).not.toHaveBeenCalled()
    expect(cell(2).getAttribute('aria-label')).toBe(`Line 2, changed: ${B}`)
  })

  it('lands where the pointer is let go, even when no move came before', () => {
    // A very fast drag: the release is the first event that carries the new position.
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    pickUp(trayChip(A), TRAY_AT)
    letGo(lineAt(5))
    expect(onCall.mock.calls).toEqual([['line5', 'p1-a']])
  })

  it('does not start on a plain press and release', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    fireEvent.mouseDown(trayChip(A), { button: 0, ...TRAY_AT })
    fireEvent.mouseMove(document.body, { clientX: 552, clientY: 301 })
    expect(overlay()).toBeNull()
    fireEvent.mouseUp(document.body, { clientX: 552, clientY: 301 })
    expect(onCall).not.toHaveBeenCalled()
  })

  it('treats a press that slips a few pixels as a tap: the chip is selected', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    fireEvent.mouseDown(trayChip(A), { button: 0, ...TRAY_AT })
    fireEvent.mouseMove(document.body, { clientX: 557, clientY: 302 }) // 7 px: a drag starts
    expect(overlay()).not.toBeNull()
    fireEvent.mouseUp(document.body, { clientX: 557, clientY: 302 })

    expect(onCall).not.toHaveBeenCalled()
    expect(trayChip(A).getAttribute('aria-pressed')).toBe('true')
    expect(cell(1).textContent).toBe('click to place here')
  })

  it('treats a slipped press on the selected chip as the second tap: it cancels', () => {
    render(<Page />)
    fireEvent.click(trayChip(A), { detail: 1 })
    fireEvent.mouseDown(trayChip(A), { button: 0, ...TRAY_AT })
    fireEvent.mouseMove(document.body, { clientX: 557, clientY: 302 })
    fireEvent.mouseUp(document.body, { clientX: 557, clientY: 302 })
    expect(trayChip(A).getAttribute('aria-pressed')).toBe('false')
    expect(heard()).toBe(`${A} is not selected any more.`)
  })

  it('forgets a selected chip when another chip is dragged', () => {
    render(<Page />)
    fireEvent.click(trayChip(B), { detail: 1 })
    pickUp(trayChip(A), TRAY_AT)
    expect(trayChip(B).getAttribute('aria-pressed')).toBe('false')
    expect(cell(1).textContent).toBe('drop a chip here')
    letGo(lineAt(1))
    expect(cell(1).getAttribute('aria-label')).toBe(`Line 1, changed: ${A}`)
  })

  it('gives up the drag on Escape: the later release changes nothing', async () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)
    pickUp(cell(1), lineAt(1))
    moveTo(lineAt(3))
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    await settle()
    expect(overlay()).toBeNull()
    letGo(lineAt(3))

    expect(onCall).not.toHaveBeenCalled()
    expect(cell(1).getAttribute('aria-label')).toBe(`Line 1, changed: ${A}`)
  })

  it.each([
    ['the right button', 2],
    ['the middle button (the wheel)', 1],
  ])('does not start a drag with %s', (_name, button) => {
    // dnd-kit itself turns away only the right button; the middle one also started the
    // browser's own scrolling on Windows.
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    fireEvent.mouseDown(trayChip(A), { button, ...TRAY_AT })
    fireEvent.mouseMove(document.body, lineAt(1))
    expect(overlay()).toBeNull()
    fireEvent.mouseUp(document.body, lineAt(1))
    expect(cell(1).getAttribute('aria-label')).toBe(EMPTY_1)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('moves the focus with a chip that is dragged out of the tray', () => {
    render(<Page />)
    trayChip(A).focus()
    drag(trayChip(A), TRAY_AT, lineAt(2))
    expect(document.activeElement).toBe(cell(2))
  })

  it('does not draw the rows again while the pointer moves', () => {
    render(<Page />)
    pickUp(trayChip(A), TRAY_AT)
    moveTo(lineAt(2))
    const before = drawn.codeLines
    for (let step = 0; step < 40; step++) {
      moveTo({ clientX: 20 + step * 6, clientY: 210 + step * 2 }) // all inside line 2
    }
    expect(drawn.codeLines).toBe(before)
    expect(row(2).hasAttribute('data-over')).toBe(true)
    letGo(lineAt(2))
  })

  it('stops watching for the release when the table goes away in the middle of a drag', () => {
    const onCall = vi.fn()
    const { unmount } = render(<Page onCall={onCall} />)
    pickUp(trayChip(A), TRAY_AT)
    unmount()
    letGo(lineAt(1))
    expect(onCall).not.toHaveBeenCalled()
  })

  it('ignores a drop that comes after the table was locked', () => {
    const onCall = vi.fn()
    function Lockable(): ReactNode {
      const [locked, setLocked] = useState(false)
      useEffect(() => {
        const lock = () => setLocked(true)
        window.addEventListener('test:lock', lock)
        return () => window.removeEventListener('test:lock', lock)
      }, [])
      return <Page locked={locked} onCall={onCall} />
    }
    render(<Lockable />)
    pickUp(trayChip(A), TRAY_AT)
    happen('test:lock')
    letGo(lineAt(1))
    expect(onCall).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[data-trace-table] button')).toHaveLength(0)
  })

  it('ignores a drop that comes after the problem changed', () => {
    const onCall = vi.fn()
    const P2 = sampleProblem(1)
    function Switching(): ReactNode {
      const [problem, setProblem] = useState(P1)
      useEffect(() => {
        const next = () => setProblem(P2)
        window.addEventListener('test:next', next)
        return () => window.removeEventListener('test:next', next)
      }, [])
      return (
        <TraceTableView
          problem={problem}
          answers={{}}
          onChange={onCall}
          locked={false}
          result={null}
        />
      )
    }
    render(<Switching />)
    pickUp(trayChip(A), TRAY_AT)
    happen('test:next')
    letGo(lineAt(1))
    expect(onCall).not.toHaveBeenCalled()
    expect(cell(1).getAttribute('aria-label')).toBe(EMPTY_1)
    expect(within(tray()).getAllByRole('button')).toHaveLength(9)
  })
})

/**
 * A touch event at a point. jsdom has no `Touch` objects, so the lists of touches are
 * plain objects with the two fields dnd-kit and the table read.
 */
function touchAt(type: 'touchstart' | 'touchmove' | 'touchend', at: At): TouchEvent {
  const event = new TouchEvent(type, { bubbles: true, cancelable: true })
  const point = [{ clientX: at.clientX, clientY: at.clientY }]
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : point })
  Object.defineProperty(event, 'changedTouches', { value: point })
  return event
}

/** Let time pass while a finger rests on the screen (dnd-kit waits with a timer). */
function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

/**
 * A finger on a chip. Touch events always go to the element the finger first touched,
 * so the moves and the lift are sent to that element too.
 */
function finger(chip: HTMLElement, from: At) {
  fireEvent(chip, touchAt('touchstart', from))
  return {
    moveTo: (to: At) => fireEvent(chip, touchAt('touchmove', to)),
    lift: (at: At) => fireEvent(chip, touchAt('touchend', at)),
  }
}

describe('dragging with a finger', () => {
  it('waits for a long press (half a second) before a finger picks up a chip', () => {
    render(<Page />)
    finger(trayChip(A), TRAY_AT)
    wait(TOUCH_DRAG_DELAY - 50)
    expect(overlay()).toBeNull()
    wait(50)
    expect(overlay()?.textContent).toContain(A)
  })

  it('does not pick up a chip when the thumb rests a moment and then swipes', () => {
    // People rest a thumb on the screen for a moment before they swipe to scroll. With
    // a shorter wait, a rest of 0.3 s picked up the chip and the swipe dropped it.
    const onCall = vi.fn()
    render(<Page start={{ line3: 'p1-c' }} onCall={onCall} />)
    for (const [chip, from] of [
      [trayChip(B), TRAY_AT],
      [cell(3), lineAt(3)],
    ] as const) {
      const hand = finger(chip, from)
      wait(300)
      hand.moveTo({ clientX: from.clientX, clientY: from.clientY - 30 })
      wait(TOUCH_DRAG_DELAY)
      expect(overlay()).toBeNull()
      hand.moveTo(lineAt(2))
      hand.lift(lineAt(2))
    }
    expect(onCall).not.toHaveBeenCalled()
    expect(cell(3).getAttribute('aria-label')).toBe(`Line 3, changed: ${C}`)
  })

  it('places a chip that a long press picked up and a finger let go over a line', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    const hand = finger(trayChip(A), TRAY_AT)
    wait(TOUCH_DRAG_DELAY)
    hand.moveTo(lineAt(2))
    expect(row(2).hasAttribute('data-over')).toBe(true)
    hand.lift(lineAt(2))
    expect(onCall.mock.calls).toEqual([['line2', 'p1-a']])
    expect(heard()).toBe(`${A} placed on line 2.`)
  })

  it('puts a placed chip back when a finger lets go of it over the tray', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)
    const hand = finger(cell(1), lineAt(1))
    wait(TOUCH_DRAG_DELAY)
    hand.moveTo(TRAY_AT)
    expect(overlay()?.querySelector('[data-trace-drag-tag]')?.textContent).toBe('put back')
    hand.lift(TRAY_AT)
    expect(onCall.mock.calls).toEqual([['line1', '']])
  })

  it('changes nothing when a finger lets go of a chip outside every line and the tray', () => {
    // A thumb that picked up a chip by mistake and slid off to scroll must not lose an
    // answer. (A mouse that lets go outside puts a chip from a line back in the tray.)
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)
    const hand = finger(cell(1), lineAt(1))
    wait(TOUCH_DRAG_DELAY)
    hand.moveTo(NOWHERE)
    // Nothing says "put back" while the finger is over nothing.
    expect(overlay()?.querySelector('[data-trace-drag-tag]')).toBeNull()
    expect(
      tray().querySelector('[data-trace-put-back-hint]')?.getAttribute('data-trace-put-back-hint'),
    ).toBe('open')
    hand.lift(NOWHERE)

    expect(onCall).not.toHaveBeenCalled()
    expect(cell(1).getAttribute('aria-label')).toBe(`Line 1, changed: ${A}`)
    expect(heard()).toBe('')
  })

  it('treats a long press that is let go on the spot as a tap: the chip is selected', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    const hand = finger(trayChip(A), TRAY_AT)
    wait(TOUCH_DRAG_DELAY + 200)
    expect(overlay()).not.toBeNull()
    hand.lift(TRAY_AT)
    expect(onCall).not.toHaveBeenCalled()
    expect(trayChip(A).getAttribute('aria-pressed')).toBe('true')
  })
})

describe('what is under the pointer', () => {
  it('reads the places of the tray and of the rows from the page', () => {
    const { container } = render(<Page />)
    const zones = readDropZones(container)
    expect(zones.tray).toMatchObject({ left: 400, top: 0, right: 700, bottom: 600 })
    expect(zones.rows.map((entry) => entry.fieldId)).toEqual([
      'line1',
      'line2',
      'line3',
      'line4',
      'line5',
    ])
    expect(zones.rows[1]?.box).toMatchObject({ left: 0, top: 200, right: 300, bottom: 300 })
  })

  it('tells dnd-kit which place the pointer is over: the tray first, then a row', () => {
    const { container } = render(<Page />)
    const node = (selector: string) => ({
      current: container.querySelector<HTMLElement>(selector),
    })
    const containers = [
      { id: 'line1', node: node('[data-trace-row="1"]') },
      { id: 'line2', node: node('[data-trace-row="2"]') },
      { id: TRAY_DROP_ID, node: node('[data-trace-tray]') },
      { id: 'gone', node: { current: null } },
    ]
    const over = (x: number, y: number) =>
      pointerCollision({
        droppableContainers: containers,
        pointerCoordinates: { x, y },
      } as unknown as Parameters<typeof pointerCollision>[0]).map((hit) => hit.id)

    expect(over(150, 250)).toEqual(['line2'])
    expect(over(550, 250)).toEqual([TRAY_DROP_ID])
    expect(over(350, 250)).toEqual([])
    expect(
      pointerCollision({
        droppableContainers: containers,
        pointerCoordinates: null,
      } as unknown as Parameters<typeof pointerCollision>[0]),
    ).toEqual([])
  })
})

describe('watchRelease', () => {
  const press = (type: string) => new Event(type)

  it('reports where the mouse button went up, once', () => {
    const onRelease = vi.fn()
    const onCancel = vi.fn()
    watchRelease(press('mousedown'), onRelease, onCancel)
    fireEvent.mouseUp(document.body, { clientX: 12, clientY: 34 })
    fireEvent.mouseUp(document.body, { clientX: 56, clientY: 78 })
    expect(onRelease.mock.calls).toEqual([[{ x: 12, y: 34 }]])
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('sees the release before listeners in the bubble phase do', () => {
    const order: string[] = []
    const later = () => order.push('bubble')
    document.addEventListener('mouseup', later)
    watchRelease(
      press('mousedown'),
      () => order.push('watch'),
      () => {},
    )
    fireEvent.mouseUp(document.body)
    document.removeEventListener('mouseup', later)
    expect(order).toEqual(['watch', 'bubble'])
  })

  it('cancels on Escape, and then ignores the release', () => {
    const onRelease = vi.fn()
    const onCancel = vi.fn()
    watchRelease(press('mousedown'), onRelease, onCancel)
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' })
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' })
    fireEvent.mouseUp(document.body)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onRelease).not.toHaveBeenCalled()
  })

  it.each([
    ['the window changes size', () => fireEvent(window, new Event('resize'))],
    ['the page goes to the background', () => fireEvent(document, new Event('visibilitychange'))],
    [
      'the touch is cancelled',
      () => fireEvent(document.body, new Event('touchcancel', { bubbles: true })),
    ],
  ])('cancels when %s', (_name, happen) => {
    const onRelease = vi.fn()
    const onCancel = vi.fn()
    watchRelease(press('mousedown'), onRelease, onCancel)
    happen()
    fireEvent.mouseUp(document.body)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onRelease).not.toHaveBeenCalled()
  })

  it('watches touchend for a touch and ignores the mouse', () => {
    const onRelease = vi.fn()
    watchRelease(press('touchstart'), onRelease, () => {})
    fireEvent.mouseUp(document.body, { clientX: 1, clientY: 2 })
    expect(onRelease).not.toHaveBeenCalled()

    const lift = new Event('touchend', { bubbles: true })
    Object.defineProperty(lift, 'changedTouches', { value: [{ clientX: 40, clientY: 50 }] })
    fireEvent(document.body, lift)
    expect(onRelease.mock.calls).toEqual([[{ x: 40, y: 50 }]])
  })

  it('stops when asked, and stopping twice is fine', () => {
    const onRelease = vi.fn()
    const watch = watchRelease(press('mousedown'), onRelease, () => {})
    watch.stop()
    watch.stop()
    fireEvent.mouseUp(document.body)
    expect(onRelease).not.toHaveBeenCalled()
  })

  it('reads the position of mouse and touch events', () => {
    expect(pointOf(new MouseEvent('mouseup', { clientX: 3, clientY: 4 }))).toEqual({ x: 3, y: 4 })
    const touch = new Event('touchend')
    Object.defineProperty(touch, 'changedTouches', { value: [{ clientX: 5, clientY: 6 }] })
    expect(pointOf(touch)).toEqual({ x: 5, y: 6 })
    const empty = new Event('touchend')
    Object.defineProperty(empty, 'changedTouches', { value: [] })
    expect(pointOf(empty)).toBeNull()
    expect(pointOf(new Event('keydown'))).toBeNull()
  })
})

describe('how the student acts', () => {
  const click = (detail: number, pointerType?: string) => ({
    detail,
    nativeEvent: Object.assign(
      new Event('click'),
      pointerType === undefined ? {} : { pointerType },
    ),
  })

  it('knows a keyboard click by its detail of 0', () => {
    expect(howOfClick(click(0, 'mouse'))).toBe('keyboard')
  })

  it('uses what the browser says about the pointer', () => {
    expect(howOfClick(click(1, 'touch'))).toBe('touch')
    expect(howOfClick(click(1, 'mouse'))).toBe('mouse')
    expect(howOfClick(click(1, 'pen'))).toBe('mouse')
  })

  it('falls back to the kind of device when the browser does not say', () => {
    expect(howOfClick(click(1))).toBe('mouse')
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
    expect(howOfClick(click(1))).toBe('touch')
  })

  it('respects a wish for less motion', () => {
    expect(prefersReducedMotion()).toBe(false)
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }))
    expect(prefersReducedMotion()).toBe(true)
  })
})
