/// <reference lib="dom" />
/**
 * Accessibility, checked by axe-core in a real browser: every route of the site in the
 * light and in the dark theme, in both Playwright projects (desktop 1280×800, phone
 * 360×740), and the states a student sees most: the stepper in the middle of a run, the
 * stepper waiting for input, a practice problem checked wrong, a quiz question, the
 * progress page with a history, and the tutor's drawer.
 *
 *   E2E_DEV=1 E2E_PORT=5272 npx playwright test e2e/a11y.spec.ts
 *
 * The rules are those of WCAG 2.1 levels A and AA (axe tags wcag2a, wcag2aa, wcag21a,
 * wcag21aa), and every one of them must pass: nothing is switched off. If a rule ever has
 * to be switched off for one element, do it with `.exclude()` on that element only, and
 * say why in a comment next to it.
 *
 * Animations are switched off (reduced motion): a value that just changed fades its
 * background for one second, and a check in the middle of the fade would measure a colour
 * that nobody reads.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import {
  control,
  expectStatus,
  openStepper,
  pressStep,
  setRunSpeed,
  watchForErrors,
} from './helpers'

const WCAG_21_A_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const DARK = /(^|\s)dark(\s|$)/

/** The page of the address bar is on screen, with its parts that load later. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('main#main:not([aria-busy])')).toHaveCount(1)
  await expect(page.locator('h1')).toHaveCount(1)
  await page.waitForLoadState('networkidle')
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`/#${path}`)
  await settle(page)
}

/** Run axe on the whole page and expect no WCAG 2.1 A/AA violation at all. */
async function expectNoViolations(page: Page, what: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_21_A_AA).analyze()
  const found = results.violations.map((violation) => {
    const nodes = violation.nodes.slice(0, 6).map((node) => {
      const why = (node.failureSummary ?? '').split('\n').slice(1).join(' ').trim()
      return `    ${node.target.join(' ')}${why === '' ? '' : `: ${why}`}`
    })
    const more = violation.nodes.length > 6 ? `\n    … and ${violation.nodes.length - 6} more` : ''
    return `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n${nodes.join('\n')}${more}`
  })
  expect(found, `${what}: axe found WCAG 2.1 A/AA problems`).toEqual([])
}

/** Every pattern of the route table as a real address, and the "not found" pages. */
const ROUTES = [
  '/',
  '/stepper',
  '/learn',
  '/learn/registers-and-memory',
  '/learn/call-and-ret',
  '/practice',
  '/practice/register-names',
  '/practice/homework-table',
  '/practice/weak',
  '/practice/quiz',
  '/cheatsheet',
  '/progress',
  '/about',
  '/nope',
  '/learn/not-a-lesson',
  '/practice/not-a-topic',
] as const

