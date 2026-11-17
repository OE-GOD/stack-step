/// <reference lib="dom" />
/**
 * The progress page, tested in a real browser. Most tests put a known progress value into
 * storage before the site starts, and check what the page makes of it.
 *
 *   E2E_DEV=1 E2E_PORT=5204 npx playwright test e2e/progress.spec.ts
 *
 * Runs in both Playwright projects (desktop 1280×800, phone 360×740). The reset dialog is
 * the browser's own <dialog>, so it is tested here, in a real browser: the <dialog> of
 * jsdom does not trap focus or close on Escape.
 *
 * The first line gives this file the browser types (`window`, `document`) for the
 * callbacks that run inside the page.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectNoSidewaysScroll, watchForErrors } from './helpers'
import { LESSONS } from '../src/content/lessonList'
import { TOPICS, type TopicId } from '../src/content/topics'

const STORAGE_KEY = 'stackstep:progress:v1'

/** "1101" → [true, true, false, true]: right, right, wrong, right (the newest last). */
function answers(pattern: string): boolean[] {
  return [...pattern].map((digit) => digit === '1')
}

/**
 * A student who has done some of everything. TABLE and WEAKEST below say what the page
 * must show for it; the quizzes are 9, 12 and 11 of 15 (the best is the middle one).
 */
const STUDENT = {
  version: 1,
  // 5 of 14 lessons: the first five.
  lessonsDone: {
    'registers-and-memory': '2026-11-02T10:00:00.000Z',
    'register-names': '2026-11-03T10:00:00.000Z',
    'partial-writes': '2026-11-04T10:00:00.000Z',
    'line-format': '2026-11-05T10:00:00.000Z',
    mov: '2026-11-06T10:00:00.000Z',
  },
  practice: {
    'register-names': { right: 9, wrong: 1, recent: answers('1111111110') },
    'subregister-writes': { right: 3, wrong: 5, recent: answers('01001010') },
    'rsp-tracker': { right: 2, wrong: 2, recent: answers('0101') },
    rip: { right: 4, wrong: 1, recent: answers('11011') },
    'call-ret': { right: 5, wrong: 5, recent: answers('1010101010') },
    'indirect-addressing': { right: 2, wrong: 6, recent: answers('00100100') },
    // 28 answers. Only the newest 20 are kept, and they are all right.
    'mov-legality': { right: 25, wrong: 3, recent: answers('1'.repeat(20)) },
    // 'homework-table' was never tried.
  },
  quizzes: [
    { score: 9, total: 15, date: '2026-11-10T09:00:00.000Z', weakTopics: ['rip'] },
    { score: 12, total: 15, date: '2026-11-12T09:00:00.000Z', weakTopics: [] },
    { score: 11, total: 15, date: '2026-11-14T09:00:00.000Z', weakTopics: ['call-ret'] },
  ],
}

/** The row of each topic in the practice table: right, wrong, recent accuracy. */
const TABLE: Record<TopicId, readonly [string, string, string] | 'Not tried yet'> = {
  'register-names': ['9', '1', '90%'],
  'subregister-writes': ['3', '5', '38%'],
  'rsp-tracker': ['2', '2', '50%'],
  rip: ['4', '1', '80%'],
  'call-ret': ['5', '5', '50%'],
  'indirect-addressing': ['2', '6', '25%'],
  'mov-legality': ['25', '3', '100%'],
  'homework-table': 'Not tried yet',
}

/**
 * The three weakest topics, weakest first: 25 %, then 38 %, then a tie at 50 %, which
 * `call-ret` wins with 10 answers against 4 (it comes after `rsp-tracker` in the topic
 * list, so the order is decided by the number of answers, not by the list).
 */
const WEAKEST = [
  {
    topic: 'indirect-addressing',
    lesson: 'indirect-addressing',
    accuracy: 'Recent accuracy: 25% (2 right of your last 8)',
  },
  {
    topic: 'subregister-writes',
    lesson: 'partial-writes',
    accuracy: 'Recent accuracy: 38% (3 right of your last 8)',
  },
  {
    topic: 'call-ret',
    lesson: 'call-and-ret',
    accuracy: 'Recent accuracy: 50% (5 right of your last 10)',
  },
] as const

