/**
 * Builds the CodeMirror editor and keeps it in step with what the page passes in.
 *
 * The React component (`CodeEditor.tsx`) creates ONE editor with `createEditorView` and
 * then calls `syncEditor` whenever a prop changes. Nothing here knows about React.
 */
import { history, isolateHistory } from '@codemirror/commands'
import { indentUnit } from '@codemirror/language'
import { Compartment, EditorState, type Extension, type StateEffect } from '@codemirror/state'
import { EditorView, highlightSpecialChars, keymap } from '@codemirror/view'
import { assembly } from './asmLanguage'
import { markerGutters } from './breakpointGutter'
import { diagnosticMessages } from './diagnosticTooltip'
import { editorKeymap } from './editorKeymap'
import {
  activeLine,
  breakpointsFollowEdits,
  diagnosticRange,
  lineMarks,
  lineMarksField,
  mergeMarkers,
  pageChange,
  setLineMarkers,
  wrapLongLines,
  type LineMarkers,
} from './lineMarkers'
import { describeBreakpointChange, oddSpaceLabel } from './markerText'
import { editorTheme } from './theme'

/** One step of indentation: the four spaces of the course's house style. */
export const INDENT = '    '

/**
 * How wide a tab CHARACTER is drawn. The Tab key never types one, but code copied from
 * `gcc -S` is full of them, and it only lines up with tab stops every 8 columns.
 */
export const TAB_WIDTH = 8

/** The name and the description of the text area, for screen readers. */
export interface AccessibleText {
  /** The accessible name, e.g. "Assembly code". */
  label: string
  /** Ids (separated by spaces) of the elements that describe the text area. */
  describedBy: string
}

export interface EditorConfig extends AccessibleText {
  /** The program text to start with. */
  doc: string
  /** The marks to start with. */
  markers: LineMarkers
  /** Called with the whole text after every edit that the student made. */
  onChange: (text: string) => void
  /** Called with a line number when the student asks to switch its breakpoint. */
  onToggleBreakpoint: (line: number) => void
  /**
   * Breakpoints stay with their line of code while the student edits (default false:
   * they keep their line numbers). Change it later with `setBreakpointsFollow`.
   */
  breakpointsFollow?: boolean
  /**
   * While breakpoints follow their lines: called (after `onChange`) with the new line
   * numbers whenever an edit of the student moved or removed a breakpoint.
   */
  onBreakpointsChange?: (lines: number[]) => void
  /** Long lines wrap (default false: they scroll sideways). See `setWrapLines`. */
  wrapLines?: boolean
  /** Pixels at the bottom of the screen that fixed controls cover. See `setCoveredBottom`. */
  coveredBottom?: number
}

/** The text that the page gave each editor last (see `syncDocument`). */
const lastGivenText = new WeakMap<EditorView, string>()

/** The name and description that each editor has now (see `setAccessibleText`). */
const accessibleTexts = new WeakMap<EditorView, AccessibleText>()

/** Holds the name and description, which the page can change later. */
const accessibility = new Compartment()

/** Holds `breakpointsFollowEdits`, which is on while the page listens for moved breakpoints. */
const breakpointFollowing = new Compartment()

/** Holds line wrapping (and `wrapLongLines`, which tells the marks about it). */
const wrapping = new Compartment()

/** How many pixels at the bottom of the screen each editor must treat as covered. */
const coveredBottoms = new WeakMap<EditorView, number>()

function wrapExtension(on: boolean): Extension {
  return on ? [EditorView.lineWrapping, wrapLongLines.of(true)] : wrapLongLines.of(false)
}

/* ───────────────────────── Characters that look like others ───────────────────────── */

/**
 * Spaces that look like a normal space but are not one (the no-break space that slides
 * and some phone keyboards produce, and its cousins). gcc cannot read them, and the
 * assembler says so; here they are drawn as a visible dot, so the student can find them.
 */
const ODD_SPACES = /[\u00a0\u2007\u202f\u3000]/

function specialCharacter(code: number, description: string | null, placeholder: string) {
  const mark = document.createElement('span')
  if (ODD_SPACES.test(String.fromCodePoint(code))) {
    const label = oddSpaceLabel(code)
    mark.className = 'cm-ss-odd-space'
    mark.textContent = '\u00b7'
    mark.title = label
    mark.setAttribute('aria-label', label)
    return mark
  }
  // CodeMirror's own way for the other special characters (zero-width spaces, …).
  mark.className = 'cm-specialChar'
  mark.textContent = placeholder
  if (description !== null) {
    mark.title = description
    mark.setAttribute('aria-label', description)
  }
  return mark
}

