import type { ReactNode } from 'react'
import { cx } from '../../../components/ui/cx'
import { ArrowLeftIcon, ArrowRightIcon } from '../../../components/ui/icons'
import { TextLink } from '../../../components/ui/TextLink'
import { VisuallyHidden } from '../../../components/ui/VisuallyHidden'
import { LESSONS, type Lesson, type LessonId } from '../../../content/lessonList'
import { isTopicId, topicById, type TopicId } from '../../../content/topics'
import { Link } from '../../../lib/router'
import { preloadLesson } from '../registry'
import { COLUMN } from './layout'

interface PagerLinkProps {
  to: string
  /** "Previous lesson", "Next lesson", "Go to practice". */
  label: string
  /** The second line: the title of the lesson it opens. */
  detail: string
  direction: 'back' | 'forward'
  primary?: boolean
  /** Load this lesson's file early, when the student points at the link. */
  preload?: LessonId
  className?: string
}

function PagerLink({
  to,
  label,
  detail,
  direction,
  primary = false,
  preload,
  className,
}: PagerLinkProps): ReactNode {
  const warmUp = preload === undefined ? undefined : () => preloadLesson(preload)
  return (
    <Link
      to={to}
      onPointerEnter={warmUp}
      onFocus={warmUp}
      className={cx(
        'flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 transition-colors',
        direction === 'forward' && 'flex-row-reverse text-right',
        primary
          ? 'border-transparent bg-primary text-on-primary shadow-sm hover:bg-primary-hover'
          : 'border-line-strong bg-surface text-ink hover:bg-surface-2',
        className,
      )}
    >
      {direction === 'back' ? <ArrowLeftIcon size={20} /> : <ArrowRightIcon size={20} />}
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{label}</span>
        <VisuallyHidden>: </VisuallyHidden>
        <span
          className={cx(
            'block text-sm leading-snug text-pretty',
            primary ? 'opacity-90' : 'text-muted',
          )}
        >
          {detail}
        </span>
      </span>
    </Link>
  )
}

export interface LessonPagerProps {
  lesson: Lesson
  /** The practice topic of the lesson, once its file has loaded. */
  practiceTopic?: TopicId
}

/**
 * The way on from a lesson: the previous and the next lesson (the last lesson leads to
 * practice), the lesson's practice topic, and the list of all lessons. It never depends on
 * the lesson's own file, so it works even while a lesson is missing or broken.
 */
export function LessonPager({ lesson, practiceTopic }: LessonPagerProps): ReactNode {
  const index = LESSONS.findIndex((candidate) => candidate.id === lesson.id)
  const previous = index > 0 ? LESSONS[index - 1] : undefined
  const next = index >= 0 && index < LESSONS.length - 1 ? LESSONS[index + 1] : undefined
  const topic =
    practiceTopic !== undefined && isTopicId(practiceTopic) ? topicById(practiceTopic) : null

  return (
    <nav aria-label="Lesson navigation" className={cx(COLUMN, 'mt-12 border-t border-line pt-6')}>
      <div className="grid gap-3 sm:grid-cols-2">
        {previous !== undefined && (
          <PagerLink
            to={`/learn/${previous.id}`}
            label="Previous lesson"
            detail={previous.title}
            direction="back"
            preload={previous.id}
          />
        )}
        {next !== undefined ? (
          <PagerLink
            to={`/learn/${next.id}`}
            label="Next lesson"
            detail={next.title}
            direction="forward"
            primary
            preload={next.id}
            className={previous === undefined ? 'sm:col-start-2' : undefined}
          />
        ) : (
          <PagerLink
            to="/practice"
            label="Go to practice"
            detail="Practice what you learned, with new problems."
            direction="forward"
            primary
          />
        )}
      </div>
      <p className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-1">
        {topic !== null && (
          <TextLink to={`/practice/${topic.id}`} className="inline-flex min-h-11 items-center">
            Practice this: {topic.title}
          </TextLink>
        )}
        <TextLink to="/learn" className="inline-flex min-h-11 items-center">
          All lessons
        </TextLink>
      </p>
    </nav>
  )
}
