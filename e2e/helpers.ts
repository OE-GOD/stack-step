/// <reference lib="dom" />
/**
 * Helpers for browser tests that use the stepper (the page, and later lessons and
 * practice). They work in both Playwright projects (desktop 1280×800, phone 360×740).
 *
 *   await openStepper(page, '?example=factorial')
 *   await setCode(page, 'main:\n    mov rax, 5\n    ret\n')
 *   await pressStep(page, 2)
 *   expect(await registerValue(page, 'rax')).toBe('0x0000000000000005')
 *
 * The first line gives this file the browser types for callbacks that run in the page.
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** Ctrl on Windows and Linux, Cmd on a Mac (as the page's shortcuts accept both). */
export const MOD = 'ControlOrMeta'

/** The names of the page's states (`data-status` on the page). */
export type StepperStatus =
  'ready' | 'running' | 'paused' | 'waiting' | 'ended' | 'error' | 'problems'

export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 1024
}

/**
 * True for the one console line that every test may ignore: the browser's own report of a
 * failed request to the optional tutor function. On a host without that function (the
 * built site served by `vite preview`, or any static host) the tutor's one availability
 * check gets a 404, and the browser logs the failed request; the page then hides the
 * tutor, as it should. A test that mocks the tutor's answers (429, 503, a broken
 * connection) sees the same kind of line for those requests.
 */
function isFailedTutorRequest(type: string, text: string, url: string): boolean {
  return (
    type === 'error' && text.startsWith('Failed to load resource') && url.endsWith('/api/tutor')
  )
}

/**
 * Collect everything the browser reports as an error while a test runs: console errors
 * and uncaught exceptions. Exactly one thing is left out (see `isFailedTutorRequest`).
 * Every spec uses this one rule.
 */
export function watchForErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    if (isFailedTutorRequest(message.type(), message.text(), message.location().url)) return
    errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  return errors
}

export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, 'the page must not be wider than the screen').toBeLessThanOrEqual(clientWidth)
}

/** The stepper page (not a MiniStepper). */
export function stepperPage(page: Page): Locator {
  return page.locator('[data-stepper-page]')
}

/** The code editor, found by its accessible name. */
export function codeEditor(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Assembly code' })
}

/**
 * Open the stepper (with an optional query such as '?example=factorial') and wait until
 * the code editor is ready.
 */
export async function openStepper(page: Page, query = ''): Promise<void> {
  await page.goto(`/#/stepper${query}`)
  await expect(codeEditor(page)).toBeVisible()
  await expect(stepperPage(page)).toBeVisible()
}

/** Load an example from the Example menu by its title. */
export async function chooseExample(page: Page, title: string): Promise<void> {
  await stepperPage(page).getByLabel('Example', { exact: true }).selectOption({ label: title })
  await expect(stepperPage(page).getByLabel('Example', { exact: true })).toHaveValue(/.+/)
}

/**
 * Replace the whole program in the editor, as a student who pastes code does, and wait
 * until the page has read it.
 */
export async function setCode(page: Page, text: string): Promise<void> {
  await codeEditor(page).click()
  await page.keyboard.press(`${MOD}+a`)
  if (text === '') await page.keyboard.press('Delete')
  else await page.keyboard.insertText(text)
  await expect(stepperPage(page)).not.toHaveAttribute('data-edit-pending', 'true')
}

/**
 * Paste text into the editor the way Ctrl+V or a phone's Paste menu does (a real paste
 * event, not typing: typing turns curly quotes into plain ones, a paste keeps them).
 * Replaces the selection; call after selecting what should be replaced.
 */
export async function pasteIntoEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').evaluate((element, pasted) => {
    const data = new DataTransfer()
    data.setData('text/plain', pasted)
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

/** The cell of the editor's line-number column that shows `line` (click it for a breakpoint). */
export function lineNumberCell(page: Page, line: number): Locator {
  return page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: new RegExp(`^${line}$`) })
}

/**
 * The line-number cell of `line`, scrolled into the editor's view first: CodeMirror draws
 * only the lines near the part that is on the screen.
 */
export async function visibleLineNumberCell(page: Page, line: number): Promise<Locator> {
  const cell = lineNumberCell(page, line)
  const scroller = page.locator('.cm-scroller')
  await scroller.evaluate((element) => element.scrollTo(0, 0))
  for (let i = 0; i < 60 && (await cell.count()) === 0; i++) {
    await scroller.evaluate((element) => element.scrollBy(0, element.clientHeight / 2))
  }
  await cell.scrollIntoViewIfNeeded()
  return cell
}

/** The lines that show a breakpoint dot in the editor, ascending. */
export async function breakpointLines(page: Page): Promise<number[]> {
  const labels = await page
    .locator('.cm-gutters .cm-ss-breakpoint')
    .evaluateAll((marks) => marks.map((mark) => mark.getAttribute('aria-label') ?? ''))
  return labels.map((label) => Number(/(\d+)$/.exec(label)?.[1] ?? NaN)).sort((a, b) => a - b)
}

