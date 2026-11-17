import { useState, type ReactNode } from 'react'
import { cx } from '../../../components/ui/cx'
import { CheckCircleIcon, ChevronRightIcon, XCircleIcon } from '../../../components/ui/icons'
import { RichText } from '../../../components/ui/RichText'
import { TextLink } from '../../../components/ui/TextLink'
import { lessonById } from '../../../content/lessonList'
import { topicById } from '../../../content/topics'
import { isBlank, type GradedQuestion, type TopicReview } from '../session'
import { AnswerRows, MistakeLine, ShowMe } from './Feedback'
import { ProblemView } from './ProblemView'

/* ──────────────────────────────── topics to review ──────────────────────────────── */

export interface TopicsToReviewProps {
  review: readonly TopicReview[]
}

/** Every topic with a wrong answer, weakest first, with its practice page and its lessons. */
export function TopicsToReview({ review }: TopicsToReviewProps): ReactNode {
  if (review.length === 0) {
    return <p className="text-lg">All your answers were right. There is nothing to review.</p>
  }
  return (
    <ol className="grid gap-3" data-topics-to-review="">
      {review.map((entry) => {
        const topic = topicById(entry.topic)
        const asked = entry.right + entry.wrong
        return (
          <li
            key={entry.topic}
            data-review-topic={entry.topic}
            className="rounded-xl border border-line bg-surface p-4 shadow-xs"
          >
            <h3 className="flex flex-wrap items-baseline gap-x-3 text-lg leading-snug font-bold">
              {topic.title}
              <span className="text-sm font-medium text-muted">
                {entry.right} of {asked} right
              </span>
            </h3>
            <ul className="mt-1 flex flex-col sm:flex-row sm:flex-wrap sm:gap-x-6">
              <li>
                <TextLink
                  to={`/practice/${entry.topic}`}
                  className="inline-flex min-h-11 items-center"
                >
                  Practice: {topic.title}
                </TextLink>
              </li>
              {topic.lessons.map((id) => {
                const lesson = lessonById(id)
                return (
                  <li key={id}>
                    <TextLink to={`/learn/${id}`} className="inline-flex min-h-11 items-center">
                      Lesson {lesson.number}: {lesson.title}
                    </TextLink>
                  </li>
                )
              })}
            </ul>
          </li>
        )
      })}
    </ol>
  )
}

/* ──────────────────────────────── every question ──────────────────────────────── */

/** The question itself, drawn only when the student opens it. */
function SeeTheQuestion({ graded }: { graded: GradedQuestion }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="mt-3 rounded-lg border border-line"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium text-primary">
        See the question
      </summary>
      {open && (
        <div className="border-t border-line p-3">
          <ProblemView
            problem={graded.question.problem}
            answers={graded.answers}
            onChange={() => undefined}
            locked
            result={graded.result}
          />
        </div>
      )}
    </details>
  )
}

export interface QuizReviewProps {
  questions: readonly GradedQuestion[]
}

/**
 * One question of a finished quiz. A wrong answer is open; a right one, and a question
 * left blank (every part of it would be listed), are one line that opens on a tap.
 */
function ReviewedQuestion({ graded }: { graded: GradedQuestion }): ReactNode {
  const { question, result } = graded
  const blank = isBlank(graded.answers)
  return (
    <li
      data-question={question.number}
      data-correct={result.correct ? 'yes' : 'no'}
      data-blank={blank ? 'yes' : undefined}
      className={cx(
        'min-w-0 rounded-xl border bg-surface shadow-xs',
        result.correct ? 'border-line' : 'border-bad/40',
      )}
    >
      <details open={!result.correct && !blank} className="group">
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 leading-snug [&::-webkit-details-marker]:hidden">
          <ChevronRightIcon
            size={18}
            className="text-muted transition-transform group-open:rotate-90"
          />
          <span className="font-bold">Question {question.number}</span>
          <span className="text-muted">{topicById(question.topic).title}</span>
          {result.correct ? (
            <span className="inline-flex items-center gap-1 font-semibold text-good">
              <CheckCircleIcon size={18} />
              Right
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-semibold text-bad">
              <XCircleIcon size={18} />
              {blank ? 'Blank' : 'Wrong'}
            </span>
          )}
        </summary>
        <div className="border-t border-line px-4 pt-3 pb-4">
          <div className="grid gap-2">
            {blank ? (
              <p className="text-muted">You left this question blank.</p>
            ) : (
              <MistakeLine mistake={result.mistake} />
            )}
            {/* A right question shows every part; a wrong one only its wrong parts (the
                whole question, with every mark, is one click away under it). */}
            <AnswerRows problem={question.problem} result={result} onlyWrong={!result.correct} />
            <p>
              <RichText text={result.reason} />
            </p>
          </div>
          {!result.correct && (
            <div className="mt-3">
              <ShowMe problem={question.problem} which={`question ${question.number}`} />
            </div>
          )}
          <SeeTheQuestion graded={graded} />
        </div>
      </details>
    </li>
  )
}

/**
 * Every question of a finished quiz: a right one as one line that opens, a wrong one open
 * with its wrong parts, the reason, the mistake and "Show me". A switch hides the right
 * ones, so a long quiz on a phone shows only what needs a second look.
 */
export function QuizReview({ questions }: QuizReviewProps): ReactNode {
  const [onlyWrong, setOnlyWrong] = useState(false)
  const shown = onlyWrong ? questions.filter((graded) => !graded.result.correct) : questions
  return (
    <div className="grid gap-3">
      <label className="flex min-h-11 w-fit cursor-pointer items-center gap-3 font-medium">
        <input
          type="checkbox"
          checked={onlyWrong}
          onChange={(event) => setOnlyWrong(event.target.checked)}
          className="size-5 shrink-0 accent-primary"
          data-quiz-only-wrong=""
        />
        Show only wrong answers
      </label>
      {shown.length === 0 ? (
        <p className="text-lg">All your answers were right.</p>
      ) : (
        <ol className="grid gap-3" data-quiz-review="">
          {shown.map((graded) => (
            <ReviewedQuestion key={graded.question.number} graded={graded} />
          ))}
        </ol>
      )}
    </div>
  )
}
