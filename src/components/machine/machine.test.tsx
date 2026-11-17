// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmulator, type Emulator } from '../../emulator'
import { exampleById } from '../../examples'
import { CodeListing } from './CodeListing'
import { DataPanel } from './DataPanel'
import { ExplanationPanel } from './ExplanationPanel'
import { FlagsPanel } from './FlagsPanel'
import { HexValue } from './HexValue'
import { OutputPanel } from './OutputPanel'
import { PanelBoundary } from './PanelBoundary'
import { RegistersPanel } from './RegistersPanel'
import { StackPanel } from './StackPanel'
import {
  BEFORE_FIRST_STEP,
  CANNOT_SHOW_EXAMPLE,
  CANNOT_SHOW_PART,
  FIX_THE_CODE,
  FIX_THE_PROBLEMS,
  NOTHING_PRINTED,
} from './words'

afterEach(() => {
  cleanup()
})

function emulator(source: string): Emulator {
  const created = createEmulator(source)
  if (!created.ok) throw new Error(created.diagnostics.map((item) => item.message).join(' | '))
  return created.emulator
}

function example(id: string): Emulator {
  return emulator(exampleById(id)?.source ?? '')
}

function steps(emu: Emulator, count: number): Emulator {
  for (let i = 0; i < count; i++) emu.step()
  return emu
}

/**
 * jsdom lays nothing out, so no box ever overflows. This makes every element report the
 * given sizes (a box that hides content), and gives a ResizeObserver that measures once.
 * Returns the function that puts everything back.
 */
function fakeOverflow(sizes: { scrollHeight: number; clientHeight: number }): () => void {
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(sizes.scrollHeight),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(sizes.clientHeight),
  ]
  const original = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    private readonly callback: () => void
    constructor(callback: () => void) {
      this.callback = callback
    }
    observe(): void {
      this.callback()
    }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  return () => {
    for (const spy of spies) spy.mockRestore()
    globalThis.ResizeObserver = original
  }
}

const MOV = 'main:\n    mov rax, -1\n    mov eax, 5\n    push rax\n    pop rbx\n    ret\n'

describe('HexValue', () => {
  it('copies as one word, with the leading zeros dimmed and groups made by CSS', () => {
    const { container } = render(<HexValue value={7n} />)
    const hex = container.querySelector('[data-hex]')
    expect(hex?.textContent).toBe('0x0000000000000007')
    // 15 dimmed zeros (and the dimmed 0x prefix).
    const dimmed = [...(hex?.querySelectorAll('.text-muted') ?? [])].map((node) => node.textContent)
    expect(dimmed.join('')).toBe('0x000000000000000')
  })

  it('marks a change with bold text, a dot and the word "changed"', () => {
    const { container } = render(<HexValue value={0x2an} changed flashKey={3} digits={8} />)
    expect(container.textContent).toBe('0x0000002a changed')
    expect(container.firstElementChild?.className).toContain('font-bold')
    expect(container.querySelector('.animate-flash')).not.toBeNull()
  })

  it('can leave out the groups (rip)', () => {
    const { container } = render(<HexValue value={0x401126n} digits={0} group={false} />)
    expect(container.querySelectorAll('[data-hex] > span')).toHaveLength(2)
    expect(container.querySelector('[data-hex]')?.textContent).toBe('0x401126')
  })
})