/** A student who has done some of everything, for the full progress page. */
const SOME_PROGRESS = {
  version: 1,
  lessonsDone: {
    'registers-and-memory': '2026-11-02T10:00:00.000Z',
    mov: '2026-11-06T10:00:00.000Z',
  },
  practice: {
    'register-names': { right: 9, wrong: 1, recent: [true, true, true, false, true] },
    rip: { right: 1, wrong: 3, recent: [false, true, false, false] },
  },
  quizzes: [{ score: 9, total: 15, date: '2026-11-10T09:00:00.000Z', weakTopics: ['rip'] }],
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme, reducedMotion: 'reduce' })

    test.beforeEach(async ({ page }) => {
      // The site starts in the theme of the device when nothing is saved.
      await page.addInitScript(() => {
        try {
          window.localStorage.removeItem('stackstep:theme')
        } catch {
          // Storage is blocked: the device theme decides anyway.
        }
      })
    })

    for (const route of ROUTES) {
      test(`${route} has no WCAG 2.1 A/AA problem`, async ({ page }) => {
        const errors = watchForErrors(page)
        if (route === '/stepper') {
          // The editor is downloaded after the page: wait for it too.
          await openStepper(page)
          await settle(page)
        } else {
          await open(page, route)
        }
        if (theme === 'dark') await expect(page.locator('html')).toHaveClass(DARK)
        else await expect(page.locator('html')).not.toHaveClass(DARK)
        await expectNoViolations(page, route)
        expect(errors).toEqual([])
      })
    }

    test('the stepper in the middle of a run', async ({ page }) => {
      await openStepper(page, '?example=factorial')
      await pressStep(page, 6)
      await expectStatus(page, 'paused')
      await expectNoViolations(page, 'factorial after 6 steps')
      // On a phone the stack and the output are tabs of their own.
      for (const tab of ['Stack', 'Output'] as const) {
        const button = page
          .locator('[data-stepper-page]')
          .getByRole('tab', { name: new RegExp(`^${tab}`) })
        if ((await button.count()) === 0 || !(await button.isVisible())) continue
        await button.click()
        await expectNoViolations(page, `factorial after 6 steps, ${tab} tab`)
      }
    })

    test('the stepper inside a library call, and at the end of the program', async ({ page }) => {
      await openStepper(page, '?example=hello-world')
      // push, mov, lea, mov, call: after 5 steps the next step runs inside printf.
      await pressStep(page, 5)
      await expectStatus(page, 'paused')
      await expectNoViolations(page, 'hello world inside printf')
      await setRunSpeed(page, 10)
      await control(page, 'Run').click()
      await expectStatus(page, 'ended')
      await expectNoViolations(page, 'hello world at the end')
    })

    test('the stepper waiting for input', async ({ page }) => {
      await openStepper(page, '?example=read-number')
      await setRunSpeed(page, 10)
      await control(page, 'Run').click()
      await expectStatus(page, 'waiting')
      await expectNoViolations(page, 'read a number, waiting for input')
    })

    test('a practice problem checked wrong', async ({ page }) => {
      await open(page, '/practice/subregister-writes?seed=3')
      const card = page.locator('[data-practice-card]')
      await expect(card).toBeVisible()
      for (const field of await card.getByRole('textbox').all()) await field.fill('0x1')
      await page.getByRole('button', { name: 'Check', exact: true }).click()
      await expect(page.getByTestId('result')).toContainText('Not yet')
      await expectNoViolations(page, 'a practice problem checked wrong')
    })

    test('a quiz question', async ({ page }) => {
      await open(page, '/practice/quiz?seed=2024')
      await page.getByRole('button', { name: 'Start the quiz' }).click()
      await expect(page.locator('#quiz-question-1')).toBeVisible()
      await expectNoViolations(page, 'quiz question 1')
    })

    test('the progress page with a history, and its reset dialog', async ({ page }) => {
      await page.addInitScript((value) => {
        window.localStorage.setItem('stackstep:progress:v1', value)
      }, JSON.stringify(SOME_PROGRESS))
      await open(page, '/progress')
      await expect(page.getByRole('region', { name: 'Mixed quizzes' })).toBeVisible()
      await expectNoViolations(page, 'progress with a history')
      await page.getByRole('button', { name: 'Reset my progress', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Reset your progress?' })).toBeVisible()
      await expectNoViolations(page, 'the reset dialog')
    })

    test('the tutor button and its open drawer on the stepper', async ({ page }) => {
      await page.route('**/api/tutor', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ enabled: true }),
            })
          : route.fulfill({ status: 200, contentType: 'text/plain', body: 'Look at line 4.' }),
      )
      await openStepper(page)
      const button = page.getByRole('button', { name: 'Ask the tutor' })
      await expect(button).toBeVisible()
      await expectNoViolations(page, 'the stepper with the tutor button')
      await button.click()
      const drawer = page.getByRole('dialog', { name: 'Tutor' })
      await expect(drawer).toBeVisible()
      await drawer.getByLabel('Your question').fill('Why did rsp change?')
      await drawer.getByRole('button', { name: 'Send' }).click()
      await expect(drawer).toContainText('Look at line 4.')
      await expectNoViolations(page, 'the tutor drawer with a reply')
    })
  })
}
