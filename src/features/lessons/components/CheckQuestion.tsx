import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button } from '../../../components/ui/Button'
import { Callout } from '../../../components/ui/Callout'
import { Input } from '../../../components/ui/Input'
import { RichText } from '../../../components/ui/RichText'
import { checkChoice, checkHex, checkText, makeHexKey, type Verdict } from '../checkAnswer'
import type {
  CheckQuestion as CheckQuestionData,
  ChoiceQuestion,
  HexQuestion,
  TextQuestion,
} from '../types'
import { Code, CodeBlock } from './prose'

export interface CheckQuestionProps {
  question: CheckQuestionData
  /** Called after every right answer (the page marks the lesson done the first time). */
  onRight: () => void
  /** Shown under the feedback after a right answer, such as a link to the next lesson. */
  afterRight?: ReactNode
}

/**
 * The check question of a lesson, with instant feedback. A wrong answer can be changed
 * and checked again, as often as the student likes; the right answer is never shown
 * before the student gives it.
 */
export function CheckQuestion({ question, onRight, afterRight }: CheckQuestionProps): ReactNode {
  switch (question.kind) {
    case 'choice':
      return <ChoiceCheck question={question} onRight={onRight} afterRight={afterRight} />
    case 'hex':
      return <HexCheck question={question} onRight={onRight} afterRight={afterRight} />
    case 'text':
      return <TextCheck question={question} onRight={onRight} afterRight={afterRight} />
    default:
      return <QuestionProblem />
  }
}

interface WidgetProps<Q> {
  question: Q
  onRight: () => void
  afterRight?: ReactNode
}

/** The last verdict, and how many times Check was pressed (so the same words are read again). */
interface Checked {
  verdict: Verdict
  attempt: number
}

function useChecking(onRight: () => void) {
  const [checked, setChecked] = useState<Checked | null>(null)
  const show = (verdict: Verdict) => {
    setChecked((old) => ({ verdict, attempt: (old?.attempt ?? 0) + 1 }))
    if (verdict.result === 'right') onRight()
  }
  const clear = () => setChecked(null)
  return { checked, show, clear }
}

/**
 * "Correct" or "Not yet", always with an icon and the word. Something that is not an answer
 * yet (a blank, too few digits) gets a neutral note instead: it says what to fix, and it
 * does not look like a wrong answer. The region is always on the page, so screen readers
 * notice when words appear in it. A new attempt replaces the box, so the same sentence is
 * read out again when the same answer is checked again. After a right answer,
 * `afterRight` is read out with it ("Lesson 1 is done.").
 */
function Feedback({
  checked,
  afterRight,
}: {
  checked: Checked | null
  afterRight?: ReactNode
}): ReactNode {
  const result = checked?.verdict.result
  const right = result === 'right'
  return (
    <div aria-live="polite" aria-atomic="true" data-feedback={result ?? 'none'}>
      {checked !== null && (
        <Callout
          key={checked.attempt}
          tone={right ? 'good' : result === 'retry' ? 'info' : 'bad'}
          label={right ? 'Correct' : result === 'retry' ? 'Note' : 'Not yet'}
          className="mt-4 animate-fade-in"
        >
          <p>
            <RichText text={checked.verdict.message} />
          </p>
        </Callout>
      )}
      {right && afterRight}
    </div>
  )
}

function QuestionCode({ code }: { code: readonly string[] | undefined }): ReactNode {
  if (code === undefined || code.length === 0) return null
  return (
    <div className="mt-3">
      <CodeBlock label="Code for the question">{code.join('\n')}</CodeBlock>
    </div>
  )
}

/* ──────────────────────────────── choice ──────────────────────────────── */

