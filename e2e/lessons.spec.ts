/// <reference lib="dom" />
/**
 * The Learn pages in a real browser: the list of lessons, a lesson with its live example
 * and its check question, done-tracking, and the way from lesson to lesson.
 *
 *   E2E_DEV=1 E2E_PORT=5224 npx playwright test e2e/lessons.spec.ts
 *
 * Runs in both Playwright projects (desktop 1280×800, phone 360×740). Every test starts
 * with empty storage (Playwright gives each test a fresh browser context).
 *
 * The first line gives this file the browser types for callbacks that run in the page.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { LESSONS } from '../src/content/lessonList'
import { blockStorage, expectNoSidewaysScroll, isPhone, watchForErrors } from './helpers'

const STORAGE_KEY = 'stackstep:progress:v1'
const FIRST = LESSONS[0]
const SECOND = LESSONS[1]

/** The smallest text a student must read on a phone, in px. */
const MIN_PHONE_TEXT = 14

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`/#${path}`)
  await expect(page.locator('h1')).toBeVisible()
}

/** The heading that shows the lesson file is on the page (or a message stands in for it). */
function lessonSettled(page: Page): Locator {
  return page.getByRole('heading', {
    level: 2,
    name: /^(Check yourself|This lesson has a problem|This lesson did not load)$/,
  })
}

/**
 * Text in the main part of the page that is smaller than `min` px, as "size "text"". The
 * live example and code listings are left out: the stepper's panels own their sizes.
 */
async function textSmallerThan(page: Page, min: number): Promise<string[]> {
  return page.locator('main').evaluate((main, limit) => {
    const found: string[] = []
    for (const element of main.querySelectorAll<HTMLElement>('*')) {
      if (element.closest('[data-ministepper], [data-line]') !== null) continue
      const own = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim()
      if (own === '' || element.getClientRects().length === 0) continue
      const size = Number.parseFloat(getComputedStyle(element).fontSize)
      if (size < limit - 0.01) found.push(`${size}px "${own.slice(0, 40)}"`)
    }
    return found
  }, min)
}

async function openLesson(page: Page, id: string): Promise<void> {
  await open(page, `/learn/${id}`)
  await expect(lessonSettled(page)).toBeVisible()
}

/** The lessons stored as done in this browser: lesson id → date. */
async function storedLessonsDone(page: Page): Promise<Record<string, string>> {
  return page.evaluate((key) => {
    const text = localStorage.getItem(key)
    if (text === null) return {}
    const data = JSON.parse(text) as { lessonsDone?: Record<string, string> }
    return data.lessonsDone ?? {}
  }, STORAGE_KEY)
}

function feedback(page: Page): Locator {
  return page.locator('[data-feedback]')
}

function doneMark(page: Page): Locator {
  return page.locator('header [data-done-mark]')
}

async function answerLessonOne(page: Page, label: '4' | '8' | '16' | '64'): Promise<void> {
  await page.getByRole('radio', { name: label, exact: true }).check()
  await page.getByRole('button', { name: 'Check', exact: true }).click()
}

