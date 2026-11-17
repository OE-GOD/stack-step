/// <reference lib="dom" />
/**
 * The practice pages in a real browser: a session (right, wrong, blank, next problem,
 * "Show me"), the hub's accuracy, the mixed quiz, the weak-spots mix, an unknown topic,
 * the keyboard, and phone width.
 *
 *   E2E_DEV=1 E2E_PORT=5234 npx playwright test e2e/practice.spec.ts
 *
 * Runs in both projects (desktop 1280×800, phone 360×740).
 *
 * How the tests know the right answer: they import the generators (and the quiz builder)
 * from `src/` and build the same problem from the same seed (`?seed=N` in the address
 * opens exactly that problem). Nothing is read back from the page to find the answer.
 *
 * The first line gives this file the browser types for callbacks that run in the page.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { generate as callRetProblem } from '../src/features/practice/generators/call-ret'
import { generate as homeworkTableProblem } from '../src/features/practice/generators/homework-table'
import { generate as movLegalityProblem } from '../src/features/practice/generators/mov-legality'
import { generate as ripProblem } from '../src/features/practice/generators/rip'
import { generateWithPredictions as registerNamesProblem } from '../src/features/practice/generators/register-names'
import { generateWithPredictions as subregisterProblem } from '../src/features/practice/generators/subregister-writes'
import { generate as rspTrackerProblem } from '../src/features/practice/generators/rsp-tracker'
import { buildQuiz } from '../src/features/practice/session'
import { QUIZ_LENGTH, weakMixWords, weakRotation } from '../src/features/practice/topicMix'
import { MAX_ANSWER_LENGTH, type Field, type Problem } from '../src/features/practice/types'
import type { ProgressData } from '../src/lib/progress'
import { decodePayload } from '../src/lib/share'
import { TOPICS, type TopicId } from '../src/content/topics'
import {
  blockStorage,
  codeEditor,
  expectNoSidewaysScroll,
  pressStep,
  registerValue,
  stepperPage,
  watchForErrors,
} from './helpers'

const PROGRESS_KEY = 'stackstep:progress:v1'

/* ───────────────────────────────── helpers ───────────────────────────────── */

/** Text as the page shows it: code in backticks loses its backticks. */
function plain(text: string | undefined): string {
  return (text ?? '').replaceAll('`', '')
}

function card(page: Page): Locator {
  return page.locator('[data-practice-card]')
}

function result(page: Page): Locator {
  return page.getByTestId('result')
}

function checkButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Check', exact: true })
}

function nextButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Next problem' })
}

function showMeLink(page: Page): Locator {
  return page.getByRole('link', { name: /^Show me/ })
}

function fieldInput(page: Page, field: Field): Locator {
  return page.getByLabel(plain(field.label), { exact: true })
}

async function openProblem(page: Page, topic: TopicId, seed: number): Promise<void> {
  await page.goto(`/#/practice/${topic}?seed=${seed}`)
  await expect(card(page)).toHaveAttribute('data-problem-id', `${topic}-${seed}`)
}

/** Type the right answer of every field (as the page shows it), or pick the right choice. */
async function answerRight(page: Page, problem: Problem): Promise<void> {
  for (const field of problem.fields) {
    if (field.kind.type === 'choice') {
      await page.getByLabel(plain(field.expectedDisplay), { exact: true }).check()
    } else {
      await fieldInput(page, field).fill(field.expectedDisplay)
    }
  }
}

/** The first seed (from 0) whose problem passes the test. */
function firstSeed<T>(make: (seed: number) => T, wanted: (made: T) => boolean): number {
  for (let seed = 0; seed < 2000; seed++) if (wanted(make(seed))) return seed
  throw new Error('No seed found.')
}

/**
 * The main button of a session (and the quiz's Back, Next and Finish) ignores presses for
 * a moment after it changes its job or appears, against double taps, and says so with
 * aria-disabled. A click waits for that by itself; a key press or a raw tap does not.
 */
async function expectSettled(button: Locator): Promise<void> {
  await expect(button).not.toHaveAttribute('aria-disabled', 'true')
}

/** Two taps (or clicks) on the same spot, `gap` ms apart, the way a hurried thumb does it. */
async function doubleTap(page: Page, target: Locator, gap = 150): Promise<void> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (box === null) throw new Error('The button is not on the screen.')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const touch = await page.evaluate(() => navigator.maxTouchPoints > 0)
  for (const tap of [1, 2]) {
    if (touch) await page.touchscreen.tap(x, y)
    else await page.mouse.click(x, y)
    if (tap === 1) await page.waitForTimeout(gap)
  }
}

/** The recent results the progress store keeps for a topic. */
async function recentResults(page: Page, topic: TopicId): Promise<boolean[]> {
  return page.evaluate(
    ([key, id]) => {
      const stored = JSON.parse(localStorage.getItem(key) ?? '{}') as {
        practice?: Record<string, { recent?: boolean[] }>
      }
      return stored.practice?.[id]?.recent ?? []
    },
    [PROGRESS_KEY, topic] as const,
  )
}

/** Press Tab until `target` has the keyboard focus. */
async function tabTo(page: Page, target: Locator, limit = 60): Promise<void> {
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
}

/** The `s=` payload of a stepper link. */
function payloadOf(href: string): ReturnType<typeof decodePayload> {
  const hash = new URL(href).hash
  const query = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
  return decodePayload(query.get('s') ?? '')
}

function emptyProgress(): ProgressData {
  return { version: 1, lessonsDone: {}, practice: {}, quizzes: [] }
}

function titleOf(topic: TopicId): string {
  return TOPICS.find((entry) => entry.id === topic)?.title ?? topic
}

/* ───────────────────────────────── a session ───────────────────────────────── */