function ChoiceCheck({ question, onRight, afterRight }: WidgetProps<ChoiceQuestion>): ReactNode {
  const groupName = useId()
  const [chosen, setChosen] = useState<string | null>(null)
  const { checked, show, clear } = useChecking(onRight)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    show(checkChoice(question, chosen))
  }

  return (
    <form onSubmit={submit} noValidate>
      {/* min-w-0: a fieldset is at least as wide as its widest line of code by default, which
          would push the page sideways on a phone. */}
      <fieldset className="min-w-0">
        <legend className="text-lg leading-snug font-semibold text-pretty">
          <RichText text={question.prompt} />
        </legend>
        <QuestionCode code={question.code} />
        <div className="mt-4 grid gap-2">
          {question.options.map((option) => {
            const inputId = `${groupName}-${option.id}`
            return (
              <label
                key={option.id}
                htmlFor={inputId}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-line-strong bg-surface px-3 py-2 transition-colors hover:bg-surface-2 has-checked:border-primary has-checked:bg-primary-soft"
              >
                <input
                  id={inputId}
                  type="radio"
                  name={groupName}
                  value={option.id}
                  checked={chosen === option.id}
                  onChange={() => {
                    setChosen(option.id)
                    // The old words were about the old choice.
                    clear()
                  }}
                  className="size-5 shrink-0 cursor-pointer accent-primary"
                />
                <span className="min-w-0">
                  <RichText text={option.label} />
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>
      <Button type="submit" variant="primary" className="mt-4">
        Check
      </Button>
      <Feedback checked={checked} afterRight={afterRight} />
    </form>
  )
}

/* ────────────────────────────── hex and text ────────────────────────────── */

interface AnswerFormProps {
  prompt: string
  code?: readonly string[]
  label: string
  /** A line under the label, such as "Type 16 hex digits." */
  help?: ReactNode
  check: (typed: string) => Verdict
  onRight: () => void
  afterRight?: ReactNode
}

/** A question answered by typing: a labelled box and Check (Enter checks too). */
function AnswerForm({
  prompt,
  code,
  label,
  help,
  check,
  onRight,
  afterRight,
}: AnswerFormProps): ReactNode {
  const promptId = useId()
  const helpId = useId()
  const inputId = useId()
  const [typed, setTyped] = useState('')
  const { checked, show } = useChecking(onRight)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    show(check(typed))
  }

  return (
    <form onSubmit={submit} noValidate>
      <p id={promptId} className="text-lg leading-snug font-semibold text-pretty">
        <RichText text={prompt} />
      </p>
      <QuestionCode code={code} />
      <label htmlFor={inputId} className="mt-4 block font-semibold">
        <RichText text={label} />
      </label>
      {help !== undefined && (
        <p id={helpId} className="text-sm text-muted">
          {help}
        </p>
      )}
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
        <Input
          id={inputId}
          mono
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={help === undefined ? promptId : `${promptId} ${helpId}`}
          aria-invalid={checked?.verdict.result === 'retry' ? true : undefined}
          className="sm:max-w-xs"
        />
        <Button type="submit" variant="primary" className="shrink-0">
          Check
        </Button>
      </div>
      <Feedback checked={checked} afterRight={afterRight} />
    </form>
  )
}

function HexCheck({ question, onRight, afterRight }: WidgetProps<HexQuestion>): ReactNode {
  // The right answer comes from running a program: once, when the question is shown.
  const [made] = useState(() => makeHexKey(question))

  useEffect(() => {
    if (!made.ok) console.error('The check question of this lesson has a problem.', made.error)
  }, [made])

  if (!made.ok) return <QuestionProblem />
  // The help line is small (14 px). The lesson's <Code> keeps its `0x` at 14 px too.
  const help = (
    <>
      {question.digits === undefined
        ? 'Type a number in hex. You may start it with '
        : `Type ${question.digits} hex digits. You may start with `}
      <Code>0x</Code>.
    </>
  )
  return (
    <AnswerForm
      prompt={question.prompt}
      code={question.code}
      label={question.label}
      help={help}
      check={(typed) => checkHex(question, made.key, typed)}
      onRight={onRight}
      afterRight={afterRight}
    />
  )
}

function TextCheck({ question, onRight, afterRight }: WidgetProps<TextQuestion>): ReactNode {
  return (
    <AnswerForm
      prompt={question.prompt}
      code={question.code}
      label={question.label}
      check={(typed) => checkText(question, typed)}
      onRight={onRight}
      afterRight={afterRight}
    />
  )
}

/** A question that cannot be checked (a mistake in the lesson, not the student's). */
function QuestionProblem(): ReactNode {
  return (
    <Callout tone="warn" label="This question has a problem">
      <p>Stack Step made a mistake in this question. You did nothing wrong.</p>
      <p>You can still read the rest of the lesson.</p>
    </Callout>
  )
}
