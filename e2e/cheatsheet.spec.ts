/// <reference lib="dom" />
/**
 * The cheat sheet, tested in a real browser: the page on screen, and the two pages it
 * prints (the 3×5 inch index card and the letter page).
 *
 *   E2E_DEV=1 E2E_PORT=5204 npx playwright test e2e/cheatsheet.spec.ts
 *
 * The screen tests run in both Playwright projects (desktop 1280×800, phone 360×740).
 * The print tests run in the desktop project only: they make real PDF files with
 * `page.pdf()`, which needs headless Chromium, and read the number of pages and the page
 * size back from the PDF bytes.
 *
 * To keep the PDF files and PNG pictures of the printed pages as evidence, run with
 * SAVE_PRINT_EVIDENCE=1. They are written to docs/screenshots/m6/. This is not done on
 * every run, because a PDF holds the time it was made: the files would change each time.
 *
 * The first line gives this file the browser types (`document`, `window`) for the
 * callbacks that run inside the page.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Browser, type Page } from '@playwright/test'
import { expectNoSidewaysScroll, watchForErrors } from './helpers'

const SECTION_HEADINGS = [
  'Register names',
  'Writing part of a register',
  'mov rules',
  'Sizes',
  'lea vs. mov',
  'Indirect addressing',
  '.equ names',
  'Flags and jumps',
  'Stack, rip, call, ret',
  'Calling convention',
  'Hex: count down by 8',
] as const

const CARD_BUTTON = 'Print the index card (3×5 in)'
const LETTER_BUTTON = 'Print the full page (letter)'

type PrintMode = 'card' | 'letter'

/** One CSS inch is 96 px, and one point is 1/72 inch. */
const PX_PER_INCH = 96
const PT_PER_PX = 72 / PX_PER_INCH

interface Paper {
  /** The paper, and the room inside its margins, in inches. */
  width: number
  height: number
  margin: number
  /** The class of the rendition that is printed on it. */
  sheet: string
  /** The `@page` rule the page must use. */
  rule: string
  button: string
}

const PAPER: Record<PrintMode, Paper> = {
  card: {
    width: 5,
    height: 3,
    margin: 0.1,
    sheet: '.cs-card',
    rule: '@page { size: 5in 3in; margin: 0.1in }',
    button: CARD_BUTTON,
  },
  letter: {
    width: 8.5,
    height: 11,
    margin: 0.5,
    sheet: '.cs-letter',
    rule: '@page { size: letter; margin: 0.5in }',
    button: LETTER_BUTTON,
  },
}

const EVIDENCE_DIR = path.join(import.meta.dirname, '..', 'docs', 'screenshots', 'm6')
const saveEvidence = process.env.SAVE_PRINT_EVIDENCE === '1'

/**
 * Extra space after every letter: 0.0125em is 0.1 px at 6 pt, which makes a line of the
 * card about 2.5 % wider. That is more than the difference between two browsers that use
 * the same fonts, or between Menlo and its stand-ins on other computers.
 */
const WIDER_LETTERS = '0.0125em'

/**
 * SF Mono: the font that Safari and every browser on an iPhone or iPad pick for
 * `ui-monospace`. It is on every Mac, but Chromium cannot pick it by name, so the test
 * loads the file itself.
 */
const SF_MONO_FILE = '/System/Library/Fonts/SFNSMono.ttf'

/* ───────────────────────────── Helpers ───────────────────────────── */

interface PrintWindow extends Window {
  __printCalls?: number
}

/** Replace `window.print` by a counter, so that no print window opens. */
async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counter = window as PrintWindow
    counter.__printCalls = 0
    window.print = () => {
      counter.__printCalls = (counter.__printCalls ?? 0) + 1
    }
  })
}

async function printCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as PrintWindow).__printCalls ?? 0)
}

async function open(page: Page): Promise<void> {
  await page.goto('/#/cheatsheet')
  await expect(page.locator('h1')).toHaveText('Cheat sheet')
}

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768
}