test.describe('a practice problem', () => {
  test('marks a right answer "Correct" and gives the reason', async ({ page }) => {
    const errors = watchForErrors(page)
    const { problem } = subregisterProblem(7)
    const field = problem.fields[0]
    if (field === undefined) throw new Error('The problem has no field.')

    await openProblem(page, 'subregister-writes', 7)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(titleOf('subregister-writes'))
    await expect(card(page)).toContainText(
      plain(problem.prompt[1]?.type === 'text' ? problem.prompt[1].text : ''),
    )
    await expect(card(page)).toContainText('0 of 16 digits')
    await fieldInput(page, field).fill(field.expectedDisplay)
    await expect(card(page)).toContainText('16 of 16 digits')
    await checkButton(page).click()

    await expect(result(page)).toContainText('Correct')
    await expect(result(page)).toContainText(plain(problem.reason))
    await expect(card(page).locator('[data-field-mark="right"]')).toHaveText('Right')
    await expect(fieldInput(page, field)).not.toBeEditable()
    await expect(showMeLink(page)).toHaveCount(0)
    await expect(page.locator('[data-session-score]')).toHaveText('1 of 1 right')
    // Plain words, no idiom: "Right answers one after another: 1".
    await expect(page.locator('[data-session-stats]')).toContainText(
      'Right answers one after another: 1',
    )
    await expect(page.locator('[data-session-streak]')).toHaveText('1')
    await expect(page.locator('[data-session-stats]')).not.toContainText(/streak|in a row/i)
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('marks a wrong answer "Not yet": right answer, reason, named mistake, Show me', async ({
    page,
    context,
  }) => {
    const errors = watchForErrors(page)
    // A 32-bit write, so the tempting answer keeps the old top half.
    const seed = firstSeed(subregisterProblem, ({ predictions }) =>
      predictions.some((prediction) => prediction.code === 'forgot-zero-upper'),
    )
    const { problem, predictions } = subregisterProblem(seed)
    const keptTop = predictions.find((prediction) => prediction.code === 'forgot-zero-upper')
    const field = problem.fields[0]
    if (keptTop === undefined || field === undefined) throw new Error('No 32-bit problem.')
    const typed = keptTop.answers.after ?? ''
    const mistake = problem.diagnose({ after: BigInt(typed).toString(16) })

    await openProblem(page, 'subregister-writes', seed)
    await fieldInput(page, field).fill(typed)
    await checkButton(page).click()

    const feedback = result(page)
    await expect(feedback).toContainText('Not yet')
    await expect(feedback.locator('[data-your-answer]')).toHaveText(typed)
    await expect(feedback.locator('[data-right-answer]')).toHaveText(field.expectedDisplay)
    await expect(feedback).toContainText(plain(problem.reason))
    await expect(feedback.getByTestId('mistake')).toHaveAttribute(
      'data-mistake-code',
      'forgot-zero-upper',
    )
    await expect(feedback.getByTestId('mistake')).toContainText(
      `Common mistake: ${plain(mistake?.message)}`,
    )
    await expect(card(page).locator('[data-field-mark="wrong"]')).toHaveText('Wrong')
    await expect(page.locator('[data-session-score]')).toHaveText('0 of 1 right')

    // "Show me" is a real link to the stepper with exactly this problem, in a new tab.
    const link = showMeLink(page)
    await expect(link).toHaveAttribute('target', '_blank')
    const href = await link.getAttribute('href')
    expect(payloadOf(href ?? '')).toEqual(problem.stepper)

    // The inline stepper runs the same program here.
    await page.getByRole('button', { name: 'Step through it here' }).click()
    const mini = page.locator('[data-ministepper]')
    await expect(mini).toBeVisible()
    await expect(mini).toContainText(problem.stepper.code.split('\n')[2]?.trim() ?? '')
    await expectNoSidewaysScroll(page)

    // Follow the link: the stepper opens with the program and its starting values.
    const [stepper] = await Promise.all([context.waitForEvent('page'), link.click()])
    await expect(codeEditor(stepper)).toBeVisible()
    // (The program ends with a line break, so the editor shows an empty last line.)
    await expect(stepper.locator('[data-stepper-page] .cm-line')).toHaveText(
      problem.stepper.code.split('\n'),
    )
    await expect(stepperPage(stepper)).toContainText(plain(problem.stepper.note))
    await pressStep(stepper, 1)
    const base = field.label.split(' ')[0] ?? ''
    expect(await registerValue(stepper, base)).toBe(field.expectedDisplay)
    expect(errors).toEqual([])
  })

  test('names a wrong register part, and the unanswered part', async ({ page }) => {
    const errors = watchForErrors(page)
    const isNameQuestion = ({ problem: made }: { problem: Problem }) =>
      made.fields[0]?.id === 'name'
    const blankSeed = firstSeed(registerNamesProblem, isNameQuestion)
    const seed = firstSeed(
      (candidate) => registerNamesProblem(candidate + blankSeed + 1),
      isNameQuestion,
    )
    const partSeed = seed + blankSeed + 1

    // Only the name: the size is left blank.
    const blank = registerNamesProblem(blankSeed).problem
    const [blankName, blankSize] = blank.fields
    if (blankName === undefined || blankSize === undefined) throw new Error('No name question.')
    await openProblem(page, 'register-names', blankSeed)
    await fieldInput(page, blankName).fill(blankName.expectedDisplay)
    await checkButton(page).click()
    await expect(result(page)).toContainText('Not yet')
    await expect(result(page).getByTestId('mistake')).toHaveAttribute(
      'data-mistake-code',
      'unanswered',
    )
    await expect(result(page)).toContainText(`You left one part blank: "${blankSize.label}"`)

    // A real name of the same register, but another part.
    const { problem, predictions } = registerNamesProblem(partSeed)
    const [name, size] = problem.fields
    const wrongPart = predictions.find((prediction) => prediction.code === 'wrong-part')
    if (name === undefined || size === undefined || wrongPart === undefined) {
      throw new Error('No name question.')
    }
    await openProblem(page, 'register-names', partSeed)
    await fieldInput(page, name).fill(wrongPart.answers.name ?? '')
    await fieldInput(page, size).fill(size.expectedDisplay)
    await checkButton(page).click()
    await expect(result(page).getByTestId('mistake')).toHaveAttribute(
      'data-mistake-code',
      'wrong-part',
    )
    await expect(result(page)).toContainText(plain(problem.diagnose(wrongPart.answers)?.message))
    await expect(card(page).locator('[data-field-mark="right"]')).toHaveText('Right')
    await expect(card(page).locator('[data-field-mark="wrong"]')).toHaveText('Wrong')
    expect(errors).toEqual([])
  })

  test('says what is missing when the field is blank', async ({ page }) => {
    const errors = watchForErrors(page)
    await openProblem(page, 'subregister-writes', 7)
    await checkButton(page).click()
    await expect(result(page)).toContainText('Not yet')
    await expect(result(page)).toContainText('You did not type an answer yet.')
    await expect(result(page).locator('[data-your-answer]')).toHaveText('blank')
    expect(errors).toEqual([])
  })

  test('"Next problem" gives a different problem, from a new seed in the address', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    await openProblem(page, 'subregister-writes', 7)
    await checkButton(page).click()
    await nextButton(page).click()

    await expect(card(page)).not.toHaveAttribute('data-problem-id', 'subregister-writes-7')
    const id = (await card(page).getAttribute('data-problem-id')) ?? ''
    const seed = Number(id.replace('subregister-writes-', ''))
    expect(Number.isInteger(seed)).toBe(true)
    await expect(page).toHaveURL(new RegExp(`#/practice/subregister-writes\\?seed=${seed}$`))

    // It is exactly the generator's problem for that seed, fresh and unlocked.
    const { problem } = subregisterProblem(seed)
    const field = problem.fields[0]
    if (field === undefined) throw new Error('The problem has no field.')
    const question = problem.prompt[1]
    await expect(card(page)).toContainText(plain(question?.type === 'text' ? question.text : ''))
    await expect(fieldInput(page, field)).toHaveValue('')
    await expect(fieldInput(page, field)).toBeEditable()
    await expect(result(page)).toBeEmpty()
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(/^Problem 2$/i)
    await expect(page.locator('[data-session-score]')).toHaveText('0 of 1 right')
    expect(errors).toEqual([])
  })

  test('without a seed, writes a new one into the address', async ({ page }) => {
    await page.goto('/#/practice/register-names')
    await expect(page).toHaveURL(/#\/practice\/register-names\?seed=\d+$/)
    const seed = Number(new URL(page.url()).hash.split('seed=')[1])
    await expect(card(page)).toHaveAttribute('data-problem-id', `register-names-${seed}`)
  })
})

/* ─────────────────────── double taps, and the phone screen ─────────────────────── */

/** A student who moves rsp the wrong way at every push, pop, call and ret (sub, add right). */
function wrongWayAnswers(problem: Problem): Record<string, string> {
  const first = problem.prompt[0]
  const start = /starts at (0x[0-9a-f]+)/.exec(first?.type === 'text' ? first.text : '')?.[1]
  const trace = problem.prompt.find((block) => block.type === 'trace')
  if (start === undefined || trace?.type !== 'trace') throw new Error('Not an rsp problem.')
  const answers: Record<string, string> = {}
  let rsp = BigInt(start)
  for (const row of trace.rows) {
    const kind = row.text.split(' ')[0] ?? ''
    const down = ['push', 'call', 'sub'].includes(kind)
    const box = ['push', 'pop', 'call', 'ret'].includes(kind)
    const size = box ? 8n : BigInt(/(\d+)$/.exec(row.text)?.[1] ?? '0')
    // Every box move goes the wrong way; `sub` and `add` go the right way.
    rsp = down !== box ? rsp - size : rsp + size
    answers[row.fieldId] = `0x${rsp.toString(16)}`
  }
  return answers
}

test.describe('a double tap on the main button does one thing', () => {
  test('two quick taps on Check keep the feedback on the screen and count one answer; two on "Next problem" open the next problem unchecked', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const { problem } = subregisterProblem(1)
    const field = problem.fields[0]
    if (field === undefined) throw new Error('The problem has no field.')
    await openProblem(page, 'subregister-writes', 1)
    await fieldInput(page, field).fill('0x1')
    await expectSettled(checkButton(page))
    await doubleTap(page, checkButton(page))

    await expect(result(page)).toContainText('Not yet')
    // Longer than the guard: the second tap did nothing, and nothing comes after it.
    await page.waitForTimeout(800)
    await expect(card(page)).toHaveAttribute('data-problem-id', 'subregister-writes-1')
    await expect(result(page)).toContainText('Not yet')
    await expect(page.locator('[data-session-score]')).toHaveText('0 of 1 right')
    expect(await recentResults(page, 'subregister-writes')).toEqual([false])

    await expectSettled(nextButton(page))
    await doubleTap(page, nextButton(page))
    await expect(card(page)).not.toHaveAttribute('data-problem-id', 'subregister-writes-1')
    await page.waitForTimeout(800)
    await expect(card(page)).toHaveAttribute('data-checked', 'no')
    await expect(result(page)).toBeEmpty()
    await expect(page.locator('[data-session-score]')).toHaveText('0 of 1 right')
    expect(await recentResults(page, 'subregister-writes')).toEqual([false])
    expect(errors).toEqual([])
  })
})

/**
 * The element with the keyboard focus is in view, and not under the bar that sticks to the
 * bottom of the screen (a button of the bar itself is fine). WCAG 2.4.11: the focus must
 * not be hidden by content of the page.
 */
async function expectFocusClearOfTheBar(page: Page, what: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const focused = document.activeElement
          const bar = document.querySelector('[data-primary-bar]')
          if (!(focused instanceof HTMLElement) || focused === document.body) return 'no focus'
          if (bar === null || bar.contains(focused)) return 'clear'
          const box = focused.getBoundingClientRect()
          const sticky = getComputedStyle(bar).position === 'sticky'
          const limit = sticky ? bar.getBoundingClientRect().top : window.innerHeight
          return box.top >= 0 && box.bottom <= limit + 0.5
            ? 'clear'
            : `${focused.getAttribute('aria-label') ?? focused.tagName} at ${Math.round(box.top)}…${Math.round(box.bottom)}, bar at ${Math.round(limit)}`
        }),
      { message: what },
    )
    .toBe('clear')
}

