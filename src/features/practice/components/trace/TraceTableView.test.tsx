// @vitest-environment jsdom
/**
 * The trace table as a student meets it: what it shows, tap-to-place (a click), the
 * keyboard, what screen readers hear, the locked state after Check, and odd props.
 *
 * In jsdom a click made with `fireEvent.click(element)` has `detail` 0, as a click made
 * with Enter or Space has in a browser; `{ detail: 1 }` stands for a mouse click.
 * Real dragging, real taps and real key presses are tested in a browser
 * (e2e/trace-table.spec.ts); the logic of a drag is tested in drag.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkProblem } from '../../check'
import type { CheckResult, Problem } from '../../types'
import TraceTableView from '../TraceTableView'
import { SAMPLE_PROBLEMS } from './sampleProblems'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function sample(index: number): Problem {
  const problem = SAMPLE_PROBLEMS[index]
  if (problem === undefined) throw new Error(`There is no sample problem ${index + 1}.`)
  return problem
}

const P1 = sample(0)
const P2 = sample(1)

/** Chip labels of problem 1 (see sampleProblems.ts). */
const A = 'rax = 0x0000000000000005' // line 1
const B = 'rbx = 0x0000000000000015' // line 2
const C = 'rcx = 0xaaaabbbbccccdd7f' // line 3
const KEEP = 'rax = 0x1111222200000005' // the tempting wrong chip of line 1

interface PageProps {
  problem?: Problem
  start?: Record<string, string>
  locked?: boolean
  result?: CheckResult | null
  onCall?: (fieldId: string, value: string) => void
}

/** A page that owns the answers, as the practice page does. */
function Page({
  problem = P1,
  start = {},
  locked = false,
  result = null,
  onCall,
}: PageProps): ReactNode {
  const [answers, setAnswers] = useState<Record<string, string>>(start)
  return (
    <StrictMode>
      <TraceTableView
        problem={problem}
        answers={answers}
        onChange={(fieldId, value) => {
          onCall?.(fieldId, value)
          setAnswers((old) => ({ ...old, [fieldId]: value }))
        }}
        locked={locked}
        result={result}
      />
    </StrictMode>
  )
}

function tray(): HTMLElement {
  return screen.getByRole('group', { name: /^Chips/ })
}

function trayChip(label: string): HTMLElement {
  return within(tray()).getByRole('button', { name: label })
}

function trayLabels(): string[] {
  return [...tray().querySelectorAll('[data-chip-in="tray"]')].map(
    (chip) => chip.getAttribute('aria-label') ?? chip.textContent ?? '',
  )
}