/** The line the editor marks with the "runs next" arrow, or null when none is marked. */
export async function markedCurrentLine(page: Page): Promise<number | null> {
  const arrow = page.locator('.cm-gutters .cm-ss-arrow')
  if ((await arrow.count()) === 0) return null
  const label = (await arrow.getAttribute('aria-label')) ?? ''
  return Number(/^Line (\d+) runs next$/.exec(label)?.[1] ?? NaN)
}

/** Put the text cursor at the end of the first line of code that contains `text`. */
export async function cursorToEndOf(page: Page, text: string): Promise<void> {
  await page.locator('.cm-line', { hasText: text }).first().click()
  await page.keyboard.press('End')
}

/** A button of the stepper's controls ('Step', 'Back', 'Run', 'Pause', 'Reset'). */
export function control(page: Page, name: string): Locator {
  return stepperPage(page).getByRole('button', { name, exact: true })
}

/** Set the speed of Run (1 … 10; 10 is "instant"). */
export async function setRunSpeed(page: Page, speed: number): Promise<void> {
  await stepperPage(page).getByRole('slider', { name: 'Run speed' }).fill(String(speed))
}

/** The Explanation card (its heading is hidden on a phone, but it keeps its name). */
export function explanation(page: Page): Locator {
  return stepperPage(page).getByRole('region', { name: 'Explanation' })
}

/** The fixed control bar of a narrow screen (Step, Back, Run, Reset and the status). */
export function controlBar(page: Page): Locator {
  return stepperPage(page).locator('[data-stepper-bar]')
}

/** The scanf input box (opens the Output tab on a phone). */
export async function inputBox(page: Page): Promise<Locator> {
  await showTab(page, 'Output')
  return stepperPage(page).getByRole('region', { name: 'Output' }).getByRole('textbox')
}

/** Where an element is on the PAGE (not on the screen), in px from the top. */
export async function pageTop(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().top + window.scrollY)
}

/** Press Step `times` times. */
export async function pressStep(page: Page, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) await control(page, 'Step').click()
}

/** Press Step until the program cannot step any more (or `limit` presses). */
export async function stepToTheEnd(page: Page, limit = 200): Promise<void> {
  const step = control(page, 'Step')
  for (let i = 0; i < limit && (await step.isEnabled()); i++) await step.click()
}

/** The state of the page: 'ready', 'paused', 'ended', … */
export async function expectStatus(page: Page, status: StepperStatus): Promise<void> {
  await expect(stepperPage(page)).toHaveAttribute('data-status', status)
}

/** The status line the student sees (in the bottom bar on a phone). */
export function statusLine(page: Page): Locator {
  return stepperPage(page).locator('[data-stepper-status]:visible')
}

/** How many steps have run. */
export async function stepCount(page: Page): Promise<number> {
  return Number(await stepperPage(page).getAttribute('data-steps'))
}

/** On a phone, show one of the tabs (Registers · Stack · Output). Does nothing on a desktop. */
export async function showTab(page: Page, name: 'Registers' | 'Stack' | 'Output'): Promise<void> {
  if (!isPhone(page)) return
  const tab = stepperPage(page).getByRole('tab', { name: new RegExp(`^${name}`) })
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
}

/** The row of a register in the Registers panel (opens the Registers tab on a phone). */
export async function registerRow(page: Page, name: string): Promise<Locator> {
  await showTab(page, 'Registers')
  return stepperPage(page).locator(`[data-register="${name}"]`)
}

/** A register's value as it is copied: '0x0000000000000005'. */
export async function registerValue(page: Page, name: string): Promise<string> {
  const row = await registerRow(page, name)
  return (await row.locator('[data-hex]').first().textContent()) ?? ''
}

/** Everything the program printed ('' when nothing). Opens the Output tab on a phone. */
export async function outputText(page: Page): Promise<string> {
  await showTab(page, 'Output')
  const output = stepperPage(page).locator('[data-output]')
  if ((await output.count()) === 0) return ''
  return (await output.textContent()) ?? ''
}

/** The stack box that rsp points at (opens the Stack tab on a phone). */
export async function rspBox(page: Page): Promise<Locator> {
  await showTab(page, 'Stack')
  return stepperPage(page).locator('[data-stack-box][data-rsp="true"]')
}

/**
 * Make the page's clipboard record what is copied (and optionally fail), before the page
 * loads. Read it back with `copiedText`.
 */
export async function fakeClipboard(page: Page, works = true): Promise<void> {
  await page.addInitScript((ok) => {
    const store = window as unknown as { __copied?: string }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string) => {
          if (!ok) return Promise.reject(new Error('The clipboard is blocked.'))
          store.__copied = text
          return Promise.resolve()
        },
      },
    })
  }, works)
}

export async function copiedText(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as unknown as { __copied?: string }).__copied)
}

/** Make every use of localStorage throw, as a browser with blocked storage does. */
export async function blockStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('Storage is blocked.')
      },
    })
  })
}