/** The element is in view, and above the bar at the bottom of the screen. */
async function expectAboveTheBar(page: Page, target: Locator, what: string): Promise<void> {
  const bar = page.locator('[data-primary-bar]')
  await expect
    .poll(async () => {
      const [box, barBox] = await Promise.all([target.boundingBox(), bar.boundingBox()])
      if (box === null || barBox === null) return false
      return box.y >= 0 && box.y + box.height <= barBox.y
    }, `${what} must be in view above the bar`)
    .toBe(true)
}

test.describe('on a phone screen', () => {
  test.skip(({ isMobile }) => !isMobile, 'The phone layout is tested in the phone project.')

  test('the first field and its digit count are in view above the button bar when a problem opens', async ({
    page,
  }) => {
    const { problem } = subregisterProblem(1)
    const field = problem.fields[0]
    if (field === undefined) throw new Error('The problem has no field.')
    await openProblem(page, 'subregister-writes', 1)
    const bar = page.locator('[data-primary-bar]')
    await expect(bar).toHaveAttribute('data-primary-bar', 'sticky')
    // No "0 of 0 right" before the first Check.
    await expect(page.locator('[data-session-stats]')).toHaveCount(0)
    const [input, hint, barBox] = await Promise.all([
      fieldInput(page, field).boundingBox(),
      card(page).getByText('0 of 16 digits').boundingBox(),
      bar.boundingBox(),
    ])
    if (input === null || hint === null || barBox === null) throw new Error('Not on the screen.')
    expect(input.y + input.height, 'the field ends above the bar').toBeLessThanOrEqual(barBox.y)
    expect(hint.y + hint.height, 'the digit count ends above the bar').toBeLessThanOrEqual(barBox.y)
    // The lesson link moved under the problem.
    const lessons = page.locator('[data-lesson-links]').filter({ visible: true })
    await expect(lessons).toHaveCount(1)
    const lessonsBox = await lessons.boundingBox()
    const cardBox = await card(page).boundingBox()
    expect(lessonsBox?.y ?? 0).toBeGreaterThan((cardBox?.y ?? 0) + (cardBox?.height ?? 0) - 1)
  })

  test('a wrong answer brings the named mistake and "Show me" into view above the button bar', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    // One slip: the last `ret` (main's) leaves rsp alone; every other step is right.
    const problem = rspTrackerProblem(1)
    const answers = Object.fromEntries(
      problem.fields.map((field) => [field.id, field.expectedDisplay]),
    )
    const last = problem.fields.at(-1)
    const beforeLast = problem.fields.at(-2)
    if (last === undefined || beforeLast === undefined) throw new Error('Too few steps.')
    answers[last.id] = beforeLast.expectedDisplay
    await openProblem(page, 'rsp-tracker', 1)
    for (const field of problem.fields) await fieldInput(page, field).fill(answers[field.id] ?? '')
    await checkButton(page).click()
    const mistake = result(page).getByTestId('mistake')
    await expect(mistake).toHaveAttribute('data-mistake-code', 'call-ret-forgot-stack')
    await expectAboveTheBar(page, mistake, 'the named mistake')
    await expectAboveTheBar(page, showMeLink(page), 'Show me')
    await expectAboveTheBar(
      page,
      page.getByRole('button', { name: 'Step through it here' }),
      'Step through it here',
    )
    await expectNoSidewaysScroll(page)
  })

  test('when every step is wrong, the named mistake still comes first, and short values stay in a table', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const problem = rspTrackerProblem(1)
    const answers = wrongWayAnswers(problem)
    await openProblem(page, 'rsp-tracker', 1)
    for (const field of problem.fields) await fieldInput(page, field).fill(answers[field.id] ?? '')
    await checkButton(page).click()
    const mistake = result(page).getByTestId('mistake')
    await expect(mistake).toHaveAttribute('data-mistake-code', 'rsp-wrong-direction')
    // The feedback is taller than the screen: its top comes into view, the mistake first.
    await expectAboveTheBar(page, mistake, 'the named mistake')
    await expect(result(page).locator('[data-answer-table]')).toBeVisible()
    // One row per wrong step (going the wrong way, a step now and then lands on a right value).
    const wrong = problem.fields.filter(
      (field) => BigInt(answers[field.id] ?? '0') !== BigInt(`0x${field.expected}`),
    )
    expect(wrong.length).toBeGreaterThan(2)
    await expect(result(page).locator('[data-answer-table] tbody tr')).toHaveCount(wrong.length)
    await expectNoSidewaysScroll(page)
  })

  test('Tab never leaves the focus under the bar: practice fields, and every quiz question number', async ({
    page,
  }) => {
    // The browser review: Tab scrolled the next quiz question number just into view, under
    // the Back/Next bar, on 8 of the 15 questions.
    const errors = watchForErrors(page)
    // A practice problem with many fields (rsp after each step).
    const problem = rspTrackerProblem(1)
    await openProblem(page, 'rsp-tracker', 1)
    const first = problem.fields[0]
    if (first === undefined) throw new Error('No field.')
    await fieldInput(page, first).focus()
    await page.evaluate(() => window.scrollTo(0, 0))
    for (const field of problem.fields.slice(1)) {
      await page.keyboard.press('Tab')
      await expect(fieldInput(page, field)).toBeFocused()
      await expectFocusClearOfTheBar(page, `Tab to "${field.label}"`)
    }

    // The quiz: from the heading of a question, Tab through its fields, the question
    // numbers and the bar. On the last question the bar is taller (it names the blanks).
    const quiz = buildQuiz(2024)
    const withFields = quiz.find(
      (question) => question.problem.view === 'form' && question.problem.fields.length >= 5,
    )
    const pick = [withFields?.number ?? 2, 3, quiz.length]
    await page.goto('/#/practice/quiz?seed=2024')
    await page.getByRole('button', { name: 'Start the quiz' }).click()
    for (const number of pick) {
      await page.locator(`[data-quiz-go="${number}"]`).click()
      const heading = page.locator(`#quiz-question-${number}`)
      await expect(heading).toBeFocused()
      if (quiz[number - 1]?.problem.view === 'trace-table') continue
      for (let presses = 0; presses < 40; presses++) {
        await page.keyboard.press('Tab')
        const inBar = await page.evaluate(
          () => document.activeElement?.closest('[data-primary-bar]') !== null,
        )
        await expectFocusClearOfTheBar(page, `question ${number}, Tab ${presses + 1}`)
        if (inBar) break
      }
    }
    expect(errors).toEqual([])
  })

  test('a long code line scrolls inside its box, not the page: call and ret, and in the quiz', async ({
    page,
  }) => {
    // The final browser check: `lea eax, [r12+r12*2]` beside its address made the page
    // 16–25 px wider than a 360 px phone, and the end of the question was cut off.
    const errors = watchForErrors(page)
    /** The widest code row of a problem, in characters: the address plus the line. */
    const widest = (problem: Problem): number =>
      Math.max(
        0,
        ...problem.prompt.flatMap((block) =>
          block.type === 'code'
            ? block.lines.map(
                (line, index) => line.length + (block.addresses?.[index]?.length ?? 0),
              )
            : [],
        ),
      )
    const sizes = Array.from({ length: 300 }, (_, seed) => ({
      seed,
      size: widest(callRetProblem(seed)),
    }))
    sizes.sort((a, b) => b.size - a.size || a.seed - b.seed)
    const picked = sizes.slice(0, 3)
    const widestSize = picked[0]?.size ?? 0
    expect(widestSize, 'some problem has a long code row').toBeGreaterThanOrEqual(30)

    const expectCodeInsideTheCard = async (): Promise<void> => {
      const cardBox = await card(page).boundingBox()
      const listing = card(page).locator('[data-code-addresses] + div, [data-code-addresses] ~ div')
      const listingBox = await listing.first().boundingBox()
      if (cardBox === null || listingBox === null) throw new Error('No card or code box.')
      expect(listingBox.x + listingBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 0.5)
    }
    for (const { seed } of picked) {
      await openProblem(page, 'call-ret', seed)
      await expectNoSidewaysScroll(page)
      await expectCodeInsideTheCard()
    }

    // The same kind of problem as a quiz question.
    const quizSeed = firstSeed(buildQuiz, (quiz) =>
      quiz.some(
        (question) => question.topic === 'call-ret' && widest(question.problem) >= widestSize - 1,
      ),
    )
    const question = buildQuiz(quizSeed).find(
      (entry) => entry.topic === 'call-ret' && widest(entry.problem) >= widestSize - 1,
    )
    if (question === undefined) throw new Error('No quiz question found.')
    await page.goto(`/#/practice/quiz?seed=${quizSeed}`)
    await page.getByRole('button', { name: 'Start the quiz' }).click()
    await page.locator(`[data-quiz-go="${question.number}"]`).click()
    await expect(page.locator(`#quiz-question-${question.number}`)).toBeFocused()
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('the long "needs a size" answer with its "Right answer" mark stays inside the card, also in the quiz results', async ({
    page,
  }) => {
    // The final browser check: "(byte/word/dword/qword ptr)" could not break, so with the
    // "Right answer" mark beside it the answer box was wider than the card on a 360 px
    // phone, and the quiz results scrolled sideways.
    const errors = watchForErrors(page)
    const needsSize = (problem: Problem): boolean =>
      problem.fields.some(
        (field) => field.kind.type === 'choice' && field.expected === 'missing-size',
      )
    const answerBoxes = (scope: Locator): Locator => scope.locator('label:has(input[type=radio])')
    const expectBoxesInside = async (scope: Locator, container: Locator): Promise<void> => {
      const outer = await container.boundingBox()
      if (outer === null) throw new Error('No container.')
      const rights = await answerBoxes(scope).evaluateAll((labels) =>
        labels.map((label) => label.getBoundingClientRect().right),
      )
      expect(rights.length).toBeGreaterThan(1)
      for (const right of rights) expect(right).toBeLessThanOrEqual(outer.x + outer.width + 0.5)
    }

    // A practice problem whose right answer is this one, answered wrong so it gets the mark.
    const seed = firstSeed(movLegalityProblem, needsSize)
    await openProblem(page, 'mov-legality', seed)
    await page.getByLabel('Legal', { exact: true }).check()
    await checkButton(page).click()
    await expect(result(page)).toBeVisible()
    await expect(answerBoxes(card(page)).getByText('Right answer')).toBeVisible()
    await expectBoxesInside(card(page), card(page))
    await expectNoSidewaysScroll(page)

    // The same answer in the quiz results: the question left blank, then opened.
    const quizSeed = firstSeed(buildQuiz, (quiz) =>
      quiz.some((question) => needsSize(question.problem)),
    )
    const question = buildQuiz(quizSeed).find((entry) => needsSize(entry.problem))
    if (question === undefined) throw new Error('No quiz question found.')
    await page.goto(`/#/practice/quiz?seed=${quizSeed}`)
    await page.getByRole('button', { name: 'Start the quiz' }).click()
    await page.locator(`[data-quiz-go="${QUIZ_LENGTH}"]`).click()
    await page.getByRole('button', { name: 'Finish the quiz' }).click()
    const item = page.locator(`[data-quiz-review] > li[data-question="${question.number}"]`)
    await item.locator('summary').first().click()
    await item.getByText('See the question', { exact: true }).click()
    await expect(answerBoxes(item).getByText('Right answer')).toBeVisible()
    await expectBoxesInside(item, item)
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('code without an address column wraps on a phone, so every line can be read whole', async ({
    page,
  }) => {
    // The live-site check: at 360 px `mov dword ptr -8[rbp], 0x100000000` showed as
    // `…, 0x10`, and the size comments of "Where is rip?" problems were past the edge.
    const errors = watchForErrors(page)
    const longestLine = (problem: Problem): number =>
      Math.max(
        0,
        ...problem.prompt.flatMap((block) =>
          block.type === 'code' && (block.addresses ?? []).length === 0
            ? block.lines.map((line) => line.length)
            : [],
        ),
      )
    const topics = [
      ['mov-legality', movLegalityProblem],
      ['rip', ripProblem],
    ] as const
    for (const [topic, make] of topics) {
      let widest = { seed: 0, size: 0 }
      for (let seed = 0; seed < 300; seed++) {
        const size = longestLine(make(seed))
        if (size > widest.size) widest = { seed, size }
      }
      // About 32 characters fit in the box at 360 px.
      expect(widest.size, `${topic}: a line longer than the box`).toBeGreaterThan(36)
      await openProblem(page, topic, widest.seed)
      const listing = card(page).locator('[data-code-listing]').first()
      await expect(listing.locator('[data-code-wrap]')).toHaveCount(1)
      const view = await listing.evaluate((box) => {
        const right = box.getBoundingClientRect().right
        const cut = [...box.querySelectorAll('code')].filter(
          (code) => code.getBoundingClientRect().right > right + 0.5,
        )
        return { scrollsSideways: box.scrollWidth > box.clientWidth + 1, cut: cut.length }
      })
      expect(view, `${topic} seed ${widest.seed}`).toEqual({ scrollsSideways: false, cut: 0 })
      await expectNoSidewaysScroll(page)
    }
    expect(errors).toEqual([])
  })

  test('with the tutor on, the end of a practice page scrolls clear of the tutor button', async ({
    page,
  }) => {
    // The browser review: at the end of the weak-spots page the round tutor button lay on
    // a corner of "Check".
    const errors = watchForErrors(page)
    await page.route('**/api/tutor', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ enabled: true }),
          })
        : route.abort(),
    )
    const pages = [
      { address: '/#/practice/weak', problem: '[data-practice-card]' },
      {
        address: '/#/practice/register-names?seed=3',
        problem: '[data-practice-card][data-problem-id="register-names-3"]',
      },
    ]
    for (const { address, problem } of pages) {
      await page.goto(address)
      // From one practice page to the next only the hash changes: the new page comes a
      // moment later and starts at its top. So wait for its problem, and scroll to the end
      // before every measurement (a scroll made too early would measure the top).
      await expect(page.locator(problem)).toBeVisible()
      const launcher = page.locator('[data-tutor="button"]')
      await expect(launcher).toBeVisible()
      await expect
        .poll(() =>
          page.evaluate(() => {
            window.scrollTo(0, document.documentElement.scrollHeight)
            const button = document.querySelector('[data-tutor="button"]')
            if (button === null) return ['no tutor button']
            const tutor = button.getBoundingClientRect()
            const targets = document.querySelectorAll<HTMLElement>(
              '[data-practice-card] :is(button, a, input), [data-lesson-links] a',
            )
            return [...targets]
              .filter((target) => {
                const box = target.getBoundingClientRect()
                if (box.width === 0 || box.height === 0) return false
                const across = Math.min(box.right, tutor.right) - Math.max(box.left, tutor.left)
                const down = Math.min(box.bottom, tutor.bottom) - Math.max(box.top, tutor.top)
                return across > 0 && down > 0
              })
              .map((target) => target.textContent?.trim() ?? target.tagName)
          }),
        )
        .toEqual([])
      await expectNoSidewaysScroll(page)
    }
    expect(errors).toEqual([])
  })
})

