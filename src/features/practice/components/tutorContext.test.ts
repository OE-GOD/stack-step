import { describe, expect, it } from 'vitest'
import { checkProblem } from '../check'
import { makeProblem } from '../generators'
import { practiceTutorContext } from './tutorContext'

describe('what a practice page tells the tutor', () => {
  it('says nothing about a problem when none is shown', () => {
    expect(practiceTutorContext(null, {}, null)).toEqual({
      page: 'practice',
      code: '',
      machine: '',
      problem: null,
    })
  })

  it('gives the question, the code and the student answers, but no right answer before Check', () => {
    const problem = makeProblem('subregister-writes', 7)
    const field = problem.fields[0]
    if (field === undefined) throw new Error('The problem has no field.')
    const context = practiceTutorContext(problem, { [field.id]: '0x1' }, null)
    expect(context.page).toBe('practice')
    expect(context.code).toBe(problem.stepper.code)
    expect(context.machine).not.toBe('')
    expect(context.problem).toContain(`- ${field.label}: the student wrote 0x1`)
    expect(context.problem).not.toContain(field.expectedDisplay)
    expect(context.problem).not.toContain('Reason:')

    const blank = practiceTutorContext(problem, {}, null)
    expect(blank.problem).toContain('the student wrote (blank)')
  })

  it('adds the result after Check: right answers, the named mistake and the reason', () => {
    const problem = makeProblem('subregister-writes', 7)
    const field = problem.fields[0]
    if (field === undefined) throw new Error('The problem has no field.')
    const answers = { [field.id]: '0x1' }
    const context = practiceTutorContext(problem, answers, checkProblem(problem, answers))
    expect(context.problem).toContain('The student checked: not right.')
    expect(context.problem).toContain(`- Right answer: ${field.expectedDisplay}`)
    expect(context.problem).toContain(`Reason: ${problem.reason}`)
  })

  it('shows a placed chip and a chosen choice by their words, not by their ids', () => {
    const table = makeProblem('homework-table', 2)
    const line1 = table.fields[0]
    const chip = table.chips?.find((entry) => entry.id === line1?.expected)
    if (line1 === undefined || chip === undefined) throw new Error('No chip for line 1.')
    const tableText = practiceTutorContext(table, { [line1.id]: chip.id }, null).problem ?? ''
    expect(tableText).toContain(`the student wrote ${chip.label}`)
    expect(tableText).not.toContain(`the student wrote ${chip.id}`)

    const legality = makeProblem('mov-legality', 1)
    const pick = legality.fields[0]
    if (pick?.kind.type !== 'choice') throw new Error('mov-legality has no choice field.')
    const choice = pick.kind.choices[1]
    if (choice === undefined) throw new Error('Too few choices.')
    const pickText = practiceTutorContext(legality, { [pick.id]: choice.id }, null).problem ?? ''
    expect(pickText).toContain(`the student wrote ${choice.label}`)
  })
})
