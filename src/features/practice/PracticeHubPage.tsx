import { useId, useMemo, useState, type ReactNode } from 'react'
import { PageContainer, PageHeader } from '../../components/layout/Page'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { ArrowRightIcon } from '../../components/ui/icons'
import { NotSavedNote } from '../../components/ui/NotSavedNote'
import { TOPICS, topicById } from '../../content/topics'
import { useProgress } from '../../lib/progress'
import { storageAvailable } from '../../lib/storage'
import { TopicCard } from './components/TopicCard'
// Only the mix of topics: the hub must not download the generators and the emulator.
import { hasPracticeHistory, QUIZ_LENGTH, weakMixWords, weakRotation } from './topicMix'

const CARD = 'flex min-w-0 flex-col rounded-2xl border border-line bg-surface p-5 shadow-xs md:p-6'

function WeakSpotsCard(): ReactNode {
  const headingId = useId()
  const progress = useProgress()
  const rotation = useMemo(() => weakRotation(progress), [progress])
  const tried = hasPracticeHistory(progress)
  return (
    <section aria-labelledby={headingId} className={CARD} data-weak-spots-card="">
      <h2 id={headingId} className="text-xl leading-tight font-bold">
        Practice my weak spots
      </h2>
      <p className="mt-2 text-pretty text-muted" data-weak-spots-words="">
        {tried
          ? `Problems from ${weakMixWords(progress, rotation)}, taking turns:`
          : 'You have no results yet, so this mix starts with the first topics:'}
      </p>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Topics in the mix">
        {rotation.map((topic) => (
          <li
            key={topic}
            className="rounded-full border border-line bg-surface-2 px-3 py-1 text-sm font-semibold"
          >
            {topicById(topic).title}
          </li>
        ))}
      </ul>
      <p className="mt-auto pt-5">
        <ButtonLink to="/practice/weak" variant="primary">
          Practice my weak spots
          <ArrowRightIcon size={18} />
        </ButtonLink>
      </p>
    </section>
  )
}

function QuizCard(): ReactNode {
  const headingId = useId()
  const { quizzes } = useProgress()
  const last = quizzes.at(-1)
  return (
    <section aria-labelledby={headingId} className={CARD} data-quiz-card="">
      <h2 id={headingId} className="text-xl leading-tight font-bold">
        Mixed quiz
      </h2>
      <p className="mt-2 text-pretty text-muted">
        {QUIZ_LENGTH} questions from all the topics, like a test. You see what was right and wrong
        at the end.
      </p>
      {last !== undefined && (
        <p className="mt-3 text-sm">
          Your last quiz:{' '}
          <strong className="tabular-nums">
            {last.score} of {last.total}
          </strong>
        </p>
      )}
      <p className="mt-auto pt-5">
        <ButtonLink to="/practice/quiz">
          Start the mixed quiz
          <ArrowRightIcon size={18} />
        </ButtonLink>
      </p>
    </section>
  )
}

/** The practice hub: every topic with its accuracy, the weak-spots mix and the mixed quiz. */
export default function PracticeHubPage(): ReactNode {
  const progress = useProgress()
  const topicsHeadingId = useId()
  // Checked once: when the browser blocks storage, practice still works, but say that the
  // results will not be kept.
  const [canSave] = useState(storageAvailable)
  return (
    <PageContainer data-practice-hub="">
      <PageHeader
        title="Practice"
        lead="Problems with new numbers every time. The emulator checks every answer, and a wrong answer shows you why."
      />
      {/* The same note, in the same words, as on the Learn and Progress pages. */}
      {!canSave && <NotSavedNote data-no-storage="" className="mb-6" />}
      <div className="grid gap-4 md:grid-cols-2">
        <WeakSpotsCard />
        <QuizCard />
      </div>
      <section aria-labelledby={topicsHeadingId} className="mt-10">
        <h2 id={topicsHeadingId} className="text-2xl leading-tight font-bold">
          Topics
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {TOPICS.map((topic) => (
            <TopicCard key={topic.id} topic={topic} stats={progress.practice[topic.id]} />
          ))}
        </ul>
      </section>
    </PageContainer>
  )
}
