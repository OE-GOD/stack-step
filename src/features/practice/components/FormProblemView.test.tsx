// @vitest-environment jsdom
/**
 * The form view of a problem, as a student meets it: labels, the Enter key, the hex
 * field's help, and the locked state with a mark on every field after Check.
 * The whole page (Check, feedback, Show me) is tested in a browser: e2e/practice.spec.ts.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProblem } from '../check'
import { generate as registerNames } from '../generators/register-names'
import { generate as subregisterWrites } from '../generators/subregister-writes'
import { MAX_ANSWER_LENGTH, type CheckResult, type Problem } from '../types'
import { FormProblemView } from './FormProblemView'

afterEach(() => {
  cleanup()
})

/** The view with its answers kept in state, as the page keeps them. */
function Harness({
  problem,
  result = null,
  onEnterLast,
  onEnterLocked,
}: {
  problem: Problem
  result?: CheckResult | null
  onEnterLast?: () => void
  onEnterLocked?: () => void
}): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  return (
    <FormProblemView
      problem={problem}
      answers={answers}
      onChange={(fieldId, value) => setAnswers((now) => ({ ...now, [fieldId]: value }))}
      locked={result !== null}
      result={result}
      onEnterLast={onEnterLast}
      onEnterLocked={onEnterLocked}
    />
  )
}

/** A register-names problem with two text-like fields. */
function twoFieldProblem(): Problem {
  for (let seed = 0; seed < 100; seed++) {
    const problem = registerNames(seed)
    if (problem.fields.length === 2) return problem
  }
  throw new Error('No two-field problem.')
}

describe('FormProblemView', () => {
  it('stops every typed answer at the longest answer a field takes', () => {
    // A quiz kept in the tab keeps no longer text either (session.ts parseRunningQuiz).
    for (const problem of [twoFieldProblem(), subregisterWrites(7)]) {
      cleanup()
      render(<Harness problem={problem} />)
      for (const field of problem.fields) {
        const input = screen.getByLabelText(field.label)
        expect(input.getAttribute('maxlength'), field.label).toBe(String(MAX_ANSWER_LENGTH))
      }
    }
  })

  it('gives every field a real label and the prompt as text', () => {
    const problem = twoFieldProblem()
    render(<Harness problem={problem} />)
    for (const field of problem.fields) {
      const input = screen.getByLabelText(field.label)
      expect(input.tagName).toBe('INPUT')
      expect(input.getAttribute('autocapitalize')).toBe('off')
      expect(input.getAttribute('spellcheck')).toBe('false')
    }
    const text = problem.prompt[0]?.type === 'text' ? problem.prompt[0].text : ''
    expect(document.body.textContent).toContain(text.replaceAll('`', ''))
  })

  it('moves to the next field on Enter, and asks the page to check on the last one', () => {
    const problem = twoFieldProblem()
    const onEnterLast = vi.fn()
    render(<Harness problem={problem} onEnterLast={onEnterLast} />)
    const [first, second] = problem.fields.map((field) => screen.getByLabelText(field.label))
    if (first === undefined || second === undefined) throw new Error('Two fields expected.')
    first.focus()
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(document.activeElement).toBe(second)
    expect(onEnterLast).not.toHaveBeenCalled()
    fireEvent.keyDown(second, { key: 'Enter' })
    expect(onEnterLast).toHaveBeenCalledTimes(1)
    // Enter while an input method is still composing a character does nothing.
    fireEvent.keyDown(second, { key: 'Enter', isComposing: true })
    expect(onEnterLast).toHaveBeenCalledTimes(1)
  })

  it('counts the digits of a whole register and groups them without changing the value', () => {
    const problem = subregisterWrites(7)
    const field = problem.fields[0]
    if (field === undefined) throw new Error('One field expected.')
    render(<Harness problem={problem} />)
    const input = screen.getByLabelText<HTMLInputElement>(field.label)
    expect(input.getAttribute('inputmode')).toBe('text')
    expect(screen.getByText('0 of 16 digits')).toBeDefined()

    fireEvent.change(input, { target: { value: '1111222233334444' } })
    expect(input.value).toBe('1111222233334444')
    expect(screen.getByText('16 of 16 digits')).toBeDefined()
    expect(input.style.backgroundImage).toContain('repeating-linear-gradient')
    expect(input.style.backgroundSize).toBe('16ch 1.5em')

    fireEvent.change(input, { target: { value: '0x1111 2222' } })
    expect(input.value).toBe('0x1111 2222')
    expect(screen.getByText('8 of 16 digits')).toBeDefined()

    fireEvent.change(input, { target: { value: '12g4' } })
    expect(screen.getByText('Use only the digits 0 to 9 and the letters a to f.')).toBeDefined()
  })

  it('locks the fields after Check and marks each one right or wrong, in words', () => {
    const problem = twoFieldProblem()
    const [first, second] = problem.fields
    if (first === undefined || second === undefined) throw new Error('Two fields expected.')
    const result = checkProblem(problem, { [first.id]: first.expected, [second.id]: '3' })
    const onEnterLocked = vi.fn()
    render(<Harness problem={problem} result={result} onEnterLocked={onEnterLocked} />)

    const inputs = problem.fields.map((field) => screen.getByLabelText(field.label))
    for (const input of inputs) expect(input).toHaveProperty('readOnly', true)
    expect(screen.getByText('Right')).toBeDefined()
    expect(screen.getByText('Wrong')).toBeDefined()
    expect(inputs[1]?.getAttribute('aria-invalid')).toBe('true')
    expect(inputs[0]?.getAttribute('aria-invalid')).toBeNull()

    // Enter in a locked field hands the focus to the page's main button.
    const firstInput = inputs[0]
    if (firstInput === undefined) throw new Error('No input.')
    fireEvent.keyDown(firstInput, { key: 'Enter' })
    expect(onEnterLocked).toHaveBeenCalledTimes(1)
  })

  it('shows a choice as a group of radio buttons named by its question', () => {
    const problem: Problem = {
      ...twoFieldProblem(),
      fields: [
        {
          id: 'verdict',
          label: 'Is this line legal?',
          kind: {
            type: 'choice',
            choices: [
              { id: 'legal', label: 'Legal' },
              { id: 'memory-to-memory', label: 'Illegal: memory to memory' },
            ],
          },
          expected: 'memory-to-memory',
          expectedDisplay: 'Illegal: memory to memory',
        },
      ],
    }
    render(<Harness problem={problem} />)
    const group = screen.getByRole('group', { name: 'Is this line legal?' })
    expect(group.tagName).toBe('FIELDSET')
    const legal = screen.getByLabelText('Legal')
    fireEvent.click(legal)
    expect(legal).toHaveProperty('checked', true)
  })
})
