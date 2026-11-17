import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../../../emulator'
import { marksByLine, NO_MARKERS, normalizeMarkers, type MarkerInput } from './lineMarkers'
import {
  breakpointLabel,
  currentLineLabel,
  describeBreakpointChange,
  describeLineMarks,
  describeMarkers,
  diagnosticLabel,
  LEAVE_HINT,
  libraryLineLabel,
  libraryTagText,
  oddSpaceLabel,
  ranLineLabel,
  VISIBLE_LEAVE_HINT,
} from './markerText'

function diagnostic(severity: Diagnostic['severity'], line: number, message: string): Diagnostic {
  return {
    severity,
    code: severity === 'error' ? 'bad-operand' : 'unknown-directive',
    line,
    message,
  }
}

function markers(input: Partial<MarkerInput>) {
  return normalizeMarkers({
    currentLine: null,
    libraryLine: null,
    breakpoints: [],
    diagnostics: [],
    ...input,
  })
}

describe('labels of the gutter marks', () => {
  it('name the line', () => {
    expect(breakpointLabel(12)).toBe('Breakpoint on line 12')
    expect(currentLineLabel(7)).toBe('Line 7 runs next')
    expect(libraryLineLabel(9)).toBe('Line 9: the program is inside the library')
    expect(libraryLineLabel(9, 'printf')).toBe('Line 9: the program is inside printf')
    expect(diagnosticLabel('error', 3)).toBe('Error on line 3')
    expect(diagnosticLabel('warning', 4)).toBe('Warning on line 4')
  })
})

describe('the library tag and the special space', () => {
  it('names the function when it is known', () => {
    expect(libraryTagText('printf')).toBe('inside printf')
    expect(libraryTagText(null)).toBe('inside the library')
  })

  it('gives the code of a special space', () => {
    expect(oddSpaceLabel(0xa0)).toBe('Special space (U+00A0). Delete it and type a normal space.')
  })
})

describe('LEAVE_HINT', () => {
  it('tells keyboard users how to leave the editor', () => {
    expect(LEAVE_HINT).toBe('Press Escape, then Tab, to leave the editor.')
  })
})

describe('describeMarkers', () => {
  it('says nothing when nothing is marked', () => {
    expect(describeMarkers(NO_MARKERS)).toBe('')
  })

  it('names the line that runs next and the breakpoints', () => {
    expect(describeMarkers(markers({ currentLine: 7, breakpoints: [12] }))).toBe(
      'Line 7 runs next. Breakpoint on line 12.',
    )
    expect(describeMarkers(markers({ breakpoints: [15, 12] }))).toBe(
      'Breakpoints on lines 12 and 15.',
    )
    expect(describeMarkers(markers({ breakpoints: [3, 12, 15] }))).toBe(
      'Breakpoints on lines 3, 12 and 15.',
    )
  })

  it('names the library line, and the function when it is known', () => {
    expect(describeMarkers(markers({ libraryLine: 9 }))).toBe(
      'The program is inside the library at line 9.',
    )
    expect(describeMarkers(markers({ libraryLine: 9, libraryName: 'scanf' }))).toBe(
      'The program is inside scanf at line 9.',
    )
  })

  it('names the lines with errors and with warnings', () => {
    const text = describeMarkers(
      markers({
        diagnostics: [
          diagnostic('error', 3, 'e'),
          diagnostic('error', 9, 'e'),
          diagnostic('warning', 4, 'w'),
        ],
      }),
    )
    expect(text).toBe('Errors on lines 3 and 9. Warning on line 4.')
  })

  it('counts a line with an error and a warning under both', () => {
    const text = describeMarkers(
      markers({ diagnostics: [diagnostic('error', 3, 'e'), diagnostic('warning', 3, 'w')] }),
    )
    expect(text).toBe('Error on line 3. Warning on line 3.')
  })

  it('does not read out a long list of lines', () => {
    expect(describeMarkers(markers({ breakpoints: [1, 2, 3, 4, 5, 6, 7, 8] }))).toBe(
      'Breakpoints on lines 1, 2, 3, 4, 5 and 3 more lines.',
    )
  })
})

describe('the line that just ran', () => {
  it('has a label, a sentence in the summary and one when the cursor arrives', () => {
    expect(ranLineLabel(11)).toBe('Line 11 just ran')
    expect(describeMarkers(markers({ lastLine: 11, currentLine: 12 }))).toBe(
      'Line 11 just ran. Line 12 runs next.',
    )
    // A line that ran and runs next again (a loop on one line) is said once.
    expect(describeMarkers(markers({ lastLine: 12, currentLine: 12 }))).toBe('Line 12 runs next.')
    const marks = marksByLine(markers({ lastLine: 2, currentLine: 3 }), 6).get(2)
    expect(marks === undefined ? '' : describeLineMarks(marks)).toBe('This line just ran.')
  })

  it('is short on the screen: how to leave the editor with the keyboard', () => {
    expect(VISIBLE_LEAVE_HINT).toBe('Esc, then Tab: leave the code')
  })
})

describe('describeLineMarks', () => {
  const marksOf = (input: Partial<MarkerInput>, line: number) => {
    const marks = marksByLine(markers(input), 50).get(line)
    if (marks === undefined) throw new Error(`Line ${line} has no marks.`)
    return marks
  }

  it('reads out each mark of the line as a short sentence', () => {
    expect(describeLineMarks(marksOf({ breakpoints: [5] }, 5))).toBe('Breakpoint.')
    expect(describeLineMarks(marksOf({ currentLine: 5 }, 5))).toBe('This line runs next.')
    expect(describeLineMarks(marksOf({ libraryLine: 5 }, 5))).toBe(
      'The program is inside the library at this line.',
    )
    expect(describeLineMarks(marksOf({ currentLine: 5, breakpoints: [5] }, 5))).toBe(
      'Breakpoint. This line runs next.',
    )
  })

  it('reads out the messages without the backticks around code', () => {
    const marks = marksOf(
      {
        diagnostics: [
          diagnostic('error', 7, 'Line 7: `mvo` is not an instruction. Did you mean `mov`?'),
          diagnostic('warning', 7, 'Line 7: this looks odd.'),
        ],
      },
      7,
    )
    expect(describeLineMarks(marks)).toBe(
      'Line 7: mvo is not an instruction. Did you mean mov? Line 7: this looks odd.',
    )
  })
})

describe('describeBreakpointChange', () => {
  it('tells which single line got or lost its breakpoint', () => {
    expect(describeBreakpointChange([3], [3, 9])).toBe('Breakpoint added on line 9.')
    expect(describeBreakpointChange([3, 9], [9])).toBe('Breakpoint removed from line 3.')
  })

  it('says nothing when nothing or more than one line changed', () => {
    expect(describeBreakpointChange([3], [3])).toBeNull()
    expect(describeBreakpointChange([3, 9], [])).toBeNull()
    expect(describeBreakpointChange([], [3, 9])).toBeNull()
    expect(describeBreakpointChange([3], [9])).toBeNull()
  })
})