describe('RegistersPanel', () => {
  it('shows sixteen registers and rip, and marks the changed one', () => {
    const emu = steps(emulator(MOV), 1)
    render(<RegistersPanel machine={emu.getSnapshot()} program={emu.program} />)
    const rows = screen.getAllByRole('button', { expanded: false })
    expect(rows).toHaveLength(16)
    // The name holds the value as the screen shows it: all 16 digits.
    expect(screen.getByRole('button', { name: 'rax: 0xffffffffffffffff, changed' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'rbx: 0x0000000000000000' })).toBeDefined()
    expect(screen.getByText('line 3')).toBeDefined()
  })

  it('opens a row into its parts and shows the cleared top half', () => {
    const emu = steps(emulator(MOV), 2)
    const { container } = render(
      <RegistersPanel machine={emu.getSnapshot()} program={emu.program} />,
    )
    const rax = screen.getByRole('button', { name: /^rax: / })
    fireEvent.click(rax)
    expect(rax.getAttribute('aria-expanded')).toBe('true')
    const parts = container.querySelector(`#${CSS.escape(rax.getAttribute('aria-controls') ?? '')}`)
    expect(parts).not.toBeNull()
    const view = within(parts as HTMLElement)
    for (const name of ['eax', 'ax', 'ah', 'al'])
      expect(view.getAllByText(name).length).toBeGreaterThan(0)
    expect(view.getByText(/also set the top 32 bits of/)).toBeDefined()
    expect(parts?.textContent).toContain('0xffffffffffffffff')
    expect(parts?.textContent).toContain('Unsigned: 5')
  })

  it('shows only the chosen registers in a compact panel', () => {
    const emu = emulator(MOV)
    render(
      <RegistersPanel compact machine={emu.getSnapshot()} registers={['rax']} showRip={false} />,
    )
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('StackPanel', () => {
  it('moves the rsp marker with a push, and labels the box', () => {
    const emu = steps(emulator(MOV), 3)
    const machine = emu.getSnapshot()
    const { container } = render(<StackPanel machine={machine} />)
    const rspBox = container.querySelector('[data-rsp="true"]')
    expect(rspBox?.getAttribute('data-stack-box')).toBe('0x7ffffffddff0')
    // The emulator's label of the pushed box (it names rax), shown as it is.
    const label = machine.stack.find((slot) => slot.isRsp)?.label ?? ''
    expect(label).toMatch(/rax/)
    expect(rspBox?.textContent).toContain(label)
    // Read label first: what the box is, then its value, its address and the pointer.
    expect(
      within(rspBox as HTMLElement)
        .getByRole('button')
        .getAttribute('aria-label'),
    ).toBe(`${label}, 0x0000000000000005, changed, address 0x7ffffffddff0, rsp points here`)
    expect(screen.getByText('High addresses at the top. The stack grows down.')).toBeDefined()
  })

  it('shows leftovers below rsp, and the bytes of a box lowest address first', () => {
    const emu = steps(emulator(MOV), 4) // after pop rbx
    const { container } = render(<StackPanel machine={emu.getSnapshot()} />)
    expect(screen.getAllByText('leftover')).toHaveLength(1)
    const leftover = container.querySelector('[data-stack-box="0x7ffffffddff0"]')
    fireEvent.click(within(leftover as HTMLElement).getByRole('button'))
    const bytes = within(leftover as HTMLElement).getAllByRole('listitem')
    expect(bytes).toHaveLength(8)
    expect(bytes[0]?.textContent).toContain('0x7ffffffddff0: 0x05')
    expect(bytes[7]?.textContent).toContain('0x7ffffffddff7: 0x00')
  })

  it('writes offsets from rbp when rbp points into the stack', () => {
    const emu = steps(example('locals'), 6)
    render(<StackPanel machine={emu.getSnapshot()} />)
    expect(screen.getByText('rbp−8')).toBeDefined()
    expect(screen.getByText('count')).toBeDefined()
  })
})

describe('FlagsPanel', () => {
  it('shows each flag as a digit and marks the changed ones', () => {
    const emu = steps(emulator('main:\n    mov eax, 1\n    sub eax, 1\n    ret\n'), 2)
    render(<FlagsPanel machine={emu.getSnapshot()} />)
    const zf = screen.getByRole('button', { name: /ZF/ })
    expect(zf.textContent).toContain('1')
    expect(zf.textContent).toContain('changed')
    expect(screen.getByRole('button', { name: /CF/ }).textContent).not.toContain('changed')
  })

  it('explains a flag on focus and on tap', () => {
    const emu = emulator(MOV)
    render(<FlagsPanel machine={emu.getSnapshot()} />)
    const zf = screen.getByRole('button', { name: /ZF/ })
    // The description is always there for screen readers.
    expect(zf.getAttribute('aria-describedby')).not.toBeNull()
    fireEvent.focus(zf)
    expect(screen.getAllByText('Zero flag. 1 when the last result was 0.').length).toBe(2)
    fireEvent.blur(zf)
    fireEvent.click(zf)
    expect(screen.getAllByText('Zero flag. 1 when the last result was 0.').length).toBe(2)
  })
})

describe('ExplanationPanel', () => {
  it('says what to do before the first step, and what runs next', () => {
    const emu = example('hello-world')
    render(<ExplanationPanel machine={emu.getSnapshot()} program={emu.program} />)
    expect(screen.getByText(BEFORE_FIRST_STEP)).toBeDefined()
    expect(screen.getByText(/Next: line 11/)).toBeDefined()
  })

  it('shows the step, its tip, and the end of the program', () => {
    const emu = steps(example('hello-world'), 6)
    const { rerender } = render(
      <ExplanationPanel machine={emu.getSnapshot()} program={emu.program} />,
    )
    const heading = screen.getByText((_, node) => node?.hasAttribute('data-step-heading') ?? false)
    expect(heading.textContent).toBe('Step 6 · ran printf (library code), called on line 15')
    expect(screen.getByText('Tip')).toBeDefined()
    steps(emu, 10)
    rerender(<ExplanationPanel machine={emu.getSnapshot()} program={emu.program} />)
    expect(screen.getByText('Press Reset to run it again.')).toBeDefined()
    expect(screen.queryByText(/^Next:/)).toBeNull()
  })

  it('shows a run-time error first, and asks to fix the code when there is no machine', () => {
    const emu = steps(emulator('main:\n    push 5\n    ret\n'), 2)
    const { container, rerender } = render(<ExplanationPanel machine={emu.getSnapshot()} />)
    const live = container.querySelector('[aria-live="polite"]')
    expect(live?.firstElementChild?.textContent).toMatch(/^Error/)
    rerender(<ExplanationPanel machine={null} />)
    expect(screen.getByText(FIX_THE_CODE)).toBeDefined()
  })
})

describe('OutputPanel', () => {
  it('says when nothing was printed, and shows what was', () => {
    const emu = example('hello-world')
    const { rerender, container } = render(
      <OutputPanel machine={emu.getSnapshot()} onSendInput={() => undefined} />,
    )
    expect(screen.getByText(NOTHING_PRINTED)).toBeDefined()
    emu.run()
    rerender(<OutputPanel machine={emu.getSnapshot()} onSendInput={() => undefined} />)
    expect(container.querySelector('pre')?.textContent).toBe('Hello World!\n')
  })

  it('asks for input with a labelled box that has the focus; Enter sends', () => {
    const emu = example('read-number')
    emu.run()
    const machine = emu.getSnapshot()
    const send = vi.fn()
    render(<OutputPanel machine={machine} onSendInput={send} />)
    // The label is the emulator's prompt, whatever its words are today.
    const prompt = machine.inputRequest?.prompt ?? ''
    expect(prompt).not.toBe('')
    const input = screen.getByLabelText(prompt)
    expect(document.activeElement).toBe(input)
    fireEvent.change(input, { target: { value: '41' } })
    fireEvent.submit(input)
    expect(send).toHaveBeenCalledWith('41')
  })
})

describe('DataPanel', () => {
  it('renders nothing without data, and shows strings with visible escapes', () => {
    const plain = emulator(MOV)
    const { container, rerender } = render(<DataPanel machine={plain.getSnapshot()} />)
    expect(container.textContent).toBe('')
    const hello = example('hello-world')
    rerender(<DataPanel machine={hello.getSnapshot()} />)
    expect(screen.getByText('message')).toBeDefined()
    expect(screen.getByText('read-only')).toBeDefined()
    expect(screen.getByText('\\n')).toBeDefined()
  })

  it('shows numbers in hex and decimal', () => {
    render(<DataPanel machine={example('array-max').getSnapshot()} />)
    expect(screen.getByText('(41)')).toBeDefined()
  })
})

describe('CodeListing', () => {
  it('numbers the lines and marks the line that runs next', () => {
    const source = exampleById('hello-world')?.source ?? ''
    const { container } = render(
      <CodeListing source={source} currentLine={12} breakpoints={[14]} />,
    )
    const lines = container.querySelectorAll('li[data-line]')
    expect(lines).toHaveLength(source.trimEnd().split('\n').length)
    const current = container.querySelector('li[aria-current="step"]')
    expect(current?.getAttribute('data-line')).toBe('12')
    expect(current?.textContent).toContain('Runs next:')
    expect(container.querySelector('li[data-line="14"]')?.textContent).toContain('Breakpoint:')
    // All of its code is in sight (jsdom draws nothing that overflows): a named group, and
    // no Tab stop.
    const listing = screen.getByRole('group', { name: 'Code' })
    expect(listing.hasAttribute('tabindex')).toBe(false)
  })

  it('is a Tab stop, with a fade, only while it hides code', async () => {
    const restore = fakeOverflow({ scrollHeight: 400, clientHeight: 180 })
    try {
      render(
        <CodeListing
          source={'main:\n    nop\n    ret\n'}
          currentLine={null}
          label="Code: Try it"
        />,
      )
      const listing = await screen.findByRole('region', { name: 'Code: Try it' })
      expect(listing.getAttribute('tabindex')).toBe('0')
      // A fade at the bottom edge: more lines below.
      expect(listing.style.maskImage).toContain('calc(100% - 1.25rem)')
      // A vertical swipe on the box can move the page: only sideways scrolling is held in.
      expect(listing.className).toContain('overscroll-x-contain')
      expect(listing.className).not.toMatch(/(^|\s)overscroll-contain/)
    } finally {
      restore()
    }
  })

  it('tags the library line with the function name', () => {
    render(
      <CodeListing
        source={'main:\n    call printf\n'}
        currentLine={null}
        libraryLine={2}
        libraryName="printf"
      />,
    )
    expect(screen.getByText('inside printf')).toBeDefined()
  })
})

describe('PanelBoundary', () => {
  function Broken({ fail }: { fail: boolean }) {
    if (fail) throw new Error('A mistake in a panel.')
    return <p>The panel works.</p>
  }

  it('shows a calm message in place of a part that crashed, and tries again on a new key', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <PanelBoundary title="Stack" resetKey={1}>
        <Broken fail />
      </PanelBoundary>,
    )
    expect(screen.getByText(CANNOT_SHOW_PART)).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Stack' })).toBeDefined()
    // The same key: still the message. A new key (the next step): the part again.
    rerender(
      <PanelBoundary title="Stack" resetKey={1}>
        <Broken fail={false} />
      </PanelBoundary>,
    )
    expect(screen.getByText(CANNOT_SHOW_PART)).toBeDefined()
    rerender(
      <PanelBoundary title="Stack" resetKey={2}>
        <Broken fail={false} />
      </PanelBoundary>,
    )
    expect(screen.getByText('The panel works.')).toBeDefined()
    expect(quiet).toHaveBeenCalled()
    quiet.mockRestore()
  })

  it('uses a light box without a heading in compact form', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <PanelBoundary title="Try it" compact>
        <Broken fail />
      </PanelBoundary>,
    )
    // A MiniStepper in a lesson has no editor and maybe no Step button: other words.
    expect(screen.getByRole('note').textContent).toBe(CANNOT_SHOW_EXAMPLE)
    expect(screen.queryByRole('heading')).toBeNull()
    quiet.mockRestore()
  })
})

