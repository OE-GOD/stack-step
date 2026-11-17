// @vitest-environment jsdom
/**
 * The editor as a whole, without a real browser: jsdom has no layout, so everything
 * here is about state, the elements that get created, and which callbacks are called.
 * Scrolling, sizes and real key presses are tested in e2e/editor.spec.ts.
 */
import { redo, undo } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Diagnostic } from '../../../emulator'
import {
  appendRichText,
  hideLineMessage,
  messageElement,
  showLineMessage,
  shownMessageLine,
} from './diagnosticTooltip'
import {
  createEditorView,
  goToLine,
  normalizeLineBreaks,
  plainTypedText,
  setAccessibleText,
  setBreakpointsFollow,
  smallestChange,
  syncDocument,
  syncEditor,
  syncMarkers,
} from './editorSetup'
import { lineMarksField, normalizeMarkers, type LineMarkers, type MarkerInput } from './lineMarkers'

const PROGRAM = [
  'main:',
  '    push    rbp',
  '    mov     rbp, rsp',
  '    pop     rbp',
  '    ret',
].join('\n')

const OTHER_PROGRAM = '# Another program.\n    .text\nstart:\n    nop\n'

const ERROR_MESSAGE = 'Line 3: `mvo` is not an instruction. Did you mean `mov`?'

function error(line: number, message = ERROR_MESSAGE): Diagnostic {
  return { severity: 'error', code: 'unknown-instruction', line, message }
}

function markers(input: Partial<MarkerInput> = {}): LineMarkers {
  return normalizeMarkers({
    currentLine: null,
    libraryLine: null,
    breakpoints: [],
    diagnostics: [],
    ...input,
  })
}

interface Mounted {
  view: EditorView
  host: HTMLElement
  onChange: ReturnType<typeof vi.fn<(text: string) => void>>
  onToggleBreakpoint: ReturnType<typeof vi.fn<(line: number) => void>>
  onBreakpointsChange: ReturnType<typeof vi.fn<(lines: number[]) => void>>
}

const mountedViews: EditorView[] = []

function mount(
  doc = PROGRAM,
  startMarkers: LineMarkers = markers(),
  { breakpointsFollow = false } = {},
): Mounted {
  const host = document.createElement('div')
  document.body.append(host)
  const onChange = vi.fn<(text: string) => void>()
  const onToggleBreakpoint = vi.fn<(line: number) => void>()
  const onBreakpointsChange = vi.fn<(lines: number[]) => void>()
  const view = createEditorView(host, {
    doc,
    markers: startMarkers,
    label: 'Assembly code',
    describedBy: 'hint summary',
    onChange,
    onToggleBreakpoint,
    breakpointsFollow,
    onBreakpointsChange,
  })
  mountedViews.push(view)
  return { view, host, onChange, onToggleBreakpoint, onBreakpointsChange }
}

afterEach(() => {
  for (const view of mountedViews.splice(0)) view.destroy()
  document.body.replaceChildren()
})

/** Type `text` at the cursor, the way CodeMirror reports typing. */
function type(view: EditorView, text: string): void {
  const { head } = view.state.selection.main
  view.dispatch({
    changes: { from: head, insert: text },
    selection: { anchor: head + text.length },
    userEvent: 'input.type',
  })
}

/** Put the text cursor at the start of a line, as an arrow key or a click does. */
function moveCursorToLine(view: EditorView, line: number, userEvent = 'select'): void {
  view.dispatch({ selection: { anchor: view.state.doc.line(line).from }, userEvent })
}

function pressKey(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  view.contentDOM.dispatchEvent(event)
  return event
}

/** Focus the editor and let CodeMirror notice (it looks 10 ms after the focus event). */
async function focus(view: EditorView): Promise<void> {
  view.focus()
  await new Promise((resolve) => setTimeout(resolve, 30))
}

function announced(view: EditorView): string {
  return view.dom.querySelector('.cm-announced')?.textContent ?? ''
}

function messageBox(view: EditorView): HTMLElement | null {
  return view.dom.querySelector('.cm-ss-message')
}