/** The print mode the page is in: the attribute on <html> and the `@page` rule in <head>. */
async function printState(page: Page): Promise<{ mode: string | null; rule: string | null }> {
  return page.evaluate(() => ({
    mode: document.documentElement.getAttribute('data-cheatsheet-print'),
    rule: document.getElementById('cheatsheet-page-rule')?.textContent ?? null,
  }))
}

/** Click the print button of a mode, the way a student does. The print window is stubbed. */
async function pressPrint(page: Page, mode: PrintMode): Promise<void> {
  await page.getByRole('button', { name: PAPER[mode].button }).click()
  await expect.poll(() => printState(page)).toEqual({ mode, rule: PAPER[mode].rule })
}

/** What the test needs from a PDF file: how many pages, and the size of each in points. */
interface PdfFacts {
  pages: number
  /** `/Count` of the page tree: the number of pages the file says it has. */
  count: number
  sizes: { width: number; height: number }[]
}

/**
 * Read the page count and the page sizes from the bytes of a PDF.
 *
 * Chromium writes every page as a plain object ("<</Type /Page … /MediaBox [0 0 360 216]
 * …>>") and the page tree as "<</Type /Pages /Count 1 …>>". Only the drawing commands and
 * the fonts are compressed, so the structure can be read as text.
 */
function readPdf(bytes: Buffer): PdfFacts {
  const text = bytes.toString('latin1')
  expect(text.startsWith('%PDF-'), 'the file is a PDF').toBe(true)
  const pages = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0
  const tree = /<<[^<>]*\/Type\s*\/Pages(?![A-Za-z])[^<>]*>>/.exec(text)?.[0] ?? ''
  const count = Number(/\/Count\s+(\d+)/.exec(tree)?.[1] ?? Number.NaN)
  const sizes = [...text.matchAll(/\/MediaBox\s*\[([^\]]+)\]/g)].map((match) => {
    const [left, bottom, right, top] = match[1].trim().split(/\s+/).map(Number)
    return { width: right - left, height: top - bottom }
  })
  return { pages, count, sizes }
}

interface SheetReport {
  /** The size of the printed sheet in px. */
  width: number
  height: number
  /** Every font size used by text of the sheet, in points. */
  fontSizes: number[]
  /** Font sizes of the text outside the title, in points. */
  bodyFontSizes: number[]
  /** Boxes whose content is wider than the box itself. */
  tooWide: string[]
  /** Boxes that could cut off their content: anything that does not let overflow show. */
  clipping: string[]
  /** Pieces that reach out of their column. */
  outside: string[]
  /** The room left under the last section of each column, in px. */
  spare: number[]
  /** Colors of the text, and the backgrounds behind the sheet. */
  textColors: string[]
  backgrounds: string[]
}