/**
 * Typing turns curly quotes and no-break spaces into the plain characters gcc reads.
 * Phone keyboards type “ ” ‘ ’ for " and ' (smart punctuation), so without this a student
 * on a phone could not type a string at all. Pasted text is not changed: the assembler
 * explains what is wrong with it, and how to fix it.
 */
const PLAIN_FOR_TYPED: Readonly<Record<string, string>> = {
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u00a0': ' ',
  '\u202f': ' ',
}
const TYPED_LOOKALIKES = /[\u201c\u201d\u201e\u2018\u2019\u201a\u00a0\u202f]/g

export function plainTypedText(text: string): string {
  return text.replace(TYPED_LOOKALIKES, (char) => PLAIN_FOR_TYPED[char] ?? char)
}

const plainTyping = EditorView.inputHandler.of((view, from, to, text) => {
  const plain = plainTypedText(text)
  if (plain === text || view.state.selection.ranges.length > 1) return false
  view.dispatch({
    changes: { from, to, insert: plain },
    selection: { anchor: from + plain.length },
    scrollIntoView: true,
    userEvent: 'input.type',
  })
  return true
})

/**
 * Text of several lines that arrives as typing (an `insertText` input: some keyboards and
 * dictation tools, and test robots, insert a whole program that way) goes in the way a
 * paste does. The browser's own editing of the text area is very slow for long text: 5,000
 * lines took 18 seconds, a paste of the same text a third of a second. Like a paste, the
 * text is not changed (see `plainTyping` for what typing changes).
 */
const multiLineInput = EditorView.domEventHandlers({
  beforeinput(event, view) {
    const text = event.data
    if (event.inputType !== 'insertText' || text === null || !text.includes('\n')) return false
    event.preventDefault()
    view.dispatch({
      ...view.state.replaceSelection(normalizeLineBreaks(text)),
      scrollIntoView: true,
      userEvent: 'input.paste',
    })
    return true
  },
})

function accessibleAttributes({ label, describedBy }: AccessibleText): Extension {
  // CodeMirror itself adds role="textbox", aria-multiline and the attributes that
  // switch off spell-check, auto-correct and auto-capitalise.
  return EditorView.contentAttributes.of({
    'aria-label': label,
    'aria-describedby': describedBy,
    // An editable text is a Tab stop anyway; saying so lets checkers (axe) see that the
    // scrolling box around it can be reached with the keyboard. No extra stop.
    tabindex: '0',
    // Grammar helpers in the browser would underline every register name.
    'data-gramm': 'false',
    'data-gramm_editor': 'false',
    'data-enable-grammarly': 'false',
  })
}

/** Create the editor inside `parent`. Call `destroy()` on the result to remove it. */
export function createEditorView(parent: HTMLElement, config: EditorConfig): EditorView {
  const { onChange, onToggleBreakpoint, onBreakpointsChange } = config

  const reportEdits = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return
    const edited = update.transactions.some(
      (transaction) => transaction.docChanged && transaction.annotation(pageChange) !== true,
    )
    if (!edited) return
    onChange(update.state.doc.toString())
    // The edit carried breakpoints along with their lines (see `mapBreakpoints`).
    const before = update.startState.field(lineMarksField).markers.breakpoints
    const after = update.state.field(lineMarksField).markers.breakpoints
    if (after !== before) onBreakpointsChange?.([...after])
  })

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: config.doc,
      extensions: [
        wrapping.of(wrapExtension(config.wrapLines === true)),
        lineMarks(config.markers),
        breakpointFollowing.of(breakpointsFollowEdits.of(config.breakpointsFollow === true)),
        markerGutters(onToggleBreakpoint),
        history(),
        EditorState.tabSize.of(TAB_WIDTH),
        indentUnit.of(INDENT),
        highlightSpecialChars({ addSpecialChars: ODD_SPACES, render: specialCharacter }),
        multiLineInput,
        plainTyping,
        assembly(),
        diagnosticMessages(),
        keymap.of(editorKeymap(onToggleBreakpoint)),
        editorTheme(),
        accessibility.of(accessibleAttributes(config)),
        reportEdits,
      ],
    }),
  })

  lastGivenText.set(view, config.doc)
  accessibleTexts.set(view, { label: config.label, describedBy: config.describedBy })
  coveredBottoms.set(view, Math.max(0, config.coveredBottom ?? 0))

  const line = activeLine(config.markers)
  if (line !== null) revealLine(view, line)
  return view
}