test.describe('on a wide screen', () => {
  test.skip(({ isMobile }) => isMobile, 'The wide layout is tested in the desktop project.')

  test('after Check with the keyboard, "Next problem" (which has the focus) is in view with the feedback', async ({
    page,
  }) => {
    // The browser review: in the trace table the page scrolled to the feedback and left the
    // focused button below the screen (y 817–861 in an 800 px window).
    const errors = watchForErrors(page)
    for (const [topic, seed] of [
      ['homework-table', 2],
      ['subregister-writes', 7],
    ] as const) {
      await openProblem(page, topic, seed)
      await expectSettled(checkButton(page))
      await checkButton(page).focus()
      await page.keyboard.press('Enter')
      await expect(result(page)).toContainText('Not yet')
      await expect(nextButton(page)).toBeFocused()
      // Both in view: the feedback (its top) and the focused button.
      await expect(nextButton(page)).toBeInViewport({ ratio: 1 })
      await expect(result(page).getByTestId('mistake')).toBeInViewport()
    }
    // The table of a trace-table problem stays where it is: the feedback is under it.
    expect(homeworkTableProblem(2).view).toBe('trace-table')
    expect(errors).toEqual([])
  })
})

/* ──────────────────────────────── the hub ──────────────────────────────── */

test('the hub shows the accuracy of each topic, and it updates', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/#/practice')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Practice')
  await expect(page.locator('[data-topic-card]')).toHaveCount(TOPICS.length)
  const topicCard = page.locator('[data-topic-card="subregister-writes"]')
  await expect(topicCard).toContainText('Not tried yet')
  await expectNoSidewaysScroll(page)

  const { problem } = subregisterProblem(7)
  await openProblem(page, 'subregister-writes', 7)
  await answerRight(page, problem)
  await checkButton(page).click()
  await expect(result(page)).toContainText('Correct')

  await page.goto('/#/practice')
  await expect(topicCard.locator('[data-topic-accuracy]')).toHaveText(
    'Recent accuracy: 100% (1 right of 1 answer)',
  )

  await openProblem(page, 'subregister-writes', 8)
  await checkButton(page).click()
  await expect(result(page)).toContainText('Not yet')
  await page.goto('/#/practice')
  await expect(topicCard.locator('[data-topic-accuracy]')).toHaveText(
    'Recent accuracy: 50% (1 right of your last 2)',
  )

  // The card's link opens the topic.
  await topicCard.getByRole('link', { name: `Practice: ${titleOf('subregister-writes')}` }).click()
  await expect(page).toHaveURL(/#\/practice\/subregister-writes\?seed=\d+$/)
  await expect(card(page)).toBeVisible()
  expect(errors).toEqual([])
})

