/**
 * The words that describe the marks of the editor: labels of the gutter marks, the hint
 * and the summary that screen readers read when the editor gets the keyboard focus, and
 * the short sentences that are read out while the text cursor moves.
 *
 * All of it is plain data → text, with no editor code, so the wording is in one place.
 */
import { joinAnd } from '../../../emulator'
import type { DiagnosticSeverity, LineMarkers, LineMarks } from './lineMarkers'

/** Tab indents, so keyboard users need to be told how to leave the editor. */
export const LEAVE_HINT = 'Press Escape, then Tab, to leave the editor.'

/** The same, short, on the screen while the focus came from the keyboard. */
export const VISIBLE_LEAVE_HINT = 'Esc, then Tab: leave the code'

/** The word shown (and read) in front of a diagnostic message. */
export const SEVERITY_WORD: Readonly<Record<DiagnosticSeverity, string>> = {
  error: 'Error',
  warning: 'Warning',
}

/* ───────────────────────────── Gutter mark labels ───────────────────────────── */

export function breakpointLabel(line: number): string {
  return `Breakpoint on line ${line}`
}

export function currentLineLabel(line: number): string {
  return `Line ${line} runs next`
}

export function ranLineLabel(line: number): string {
  return `Line ${line} just ran`
}

/** "printf" or, when the name is not known, "the library". */
function libraryWords(name: string | null): string {
  return name === null ? 'the library' : name
}

/** The small tag at the end of the library line: "inside printf" ("inside the library"). */
export function libraryTagText(name: string | null): string {
  return `inside ${libraryWords(name)}`
}

export function libraryLineLabel(line: number, name: string | null = null): string {
  return `Line ${line}: the program is inside ${libraryWords(name)}`
}

export function diagnosticLabel(severity: DiagnosticSeverity, line: number): string {
  return `${SEVERITY_WORD[severity]} on line ${line}`
}

/** The dot that marks a space gcc cannot read (a no-break space, U+00A0, and its cousins). */
export function oddSpaceLabel(code: number): string {
  const hex = code.toString(16).toUpperCase().padStart(4, '0')
  return `Special space (U+${hex}). Delete it and type a normal space.`
}

/* ───────────────────────────────── Summary ───────────────────────────────── */

/** At most this many line numbers are listed in one sentence of the summary. */
const MAX_LISTED_LINES = 5

/** "line 3", "lines 3 and 9", "lines 3, 9 and 12", "lines 1, 2, 3, 4, 5 and 7 more lines". */
function lineList(lines: readonly number[]): string {
  if (lines.length === 1) return `line ${lines[0]}`
  if (lines.length > MAX_LISTED_LINES) {
    const shown = lines.slice(0, MAX_LISTED_LINES).join(', ')
    return `lines ${shown} and ${lines.length - MAX_LISTED_LINES} more lines`
  }
  return `lines ${joinAnd(lines.map(String))}`
}

/**
 * One short sentence per kind of mark, for the description of the text area. A screen
 * reader reads it when the editor gets the keyboard focus. '' when nothing is marked.
 */
export function describeMarkers(markers: LineMarkers): string {
  const sentences: string[] = []
  if (markers.lastLine !== null && markers.lastLine !== markers.currentLine) {
    sentences.push(`Line ${markers.lastLine} just ran.`)
  }
  if (markers.currentLine !== null) sentences.push(`Line ${markers.currentLine} runs next.`)
  if (markers.libraryLine !== null) {
    sentences.push(
      `The program is inside ${libraryWords(markers.libraryName)} at line ${markers.libraryLine}.`,
    )
  }
  if (markers.breakpoints.length > 0) {
    const word = markers.breakpoints.length === 1 ? 'Breakpoint' : 'Breakpoints'
    sentences.push(`${word} on ${lineList(markers.breakpoints)}.`)
  }
  for (const severity of ['error', 'warning'] as const) {
    const lines = markers.diagnostics
      .filter((entry) => entry.messages.some((message) => message.severity === severity))
      .map((entry) => entry.line)
    if (lines.length > 0) {
      const word = SEVERITY_WORD[severity]
      sentences.push(`${lines.length === 1 ? word : `${word}s`} on ${lineList(lines)}.`)
    }
  }
  return sentences.join(' ')
}

/* ─────────────────────────── Read out while moving ─────────────────────────── */

/** A message as speech: the backticks that mark code are not read out. */
function spoken(message: string): string {
  return message.replaceAll('`', '')
}

/**
 * What a screen reader hears when the text cursor arrives on a marked line. The gutter
 * marks are pictures beside the text, so this is how they reach a student who cannot
 * see them. '' when the line has no marks.
 */
export function describeLineMarks(marks: LineMarks): string {
  const parts: string[] = []
  if (marks.breakpoint) parts.push('Breakpoint.')
  if (marks.ran) parts.push('This line just ran.')
  if (marks.execution === 'current') parts.push('This line runs next.')
  if (marks.execution === 'library') {
    parts.push(`The program is inside ${libraryWords(marks.libraryName)} at this line.`)
  }
  for (const { message } of marks.diagnostics?.messages ?? []) parts.push(spoken(message))
  return parts.join(' ')
}

/**
 * What to read out after the breakpoints changed: a sentence when exactly one line was
 * added or removed (the student toggled it), otherwise null.
 */
export function describeBreakpointChange(
  before: readonly number[],
  after: readonly number[],
): string | null {
  const added = after.filter((line) => !before.includes(line))
  const removed = before.filter((line) => !after.includes(line))
  if (added.length === 1 && removed.length === 0) return `Breakpoint added on line ${added[0]}.`
  if (removed.length === 1 && added.length === 0) {
    return `Breakpoint removed from line ${removed[0]}.`
  }
  return null
}
