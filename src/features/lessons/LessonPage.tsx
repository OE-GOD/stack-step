import { Suspense, use, useEffect, useState, type ReactNode } from 'react'
import { PageContainer } from '../../components/layout/Page'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { ArrowRightIcon } from '../../components/ui/icons'
import { isLessonId, lessonById, LESSONS, type LessonId } from '../../content/lessonList'
import { isLessonDone, markLessonDone, useProgress } from '../../lib/progress'
import { matchPath, navigate, useRoute } from '../../lib/router'
import { DoneMark } from './components/DoneMark'
import { COLUMN } from './components/layout'
import { LessonArticle } from './components/LessonArticle'
import { LessonPager } from './components/LessonPager'
import { LessonErrorBoundary, LessonLoading, LessonProblem } from './components/LessonStates'
import { forgetFailedLesson, forgetLesson, loadLesson, preloadLesson } from './registry'

/**
 * One lesson (`/learn/:lessonId`): the title, then the lesson file's content (loaded when
 * the page opens), then the way on. The title and the way on never depend on the lesson
 * file, so the page works while a file is loading, and when it fails to load or is broken.
 */
export default function LessonPage(): ReactNode {
  const { path } = useRoute()
  const lessonId = matchPath('/learn/:lessonId', path)?.lessonId ?? ''
  if (isLessonId(lessonId)) return <LessonScreen key={lessonId} id={lessonId} />
  // A lesson id typed in capitals (/learn/MOV) opens that lesson, at its usual address.
  const lowerCase = lessonId.toLowerCase()
  if (isLessonId(lowerCase)) return <MoveToLesson id={lowerCase} />
  return <UnknownLesson />
}

/** Shows the lesson and swaps the address for the usual one (the tab title follows it). */
function MoveToLesson({ id }: { id: LessonId }): ReactNode {
  useEffect(() => navigate(`/learn/${id}`, { replace: true }), [id])
  return <LessonScreen id={id} />
}

function LessonScreen({ id }: { id: LessonId }): ReactNode {
  const lesson = lessonById(id)
  const done = isLessonDone(useProgress(), id)
  // A lesson that failed to download on an earlier visit is asked for again.
  useState(() => forgetFailedLesson(id))
  // "Try again" after a failed download: a new key loads the file again.
  const [attempt, setAttempt] = useState(0)

  const retry = () => {
    forgetLesson(id)
    setAttempt((count) => count + 1)
  }

  return (
    <PageContainer>
      <header className={COLUMN}>
        <p className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-muted">
          <span>
            Lesson {lesson.number} of {LESSONS.length}
          </span>
          {done && <DoneMark />}
        </p>
        <h1 className="mt-2 text-3xl leading-tight font-extrabold tracking-tight text-balance md:text-4xl">
          {lesson.title}
        </h1>
      </header>
      <div className="mt-5 md:mt-6">
        <Suspense
          fallback={
            <>
              <LessonLoading />
              <LessonPager lesson={lesson} />
            </>
          }
        >
          <LoadedLesson key={attempt} id={id} onRetry={retry} />
        </Suspense>
      </div>
    </PageContainer>
  )
}

/** The lesson file's content (or the message that stands in for it) and the way on. */
function LoadedLesson({ id, onRetry }: { id: LessonId; onRetry: () => void }): ReactNode {
  const load = use(loadLesson(id))
  const lesson = lessonById(id)
  const index = LESSONS.findIndex((candidate) => candidate.id === id)

  // Once this lesson is on screen, load the lessons before and after it, so that Previous
  // and Next open them at once, also on a phone (where nothing is pointed at first).
  useEffect(() => {
    for (const neighbour of [LESSONS[index - 1], LESSONS[index + 1]]) {
      if (neighbour !== undefined) preloadLesson(neighbour.id)
    }
  }, [index])

  if (load.status !== 'ready') {
    return (
      <>
        {load.status === 'failed' ? (
          <LessonProblem downloadFailed onRetry={onRetry} />
        ) : (
          <LessonProblem />
        )}
        <LessonPager lesson={lesson} />
      </>
    )
  }

  const next = LESSONS[index + 1]
  return (
    <>
      <LessonErrorBoundary>
        <LessonArticle
          content={load.content}
          onRight={() => markLessonDone(id)}
          afterRight={
            <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
              <span className="font-semibold">Lesson {lesson.number} is done.</span>
              {next === undefined ? (
                <ButtonLink to="/practice" variant="primary">
                  Go to practice
                  <ArrowRightIcon size={18} />
                </ButtonLink>
              ) : (
                <ButtonLink to={`/learn/${next.id}`} variant="primary">
                  Go to lesson {next.number}
                  <ArrowRightIcon size={18} />
                </ButtonLink>
              )}
            </p>
          }
        />
      </LessonErrorBoundary>
      <LessonPager lesson={lesson} practiceTopic={load.content.practiceTopic} />
    </>
  )
}

/** An address under /learn/ that is not a lesson: say so, and link to the list. */
function UnknownLesson(): ReactNode {
  return (
    <PageContainer width="text">
      <h1 className="text-3xl leading-tight font-extrabold tracking-tight md:text-4xl">
        There is no such lesson
      </h1>
      <p className="mt-3 text-lg text-muted">
        The address may have a typing mistake. All {LESSONS.length} lessons are on the list.
      </p>
      <p className="mt-6">
        <ButtonLink to="/learn" variant="primary">
          See all lessons
        </ButtonLink>
      </p>
    </PageContainer>
  )
}