function cell(line: number): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^Line ${line}, changed:`) })
}

function cellNames(): string[] {
  return [1, 2, 3, 4, 5].map((line) => cell(line).getAttribute('aria-label') ?? '')
}

/**
 * The name of an empty cell: its line, "empty", then the words the cell shows (so a
 * student who speaks to the computer can say what they see).
 */
function emptyCell(line: number, words = 'put a chip here'): string {
  return `Line ${line}, changed: empty, ${words}`
}

/** The "put it back" button of the tray, if it shows. */
function putBackButton(): HTMLElement | null {
  return within(tray()).queryByRole('button', { name: /to put it back: / })
}

/**
 * Every button of the table whose name does not hold the words it shows (Label in Name,
 * WCAG 2.5.3). The word "selected" on a chip is a state, which the button gives with
 * aria-pressed, not part of its label. Commas and colons do not count.
 */
function buttonsWithoutTheirWords(): string[] {
  const plain = (text: string) => text.replace(/[,:]/g, ' ').replace(/\s+/g, ' ').trim()
  const wrong: string[] = []
  for (const button of document.querySelectorAll<HTMLElement>('[data-trace-table] button')) {
    const tag = button.querySelector('[data-trace-tag]')?.textContent ?? ''
    const all = button.textContent ?? ''
    const body = tag === '' ? all : all.slice(0, all.length - tag.length)
    const name = plain(button.getAttribute('aria-label') ?? all)
    for (const words of [body, tag === 'selected' ? '' : tag]) {
      if (!name.includes(plain(words))) wrong.push(`"${name}" does not say "${plain(words)}"`)
    }
  }
  return wrong
}

/** What the live region says, without the invisible space that marks a repeat. */
function heard(): string {
  return (screen.getByTestId('trace-announcer').textContent ?? '').replace(/\u00a0/g, '')
}

/** Place a chip from the tray with two clicks. */
function place(label: string, line: number): void {
  fireEvent.click(trayChip(label))
  fireEvent.click(cell(line))
}

describe('what it shows', () => {
  it('shows the sentence of the question', () => {
    render(<Page />)
    expect(screen.getByText(/^Follow the code one line at a time\./)).toBeTruthy()
  })

  it('shows the starting values as a small table with a heading', () => {
    render(<Page />)
    const table = screen.getByRole('table', { name: 'Starting values' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.textContent)).toEqual([
      'rax0x1111222233334444',
      'rbx0x0000000000000010',
      'rcx0xaaaabbbbccccdddd',
    ])
    expect(within(table).getByRole('rowheader', { name: 'rax' })).toBeTruthy()
  })

  it('uses the default heading when the problem gives none', () => {
    render(<Page problem={P2} />)
    expect(screen.getByRole('table', { name: 'Starting values' })).toBeTruthy()
  })

  it('shows one row per line of code: number, instruction, empty cell', () => {
    render(<Page />)
    const table = screen.getByRole('table', { name: 'Trace table' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Line', 'Code', 'What changed'])
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.querySelector('code')?.textContent)).toEqual([
      'mov eax, 5',
      'add rbx, rax',
      'mov cl, 0x7f',
      'inc rax',
      'xor ebx, ebx',
    ])
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ])
    expect(cellNames()).toEqual([1, 2, 3, 4, 5].map((line) => emptyCell(line)))
    for (const line of [1, 2, 3, 4, 5]) expect(cell(line).textContent).toBe('put a chip here')
  })

  it('shows chip values and starting values in groups of four digits, and copies them exactly', () => {
    // The browser review: 16 digits with no groups made the tempting chips (which differ in
    // the top half) hard to compare. The M8 review: chips and starting values now look like
    // every other whole register on the site (and the feedback under the table): four
    // groups with a small gap between them. The gaps are margins, so the text stays the same.
    render(<Page />)
    const chip = trayChip(KEEP)
    const value = chip.querySelector('[data-hex]')
    expect(value?.textContent).toBe('0x1111222200000005')
    expect(value?.children).toHaveLength(4)
    expect(chip.textContent).toBe(KEEP)
    const starts = document.querySelectorAll('[data-trace-table] table:first-of-type [data-hex]')
    expect(starts.length).toBeGreaterThanOrEqual(3)
    for (const start of starts) {
      expect(start.textContent).toMatch(/^0x[0-9a-f]{16}$/)
      expect(start.children).toHaveLength(4)
    }
    expect(document.querySelector('[data-hex-bands]')).toBeNull()
  })

  it('keeps each word of a code line together, and breaks a long one after + and ,', () => {
    // At 360 px the code column holds about 16 characters. A word that fits moves to the
    // next line whole (it is an inline block); one that does not breaks after a + or a ,
    // so a number stays in one piece. Before, `[r14+r13*8+0x7ffffff0]` was cut inside
    // the number ("0x7ff" / "ffff0").
    const long: Problem = {
      ...P1,
      prompt: P1.prompt.map((block) =>
        block.type === 'code'
          ? {
              ...block,
              lines: ['lea r15, [r14+r13*8+0x7ffffff0]', 'mov qword ptr [rbp-8], rax'],
            }
          : block,
      ),
    }
    const { container } = render(<Page problem={long} />)
    const breaksIn = (line: number) => {
      const code = container.querySelector(`[data-trace-row="${line}"] code`)
      return [...(code?.querySelectorAll('wbr') ?? [])].map(
        (wbr) => wbr.previousSibling?.textContent,
      )
    }
    const wordsIn = (line: number) =>
      [...container.querySelectorAll(`[data-trace-row="${line}"] [data-code-word]`)].map(
        (word) => word.textContent,
      )
    expect(container.querySelector('[data-trace-row="1"] code')?.textContent).toBe(
      'lea r15, [r14+r13*8+0x7ffffff0]',
    )
    expect(wordsIn(1)).toEqual(['lea', 'r15,', '[r14+r13*8+0x7ffffff0]'])
    expect(wordsIn(2)).toEqual(['mov', 'qword', 'ptr', '[rbp-8],', 'rax'])
    for (const word of container.querySelectorAll('[data-code-word]')) {
      expect(word.className).toBe('inline-block')
    }
    // Inside a word, a place to break follows each + and , and nothing else: `r13*8` and
    // `[rbp-8]` stay together.
    expect(breaksIn(1)).toEqual([',', '+', '+'])
    expect(breaksIn(2)).toEqual([','])
    expect(screen.getByText('0x7ffffff0', { selector: 'code span' }).className).toContain(
      'text-syn-number',
    )
  })

  it('colors the instruction like the editor does', () => {
    render(<Page />)
    const first = (text: string) => screen.getAllByText(text, { selector: 'code span' })[0]
    expect(first('mov')?.className).toContain('text-syn-mnemonic')
    expect(first('eax')?.className).toContain('text-syn-register')
    expect(first('0x7f')?.className).toContain('text-syn-number')
  })

  it('shows every chip in the tray, in the order of the problem, as a button', () => {
    render(<Page />)
    expect(trayLabels()).toEqual((P1.chips ?? []).map((chip) => chip.label))
    for (const chip of P1.chips ?? []) {
      const button = trayChip(chip.label)
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('type')).toBe('button')
      expect(button.getAttribute('aria-pressed')).toBe('false')
    }
  })

  it('lets a chip break after the = and nowhere else by choice', () => {
    render(<Page />)
    const chip = trayChip(A)
    expect(chip.textContent).toBe(A)
    const [name, value] = chip.querySelectorAll(':scope > span > span')
    expect(name?.textContent).toBe('rax =')
    expect(name?.className).toContain('whitespace-nowrap')
    expect(value?.textContent).toBe('0x0000000000000005')
  })

  it('has no positive tabindex and hides nothing focusable from screen readers', () => {
    const { container } = render(<Page />)
    expect(
      container.querySelector('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])'),
    ).toBeNull()
    expect(
      container.querySelector('[aria-hidden="true"] button, button[aria-hidden="true"]'),
    ).toBeNull()
  })

  it('gives keyboard users their instructions through the table and the tray', () => {
    render(<Page />)
    const table = screen.getByRole('table', { name: 'Trace table' })
    const helpId = table.getAttribute('aria-describedby') ?? ''
    expect(document.getElementById(helpId)?.textContent).toContain('press Enter on a chip')
    expect(tray().getAttribute('aria-describedby')).toContain(helpId)
  })

  it('keeps a space between the heading of the tray and its help, so they are not read as one word', () => {
    render(<Page />)
    expect(tray().textContent).toMatch(/^Chips Drag a chip to a line\./)
    fireEvent.click(trayChip(A))
    expect(tray().textContent).toMatch(/^Chips Now go to a line and press Enter\./)
  })
})

describe('tap to place (a click)', () => {
  it('selects a chip: pressed, the word "selected", and the cells invite a click', () => {
    render(<Page />)
    fireEvent.click(trayChip(A), { detail: 1 })

    const chip = trayChip(A)
    expect(chip.getAttribute('aria-pressed')).toBe('true')
    expect(chip.textContent).toContain('selected')
    expect(chip.className).toContain('ring-2')
    for (const line of [1, 2, 3, 4, 5]) expect(cell(line).textContent).toBe('click to place here')
    expect(heard()).toBe(`${A} selected. Now choose a line.`)
    expect(tray().textContent).toContain('Now click a line.')
    // Only one chip is selected.
    expect(tray().querySelectorAll('[aria-pressed="true"]')).toHaveLength(1)
  })

  it('names the action after the way the chip was selected', () => {
    render(<Page />)
    fireEvent.click(trayChip(A)) // detail 0: the keyboard
    // The key alone, not "press Enter …": the short words fit beside the register name.
    expect(cell(1).textContent).toBe('Enter to place here')
    expect(cell(1).getAttribute('aria-label')).toBe(emptyCell(1, 'Enter to place here'))
    fireEvent.click(trayChip(A))

    // A browser that does not say what made the click, on a device with a touch screen.
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' }))
    fireEvent.click(trayChip(A), { detail: 1 })
    expect(cell(1).textContent).toBe('tap to place here')
    expect(tray().textContent).toContain('Now tap a line.')
  })

  it('cancels when the selected chip is chosen again', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    fireEvent.click(trayChip(A))
    fireEvent.click(trayChip(A))

    expect(trayChip(A).getAttribute('aria-pressed')).toBe('false')
    expect(cell(1).textContent).toBe('put a chip here')
    expect(heard()).toBe(`${A} is not selected any more.`)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('switches to another chip of the tray', () => {
    render(<Page />)
    fireEvent.click(trayChip(A))
    fireEvent.click(trayChip(B))
    expect(trayChip(A).getAttribute('aria-pressed')).toBe('false')
    expect(trayChip(B).getAttribute('aria-pressed')).toBe('true')
    expect(heard()).toBe(`${B} selected. Now choose a line.`)
  })

  it('places the selected chip with one call of onChange', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    place(A, 2)

    expect(onCall.mock.calls).toEqual([['line2', 'p1-a']])
    expect(cell(2).getAttribute('aria-label')).toBe(`Line 2, changed: ${A}`)
    expect(cell(2).textContent).toBe(A)
    expect(trayLabels()).not.toContain(A)
    expect(trayLabels()).toHaveLength(8)
    expect(heard()).toBe(`${A} placed on line 2.`)
    // Nothing is selected any more.
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(cell(1).textContent).toBe('put a chip here')
  })

  it('replaces the chip of a filled cell; the old chip is back in the tray', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-keep' }} onCall={onCall} />)
    expect(trayLabels()).not.toContain(KEEP)

    fireEvent.click(trayChip(A), { detail: 1 })
    expect(cell(1).textContent).toContain('click to replace')
    fireEvent.click(cell(1), { detail: 1 })

    expect(onCall.mock.calls).toEqual([['line1', 'p1-a']])
    expect(cell(1).getAttribute('aria-label')).toBe(`Line 1, changed: ${A}`)
    expect(trayLabels()).toContain(KEEP)
    expect(heard()).toBe(`${A} placed on line 1. ${KEEP} is back with the other chips.`)
  })

  it('picks up a placed chip and moves it to another line with two calls', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)

    fireEvent.click(cell(1))
    expect(cell(1).getAttribute('aria-pressed')).toBe('true')
    expect(cell(1).textContent).toContain('selected')
    expect(heard()).toBe(`${A} on line 1 selected. Now choose another line, or put the chip back.`)

    fireEvent.click(cell(4))
    expect(onCall.mock.calls).toEqual([
      ['line1', ''],
      ['line4', 'p1-a'],
    ])
    expect(cellNames()[0]).toBe(emptyCell(1))
    expect(cellNames()[3]).toBe(`Line 4, changed: ${A}`)
    expect(heard()).toBe(`${A} moved from line 1 to line 4.`)
  })

  it('moves a placed chip onto a filled cell: that chip goes back to the tray', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a', line2: 'p1-b' }} onCall={onCall} />)
    fireEvent.click(cell(1))
    fireEvent.click(cell(2))

    expect(onCall.mock.calls).toEqual([
      ['line1', ''],
      ['line2', 'p1-a'],
    ])
    expect(cellNames().slice(0, 2)).toEqual([emptyCell(1), `Line 2, changed: ${A}`])
    expect(trayLabels()).toContain(B)
    expect(heard()).toBe(`${A} moved from line 1 to line 2. ${B} is back with the other chips.`)
  })

  it('cancels when the selected placed chip is chosen again', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a' }} onCall={onCall} />)
    fireEvent.click(cell(1))
    fireEvent.click(cell(1))
    expect(cell(1).getAttribute('aria-pressed')).toBe('false')
    expect(onCall).not.toHaveBeenCalled()
    expect(heard()).toBe(`${A} is not selected any more.`)
  })

  it('offers "put it back" for a selected placed chip, and puts it back', () => {
    const onCall = vi.fn()
    render(<Page start={{ line3: 'p1-c' }} onCall={onCall} />)
    expect(putBackButton()).toBeNull()

    fireEvent.click(cell(3), { detail: 1 })
    // Its name starts with the words it shows, then names the chip.
    const putBack = screen.getByRole('button', { name: `click to put it back: ${C}` })
    expect(putBack.textContent).toBe('click to put it back')
    expect(tray().contains(putBack)).toBe(true)

    fireEvent.click(putBack, { detail: 1 })
    expect(onCall.mock.calls).toEqual([['line3', '']])
    expect(trayLabels()).toContain(C)
    expect(cellNames()[2]).toBe(emptyCell(3))
    expect(heard()).toBe(`Line 3 cleared. ${C} is back with the other chips.`)
    expect(putBackButton()).toBeNull()
  })

  it('names "put it back" after the way the chip was picked up', () => {
    render(<Page start={{ line3: 'p1-c' }} />)
    fireEvent.click(cell(3)) // the keyboard
    expect(putBackButton()?.getAttribute('aria-label')).toBe(`Enter to put it back: ${C}`)
    expect(putBackButton()?.textContent).toBe('Enter to put it back')
  })

  it('does not offer "put it back" for a chip of the tray', () => {
    render(<Page start={{ line3: 'p1-c' }} />)
    fireEvent.click(trayChip(A))
    expect(putBackButton()).toBeNull()
  })

  it('puts the words a button shows into its name, in every state (Label in Name)', () => {
    render(<Page start={{ line1: 'p1-a', line3: 'p1-c' }} />)
    expect(buttonsWithoutTheirWords()).toEqual([])
    fireEvent.click(trayChip(KEEP), { detail: 1 }) // a mouse: "click to replace", "click to place here"
    expect(cell(1).getAttribute('aria-label')).toBe(`Line 1, changed: ${A}, click to replace`)
    expect(cell(2).getAttribute('aria-label')).toBe(emptyCell(2, 'click to place here'))
    expect(buttonsWithoutTheirWords()).toEqual([])
    fireEvent.click(trayChip(KEEP)) // cancel
    fireEvent.click(trayChip(KEEP)) // the keyboard: "Enter to replace"
    expect(cell(3).getAttribute('aria-label')).toBe(`Line 3, changed: ${C}, Enter to replace`)
    expect(buttonsWithoutTheirWords()).toEqual([])
    fireEvent.keyDown(document.body, { key: 'Escape' })
    fireEvent.click(cell(3), { detail: 1 }) // a placed chip picked up: "selected" is a state
    expect(cell(3).getAttribute('aria-label')).toBe(`Line 3, changed: ${C}`)
    expect(cell(3).getAttribute('aria-pressed')).toBe('true')
    expect(buttonsWithoutTheirWords()).toEqual([])
  })

  it('says "first choose a chip" when an empty cell is chosen with nothing selected', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    fireEvent.click(cell(2))

    expect(onCall).not.toHaveBeenCalled()
    expect(heard()).toBe('No chip is selected. First choose a chip, then choose a line.')
    expect(tray().textContent).toContain('First choose a chip. Then choose a line.')

    // The hint goes away with the next action.
    fireEvent.click(trayChip(A))
    expect(tray().textContent).not.toContain('First choose a chip.')
  })

  it('announces the same sentence again when it happens twice in a row', () => {
    render(<Page />)
    fireEvent.click(cell(2))
    const first = screen.getByTestId('trace-announcer').textContent
    fireEvent.click(cell(2))
    const second = screen.getByTestId('trace-announcer').textContent
    expect(second).not.toBe(first)
    expect(heard()).toBe('No chip is selected. First choose a chip, then choose a line.')
  })

  it('makes the two calls of a move in a row, before the page draws again', () => {
    // A page that reads `answers` from a stale closure would lose the first call.
    const seen: string[] = []
    function Listener(): ReactNode {
      const [answers, setAnswers] = useState<Record<string, string>>({ line1: 'p1-a' })
      seen.push(JSON.stringify(answers))
      return (
        <TraceTableView
          problem={P1}
          answers={answers}
          onChange={(fieldId, value) => setAnswers((old) => ({ ...old, [fieldId]: value }))}
          locked={false}
          result={null}
        />
      )
    }
    render(<Listener />)
    fireEvent.click(cell(1))
    fireEvent.click(cell(5))
    // The state with the chip in neither cell was never drawn.
    expect(seen).not.toContain(JSON.stringify({ line1: '' }))
    expect(seen.at(-1)).toBe(JSON.stringify({ line1: '', line5: 'p1-a' }))
  })
})

describe('the keyboard', () => {
  it('cancels the selection with Escape, wherever the focus is', () => {
    const onCall = vi.fn()
    render(<Page onCall={onCall} />)
    fireEvent.click(trayChip(A))
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(trayChip(A).getAttribute('aria-pressed')).toBe('false')
    expect(cell(1).textContent).toBe('put a chip here')
    expect(heard()).toBe(`${A} is not selected any more.`)
    expect(onCall).not.toHaveBeenCalled()
  })

  it('does nothing on Escape when nothing is selected', () => {
    render(<Page />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(heard()).toBe('')
  })

  it.each(['Backspace', 'Delete'])('clears a filled cell with %s', (key) => {
    const onCall = vi.fn()
    render(<Page start={{ line2: 'p1-b' }} onCall={onCall} />)
    cell(2).focus()
    fireEvent.keyDown(cell(2), { key })

    expect(onCall.mock.calls).toEqual([['line2', '']])
    expect(cellNames()[1]).toBe(emptyCell(2))
    expect(trayLabels()).toContain(B)
    expect(heard()).toBe(`Line 2 cleared. ${B} is back with the other chips.`)
    // The cell is still there and still has the focus.
    expect(document.activeElement).toBe(cell(2))
  })

  it('ignores Backspace on an empty cell and other keys on a filled one', () => {
    const onCall = vi.fn()
    render(<Page start={{ line2: 'p1-b' }} onCall={onCall} />)
    fireEvent.keyDown(cell(1), { key: 'Backspace' })
    fireEvent.keyDown(cell(2), { key: 'a' })
    fireEvent.keyDown(cell(2), { key: 'ArrowDown' })
    expect(onCall).not.toHaveBeenCalled()
  })

  it('clears a cell whose chip is selected, and forgets the selection', () => {
    render(<Page start={{ line2: 'p1-b' }} />)
    fireEvent.click(cell(2))
    fireEvent.keyDown(cell(2), { key: 'Delete' })
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(putBackButton()).toBeNull()
    expect(trayLabels()).toContain(B)
    expect(heard()).toBe(`Line 2 cleared. ${B} is back with the other chips.`)
  })

  it('keeps a selected chip selected when another line is cleared, and says so', () => {
    const onCall = vi.fn()
    render(<Page start={{ line3: 'p1-c' }} onCall={onCall} />)
    fireEvent.click(trayChip(A)) // Enter on a chip of the tray
    cell(3).focus()
    fireEvent.keyDown(cell(3), { key: 'Backspace' })

    expect(onCall.mock.calls).toEqual([['line3', '']])
    expect(trayChip(A).getAttribute('aria-pressed')).toBe('true')
    expect(heard()).toBe(
      `Line 3 cleared. ${C} is back with the other chips. ${A} is still selected.`,
    )
    expect(cell(3).textContent).toBe('Enter to place here')
    // The next Enter on the line places the chip that is still selected.
    fireEvent.click(cell(3))
    expect(onCall.mock.calls.at(-1)).toEqual(['line3', 'p1-a'])
    expect(heard()).toBe(`${A} placed on line 3.`)
  })

  it('keeps a picked-up placed chip selected when another line is cleared', () => {
    render(<Page start={{ line1: 'p1-a', line3: 'p1-c' }} />)
    fireEvent.click(cell(1)) // pick up the chip of line 1
    fireEvent.keyDown(cell(3), { key: 'Delete' })
    expect(cell(1).getAttribute('aria-pressed')).toBe('true')
    expect(putBackButton()).not.toBeNull()
    expect(heard()).toBe(
      `Line 3 cleared. ${C} is back with the other chips. ${A} is still selected.`,
    )
  })

  it('moves the focus to the cell when the focused chip leaves the tray', () => {
    render(<Page />)
    trayChip(A).focus()
    fireEvent.click(trayChip(A))
    fireEvent.click(cell(3))
    expect(document.activeElement).toBe(cell(3))
    expect(document.activeElement?.getAttribute('aria-label')).toBe(`Line 3, changed: ${A}`)
  })

  it('moves the focus to the chip when "put it back" is used', () => {
    render(<Page start={{ line3: 'p1-c' }} />)
    fireEvent.click(cell(3))
    const putBack = putBackButton()
    if (putBack === null) throw new Error('No "put it back" button.')
    putBack.focus()
    fireEvent.click(putBack)
    expect(document.activeElement).toBe(trayChip(C))
  })

  it('moves the focus to the cell when Escape removes the focused "put it back" button', () => {
    render(<Page start={{ line3: 'p1-c' }} />)
    fireEvent.click(cell(3))
    putBackButton()?.focus()
    expect(document.activeElement).toBe(putBackButton())
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.activeElement).toBe(cell(3))
  })

  it('keeps the focus on a cell while it is filled, replaced and cleared', () => {
    render(<Page />)
    fireEvent.click(trayChip(A))
    cell(1).focus()
    const button = cell(1)
    fireEvent.click(button)
    expect(document.activeElement).toBe(button)
    fireEvent.click(trayChip(KEEP))
    fireEvent.click(button)
    expect(document.activeElement).toBe(button)
    fireEvent.keyDown(button, { key: 'Backspace' })
    expect(document.activeElement).toBe(button)
    // It is the same element all along, so a screen reader keeps its place.
    expect(cell(1)).toBe(button)
  })

  it('keeps a focused line clear of the tray: every cell asks for the height of the tray below it', () => {
    // The tray sticks to the bottom of a phone screen and covers the lines that scroll
    // under it. A cell that gets the focus asks the browser to keep that much room free
    // below it, so the browser scrolls the cell out from under the tray.
    let report: ResizeObserverCallback = () => {}
    const observed: Element[] = []
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          report = callback
        }
        observe(target: Element) {
          observed.push(target)
        }
        disconnect() {}
        unobserve() {}
      },
    )
    const rect = (height: number) => {
      const box = { x: 0, y: 0, left: 0, top: 0, width: 360, height, right: 360, bottom: height }
      return { ...box, toJSON: () => box }
    }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      return rect(this.matches('[data-trace-tray]') ? 347.6 : 0)
    })
    const { container, unmount } = render(<Page />)
    const root = container.querySelector<HTMLElement>('[data-trace-table]')
    expect(observed).toEqual([tray()])

    act(() => report([], {} as ResizeObserver))
    expect(root?.style.getPropertyValue('--trace-tray-h')).toBe('348px')
    for (const line of [1, 2, 3, 4, 5]) {
      expect(cell(line).className).toContain('scroll-mb-[calc(var(--trace-tray-h,0px)+0.75rem)]')
    }
    // Only under the same conditions as the sticky tray (a box wide enough for two columns
    // of 14 px chips, a narrow and tall window).
    expect(cell(1).className).toMatch(
      /@min-\[22\.5rem\]:@max-\[44rem\]:max-md:\[@media\(min-height:37\.5rem\)\]:scroll-mb-/,
    )
    expect(tray().className).toMatch(
      /@min-\[22\.5rem\]:@max-\[44rem\]:max-md:\[@media\(min-height:37\.5rem\)\]:sticky/,
    )
    unmount()
    expect(root?.style.getPropertyValue('--trace-tray-h')).toBe('')
  })

  it('works without ResizeObserver: no variable, nothing breaks', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { container } = render(<Page />)
    expect(
      container
        .querySelector<HTMLElement>('[data-trace-table]')
        ?.style.getPropertyValue('--trace-tray-h'),
    ).toBe('')
    place(A, 1)
    expect(cellNames()[0]).toBe(`Line 1, changed: ${A}`)
  })
})

describe('screen readers', () => {
  it('has one polite live region of its own, empty at the start', () => {
    render(<Page />)
    const region = screen.getByTestId('trace-announcer')
    expect(region.getAttribute('role')).toBe('status')
    expect(region.getAttribute('aria-live')).toBe('polite')
    expect(region.getAttribute('aria-atomic')).toBe('true')
    expect(region.textContent).toBe('')
  })

  it('keeps the live region of dnd-kit silent, so nothing is read twice', () => {
    render(<Page />)
    place(A, 1)
    fireEvent.click(cell(1))
    fireEvent.click(cell(2))
    const regions = screen.getAllByRole('status')
    const others = regions.filter((region) => region !== screen.getByTestId('trace-announcer'))
    for (const region of others) expect(region.textContent).toBe('')
  })

  it('marks the tray as a group named "Chips"', () => {
    render(<Page />)
    expect(tray().getAttribute('role')).toBe('group')
    expect(screen.getByRole('group', { name: 'Chips' })).toBe(tray())
  })
})

describe('after Check', () => {
  function checked(answers: Record<string, string>): CheckResult {
    return checkProblem(P1, answers)
  }
  const RIGHT = { line1: 'p1-a', line2: 'p1-b', line3: 'p1-c', line4: 'p1-d', line5: 'p1-e' }

  it('has no button left: nothing can be selected, moved or cleared', () => {
    const onCall = vi.fn()
    const { container } = render(
      <Page start={RIGHT} locked result={checked(RIGHT)} onCall={onCall} />,
    )
    expect(container.querySelectorAll('button')).toHaveLength(0)
    for (const chip of container.querySelectorAll('[data-chip-id]')) {
      fireEvent.click(chip)
      fireEvent.mouseDown(chip, { button: 0, clientX: 5, clientY: 5 })
      fireEvent.keyDown(chip, { key: 'Backspace' })
    }
    fireEvent.mouseMove(document.body, { clientX: 100, clientY: 100 })
    fireEvent.mouseUp(document.body, { clientX: 100, clientY: 100 })
    expect(onCall).not.toHaveBeenCalled()
    expect(document.querySelector('[data-trace-overlay]')).toBeNull()
  })

  it('marks every row right with an icon and the word', () => {
    const { container } = render(<Page start={RIGHT} locked result={checked(RIGHT)} />)
    const rows = [...container.querySelectorAll('[data-trace-row]')]
    expect(rows.map((row) => row.getAttribute('data-result'))).toEqual(Array(5).fill('right'))
    for (const row of rows) {
      expect(within(row as HTMLElement).getByText('Right')).toBeTruthy()
      expect(row.querySelector('svg')).not.toBeNull()
      expect(row.textContent).not.toContain('Right answer')
    }
  })

  it('marks a wrong row with an icon, the words, and the right chip under it', () => {
    const answers = { ...RIGHT, line1: 'p1-keep' }
    const { container } = render(<Page start={answers} locked result={checked(answers)} />)
    const rows = [...container.querySelectorAll<HTMLElement>('[data-trace-row]')]
    expect(rows.map((row) => row.getAttribute('data-result'))).toEqual([
      'wrong',
      'right',
      'right',
      'right',
      'right',
    ])
    const wrong = rows[0]
    if (wrong === undefined) throw new Error('No row.')
    // The same word as the mark of a wrong answer field ("Wrong"), with an icon.
    expect(within(wrong).getByText('Wrong')).toBeTruthy()
    expect(wrong.querySelector('svg')).not.toBeNull()
    expect(wrong.querySelector('[data-chip-id]')?.textContent).toBe(KEEP)
    expect(within(wrong).getByText('Right answer:')).toBeTruthy()
    expect(wrong.querySelector('[data-trace-right-answer]')?.textContent).toBe(A)
  })

  it('says "Left blank" for an empty row and still shows the right chip', () => {
    const answers = { ...RIGHT, line4: '' }
    const { container } = render(<Page start={answers} locked result={checked(answers)} />)
    const row = container.querySelector<HTMLElement>('[data-trace-row="4"]')
    if (row === null) throw new Error('No row.')
    expect(row.getAttribute('data-result')).toBe('wrong')
    expect(within(row).getByText('Left blank')).toBeTruthy()
    expect(within(row).getByText('no chip')).toBeTruthy()
    expect(row.querySelector('[data-trace-right-answer]')?.textContent).toBe(
      'rax = 0x0000000000000006',
    )
  })

  it('shows the chips that were not used, and that they are only shown', () => {
    render(<Page start={RIGHT} locked result={checked(RIGHT)} />)
    const group = screen.getByRole('group', { name: 'Chips you did not use' })
    expect(within(group).queryAllByRole('button')).toHaveLength(0)
    expect(group.querySelectorAll('[data-chip-in="tray"]')).toHaveLength(4)
    expect(group.textContent).not.toContain('Drag a chip')
  })

  it('shows no marks when it is locked without a result', () => {
    const { container } = render(<Page start={{ line1: 'p1-a' }} locked result={null} />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[data-result]')).toBeNull()
    expect(container.textContent).not.toContain('Right answer')
    expect(container.querySelector('[data-trace-row="1"] [data-chip-id]')?.textContent).toBe(A)
  })

  it('shows no marks while it is open, even when a result is still around', () => {
    const { container } = render(<Page start={RIGHT} locked={false} result={checked(RIGHT)} />)
    expect(container.querySelector('[data-result]')).toBeNull()
    expect(cell(1).tagName).toBe('BUTTON')
  })

  it('forgets a selection when the table locks, and opens clean again', () => {
    function Toggle(): ReactNode {
      const [locked, setLocked] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setLocked((old) => !old)}>
            toggle
          </button>
          <Page locked={locked} />
        </>
      )
    }
    render(<Toggle />)
    fireEvent.click(trayChip(A))
    fireEvent.click(screen.getByText('toggle'))
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(screen.queryByText('selected')).toBeNull()

    // "Try again" opens the same problem again: the old selection must not come back.
    fireEvent.click(screen.getByText('toggle'))
    expect(trayChip(A).getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(cell(1).textContent).toBe('put a chip here')
    // Escape has nothing to cancel, so it says nothing.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(heard()).toBe('')
  })

  it('empties the live region when the table locks and when it opens again', () => {
    // After Check a screen reader that reads the page must not find an old instruction
    // ("No chip is selected. First choose a chip…") under the table.
    function Toggle(): ReactNode {
      const [locked, setLocked] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setLocked((old) => !old)}>
            toggle
          </button>
          <Page locked={locked} />
        </>
      )
    }
    render(<Toggle />)
    fireEvent.click(cell(2))
    expect(heard()).toBe('No chip is selected. First choose a chip, then choose a line.')
    fireEvent.click(screen.getByText('toggle'))
    expect(screen.getByTestId('trace-announcer').textContent).toBe('')
    fireEvent.click(screen.getByText('toggle'))
    expect(screen.getByTestId('trace-announcer').textContent).toBe('')
    // It works as before once the table is open again.
    fireEvent.click(trayChip(A))
    expect(heard()).toBe(`${A} selected. Now choose a line.`)
  })

  it('forgets "first choose a chip" when the table locks and opens again', () => {
    function Toggle(): ReactNode {
      const [locked, setLocked] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setLocked((old) => !old)}>
            toggle
          </button>
          <Page locked={locked} />
        </>
      )
    }
    render(<Toggle />)
    fireEvent.click(cell(2))
    expect(tray().textContent).toContain('First choose a chip.')
    fireEvent.click(screen.getByText('toggle'))
    fireEvent.click(screen.getByText('toggle'))
    expect(tray().textContent).not.toContain('First choose a chip.')
  })

  it('falls back to the text of the field when the right chip is not among the chips', () => {
    const odd: Problem = {
      ...P1,
      fields: P1.fields.map((field, index) =>
        index === 0 ? { ...field, expected: 'missing', expectedDisplay: 'rax = 0x5' } : field,
      ),
    }
    const answers = { ...RIGHT }
    const { container } = render(
      <Page problem={odd} start={answers} locked result={checkProblem(odd, answers)} />,
    )
    expect(
      container.querySelector('[data-trace-row="1"] [data-trace-right-answer]')?.textContent,
    ).toBe('rax = 0x5')
  })
})

describe('odd props', () => {
  it('treats an answer that names a chip that does not exist as an empty cell', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'ghost' }} onCall={onCall} />)
    expect(cellNames()[0]).toBe(emptyCell(1))
    expect(trayLabels()).toHaveLength(9)
    place(A, 1)
    expect(onCall.mock.calls).toEqual([['line1', 'p1-a']])
    expect(cellNames()[0]).toBe(`Line 1, changed: ${A}`)
  })

  it('shows the same chip in two rows without crashing, and a move tidies it up', () => {
    const onCall = vi.fn()
    render(<Page start={{ line1: 'p1-a', line3: 'p1-a' }} onCall={onCall} />)
    expect(cellNames()[0]).toBe(`Line 1, changed: ${A}`)
    expect(cellNames()[2]).toBe(`Line 3, changed: ${A}`)
    expect(trayLabels()).not.toContain(A)

    fireEvent.click(cell(3))
    fireEvent.click(cell(5))
    expect(cellNames()).toEqual([
      emptyCell(1),
      emptyCell(2),
      emptyCell(3),
      emptyCell(4),
      `Line 5, changed: ${A}`,
    ])
    expect(trayLabels()).toHaveLength(8)
  })

  it('works with a problem that has no chips', () => {
    const none: Problem = { ...P1, chips: undefined }
    render(<Page problem={none} start={{ line1: 'p1-a' }} />)
    expect(cellNames()[0]).toBe(emptyCell(1))
    expect(tray().textContent).toContain('This problem has no chips.')
    fireEvent.click(cell(1))
    expect(heard()).toContain('No chip is selected.')
  })

  it('says so when every chip is placed', () => {
    const few: Problem = { ...P1, chips: (P1.chips ?? []).slice(0, 2) }
    render(<Page problem={few} start={{ line1: 'p1-b', line2: 'p1-keep' }} />)
    expect(tray().textContent).toContain('No chips are left.')
    // The last chip can still be put back.
    fireEvent.click(cell(1))
    expect(putBackButton()).not.toBeNull()
  })

  it('keeps long labels and labels without = inside the chip', () => {
    const long: Problem = {
      ...P1,
      chips: [
        { id: 'x', label: 'r15 = 0xffffffffffffffff' },
        { id: 'y', label: 'a label with no equals sign that is quite long' },
        { id: 'z', label: 'rax = 0x0000000000000005 = again' },
      ],
    }
    render(<Page problem={long} />)
    expect(trayChip('r15 = 0xffffffffffffffff').textContent).toBe('r15 = 0xffffffffffffffff')
    const plain = trayChip('a label with no equals sign that is quite long')
    expect(plain.querySelector('span')?.className).toContain('[overflow-wrap:anywhere]')
    expect(trayChip('rax = 0x0000000000000005 = again').textContent).toBe(
      'rax = 0x0000000000000005 = again',
    )
  })

  it('shows a row for a line of code that has no field, without a cell', () => {
    const extra: Problem = {
      ...P1,
      prompt: P1.prompt.map((block) =>
        block.type === 'code' ? { ...block, lines: [...block.lines, 'ret'] } : block,
      ),
    }
    const { container } = render(<Page problem={extra} />)
    const rows = container.querySelectorAll('[data-trace-row]')
    expect(rows).toHaveLength(6)
    expect(rows[5]?.querySelector('code')?.textContent).toBe('ret')
    expect(rows[5]?.querySelector('button')).toBeNull()
  })

  it('shows a cell for a field that has no line of code', () => {
    const short: Problem = {
      ...P1,
      prompt: P1.prompt.map((block) =>
        block.type === 'code' ? { ...block, lines: block.lines.slice(0, 3) } : block,
      ),
    }
    render(<Page problem={short} />)
    expect(cellNames()).toHaveLength(5)
    place(A, 5)
    expect(cellNames()[4]).toBe(`Line 5, changed: ${A}`)
  })

  it('starts clean when the problem changes while a chip is selected', () => {
    function Switch(): ReactNode {
      const [problem, setProblem] = useState(P1)
      return (
        <>
          <button type="button" onClick={() => setProblem(P2)}>
            next problem
          </button>
          <Page key={problem.id} problem={problem} />
        </>
      )
    }
    render(<Switch />)
    fireEvent.click(trayChip(A))
    fireEvent.click(cell(9 - 8)) // still problem 1: nothing wrong with choosing a line
    fireEvent.click(trayChip(B))
    fireEvent.click(screen.getByText('next problem'))

    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(heard()).toBe('')
    expect(trayLabels()).toEqual((P2.chips ?? []).map((chip) => chip.label))
    expect(cell(1).textContent).toBe('put a chip here')
  })

  it('forgets the selection when only the problem prop changes (same page, same answers)', () => {
    function Switch(): ReactNode {
      const [problem, setProblem] = useState(P1)
      return (
        <>
          <button type="button" onClick={() => setProblem(P2)}>
            next problem
          </button>
          <TraceTableView
            problem={problem}
            answers={{}}
            onChange={() => {}}
            locked={false}
            result={null}
          />
        </>
      )
    }
    render(<Switch />)
    fireEvent.click(trayChip(A))
    act(() => {
      fireEvent.click(screen.getByText('next problem'))
    })
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull()
    expect(cell(1).textContent).toBe('put a chip here')
    expect(heard()).toBe('')
  })

  it('unmounts cleanly in the middle of a selection', () => {
    const { unmount } = render(<Page />)
    fireEvent.click(trayChip(A))
    unmount()
    // The Escape listener is gone: nothing happens, nothing throws.
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.querySelector('[data-trace-table]')).toBeNull()
  })
})
