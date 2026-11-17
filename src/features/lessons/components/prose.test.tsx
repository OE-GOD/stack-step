// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Code, CodeBlock, FactTable, Note, Steps, Term } from '.'

afterEach(() => {
  cleanup()
})

describe('the prose helpers', () => {
  it('FactTable is a real table with a caption, column and row headings', () => {
    render(
      <FactTable
        caption="Parts of `rax`"
        head={['Part', 'Name']}
        rows={[
          ['lowest 32 bits', '`eax`'],
          ['lowest 8 bits', '`al`'],
        ]}
      />,
    )
    const table = screen.getByRole('table', { name: 'Parts of rax' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Part', 'Name'])
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(['lowest 32 bits', 'lowest 8 bits'])
    // Code in a cell may break at a space, but never inside a word: that would make a
    // column one letter wide on a phone. So it is plain inline code, with no rule that
    // lets the browser break a word.
    const code = within(table).getByText('eax')
    expect(code.tagName).toBe('CODE')
    expect(code.className).not.toMatch(/inline-block|overflow-wrap|break-all|wrap-anywhere/)
    // The cell text is 15 px and the caption 14 px: 0.9 of that would be below 14 px, the
    // smallest text a student must read on a phone, so code never gets smaller than 14 px.
    expect(code.className).toContain('text-[length:max(0.9em,0.875rem)]')
    const captionCode = within(table).getByText('rax')
    expect(captionCode.className).toContain('text-[length:max(0.9em,0.875rem)]')
  })

  it('Steps is a numbered list; backticks become code', () => {
    render(<Steps items={['rsp goes down by 8.', 'The value of `rbx` is copied.']} />)
    const items = within(screen.getByRole('list')).getAllByRole('listitem')
    expect(screen.getByRole('list').tagName).toBe('OL')
    expect(items).toHaveLength(2)
    expect(within(items[1]).getByText('rbx').tagName).toBe('CODE')
  })

  it('Code, Term and Note use the right elements', () => {
    render(
      <>
        <p>
          A <Term>register</Term> such as <Code>rax</Code>.
        </p>
        <Note>You will use this in lesson 12.</Note>
      </>,
    )
    expect(screen.getByText('register').tagName).toBe('DFN')
    expect(screen.getByText('rax').tagName).toBe('CODE')
    expect(screen.getByText('rax').className).toContain('text-[length:max(0.9em,0.875rem)]')
    expect(screen.getByRole('note').textContent).toBe('You will use this in lesson 12.')
  })

  it('CodeBlock leaves out the line breaks around a template string', () => {
    const { container } = render(
      <CodeBlock>{`
    mov     rax, 5     # rax = 5
    ret
`}</CodeBlock>,
    )
    const lines = container.querySelectorAll('[data-line]')
    expect(lines).toHaveLength(2)
    expect(lines[0].textContent).toContain('mov     rax, 5')
  })
})
