/**
 * What a practice page tells the optional AI tutor: the problem as plain text, its code,
 * and a short summary of the machine at the start of the problem.
 */
import { createEmulator } from '../../../emulator'
import { summarizeMachine } from '../../stepper/machineSummary'
import type { TutorContext } from '../../tutor/TutorMount'
import type { CheckResult, Field, Problem, PromptBlock } from '../types'
import { chipLabel } from './answerText'

function blockText(block: PromptBlock): string[] {
  switch (block.type) {
    case 'text':
      return [block.text]
    case 'code':
      return [
        'Code:',
        ...block.lines.map((line, index) => {
          const address = block.addresses?.[index]
          return address === undefined ? `    ${line}` : `    ${address}:  ${line}`
        }),
      ]
    case 'registers':
      return [
        `${block.title ?? 'Registers'}:`,
        ...block.rows.map((row) => `    ${row.name} = ${row.value}`),
      ]
    case 'stack':
      return [
        `${block.title ?? 'Stack'} (highest address first):`,
        ...block.rows.map(
          (row) => `    ${row.address}: ${row.value}${row.marker ? `  <- ${row.marker}` : ''}`,
        ),
      ]
    case 'trace':
      return ['Steps:', ...block.rows.map((row) => `    ${row.step}. ${row.text}`)]
  }
}

/**
 * An answer the way the student sees it: the words of a chosen choice and the text of a
 * placed chip (the page keeps their ids), '(blank)' for nothing.
 */
function shownAnswer(problem: Problem, field: Field, raw: string | undefined): string {
  const given = raw?.trim() ?? ''
  if (given === '') return '(blank)'
  if (field.kind.type === 'chip') return chipLabel(problem, given)
  if (field.kind.type === 'choice') {
    return field.kind.choices.find((choice) => choice.id === given)?.label ?? given
  }
  return given
}

/**
 * The problem as plain text: the question, what is asked, the student's answers so far,
 * and (only after Check) the result. The right answers are not included before Check.
 */
function problemText(
  problem: Problem,
  answers: Readonly<Record<string, string>>,
  result: CheckResult | null,
): string {
  const lines = problem.prompt.flatMap(blockText)
  lines.push('', 'The student must give:')
  for (const field of problem.fields) {
    lines.push(
      `- ${field.label}: the student wrote ${shownAnswer(problem, field, answers[field.id])}`,
    )
  }
  if (result !== null) {
    lines.push(
      '',
      result.correct ? 'The student checked: right.' : 'The student checked: not right.',
    )
    if (!result.correct) {
      for (const field of result.fields) {
        if (!field.correct) lines.push(`- Right answer: ${field.expectedDisplay}`)
      }
      if (result.mistake !== null) lines.push(`Named mistake: ${result.mistake.message}`)
    }
    lines.push(`Reason: ${result.reason}`)
  }
  return lines.join('\n')
}

/** The machine as the problem starts (before any step), as plain text. '' if it cannot run. */
function startingMachine(problem: Problem): string {
  try {
    const created = createEmulator(problem.stepper.code, problem.stepper.options)
    if (!created.ok) return ''
    return summarizeMachine(created.emulator.getSnapshot(), { program: created.emulator.program })
  } catch {
    return ''
  }
}

/** The whole tutor context of a practice page. */
export function practiceTutorContext(
  problem: Problem | null,
  answers: Readonly<Record<string, string>>,
  result: CheckResult | null,
): TutorContext {
  if (problem === null) return { page: 'practice', code: '', machine: '', problem: null }
  return {
    page: 'practice',
    code: problem.stepper.code,
    machine: startingMachine(problem),
    problem: problemText(problem, answers, result),
  }
}
