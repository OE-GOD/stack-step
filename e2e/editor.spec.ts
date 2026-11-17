/// <reference lib="dom" />
/**
 * The code editor (CodeMirror 6), tested in a real browser on its harness page.
 *
 * The harness (src/features/stepper/editor/demo.html) is a developer page. Only the dev
 * server serves it, so these tests need E2E_DEV=1:
 *
 *   E2E_DEV=1 E2E_PORT=5195 npx playwright test e2e/editor.spec.ts
 *
 * They run in both Playwright projects (desktop 1280×800, phone 360×740). Without
 * E2E_DEV they are skipped, so the production run (build + preview) stays green.
 *
 * The first line gives this file the browser types (`document`, `window`) for the
 * callbacks that run inside the page.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { watchForErrors } from './helpers'

test.skip(
  process.env.E2E_DEV !== '1',
  'The editor harness is a developer page that only the dev server serves. Run with E2E_DEV=1.',
)

const HARNESS = '/src/features/stepper/editor/demo.html'

/** What the harness page exposes as `window.__editorHarness` (see EditorDemoPage.tsx). */
interface HarnessDiagnostic {
  severity: 'error' | 'warning'
  code: string
  line: number
  message: string
}

interface HarnessState {
  source: string
  currentLine: number | null
  libraryLine: number | null
  breakpoints: number[]
  diagnostics: HarnessDiagnostic[]
}

interface HarnessSnapshot extends HarnessState {
  changes: number
  toggles: number
  steps: number
  backs: number
  runs: number
}

interface HarnessWindow {
  __editorHarness?: {
    get: () => HarnessSnapshot
    set: (change: Partial<HarnessState>) => void
  }
  __announced?: string[]
  __keysHeard?: number
}

const ERROR_14: HarnessDiagnostic = {
  severity: 'error',
  code: 'unknown-instruction',
  line: 14,
  message: 'Line 14: `mvo` is not an instruction. Did you mean `mov`?',
}

const WARNING_5: HarnessDiagnostic = {
  severity: 'warning',
  code: 'unknown-directive',
  line: 5,
  message: 'Line 5: Stack Step does not know the directive `.type`. It is skipped.',
}

/** Ctrl on Windows and Linux, Cmd on a Mac: CodeMirror's "Mod". */
const MOD = 'ControlOrMeta'

/* ───────────────────────────── Helpers ───────────────────────────── */

function editor(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Assembly code' })
}

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`${HARNESS}${query}`)
  await expect(editor(page)).toBeVisible()
  // The harness sets this in an effect, right after the first render.
  await page.waitForFunction(() => (window as HarnessWindow).__editorHarness !== undefined)
}

async function snapshot(page: Page): Promise<HarnessSnapshot> {
  return page.evaluate(() => {
    const harness = (window as HarnessWindow).__editorHarness
    if (harness === undefined) throw new Error('The harness is not ready.')
    return harness.get()
  })
}

async function setState(page: Page, change: Partial<HarnessState>): Promise<void> {
  await page.evaluate((part) => {
    const harness = (window as HarnessWindow).__editorHarness
    if (harness === undefined) throw new Error('The harness is not ready.')
    harness.set(part)
  }, change)
}

async function loadExample(page: Page, title: string): Promise<void> {
  await page.getByLabel('Example').selectOption({ label: title })
}

/** The line of code that contains `text` (the first one). */
function codeLine(page: Page, text: string): Locator {
  return page.locator('.cm-line', { hasText: text }).first()
}

/** The cell of the line-number column that shows `line`. */
function lineNumberCell(page: Page, line: number): Locator {
  return page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: new RegExp(`^${line}$`) })
}

/** The middle of the row of `line` in the marks column (the column left of the numbers). */
async function marksRowPoint(page: Page, line: number): Promise<{ x: number; y: number }> {
  const number = await lineNumberCell(page, line).boundingBox()
  const marks = await page.locator('.cm-ss-marks').boundingBox()
  if (number === null || marks === null) throw new Error(`Line ${line} is not on the screen.`)
  // Right of the middle: left of it is the place of the `!` mark.
  return { x: marks.x + marks.width * 0.7, y: number.y + number.height / 2 }
}

function mark(page: Page, label: string): Locator {
  return page.locator(`.cm-gutters [aria-label="${label}"]`)
}

function messageBox(page: Page): Locator {
  return page.locator('.cm-tooltip .cm-ss-message')
}

/** The color that a CSS variable of the site stands for right now, as `rgb(…)`. */
async function tokenColor(page: Page, variable: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, variable)
}

async function style(locator: Locator, property: string, pseudo?: string): Promise<string> {
  return locator.evaluate(
    (element, [name, pseudoElement]) =>
      getComputedStyle(element, pseudoElement ?? null).getPropertyValue(name ?? ''),
    [property, pseudo] as const,
  )
}

async function scrollTop(page: Page): Promise<number> {
  return page.locator('.cm-scroller').evaluate((element) => element.scrollTop)
}

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth, 'the page must not be wider than the screen').toBeLessThanOrEqual(clientWidth)
}

/** Record what the editor reads out for screen readers (CodeMirror clears it after 200 ms). */
async function recordAnnouncements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const region = document.querySelector('.cm-announced')
    if (region === null) throw new Error('The editor has no live region.')
    const heard: string[] = []
    ;(window as HarnessWindow).__announced = heard
    new MutationObserver(() => {
      // CodeMirror empties the region by writing one non-breaking space into it.
      const text = (region.textContent ?? '').replaceAll(String.fromCharCode(0xa0), '').trim()
      if (text !== '' && heard[heard.length - 1] !== text) heard.push(text)
    }).observe(region, { childList: true, subtree: true, characterData: true })
  })
}

async function announcements(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as HarnessWindow).__announced ?? [])
}

