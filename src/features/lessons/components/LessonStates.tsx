import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../../../components/ui/Button'
import { Callout } from '../../../components/ui/Callout'
import { Loading } from '../../../components/ui/Spinner'
import { COLUMN } from './layout'

/*
 * What the lesson page shows instead of a lesson: while it loads, and when it has a
 * problem. The page's <h1> (the lesson title) stays above both, so each one has an <h2>
 * and never an <h1>.
 */

/** While the lesson file downloads. A quick download shows nothing at all. */
export function LessonLoading(): ReactNode {
  return (
    <div className={COLUMN}>
      <Loading label="Loading the lesson…" className="animate-appear" />
    </div>
  )
}

export interface LessonProblemProps {
  /** True when the lesson file could not be downloaded (the student can try again). */
  downloadFailed?: boolean
  onRetry?: () => void
}

/** The lesson could not be shown: its file did not download, or it is missing or broken. */
export function LessonProblem({ downloadFailed = false, onRetry }: LessonProblemProps): ReactNode {
  return (
    <div className={COLUMN}>
      <Callout tone="warn" label="Something went wrong" role="alert" data-lesson-state="problem">
        {downloadFailed ? (
          <>
            <h2 className="text-xl leading-tight font-bold">This lesson did not load</h2>
            <p>Check your internet connection. Then try again.</p>
          </>
        ) : (
          <>
            <h2 className="text-xl leading-tight font-bold">This lesson has a problem</h2>
            <p>Stack Step made a mistake. You did nothing wrong.</p>
            <p>You can open another lesson.</p>
          </>
        )}
        {onRetry !== undefined && (
          <p className="pt-2">
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          </p>
        )}
      </Callout>
    </div>
  )
}

interface LessonErrorBoundaryProps {
  children: ReactNode
}

interface LessonErrorBoundaryState {
  failed: boolean
}

/**
 * Catches a mistake inside a lesson file (its body, its example, its question) and shows
 * a calm message in its place. The title above and the links below keep working.
 */
export class LessonErrorBoundary extends Component<
  LessonErrorBoundaryProps,
  LessonErrorBoundaryState
> {
  override state: LessonErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): LessonErrorBoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the details for whoever opens the browser console.
    console.error('Stack Step could not show this lesson.', error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.failed ? <LessonProblem /> : this.props.children
  }
}
