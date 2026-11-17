import type { ReactNode } from 'react'
import { ButtonLink } from '../../../components/ui/ButtonLink'
import { ArrowRightIcon } from '../../../components/ui/icons'
import { RichText } from '../../../components/ui/RichText'
import type { Topic } from '../../../content/topics'
import { accuracy, recentAnswersWords, type TopicStats } from '../../../lib/progress'
import { Meter } from '../../progress/Meter'

/** "Recent accuracy: 80% (4 right of your last 5)", as on the progress page. */
function accuracyText(stats: TopicStats, share: number): string {
  const right = stats.recent.filter(Boolean).length
  const count = stats.recent.length
  return `Recent accuracy: ${Math.round(share * 100)}% (${recentAnswersWords(right, count)})`
}

export interface TopicCardProps {
  topic: Topic
  stats: TopicStats | undefined
}

/** A practice topic on the hub: its name, what it is about, the accuracy so far, a link. */
export function TopicCard({ topic, stats }: TopicCardProps): ReactNode {
  const share = accuracy(stats)
  return (
    <li
      data-topic-card={topic.id}
      className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4 shadow-xs md:p-5"
    >
      <h3 className="text-lg leading-snug font-bold">{topic.title}</h3>
      <p className="mt-1 flex-1 text-pretty text-muted">
        <RichText text={topic.blurb} />
      </p>
      <div className="mt-4" data-topic-accuracy="">
        {stats === undefined || share === null ? (
          <p className="text-sm text-muted">Not tried yet</p>
        ) : (
          <>
            <p className="text-sm font-medium">{accuracyText(stats, share)}</p>
            <Meter share={share} className="mt-1.5" />
          </>
        )}
      </div>
      <p className="mt-4">
        {/* One name for the whole link: the visible word, then which topic. */}
        <ButtonLink to={`/practice/${topic.id}`} aria-label={`Practice: ${topic.title}`}>
          Practice
          <ArrowRightIcon size={18} />
        </ButtonLink>
      </p>
    </li>
  )
}