/* ───────────────────────────── Helpers ───────────────────────────── */

function titleOfTopic(id: TopicId): string {
  const topic = TOPICS.find((candidate) => candidate.id === id)
  if (topic === undefined) throw new Error(`No topic ${id}`)
  return topic.title
}

function titleOfLesson(id: string): string {
  const lesson = LESSONS.find((candidate) => candidate.id === id)
  if (lesson === undefined) throw new Error(`No lesson ${id}`)
  return lesson.title
}

/**
 * Put `text` into storage before the site starts. Only once in a tab: a reload after a
 * reset must show what the reset left, not the same progress again.
 */
async function seed(page: Page, text: string): Promise<void> {
  await page.addInitScript(
    ({ key, value }) => {
      if (window.sessionStorage.getItem('e2e-progress-seeded') !== null) return
      window.sessionStorage.setItem('e2e-progress-seeded', '1')
      window.localStorage.setItem(key, value)
    },
    { key: STORAGE_KEY, value: text },
  )
}

async function open(page: Page): Promise<void> {
  await page.goto('/#/progress')
  await expect(page.locator('h1')).toHaveText('Progress')
}

function stored(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)
}

function region(page: Page, name: string): Locator {
  return page.getByRole('main').getByRole('region', { name, exact: true })
}

/** The page of a new student: a welcome and two ways to start, and nothing else. */
async function expectWelcome(page: Page): Promise<void> {
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { level: 2, name: 'Welcome' })).toBeVisible()
  await expect(main.getByRole('link', { name: 'Start lesson 1' })).toHaveAttribute(
    'href',
    `#/learn/${LESSONS[0].id}`,
  )
  await expect(main.getByRole('link', { name: 'Try a practice problem' })).toHaveAttribute(
    'href',
    '#/practice',
  )
  // No table of zeros, no lesson list, nothing to reset.
  await expect(main.getByRole('table')).toHaveCount(0)
  await expect(region(page, 'Lessons')).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Reset my progress', exact: true })).toHaveCount(0)
}

/* ─────────────────────────── A student with progress ─────────────────────────── */

