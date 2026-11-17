/**
 * The page of the editor harness: the code editor with a control for every prop.
 *
 * It plays the part of the stepper page. It owns the text and the marks, it loads the
 * editor lazily, and it listens for the page's own shortcuts (Ctrl/Cmd+Enter, with Shift,
 * with Alt) in the capture phase, as the real page does.
 *
 * Tests and the screenshot script can also set the state directly:
 *
 *   window.__editorHarness.set({ currentLine: 12, breakpoints: [9, 14] })
 *   window.__editorHarness.get()   // the state plus the counters
 *
 * and they can choose what the page starts with:
 *
 *   demo.html?example=read-number&line=40    (an example id, the line that runs next)
 */
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Diagnostic } from '../../../emulator'
import { EXAMPLES } from '../../../examples'

const CodeEditor = lazy(() => import('./CodeEditor'))

interface HarnessState {
  source: string
  currentLine: number | null
  libraryLine: number | null
  breakpoints: number[]
  diagnostics: Diagnostic[]
}

interface HarnessCounters {
  /** How often the editor called `onChange`. */
  changes: number
  /** How often the editor called `onToggleBreakpoint`. */
  toggles: number
  /** The page's own shortcuts: Ctrl/Cmd+Enter, +Shift, +Alt. */
  steps: number
  backs: number
  runs: number
}

interface EditorHarness {
  get: () => HarnessState & HarnessCounters
  set: (change: Partial<HarnessState>) => void
}

declare global {
  interface Window {
    __editorHarness?: EditorHarness
  }
}

/** A whole number of 1 or more from a text field; anything else means "no line". */
function toLine(text: string | null): number | null {
  const value = Number(text ?? '')
  return Number.isInteger(value) && value >= 1 ? value : null
}

/** What the page starts with: the first example, or what the address asks for. */
const QUERY = new URLSearchParams(window.location.search)
const START_EXAMPLE = EXAMPLES.find((entry) => entry.id === QUERY.get('example')) ?? EXAMPLES[0]

const START: HarnessState = {
  source: START_EXAMPLE?.source ?? '',
  currentLine: toLine(QUERY.get('line')),
  libraryLine: null,
  breakpoints: [],
  diagnostics: [],
}

const NO_COUNTS: HarnessCounters = { changes: 0, toggles: 0, steps: 0, backs: 0, runs: 0 }

function sampleError(line: number): Diagnostic {
  return {
    severity: 'error',
    code: 'unknown-instruction',
    line,
    message: `Line ${line}: \`mvo\` is not an instruction. Did you mean \`mov\`?`,
  }
}

function sampleWarning(line: number): Diagnostic {
  return {
    severity: 'warning',
    code: 'unknown-directive',
    line,
    message: `Line ${line}: Stack Step does not know the directive \`.weird\`. It is skipped.`,
  }
}

const WHOLE_PROGRAM_WARNING: Diagnostic = {
  severity: 'warning',
  code: 'no-main',
  line: 0,
  message: 'The program has no `main` label. It starts at the first instruction.',
}

