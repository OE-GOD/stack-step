/**
 * The rules of the trace table without React: where the chips are, what a move changes,
 * what lies under a point, and the words that describe it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Chip, PromptBlock } from '../../types'
import {
  distance,
  isInside,
  isTouchDrag,
  landingOf,
  MainButtonMouseSensor,
  targetAt,
  TOUCH_DRAG_DELAY,
  type DropZones,
} from './dnd'
import {
  cellOfChip,
  chipInCell,
  chipsInTray,
  planMove,
  type AnswerChange,
  type Answers,
  type MoveTarget,
} from './placement'
import { readPrompt } from './prompt'
import {
  actionWord,
  cancelledMessage,
  cellName,
  dragTag,
  nextStepHelp,
  outcomeMessage,
  placeHereHint,
  putBackHint,
  putBackName,
  replaceHint,
  selectedMessage,
  stillSelectedMessage,
  WORDS,
} from './words'

const CHIPS: readonly Chip[] = [
  { id: 'a', label: 'rax = 0x0000000000000005' },
  { id: 'b', label: 'rbx = 0x0000000000000015' },
  { id: 'c', label: 'rcx = 0xaaaabbbbccccdd7f' },
  { id: 'd', label: 'rax = 0x0000000000000006' },
]
const FIELDS = ['line1', 'line2', 'line3'] as const

const cell = (fieldId: string): MoveTarget => ({ kind: 'cell', fieldId })
const TRAY: MoveTarget = { kind: 'tray' }

function plan(answers: Answers, chipId: string, target: MoveTarget) {
  return planMove(CHIPS, FIELDS, answers, chipId, target)
}

/** The answers after a list of changes (what a page that follows `onChange` ends up with). */
function applyChanges(answers: Answers, changes: readonly AnswerChange[]): Answers {
  const next: Record<string, string> = { ...answers }
  for (const change of changes) next[change.fieldId] = change.value
  return next
}

describe('chipInCell', () => {
  it('gives the chip of a filled cell', () => {
    expect(chipInCell(CHIPS, { line1: 'b' }, 'line1')).toEqual(CHIPS[1])
  })

  it('gives null for an empty cell, a missing answer and a chip that does not exist', () => {
    expect(chipInCell(CHIPS, { line1: '' }, 'line1')).toBeNull()
    expect(chipInCell(CHIPS, {}, 'line1')).toBeNull()
    expect(chipInCell(CHIPS, { line1: 'nope' }, 'line1')).toBeNull()
  })
})

describe('cellOfChip', () => {
  it('finds the cell that holds a chip', () => {
    expect(cellOfChip(FIELDS, { line1: 'a', line3: 'c' }, 'c')).toBe('line3')
  })

  it('gives null for a chip in the tray', () => {
    expect(cellOfChip(FIELDS, { line1: 'a' }, 'b')).toBeNull()
  })

  it('never matches the empty answer of an empty cell', () => {
    expect(cellOfChip(FIELDS, { line1: '', line2: '' }, '')).toBeNull()
  })

  it('only looks at the fields of this problem', () => {
    expect(cellOfChip(FIELDS, { other: 'a' }, 'a')).toBeNull()
  })
})

describe('chipsInTray', () => {
  it('is every chip at the start, in the order of the problem', () => {
    expect(chipsInTray(CHIPS, FIELDS, {})).toEqual(CHIPS)
  })

  it('leaves out the chips that sit in a cell and keeps the order of the others', () => {
    const tray = chipsInTray(CHIPS, FIELDS, { line1: 'c', line2: 'a', line3: '' })
    expect(tray.map((chip) => chip.id)).toEqual(['b', 'd'])
  })

  it('keeps every chip when the answers name chips that do not exist', () => {
    expect(chipsInTray(CHIPS, FIELDS, { line1: 'ghost' })).toEqual(CHIPS)
  })

  it('ignores answers of fields that are not part of the problem', () => {
    expect(chipsInTray(CHIPS, FIELDS, { somethingElse: 'a' })).toEqual(CHIPS)
  })
})

