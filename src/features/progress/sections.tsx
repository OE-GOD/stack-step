import type { ReactNode } from 'react'
import { Badge } from '../../components/ui/Badge'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { ArrowRightIcon, CheckIcon } from '../../components/ui/icons'
import { Panel } from '../../components/ui/Panel'
import { TextLink } from '../../components/ui/TextLink'
import { lessonById, LESSONS } from '../../content/lessonList'
import {
  MAX_QUIZZES,
  recentAnswersWords,
  type ProgressData,
  type QuizResult,
} from '../../lib/progress'
import { Link } from '../../lib/router'
import { Meter } from './Meter'
import {
  hasPracticeHistory,
  lessonRows,
  lessonsDone,
  quizShare,
  quizSummary,
  toPercent,
  topicRows,
  weakTopicRows,
  type TopicRow,
} from './summary'

export interface SectionProps {
  progress: ProgressData
}

/* ──────────────────────────────── Lessons ──────────────────────────────── */

/** "N of 14 lessons done", a bar, and every lesson with its done mark. */
export function LessonsSection({ progress }: SectionProps): ReactNode {
  const done = lessonsDone(progress)
  return (
    <Panel title="Lessons" flush>
      <div className="px-4 pt-4 pb-4">
        <p className="text-lg font-semibold">
          {done} of {LESSONS.length} lessons done
        </p>
        <Meter share={done / LESSONS.length} className="mt-2" />
      </div>
      <ol className="border-t border-line">
        {lessonRows(progress).map(({ lesson, done: lessonDone }) => (
          <li key={lesson.id} className="border-b border-line last:border-b-0">
            {/* The whole row is the link. The outline is drawn inside the row, because the
                card cuts off anything that sticks out. The name is given whole, because
                screen readers put spaces between the boxes of the row ("Lesson 1 : …").
                It holds every visible word in the same order (WCAG 2.5.3, "label in
                name"), and the spaces between the boxes let a checker see those words
                apart: a space between two flex items is not drawn. */}
            <Link
              to={`/learn/${lesson.id}`}
              aria-label={`Lesson ${lesson.number}: ${lesson.title}, ${lessonDone ? 'Done' : 'Not done yet'}`}
              className="flex min-h-12 items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2"
            >
              <span className="w-5 shrink-0 text-right text-sm text-muted tabular-nums">
                {lesson.number}
              </span>{' '}
              <span className="min-w-0 flex-1 leading-snug font-medium">{lesson.title}</span>{' '}
              {lessonDone ? (
                <Badge tone="good" className="shrink-0">
                  <CheckIcon size={12} strokeWidth={3} />
                  Done
                </Badge>
              ) : (
                <span className="shrink-0 text-sm whitespace-nowrap text-muted">Not done yet</span>
              )}
            </Link>
          </li>
        ))}
      </ol>
    </Panel>
  )
}

/* ──────────────────────────── Practice accuracy ──────────────────────────── */

