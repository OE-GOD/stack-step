// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LessonErrorBoundary, LessonProblem } from './LessonStates'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Broken(): never {
  throw new Error('a mistake in a lesson file')
}

describe('the stand-ins for a lesson', () => {
  it('a lesson that throws while it is shown becomes a calm message, not a crash', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <>
        <h1>Lesson title</h1>
        <LessonErrorBoundary>
          <Broken />
        </LessonErrorBoundary>
        <a href="#/learn">All lessons</a>
      </>,
    )
    expect(
      screen.getByRole('heading', { level: 2, name: 'This lesson has a problem' }),
    ).toBeDefined()
    // The page keeps its one <h1> and its links.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'All lessons' })).toBeDefined()
  })

  it('a missing or broken lesson file is a problem of the site, with no Try again', () => {
    render(<LessonProblem />)
    expect(
      screen.getByRole('heading', { level: 2, name: 'This lesson has a problem' }),
    ).toBeDefined()
    expect(screen.getByText('Stack Step made a mistake. You did nothing wrong.')).toBeDefined()
    // Loading the same file again would not help, so there is nothing to try again.
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    // Nothing on the page says the lesson is still being written: every lesson exists.
    expect(document.body.textContent).not.toMatch(/being written|coming soon/i)
  })

  it('a failed download offers Try again', () => {
    const retry = vi.fn()
    render(<LessonProblem downloadFailed onRetry={retry} />)
    expect(
      screen.getByRole('heading', { level: 2, name: 'This lesson did not load' }),
    ).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
