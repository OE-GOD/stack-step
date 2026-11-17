import { history, redo, undo } from '@codemirror/commands'
import { EditorState, Text, type ChangeSpec } from '@codemirror/state'
import type { DecorationSet } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../../../emulator'
import {
  activeLine,
  breakpointsFollowEdits,
  buildDecorations,
  diagnosticRange,
  lineMarks,
  lineMarksField,
  mapBreakpoints,
  marksByLine,
  mergeMarkers,
  NO_MARKERS,
  normalizeMarkers,
  pageChange,
  setLineMarkers,
  type LineMarkers,
  type MarkerInput,
} from './lineMarkers'

function error(line: number, message = `Line ${line}: something is wrong.`): Diagnostic {
  return { severity: 'error', code: 'bad-operand', line, message }
}

function warning(line: number, message = `Line ${line}: this looks odd.`): Diagnostic {
  return { severity: 'warning', code: 'unknown-directive', line, message }
}

function markers(input: Partial<MarkerInput>): LineMarkers {
  return normalizeMarkers({
    currentLine: null,
    libraryLine: null,
    breakpoints: [],
    diagnostics: [],
    ...input,
  })
}

const PROGRAM = [
  'main:', // 1
  '    push    rbp            # save it', // 2
  '    mov     rbp, rsp', // 3
  '', // 4
  '    call    printf@PLT     # print', // 5
  '    ret', // 6
]
const DOC = Text.of(PROGRAM)

interface Seen {
  from: number
  to: number
  /** The class of a line or mark decoration; 'widget' for the library tag. */
  what: string
}

function decorationsOf(set: DecorationSet): Seen[] {
  const seen: Seen[] = []
  for (const cursor = set.iter(); cursor.value !== null; cursor.next()) {
    const spec = cursor.value.spec as { class?: string; widget?: unknown }
    seen.push({
      from: cursor.from,
      to: cursor.to,
      what: spec.widget === undefined ? (spec.class ?? '') : 'widget',
    })
  }
  return seen
}

describe('normalizeMarkers', () => {
  it('sorts the breakpoints and drops repeats and impossible line numbers', () => {
    const result = markers({ breakpoints: [9, 3, 9, 0, -2, 4.5, Number.NaN, 12] })
    expect(result.breakpoints).toEqual([3, 9, 12])
  })

  it('drops a current or library line that cannot be a line', () => {
    expect(markers({ currentLine: 0, libraryLine: -1 })).toEqual(NO_MARKERS)
    expect(markers({ currentLine: 2.5 }).currentLine).toBeNull()
    expect(markers({ currentLine: 7, libraryLine: 9 })).toMatchObject({
      currentLine: 7,
      libraryLine: 9,
    })
  })

  it('leaves out diagnostics about the whole program (line 0)', () => {
    const result = markers({ diagnostics: [warning(0, 'The program has no `main` label.')] })
    expect(result.diagnostics).toEqual([])
  })

  it('puts the diagnostics of one line together, errors first, lines ascending', () => {
    const result = markers({
      diagnostics: [warning(5, 'w5'), error(2, 'e2'), error(5, 'e5'), warning(3, 'w3')],
    })
    expect(result.diagnostics).toEqual([
      { line: 2, severity: 'error', messages: [{ severity: 'error', message: 'e2' }] },
      { line: 3, severity: 'warning', messages: [{ severity: 'warning', message: 'w3' }] },
      {
        line: 5,
        severity: 'error',
        messages: [
          { severity: 'error', message: 'e5' },
          { severity: 'warning', message: 'w5' },
        ],
      },
    ])
  })

  it('keeps one copy of a message that is given twice', () => {
    const result = markers({ diagnostics: [error(2, 'same'), error(2, 'same')] })
    expect(result.diagnostics[0]?.messages).toHaveLength(1)
  })
})

