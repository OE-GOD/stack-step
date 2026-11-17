// @vitest-environment jsdom
/**
 * The React side of the editor: one CodeMirror editor that survives StrictMode, follows
 * the props, and calls the newest callbacks. (Real typing, scrolling and focus are tested
 * in a real browser: e2e/editor.spec.ts.)
 */
import { EditorView } from '@codemirror/view'
import { act, cleanup, render, screen } from '@testing-library/react'
import { createRef, StrictMode, useState, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Diagnostic } from '../../../emulator'
import CodeEditor from './CodeEditor'
import { lineMarksField } from './lineMarkers'
import type { CodeEditorHandle, CodeEditorProps } from './types'

afterEach(cleanup)

const PROGRAM = 'main:\n    push    rbp\n    mov     rbp, rsp\n    pop     rbp\n    ret\n'
const OTHER_PROGRAM = '# Another program.\nstart:\n    nop\n'

function props(overrides: Partial<CodeEditorProps> = {}): CodeEditorProps {
  return {
    value: PROGRAM,
    onChange: () => {},
    currentLine: null,
    libraryLine: null,
    breakpoints: [],
    onToggleBreakpoint: () => {},
    diagnostics: [],
    ariaLabel: 'Assembly code',
    ...overrides,
  }
}

function strict(node: ReactNode): ReactNode {
  return <StrictMode>{node}</StrictMode>
}

/** The CodeMirror editor that the component created. */
function editorIn(container: HTMLElement): EditorView {
  const element = container.querySelector<HTMLElement>('.cm-editor')
  const view = element === null ? null : EditorView.findFromDOM(element)
  if (view === null) throw new Error('No editor on the page.')
  return view
}

function typeAtStart(view: EditorView, text: string): void {
  act(() => {
    view.dispatch({ changes: { from: 0, insert: text }, userEvent: 'input.type' })
  })
}

/** A page that owns the text, as the stepper page does. */
function ControlledPage({ onText }: { onText: (text: string) => void }): ReactNode {
  const [value, setValue] = useState(PROGRAM)
  return (
    <>
      <button type="button" onClick={() => setValue(OTHER_PROGRAM)}>
        Load example
      </button>
      <CodeEditor
        {...props({
          value,
          onChange: (text) => {
            onText(text)
            setValue(text)
          },
        })}
      />
    </>
  )
}

