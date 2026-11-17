// @vitest-environment jsdom
/**
 * The pieces of feedback that the browser review asked to change: the named mistake comes
 * first, short answers keep their table on a phone, the quiz review folds the right
 * questions away, the quiz has a map of its questions, and a double tap on a button that
 * changes its job does only one thing. The whole pages are tested in a browser:
 * e2e/practice.spec.ts.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProblem } from '../check'
import { makeProblem } from '../generators'
import { gradeQuiz, type QuizQuestion } from '../session'
import { digitCountText } from './answerText'
import { FeedbackMessage } from './Feedback'
import { PRESS_GUARD_MS, usePressGuard } from './pressGuard'
import { QuizMap } from './QuizMap'
import { QuizReview } from './QuizReview'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** The right answers of a problem, with some fields changed. */
function answersFor(
  fields: readonly { id: string; expected: string }[],
  changes: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...Object.fromEntries(fields.map((field) => [field.id, field.expected])), ...changes }
}

describe('the feedback after a wrong answer', () => {
  it('names the mistake first, before the answers and the reason', () => {
    const problem = makeProblem('subregister-writes', 0)
    // Seed 0: `mov eax, edx`; the old top half kept is the classic slip.
    const result = checkProblem(problem, { after: '0x4231788ac39c8f2b' })
    expect(result.mistake?.code).toBe('forgot-zero-upper')
    render(<FeedbackMessage problem={problem} result={result} />)
    const mistake = screen.getByTestId('mistake')
    const answer = document.querySelector('[data-answer-row]')
    expect(answer).not.toBeNull()
    // The mistake comes before the answer row in the page.
    expect(
      mistake.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('keeps the three-column table on a phone when every value is short (rsp after each step)', () => {
    const problem = makeProblem('rsp-tracker', 1)
    const wrong = Object.fromEntries(problem.fields.map((field) => [field.id, '0x10']))
    render(<FeedbackMessage problem={problem} result={checkProblem(problem, wrong)} />)
    const table = document.querySelector('[data-answer-table]')
    expect(table).not.toBeNull()
    // No "hidden" on phones, and no stacked copy of the rows.
    expect(table?.className).not.toContain('hidden')
    expect(document.querySelectorAll('[data-answer-row]')).toHaveLength(problem.fields.length)
  })

  it('stacks the parts on a phone when a value is long (a chip of the trace table)', () => {
    const problem = makeProblem('homework-table', 0)
    const right = answersFor(problem.fields)
    const chips = problem.chips ?? []
    const other = chips.find((chip) => chip.id !== right.line1 && chip.id !== right.line2)
    const swapped = { ...right, line1: right.line2 ?? '', line2: other?.id ?? '' }
    render(<FeedbackMessage problem={problem} result={checkProblem(problem, swapped)} />)
    expect(document.querySelector('[data-answer-table]')?.className).toContain('hidden sm:block')
  })
})

describe('the digit counter of a 16-digit field', () => {
  it('counts up to 16, then says how many are too many', () => {
    expect(digitCountText('0x1234', 16)).toBe('4 of 16 digits')
    expect(digitCountText('0000000000000000', 16)).toBe('16 of 16 digits')
    expect(digitCountText('0x000000000c39c8f2b', 16)).toBe('17 digits: 1 too many')
    expect(digitCountText('', 16)).toBe('0 of 16 digits')
  })
})

/* ──────────────────────────────── the quiz ──────────────────────────────── */

function quizOf(topics: Parameters<typeof makeProblem>[0][]): QuizQuestion[] {
  return topics.map((topic, index) => ({
    number: index + 1,
    topic,
    problem: makeProblem(topic, 10 + index),
  }))
}

describe('the map of the quiz questions', () => {
  it('has one button per question that says, in words, if it has an answer', () => {
    const questions = quizOf(['rip', 'call-ret', 'register-names'])
    const onGo = vi.fn()
    const first = questions[0]?.problem.fields[0]?.id ?? ''
    render(
      <QuizMap
        questions={questions}
        answers={{ 1: { [first]: '0x4000' } }}
        index={1}
        onGo={onGo}
      />,
    )
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Question 1: answered',
      'Question 2: no answer yet',
      'Question 3: no answer yet',
    ])
    expect(buttons[1]?.getAttribute('aria-current')).toBe('step')
    expect(buttons[0]?.getAttribute('aria-current')).toBeNull()
    // Not color alone: a check mark for an answered question, a dash for the others.
    expect(buttons[0]?.querySelector('svg')).not.toBeNull()
    expect(buttons[2]?.textContent).toBe('3–')
    const third = buttons[2]
    if (third === undefined) throw new Error('No third button.')
    fireEvent.click(third)
    expect(onGo).toHaveBeenCalledWith(2)
  })
})

describe('the review of a finished quiz', () => {
  it('opens a wrong answer with only its wrong parts; a right one and a blank one are one closed line', () => {
    const questions = quizOf(['rsp-tracker', 'register-names', 'rip'])
    const [rsp, names] = questions
    if (rsp === undefined || names === undefined) throw new Error('No questions.')
    const rspAnswers = answersFor(rsp.problem.fields, { step1: '0x10' })
    const nameAnswers = answersFor(names.problem.fields)
    // Question 3 is left blank.
    const grade = gradeQuiz(questions, { 1: rspAnswers, 2: nameAnswers })
    render(<QuizReview questions={grade.questions} />)

    const wrong = document.querySelector('li[data-question="1"] details')
    const right = document.querySelector('li[data-question="2"] details')
    const blank = document.querySelector('li[data-question="3"] details')
    expect(wrong?.hasAttribute('open')).toBe(true)
    expect(right?.hasAttribute('open')).toBe(false)
    expect(blank?.hasAttribute('open')).toBe(false)
    // The wrong question lists only its one wrong step.
    expect(document.querySelectorAll('li[data-question="1"] [data-answer-row]')).toHaveLength(1)
    expect(right?.querySelector('summary')?.textContent).toContain('Right')
    expect(blank?.querySelector('summary')?.textContent).toContain('Blank')
    expect(blank?.textContent).toContain('You left this question blank.')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show only wrong answers' }))
    expect(document.querySelectorAll('[data-quiz-review] > li')).toHaveLength(2)
    expect(document.querySelector('li[data-question="2"]')).toBeNull()
  })
})

/* ──────────────────────────────── double taps ──────────────────────────────── */

/** A button that is "Check" and then "Next", in the same place, like the session page's. */
function TwoJobs({ onCheck, onNext }: { onCheck: () => void; onNext: () => void }): ReactNode {
  const [checked, setChecked] = useState(false)
  const guard = usePressGuard(checked ? 'next' : 'check')
  return (
    <button
      type="button"
      aria-disabled={guard.settled ? undefined : true}
      onClick={() => {
        if (!guard.accepts()) return
        if (checked) {
          onNext()
        } else {
          guard.restart()
          setChecked(true)
          onCheck()
        }
      }}
    >
      {checked ? 'Next' : 'Check'}
    </button>
  )
}

describe('the guard against double taps', () => {
  it('ignores a second press that comes right after the button changed its job', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const onCheck = vi.fn()
    const onNext = vi.fn()
    render(<TwoJobs onCheck={onCheck} onNext={onNext} />)
    const button = screen.getByRole('button')
    // Right after the button appears: not yet.
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button)
    expect(onCheck).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(PRESS_GUARD_MS)
    })
    expect(button.getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(button)
    expect(onCheck).toHaveBeenCalledTimes(1)
    // The second tap of a double tap, 150 ms later, lands on "Next": ignored.
    act(() => {
      vi.advanceTimersByTime(150)
    })
    fireEvent.click(button)
    expect(onNext).not.toHaveBeenCalled()
    expect(button.getAttribute('aria-disabled')).toBe('true')

    act(() => {
      vi.advanceTimersByTime(PRESS_GUARD_MS)
    })
    fireEvent.click(button)
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})
