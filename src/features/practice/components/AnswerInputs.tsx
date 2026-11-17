import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { cx } from '../../../components/ui/cx'
import { FIELD_CLASSES } from '../../../components/ui/fieldStyles'
import { CheckCircleIcon, WarningIcon, XCircleIcon } from '../../../components/ui/icons'
import { RichText } from '../../../components/ui/RichText'
import { MAX_ANSWER_LENGTH, type Field, type FieldResult } from '../types'
import { digitCountText, digitsStartAt, hasNonHex, typedHexDigits } from './answerText'

/** Mobile keyboards show this word on their Enter key. */
export type EnterHint = 'next' | 'done' | 'go'

export interface AnswerFieldProps {
  field: Field
  /** The id of the input (or of the first radio button). */
  inputId: string
  value: string
  onChange: (value: string) => void
  /** After Check: the value can be read and selected, but not changed. */
  locked: boolean
  /** This field's part of the result, after Check. */
  result: FieldResult | null
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  enterKeyHint: EnterHint
}

/**
 * Keeps phone keyboards from changing what a student types, and stops the typing at the
 * longest answer a field takes (a quiz kept in the tab keeps no more than that).
 */
const PLAIN_TYPING = {
  autoCapitalize: 'off',
  autoCorrect: 'off',
  autoComplete: 'off',
  spellCheck: false,
  maxLength: MAX_ANSWER_LENGTH,
} as const

/** Faint bands behind every second group of four digits (digits are 1ch wide in the code font). */
const DIGIT_BANDS = 'repeating-linear-gradient(90deg, transparent 0 4ch, var(--c-chip) 4ch 8ch)'

/* ───────────────────────────── the right/wrong mark ───────────────────────────── */

export interface FieldMarkProps {
  result: FieldResult | null
  id?: string
  className?: string
}

/** After Check: an icon and a word next to a field ("Right" / "Wrong"), never color alone. */
export function FieldMark({ result, id, className }: FieldMarkProps): ReactNode {
  if (result === null) return null
  return result.correct ? (
    <span
      id={id}
      data-field-mark="right"
      className={cx('inline-flex items-center gap-1 font-semibold text-good', className)}
    >
      <CheckCircleIcon size={18} />
      Right
    </span>
  ) : (
    <span
      id={id}
      data-field-mark="wrong"
      className={cx('inline-flex items-center gap-1 font-semibold text-bad', className)}
    >
      <XCircleIcon size={18} />
      Wrong
    </span>
  )
}

function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const list = ids.filter((id): id is string => typeof id === 'string' && id !== '')
  return list.length > 0 ? list.join(' ') : undefined
}

/* ──────────────────────────────── a hex number ──────────────────────────────── */

function HexInput({
  field,
  inputId,
  value,
  onChange,
  locked,
  result,
  onKeyDown,
  enterKeyHint,
}: AnswerFieldProps): ReactNode {
  const digits = field.kind.type === 'hex' ? field.kind.digits : undefined
  const typedPrefix = /^\s*0x/i.test(value)
  const start = digits === undefined ? null : digitsStartAt(value)
  const typed = typedHexDigits(value)
  const notHex = hasNonHex(value)
  const hintId = `${inputId}-hint`
  const markId = `${inputId}-mark`

  // The typed digits are grouped in fours by bands behind them (only behind the digits that
  // are there); the value itself is never changed.
  const bands: CSSProperties | undefined =
    start !== null && typed !== null
      ? {
          backgroundImage: DIGIT_BANDS,
          backgroundOrigin: 'content-box',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: `${start}ch center`,
          backgroundSize: `${typed.length}ch 1.5em`,
        }
      : undefined

  return (
    <div className="grid gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className={cx('relative w-full', digits === 16 ? 'sm:max-w-80' : 'sm:max-w-56')}>
          {!typedPrefix && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-muted"
            >
              0x
            </span>
          )}
          <input
            id={inputId}
            type="text"
            inputMode="text"
            {...PLAIN_TYPING}
            enterKeyHint={enterKeyHint}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKeyDown}
            readOnly={locked}
            aria-invalid={result !== null && !result.correct ? true : undefined}
            aria-describedby={describedBy(
              result !== null && markId,
              digits !== undefined && hintId,
            )}
            data-answer-input=""
            data-field-id={field.id}
            className={cx(
              FIELD_CLASSES,
              'font-mono read-only:bg-surface-2',
              !typedPrefix && 'pl-[calc(0.75rem+2.25ch)]',
            )}
            style={bands}
          />
        </div>
        <FieldMark result={result} id={markId} />
      </div>
      {digits !== undefined && (
        <p id={hintId} className="text-sm text-muted">
          {notHex ? (
            <span className="inline-flex items-center gap-1 text-warn">
              <WarningIcon size={16} />
              Use only the digits 0 to 9 and the letters a to f.
            </span>
          ) : (
            digitCountText(value, digits)
          )}
        </p>
      )}
    </div>
  )
}

