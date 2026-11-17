import { useLayoutEffect, useRef, useState } from 'react'

/** How long a button ignores presses after it changes its job or appears. */
export const PRESS_GUARD_MS = 600

export interface PressGuard {
  /** False during the wait: give the button `aria-disabled` then (tests wait for it too). */
  settled: boolean
  /** True when a press now should count. Call it first thing in the click handler. */
  accepts: () => boolean
  /** The button changes its job right now (call it in the handler that changes it). */
  restart: () => void
}

/**
 * A guard against double taps. One button often does two jobs in the same place (Check,
 * then "Next problem"), and a new screen can put a button under the finger that just
 * tapped. Without a guard, the second tap of a double tap does the second job: it skips
 * the feedback, or checks a problem the student has not seen.
 *
 * `job` names what the button does now. For `PRESS_GUARD_MS` after the button appears,
 * and after `job` changes, presses are ignored.
 */
export function usePressGuard(job: string): PressGuard {
  const since = useRef(0)
  const [settledJob, setSettledJob] = useState<string | null>(null)

  useLayoutEffect(() => {
    since.current = performance.now()
    const timer = window.setTimeout(() => setSettledJob(job), PRESS_GUARD_MS)
    return () => window.clearTimeout(timer)
  }, [job])

  return {
    settled: settledJob === job,
    accepts: () => performance.now() - since.current >= PRESS_GUARD_MS,
    restart: () => {
      since.current = performance.now()
    },
  }
}