/** A table: one row per topic with right, wrong and the recent accuracy. */
export function PracticeSection({ progress }: SectionProps): ReactNode {
  return (
    <Panel title="Practice accuracy" flush>
      <table className="w-full text-left">
        <caption className="sr-only">Your practice results for each topic</caption>
        <thead className="bg-surface-2 text-sm text-muted">
          <tr>
            <th scope="col" className="py-2 pr-2 pl-4 font-semibold">
              Topic
            </th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">
              Right
            </th>
            <th scope="col" className="px-2 py-2 text-right font-semibold">
              Wrong
            </th>
            <th scope="col" className="py-2 pr-4 pl-2 font-semibold">
              Recent accuracy
            </th>
          </tr>
        </thead>
        <tbody>
          {topicRows(progress).map((row) => (
            <tr key={row.topic.id} className="border-t border-line">
              <th scope="row" className="py-1 pr-2 pl-4 leading-snug font-medium">
                {/* The flush card draws the focus outline inside the link, so the link gets
                    a little room around its words (and gives it back with a negative margin). */}
                <TextLink
                  to={`/practice/${row.topic.id}`}
                  className="-mx-1 inline-flex min-h-11 items-center px-1"
                >
                  {row.topic.title}
                </TextLink>
              </th>
              {row.accuracy === null ? (
                <td colSpan={3} className="py-2 pr-4 pl-2 text-muted">
                  Not tried yet
                </td>
              ) : (
                <>
                  <td className="px-2 py-2 text-right tabular-nums">{row.right}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{row.wrong}</td>
                  <td className="py-2 pr-4 pl-2">
                    <span className="font-semibold tabular-nums">{toPercent(row.accuracy)}%</span>
                    <Meter share={row.accuracy} className="mt-1 w-full max-w-28 min-w-14" />
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-line px-4 py-3 text-sm text-pretty text-muted">
        Right and Wrong count all your answers. Recent accuracy counts only your newest answers in a
        topic.
      </p>
    </Panel>
  )
}

/* ───────────────────────────── Weakest topics ───────────────────────────── */

function WeakTopic({ row, place }: { row: TopicRow; place: number }): ReactNode {
  const { topic } = row
  // The first lesson of a topic is the best place to start (see topics.ts).
  const lesson = lessonById(topic.lessons[0])
  return (
    <li className="border-b border-line pb-4 last:border-b-0 last:pb-0">
      <p className="text-lg leading-snug font-semibold">
        {place}. {topic.title}
      </p>
      {row.accuracy === null ? (
        <p className="mt-0.5 text-muted">Not tried yet</p>
      ) : (
        <p className="mt-0.5 text-muted">
          Recent accuracy:{' '}
          <span className="font-semibold text-ink tabular-nums">{toPercent(row.accuracy)}%</span> (
          {recentAnswersWords(row.recentRight, row.recentCount)})
        </p>
      )}
      <p className="mt-3 flex flex-wrap gap-2">
        {/* The names say which lesson and which practice the two links open. */}
        <ButtonLink to={`/learn/${lesson.id}`} aria-label={`Review the lesson: ${lesson.title}`}>
          Review the lesson
        </ButtonLink>
        <ButtonLink to={`/practice/${topic.id}`} aria-label={`Practice: ${topic.title}`}>
          Practice
        </ButtonLink>
      </p>
    </li>
  )
}

/** The panel title. Not "three": with mastered topics left out, the list can be shorter. */
const WEAK_TITLE = 'Your weakest topics'

/** The topics to practice next, and the button that starts a mixed session. */
export function WeakTopicsSection({ progress }: SectionProps): ReactNode {
  if (!hasPracticeHistory(progress)) {
    return (
      <Panel title={WEAK_TITLE}>
        <p className="text-pretty">
          You have not answered a practice problem yet. Answer some problems, and this box shows the
          topics that you need to practice most.
        </p>
        <p className="mt-4">
          <ButtonLink to="/practice" variant="primary">
            Go to Practice
            <ArrowRightIcon size={18} />
          </ButtonLink>
        </p>
      </Panel>
    )
  }
  const rows = weakTopicRows(progress)
  if (rows.length === 0) {
    // Every topic is mastered: there is no weak spot to practice.
    return (
      <Panel title={WEAK_TITLE}>
        <p className="text-pretty">
          You have no weak topics right now. In every topic, your recent answers are right.
        </p>
        <p className="mt-4">
          <ButtonLink to="/practice/quiz" variant="primary">
            Take the mixed quiz
            <ArrowRightIcon size={18} />
          </ButtonLink>
        </p>
      </Panel>
    )
  }
  return (
    <Panel title={WEAK_TITLE}>
      <ol className="space-y-4">
        {rows.map((row, index) => (
          <WeakTopic key={row.topic.id} row={row} place={index + 1} />
        ))}
      </ol>
      <p className="mt-5">
        <ButtonLink to="/practice/weak" variant="primary" size="lg" className="w-full sm:w-auto">
          Practice my weak spots
          <ArrowRightIcon size={20} />
        </ButtonLink>
      </p>
    </Panel>
  )
}

/* ──────────────────────────────── Mixed quizzes ──────────────────────────────── */

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
})

function QuizScore({ quiz }: { quiz: QuizResult }): ReactNode {
  return (
    <>
      <span className="text-lg font-semibold tabular-nums">
        {quiz.score} of {quiz.total}
      </span>{' '}
      <span className="tabular-nums">({toPercent(quizShare(quiz))}%)</span>
      <span className="block text-sm text-muted">{DATE_FORMAT.format(new Date(quiz.date))}</span>
    </>
  )
}

/**
 * The latest and the best mixed quiz (the practice hub and the quiz page use the same
 * name). Shown only after the first quiz.
 *
 * The store keeps only the newest MAX_QUIZZES results. Once it is full, the oldest ones
 * may be gone, so the page says "your last 20" and "20 or more" instead of numbers that
 * could be wrong.
 */
export function QuizSection({ progress }: SectionProps): ReactNode {
  const summary = quizSummary(progress)
  if (summary === null) return null
  return (
    <Panel title="Mixed quizzes">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1">
        <div>
          <dt className="text-sm font-semibold text-muted">Latest score</dt>
          <dd>
            <QuizScore quiz={summary.latest} />
          </dd>
        </div>
        <div>
          <dt className="text-sm font-semibold text-muted">
            {summary.onlyNewest ? `Best of your last ${MAX_QUIZZES}` : 'Best score'}
          </dt>
          <dd>
            <QuizScore quiz={summary.best} />
          </dd>
        </div>
      </dl>
      <p className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <span className="text-muted">
          Quizzes taken: {summary.onlyNewest ? `${MAX_QUIZZES} or more` : summary.count}
        </span>
        <TextLink to="/practice/quiz" className="inline-flex min-h-11 items-center">
          Take the mixed quiz
        </TextLink>
      </p>
    </Panel>
  )
}
