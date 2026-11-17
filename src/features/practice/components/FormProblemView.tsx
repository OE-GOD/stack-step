import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import type { ProblemViewProps } from '../types'
import { AnswerField, type EnterHint } from './AnswerInputs'
import { fieldsInOrder, fieldsInTrace } from './answerText'
import { PromptView } from './PromptView'

export interface FormProblemViewProps extends ProblemViewProps {
  /** Enter in the last field: the page checks the answer (or opens the next question). */
  onEnterLast?: () => void
  /** Enter in a field after Check: the page moves the keyboard focus to its main button. */
  onEnterLocked?: () => void
  /** The word on the Enter key of a phone keyboard in the last field. Default 'done'. */
  lastEnterHint?: EnterHint
}

/** Put the keyboard focus in a field (the picked radio button of a choice, or its first one). */
function focusField(root: HTMLElement | null, fieldId: string): void {
  if (root === null) return
  const inputs = [...root.querySelectorAll<HTMLInputElement>('[data-answer-input]')].filter(
    (input) => input.dataset.fieldId === fieldId,
  )
  const target = inputs.find((input) => input.checked) ?? inputs[0]
  target?.focus()
}

/**
 * A problem with `view: 'form'`: the prompt, then one input per field. Fields that a
 * `trace` block places sit in their row; the others are listed under the prompt.
 *
 * Enter moves to the next field; in the last field it calls `onEnterLast`.
 */
export function FormProblemView({
  problem,
  answers,
  onChange,
  locked,
  result,
  onEnterLast,
  onEnterLocked,
  lastEnterHint = 'done',
}: FormProblemViewProps): ReactNode {
  const idPrefix = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const ordered = fieldsInOrder(problem)
  const inTrace = fieldsInTrace(problem)
  const rest = ordered.filter((field) => !inTrace.has(field.id))

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (locked) {
      onEnterLocked?.()
      return
    }
    const next = ordered[index + 1]
    if (next !== undefined) focusField(rootRef.current, next.id)
    else onEnterLast?.()
  }

  const renderField = (fieldId: string, compact: boolean): ReactNode => {
    const index = ordered.findIndex((field) => field.id === fieldId)
    const field = ordered[index]
    if (field === undefined) return null
    return (
      <AnswerField
        key={field.id}
        field={field}
        compact={compact}
        inputId={`${idPrefix}-${field.id}`}
        value={answers[field.id] ?? ''}
        onChange={(value) => onChange(field.id, value)}
        locked={locked}
        result={result?.fields.find((entry) => entry.fieldId === field.id) ?? null}
        onKeyDown={onKeyDown(index)}
        enterKeyHint={index === ordered.length - 1 ? lastEnterHint : 'next'}
      />
    )
  }

  return (
    <div ref={rootRef} className="grid min-w-0 gap-6" data-problem-view="form">
      <PromptView
        prompt={problem.prompt}
        renderTraceField={(fieldId) => renderField(fieldId, true)}
      />
      {rest.length > 0 && (
        <div className="grid min-w-0 gap-5">
          {rest.map((field) => renderField(field.id, false))}
        </div>
      )}
    </div>
  )
}
