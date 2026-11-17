import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { PageContainer, PageHeader } from '../../components/layout/Page'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Callout } from '../../components/ui/Callout'
import { cx } from '../../components/ui/cx'
import { ArrowLeftIcon, ArrowRightIcon } from '../../components/ui/icons'
import { RichText } from '../../components/ui/RichText'
import { TextLink } from '../../components/ui/TextLink'
import { lessonById } from '../../content/lessonList'
import { isTopicId, topicById, type TopicId } from '../../content/topics'
import { getProgress, recordAttempt } from '../../lib/progress'
import { randomSeed } from '../../lib/rng'
import { matchPath, navigate, useRoute } from '../../lib/router'
import { TutorMount, type TutorContext } from '../tutor/TutorMount'
import { checkProblem } from './check'
import { FeedbackMessage, ShowMe } from './components/Feedback'
import { ProblemView } from './components/ProblemView'
import { SessionStats } from './components/SessionStats'
import { usePressGuard } from './components/pressGuard'
import { revealWithButton, useRoomAboveStickyBar } from './components/stickyBar'
import { practiceTutorContext } from './components/tutorContext'
import {
  EMPTY_SCORE,
  loadProblem,
  nextSeed,
  parseSeed,
  scoreAfter,
  type ProblemLoad,
  type SessionScore,
} from './session'
import { hasPracticeHistory, topicInRotation, weakMixWords, weakRotation } from './topicMix'
import type { CheckResult } from './types'

/* ───────────────────────────── modes and routes ───────────────────────────── */

type Mode =
  | { kind: 'topic'; topic: TopicId }
  /** "Practice my weak spots": the problems take turns between these topics. */
  | { kind: 'weak'; rotation: readonly TopicId[] }

/** The address of one problem: the seed (and in a weak-spots session, the topic). */
function routeFor(mode: Mode, topic: TopicId, seed: number): string {
  return mode.kind === 'topic'
    ? `/practice/${topic}?seed=${seed}`
    : `/practice/weak?topic=${topic}&seed=${seed}`
}

/** Where the keyboard focus goes when the next problem appears. */
type FocusTarget = 'first-field' | 'problem'

/* ─────────────────────────────── small pieces ─────────────────────────────── */

function BackToHub(): ReactNode {
  return (
    <p className="mb-4">
      <TextLink to="/practice" className="inline-flex min-h-11 items-center gap-1.5">
        <ArrowLeftIcon size={18} />
        All practice topics
      </TextLink>
    </p>
  )
}

/**
 * "The lesson for this topic: Lesson 3: Writing part of a register" (links). On a phone it
 * sits under the problem instead of above it, so the problem's first field is in view
 * when the page opens.
 */
function LessonLinks({ topic, className }: { topic: TopicId; className?: string }): ReactNode {
  const lessons = topicById(topic).lessons.map((id) => lessonById(id))
  return (
    <p
      className={cx('flex flex-wrap items-baseline gap-x-3 gap-y-1 text-muted', className)}
      data-lesson-links=""
    >
      <span>
        {lessons.length === 1 ? 'The lesson for this topic:' : 'The lessons for this topic:'}
      </span>
      {lessons.map((lesson) => (
        <TextLink
          key={lesson.id}
          to={`/learn/${lesson.id}`}
          className="inline-flex min-h-11 items-center"
        >
          Lesson {lesson.number}: {lesson.title}
        </TextLink>
      ))}
    </p>
  )
}

/** The first thing to type in: an answer field, or the first button of the trace table. */
function firstAnswerControl(root: HTMLElement | null): HTMLElement | null {
  if (root === null) return null
  return (
    root.querySelector<HTMLElement>('[data-answer-input]') ??
    root.querySelector<HTMLElement>('[data-problem-area] button:not([disabled])')
  )
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The page around a session. On a phone the main button sticks to the bottom of the
 * screen, and the tutor's button (when the tutor is on) floats above it: the offset moves
 * it up. When the tutor's button is there, the end of the page gets room for it (its
 * height, its offset and a small gap), so the last control and the lesson links can be
 * scrolled up above it.
 */
const SESSION_PAGE =
  'max-md:[--tutor-bottom-offset:5rem] max-md:has-[[data-tutor=button]]:pb-[calc(4.5rem+var(--tutor-bottom-offset))]'

