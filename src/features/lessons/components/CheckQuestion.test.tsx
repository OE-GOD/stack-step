// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmulator } from '../../../emulator'
import type { ChoiceQuestion, HexQuestion, TextQuestion } from '../types'
import { CheckQuestion } from './CheckQuestion'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function feedback(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[data-feedback]')
  if (region === null) throw new Error('no feedback region')
  return region
}

function check(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Check' }))
}

const CHOICE: ChoiceQuestion = {
  kind: 'choice',
  prompt: 'How many hex digits does `rax` show?',
  options: [
    { id: 'eight', label: '8', feedback: '8 is the number of bytes.' },
    { id: 'sixteen', label: '16', correct: true, feedback: 'Right: 64 ÷ 4 = 16.' },
    { id: 'sixty-four', label: '64', feedback: '64 is the number of bits.' },
  ],
}

describe('a choice question', () => {
  it('is a group of real radio buttons named by the question', () => {
    render(<CheckQuestion question={CHOICE} onRight={() => undefined} />)
    const group = screen.getByRole('group', { name: 'How many hex digits does rax show?' })
    expect(group.tagName).toBe('FIELDSET')
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('gives the chosen option its own feedback, and lets the student try again', () => {
    const onRight = vi.fn()
    const { container } = render(
      <CheckQuestion question={CHOICE} onRight={onRight} afterRight={<p>Next step here</p>} />,
    )
    const region = feedback(container)
    expect(region.getAttribute('aria-live')).toBe('polite')

    check()
    // Nothing chosen is not a wrong answer: a neutral note says what to do.
    expect(region.textContent).toContain('Note')
    expect(region.textContent).not.toContain('Not yet')
    expect(region.textContent).toContain('Pick one of the answers first.')
    expect(region.getAttribute('data-feedback')).toBe('retry')

    fireEvent.click(screen.getByRole('radio', { name: '64' }))
    check()
    expect(region.textContent).toContain('Not yet')
    expect(region.textContent).toContain('64 is the number of bits.')
    // The right option is not given away.
    expect(region.textContent).not.toContain('Right: 64 ÷ 4 = 16.')
    expect(onRight).not.toHaveBeenCalled()
    expect(screen.queryByText('Next step here')).toBeNull()

    // A new choice: the old words go, because they were about the old choice.
    fireEvent.click(screen.getByRole('radio', { name: '16' }))
    expect(region.textContent).toBe('')
    check()
    expect(region.textContent).toContain('Correct')
    expect(region.textContent).toContain('Right: 64 ÷ 4 = 16.')
    expect(region.getAttribute('data-feedback')).toBe('right')
    expect(onRight).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Next step here')).toBeDefined()
  })
})

/** rax after `mov rax, -1` and `mov eax, 7`, from the emulator. */
function raxAfterWrite(): bigint {
  const made = createEmulator('    mov rax, -1\n    mov eax, 7\n    ret\n')
  if (!made.ok) throw new Error('does not assemble')
  made.emulator.run()
  return made.emulator.readRegister('rax')
}

const HEX: HexQuestion = {
  kind: 'hex',
  prompt: 'What does `rax` hold after the two lines?',
  code: ['    mov rax, -1', '    mov eax, 7'],
  label: '`rax` =',
  digits: 16,
  answer: raxAfterWrite,
  wrongAnswers: [{ value: () => 0xffffffff00000007n, feedback: 'You kept the top half.' }],
  rightFeedback: 'Right: a 32-bit write clears the top half.',
  hint: 'Think about the top 32 bits.',
}

function typeAndCheck(text: string): void {
  const box = screen.getByRole('textbox')
  fireEvent.change(box, { target: { value: text } })
  // Enter in the box submits the form, the same as pressing Check.
  const form = box.closest('form')
  if (form === null) throw new Error('no form')
  fireEvent.submit(form)
}

describe('a hex question', () => {
  it('has a labelled box and shows the code of the question', () => {
    const { container } = render(<CheckQuestion question={HEX} onRight={() => undefined} />)
    const box = screen.getByRole('textbox', { name: 'rax =' })
    // The code listing, found by its lines (it is a named region only when it scrolls).
    const lines = [...container.querySelectorAll('[data-line]')].map((line) => line.textContent)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('mov eax, 7')

    // The help line is read with the box, and its `0x` is code that never shrinks below
    // 14 px (the line itself is 14 px).
    const helpIds = (box.getAttribute('aria-describedby') ?? '').split(' ')
    const help = helpIds
      .map((id) => document.getElementById(id))
      .find((element) => element?.textContent?.startsWith('Type 16 hex digits'))
    expect(help?.textContent).toBe('Type 16 hex digits. You may start with 0x.')
    const prefix = help?.querySelector('code')
    expect(prefix?.textContent).toBe('0x')
    expect(prefix?.className).toContain('max(0.9em,0.875rem)')
  })

  it('asks for all the digits, names known mistakes, hints otherwise, and accepts any spelling', () => {
    const onRight = vi.fn()
    const { container } = render(<CheckQuestion question={HEX} onRight={onRight} />)
    const region = feedback(container)

    typeAndCheck('0x7')
    expect(region.textContent).toContain('Type all 16 hex digits')
    expect(region.textContent).not.toContain('Not yet')
    expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true')

    typeAndCheck('0xFFFF FFFF 0000 0007')
    expect(region.textContent).toContain('Not yet')
    expect(region.textContent).toContain('You kept the top half.')

    typeAndCheck('0x0000000000000009')
    expect(region.textContent).toContain('Think about the top 32 bits.')
    expect(onRight).not.toHaveBeenCalled()

    typeAndCheck('0000_0000_0000_0007')
    expect(region.textContent).toContain('Correct')
    expect(onRight).toHaveBeenCalledTimes(1)
  })

  it('shows a calm message when the answer cannot be computed', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const broken: HexQuestion = {
      ...HEX,
      answer: () => {
        throw new Error('the program does not assemble')
      },
    }
    render(<CheckQuestion question={broken} onRight={() => undefined} />)
    expect(screen.getByText('This question has a problem')).toBeDefined()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(logged).toHaveBeenCalled()
  })
})

const TEXT: TextQuestion = {
  kind: 'text',
  prompt: 'What is the name of the lowest 16 bits of `r10`?',
  label: '16-bit part of `r10`',
  answers: ['r10w'],
  wrongAnswers: [{ value: 'r10d', feedback: '`r10d` is the 32-bit part.' }],
  rightFeedback: 'Right: `r10w`.',
  hint: 'Look at the `r8` pattern.',
}

describe('a text question', () => {
  it('compares without regard to case and spaces, with feedback for known mistakes', () => {
    const onRight = vi.fn()
    const { container } = render(<CheckQuestion question={TEXT} onRight={onRight} />)
    const region = feedback(container)
    expect(screen.getByRole('textbox', { name: '16-bit part of r10' })).toBeDefined()

    typeAndCheck('')
    expect(region.textContent).toContain('Type your answer first.')

    typeAndCheck('R10D')
    expect(region.textContent).toContain('r10d is the 32-bit part.')

    typeAndCheck('r10x')
    expect(region.textContent).toContain('Look at the r8 pattern.')

    typeAndCheck('  R10W ')
    expect(region.textContent).toContain('Correct')
    expect(onRight).toHaveBeenCalledTimes(1)
  })
})