/* ────────────────────────────── a word or a number ───────────────────────────── */

function PlainInput({
  field,
  inputId,
  value,
  onChange,
  locked,
  result,
  onKeyDown,
  enterKeyHint,
}: AnswerFieldProps): ReactNode {
  const markId = `${inputId}-mark`
  const decimal = field.kind.type === 'decimal'
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <input
        id={inputId}
        type="text"
        inputMode={decimal ? 'numeric' : 'text'}
        {...PLAIN_TYPING}
        enterKeyHint={enterKeyHint}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        readOnly={locked}
        aria-invalid={result !== null && !result.correct ? true : undefined}
        aria-describedby={describedBy(result !== null && markId)}
        data-answer-input=""
        data-field-id={field.id}
        className={cx(
          FIELD_CLASSES,
          'font-mono read-only:bg-surface-2',
          decimal ? 'sm:max-w-40' : 'sm:max-w-56',
        )}
      />
      <FieldMark result={result} id={markId} />
    </div>
  )
}

/* ──────────────────────────────── pick one ──────────────────────────────── */

function ChoiceInput({
  field,
  inputId,
  value,
  onChange,
  locked,
  result,
  onKeyDown,
}: AnswerFieldProps): ReactNode {
  if (field.kind.type !== 'choice') return null
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-semibold">
        <span>
          <RichText text={field.label} />
        </span>
        <FieldMark result={result} />
      </legend>
      <div className="grid gap-2">
        {field.kind.choices.map((choice, index) => {
          const picked = value === choice.id
          const isRight = result !== null && choice.id === field.expected
          const wrongPick = result !== null && picked && !result.correct
          return (
            <label
              key={choice.id}
              className={cx(
                'flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2',
                picked ? 'border-primary bg-primary-soft' : 'border-line-strong bg-surface',
                locked && 'cursor-default',
              )}
            >
              <input
                id={index === 0 ? inputId : `${inputId}-${index}`}
                type="radio"
                name={inputId}
                value={choice.id}
                checked={picked}
                onChange={() => onChange(choice.id)}
                onKeyDown={onKeyDown}
                disabled={locked}
                data-answer-input=""
                data-field-id={field.id}
                className="size-5 shrink-0 accent-primary"
              />
              {/* `anywhere`: a long word may break, so that the "Right answer" mark beside it
                  never makes the box wider than a phone's card. */}
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <RichText text={choice.label} />
              </span>
              {isRight && (
                <span className="inline-flex items-center gap-1 text-sm font-semibold text-good">
                  <CheckCircleIcon size={16} />
                  Right answer
                </span>
              )}
              {wrongPick && (
                <span className="inline-flex items-center gap-1 text-sm font-semibold text-bad">
                  <XCircleIcon size={16} />
                  Your answer
                </span>
              )}
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/* ─────────────────────────────── any field ──────────────────────────────── */

/** The input that fits the field's kind. The label is drawn by the caller, except for a choice. */
export function AnswerInput(props: AnswerFieldProps): ReactNode {
  switch (props.field.kind.type) {
    case 'hex':
      return <HexInput {...props} />
    case 'choice':
      return <ChoiceInput {...props} />
    case 'text':
    case 'decimal':
    case 'chip':
      return <PlainInput {...props} />
  }
}

export interface AnswerFieldRowProps extends AnswerFieldProps {
  /** Smaller label, for a field inside a trace row. */
  compact?: boolean
}

/** A field with its real <label> (a choice uses its <legend>). */
export function AnswerField({ compact = false, ...props }: AnswerFieldRowProps): ReactNode {
  if (props.field.kind.type === 'choice') return <AnswerInput {...props} />
  return (
    <div className="grid min-w-0 gap-1.5" data-answer-field={props.field.id}>
      <label
        htmlFor={props.inputId}
        className={cx(compact ? 'text-sm text-muted' : 'font-semibold')}
      >
        <RichText text={props.field.label} />
      </label>
      <AnswerInput {...props} />
    </div>
  )
}
