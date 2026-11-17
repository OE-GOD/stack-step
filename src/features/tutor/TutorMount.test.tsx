// @vitest-environment jsdom
/**
 * TutorMount in a pretend browser: when does it render nothing, when does the button
 * appear, and how often does it ask the function.
 *
 * The drawer itself (a native <dialog>) is tested in a real browser: e2e/tutor.spec.ts.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetTutorAnswer } from './availability'
import { TutorMount, type TutorContext } from './TutorMount'

const CONTEXT: TutorContext = { page: 'stepper', code: 'ret', machine: '', problem: null }
const getContext = (): TutorContext => CONTEXT

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

/** Replace the browser's fetch for one test. Returns the list of addresses that were asked. */
function stubFetch(respond: () => Response | Promise<Response>): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    asked.push(input instanceof Request ? input.url : input.toString())
    try {
      return Promise.resolve(respond())
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return asked
}

/** Give the request, the answer and the download of the drawer time to finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

let errors: ReturnType<typeof vi.spyOn>
let warnings: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  forgetTutorAnswer()
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function expectNothing(container: HTMLElement): void {
  expect(container.innerHTML).toBe('')
  expect(screen.queryByRole('button')).toBeNull()
  expect(document.querySelector('dialog')).toBeNull()
  expect(document.querySelector('[data-tutor]')).toBeNull()
  // Nothing from our code in the console either.
  expect(errors).not.toHaveBeenCalled()
  expect(warnings).not.toHaveBeenCalled()
}

describe('TutorMount without a tutor', () => {
  it('renders nothing while the answer is not there yet', async () => {
    let answer: (response: Response) => void = () => undefined
    const asked = stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)))
    const { container } = render(<TutorMount getContext={getContext} />)
    await settle()
    expect(asked).toEqual(['/api/tutor'])
    expectNothing(container)
    answer(json(200, { enabled: false }))
    await settle()
    expectNothing(container)
  })

  it.each([
    ['the function says enabled: false', () => json(200, { enabled: false })],
    ['there is no function (404)', () => new Response('Not Found', { status: 404 })],
    [
      'a static host answers with the HTML page of the site',
      () =>
        new Response('<!doctype html><title>Stack Step</title>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    ],
    [
      'the body is not JSON',
      () => new Response('enabled', { headers: { 'Content-Type': 'application/json' } }),
    ],
    ['the function fails (500)', () => json(500, { error: 'tutor-dev-error' })],
    [
      'the network fails',
      () => {
        throw new TypeError('Failed to fetch')
      },
    ],
  ])('renders nothing when %s', async (_name, respond) => {
    const asked = stubFetch(respond)
    const { container } = render(<TutorMount getContext={getContext} />)
    await settle()
    expect(asked).toEqual(['/api/tutor'])
    expectNothing(container)
  })

  it('never calls getContext', async () => {
    stubFetch(() => json(200, { enabled: false }))
    const spy = vi.fn(getContext)
    render(<TutorMount getContext={spy} />)
    await settle()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('TutorMount with a tutor', () => {
  it('shows the button after the function says enabled: true', async () => {
    stubFetch(() => json(200, { enabled: true }))
    const { container } = render(<TutorMount getContext={getContext} />)
    // Not at once: first the answer, then the code of the drawer.
    expect(container.innerHTML).toBe('')
    // (The first download of the drawer can take a moment in the test runner.)
    const button = await screen.findByRole('button', { name: 'Ask the tutor' }, { timeout: 5000 })
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.className).toContain('fixed')
    // The page tells the button how far to stay away from the bottom of the screen.
    expect(button.className).toContain('var(--tutor-bottom-offset,0px)')
    // The drawer is in the page, closed.
    const dialog = document.querySelector('dialog')
    expect(dialog).not.toBeNull()
    expect(dialog?.hasAttribute('open')).toBe(false)
    // Both parts carry a mark, so that tests can tell them from other dialogs of the site.
    expect(button.getAttribute('data-tutor')).toBe('button')
    expect(dialog?.getAttribute('data-tutor')).toBe('drawer')
    // Asking for the page data waits until the student sends a question.
    expect(errors).not.toHaveBeenCalled()
  })
})

describe('one request per page load', () => {
  it('asks once, however many times the tutor is mounted', async () => {
    const asked = stubFetch(() => json(200, { enabled: true }))
    const first = render(
      <StrictMode>
        <TutorMount getContext={getContext} />
        <TutorMount getContext={getContext} />
      </StrictMode>,
    )
    const buttons = await screen.findAllByRole(
      'button',
      { name: 'Ask the tutor' },
      { timeout: 5000 },
    )
    expect(buttons).toHaveLength(2)
    first.unmount()

    // The student goes to another page and comes back: the answer is already known, so
    // the button is there in the very first render.
    render(<TutorMount getContext={getContext} />)
    expect(asked).toEqual(['/api/tutor'])
    await settle()
    expect(screen.getByRole('button', { name: 'Ask the tutor' })).toBeTruthy()
    expect(asked).toEqual(['/api/tutor'])
  })

  it('also remembers "no": a second page does not ask again', async () => {
    const asked = stubFetch(() => new Response('Not Found', { status: 404 }))
    const first = render(<TutorMount getContext={getContext} />)
    await settle()
    first.unmount()
    const second = render(<TutorMount getContext={getContext} />)
    await settle()
    expect(asked).toEqual(['/api/tutor'])
    expectNothing(second.container)
  })
})