test('the hub does not download the problem makers or the emulator', async ({ page }) => {
  // The hub shows the weak-spots mix and the quiz length only. (The code review: it used
  // to download every generator and the whole emulator, about 76 kB gzip, for that.)
  const errors = watchForErrors(page)
  const loaded: string[] = []
  page.on('request', (request) => loaded.push(new URL(request.url()).pathname))
  await page.goto('/#/practice')
  await expect(page.locator('[data-quiz-card]')).toBeVisible()
  await expect(page.locator('[data-weak-spots-card] li')).toHaveCount(3)
  await page.waitForLoadState('networkidle')
  // Dev server: one file per module. Built site: the chunks named after them.
  const heavy = loaded.filter((path) =>
    /\/src\/emulator\/|\/src\/features\/practice\/(session|generators\/|gen\/)|\/assets\/(session|emulator)-/.test(
      path,
    ),
  )
  expect(loaded.length).toBeGreaterThan(0)
  expect(heavy).toEqual([])
  expect(errors).toEqual([])
})

test('when the browser blocks storage, the hub says so in the same words as the other pages', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await blockStorage(page)
  await page.goto('/#/practice')
  const note = page.locator('[data-no-storage]')
  await expect(note).toContainText('Not saved')
  await expect(note).toContainText(
    'This browser does not let Stack Step save your progress. It is kept only until you close or reload this page.',
  )
  await expect(page.locator('[data-topic-card]')).toHaveCount(TOPICS.length)
  expect(errors).toEqual([])
})

