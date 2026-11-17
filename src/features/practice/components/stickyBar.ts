/**
 * Room above the bar that sticks to the bottom of a phone screen (the practice card's
 * Check / Next bar, the quiz's Back / Next bar).
 *
 * When the keyboard focus moves (Tab, or a page that moves the focus itself), the browser
 * scrolls the focused field, link or button just into view: at the very bottom of the
 * screen, under the bar, where nobody can see it. While the bar sticks, the page's
 * `scroll-padding-bottom` is kept equal to the bar's height plus a small gap, so the
 * browser stops every focused element above the bar instead. The bar's height is measured
 * again whenever it changes (a sentence appears in it, the screen turns).
 */
import { useEffect, type RefObject } from 'react'

/** Room between the bar and the focused element, for its focus ring (px). */
const GAP = 12

/** The `scroll-padding-bottom` that keeps the page clear of `bar`, or null when it does not stick. */
export function roomAbove(bar: HTMLElement): string | null {
  if (getComputedStyle(bar).position !== 'sticky') return null
  return `${Math.ceil(bar.getBoundingClientRect().height) + GAP}px`
}

/**
 * Keep the page's scroll padding clear of `bar` while `active` (the bar can stick) and the
 * component is on the page. Leaves the page as it was when it stops.
 */
export function useRoomAboveStickyBar(bar: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const element = bar.current
    if (!active || element === null) return
    const page = document.documentElement
    let kept = false
    const update = () => {
      const room = roomAbove(element)
      if (room !== null) {
        page.style.setProperty('scroll-padding-bottom', room)
        kept = true
      } else if (kept) {
        page.style.removeProperty('scroll-padding-bottom')
        kept = false
      }
    }
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(element)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      if (kept) page.style.removeProperty('scroll-padding-bottom')
    }
  }, [bar, active])
}

/** Room above and below the feedback and the main button when they are shown together (px). */
const EDGE = 16

/**
 * After Check, when the main button does not stick to the screen (a trace table, or any
 * problem on a wide screen) and it has the keyboard focus: scroll so that the feedback AND
 * the button below it are in view together, when they fit on the screen. Then a keyboard
 * user sees the result and where the focus is. When they do not fit, the top of the
 * feedback comes first (it says what went wrong).
 */
export function revealWithButton(
  feedback: HTMLElement,
  button: HTMLElement,
  behavior: ScrollBehavior,
): void {
  const top = feedback.getBoundingClientRect().top - EDGE
  const bottom = button.getBoundingClientRect().bottom + EDGE
  const view = window.innerHeight
  if (bottom - top > view) {
    feedback.scrollIntoView({ block: 'nearest', behavior })
    return
  }
  if (top >= 0 && bottom <= view) return
  window.scrollBy({ top: top < 0 ? top : bottom - view, behavior })
}