describe('planMove', () => {
  it('tray to an empty cell: one call', () => {
    expect(plan({}, 'a', cell('line2'))).toEqual({
      changes: [{ fieldId: 'line2', value: 'a' }],
      outcome: {
        type: 'placed',
        chipId: 'a',
        fieldId: 'line2',
        fromFieldId: null,
        replacedChipId: null,
      },
    })
  })

  it('tray to a filled cell: one call, and the old chip is back in the tray', () => {
    const before = { line2: 'b' }
    const move = plan(before, 'a', cell('line2'))
    expect(move.changes).toEqual([{ fieldId: 'line2', value: 'a' }])
    expect(move.outcome).toMatchObject({ type: 'placed', replacedChipId: 'b', fromFieldId: null })

    const after = applyChanges(before, move.changes)
    expect(chipsInTray(CHIPS, FIELDS, after).map((chip) => chip.id)).toEqual(['b', 'c', 'd'])
  })

  it('cell to an empty cell: two calls, first the old cell is emptied', () => {
    const move = plan({ line1: 'a' }, 'a', cell('line3'))
    expect(move.changes).toEqual([
      { fieldId: 'line1', value: '' },
      { fieldId: 'line3', value: 'a' },
    ])
    expect(move.outcome).toEqual({
      type: 'placed',
      chipId: 'a',
      fieldId: 'line3',
      fromFieldId: 'line1',
      replacedChipId: null,
    })
  })

  it('cell to a filled cell: two calls, and the chip that was there goes to the tray', () => {
    const before = { line1: 'a', line2: 'b' }
    const move = plan(before, 'a', cell('line2'))
    expect(move.changes).toEqual([
      { fieldId: 'line1', value: '' },
      { fieldId: 'line2', value: 'a' },
    ])
    expect(move.outcome).toMatchObject({ fromFieldId: 'line1', replacedChipId: 'b' })

    const after = applyChanges(before, move.changes)
    expect(after).toEqual({ line1: '', line2: 'a' })
    expect(chipsInTray(CHIPS, FIELDS, after).map((chip) => chip.id)).toEqual(['b', 'c', 'd'])
  })

  it('a chip is never in two cells, not even between the two calls of a move', () => {
    const before = { line1: 'a' }
    const [first] = plan(before, 'a', cell('line2')).changes
    const between = applyChanges(before, first === undefined ? [] : [first])
    expect(FIELDS.filter((fieldId) => between[fieldId] === 'a')).toHaveLength(0)
  })

  it('onto the cell it is in already: nothing', () => {
    expect(plan({ line2: 'a' }, 'a', cell('line2'))).toEqual({ changes: [], outcome: null })
  })

  it('cell to the tray: one call that empties the cell', () => {
    expect(plan({ line2: 'a' }, 'a', TRAY)).toEqual({
      changes: [{ fieldId: 'line2', value: '' }],
      outcome: { type: 'returned', chipId: 'a', fromFieldId: 'line2' },
    })
  })

  it('tray to the tray: nothing', () => {
    expect(plan({ line2: 'b' }, 'a', TRAY)).toEqual({ changes: [], outcome: null })
  })

  it('a chip or a field that does not exist: nothing', () => {
    expect(plan({}, 'ghost', cell('line1'))).toEqual({ changes: [], outcome: null })
    expect(plan({}, 'a', cell('line9'))).toEqual({ changes: [], outcome: null })
    expect(plan({ line1: 'ghost' }, 'ghost', TRAY)).toEqual({ changes: [], outcome: null })
  })

  it('placing onto a cell that names a chip that does not exist replaces nothing', () => {
    const move = plan({ line1: 'ghost' }, 'a', cell('line1'))
    expect(move.changes).toEqual([{ fieldId: 'line1', value: 'a' }])
    expect(move.outcome).toMatchObject({ replacedChipId: null })
  })

  describe('when the page handed over the same chip in two cells', () => {
    const twice = { line1: 'a', line3: 'a' }

    it('a move to another cell empties both', () => {
      const move = plan(twice, 'a', cell('line2'))
      expect(applyChanges(twice, move.changes)).toEqual({ line1: '', line2: 'a', line3: '' })
    })

    it('a move onto one of the two empties the other', () => {
      const move = plan(twice, 'a', cell('line3'))
      expect(move.changes).toEqual([{ fieldId: 'line1', value: '' }])
      expect(applyChanges(twice, move.changes)).toEqual({ line1: '', line3: 'a' })
    })

    it('a move to the tray empties both', () => {
      const move = plan(twice, 'a', TRAY)
      expect(applyChanges(twice, move.changes)).toEqual({ line1: '', line3: '' })
    })
  })

  it('never loses or doubles a chip, whatever the moves (2000 random moves)', () => {
    // A small seeded generator, so a failure can be repeated.
    let seed = 20261116
    const random = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % below
    }

    let answers: Answers = {}
    for (let step = 0; step < 2000; step++) {
      const chip = CHIPS[random(CHIPS.length)]
      if (chip === undefined) throw new Error('No chip.')
      const where = random(FIELDS.length + 1)
      const target = where === FIELDS.length ? TRAY : cell(FIELDS[where] ?? '')
      const move = plan(answers, chip.id, target)

      expect(move.changes.length).toBeLessThanOrEqual(2)
      answers = applyChanges(answers, move.changes)

      // The chip is where it was sent.
      if (target.kind === 'cell') expect(answers[target.fieldId]).toBe(chip.id)
      else expect(cellOfChip(FIELDS, answers, chip.id)).toBeNull()

      // Every chip is in exactly one place: one cell, or the tray.
      const inCells = FIELDS.map((fieldId) => answers[fieldId] ?? '').filter((id) => id !== '')
      expect(new Set(inCells).size).toBe(inCells.length)
      const inTray = chipsInTray(CHIPS, FIELDS, answers).map((entry) => entry.id)
      expect([...inCells, ...inTray].sort()).toEqual(CHIPS.map((entry) => entry.id).sort())
    }
  })
})