test('an answer field stops typing at the longest answer it takes', async ({ page }) => {
  const errors = watchForErrors(page)
  const { problem } = subregisterProblem(7)
  const field = problem.fields[0]
  if (field === undefined) throw new Error('The problem has no field.')
  await openProblem(page, 'subregister-writes', 7)
  const input = fieldInput(page, field)
  await input.click()
  await page.keyboard.type('1'.repeat(MAX_ANSWER_LENGTH + 10))
  await expect(input).toHaveValue('1'.repeat(MAX_ANSWER_LENGTH))
  expect(errors).toEqual([])
})

/* ──────────────────────────────── the quiz ──────────────────────────────── */

test('the mixed quiz: answer some, skip some, finish, see the score and what to review', async ({
  page,
}) => {
  test.slow()
  const errors = watchForErrors(page)
  const QUIZ_SEED = 2024
  const quiz = buildQuiz(QUIZ_SEED)
  expect(quiz.length).toBe(15)

  await page.goto(`/#/practice/quiz?seed=${QUIZ_SEED}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mixed quiz')
  // 8 topics, one of them the trace table: 1 + 2 × 7 = 15 (not "two from each topic").
  await expect(page.locator('[data-quiz-mix]')).toHaveText(
    '15 questions: one trace table, and two from each of the other 7 topics. They come in a mixed order.',
  )
  await page.getByRole('button', { name: 'Start the quiz' }).click()

  const right = new Set<number>()
  let wrongQuestion: number | null = null
  for (const question of quiz) {
    const screen = page.locator(`[data-quiz-question="${question.number}"]`)
    await expect(screen).toHaveAttribute('data-problem-id', question.problem.id)
    await expect(page.locator('[data-quiz-position]')).toHaveText(
      `Question ${question.number} of ${quiz.length}`,
    )
    const form = question.problem.view === 'form'
    if (form && right.size < 3) {
      await answerRight(page, question.problem)
      right.add(question.number)
    } else if (form && wrongQuestion === null) {
      // A wrong answer: something typed that is not right.
      const field = question.problem.fields[0]
      if (field !== undefined && field.kind.type !== 'choice') {
        await fieldInput(page, field).fill(field.kind.type === 'hex' ? '0x1' : 'zz')
        wrongQuestion = question.number
      }
    }
    // No right or wrong during the quiz.
    await expect(page.locator('[data-field-mark]')).toHaveCount(0)
    await expect(page.getByTestId('result')).toHaveCount(0)

    if (question.number === 1) {
      // Back keeps the answers.
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByRole('button', { name: 'Back' }).click()
      await expect(screen).toBeVisible()
      const first = question.problem.fields[0]
      if (form && first !== undefined && first.kind.type !== 'choice') {
        await expect(fieldInput(page, first)).toHaveValue(first.expectedDisplay)
      }
    }
    if (question.number === 8) await expectNoSidewaysScroll(page)

    if (question.number === quiz.length) {
      const blanks = quiz.length - right.size - (wrongQuestion === null ? 0 : 1)
      await expect(page.locator('[data-quiz-blanks]')).toContainText(`${blanks} questions`)
      await page.getByRole('button', { name: 'Finish the quiz' }).click()
    } else {
      await page.getByRole('button', { name: 'Next', exact: true }).click()
    }
  }

  // The score, and every question with its answers.
  await expect(page.locator('[data-quiz-score]')).toHaveText(`${right.size} of ${quiz.length}`)
  const review = page.locator('[data-quiz-review] > li')
  await expect(review).toHaveCount(quiz.length)
  for (const question of quiz) {
    const item = page.locator(`[data-quiz-review] > li[data-question="${question.number}"]`)
    await expect(item).toHaveAttribute('data-correct', right.has(question.number) ? 'yes' : 'no')
    await expect(item).toContainText(plain(question.problem.reason))
  }
  if (wrongQuestion !== null) {
    const item = page.locator(`[data-quiz-review] > li[data-question="${wrongQuestion}"]`)
    await expect(item).toContainText('Wrong')
    const wrongProblem = quiz[wrongQuestion - 1]?.problem
    const href = await item.getByRole('link', { name: /^Show me/ }).getAttribute('href')
    expect(payloadOf(href ?? '')).toEqual(wrongProblem?.stepper)
  }
  const blankItem = page.locator('[data-quiz-review] > li[data-correct="no"]').last()
  await expect(blankItem).toContainText('You left this question blank.')

  // A wrong answer is open; a right one and a blank one are one closed line. The switch
  // hides the right ones.
  for (const question of quiz) {
    const details = page.locator(
      `[data-quiz-review] > li[data-question="${question.number}"] details`,
    )
    if (question.number === wrongQuestion) await expect(details.first()).toHaveAttribute('open', '')
    else await expect(details.first()).not.toHaveAttribute('open')
  }
  const onlyWrong = page.getByRole('checkbox', { name: 'Show only wrong answers' })
  await onlyWrong.check()
  await expect(review).toHaveCount(quiz.length - right.size)
  await onlyWrong.uncheck()
  await expect(review).toHaveCount(quiz.length)

  // Topics to review: every topic with at least one wrong (or blank) answer.
  const missed = new Set(quiz.filter((q) => !right.has(q.number)).map((q) => q.topic))
  await expect(page.locator('[data-review-topic]')).toHaveCount(missed.size)
  const firstTopic = page.locator('[data-review-topic]').first()
  const topicId = (await firstTopic.getAttribute('data-review-topic')) as TopicId
  await expect(
    firstTopic.getByRole('link', { name: `Practice: ${titleOf(topicId)}` }),
  ).toHaveAttribute('href', `#/practice/${topicId}`)
  await expect(firstTopic.getByRole('link', { name: /^Lesson \d+:/ }).first()).toBeVisible()
  await expectNoSidewaysScroll(page)

  // Saved: the hub shows the result.
  await page.goto('/#/practice')
  await expect(page.locator('[data-quiz-card]')).toContainText(
    `Your last quiz: ${right.size} of ${quiz.length}`,
  )
  expect(errors).toEqual([])
})

test('the quiz keeps its answers through a reload and a visit to another page, and the map jumps to any question', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  // A quiz whose first two questions are typed answers.
  const typed = (question: { problem: Problem } | undefined) =>
    question?.problem.view === 'form' &&
    question.problem.fields.every((field) => field.kind.type !== 'choice')
  const seed = firstSeed(buildQuiz, (quiz) => typed(quiz[0]) && typed(quiz[1]))
  const [first, second] = buildQuiz(seed)
  const firstField = first?.problem.fields[0]
  const secondField = second?.problem.fields[0]
  if (first === undefined || firstField === undefined || secondField === undefined) {
    throw new Error('No such quiz.')
  }

  await page.goto(`/#/practice/quiz?seed=${seed}`)
  await page.getByRole('button', { name: 'Start the quiz' }).click()
  await answerRight(page, first.problem)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.locator('[data-quiz-question="2"]')).toBeVisible()
  const slip = secondField.kind.type === 'hex' ? '0x1' : 'zz'
  await fieldInput(page, secondField).fill(slip)
  // The map says which questions have an answer: in words and with a shape.
  const go = (number: number) => page.locator(`[data-quiz-go="${number}"]`)
  await expect(go(1)).toHaveAccessibleName('Question 1: answered')
  await expect(go(2)).toHaveAttribute('data-answered', 'yes')
  await expect(go(2)).toHaveAttribute('aria-current', 'step')
  await expect(go(3)).toHaveAccessibleName('Question 3: no answer yet')

  // A reload comes back to the same question, with the answers.
  await page.reload()
  await expect(page.locator('[data-quiz-question="2"]')).toBeVisible()
  await expect(page.getByText('You came back to the quiz you started.')).toBeVisible()
  await expect(fieldInput(page, secondField)).toHaveValue(slip)
  await go(1).click()
  await expect(page.locator('[data-quiz-question="1"]')).toBeVisible()
  await expect(fieldInput(page, firstField)).toHaveValue(firstField.expectedDisplay)

  // So does a visit to another page.
  await page.goto('/#/practice')
  await page.goto('/#/practice/quiz')
  await expect(page.locator('[data-quiz-question="1"]')).toBeVisible()
  await expect(fieldInput(page, firstField)).toHaveValue(firstField.expectedDisplay)

  // The last question names the questions that have no answer.
  await go(15).click()
  await expect(page.locator('[data-quiz-blanks]')).toContainText(
    'questions 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14 and 15',
  )
  await expectNoSidewaysScroll(page)
  expect(errors).toEqual([])
})