/** Measure the printed sheet. Call it while the page shows print media. */
async function measureSheet(page: Page, mode: PrintMode): Promise<SheetReport> {
  return page.evaluate(
    ({ selector, pageHeight, pointsPerPx }) => {
      const sheet = document.querySelector<HTMLElement>(selector)
      if (sheet === null) throw new Error(`No element ${selector}`)
      const describe = (element: Element): string =>
        `<${element.tagName.toLowerCase()} class="${element.className}"> ${(element.textContent ?? '').slice(0, 40)}`
      const box = sheet.getBoundingClientRect()

      const tooWide: string[] = []
      const clipping: string[] = []
      const canClip = (element: Element): boolean => {
        const style = getComputedStyle(element)
        return style.overflowX !== 'visible' || style.overflowY !== 'visible'
      }
      for (const element of [sheet, ...sheet.querySelectorAll<HTMLElement>('*')]) {
        const { display } = getComputedStyle(element)
        if (display === 'none') continue
        if (canClip(element)) clipping.push(describe(element))
        if (display === 'inline' || display === 'contents' || element.clientWidth === 0) continue
        if (element.scrollWidth > element.clientWidth) tooWide.push(describe(element))
      }
      // The boxes around the sheet must not cut it off either (on screen, the preview
      // frame does). <body> and <html> scroll the window, which paper does not have.
      for (let box = sheet.parentElement; box !== null && box !== document.body;) {
        if (canClip(box)) clipping.push(describe(box))
        box = box.parentElement
      }

      // The inside of a column: without its padding and its rule.
      const inside = (column: Element): { left: number; right: number } => {
        const rect = column.getBoundingClientRect()
        const style = getComputedStyle(column)
        return {
          left: rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          right: rect.right - parseFloat(style.paddingRight),
        }
      }
      const outside: string[] = []
      for (const column of sheet.querySelectorAll('.cs-col, .cs-foot')) {
        const { left, right } = inside(column)
        for (const element of column.querySelectorAll('*')) {
          const rect = element.getBoundingClientRect()
          if (rect.width === 0 || rect.height === 0) continue
          if (rect.left < left - 0.5 || rect.right > right + 0.5) outside.push(describe(element))
        }
      }

      // The columns end where the foot begins (or at the bottom of the page).
      const foot = sheet.querySelector('.cs-foot')
      const columnsTop = sheet.querySelector('.cs-cols')?.getBoundingClientRect().top ?? box.top
      const footHeight =
        foot === null
          ? 0
          : foot.getBoundingClientRect().height + parseFloat(getComputedStyle(foot).marginTop)
      const columnsBottom = box.top + pageHeight - footHeight
      const spare = [...sheet.querySelectorAll('.cs-col')].map((column) => {
        const last = column.lastElementChild?.getBoundingClientRect().bottom ?? columnsTop
        return columnsBottom - last
      })

      const fontSizes = new Set<number>()
      const bodyFontSizes = new Set<number>()
      const textColors = new Set<string>()
      const walker = document.createTreeWalker(sheet, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement
        if (parent === null || (walker.currentNode.textContent ?? '').trim() === '') continue
        // Text that is not printed (the long or the short form of a word) does not count.
        if (parent.getClientRects().length === 0) continue
        const style = getComputedStyle(parent)
        const points = Math.round(parseFloat(style.fontSize) * pointsPerPx * 100) / 100
        fontSizes.add(points)
        if (parent.closest('.cs-title') === null) bodyFontSizes.add(points)
        textColors.add(style.color)
      }

      const backgrounds = [document.documentElement, document.body, sheet].map(
        (element) => getComputedStyle(element).backgroundColor,
      )
      return {
        width: box.width,
        height: box.height,
        fontSizes: [...fontSizes].sort((a, b) => a - b),
        bodyFontSizes: [...bodyFontSizes].sort((a, b) => a - b),
        tooWide,
        clipping,
        outside,
        spare,
        textColors: [...textColors],
        backgrounds,
      }
    },
    {
      selector: PAPER[mode].sheet,
      pageHeight: (PAPER[mode].height - 2 * PAPER[mode].margin) * PX_PER_INCH,
      pointsPerPx: PT_PER_PX,
    },
  )
}

/** In print media, only the sheet of this mode is left on the page. */
async function expectOnlyTheSheet(page: Page, mode: PrintMode): Promise<void> {
  const other: PrintMode = mode === 'card' ? 'letter' : 'card'
  await expect(page.locator(PAPER[mode].sheet)).toBeVisible()
  await expect(page.locator(PAPER[other].sheet)).toBeHidden()

  // The frame of the site and everything around the sheet.
  await expect(page.locator('#root header').first()).toBeHidden()
  await expect(page.locator('nav[aria-label="Main"]')).toBeHidden()
  await expect(page.locator('#root footer')).toBeHidden()
  await expect(page.locator('.skip-link')).toBeHidden()
  await expect(page.locator('h1')).toBeHidden()
  await expect(page.locator('button', { hasText: CARD_BUTTON })).toBeHidden()
  await expect(page.locator('button', { hasText: LETTER_BUTTON })).toBeHidden()
  await expect(page.getByText('How to print')).toBeHidden()
  await expect(page.getByText('Preview of the index card')).toBeHidden()
  await expect(page.locator('.cs-screen')).toBeHidden()

  // What is left to read is the sheet and nothing else.
  const text = await page.evaluate(() => document.body.innerText)
  expect(
    text.trimStart().startsWith(mode === 'card' ? 'Register names' : 'x86-64 cheat sheet'),
  ).toBe(true)
  expect(text).toContain('0x1f8')
  expect(text).not.toContain('How to print')
  expect(text).not.toContain('Stack Step is a learning tool')
}