describe('what lies under a point', () => {
  const zones: DropZones = {
    tray: { left: 0, top: 400, right: 300, bottom: 700 },
    rows: [
      { fieldId: 'line1', box: { left: 0, top: 100, right: 300, bottom: 150 } },
      { fieldId: 'line2', box: { left: 0, top: 150, right: 300, bottom: 200 } },
      // A row that the tray covers (the tray sticks to the bottom of a phone screen).
      { fieldId: 'line3', box: { left: 0, top: 380, right: 300, bottom: 430 } },
    ],
  }

  it('finds the row under the point', () => {
    expect(targetAt({ x: 20, y: 120 }, zones)).toEqual({ kind: 'cell', fieldId: 'line1' })
    expect(targetAt({ x: 299, y: 199 }, zones)).toEqual({ kind: 'cell', fieldId: 'line2' })
  })

  it('gives the first of two rows that share an edge', () => {
    expect(targetAt({ x: 20, y: 150 }, zones)).toEqual({ kind: 'cell', fieldId: 'line1' })
  })

  it('gives the tray where the tray lies over a row', () => {
    expect(targetAt({ x: 20, y: 410 }, zones)).toEqual({ kind: 'tray' })
    expect(targetAt({ x: 20, y: 390 }, zones)).toEqual({ kind: 'cell', fieldId: 'line3' })
  })

  it('gives null outside everything', () => {
    expect(targetAt({ x: 20, y: 50 }, zones)).toBeNull()
    expect(targetAt({ x: 350, y: 120 }, zones)).toBeNull()
    expect(targetAt({ x: 20, y: 120 }, { tray: null, rows: [] })).toBeNull()
  })

  it('counts the edges of a box as inside', () => {
    const box = { left: 10, top: 10, right: 20, bottom: 20 }
    expect(isInside({ x: 10, y: 10 }, box)).toBe(true)
    expect(isInside({ x: 20, y: 20 }, box)).toBe(true)
    expect(isInside({ x: 9.9, y: 15 }, box)).toBe(false)
    expect(isInside({ x: 15, y: 20.1 }, box)).toBe(false)
  })

  it('measures how far the pointer went', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(distance({ x: 7, y: 7 }, { x: 7, y: 7 })).toBe(0)
  })
})

