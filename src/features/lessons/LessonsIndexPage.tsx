import { useEffect, useState, type ReactNode } from 'react'
import { PageContainer, PageHeader } from '../../components/layout/Page'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { cx } from '../../components/ui/cx'
import { ArrowRightIcon } from '../../components/ui/icons'
import { NotSavedNote } from '../../components/ui/NotSavedNote'
import { RichText } from '../../components/ui/RichText'
import { VisuallyHidden } from '../../components/ui/VisuallyHidden'
import { LESSONS, type Lesson } from '../../content/lessonList'
import { isLessonDone, useProgress } from '../../lib/progress'
import { Link } from '../../lib/router'
import { storageAvailable } from '../../lib/storage'
import { DoneMark } from './components/DoneMark'
import { ProgressBar } from './components/ProgressBar'
import { preloadLesson } from './registry'

/** The big button: start, go on with the first lesson that is not done, or practice. */
function NextStep({ doneCount, firstOpen }: { doneCount: number; firstOpen: Lesson | undefined }) {
  if (firstOpen === undefined) {
    return (
      <ButtonLink to="/practice" variant="primary" size="lg">
        Go to practice
        <ArrowRightIcon size={20} />
      </ButtonLink>
    )
  }
  return (
    <ButtonLink to={`/learn/${firstOpen.id}`} variant="primary" size="lg">
      {doneCount === 0 ? 'Start with lesson 1' : `Continue with lesson ${firstOpen.number}`}
      <ArrowRightIcon size={20} />
    </ButtonLink>
  )
}

/**
 * One lesson in the list. The whole card opens the lesson, but only the title is the
 * link, so the link's name is short ("Lesson 1: …") and the summary is read as text.
 */
function LessonCard({ lesson, done }: { lesson: Lesson; done: boolean }): ReactNode {
  // Load the lesson's file as soon as the student points at the card, focuses it or
  // touches it, so the lesson opens at once.
  const warmUp = () => preloadLesson(lesson.id)
  return (
    <li
      data-lesson={lesson.id}
      className="relative flex gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs transition-colors hover:border-line-strong hover:bg-surface-2 sm:gap-4"
    >
      {/* A done lesson's number is tinted too, so the list shows progress at a glance (the
          "Done" badge says it in words). */}
      <span
        aria-hidden="true"
        className={cx(
          'flex size-9 shrink-0 items-center justify-center rounded-full border font-bold tabular-nums',
          done ? 'border-good bg-good-soft text-good' : 'border-line-strong',
        )}
      >
        {lesson.number}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link
            to={`/learn/${lesson.id}`}
            onPointerEnter={warmUp}
            onFocus={warmUp}
            onTouchStart={warmUp}
            className="text-lg leading-snug font-semibold text-ink after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-focus"
          >
            <VisuallyHidden>Lesson {lesson.number}: </VisuallyHidden>
            {lesson.title}
            {done && <VisuallyHidden> (done)</VisuallyHidden>}
          </Link>
          {/* The link's name already says "(done)", so screen readers skip the badge. */}
          {done && (
            <span aria-hidden="true" className="contents">
              <DoneMark />
            </span>
          )}
        </p>
        <p className="mt-1 text-pretty text-muted">
          <RichText text={lesson.summary} />
        </p>
      </div>
    </li>
  )
}

/** The list of lessons (`/learn`), with how many are done and where to go on. */
export default function LessonsIndexPage(): ReactNode {
  const progress = useProgress()
  const doneIds = new Set(
    LESSONS.filter((lesson) => isLessonDone(progress, lesson.id)).map((l) => l.id),
  )
  const doneCount = doneIds.size
  const firstOpen = LESSONS.find((lesson) => !doneIds.has(lesson.id))
  // Checked once: when the browser blocks saving, progress lasts only as long as the page.
  const [canSave] = useState(storageAvailable)

  // The big button most likely opens this lesson next: load it now.
  useEffect(() => {
    if (firstOpen !== undefined) preloadLesson(firstOpen.id)
  }, [firstOpen])

  return (
    <PageContainer>
      <PageHeader
        title="Learn"
        lead={`${LESSONS.length} short lessons, one idea each. Every lesson has a live example and one question to check yourself.`}
      >
        <div className="mt-6 flex max-w-3xl flex-col gap-4 rounded-2xl border border-line bg-surface p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div className="min-w-0 sm:flex-1">
            <p className="text-lg font-semibold" data-lessons-done={doneCount}>
              {doneCount} of {LESSONS.length} done
            </p>
            <ProgressBar done={doneCount} total={LESSONS.length} className="mt-2 sm:max-w-xs" />
          </div>
          <NextStep doneCount={doneCount} firstOpen={firstOpen} />
        </div>
        {/* The same note, in the same words, as on the Practice and Progress pages. */}
        {!canSave && <NotSavedNote data-progress-not-saved="" className="mt-4 max-w-3xl" />}
      </PageHeader>

      <ol aria-label="Lessons" className="grid max-w-3xl gap-3">
        {LESSONS.map((lesson) => (
          <LessonCard key={lesson.id} lesson={lesson} done={doneIds.has(lesson.id)} />
        ))}
      </ol>
    </PageContainer>
  )
}