describe('mergeMarkers', () => {
  const before = markers({ currentLine: 3, breakpoints: [2, 5], diagnostics: [error(6)] })

  it('returns the old object when nothing changed', () => {
    const same = markers({ currentLine: 3, breakpoints: [5, 2], diagnostics: [error(6)] })
    expect(same).not.toBe(before)
    expect(mergeMarkers(before, same)).toBe(before)
  })

  it('keeps the old object of every part that did not change', () => {
    const moved = mergeMarkers(
      before,
      markers({ currentLine: 4, breakpoints: [2, 5], diagnostics: [error(6)] }),
    )
    expect(moved).not.toBe(before)
    expect(moved.currentLine).toBe(4)
    expect(moved.breakpoints).toBe(before.breakpoints)
    expect(moved.diagnostics).toBe(before.diagnostics)
  })

  it('sees a changed breakpoint, message or severity', () => {
    const added = mergeMarkers(before, { ...before, breakpoints: [2, 5, 6] })
    expect(added.breakpoints).toEqual([2, 5, 6])
    expect(added.diagnostics).toBe(before.diagnostics)

    const reworded = mergeMarkers(before, markers({ ...before, diagnostics: [error(6, 'new')] }))
    expect(reworded.diagnostics).not.toBe(before.diagnostics)

    const softer = mergeMarkers(
      before,
      markers({ currentLine: 3, breakpoints: [2, 5], diagnostics: [warning(6)] }),
    )
    expect(softer.diagnostics[0]?.severity).toBe('warning')
  })
})

describe('activeLine', () => {
  it('is the line that runs next, else the library line, else nothing', () => {
    expect(activeLine(markers({ currentLine: 4, libraryLine: 9 }))).toBe(4)
    expect(activeLine(markers({ libraryLine: 9 }))).toBe(9)
    expect(activeLine(NO_MARKERS)).toBeNull()
  })
})

describe('marksByLine', () => {
  it('collects the marks of each line, in ascending order', () => {
    const marks = marksByLine(
      markers({
        currentLine: 3,
        libraryLine: 5,
        breakpoints: [5, 2],
        diagnostics: [error(2), warning(6)],
      }),
      6,
    )
    expect([...marks.keys()]).toEqual([2, 3, 5, 6])
    expect(marks.get(2)).toMatchObject({ breakpoint: true, execution: null })
    expect(marks.get(2)?.diagnostics?.severity).toBe('error')
    expect(marks.get(3)).toEqual({
      line: 3,
      breakpoint: false,
      execution: 'current',
      libraryName: null,
      ran: false,
      stopped: false,
      diagnostics: null,
    })
    expect(marks.get(5)).toMatchObject({ breakpoint: true, execution: 'library' })
    expect(marks.get(6)?.diagnostics?.severity).toBe('warning')
  })

  it('gives the library line the name of the function that runs', () => {
    const marks = marksByLine(markers({ libraryLine: 5, libraryName: 'printf' }), 6)
    expect(marks.get(5)).toMatchObject({ execution: 'library', libraryName: 'printf' })
  })

  it('leaves out lines that the document does not have', () => {
    const marks = marksByLine(
      markers({ currentLine: 40, breakpoints: [2, 7], diagnostics: [error(9)] }),
      6,
    )
    expect([...marks.keys()]).toEqual([2])
  })

  it('marks the line that just ran, unless it also runs next or holds the library call', () => {
    const marks = marksByLine(markers({ currentLine: 3, lastLine: 2 }), 6)
    expect(marks.get(2)).toMatchObject({ ran: true, execution: null })
    expect(marks.get(3)).toMatchObject({ ran: false, execution: 'current' })
    // A jump to itself: the line ran and runs next again; it shows as "runs next".
    expect(marksByLine(markers({ currentLine: 3, lastLine: 3 }), 6).get(3)).toMatchObject({
      ran: false,
      execution: 'current',
    })
    // The call line while the program is inside the library: "inside printf", not "ran".
    expect(marksByLine(markers({ libraryLine: 5, lastLine: 5 }), 6).get(5)).toMatchObject({
      ran: false,
      execution: 'library',
    })
  })

  it('marks the line of a run-time error like an error, with its message', () => {
    const marks = marksByLine(
      markers({ lastLine: 6, runtimeError: { line: 6, message: 'Line 6: `ret` took 0x5.' } }),
      6,
    )
    expect(marks.get(6)).toMatchObject({ stopped: true, ran: true })
    expect(marks.get(6)?.diagnostics).toEqual({
      line: 6,
      severity: 'error',
      messages: [{ severity: 'error', message: 'Line 6: `ret` took 0x5.' }],
    })
    // A run-time error without a line marks nothing.
    expect(marksByLine(markers({ runtimeError: { line: 0, message: 'Somewhere.' } }), 6).size).toBe(
      0,
    )
  })

  it('shows a line that is given as both as the line that runs next', () => {
    const marks = marksByLine(markers({ currentLine: 3, libraryLine: 3 }), 6)
    expect(marks.get(3)?.execution).toBe('current')
  })
})

