// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { assemble } from '../../emulator'
import { unreachedBreakpoints, WHOLE_PROGRAM_WARNINGS } from './problems'
import { ProblemsList } from './ProblemsList'

afterEach(() => {
  cleanup()
})

const PROGRAM = 'main:\n    mov rax, 1   # one\n    ret\n# the end\n'

function program() {
  const result = assemble(PROGRAM)
  if (!result.ok) throw new Error('The program did not assemble.')
  return result.program
}

describe('breakpoints that are never reached', () => {
  it('are the ones on a line without an instruction', () => {
    expect(unreachedBreakpoints(program(), [2, 3, 4])).toEqual([
      {
        line: 4,
        message:
          'Line 4: this line has no instruction, so the program never stops at its breakpoint.',
      },
    ])
    expect(unreachedBreakpoints(null, [4])).toEqual([])
  })

  it('are listed with the notes, with a button that goes to the line', () => {
    render(
      <ProblemsList
        diagnostics={[]}
        notes={unreachedBreakpoints(program(), [4])}
        onGoToLine={() => undefined}
      />,
    )
    expect(screen.getByText('Note')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Line 4' })).toBeDefined()
    expect(screen.getByText(/never stops at its breakpoint/)).toBeDefined()
  })
})

describe('the warnings about whole programs', () => {
  it('are left out for a piece of a program', () => {
    const result = assemble('    mov rax, 1\n    ret\n')
    const codes = result.diagnostics.map((item) => item.code)
    expect(codes).toEqual(expect.arrayContaining([...WHOLE_PROGRAM_WARNINGS]))
    const { container } = render(
      <ProblemsList diagnostics={result.diagnostics} hideWarnings={WHOLE_PROGRAM_WARNINGS} />,
    )
    expect(container.textContent).toBe('')
  })
})
