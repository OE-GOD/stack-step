import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { PageContainer, PageHeader } from '../../components/layout/Page'
import { Button } from '../../components/ui/Button'
import { ButtonLink } from '../../components/ui/ButtonLink'
import { Callout } from '../../components/ui/Callout'
import { ArrowRightIcon } from '../../components/ui/icons'
import { NotSavedNote } from '../../components/ui/NotSavedNote'
import { LESSONS } from '../../content/lessonList'
import { resetProgress, useProgress } from '../../lib/progress'
import { storageAvailable } from '../../lib/storage'
import { ConfirmDialog } from './ConfirmDialog'
import { LessonsSection, PracticeSection, QuizSection, WeakTopicsSection } from './sections'
import { isEmptyProgress } from './summary'

/** For a new student: a short welcome and two ways to start. No table of zeros. */
function Welcome({ storageWorks }: { storageWorks: boolean }): ReactNode {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="max-w-2xl rounded-2xl border border-line bg-surface p-5 shadow-xs md:p-8"
    >
      <h2 id={headingId} className="text-2xl leading-tight font-bold">
        Welcome
      </h2>
      <p className="mt-2 text-lg text-pretty text-muted">
        You have not finished a lesson or answered a practice problem yet. When you do, this page
        shows your progress.
      </p>
      <p className="mt-6 flex flex-col gap-3 sm:flex-row">
        <ButtonLink to={`/learn/${LESSONS[0].id}`} variant="primary" size="lg">
          Start lesson 1
          <ArrowRightIcon size={20} />
        </ButtonLink>
        <ButtonLink to="/practice" size="lg">
          Try a practice problem
        </ButtonLink>
      </p>
      {storageWorks && (
        <p className="mt-6 text-sm text-muted">Your progress is stored only in this browser.</p>
      )}
    </section>
  )
}

/**
 * The progress page: lessons done, practice accuracy for each topic, the weakest topics
 * (three at most), the mixed quizzes, and a way to start again.
 *
 * Everything comes from the progress store in this browser (`useProgress`); nothing is
 * sent anywhere.
 */
export default function ProgressPage(): ReactNode {
  const progress = useProgress()
  const empty = isEmptyProgress(progress)
  // Asked once: the answer cannot change while the page is open.
  const [storageWorks] = useState(storageAvailable)

  const [confirming, setConfirming] = useState(false)
  const [justReset, setJustReset] = useState(false)
  const resetMessageRef = useRef<HTMLDivElement | null>(null)
  const resetHeadingId = useId()

  // After a reset the button that had focus is gone. Put focus on the message that says
  // what happened, so keyboard and screen reader users are not left at the top of the page.
  useEffect(() => {
    if (justReset) resetMessageRef.current?.focus()
  }, [justReset])

  const reset = () => {
    resetProgress()
    setConfirming(false)
    setJustReset(true)
  }

  return (
    <PageContainer>
      <PageHeader
        title="Progress"
        lead="The lessons you have finished, your practice results, and the topics to practice next."
      />

      {/* The same note, in the same words, as on the Learn and Practice pages. */}
      {!storageWorks && <NotSavedNote data-no-storage="" className="mb-6 max-w-2xl" />}

      {justReset && empty && (
        <Callout
          ref={resetMessageRef}
          tabIndex={-1}
          role="status"
          tone="good"
          label="Done"
          className="mb-6 max-w-2xl"
        >
          <p>Your progress is reset. You can start again.</p>
        </Callout>
      )}

      {empty ? (
        <Welcome storageWorks={storageWorks} />
      ) : (
        <>
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <LessonsSection progress={progress} />
            <div className="grid gap-5">
              <PracticeSection progress={progress} />
              <WeakTopicsSection progress={progress} />
              <QuizSection progress={progress} />
            </div>
          </div>

          <section aria-labelledby={resetHeadingId} className="mt-10 border-t border-line pt-6">
            <h2 id={resetHeadingId} className="text-xl leading-tight font-bold">
              Start again
            </h2>
            <p className="mt-2 max-w-2xl text-pretty text-muted">
              {storageWorks && 'Your progress is stored only in this browser. '}
              You can erase it and start again from the first lesson.
            </p>
            <p className="mt-4">
              <Button variant="danger" onClick={() => setConfirming(true)}>
                Reset my progress
              </Button>
            </p>
          </section>
        </>
      )}

      <ConfirmDialog
        open={confirming}
        title="Reset your progress?"
        confirmLabel="Yes, reset my progress"
        danger
        onConfirm={reset}
        onCancel={() => setConfirming(false)}
      >
        <p>
          This erases your finished lessons, your practice results and your quiz scores in this
          browser.
        </p>
        <p>You cannot undo this.</p>
      </ConfirmDialog>
    </PageContainer>
  )
}