describe('normalizeLineBreaks', () => {
  it('turns every kind of line break into \\n', () => {
    expect(normalizeLineBreaks('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
    expect(normalizeLineBreaks('plain')).toBe('plain')
  })
})

describe('smallestChange', () => {
  const apply = (before: string, after: string): string => {
    const { from, to, insert } = smallestChange(before, after)
    return before.slice(0, from) + insert + before.slice(to)
  }

  it('finds the one part that differs', () => {
    expect(smallestChange('mov rax, 1', 'mov rbx, 1')).toEqual({ from: 5, to: 6, insert: 'b' })
    expect(smallestChange('abc', 'abXYc')).toEqual({ from: 2, to: 2, insert: 'XY' })
    expect(smallestChange('abXYc', 'abc')).toEqual({ from: 2, to: 4, insert: '' })
  })

  it('handles text added or removed at an end', () => {
    expect(smallestChange('ret', '# top\nret')).toEqual({ from: 0, to: 0, insert: '# top\n' })
    expect(smallestChange('ret', 'ret\nnop')).toEqual({ from: 3, to: 3, insert: '\nnop' })
    expect(smallestChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' })
    expect(smallestChange('old', '')).toEqual({ from: 0, to: 3, insert: '' })
  })

  it('never lets the shared start and the shared end overlap', () => {
    expect(smallestChange('aaa', 'aaaa')).toEqual({ from: 3, to: 3, insert: 'a' })
    expect(smallestChange('aaaa', 'aa')).toEqual({ from: 2, to: 4, insert: '' })
    expect(smallestChange('abab', 'ab')).toEqual({ from: 2, to: 4, insert: '' })
  })

  it('always leads from the old text to the new one', () => {
    const texts = ['', 'a', 'ab', 'ba', 'aaa', 'abcabc', PROGRAM, OTHER_PROGRAM, `${PROGRAM}\n`]
    for (const before of texts) {
      for (const after of texts) expect(apply(before, after)).toBe(after)
    }
  })

  it('changes nothing when the texts are equal', () => {
    expect(smallestChange('same', 'same')).toEqual({ from: 4, to: 4, insert: '' })
  })
})

describe('createEditorView', () => {
  it('shows the program in one editor with line numbers', () => {
    const { view, host } = mount()
    expect(host.querySelectorAll('.cm-editor')).toHaveLength(1)
    expect(view.state.doc.toString()).toBe(PROGRAM)
    const numbers = [...host.querySelectorAll('.cm-lineNumbers .cm-gutterElement')]
      .map((element) => element.textContent)
      .slice(1) // The first one is CodeMirror's hidden spacer.
    expect(numbers).toEqual(['1', '2', '3', '4', '5'])
  })

  it('makes the text area a named, described, multi-line text box without spell-check', () => {
    const { view } = mount()
    const content = view.contentDOM
    expect(content.getAttribute('role')).toBe('textbox')
    expect(content.getAttribute('aria-multiline')).toBe('true')
    expect(content.getAttribute('aria-label')).toBe('Assembly code')
    expect(content.getAttribute('aria-describedby')).toBe('hint summary')
    expect(content.getAttribute('contenteditable')).toBe('true')
    expect(content.getAttribute('spellcheck')).toBe('false')
    expect(content.getAttribute('autocorrect')).toBe('off')
    expect(content.getAttribute('autocapitalize')).toBe('off')
  })

  it('can be given another name and description later', () => {
    const { view } = mount()
    setAccessibleText(view, { label: 'Your program', describedBy: 'other' })
    expect(view.contentDOM.getAttribute('aria-label')).toBe('Your program')
    expect(view.contentDOM.getAttribute('aria-describedby')).toBe('other')
  })

  it('colors the code with the token classes', () => {
    const { host } = mount()
    expect(host.querySelector('.cm-asm-label')?.textContent).toBe('main')
    expect(host.querySelector('.cm-asm-mnemonic')?.textContent).toBe('push')
    expect(host.querySelector('.cm-asm-register')?.textContent).toBe('rbp')
  })

  it('starts with the marks it is given', () => {
    const start = markers({ currentLine: 2, breakpoints: [4], diagnostics: [error(3)] })
    const { view, host } = mount(PROGRAM, start)
    expect(view.state.field(lineMarksField).markers).toBe(start)
    expect(host.querySelector('[aria-label="Line 2 runs next"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Breakpoint on line 4"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="Error on line 3"]')?.textContent).toBe('!')
    expect(host.querySelector('.cm-ss-line-current')?.textContent).toBe('    push    rbp')
    expect(host.querySelector('.cm-ss-underline-error')?.textContent).toBe('mov     rbp, rsp')
  })

  it('removes everything when it is destroyed', () => {
    const { view, host } = mount()
    view.destroy()
    expect(host.childElementCount).toBe(0)
  })
})

describe('onChange', () => {
  it('gets the whole text after every edit of the student', () => {
    const { view, onChange } = mount()
    type(view, '# ')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith(`# ${PROGRAM}`)
    type(view, 'x')
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith(`# x${PROGRAM}`)
  })

  it('is not called when only the cursor moves or the marks change', () => {
    const { view, onChange } = mount()
    moveCursorToLine(view, 3)
    syncMarkers(view, markers({ currentLine: 2 }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('syncDocument', () => {
  it('does nothing when the page passes the text the editor already shows', () => {
    const { view, onChange } = mount()
    const before = view.state
    expect(syncDocument(view, PROGRAM)).toBe('same')
    expect(view.state).toBe(before)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('takes a text with Windows line breaks as the same text', () => {
    const { view } = mount()
    const before = view.state
    expect(syncDocument(view, PROGRAM.replaceAll('\n', '\r\n'))).toBe('same')
    expect(view.state).toBe(before)
  })

  it('applies a small change from outside and keeps the cursor on its text', () => {
    const { view, onChange } = mount()
    moveCursorToLine(view, 4)
    expect(syncDocument(view, `# A line from outside.\n${PROGRAM}`)).toBe('edited')
    expect(view.state.doc.toString()).toBe(`# A line from outside.\n${PROGRAM}`)
    // The cursor was at the start of "    pop     rbp"; it still is, one line lower.
    const cursor = view.state.selection.main.head
    expect(view.state.doc.lineAt(cursor).text).toBe('    pop     rbp')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('goes back to the start for another program', () => {
    const { view, onChange } = mount()
    moveCursorToLine(view, 4)
    expect(syncDocument(view, OTHER_PROGRAM)).toBe('replaced')
    expect(view.state.doc.toString()).toBe(OTHER_PROGRAM)
    expect(view.state.selection.main.head).toBe(0)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('can empty the editor and fill it again', () => {
    const { view } = mount()
    expect(syncDocument(view, '')).toBe('replaced')
    expect(view.state.doc.length).toBe(0)
    expect(syncDocument(view, PROGRAM)).toBe('edited')
    expect(view.state.doc.toString()).toBe(PROGRAM)
  })

  it('never undoes typing when a page that is one step behind passes the old text again', () => {
    const { view, onChange } = mount()
    type(view, 'x')
    expect(onChange).toHaveBeenLastCalledWith(`x${PROGRAM}`)
    // The page rendered again (a mark changed) before it took the new text over.
    expect(syncDocument(view, PROGRAM)).toBe('same')
    expect(view.state.doc.toString()).toBe(`x${PROGRAM}`)
    // Then the page catches up.
    expect(syncDocument(view, `x${PROGRAM}`)).toBe('same')
    // And a real change from the page still goes through.
    expect(syncDocument(view, PROGRAM)).toBe('edited')
    expect(view.state.doc.toString()).toBe(PROGRAM)
  })

  it('makes a change from outside one step of Undo, and Undo tells the page', () => {
    const { view, onChange } = mount()
    type(view, '# mine\n')
    const mine = view.state.doc.toString()
    onChange.mockClear()

    syncDocument(view, OTHER_PROGRAM)
    type(view, 'y')
    expect(onChange).toHaveBeenCalledTimes(1)

    // First Undo: only the typed letter. Second Undo: the whole example goes away.
    undo(view)
    expect(view.state.doc.toString()).toBe(OTHER_PROGRAM)
    undo(view)
    expect(view.state.doc.toString()).toBe(mine)
    expect(onChange).toHaveBeenLastCalledWith(mine)

    redo(view)
    expect(view.state.doc.toString()).toBe(OTHER_PROGRAM)
    expect(onChange).toHaveBeenLastCalledWith(OTHER_PROGRAM)
  })
})

describe('syncMarkers', () => {
  it('gives the editor the marks and tells whether the line to look at changed', () => {
    const { view, host } = mount()
    expect(syncMarkers(view, markers({ currentLine: 2 }))).toBe(true)
    expect(host.querySelector('[aria-label="Line 2 runs next"]')).not.toBeNull()

    expect(syncMarkers(view, markers({ currentLine: 2, breakpoints: [4] }))).toBe(false)
    expect(host.querySelector('[aria-label="Breakpoint on line 4"]')).not.toBeNull()

    expect(syncMarkers(view, markers({ currentLine: 3, breakpoints: [4] }))).toBe(true)
    expect(host.querySelector('[aria-label="Line 2 runs next"]')).toBeNull()
    expect(host.querySelector('[aria-label="Line 3 runs next"]')).not.toBeNull()

    // From "runs next" to "inside the library" on the same line: the same line, but the
    // tag can make it taller (a row of its own, or a wrap), so it is shown again.
    expect(syncMarkers(view, markers({ libraryLine: 3, breakpoints: [4] }))).toBe(true)
    expect(
      host.querySelector('[aria-label="Line 3: the program is inside the library"]'),
    ).not.toBeNull()
    expect(host.querySelector('.cm-ss-library-tag')?.textContent).toBe('inside the library')

    expect(syncMarkers(view, markers())).toBe(true)
    expect(host.querySelector('.cm-ss-marks-row')).toBeNull()
  })

  it('does nothing when the page passes equal marks in new arrays', () => {
    const { view } = mount(PROGRAM, markers({ currentLine: 2, breakpoints: [4] }))
    const before = view.state
    expect(syncMarkers(view, markers({ currentLine: 2, breakpoints: [4] }))).toBe(false)
    expect(view.state).toBe(before)
  })

  it('marks nothing for a diagnostic about the whole program', () => {
    const { view, host } = mount()
    syncMarkers(
      view,
      markers({
        diagnostics: [
          {
            severity: 'warning',
            code: 'no-main',
            line: 0,
            message: 'The program has no `main` label.',
          },
        ],
      }),
    )
    expect(host.querySelector('.cm-ss-diagnostic')).toBeNull()
    expect(host.querySelector('.cm-ss-underline')).toBeNull()
  })

  it('reads out a breakpoint that was switched while the editor has the focus', async () => {
    const { view } = mount()
    await focus(view)
    syncMarkers(view, markers({ breakpoints: [3] }))
    expect(announced(view)).toBe('Breakpoint added on line 3.')
    syncMarkers(view, markers({ breakpoints: [] }))
    expect(announced(view)).toBe('Breakpoint removed from line 3.')
  })

  it('stays silent about breakpoints when the focus is somewhere else', () => {
    const { view } = mount()
    syncMarkers(view, markers({ breakpoints: [3] }))
    expect(announced(view)).toBe('')
  })
})

describe('syncEditor', () => {
  it('brings the text and the marks in step in one call', () => {
    const { view, onChange } = mount()
    syncEditor(view, OTHER_PROGRAM, markers({ currentLine: 4, breakpoints: [3] }))
    expect(view.state.doc.toString()).toBe(OTHER_PROGRAM)
    expect(view.state.field(lineMarksField).markers).toMatchObject({
      currentLine: 4,
      breakpoints: [3],
    })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('the library line', () => {
  it('names the function that runs, in the tag and in the label of the mark', () => {
    const { view, host } = mount()
    syncMarkers(view, markers({ libraryLine: 3, libraryName: 'printf' }))
    expect(host.querySelector('.cm-ss-library-tag')?.textContent).toBe('inside printf')
    expect(host.querySelector('[aria-label="Line 3: the program is inside printf"]')).not.toBeNull()

    // Another function on the same line: the tag says so.
    syncMarkers(view, markers({ libraryLine: 3, libraryName: 'scanf' }))
    expect(host.querySelector('.cm-ss-library-tag')?.textContent).toBe('inside scanf')
  })
})

describe('breakpoints that follow their line', () => {
  /** Put the cursor at the end of `line` and press Enter, as the student does. */
  function newLineAfter(view: EditorView, line: number): void {
    const at = view.state.doc.line(line).to
    view.dispatch({
      changes: { from: at, insert: '\n    nop' },
      selection: { anchor: at + 8 },
      userEvent: 'input.type',
    })
  }

  it('tell the page the new lines after onChange, when a line is added above them', () => {
    const { view, onChange, onBreakpointsChange } = mount(
      PROGRAM,
      markers({ breakpoints: [3, 5] }),
      { breakpointsFollow: true },
    )
    const order: string[] = []
    onChange.mockImplementation(() => order.push('change'))
    onBreakpointsChange.mockImplementation(() => order.push('breakpoints'))
    newLineAfter(view, 1)
    expect(onBreakpointsChange).toHaveBeenCalledWith([4, 6])
    expect(order).toEqual(['change', 'breakpoints'])
    // The page passes the new list back: nothing moves again.
    syncMarkers(view, markers({ breakpoints: [4, 6] }))
    expect(view.state.field(lineMarksField).markers.breakpoints).toEqual([4, 6])
  })

  it('stay silent when an edit moves no breakpoint', () => {
    const { view, onChange, onBreakpointsChange } = mount(PROGRAM, markers({ breakpoints: [2] }), {
      breakpointsFollow: true,
    })
    newLineAfter(view, 4)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onBreakpointsChange).not.toHaveBeenCalled()
  })

  it('keep their numbers for a new text from the page', () => {
    const { view, onBreakpointsChange } = mount(PROGRAM, markers({ breakpoints: [3] }), {
      breakpointsFollow: true,
    })
    syncDocument(view, `# a note on top\n${PROGRAM}`)
    expect(view.state.field(lineMarksField).markers.breakpoints).toEqual([3])
    expect(onBreakpointsChange).not.toHaveBeenCalled()
  })

  it('keep their numbers while following is off, and can be switched on later', () => {
    const { view, onBreakpointsChange } = mount(PROGRAM, markers({ breakpoints: [3] }))
    newLineAfter(view, 1)
    expect(view.state.field(lineMarksField).markers.breakpoints).toEqual([3])
    expect(onBreakpointsChange).not.toHaveBeenCalled()

    setBreakpointsFollow(view, true)
    newLineAfter(view, 1)
    expect(onBreakpointsChange).toHaveBeenCalledWith([4])
  })
})

describe('goToLine', () => {
  it('puts the cursor at the start of the code of the line and focuses the editor', async () => {
    const { view } = mount()
    goToLine(view, 3)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const { head } = view.state.selection.main
    expect(head).toBe(view.state.doc.line(3).from + 4)
    expect(view.hasFocus).toBe(true)
  })

  it('ignores lines that do not exist', () => {
    const { view } = mount()
    const before = view.state
    goToLine(view, 0)
    goToLine(view, 99)
    expect(view.state).toBe(before)
  })
})

describe('characters that look like others', () => {
  it('draws a no-break space as a visible dot with a label', () => {
    const { host } = mount('main:\n    mov\u00a0rax, 5\n    ret')
    const mark = host.querySelector('.cm-ss-odd-space')
    expect(mark?.textContent).toBe('\u00b7')
    expect(mark?.getAttribute('aria-label')).toMatch(/^Special space \(U\+00A0\)/)
  })

  it('turns typed curly quotes and no-break spaces into plain ones', () => {
    expect(plainTypedText('\u201cHi\u201d')).toBe('"Hi"')
    expect(plainTypedText('\u2018A\u2019')).toBe("'A'")
    expect(plainTypedText('mov\u00a0rax')).toBe('mov rax')
    expect(plainTypedText('plain text')).toBe('plain text')
  })
})

describe('the gutter', () => {
  // jsdom has no layout: every row sits at the top of the page, so a click 10 px down is
  // always on line 1. Clicks on other lines are tested in the browser (e2e).
  const clickAt = (button: number, clientY: number) =>
    new MouseEvent('click', { bubbles: true, cancelable: true, button, clientY })

  it('switches the breakpoint of the row that is clicked, in both columns', () => {
    const { host, onToggleBreakpoint } = mount()
    const row = host.querySelector('.cm-ss-marks .cm-gutterElement')
    row?.dispatchEvent(clickAt(0, 10))
    expect(onToggleBreakpoint).toHaveBeenCalledExactlyOnceWith(1)

    const number = host.querySelectorAll('.cm-lineNumbers .cm-gutterElement')[1]
    number?.dispatchEvent(clickAt(0, 10))
    expect(onToggleBreakpoint).toHaveBeenCalledTimes(2)
    expect(onToggleBreakpoint).toHaveBeenLastCalledWith(1)
  })

  it('ignores the other mouse buttons and clicks that are not on a line', () => {
    const { host, onToggleBreakpoint } = mount()
    const row = host.querySelector('.cm-ss-marks .cm-gutterElement')
    row?.dispatchEvent(clickAt(2, 10))
    // Far below the last line of the program.
    host.querySelector('.cm-ss-marks')?.dispatchEvent(clickAt(0, 5000))
    expect(onToggleBreakpoint).not.toHaveBeenCalled()
  })

  it('keeps the keyboard focus where it is when a row is pressed', () => {
    const { host } = mount()
    const row = host.querySelector('.cm-ss-marks .cm-gutterElement')
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    row?.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
  })

  it('shows the message, and sets no breakpoint, when the ! mark is clicked', () => {
    const { view, host, onToggleBreakpoint } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    const mark = host.querySelector('[aria-label="Error on line 3"]')
    mark?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(onToggleBreakpoint).not.toHaveBeenCalled()
    expect(shownMessageLine(view.state)).toBe(3)
  })

  it('shows the message while the pointer is on the ! mark', () => {
    const { view, host } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    const mark = host.querySelector('[aria-label="Error on line 3"]')
    mark?.dispatchEvent(new MouseEvent('mouseenter'))
    expect(shownMessageLine(view.state)).toBe(3)
    expect(messageBox(view)?.textContent).toContain('mvo is not an instruction')
    mark?.dispatchEvent(new MouseEvent('mouseleave'))
    expect(shownMessageLine(view.state)).toBeNull()
  })
})

describe('keys', () => {
  it('switches the breakpoint of the cursor line with Ctrl+B', () => {
    const { view, onToggleBreakpoint } = mount()
    moveCursorToLine(view, 4)
    const event = pressKey(view, { key: 'b', ctrlKey: true })
    expect(onToggleBreakpoint).toHaveBeenCalledExactlyOnceWith(4)
    expect(event.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe(PROGRAM)
  })

  it("does nothing with the page's keys, but stops the browser's own line break", () => {
    const { view, onChange } = mount()
    const heard: string[] = []
    const listen = (event: KeyboardEvent) => heard.push(event.key)
    document.addEventListener('keydown', listen)

    const combos: KeyboardEventInit[] = [
      { ctrlKey: true },
      { metaKey: true },
      { ctrlKey: true, shiftKey: true },
      { metaKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
      { metaKey: true, altKey: true },
    ]
    for (const combo of combos) {
      const event = pressKey(view, { key: 'Enter', ...combo })
      expect(event.defaultPrevented, JSON.stringify(combo)).toBe(true)
    }
    document.removeEventListener('keydown', listen)

    expect(view.state.doc.toString()).toBe(PROGRAM)
    expect(onChange).not.toHaveBeenCalled()
    // The page (which listens on the document) heard all six.
    expect(heard).toHaveLength(combos.length)
  })

  it('leaves a key alone that the page has already handled', () => {
    const { view } = mount()
    const handle = (event: KeyboardEvent) => event.preventDefault()
    window.addEventListener('keydown', handle, { capture: true })
    // A plain Enter would add a line. The page took it first, so nothing happens.
    pressKey(view, { key: 'Enter' })
    window.removeEventListener('keydown', handle, { capture: true })
    expect(view.state.doc.toString()).toBe(PROGRAM)
  })

  it('adds a line that keeps the indentation with Enter', () => {
    const { view, onChange } = mount()
    view.dispatch({ selection: { anchor: view.state.doc.line(2).to } })
    pressKey(view, { key: 'Enter' })
    expect(view.state.doc.line(3).text).toBe('    ')
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('indents with Tab and takes the indentation away with Shift+Tab', () => {
    const { view } = mount('ret')
    pressKey(view, { key: 'Tab' })
    expect(view.state.doc.toString()).toBe('    ret')
    pressKey(view, { key: 'Tab', shiftKey: true })
    expect(view.state.doc.toString()).toBe('ret')
  })
})

describe('the message box', () => {
  it('writes each message with a word for its kind and code in <code>', () => {
    const [diagnostics] = markers({
      diagnostics: [
        error(3),
        { severity: 'warning', code: 'unknown-directive', line: 3, message: 'Line 3: odd.' },
      ],
    }).diagnostics
    if (diagnostics === undefined) throw new Error('No diagnostics.')
    const box = messageElement(diagnostics)
    const rows = [...box.querySelectorAll('.cm-ss-message-row')]
    expect(rows.map((row) => row.querySelector('.cm-ss-message-kind')?.textContent)).toEqual([
      'Error',
      'Warning',
    ])
    expect(rows[0]?.textContent).toBe(
      '! Error Line 3: mvo is not an instruction. Did you mean mov?',
    )
    expect([...(rows[0]?.querySelectorAll('code') ?? [])].map((code) => code.textContent)).toEqual([
      'mvo',
      'mov',
    ])
  })

  it('shows text as text, never as HTML', () => {
    const paragraph = document.createElement('p')
    appendRichText(paragraph, 'Use `<b>` & `mov`, not <i>this</i>.')
    expect(paragraph.querySelector('b, i')).toBeNull()
    expect(paragraph.textContent).toBe('Use <b> & mov, not <i>this</i>.')
    expect(paragraph.querySelectorAll('code')).toHaveLength(2)
  })

  it('shows a backtick without a partner as it is (the rule of <RichText>)', () => {
    const paragraph = document.createElement('p')
    appendRichText(paragraph, 'Type `mov` or a single ` here.')
    expect(paragraph.textContent).toBe('Type mov or a single ` here.')
    expect([...paragraph.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['mov'])

    const other = document.createElement('p')
    appendRichText(other, 'Only one ` in this text.')
    expect(other.textContent).toBe('Only one ` in this text.')
    expect(other.querySelector('code')).toBeNull()
  })

  it('opens for a line with a message and not for other lines', () => {
    const { view } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    expect(showLineMessage(view, 2, 'cursor')).toBe(false)
    expect(shownMessageLine(view.state)).toBeNull()
    expect(showLineMessage(view, 3, 'cursor')).toBe(true)
    expect(shownMessageLine(view.state)).toBe(3)
    expect(messageBox(view)?.textContent).toContain('Did you mean mov?')
    hideLineMessage(view)
    expect(shownMessageLine(view.state)).toBeNull()
    expect(messageBox(view)).toBeNull()
  })

  it('closes when the student types', () => {
    const { view } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    moveCursorToLine(view, 3)
    showLineMessage(view, 3, 'cursor')
    type(view, 'x')
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('stays while the cursor moves inside the line and closes when it leaves', () => {
    const { view } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    moveCursorToLine(view, 3)
    showLineMessage(view, 3, 'cursor')
    view.dispatch({ selection: { anchor: view.state.doc.line(3).to }, userEvent: 'select' })
    expect(shownMessageLine(view.state)).toBe(3)
    moveCursorToLine(view, 4)
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('closes when the cursor is put anywhere after the pointer opened it', () => {
    const { view } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    showLineMessage(view, 3, 'pointer')
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from + 1 } })
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('closes when the marks change after the pointer opened it', () => {
    const { view } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    showLineMessage(view, 3, 'pointer')
    // The same marks again change nothing; the box stays.
    syncMarkers(view, markers({ diagnostics: [error(3)] }))
    expect(shownMessageLine(view.state)).toBe(3)
    // The line that runs next moves onto the line: its mark is drawn again.
    syncMarkers(view, markers({ currentLine: 3, diagnostics: [error(3)] }))
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('closes when the page passes other diagnostics, and stays for equal ones', () => {
    const { view } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    showLineMessage(view, 3, 'cursor')
    syncMarkers(view, markers({ currentLine: 2, diagnostics: [error(3)] }))
    expect(shownMessageLine(view.state)).toBe(3)
    syncMarkers(view, markers({ currentLine: 2, diagnostics: [error(3, 'Line 3: other.')] }))
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('closes on Escape', () => {
    const { view } = mount(PROGRAM, markers({ diagnostics: [error(3)] }))
    showLineMessage(view, 3, 'cursor')
    const event = pressKey(view, { key: 'Escape' })
    expect(shownMessageLine(view.state)).toBeNull()
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('when the text cursor arrives on a marked line', () => {
  const start = markers({ currentLine: 2, breakpoints: [2, 4], diagnostics: [error(3)] })

  it('reads out the marks of the line', async () => {
    const { view } = mount(PROGRAM, start)
    await focus(view)
    moveCursorToLine(view, 2)
    expect(announced(view)).toBe('Breakpoint. This line runs next.')
    moveCursorToLine(view, 4, 'select.pointer')
    expect(announced(view)).toBe('Breakpoint.')
  })

  it('reads out the message of the line and shows it', async () => {
    const { view } = mount(PROGRAM, start)
    await focus(view)
    moveCursorToLine(view, 3)
    expect(announced(view)).toBe('Line 3: mvo is not an instruction. Did you mean mov?')
    expect(shownMessageLine(view.state)).toBe(3)
  })

  it('reads out the line the cursor is on when the editor gets the focus', async () => {
    const { view } = mount(PROGRAM, markers({ breakpoints: [1] }))
    await focus(view)
    expect(announced(view)).toBe('Breakpoint.')
  })

  it('stays silent on a line without marks', async () => {
    const { view } = mount(PROGRAM, start)
    await focus(view)
    moveCursorToLine(view, 5)
    expect(announced(view)).toBe('')
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('stays silent while the student types, also when typing moves the cursor', async () => {
    const { view } = mount(PROGRAM, start)
    await focus(view)
    view.dispatch({ selection: { anchor: view.state.doc.line(1).to } })
    // A new line after line 1: the cursor is now on (new) line 2, which has marks.
    type(view, '\n')
    expect(announced(view)).toBe('')
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('stays silent when the page moves the cursor', async () => {
    const { view } = mount(PROGRAM, start)
    await focus(view)
    view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
    expect(announced(view)).toBe('')
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('stays silent when the editor does not have the focus', () => {
    const { view } = mount(PROGRAM, start)
    moveCursorToLine(view, 3)
    expect(announced(view)).toBe('')
    expect(shownMessageLine(view.state)).toBeNull()
  })

  it('closes the message when the editor loses the focus', async () => {
    const { view } = mount(PROGRAM, start)
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    await focus(view)
    moveCursorToLine(view, 3)
    expect(shownMessageLine(view.state)).toBe(3)
    elsewhere.focus()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(shownMessageLine(view.state)).toBeNull()
  })
})

describe('several lines that arrive as typing', () => {
  it('go in the way a paste does: at once, unchanged, and onChange hears it', () => {
    const { view, onChange } = mount('main:\n    ret\n')
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    const text = '    .string “Hi”\r\nmain:\n    nop\n'
    const input = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: text,
      cancelable: true,
      bubbles: true,
    })
    view.contentDOM.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(true)
    // The curly quotes stay (as in a paste); the line break becomes \n.
    expect(view.state.doc.toString()).toBe('    .string “Hi”\nmain:\n    nop\n')
    expect(onChange).toHaveBeenLastCalledWith('    .string “Hi”\nmain:\n    nop\n')
  })

  it('leave one line of typing to the usual way', () => {
    const { view } = mount('main:\n')
    const input = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'nop',
      cancelable: true,
      bubbles: true,
    })
    view.contentDOM.dispatchEvent(input)
    expect(input.defaultPrevented).toBe(false)
  })
})

describe('the text area for checkers', () => {
  it('says that it is a Tab stop (a contenteditable is one anyway)', () => {
    const { view } = mount()
    expect(view.contentDOM.getAttribute('tabindex')).toBe('0')
  })
})
