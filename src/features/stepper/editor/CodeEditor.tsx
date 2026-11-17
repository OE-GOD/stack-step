/**
 * The code editor of the stepper page: CodeMirror 6 with assembly colors, line numbers,
 * breakpoints, the line that runs next, and error marks.
 *
 * It is a controlled component (see `types.ts`): the page owns the text and the marks.
 * This file is the only way in. Load it lazily, because CodeMirror is the largest
 * dependency of the site:
 *
 *   const CodeEditor = lazy(() => import('./editor/CodeEditor'))
 *
 * Keyboard (the full list is in `editorKeymap.ts`): Tab and Shift-Tab indent, Enter keeps
 * the indentation, Cmd/Ctrl+B switches the breakpoint of the cursor's line, Escape and
 * then Tab leaves the editor. Ctrl/Cmd+Enter (with or without Shift or Alt) is left to
 * the page. When the editor gets the focus from the keyboard, a small hint at its bottom
 * right says how to leave it again (until the first key press).
 *
 * The component is memoised: it renders again only when one of its props changes. Pass
 * stable callbacks (`useCallback`), so a step of the program re-renders it only when a
 * mark moves.
 */
import {
  memo,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { EditorView } from '@codemirror/view'
import { cx } from '../../../components/ui/cx'
import {
  createEditorView,
  goToLine,
  setAccessibleText,
  setBreakpointsFollow,
  setCoveredBottom,
  setWrapLines,
  showLine,
  syncEditor,
} from './editorSetup'
import { normalizeMarkers } from './lineMarkers'
import { describeMarkers, LEAVE_HINT, VISIBLE_LEAVE_HINT } from './markerText'
import type { CodeEditorProps } from './types'

/**
 * The classes of the outer element.
 *
 * - `[:where(&)]:h-full` and `[:where(&)]:w-full`: the editor fills its parent, but with
 *   a specificity of zero. A size in `className` (`h-80`, `flex-1`, `max-w-…`) always
 *   wins, whatever order Tailwind writes its utilities in.
 * - `contain-inline-size`: the longest line of code can never make this box (or the page
 *   around it) wider. The code scrolls inside the editor instead.
 */
const OUTER_CLASSES =
  '[:where(&)]:h-full [:where(&)]:w-full relative min-h-0 min-w-0 contain-inline-size bg-code-bg text-ink'

/**
 * Was the last thing the student did a key press (and not a click or a tap)? Then a focus
 * that arrives now came from the keyboard. (`:focus-visible` cannot tell: a text field
 * matches it after a click too.)
 */
let lastInputWasKey = false
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', () => (lastInputWasKey = true), { capture: true })
  window.addEventListener('pointerdown', () => (lastInputWasKey = false), { capture: true })
}

function CodeEditor({
  value,
  onChange,
  currentLine,
  lastLine,
  libraryLine,
  libraryName,
  breakpoints,
  onToggleBreakpoint,
  onBreakpointsChange,
  diagnostics,
  runtimeError,
  wrapLines = false,
  coveredBottom = 0,
  ariaLabel,
  className,
  ref,
}: CodeEditorProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const [keyboardHint, setKeyboardHint] = useState(false)

  const markers = useMemo(
    () =>
      normalizeMarkers({
        currentLine,
        lastLine,
        libraryLine,
        libraryName,
        breakpoints,
        diagnostics,
        runtimeError,
      }),
    [currentLine, lastLine, libraryLine, libraryName, breakpoints, diagnostics, runtimeError],
  )
  const breakpointsFollow = onBreakpointsChange !== undefined

  // Two hidden texts describe the text area for screen readers: how to leave it, and
  // which lines are marked.
  const hintId = useId()
  const summaryId = useId()
  const describedBy = `${hintId} ${summaryId}`

  // The editor is created once, but it must always call the newest callbacks and start
  // from the newest props. Effect Events read the latest values without being
  // dependencies of the effect.
  const emitChange = useEffectEvent((text: string) => {
    onChange(text)
  })
  const emitToggleBreakpoint = useEffectEvent((line: number) => {
    onToggleBreakpoint(line)
  })
  const emitBreakpointsChange = useEffectEvent((lines: number[]) => {
    onBreakpointsChange?.(lines)
  })
  const latestProps = useEffectEvent(() => ({
    doc: value,
    markers,
    label: ariaLabel,
    describedBy,
    breakpointsFollow,
    wrapLines,
    coveredBottom,
  }))

  // Create the editor once (twice under StrictMode: the first one is destroyed again).
  // A layout effect, so the editor is on the page before the browser paints.
  useLayoutEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const view = createEditorView(host, {
      ...latestProps(),
      onChange: (text) => emitChange(text),
      onToggleBreakpoint: (line) => emitToggleBreakpoint(line),
      onBreakpointsChange: (lines) => emitBreakpointsChange(lines),
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [])

  // Props changed: tell the editor. React never touches the editor's own elements, so
  // typing is not interrupted by a render.
  useLayoutEffect(() => {
    const view = viewRef.current
    if (view !== null) syncEditor(view, value, markers)
  }, [value, markers])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view !== null) setAccessibleText(view, { label: ariaLabel, describedBy })
  }, [ariaLabel, describedBy])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view !== null) setBreakpointsFollow(view, breakpointsFollow)
  }, [breakpointsFollow])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view !== null) setWrapLines(view, wrapLines)
  }, [wrapLines])

  useLayoutEffect(() => {
    const view = viewRef.current
    if (view !== null) setCoveredBottom(view, coveredBottom)
  }, [coveredBottom])

  // The visible hint: shown when the focus arrives from the keyboard, gone after the
  // first key press, a click, or when the focus leaves.
  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const onFocusIn = () => setKeyboardHint(lastInputWasKey)
    const hide = () => setKeyboardHint(false)
    host.addEventListener('focusin', onFocusIn)
    host.addEventListener('focusout', hide)
    host.addEventListener('keydown', hide)
    host.addEventListener('pointerdown', hide)
    return () => {
      host.removeEventListener('focusin', onFocusIn)
      host.removeEventListener('focusout', hide)
      host.removeEventListener('keydown', hide)
      host.removeEventListener('pointerdown', hide)
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      goToLine: (line: number) => {
        const view = viewRef.current
        if (view !== null) goToLine(view, line)
      },
      showLine: (line: number) => {
        const view = viewRef.current
        if (view !== null) showLine(view, line)
      },
    }),
    [],
  )

  return (
    <div className={cx(OUTER_CLASSES, className)}>
      <div ref={hostRef} className="h-full rounded-[inherit]" />
      {keyboardHint && (
        <p
          aria-hidden="true"
          data-leave-hint=""
          className="pointer-events-none absolute right-2 bottom-2 z-[2] animate-fade-in rounded-md border border-line-strong bg-surface px-2 py-0.5 text-xs font-semibold text-ink shadow-sm"
        >
          {VISIBLE_LEAVE_HINT}
        </p>
      )}
      <p id={hintId} className="sr-only">
        {LEAVE_HINT}
      </p>
      <p id={summaryId} className="sr-only">
        {describeMarkers(markers)}
      </p>
    </div>
  )
}

export default memo(CodeEditor)