/* ───────────────────────────── Set-up ───────────────────────────── */

let errors: string[] = []

// The first visit makes the dev server prepare CodeMirror, which can reload the page
// once. Do that here, so no test is cut off by it.
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await page.goto(HARNESS)
  await page.locator('.cm-content').waitFor()
  await page.waitForLoadState('networkidle')
  await page.reload()
  await page.locator('.cm-content').waitFor()
  await page.waitForLoadState('networkidle')
  await page.close()
})

test.beforeEach(({ page }) => {
  errors = watchForErrors(page)
})

test.afterEach(() => {
  expect(errors, 'the browser console must stay free of errors').toEqual([])
})

/* ───────────────────────────── The text ───────────────────────────── */

test.describe('the text', () => {
  test('shows the program in one editor, also under StrictMode', async ({ page }) => {
    await open(page)
    await expect(page.locator('.cm-editor')).toHaveCount(1)
    await expect(editor(page)).toContainText('# Hello World: print one line of text.')
    await expect(lineNumberCell(page, 1)).toBeVisible()
    await expect(lineNumberCell(page, 19)).toBeVisible()
  })

  test('typing appears in order and onChange fires', async ({ page }) => {
    await open(page)
    await codeLine(page, 'main:').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('mov     rcx, 0x2A   # typed fast', { delay: 0 })

    // Every character is there, in the order it was typed: no cursor jumps.
    await expect(codeLine(page, 'typed fast')).toHaveText('mov     rcx, 0x2A   # typed fast')
    await expect
      .poll(async () => (await snapshot(page)).source)
      .toContain('main:\nmov     rcx, 0x2A   # typed fast\n    push    rbp')
    expect((await snapshot(page)).changes).toBeGreaterThan(0)
  })

  test('keeps typing in place while the page changes other props', async ({ page }) => {
    await open(page)
    await codeLine(page, 'main:').click()
    await page.keyboard.press('End')
    for (const [index, letter] of [...' # abcdef'].entries()) {
      await page.keyboard.type(letter)
      // The page moves the "runs next" mark between the key presses.
      await setState(page, { currentLine: 11 + (index % 3), breakpoints: [index + 1] })
    }
    await expect(codeLine(page, 'abcdef')).toHaveText('main: # abcdef')
    await expect(editor(page)).toBeFocused()
  })

  test('loading another example replaces the text without calling onChange', async ({ page }) => {
    await open(page)
    await loadExample(page, 'Factorial (loop)')
    await expect(editor(page)).toContainText('# Factorial with a loop')
    await expect(editor(page)).not.toContainText('Hello World: print one line')
    await expect(codeLine(page, 'imul')).toBeVisible()

    await loadExample(page, 'Empty program')
    await expect(editor(page)).toHaveText('')
    expect((await snapshot(page)).changes).toBe(0)
  })

  test('undo takes typing back, and brings back the program that an example replaced', async ({
    page,
  }) => {
    await open(page)
    await codeLine(page, 'main:').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' # mine')
    await expect(codeLine(page, '# mine')).toHaveText('main: # mine')

    await loadExample(page, 'Factorial (loop)')
    await expect(editor(page)).toContainText('# Factorial with a loop')

    await editor(page).click()
    await page.keyboard.press(`${MOD}+z`)
    await expect(editor(page)).toContainText('# Hello World: print one line of text.')
    await expect(codeLine(page, '# mine')).toHaveText('main: # mine')
    // The page was told: it holds the old program again.
    await expect.poll(async () => (await snapshot(page)).source).toContain('main: # mine')

    await page.keyboard.press(`${MOD}+z`)
    await expect(codeLine(page, 'main:')).toHaveText('main:')
  })

  test('a small change from outside keeps the scroll position; a new program starts at the top', async ({
    page,
  }) => {
    await open(page)
    await loadExample(page, 'Read a number (scanf)')
    const scroller = page.locator('.cm-scroller')
    await scroller.evaluate((element) => {
      element.scrollTop = 240
    })
    await expect.poll(() => scrollTop(page)).toBe(240)

    await page.getByRole('button', { name: 'Add a last line from outside' }).click()
    await expect.poll(async () => (await snapshot(page)).source).toMatch(/ {4}nop\n$/)
    expect(await scrollTop(page)).toBe(240)

    await loadExample(page, 'Biggest number in an array')
    await expect(editor(page)).toContainText('# Find the biggest number in an array.')
    await expect.poll(() => scrollTop(page)).toBe(0)
    expect((await snapshot(page)).changes).toBe(0)
  })
})

/* ─────────────────────────── Breakpoints ─────────────────────────── */

