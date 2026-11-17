/// <reference lib="dom" />
/**
 * The trace table with drag-and-drop chips (TraceTableView), tested in a real browser:
 * a real mouse drag, real taps and touch sequences, and real key presses.
 *
 * Every test runs on two pages (see "The pages under test" below): the harness, a
 * developer page with hand-written problems that only the dev server serves, and the
 * practice page where students meet the table. So:
 *
 *   E2E_DEV=1 E2E_PORT=5278 npx playwright test e2e/trace-table.spec.ts   both pages
 *   E2E_PORT=5279 npx playwright test e2e/trace-table.spec.ts             the practice page
 *
 * They run in both Playwright projects. The mouse and keyboard tests run in `desktop`
 * (1280×800, and a few narrow windows where the tray sticks to the bottom), the touch
 * tests in `phone` (a touch screen, 360×740; the tests about the tray that sticks to the
 * bottom of the screen use a 430×932 phone, the narrowest common phone on which it does).
 *
 * The first line gives this file the browser types (`document`, `window`) for the
 * callbacks that run inside the page.
 */
import { expect, test, type CDPSession, type Locator, type Page } from '@playwright/test'
import { SAMPLE_PROBLEMS } from '../src/features/practice/components/trace/sampleProblems'
import { makeProblem } from '../src/features/practice/generators'
import type { Problem } from '../src/features/practice/types'
import { expectNoSidewaysScroll, watchForErrors } from './helpers'

/* ───────────────────────── The pages under test ───────────────────────── */

/** One problem of a page, with what the tests need to know about it. */
interface Sample {
  /** How a test title names it: "problem 1" (harness), "seed 2" (practice page). */
  name: string
  /** The address that shows it. */
  address: string
  problemId: string
  /** The label of the right chip of each line: `right[0]` belongs to line 1. */
  right: string[]
  /** Every chip label, in the order of the tray. */
  all: string[]
  /** A tempting wrong chip, the line it belongs to, and the mistake it stands for. */
  trap: { label: string; line: number; message: string }
  reason: string
}

/** How a page is opened: in the dark theme, and (harness) inside a padded card. */
interface Look {
  dark?: boolean
  card?: boolean
}

/**
 * - The harness: `?problem=N` shows sample problem N (1, 2 or 3) of SAMPLE_PROBLEMS,
 *   `&theme=dark` starts dark, `&frame=card` puts the table in a padded card. It logs every
 *   onChange call (`window.__traceHarness`) and has a "Try again" button. Dev server only.
 * - The practice page `/#/practice/homework-table?seed=N`: the generator's problem for that
 *   seed, inside the practice card (so a padded card is all it has), with the page's own
 *   Check button and feedback, and the dark theme of the device.
 *
 * Harness only: the checks of the onChange log (on the practice page those tests check
 * where the chips are instead) and "Try again" (the practice page has "Next problem").
 */
interface Target {
  name: string
  devOnly: boolean
  samples: readonly [Sample, Sample, Sample]
  open: (page: Page, sample: Sample, look?: Look) => Promise<void>
  logsChanges: boolean
  canTryAgain: boolean
}

/** A phone on which the tray sticks to the bottom of the screen on both pages. */
const STICKY_PHONE = { width: 430, height: 932 }

/** Window sizes (desktop project) where the tray sticks to the bottom on both pages. */
const STICKY_WINDOWS = [
  [430, 932],
  [600, 700],
] as const

/** A message as the page shows it: code in backticks is in a code font, without the backticks. */
function plain(message: string): string {
  return message.replaceAll('`', '')
}

/**
 * The facts of a problem. With `trap` the tempting chip is that one; without it, the
 * first chip that names a mistake on some line.
 */
function sampleOf(
  problem: Problem,
  name: string,
  address: string,
  trap?: { chipId: string; line: number },
): Sample {
  const labelOf = (chipId: string): string => {
    const chip = problem.chips?.find((entry) => entry.id === chipId)
    if (chip === undefined) throw new Error(`${problem.id} has no chip ${chipId}.`)
    return chip.label
  }
  const answers = Object.fromEntries(problem.fields.map((field) => [field.id, field.expected]))
  const tries =
    trap === undefined
      ? (problem.chips ?? []).flatMap((chip) =>
          problem.fields.map((_field, index) => ({ chipId: chip.id, line: index + 1 })),
        )
      : [trap]
  for (const attempt of tries) {
    const mistake = problem.diagnose({ ...answers, [`line${attempt.line}`]: attempt.chipId })
    if (mistake === null) continue
    return {
      name,
      address,
      problemId: problem.id,
      right: problem.fields.map((field) => labelOf(field.expected)),
      all: (problem.chips ?? []).map((chip) => chip.label),
      trap: { label: labelOf(attempt.chipId), line: attempt.line, message: plain(mistake.message) },
      reason: plain(problem.reason),
    }
  }
  throw new Error(`${problem.id} has no tempting chip.`)
}

const TRACE_PAGE = '/src/features/practice/components/trace/demo.html'

function harnessSample(number: number, trapChipId: string, trapLine: number): Sample {
  const problem = SAMPLE_PROBLEMS[number - 1]
  if (problem === undefined) throw new Error(`There is no sample problem ${number}.`)
  return sampleOf(problem, `problem ${number}`, `${TRACE_PAGE}?problem=${number}`, {
    chipId: trapChipId,
    line: trapLine,
  })
}

function practiceSample(seed: number): Sample {
  return sampleOf(
    makeProblem('homework-table', seed),
    `seed ${seed}`,
    `/#/practice/homework-table?seed=${seed}`,
  )
}

const HARNESS: Target = {
  name: 'the harness',
  devOnly: true,
  samples: [
    harnessSample(1, 'p1-keep', 1),
    harnessSample(2, 'p2-stale', 2),
    harnessSample(3, 'p3-clear', 3),
  ],
  open: async (page, sample, look = {}) => {
    const theme = look.dark === true ? '&theme=dark' : ''
    const frame = look.card === true ? '&frame=card' : ''
    await page.goto(`${sample.address}${theme}${frame}`)
    await expect(cell(page, 1)).toBeVisible()
    await expect(trayChips(page)).toHaveCount(sample.all.length)
  },
  logsChanges: true,
  canTryAgain: true,
}

/** Seed 2 is the one the browser review used; 1 and 3 have other tempting chips. */
const PRACTICE: Target = {
  name: 'the practice page',
  devOnly: false,
  samples: [practiceSample(2), practiceSample(1), practiceSample(3)],
  open: async (page, sample, look = {}) => {
    // The site follows the theme of the device (nothing is saved in these tests).
    await page.emulateMedia({ colorScheme: look.dark === true ? 'dark' : 'light' })
    const again = page.url().endsWith(sample.address)
    await page.goto(sample.address)
    if (again) await page.reload()
    await expect(page.locator('[data-practice-card]')).toHaveAttribute(
      'data-problem-id',
      sample.problemId,
    )
    await expect(cell(page, 1)).toBeVisible()
    await expect(trayChips(page)).toHaveCount(sample.all.length)
    // The table at the top of the window, as a student who scrolled down to it.
    await page.locator('[data-trace-table]').evaluate((element) => {
      element.scrollIntoView({ block: 'start' })
    })
  },
  logsChanges: false,
  canTryAgain: false,
}

/** The button of the page that checks the answer, and the one that starts over. */
function checkButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Check', exact: true })
}
function tryAgainButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Try again', exact: true })
}

/** The feedback of the page after Check ("Correct" / "Not yet", the reason, the mistake). */
function feedback(page: Page): Locator {
  return page.getByTestId('result')
}

/* ─────────────────────────────── Helpers ─────────────────────────────── */

interface Point {
  x: number
  y: number
}

/** What the harness page exposes for tests (see TraceDemoPage.tsx). */
interface HarnessWindow {
  __traceHarness?: {
    get: () => { answers: Record<string, string>; changes: { fieldId: string; value: string }[] }
  }
  __sawDraggedChip?: boolean
}

function tray(page: Page): Locator {
  return page.getByRole('group', { name: /^Chips/ })
}

/** The chips that wait in the tray (buttons while the table is open). */
function trayChips(page: Page): Locator {
  return tray(page).locator('[data-chip-in="tray"]')
}

function trayChip(page: Page, label: string): Locator {
  return tray(page).getByRole('button', { name: label, exact: true })
}

/** The "changed" cell of a line: a button named "Line 2, changed: …". */
function cell(page: Page, line: number): Locator {
  return page.getByRole('button', { name: new RegExp(`^Line ${line}, changed:`) })
}

function row(page: Page, line: number): Locator {
  return page.locator(`[data-trace-row="${line}"]`)
}

/** The chip that follows the pointer during a drag. */
function draggedChip(page: Page): Locator {
  return page.locator('[data-trace-overlay]')
}

/** What screen readers hear (a polite live region). */
function announcer(page: Page): Locator {
  return page.getByTestId('trace-announcer')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The cell of a line holds this chip (null: it is empty). Its name is "Line 2, changed:
 * rax = 0x…" or "Line 2, changed: empty", then, after a comma, the words the cell shows
 * at that moment ("put a chip here", "tap to replace"), if it shows any.
 */
async function expectCell(page: Page, line: number, label: string | null): Promise<void> {
  const start = escapeRegExp(`Line ${line}, changed: ${label ?? 'empty'}`)
  await expect(cell(page, line)).toHaveAccessibleName(new RegExp(`^${start}(, [^,]+)?$`))
}

/** The name of an empty cell while nothing is selected or dragged. */
function emptyCellName(line: number): string {
  return `Line ${line}, changed: empty, put a chip here`
}

/** The button of the tray that takes a selected chip off its line ("tap to put it back"). */
function putBackButton(page: Page, label?: string): Locator {
  return tray(page).getByRole('button', {
    name:
      label === undefined
        ? /to put it back: /
        : new RegExp(`to put it back: ${escapeRegExp(label)}$`),
  })
}

async function expectInTray(page: Page, label: string, inTray = true): Promise<void> {
  await expect(trayChip(page, label)).toHaveCount(inTray ? 1 : 0)
}

async function centerOf(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('The element is not on the screen.')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => Math.round(window.scrollY))
}

