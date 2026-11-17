/**
 * The marks the stepper page puts on lines: the line that runs next, the line that just
 * ran, the line whose library call is running, breakpoints, assembler errors and warnings,
 * and the line where a run-time error stopped the program.
 *
 * The page talks in LINE NUMBERS (1-based), so that is what is stored here. Where a mark
 * is drawn is worked out again from the line numbers every time the text changes; a mark
 * stays on its line number until the page says otherwise.
 *
 * One exception: when the page asks for it (`breakpointsFollowEdits`), a breakpoint stays
 * with its line of code while the student edits. A new line above it moves it down, and
 * deleting its line removes it. The page is then told the new line numbers.
 *
 * This file is the model (plain data, easy to test) plus the marks inside the text:
 * line backgrounds, wavy underlines and the "inside printf" tag. The gutter marks are in
 * `breakpointGutter.ts`, the messages in `diagnosticTooltip.ts`.
 *
 * The "inside printf" tag never covers code: when long lines wrap (`wrapLongLines`) it
 * sits right after the instruction, before the comment; otherwise it gets a row of its
 * own under the call line.
 */
import {
  Annotation,
  Facet,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Line,
  type Range,
  type Text,
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { Diagnostic } from '../../../emulator'
import { tokenizeLine } from '../../../lib/asmHighlight'
import { libraryTagText } from './markerText'

export type DiagnosticSeverity = Diagnostic['severity']

export interface DiagnosticMessage {
  severity: DiagnosticSeverity
  /** The complete message from the assembler, e.g. "Line 7: you can't move memory …". */
  message: string
}

/** Every diagnostic of one line. */
export interface LineDiagnostics {
  line: number
  /** 'error' when at least one message is an error, else 'warning'. */
  severity: DiagnosticSeverity
  /** Errors first, then warnings; otherwise in the order the assembler gave them. */
  messages: readonly DiagnosticMessage[]
}

/** All the marks, as the page gives them, cleaned up (see `normalizeMarkers`). */
export interface LineMarkers {
  currentLine: number | null
  /** The line that just ran (it gets a hollow arrow). */
  lastLine: number | null
  libraryLine: number | null
  /** The library function that runs at `libraryLine` ("printf"), or null when not known. */
  libraryName: string | null
  /** Ascending, no line twice. */
  breakpoints: readonly number[]
  /**
   * One entry per line, ascending. A run-time error is one of them (an error on the line
   * where it happened), so it gets the same underline, mark and message.
   */
  diagnostics: readonly LineDiagnostics[]
  /** The line where a run-time error stopped the program, or null. */
  stoppedLine: number | null
}

export const NO_MARKERS: LineMarkers = {
  currentLine: null,
  lastLine: null,
  libraryLine: null,
  libraryName: null,
  breakpoints: [],
  diagnostics: [],
  stoppedLine: null,
}

/** The marker props of the editor, exactly as the page passes them. */
export interface MarkerInput {
  currentLine: number | null
  /** The line that just ran. Missing or null: none. */
  lastLine?: number | null
  libraryLine: number | null
  /** The name of the library function that is running. Missing or null: "the library". */
  libraryName?: string | null
  breakpoints: readonly number[]
  diagnostics: readonly Diagnostic[]
  /** A run-time error and its line. Missing or null: none. */
  runtimeError?: { line: number; message: string } | null
}

function isLineNumber(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 1
}

/** A name worth showing: some text that is not only spaces. */
function cleanName(name: string | null | undefined): string | null {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return trimmed === '' ? null : trimmed
}

/**
 * Clean up what the page passes: drop line numbers that cannot be a line (0, negative,
 * fractions), sort the breakpoints, and put the diagnostics of one line together.
 * A diagnostic with `line: 0` is about the whole program, so it marks no line.
 */
export function normalizeMarkers(input: MarkerInput): LineMarkers {
  const breakpoints = [...new Set(input.breakpoints.filter(isLineNumber))].sort((a, b) => a - b)

  const runtimeError = input.runtimeError ?? null
  const stoppedLine =
    runtimeError !== null && isLineNumber(runtimeError.line) ? runtimeError.line : null
  const all: { line: number; severity: DiagnosticSeverity; message: string }[] = [
    ...input.diagnostics,
  ]
  if (runtimeError !== null && stoppedLine !== null) {
    all.push({ line: stoppedLine, severity: 'error', message: runtimeError.message })
  }

  const byLine = new Map<number, DiagnosticMessage[]>()
  for (const { line, severity, message } of all) {
    if (!isLineNumber(line)) continue
    const messages = byLine.get(line) ?? []
    if (!messages.some((known) => known.severity === severity && known.message === message)) {
      messages.push({ severity, message })
    }
    byLine.set(line, messages)
  }
  const diagnostics = [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, messages]): LineDiagnostics => {
      const errors = messages.filter((entry) => entry.severity === 'error')
      const warnings = messages.filter((entry) => entry.severity === 'warning')
      return {
        line,
        severity: errors.length > 0 ? 'error' : 'warning',
        messages: [...errors, ...warnings],
      }
    })

  const libraryLine = isLineNumber(input.libraryLine) ? input.libraryLine : null
  const lastLine = input.lastLine ?? null
  return {
    currentLine: isLineNumber(input.currentLine) ? input.currentLine : null,
    lastLine: isLineNumber(lastLine) ? lastLine : null,
    libraryLine,
    // A name without a library line names nothing.
    libraryName: libraryLine === null ? null : cleanName(input.libraryName),
    breakpoints,
    diagnostics,
    stoppedLine,
  }
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  return a === b || (a.length === b.length && a.every((value, index) => value === b[index]))
}

