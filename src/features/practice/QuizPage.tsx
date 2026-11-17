import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { PageContainer, PageHeader } from '../../components/layout/Page'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Callout } from '../../components/ui/Callout'
import { cx } from '../../components/ui/cx'
import { ArrowLeftIcon, ArrowRightIcon } from '../../components/ui/icons'
import { topicById } from '../../content/topics'
import { randomSeed } from '../../lib/rng'
import { navigate, useRoute } from '../../lib/router'
import { Meter } from '../progress/Meter'
import { usePressGuard } from './components/pressGuard'
import { ProblemView } from './components/ProblemView'
import { QuizMap } from './components/QuizMap'
import { QuizReview, TopicsToReview } from './components/QuizReview'
import { useRoomAboveStickyBar } from './components/stickyBar'
import {
  blankQuestionNumbers,
  buildQuiz,
  forgetRunningQuiz,
  freshSeed,
  gradeQuiz,
  keepRunningQuiz,
  listOfNumbers,
  parseSeed,
  readRunningQuiz,
  saveQuiz,
  type QuizGrade,
  type QuizQuestion,
} from './session'
import { QUIZ_FORM_TOPIC_COUNT, QUIZ_LENGTH } from './topicMix'

type Answers = Record<number, Record<string, string>>

type Phase =
  /** `failed`: no question of the quiz could be made (a bug, never the student's fault). */
  | { kind: 'start'; problem: 'none' | 'failed' }
  | {
      kind: 'running'
      seed: number
      questions: QuizQuestion[]
      index: number
      answers: Answers
      /** The quiz was started before a reload (or before a visit to another page). */
      resumed: boolean
    }
  | { kind: 'done'; grade: QuizGrade }

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Puts the keyboard focus on a heading when its screen appears (a new question, or the
 * results), so keyboard and screen reader users start there. `scroll` says where the
 * page goes: to the heading (a question), or back to the top of the page (the results,
 * so the page title and the score are both in view).
 */
function useFocusOnShow<T extends HTMLElement>(scroll: 'heading' | 'page-top') {
  const ref = useRef<T | null>(null)
  const [where] = useState(scroll)
  useLayoutEffect(() => {
    const element = ref.current
    element?.focus({ preventScroll: true })
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth'
    if (where === 'page-top') window.scrollTo({ top: 0, behavior })
    else element?.scrollIntoView({ block: 'start', behavior })
  }, [where])
  return ref
}

/**
 * The quiz to show when the page opens: the quiz this tab was in the middle of (after a
 * reload, or back from another page), unless the address asks for another quiz.
 */
function resumedPhase(addressSeed: number | null): Phase | null {
  const saved = readRunningQuiz()
  if (saved === null || (addressSeed !== null && addressSeed !== saved.seed)) return null
  const questions = buildQuiz(saved.seed)
  if (questions.length === 0) return null
  const answers: Answers = {}
  for (const question of questions) {
    const kept = saved.answers[question.number]
    if (kept !== undefined) answers[question.number] = { ...kept }
  }
  return {
    kind: 'running',
    seed: saved.seed,
    questions,
    index: Math.min(saved.index, questions.length - 1),
    answers,
    resumed: true,
  }
}

/* ─────────────────────────────── the start screen ─────────────────────────────── */

function StartScreen({ onStart, failed }: { onStart: () => void; failed: boolean }): ReactNode {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="max-w-2xl rounded-2xl border border-line bg-surface p-5 shadow-xs md:p-8"
      data-quiz-start=""
    >
      <h2 id={headingId} className="text-2xl leading-tight font-bold">
        How the quiz works
      </h2>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-pretty">
        <li data-quiz-mix="">
          {QUIZ_LENGTH} questions: one trace table, and two from each of the other{' '}
          {QUIZ_FORM_TOPIC_COUNT} topics. They come in a mixed order.
        </li>
        <li>You see no right or wrong answers until the end.</li>
        <li>
          Use Back and Next, or the question numbers, to move. You may leave a question blank, but a
          blank counts as wrong.
        </li>
        <li>
          If you reload the page or open another page, your answers are kept until you close this
          browser tab.
        </li>
        <li>At the end you see your score, every right answer, and the topics to review.</li>
      </ul>
      {failed && (
        <Callout tone="warn" label="Something went wrong" className="mt-5">
          <p>This quiz could not be made. It is not your fault. Please start the quiz again.</p>
        </Callout>
      )}
      <p className="mt-6">
        <Button variant="primary" size="lg" onClick={onStart}>
          Start the quiz
          <ArrowRightIcon size={20} />
        </Button>
      </p>
    </section>
  )
}

/* ──────────────────────────────── one question ─────────────────────────────── */