describe('diagnosticRange', () => {
  const marked = (line: string): string | null => {
    const range = diagnosticRange(line)
    return range === null ? null : line.slice(range.from, range.to)
  }

  it('covers the code without the space around it', () => {
    expect(marked('    mov     rbp, rsp')).toBe('mov     rbp, rsp')
    expect(marked('\tmov\trax, 5  \t')).toBe('mov\trax, 5')
    expect(diagnosticRange('    ret')).toEqual({ from: 4, to: 7 })
  })

  it('stops before the comment at the end of the line', () => {
    expect(marked('    push    rbp            # save it')).toBe('push    rbp')
    expect(marked('main: ret # done')).toBe('main: ret')
  })

  it('does not take a # inside a string for a comment', () => {
    expect(marked('    .string "a # b"   # text')).toBe('.string "a # b"')
  })

  it('covers a line that holds only a comment', () => {
    expect(marked('   # only a comment  ')).toBe('# only a comment')
    expect(marked('// not our comment style')).toBe('// not our comment style')
  })

  it('has nothing to cover on a blank line', () => {
    expect(diagnosticRange('')).toBeNull()
    expect(diagnosticRange('   \t ')).toBeNull()
  })
})

describe('buildDecorations', () => {
  const at = (line: number) => DOC.line(line)

  it('tints the line that runs next', () => {
    const set = buildDecorations(DOC, marksByLine(markers({ currentLine: 3 }), DOC.lines))
    expect(decorationsOf(set)).toEqual([
      { from: at(3).from, to: at(3).from, what: 'cm-ss-line-current' },
    ])
  })

  it('marks the library line and puts the tag at its end', () => {
    const set = buildDecorations(DOC, marksByLine(markers({ libraryLine: 5 }), DOC.lines))
    expect(decorationsOf(set)).toEqual([
      { from: at(5).from, to: at(5).from, what: 'cm-ss-line-library' },
      { from: at(5).to, to: at(5).to, what: 'widget' },
    ])
  })

  it('puts the tag right after the instruction, before the comment, when lines wrap', () => {
    const set = buildDecorations(DOC, marksByLine(markers({ libraryLine: 5 }), DOC.lines), true)
    expect(decorationsOf(set)).toEqual([
      { from: at(5).from, to: at(5).from, what: 'cm-ss-line-library' },
      {
        from: at(5).from + '    call    printf@PLT'.length,
        to: at(5).from + '    call    printf@PLT'.length,
        what: 'widget',
      },
    ])
  })

  it('draws the line that just ran and the line of a run-time error', () => {
    const set = buildDecorations(
      DOC,
      marksByLine(
        markers({ lastLine: 2, runtimeError: { line: 6, message: 'Line 6: it failed.' } }),
        DOC.lines,
      ),
    )
    expect(decorationsOf(set)).toEqual([
      { from: at(2).from, to: at(2).from, what: 'cm-ss-line-ran' },
      { from: at(6).from, to: at(6).from, what: 'cm-ss-line-stopped' },
      { from: at(6).from + 4, to: at(6).to, what: 'cm-ss-underline cm-ss-underline-error' },
    ])
  })

  it('underlines the code of a line with an error or a warning', () => {
    const set = buildDecorations(
      DOC,
      marksByLine(markers({ diagnostics: [error(2), warning(6)] }), DOC.lines),
    )
    expect(decorationsOf(set)).toEqual([
      {
        from: at(2).from + 4,
        to: at(2).from + '    push    rbp'.length,
        what: 'cm-ss-underline cm-ss-underline-error',
      },
      { from: at(6).from + 4, to: at(6).to, what: 'cm-ss-underline cm-ss-underline-warning' },
    ])
  })

  it('uses the error look when a line has an error and a warning', () => {
    const set = buildDecorations(
      DOC,
      marksByLine(markers({ diagnostics: [warning(3), error(3)] }), DOC.lines),
    )
    expect(decorationsOf(set).map((seen) => seen.what)).toEqual([
      'cm-ss-underline cm-ss-underline-error',
    ])
  })

  it('draws nothing in the text for a breakpoint, a blank line or a missing line', () => {
    const set = buildDecorations(
      DOC,
      marksByLine(markers({ breakpoints: [2, 3], diagnostics: [error(4), error(99)] }), DOC.lines),
    )
    expect(decorationsOf(set)).toEqual([])
  })

  it('puts everything of one line in place together', () => {
    const set = buildDecorations(
      DOC,
      marksByLine(
        markers({ libraryLine: 5, breakpoints: [5], diagnostics: [warning(5)] }),
        DOC.lines,
      ),
    )
    expect(decorationsOf(set)).toEqual([
      { from: at(5).from, to: at(5).from, what: 'cm-ss-line-library' },
      {
        from: at(5).from + 4,
        to: at(5).from + '    call    printf@PLT'.length,
        what: 'cm-ss-underline cm-ss-underline-warning',
      },
      { from: at(5).to, to: at(5).to, what: 'widget' },
    ])
  })
})

