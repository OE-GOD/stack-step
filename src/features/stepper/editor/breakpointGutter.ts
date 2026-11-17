/**
 * The two columns beside the code.
 *
 *   [ !  ●  ▶ ] [ 12 ] │ code
 *    marks       line number
 *
 * The marks column has three fixed places, so marks never push each other around:
 *   `!`  an error or a warning on this line (rest the pointer on it, or tap it, to read it)
 *   ●    a breakpoint
 *   ▶    this line runs next          (⧗ the program is inside the library call of this line,
 *                                        for example inside printf; ▷ hollow: this line just
 *                                        ran, the step that the page explains)
 *
 * A click or a tap anywhere on a row of EITHER column switches the breakpoint of that
 * line on or off. The row is as tall as the line and both columns together are at least
 * 70 px wide, so it is an easy target.
 *
 * CodeMirror hides the gutters from screen readers (they would read every line number
 * aloud). The marks still carry a label for people who use a mouse and for tests; screen
 * readers get the same facts in words (see `markerText.ts` and `diagnosticTooltip.ts`).
 */
import { RangeSet, type EditorState, type Extension, type Range } from '@codemirror/state'
import {
  gutter,
  gutterLineClass,
  GutterMarker,
  lineNumbers,
  type BlockInfo,
  type EditorView,
} from '@codemirror/view'
import {
  diagnosticBadge,
  hideLineMessage,
  showLineMessage,
  shownMessageLine,
} from './diagnosticTooltip'
import { lineMarksField, type LineMarks } from './lineMarkers'
import {
  breakpointLabel,
  currentLineLabel,
  diagnosticLabel,
  libraryLineLabel,
  ranLineLabel,
} from './markerText'

const SVG = 'http://www.w3.org/2000/svg'

/** A 12 × 12 picture drawn with one filled path. */
function icon(className: string, path: string, label: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  const title = document.createElementNS(SVG, 'title')
  title.textContent = label
  const shape = document.createElementNS(SVG, 'path')
  shape.setAttribute('d', path)
  svg.append(title, shape)
  return svg
}

/** ▶ */
const ARROW_PATH = 'M2 .8 11 6l-9 5.2z'
/** ⧗ */
const HOURGLASS_PATH = 'M2 .5h8v2L7.1 6 10 9.5v2H2v-2L4.9 6 2 2.5z'

function slot(name: string, content: Element | null): HTMLElement {
  const element = document.createElement('span')
  element.className = `cm-ss-slot cm-ss-slot-${name}`
  if (content !== null) element.append(content)
  return element
}

/** The `!` mark of a line. The pointer on it (or a tap) opens the message of the line. */
function diagnosticMark(view: EditorView, marks: LineMarks): HTMLElement | null {
  if (marks.diagnostics === null) return null
  const { line } = marks
  const badge = diagnosticBadge(marks.diagnostics.severity)
  badge.setAttribute('role', 'img')
  badge.setAttribute('aria-label', diagnosticLabel(marks.diagnostics.severity, line))

  // Close the box when the pointer leaves, but only a box that this mark opened.
  let opened = false
  const open = () => {
    if (shownMessageLine(view.state) === line) return
    opened = showLineMessage(view, line, 'pointer')
  }
  badge.addEventListener('mouseenter', open)
  // A second tap on a touch screen brings no new "enter", so a click opens the box too.
  badge.addEventListener('click', open)
  badge.addEventListener('mouseleave', () => {
    if (opened) hideLineMessage(view)
    opened = false
  })
  return badge
}

/** All the marks of one line, drawn in their three places. */
class LineMarksMarker extends GutterMarker {
  readonly marks: LineMarks
  override elementClass: string

  constructor(marks: LineMarks) {
    super()
    this.marks = marks
    this.elementClass = marks.breakpoint ? 'cm-ss-row-breakpoint' : ''
  }

  override eq(other: LineMarksMarker): boolean {
    const a = this.marks
    const b = other.marks
    return (
      a.line === b.line &&
      a.breakpoint === b.breakpoint &&
      a.execution === b.execution &&
      a.libraryName === b.libraryName &&
      a.ran === b.ran &&
      a.diagnostics === b.diagnostics
    )
  }