/**
 * A picture of the printed page: the print view at the size of the paper, three times as
 * sharp as a screen, so that 6 pt type can be read. The margin that `@page` gives on real
 * paper is added here by hand.
 */
async function savePrintPicture(
  browser: Browser,
  baseURL: string | undefined,
  mode: PrintMode,
  file: string,
): Promise<void> {
  const paper = PAPER[mode]
  const context = await browser.newContext({
    baseURL,
    viewport: { width: paper.width * PX_PER_INCH, height: paper.height * PX_PER_INCH },
    deviceScaleFactor: 3,
  })
  try {
    const page = await context.newPage()
    await stubPrint(page)
    await open(page)
    await pressPrint(page, mode)
    await page.emulateMedia({ media: 'print' })
    await page.addStyleTag({ content: `body { margin: ${paper.margin}in !important }` })
    await page.screenshot({ path: file })
  } finally {
    await context.close()
  }
}

/* ───────────────────────────── On screen ───────────────────────────── */

test.describe('the page on screen', () => {
  test('shows one heading, the print buttons, the note on printing and every section', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    await open(page)
    const main = page.getByRole('main')

    await expect(page).toHaveTitle('Cheat sheet · Stack Step')
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(main.getByRole('button', { name: CARD_BUTTON })).toBeVisible()
    await expect(main.getByRole('button', { name: LETTER_BUTTON })).toBeVisible()

    await expect(main.getByText('How to print')).toBeVisible()
    for (const words of [
      'Headers and footers',
      'scale to 100%',
      'Actual size',
      '3×5 in',
      // Chrome hides this setting when the page sets its own paper size, so the note does
      // not promise that it is there.
      'If you see a Layout setting, choose Landscape.',
    ]) {
      await expect(main.getByText(words, { exact: false }).first()).toBeVisible()
    }

    for (const name of SECTION_HEADINGS) {
      // Exactly one: the copies inside the preview and the letter page are not announced.
      await expect(main.getByRole('heading', { level: 2, name, exact: true })).toHaveCount(1)
      await expect(main.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
    }
    await expect(
      main.getByRole('heading', { level: 2, name: 'Preview of the index card' }),
    ).toBeVisible()

    await expectNoSidewaysScroll(page)
    expect(errors, 'nothing is reported in the browser console').toEqual([])
  })

  test('the register table has all sixteen registers and their smaller names', async ({ page }) => {
    await open(page)
    const table = page.getByRole('region', { name: 'Register names' }).getByRole('table')
    await expect(table.getByRole('columnheader')).toHaveText([
      '64 bits',
      '32 bits',
      '16 bits',
      '8 bits',
      'bits 15–8',
    ])
    await expect(table.locator('tbody tr')).toHaveCount(16)
    await expect(table.locator('tbody tr').first().locator('th, td')).toHaveText([
      'rax',
      'eax',
      'ax',
      'al',
      'ah',
    ])
    await expect(table.locator('tbody tr').nth(4).locator('th, td')).toHaveText([
      'rsi',
      'esi',
      'si',
      'sil',
      '',
    ])
    await expect(table.locator('tbody tr').last().locator('th, td')).toHaveText([
      'r15',
      'r15d',
      'r15w',
      'r15b',
      '',
    ])
  })

  test('the sheet says the facts in words, not by color alone', async ({ page }) => {
    await open(page)
    const mov = page.getByRole('region', { name: 'mov rules' })
    // The same two words as on the card and the letter page (and as the practice topic).
    await expect(mov.getByRole('row', { name: /^memory/ }).getByRole('cell')).toHaveText(
      ['legal', 'illegal', 'legal*'],
      { useInnerText: true },
    )
    await expect(mov.getByText('* needs a size:')).toContainText('mov dword ptr [rbx], 5')

    const flags = page.getByRole('region', { name: 'Flags and jumps' })
    // The four flag lines are true after these three instructions, and CF has an exception.
    await expect(flags.getByText('After add, sub, cmp:', { exact: true })).toBeVisible()
    await expect(flags.getByText('inc and dec leave CF alone.', { exact: true })).toBeVisible()
    const jumps = flags.getByRole('table')
    await expect(jumps.getByRole('row', { name: /a > b/ }).getByRole('cell')).toHaveText([
      'jg',
      'ja',
    ])

    // The alignment rule says when it holds.
    await expect(page.getByRole('region', { name: 'Calling convention' })).toContainText(
      'so that rsp ends in 0 before a call (no other push).',
    )

    const ladder = page.getByRole('region', { name: 'Hex: count down by 8' })
    await expect(ladder.getByRole('listitem')).toHaveCount(18)
    await expect(ladder.getByText('Trap:')).toContainText('0x200 − 8 = 0x1f8')
    await expect(ladder.getByText('Trap:')).toContainText('not 0x192')
  })

  test('the preview shows the card at its real size, or smaller on a narrow screen', async ({
    page,
  }) => {
    await open(page)
    const frame = page.locator('.cs-preview-frame')
    const box = await frame.boundingBox()
    if (box === null) throw new Error('The preview frame is not on the page.')
    const screenWidth = page.viewportSize()?.width ?? 1280

    if (isPhone(page)) {
      // 16 px of space on each side of the page.
      expect(box.width).toBeLessThanOrEqual(screenWidth - 32)
      expect(box.width).toBeGreaterThan(300)
    } else {
      // 5 × 3 inches at 96 px per inch.
      expect(box.width).toBeCloseTo(480, 0)
    }
    expect(box.height / box.width, 'the frame keeps the shape of the card').toBeCloseTo(3 / 5, 2)

    // The card fills the frame exactly: nothing is cut off and nothing is left over.
    const card = await page.locator('.cs-card').boundingBox()
    expect(card?.width).toBeCloseTo(box.width, 0)
    expect(card?.height).toBeCloseTo(box.height, 0)

    // The preview is a picture for the eyes: screen readers get the sheet below it.
    await expect(page.locator('.cs-preview-scaler')).toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator('.cs-letter')).toBeHidden()
  })

  test('the print buttons are big enough for a thumb', async ({ page }) => {
    await open(page)
    for (const name of [CARD_BUTTON, LETTER_BUTTON]) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(box?.height ?? 0, `"${name}" is at least 44 px tall`).toBeGreaterThanOrEqual(44)
    }
  })

  test('a print button sets its mode and asks the browser to print once', async ({ page }) => {
    await stubPrint(page)
    await open(page)
    expect(await printCalls(page)).toBe(0)

    await pressPrint(page, 'card')
    expect(await printCalls(page)).toBe(1)

    await pressPrint(page, 'letter')
    expect(await printCalls(page)).toBe(2)
  })

  test('the print rules are gone on every other page', async ({ page }) => {
    await open(page)
    expect(await printState(page)).toEqual({ mode: 'letter', rule: PAPER.letter.rule })

    await page.goto('/#/about')
    await expect(page.locator('h1')).toHaveText('About Stack Step')
    expect(await printState(page)).toEqual({ mode: null, rule: null })

    await page.goBack()
    await expect(page.locator('h1')).toHaveText('Cheat sheet')
    expect(await printState(page)).toEqual({ mode: 'letter', rule: PAPER.letter.rule })
  })

  test.describe('in the dark theme', () => {
    test.use({ colorScheme: 'dark' })

    test('the page is dark and the preview stays white paper with black ink', async ({ page }) => {
      const errors = watchForErrors(page)
      await open(page)
      await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)

      const colors = await page.locator('.cs-card').evaluate((card) => {
        const style = getComputedStyle(card)
        return { paper: style.backgroundColor, ink: style.color }
      })
      expect(colors).toEqual({ paper: 'rgb(255, 255, 255)', ink: 'rgb(0, 0, 0)' })

      await expectNoSidewaysScroll(page)
      expect(errors).toEqual([])
    })
  })
})