describe('lineMarksField', () => {
  const source = PROGRAM.join('\n')

  it('starts without marks, or with the marks it is given', () => {
    const plain = EditorState.create({ doc: source, extensions: [lineMarksField] })
    expect(plain.field(lineMarksField).markers).toBe(NO_MARKERS)
    expect(plain.field(lineMarksField).byLine.size).toBe(0)

    const start = markers({ currentLine: 2, breakpoints: [3] })
    const marked = EditorState.create({ doc: source, extensions: [lineMarks(start)] })
    expect(marked.field(lineMarksField).markers).toBe(start)
    expect([...marked.field(lineMarksField).byLine.keys()]).toEqual([2, 3])
  })

  it('takes new marks from an effect', () => {
    const state = EditorState.create({ doc: source, extensions: [lineMarksField] })
    const next = markers({ currentLine: 3, diagnostics: [error(6)] })
    const after = state.update({ effects: setLineMarkers.of(next) }).state
    expect(after.field(lineMarksField).markers).toBe(next)
    expect(decorationsOf(after.field(lineMarksField).decorations).map((seen) => seen.what)).toEqual(
      ['cm-ss-line-current', 'cm-ss-underline cm-ss-underline-error'],
    )
  })

  it('keeps a mark on its line NUMBER when lines are added above it', () => {
    const start = markers({ currentLine: 3 })
    const state = EditorState.create({ doc: source, extensions: [lineMarks(start)] })
    const after = state.update({ changes: { from: 0, insert: '# new first line\n' } }).state
    const [seen] = decorationsOf(after.field(lineMarksField).decorations)
    // Line 3 is now the old line 2.
    expect(seen?.from).toBe(after.doc.line(3).from)
    expect(after.doc.line(3).text).toBe(PROGRAM[1])
  })

  it('shows a mark again when its line comes into being', () => {
    const start = markers({ breakpoints: [8] })
    const state = EditorState.create({ doc: source, extensions: [lineMarks(start)] })
    expect(state.field(lineMarksField).byLine.size).toBe(0)
    const after = state.update({ changes: { from: state.doc.length, insert: '\n\n    nop' } }).state
    expect([...after.field(lineMarksField).byLine.keys()]).toEqual([8])
  })

  it('does no work while the student types in a program without marks', () => {
    const state = EditorState.create({ doc: source, extensions: [lineMarksField] })
    const after = state.update({ changes: { from: 0, insert: 'x' } }).state
    expect(after.field(lineMarksField)).toBe(state.field(lineMarksField))
  })

  it('keeps its value when a transaction changes neither the text nor the marks', () => {
    const start = markers({ currentLine: 2 })
    const state = EditorState.create({ doc: source, extensions: [lineMarks(start)] })
    const after = state.update({ selection: { anchor: 3 } }).state
    expect(after.field(lineMarksField)).toBe(state.field(lineMarksField))
  })

  it('keeps breakpoints on their line NUMBERS while following is off', () => {
    const state = EditorState.create({
      doc: source,
      extensions: [lineMarks(markers({ breakpoints: [3] }))],
    })
    const after = state.update({ changes: { from: 0, insert: '# new first line\n' } }).state
    expect(after.field(lineMarksField).markers.breakpoints).toEqual([3])
  })
})

describe('library names', () => {
  it('keeps the name only with a library line, without spaces around it', () => {
    expect(markers({ libraryLine: 5, libraryName: ' printf ' }).libraryName).toBe('printf')
    expect(markers({ libraryLine: 5, libraryName: '  ' }).libraryName).toBeNull()
    expect(markers({ libraryLine: 5 }).libraryName).toBeNull()
    expect(markers({ libraryLine: null, libraryName: 'printf' }).libraryName).toBeNull()
  })

  it('counts a new name as a change of the marks', () => {
    const previous = markers({ libraryLine: 5, libraryName: 'printf' })
    expect(mergeMarkers(previous, markers({ libraryLine: 5, libraryName: 'printf' }))).toBe(
      previous,
    )
    const next = mergeMarkers(previous, markers({ libraryLine: 5, libraryName: 'scanf' }))
    expect(next).not.toBe(previous)
    expect(next.libraryName).toBe('scanf')
  })
})