describe('after a library call', () => {
  it('marks the junk registers with a word and a hatch, not as a change', () => {
    const emu = steps(example('hello-world'), 6) // printf ran
    const { container } = render(
      <RegistersPanel machine={emu.getSnapshot()} program={emu.program} />,
    )
    // rax holds printf's result: a real change.
    expect(container.querySelector('[data-register="rax"]')?.getAttribute('data-changed')).toBe(
      'true',
    )
    const rcx = container.querySelector('[data-register="rcx"]')
    expect(rcx?.getAttribute('data-junk')).toBe('true')
    expect(rcx?.getAttribute('data-changed')).toBeNull()
    expect(within(rcx as HTMLElement).getByText('junk')).toBeDefined()
    expect(
      within(rcx as HTMLElement)
        .getByRole('button')
        .getAttribute('aria-label'),
    ).toMatch(/^rcx: 0x[0-9a-f]{16}, junk from the library call$/)
  })

  it('shows the long tip once, then a one-line reminder', () => {
    const emu = steps(example('hello-world'), 6)
    const { container, rerender } = render(
      <ExplanationPanel machine={emu.getSnapshot()} program={emu.program} />,
    )
    expect(container.textContent).toContain('To keep a value')
    rerender(<ExplanationPanel machine={emu.getSnapshot()} program={emu.program} repeatedTip />)
    expect(container.textContent).not.toContain('To keep a value')
    expect(container.textContent).toContain('rcx, rdx, rsi, rdi and r8 to r11 hold junk now.')
  })
})