/* ─────────────────────────────── Print ─────────────────────────────── */

test.describe('print', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(isPhone(page), 'The print views are tested in the desktop project.')
    await stubPrint(page)
  })

  test('the card button prints one 5 × 3 inch page at about 6 pt, and everything fits', async ({
    page,
    browser,
    baseURL,
  }) => {
    const errors = watchForErrors(page)
    await open(page)
    await pressPrint(page, 'card')
    expect(await printCalls(page)).toBe(1)

    await page.emulateMedia({ media: 'print' })
    await expectOnlyTheSheet(page, 'card')

    const report = await measureSheet(page, 'card')
    // The room inside the margins: 4.8 × 2.8 inches. The card fills it, and is never taller.
    expect(report.width).toBeCloseTo(4.8 * PX_PER_INCH, 1)
    expect(report.height, 'the card is not taller than one page').toBeLessThanOrEqual(
      2.8 * PX_PER_INCH,
    )
    expect(report.height, 'the card fills the page').toBeGreaterThan(2.8 * PX_PER_INCH - 3)

    // About 6 pt: never below 5.5 pt, never above 6.5 pt, and that is all the text.
    expect(report.fontSizes.length).toBeGreaterThan(0)
    expect(Math.min(...report.fontSizes)).toBeGreaterThanOrEqual(5.5)
    expect(Math.max(...report.fontSizes)).toBeLessThanOrEqual(6.5)

    expect(report.tooWide, 'no box is wider than its column').toEqual([])
    expect(report.clipping, 'no box can cut off its content').toEqual([])
    expect(report.outside, 'nothing reaches out of its column').toEqual([])

    // Four columns, and none is filled to the last pixel: a browser that rounds the height
    // of a line a little differently cannot push the last line onto a second card. (Wider
    // letters are a different danger: see "a little wider" below.)
    expect(report.spare).toHaveLength(4)
    for (const [index, room] of report.spare.entries()) {
      expect(room, `column ${index + 1} has a little room left`).toBeGreaterThanOrEqual(3)
    }

    // The mov table says "legal" and "illegal", as the letter page and the screen do. Its
    // corner ("dest ← src") moves to the end of the heading line, where there is room.
    const movRow = page.locator('.cs-card .cs-mov-forms tbody tr').nth(1)
    await expect(movRow.locator('td')).toHaveText(['legal', 'illegal', 'legal*'], {
      useInnerText: true,
    })
    await expect(page.locator('.cs-card .cs-sec--mov .cs-h')).toHaveText(
      /^mov rules\s*dest ← src$/,
      {
        useInnerText: true,
      },
    )
    await expect(page.locator('.cs-letter .cs-mov-forms tbody tr').nth(1).locator('td')).toHaveText(
      ['legal', 'illegal', 'legal*'],
      { useInnerText: true },
    )

    // The card's own code font: never `ui-monospace`, which Safari and every iPhone turn
    // into SF Mono, a font the card was not fitted with (see cheatsheet.css).
    const mono = await page
      .locator('.cs-card code')
      .first()
      .evaluate((code) => getComputedStyle(code).fontFamily)
    expect(mono).not.toMatch(/ui-monospace|SFMono|SF Mono/)
    expect(mono.split(',')[0].trim()).toBe('Menlo')

    const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: false })
    const pdf = readPdf(bytes)
    expect(pdf.pages, 'the card is ONE page: the front of the card only').toBe(1)
    expect(pdf.count).toBe(1)
    // 5 × 3 inches = 360 × 216 pt.
    expect(pdf.sizes).toEqual([{ width: 360, height: 216 }])

    expect(errors).toEqual([])

    await test.info().attach('cheatsheet-card.pdf', { body: bytes, contentType: 'application/pdf' })
    if (saveEvidence) {
      await mkdir(EVIDENCE_DIR, { recursive: true })
      await writeFile(path.join(EVIDENCE_DIR, 'cheatsheet-card.pdf'), bytes)
      await savePrintPicture(
        browser,
        baseURL,
        'card',
        path.join(EVIDENCE_DIR, 'cheatsheet-card-print.png'),
      )
    }
  })

  test('the letter button prints one letter page at about 10 pt, and everything fits', async ({
    page,
    browser,
    baseURL,
  }) => {
    const errors = watchForErrors(page)
    await open(page)
    await pressPrint(page, 'letter')
    expect(await printCalls(page)).toBe(1)

    await page.emulateMedia({ media: 'print' })
    await expectOnlyTheSheet(page, 'letter')

    const report = await measureSheet(page, 'letter')
    // The room inside the margins: 7.5 × 10 inches. The sheet fills it, and is never taller.
    expect(report.width).toBeCloseTo(7.5 * PX_PER_INCH, 1)
    expect(report.height, 'the sheet is not taller than one page').toBeLessThanOrEqual(
      10 * PX_PER_INCH,
    )
    expect(report.height, 'the sheet fills the page').toBeGreaterThan(10 * PX_PER_INCH - 3)

    // About 9.5 to 11 pt for everything under the title.
    expect(Math.min(...report.bodyFontSizes)).toBeGreaterThanOrEqual(9.5)
    expect(Math.max(...report.bodyFontSizes)).toBeLessThanOrEqual(11)

    expect(report.tooWide, 'no box is wider than its column').toEqual([])
    expect(report.clipping, 'no box can cut off its content').toEqual([])
    expect(report.outside, 'nothing reaches out of its column').toEqual([])

    // Three columns, each with room for at least two more lines.
    expect(report.spare).toHaveLength(3)
    for (const [index, room] of report.spare.entries()) {
      expect(room, `column ${index + 1} has spare room`).toBeGreaterThanOrEqual(36)
    }

    const bytes = await page.pdf({ preferCSSPageSize: true, printBackground: false })
    const pdf = readPdf(bytes)
    expect(pdf.pages, 'the letter version is ONE page').toBe(1)
    expect(pdf.count).toBe(1)
    // 8.5 × 11 inches = 612 × 792 pt.
    expect(pdf.sizes).toEqual([{ width: 612, height: 792 }])

    expect(errors).toEqual([])

    await test
      .info()
      .attach('cheatsheet-letter.pdf', { body: bytes, contentType: 'application/pdf' })
    if (saveEvidence) {
      await mkdir(EVIDENCE_DIR, { recursive: true })
      await writeFile(path.join(EVIDENCE_DIR, 'cheatsheet-letter.pdf'), bytes)
      await savePrintPicture(
        browser,
        baseURL,
        'letter',
        path.join(EVIDENCE_DIR, 'cheatsheet-letter-print.png'),
      )
    }
  })

  test("the browser's own Print command, with no button, gives the letter page", async ({
    page,
  }) => {
    await open(page)
    expect(await printState(page)).toEqual({ mode: 'letter', rule: PAPER.letter.rule })
    expect(await printCalls(page)).toBe(0)

    await page.emulateMedia({ media: 'print' })
    await expectOnlyTheSheet(page, 'letter')

    const pdf = readPdf(await page.pdf({ preferCSSPageSize: true, printBackground: false }))
    expect(pdf.pages).toBe(1)
    expect(pdf.sizes).toEqual([{ width: 612, height: 792 }])
  })

  test('when the print job is over, the page is back on the letter page', async ({ page }) => {
    await open(page)

    // The browser says that the print job is over.
    await pressPrint(page, 'card')
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    expect(await printState(page)).toEqual({ mode: 'letter', rule: PAPER.letter.rule })

    // A browser that never says so: the next key press puts the letter page back …
    await pressPrint(page, 'card')
    await page.keyboard.press('Shift')
    expect(await printState(page)).toEqual({ mode: 'letter', rule: PAPER.letter.rule })

    // … and so does the next click anywhere on the page.
    await pressPrint(page, 'card')
    await page.locator('h1').click()
    expect(await printState(page)).toEqual({ mode: 'letter', rule: PAPER.letter.rule })

    // There is only ever one `@page` rule.
    expect(await page.locator('style#cheatsheet-page-rule').count()).toBe(1)
  })

  test('the keyboard can press the card button', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: CARD_BUTTON }).focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => printCalls(page)).toBe(1)
    expect(await printState(page)).toEqual({ mode: 'card', rule: PAPER.card.rule })
  })

  for (const mode of ['card', 'letter'] as const) {
    test(`on the ${mode}, letters a little wider do not move a single line break`, async ({
      page,
    }) => {
      await open(page)
      await pressPrint(page, mode)
      await page.emulateMedia({ media: 'print' })
      const before = await measureSheet(page, mode)

      // Every line about 2.5 % wider, as in a browser whose letters come out a little
      // wider. The columns are wide enough that every line still breaks at the same place,
      // so nothing moves down and the page stays one page.
      await page.addStyleTag({
        content: `${PAPER[mode].sheet} { letter-spacing: ${WIDER_LETTERS} }`,
      })
      const after = await measureSheet(page, mode)
      expect(after.spare, 'every column ends where it did').toEqual(before.spare)
      expect(after.height).toBe(before.height)
      expect(after.tooWide).toEqual([])
      expect(after.outside).toEqual([])
      const pdf = readPdf(await page.pdf({ preferCSSPageSize: true, printBackground: false }))
      expect(pdf.pages).toBe(1)
    })
  }

  test('with SF Mono as its code font, the card is still one page', async ({ page }) => {
    test.skip(!existsSync(SF_MONO_FILE), 'SF Mono is a font of the Mac only.')
    await open(page)
    await pressPrint(page, 'card')
    await page.emulateMedia({ media: 'print' })

    // SF Mono is wider and taller than Menlo. Each font sits on a line of Arial in its own
    // way: without the card's rule for code, each line with code grew by about 1 px and
    // the last line went onto a second card.
    const font = (await readFile(SF_MONO_FILE)).toString('base64')
    await page.addStyleTag({
      content: [
        `@font-face { font-family: 'Test SF Mono'; src: url(data:font/ttf;base64,${font}) format('truetype'); }`,
        `.cs-card { --cs-mono: 'Test SF Mono' !important; }`,
      ].join('\n'),
    })
    await page.evaluate(() => document.fonts.load('6pt "Test SF Mono"'))
    expect(await page.evaluate(() => document.fonts.check('6pt "Test SF Mono"'))).toBe(true)
    const mono = await page
      .locator('.cs-card code')
      .first()
      .evaluate((code) => getComputedStyle(code).fontFamily)
    expect(mono).toBe('"Test SF Mono"')

    const report = await measureSheet(page, 'card')
    expect(report.height, 'the card is not taller than one page').toBeLessThanOrEqual(
      2.8 * PX_PER_INCH,
    )
    for (const [index, room] of report.spare.entries()) {
      expect(room, `column ${index + 1} still fits`).toBeGreaterThanOrEqual(0)
    }
    expect(report.tooWide).toEqual([])
    expect(report.outside).toEqual([])
    const pdf = readPdf(await page.pdf({ preferCSSPageSize: true, printBackground: false }))
    expect(pdf.pages, 'the card is still ONE page').toBe(1)
  })

  test.describe('in the dark theme', () => {
    test.use({ colorScheme: 'dark' })

    for (const mode of ['card', 'letter'] as const) {
      test(`the ${mode} prints black on white, with no page background`, async ({ page }) => {
        await open(page)
        await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
        await pressPrint(page, mode)
        await page.emulateMedia({ media: 'print' })
        await expectOnlyTheSheet(page, mode)

        const report = await measureSheet(page, mode)
        expect(report.textColors, 'all text is black').toEqual(['rgb(0, 0, 0)'])
        // <html>, <body> and the sheet itself.
        expect(report.backgrounds).toEqual([
          'rgb(255, 255, 255)',
          'rgb(255, 255, 255)',
          'rgb(255, 255, 255)',
        ])

        const pdf = readPdf(await page.pdf({ preferCSSPageSize: true, printBackground: false }))
        expect(pdf.pages).toBe(1)
      })
    }
  })
})
