/**
 * How the editor looks.
 *
 * Every color is one of the site's CSS variables (src/index.css), so the editor turns
 * dark the moment <html> gets the `dark` class. CodeMirror does not need to be told.
 *
 * Sizes: 14 px text and 22 px lines with a mouse; 16 px text and 26 px lines on touch
 * screens (iOS zooms the page when a text field with smaller text gets the focus).
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/** The site's font stacks, with the same lists as a fallback when a variable is missing. */
const MONO =
  'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)'
const SANS =
  'var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)'

/** A thin dashed line, used above and below the line whose library call is running. */
const DASHES = 'repeating-linear-gradient(90deg, var(--c-primary) 0 5px, transparent 5px 9px)'

/** A dashed bar down the left edge: the line that just ran. */
const DASHED_BAR = 'repeating-linear-gradient(180deg, var(--c-muted) 0 4px, transparent 4px 7px)'

/** Rows that a long line wraps onto start this far in (a hanging indent). */
const HANGING_INDENT = '4ch'

/** Width of one place in the marks column, and of the column (three places + 2 + 2 px). */
const SLOT = 14
const MARKS_WIDTH = 3 * SLOT + 4

const theme = EditorView.theme({
  /* ───────────────────────────── Frame ───────────────────────────── */
  '&': {
    height: '100%',
    borderRadius: 'inherit',
    backgroundColor: 'var(--c-code-bg)',
    color: 'var(--c-ink)',
    fontSize: '14px',
  },
  // CodeMirror's own focus mark is a thin dotted line. Ours is drawn on top of the
  // content, inside the frame, so no parent can cut it off and no line can cover it.
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused::after': {
    content: '""',
    position: 'absolute',
    inset: '0',
    zIndex: '1',
    border: '2px solid var(--c-focus)',
    borderRadius: 'inherit',
    pointerEvents: 'none',
  },
  '.cm-scroller': {
    borderRadius: 'inherit',
    fontFamily: MONO,
    lineHeight: '22px',
    overflow: 'auto',
    // Scrolling the code sideways must not turn into the browser's "go back" swipe.
    overscrollBehaviorX: 'contain',
  },
  '.cm-content': {
    padding: '8px 0',
    caretColor: 'var(--c-ink)',
  },
  '.cm-line': { padding: '0 16px 0 10px' },
  // Wrapped long lines: the rows after the first start further in, so a wrapped comment
  // does not look like a new line of code.
  '.cm-lineWrapping .cm-line': {
    paddingLeft: `calc(10px + ${HANGING_INDENT})`,
    textIndent: `calc(-1 * ${HANGING_INDENT})`,
  },
  '.cm-line::selection, .cm-line ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--c-primary) 30%, transparent)',
  },
  '.cm-specialChar': { color: 'var(--c-bad)' },
  // A space gcc cannot read: a dot in a dashed box, as wide as one letter.
  '.cm-ss-odd-space': {
    display: 'inline-block',
    boxSizing: 'border-box',
    width: '1ch',
    border: '1px dashed var(--c-bad)',
    borderRadius: '2px',
    backgroundColor: 'var(--c-bad-soft)',
    color: 'var(--c-bad)',
    lineHeight: '1.1',
    textAlign: 'center',
  },

  /* ────────────────────────── Syntax colors ────────────────────────── */
  '.cm-asm-mnemonic': { color: 'var(--c-syn-mnemonic)', fontWeight: '700' },
  '.cm-asm-register': { color: 'var(--c-syn-register)' },
  '.cm-asm-number': { color: 'var(--c-syn-number)' },
  '.cm-asm-comment': { color: 'var(--c-syn-comment)', fontStyle: 'italic' },
  '.cm-asm-directive': { color: 'var(--c-syn-directive)' },
  '.cm-asm-string': { color: 'var(--c-syn-string)' },
  '.cm-asm-label': { fontWeight: '700' },

  /* ───────────────────────────── Gutters ───────────────────────────── */
  '.cm-gutters': {
    backgroundColor: 'var(--c-code-bg)',
    color: 'var(--c-muted)',
    border: 'none',
    borderRight: '1px solid var(--c-line)',
    cursor: 'pointer',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    // Two quick taps on a row are two taps, not "zoom in".
    touchAction: 'manipulation',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    minWidth: '26px',
    padding: '0 8px 0 2px',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-ss-marks': { width: `${MARKS_WIDTH}px` },
  '.cm-ss-marks .cm-gutterElement': { position: 'relative' },
  '.cm-ss-marks-row': {
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    paddingLeft: '2px',
  },
  '.cm-ss-slot': {
    display: 'inline-flex',
    flex: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: `${SLOT}px`,
    height: '100%',
  },
  // A dot made of borders, not of a background: Windows high-contrast mode takes
  // backgrounds away, but it keeps borders.
  '.cm-ss-breakpoint': {
    boxSizing: 'content-box',
    width: '0',
    height: '0',
    border: '5px solid var(--c-bad)',
    borderRadius: '50%',
  },
  '.cm-ss-arrow, .cm-ss-hourglass, .cm-ss-ran': {
    width: '12px',
    height: '12px',
    fill: 'var(--c-primary)',
  },
  // The line that just ran: the same arrow, hollow (a different shape from ▶).
  '.cm-ss-ran': {
    fill: 'transparent',
    stroke: 'var(--c-muted)',
    strokeWidth: '1.4px',
    strokeLinejoin: 'round',
    overflow: 'visible',
  },
  // The `!` mark: a filled square for an error, a ring for a warning (shape, not only color).
  '.cm-ss-diagnostic': {
    display: 'inline-block',
    boxSizing: 'border-box',
    flex: 'none',
    width: '12px',
    height: '14px',
    fontFamily: SANS,
    fontSize: '11px',
    fontStyle: 'normal',
    fontWeight: '800',
    lineHeight: '14px',
    textAlign: 'center',
    cursor: 'help',
  },
  '.cm-ss-diagnostic-error': {
    borderRadius: '3px',
    backgroundColor: 'var(--c-bad)',
    color: 'var(--c-code-bg)',
  },
  '.cm-ss-diagnostic-warning': {
    width: '14px',
    border: '1.5px solid var(--c-warn)',
    borderRadius: '50%',
    color: 'var(--c-warn)',
    lineHeight: '11px',
  },

  /* ─────────────────── The line that runs next / the library line ─────────────────── */
  '.cm-ss-line-current, .cm-ss-row-current': { backgroundColor: 'var(--c-current-line)' },
  // A solid bar inside the line too: the tint alone is faint on a projector.
  '.cm-ss-line-current': { boxShadow: 'inset 3px 0 0 var(--c-primary)' },
  '.cm-ss-row-current': { color: 'var(--c-ink)', fontWeight: '700' },
  '.cm-ss-line-ran': {
    backgroundImage: DASHED_BAR,
    backgroundSize: '3px 100%',
    backgroundPosition: '0 0',
    backgroundRepeat: 'no-repeat',
  },
  // The line where a run-time error stopped the program (with the error's underline).
  '.cm-ss-line-stopped': {
    backgroundColor: 'var(--c-bad-soft)',
    boxShadow: 'inset 3px 0 0 var(--c-bad)',
  },
  '.cm-ss-line-library, .cm-ss-row-library': {
    backgroundImage: `${DASHES}, ${DASHES}`,
    backgroundSize: '100% 1px',
    backgroundPosition: '0 0, 0 100%',
    backgroundRepeat: 'no-repeat',
  },
  '.cm-ss-row-library': { color: 'var(--c-ink)', fontWeight: '700' },
  // The tag "inside printf": right after the instruction when lines wrap, or alone in a
  // row under the call line (`.cm-ss-library-row`) when they scroll sideways. It never
  // covers code.
  '.cm-ss-library-tag': {
    display: 'inline-block',
    margin: '0 1.5ch',
    padding: '0 8px',
    textIndent: '0',
    border: '1px dashed var(--c-primary)',
    borderRadius: '999px',
    backgroundColor: 'var(--c-primary-soft)',
    color: 'var(--c-primary)',
    fontFamily: SANS,
    fontSize: '12px',
    fontStyle: 'normal',
    fontWeight: '600',
    lineHeight: '16px',
    whiteSpace: 'nowrap',
    userSelect: 'none',
    WebkitUserSelect: 'none',
  },
  '.cm-ss-library-row': {
    padding: '1px 16px 3px calc(10px + 4ch)',
    lineHeight: '18px',
  },
  '.cm-ss-library-row .cm-ss-library-tag': { marginLeft: '0' },

  /* ─────────────────────── Errors and warnings ─────────────────────── */
  '.cm-ss-underline': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'wavy',
    textDecorationThickness: '1px',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '2px',
  },
  '.cm-ss-underline-error': { textDecorationColor: 'var(--c-bad)' },
  '.cm-ss-underline-warning': { textDecorationColor: 'var(--c-warn)' },

  '.cm-tooltip': {
    border: '1px solid var(--c-line-strong)',
    borderRadius: '8px',
    backgroundColor: 'var(--c-surface)',
    color: 'var(--c-ink)',
    boxShadow: '0 6px 20px rgb(0 0 0 / 0.2)',
  },
  '.cm-ss-message': {
    boxSizing: 'border-box',
    maxWidth: 'min(26rem, calc(100vw - 24px))',
    padding: '8px 12px',
    fontFamily: SANS,
    fontSize: '14px',
    lineHeight: '1.45',
    overflowWrap: 'anywhere',
  },
  '.cm-ss-message-row': { margin: '0' },
  '.cm-ss-message-row + .cm-ss-message-row': { marginTop: '6px' },
  '.cm-ss-message .cm-ss-diagnostic': { verticalAlign: '-2px', cursor: 'default' },
  '.cm-ss-message-error .cm-ss-message-kind': { color: 'var(--c-bad)' },
  '.cm-ss-message-warning .cm-ss-message-kind': { color: 'var(--c-warn)' },
  '.cm-ss-message code': {
    padding: '1px 4px',
    borderRadius: '3px',
    backgroundColor: 'color-mix(in srgb, var(--c-ink) 9%, transparent)',
    fontFamily: MONO,
    fontSize: '0.9em',
  },

  /* ───────────────────────── Mouse and touch ───────────────────────── */
  // A faint dot under the pointer shows where a click sets a breakpoint. Only for a
  // real pointer: on a touch screen "hover" stays on the row that was tapped last.
  '@media (hover: hover)': {
    '.cm-ss-marks .cm-gutterElement:hover::before': {
      content: '""',
      position: 'absolute',
      top: 'calc(50% - 5px)',
      left: `${2 + SLOT + (SLOT - 10) / 2}px`,
      width: '10px',
      height: '10px',
      borderRadius: '50%',
      backgroundColor: 'var(--c-bad)',
      opacity: '0.3',
    },
    // No hint on a line that has its dot already, and none while the pointer is on the
    // `!` mark (a click there shows the message; it does not set a breakpoint).
    '.cm-ss-marks .cm-ss-row-breakpoint:hover::before': { display: 'none' },
    '.cm-ss-marks .cm-gutterElement:has(.cm-ss-diagnostic:hover)::before': { display: 'none' },
  },
  '@media (pointer: coarse)': {
    '.cm-content': { fontSize: '16px' },
    '.cm-scroller': { lineHeight: '26px' },
    '.cm-ss-breakpoint': { borderWidth: '6px' },
  },
  // Windows high-contrast mode removes the tint, the dashed lines and the fill of the
  // error mark (they are backgrounds). Outlines and a border in system colors take
  // their place.
  '@media (forced-colors: active)': {
    '.cm-ss-line-current': { outline: '2px solid Highlight', outlineOffset: '-2px' },
    '.cm-ss-line-library': { outline: '1px dashed CanvasText', outlineOffset: '-1px' },
    '.cm-ss-line-ran': { outline: '1px dotted CanvasText', outlineOffset: '-1px' },
    '.cm-ss-line-stopped': { outline: '2px solid Mark', outlineOffset: '-2px' },
    '.cm-ss-ran': { stroke: 'CanvasText' },
    '.cm-ss-diagnostic-error': { border: '1px solid CanvasText', lineHeight: '12px' },
  },
})

/** The look of the editor, as one extension. */
export function editorTheme(): Extension {
  return theme
}