describe('StackPanel, more', () => {
  it('draws leftovers at full strength (readable), dashed and tagged', () => {
    const emu = steps(emulator(MOV), 4) // after pop rbx
    const { container } = render(<StackPanel machine={emu.getSnapshot()} />)
    const leftover = container.querySelector('[data-stack-box="0x7ffffffddff0"]')
    expect(leftover?.innerHTML).not.toMatch(/opacity/)
    expect(leftover?.querySelector('.border-dashed')).not.toBeNull()
    expect(
      within(leftover as HTMLElement)
        .getByRole('button')
        .getAttribute('aria-label'),
    ).toMatch(/, leftover, address 0x7ffffffddff0$/)
  })

  it('stays short however deep the stack is (sub rsp, 0x80000)', () => {
    const emu = steps(emulator('main:\n    sub rsp, 0x80000\n    push 7\n    ret\n'), 2)
    const { container } = render(<StackPanel machine={emu.getSnapshot()} />)
    const rows = container.querySelectorAll('ol > li')
    expect(emu.getSnapshot().stack.length).toBeGreaterThan(65_000)
    expect(rows.length).toBeLessThan(40)
    expect(container.querySelector('[data-rsp="true"]')?.textContent).toContain('0x7')
    expect(screen.getByText(/^65,53\d more boxes, not set yet$/)).toBeDefined()
  })

  it('does not replay the flash or the slide-in when only a breakpoint changed', () => {
    const emu = steps(emulator(MOV), 3) // push rax
    const { container, rerender } = render(<StackPanel machine={emu.getSnapshot()} />)
    const box = container.querySelector('[data-rsp="true"] .animate-slide-in')
    const value = container.querySelector('[data-rsp="true"] [data-hex]')
    expect(box).not.toBeNull()
    emu.toggleBreakpoint(5) // a new snapshot, the same step
    rerender(<StackPanel machine={emu.getSnapshot()} />)
    expect(container.querySelector('[data-rsp="true"] .animate-slide-in')).toBe(box)
    expect(container.querySelector('[data-rsp="true"] [data-hex]')).toBe(value)
  })
})

