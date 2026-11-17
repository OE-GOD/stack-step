/**
 * The message of an error or a warning, shown in a small box under its line.
 *
 * The box appears in three ways, so that every student can reach the message:
 *   - mouse:    rest the pointer on the underlined text or on the `!` mark in the gutter;
 *   - touch:    tap the `!` mark, or tap the line;
 *   - keyboard: move the text cursor onto the line.
 * It goes away when the text changes, when the cursor leaves the line, when the editor
 * loses the keyboard focus, and on Escape.
 *
 * When the text cursor arrives on a marked line, the marks of that line are also read
 * out for screen readers (the gutter marks are pictures that they cannot see).
 */
import type { EditorState, Extension, Transaction } from '@codemirror/state'
import {
  activateHover,
  closeHoverTooltip,
  EditorView,
  hoverTooltip,
  type Rect,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from '@codemirror/view'
import {
  diagnosticRange,
  lineMarksField,
  setLineMarkers,
  type DiagnosticSeverity,
  type LineDiagnostics,
} from './lineMarkers'
import { describeLineMarks, SEVERITY_WORD } from './markerText'

/* ────────────────────────────── The box itself ────────────────────────────── */

/** The small `!` picture: a filled square for an error, a ring for a warning. */
export function diagnosticBadge(severity: DiagnosticSeverity): HTMLElement {
  const badge = document.createElement('span')
  badge.className = `cm-ss-diagnostic cm-ss-diagnostic-${severity}`
  badge.textContent = '!'
  return badge
}

/**
 * Add `text` to `parent`, with the parts in backticks as <code>. This is the rule of
 * <RichText>: a backtick that has no partner is shown as it is.
 */
export function appendRichText(parent: HTMLElement, text: string): void {
  const parts = text.split('`')
  if (parts.length % 2 === 0) {
    const tail = parts.pop() ?? ''
    parts[parts.length - 1] += `\`${tail}`
  }
  parts.forEach((part, index) => {
    if (part === '') return
    if (index % 2 === 1) {
      const code = document.createElement('code')
      code.textContent = part
      parent.append(code)
    } else {
      parent.append(part)
    }
  })
}

/** The content of the box: one paragraph per message, each with a picture and a word. */
export function messageElement(diagnostics: LineDiagnostics): HTMLElement {
  const box = document.createElement('div')
  box.className = 'cm-ss-message'
  for (const { severity, message } of diagnostics.messages) {
    const row = document.createElement('p')
    row.className = `cm-ss-message-row cm-ss-message-${severity}`
    const badge = diagnosticBadge(severity)
    badge.setAttribute('aria-hidden', 'true')
    const word = document.createElement('strong')
    word.className = 'cm-ss-message-kind'
    word.textContent = SEVERITY_WORD[severity]
    row.append(badge, ' ', word, ' ')
    appendRichText(row, message)
    box.append(row)
  }
  return box
}

/**
 * Where the box hangs: under the line, at the start of the marked text. When the code is
 * scrolled sideways (a phone), that start can be out of sight; then the box hangs at the
 * left edge of the code that is in sight, so it never disappears with it.
 */
function messageAnchor(view: EditorView, position: number): Rect {
  const block = view.lineBlockAt(position)
  const top = view.documentTop + block.top
  const scroller = view.scrollDOM.getBoundingClientRect()
  const gutters = view.scrollDOM.querySelector('.cm-gutters')
  // Two pixels inside the code area: CodeMirror hides a box whose anchor is outside it,
  // and it measures the gutter in whole pixels.
  const codeLeft = (gutters === null ? scroller.left : gutters.getBoundingClientRect().right) + 2
  const codeRight = Math.max(codeLeft, scroller.right - 2)
  const textLeft = view.coordsAtPos(position)?.left ?? codeLeft
  const x = Math.min(Math.max(textLeft, codeLeft), codeRight)
  return { left: x, right: x, top, bottom: top + block.height }
}

type CreateTooltip = (view: EditorView) => TooltipView

/**
 * CodeMirror keeps a box on the screen as long as it is asked for with the SAME `create`
 * function. One function per set of messages means the box does not flicker when it is
 * asked for again (for example by the mouse and then by the cursor).
 */
const creators = new WeakMap<LineDiagnostics, CreateTooltip>()

function creatorFor(diagnostics: LineDiagnostics): CreateTooltip {
  let create = creators.get(diagnostics)
  if (create === undefined) {
    create = (view) => ({
      dom: messageElement(diagnostics),
      getCoords: (position) => messageAnchor(view, position),
    })
    creators.set(diagnostics, create)
  }
  return create
}

/** The box for the messages of line `lineNumber`, or null when that line has none. */
function messageTooltip(state: EditorState, lineNumber: number): Tooltip | null {
  const diagnostics = state.field(lineMarksField).byLine.get(lineNumber)?.diagnostics ?? null
  if (diagnostics === null) return null
  const line = state.doc.line(lineNumber)
  const range = diagnosticRange(line.text) ?? { from: 0, to: line.length }
  return {
    pos: line.from + range.from,
    end: line.from + range.to,
    above: false,
    create: creatorFor(diagnostics),
  }
}

/* ─────────────────────────── Showing and hiding ─────────────────────────── */

/** True when this transaction gives the editor other diagnostics than it had. */
function changesDiagnostics(transaction: Transaction): boolean {
  const before = transaction.startState.field(lineMarksField).markers.diagnostics
  return transaction.effects.some(
    (effect) => effect.is(setLineMarkers) && effect.value.diagnostics !== before,
  )
}

/**
 * The mouse part: resting the pointer on the underlined text shows the box. The same
 * machine is used for the other two ways (see `showLineMessage`), so there is never
 * more than one box.
 */
const messageHover = hoverTooltip(
  (view, position) => {
    const tooltip = messageTooltip(view.state, view.state.doc.lineAt(position).number)
    if (tooltip === null) return null
    // Only the marked text shows the message, not the comment or the space beside it.
    return position >= tooltip.pos && position <= (tooltip.end ?? tooltip.pos) ? tooltip : null
  },
  { hideOn: (transaction) => transaction.docChanged || changesDiagnostics(transaction) },
)

/** The line whose message box is open, or null. */
export function shownMessageLine(state: EditorState): number | null {
  const [tooltip] = state.field(messageHover.active, false) ?? []
  return tooltip === undefined ? null : state.doc.lineAt(tooltip.pos).number
}

/**
 * - 'cursor':  the text cursor arrived on the line. The box stays until the cursor
 *              leaves the line.
 * - 'pointer': the mouse or a finger is on the `!` mark. The box stays until the cursor
 *              is put somewhere or the marks change (the mark may be redrawn then, and a
 *              redrawn mark never hears the pointer leave), or until `hideLineMessage`
 *              is called because the pointer left.
 */
export type MessageTrigger = 'cursor' | 'pointer'

/** Open the message box of a line. Returns false when the line has no message. */
export function showLineMessage(
  view: EditorView,
  lineNumber: number,
  trigger: MessageTrigger,
): boolean {
  const tooltip = messageTooltip(view.state, lineNumber)
  if (tooltip === null) return false
  const until = (transaction: Transaction): boolean => {
    if (trigger === 'pointer') {
      return (
        transaction.selection !== undefined ||
        transaction.effects.some((effect) => effect.is(setLineMarkers))
      )
    }
    if (transaction.selection === undefined) return false
    const head = transaction.newSelection.main.head
    return transaction.newDoc.lineAt(head).number !== lineNumber
  }
  activateHover(view, tooltip.pos, 1, { tooltip: messageHover, until })
  return true
}

/** Close the message box, if one is open. */
export function hideLineMessage(view: EditorView): void {
  if (shownMessageLine(view.state) !== null) {
    view.dispatch({ effects: closeHoverTooltip(messageHover) })
  }
}

/* ───────────────────── When the text cursor arrives on a line ───────────────────── */

function cursorLine(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number
}

/**
 * True when this update put the text cursor on a line it was not on before: the student
 * moved it there (keys, mouse or finger), or the editor just got the keyboard focus.
 * Typing is not arriving: nothing should pop up or be read out while the student types.
 */
function cursorArrived(update: ViewUpdate): boolean {
  if (!update.view.hasFocus) return false
  if (update.focusChanged) return true
  if (!update.selectionSet || update.docChanged) return false
  return (
    cursorLine(update.startState) !== cursorLine(update.state) &&
    update.transactions.some((transaction) => transaction.isUserEvent('select'))
  )
}

function onUpdate(update: ViewUpdate): void {
  if (!cursorArrived(update)) return
  const { view, state } = update
  const line = cursorLine(state)
  const marks = state.field(lineMarksField).byLine.get(line)
  if (marks === undefined) return
  const words = describeLineMarks(marks)
  if (words !== '') view.dispatch({ effects: EditorView.announce.of(words) })
  if (marks.diagnostics !== null) showLineMessage(view, line, 'cursor')
}

/** Everything in this file as one extension. */
export function diagnosticMessages(): Extension {
  return [
    messageHover,
    EditorView.updateListener.of(onUpdate),
    // The box belongs to the cursor or the pointer. Without the keyboard focus it goes.
    EditorView.focusChangeEffect.of((_state, focusing) =>
      focusing ? null : closeHoverTooltip(messageHover),
    ),
  ]
}