describe('breakpoints that follow their line', () => {
  const source = PROGRAM.join('\n')
  const line = (number: number) => DOC.line(number)

  /** The breakpoints after one change of PROGRAM. */
  function after(lines: number[], changes: ChangeSpec): readonly number[] {
    const transaction = EditorState.create({ doc: source }).update({ changes })
    return mapBreakpoints(
      lines,
      transaction.changes,
      transaction.startState.doc,
      transaction.newDoc,
    )
  }

  it('move down when a line is added above them', () => {
    expect(after([3, 5], { from: line(3).from, insert: '    nop\n' })).toEqual([4, 6])
    // Enter at the end of the line above.
    expect(after([3], { from: line(2).to, insert: '\n' })).toEqual([4])
    // Several lines pasted at the very start of the line.
    expect(after([3], { from: line(3).from, insert: 'a:\n    nop\n' })).toEqual([5])
  })

  it('stay when the line itself is typed in or split after its start', () => {
    expect(after([3], { from: line(3).from, insert: '  ' })).toEqual([3])
    expect(after([3, 5], { from: line(3).from + 8, insert: '\n' })).toEqual([3, 6])
    // A line that is only emptied still exists.
    expect(after([3], { from: line(3).from, to: line(3).to })).toEqual([3])
  })

  it('go away with their line, and the ones below move up', () => {
    expect(after([3, 5], { from: line(3).from, to: line(4).from })).toEqual([4])
    // The last line: its text and the line break before it.
    expect(after([2, 6], { from: line(5).to, to: line(6).to })).toEqual([2])
    // A selection across several lines takes the lines inside it.
    expect(after([2, 3, 4], { from: line(2).from + 4, to: line(5).from })).toEqual([2])
  })

  it('go up with the line that is joined to the line above, and meet as one', () => {
    expect(after([3], { from: line(2).to, to: line(3).from })).toEqual([2])
    expect(after([2, 3], { from: line(2).to, to: line(3).from })).toEqual([2])
  })

  it('return the same list when nothing moved, and keep numbers past the end', () => {
    const lines = [2, 9]
    expect(after(lines, { from: line(2).from + 4, insert: 'x' })).toBe(lines)
    expect(after([9], { from: 0, insert: '\n' })).toEqual([9])
  })

  describe('in the editor state', () => {
    function start(lines: number[]): EditorState {
      return EditorState.create({
        doc: source,
        extensions: [lineMarks(markers({ breakpoints: lines })), breakpointsFollowEdits.of(true)],
      })
    }

    it("follow the student's edits", () => {
      const state = start([3])
      const next = state.update({ changes: { from: line(2).to, insert: '\n    nop' } }).state
      expect(next.field(lineMarksField).markers.breakpoints).toEqual([4])
      // The marks are drawn on the new line.
      expect([...next.field(lineMarksField).byLine.keys()]).toEqual([4])
    })

    it('follow Undo and Redo back and forth', () => {
      let state = EditorState.create({
        doc: source,
        extensions: [
          history(),
          lineMarks(markers({ breakpoints: [5] })),
          breakpointsFollowEdits.of(true),
        ],
      })
      const run = (command: typeof undo) => {
        command({ state, dispatch: (transaction) => (state = transaction.state) })
      }
      state = state.update({
        changes: { from: line(1).to, insert: '\n    nop\n    nop' },
        userEvent: 'input',
      }).state
      expect(state.field(lineMarksField).markers.breakpoints).toEqual([7])
      run(undo)
      expect(state.field(lineMarksField).markers.breakpoints).toEqual([5])
      run(redo)
      expect(state.field(lineMarksField).markers.breakpoints).toEqual([7])
    })

    it('do not move for a change from the page, or for one that sets the marks itself', () => {
      const state = start([3])
      const fromPage = state.update({
        changes: { from: 0, insert: '# loaded\n' },
        annotations: pageChange.of(true),
      }).state
      expect(fromPage.field(lineMarksField).markers.breakpoints).toEqual([3])

      const withMarks = state.update({
        changes: { from: 0, insert: '# loaded\n' },
        effects: setLineMarkers.of(markers({ breakpoints: [3] })),
      }).state
      expect(withMarks.field(lineMarksField).markers.breakpoints).toEqual([3])
    })
  })
})