test('the quiz: a double tap on Next does not finish the quiz with the last question unseen', async ({
  page,
}) => {
  const errors = watchForErrors(page)
  await page.goto('/#/practice/quiz?seed=2024')
  await page.getByRole('button', { name: 'Start the quiz' }).click()
  await page.locator('[data-quiz-go="14"]').click()
  await expect(page.locator('[data-quiz-question="14"]')).toBeVisible()
  const next = page.getByRole('button', { name: 'Next', exact: true })
  await expectSettled(next)
  await doubleTap(page, next)
  await expect(page.locator('[data-quiz-question="15"]')).toBeVisible()
  await page.waitForTimeout(800)
  await expect(page.locator('[data-quiz-page]')).toHaveAttribute('data-quiz-page', 'running')
  await expect(page.getByRole('button', { name: 'Finish the quiz' })).toBeVisible()
  expect(errors).toEqual([])
})

/* ──────────────────────────────── weak spots ──────────────────────────────── */

test.describe('practice my weak spots', () => {
  test('works without any history: it starts with the first topics', async ({ page }) => {
    const errors = watchForErrors(page)
    const rotation = weakRotation(emptyProgress())
    const [first, second] = rotation
    if (first === undefined || second === undefined) throw new Error('Too few topics are ready.')

    await page.goto('/#/practice/weak')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Practice my weak spots')
    await expect(page.getByText('You have no practice results yet')).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Topics in this mix' }).getByRole('listitem'),
    ).toHaveText(rotation.map(titleOf))
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
      new RegExp(`Problem 1: ${titleOf(first)}`, 'i'),
    )
    await expect(page).toHaveURL(new RegExp(`topic=${first}&seed=\\d+$`))
    await expect(card(page)).toHaveAttribute('data-problem-id', new RegExp(`^${first}-\\d+$`))

    // The topics take turns.
    await checkButton(page).click()
    await nextButton(page).click()
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
      new RegExp(`Problem 2: ${titleOf(second)}`, 'i'),
    )
    expect(errors).toEqual([])
  })

  test('with history: the weakest topic comes first', async ({ page }) => {
    const errors = watchForErrors(page)
    const progress: ProgressData = {
      ...emptyProgress(),
      practice: {
        'register-names': { right: 5, wrong: 0, recent: [true, true, true, true, true] },
        'subregister-writes': { right: 1, wrong: 3, recent: [false, true, false, false] },
      },
    }
    const rotation = weakRotation(progress)
    expect(rotation[0]).toBe('subregister-writes')
    await page.addInitScript(
      ([key, value]) => {
        if (sessionStorage.getItem('seeded') !== null) return
        sessionStorage.setItem('seeded', '1')
        localStorage.setItem(key, value)
      },
      [PROGRESS_KEY, JSON.stringify(progress)] as const,
    )

    await page.goto('/#/practice/weak')
    await expect(
      page.getByText(`This mix uses ${weakMixWords(progress, rotation)}.`, { exact: false }),
    ).toBeVisible()
    await expect(
      page.getByRole('list', { name: 'Topics in this mix' }).getByRole('listitem'),
    ).toHaveText(rotation.map(titleOf))
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
      new RegExp(`Problem 1: ${titleOf('subregister-writes')}`, 'i'),
    )
    // The hub offers the same mix.
    await page.goto('/#/practice')
    await expect(page.locator('[data-weak-spots-card] li')).toHaveText(rotation.map(titleOf))
    expect(errors).toEqual([])
  })

  test('a topic with only right answers is never called a weak spot (2 of 2 right)', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    // The browser review: after 2 of 2 right, the hub called this topic the weakest, next to
    // its own card saying 100%.
    const progress: ProgressData = {
      ...emptyProgress(),
      practice: { 'subregister-writes': { right: 2, wrong: 0, recent: [true, true] } },
    }
    const rotation = weakRotation(progress)
    expect(rotation).not.toContain('subregister-writes')
    await page.addInitScript(
      ([key, value]) => {
        if (sessionStorage.getItem('seeded') !== null) return
        sessionStorage.setItem('seeded', '1')
        localStorage.setItem(key, value)
      },
      [PROGRESS_KEY, JSON.stringify(progress)] as const,
    )

    await page.goto('/#/practice')
    await expect(
      page.locator('[data-topic-card="subregister-writes"] [data-topic-accuracy]'),
    ).toHaveText('Recent accuracy: 100% (2 right of your last 2)')
    const mix = page.locator('[data-weak-spots-card]')
    await expect(mix.locator('[data-weak-spots-words]')).toHaveText(
      'Problems from topics you have not tried yet, taking turns:',
    )
    await expect(mix.locator('li')).toHaveText(rotation.map(titleOf))

    await page.goto('/#/practice/weak')
    await expect(page.getByText('This mix uses topics you have not tried yet.')).toBeVisible()
    await expect(card(page).getByRole('heading', { level: 2 })).toHaveText(
      new RegExp(`Problem 1: ${titleOf(rotation[0] ?? 'register-names')}`, 'i'),
    )
    expect(errors).toEqual([])
  })
})

