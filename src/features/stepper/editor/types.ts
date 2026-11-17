import type { Ref } from 'react'
import type { Diagnostic } from '../../../emulator'

/**
 * The contract between the stepper page and the code editor.
 *
 * The editor is a controlled component: the page owns the text. The editor is loaded
 * lazily (`React.lazy(() => import('./editor/CodeEditor'))`) because CodeMirror is the
 * largest dependency on the site.
 */
export interface CodeEditorProps {
  /** The program text. */
  value: string
  /** Called on every edit with the new text. */
  onChange: (value: string) => void
  /**
   * The 1-based line that runs next. Shown with a clear marker (an arrow in the gutter
   * and a tinted line), and kept in view. null = no such line (not started with a valid
   * program, halted, or inside a library function).
   */
  currentLine: number | null
  /**
   * While the machine is inside a library function (the second half of
   * `call printf@PLT`): the line of that call. Shown in a different style from
   * `currentLine` ("inside printf"). null otherwise.
   */
  libraryLine: number | null
  /**
   * The name of that library function ("printf"), so the tag on the library line reads
   * "inside printf". Missing or null: the tag reads "inside the library".
   */
  libraryName?: string | null
  /** Lines that have a breakpoint (1-based, ascending). */
  breakpoints: readonly number[]
  /** The student clicked the gutter (or used the keyboard command) on this line. */
  onToggleBreakpoint: (line: number) => void
  /**
   * When given, a breakpoint stays with its line of code while the student edits: a line
   * added above moves it down, deleting its line removes it, Undo moves it back. The
   * editor then calls this (right after `onChange`) with the new list; pass that list back
   * as `breakpoints`. When missing, breakpoints keep their line numbers.
   *
   * Changes from the page (a new `value`) never move breakpoints: the page knows them.
   */
  onBreakpointsChange?: (lines: number[]) => void
  /** Assembler errors and warnings to mark on their lines (`line` 0 = whole program). */
  diagnostics: readonly Diagnostic[]
  /**
   * The line that just ran: the step the page explains. It gets a hollow arrow (▷) and a
   * dashed bar, so it looks different from the line that runs NEXT (▶ and a tint).
   * Missing or null: no such mark.
   */
  lastLine?: number | null
  /**
   * A run-time error stopped the program on this line: the line is marked like an error
   * (a tint, a wavy underline, the `!` mark), and its message opens like the assembler's.
   */
  runtimeError?: { line: number; message: string } | null
  /**
   * Long lines wrap onto the next row (wide screens), with a hanging indent. The
   * "inside printf" tag then sits right after the instruction. Default false: long lines
   * scroll sideways, and the tag gets a row of its own under the call line, where it can
   * never cover code.
   */
  wrapLines?: boolean
  /**
   * How many pixels at the bottom of the screen fixed controls cover (the control bar of a
   * phone). A line counts as "in sight" only above them. Default 0.
   */
  coveredBottom?: number
  /** Accessible name of the text area, e.g. "Assembly code". */
  ariaLabel: string
  /** Extra classes for the outer element (the page controls the height). */
  className?: string
  /** Commands the page can give the editor (see `CodeEditorHandle`). */
  ref?: Ref<CodeEditorHandle>
}

/** What the page can ask the editor to do, through `ref`. */
export interface CodeEditorHandle {
  /**
   * Put the text cursor at the start of the code on `line`, scroll it into sight and give
   * the editor the keyboard focus (the message of a marked line then opens). Lines that
   * do not exist are ignored.
   */
  goToLine: (line: number) => void
  /**
   * Show a line without taking the keyboard focus (a phone would open its keyboard):
   * the editor comes into the page's view if it is out of it, and the line into the
   * editor's view. Lines that do not exist are ignored.
   */
  showLine: (line: number) => void
}