test.describe('breakpoints', () => {
  test('a click on the line number or on the marks column switches a breakpoint', async ({
    page,
  }) => {
    await open(page)
    await lineNumberCell(page, 12).click()
    await expect(mark(page, 'Breakpoint on line 12')).toBeVisible()
    expect((await snapshot(page)).breakpoints).toEqual([12])

    const row15 = await marksRowPoint(page, 15)
    await page.mouse.click(row15.x, row15.y)
    await expect(mark(page, 'Breakpoint on line 15')).toBeVisible()
    expect((await snapshot(page)).breakpoints).toEqual([12, 15])

    // The dot is a shape in the "wrong" color of the site, not color alone.
    const dot = mark(page, 'Breakpoint on line 12')
    expect(await style(dot, 'border-top-color')).toBe(await tokenColor(page, '--c-bad'))
    expect(await style(dot, 'border-radius')).toBe('50%')
    const dotBox = await dot.boundingBox()
    expect(dotBox?.width).toBe(dotBox?.height)
    expect(dotBox?.width ?? 0).toBeGreaterThanOrEqual(10)

    const row12 = await marksRowPoint(page, 12)
    await page.mouse.click(row12.x, row12.y)
    await expect(mark(page, 'Breakpoint on line 12')).toHaveCount(0)
    await lineNumberCell(page, 15).click()
    await expect(mark(page, 'Breakpoint on line 15')).toHaveCount(0)
    expect((await snapshot(page)).breakpoints).toEqual([])
  })

  test('the place to click is the whole row, and wide enough', async ({ page }) => {
    await open(page)
    const marks = await page.locator('.cm-ss-marks').boundingBox()
    const numbers = await page.locator('.cm-lineNumbers').boundingBox()
    const row = await lineNumberCell(page, 12).boundingBox()
    const line = await codeLine(page, 'mov     rbp, rsp').boundingBox()
    if (marks === null || numbers === null || row === null || line === null) {
      throw new Error('The gutters are not on the screen.')
    }
    expect(marks.width).toBeGreaterThanOrEqual(24)
    expect(marks.width + numbers.width).toBeGreaterThanOrEqual(44)
    expect(row.height).toBe(line.height)

    // The very top and the very bottom of the row both count.
    const { x } = await marksRowPoint(page, 12)
    await page.mouse.click(x, row.y + 1)
    await expect(mark(page, 'Breakpoint on line 12')).toBeVisible()
    await page.mouse.click(x, row.y + row.height - 1)
    await expect(mark(page, 'Breakpoint on line 12')).toHaveCount(0)
  })

  test('a click in the gutter does not take the keyboard focus', async ({ page }) => {
    await open(page)
    const button = page.getByRole('button', { name: 'Button after the editor' })
    await button.focus()
    await lineNumberCell(page, 11).click()
    await expect(mark(page, 'Breakpoint on line 11')).toBeVisible()
    await expect(button).toBeFocused()

    // And with the cursor in the text, the text keeps it.
    await codeLine(page, 'main:').click()
    await lineNumberCell(page, 12).click()
    await expect(mark(page, 'Breakpoint on line 12')).toBeVisible()
    await expect(editor(page)).toBeFocused()
  })

  test('a click below the last line sets nothing', async ({ page }) => {
    await open(page)
    // Measure once the lines have stopped moving: on a busy machine the layout can still
    // settle just after the page opens, and a click measured too early lands on a line.
    let last = await lineNumberCell(page, 19).boundingBox()
    await expect
      .poll(async () => {
        const before = last
        last = await lineNumberCell(page, 19).boundingBox()
        return before !== null && last !== null && before.x === last.x && before.y === last.y
      })
      .toBe(true)
    if (last === null) throw new Error('Line 19 is not on the screen.')
    const { x } = await marksRowPoint(page, 19)
    await page.mouse.click(x, last.y + last.height + 40)
    await page.mouse.click(last.x + last.width / 2, last.y + last.height + 40)
    expect((await snapshot(page)).toggles).toBe(0)
  })

  test('Mod-b switches the breakpoint of the line with the cursor', async ({ page }) => {
    await open(page)
    await codeLine(page, 'lea     rdi, message[rip]').click()
    await page.keyboard.press(`${MOD}+b`)
    await expect(mark(page, 'Breakpoint on line 13')).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press(`${MOD}+b`)
    await expect(mark(page, 'Breakpoint on line 14')).toBeVisible()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press(`${MOD}+b`)
    await expect(mark(page, 'Breakpoint on line 13')).toHaveCount(0)

    const state = await snapshot(page)
    expect(state.breakpoints).toEqual([14])
    // The key is not typed into the program.
    expect(state.changes).toBe(0)
  })

  test('a breakpoint switched from the keyboard is read out', async ({ page }) => {
    await open(page)
    await codeLine(page, 'lea     rdi, message[rip]').click()
    await recordAnnouncements(page)
    await page.keyboard.press(`${MOD}+b`)
    await expect.poll(() => announcements(page)).toContain('Breakpoint added on line 13.')
    await page.keyboard.press(`${MOD}+b`)
    await expect.poll(() => announcements(page)).toContain('Breakpoint removed from line 13.')
  })

  test('a tap switches a breakpoint on a touch screen', async ({ page }) => {
    test.skip(!isPhone(page), 'Taps need the touch screen of the phone project.')
    await open(page)
    await lineNumberCell(page, 12).tap()
    await expect(mark(page, 'Breakpoint on line 12')).toBeVisible()
    const row = await marksRowPoint(page, 12)
    await page.touchscreen.tap(row.x, row.y)
    await expect(mark(page, 'Breakpoint on line 12')).toHaveCount(0)
    expect((await snapshot(page)).toggles).toBe(2)
  })
})

/* ───────────────────── The line that runs next ───────────────────── */

