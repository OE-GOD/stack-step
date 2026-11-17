/**
 * Every word the trace table shows or reads out, in one place.
 *
 * The students are beginners and many are learning English, so: short sentences, common
 * words, and the same word for the same thing every time. A "chip" is one answer tile.
 * A "line" is one line of code. "The chips" is the place where unplaced chips wait.
 */
import type { MoveOutcome } from './placement'

/** How the student last acted, so the hints can name the right action. */
export type How = 'touch' | 'mouse' | 'keyboard'

/**
 * "tap", "click" or "Enter": the first word of the short hints ("tap to replace",
 * "Enter to replace"). The key name alone keeps the keyboard hints as short as the others:
 * a hint sits on the top edge of a chip, and a longer one ("press Enter to replace")
 * covered the register name on a phone. Full sentences still say "press Enter".
 */
export function actionWord(how: How): string {
  if (how === 'touch') return 'tap'
  if (how === 'mouse') return 'click'
  return 'Enter'
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const WORDS = {
  startingValues: 'Starting values',
  register: 'Register',
  value: 'Value',
  traceTable: 'Trace table',
  line: 'Line',
  code: 'Code',
  changed: 'What changed',
  chips: 'Chips',
  chipsNotUsed: 'Chips you did not use',
  noChipsLeft: 'No chips are left.',
  noChips: 'This problem has no chips.',
  selected: 'selected',
  /**
   * An empty cell that waits for a chip. "put" fits every way to fill it: a drag, a tap,
   * a click or the keyboard ("drop" only fits a drag).
   */
  emptyCell: 'put a chip here',
  /** An empty cell while a chip is being dragged (but not over this cell). */
  emptyCellWhileDragging: 'drop a chip here',
  /** The cell under the pointer while a chip is dragged. */
  dropHere: 'drop it here',
  dropToReplace: 'drop to replace',
  dropToPutBack: 'drop here to put it back',
  /** The marks after Check: the same words as the marks of the answer fields. */
  right: 'Right',
  wrong: 'Wrong',
  blank: 'Left blank',
  /** An empty cell after Check. */
  noChip: 'no chip',
  rightAnswer: 'Right answer:',
  helpMouse: 'Drag a chip to a line. Or click a chip, then click a line.',
  helpTouch: 'Tap a chip, then tap a line. Or hold and drag.',
  helpDragging: 'Drop the chip on a line.',
  helpChooseChip: 'First choose a chip. Then choose a line.',
  keyboardHelp:
    'With a keyboard: press Enter on a chip to select it. Then press Enter on a line to place it there. Press Escape to cancel. Press Backspace on a line to clear it.',
} as const

/** The hint inside an empty cell while a chip is selected: "tap to place here". */
export function placeHereHint(how: How): string {
  return `${actionWord(how)} to place here`
}

/** The hint on a filled cell while another chip is selected: "tap to replace". */
export function replaceHint(how: How): string {
  return `${actionWord(how)} to replace`
}

/** The hint on the tray while a chip that sits on a line is selected: "tap to put it back". */
export function putBackHint(how: How): string {
  return `${actionWord(how)} to put it back`
}

/** The line under the heading of the tray while a chip is selected. */
export function nextStepHelp(how: How, chipIsOnALine: boolean): string {
  if (how === 'keyboard') {
    return chipIsOnALine
      ? 'Now go to another line and press Enter. Or press Backspace on its line to put it back.'
      : 'Now go to a line and press Enter. Press Escape to cancel.'
  }
  const action = capital(actionWord(how))
  return chipIsOnALine
    ? `Now ${actionWord(how)} another line, or put the chip back.`
    : `Now ${actionWord(how)} a line. ${action} the chip again to cancel.`
}

/**
 * The small label on the chip while it is dragged. It names what a drop would do, in
 * words that stay in sight (the chip itself can hide the cell under it): "line 2" over a
 * line, "put back" when a drop would put the chip back in the tray.
 */
export function dragTag(overLine: number | null, putsBack: boolean): string | null {
  if (overLine !== null) return `line ${overLine}`
  return putsBack ? 'put back' : null
}

/**
 * The accessible name of a cell: its line, what it holds, and then the words the cell
 * shows, if any ("Line 2, changed: empty, put a chip here", "Line 2, changed: rax =
 * 0x0000000000000005, tap to replace"). The visible words are part of the name, so a
 * student who controls the page by voice can say what they see. ("selected" is not
 * passed: the button says that with `aria-pressed`.)
 */
export function cellName(
  line: number,
  chipLabel: string | null,
  shownWords: string | null,
): string {
  const name = `Line ${line}, changed: ${chipLabel ?? 'empty'}`
  return shownWords === null ? name : `${name}, ${shownWords}`
}

/**
 * The accessible name of the button that takes a selected chip off its line. It starts
 * with the words the button shows ("tap to put it back"), then names the chip.
 */
export function putBackName(chipLabel: string, how: How): string {
  return `${putBackHint(how)}: ${chipLabel}`
}

/* ───────────────────── What screen readers hear ───────────────────── */

export function selectedMessage(chipLabel: string, line: number | null): string {
  return line === null
    ? `${chipLabel} selected. Now choose a line.`
    : `${chipLabel} on line ${line} selected. Now choose another line, or put the chip back.`
}

export function cancelledMessage(chipLabel: string): string {
  return `${chipLabel} is not selected any more.`
}

/** Said after a line was cleared while another chip stays selected. */
export function stillSelectedMessage(chipLabel: string): string {
  return `${chipLabel} is still selected.`
}

export const CHOOSE_A_CHIP_FIRST = 'No chip is selected. First choose a chip, then choose a line.'

/**
 * The sentence for a finished move. `labelOf` gives the text of a chip and `lineOf` the
 * line number of a field.
 */
export function outcomeMessage(
  outcome: MoveOutcome,
  labelOf: (chipId: string) => string,
  lineOf: (fieldId: string) => number,
): string {
  const chip = labelOf(outcome.chipId)
  if (outcome.type === 'returned') {
    return `Line ${lineOf(outcome.fromFieldId)} cleared. ${chip} is back with the other chips.`
  }
  const line = lineOf(outcome.fieldId)
  const first =
    outcome.fromFieldId === null
      ? `${chip} placed on line ${line}.`
      : `${chip} moved from line ${lineOf(outcome.fromFieldId)} to line ${line}.`
  return outcome.replacedChipId === null
    ? first
    : `${first} ${labelOf(outcome.replacedChipId)} is back with the other chips.`
}