/* ─────────────────────────────── unknown topic ─────────────────────────────── */

test('an unknown topic id shows a friendly page with a link to the hub', async ({ page }) => {
  const errors = watchForErrors(page)
  await page.goto('/#/practice/not-a-topic')
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'This practice topic does not exist',
  )
  await expect(page).toHaveTitle('No such practice topic · Stack Step')
  await expect(page.getByText('“not-a-topic”', { exact: false })).toBeVisible()
  await expect(page.getByRole('link', { name: 'See all practice topics' })).toHaveAttribute(
    'href',
    '#/practice',
  )
  await expectNoSidewaysScroll(page)
  expect(errors).toEqual([])
})

/* ──────────────────────────────── keyboard only ──────────────────────────────── */

test('works with the keyboard only', async ({ page }) => {
  const errors = watchForErrors(page)
  const { problem } = subregisterProblem(7)
  const field = problem.fields[0]
  if (field === undefined) throw new Error('The problem has no field.')

  // Type, Enter checks; Enter again goes to "Next problem"; Enter opens the next problem
  // with the focus in its first field.
  await openProblem(page, 'subregister-writes', 7)
  await tabTo(page, fieldInput(page, field))
  await page.keyboard.type(field.expectedDisplay)
  await page.keyboard.press('Enter')
  await expect(result(page)).toContainText('Correct')
  await expect(fieldInput(page, field)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(nextButton(page)).toBeFocused()
  // Right after Check the button ignores presses for a moment (against double taps).
  await expectSettled(nextButton(page))
  await page.keyboard.press('Enter')
  await expect(card(page)).not.toHaveAttribute('data-problem-id', 'subregister-writes-7')
  await expect(card(page).locator('[data-answer-input]').first()).toBeFocused()

  // Enter moves from field to field; then Tab reaches "Show me" and the inline stepper.
  const seed = firstSeed(registerNamesProblem, ({ problem: made }) => made.fields.length === 2)
  const named = registerNamesProblem(seed).problem
  const [first, second] = named.fields
  if (first === undefined || second === undefined) throw new Error('No two-part question.')
  await openProblem(page, 'register-names', seed)
  await tabTo(page, fieldInput(page, first))
  await page.keyboard.type(first.expectedDisplay)
  await page.keyboard.press('Enter')
  await expect(fieldInput(page, second)).toBeFocused()
  await page.keyboard.type('3')
  await page.keyboard.press('Enter')
  await expect(result(page)).toContainText('Not yet')
  await page.keyboard.press('Tab')
  await expect(showMeLink(page)).toBeFocused()
  await page.keyboard.press('Tab')
  const toggle = page.getByRole('button', { name: 'Step through it here' })
  await expect(toggle).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('[data-ministepper]')).toBeVisible()
  await expectNoSidewaysScroll(page)
  expect(errors).toEqual([])
})