describe('where a dragged chip lands', () => {
  it('lands on the line or the tray it is let go over, with a mouse or a finger', () => {
    for (const touch of [false, true]) {
      expect(landingOf(cell('line2'), touch)).toEqual(cell('line2'))
      expect(landingOf(TRAY, touch)).toEqual(TRAY)
    }
  })

  it('goes back to the tray when a mouse lets go over nothing', () => {
    expect(landingOf(null, false)).toEqual(TRAY)
  })

  it('changes nothing when a finger lets go over nothing', () => {
    // A thumb that picked up a chip by mistake and slid off to scroll must not lose it.
    expect(landingOf(null, true)).toBeNull()
  })

  it('tells a touch drag from a mouse drag by the event that started it', () => {
    expect(isTouchDrag(new Event('touchstart'))).toBe(true)
    expect(isTouchDrag(new Event('mousedown'))).toBe(false)
    expect(isTouchDrag(null)).toBe(false)
  })

  it('waits for a long press before a finger picks up a chip', () => {
    // People rest a thumb on the screen before they swipe; 0.3 s must not be a drag.
    expect(TOUCH_DRAG_DELAY).toBeGreaterThanOrEqual(500)
  })
})

describe('the mouse sensor', () => {
  const [activator] = MainButtonMouseSensor.activators
  const press = (button: number) => {
    const onActivation = vi.fn()
    const started = activator?.handler({ nativeEvent: { button } as MouseEvent }, { onActivation })
    return { started, activated: onActivation.mock.calls.length }
  }

  it('starts a drag with the main button only', () => {
    expect(activator?.eventName).toBe('onMouseDown')
    expect(press(0)).toEqual({ started: true, activated: 1 })
    expect(press(1)).toEqual({ started: false, activated: 0 }) // the middle button (the wheel)
    expect(press(2)).toEqual({ started: false, activated: 0 }) // the right button
  })
})

