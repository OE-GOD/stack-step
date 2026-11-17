import type { ReactNode } from 'react'
import { cx } from '../../components/ui/cx'
import { toPercent } from './summary'

export interface MeterProps {
  /** How full the bar is, from 0 (empty) to 1 (full). */
  share: number
  className?: string
}

/**
 * A bar that shows a share as a length. It is a picture only: the number is always
 * written next to it, so the bar never carries the meaning alone and screen readers
 * skip it.
 */
export function Meter({ share, className }: MeterProps): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'block h-2.5 overflow-hidden rounded-full border border-line-strong bg-surface-2',
        className,
      )}
    >
      <span className="block h-full bg-primary" style={{ width: `${toPercent(share)}%` }} />
    </span>
  )
}