interface QuestionScreenProps {
  questions: readonly QuizQuestion[]
  index: number
  answers: Answers
  onChange: (fieldId: string, value: string) => void
  onGo: (index: number) => void
  onFinish: () => void
}

function QuestionScreen({
  questions,
  index,
  answers,
  onChange,
  onGo,
  onFinish,
}: QuestionScreenProps): ReactNode {
  const headingRef = useFocusOnShow<HTMLHeadingElement>('heading')
  const finishRef = useRef<HTMLButtonElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  // Next and "Finish the quiz" sit in the same place: a double tap on Next must not
  // finish the quiz with the last question unseen.
  const guard = usePressGuard(`question-${index}`)
  const question = questions[index]
  // The trace table keeps its chips at the bottom of a phone screen: no second bar there.
  const stickyBar = question?.problem.view !== 'trace-table'
  // A field or a question number reached with Tab stops above the bar, not under it.
  useRoomAboveStickyBar(barRef, stickyBar)
  if (question === undefined) return null
  const last = index === questions.length - 1
  const blanks = blankQuestionNumbers(questions, answers)
  const position = `Question ${question.number} of ${questions.length}`
  const guarded = (action: () => void) => () => {
    if (guard.accepts()) action()
  }
  const busy = guard.settled ? undefined : true

  return (
    <section
      aria-labelledby={`quiz-question-${question.number}`}
      data-quiz-question={question.number}
      data-problem-id={question.problem.id}
      className="min-w-0 rounded-2xl border border-line bg-surface shadow-xs"
    >
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <p className="text-sm font-semibold text-muted" data-quiz-position="">
          {position}
        </p>
        <Meter share={question.number / questions.length} className="mt-1.5 max-w-xs" />
        <h2
          id={`quiz-question-${question.number}`}
          ref={headingRef}
          tabIndex={-1}
          className="mt-4 mb-4 scroll-mt-4 text-xl leading-tight font-bold"
        >
          <span className="sr-only">{position}: </span>
          {topicById(question.topic).title}
        </h2>
        <ProblemView
          problem={question.problem}
          answers={answers[question.number] ?? {}}
          onChange={onChange}
          locked={false}
          result={null}
          onEnterLast={last ? () => finishRef.current?.focus() : () => onGo(index + 1)}
          lastEnterHint="next"
        />
        <div className="mt-8 border-t border-line pt-4">
          <QuizMap questions={questions} answers={answers} index={index} onGo={onGo} />
        </div>
      </div>
      <div
        ref={barRef}
        data-primary-bar={stickyBar ? 'sticky' : 'static'}
        className={cx(
          'mt-6 rounded-b-2xl border-t border-line bg-surface px-4 py-3 md:px-6 md:py-4',
          stickyBar && 'sticky bottom-0 z-10 md:static',
        )}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={guarded(() => onGo(index - 1))}
            disabled={index === 0}
            aria-disabled={index === 0 ? undefined : busy}
          >
            <ArrowLeftIcon size={18} />
            Back
          </Button>
          {last ? (
            <Button
              ref={finishRef}
              variant="primary"
              onClick={guarded(onFinish)}
              aria-disabled={busy}
            >
              Finish the quiz
            </Button>
          ) : (
            <Button variant="primary" onClick={guarded(() => onGo(index + 1))} aria-disabled={busy}>
              Next
              <ArrowRightIcon size={18} />
            </Button>
          )}
        </div>
        {last && blanks.length > 0 && (
          <p className="mt-2 text-sm text-muted" data-quiz-blanks="">
            {blanks.length === 1
              ? `1 question has no answer: question ${listOfNumbers(blanks)}. A blank counts as wrong.`
              : `${blanks.length} questions have no answer: questions ${listOfNumbers(blanks)}. A blank counts as wrong.`}
          </p>
        )}
      </div>
    </section>
  )
}

/* ──────────────────────────────── the results ─────────────────────────────── */

