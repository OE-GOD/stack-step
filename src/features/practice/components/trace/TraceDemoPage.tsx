/**
 * The page of the trace-table harness: `TraceTableView` with a hand-written problem, a
 * Check button and the result, the way the practice page will use it.
 *
 *   demo.html?problem=2          the second sample problem (1, 2 or 3)
 *   demo.html?theme=dark         start in the dark theme
 *   demo.html?frame=card         put the table in a padded card (a narrower box)
 *
 * It plays the part of the practice page: it owns the answers, it locks the table after
 * Check, and it shows `result.reason` and `result.mistake`. Tests and scripts can also
 * read and set its state:
 *
 *   window.__traceHarness.get()                       answers, locked, result, the onChange calls
 *   window.__traceHarness.setAnswers({ line1: 'p1-a' })
 *   window.__traceHarness.check() / .reset()
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '../../../../components/ui/Button'
import { Callout } from '../../../../components/ui/Callout'
import { RichText } from '../../../../components/ui/RichText'
import { checkProblem } from '../../check'
import type { CheckResult } from '../../types'
import TraceTableView from '../TraceTableView'
import type { AnswerChange } from './placement'
import { SAMPLE_PROBLEMS } from './sampleProblems'

interface HarnessSnapshot {
  problemId: string
  answers: Record<string, string>
  locked: boolean
  result: CheckResult | null
  /** Every `onChange(fieldId, value)` call so far, oldest first. */
  changes: AnswerChange[]
}

interface TraceHarness {
  get: () => HarnessSnapshot
  setAnswers: (answers: Record<string, string>) => void
  check: () => void
  reset: () => void
}

declare global {
  interface Window {
    __traceHarness?: TraceHarness
  }
}

const QUERY = new URLSearchParams(window.location.search)
const WANTED = Number(QUERY.get('problem') ?? '1')
const PROBLEM_INDEX =
  Number.isInteger(WANTED) && WANTED >= 1 && WANTED <= SAMPLE_PROBLEMS.length ? WANTED - 1 : 0
const IN_CARD = QUERY.get('frame') === 'card'

/** The address of this page for another sample problem, keeping the other choices. */
function hrefForProblem(number: number): string {
  const query = new URLSearchParams(window.location.search)
  query.set('problem', String(number))
  return `?${query.toString()}`
}

export function TraceDemoPage(): ReactNode {
  const problem = SAMPLE_PROBLEMS[PROBLEM_INDEX]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [result, setResult] = useState<CheckResult | null>(null)
  const [changes, setChanges] = useState<AnswerChange[]>([])
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const locked = result !== null

  // Like the practice page: one field at a time, on top of the newest answers. A move
  // from one line to another calls this twice in a row, so it must not use a stale copy.
  const onChange = (fieldId: string, value: string) => {
    setAnswers((old) => ({ ...old, [fieldId]: value }))
    setChanges((old) => [...old, { fieldId, value }])
  }

  const check = () => {
    if (problem !== undefined) setResult(checkProblem(problem, answers))
  }

  const reset = () => {
    setAnswers({})
    setResult(null)
    setChanges([])
  }

  // For tests: the newest state and the actions, reachable from outside React.
  const latest = useRef({ answers, result, changes, check, reset })
  useLayoutEffect(() => {
    latest.current = { answers, result, changes, check, reset }
  })
  useEffect(() => {
    window.__traceHarness = {
      get: () => ({
        problemId: problem?.id ?? '',
        answers: latest.current.answers,
        locked: latest.current.result !== null,
        result: latest.current.result,
        changes: latest.current.changes,
      }),
      setAnswers: (next) => setAnswers(next),
      check: () => latest.current.check(),
      reset: () => latest.current.reset(),
    }
    return () => {
      delete window.__traceHarness
    }
  }, [problem])

  const switchTheme = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    setDark(next)
  }

  if (problem === undefined) return <p className="p-4">There is no sample problem.</p>

  const view = (
    <TraceTableView
      problem={problem}
      answers={answers}
      onChange={onChange}
      locked={locked}
      result={result}
    />
  )

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-[45vh] md:px-6 md:pt-10">
      <header className="mb-5 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h1 className="text-2xl leading-tight font-extrabold tracking-tight">Trace table</h1>
        <nav aria-label="Sample problems" className="flex flex-wrap items-center gap-x-3 text-sm">
          {SAMPLE_PROBLEMS.map((entry, index) => (
            <a
              key={entry.id}
              href={hrefForProblem(index + 1)}
              aria-current={index === PROBLEM_INDEX ? 'page' : undefined}
              className="rounded-sm font-medium text-primary underline underline-offset-2 aria-[current]:font-bold aria-[current]:text-ink aria-[current]:no-underline"
            >
              Problem {index + 1}
            </a>
          ))}
          <Button size="sm" variant="ghost" onClick={switchTheme}>
            {dark ? 'Light theme' : 'Dark theme'}
          </Button>
        </nav>
      </header>

      {IN_CARD ? (
        <div className="rounded-xl border border-line bg-surface p-4 shadow-xs">{view}</div>
      ) : (
        view
      )}

      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="primary" onClick={check} disabled={locked}>
          Check
        </Button>
        <Button onClick={reset}>Try again</Button>
      </div>

      <div aria-live="polite" data-testid="result" className="mt-4 max-w-3xl">
        {result !== null &&
          (result.correct ? (
            <Callout tone="good" label="Correct">
              <p>
                <RichText text={result.reason} />
              </p>
            </Callout>
          ) : (
            <Callout tone="bad" label="Not yet">
              <p>
                <RichText text={result.reason} />
              </p>
              {result.mistake !== null && (
                <p data-testid="mistake" data-mistake-code={result.mistake.code}>
                  <strong>Common mistake:</strong> <RichText text={result.mistake.message} />
                </p>
              )}
            </Callout>
          ))}
      </div>

      <details className="mt-6 text-sm text-muted">
        <summary className="cursor-pointer">State (for developers)</summary>
        <pre data-testid="answers" className="mt-2 font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify({ answers, onChangeCalls: changes }, null, 1)}
        </pre>
      </details>
    </main>
  )
}
