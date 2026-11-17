import type { ReactNode } from 'react'
import { cx } from '../ui/cx'

export interface ChangedMarkProps {
  changed: boolean
  className?: string
}

/**
 * The "just changed" mark: an orange dot (8 px, big enough to see on a projector), and the
 * word "changed" for screen readers. The dot is a shape, so the mark never depends on color
 * alone (the text next to it is bold too). When `changed` is false it keeps its place, empty,
 * so nothing moves.
 */
export function ChangedMark({ changed, className }: ChangedMarkProps): ReactNode {
  return (
    <>
      <span
        aria-hidden="true"
        className={cx(
          'inline-block size-2 shrink-0 rounded-full',
          changed ? 'bg-changed forced-colors:bg-[Highlight]' : 'bg-transparent',
          className,
        )}
      />
      {changed && <span className="sr-only"> changed</span>}
    </>
  )
}