describe('CodeEditor', () => {
  it('creates exactly one editor, also under StrictMode', () => {
    const { container } = render(strict(<CodeEditor {...props()} />))
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(1)
    expect(editorIn(container).state.doc.toString()).toBe(PROGRAM)
  })

  it('is a text box with the given name and a description', () => {
    render(strict(<CodeEditor {...props({ currentLine: 2, breakpoints: [4] })} />))
    const textbox = screen.getByRole('textbox', { name: 'Assembly code' })
    expect(textbox.getAttribute('aria-multiline')).toBe('true')

    const description = (textbox.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? `(no element ${id})`)
    expect(description).toEqual([
      'Press Escape, then Tab, to leave the editor.',
      'Line 2 runs next. Breakpoint on line 4.',
    ])
  })

  it('follows a new name', () => {
    const { rerender } = render(strict(<CodeEditor {...props()} />))
    rerender(strict(<CodeEditor {...props({ ariaLabel: 'Your program' })} />))
    expect(screen.getByRole('textbox', { name: 'Your program' })).toBeTruthy()
  })

  it('puts the extra classes on the outer element', () => {
    const { container } = render(
      strict(<CodeEditor {...props({ className: 'h-80 rounded-lg' })} />),
    )
    const outer = container.firstElementChild
    expect(outer?.classList.contains('h-80')).toBe(true)
    expect(outer?.classList.contains('rounded-lg')).toBe(true)
    expect(outer?.querySelector('.cm-editor')).not.toBeNull()
  })

  it('keeps the same editor when props change', () => {
    const { container, rerender } = render(strict(<CodeEditor {...props()} />))
    const view = editorIn(container)
    rerender(strict(<CodeEditor {...props({ value: OTHER_PROGRAM, currentLine: 3 })} />))
    expect(editorIn(container)).toBe(view)
    expect(container.querySelectorAll('.cm-editor')).toHaveLength(1)
  })

  it('shows a new value from the page without calling onChange', () => {
    const onChange = vi.fn<(text: string) => void>()
    const { container, rerender } = render(strict(<CodeEditor {...props({ onChange })} />))
    rerender(strict(<CodeEditor {...props({ onChange, value: OTHER_PROGRAM })} />))
    expect(editorIn(container).state.doc.toString()).toBe(OTHER_PROGRAM)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('calls onChange once per edit and does nothing when the page passes the text back', () => {
    const onText = vi.fn<(text: string) => void>()
    const { container } = render(strict(<ControlledPage onText={onText} />))
    const view = editorIn(container)
    const dispatch = vi.spyOn(view, 'dispatch')

    typeAtStart(view, '# ')
    expect(onText).toHaveBeenCalledExactlyOnceWith(`# ${PROGRAM}`)
    typeAtStart(view, 'x')
    expect(onText).toHaveBeenCalledTimes(2)
    expect(onText).toHaveBeenLastCalledWith(`x# ${PROGRAM}`)
    expect(view.state.doc.toString()).toBe(`x# ${PROGRAM}`)
    // Two edits, two transactions: the page rendered with the new text both times, and
    // the editor did not answer that with a change of its own.
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('does not call onChange in a loop when the page loads another program', () => {
    const onText = vi.fn<(text: string) => void>()
    const { container } = render(strict(<ControlledPage onText={onText} />))
    act(() => screen.getByRole('button', { name: 'Load example' }).click())
    expect(editorIn(container).state.doc.toString()).toBe(OTHER_PROGRAM)
    expect(onText).not.toHaveBeenCalled()
  })

  it('always calls the newest callbacks', () => {
    const first = vi.fn<(text: string) => void>()
    const second = vi.fn<(text: string) => void>()
    const firstToggle = vi.fn<(line: number) => void>()
    const secondToggle = vi.fn<(line: number) => void>()
    const { container, rerender } = render(
      strict(<CodeEditor {...props({ onChange: first, onToggleBreakpoint: firstToggle })} />),
    )
    rerender(
      strict(<CodeEditor {...props({ onChange: second, onToggleBreakpoint: secondToggle })} />),
    )
    const view = editorIn(container)

    typeAtStart(view, 'x')
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledExactlyOnceWith(`x${PROGRAM}`)

    act(() => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }),
      )
    })
    expect(firstToggle).not.toHaveBeenCalled()
    expect(secondToggle).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('draws the marks that the page passes and takes them away again', () => {
    const diagnostics: Diagnostic[] = [
      { severity: 'error', code: 'bad-operand', line: 3, message: 'Line 3: this is wrong.' },
    ]
    const { container, rerender } = render(strict(<CodeEditor {...props()} />))
    expect(container.querySelector('.cm-ss-marks-row')).toBeNull()

    rerender(
      strict(<CodeEditor {...props({ currentLine: 2, breakpoints: [2, 4], diagnostics })} />),
    )
    expect(container.querySelector('[aria-label="Line 2 runs next"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Breakpoint on line 2"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Breakpoint on line 4"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Error on line 3"]')).not.toBeNull()
    expect(container.querySelector('.cm-ss-line-current')?.textContent).toBe('    push    rbp')

    rerender(strict(<CodeEditor {...props({ libraryLine: 4 })} />))
    expect(container.querySelector('[aria-label="Line 2 runs next"]')).toBeNull()
    // Lines scroll sideways: the tag has a row of its own under the call line, where it
    // can never cover code.
    expect(container.querySelector('.cm-ss-line-library')?.textContent).toBe('    pop     rbp')
    expect(container.querySelector('.cm-ss-library-row')?.textContent).toBe('inside the library')

    rerender(strict(<CodeEditor {...props()} />))
    expect(container.querySelector('.cm-ss-marks-row')).toBeNull()
  })

  it('names the library function in the tag when the page gives the name', () => {
    const { container } = render(
      strict(<CodeEditor {...props({ libraryLine: 4, libraryName: 'printf' })} />),
    )
    expect(container.querySelector('.cm-ss-library-tag')?.textContent).toBe('inside printf')
  })

  it('puts the tag after the instruction, inside the line, when long lines wrap', () => {
    const program = 'main:\n    call    printf@PLT     # print the text\n    ret\n'
    const { container, rerender } = render(
      strict(
        <CodeEditor
          {...props({ value: program, libraryLine: 2, libraryName: 'printf', wrapLines: true })}
        />,
      ),
    )
    const line = container.querySelector('.cm-ss-line-library')
    expect(line?.textContent).toBe('    call    printf@PLTinside printf     # print the text')
    expect(container.querySelector('.cm-ss-library-row')).toBeNull()
    expect(editorIn(container).contentDOM.classList.contains('cm-lineWrapping')).toBe(true)
    // Back to one row per line: the tag goes under the line again.
    rerender(
      strict(
        <CodeEditor
          {...props({ value: program, libraryLine: 2, libraryName: 'printf', wrapLines: false })}
        />,
      ),
    )
    expect(container.querySelector('.cm-ss-library-row')?.textContent).toBe('inside printf')
    expect(editorIn(container).contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
  })

  it('marks the line that just ran with a hollow arrow, apart from the line that runs next', () => {
    const { container } = render(strict(<CodeEditor {...props({ currentLine: 3, lastLine: 2 })} />))
    const ran = container.querySelector('[aria-label="Line 2 just ran"]')
    expect(ran?.getAttribute('class')).toBe('cm-ss-ran')
    expect(container.querySelector('.cm-ss-line-ran')?.textContent).toBe('    push    rbp')
    expect(container.querySelector('[aria-label="Line 3 runs next"]')).not.toBeNull()
    const textbox = screen.getByRole('textbox', { name: 'Assembly code' })
    const summary = document.getElementById(
      (textbox.getAttribute('aria-describedby') ?? '').split(' ')[1] ?? '',
    )
    expect(summary?.textContent).toBe('Line 2 just ran. Line 3 runs next.')
  })

  it('marks the line where a run-time error stopped the program, with its message', () => {
    const { container } = render(
      strict(
        <CodeEditor
          {...props({ runtimeError: { line: 5, message: 'Line 5: `ret` took 0x5.' } })}
        />,
      ),
    )
    expect(container.querySelector('.cm-ss-line-stopped')?.textContent).toBe('    ret')
    expect(container.querySelector('[aria-label="Error on line 5"]')).not.toBeNull()
    const view = editorIn(container)
    expect(view.state.field(lineMarksField).byLine.get(5)?.diagnostics?.messages).toEqual([
      { severity: 'error', message: 'Line 5: `ret` took 0x5.' },
    ])
  })

  it('shows a line through its ref without taking the keyboard focus', async () => {
    // jsdom draws nothing, so the editor counts as out of sight and is scrolled to.
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const ref = createRef<CodeEditorHandle>()
    const { container } = render(strict(<CodeEditor {...props({ ref, coveredBottom: 90 })} />))
    act(() => ref.current?.showLine(4))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(editorIn(container).hasFocus).toBe(false)
    // Lines that do not exist are ignored.
    expect(() => act(() => ref.current?.showLine(99))).not.toThrow()
  })

  it('moves breakpoints with their lines and tells a page that listens', () => {
    const told = vi.fn<(lines: number[]) => void>()
    function BreakpointPage(): ReactNode {
      const [value, setValue] = useState(PROGRAM)
      const [breakpoints, setBreakpoints] = useState<readonly number[]>([3])
      return (
        <CodeEditor
          {...props({
            value,
            onChange: setValue,
            breakpoints,
            onBreakpointsChange: (lines) => {
              told(lines)
              setBreakpoints(lines)
            },
          })}
        />
      )
    }
    const { container } = render(strict(<BreakpointPage />))
    const view = editorIn(container)
    // A new line above line 3 (Enter at the end of line 1).
    act(() => {
      const at = view.state.doc.line(1).to
      view.dispatch({ changes: { from: at, insert: '\n    nop' }, userEvent: 'input.type' })
    })
    expect(told).toHaveBeenCalledExactlyOnceWith([4])
    // The page passed the new list back, and the editor kept it.
    expect(view.state.field(lineMarksField).markers.breakpoints).toEqual([4])
    expect(container.querySelector('[aria-label="Breakpoint on line 4"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Breakpoint on line 3"]')).toBeNull()
  })

  it('keeps breakpoints on their line numbers when the page does not listen', () => {
    const { container } = render(strict(<CodeEditor {...props({ breakpoints: [3] })} />))
    typeAtStart(editorIn(container), '\n')
    expect(container.querySelector('[aria-label="Breakpoint on line 3"]')).not.toBeNull()
  })

  it('takes the student to a line through its ref', async () => {
    const ref = createRef<CodeEditorHandle>()
    const { container } = render(strict(<CodeEditor {...props({ ref })} />))
    act(() => ref.current?.goToLine(4))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const view = editorIn(container)
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(4)
    expect(view.hasFocus).toBe(true)
  })

  it('does not rebuild anything when the page passes equal marks in new arrays', () => {
    const { container, rerender } = render(
      strict(<CodeEditor {...props({ currentLine: 2, breakpoints: [4] })} />),
    )
    const view = editorIn(container)
    const before = view.state
    rerender(strict(<CodeEditor {...props({ currentLine: 2, breakpoints: [4] })} />))
    expect(view.state).toBe(before)
  })

  it('removes the editor when it is taken off the page', () => {
    const { container, unmount } = render(strict(<CodeEditor {...props()} />))
    const view = editorIn(container)
    unmount()
    expect(document.querySelector('.cm-editor')).toBeNull()
    // A destroyed editor ignores what is sent to it.
    expect(() => view.dispatch({ changes: { from: 0, insert: 'x' } })).not.toThrow()
  })
})