/* ──────────────────────────────── one problem ─────────────────────────────── */

interface ProblemCardProps {
  load: ProblemLoad
  /** "Problem 3", or "Problem 3: Follow rsp" in a weak-spots session. */
  heading: string
  score: SessionScore
  focusOnMount: FocusTarget | null
  onChecked: (topic: TopicId, correct: boolean) => void
  onNext: (viaKeyboard: boolean) => void
  /** Tells the session what the tutor should see right now. */
  onTutorContext: (context: () => TutorContext) => void
}

/**
 * One problem from first look to "Next problem". It is drawn again from scratch for every
 * problem (the session gives it a new key), so no answer can leak into the next one.
 */
function ProblemCard({
  load,
  heading,
  score,
  focusOnMount,
  onChecked,
  onNext,
  onTutorContext,
}: ProblemCardProps): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<CheckResult | null>(null)
  // Read once: the focus is placed when this problem appears, never again.
  const [focusWhenShown] = useState(focusOnMount)
  const headingId = useId()
  const cardRef = useRef<HTMLElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const primaryRef = useRef<HTMLButtonElement | null>(null)
  const barRef = useRef<HTMLDivElement | null>(null)
  const feedbackRef = useRef<HTMLDivElement | null>(null)
  const problem = load.kind === 'ready' ? load.problem : null
  const job = result === null && problem !== null ? 'check' : 'next'
  // The main button is Check, then "Next problem", in the same place: a double tap must
  // not skip the feedback or check the next problem unseen.
  const guard = usePressGuard(job)
  // The trace table keeps its chips at the bottom of a phone screen; a second bar there
  // would cover them, so for a trace table the main button stays in its place.
  const stickyBar = problem?.view !== 'trace-table'
  // A field reached with Tab stops above the bar, not under it.
  useRoomAboveStickyBar(barRef, stickyBar)

  // A new problem after "Next problem": keyboard users land in its first field, everybody
  // else on its heading (a phone keyboard does not pop up by surprise).
  useLayoutEffect(() => {
    if (focusWhenShown === null) return
    const card = cardRef.current
    const first = focusWhenShown === 'first-field' ? firstAnswerControl(card) : null
    if (first !== null) first.focus()
    else headingRef.current?.focus({ preventScroll: true })
    card?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [focusWhenShown])

  useEffect(() => {
    onTutorContext(() => practiceTutorContext(problem, answers, result))
  })

  // After Check: bring the feedback and "Show me" into view (above the bar at the bottom
  // of a phone screen), and keep the keyboard focus on the page (a radio button that was
  // locked has lost it). When the focus is on the main button ("Next problem" now) and
  // that button does not stick to the screen (a trace table; a wide screen), it comes into
  // view together with the feedback, so the focus can be seen.
  useEffect(() => {
    if (result === null) return
    const primary = primaryRef.current
    const focused = document.activeElement
    if (focused === null || focused === document.body) primary?.focus()
    const feedback = feedbackRef.current
    const bar = barRef.current
    if (feedback === null) return
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth'
    const buttonHasFocus = primary !== null && document.activeElement === primary
    if (buttonHasFocus && bar !== null && getComputedStyle(bar).position !== 'sticky') {
      revealWithButton(feedback, primary, behavior)
    } else {
      feedback.scrollIntoView({ block: 'nearest', behavior })
    }
  }, [result])

  const check = () => {
    if (problem === null || result !== null) return
    guard.restart()
    const checked = checkProblem(problem, answers)
    setResult(checked)
    onChecked(problem.topic, checked.correct)
  }

  const onPrimary = (event: MouseEvent<HTMLButtonElement>) => {
    if (!guard.accepts()) return
    // `detail` is 0 when the button was pressed with the keyboard.
    if (result === null && problem !== null) check()
    else onNext(event.detail === 0)
  }

  const locked = result !== null

  return (
    <section
      ref={cardRef}
      aria-labelledby={headingId}
      data-practice-card=""
      data-problem-id={problem?.id ?? ''}
      data-checked={result === null ? 'no' : result.correct ? 'right' : 'wrong'}
      className="scroll-mt-4 rounded-2xl border border-line bg-surface shadow-xs"
    >
      <div className="px-4 pt-4 md:px-6 md:pt-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h2
            id={headingId}
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold tracking-wide text-muted uppercase"
          >
            {heading}
          </h2>
          {/* "0 of 0 right" says nothing yet: the score shows from the first Check on. */}
          {score.total > 0 && <SessionStats score={score} />}
        </div>

        {load.kind === 'failed' && (
          <Callout tone="warn" label="Something went wrong">
            <p>This problem could not be made. It is not your fault. Try the next problem.</p>
          </Callout>
        )}

        {problem !== null && (
          <div data-problem-area="" className="min-w-0">
            <ProblemView
              problem={problem}
              answers={answers}
              onChange={(fieldId, value) => {
                if (!locked) setAnswers((now) => ({ ...now, [fieldId]: value }))
              }}
              locked={locked}
              result={result}
              onEnterLast={check}
              onEnterLocked={() => primaryRef.current?.focus()}
              lastEnterHint="go"
            />
          </div>
        )}

        {/* The feedback and "Show me" scroll into view together, clear of the bar at the
            bottom of a phone screen (the page keeps room above the bar: see
            useRoomAboveStickyBar). When they are taller than the screen, their top comes
            into view: "Not yet" and the named mistake. */}
        <div
          ref={feedbackRef}
          data-feedback-area=""
          className={result === null ? undefined : 'mt-6 grid scroll-mt-4 scroll-mb-6 gap-3'}
        >
          {/* The live region is always there, so screen readers read what appears in it. */}
          <div aria-live="polite" data-testid="result">
            {problem !== null && result !== null && (
              <FeedbackMessage problem={problem} result={result} />
            )}
          </div>
          {problem !== null && result !== null && !result.correct && <ShowMe problem={problem} />}
        </div>
      </div>

      {/* On a phone the main button stays at the bottom of the screen, so it is always in
          reach (but not under a trace table's chips: see stickyBar). */}
      {(problem !== null || load.kind === 'failed') && (
        <div
          ref={barRef}
          data-primary-bar={stickyBar ? 'sticky' : 'static'}
          className={cx(
            'mt-6 rounded-b-2xl border-t border-line bg-surface px-4 py-3 md:px-6 md:py-4',
            stickyBar && 'sticky bottom-0 z-10 md:static',
          )}
        >
          <Button
            ref={primaryRef}
            variant="primary"
            onClick={onPrimary}
            aria-disabled={guard.settled ? undefined : true}
            className="w-full sm:w-auto sm:min-w-36"
            data-primary-action={job}
          >
            {result === null && problem !== null ? (
              'Check'
            ) : (
              <>
                Next problem
                <ArrowRightIcon size={18} />
              </>
            )}
          </Button>
        </div>
      )}
    </section>
  )
}