/** Give the text area another name or description. Does nothing when both are as before. */
export function setAccessibleText(view: EditorView, text: AccessibleText): void {
  const current = accessibleTexts.get(view)
  if (current?.label === text.label && current.describedBy === text.describedBy) return
  accessibleTexts.set(view, { label: text.label, describedBy: text.describedBy })
  view.dispatch({ effects: accessibility.reconfigure(accessibleAttributes(text)) })
}

/** Switch line wrapping on or off. Does nothing when unchanged. */
export function setWrapLines(view: EditorView, on: boolean): void {
  if (view.state.facet(wrapLongLines) === on) return
  view.dispatch({ effects: wrapping.reconfigure(wrapExtension(on)) })
}

/**
 * Tell the editor how many pixels at the bottom of the screen fixed controls cover (a
 * phone's control bar). `revealLine` then keeps lines above them.
 */
export function setCoveredBottom(view: EditorView, pixels: number): void {
  coveredBottoms.set(view, Number.isFinite(pixels) ? Math.max(0, pixels) : 0)
}

/** Switch "breakpoints stay with their line of code" on or off. Does nothing when unchanged. */
export function setBreakpointsFollow(view: EditorView, on: boolean): void {
  if (view.state.facet(breakpointsFollowEdits) === on) return
  view.dispatch({ effects: breakpointFollowing.reconfigure(breakpointsFollowEdits.of(on)) })
}

/**
 * Take the student to a line, for example from the list of problems: the text cursor goes
 * to the start of the line's code, the line is scrolled into sight, and the editor gets
 * the keyboard focus (so the message of a marked line opens and is read out).
 */
export function goToLine(view: EditorView, lineNumber: number): void {
  const { doc } = view.state
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > doc.lines) return
  const line = doc.line(lineNumber)
  const start = line.from + (diagnosticRange(line.text)?.from ?? 0)
  view.dispatch({ selection: { anchor: start }, userEvent: 'select' })
  revealLine(view, lineNumber)
  // The focus comes last: arriving on the line with the focus opens its message and reads
  // its marks out once.
  view.focus()
}

/**
 * Show a line without the keyboard focus (on a phone, the focus would open the keyboard):
 * when the editor is out of the page's view, the page scrolls to it first; then the line
 * is scrolled into the editor's view.
 */
export function showLine(view: EditorView, lineNumber: number): void {
  const { doc } = view.state
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > doc.lines) return
  const box = view.dom.getBoundingClientRect()
  const screenHeight = view.dom.ownerDocument.defaultView?.innerHeight ?? box.bottom
  const covered = coveredBottoms.get(view) ?? 0
  if (box.bottom <= 0 || box.top >= screenHeight - covered) {
    view.dom.scrollIntoView({ block: 'nearest' })
  }
  revealLine(view, lineNumber)
}

/* ───────────────────────────── The text ───────────────────────────── */

/** CodeMirror keeps "\n" between lines, whatever the text came with. */
export function normalizeLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

export interface TextChange {
  from: number
  to: number
  insert: string
}

/**
 * The smallest single change that turns `before` into `after`: everything between the
 * part they share at the start and the part they share at the end. `from` and `to` are
 * positions in `before`.
 */
export function smallestChange(before: string, after: string): TextChange {
  const limit = Math.min(before.length, after.length)
  let start = 0
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1
  let end = 0
  while (
    end < limit - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) {
    end += 1
  }
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) }
}

/**
 * - 'same':     the editor already shows this text; nothing was done.
 * - 'edited':   part of the text was changed; the cursor and the scroll position stay.
 * - 'replaced': it is another program; the editor went back to the top.
 */
export type DocumentSync = 'same' | 'edited' | 'replaced'

/**
 * Make the editor show `text`, the value that the page passes in.
 *
 * The editor acts only when the page passes ANOTHER text than last time (an example was
 * loaded). The same text again means "nothing new from the page": the student may have
 * typed since, and a page that is one step behind must never undo that typing.
 *
 * Only the part that differs is changed, so a small change from outside keeps the
 * cursor and the scroll position. When less than half of the old text is left, it is
 * another program: the cursor goes to the start and the editor scrolls to the top.
 * `onChange` is not called. The change is one step of the undo history, so a student
 * who loads an example by mistake gets the old program back with Undo.
 */
export function syncDocument(view: EditorView, text: string): DocumentSync {
  if (lastGivenText.get(view) === text) return 'same'
  lastGivenText.set(view, text)

  const before = view.state.doc.toString()
  const after = normalizeLineBreaks(text)
  if (before === after) return 'same'

  const change = smallestChange(before, after)
  const kept = before.length - (change.to - change.from)
  const replaced = kept * 2 < before.length
  view.dispatch({
    changes: change,
    selection: replaced ? { anchor: 0 } : undefined,
    annotations: [pageChange.of(true), isolateHistory.of('full')],
  })
  if (replaced) {
    view.scrollDOM.scrollTop = 0
    view.scrollDOM.scrollLeft = 0
  }
  return replaced ? 'replaced' : 'edited'
}