  override toDOM(view: EditorView): Node {
    const { line, breakpoint, execution, libraryName, ran } = this.marks
    const row = document.createElement('span')
    row.className = 'cm-ss-marks-row'

    let dot: HTMLElement | null = null
    if (breakpoint) {
      dot = document.createElement('span')
      dot.className = 'cm-ss-breakpoint'
      dot.setAttribute('role', 'img')
      dot.setAttribute('aria-label', breakpointLabel(line))
      dot.title = breakpointLabel(line)
    }

    let pointer: SVGSVGElement | null = null
    if (execution === 'current') {
      pointer = icon('cm-ss-arrow', ARROW_PATH, currentLineLabel(line))
    } else if (execution === 'library') {
      pointer = icon('cm-ss-hourglass', HOURGLASS_PATH, libraryLineLabel(line, libraryName))
    } else if (ran) {
      pointer = icon('cm-ss-ran', ARROW_PATH, ranLineLabel(line))
    }

    row.append(
      slot('diagnostic', diagnosticMark(view, this.marks)),
      slot('breakpoint', dot),
      slot('execution', pointer),
    )
    return row
  }
}

/** Adds a class to every gutter cell of a line (both columns). It draws nothing itself. */
class RowClassMarker extends GutterMarker {
  override elementClass: string

  constructor(className: string) {
    super()
    this.elementClass = className
  }

  override eq(other: RowClassMarker): boolean {
    return this.elementClass === other.elementClass
  }
}

const currentRow = new RowClassMarker('cm-ss-row-current')
const libraryRow = new RowClassMarker('cm-ss-row-library')

/** The gutter cells of the line that runs next (or of the library line) get a class. */
function rowClasses(state: EditorState): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = []
  for (const { line, execution } of state.field(lineMarksField).byLine.values()) {
    if (execution === null) continue
    const marker = execution === 'current' ? currentRow : libraryRow
    ranges.push(marker.range(state.doc.line(line).from))
  }
  return RangeSet.of(ranges)
}

function lineNumberOf(view: EditorView, block: BlockInfo): number {
  return view.state.doc.lineAt(block.from).number
}

/**
 * The marks column and the line numbers. `onToggleBreakpoint` is called with the line
 * number when a row of either column is clicked or tapped.
 */
export function markerGutters(onToggleBreakpoint: (line: number) => void): Extension {
  type Handler = (view: EditorView, block: BlockInfo, event: Event) => boolean

  const isMainButton = (event: Event): event is MouseEvent =>
    event instanceof MouseEvent && event.button === 0

  // Handled (true) means "do not do what the browser would do": the keyboard focus stays
  // where it is and no text gets selected. The click that follows still happens.
  const mousedown: Handler = (_view, _block, event) => isMainButton(event)

  const click: Handler = (view, block, event) => {
    if (!isMainButton(event)) return false
    // The `!` mark shows its message. It is not a place to set a breakpoint.
    if (event.target instanceof Element && event.target.closest('.cm-ss-diagnostic') !== null) {
      return true
    }
    // Below the last line there is no line to stop on.
    const top = view.documentTop + block.top
    if (event.clientY < top || event.clientY > top + block.height) return false
    onToggleBreakpoint(lineNumberOf(view, block))
    return true
  }

  const domEventHandlers = { mousedown, click }

  return [
    gutter({
      class: 'cm-ss-marks',
      // Every row is there, also without a mark: it is the place to click.
      renderEmptyElements: true,
      lineMarker(view, block) {
        const marks = view.state.field(lineMarksField).byLine.get(lineNumberOf(view, block))
        return marks === undefined ? null : new LineMarksMarker(marks)
      },
      lineMarkerChange: (update) =>
        update.startState.field(lineMarksField) !== update.state.field(lineMarksField),
      domEventHandlers,
    }),
    lineNumbers({ domEventHandlers }),
    gutterLineClass.compute([lineMarksField], rowClasses),
  ]
}
