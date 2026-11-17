import { useId, useState, type ReactNode } from 'react'
import { MiniStepper } from '../../../components/ministepper/MiniStepper'
import { Button } from '../../../components/ui/Button'
import { buttonClasses } from '../../../components/ui/buttonStyles'
import { Callout } from '../../../components/ui/Callout'
import { cx } from '../../../components/ui/cx'
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  InfoIcon,
  XCircleIcon,
} from '../../../components/ui/icons'
import { RichText } from '../../../components/ui/RichText'
import { VisuallyHidden } from '../../../components/ui/VisuallyHidden'
import { stepperUrl } from '../../../lib/share'
import type { CheckResult, Field, Mistake, Problem } from '../types'
import { givenText } from './answerText'
import { HexText } from './HexText'

/* ──────────────────────────── your answer, right answer ──────────────────────────── */

/** A chip label such as "rax = 0x0000000000000005": the number in groups of four. */
const ENDS_IN_HEX = /^(.*?)(0x[0-9a-f]+)$/i

function AnswerValue({ field, text }: { field: Field; text: string }): ReactNode {
  if (field.kind.type === 'hex') return <HexText text={text} />
  if (field.kind.type === 'text' || field.kind.type === 'decimal') {
    return <span className="font-mono [overflow-wrap:anywhere]">{text}</span>
  }
  const hexAtEnd = field.kind.type === 'chip' ? ENDS_IN_HEX.exec(text) : null
  if (hexAtEnd !== null) {
    return (
      <span className="font-mono">
        {hexAtEnd[1]}
        <HexText text={hexAtEnd[2] ?? ''} />
      </span>
    )
  }
  return <RichText text={text} />
}

export interface AnswerRowsProps {
  problem: Problem
  result: CheckResult
  /** Show only the fields that are wrong (default), or every field. */
  onlyWrong?: boolean
}

function GivenValue({ field, text }: { field: Field; text: string }): ReactNode {
  return text === '' ? (
    <span className="text-muted italic">blank</span>
  ) : (
    <AnswerValue field={field} text={text} />
  )
}

/** "Right" or "Wrong" for one part, as an icon with the word for screen readers. */
function PartMark({ correct }: { correct: boolean }): ReactNode {
  return correct ? (
    <span className="ml-1.5 inline-flex align-[-0.15em] text-good">
      <CheckCircleIcon size={16} />
      <VisuallyHidden> (right)</VisuallyHidden>
    </span>
  ) : (
    <span className="ml-1.5 inline-flex align-[-0.15em] text-bad">
      <XCircleIcon size={16} />
      <VisuallyHidden> (wrong)</VisuallyHidden>
    </span>
  )
}

interface AnswerRow {
  entry: CheckResult['fields'][number]
  field: Field
  given: string
}

/** One part: its name (when the problem has several), then the two answers one above the other. */
function OneAnswer({
  row,
  showLabel,
  showMark,
}: {
  row: AnswerRow
  showLabel: boolean
  showMark: boolean
}): ReactNode {
  return (
    <div className="min-w-0" data-answer-row={row.field.id}>
      {showLabel && (
        <p className="text-sm font-semibold">
          <RichText text={row.field.label} />
        </p>
      )}
      <dl className="grid min-w-0 items-baseline gap-x-3 sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-0.5">
        <dt className="text-sm text-muted">Your answer</dt>
        <dd className="mb-1 min-w-0 sm:mb-0" data-your-answer="">
          <GivenValue field={row.field} text={row.given} />
          {showMark && <PartMark correct={row.entry.correct} />}
        </dd>
        <dt className="text-sm text-muted">Right answer</dt>
        <dd className="min-w-0 font-semibold" data-right-answer="">
          <AnswerValue field={row.field} text={row.entry.expectedDisplay} />
        </dd>
      </dl>
    </div>
  )
}

/** A value this short (0xf28, rax, 16) leaves room for three columns on a phone. */
const SHORT_VALUE = 10

/**
 * "Your answer" and "Right answer" for each wrong part (or each part, with `onlyWrong`
 * false). One part: the two answers one above the other, so their digits line up.
 * Several parts: a small table, one row per part. On a narrow screen the table stays when
 * every value is short; with long values (16 hex digits, a chip) the parts are listed one
 * under the other instead.
 */