test.describe('a student with progress', () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, JSON.stringify(STUDENT))
  })

  test('shows how many lessons are done, and a mark on every lesson', async ({ page }) => {
    const errors = watchForErrors(page)
    await open(page)
    await expect(page).toHaveTitle('Progress · Stack Step')
    await expect(page.locator('h1')).toHaveCount(1)

    const lessons = region(page, 'Lessons')
    await expect(lessons.getByText('5 of 14 lessons done', { exact: true })).toBeVisible()

    const items = lessons.getByRole('listitem')
    await expect(items).toHaveCount(LESSONS.length)
    for (const [index, lesson] of LESSONS.entries()) {
      const item = items.nth(index)
      const done = index < 5
      await expect(item).toContainText(lesson.title)
      await expect(item.getByRole('link')).toHaveAttribute('href', `#/learn/${lesson.id}`)
      // A screen reader hears the whole row as one clear name, with no stray spaces.
      await expect(item.getByRole('link')).toHaveAccessibleName(
        `Lesson ${lesson.number}: ${lesson.title}, ${done ? 'Done' : 'Not done yet'}`,
      )
      if (done) {
        // An icon and a word, never a color alone.
        await expect(item.getByText('Done', { exact: true })).toBeVisible()
        await expect(item.locator('svg')).toHaveCount(1)
        await expect(item).not.toContainText('Not done yet')
      } else {
        await expect(item.getByText('Not done yet', { exact: true })).toBeVisible()
      }
    }

    await expectNoSidewaysScroll(page)
    expect(errors, 'nothing is reported in the browser console').toEqual([])
  })

  test('the practice table shows right, wrong and the recent accuracy of every topic', async ({
    page,
  }) => {
    await open(page)
    const table = region(page, 'Practice accuracy').getByRole('table')
    await expect(table.getByRole('columnheader')).toHaveText([
      'Topic',
      'Right',
      'Wrong',
      'Recent accuracy',
    ])

    const rows = table.locator('tbody tr')
    await expect(rows).toHaveCount(TOPICS.length)
    for (const [index, topic] of TOPICS.entries()) {
      const row = rows.nth(index)
      const expected = TABLE[topic.id]
      await expect(row.getByRole('rowheader')).toHaveText(topic.title)
      // Each row links to the practice of its topic.
      await expect(row.getByRole('link', { name: topic.title })).toHaveAttribute(
        'href',
        `#/practice/${topic.id}`,
      )
      await expect(row.getByRole('cell')).toHaveText(
        expected === 'Not tried yet' ? [expected] : [...expected],
      )
      if (expected !== 'Not tried yet') {
        // The bar is as long as the number says. It is a picture only: the number is text.
        const bar = row.locator('[aria-hidden="true"] > span')
        await expect(bar).toHaveAttribute('style', `width: ${expected[2]};`)
      }
    }
  })

  test('the focus outline of a topic link does not touch its words', async ({ page }) => {
    await open(page)
    const link = region(page, 'Practice accuracy').getByRole('link').first()
    await link.focus()
    const room = await link.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        focusVisible: element.matches(':focus-visible'),
        outline: style.outlineStyle,
        // The card draws the outline inside the link (a negative offset). What is left
        // between the outline and the first letter is the padding minus that offset.
        gap: parseFloat(style.paddingLeft) + parseFloat(style.outlineOffset),
      }
    })
    expect(room.focusVisible).toBe(true)
    expect(room.outline).toBe('solid')
    expect(room.gap, 'px between the outline and the first letter').toBeGreaterThanOrEqual(2)
  })

  test('names the three weakest topics, weakest first, with a lesson and a practice link', async ({
    page,
  }) => {
    await open(page)
    const weak = region(page, 'Your weakest topics')
    const items = weak.getByRole('listitem')
    await expect(items).toHaveCount(3)

    for (const [index, { topic, lesson, accuracy }] of WEAKEST.entries()) {
      const item = items.nth(index)
      await expect(item).toContainText(`${index + 1}. ${titleOfTopic(topic)}`)
      await expect(item).toContainText(accuracy)
      // The link of the topic's first lesson, and the link to its practice. Their names
      // tell a screen reader which lesson and which practice the link opens.
      const review = `Review the lesson: ${titleOfLesson(lesson)}`
      await expect(item.getByRole('link', { name: review, exact: true })).toHaveAttribute(
        'href',
        `#/learn/${lesson}`,
      )
      const practice = `Practice: ${titleOfTopic(topic)}`
      await expect(item.getByRole('link', { name: practice, exact: true })).toHaveAttribute(
        'href',
        `#/practice/${topic}`,
      )
    }

    await expect(weak.getByRole('link', { name: 'Practice my weak spots' })).toHaveAttribute(
      'href',
      '#/practice/weak',
    )
  })

  test('"Practice my weak spots" opens the practice of the weak spots', async ({ page }) => {
    await open(page)
    await region(page, 'Your weakest topics')
      .getByRole('link', { name: 'Practice my weak spots' })
      .click()
    await expect(page).toHaveURL(/#\/practice\/weak$/)
    await expect(page).toHaveTitle('Practice my weak spots · Stack Step')
  })

  test('shows the latest and the best mixed quiz', async ({ page }) => {
    await open(page)
    const quizzes = region(page, 'Mixed quizzes')
    await expect(quizzes.locator('dt')).toHaveText(['Latest score', 'Best score'])
    const [latest, best] = [quizzes.locator('dd').first(), quizzes.locator('dd').last()]
    await expect(latest).toContainText('11 of 15 (73%)')
    await expect(best).toContainText('12 of 15 (80%)')
    await expect(quizzes).toContainText('Quizzes taken: 3')
    await expect(quizzes.getByRole('link', { name: 'Take the mixed quiz' })).toHaveAttribute(
      'href',
      '#/practice/quiz',
    )
  })

  test('every link and button on the page is big enough for a thumb', async ({ page }) => {
    await open(page)
    const small = await page.getByRole('main').evaluate((main) =>
      [...main.querySelectorAll('a, button')]
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => ({
          name: (control.textContent ?? '').trim(),
          height: control.getBoundingClientRect().height,
        }))
        .filter(({ height }) => height < 44),
    )
    expect(small, 'every control is at least 44 px tall').toEqual([])
  })

  test.describe('in the dark theme', () => {
    test.use({ colorScheme: 'dark' })

    test('the page loads with no errors and no sideways scrolling', async ({ page }) => {
      const errors = watchForErrors(page)
      await open(page)
      await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/)
      await expect(region(page, 'Lessons')).toContainText('5 of 14 lessons done')
      await expectNoSidewaysScroll(page)
      expect(errors).toEqual([])
    })
  })
})