/* ───────────────────────────────── a session ──────────────────────────────── */

/**
 * The endless session: one problem at a time. The address holds the problem (`?seed=`,
 * and `&topic=` for weak spots), so a reload or a shared link shows the same problem;
 * "Next problem" puts a new random seed there.
 */
function Session({ mode }: { mode: Mode }): ReactNode {
  const { query } = useRoute()
  const [fallbackSeed] = useState(randomSeed)
  const [turn, setTurn] = useState(0)
  const [score, setScore] = useState(EMPTY_SCORE)
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null)
  const tutorContext = useRef<() => TutorContext>(() => practiceTutorContext(null, {}, null))

  const querySeed = parseSeed(query.get('seed'))
  const seed = querySeed ?? fallbackSeed
  const queryTopic = query.get('topic')
  const topic: TopicId =
    mode.kind === 'topic'
      ? mode.topic
      : queryTopic !== null && isTopicId(queryTopic)
        ? queryTopic
        : (topicInRotation(mode.rotation, turn) ?? 'register-names')

  // The first problem: write its seed into the address (no new history entry).
  useEffect(() => {
    if (querySeed === null) navigate(routeFor(mode, topic, seed), { replace: true })
  }, [mode, querySeed, seed, topic])

  const load = useMemo(() => loadProblem(topic, seed), [topic, seed])
  const problemNumber = turn + 1
  const heading =
    mode.kind === 'weak'
      ? `Problem ${problemNumber}: ${topicById(topic).title}`
      : `Problem ${problemNumber}`

  const onChecked = (checkedTopic: TopicId, correct: boolean) => {
    setScore((now) => scoreAfter(now, correct))
    recordAttempt(checkedTopic, correct)
  }

  const onNext = (viaKeyboard: boolean) => {
    const nextTurn = turn + 1
    const nextTopic =
      mode.kind === 'topic' ? mode.topic : (topicInRotation(mode.rotation, nextTurn) ?? topic)
    setTurn(nextTurn)
    setFocusTarget(viaKeyboard ? 'first-field' : 'problem')
    // A new seed that does not make the question that is on the screen now.
    const shown = load.kind === 'ready' && nextTopic === topic ? load.problem : null
    navigate(routeFor(mode, nextTopic, nextSeed(nextTopic, { seed, problem: shown })), {
      replace: true,
    })
  }

  return (
    <>
      <ProblemCard
        key={`${topic}-${seed}`}
        load={load}
        heading={heading}
        score={score}
        focusOnMount={focusTarget}
        onChecked={onChecked}
        onNext={onNext}
        onTutorContext={(context) => {
          tutorContext.current = context
        }}
      />
      <TutorMount getContext={() => tutorContext.current()} />
    </>
  )
}