test.describe('the line that runs next', () => {
  test('gets an arrow and a tint, and both move when the prop changes', async ({ page }) => {
    await open(page)
    await page.getByLabel('Current line').fill('12')
    await expect(mark(page, 'Line 12 runs next')).toBeVisible()
    const current = page.locator('.cm-line.cm-ss-line-current')
    await expect(current).toHaveCount(1)
    await expect(current).toContainText('mov     rbp, rsp')
    expect(await style(current, 'background-color')).toBe(
      await tokenColor(page, '--c-current-line'),
    )
    // The tint runs through both gutter columns too.
    expect(await style(lineNumberCell(page, 12), 'background-color')).toBe(
      await tokenColor(page, '--c-current-line'),
    )

    await page.getByRole('button', { name: 'Next line' }).click()
    await expect(mark(page, 'Line 13 runs next')).toBeVisible()
    await expect(mark(page, 'Line 12 runs next')).toHaveCount(0)
    await expect(current).toHaveCount(1)
    await expect(current).toContainText('lea     rdi, message[rip]')

    await page.getByRole('button', { name: 'Not running' }).click()
    await expect(current).toHaveCount(0)
    await expect(page.locator('.cm-ss-arrow')).toHaveCount(0)
  })

  test('shows next to a breakpoint on the same line', async ({ page }) => {
    await open(page)
    await setState(page, { currentLine: 12, breakpoints: [12] })
    await expect(mark(page, 'Line 12 runs next')).toBeVisible()
    await expect(mark(page, 'Breakpoint on line 12')).toBeVisible()
    const dot = await mark(page, 'Breakpoint on line 12').boundingBox()
    const arrow = await mark(page, 'Line 12 runs next').boundingBox()
    if (dot === null || arrow === null) throw new Error('The marks are not on the screen.')
    expect(arrow.x).toBeGreaterThanOrEqual(dot.x + dot.width)
  })

  test('is scrolled into sight only when it is out of sight, without taking the focus', async ({
    page,
  }) => {
    await open(page)
    await loadExample(page, 'Read a number (scanf)')
    // The keyboard focus is on a control above the editor, as it would be on a button.
    const control = page.getByLabel('Example')
    await control.focus()
    const pageScroll = await page.evaluate(() => window.scrollY)

    // A line in sight: nothing moves.
    await setState(page, { currentLine: 3 })
    await expect(mark(page, 'Line 3 runs next')).toBeVisible()
    expect(await scrollTop(page)).toBe(0)

    // A line far down: the editor scrolls to it.
    await setState(page, { currentLine: 39 })
    await expect(mark(page, 'Line 39 runs next')).toBeInViewport()
    const scrolled = await scrollTop(page)
    expect(scrolled).toBeGreaterThan(0)

    // The next line is in sight already: nothing moves.
    await setState(page, { currentLine: 40 })
    await expect(mark(page, 'Line 40 runs next')).toBeInViewport()
    expect(await scrollTop(page)).toBe(scrolled)

    // Inside the library call of a line that is out of sight: the editor goes there too.
    await setState(page, { currentLine: null, libraryLine: 2 })
    await expect(mark(page, 'Line 2: the program is inside the library')).toBeInViewport()
    expect(await scrollTop(page)).toBeLessThan(scrolled)

    // Only the editor scrolled, and the keyboard focus stayed on the control.
    expect(await page.evaluate(() => window.scrollY)).toBe(pageScroll)
    await expect(control).toBeFocused()
  })

  test('goes into the part of the editor that is on the screen, and the page stays put', async ({
    page,
  }) => {
    await open(page)
    await loadExample(page, 'Read a number (scanf)')
    // Scroll the page until only the lower part of the editor is left on the screen.
    const frame = await page.locator('.demo-frame').boundingBox()
    if (frame === null) throw new Error('The editor is not on the screen.')
    const cut = Math.round(frame.y + frame.height * 0.6)
    await page.evaluate((y) => window.scrollTo(0, y), cut)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(cut)

    // Line 30 is further down than the strip of the editor that is left on the screen.
    await setState(page, { currentLine: 30 })
    await expect(mark(page, 'Line 30 runs next')).toBeInViewport()
    const scrolled = await scrollTop(page)
    expect(scrolled).toBeGreaterThan(0)

    // Line 20 is now above that strip, in the part of the editor that is off the screen.
    await setState(page, { currentLine: 20 })
    await expect(mark(page, 'Line 20 runs next')).toBeInViewport()
    expect(await scrollTop(page)).toBeLessThan(scrolled)

    expect(await page.evaluate(() => window.scrollY)).toBe(cut)
  })

  test('is in sight when the page starts with a line far down', async ({ page }) => {
    await open(page, '?example=read-number&line=40')
    await expect(mark(page, 'Line 40 runs next')).toBeInViewport()
    expect(await scrollTop(page)).toBeGreaterThan(0)
  })

  test('is in sight after another program was loaded, also when its number stays the same', async ({
    page,
  }) => {
    await open(page)
    // Hello World has 19 lines: there is no line 40 to mark yet.
    await setState(page, { currentLine: 40 })
    await expect(page.locator('.cm-ss-arrow')).toHaveCount(0)

    const longProgram = Array.from({ length: 60 }, (_, index) => `    mov     rax, ${index}`)
    await setState(page, { source: `${longProgram.join('\n')}\n` })
    await expect(mark(page, 'Line 40 runs next')).toBeInViewport()
    await expect(page.locator('.cm-line.cm-ss-line-current')).toHaveText('    mov     rax, 39')
  })
})

/* ─────────────────────────── The library line ─────────────────────────── */

test.describe('the library line', () => {
  test('gets its own mark, a dashed line and the tag "inside the library"', async ({ page }) => {
    await open(page)
    await page.getByLabel('Library line').fill('15')
    await expect(mark(page, 'Line 15: the program is inside the library')).toBeVisible()
    const line = page.locator('.cm-line.cm-ss-line-library')
    await expect(line).toHaveCount(1)
    await expect(line).toContainText('call    printf@PLT')
    // Long lines scroll sideways here, so the tag has a row of its own under the call line:
    // it is in sight however long the line is, and it never covers code.
    const tag = page.locator('.cm-ss-library-row .cm-ss-library-tag')
    await expect(tag).toHaveText('inside the library')
    await expect(line.locator('.cm-ss-library-tag')).toHaveCount(0)
    const lineBox = await line.boundingBox()
    const tagBox = await tag.boundingBox()
    expect(tagBox?.y ?? 0).toBeGreaterThanOrEqual((lineBox?.y ?? 0) + (lineBox?.height ?? 0) - 1)

    // It does not look like the line that runs next: no tint, no arrow.
    await expect(page.locator('.cm-ss-line-current')).toHaveCount(0)
    await expect(page.locator('.cm-ss-arrow')).toHaveCount(0)
    expect(await style(line, 'background-color')).toBe('rgba(0, 0, 0, 0)')
    expect(await style(line, 'background-image')).toContain('repeating-linear-gradient')

    // The tag is not part of the program.
    expect((await snapshot(page)).source).not.toContain('inside the library')
  })
})

