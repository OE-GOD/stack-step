import type { ReactNode } from 'react'
import { Badge } from '../../../components/ui/Badge'
import { cx } from '../../../components/ui/cx'
import { CheckIcon } from '../../../components/ui/icons'

/**
 * "Done" with a check mark: a finished lesson (the same mark as on the progress page).
 * The kit's badge is 14 px on a narrow screen and 12 px on a wide one; the check mark
 * grows with the word.
 */
export function DoneMark({ className }: { className?: string }): ReactNode {
  return (
    <Badge tone="good" data-done-mark="" className={cx('shrink-0', className)}>
      <CheckIcon size={12} strokeWidth={3} className="max-md:size-3.5" />
      Done
    </Badge>
  )
}
