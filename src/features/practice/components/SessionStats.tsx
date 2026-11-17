import type { ReactNode } from 'react'
import { cx } from '../../../components/ui/cx'
import type { SessionScore } from '../session'

export interface SessionStatsProps {
  score: SessionScore
  className?: string
}

/**
 * This session's score, and how many of the latest answers were right one after another
 * (the streak; the word itself is not used, and neither is the idiom "in a row").
 */
export function SessionStats({ score, className }: SessionStatsProps): ReactNode {
  return (
    <p
      className={cx('flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted', className)}
      data-session-stats=""
    >
      <span>
        This session:{' '}
        <strong className="text-ink tabular-nums" data-session-score="">
          {score.right} of {score.total} right
        </strong>
      </span>
      <span>
        Right answers one after another:{' '}
        <strong className="text-ink tabular-nums" data-session-streak="">
          {score.streak}
        </strong>
      </span>
    </p>
  )
}