/* ──────────────────────── Errors and warnings ──────────────────────── */

test.describe('errors and warnings', () => {
  test('an error gets a wavy underline and a ! mark; a warning the same in its own color', async ({
    page,
  }) => {
    await open(page)
    await setState(page, { diagnostics: [ERROR_14, WARNING_5] })

    await expect(mark(page, 'Error on line 14')).toHaveText('!')
    const errorText = page.locator('.cm-ss-underline-error')
    await expect(errorText).toHaveText('mov     eax, 0')
    expect(await style(errorText, 'text-decoration-line')).toBe('underline')
    expect(await style(errorText, 'text-decoration-style')).toBe('wavy')
    expect(await style(errorText, 'text-decoration-color')).toBe(await tokenColor(page, '--c-bad'))

    await expect(mark(page, 'Warning on line 5')).toHaveText('!')
    const warningText = page.locator('.cm-ss-underline-warning')
    await expect(warningText).toHaveText('.type   main, @function')
    expect(await style(warningText, 'text-decoration-style')).toBe('wavy')
    expect(await style(warningText, 'text-decoration-color')).toBe(
      await tokenColor(page, '--c-warn'),
    )

    // Error and warning differ in shape too: a filled square and a ring.
    expect(await style(mark(page, 'Error on line 14'), 'background-color')).toBe(
      await tokenColor(page, '--c-bad'),
    )
    expect(await style(mark(page, 'Warning on line 5'), 'background-color')).toBe(
      'rgba(0, 0, 0, 0)',
    )
    expect(await style(mark(page, 'Warning on line 5'), 'border-radius')).toBe('50%')
    expect(await style(mark(page, 'Warning on line 5'), 'border-top-color')).toBe(
      await tokenColor(page, '--c-warn'),
    )
  })

  test('a diagnostic about the whole program (line 0) marks nothing', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Add whole-program warning (line 0)' }).click()
    await expect.poll(async () => (await snapshot(page)).diagnostics).toHaveLength(1)
    await expect(page.locator('.cm-ss-diagnostic')).toHaveCount(0)
    await expect(page.locator('.cm-ss-underline')).toHaveCount(0)
  })

  test('the pointer on the ! mark shows the message', async ({ page }) => {
    await open(page)
    await setState(page, { diagnostics: [ERROR_14] })
    await expect(messageBox(page)).toHaveCount(0)

    await mark(page, 'Error on line 14').hover()
    await expect(messageBox(page)).toBeVisible()
    await expect(messageBox(page)).toHaveText(
      '! Error Line 14: mvo is not an instruction. Did you mean mov?',
    )
    await expect(messageBox(page).locator('code')).toHaveText(['mvo', 'mov'])
    await expect(messageBox(page)).toBeInViewport()

    await page.getByRole('heading', { name: 'Code editor harness' }).hover()
    await expect(messageBox(page)).toHaveCount(0)
  })

  test('the pointer on the underlined text shows the message', async ({ page }) => {
    await open(page)
    await setState(page, { diagnostics: [ERROR_14] })
    await page.locator('.cm-ss-underline-error .cm-asm-mnemonic').hover()
    await expect(messageBox(page)).toContainText('Did you mean mov?')
    // On the comment of the same line there is nothing to show.
    await page.getByRole('heading', { name: 'Code editor harness' }).hover()
    await expect(messageBox(page)).toHaveCount(0)
    await codeLine(page, 'call    printf@PLT').locator('.cm-asm-comment').hover()
    await page.waitForTimeout(500)
    await expect(messageBox(page)).toHaveCount(0)
  })

  test('a click on the ! mark shows the message and sets no breakpoint', async ({ page }) => {
    await open(page)
    await setState(page, { diagnostics: [ERROR_14] })
    await mark(page, 'Error on line 14').click()
    await expect(messageBox(page)).toContainText('Did you mean mov?')
    expect((await snapshot(page)).toggles).toBe(0)
  })

  test('a tap on the ! mark shows the message on a touch screen', async ({ page }) => {
    test.skip(!isPhone(page), 'Taps need the touch screen of the phone project.')
    await open(page)
    await setState(page, { diagnostics: [ERROR_14] })
    await mark(page, 'Error on line 14').tap()
    await expect(messageBox(page)).toContainText('Did you mean mov?')
    await expect(messageBox(page)).toBeInViewport()
    expect((await snapshot(page)).toggles).toBe(0)

    // The box is never wider than the phone.
    const box = await messageBox(page).boundingBox()
    expect((box?.x ?? -1) >= 0 && (box?.x ?? 0) + (box?.width ?? 999) <= 360).toBe(true)
    await expectNoSidewaysScroll(page)

    // A tap in the text puts the cursor there and closes the box.
    await codeLine(page, 'main:').tap()
    await expect(messageBox(page)).toHaveCount(0)
  })

  test('the message stays on the screen when the code is scrolled sideways', async ({ page }) => {
    await open(page)
    // Twelve lines, so the line numbers have two digits, as in a real program.
    const filler = '    nop\n'.repeat(10)
    await setState(page, {
      source: `main:\n${filler}    mvo     rax, 1      # ${'a long comment '.repeat(30)}\n    ret\n`,
      diagnostics: [{ ...ERROR_14, line: 12 }],
    })
    await mark(page, 'Error on line 12').click()
    await expect(messageBox(page)).toBeInViewport()

    // The start of the line goes out of sight; the box must not go with it.
    for (const scrollLeft of [40, 333, 600]) {
      await page.locator('.cm-scroller').evaluate((element, left) => {
        element.scrollLeft = left
      }, scrollLeft)
      await expect
        .poll(() => page.locator('.cm-scroller').evaluate((element) => element.scrollLeft))
        .toBe(scrollLeft)
      // CodeMirror moves the box a moment after the scroll.
      await page.waitForTimeout(150)
      await expect(messageBox(page), `scrolled ${scrollLeft} px`).toBeInViewport()
    }
    const box = await messageBox(page).boundingBox()
    const width = page.viewportSize()?.width ?? 0
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? width + 1)).toBeLessThanOrEqual(width)
    await expectNoSidewaysScroll(page)
  })

  test('the keyboard reaches the message: it shows and is read out when the cursor arrives', async ({
    page,
  }) => {
    await open(page)
    await setState(page, { diagnostics: [ERROR_14], breakpoints: [15] })
    await codeLine(page, 'lea     rdi, message[rip]').click()
    await recordAnnouncements(page)
    await expect(messageBox(page)).toHaveCount(0)

    await page.keyboard.press('ArrowDown')
    await expect(messageBox(page)).toContainText('Line 14: mvo is not an instruction.')
    await expect
      .poll(() => announcements(page))
      .toContain('Line 14: mvo is not an instruction. Did you mean mov?')

    // It stays while the cursor moves inside the line …
    await page.keyboard.press('ArrowRight')
    await expect(messageBox(page)).toBeVisible()
    // … and goes away when the cursor leaves the line. The next line has a breakpoint.
    await page.keyboard.press('ArrowDown')
    await expect(messageBox(page)).toHaveCount(0)
    await expect.poll(() => announcements(page)).toContain('Breakpoint.')
  })

  test('the message goes away on Escape, when typing starts, and when the focus leaves', async ({
    page,
  }) => {
    await open(page)
    await setState(page, { diagnostics: [ERROR_14] })
    const before = codeLine(page, 'lea     rdi, message[rip]')

    await before.click()
    await page.keyboard.press('ArrowDown')
    await expect(messageBox(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(messageBox(page)).toHaveCount(0)

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await expect(messageBox(page)).toBeVisible()
    await page.keyboard.type('x')
    await expect(messageBox(page)).toHaveCount(0)

    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowDown')
    await expect(messageBox(page)).toBeVisible()
    await page.getByRole('button', { name: 'Button after the editor' }).focus()
    await expect(messageBox(page)).toHaveCount(0)
  })
})