/**
 * The element is in sight and nothing lies on top of it: the point in its middle belongs
 * to it, and (for a line of the table) its whole box is above the tray while the tray
 * sticks to the bottom of the screen. Playwright's own checks cannot tell this:
 * `toBeInViewport` ignores what lies on top of an element, and every action scrolls first.
 */
async function expectInSight(locator: Locator, what: string): Promise<void> {
  const where = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const middle = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    const tray = document.querySelector('[data-trace-tray]')
    const sticky = tray !== null && getComputedStyle(tray).position === 'sticky'
    const inTray = tray?.contains(element) === true
    return {
      hit: middle !== null && element.contains(middle),
      top: box.top,
      bottom: box.bottom,
      limit:
        sticky && !inTray && tray !== null ? tray.getBoundingClientRect().top : window.innerHeight,
    }
  })
  expect(where.hit, `${what}: nothing may lie on top of it`).toBe(true)
  expect(where.top, `${what}: its top must be in sight`).toBeGreaterThanOrEqual(0)
  expect(where.bottom, `${what}: it must end above the tray`).toBeLessThanOrEqual(where.limit)
}

/**
 * The small label on the chip in a cell ("selected", "Enter to replace") says `text` and
 * does not cover the register name at the start of the chip.
 */
async function expectTagClearOfName(chipCell: Locator, text: string): Promise<void> {
  const tag = chipCell.locator('[data-trace-tag]')
  await expect(tag).toHaveText(text)
  const [tagBox, nameBox] = await Promise.all([
    tag.boundingBox(),
    chipCell.locator('[data-chip-name]').boundingBox(),
  ])
  if (tagBox === null || nameBox === null) throw new Error('The label or the name is not shown.')
  const across =
    Math.min(tagBox.x + tagBox.width, nameBox.x + nameBox.width) - Math.max(tagBox.x, nameBox.x)
  const down =
    Math.min(tagBox.y + tagBox.height, nameBox.y + nameBox.height) - Math.max(tagBox.y, nameBox.y)
  expect(across <= 0 || down <= 0, `"${text}" must not cover the register name`).toBe(true)
}

/**
 * Every button of the table whose name does not hold the words it shows (Label in Name,
 * WCAG 2.5.3: a student who controls the page by voice says what they see). The word
 * "selected" on a chip is a state, given by aria-pressed. Commas and colons do not count.
 */
async function buttonsWithoutTheirWords(page: Page): Promise<string[]> {
  return page.locator('[data-trace-table]').evaluate((table) => {
    const plain = (text: string) => text.replace(/[,:]/g, ' ').replace(/\s+/g, ' ').trim()
    const wrong: string[] = []
    for (const button of table.querySelectorAll<HTMLElement>('button')) {
      const tag = button.querySelector('[data-trace-tag]')?.textContent ?? ''
      const all = button.textContent ?? ''
      const body = tag === '' ? all : all.slice(0, all.length - tag.length)
      const name = plain(button.getAttribute('aria-label') ?? all)
      for (const words of [body, tag === 'selected' ? '' : tag]) {
        if (!name.includes(plain(words))) wrong.push(`"${name}" does not say "${plain(words)}"`)
      }
    }
    return wrong
  })
}

/** Every `onChange(fieldId, value)` call the harness has received. */
async function onChangeCalls(page: Page): Promise<[string, string][]> {
  return page.evaluate(() => {
    const harness = (window as HarnessWindow).__traceHarness
    if (harness === undefined) throw new Error('The harness is not ready.')
    return harness.get().changes.map((change): [string, string] => [change.fieldId, change.value])
  })
}

/** The log of onChange calls as it is now, or null on a page that keeps none. */
async function changeLog(page: Page, target: Target): Promise<[string, string][] | null> {
  return target.logsChanges ? onChangeCalls(page) : null
}

/**
 * The log of onChange calls is exactly `calls` (null: a log read with `changeLog` on a
 * page that keeps none, nothing to check).
 */
async function expectChangeLog(
  page: Page,
  target: Target,
  calls: readonly (readonly [string, string])[] | null,
): Promise<void> {
  if (!target.logsChanges || calls === null) return
  expect(await onChangeCalls(page)).toEqual(calls)
}

/** The tray sticks to the bottom of the screen now. */
async function expectStickyTray(page: Page): Promise<void> {
  await expect(tray(page)).toHaveCSS('position', 'sticky')
}

/**
 * Room to scroll below the table, for the tests that scroll the page with a swipe or the
 * wheel. The harness has it (a tall empty end); the practice page ends soon after the
 * table, so on a tall phone the page could not scroll far enough to tell.
 */
async function makeRoomToScroll(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'body { padding-bottom: 60vh !important; }' })
}

/**
 * The Check button of the practice page ignores presses for a moment after it appears
 * (against double taps), and says so with aria-disabled. A click waits for that by
 * itself; a key press does not.
 */
async function expectCheckReady(page: Page): Promise<void> {
  await expect(checkButton(page)).not.toHaveAttribute('aria-disabled', 'true')
}

/* ───────────────────── A drag with real mouse events ───────────────────── */

interface DragOptions {
  /** Runs while the chip is held over the target, before the button goes up. */
  whileHeld?: () => Promise<void>
}

/**
 * Press the mouse button on `from`, move to `to` in small steps, let go. These are real
 * mouse events from the browser's input pipeline (`page.mouse`), not synthetic DOM
 * events: if dragging is broken, nothing lands and the test fails.
 */
async function dragWithMouse(
  page: Page,
  from: Locator,
  to: Locator | Point,
  { whileHeld }: DragOptions = {},
): Promise<void> {
  const start = await centerOf(from)
  const end = 'x' in to ? to : await centerOf(to)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // A drag starts after 6 px. Go there the way a hand does: a little, then on.
  await page.mouse.move(start.x + 3, start.y + 2)
  await page.mouse.move(start.x + 10, start.y + 6, { steps: 3 })
  await expect(draggedChip(page), 'the chip must follow the pointer').toBeVisible()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await whileHeld?.()
  await page.mouse.up()
  // The chip glides into its place; then the copy under the pointer is gone.
  await expect(draggedChip(page)).toHaveCount(0)
}

/* ───────────────────── Real touch sequences (phone) ───────────────────── */

async function touchSession(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page)
}

async function touch(
  session: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  point?: Point,
): Promise<void> {
  await session.send('Input.dispatchTouchEvent', {
    type,
    touchPoints:
      point === undefined
        ? []
        : [
            {
              x: Math.round(point.x),
              y: Math.round(point.y),
              id: 0,
              radiusX: 5,
              radiusY: 5,
              force: 1,
            },
          ],
  })
}

/** Move a finger that is already down from `from` to `to`, about one step per frame. */
async function slide(page: Page, session: CDPSession, from: Point, to: Point, steps = 12) {
  for (let step = 1; step <= steps; step++) {
    await touch(session, 'touchMove', {
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
    })
    await page.waitForTimeout(16)
  }
}

/** A quick swipe: finger down, move at once, finger up. */
async function swipe(page: Page, session: CDPSession, from: Point, to: Point): Promise<void> {
  await touch(session, 'touchStart', from)
  await slide(page, session, from, to, 10)
  await touch(session, 'touchEnd')
}

/** Remember whether the dragged chip ever shows up from now on. */
async function watchForDraggedChip(page: Page): Promise<void> {
  await page.evaluate(() => {
    const view = window as HarnessWindow
    view.__sawDraggedChip = false
    new MutationObserver(() => {
      if (document.querySelector('[data-trace-overlay]') !== null) view.__sawDraggedChip = true
    }).observe(document.body, { childList: true, subtree: true })
  })
}

async function sawDraggedChip(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as HarnessWindow).__sawDraggedChip === true)
}

/* ─────────────────────────── Keyboard helpers ─────────────────────────── */

/** The name of the element that has the focus: its `aria-label`, else its text. */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const focused = document.activeElement
    if (focused === null || focused === document.body) return ''
    return focused.getAttribute('aria-label') ?? (focused.textContent ?? '').trim()
  })
}

/** Press Tab (or Shift+Tab) until the focus is on the element with this name. */
async function tabTo(page: Page, name: string | RegExp, key: 'Tab' | 'Shift+Tab'): Promise<void> {
  for (let presses = 0; presses < 80; presses++) {
    const current = await focusedName(page)
    if (typeof name === 'string' ? current === name : name.test(current)) return
    await page.keyboard.press(key)
  }
  throw new Error(`${key} never reached "${String(name)}".`)
}

async function expectFocusInsideTheTable(page: Page): Promise<void> {
  const where = await page.evaluate(() => {
    const focused = document.activeElement
    return {
      tag: focused?.tagName ?? '',
      inside: focused?.closest('[data-trace-table]') !== null,
    }
  })
  expect(where, 'the focus must not be lost').toEqual({ tag: 'BUTTON', inside: true })
}

/* ─────────────────────────────── Set-up ─────────────────────────────── */

let errors: string[] = []

test.beforeEach(({ page }) => {
  errors = watchForErrors(page)
})

test.afterEach(() => {
  expect(errors, 'the browser console must stay free of errors').toEqual([])
})

/* ───────────────────────── The tests, for one page ───────────────────────── */

