import { useCallback, useSyncExternalStore } from 'react'

/** False when the browser has no `matchMedia` (a test page, a very old browser). */
function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/**
 * True while the CSS media query matches. Known on the first render (matchMedia answers
 * at once), so the page never draws the wrong layout first. Without `matchMedia` it is
 * always false (the narrow layout, which works everywhere) instead of crashing the page.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!canMatch()) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  const matches = useCallback(() => canMatch() && window.matchMedia(query).matches, [query])
  return useSyncExternalStore(subscribe, matches, () => false)
}

/** The stepper's wide layout: three columns, no tabs, no bar at the bottom. */
export const WIDE_LAYOUT = '(min-width: 64rem)'

/** The main pointer is a finger (a phone or a tablet): there is an on-screen keyboard. */
export const TOUCH_SCREEN = '(pointer: coarse)'