function sameLineDiagnostics(a: LineDiagnostics, b: LineDiagnostics): boolean {
  return (
    a.line === b.line &&
    a.severity === b.severity &&
    a.messages.length === b.messages.length &&
    a.messages.every((entry, index) => {
      const other = b.messages[index]
      return (
        other !== undefined && entry.severity === other.severity && entry.message === other.message
      )
    })
  )
}

function sameDiagnostics(a: readonly LineDiagnostics[], b: readonly LineDiagnostics[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((entry, index) => {
        const other = b[index]
        return other !== undefined && sameLineDiagnostics(entry, other)
      }))
  )
}

/**
 * The markers to keep after the page passed new ones. Parts that did not change keep
 * their old object, and when nothing changed the result IS `previous`. So `===` is
 * enough to ask "did the breakpoints change?" or "did anything change?".
 */
export function mergeMarkers(previous: LineMarkers, next: LineMarkers): LineMarkers {
  const breakpoints = sameNumbers(previous.breakpoints, next.breakpoints)
    ? previous.breakpoints
    : next.breakpoints
  const diagnostics = sameDiagnostics(previous.diagnostics, next.diagnostics)
    ? previous.diagnostics
    : next.diagnostics
  const unchanged =
    breakpoints === previous.breakpoints &&
    diagnostics === previous.diagnostics &&
    previous.currentLine === next.currentLine &&
    previous.lastLine === next.lastLine &&
    previous.libraryLine === next.libraryLine &&
    previous.libraryName === next.libraryName &&
    previous.stoppedLine === next.stoppedLine
  if (unchanged) return previous
  return {
    currentLine: next.currentLine,
    lastLine: next.lastLine,
    libraryLine: next.libraryLine,
    libraryName: next.libraryName,
    breakpoints,
    diagnostics,
    stoppedLine: next.stoppedLine,
  }
}

/* ─────────────────────── Breakpoints that follow their line ─────────────────────── */

/**
 * True when one change removed the whole line: its text and the line break after it (for
 * the last line: the line break before it). A line that was only emptied still exists.
 */
function lineRemoved(changes: ChangeDesc, line: Line, doc: Text): boolean {
  const last = line.number === doc.lines
  if (last && line.number === 1) return false
  const from = last ? line.from - 1 : line.from
  const to = last ? line.to : line.to + 1
  let removed = false
  changes.iterChangedRanges((fromA, toA) => {
    if (fromA <= from && toA >= to) removed = true
  })
  return removed
}

/**
 * The breakpoints after an edit of the student, so that each one stays with its line of
 * code: lines added or removed above it move it, a line split after its start keeps it,
 * and removing its whole line removes it. Two breakpoints that end up on one line become
 * one. Returns `lines` itself when nothing moved.
 */
export function mapBreakpoints(
  lines: readonly number[],
  changes: ChangeDesc,
  before: Text,
  after: Text,
): readonly number[] {
  if (lines.length === 0 || changes.empty) return lines
  const mapped = new Set<number>()
  for (const number of lines) {
    // A breakpoint past the end marks nothing; it keeps its number until the page drops it.
    if (number > before.lines) {
      mapped.add(number)
      continue
    }
    const line = before.line(number)
    if (lineRemoved(changes, line, before)) continue
    // `1`: text typed at the very start of the line goes before the breakpoint's code.
    mapped.add(after.lineAt(changes.mapPos(line.from, 1)).number)
  }
  const result = [...mapped].sort((a, b) => a - b)
  return sameNumbers(result, lines) ? lines : result
}

/**
 * On when the page wants breakpoints to stay with their line of code while the student
 * edits (it then listens for the new line numbers). Off: breakpoints keep their numbers.
 */
export const breakpointsFollowEdits = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

/**
 * On when long lines wrap onto the next row (the page turns `EditorView.lineWrapping` on
 * with it). It decides where the "inside printf" tag goes.
 */