/* ───────────────────────────── The marks ───────────────────────────── */

/**
 * Give the editor the marks of the page. Returns true when the line to look at (the
 * line that runs next, or the library line) is now another line, or got the library tag.
 *
 * When exactly one breakpoint was switched while the editor has the keyboard focus (the
 * student pressed Mod-b), that is read out for screen readers.
 */
export function syncMarkers(view: EditorView, next: LineMarkers): boolean {
  const previous = view.state.field(lineMarksField).markers
  const markers = mergeMarkers(previous, next)
  if (markers === previous) return false

  const effects: StateEffect<unknown>[] = [setLineMarkers.of(markers)]
  if (view.hasFocus) {
    const words = describeBreakpointChange(previous.breakpoints, markers.breakpoints)
    if (words !== null) effects.push(EditorView.announce.of(words))
  }
  view.dispatch({ effects })
  // The library tag can make its line taller (a row of its own, or a wrapped line), so the
  // line is shown again when the tag comes, also when it is the same line as before.
  return (
    activeLine(markers) !== activeLine(previous) || markers.libraryLine !== previous.libraryLine
  )
}

/** Only the last request to reveal a line counts. */
const revealRequest = {}

/**
 * Scroll the editor so that a line is in sight. Nothing moves when the whole line is
 * already in sight; otherwise the line goes to the middle. Only the editor's own
 * scroller moves: never the page, never sideways, and the keyboard focus stays put.
 *
 * "In sight" means inside the part of the editor that is on the screen, above the fixed
 * controls (see `setCoveredBottom`). On a phone the student may have scrolled the page so
 * that only a strip of the editor is left at the top of the screen; the line then goes
 * into that strip.
 */
function revealLine(view: EditorView, lineNumber: number): void {
  // One frame later. New marks can change the height of lines (the "inside printf" row
  // under a call, a line that wraps), and while CodeMirror measures such a change it keeps
  // the lines on the screen where they are: a scroll written in that same measure would be
  // undone. A frame later the heights are known and the scroll stays.
  const win = view.dom.ownerDocument.defaultView
  const later = (callback: () => void) => {
    if (win === null) setTimeout(callback, 16)
    else win.requestAnimationFrame(callback)
  }
  later(() => {
    // The editor may have been taken off the page in the meantime.
    if (view.dom.isConnected) measureAndReveal(view, lineNumber)
  })
}

function measureAndReveal(view: EditorView, lineNumber: number): void {
  view.requestMeasure({
    key: revealRequest,
    read(measured) {
      const scroller = measured.scrollDOM
      if (lineNumber > measured.state.doc.lines || scroller.clientHeight === 0) return 0
      const block = measured.lineBlockAt(measured.state.doc.line(lineNumber).from)
      const top = measured.documentTop + block.top
      const bottom = top + block.height

      const boxTop = scroller.getBoundingClientRect().top
      const boxBottom = boxTop + scroller.clientHeight
      const screenHeight = scroller.ownerDocument.defaultView?.innerHeight ?? boxBottom
      // Fixed controls at the bottom of the screen (a phone's bar) cover part of it.
      const covered = coveredBottoms.get(measured) ?? 0
      let viewTop = Math.max(boxTop, 0)
      let viewBottom = Math.min(boxBottom, screenHeight - covered)
      // (Almost) nothing of the editor is on the screen: use the whole editor.
      if (viewBottom - viewTop < block.height) {
        viewTop = boxTop
        viewBottom = boxBottom
      }

      if (top >= viewTop && bottom <= viewBottom) return 0
      return (top + bottom) / 2 - (viewTop + viewBottom) / 2
    },
    write(distance, measured) {
      if (distance !== 0) measured.scrollDOM.scrollTop += distance
    },
  })
}

/**
 * Bring the editor in step with the page: first the text, then the marks. The line to
 * look at is scrolled into sight when it is another line than before, or when another
 * program was loaded.
 */
export function syncEditor(view: EditorView, text: string, markers: LineMarkers): void {
  const documentSync = syncDocument(view, text)
  const lineChanged = syncMarkers(view, markers)
  const line = activeLine(markers)
  if (line !== null && (lineChanged || documentSync === 'replaced')) revealLine(view, line)
}