/* ─────────────────────── A student who has done a lot ─────────────────────── */

/** `count` answers in a topic, all of them right: from 5 such answers a topic is mastered. */
function allRight(count: number): { right: number; wrong: number; recent: boolean[] } {
  return { right: count, wrong: 0, recent: answers('1'.repeat(count)) }
}

test.describe('a student who has done a lot', () => {
  test('after more than 20 quizzes, the quiz box does not claim numbers it cannot know', async ({
    page,
  }) => {
    // 25 quizzes. The store keeps only the newest 20, so the 15 of 15 of the third quiz is
    // gone: the best the page can know is the 13 of 15 of the 18th quiz.
    const quizzes = Array.from({ length: 25 }, (_, index) => ({
      score: index === 2 ? 15 : index === 17 ? 13 : 9,
      total: 15,
      date: new Date(Date.UTC(2026, 9, index + 1, 9)).toISOString(),
      weakTopics: [],
    }))
    await seed(page, JSON.stringify({ ...STUDENT, quizzes }))
    await open(page)

    const box = region(page, 'Mixed quizzes')
    await expect(box.locator('dt')).toHaveText(['Latest score', 'Best of your last 20'])
    await expect(box.locator('dd').first()).toContainText('9 of 15 (60%)')
    await expect(box.locator('dd').last()).toContainText('13 of 15 (87%)')
    await expect(box).toContainText('Quizzes taken: 20 or more')
    await expect(box).not.toContainText('15 of 15')
  })

  test('when every topic is mastered, nothing is called a weak topic', async ({ page }) => {
    const practice = Object.fromEntries(TOPICS.map((topic) => [topic.id, allRight(20)]))
    await seed(page, JSON.stringify({ ...STUDENT, practice }))
    await open(page)

    const weak = region(page, 'Your weakest topics')
    await expect(weak).toContainText('You have no weak topics right now.')
    await expect(weak.getByRole('listitem')).toHaveCount(0)
    await expect(weak.getByRole('link', { name: 'Practice my weak spots' })).toHaveCount(0)
    await expect(weak.getByRole('link', { name: 'Take the mixed quiz' })).toHaveAttribute(
      'href',
      '#/practice/quiz',
    )
    // The table still shows every topic at 100 %.
    await expect(
      region(page, 'Practice accuracy').getByRole('cell').filter({ hasText: '%' }),
    ).toHaveText(TOPICS.map(() => '100%'))
  })

  test('a mastered topic is never listed, even when fewer than three topics are left', async ({
    page,
  }) => {
    // Seven topics mastered, and "Trace table" never tried. The store fills its three places
    // with mastered topics; the page lists only the topic that was not tried.
    const practice = Object.fromEntries(
      TOPICS.filter((topic) => topic.id !== 'homework-table').map((topic) => [
        topic.id,
        allRight(5),
      ]),
    )
    await seed(page, JSON.stringify({ ...STUDENT, practice }))
    await open(page)

    const weak = region(page, 'Your weakest topics')
    const items = weak.getByRole('listitem')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText(`1. ${titleOfTopic('homework-table')}`)
    await expect(items.first()).toContainText('Not tried yet')
    await expect(weak.getByRole('link', { name: 'Practice my weak spots' })).toHaveAttribute(
      'href',
      '#/practice/weak',
    )
    await expectNoSidewaysScroll(page)
  })
})

/* ───────────────────────────────── Resetting ───────────────────────────────── */

