import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './Button'
import { ButtonLink } from './ButtonLink'
import { Callout } from './Callout'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Called once with the error, after the message is on screen. */
  onError?: (error: unknown) => void
}

interface ErrorBoundaryState {
  failed: boolean
  /** True when the reason is a file that could not be downloaded. */
  downloadFailed: boolean
}

/**
 * What the browsers say when a page file, or a file it needs, could not be downloaded
 * (Chrome, Firefox and Safari each use other words; the build tool adds one more).
 */
const DOWNLOAD_ERROR =
  /dynamically imported module|importing a module script failed|unable to preload|^failed to fetch$|^load failed$|networkerror when attempting to fetch/i

function isDownloadError(error: unknown): boolean {
  return error instanceof Error && DOWNLOAD_ERROR.test(error.message)
}

/**
 * Catches an error in the page below it and shows a calm message instead of an empty
 * screen. The header and the footer keep working.
 *
 * There are two messages. A page file that could not be downloaded: "check your internet
 * connection". Anything else is a mistake in the site, and the message says so: the
 * student's connection is fine and the student did nothing wrong.
 *
 * To let the student try again on the next page, give it a `key` that changes with the
 * route: a new key makes a fresh boundary.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failed: false, downloadFailed: false }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { failed: true, downloadFailed: isDownloadError(error) }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the details for whoever opens the browser console.
    console.error('Stack Step could not show this page.', error, info.componentStack)
    this.props.onError?.(error)
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 md:px-6 md:py-16">
        <Callout tone="warn" label="Something went wrong" role="alert">
          {this.state.downloadFailed ? (
            <>
              <h1 className="text-xl font-bold">This page did not load</h1>
              <p>Check your internet connection. Then load the page again.</p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-bold">This page has a problem</h1>
              <p>Stack Step made a mistake. You did nothing wrong.</p>
              <p>Load the page again. If you see this message again, go to the home page.</p>
            </>
          )}
          <p className="flex flex-wrap gap-3 pt-2">
            <Button variant="primary" onClick={() => window.location.reload()}>
              Load the page again
            </Button>
            <ButtonLink to="/">Go to the home page</ButtonLink>
          </p>
        </Callout>
      </div>
    )
  }
}
