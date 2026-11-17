// @vitest-environment jsdom
/**
 * The scroll helpers of the practice card's bar. The real scrolling is tested in a browser
 * (e2e/practice.spec.ts: "Tab never leaves the focus under the bar", "after Check with the
 * keyboard, Next problem is in view with the feedback"); here, the decisions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealWithButton, roomAbove } from './stickyBar'

function boxAt(element: HTMLElement, top: number, height: number): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('the room above a bar that sticks to the bottom', () => {
  it('is the height of the bar and a small gap, only while the bar sticks', () => {
    const bar = document.createElement('div')
    document.body.append(bar)
    boxAt(bar, 671, 69)
    bar.style.position = 'sticky'
    expect(roomAbove(bar)).toBe('81px')
    bar.style.position = 'static'
    expect(roomAbove(bar)).toBeNull()
  })
})

describe('revealWithButton (after Check, the focus on the main button)', () => {
  function setUp(feedbackTop: number, feedbackHeight: number, buttonTop: number) {
    const feedback = document.createElement('div')
    const button = document.createElement('button')
    document.body.append(feedback, button)
    boxAt(feedback, feedbackTop, feedbackHeight)
    boxAt(button, buttonTop, 44)
    const scrollBy = vi.fn()
    window.scrollBy = scrollBy
    const intoView = vi.fn()
    feedback.scrollIntoView = intoView
    return { feedback, button, scrollBy, intoView }
  }

  it('scrolls the feedback and the button into view together when they fit', () => {
    // The browser review: the button ended at 861 in a 768 px high window.
    window.innerHeight = 768
    const { feedback, button, scrollBy, intoView } = setUp(500, 250, 817)
    revealWithButton(feedback, button, 'auto')
    // The button's bottom (861) plus 16 px must reach 768: 109 px down.
    expect(scrollBy).toHaveBeenCalledWith({ top: 109, behavior: 'auto' })
    expect(intoView).not.toHaveBeenCalled()
  })

  it('scrolls up when the feedback starts above the window', () => {
    window.innerHeight = 800
    const { feedback, button, scrollBy } = setUp(-40, 200, 300)
    revealWithButton(feedback, button, 'smooth')
    expect(scrollBy).toHaveBeenCalledWith({ top: -56, behavior: 'smooth' })
  })

  it('does nothing when both are in view already', () => {
    window.innerHeight = 800
    const { feedback, button, scrollBy, intoView } = setUp(100, 200, 400)
    revealWithButton(feedback, button, 'auto')
    expect(scrollBy).not.toHaveBeenCalled()
    expect(intoView).not.toHaveBeenCalled()
  })

  it('shows the top of the feedback first when the two do not fit on the screen', () => {
    window.innerHeight = 600
    const { feedback, button, scrollBy, intoView } = setUp(700, 900, 1650)
    revealWithButton(feedback, button, 'auto')
    expect(intoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' })
    expect(scrollBy).not.toHaveBeenCalled()
  })
})
