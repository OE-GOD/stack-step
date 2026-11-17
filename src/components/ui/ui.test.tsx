// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { createRef, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Badge } from './Badge'
import { Button } from './Button'
import { ButtonLink } from './ButtonLink'
import { Callout, type CalloutTone } from './Callout'
import { cx } from './cx'
import { ErrorBoundary } from './ErrorBoundary'
import { IconButton } from './IconButton'
import * as icons from './icons'
import { InlineCode } from './InlineCode'
import { Input } from './Input'
import { Kbd } from './Kbd'
import { NoWrap } from './NoWrap'
import { NOT_SAVED_TEXT, NotSavedNote } from './NotSavedNote'
import { Panel } from './Panel'
import { Popover } from './Popover'
import { RichText } from './RichText'
import { Select } from './Select'
import { Loading, Spinner } from './Spinner'
import { TextLink } from './TextLink'
import { useDisclosure } from './useDisclosure'
import { VisuallyHidden } from './VisuallyHidden'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function classesOf(element: Element): string[] {
  return [...element.classList]
}

describe('cx', () => {
  it('joins class names and skips empty values', () => {
    expect(cx('a', false, 'b', null, undefined, '', 'c')).toBe('a b c')
    expect(cx()).toBe('')
  })
})

describe('Button', () => {
  it('is type="button" unless told otherwise', () => {
    render(
      <>
        <Button>Step</Button>
        <Button type="submit">Check</Button>
      </>,
    )
    expect(screen.getByRole('button', { name: 'Step' }).getAttribute('type')).toBe('button')
    expect(screen.getByRole('button', { name: 'Check' }).getAttribute('type')).toBe('submit')
  })

  it('is secondary and 44 px tall by default', () => {
    render(<Button>Step</Button>)
    const classes = classesOf(screen.getByRole('button'))
    expect(classes).toContain('border-line-strong')
    expect(classes).toContain('min-h-11')
  })

  it.each([
    ['primary', 'bg-primary'],
    ['secondary', 'bg-surface'],
    ['ghost', 'bg-transparent'],
    ['danger', 'text-bad'],
  ] as const)('has the look of the %s variant', (variant, expected) => {
    render(<Button variant={variant}>Go</Button>)
    expect(classesOf(screen.getByRole('button'))).toContain(expected)
  })

  it.each([
    ['sm', 'min-h-9'],
    ['md', 'min-h-11'],
    ['lg', 'min-h-13'],
  ] as const)('has the height of size %s', (size, expected) => {
    render(<Button size={size}>Go</Button>)
    expect(classesOf(screen.getByRole('button'))).toContain(expected)
  })

  it('passes every other attribute, the ref and the click handler through', () => {
    const onClick = vi.fn()
    const ref = createRef<HTMLButtonElement>()
    render(
      <Button onClick={onClick} ref={ref} className="w-full" aria-pressed="true" data-step="1">
        Step
      </Button>,
    )
    const button = screen.getByRole('button', { name: 'Step' })
    expect(ref.current).toBe(button)
    expect(classesOf(button)).toContain('w-full')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.getAttribute('data-step')).toBe('1')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not click when it is disabled', () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Step
      </Button>,
    )
    const button = screen.getByRole<HTMLButtonElement>('button')
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('IconButton', () => {
  it('takes its name from the label and is a square', () => {
    render(
      <IconButton label="Step back">
        <icons.StepBackIcon />
      </IconButton>,
    )
    const button = screen.getByRole('button', { name: 'Step back' })
    expect(button.getAttribute('type')).toBe('button')
    expect(classesOf(button)).toContain('size-11')
    expect(classesOf(button)).not.toContain('px-4')
  })
})

describe('ButtonLink and TextLink', () => {
  it('ButtonLink is a real link to the route that looks like a button', () => {
    render(
      <ButtonLink to="/learn/mov" variant="primary" size="lg">
        Start the lesson
      </ButtonLink>,
    )
    const link = screen.getByRole('link', { name: 'Start the lesson' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('#/learn/mov')
    expect(classesOf(link)).toEqual(expect.arrayContaining(['bg-primary', 'min-h-13']))
  })

  it('a ButtonLink that is switched off cannot be followed', () => {
    const onClick = vi.fn()
    render(
      <>
        <ButtonLink to="/learn/mov" aria-disabled="true" onClick={onClick} id="next">
          Next lesson
        </ButtonLink>
        <ButtonLink to="/about" aria-disabled={true}>
          About
        </ButtonLink>
        <ButtonLink to="/progress" aria-disabled="false">
          Progress
        </ButtonLink>
      </>,
    )
    const before = window.location.hash

    // Screen readers still find it, as a link that is not available.
    const link = screen.getByRole('link', { name: 'Next lesson' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('aria-disabled')).toBe('true')
    expect(link.id).toBe('next')
    // No address: the browser has nothing to follow, and the Tab key skips it
    // (e2e/shell.spec.ts checks the Tab key in a real browser).
    expect(link.hasAttribute('href')).toBe(false)
    expect(link.hasAttribute('tabindex')).toBe(false)
    // It keeps the look of a button.
    expect(classesOf(link)).toContain('min-h-11')

    fireEvent.click(link)
    expect(onClick).not.toHaveBeenCalled()
    expect(window.location.hash).toBe(before)

    expect(screen.getByRole('link', { name: 'About' }).hasAttribute('href')).toBe(false)
    // aria-disabled="false" is a normal link.
    expect(screen.getByRole('link', { name: 'Progress' }).getAttribute('href')).toBe('#/progress')
  })

  it('TextLink is an underlined link to the route', () => {
    render(<TextLink to="/about">About</TextLink>)
    const link = screen.getByRole('link', { name: 'About' })
    expect(link.getAttribute('href')).toBe('#/about')
    expect(classesOf(link)).toContain('underline')
  })
})

describe('Panel', () => {
  it('is a section named by its heading', () => {
    render(<Panel title="Registers">sixteen of them</Panel>)
    const section = screen.getByRole('region', { name: 'Registers' })
    expect(section.tagName).toBe('SECTION')
    expect(section.textContent).toContain('sixteen of them')
    expect(screen.getByRole('heading', { level: 2, name: 'Registers' })).toBeTruthy()
  })

  it('can use another heading level', () => {
    render(
      <Panel title="Flags" headingLevel={3}>
        four lights
      </Panel>,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Flags' })).toBeTruthy()
  })

  it('shows the actions next to the heading', () => {
    render(
      <Panel title="Stack" actions={<Button size="sm">Help</Button>}>
        boxes
      </Panel>,
    )
    const section = screen.getByRole('region', { name: 'Stack' })
    expect(section.contains(screen.getByRole('button', { name: 'Help' }))).toBe(true)
  })

  it('gives two panels different heading ids', () => {
    render(
      <>
        <Panel title="One">1</Panel>
        <Panel title="Two">2</Panel>
      </>,
    )
    const ids = screen.getAllByRole('heading').map((heading) => heading.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('a flush panel draws focus outlines inside the controls, where they are not cut off', () => {
    const { container } = render(
      <>
        <Panel title="Registers" flush>
          <button type="button">rax</button>
        </Panel>
        <Panel title="Flags">
          <button type="button">ZF</button>
        </Panel>
      </>,
    )
    const [flush, padded] = [...container.querySelectorAll('section')].map(
      (section) => section.lastElementChild as HTMLElement,
    )
    expect(classesOf(flush)).toEqual(
      expect.arrayContaining(['overflow-hidden', '[&_:focus-visible]:-outline-offset-2']),
    )
    expect(classesOf(padded)).toEqual(['p-4'])
  })

  it('passes other attributes to the section', () => {
    render(
      <Panel title="Output" className="mt-4" data-panel="output">
        text
      </Panel>,
    )
    const section = screen.getByRole('region', { name: 'Output' })
    expect(classesOf(section)).toContain('mt-4')
    expect(section.getAttribute('data-panel')).toBe('output')
  })
})

describe('Callout', () => {
  const labels: [CalloutTone, string][] = [
    ['info', 'Note'],
    ['analogy', 'Think of it like this'],
    ['good', 'Correct'],
    ['bad', 'Not correct'],
    ['warn', 'Warning'],
  ]

  it.each(labels)('tone %s shows an icon and the word "%s"', (tone, label) => {
    const { container } = render(<Callout tone={tone}>The body text.</Callout>)
    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText('The body text.')).toBeTruthy()
    const icon = container.querySelector('svg')
    expect(icon?.getAttribute('aria-hidden')).toBe('true')
  })

  it('is a note by default', () => {
    render(<Callout>Text</Callout>)
    expect(screen.getByText('Note')).toBeTruthy()
  })

  it('can show another word, and passes other attributes through', () => {
    render(
      <Callout tone="good" label="Yes, 0x10" role="status">
        Well done.
      </Callout>,
    )
    const box = screen.getByRole('status')
    expect(box.textContent).toContain('Yes, 0x10')
    expect(box.textContent).not.toContain('Correct')
  })
})

describe('small pieces', () => {
  it('Badge shows its text and takes a tone', () => {
    render(<Badge tone="good">Done</Badge>)
    expect(classesOf(screen.getByText('Done'))).toContain('text-good')
  })

  it('Badge text is 14 px on a phone and 12 px from 768 px', () => {
    render(<Badge>Done</Badge>)
    const classes = classesOf(screen.getByText('Done'))
    expect(classes).toContain('text-sm')
    expect(classes).toContain('md:text-xs')
    expect(classes).not.toContain('text-xs')
  })

  it('Kbd is a <kbd> element', () => {
    render(<Kbd>S</Kbd>)
    expect(screen.getByText('S').tagName).toBe('KBD')
  })

  it('VisuallyHidden keeps the text for screen readers', () => {
    render(
      <button type="button">
        <icons.CloseIcon />
        <VisuallyHidden>Close</VisuallyHidden>
      </button>,
    )
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
    expect(classesOf(screen.getByText('Close'))).toContain('sr-only')
  })

  it('Loading is a status with words; the spinner is decoration', () => {
    const { container } = render(
      <>
        <Loading />
        <Loading label="Loading the editor…" />
      </>,
    )
    const [first, second] = screen.getAllByRole('status')
    expect(first.textContent).toBe('Loading…')
    expect(second.textContent).toBe('Loading the editor…')
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('Spinner takes a size', () => {
    const { container } = render(<Spinner size={32} />)
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('32')
  })

  it('InlineCode is a <code> element', () => {
    render(<InlineCode>mov rax, 5</InlineCode>)
    expect(screen.getByText('mov rax, 5').tagName).toBe('CODE')
  })

  it('InlineCode has a background that every browser can paint, and can break inside', () => {
    render(<InlineCode className="text-bad">mov rax, 5</InlineCode>)
    const classes = classesOf(screen.getByText('mov rax, 5'))
    // A tint token, not an opacity modifier (see the rule in src/index.css).
    expect(classes).toContain('bg-chip')
    expect(classes.filter((name) => name.includes('/'))).toEqual([])
    // Inside a <NoWrap>, long code must still be able to break.
    expect(classes).toContain('whitespace-normal')
    expect(classes).toContain('text-bad')
  })

  it('NoWrap keeps its text on one line', () => {
    render(<NoWrap>x86-64</NoWrap>)
    expect(classesOf(screen.getByText('x86-64'))).toContain('whitespace-nowrap')
  })

  it('Input and Select pass their attributes through', () => {
    render(
      <>
        <label htmlFor="answer">Your answer</label>
        <Input id="answer" mono defaultValue="0x10" inputMode="text" />
        <label htmlFor="example">Example</label>
        <Select id="example" defaultValue="sum">
          <option value="hello">Hello World</option>
          <option value="sum">Sum loop</option>
        </Select>
      </>,
    )
    const input = screen.getByLabelText<HTMLInputElement>('Your answer')
    expect(input.value).toBe('0x10')
    expect(classesOf(input)).toEqual(expect.arrayContaining(['font-mono', 'min-h-11']))
    const select = screen.getByLabelText<HTMLSelectElement>('Example')
    expect(select.value).toBe('sum')
    expect(classesOf(select)).toContain('min-h-11')
  })
})

describe('icons', () => {
  const all = Object.entries(icons)

  it('there is a set of them', () => {
    expect(all.length).toBeGreaterThanOrEqual(20)
  })

  it.each(all)('%s is a hidden, non-focusable drawing', (_name, Icon) => {
    const { container } = render(<Icon />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('focusable')).toBe('false')
    expect(svg?.getAttribute('width')).toBe('20')
    expect(svg?.childElementCount).toBeGreaterThan(0)
  })

  it('takes a size and extra classes, and cannot be un-hidden', () => {
    const { container } = render(
      <icons.CheckIcon size={32} className="text-good" aria-hidden={false} />,
    )
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('32')
    expect(svg?.getAttribute('height')).toBe('32')
    expect(svg?.getAttribute('class')).toBe('shrink-0 text-good')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('RichText', () => {
  function renderText(text: string): HTMLElement {
    return render(
      <p>
        <RichText text={text} />
      </p>,
    ).container
  }

  function codeIn(container: HTMLElement): string[] {
    return [...container.querySelectorAll('code')].map((code) => code.textContent)
  }

  it('shows plain text as it is', () => {
    const container = renderText('rsp went down 8.')
    expect(container.textContent).toBe('rsp went down 8.')
    expect(codeIn(container)).toEqual([])
  })

  it('puts the parts in backticks in a code font and drops the backticks', () => {
    const container = renderText('`push rbx`: rsp went down 8, then `rbx` was copied.')
    expect(container.textContent).toBe('push rbx: rsp went down 8, then rbx was copied.')
    expect(codeIn(container)).toEqual(['push rbx', 'rbx'])
  })

  it('handles code at the very start and the very end', () => {
    const container = renderText('`mov` copies into `rax`')
    expect(container.textContent).toBe('mov copies into rax')
    expect(codeIn(container)).toEqual(['mov', 'rax'])
  })

  it('handles a message that is only code', () => {
    expect(codeIn(renderText('`ret`'))).toEqual(['ret'])
  })

  it('shows a backtick that has no partner as it is', () => {
    const container = renderText('Use `mov` and not ` here')
    expect(container.textContent).toBe('Use mov and not ` here')
    expect(codeIn(container)).toEqual(['mov'])

    expect(renderText('a ` b').textContent).toBe('a ` b')
    expect(renderText('`').textContent).toBe('`')
  })

  it('shows nothing for an empty message or empty backticks', () => {
    expect(renderText('').textContent).toBe('')
    const container = renderText('a``b')
    expect(container.textContent).toBe('ab')
    expect(codeIn(container)).toEqual([])
  })

  /** The text of every piece that is kept on one line. */
  function keptTogether(container: HTMLElement): string[] {
    return [...container.querySelectorAll('span.whitespace-nowrap')].map((span) => span.textContent)
  }

  it('keeps a comma or a period on the same line as the code in front of it', () => {
    const container = renderText(
      'The answer is `0x7ffffffddff0`. rsp goes down, see `push`, then `pop`.',
    )
    expect(container.textContent).toBe(
      'The answer is 0x7ffffffddff0. rsp goes down, see push, then pop.',
    )
    expect(codeIn(container)).toEqual(['0x7ffffffddff0', 'push', 'pop'])
    expect(keptTogether(container)).toEqual(['0x7ffffffddff0.', 'push,', 'pop.'])
  })

  it.each([
    ['`push rbx`: rsp went down 8.', ['push rbx:']],
    ['Did you mean `rax`?', ['rax?']],
    ['Wrong (see `mov`).', ['mov).']],
    ['Use (`rax`) here', ['(rax)']],
    ['He said "`ret`" twice', ['"ret"']],
    ['Both `je`/`jz` work', ['je/']],
    ["The value of `rbx`'s low byte", ["rbx'"]],
    ['Is it `rax`…', ['rax…']],
  ])('keeps the marks that touch the code with it: %j', (text, expected) => {
    const container = renderText(text)
    expect(keptTogether(container)).toEqual(expected)
    expect(container.textContent).toBe(text.replaceAll('`', ''))
  })

  it('leaves code alone when a space or a word comes next', () => {
    const container = renderText('`mov` copies `rax` and `rbx`s too, but not ( `rcx` )')
    expect(keptTogether(container)).toEqual([])
    expect(codeIn(container)).toEqual(['mov', 'rax', 'rbx', 'rcx'])
  })

  it('takes at most three marks on each side', () => {
    const container = renderText('a ((((`x`)))). b')
    expect(keptTogether(container)).toEqual(['(((x)))'])
    expect(container.textContent).toBe('a ((((x)))). b')
  })

  it('does not take the marks of an unpaired backtick', () => {
    const container = renderText('`mov`, and not `, here')
    expect(container.textContent).toBe('mov, and not `, here')
    expect(keptTogether(container)).toEqual(['mov,'])
  })
})

describe('Popover', () => {
  function setup(): { button: HTMLElement; panel: HTMLElement; outside: HTMLElement } {
    render(
      <>
        <Popover button="Shortcuts" title="Keyboard shortcuts">
          <button type="button">Inside</button>
        </Popover>
        <button type="button">Outside</button>
      </>,
    )
    const button = screen.getByRole('button', { name: 'Shortcuts' })
    const panelId = button.getAttribute('aria-controls') ?? ''
    const panel = document.getElementById(panelId)
    if (panel === null) throw new Error('aria-controls does not point at an element')
    return { button, panel, outside: screen.getByRole('button', { name: 'Outside' }) }
  }

  it('starts closed, with the panel still in the page', () => {
    const { button, panel } = setup()
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(panel.hidden).toBe(true)
    expect(panel.getAttribute('aria-label')).toBe('Keyboard shortcuts')
  })

  it('opens and closes when the button is clicked', () => {
    const { button, panel } = setup()
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(panel.hidden).toBe(false)
    expect(panel.textContent).toContain('Keyboard shortcuts')

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(panel.hidden).toBe(true)
  })

  it('closes on Escape and puts focus back on the button', () => {
    const { button, panel } = setup()
    fireEvent.click(button)
    const inside = screen.getByRole('button', { name: 'Inside' })
    act(() => inside.focus())
    expect(document.activeElement).toBe(inside)

    fireEvent.keyDown(inside, { key: 'Escape' })
    expect(panel.hidden).toBe(true)
    expect(document.activeElement).toBe(button)
  })

  it('ignores other keys', () => {
    const { button, panel } = setup()
    fireEvent.click(button)
    fireEvent.keyDown(document.body, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'a' })
    expect(panel.hidden).toBe(false)
  })

  it('closes on a press outside, but not on a press inside', () => {
    const { button, panel, outside } = setup()
    fireEvent.click(button)

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Inside' }))
    expect(panel.hidden).toBe(false)
    fireEvent.pointerDown(button)
    expect(panel.hidden).toBe(false)

    fireEvent.pointerDown(outside)
    expect(panel.hidden).toBe(true)
  })

  it('closes when keyboard focus leaves the button and the panel', () => {
    const { button, panel, outside } = setup()
    fireEvent.click(button)
    act(() => screen.getByRole('button', { name: 'Inside' }).focus())
    expect(panel.hidden).toBe(false)

    act(() => outside.focus())
    expect(panel.hidden).toBe(true)
    // Focus stays where the student put it.
    expect(document.activeElement).toBe(outside)
  })

  it('stops listening to the page when it is closed and when it goes away', () => {
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    const { button } = setup()
    expect(added).not.toHaveBeenCalled()

    fireEvent.click(button)
    const count = added.mock.calls.length
    expect(count).toBeGreaterThan(0)
    fireEvent.click(button)
    expect(removed.mock.calls.length).toBe(count)

    fireEvent.click(button)
    cleanup()
    expect(removed.mock.calls.length).toBe(added.mock.calls.length)
  })

  it('names an icon-only button with buttonLabel', () => {
    render(
      <Popover button={<icons.HelpIcon />} buttonLabel="Help" align="end">
        Text
      </Popover>,
    )
    const button = screen.getByRole('button', { name: 'Help' })
    const panel = document.getElementById(button.getAttribute('aria-controls') ?? '')
    expect(panel?.getAttribute('aria-label')).toBe('Help')
    expect(classesOf(panel as HTMLElement)).toContain('right-0')
  })
})

describe('useDisclosure', () => {
  it('opens, closes and toggles', () => {
    const { result } = renderHook(() => useDisclosure())
    expect(result.current.open).toBe(false)
    act(() => result.current.toggle())
    expect(result.current.open).toBe(true)
    expect(result.current.buttonProps['aria-expanded']).toBe(true)
    act(() => result.current.close())
    expect(result.current.open).toBe(false)
    act(() => result.current.close())
    expect(result.current.open).toBe(false)
  })

  it('points the button at the panel', () => {
    const { result } = renderHook(() => useDisclosure())
    expect(result.current.buttonProps['aria-controls']).toBe(result.current.panelProps.id)
    expect(result.current.panelProps.id).not.toBe('')
  })

  it('closes when the watched value changes, in the same render', () => {
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useDisclosure({ closeOnChangeOf: path }),
      { initialProps: { path: '/' } },
    )
    act(() => result.current.toggle())
    expect(result.current.open).toBe(true)

    rerender({ path: '/' })
    expect(result.current.open).toBe(true)

    rerender({ path: '/about' })
    expect(result.current.open).toBe(false)

    // It can be opened again on the new page.
    act(() => result.current.toggle())
    expect(result.current.open).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.open).toBe(false)
  })

  it('stays closed when the watched value later returns to the value it was opened with', () => {
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useDisclosure({ closeOnChangeOf: path }),
      { initialProps: { path: '/' } },
    )
    // Open on '/', leave without closing (the Back button, for example), then come back.
    act(() => result.current.toggle())
    rerender({ path: '/about' })
    expect(result.current.open).toBe(false)
    rerender({ path: '/' })
    expect(result.current.open).toBe(false)

    // One press opens it again: the old "open" was really forgotten.
    act(() => result.current.toggle())
    expect(result.current.open).toBe(true)
  })

  it('does not open again when the watched value changes back', () => {
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => useDisclosure({ closeOnChangeOf: path }),
      { initialProps: { path: '/' } },
    )
    act(() => result.current.toggle())
    rerender({ path: '/about' })
    act(() => result.current.toggle())
    act(() => result.current.toggle())
    rerender({ path: '/' })
    expect(result.current.open).toBe(false)
  })
})

describe('ErrorBoundary', () => {
  /** What Chrome says when a page file cannot be downloaded. */
  const DOWNLOAD_ERROR =
    'Failed to fetch dynamically imported module: http://localhost/assets/StepperPage.js'

  function Broken({ message = DOWNLOAD_ERROR }: { message?: string }): ReactNode {
    throw new Error(message)
  }

  it('shows its children when nothing goes wrong', () => {
    render(
      <ErrorBoundary>
        <h1>Stepper</h1>
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Stepper')
  })

  it('shows a calm message with a way out when the page file could not be downloaded', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    )
    const alert = screen.getByRole('alert')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This page did not load')
    expect(alert.textContent).toContain('Check your internet connection.')
    expect(screen.getByRole('button', { name: 'Load the page again' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to the home page' }).getAttribute('href')).toBe(
      '#/',
    )
    expect(logged).toHaveBeenCalled()
  })

  it('does not blame the internet for a mistake in the page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Broken message="Cannot read properties of undefined (reading 'rax')" />
      </ErrorBoundary>,
    )
    const alert = screen.getByRole('alert')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This page has a problem')
    expect(alert.textContent).not.toContain('internet')
    expect(alert.textContent).toContain('You did nothing wrong.')
    // The same two ways out.
    expect(screen.getByRole('button', { name: 'Load the page again' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Go to the home page' }).getAttribute('href')).toBe(
      '#/',
    )
    expect(screen.getAllByRole('heading')).toHaveLength(1)
  })

  it.each([
    ['Chrome', DOWNLOAD_ERROR],
    ['Firefox', 'error loading dynamically imported module: http://localhost/assets/Page.js'],
    ['Safari', 'Importing a module script failed.'],
    ['a style file of the page', 'Unable to preload CSS for /assets/StepperPage.css'],
    ['a failed request in Chrome', 'Failed to fetch'],
    ['a failed request in Firefox', 'NetworkError when attempting to fetch resource.'],
    ['a failed request in Safari', 'Load failed'],
  ])('knows a failed download as %s words it', (_browser, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Broken message={message} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This page did not load')
  })

  it.each([
    'The example failed to load its program',
    'Failed to fetch the answer key from the emulator',
    'x is not a function',
    '',
  ])('treats %j as a mistake in the page', (message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <ErrorBoundary>
        <Broken message={message} />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('This page has a problem')
  })

  it('tells its owner about the error once, after the message is on screen', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const seen: { message: string; alertOnScreen: boolean }[] = []
    render(
      <ErrorBoundary
        onError={(error) =>
          seen.push({
            message: error instanceof Error ? error.message : String(error),
            alertOnScreen: screen.queryByRole('alert') !== null,
          })
        }
      >
        <Broken message="boom" />
      </ErrorBoundary>,
    )
    expect(seen).toEqual([{ message: 'boom', alertOnScreen: true }])
  })

  it('tries again with a new key', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <ErrorBoundary key="/broken">
        <Broken />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()

    rerender(
      <ErrorBoundary key="/about">
        <h1>About</h1>
      </ErrorBoundary>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('About')
  })
})

describe('NotSavedNote', () => {
  it('says in one sentence, as an info note, that progress lasts only until a reload', () => {
    render(<NotSavedNote data-no-storage="" className="mb-6" />)
    const box = screen.getByText(NOT_SAVED_TEXT).closest('div[data-no-storage]')
    if (!(box instanceof HTMLElement)) throw new Error('The note is not there.')
    expect(box.textContent).toBe(`Not saved${NOT_SAVED_TEXT}`)
    expect(classesOf(box)).toContain('mb-6')
    expect(classesOf(box)).toContain('bg-primary-soft')
    // The words are true for a browser that blocks storage: a reload loses the progress.
    expect(NOT_SAVED_TEXT).toContain('close or reload this page')
    expect(NOT_SAVED_TEXT).not.toMatch(/storage|tab/)
  })
})

describe('the rule about see-through backgrounds', () => {
  // A background such as `bg-ink/8` is built with color-mix(). A browser without
  // color-mix() paints the full color instead and hides what is on top of it.
  // Use a tint token (see src/index.css).
  const sources = import.meta.glob<string>(
    ['./*.{ts,tsx}', '../layout/*.{ts,tsx}', '!./*.test.tsx', '!../layout/*.test.tsx'],
    { query: '?raw', import: 'default', eager: true },
  )

  it('reads the kit', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(25)
    expect(Object.keys(sources)).toContain('./InlineCode.tsx')
    expect(Object.keys(sources)).toContain('../layout/AppShell.tsx')
  })

  it.each(Object.entries(sources))(
    '%s has no background with an opacity modifier',
    (_file, source) => {
      expect(source.match(/\bbg-[a-z0-9-]+\/\d+/g) ?? []).toEqual([])
    },
  )
})