test.describe('the list of lessons', () => {
  test('shows all 14 lessons in order, how many are done, and where to start', async ({ page }) => {
    const errors = watchForErrors(page)
    await open(page, '/learn')
    await expect(page.locator('h1')).toHaveText('Learn')

    const items = page.getByRole('list', { name: 'Lessons' }).getByRole('listitem')
    await expect(items).toHaveCount(LESSONS.length)
    for (const [index, lesson] of LESSONS.entries()) {
      const link = items.nth(index).getByRole('link')
      await expect(link).toHaveAccessibleName(`Lesson ${lesson.number}: ${lesson.title}`)
      await expect(link).toHaveAttribute('href', `#/learn/${lesson.id}`)
    }
    await expect(page.locator('[data-done-mark]')).toHaveCount(0)

    await expect(page.getByText('0 of 14 done', { exact: true })).toBeVisible()
    const start = page.getByRole('link', { name: 'Start with lesson 1' })
    await expect(start).toHaveAttribute('href', `#/learn/${FIRST.id}`)
    // Saving works here, so the page does not warn about it.
    await expect(page.locator('[data-progress-not-saved]')).toHaveCount(0)

    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('says so when the browser blocks saving', async ({ page }) => {
    const errors = watchForErrors(page)
    await blockStorage(page)
    await open(page, '/learn')
    // A note box with an icon and a word, in the same words as the other pages.
    const note = page.locator('[data-progress-not-saved]')
    await expect(note).toContainText('Not saved')
    await expect(note).toContainText(
      'This browser does not let Stack Step save your progress. It is kept only until you close or reload this page.',
    )
    await expect(note.locator('svg')).toHaveCount(1)
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })
})

test.describe('a lesson', () => {
  test('shows its idea, its analogy, a live example and a question', async ({ page }) => {
    const errors = watchForErrors(page)
    await openLesson(page, FIRST.id)

    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toHaveText(FIRST.title)
    await expect(page.getByText('Lesson 1 of 14', { exact: true })).toBeVisible()
    await expect(page.locator('[data-lesson-idea]')).toContainText('registers')
    await expect(page.getByText('Think of it like this', { exact: true })).toBeVisible()
    await expect(page.locator('[data-ministepper]')).toBeVisible()
    await expect(
      page.getByRole('group', { name: 'How many hex digits does a 64-bit register have?' }),
    ).toBeVisible()
    await expect(page.getByRole('radio')).toHaveCount(4)
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Try it',
      'Check yourself',
      'Remember',
    ])

    // "Watch for" is above the example on a phone (so it is read before stepping), and
    // beside the example on a wide screen.
    const watch = await page.getByRole('heading', { name: 'Watch for' }).boundingBox()
    const stepper = await page.locator('[data-ministepper]').boundingBox()
    if (watch === null || stepper === null) throw new Error('Watch for or the example is missing.')
    if (isPhone(page)) expect(watch.y).toBeLessThan(stepper.y)
    else expect(watch.x).toBeGreaterThanOrEqual(stepper.x + stepper.width)

    // A whole register value is written in groups of four digits, as the Registers panel
    // beside it shows it.
    await expect(page.getByRole('listitem').filter({ hasText: 'After line 1' })).toContainText(
      'rax is 0x0000 0000 0000 002a',
    )

    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('its example steps: a register changes', async ({ page }) => {
    const errors = watchForErrors(page)
    await openLesson(page, FIRST.id)

    const example = page.locator('[data-ministepper]')
    const rax = example.locator('[data-register="rax"] [data-hex]')
    await expect(rax).toHaveText('0x0000000000000000')
    await example.getByRole('button', { name: 'Step', exact: true }).click()
    await expect(rax).toHaveText('0x000000000000002a')
    expect(errors).toEqual([])
  })

  test('a wrong answer shows its own feedback and does not mark the lesson done', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    await openLesson(page, FIRST.id)

    await answerLessonOne(page, '64')
    await expect(feedback(page)).toContainText('Not yet')
    await expect(feedback(page)).toContainText('64 is the number of bits.')
    // The right answer is not given away.
    await expect(feedback(page)).not.toContainText('Correct')
    await expect(doneMark(page)).toHaveCount(0)
    expect(await storedLessonsDone(page)).toEqual({})

    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('the right answer marks the lesson done: on the page, on the list, in storage', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    await openLesson(page, FIRST.id)

    await answerLessonOne(page, '8')
    await expect(feedback(page)).toContainText('Not yet')
    // A wrong answer can be changed and checked again.
    await answerLessonOne(page, '16')
    await expect(feedback(page)).toContainText('Correct')
    await expect(doneMark(page)).toBeVisible()
    await expect(doneMark(page)).toHaveText('Done')
    expect(Object.keys(await storedLessonsDone(page))).toEqual([FIRST.id])
    await expect(page.getByRole('link', { name: 'Go to lesson 2' })).toHaveAttribute(
      'href',
      `#/learn/${SECOND.id}`,
    )
    await expectNoSidewaysScroll(page)

    // Done stays done after a reload.
    await page.reload()
    await expect(lessonSettled(page)).toBeVisible()
    await expect(doneMark(page)).toBeVisible()

    await page.getByRole('link', { name: 'All lessons', exact: true }).click()
    await expect(page).toHaveURL(/#\/learn$/)
    const firstItem = page.getByRole('list', { name: 'Lessons' }).getByRole('listitem').first()
    await expect(firstItem.locator('[data-done-mark]')).toHaveText('Done')
    await expect(page.locator('[data-done-mark]')).toHaveCount(1)
    await expect(page.getByText('1 of 14 done', { exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Continue with lesson 2' })).toHaveAttribute(
      'href',
      `#/learn/${SECOND.id}`,
    )
    expect(errors).toEqual([])
  })

  test('the question works with the keyboard alone', async ({ page }) => {
    test.skip(isPhone(page), 'Needs a keyboard.')
    const errors = watchForErrors(page)
    await openLesson(page, FIRST.id)

    await page.getByRole('radio', { name: '4', exact: true }).focus()
    // The arrow keys move through the options: 4 → 8 → 16.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('radio', { name: '16', exact: true })).toBeChecked()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Check', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(feedback(page)).toContainText('Correct')
    expect(errors).toEqual([])
  })

  test('a typed answer: Enter checks it, and letter case does not matter', async ({ page }) => {
    const errors = watchForErrors(page)
    await openLesson(page, SECOND.id)

    const box = page.getByRole('textbox', { name: '16-bit part of r10' })
    await box.fill('r10d')
    await box.press('Enter')
    await expect(feedback(page)).toContainText('Not yet')
    await expect(feedback(page)).toContainText('r10d is the 32-bit part')
    await expect(doneMark(page)).toHaveCount(0)

    await box.fill(' R10W ')
    await box.press('Enter')
    await expect(feedback(page)).toContainText('Correct')
    await expect(doneMark(page)).toBeVisible()
    expect(Object.keys(await storedLessonsDone(page))).toEqual([SECOND.id])

    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })
})

test.describe('moving between lessons', () => {
  test('Next goes to lesson 2, and Previous comes back', async ({ page }) => {
    const errors = watchForErrors(page)
    await openLesson(page, FIRST.id)
    // The first lesson has no previous lesson.
    await expect(page.getByRole('link', { name: /^Previous lesson/ })).toHaveCount(0)

    await page.getByRole('link', { name: /^Next lesson/ }).click()
    await expect(page).toHaveURL(new RegExp(`#/learn/${SECOND.id}$`))
    await expect(page.locator('h1')).toHaveText(SECOND.title)
    await expect(lessonSettled(page)).toBeVisible()

    await page.getByRole('link', { name: /^Previous lesson/ }).click()
    await expect(page).toHaveURL(new RegExp(`#/learn/${FIRST.id}$`))
    await expect(page.locator('h1')).toHaveText(FIRST.title)

    const practice = page.getByRole('link', { name: 'Practice this: Register names' })
    await expect(practice).toHaveAttribute('href', '#/practice/register-names')
    expect(errors).toEqual([])
  })

  test('an address that is not a lesson says so and links to the list', async ({ page }) => {
    const errors = watchForErrors(page)
    await open(page, '/learn/not-a-lesson')
    const main = page.getByRole('main')
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toHaveText('There is no such lesson')
    const list = main.getByRole('link', { name: 'See all lessons' })
    await expect(list).toHaveAttribute('href', '#/learn')
    await expectNoSidewaysScroll(page)

    await list.click()
    await expect(page).toHaveURL(/#\/learn$/)
    await expect(page.locator('h1')).toHaveText('Learn')
    expect(errors).toEqual([])
  })

  test('a lesson id typed in capitals opens that lesson, at its usual address', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const mov = LESSONS.find((lesson) => lesson.id === 'mov')
    if (mov === undefined) throw new Error('There is no lesson "mov".')
    await page.goto('/#/learn/MOV')
    await expect(page).toHaveURL(/#\/learn\/mov$/)
    await expect(page.locator('h1')).toHaveText(mov.title)
    await expect(lessonSettled(page)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('a lesson loads the lessons before and after it, so Previous and Next open at once', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    // Lesson files by their file name: in the dev server the .tsx file, in the built site a
    // chunk named after it.
    const requested = new Set<string>()
    page.on('request', (request) => {
      for (const lesson of LESSONS) {
        const file = `${String(lesson.number).padStart(2, '0')}-${lesson.id}`
        if (request.url().includes(`/${file}`)) requested.add(lesson.id)
      }
    })
    await openLesson(page, SECOND.id)
    await expect
      .poll(() => [...requested].sort())
      .toEqual([FIRST.id, SECOND.id, LESSONS[2].id].sort())
    expect(errors).toEqual([])
  })

  test('the last lesson opens, and the way on works', async ({ page }) => {
    const errors = watchForErrors(page)
    const last = LESSONS[LESSONS.length - 1]
    const before = LESSONS[LESSONS.length - 2]
    await openLesson(page, last.id)
    await expect(page.locator('h1')).toHaveText(last.title)
    await expect(page.getByRole('heading', { name: 'Check yourself' })).toBeVisible()
    // Nothing crashed, and the way on is there.
    await expect(page.getByRole('heading', { name: /has a problem|did not load/ })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Go to practice' }).last()).toHaveAttribute(
      'href',
      '#/practice',
    )
    await page.getByRole('link', { name: /^Previous lesson/ }).click()
    await expect(page).toHaveURL(new RegExp(`#/learn/${before.id}$`))
    await expect(page.locator('h1')).toHaveText(before.title)
    await expect(lessonSettled(page)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('a lesson file that does not download: a calm message, Try again, the way on', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    // Block the file of lesson 2: in the dev server it is the .tsx file, in the built site
    // a chunk named after it.
    const lessonFile = /\/02-register-names[^/]*$/
    await page.route(lessonFile, (route) => route.abort())
    await open(page, `/learn/${SECOND.id}`)

    await expect(page.getByRole('heading', { name: 'This lesson did not load' })).toBeVisible()
    await expect(page.locator('h1')).toHaveText(SECOND.title)
    await expect(page.getByRole('link', { name: /^Previous lesson/ })).toHaveAttribute(
      'href',
      `#/learn/${FIRST.id}`,
    )
    await expect(page.getByRole('link', { name: /^Next lesson/ })).toHaveAttribute(
      'href',
      `#/learn/${LESSONS[2].id}`,
    )

    await page.unroute(lessonFile)
    await page.getByRole('button', { name: 'Try again' }).click()
    await expect(page.getByRole('heading', { name: 'Check yourself' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'This lesson did not load' })).toHaveCount(0)

    // Only the blocked download itself may be reported.
    expect(errors.filter((text) => !/Failed to load resource|ERR_FAILED/.test(text))).toEqual([])
  })
})

test.describe('every lesson', () => {
  test('opens without errors, and nothing on it scrolls sideways', async ({ page }) => {
    test.slow()
    const errors = watchForErrors(page)
    // A phone is checked at 360 px (the site's promise) and at 320 px (very small screens).
    const widths = isPhone(page) ? [360, 320] : [page.viewportSize()?.width ?? 1280]
    for (const width of widths) {
      await page.setViewportSize({ width, height: page.viewportSize()?.height ?? 740 })
      for (const lesson of LESSONS) {
        await page.goto(`/#/learn/${lesson.id}`)
        await expect(page.locator('h1')).toHaveText(lesson.title)
        await expect(page.getByRole('heading', { level: 2, name: 'Check yourself' })).toBeVisible()
        await expect(page.locator('h1')).toHaveCount(1)
        await expectNoSidewaysScroll(page)
        if (width < 360) continue
        // Code lines are short enough for the boxes: nothing is cut off at the right. (A code
        // box is the box around a list of code lines.)
        const cutOff = await page.locator('main ol:has(> li[data-line])').evaluateAll((lists) =>
          lists
            .map((list) => list.parentElement)
            .filter((box): box is HTMLElement => box !== null && box.scrollWidth > box.clientWidth)
            .map((box) => box.getAttribute('aria-label') ?? 'a code box'),
        )
        expect(
          cutOff,
          `${lesson.id} at ${width} px: code boxes too narrow for their lines`,
        ).toEqual([])
      }
    }
    expect(errors).toEqual([])
  })

  test(`on a phone, every text a student reads is at least ${MIN_PHONE_TEXT} px`, async ({
    page,
  }) => {
    test.skip(!isPhone(page), 'The size rule is for phones.')
    test.slow()
    const errors = watchForErrors(page)

    // A done lesson shows the "Done" mark, and its question shows feedback.
    await openLesson(page, FIRST.id)
    await answerLessonOne(page, '16')
    await expect(doneMark(page)).toBeVisible()
    expect(await textSmallerThan(page, MIN_PHONE_TEXT), FIRST.id).toEqual([])
    // A hex question shows a help line with code in it, and a wrong answer gets feedback.
    for (const lesson of LESSONS.slice(1)) {
      await openLesson(page, lesson.id)
      await page.getByRole('button', { name: 'Check', exact: true }).click()
      await expect(feedback(page).locator('p').first()).toBeVisible()
      expect(await textSmallerThan(page, MIN_PHONE_TEXT), lesson.id).toEqual([])
    }
    // The list shows the "Done" mark too.
    await open(page, '/learn')
    await expect(page.locator('[data-done-mark]')).toHaveCount(1)
    expect(await textSmallerThan(page, MIN_PHONE_TEXT), 'the list').toEqual([])
    expect(errors).toEqual([])
  })
})