function ResultsScreen({ grade, onAgain }: { grade: QuizGrade; onAgain: () => void }): ReactNode {
  const headingRef = useFocusOnShow<HTMLHeadingElement>('page-top')
  const reviewId = useId()
  const allId = useId()
  return (
    <div className="grid gap-10" data-quiz-results="">
      <section
        aria-labelledby="quiz-score-heading"
        className="max-w-2xl rounded-2xl border border-line bg-surface p-5 shadow-xs md:p-8"
      >
        <h2
          id="quiz-score-heading"
          ref={headingRef}
          tabIndex={-1}
          className="scroll-mt-4 text-lg font-semibold text-muted"
        >
          Your score
        </h2>
        <p className="mt-1 text-4xl font-extrabold tracking-tight tabular-nums" data-quiz-score="">
          {grade.score} of {grade.total}
        </p>
        <Meter
          share={grade.total === 0 ? 0 : grade.score / grade.total}
          className="mt-3 max-w-xs"
        />
        <p className="mt-6 flex flex-wrap gap-3">
          <Button variant="primary" onClick={onAgain}>
            Start a new quiz
          </Button>
          <ButtonLink to="/practice">All practice topics</ButtonLink>
        </p>
      </section>

      <section aria-labelledby={reviewId}>
        <h2 id={reviewId} className="mb-4 text-2xl leading-tight font-bold">
          Topics to review
        </h2>
        <TopicsToReview review={grade.review} />
      </section>

      <section aria-labelledby={allId}>
        <h2 id={allId} className="mb-4 text-2xl leading-tight font-bold">
          Every question
        </h2>
        <QuizReview questions={grade.questions} />
      </section>
    </div>
  )
}

/* ──────────────────────────────────── page ─────────────────────────────────── */

/**
 * The mixed mock quiz: 15 questions, no feedback until the end, then the score, every
 * answer and the topics to review. `?seed=N` gives the same quiz every time (for tests
 * and for sharing); without it every quiz is new. A quiz in progress is kept in this tab,
 * so a reload (or a visit to another page) comes back to it.
 */
export default function QuizPage(): ReactNode {
  const { query } = useRoute()
  const [opening] = useState(() => {
    const addressSeed = parseSeed(query.get('seed'))
    const resumed = resumedPhase(addressSeed)
    return { resumed, seed: resumed?.kind === 'running' ? resumed.seed : addressSeed }
  })
  const [quizSeed, setQuizSeed] = useState(() => opening.seed ?? randomSeed())
  const [phase, setPhase] = useState<Phase>(
    () => opening.resumed ?? { kind: 'start', problem: 'none' },
  )

  // Keep the quiz in progress in this tab (see RunningQuiz), right as each answer is drawn,
  // so a reload a moment after typing still finds it.
  useLayoutEffect(() => {
    if (phase.kind !== 'running') return
    keepRunningQuiz({ seed: phase.seed, index: phase.index, answers: phase.answers })
  }, [phase])

  const start = (seed: number) => {
    const questions = buildQuiz(seed)
    if (questions.length === 0) {
      // Never seen: every try of every question failed. A new seed may work.
      setQuizSeed(freshSeed(seed))
      setPhase({ kind: 'start', problem: 'failed' })
    } else {
      setPhase({ kind: 'running', seed, questions, index: 0, answers: {}, resumed: false })
    }
  }

  const onChange = (fieldId: string, value: string) => {
    setPhase((now) => {
      if (now.kind !== 'running') return now
      const question = now.questions[now.index]
      if (question === undefined) return now
      const before = now.answers[question.number] ?? {}
      return {
        ...now,
        answers: { ...now.answers, [question.number]: { ...before, [fieldId]: value } },
      }
    })
  }

  const go = (index: number) => {
    setPhase((now) =>
      now.kind === 'running'
        ? { ...now, index: Math.min(now.questions.length - 1, Math.max(0, index)) }
        : now,
    )
  }

  const finish = () => {
    if (phase.kind !== 'running') return
    const grade = gradeQuiz(phase.questions, phase.answers)
    saveQuiz(grade, new Date())
    forgetRunningQuiz()
    setPhase({ kind: 'done', grade })
  }

  const again = () => {
    const seed = freshSeed(quizSeed)
    setQuizSeed(seed)
    if (query.has('seed')) navigate('/practice/quiz', { replace: true })
    start(seed)
  }

  let lead = `${QUIZ_LENGTH} questions from all the topics. Answer them like a test: you see the results at the end.`
  if (phase.kind === 'done') {
    lead = 'Here is how you did. Each wrong answer shows the right one and why.'
  } else if (phase.kind === 'running' && phase.resumed) {
    lead = 'You came back to the quiz you started. Your answers are still here.'
  }

  return (
    <PageContainer data-quiz-page={phase.kind}>
      <div className="max-w-4xl">
        <PageHeader title="Mixed quiz" lead={lead} />
        {phase.kind === 'start' && (
          <StartScreen onStart={() => start(quizSeed)} failed={phase.problem === 'failed'} />
        )}
        {phase.kind === 'running' && (
          <QuestionScreen
            key={phase.index}
            questions={phase.questions}
            index={phase.index}
            answers={phase.answers}
            onChange={onChange}
            onGo={go}
            onFinish={finish}
          />
        )}
        {phase.kind === 'done' && <ResultsScreen grade={phase.grade} onAgain={again} />}
      </div>
    </PageContainer>
  )
}