function traceTableTests(target: Target): void {
  const [P1, P2, P3] = target.samples
  const open = (page: Page, sample: Sample, look?: Look) => target.open(page, sample, look)

  /* ─────────────────────────── With a mouse ─────────────────────────── */

  test.describe('with a mouse', () => {
    test.skip(({ isMobile }) => isMobile, 'The mouse tests run in the desktop project.')

    for (const problem of [P1, P2, P3]) {
      test(`${problem.name}: dragging every right chip to its line gives five right rows`, async ({
        page,
      }) => {
        await open(page, problem)
        for (const [index, label] of problem.right.entries()) {
          await dragWithMouse(page, trayChip(page, label), cell(page, index + 1))
          await expectCell(page, index + 1, label)
          await expectInTray(page, label, false)
        }
        await expect(trayChips(page)).toHaveCount(problem.all.length - 5)

        await checkButton(page).click()
        for (const line of [1, 2, 3, 4, 5]) {
          await expect(row(page, line)).toHaveAttribute('data-result', 'right')
          await expect(row(page, line).getByText('Right', { exact: true })).toBeVisible()
          await expect(row(page, line).locator('svg')).toBeVisible()
        }
        await expect(feedback(page)).toContainText('Correct')
        await expect(feedback(page)).toContainText(problem.reason)
      })
    }

    for (const problem of [P1, P2, P3]) {
      test(`${problem.name}: a tempting wrong chip marks its row wrong and the result names the mistake`, async ({
        page,
      }) => {
        await open(page, problem)
        const { trap } = problem
        for (const [index, label] of problem.right.entries()) {
          const line = index + 1
          await dragWithMouse(
            page,
            trayChip(page, line === trap.line ? trap.label : label),
            cell(page, line),
          )
        }
        await expectCell(page, trap.line, trap.label)

        await checkButton(page).click()
        for (const line of [1, 2, 3, 4, 5]) {
          await expect(row(page, line)).toHaveAttribute(
            'data-result',
            line === trap.line ? 'wrong' : 'right',
          )
        }
        const wrong = row(page, trap.line)
        // The same word as a wrong answer field: "Wrong", with an icon.
        await expect(wrong.getByText('Wrong', { exact: true })).toBeVisible()
        await expect(wrong.locator('svg')).toBeVisible()
        // The wrong chip stays in the cell and the right chip is shown under it.
        await expect(wrong.locator('[data-chip-id]')).toHaveText(trap.label)
        await expect(wrong.getByText('Right answer:')).toBeVisible()
        await expect(wrong.locator('[data-trace-right-answer]')).toHaveText(
          problem.right[trap.line - 1] ?? '',
        )

        await expect(feedback(page)).toContainText('Not yet')
        await expect(feedback(page)).toContainText(problem.reason)
        await expect(feedback(page)).toContainText(trap.message)
      })
    }

    test('the chip follows the pointer, and the line under it is marked in three ways', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      // A drag changes the words above the chips. The page must not move under the pointer
      // for that (on the practice page the table jumped 19 px at every drag).
      const still = await scrollY(page)
      await dragWithMouse(page, trayChip(page, first), cell(page, 3), {
        whileHeld: async () => {
          expect(await scrollY(page), 'the page must not move when the drag starts').toBe(still)
          // What stays behind in the tray is a faint copy.
          await expect(trayChip(page, first)).toHaveCSS('opacity', '0.4')
          // 1. The row: a marker for tests, a bold blue number.
          await expect(row(page, 3)).toHaveAttribute('data-over', '')
          await expect(row(page, 3).getByRole('rowheader')).toHaveCSS('font-weight', '700')
          // 2. The cell: other words and a solid edge instead of a dashed one.
          await expect(cell(page, 3)).toHaveText('drop it here')
          await expect(cell(page, 3)).toHaveCSS('border-top-style', 'solid')
          await expect(cell(page, 2)).toHaveText('drop a chip here')
          await expect(cell(page, 2)).toHaveCSS('border-top-style', 'dashed')
          await expect(row(page, 2)).not.toHaveAttribute('data-over', '')
          // 3. The chip under the pointer names the line.
          await expect(draggedChip(page)).toContainText(first)
          await expect(draggedChip(page).locator('[data-trace-drag-tag]')).toHaveText('line 3')
          await expect(tray(page)).toContainText('Drop the chip on a line.')

          // The chip is under the pointer: its box holds the pointer position.
          const held = await draggedChip(page).boundingBox()
          const pointer = await centerOf(cell(page, 3))
          expect(held).not.toBeNull()
          if (held !== null) {
            expect(pointer.x).toBeGreaterThan(held.x)
            expect(pointer.x).toBeLessThan(held.x + held.width)
            expect(pointer.y).toBeGreaterThan(held.y)
            expect(pointer.y).toBeLessThan(held.y + held.height)
          }
        },
      })
      await expectCell(page, 3, first)
      await expect(row(page, 3)).not.toHaveAttribute('data-over', '')
      await expect(announcer(page)).toHaveText(`${first} placed on line 3.`)

      // A filled cell under the pointer says "drop to replace".
      await dragWithMouse(page, trayChip(page, second), cell(page, 3), {
        whileHeld: async () => {
          await expect(cell(page, 3)).toContainText('drop to replace')
        },
      })
      await expectCell(page, 3, second)
    })

    test('dropping on an occupied cell puts the old chip back in the tray', async ({ page }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), cell(page, 1))
      await dragWithMouse(page, trayChip(page, second), cell(page, 1))

      await expectCell(page, 1, second)
      await expectInTray(page, first)
      await expectInTray(page, second, false)
      await expect(trayChips(page)).toHaveCount(P1.all.length - 1)
      await expect(announcer(page)).toHaveText(
        `${second} placed on line 1. ${first} is back with the other chips.`,
      )
      // One call per drop: the old chip needs no call of its own.
      await expectChangeLog(page, target, [
        ['line1', 'p1-a'],
        ['line1', 'p1-b'],
      ])
    })

    test('a placed chip can be dragged to another line (on the harness: two onChange calls, in order)', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), cell(page, 1))
      await dragWithMouse(page, cell(page, 1), cell(page, 4))
      await expectCell(page, 1, null)
      await expectCell(page, 4, first)
      await expect(announcer(page)).toHaveText(`${first} moved from line 1 to line 4.`)
      await expectChangeLog(page, target, [
        ['line1', 'p1-a'],
        ['line1', ''],
        ['line4', 'p1-a'],
      ])

      // Onto an occupied line: the chip that was there goes back to the tray.
      await dragWithMouse(page, trayChip(page, second), cell(page, 2))
      await dragWithMouse(page, cell(page, 4), cell(page, 2))
      await expectCell(page, 4, null)
      await expectCell(page, 2, first)
      await expectInTray(page, second)
    })

    test('a placed chip goes back to the tray: dropped on the tray, or outside every line', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), cell(page, 1))
      await dragWithMouse(page, trayChip(page, second), cell(page, 2))

      // On the tray.
      await dragWithMouse(page, cell(page, 1), tray(page), {
        whileHeld: async () => {
          await expect(tray(page).locator('[data-trace-put-back-hint="over"]')).toHaveText(
            'drop here to put it back',
          )
          await expect(draggedChip(page).locator('[data-trace-drag-tag]')).toHaveText('put back')
        },
      })
      await expectCell(page, 1, null)
      await expectInTray(page, first)
      await expect(announcer(page)).toHaveText(
        `Line 1 cleared. ${first} is back with the other chips.`,
      )

      // Outside everything: on the page above the table.
      await dragWithMouse(page, cell(page, 2), { x: 640, y: 20 })
      await expectCell(page, 2, null)
      await expectInTray(page, second)
      await expect(trayChips(page)).toHaveCount(P1.all.length)
    })

    test('a chip from the tray that is dropped outside every line stays in the tray', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), { x: 640, y: 20 })
      await dragWithMouse(page, trayChip(page, first), { x: 5, y: 795 })
      await expectInTray(page, first)
      await expect(trayChips(page)).toHaveCount(P1.all.length)
      await expectChangeLog(page, target, [])
      await expect(announcer(page)).toHaveText('')
    })

    test('a press without a move is a click, not a drag: click a chip, then click a line', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = ''] = P1.right
      await watchForDraggedChip(page)
      const at = await centerOf(trayChip(page, first))
      await page.mouse.move(at.x, at.y)
      await page.mouse.down()
      await page.mouse.move(at.x + 2, at.y + 1) // a hand is never perfectly still
      await page.mouse.up()

      expect(await sawDraggedChip(page)).toBe(false)
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'true')
      await expect(trayChip(page, first)).toContainText('selected')
      await expect(cell(page, 2)).toHaveText('click to place here')
      await expect(tray(page)).toContainText('Now click a line.')

      await cell(page, 2).click()
      await expectCell(page, 2, first)
      await expectInTray(page, first, false)
      await expect(cell(page, 1)).toHaveText('put a chip here')
    })

    test('a fast drag lands where the pointer is let go', async ({ page }) => {
      await open(page, P1)
      for (const [index, label] of P1.right.entries()) {
        const from = await centerOf(trayChip(page, label))
        const to = await centerOf(cell(page, index + 1))
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y) // one jump, no steps
        await page.mouse.up()
        await expectCell(page, index + 1, label)
        await expect(draggedChip(page)).toHaveCount(0)
      }
      await expect(trayChips(page)).toHaveCount(P1.all.length - 5)
    })

    test('Escape during a drag puts the chip back where it was', async ({ page }) => {
      await open(page, P1)
      const [first = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), cell(page, 1))

      const from = await centerOf(cell(page, 1))
      const to = await centerOf(cell(page, 3))
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x + 10, from.y + 6, { steps: 3 })
      await page.mouse.move(to.x, to.y, { steps: 8 })
      await expect(row(page, 3)).toHaveAttribute('data-over', '')
      await page.keyboard.press('Escape')
      await expect(draggedChip(page)).toHaveCount(0)
      await page.mouse.up()

      await expectCell(page, 1, first)
      await expectCell(page, 3, null)
      await expectChangeLog(page, target, [['line1', 'p1-a']])
    })

    test('the page can scroll during a drag: the chip lands on the line that is under the pointer then', async ({
      page,
    }) => {
      await open(page, P1)
      await makeRoomToScroll(page)
      const [first = ''] = P1.right
      await row(page, 1).evaluate((element) => element.scrollIntoView({ block: 'center' }))
      const before = await scrollY(page)
      const from = await centerOf(trayChip(page, first))
      const overLine1 = await centerOf(cell(page, 1))
      const rowHeight = (await row(page, 1).boundingBox())?.height ?? 0

      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(from.x - 10, from.y + 6, { steps: 3 })
      await page.mouse.move(overLine1.x, overLine1.y, { steps: 10 })
      await expect(row(page, 1)).toHaveAttribute('data-over', '')

      // Scroll two rows with the wheel: line 3 is under the (unmoved) pointer now.
      await page.mouse.wheel(0, rowHeight * 2)
      await expect.poll(() => scrollY(page)).toBe(before + Math.round(rowHeight * 2))
      await expect(row(page, 3)).toHaveAttribute('data-over', '')
      await page.mouse.up()

      await expectCell(page, 3, first)
      await expectCell(page, 1, null)
    })

    test('a drag does not select text; a right-click, the middle button or a double-click does no harm', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), cell(page, 2), {
        whileHeld: async () => {
          expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
        },
      })
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')

      await trayChip(page, P1.trap.label).click({ button: 'right' })
      await expect(draggedChip(page)).toHaveCount(0)
      await page.keyboard.press('Escape') // closes the menu of the browser, if it shows one
      await expect(trayChip(page, P1.trap.label)).toHaveAttribute('aria-pressed', 'false')

      // A double-click is two clicks: select, then cancel.
      await trayChip(page, P1.trap.label).dblclick()
      await expect(trayChip(page, P1.trap.label)).toHaveAttribute('aria-pressed', 'false')
      await expectCell(page, 2, first)

      // The middle button (the wheel) starts no drag: on Windows it also starts the
      // browser's own scrolling.
      const from = await centerOf(trayChip(page, P1.trap.label))
      const to = await centerOf(cell(page, 4))
      await page.mouse.move(from.x, from.y)
      await page.mouse.down({ button: 'middle' })
      await page.mouse.move(from.x + 10, from.y + 6, { steps: 3 })
      await page.mouse.move(to.x, to.y, { steps: 8 })
      await expect(draggedChip(page)).toHaveCount(0)
      await page.mouse.up({ button: 'middle' })
      await expectCell(page, 4, null)
      await expectChangeLog(page, target, [['line2', 'p1-a']])
    })

    test('the table does not move when chips are placed, selected or taken away', async ({
      page,
    }) => {
      await open(page, P1)
      // Where every row is, measured from the corner of the table (the page may scroll).
      const places = async () =>
        page.getByRole('table', { name: 'Trace table' }).evaluate((table) => {
          const corner = table.getBoundingClientRect()
          return [...table.querySelectorAll('tbody tr')].map((line) => {
            const box = line.getBoundingClientRect()
            return [box.left - corner.left, box.top - corner.top, box.width, box.height]
          })
        })
      const before = await places()
      expect(before).toHaveLength(5)

      const [first = '', second = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), cell(page, 1))
      expect(await places()).toEqual(before)
      await trayChip(page, second).click()
      expect(await places()).toEqual(before)
      await cell(page, 5).click()
      expect(await places()).toEqual(before)
      await cell(page, 5).click() // pick it up: the "put it back" slot shows in the tray
      await expect(tray(page).locator('[data-trace-put-back]')).toBeVisible()
      expect(await places()).toEqual(before)
      await dragWithMouse(page, cell(page, 1), tray(page))
      expect(await places()).toEqual(before)
    })
  })

  /* ─────────────────────────── With a finger ─────────────────────────── */

  test.describe('with a finger', () => {
    test.skip(({ isMobile }) => !isMobile, 'The touch tests run in the phone project.')

    for (const problem of [P1, P2, P3]) {
      test(`${problem.name}: tapping a chip, then a line, places it; Check marks five right rows`, async ({
        page,
      }) => {
        await open(page, problem)
        for (const [index, label] of problem.right.entries()) {
          await trayChip(page, label).tap()
          await expect(trayChip(page, label)).toHaveAttribute('aria-pressed', 'true')
          await cell(page, index + 1).tap()
          await expectCell(page, index + 1, label)
          await expectInTray(page, label, false)
        }
        await expectNoSidewaysScroll(page)

        await checkButton(page).tap()
        for (const line of [1, 2, 3, 4, 5]) {
          await expect(row(page, line)).toHaveAttribute('data-result', 'right')
          await expect(row(page, line).getByText('Right', { exact: true })).toBeVisible()
        }
        await expect(feedback(page)).toContainText('Correct')
        await expectNoSidewaysScroll(page)
      })
    }

    test('a tempting wrong chip, placed by tapping, marks its row wrong and the result names the mistake', async ({
      page,
    }) => {
      await open(page, P2)
      const { trap } = P2
      for (const [index, label] of P2.right.entries()) {
        const line = index + 1
        await trayChip(page, line === trap.line ? trap.label : label).tap()
        await cell(page, line).tap()
      }
      await checkButton(page).tap()

      const wrong = row(page, trap.line)
      await expect(wrong).toHaveAttribute('data-result', 'wrong')
      await expect(wrong.getByText('Wrong', { exact: true })).toBeVisible()
      await expect(wrong.locator('[data-trace-right-answer]')).toHaveText(
        P2.right[trap.line - 1] ?? '',
      )
      await expect(feedback(page)).toContainText('Not yet')
      await expect(feedback(page)).toContainText(trap.message)
      await expectNoSidewaysScroll(page)
    })

    test('a selected chip is clearly marked, and the cells say "tap to place here"', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await expect(tray(page)).toContainText('Tap a chip, then tap a line.')
      await expect(cell(page, 1)).toHaveText('put a chip here')

      await trayChip(page, first).tap()
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'true')
      await expect(trayChip(page, first)).toContainText('selected')
      // A thicker edge: a 2 px ring around the border.
      await expect(trayChip(page, first)).toHaveCSS('box-shadow', /0px 0px 0px 2px/)
      for (const line of [1, 2, 3, 4, 5])
        await expect(cell(page, line)).toHaveText('tap to place here')
      await expect(tray(page)).toContainText('Now tap a line.')
      await expect(announcer(page)).toHaveText(`${first} selected. Now choose a line.`)
      await expectNoSidewaysScroll(page)

      // Tap it again: cancel.
      await trayChip(page, first).tap()
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'false')
      await expect(cell(page, 1)).toHaveText('put a chip here')
      await expect(announcer(page)).toHaveText(`${first} is not selected any more.`)

      // Tap another chip while one is selected: the other one is selected instead.
      await trayChip(page, first).tap()
      await trayChip(page, second).tap()
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'false')
      await expect(trayChip(page, second)).toHaveAttribute('aria-pressed', 'true')
      await expectChangeLog(page, target, [])
    })

    test('tapping moves a placed chip, replaces a chip, and puts a chip back', async ({ page }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await trayChip(page, first).tap()
      await cell(page, 1).tap()
      await trayChip(page, second).tap()
      await cell(page, 2).tap()

      // Tap a placed chip: it is picked up. Tap another line: it moves there.
      await cell(page, 1).tap()
      await expect(cell(page, 1)).toHaveAttribute('aria-pressed', 'true')
      // The labels on the chips stay clear of the register names on a 360 px phone.
      await expectTagClearOfName(cell(page, 1), 'selected')
      await expectTagClearOfName(cell(page, 2), 'tap to replace')
      await expect(cell(page, 4)).toHaveText('tap to place here')
      await cell(page, 4).tap()
      await expectCell(page, 1, null)
      await expectCell(page, 4, first)
      await expect(announcer(page)).toHaveText(`${first} moved from line 1 to line 4.`)

      // Tap an occupied cell with a chip selected: the old chip goes back to the tray.
      await trayChip(page, P1.trap.label).tap()
      await cell(page, 2).tap()
      await expectCell(page, 2, P1.trap.label)
      await expectInTray(page, second)

      // Tap a placed chip, then "tap to put it back". Its name starts with those words.
      await cell(page, 4).tap()
      const putBack = page.getByRole('button', { name: `tap to put it back: ${first}` })
      await expect(putBack).toHaveText('tap to put it back')
      await putBack.tap()
      await expectCell(page, 4, null)
      await expectInTray(page, first)
      await expect(putBack).toHaveCount(0)

      // Tap the picked-up chip again: it stays where it is.
      await cell(page, 2).tap()
      await cell(page, 2).tap()
      await expect(cell(page, 2)).toHaveAttribute('aria-pressed', 'false')
      await expectCell(page, 2, P1.trap.label)
      await expectNoSidewaysScroll(page)
    })

    test('a tap on an empty line with no chip selected says what to do first', async ({ page }) => {
      await open(page, P1)
      await cell(page, 3).tap()
      await expect(tray(page)).toContainText('First choose a chip. Then choose a line.')
      await expect(announcer(page)).toHaveText(
        'No chip is selected. First choose a chip, then choose a line.',
      )
      await expectChangeLog(page, target, [])
    })

    test('a swipe that starts on a chip or on a cell scrolls the page and moves nothing', async ({
      page,
    }) => {
      await page.setViewportSize(STICKY_PHONE)
      await open(page, P1)
      await makeRoomToScroll(page)
      await expectStickyTray(page)
      const [first = ''] = P1.right
      const session = await touchSession(page)
      await trayChip(page, first).tap()
      await cell(page, 1).tap()
      await expectCell(page, 1, first)
      const callsBefore = await changeLog(page, target)
      await watchForDraggedChip(page)

      // 1. On a chip in the tray. 2. On a filled cell. 3. On an empty cell.
      const starts = [trayChip(page, P1.trap.label), cell(page, 1), cell(page, 2)]
      for (const start of starts) {
        // The table at the top of the screen, the tray under it: nothing covers anything.
        await row(page, 1).evaluate((element) => element.scrollIntoView({ block: 'start' }))
        const before = await scrollY(page)
        const from = await centerOf(start)
        await swipe(page, session, from, { x: from.x, y: from.y - 200 })
        await expect
          .poll(() => scrollY(page), { message: 'the swipe must scroll the page' })
          .toBeGreaterThan(before + 100)
      }

      expect(await sawDraggedChip(page)).toBe(false)
      await expectCell(page, 1, first)
      await expectCell(page, 2, null)
      await expect(trayChips(page)).toHaveCount(P1.all.length - 1)
      await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0)
      await expectChangeLog(page, target, callsBefore)
    })

    test('a thumb that rests on a chip for a moment before it swipes still scrolls the page', async ({
      page,
    }) => {
      // People often rest a thumb on the screen before they swipe. A rest of 0.3 s used to
      // pick up the chip, and the swipe then dropped it on a line or took it off its line.
      await page.setViewportSize(STICKY_PHONE)
      await open(page, P1)
      await makeRoomToScroll(page)
      await expectStickyTray(page)
      const third = P1.right[2] ?? ''
      const session = await touchSession(page)
      await trayChip(page, third).tap()
      await cell(page, 3).tap()
      await expectCell(page, 3, third)
      const callsBefore = await changeLog(page, target)
      await watchForDraggedChip(page)

      // 1. Rest on a chip of the tray, then swipe up: the page scrolls down.
      await row(page, 1).evaluate((element) => element.scrollIntoView({ block: 'start' }))
      const top = await scrollY(page)
      const chip = await centerOf(trayChip(page, P1.trap.label))
      await touch(session, 'touchStart', chip)
      await page.waitForTimeout(300)
      await slide(page, session, chip, { x: chip.x, y: chip.y - 260 }, 15)
      await touch(session, 'touchEnd')
      await expect
        .poll(() => scrollY(page), { message: 'the swipe must scroll the page down' })
        .toBeGreaterThan(top + 100)

      // 2. Rest on the chip of line 3, then swipe down: the page scrolls up.
      await row(page, 2).evaluate((element) => element.scrollIntoView({ block: 'start' }))
      const lower = await scrollY(page)
      await expectInSight(cell(page, 3), 'line 3')
      const placed = await centerOf(cell(page, 3))
      await touch(session, 'touchStart', placed)
      await page.waitForTimeout(300)
      await slide(page, session, placed, { x: placed.x, y: placed.y + 300 }, 15)
      await touch(session, 'touchEnd')
      await expect
        .poll(() => scrollY(page), { message: 'the swipe must scroll the page up' })
        .toBeLessThan(lower - 100)

      expect(await sawDraggedChip(page), 'no chip may be picked up').toBe(false)
      await expectCell(page, 3, third)
      await expectCell(page, 2, null)
      await expectInTray(page, P1.trap.label)
      await expectChangeLog(page, target, callsBefore)
    })

    test('a chip that a finger lifted and let go outside every line and the tray stays where it was', async ({
      page,
    }) => {
      // A thumb that picked up a chip by mistake and slid off must never lose an answer.
      // (With a mouse, letting go outside puts a chip from a line back in the tray.)
      await open(page, P1)
      const third = P1.right[2] ?? ''
      const session = await touchSession(page)
      await trayChip(page, third).tap()
      await cell(page, 3).tap()
      const callsBefore = await changeLog(page, target)
      await page
        .getByRole('table', { name: 'Starting values' })
        .evaluate((element) => element.scrollIntoView({ block: 'start' }))

      const from = await centerOf(cell(page, 3))
      // The margin of the page beside line 2: no line and not the tray, and far from the
      // top and the bottom edge (where the page would scroll).
      const outside = { x: 4, y: (await centerOf(cell(page, 2))).y }
      await touch(session, 'touchStart', from)
      await expect(draggedChip(page), 'a long press lifts the chip').toBeVisible()
      await slide(page, session, from, outside)
      await expect(row(page, 2)).not.toHaveAttribute('data-over', '')
      // Nothing promises "put back" here.
      await expect(draggedChip(page).locator('[data-trace-drag-tag]')).toHaveCount(0)
      await expect(tray(page).locator('[data-trace-put-back-hint="open"]')).toBeVisible()
      await touch(session, 'touchEnd')
      await expect(draggedChip(page)).toHaveCount(0)

      await expectCell(page, 3, third)
      await expectInTray(page, third, false)
      await expectChangeLog(page, target, callsBefore)
      await expect(announcer(page)).not.toContainText('cleared')
    })

    test('press and hold, then drag: the chip lands, and the page is not trapped', async ({
      page,
    }) => {
      await page.setViewportSize(STICKY_PHONE)
      await open(page, P1)
      await makeRoomToScroll(page)
      await expectStickyTray(page)
      const [first = '', second = ''] = P1.right
      const session = await touchSession(page)
      // The table at the top of the screen, the tray under it. Line 2 is close to the top
      // edge then (about 80 px down): a chip held over it must not make the page scroll.
      // (With the 20 % edge band that dnd-kit uses by default, the page slid away here.)
      await row(page, 1).evaluate((element) => element.scrollIntoView({ block: 'start' }))
      const scrolled = await scrollY(page)

      // From the tray to line 2.
      const from = await centerOf(trayChip(page, second))
      const to = await centerOf(cell(page, 2))
      await touch(session, 'touchStart', from)
      await expect(draggedChip(page), 'a held chip is picked up').toBeVisible()
      await slide(page, session, from, to)
      await expect(row(page, 2)).toHaveAttribute('data-over', '')
      await expect(draggedChip(page).locator('[data-trace-drag-tag]')).toHaveText('line 2')
      expect(await scrollY(page), 'the page must not scroll under a held chip').toBe(scrolled)
      await touch(session, 'touchEnd')
      await expect(draggedChip(page)).toHaveCount(0)
      await expectCell(page, 2, second)
      await expectInTray(page, second, false)
      expect(await scrollY(page)).toBe(scrolled)

      // A placed chip, held and dragged to the tray, goes back.
      const placed = await centerOf(cell(page, 2))
      const home = await centerOf(tray(page))
      await touch(session, 'touchStart', placed)
      await expect(draggedChip(page)).toBeVisible()
      await slide(page, session, placed, home)
      await expect(draggedChip(page).locator('[data-trace-drag-tag]')).toHaveText('put back')
      await touch(session, 'touchEnd')
      await expect(draggedChip(page)).toHaveCount(0)
      await expectCell(page, 2, null)
      await expectInTray(page, second)

      // After a touch drag the page scrolls again as usual: nothing is trapped.
      const start = await centerOf(trayChip(page, first))
      await swipe(page, session, start, { x: start.x, y: start.y - 150 })
      await expect.poll(() => scrollY(page)).toBeGreaterThan(scrolled + 50)
    })

    test('a chip held at the top edge scrolls the page up, so a line out of sight can be reached', async ({
      page,
    }) => {
      await page.setViewportSize(STICKY_PHONE)
      await open(page, P1)
      await expectStickyTray(page)
      const [first = ''] = P1.right
      const session = await touchSession(page)
      // Line 3 at the top of the screen: lines 1 and 2 are out of sight above it.
      await row(page, 3).evaluate((element) => element.scrollIntoView({ block: 'start' }))
      const scrolled = await scrollY(page)
      expect(scrolled).toBeGreaterThan(100)

      const from = await centerOf(trayChip(page, first))
      const edge = { x: from.x, y: 12 }
      await touch(session, 'touchStart', from)
      await expect(draggedChip(page)).toBeVisible()
      await slide(page, session, from, edge)
      // The page scrolls up while the chip is held there. As soon as line 1 is in sight,
      // well below the edge, the finger moves down out of the edge band: the page stops.
      // (Held there longer, the page goes on up to its top; on the practice page line 1 is
      // then under the tray.)
      await expect
        .poll(() => cell(page, 1).evaluate((element) => element.getBoundingClientRect().top), {
          message: 'the page must scroll up until line 1 is in sight',
          intervals: [20],
        })
        .toBeGreaterThan(120)
      const calm = { x: edge.x, y: 300 }
      await slide(page, session, edge, calm, 4)
      await expectInSight(cell(page, 1), 'line 1 after the page scrolled up')

      const lineOne = await centerOf(cell(page, 1))
      await slide(page, session, calm, lineOne, 8)
      await expect(row(page, 1)).toHaveAttribute('data-over', '')
      await touch(session, 'touchEnd')
      await expect(draggedChip(page)).toHaveCount(0)
      await expectCell(page, 1, first)
    })

    test('a slow tap still selects the chip: a short hold, or a long press let go on the spot', async ({
      page,
    }) => {
      await page.setViewportSize(STICKY_PHONE)
      await open(page, P1)
      const [first = ''] = P1.right
      const session = await touchSession(page)
      await trayChip(page, first).scrollIntoViewIfNeeded()
      const at = await centerOf(trayChip(page, first))
      await watchForDraggedChip(page)

      // Shorter than a long press (half a second): nothing is lifted, it is a tap.
      await touch(session, 'touchStart', at)
      await page.waitForTimeout(300)
      await touch(session, 'touchEnd')
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'true')
      expect(await sawDraggedChip(page)).toBe(false)
      await trayChip(page, first).tap() // cancel
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'false')

      // A long press lifts the chip; let go on the spot, it counts as a tap too.
      const again = await centerOf(trayChip(page, first))
      await touch(session, 'touchStart', again)
      await expect(draggedChip(page)).toBeVisible()
      await page.waitForTimeout(200)
      await touch(session, 'touchEnd')
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'true')
      await expect(draggedChip(page)).toHaveCount(0)
      await expect(cell(page, 1)).toHaveText('tap to place here')
      await cell(page, 1).tap()
      await expectCell(page, 1, first)
      // A long press opens no menu and selects no text.
      expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    })

    test('the tray stays on the screen while the table scrolls, and every chip is big enough for a thumb', async ({
      page,
    }) => {
      await page.setViewportSize(STICKY_PHONE)
      await open(page, P1)
      await expectStickyTray(page)

      // Wherever a line of the table is on the screen, the whole tray is on the screen too.
      for (const line of [1, 3, 5]) {
        await row(page, line).evaluate((element) => element.scrollIntoView({ block: 'start' }))
        for (const label of P1.all) {
          await expect(trayChip(page, label)).toBeInViewport({ ratio: 1 })
          await expectInSight(trayChip(page, label), `the chip ${label}`)
        }
      }
      // With the starting values at the top, all five lines and all the chips fit at once.
      // A hit test, because the tray lies on top of the lines that scroll under it, and
      // `toBeInViewport` would not see that.
      await page
        .getByRole('table', { name: 'Starting values' })
        .evaluate((element) => element.scrollIntoView({ block: 'start' }))
      for (const line of [1, 2, 3, 4, 5]) await expectInSight(cell(page, line), `line ${line}`)
      for (const label of P1.all) {
        await expect(trayChip(page, label)).toBeInViewport({ ratio: 1 })
        await expectInSight(trayChip(page, label), `the chip ${label}`)
      }

      // Touch targets: chips and cells are at least 44 px tall.
      for (const label of [P1.all[0] ?? '']) {
        const box = await trayChip(page, label).boundingBox()
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      }
      expect((await cell(page, 1).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
      // Two chips side by side, and a chip breaks after the "=" instead of running over.
      const [left, right] = await Promise.all([
        trayChip(page, P1.all[0] ?? '').boundingBox(),
        trayChip(page, P1.all[1] ?? '').boundingBox(),
      ])
      expect(left?.y).toBe(right?.y)
      const fits = await trayChip(page, P1.all[0] ?? '').evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      )
      expect(fits).toBe(true)
      await expectNoSidewaysScroll(page)
    })

    test('on a 360 px phone the tray waits under the table, one chip a row, and every chip fits', async ({
      page,
    }) => {
      // Two columns of 14 px chips do not fit beside each other on the narrowest phones:
      // the tray does not stick there (a tray of one column would cover half the screen).
      await open(page, P1)
      await expect(tray(page)).toHaveCSS('position', 'static')
      const boxes = await trayChips(page).evaluateAll((chips) =>
        chips.map((chip) => {
          const box = chip.getBoundingClientRect()
          return { left: Math.round(box.left), fits: chip.scrollWidth <= chip.clientWidth }
        }),
      )
      expect(new Set(boxes.map((box) => box.left)).size).toBe(1)
      expect(boxes.every((box) => box.fits)).toBe(true)
      // The code column still holds a 32-bit number on one line.
      const codeWidth = await row(page, 1)
        .locator('td')
        .first()
        .evaluate((element) => element.getBoundingClientRect().width)
      expect(codeWidth).toBeGreaterThan(88)
      await expectNoSidewaysScroll(page)
    })

    test('the table does not move when a chip is placed or taken away', async ({ page }) => {
      await open(page, P3)
      const [first = ''] = P3.right
      const heights = async () =>
        Promise.all(
          [1, 2, 3, 4, 5].map(async (line) => (await row(page, line).boundingBox())?.height),
        )
      const before = await heights()
      await trayChip(page, first).tap()
      expect(await heights()).toEqual(before)
      await cell(page, 1).tap()
      expect(await heights()).toEqual(before)
      await cell(page, 1).tap()
      await page.locator('[data-trace-put-back]').tap()
      expect(await heights()).toEqual(before)
      await expectNoSidewaysScroll(page)
    })

    test('nothing scrolls sideways in the dark theme and inside a padded card', async ({
      page,
    }) => {
      for (const look of [{ dark: true }, { card: true }]) {
        await open(page, P3, look)
        await expectNoSidewaysScroll(page)
        await trayChip(page, P3.right[0] ?? '').tap()
        await cell(page, 1).tap()
        await expectCell(page, 1, P3.right[0] ?? '')
        await expectNoSidewaysScroll(page)
      }
    })
  })

  /* ─────────────────────────── With the keyboard ─────────────────────────── */

  test.describe('with the keyboard', () => {
    test.skip(({ isMobile }) => isMobile, 'The keyboard tests run in the desktop project.')

    test('all five chips are placed with Tab, Enter and Space only', async ({ page }) => {
      await open(page, P1)
      for (const [index, label] of P1.right.entries()) {
        const line = index + 1
        await tabTo(page, label, 'Tab')
        // Enter and Space both work.
        await page.keyboard.press(line % 2 === 1 ? 'Enter' : 'Space')
        await expect(trayChip(page, label)).toHaveAttribute('aria-pressed', 'true')
        await expect(announcer(page)).toHaveText(`${label} selected. Now choose a line.`)
        await expect(cell(page, line)).toHaveText('Enter to place here')
        await expect(cell(page, line)).toHaveAccessibleName(
          `Line ${line}, changed: empty, Enter to place here`,
        )
        await expectFocusInsideTheTable(page)

        await tabTo(page, new RegExp(`^Line ${line}, changed:`), 'Shift+Tab')
        await page.keyboard.press(line % 2 === 1 ? 'Space' : 'Enter')
        await expectCell(page, line, label)
        await expect(announcer(page)).toHaveText(`${label} placed on line ${line}.`)
        // The focus stays on the cell that was filled.
        expect(await focusedName(page)).toBe(`Line ${line}, changed: ${label}`)
        await expectFocusInsideTheTable(page)
      }
      await expect(trayChips(page)).toHaveCount(P1.all.length - 5)

      await tabTo(page, 'Check', 'Tab')
      await expect(checkButton(page)).toBeFocused()
      await expectCheckReady(page)
      await page.keyboard.press('Enter')
      await expect(feedback(page)).toContainText('Correct')
      for (const line of [1, 2, 3, 4, 5])
        await expect(row(page, line)).toHaveAttribute('data-result', 'right')
    })

    test('the Tab order is: the lines from 1 to 5, then the chips in the order of the tray', async ({
      page,
    }) => {
      await open(page, P1)
      await tabTo(page, /^Line 1, changed:/, 'Tab')
      const order: string[] = []
      for (let step = 0; step < 5 + P1.all.length; step++) {
        order.push(await focusedName(page))
        await page.keyboard.press('Tab')
      }
      expect(order).toEqual([...[1, 2, 3, 4, 5].map((line) => emptyCellName(line)), ...P1.all])
    })

    test('Escape cancels the selection; Backspace and Delete clear a line', async ({ page }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right

      await tabTo(page, first, 'Tab')
      await page.keyboard.press('Enter')
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'true')
      await page.keyboard.press('Escape')
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'false')
      await expect(cell(page, 1)).toHaveText('put a chip here')
      await expect(announcer(page)).toHaveText(`${first} is not selected any more.`)
      expect(await focusedName(page)).toBe(first)

      // Place two chips, then clear them with Backspace and with Delete.
      await page.keyboard.press('Enter')
      await tabTo(page, /^Line 1, changed:/, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await tabTo(page, second, 'Tab')
      await page.keyboard.press('Enter')
      await tabTo(page, /^Line 2, changed:/, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await expectCell(page, 1, first)
      await expectCell(page, 2, second)

      await page.keyboard.press('Backspace')
      await expectCell(page, 2, null)
      await expectInTray(page, second)
      await expect(announcer(page)).toHaveText(
        `Line 2 cleared. ${second} is back with the other chips.`,
      )
      expect(await focusedName(page)).toBe(emptyCellName(2))

      await page.keyboard.press('Shift+Tab')
      expect(await focusedName(page)).toBe(`Line 1, changed: ${first}`)
      await page.keyboard.press('Delete')
      await expectCell(page, 1, null)
      await expectInTray(page, first)
      await expectFocusInsideTheTable(page)
      await expect(trayChips(page)).toHaveCount(P1.all.length)
    })

    test('a placed chip is picked up with Enter and moved, replaced or put back; the focus is never lost', async ({
      page,
    }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await tabTo(page, first, 'Tab')
      await page.keyboard.press('Enter')
      await tabTo(page, /^Line 1, changed:/, 'Shift+Tab')
      await page.keyboard.press('Enter')

      // Pick it up from line 1 and move it to line 3.
      await page.keyboard.press('Enter')
      await expect(cell(page, 1)).toHaveAttribute('aria-pressed', 'true')
      await expect(announcer(page)).toHaveText(
        `${first} on line 1 selected. Now choose another line, or put the chip back.`,
      )
      await tabTo(page, /^Line 3, changed:/, 'Tab')
      await page.keyboard.press('Enter')
      await expectCell(page, 1, null)
      await expectCell(page, 3, first)
      await expectFocusInsideTheTable(page)

      // Replace it: the old chip goes back to the tray.
      await tabTo(page, second, 'Tab')
      await page.keyboard.press('Enter')
      await tabTo(page, /^Line 3, changed:/, 'Shift+Tab')
      await expectTagClearOfName(cell(page, 3), 'Enter to replace')
      await page.keyboard.press('Enter')
      await expectCell(page, 3, second)
      await expectInTray(page, first)
      await expectFocusInsideTheTable(page)

      // Pick it up and use "put it back": the focus follows the chip into the tray.
      await page.keyboard.press('Enter')
      await tabTo(page, `Enter to put it back: ${second}`, 'Tab')
      await expect(putBackButton(page, second)).toHaveText('Enter to put it back')
      await page.keyboard.press('Enter')
      await expectCell(page, 3, null)
      expect(await focusedName(page)).toBe(second)
      await expectFocusInsideTheTable(page)

      // Escape while the focus is on "put it back": the focus goes to the chip's cell.
      await page.keyboard.press('Enter')
      await tabTo(page, /^Line 5, changed:/, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await page.keyboard.press('Enter')
      await tabTo(page, `Enter to put it back: ${second}`, 'Tab')
      await page.keyboard.press('Escape')
      expect(await focusedName(page)).toBe(`Line 5, changed: ${second}`)
      await expectFocusInsideTheTable(page)
    })

    test('clearing one line keeps the chip that is selected for another line', async ({ page }) => {
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      // Line 3 holds a chip; then a chip of the tray is selected.
      await tabTo(page, second, 'Tab')
      await page.keyboard.press('Enter')
      await tabTo(page, /^Line 3, changed:/, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await tabTo(page, first, 'Tab')
      await page.keyboard.press('Enter')

      await tabTo(page, /^Line 3, changed:/, 'Shift+Tab')
      await page.keyboard.press('Backspace')
      await expectCell(page, 3, null)
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'true')
      await expect(announcer(page)).toHaveText(
        `Line 3 cleared. ${second} is back with the other chips. ${first} is still selected.`,
      )
      await page.keyboard.press('Enter')
      await expectCell(page, 3, first)
      await expect(announcer(page)).toHaveText(`${first} placed on line 3.`)
    })

    for (const theme of ['light', 'dark'] as const) {
      test(`chips and cells show a clear focus ring (${theme} theme)`, async ({ page }) => {
        await open(page, P1, { dark: theme === 'dark' })
        await tabTo(page, /^Line 1, changed:/, 'Tab')
        for (const focusTarget of [cell(page, 1), trayChip(page, P1.all[0] ?? '')]) {
          await tabTo(page, (await focusTarget.getAttribute('aria-label')) ?? '', 'Tab')
          await expect(focusTarget).toBeFocused()
          await expect(focusTarget).toHaveCSS('outline-style', 'solid')
          await expect(focusTarget).toHaveCSS('outline-width', '2px')
          const colors = await focusTarget.evaluate((element) => ({
            ring: getComputedStyle(element).outlineColor,
            page: getComputedStyle(document.body).backgroundColor,
          }))
          expect(colors.ring).not.toBe(colors.page)
        }
      })
    }

    test('the names and states a screen reader gets', async ({ page }) => {
      await open(page, P1)
      const [first = ''] = P1.right
      await expect(page.getByRole('table', { name: 'Trace table' })).toBeVisible()
      await expect(page.getByRole('table', { name: 'Starting values' })).toBeVisible()
      await expect(page.getByRole('group', { name: 'Chips' })).toBeVisible()
      // The heading of the tray and its help are two sentences, not one word ("ChipsDrag").
      await expect(tray(page).locator('p').first()).toHaveText(/^Chips Drag a chip to a line\./, {
        useInnerText: true,
      })
      // Each cell says its line, what it holds, and the words it shows (Label in Name).
      for (const line of [1, 2, 3, 4, 5])
        await expect(cell(page, line)).toHaveAccessibleName(emptyCellName(line))
      for (const label of P1.all)
        await expect(trayChip(page, label)).toHaveAttribute('aria-pressed', 'false')
      expect(await buttonsWithoutTheirWords(page)).toEqual([])

      // The live region is polite, and the one of dnd-kit stays empty (nothing is read twice).
      await expect(announcer(page)).toHaveAttribute('aria-live', 'polite')
      await dragWithMouse(page, trayChip(page, first), cell(page, 2))
      await expect(announcer(page)).toHaveText(`${first} placed on line 2.`)
      const spoken = await page
        .locator('[role="status"]')
        .evaluateAll((regions) =>
          regions
            .filter((region) => region.closest('header, footer, nav') === null)
            .map((region) => (region.textContent ?? '').trim()),
        )
      expect(spoken.filter((text) => text !== '')).toEqual([`${first} placed on line 2.`])

      // The keyboard instructions are tied to the table and to the tray.
      const table = page.getByRole('table', { name: 'Trace table' })
      await expect(table).toHaveAccessibleDescription(/press Enter on a chip to select it/)
      await expect(tray(page)).toHaveAccessibleDescription(/Press Backspace on a line to clear it/)

      // The names hold the visible words in every state: a chip selected with the keyboard,
      // then a placed chip picked up with the mouse ("put it back" shows in the tray).
      await trayChip(page, P1.trap.label).focus()
      await page.keyboard.press('Enter')
      await expect(cell(page, 2)).toHaveAccessibleName(
        `Line 2, changed: ${first}, Enter to replace`,
      )
      await expect(cell(page, 1)).toHaveAccessibleName(
        'Line 1, changed: empty, Enter to place here',
      )
      expect(await buttonsWithoutTheirWords(page)).toEqual([])
      await page.keyboard.press('Escape')
      await cell(page, 2).click()
      await expect(putBackButton(page, first)).toHaveAccessibleName(
        `click to put it back: ${first}`,
      )
      await expect(putBackButton(page, first)).toHaveText('click to put it back')
      expect(await buttonsWithoutTheirWords(page)).toEqual([])
    })
  })

  /* ─────────────── In a narrow window (desktop: mouse and keyboard) ─────────────── */

  test.describe('in a narrow window', () => {
    test.skip(
      ({ isMobile }) => isMobile,
      'Narrow windows with a mouse and a keyboard: desktop project.',
    )

    // The tray sticks to the bottom of the window at both sizes and covers the lines that
    // scroll under it.
    for (const [width, height] of STICKY_WINDOWS) {
      test(`${width}×${height}: a line that gets the keyboard focus is never hidden under the tray`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height })
        await open(page, P1)
        await expectStickyTray(page)
        await page.evaluate(() => window.scrollTo(0, 0))

        // Tab from the top of the page down through the five lines.
        for (const line of [1, 2, 3, 4, 5]) {
          await tabTo(page, new RegExp(`^Line ${line}, changed:`), 'Tab')
          await expectInSight(cell(page, line), `Tab to line ${line}`)
        }
        // Shift+Tab back up from the last chip of the tray.
        await tabTo(page, P1.all.at(-1) ?? '', 'Tab')
        await page.evaluate(() => window.scrollTo(0, 0))
        for (const line of [5, 4, 3, 2, 1]) {
          await tabTo(page, new RegExp(`^Line ${line}, changed:`), 'Shift+Tab')
          await expectInSight(cell(page, line), `Shift+Tab to line ${line}`)
        }
      })
    }

    // A laptop window (and a small one, 853 px wide): the tray stands beside the table and
    // sticks to nothing, so it covers no line and no starting value.
    for (const [width, height] of [
      [853, 683],
      [1280, 800],
    ] as const) {
      test(`${width}×${height}: the tray stands beside the table and covers nothing`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height })
        await open(page, P1)
        await expect(tray(page)).not.toHaveCSS('position', 'sticky')
        const [table, chips] = await Promise.all([
          page.locator('[data-trace-table] table').last().boundingBox(),
          tray(page).boundingBox(),
        ])
        expect(chips?.x ?? 0, 'the tray is to the right of the table').toBeGreaterThanOrEqual(
          (table?.x ?? 0) + (table?.width ?? 0),
        )
        await page.locator('[data-trace-table]').evaluate((element) => element.scrollIntoView())
        for (const line of [1, 2, 3, 4, 5]) await expectInSight(cell(page, line), `line ${line}`)
        for (const label of P1.all) await expectInSight(trayChip(page, label), `the chip ${label}`)
      })
    }

    test(`${STICKY_PHONE.width}×${STICKY_PHONE.height}: a line that a keyboard move sends the focus to is scrolled out from under the tray`, async ({
      page,
    }) => {
      await page.setViewportSize(STICKY_PHONE)
      await open(page, P1)
      await expectStickyTray(page)
      const [first = ''] = P1.right
      // Put a chip on line 5 and pick it up again: "put it back" shows in the tray.
      await tabTo(page, first, 'Tab')
      await page.keyboard.press('Enter')
      await tabTo(page, /^Line 5, changed:/, 'Shift+Tab')
      await page.keyboard.press('Enter')
      await expectInSight(cell(page, 5), 'line 5 after the chip was placed')
      await page.keyboard.press('Enter')
      await tabTo(page, `Enter to put it back: ${first}`, 'Tab')

      // Line 5 under the tray, then Escape: the focus goes to line 5, out from under it.
      await row(page, 5).evaluate((element) => {
        const tray = document.querySelector('[data-trace-tray]')
        const trayTop = tray?.getBoundingClientRect().top ?? window.innerHeight
        const box = element.getBoundingClientRect()
        // Scroll so that the middle of line 5 is 20 px below the top of the tray.
        window.scrollBy(0, box.top + box.height / 2 - (trayTop + 20))
      })
      expect(
        await cell(page, 5).evaluate((element) => {
          const box = element.getBoundingClientRect()
          const middle = document.elementFromPoint(
            box.left + box.width / 2,
            box.top + box.height / 2,
          )
          return middle !== null && element.contains(middle)
        }),
        'line 5 starts out under the tray',
      ).toBe(false)
      await page.keyboard.press('Escape')
      expect(await focusedName(page)).toBe(`Line 5, changed: ${first}`)
      await expectInSight(cell(page, 5), 'line 5 after Escape')
    })

    for (const width of [320, 360, 414]) {
      test(`${width} px wide: a label on a chip never covers the register name`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 800 })
        await open(page, P1)
        const [first = ''] = P1.right
        const other = P1.trap.label
        // A chip on line 1, placed with the keyboard.
        await tabTo(page, first, 'Tab')
        await page.keyboard.press('Enter')
        await tabTo(page, /^Line 1, changed:/, 'Shift+Tab')
        await page.keyboard.press('Enter')

        // A chip of the tray selected with the keyboard: "Enter to replace".
        await trayChip(page, other).focus()
        await page.keyboard.press('Enter')
        await expectTagClearOfName(cell(page, 1), 'Enter to replace')
        await page.keyboard.press('Escape')
        // … with the mouse: "click to replace".
        await trayChip(page, other).click()
        await expectTagClearOfName(cell(page, 1), 'click to replace')
        await trayChip(page, other).click()
        // The chip of line 1 picked up: "selected".
        await cell(page, 1).click()
        await expectTagClearOfName(cell(page, 1), 'selected')
        await cell(page, 1).click()
        // A chip held over line 1: "drop to replace".
        await row(page, 1).evaluate((element) => element.scrollIntoView({ block: 'start' }))
        await dragWithMouse(page, trayChips(page).first(), cell(page, 1), {
          whileHeld: () => expectTagClearOfName(cell(page, 1), 'drop to replace'),
        })
        await expectNoSidewaysScroll(page)
      })
    }
  })

  /* ───────────────────────────── After Check ───────────────────────────── */

  test.describe('after Check', () => {
    test('nothing can be moved by mouse or keyboard', async ({ page, isMobile }) => {
      test.skip(isMobile, 'The mouse and the keyboard are tested in the desktop project.')
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await dragWithMouse(page, trayChip(page, first), cell(page, 1))
      await dragWithMouse(page, trayChip(page, second), cell(page, 2))
      await checkButton(page).click()
      await expect(row(page, 1)).toHaveAttribute('data-result', 'right')
      const callsBefore = await changeLog(page, target)

      // The table holds no button any more.
      const view = page.locator('[data-trace-table]')
      await expect(view.getByRole('button')).toHaveCount(0)
      await expect(view).toHaveAttribute('data-locked', '')

      // Mouse: try to drag a placed chip to another line and a tray chip onto a line.
      await watchForDraggedChip(page)
      const placed = row(page, 1).locator('[data-chip-id]')
      const leftOver = trayChips(page).first()
      for (const [from, to] of [
        [placed, row(page, 4)],
        [leftOver, row(page, 3)],
        [placed, tray(page)],
      ] as const) {
        await from.scrollIntoViewIfNeeded()
        const start = await centerOf(from)
        const end = await centerOf(to)
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 10, start.y + 6, { steps: 3 })
        await page.mouse.move(end.x, end.y, { steps: 8 })
        await page.mouse.up()
      }
      await placed.click()
      await leftOver.click()
      await row(page, 3).click()
      expect(await sawDraggedChip(page)).toBe(false)

      // Keyboard: Tab through the whole page. The focus never enters the table.
      await page.mouse.click(5, 5)
      for (let presses = 0; presses < 20; presses++) {
        await page.keyboard.press('Tab')
        const inside = await page.evaluate(
          () => document.activeElement?.closest('[data-trace-table]') !== null,
        )
        expect(inside).toBe(false)
        await page.keyboard.press('Backspace')
      }
      await page.keyboard.press('Escape')

      await expect(row(page, 1).locator('[data-chip-id]')).toHaveText(first)
      await expect(row(page, 2).locator('[data-chip-id]')).toHaveText(second)
      await expect(row(page, 3)).toHaveAttribute('data-state', 'empty')
      await expect(trayChips(page)).toHaveCount(P1.all.length - 2)
      await expectChangeLog(page, target, callsBefore)
      await expect(tray(page)).toContainText('Chips you did not use')
    })

    test('nothing can be moved by tapping or by a held touch', async ({ page, isMobile }) => {
      test.skip(!isMobile, 'Touch is tested in the phone project.')
      await open(page, P1)
      const [first = '', second = ''] = P1.right
      await trayChip(page, first).tap()
      await cell(page, 1).tap()
      await trayChip(page, second).tap()
      await cell(page, 2).tap()
      await checkButton(page).tap()
      await expect(row(page, 1)).toHaveAttribute('data-result', 'right')
      const callsBefore = await changeLog(page, target)

      await expect(page.locator('[data-trace-table]').getByRole('button')).toHaveCount(0)
      // After Check the tray does not cover the table any more.
      await expect(tray(page)).toHaveCSS('position', 'static')

      await watchForDraggedChip(page)
      const placed = row(page, 1).locator('[data-chip-id]')
      const leftOver = trayChips(page).first()
      await placed.tap()
      await row(page, 3).tap()
      await leftOver.tap()
      await row(page, 4).tap()

      const session = await touchSession(page)
      await placed.scrollIntoViewIfNeeded()
      const from = await centerOf(placed)
      // Longer than the long press that lifts a chip while the table is open.
      await touch(session, 'touchStart', from)
      await page.waitForTimeout(700)
      await slide(page, session, from, { x: from.x, y: from.y + 60 }, 6)
      await touch(session, 'touchEnd')

      expect(await sawDraggedChip(page)).toBe(false)
      await expect(row(page, 1).locator('[data-chip-id]')).toHaveText(first)
      await expect(row(page, 3)).toHaveAttribute('data-state', 'empty')
      await expect(row(page, 4)).toHaveAttribute('data-state', 'empty')
      await expectChangeLog(page, target, callsBefore)
      // The rows that were left empty say so, and show the right chip.
      await expect(row(page, 3).getByText('Left blank', { exact: true })).toBeVisible()
      await expect(row(page, 3).locator('[data-trace-right-answer]')).toHaveText(P1.right[2] ?? '')
      await expectNoSidewaysScroll(page)
    })

    test('"Try again" gives a clean table that works again', async ({ page, isMobile }) => {
      test.skip(!target.canTryAgain, 'Only the harness has "Try again".')
      await open(page, P1)
      const [first = ''] = P1.right
      const act = async (button: Locator) => (isMobile ? button.tap() : button.click())
      await act(trayChip(page, P1.trap.label))
      await act(cell(page, 1))
      // A chip is still selected when Check is pressed: it must not come back selected.
      await act(trayChip(page, first))
      await expect(trayChip(page, first)).toHaveAttribute('aria-pressed', 'true')
      await expect(announcer(page)).toHaveText(`${first} selected. Now choose a line.`)
      await act(checkButton(page))
      await expect(row(page, 1)).toHaveAttribute('data-result', 'wrong')
      // No old instruction is left for a screen reader under the checked table.
      await expect(announcer(page)).toHaveText('')

      await act(tryAgainButton(page))
      await expect(feedback(page)).toHaveText('')
      await expect(page.locator('[data-result]')).toHaveCount(0)
      for (const line of [1, 2, 3, 4, 5])
        await expect(cell(page, line)).toHaveAccessibleName(emptyCellName(line))
      await expect(trayChips(page)).toHaveCount(P1.all.length)
      await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0)
      await expect(announcer(page)).toHaveText('')

      await act(trayChip(page, first))
      await act(cell(page, 1))
      await expectCell(page, 1, first)
    })
  })
}