describe('FlagsPanel, embedded', () => {
  it('is a labelled strip without a card of its own', () => {
    const { container } = render(<FlagsPanel machine={emulator(MOV).getSnapshot()} embedded />)
    expect(screen.getByRole('region', { name: 'Flags' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Flags', level: 3 })).toBeDefined()
    expect(container.querySelector('[data-flags]')).not.toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(4)
  })
})

describe('OutputPanel, for screen readers', () => {
  it('reads out only the text that was just printed', () => {
    const emu = example('hello-world')
    const { container, rerender } = render(
      <OutputPanel machine={emu.getSnapshot()} onSendInput={() => undefined} />,
    )
    const live = () => container.querySelector('[aria-live="polite"]')
    expect(live()?.textContent).toBe('')
    emu.run()
    rerender(<OutputPanel machine={emu.getSnapshot()} onSendInput={() => undefined} />)
    expect(live()?.textContent).toBe('Hello World!\n')
    // The printed text itself is not in a live region (it would be read again each time).
    expect(container.querySelector('pre')?.closest('[aria-live]')).toBeNull()
  })
})

describe('ExplanationPanel, more', () => {
  it('names the problems in the plural when there are several', () => {
    render(<ExplanationPanel machine={null} errorCount={3} />)
    expect(screen.getByText(FIX_THE_PROBLEMS)).toBeDefined()
  })

  it('says where a run-time error happened, with a button that shows the line', () => {
    const emu = steps(emulator('main:\n    push 5\n    ret\n'), 2)
    const onShowLine = vi.fn()
    render(<ExplanationPanel machine={emu.getSnapshot()} onShowLine={onShowLine} />)
    fireEvent.click(screen.getByRole('button', { name: 'Line 3' }))
    expect(onShowLine).toHaveBeenCalledWith(3)
    expect(screen.getByText(/Press Back to go one step back/)).toBeDefined()
  })

  it('says which line just ran, with a button that shows it', () => {
    const emu = steps(example('hello-world'), 1)
    const onShowLine = vi.fn()
    render(<ExplanationPanel machine={emu.getSnapshot()} onShowLine={onShowLine} />)
    fireEvent.click(screen.getByRole('button', { name: 'line 11' }))
    expect(onShowLine).toHaveBeenCalledWith(11)
  })

  it('offers to undo a Reset', () => {
    const onUndoReset = vi.fn()
    render(
      <ExplanationPanel
        machine={example('hello-world').getSnapshot()}
        undoResetTo={7}
        onUndoReset={onUndoReset}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Undo: back to step 7' }))
    expect(onUndoReset).toHaveBeenCalledTimes(1)
  })

  it('explains the short form of an address once, with the full address', () => {
    const emu = steps(example('hello-world'), 1) // push rbp: rsp 0x…dff8 → 0x…dff0
    const { container } = render(<ExplanationPanel machine={emu.getSnapshot()} />)
    // (A word joiner after the … keeps the address on one line.)
    const text = container.textContent?.replaceAll('\u2060', '') ?? ''
    expect(text).toMatch(/0x…dff8 is a short way to write a long address/)
    expect(container.textContent).toContain('Here it is 0x7ffffffddff8.')
  })

  it('says in its live region that an edit started the program again', () => {
    const emu = example('hello-world')
    const { container } = render(<ExplanationPanel machine={emu.getSnapshot()} restartedByEdit />)
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain(
      'You changed the code, so the program started again from the top.',
    )
  })

  it('stays quiet for screen readers while Run plays', () => {
    const emu = steps(example('hello-world'), 1)
    const { container } = render(<ExplanationPanel machine={emu.getSnapshot()} playing />)
    expect(container.querySelector('[aria-live="off"]')).not.toBeNull()
    expect(container.querySelector('[aria-live="polite"]')).toBeNull()
  })

  it('after a scanf that could not read the input, says how to type it again', () => {
    const emu = example('read-number')
    emu.run()
    emu.provideInput('abc')
    emu.step()
    render(<ExplanationPanel machine={emu.getSnapshot()} retryInputHint="Type it again." />)
    expect(screen.getByText('Type it again.')).toBeDefined()
  })
})

describe('ExplanationPanel with the list of problems', () => {
  it('shows the list outside the live region, and says once that the code must be fixed', () => {
    const { container } = render(
      <ExplanationPanel
        machine={null}
        errorCount={2}
        problems={<p data-testid="list">Line 4: wrong.</p>}
      />,
    )
    const live = container.querySelector('[aria-live="polite"]')
    expect(live?.textContent).toBe(FIX_THE_PROBLEMS)
    expect(screen.getByTestId('list').closest('[aria-live]')).toBeNull()
  })

  it('shows warnings after the step when the program can run', () => {
    const emu = steps(example('hello-world'), 1)
    const { container } = render(
      <ExplanationPanel
        machine={emu.getSnapshot()}
        problems={<p data-testid="notes">Line 0: a note.</p>}
      />,
    )
    const notes = screen.getByTestId('notes')
    expect(notes.closest('[aria-live]')).toBeNull()
    const heading = container.querySelector('[data-step-heading]')
    expect(
      heading !== null && heading.compareDocumentPosition(notes) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

describe('what the M8 audit asked for', () => {
  it('writes long step counts with commas in the heading of a step', () => {
    const emu = steps(emulator('main:\n    jmp main\n'), 10_000)
    render(<ExplanationPanel machine={emu.getSnapshot()} />)
    const heading = screen.getByText((_, node) => node?.hasAttribute('data-step-heading') ?? false)
    expect(heading.textContent).toBe('Step 10,000 · ran line 2')
  })

  it('names the instructions that the carry and overflow flags are about', () => {
    render(<FlagsPanel machine={emulator(MOV).getSnapshot()} />)
    const cf = screen.getByRole('button', { name: /CF/ })
    fireEvent.focus(cf)
    expect(screen.getAllByText(/^Carry flag\. After add, sub or cmp: 1 when/).length).toBe(2)
    fireEvent.focus(screen.getByRole('button', { name: /OF/ }))
    expect(
      screen.getAllByText(/^Overflow flag\. After add, sub, cmp, inc or dec: 1 when/).length,
    ).toBe(2)
  })

  it('shows rip with all 16 digits, like every other register, and where it points', () => {
    const emu = steps(example('hello-world'), 1)
    const { container } = render(
      <RegistersPanel machine={emu.getSnapshot()} program={emu.program} />,
    )
    const rip = container.querySelector('[data-register="rip"]')
    expect(rip?.querySelector('[data-hex]')?.textContent).toBe('0x0000000000401127')
    // Four groups of four digits (the gaps are made by CSS).
    expect(rip?.querySelectorAll('[data-hex] > span')).toHaveLength(5)
    expect(rip?.textContent).toContain('line 12')
  })

  it('writes a data address in groups of four digits, as the stack writes addresses', () => {
    const { container } = render(<DataPanel machine={example('hello-world').getSnapshot()} />)
    const address = container.querySelector('li [data-hex]')
    expect(address?.textContent).toBe('0x402010')
    expect(address?.querySelectorAll(':scope > span')).toHaveLength(3)
  })

  it('makes a wide-screen panel that hides content a Tab stop named "(scrolls)"', async () => {
    const restore = fakeOverflow({ scrollHeight: 300, clientHeight: 120 })
    try {
      render(<DataPanel machine={example('array-max').getSnapshot()} scrollOnWide />)
      const box = await screen.findByRole('group', { name: 'Data (scrolls)' })
      expect(box.getAttribute('tabindex')).toBe('0')
    } finally {
      restore()
    }
    cleanup()
    // Nothing hidden: no Tab stop.
    render(<DataPanel machine={example('array-max').getSnapshot()} scrollOnWide />)
    expect(screen.queryByRole('group', { name: 'Data (scrolls)' })).toBeNull()
  })

  it('makes the printed text a Tab stop while it hides lines', async () => {
    const restore = fakeOverflow({ scrollHeight: 300, clientHeight: 120 })
    try {
      const emu = example('hello-world')
      emu.run()
      render(<OutputPanel machine={emu.getSnapshot()} onSendInput={() => undefined} />)
      const box = await screen.findByRole('group', { name: 'Output (scrolls)' })
      expect(box.getAttribute('tabindex')).toBe('0')
      expect(box.querySelector('[data-output]')?.textContent).toBe('Hello World!\n')
    } finally {
      restore()
    }
  })

  it('scrolls the bytes of a box that was just opened into sight, and only then', () => {
    const scroll = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scroll,
    })
    try {
      const emu = steps(emulator(MOV), 3)
      const { container, rerender } = render(<StackPanel machine={emu.getSnapshot()} />)
      const box = container.querySelector('[data-rsp="true"]') as HTMLElement
      fireEvent.click(within(box).getByRole('button'))
      expect(scroll).toHaveBeenCalledTimes(1)
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' })
      // The next step keeps it open: nothing scrolls again.
      steps(emu, 1)
      rerender(<StackPanel machine={emu.getSnapshot()} />)
      expect(scroll).toHaveBeenCalledTimes(1)
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    }
  })

  it('gives "Line N" buttons a 44 px target on touch screens without moving the text', () => {
    const emu = steps(emulator('main:\n    push 5\n    ret\n'), 2)
    render(<ExplanationPanel machine={emu.getSnapshot()} onShowLine={() => undefined} />)
    const button = screen.getByRole('button', { name: 'Line 3' })
    expect(button.className).toContain('pointer-coarse:after:-inset-y-3')
    expect(button.className).toContain('relative')
  })
})
