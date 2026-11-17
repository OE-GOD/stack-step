import type { ReactNode } from 'react'
import { cx } from '../../../components/ui/cx'

export interface ProgressBarProps {
  /** How many are done. */
  done: number
  /** How many there are. */
  total: number
  className?: string
}

/**
 * A bar that shows a share as a length. It is a picture only: the numbers are always
 * written next to it, so screen readers skip it.
 */
export function ProgressBar({ done, total, className }: ProgressBarProps): ReactNode {
  const percent = total <= 0 ? 0 : Math.round((Math.min(done, total) / total) * 100)
  return (
    <span
      aria-hidden="true"
      className={cx(
        'block h-2.5 overflow-hidden rounded-full border border-line-strong bg-surface-2',
        className,
      )}
    >
      <span className="block h-full bg-primary" style={{ width: `${percent}%` }} />
    </span>
  )
}