/* ───────────────────────── Both pages ───────────────────────── */

for (const target of [HARNESS, PRACTICE]) {
  test.describe(target.name, () => {
    test.skip(
      target.devOnly && process.env.E2E_DEV !== '1',
      'The trace-table harness is a developer page that only the dev server serves. Run with E2E_DEV=1.',
    )

    // The first visit makes the dev server prepare dnd-kit, which can reload the page once.
    // Do that here, so no test is cut off by it.
    test.beforeAll(async ({ browser }) => {
      const page = await browser.newPage()
      await page.goto(target.samples[0].address)
      await page.locator('[data-trace-table]').waitFor()
      await page.waitForLoadState('networkidle')
      await page.reload()
      await page.locator('[data-trace-table]').waitFor()
      await page.waitForLoadState('networkidle')
      await page.close()
    })

    traceTableTests(target)
  })
}

/* ───────────────────────── Only in the practice page ───────────────────────── */

/**
 * What only the practice page has: its Check bar (which must not stick while the tray
 * does) and the width of the practice card on a laptop and a tablet. Seed 2 is the one the
 * browser review used: its right chip for line 5 sat in a covered row.
 */
const REAL = PRACTICE.samples[0]

/**
 * True when nothing lies on the middle of the element (no sticky bar, no tray): the hit
 * test finds the element itself. An element off the screen counts as uncovered.
 */