test.describe('resetting', () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, JSON.stringify(STUDENT))
  })

  /** Open the dialog with the reset button. Focus starts on "Cancel", the safe answer. */
  async function askToReset(page: Page): Promise<Locator> {
    await page
      .getByRole('main')
      .getByRole('button', { name: 'Reset my progress', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: 'Reset your progress?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('You cannot undo this.')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    // Opened with showModal(): the browser traps focus and makes the page behind inert.
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(true)
    return dialog
  }

  /** Nothing was erased: the page and the stored value are as before. */
  async function expectNothingErased(page: Page, before: string | null): Promise<void> {
    await expect(region(page, 'Lessons')).toContainText('5 of 14 lessons done')
    expect(await stored(page)).toBe(before)
  }

  test('the page says that progress is stored only in this browser', async ({ page }) => {
    await open(page)
    const startAgain = region(page, 'Start again')
    await expect(startAgain).toContainText('Your progress is stored only in this browser.')
    await expect(
      startAgain.getByRole('button', { name: 'Reset my progress', exact: true }),
    ).toBeVisible()
  })

  test('"Cancel" erases nothing, and focus goes back to the reset button', async ({ page }) => {
    await open(page)
    const before = await stored(page)
    expect(before).not.toBeNull()

    const dialog = await askToReset(page)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Reset my progress', exact: true })).toBeFocused()
    await expectNothingErased(page, before)
  })

  test('Escape erases nothing, and focus goes back to the reset button', async ({ page }) => {
    await open(page)
    const before = await stored(page)

    const dialog = await askToReset(page)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Reset my progress', exact: true })).toBeFocused()
    await expectNothingErased(page, before)

    // The page knows that the dialog is closed: it opens again.
    await askToReset(page)
  })

  test('the Tab key stays in the dialog and never reaches the page behind it', async ({ page }) => {
    await open(page)
    const dialog = await askToReset(page)

    /** What has focus: a button of the dialog, nothing in the page (null), or a page control. */
    const focused = () =>
      page.evaluate(() => {
        const element = document.activeElement
        // Focus that leaves the page for the browser's own controls shows up as <body>.
        if (element === null || element === document.body) return null
        const inDialog = element.closest('dialog[open]') !== null
        return inDialog ? (element.textContent ?? '').trim() : `OUTSIDE: ${element.outerHTML}`
      })

    const seen = new Set<string | null>()
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key)
      const where = await focused()
      expect(where ?? '', `after ${key}`).not.toMatch(/^OUTSIDE/)
      seen.add(where)
    }
    // Both buttons of the dialog were reached.
    expect(seen).toContain('Cancel')
    expect(seen).toContain('Yes, reset my progress')
    await expect(dialog).toBeVisible()
  })

  test('"Yes, reset my progress" clears the page and the stored progress', async ({ page }) => {
    const errors = watchForErrors(page)
    await open(page)
    const dialog = await askToReset(page)
    await dialog.getByRole('button', { name: 'Yes, reset my progress' }).click()
    await expect(dialog).toBeHidden()

    // The page starts again, and says so where the keyboard focus now is.
    const done = page.getByRole('status').filter({ hasText: 'Your progress is reset.' })
    await expect(done).toBeVisible()
    await expect(done).toBeFocused()
    await expectWelcome(page)
    expect(await stored(page)).toBeNull()

    // After a reload the progress is still gone.
    await page.reload()
    await expect(page.locator('h1')).toHaveText('Progress')
    await expectWelcome(page)
    await expect(page.getByText('Your progress is reset.')).toHaveCount(0)
    expect(await stored(page)).toBeNull()
    expect(errors).toEqual([])
  })
})

/* ─────────────────────────────── A new student ─────────────────────────────── */

