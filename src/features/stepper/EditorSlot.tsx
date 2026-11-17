/**
 * The place of the code editor on the stepper page.
 *
 * - The editor (CodeMirror, the biggest dependency of the site) is downloaded only here,
 *   lazily. A calm box of the same size holds its place while it loads.
 * - If the editor cannot be shown (its file did not download on a school network, or it
 *   crashed), the page does not break: a plain text box takes its place, with the same
 *   text and the same name, so the student can go on editing and stepping.
 */
import { Component, lazy, memo, Suspense, useId, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '../../components/ui/Button'
import { Loading } from '../../components/ui/Spinner'
import type { CodeEditorProps } from './editor/types'

// CodeMirror is the biggest dependency of the site: it is downloaded only here.
const CodeEditor = lazy(() => import('./editor/CodeEditor'))

/** The box that holds the editor's place while its code downloads. */
function EditorLoading(): ReactNode {
  return (
    <div className="flex h-full items-center justify-center bg-code-bg">
      <Loading label="Loading the editor…" className="animate-appear text-sm" />
    </div>
  )
}

/** In place of an editor that could not be shown: a plain text box with the same text. */
function PlainCodeBox({
  value,
  onChange,
  ariaLabel,
}: Pick<CodeEditorProps, 'value' | 'onChange' | 'ariaLabel'>): ReactNode {
  const noteId = useId()
  return (
    <div data-plain-editor="" className="flex h-full flex-col bg-code-bg">
      <div
        id={noteId}
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-1.5 text-sm text-muted"
      >
        <span>The code editor could not load. You can edit your code in this plain box.</span>
        <Button size="sm" variant="ghost" className="underline" onClick={() => location.reload()}>
          Load the page again
        </Button>
      </div>
      <textarea
        aria-label={ariaLabel}
        aria-describedby={noteId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        wrap="off"
        className="min-h-0 w-full flex-1 resize-none bg-code-bg px-3 py-2 font-mono text-sm text-ink focus-visible:-outline-offset-2 pointer-coarse:text-base"
      />
    </div>
  )
}

interface EditorBoundaryProps {
  fallback: ReactNode
  children: ReactNode
}

/** Catches a failed download or a crash of the editor, and shows `fallback` instead. */
class EditorBoundary extends Component<EditorBoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Stack Step could not show the code editor.', error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/**
 * The code editor of the page, with its loading box and its fallback. Same props as the
 * editor (memoised like it: pass stable callbacks).
 */
export const EditorSlot = memo(function EditorSlot(props: CodeEditorProps): ReactNode {
  return (
    <EditorBoundary
      fallback={
        <PlainCodeBox value={props.value} onChange={props.onChange} ariaLabel={props.ariaLabel} />
      }
    >
      <Suspense fallback={<EditorLoading />}>
        <CodeEditor {...props} />
      </Suspense>
    </EditorBoundary>
  )
})