/* ────────────────────────────────── pages ─────────────────────────────────── */

function TopicPractice({ topic }: { topic: TopicId }): ReactNode {
  const info = topicById(topic)
  const mode = useMemo<Mode>(() => ({ kind: 'topic', topic }), [topic])
  return (
    <PageContainer data-practice-page={topic} className={SESSION_PAGE}>
      <div className="max-w-4xl">
        <BackToHub />
        <PageHeader title={info.title} lead={<RichText text={info.blurb} />}>
          <LessonLinks topic={topic} className="mt-3 max-md:hidden" />
        </PageHeader>
        <Session mode={mode} />
        <LessonLinks topic={topic} className="mt-6 md:hidden" />
      </div>
    </PageContainer>
  )
}

function WeakSpotsPractice(): ReactNode {
  // Decided once, when the page opens: the student's answers in this session change the
  // progress, but the topics keep taking turns in the same order.
  const [start] = useState(() => {
    const progress = getProgress()
    const rotation = weakRotation(progress)
    return {
      rotation,
      hadHistory: hasPracticeHistory(progress),
      words: weakMixWords(progress, rotation),
    }
  })
  const mode = useMemo<Mode>(() => ({ kind: 'weak', rotation: start.rotation }), [start])

  return (
    <PageContainer data-practice-page="weak" className={SESSION_PAGE}>
      <div className="max-w-4xl">
        <BackToHub />
        <PageHeader
          title="Practice my weak spots"
          lead={
            start.hadHistory
              ? `This mix uses ${start.words}. The problems take turns between them.`
              : 'You have no practice results yet, so this mix starts with the first topics. Later it uses the topics where your accuracy is lowest.'
          }
        >
          <ul className="mt-3 flex flex-wrap gap-2" aria-label="Topics in this mix">
            {start.rotation.map((topic) => (
              <li
                key={topic}
                className="rounded-full border border-line bg-surface px-3 py-1 text-sm font-semibold"
              >
                {topicById(topic).title}
              </li>
            ))}
          </ul>
        </PageHeader>
        <Session mode={mode} />
      </div>
    </PageContainer>
  )
}

function UnknownTopic({ topicId }: { topicId: string }): ReactNode {
  return (
    <PageContainer width="text">
      <PageHeader
        title="This practice topic does not exist"
        lead={`Stack Step has no practice topic called “${topicId}”. The address may have a typing mistake.`}
      />
      <p>
        <ButtonLink to="/practice" variant="primary">
          See all practice topics
        </ButtonLink>
      </p>
    </PageContainer>
  )
}

/**
 * The practice session: `/practice/<topic>` for one topic, `/practice/weak` for a mix of
 * the student's weakest topics. `?seed=N` opens that exact problem.
 */
export default function PracticeSessionPage(): ReactNode {
  const { path } = useRoute()
  const topicId = matchPath('/practice/:topicId', path)?.topicId ?? ''
  if (topicId === 'weak') return <WeakSpotsPractice />
  if (!isTopicId(topicId)) return <UnknownTopic topicId={topicId} />
  return <TopicPractice topic={topicId} />
}