export const wrapLongLines = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean),
})

/** Marks a change that came from the page (an example was loaded), not from the student. */
export const pageChange = Annotation.define<boolean>()

/** The line the student should be looking at: the one that runs next, or the library call. */
export function activeLine(markers: LineMarkers): number | null {
  return markers.currentLine ?? markers.libraryLine
}

/** Everything that is marked on one line. */
export interface LineMarks {
  line: number
  breakpoint: boolean
  /**
   * 'current': this line runs next. 'library': the program is inside the library call
   * of this line. A line that is given as both shows as 'current'.
   */
  execution: 'current' | 'library' | null
  /** With 'library': the name of the function that runs ("printf"), or null when not known. */
  libraryName: string | null
  /** This line just ran (and is not the line that runs next). */
  ran: boolean
  /** A run-time error stopped the program on this line. */
  stopped: boolean
  diagnostics: LineDiagnostics | null
}

/**
 * The marks of every marked line, by line number, in ascending order. Lines that the
 * document does not have (a breakpoint on line 40 of a 30-line program) are left out.
 */
export function marksByLine(markers: LineMarkers, lineCount: number): Map<number, LineMarks> {
  const exists = (line: number | null): line is number => line !== null && line <= lineCount
  const diagnostics = new Map(markers.diagnostics.map((entry) => [entry.line, entry]))
  const breakpoints = new Set(markers.breakpoints)

  const lines = new Set<number>([...breakpoints, ...diagnostics.keys()])
  if (markers.currentLine !== null) lines.add(markers.currentLine)
  if (markers.lastLine !== null) lines.add(markers.lastLine)
  if (markers.libraryLine !== null) lines.add(markers.libraryLine)
  if (markers.stoppedLine !== null) lines.add(markers.stoppedLine)

  const result = new Map<number, LineMarks>()
  for (const line of [...lines].filter(exists).sort((a, b) => a - b)) {
    const execution =
      markers.currentLine === line ? 'current' : markers.libraryLine === line ? 'library' : null
    result.set(line, {
      line,
      breakpoint: breakpoints.has(line),
      execution,
      libraryName: execution === 'library' ? markers.libraryName : null,
      ran: markers.lastLine === line && execution === null,
      stopped: markers.stoppedLine === line,
      diagnostics: diagnostics.get(line) ?? null,
    })
  }
  return result
}

/**
 * The part of a line that gets the wavy underline: from the first piece of code to the
 * last one, without the space around it and without the comment at the end. A line that
 * holds only a comment is underlined as a whole; a blank line has nothing to underline.
 * Offsets count from the start of the line.
 */
export function diagnosticRange(lineText: string): { from: number; to: number } | null {
  let from = -1
  let to = -1
  let offset = 0
  for (const token of tokenizeLine(lineText)) {
    const end = offset + token.text.length
    if (token.kind !== 'space' && token.kind !== 'comment') {
      if (from < 0) from = offset
      to = end
    }
    offset = end
  }
  if (from >= 0) return { from, to }

  const firstInk = lineText.search(/\S/)
  return firstInk < 0 ? null : { from: firstInk, to: lineText.trimEnd().length }
}

/* ───────────────────────────── Marks inside the text ───────────────────────────── */

/**
 * The tag of the line whose library call is running: "inside printf".
 * - inline (lines wrap): right after the instruction, before the comment;
 * - a row (lines scroll sideways): a row of its own under the call line, so it is in
 *   sight however far the line reaches and never covers code.
 */
class LibraryTagWidget extends WidgetType {
  readonly name: string | null
  readonly row: boolean

  constructor(name: string | null, row: boolean) {
    super()
    this.name = name
    this.row = row
  }

  override eq(other: LibraryTagWidget): boolean {
    return other.name === this.name && other.row === this.row
  }

  override toDOM(): HTMLElement {
    const tag = document.createElement('span')
    tag.className = 'cm-ss-library-tag'
    tag.textContent = libraryTagText(this.name)
    if (!this.row) return tag
    const row = document.createElement('div')
    row.className = 'cm-ss-library-row'
    row.setAttribute('aria-hidden', 'true')
    row.append(tag)
    return row
  }
}

/** One tag decoration per function name and place, made once. */
const libraryTags = new Map<string, Decoration>()

function libraryTagDecoration(name: string | null, row: boolean): Decoration {
  const key = `${row ? 'row' : 'inline'}:${name ?? ''}`
  let decoration = libraryTags.get(key)
  if (decoration === undefined) {
    decoration = row
      ? Decoration.widget({ widget: new LibraryTagWidget(name, true), block: true, side: 1 })
      : Decoration.widget({ widget: new LibraryTagWidget(name, false), side: 1 })
    libraryTags.set(key, decoration)
  }
  return decoration
}