export function AnswerRows({ problem, result, onlyWrong = true }: AnswerRowsProps): ReactNode {
  const rows: AnswerRow[] = result.fields.flatMap((entry) => {
    const field = problem.fields.find((candidate) => candidate.id === entry.fieldId)
    if (field === undefined || (onlyWrong && entry.correct)) return []
    return [{ entry, field, given: givenText(problem, field, entry) }]
  })
  const first = rows[0]
  if (first === undefined) return null
  const several = problem.fields.length > 1

  if (rows.length === 1) return <OneAnswer row={first} showLabel={several} showMark={!onlyWrong} />

  const short = rows.every(
    (row) => row.given.length <= SHORT_VALUE && row.entry.expectedDisplay.length <= SHORT_VALUE,
  )
  return (
    <>
      {!short && (
        <div className="grid gap-3 sm:hidden">
          {rows.map((row) => (
            <OneAnswer key={row.field.id} row={row} showLabel showMark={!onlyWrong} />
          ))}
        </div>
      )}
      <div
        className={cx('max-w-full overflow-x-auto', !short && 'hidden sm:block')}
        data-answer-table=""
      >
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">Your answers and the right answers</caption>
          <thead className="text-muted">
            <tr>
              <th scope="col" className="py-1 pr-3 font-semibold">
                Part
              </th>
              <th scope="col" className="py-1 pr-3 font-semibold">
                Your answer
              </th>
              <th scope="col" className="py-1 font-semibold">
                Right answer
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entry, field, given }) => (
              <tr key={field.id} className="border-t border-line" data-answer-row={field.id}>
                <th scope="row" className="py-1.5 pr-3 align-top font-medium">
                  <RichText text={field.label} />
                </th>
                <td className="py-1.5 pr-3 align-top" data-your-answer="">
                  <GivenValue field={field} text={given} />
                  {!onlyWrong && <PartMark correct={entry.correct} />}
                </td>
                <td className="py-1.5 align-top font-semibold" data-right-answer="">
                  <AnswerValue field={field} text={entry.expectedDisplay} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/* ──────────────────────────────── the named mistake ──────────────────────────────── */

/** Messages that are not a "common mistake": a blank part, or too few digits. */
const PLAIN_MESSAGES: ReadonlySet<Mistake['code']> = new Set(['unanswered', 'missing-digits'])

export function MistakeLine({ mistake }: { mistake: Mistake | null }): ReactNode {
  if (mistake === null) return null
  return (
    <p data-testid="mistake" data-mistake-code={mistake.code}>
      {!PLAIN_MESSAGES.has(mistake.code) && <strong>Common mistake: </strong>}
      <RichText text={mistake.message} />
    </p>
  )
}

/* ───────────────────────────────── the result ─────────────────────────────────── */

export interface FeedbackMessageProps {
  problem: Problem
  result: CheckResult
}

/**
 * "Correct" with the reason, or "Not yet" with the named mistake first (the one sentence
 * that says what went wrong, in view even on a phone), then the answers and the reason.
 */
export function FeedbackMessage({ problem, result }: FeedbackMessageProps): ReactNode {
  if (result.correct) {
    return (
      <Callout tone="good" label="Correct" data-result="correct">
        <p>
          <RichText text={result.reason} />
        </p>
      </Callout>
    )
  }
  return (
    <Callout tone="bad" label="Not yet" data-result="wrong">
      <MistakeLine mistake={result.mistake} />
      <AnswerRows problem={problem} result={result} />
      <p>
        <RichText text={result.reason} />
      </p>
    </Callout>
  )
}

/* ─────────────────────────────────── show me ──────────────────────────────────── */

export interface ShowMeProps {
  problem: Problem
  /** Also offer the inline MiniStepper (default true). */
  inline?: boolean
  /** Words for screen readers when a page has several: "question 3". */
  which?: string
}

/**
 * "Show me": a real link that opens this exact problem in the stepper, in a new tab (so
 * the practice page stays), and a toggle that steps through it right here.
 */
export function ShowMe({ problem, inline = true, which }: ShowMeProps): ReactNode {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const { code, options, note } = problem.stepper
  return (
    <div className="grid min-w-0 gap-3" data-show-me="">
      <div className="flex flex-wrap gap-2">
        <a
          href={stepperUrl(problem.stepper)}
          target="_blank"
          rel="noopener"
          className={buttonClasses({ variant: 'secondary' })}
        >
          Show me
          {which !== undefined && <VisuallyHidden> {which}</VisuallyHidden>}
          <ArrowRightIcon size={18} />
          <VisuallyHidden> (opens the stepper in a new tab)</VisuallyHidden>
        </a>
        {inline && (
          <Button
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((now) => !now)}
          >
            <ChevronDownIcon
              size={18}
              className={cx('transition-transform', open && 'rotate-180')}
            />
            Step through it here
            {which !== undefined && <VisuallyHidden> ({which})</VisuallyHidden>}
          </Button>
        )}
      </div>
      {inline && (
        <div id={panelId} hidden={!open} className="min-w-0">
          {open && (
            <div className="grid min-w-0 gap-2">
              {note !== undefined && note !== '' && (
                <p className="flex items-start gap-2 text-muted">
                  <InfoIcon size={18} className="mt-0.5 text-primary" />
                  <span>
                    <RichText text={note} />
                  </span>
                </p>
              )}
              <MiniStepper
                source={code}
                options={options}
                title="This problem, step by step"
                openInStepper={false}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