test.describe('a new student', () => {
  test('sees a short welcome and two ways to start, not a table of zeros', async ({ page }) => {
    const errors = watchForErrors(page)
    await open(page)
    await expectWelcome(page)
    await expect(page.getByRole('main')).toContainText(
      'Your progress is stored only in this browser.',
    )
    await expect(page.getByRole('main')).not.toContainText('forgotten')
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('after a lesson but before any practice, the weakest-topics box points to Practice', async ({
    page,
  }) => {
    await seed(
      page,
      JSON.stringify({
        version: 1,
        lessonsDone: { 'registers-and-memory': '2026-11-02T10:00:00.000Z' },
        practice: {},
        quizzes: [],
      }),
    )
    await open(page)
    await expect(region(page, 'Lessons')).toContainText('1 of 14 lessons done')

    const weak = region(page, 'Your weakest topics')
    await expect(weak).toContainText('You have not answered a practice problem yet.')
    await expect(weak.getByRole('link', { name: 'Go to Practice' })).toHaveAttribute(
      'href',
      '#/practice',
    )
    await expect(weak.getByRole('link', { name: 'Practice my weak spots' })).toHaveCount(0)

    // Every topic says so in words.
    const cells = region(page, 'Practice accuracy').getByRole('cell')
    await expect(cells).toHaveText(TOPICS.map(() => 'Not tried yet'))
    // No quiz yet: no quiz box.
    await expect(region(page, 'Mixed quizzes')).toHaveCount(0)
  })
})

/* ──────────────────────── Stored data that cannot be used ──────────────────────── */

test.describe('stored data that cannot be used', () => {
  for (const [what, text] of [
    ['broken JSON', '{"version":1,"lessonsDone":{"mov":'],
    ['a list', '[]'],
    ['null', 'null'],
    ['a string', '"progress"'],
    ['another version', JSON.stringify({ ...STUDENT, version: 2 })],
  ] as const) {
    test(`${what} gives a fresh start, and the page still works`, async ({ page }) => {
      const errors = watchForErrors(page)
      await seed(page, text)
      await open(page)
      await expectWelcome(page)
      await expectNoSidewaysScroll(page)
      expect(errors).toEqual([])
    })
  }

  test('bad entries are left out, and the good ones are shown', async ({ page }) => {
    const errors = watchForErrors(page)
    await seed(
      page,
      JSON.stringify({
        version: 1,
        lessonsDone: {
          mov: '2026-11-06T10:00:00.000Z',
          'a-lesson-that-is-gone': '2026-11-06T10:00:00.000Z',
          'line-format': 'yesterday',
        },
        practice: {
          rip: { right: 'four', wrong: 1, recent: [true] },
          'call-ret': { right: 1, wrong: 1, recent: [false, true] },
          'a-topic-that-is-gone': { right: 1, wrong: 0, recent: [true] },
        },
        quizzes: [{ score: 20, total: 15, date: '2026-11-10T09:00:00.000Z', weakTopics: [] }, 7],
      }),
    )
    await open(page)

    await expect(region(page, 'Lessons')).toContainText('1 of 14 lessons done')
    const rows = region(page, 'Practice accuracy').locator('tbody tr')
    await expect(rows.filter({ hasText: titleOfTopic('call-ret') }).getByRole('cell')).toHaveText([
      '1',
      '1',
      '50%',
    ])
    await expect(rows.filter({ hasText: titleOfTopic('rip') }).getByRole('cell')).toHaveText([
      'Not tried yet',
    ])
    await expect(region(page, 'Mixed quizzes')).toHaveCount(0)
    expect(errors).toEqual([])
  })
})

/* ─────────────────────────── Storage that is blocked ─────────────────────────── */

test.describe('storage that is blocked', () => {
  test('the same note as on Learn and Practice says that progress is kept until a reload', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('Access is denied for this document.', 'SecurityError')
        },
      })
    })
    const errors = watchForErrors(page)
    await open(page)

    const main = page.getByRole('main')
    // One tone and one sentence on every page that keeps progress (UX review: it said
    // "blocks storage" and "close this tab" here, but a reload loses the progress too).
    const note = main.locator('[data-no-storage]')
    await expect(note).toHaveCount(1)
    await expect(note).toContainText('Not saved')
    await expect(note).toContainText(
      'This browser does not let Stack Step save your progress. It is kept only until you close or reload this page.',
    )
    await expect(main).not.toContainText('blocks storage')
    // The page does not promise what it cannot do.
    await expect(main).not.toContainText('stored only in this browser')
    await expectWelcome(page)
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })
})