/* ───────────────────────────── Keys ───────────────────────────── */

test.describe('keys', () => {
  test('Tab indents by 4 spaces and Shift+Tab takes them away; the focus stays', async ({
    page,
  }) => {
    await open(page)
    await codeLine(page, 'main:').click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Tab')
    await expect.poll(async () => (await snapshot(page)).source).toContain('\n    main:\n')
    await expect(editor(page)).toBeFocused()

    await page.keyboard.press('Shift+Tab')
    await expect.poll(async () => (await snapshot(page)).source).toContain('\nmain:\n')
    await expect(editor(page)).toBeFocused()
  })

  test('Tab in the middle of a line goes to the next step; with a selection it indents the lines', async ({
    page,
  }) => {
    await open(page)
    await loadExample(page, 'Empty program')
    await editor(page).click()
    await page.keyboard.type('ret')
    await page.keyboard.press('Tab')
    await page.keyboard.type('#')
    // "ret" ends in column 3: one space reaches column 4.
    await expect.poll(async () => (await snapshot(page)).source).toBe('ret #')

    await page.keyboard.press('Enter')
    await page.keyboard.type('nop')
    await page.keyboard.press(`${MOD}+a`)
    await page.keyboard.press('Tab')
    await expect.poll(async () => (await snapshot(page)).source).toBe('    ret #\n    nop')
    await page.keyboard.press('Shift+Tab')
    await expect.poll(async () => (await snapshot(page)).source).toBe('ret #\nnop')
  })

  test('Enter keeps the indentation of the line before', async ({ page }) => {
    await open(page)
    await codeLine(page, 'push    rbp').click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('nop')
    await expect
      .poll(async () => (await snapshot(page)).source)
      .toContain("# save the caller's rbp\n    nop\n    mov     rbp, rsp")
  })

  test('Escape, then Tab, leaves the editor; Escape, then Shift+Tab, leaves it backwards', async ({
    page,
  }) => {
    await open(page)
    const text = editor(page)
    await codeLine(page, 'main:').click()
    await expect(text).toBeFocused()

    // The editor says how to leave it.
    const description = await text.evaluate((element) =>
      (element.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    )
    expect(description).toContain('Press Escape, then Tab, to leave the editor.')

    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Button after the editor' })).toBeFocused()

    await page.keyboard.press('Shift+Tab')
    await expect(text).toBeFocused()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByRole('button', { name: 'Dark theme' })).toBeFocused()

    // Leaving typed nothing into the program.
    expect((await snapshot(page)).changes).toBe(0)
  })

  test('Escape arms only the next key: after another key, Tab indents again', async ({ page }) => {
    await open(page)
    await codeLine(page, 'main:').click()
    await page.keyboard.press('Home')
    await page.keyboard.press('Escape')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Tab')
    await expect(editor(page)).toBeFocused()
    await expect.poll(async () => (await snapshot(page)).source).toContain('\n    main:\n')
  })

  test('Escape, then Tab, also works while text is selected', async ({ page }) => {
    await open(page)
    await codeLine(page, 'main:').click()
    await page.keyboard.press(`${MOD}+a`)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Button after the editor' })).toBeFocused()
    expect((await snapshot(page)).changes).toBe(0)
  })

  test("the page's keys reach the page and change nothing in the editor", async ({ page }) => {
    await open(page)
    await codeLine(page, 'main:').click()
    await page.keyboard.press('End')
    const shortcuts = page.getByTestId('shortcuts')

    await page.keyboard.press(`${MOD}+Enter`)
    await expect(shortcuts).toHaveText('1 / 0 / 0')
    await page.keyboard.press(`${MOD}+Shift+Enter`)
    await expect(shortcuts).toHaveText('1 / 1 / 0')
    await page.keyboard.press(`${MOD}+Alt+Enter`)
    await expect(shortcuts).toHaveText('1 / 1 / 1')
    await page.keyboard.press('Control+Enter')
    await page.keyboard.press('Meta+Enter')
    await expect(shortcuts).toHaveText('3 / 1 / 1')

    const state = await snapshot(page)
    expect(state.changes).toBe(0)
    expect(state.source).toContain('\nmain:\n    push    rbp')
    await expect(editor(page)).toBeFocused()
  })

  test("the page's keys do nothing in the editor even when the page does not handle them", async ({
    page,
  }) => {
    await open(page)
    await page.getByLabel('The page handles Ctrl/Cmd+Enter').uncheck()
    // A page that listens after the editor still hears the keys.
    await page.evaluate(() => {
      const harness = window as HarnessWindow
      harness.__keysHeard = 0
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') harness.__keysHeard = (harness.__keysHeard ?? 0) + 1
      })
    })
    await codeLine(page, 'main:').click()
    await page.keyboard.press('End')

    const combos = [
      'Control+Enter',
      'Meta+Enter',
      'Control+Shift+Enter',
      'Meta+Shift+Enter',
      'Control+Alt+Enter',
      'Meta+Alt+Enter',
    ]
    for (const combo of combos) await page.keyboard.press(combo)

    expect(await page.evaluate(() => (window as HarnessWindow).__keysHeard)).toBe(combos.length)
    const state = await snapshot(page)
    expect(state.changes).toBe(0)
    expect(state.source).toContain('\nmain:\n    push    rbp')
  })
})

