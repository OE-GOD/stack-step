import type { ReactNode } from 'react'
import { cx } from '../../components/ui/cx'
import type { SessionState } from './session'
import { statusOf, stepsText, type StatusKind } from './status'

/** The shape in front of the status word: the state never depends on color alone. */
function StatusShape({ kind }: { kind: StatusKind }): ReactNode {
  const base = 'inline-block size-2.5 shrink-0'
  switch (kind) {
    case 'running':
      return (
        <span aria-hidden="true" className={cx(base, 'animate-pulse rounded-full bg-primary')} />
      )
    case 'paused':
      return <span aria-hidden="true" className={cx(base, 'rounded-[2px] bg-primary')} />
    case 'waiting':
      return <span aria-hidden="true" className={cx(base, 'rounded-full border-2 border-warn')} />
    case 'ended':
      return <span aria-hidden="true" className={cx(base, 'rounded-full bg-good')} />
    case 'error':
    case 'problems':
      return <span aria-hidden="true" className={cx(base, 'rotate-45 bg-bad')} />
    case 'ready':
      return <span aria-hidden="true" className={cx(base, 'rounded-full border-2 border-muted')} />
  }
}

export interface StatusLineProps {
  state: SessionState
  className?: string
}

/**
 * "■ Paused at line 14 · 5 steps": the status word with its shape, and the step count.
 * The page shows it in the bottom bar on phones and in the Explanation card on wide
 * screens (one of the two is hidden with CSS, so screen readers meet it once).
 */
export function StatusLine({ state, className }: StatusLineProps): ReactNode {
  const status = statusOf(state)
  const steps = state.machine === null ? null : stepsText(state.machine.stepCount)
  return (
    <p
      data-stepper-status={status.kind}
      className={cx('flex min-w-0 items-center gap-2 text-sm', className)}
    >
      <StatusShape kind={status.kind} />
      {/* The comma for screen readers sits inside the same element as the words: between
          two flex items a screen reader would read a space before it. */}
      <span className="font-semibold text-ink">
        {status.text}
        {steps !== null && <span className="sr-only">,</span>}
      </span>
      {steps !== null && (
        <>
          <span aria-hidden="true" className="text-muted">
            ·
          </span>
          <span className="whitespace-nowrap text-muted">{steps}</span>
        </>
      )}
    </p>
  )
}