const currentLineDecoration = Decoration.line({ class: 'cm-ss-line-current' })
const ranLineDecoration = Decoration.line({ class: 'cm-ss-line-ran' })
const stoppedLineDecoration = Decoration.line({ class: 'cm-ss-line-stopped' })
const libraryLineDecoration = Decoration.line({ class: 'cm-ss-line-library' })
const underlineDecoration: Record<DiagnosticSeverity, Decoration> = {
  error: Decoration.mark({ class: 'cm-ss-underline cm-ss-underline-error' }),
  warning: Decoration.mark({ class: 'cm-ss-underline cm-ss-underline-warning' }),
}

/**
 * The decorations for the marked lines of `doc` (`marks` as returned by `marksByLine`).
 * `wrap`: long lines wrap, so the library tag goes inline after the instruction.
 */
export function buildDecorations(
  doc: Text,
  marks: ReadonlyMap<number, LineMarks>,
  wrap = false,
): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const marked of marks.values()) {
    const { line: lineNumber, execution, libraryName, diagnostics } = marked
    const line = doc.line(lineNumber)
    if (execution === 'current') ranges.push(currentLineDecoration.range(line.from))
    if (marked.ran) ranges.push(ranLineDecoration.range(line.from))
    if (marked.stopped) ranges.push(stoppedLineDecoration.range(line.from))
    if (execution === 'library') {
      ranges.push(libraryLineDecoration.range(line.from))
      if (wrap) {
        const code = diagnosticRange(line.text)
        const at = code === null ? line.to : line.from + code.to
        ranges.push(libraryTagDecoration(libraryName, false).range(at))
      } else {
        ranges.push(libraryTagDecoration(libraryName, true).range(line.to))
      }
    }
    if (diagnostics !== null) {
      const range = diagnosticRange(line.text)
      if (range !== null) {
        ranges.push(
          underlineDecoration[diagnostics.severity].range(
            line.from + range.from,
            line.from + range.to,
          ),
        )
      }
    }
  }
  return Decoration.set(ranges, true)
}

/* ─────────────────────────────── Editor state ─────────────────────────────── */

export interface LineMarksState {
  /** What the page asked for. */
  markers: LineMarkers
  /** The marks of the lines that exist, by line number, ascending. */
  byLine: ReadonlyMap<number, LineMarks>
  decorations: DecorationSet
}

function hasNoMarkers(markers: LineMarkers): boolean {
  return (
    markers.currentLine === null &&
    markers.lastLine === null &&
    markers.libraryLine === null &&
    markers.breakpoints.length === 0 &&
    markers.diagnostics.length === 0 &&
    markers.stoppedLine === null
  )
}

function computeState(doc: Text, markers: LineMarkers, wrap: boolean): LineMarksState {
  const byLine = marksByLine(markers, doc.lines)
  return { markers, byLine, decorations: buildDecorations(doc, byLine, wrap) }
}

/** Replace all the marks. Pass the result of `mergeMarkers`, so unchanged parts keep their object. */
export const setLineMarkers = StateEffect.define<LineMarkers>()

/**
 * The marks of an editor. Read `state.field(lineMarksField)`; change them with a
 * `setLineMarkers` effect. A new value (a new object) means the marks may have moved.
 *
 * With `breakpointsFollowEdits` on, an edit of the student (not a change from the page,
 * not one that sets marks itself) carries the breakpoints along with their lines.
 */
export const lineMarksField = StateField.define<LineMarksState>({
  create: (state) => computeState(state.doc, NO_MARKERS, state.facet(wrapLongLines)),
  update(value, transaction) {
    let markers = value.markers
    let setByPage = false
    for (const effect of transaction.effects) {
      if (effect.is(setLineMarkers)) {
        markers = effect.value
        setByPage = true
      }
    }
    if (
      transaction.docChanged &&
      !setByPage &&
      transaction.annotation(pageChange) !== true &&
      transaction.startState.facet(breakpointsFollowEdits)
    ) {
      const breakpoints = mapBreakpoints(
        markers.breakpoints,
        transaction.changes,
        transaction.startState.doc,
        transaction.newDoc,
      )
      if (breakpoints !== markers.breakpoints) markers = { ...markers, breakpoints }
    }
    const wrap = transaction.state.facet(wrapLongLines)
    const wrapChanged = wrap !== transaction.startState.facet(wrapLongLines)
    if (markers === value.markers && !wrapChanged) {
      // Typing in a program without marks changes nothing here.
      if (!transaction.docChanged || hasNoMarkers(markers)) return value
    }
    return computeState(transaction.newDoc, markers, wrap)
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** The extension that starts an editor with `markers` already in place. */
export function lineMarks(markers: LineMarkers) {
  return lineMarksField.init((state) =>
    computeState(state.doc, markers, state.facet(wrapLongLines)),
  )
}