describe('the words', () => {
  const labelOf = (chipId: string) => CHIPS.find((chip) => chip.id === chipId)?.label ?? chipId
  const lineOf = (fieldId: string) => FIELDS.indexOf(fieldId as (typeof FIELDS)[number]) + 1

  it('names a cell by its line and what is in it', () => {
    expect(cellName(2, null, null)).toBe('Line 2, changed: empty')
    expect(cellName(2, 'rax = 0x0000000000000005', null)).toBe(
      'Line 2, changed: rax = 0x0000000000000005',
    )
  })

  it('puts the words a cell shows into its name, after the line and the content', () => {
    // Label in Name (WCAG 2.5.3): a student who speaks to the computer says what they see.
    expect(cellName(2, null, 'drop a chip here')).toBe('Line 2, changed: empty, drop a chip here')
    expect(cellName(4, 'rax = 0x5', 'tap to replace')).toBe(
      'Line 4, changed: rax = 0x5, tap to replace',
    )
  })

  it('names the action after the way the student acts', () => {
    expect(actionWord('touch')).toBe('tap')
    expect(actionWord('mouse')).toBe('click')
    expect(actionWord('keyboard')).toBe('Enter')
    expect(placeHereHint('touch')).toBe('tap to place here')
    expect(placeHereHint('mouse')).toBe('click to place here')
    expect(placeHereHint('keyboard')).toBe('Enter to place here')
    expect(replaceHint('touch')).toBe('tap to replace')
    expect(replaceHint('keyboard')).toBe('Enter to replace')
    expect(putBackHint('mouse')).toBe('click to put it back')
    expect(putBackHint('keyboard')).toBe('Enter to put it back')
  })

  it('names the "put it back" button with the words it shows, then the chip', () => {
    for (const how of ['touch', 'mouse', 'keyboard'] as const) {
      const name = putBackName('rax = 0x5', how)
      expect(name.startsWith(putBackHint(how))).toBe(true)
      expect(name).toContain('rax = 0x5')
    }
    expect(putBackName('rax = 0x5', 'touch')).toBe('tap to put it back: rax = 0x5')
  })

  it('keeps the labels on a chip short, so they never cover the register name', () => {
    // The longest label must fit beside "r15 =" in a 157 px chip (see TAG in chipStyles;
    // the e2e test measures it in a browser).
    const labels = [
      ...(['touch', 'mouse', 'keyboard'] as const).map(replaceHint),
      WORDS.dropToReplace,
      WORDS.selected,
    ]
    for (const label of labels) expect(label.length, label).toBeLessThanOrEqual(16)
  })

  it('says what to do next while a chip is selected', () => {
    expect(nextStepHelp('touch', false)).toBe('Now tap a line. Tap the chip again to cancel.')
    expect(nextStepHelp('mouse', true)).toBe('Now click another line, or put the chip back.')
    expect(nextStepHelp('keyboard', false)).toContain('press Enter')
    expect(nextStepHelp('keyboard', true)).toContain('Backspace')
  })

  it('tells a screen reader what was selected and what was cancelled', () => {
    expect(selectedMessage('rax = 0x5', null)).toBe('rax = 0x5 selected. Now choose a line.')
    expect(selectedMessage('rax = 0x5', 3)).toContain('on line 3 selected')
    expect(cancelledMessage('rax = 0x5')).toBe('rax = 0x5 is not selected any more.')
    expect(stillSelectedMessage('rax = 0x5')).toBe('rax = 0x5 is still selected.')
  })

  it('tells a screen reader what a move did', () => {
    const say = (move: ReturnType<typeof plan>) => {
      if (move.outcome === null) throw new Error('The move did nothing.')
      return outcomeMessage(move.outcome, labelOf, lineOf)
    }
    expect(say(plan({}, 'a', cell('line2')))).toBe('rax = 0x0000000000000005 placed on line 2.')
    expect(say(plan({ line2: 'b' }, 'a', cell('line2')))).toBe(
      'rax = 0x0000000000000005 placed on line 2. rbx = 0x0000000000000015 is back with the other chips.',
    )
    expect(say(plan({ line1: 'a' }, 'a', cell('line3')))).toBe(
      'rax = 0x0000000000000005 moved from line 1 to line 3.',
    )
    expect(say(plan({ line1: 'a', line3: 'c' }, 'a', cell('line3')))).toBe(
      'rax = 0x0000000000000005 moved from line 1 to line 3. rcx = 0xaaaabbbbccccdd7f is back with the other chips.',
    )
    expect(say(plan({ line2: 'a' }, 'a', TRAY))).toBe(
      'Line 2 cleared. rax = 0x0000000000000005 is back with the other chips.',
    )
  })

  it('labels the dragged chip with what a drop would do', () => {
    expect(dragTag(2, false)).toBe('line 2')
    expect(dragTag(2, true)).toBe('line 2')
    expect(dragTag(null, true)).toBe('put back')
    expect(dragTag(null, false)).toBeNull()
  })
})

describe('readPrompt', () => {
  const prompt: PromptBlock[] = [
    { type: 'text', text: 'Follow the code.' },
    { type: 'registers', title: 'Before', rows: [{ name: 'rax', value: '0x1' }] },
    { type: 'code', lines: ['mov eax, 5', 'inc rax'] },
    { type: 'text', text: 'A second sentence with `code`.' },
    { type: 'stack', rows: [{ address: '0x100', value: '0x0' }] },
    { type: 'code', lines: ['ret'] },
    { type: 'registers', rows: [{ name: 'rbx', value: '0x2' }] },
  ]

  it('collects the sentences, the tables of registers and the first listing', () => {
    expect(readPrompt(prompt)).toEqual({
      texts: ['Follow the code.', 'A second sentence with `code`.'],
      registers: [
        { title: 'Before', rows: [{ name: 'rax', value: '0x1' }] },
        { title: undefined, rows: [{ name: 'rbx', value: '0x2' }] },
      ],
      lines: ['mov eax, 5', 'inc rax'],
    })
  })

  it('gives empty parts for an empty prompt', () => {
    expect(readPrompt([])).toEqual({ texts: [], registers: [], lines: [] })
  })
})