/* ───────────────────────────── Looks ───────────────────────────── */

test.describe('colors and theme', () => {
  test('mnemonics, registers, comments and the other tokens get their classes and colors', async ({
    page,
  }) => {
    await open(page)
    const line = codeLine(page, "# save the caller's rbp")

    const mnemonic = line.locator('.cm-asm-mnemonic')
    await expect(mnemonic).toHaveText('push')
    expect(await style(mnemonic, 'color')).toBe(await tokenColor(page, '--c-syn-mnemonic'))
    expect(await style(mnemonic, 'font-weight')).toBe('700')

    const register = line.locator('.cm-asm-register')
    await expect(register).toHaveText('rbp')
    expect(await style(register, 'color')).toBe(await tokenColor(page, '--c-syn-register'))

    const comment = line.locator('.cm-asm-comment')
    await expect(comment).toHaveText("# save the caller's rbp")
    expect(await style(comment, 'color')).toBe(await tokenColor(page, '--c-syn-comment'))
    expect(await style(comment, 'font-style')).toBe('italic')

    const directive = codeLine(page, '.string').locator('.cm-asm-directive')
    expect(await style(directive, 'color')).toBe(await tokenColor(page, '--c-syn-directive'))
    const string = codeLine(page, '.string').locator('.cm-asm-string')
    await expect(string).toHaveText('"Hello World!\\n"')
    expect(await style(string, 'color')).toBe(await tokenColor(page, '--c-syn-string'))
    const number = codeLine(page, 'no floating-point').locator('.cm-asm-number')
    expect(await style(number, 'color')).toBe(await tokenColor(page, '--c-syn-number'))

    // A label is bold in the normal text color.
    const label = codeLine(page, 'main:').locator('.cm-asm-label')
    await expect(label).toHaveText('main')
    expect(await style(label, 'font-weight')).toBe('700')
    expect(await style(label, 'color')).toBe(await tokenColor(page, '--c-ink'))
  })

  test('colors a line again while it is typed', async ({ page }) => {
    await open(page)
    await loadExample(page, 'Empty program')
    await editor(page).click()
    await page.keyboard.type('loop: dec ecx # count down')
    const line = codeLine(page, 'count down')
    await expect(line.locator('.cm-asm-label')).toHaveText('loop')
    await expect(line.locator('.cm-asm-mnemonic')).toHaveText('dec')
    await expect(line.locator('.cm-asm-register')).toHaveText('ecx')
    await expect(line.locator('.cm-asm-comment')).toHaveText('# count down')
  })

  test('the dark theme changes the background and the colors by itself', async ({ page }) => {
    await open(page, '?theme=light')
    const frame = page.locator('.cm-editor')
    const mnemonic = codeLine(page, "# save the caller's rbp").locator('.cm-asm-mnemonic')
    const lightBackground = await style(frame, 'background-color')
    const lightMnemonic = await style(mnemonic, 'color')
    expect(lightBackground).toBe('rgb(251, 250, 246)')

    await page.getByRole('button', { name: 'Dark theme' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    expect(await style(frame, 'background-color')).toBe('rgb(18, 25, 34)')
    expect(await style(frame, 'background-color')).toBe(await tokenColor(page, '--c-code-bg'))
    expect(await style(frame, 'color')).toBe(await tokenColor(page, '--c-ink'))
    expect(await style(mnemonic, 'color')).not.toBe(lightMnemonic)
    expect(await style(mnemonic, 'color')).toBe(await tokenColor(page, '--c-syn-mnemonic'))
    expect(await style(page.locator('.cm-gutters'), 'background-color')).toBe('rgb(18, 25, 34)')
    expect(await style(editor(page), 'caret-color')).toBe(await tokenColor(page, '--c-ink'))

    await page.getByRole('button', { name: 'Light theme' }).click()
    expect(await style(frame, 'background-color')).toBe(lightBackground)
  })

  test('starts dark when the page is dark', async ({ page }) => {
    await open(page, '?theme=dark')
    expect(await style(page.locator('.cm-editor'), 'background-color')).toBe('rgb(18, 25, 34)')
  })
})

test.describe('accessibility', () => {
  test('the text area is a named multi-line text box without spell-check', async ({ page }) => {
    await open(page)
    const text = editor(page)
    await expect(text).toHaveAttribute('role', 'textbox')
    await expect(text).toHaveAttribute('aria-multiline', 'true')
    await expect(text).toHaveAttribute('contenteditable', 'true')
    await expect(text).toHaveAttribute('spellcheck', 'false')
    await expect(text).toHaveAttribute('autocorrect', 'off')
    await expect(text).toHaveAttribute('autocapitalize', 'off')
  })

  test('the description names the marked lines', async ({ page }) => {
    await open(page)
    await setState(page, { currentLine: 12, breakpoints: [11, 15], diagnostics: [ERROR_14] })
    await expect(editor(page)).toHaveAccessibleDescription(
      'Press Escape, then Tab, to leave the editor. Line 12 runs next. Breakpoints on lines 11 and 15. Error on line 14.',
    )
  })

  test('the frame shows a focus ring while the text has the focus', async ({ page }) => {
    await open(page)
    const frame = page.locator('.cm-editor')
    expect(await style(frame, 'content', '::after')).toBe('none')

    await codeLine(page, 'main:').click()
    await expect(frame).toHaveClass(/cm-focused/)
    expect(await style(frame, 'border-top-width', '::after')).toBe('2px')
    expect(await style(frame, 'border-top-style', '::after')).toBe('solid')
    expect(await style(frame, 'border-top-color', '::after')).toBe(
      await tokenColor(page, '--c-focus'),
    )

    await page.getByRole('button', { name: 'Button after the editor' }).focus()
    await expect(frame).not.toHaveClass(/cm-focused/)
    expect(await style(frame, 'content', '::after')).toBe('none')
  })
})

test.describe('size', () => {
  test('fills the height of its parent and scrolls inside itself in both directions', async ({
    page,
  }) => {
    await open(page)
    await loadExample(page, 'Read a number (scanf)')
    const frame = await page.locator('.demo-frame').boundingBox()
    const box = await page.locator('.cm-editor').boundingBox()
    if (frame === null || box === null) throw new Error('The editor is not on the screen.')
    // The frame of the harness has a 1 px border.
    expect(Math.abs(box.height - (frame.height - 2))).toBeLessThanOrEqual(1)
    expect(Math.abs(box.width - (frame.width - 2))).toBeLessThanOrEqual(1)

    const sizes = await page.locator('.cm-scroller').evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(sizes.scrollHeight).toBeGreaterThan(sizes.clientHeight)
    if (isPhone(page)) expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth)
    await expectNoSidewaysScroll(page)
  })

  test('a very long line scrolls inside the editor and never widens the page', async ({ page }) => {
    await open(page)
    await setState(page, { source: `# ${'a very long comment '.repeat(40)}\n    ret\n` })
    await expect(codeLine(page, 'a very long comment')).toBeVisible()
    const sizes = await page.locator('.cm-scroller').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }))
    expect(sizes.scrollWidth).toBeGreaterThan(sizes.clientWidth)
    await expectNoSidewaysScroll(page)

    // The gutters stay in place while the code scrolls sideways.
    const before = await lineNumberCell(page, 1).boundingBox()
    await page.locator('.cm-scroller').evaluate((element) => {
      element.scrollLeft = 300
    })
    await expect
      .poll(() => page.locator('.cm-scroller').evaluate((element) => element.scrollLeft))
      .toBe(300)
    const after = await lineNumberCell(page, 1).boundingBox()
    expect(after?.x).toBe(before?.x)
  })

  test('uses the mono font: 14 px with a mouse, at least 16 px on a touch screen', async ({
    page,
  }) => {
    await open(page)
    const fontSize = Number.parseFloat(await style(editor(page), 'font-size'))
    const lineHeight = (await codeLine(page, 'main:').boundingBox())?.height ?? 0
    if (isPhone(page)) {
      // Smaller text would make iOS zoom the page when the editor gets the focus.
      expect(fontSize).toBeGreaterThanOrEqual(16)
      expect(lineHeight).toBeGreaterThanOrEqual(24)
    } else {
      expect(fontSize).toBe(14)
      expect(lineHeight).toBeGreaterThanOrEqual(20)
    }
    expect(await style(editor(page), 'font-family')).toMatch(/ui-monospace|Menlo|Consolas/)
    // Bold mnemonics and italic comments must not shift the columns: every character
    // is equally wide.
    const charWidth = (locator: Locator) =>
      locator.evaluate(
        (element) => element.getBoundingClientRect().width / (element.textContent ?? '').length,
      )
    const line = codeLine(page, "# save the caller's rbp")
    const bold = await charWidth(line.locator('.cm-asm-mnemonic'))
    const regular = await charWidth(line.locator('.cm-asm-register'))
    const italic = await charWidth(line.locator('.cm-asm-comment'))
    expect(bold).toBeGreaterThan(0)
    expect(Math.abs(bold - regular)).toBeLessThan(0.05)
    expect(Math.abs(italic - regular)).toBeLessThan(0.05)
  })

  test('the page does not scroll sideways, with marks and messages on the screen', async ({
    page,
  }) => {
    await open(page)
    await setState(page, {
      currentLine: 12,
      libraryLine: 15,
      breakpoints: [11, 15],
      diagnostics: [ERROR_14, WARNING_5],
    })
    await expect(mark(page, 'Line 12 runs next')).toBeVisible()
    await expectNoSidewaysScroll(page)
    await mark(page, 'Error on line 14').hover()
    await expect(messageBox(page)).toBeVisible()
    await expectNoSidewaysScroll(page)
  })
})
