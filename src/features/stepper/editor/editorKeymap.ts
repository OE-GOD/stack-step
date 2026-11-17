/**
 * The keys of the editor.
 *
 *   Tab            with text selected: indent the selected lines by one step (4 spaces).
 *                  otherwise: add spaces up to the next step (a multiple of 4 columns).
 *   Shift-Tab      take one step of indentation away from the line (or the selected lines).
 *   Enter          new line that starts with the same indentation as the line before.
 *   Escape         close the message box, drop the selection, and let the NEXT Tab or
 *                  Shift-Tab (within two seconds) move the keyboard focus out of the editor.
 *   Mod-b          switch the breakpoint of the cursor's line on or off (Cmd-B on a Mac,
 *                  Ctrl-B elsewhere).
 *   Mod-z …        undo and redo (CodeMirror's `historyKeymap`).
 *   arrows, Home, End, Backspace, Mod-a …   CodeMirror's `standardKeymap`.
 *
 * The keys of the PAGE: Ctrl/Cmd+Enter (Step), Ctrl/Cmd+Shift+Enter (Back) and
 * Ctrl/Cmd+Alt+Enter (Run). The page handles them in the capture phase, before the
 * editor sees them. The editor runs no command for them (see `PAGE_KEYS`). That is also
 * why CodeMirror's larger `defaultKeymap` is not used: it binds Mod-Enter.
 */
import {
  historyKeymap,
  indentLess,
  indentMore,
  simplifySelection,
  standardKeymap,
} from '@codemirror/commands'
import { getIndentUnit } from '@codemirror/language'
import { countColumn, EditorSelection, type StateCommand } from '@codemirror/state'
import type { Command, KeyBinding } from '@codemirror/view'
import { hideLineMessage } from './diagnosticTooltip'

/** How long after Escape the Tab key leaves the editor instead of indenting. */
const TAB_ESCAPE_MS = 2000

/**
 * Tab. With a selection it indents the selected lines. With only a cursor it adds spaces
 * up to the next indentation step, which is what Tab does in the editors students know;
 * at the start of a line that is one full step.
 */
export const insertSoftTab: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore({ state, dispatch })

  const step = getIndentUnit(state)
  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head)
    const column = countColumn(line.text, state.tabSize, range.head - line.from)
    const spaces = step - (column % step)
    return {
      changes: { from: range.head, insert: ' '.repeat(spaces) },
      range: EditorSelection.cursor(range.head + spaces),
    }
  })
  dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }))
  return true
}

/**
 * Escape. Tab is bound to indenting, so a keyboard user needs a way out: after Escape,
 * the next Tab (or Shift-Tab) goes to the browser, which moves the keyboard focus.
 */
const escapeEditor: Command = (view) => {
  hideLineMessage(view)
  simplifySelection(view)
  view.setTabFocusMode(TAB_ESCAPE_MS)
  return true
}

/** Does nothing and says "not handled", so the next handler gets its turn. */
const leaveToPage: Command = () => false

/**
 * The page's keys. The editor has no command for them, but it must still claim them:
 * a key that nobody claims goes to the browser, and Chrome on Windows and Linux then
 * types a line break for Ctrl+Enter. `preventDefault` stops that. The key event itself
 * travels on, so a page that listens later still hears it.
 */
export const PAGE_KEYS: readonly KeyBinding[] = [
  'Ctrl-Enter',
  'Cmd-Enter',
  'Alt-Ctrl-Enter',
  'Alt-Cmd-Enter',
].map((key) => ({ key, run: leaveToPage, shift: leaveToPage, preventDefault: true }))

/** All the key bindings. `onToggleBreakpoint` gets the line number of the cursor. */
export function editorKeymap(onToggleBreakpoint: (line: number) => void): readonly KeyBinding[] {
  const toggleBreakpoint: Command = (view) => {
    onToggleBreakpoint(view.state.doc.lineAt(view.state.selection.main.head).number)
    return true
  }
  return [
    { key: 'Tab', run: insertSoftTab, shift: indentLess },
    { key: 'Escape', run: escapeEditor },
    { key: 'Mod-b', run: toggleBreakpoint, preventDefault: true },
    ...PAGE_KEYS,
    ...historyKeymap,
    ...standardKeymap,
  ]
}