export function EditorDemoPage(): ReactNode {
  const [state, setState] = useState<HarnessState>(START)
  const [counts, setCounts] = useState<HarnessCounters>(NO_COUNTS)
  const [exampleId, setExampleId] = useState(START_EXAMPLE?.id ?? '')
  const [markLine, setMarkLine] = useState('7')
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [pageShortcuts, setPageShortcuts] = useState(true)

  const change = (part: Partial<HarnessState>) => setState((old) => ({ ...old, ...part }))
  const count = (key: keyof HarnessCounters) =>
    setCounts((old) => ({ ...old, [key]: old[key] + 1 }))

  // For tests: the newest state, readable from outside React. A layout effect, so it is
  // up to date the moment the editor shows the new state.
  const latest = useRef({ ...state, ...counts })
  useLayoutEffect(() => {
    latest.current = { ...state, ...counts }
  }, [state, counts])

  useEffect(() => {
    window.__editorHarness = {
      get: () => latest.current,
      set: (part) => setState((old) => ({ ...old, ...part })),
    }
    return () => {
      delete window.__editorHarness
    }
  }, [])

  // The page's own shortcuts, handled in the capture phase before the editor sees the key.
  useEffect(() => {
    if (!pageShortcuts) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      const key = event.altKey ? 'runs' : event.shiftKey ? 'backs' : 'steps'
      setCounts((old) => ({ ...old, [key]: old[key] + 1 }))
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [pageShortcuts])

  const loadExample = (id: string) => {
    setExampleId(id)
    const example = EXAMPLES.find((entry) => entry.id === id)
    change({
      source: example?.source ?? '',
      currentLine: null,
      libraryLine: null,
      breakpoints: [],
      diagnostics: [],
    })
  }

  const toggleBreakpoint = (line: number) => {
    count('toggles')
    setState((old) => ({
      ...old,
      breakpoints: old.breakpoints.includes(line)
        ? old.breakpoints.filter((other) => other !== line)
        : [...old.breakpoints, line].sort((a, b) => a - b),
    }))
  }

  const addDiagnostic = (make: (line: number) => Diagnostic) => {
    const line = toLine(markLine)
    if (line !== null) change({ diagnostics: [...state.diagnostics, make(line)] })
  }

  const switchTheme = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    setDark(next)
  }

  return (
    <main className="demo-page">
      <h1 className="demo-title">Code editor harness</h1>

      <div className="demo-row">
        <label>
          Example
          <select value={exampleId} onChange={(event) => loadExample(event.target.value)}>
            {EXAMPLES.map((example) => (
              <option key={example.id} value={example.id}>
                {example.title}
              </option>
            ))}
            <option value="">Empty program</option>
          </select>
        </label>
        <button type="button" onClick={switchTheme}>
          {dark ? 'Light theme' : 'Dark theme'}
        </button>
      </div>

      <div className="demo-frame">
        <Suspense fallback={<p className="demo-loading">Loading the editor…</p>}>
          <CodeEditor
            value={state.source}
            onChange={(source) => {
              count('changes')
              change({ source })
            }}
            currentLine={state.currentLine}
            libraryLine={state.libraryLine}
            breakpoints={state.breakpoints}
            onToggleBreakpoint={toggleBreakpoint}
            diagnostics={state.diagnostics}
            ariaLabel="Assembly code"
            className="demo-editor"
          />
        </Suspense>
      </div>

      <div className="demo-row">
        <button type="button">Button after the editor</button>
        <dl className="demo-facts">
          <div>
            <dt>onChange calls</dt>
            <dd data-testid="changes">{counts.changes}</dd>
          </div>
          <div>
            <dt>Text length</dt>
            <dd data-testid="length">{state.source.length}</dd>
          </div>
          <div>
            <dt>Breakpoints</dt>
            <dd data-testid="breakpoints">{state.breakpoints.join(', ') || 'none'}</dd>
          </div>
          <div>
            <dt>Step / Back / Run keys</dt>
            <dd data-testid="shortcuts">
              {counts.steps} / {counts.backs} / {counts.runs}
            </dd>
          </div>
        </dl>
      </div>

      <fieldset className="demo-group">
        <legend>Running</legend>
        <div className="demo-row">
          <label>
            Current line
            <input
              type="number"
              min={1}
              value={state.currentLine ?? ''}
              onChange={(event) => change({ currentLine: toLine(event.target.value) })}
            />
          </label>
          <button
            type="button"
            onClick={() => change({ currentLine: (state.currentLine ?? 0) + 1, libraryLine: null })}
          >
            Next line
          </button>
          <label>
            Library line
            <input
              type="number"
              min={1}
              value={state.libraryLine ?? ''}
              onChange={(event) => change({ libraryLine: toLine(event.target.value) })}
            />
          </label>
          <button type="button" onClick={() => change({ currentLine: null, libraryLine: null })}>
            Not running
          </button>
          <button type="button" onClick={() => change({ breakpoints: [] })}>
            Clear breakpoints
          </button>
        </div>
      </fieldset>

      <fieldset className="demo-group">
        <legend>Errors and warnings</legend>
        <div className="demo-row">
          <label>
            Line
            <input
              type="number"
              min={1}
              value={markLine}
              onChange={(event) => setMarkLine(event.target.value)}
            />
          </label>
          <button type="button" onClick={() => addDiagnostic(sampleError)}>
            Add error
          </button>
          <button type="button" onClick={() => addDiagnostic(sampleWarning)}>
            Add warning
          </button>
          <button
            type="button"
            onClick={() => change({ diagnostics: [...state.diagnostics, WHOLE_PROGRAM_WARNING] })}
          >
            Add whole-program warning (line 0)
          </button>
          <button type="button" onClick={() => change({ diagnostics: [] })}>
            Clear errors and warnings
          </button>
        </div>
      </fieldset>

      <fieldset className="demo-group">
        <legend>The page</legend>
        <div className="demo-row">
          <button
            type="button"
            onClick={() => change({ source: `# A line from outside.\n${state.source}` })}
          >
            Add a first line from outside
          </button>
          <button type="button" onClick={() => change({ source: `${state.source}    nop\n` })}>
            Add a last line from outside
          </button>
          <label>
            <input
              type="checkbox"
              checked={pageShortcuts}
              onChange={(event) => setPageShortcuts(event.target.checked)}
            />
            The page handles Ctrl/Cmd+Enter
          </label>
        </div>
      </fieldset>
    </main>
  )
}