async function uncovered(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const y = box.top + box.height / 2
    if (y <= 0 || y >= window.innerHeight) return true
    const middle = document.elementFromPoint(box.left + box.width / 2, y)
    return middle !== null && element.contains(middle)
  })
}

async function expectNothingCovered(page: Page, sample: Sample, when: string) {
  for (const line of [1, 2, 3, 4, 5]) {
    expect(await uncovered(cell(page, line)), `${when}: line ${line} is covered`).toBe(true)
  }
  for (const label of sample.all) {
    expect(await uncovered(trayChip(page, label)), `${when}: the chip ${label} is covered`).toBe(
      true,
    )
  }
}

test.describe('in the practice page', () => {
  test.describe('on a laptop or a tablet', () => {
    test.skip(({ isMobile }) => isMobile, 'Mouse and keyboard: desktop project.')

    for (const [width, height] of [
      [1280, 800],
      [1366, 768],
      [768, 1024],
    ] as const) {
      test(`${width}×${height}: when the page opens, the tray covers no line and nothing covers the tray`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height })
        await PRACTICE.open(page, REAL)
        await page.evaluate(() => window.scrollTo(0, 0))
        await expect(tray(page)).not.toHaveCSS('position', 'sticky')
        await expectNothingCovered(page, REAL, 'at the top of the page')
        if (width >= 1024) {
          // A laptop: the tray stands beside the table.
          const [table, chips] = await Promise.all([
            page.locator('[data-trace-table] table').last().boundingBox(),
            tray(page).boundingBox(),
          ])
          expect(chips?.x ?? 0).toBeGreaterThanOrEqual((table?.x ?? 0) + (table?.width ?? 0))
        }
        await expectNoSidewaysScroll(page)
      })
    }

    test('after Check with the keyboard, the focused "Next problem" is in view with the feedback', async ({
      page,
    }) => {
      // The browser review: the page scrolled to the feedback and left the focused button
      // below the window (y 817–861 in an 800 px window).
      await PRACTICE.open(page, REAL)
      for (const [index, right] of REAL.right.entries()) {
        await dragWithMouse(page, trayChip(page, right), cell(page, index + 1))
      }
      await checkButton(page).focus()
      await expectCheckReady(page)
      await page.keyboard.press('Enter')
      await expect(feedback(page)).toContainText('Correct')
      const next = page.getByRole('button', { name: 'Next problem' })
      await expect(next).toBeFocused()
      await expect(next).toBeInViewport({ ratio: 1 })
      await expect(feedback(page)).toBeInViewport()
    })
  })

  test.describe('on a phone', () => {
    test.skip(({ isMobile }) => !isMobile, 'Touch: phone project.')

    test(`${STICKY_PHONE.width}×${STICKY_PHONE.height}: the tray sticks to the bottom alone: no Check bar covers a chip while the table scrolls`, async ({
      page,
    }) => {
      await page.setViewportSize(STICKY_PHONE)
      await PRACTICE.open(page, REAL)
      await page.evaluate(() => window.scrollTo(0, 0))
      await expectStickyTray(page)
      await expect(page.locator('[data-primary-bar]')).toHaveAttribute('data-primary-bar', 'static')
      for (const y of [0, 150, 300, 450]) {
        await page.evaluate((top) => window.scrollTo(0, top), y)
        for (const label of REAL.all) {
          expect(await uncovered(trayChip(page, label)), `scroll ${y}: ${label}`).toBe(true)
        }
      }
      // Fill every line by tapping, then Check.
      for (const [index, label] of REAL.right.entries()) {
        await trayChip(page, label).tap()
        await cell(page, index + 1).tap()
        await expectCell(page, index + 1, label)
      }
      await checkButton(page).tap()
      await expect(feedback(page)).toContainText('Correct')
      for (const line of [1, 2, 3, 4, 5]) {
        await expect(row(page, line)).toHaveAttribute('data-result', 'right')
      }
      await expectNoSidewaysScroll(page)
    })

    test('360×740: chips placed by tapping, a tempting one among them; Check names the mistake', async ({
      page,
    }) => {
      await PRACTICE.open(page, REAL)
      await page.evaluate(() => window.scrollTo(0, 0))
      await expect(page.locator('[data-primary-bar]')).toHaveAttribute('data-primary-bar', 'static')
      await expectNothingCovered(page, REAL, 'at the top of the page')
      for (const [index, right] of REAL.right.entries()) {
        const line = index + 1
        const label = line === REAL.trap.line ? REAL.trap.label : right
        await trayChip(page, label).tap()
        await cell(page, line).tap()
        await expectCell(page, line, label)
      }
      await checkButton(page).tap()
      await expect(feedback(page)).toContainText('Not yet')
      await expect(feedback(page).getByTestId('mistake')).toContainText(REAL.trap.message)
      await expect(row(page, REAL.trap.line)).toHaveAttribute('data-result', 'wrong')
      await expectNoSidewaysScroll(page)
    })
  })
})
