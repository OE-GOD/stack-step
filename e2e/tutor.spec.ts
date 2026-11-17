/// <reference lib="dom" />
/**
 * The optional AI tutor, tested in a real browser.
 *
 * No test here talks to the real tutor function or to the Anthropic API: every request
 * to /api/tutor is answered by a Playwright route mock (see `mockTutor`).
 *
 * Two groups:
 *
 * 1. "the real site": the tutor is off by default. With no function (404) and with
 *    `enabled: false`, no page shows a tutor button and nothing moves. These run in dev
 *    and in production mode.
 * 2. "the drawer, on its harness page": the button, the drawer, sending, the streamed
 *    reply, errors, the keyboard, the phone. The harness
 *    (src/features/tutor/demo.html) is a developer page that only the dev server
 *    serves, so these need E2E_DEV=1:
 *
 *      E2E_DEV=1 E2E_PORT=5214 npx playwright test e2e/tutor.spec.ts
 *
 * Both Playwright projects run them (desktop 1280×800, phone 360×740).
 *
 * The screenshots in docs/screenshots/m7 come from the last group of this file:
 *
 *      E2E_DEV=1 E2E_PORT=5214 TUTOR_SHOTS=1 npx playwright test e2e/tutor.spec.ts -g screenshots
 *
 * To add a test for a real page once it mounts the tutor (for example "the POST body
 * holds the code of the editor"): use `mockTutor(page, 'on', replyWith('…'))`, open the
 * page, `openDrawer`, `ask`, and look at `mock.posts`.
 *
 * The first line gives this file the browser types (`document`, `window`) for the
 * callbacks that run inside the page.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test as base, type Locator, type Page, type Route } from '@playwright/test'
import { expectNoSidewaysScroll, watchForErrors } from './helpers'

const DEV = process.env.E2E_DEV === '1'
const HARNESS = '/src/features/tutor/demo.html'
const TUTOR_ADDRESS = '**/api/tutor'

/* ───────────────────────────── What the page sends ───────────────────────────── */

interface TutorContext {
  page: string
  code: string
  machine: string
  problem: string | null
}

interface PostBody {
  messages: { role: string; content: string }[]
  context: TutorContext
}

interface HarnessWindow {
  __tutorHarness?: { context: TutorContext }
  __injected?: boolean
}

/* ───────────────────────────── Mocking /api/tutor ───────────────────────────── */

/**
 * What "GET /api/tutor" answers:
 * - on:      { "enabled": true }
 * - off:     { "enabled": false }   (the function is there, no key is set)
 * - missing: 404                    (a static host without the function)
 * - page:    200 with an HTML page  (a static host that answers every address with index.html)
 * - broken:  500
 */
type Availability = 'on' | 'off' | 'missing' | 'page' | 'broken'

/** Answers one question. `index` counts the questions of this page, from 0. */
type PostAnswer = (route: Route, body: PostBody, index: number) => Promise<void>

interface TutorMock {
  /** How often the page asked if the tutor is on. */
  gets: () => number
  /** The body of every question the page sent, oldest first. */
  posts: PostBody[]
  /** The headers of every question the page sent (names in lower case), oldest first. */
  postHeaders: Record<string, string>[]
  /** Hold back the answer to "is the tutor on?" until `release()` is called. */
  hold: () => void
  release: () => void
}

/** Route every request to /api/tutor to this mock. Call it before the page is opened. */
async function mockTutor(
  page: Page,
  availability: Availability,
  answer: PostAnswer = replyWith('Look at line 4.'),
): Promise<TutorMock> {
  let gets = 0
  let open: () => void = () => undefined
  let gate: Promise<void> = Promise.resolve()
  const posts: PostBody[] = []
  const postHeaders: Record<string, string>[] = []
  trackDownloads(page)

  await page.route(TUTOR_ADDRESS, async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as PostBody
      posts.push(body)
      postHeaders.push(request.headers())
      await answer(route, body, posts.length - 1)
      return
    }
    gets += 1
    await gate
    if (availability === 'on' || availability === 'off') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
        body: JSON.stringify({ enabled: availability === 'on' }),
      })
    } else if (availability === 'page') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Stack Step</title><div id="root"></div>',
      })
    } else if (availability === 'broken') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"tutor-dev-error"}',
      })
    } else {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
    }
  })

  return {
    gets: () => gets,
    posts,
    postHeaders,
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve
      })
    },
    release: () => open(),
  }
}

/** A whole reply at once, as plain text. */
function replyWith(text: string | ((body: PostBody, index: number) => string)): PostAnswer {
  return (route, body, index) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain; charset=utf-8',
      headers: { 'Cache-Control': 'no-store' },
      body: typeof text === 'string' ? text : text(body, index),
    })
}

/** A failure, as the function reports it: a status and a small JSON body. */
function failWith(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): PostAnswer {
  return (route) =>
    route.fulfill({
      status,
      contentType: 'application/json; charset=utf-8',
      headers,
      body: JSON.stringify(body),
    })
}

/** Answer the questions one after the other with the given answers; the last one repeats. */
function inTurn(...answers: PostAnswer[]): PostAnswer {
  return (route, body, index) => {
    const answer = answers[Math.min(index, answers.length - 1)]
    if (answer === undefined) throw new Error('inTurn() needs at least one answer.')
    return answer(route, body, index)
  }
}

/* ─────────────────────── A reply that arrives piece by piece ─────────────────────── */

/** One reply that the test writes piece by piece. */
interface LiveReply {
  /** Send one piece of text to the page now. */
  send: (piece: string) => Promise<void>
  /** End the reply. */
  end: () => Promise<void>
  /** Cut the connection in the middle of the reply. */
  breakOff: () => void
  /** True when the page closed the connection before the reply ended (Stop). */
  closedEarly: () => boolean
}

interface ReplyServer {
  /** Pass a question on to this server: the test then writes the reply by hand. */
  answer: PostAnswer
  /** The reply to the next question that arrives (waits for it). */
  next: () => Promise<LiveReply>
}

/**
 * A route mock answers with a whole body at once. To see a reply arrive piece by piece,
 * the question is passed on to a tiny HTTP server inside the test, which keeps the
 * response open and writes when the test says so.
 */
const test = base.extend<{ replyServer: ReplyServer }>({
  replyServer: async ({ browserName }, use) => {
    void browserName
    const arrived: LiveReply[] = []
    let waiting: ((reply: LiveReply) => void) | null = null

    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        let closedEarly = false
        res.on('close', () => {
          if (!res.writableFinished) closedEarly = true
        })
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.flushHeaders()
        const reply: LiveReply = {
          send: (piece) => new Promise((resolve) => res.write(piece, () => resolve())),
          end: () => new Promise((resolve) => res.end(() => resolve())),
          breakOff: () => res.destroy(),
          closedEarly: () => closedEarly,
        }
        if (waiting === null) arrived.push(reply)
        else {
          waiting(reply)
          waiting = null
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/reply`

    await use({
      answer: (route) => route.continue({ url }),
      next: () => {
        const ready = arrived.shift()
        if (ready !== undefined) return Promise.resolve(ready)
        return new Promise((resolve) => {
          waiting = resolve
        })
      },
    })

    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  },
})

/* ───────────────────────────── Helpers ───────────────────────────── */

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768
}

/**
 * Everything the tutor puts on a page: its button and its drawer (also while the drawer
 * is closed). Other parts of the site may have dialogs of their own.
 */
function tutorParts(page: Page): Locator {
  return page.locator('[data-tutor]')
}

function launcher(page: Page): Locator {
  return page.getByRole('button', { name: 'Ask the tutor' })
}

function drawer(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Tutor' })
}

function questionBox(page: Page): Locator {
  return drawer(page).getByLabel('Your question')
}

function conversation(page: Page): Locator {
  return drawer(page).getByRole('region', { name: 'Conversation with the tutor' })
}

/** The line that tells a screen reader about each reply once (it is visually hidden). */
function announcer(page: Page): Locator {
  return drawer(page).getByRole('status')
}

/** How the tutor function ends a reply that did not end normally (see server/tutorCore.ts). */
const END_MARK = '\u0007'

async function openDrawer(page: Page): Promise<void> {
  await launcher(page).click()
  await expect(drawer(page)).toBeVisible()
}

/** Type a question and send it with the Send button. */
async function ask(page: Page, question: string): Promise<void> {
  await questionBox(page).fill(question)
  await drawer(page).getByRole('button', { name: 'Send' }).click()
}

/** Where things are on the page: used to see that nothing moved. */
async function layoutOf(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const box = (selector: string): DOMRect | undefined =>
      document.querySelector(selector)?.getBoundingClientRect()
    const round = (value: number | undefined): number => Math.round((value ?? -1) * 100) / 100
    return {
      pageHeight: document.documentElement.scrollHeight,
      pageWidth: document.documentElement.scrollWidth,
      h1Top: round(box('h1')?.top),
      h1Left: round(box('h1')?.left),
      mainHeight: round(box('main')?.height),
      mainWidth: round(box('main')?.width),
      elements: document.querySelectorAll('body *').length,
    }
  })
}

/**
 * The layout once the page has stopped moving on its own. A page can still be drawing
 * after its files have arrived (an editor that starts up, for example); that must not be
 * taken for something the tutor did.
 */
async function settledLayout(page: Page): Promise<Record<string, number>> {
  let last = await layoutOf(page)
  for (let tries = 0; tries < 30; tries += 1) {
    await page.waitForTimeout(100)
    const now = await layoutOf(page)
    if (JSON.stringify(now) === JSON.stringify(last)) return now
    last = now
  }
  return last
}

/** Wait until the page has drawn twice, so that a change of state is on the screen. */
async function twoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

/** The downloads that are under way on each page, apart from requests to /api/tutor. */
const downloading = new WeakMap<Page, Set<string>>()

/** Start to keep track of the downloads of a page. `mockTutor` does this for every test. */
function trackDownloads(page: Page): Set<string> {
  const known = downloading.get(page)
  if (known !== undefined) return known
  const busy = new Set<string>()
  downloading.set(page, busy)
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/tutor')) busy.add(request.url())
  })
  page.on('requestfinished', (request) => busy.delete(request.url()))
  page.on('requestfailed', (request) => busy.delete(request.url()))
  return busy
}

/** Wait until nothing is being downloaded, apart from a held request to /api/tutor. */
async function quiet(page: Page): Promise<void> {
  const busy = trackDownloads(page)
  let calm = 0
  // Four calm looks in a row. A download that never ends does not hold the test up for
  // ever: after about five seconds the test goes on.
  for (let looks = 0; looks < 64 && calm < 4; looks += 1) {
    await page.waitForTimeout(75)
    calm = busy.size === 0 ? calm + 1 : 0
  }
}

/* ═════════════════════════════ The real site ═════════════════════════════ */

/** Every pattern of the route table, as a real address. */
const ROUTES = [
  '/',
  '/stepper',
  '/learn',
  '/learn/mov',
  '/practice',
  '/practice/quiz',
  '/practice/rip',
  '/practice/weak',
  '/cheatsheet',
  '/progress',
  '/about',
] as const

test.describe('the real site: the tutor is off by default', () => {
  const HOSTS: [string, Availability][] = [
    ['a static host without the function (404)', 'missing'],
    ['a host whose function has no key (enabled: false)', 'off'],
  ]

  for (const [hostName, availability] of HOSTS) {
    for (const route of ROUTES) {
      test(`${hostName}: ${route} shows no tutor, and nothing moves`, async ({ page }) => {
        const errors = watchForErrors(page)
        const mock = await mockTutor(page, availability)
        mock.hold()

        await page.goto(`/#${route}`)
        await expect(page.locator('h1')).toHaveCount(1)
        await quiet(page)

        // While the page does not know yet if there is a tutor…
        await expect(launcher(page)).toHaveCount(0)
        await expect(tutorParts(page)).toHaveCount(0)
        const before = await settledLayout(page)

        // …and after it got its answer.
        mock.release()
        await quiet(page)
        await twoFrames(page)
        await expect(launcher(page)).toHaveCount(0)
        await expect(tutorParts(page)).toHaveCount(0)
        expect(await layoutOf(page)).toEqual(before)

        // A page asks at most once, and never sends a question by itself.
        expect(mock.gets()).toBeLessThanOrEqual(1)
        expect(mock.posts).toEqual([])
        expect(errors).toEqual([])
      })
    }
  }

  test('walking through the site asks "is the tutor on?" at most once', async ({ page }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(page, 'off')
    await page.goto('/#/')
    for (const route of ['/stepper', '/practice', '/practice/rip', '/stepper', '/learn', '/']) {
      await page.evaluate((hash) => {
        window.location.hash = hash
      }, route)
      await expect(page.locator('h1')).toHaveCount(1)
      await quiet(page)
      await expect(launcher(page)).toHaveCount(0)
    }
    expect(mock.gets()).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })
})

test.describe('the real site with the tutor on: the button never covers the end of a page', () => {
  /** Boxes that overlap (more than half a pixel each way). */
  interface Box {
    x: number
    y: number
    width: number
    height: number
  }
  const overlap = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width - 0.5 &&
    b.x < a.x + a.width - 0.5 &&
    a.y < b.y + b.height - 0.5 &&
    b.y < a.y + a.height - 0.5

  for (const route of ['/stepper', '/practice/weak', '/practice/register-names']) {
    test(`${route}: scrolled to the end, the footer and every control are above or beside it`, async ({
      page,
    }) => {
      const errors = watchForErrors(page)
      await mockTutor(page, 'on')
      await page.goto(`/#${route}`)
      await expect(page.locator('h1')).toHaveCount(1)
      await expect(launcher(page)).toBeVisible()
      await quiet(page)

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await twoFrames(page)
      const button = await launcher(page).boundingBox()
      if (button === null) throw new Error('The button has no box.')

      const covered = await page.evaluate(() => {
        const boxes: { what: string; x: number; y: number; width: number; height: number }[] = []
        const add = (what: string, rect: DOMRect): void => {
          if (rect.width > 0 && rect.height > 0) {
            boxes.push({ what, x: rect.x, y: rect.y, width: rect.width, height: rect.height })
          }
        }
        // Every line of the footer's text, and its link.
        const footer = document.querySelector('[data-site-footer] p')
        if (footer === null) throw new Error('No footer.')
        const walker = document.createTreeWalker(footer, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const range = document.createRange()
          range.selectNodeContents(walker.currentNode)
          for (const rect of range.getClientRects()) {
            add(`footer: ${(walker.currentNode.nodeValue ?? '').trim().slice(0, 30)}`, rect)
          }
        }
        // Every control of the page that scrolls with it. A fixed bar (the stepper's on a
        // phone) has its own room, and the button sits above it. A sticky bar is in its own
        // place at the end of the page, so it counts.
        const isFixed = (element: Element): boolean => {
          for (let node: Element | null = element; node !== null; node = node.parentElement) {
            if (getComputedStyle(node).position === 'fixed') return true
          }
          return false
        }
        for (const control of document.querySelectorAll(
          'main a, main button, main input, main select, main textarea',
        )) {
          if (control.closest('[data-tutor]') !== null || isFixed(control)) continue
          add(
            `${control.tagName}: ${(control.textContent ?? '').trim().slice(0, 30)}`,
            control.getBoundingClientRect(),
          )
        }
        return boxes
      })
      const underTheButton = covered.filter((box) => overlap(box, button)).map((box) => box.what)
      expect(underTheButton, `nothing is under the tutor's button on ${route}`).toEqual([])
      await expectNoSidewaysScroll(page)
      expect(errors).toEqual([])
    })
  }
})

/* ═════════════════════ The drawer, on its harness page ═════════════════════ */

test.describe('the drawer, on its harness page', () => {
  test.skip(
    !DEV,
    'The tutor harness is a developer page that only the dev server serves. Run with E2E_DEV=1.',
  )

  async function openHarness(page: Page, query = ''): Promise<void> {
    await page.goto(`${HARNESS}${query}`)
    await expect(page.getByRole('heading', { level: 1, name: 'Tutor harness' })).toBeVisible()
  }

  async function harnessContext(page: Page): Promise<TutorContext> {
    return page.evaluate(() => {
      const harness = (window as HarnessWindow).__tutorHarness
      if (harness === undefined) throw new Error('The harness is not ready.')
      return harness.context
    })
  }

  /* ── (a) no tutor ── */

  for (const availability of ['off', 'missing', 'page', 'broken'] as const) {
    test(`without a tutor (${availability}) nothing is rendered and nothing moves`, async ({
      page,
    }) => {
      const errors = watchForErrors(page)
      const downloads: string[] = []
      page.on('request', (request) => downloads.push(request.url()))
      const mock = await mockTutor(page, availability)
      mock.hold()

      await openHarness(page)
      await quiet(page)
      const before = await layoutOf(page)
      const htmlBefore = await page.locator('main').innerHTML()

      mock.release()
      await quiet(page)
      await twoFrames(page)

      await expect(launcher(page)).toHaveCount(0)
      await expect(tutorParts(page)).toHaveCount(0)
      expect(await page.locator('main').innerHTML()).toBe(htmlBefore)
      expect(await layoutOf(page)).toEqual(before)

      // One question to the function (the harness mounts twice in React's strict mode),
      // and the code of the drawer was never downloaded.
      expect(mock.gets()).toBe(1)
      expect(downloads.filter((url) => url.includes('TutorDrawer'))).toEqual([])
      expect(errors).toEqual([])
    })
  }

  /* ── (b) the button, the drawer, a streamed reply ── */

  test('with a tutor the button appears, and the code of the drawer is downloaded only then', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const downloads: string[] = []
    page.on('request', (request) => downloads.push(request.url()))
    const mock = await mockTutor(page, 'on')
    mock.hold()

    await openHarness(page)
    await quiet(page)
    await expect(launcher(page)).toHaveCount(0)
    expect(downloads.filter((url) => url.includes('TutorDrawer'))).toEqual([])
    const before = await layoutOf(page)

    mock.release()
    await expect(launcher(page)).toBeVisible()
    expect(downloads.filter((url) => url.includes('TutorDrawer'))).toHaveLength(1)
    expect(mock.gets()).toBe(1)

    // The button floats over the page: the page itself did not move or grow.
    const after = await layoutOf(page)
    expect({ ...after, elements: 0 }).toEqual({ ...before, elements: 0 })
    const position = await launcher(page).evaluate((button) => getComputedStyle(button).position)
    expect(position).toBe('fixed')

    // Near the bottom right corner, and big enough for a thumb.
    const box = await launcher(page).boundingBox()
    const screen = page.viewportSize()
    if (box === null || screen === null) throw new Error('The button has no box.')
    expect(box.height).toBeGreaterThanOrEqual(44)
    expect(screen.width - (box.x + box.width)).toBeLessThanOrEqual(32)
    expect(screen.height - (box.y + box.height)).toBeLessThanOrEqual(32)
    // On a phone only the icon shows (a 48 px circle), so the button hides less of the
    // page. Its name stays "Ask the tutor" for screen readers.
    const label = launcher(page).getByText('Ask the tutor')
    if (isPhone(page)) {
      expect(box.width).toBe(48)
      expect(box.height).toBe(48)
      const labelWidth = await label.evaluate((span) => span.getBoundingClientRect().width)
      expect(labelWidth).toBeLessThanOrEqual(1)
    } else {
      await expect(label).toBeVisible()
      expect(box.width).toBeGreaterThan(120)
    }
    await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false')
    await expect(drawer(page)).toBeHidden()
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('the drawer is a labelled dialog with the note, a text box, Send and New chat', async ({
    page,
  }) => {
    await mockTutor(page, 'on')
    await openHarness(page)
    await openDrawer(page)

    const dialog = drawer(page)
    await expect(launcher(page)).toHaveAttribute('aria-expanded', 'true')
    await expect(dialog.getByRole('heading', { level: 2, name: 'Tutor' })).toBeVisible()
    await expect(dialog).toContainText(
      'The tutor gives hints. It will not write your homework. It can make mistakes: check with the stepper.',
    )
    await expect(questionBox(page)).toBeVisible()
    await expect(questionBox(page)).toHaveAttribute('maxlength', '2000')
    await expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'New chat' })).toBeDisabled()
    await expect(dialog.getByRole('button', { name: 'Close the tutor' })).toBeVisible()
    // The conversation is a named region that is not live (a reply that grows piece by
    // piece would be read out in fragments). One status line inside the dialog tells a
    // screen reader about each reply instead.
    await expect(conversation(page)).toBeVisible()
    await expect(conversation(page)).not.toHaveAttribute('aria-live')
    await expect(conversation(page)).not.toHaveAttribute('aria-busy')
    await expect(announcer(page)).toHaveCount(1)
    await expect(announcer(page)).toHaveAttribute('aria-live', 'polite')
    await expect(announcer(page)).toHaveText('')
    // The page still has exactly one h1: the drawer's heading is an h2.
    await expect(page.locator('h1')).toHaveCount(1)

    // It really is modal: the page behind it cannot be used.
    const isModal = await dialog.evaluate((element) => element.matches(':modal'))
    expect(isModal).toBe(true)
    const stepIsReachable = await page.evaluate(() => {
      const button = [...document.querySelectorAll('main button')].find(
        (element) => element.textContent === 'Step',
      )
      if (!(button instanceof HTMLElement)) throw new Error('The harness has no Step button.')
      button.focus()
      return document.activeElement === button
    })
    expect(stepIsReachable).toBe(false)

    // Every control in the drawer is big enough for a thumb.
    for (const name of ['Send', 'New chat', 'Close the tutor']) {
      const box = await dialog.getByRole('button', { name }).boundingBox()
      expect(box?.height, name).toBeGreaterThanOrEqual(44)
      expect(box?.width, name).toBeGreaterThanOrEqual(44)
    }
  })

  test('a question is sent with the page data, and the reply appears piece by piece', async ({
    page,
    replyServer,
  }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(page, 'on', replyServer.answer)
    await openHarness(page)
    await openDrawer(page)

    await ask(page, 'Why does my program stop at `ret`?')
    const reply = await replyServer.next()

    // The question is on the screen at once, the text box is empty again, and the tutor
    // is "thinking" until the first piece arrives.
    const log = conversation(page)
    await expect(log).toContainText('Why does my program stop at ret?')
    await expect(log.locator('code', { hasText: 'ret' })).toBeVisible()
    await expect(log).toContainText('The tutor is thinking…')
    await expect(questionBox(page)).toHaveValue('')
    await expect(drawer(page).getByRole('button', { name: 'Stop' })).toBeVisible()
    await expect(drawer(page).getByRole('button', { name: 'Send' })).toBeDisabled()

    // What was posted: the question, and exactly what the page shows.
    expect(mock.posts).toHaveLength(1)
    const sample = await harnessContext(page)
    expect(sample.code).toContain('push rbx')
    expect(sample.machine).toContain('rsp = 0x7ffffffddff8')
    expect(mock.posts[0]).toEqual({
      messages: [{ role: 'user', content: 'Why does my program stop at `ret`?' }],
      context: sample,
    })
    // With the id of this page load, so that classmates on one address are counted apart.
    expect(mock.postHeaders[0]?.['x-tutor-client']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    // A screen reader hears that the question went out.
    await expect(announcer(page)).toHaveText('The tutor is thinking…')

    // The reply arrives in three pieces, and each one shows up before the next is sent.
    await reply.send('Look at ')
    await expect(log).toContainText('Look at')
    await expect(log).not.toContainText('The tutor is thinking…')
    await expect(log).not.toContainText('line 4')
    await expect(drawer(page).getByRole('button', { name: 'Stop' })).toBeVisible()
    // The status line does not read out pieces: it waits for the whole reply.
    await expect(announcer(page)).toHaveText('The tutor is thinking…')

    await reply.send('line 4. What is in `rsp` ')
    await expect(log).toContainText('Look at line 4. What is in rsp')
    await expect(log).not.toContainText('before')

    await reply.send('before the `push`?')
    await expect(log).toContainText('Look at line 4. What is in rsp before the push?')
    await expect(drawer(page).getByRole('button', { name: 'Stop' })).toBeVisible()

    await reply.end()
    await expect(drawer(page).getByRole('button', { name: 'Stop' })).toHaveCount(0)
    await expect(log.locator('[data-turn-state="done"]')).toHaveCount(1)
    // Code in the reply is shown as code; the backticks are gone.
    await expect(log.locator('code', { hasText: /^rsp$/ })).toBeVisible()
    await expect(log.locator('code', { hasText: /^push$/ })).toBeVisible()
    await expect(log).not.toContainText('`')
    // The whole reply is read out once, as words (no backticks).
    await expect(announcer(page)).toHaveText(
      'Tutor: Look at line 4. What is in rsp before the push?',
    )
    expect(reply.closedEarly()).toBe(false)
    expect(errors).toEqual([])
  })

  test('every question carries the id of this page load; a reload makes a new one', async ({
    page,
  }) => {
    const mock = await mockTutor(page, 'on')
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'First?')
    await expect(conversation(page)).toContainText('Look at line 4.')
    await ask(page, 'Second?')
    await expect(conversation(page).locator('[data-turn-state="done"]')).toHaveCount(2)
    const first = mock.postHeaders[0]?.['x-tutor-client']
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(mock.postHeaders[1]?.['x-tutor-client']).toBe(first)

    await page.reload()
    await openDrawer(page)
    await ask(page, 'After the reload?')
    await expect(conversation(page)).toContainText('Look at line 4.')
    expect(mock.postHeaders[2]?.['x-tutor-client']).toMatch(/^[0-9a-f-]{36}$/)
    expect(mock.postHeaders[2]?.['x-tutor-client']).not.toBe(first)
    // Nothing of it is stored in the browser.
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...window.localStorage, ...window.sessionStorage }),
    )
    expect(stored).not.toContain(first ?? 'no id')
  })

  test('each question carries the conversation so far: the last 12 messages at most', async ({
    page,
  }) => {
    const mock = await mockTutor(
      page,
      'on',
      replyWith((_body, index) => `Hint number ${index + 1}.`),
    )
    await openHarness(page)
    await openDrawer(page)
    const sample = await harnessContext(page)

    for (let number = 1; number <= 8; number += 1) {
      await ask(page, `Question number ${number}?`)
      await expect(conversation(page)).toContainText(`Hint number ${number}.`)
    }

    expect(mock.posts).toHaveLength(8)
    for (const [index, body] of mock.posts.entries()) {
      expect(body.messages.length, `question ${index + 1}`).toBeLessThanOrEqual(12)
      expect(body.messages[0]?.role).toBe('user')
      expect(body.messages[body.messages.length - 1]).toEqual({
        role: 'user',
        content: `Question number ${index + 1}?`,
      })
      // The roles take turns, and every question carries the page data again.
      expect(body.messages.map((message) => message.role).join(' ')).toMatch(
        /^user( assistant user)*$/,
      )
      expect(body.context).toEqual(sample)
    }
    // The third question carries the two before it, with their replies.
    expect(mock.posts[2]?.messages).toEqual([
      { role: 'user', content: 'Question number 1?' },
      { role: 'assistant', content: 'Hint number 1.' },
      { role: 'user', content: 'Question number 2?' },
      { role: 'assistant', content: 'Hint number 2.' },
      { role: 'user', content: 'Question number 3?' },
    ])
    // The eighth one no longer carries the first two.
    expect(mock.posts[7]?.messages).toHaveLength(11)
    expect(mock.posts[7]?.messages[0]?.content).toBe('Question number 3?')
    // The student still sees everything.
    await expect(conversation(page)).toContainText('Question number 1?')
    await expect(conversation(page).locator('[data-turn-state="done"]')).toHaveCount(8)
  })

  test('on a practice page the problem goes along', async ({ page }) => {
    const mock = await mockTutor(page, 'on')
    await openHarness(page, '?page=practice')
    await openDrawer(page)
    await ask(page, 'Is the top half zero?')
    await expect(conversation(page)).toContainText('Look at line 4.')
    const sample = await harnessContext(page)
    expect(sample.page).toBe('practice')
    expect(sample.problem).toContain('What is in `rax`')
    expect(mock.posts[0]?.context).toEqual(sample)
  })

  test('a reply is plain text: line breaks stay, code is code, HTML is never run', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const nasty = [
      'First line.',
      'Second line with `mov eax, 5` in it.',
      '',
      '<img src="x" onerror="window.__injected = true"> <b>not bold</b> <script>window.__injected = true</script>',
      '**stars stay stars** and [a link](https://example.com) stays text.',
    ].join('\n')
    await mockTutor(page, 'on', replyWith(nasty))
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Show me <b>everything</b>')

    const log = conversation(page)
    await expect(log).toContainText('<b>not bold</b>')
    await expect(log).toContainText('**stars stay stars** and [a link](https://example.com)')
    await expect(log).toContainText('Show me <b>everything</b>')
    await expect(log.locator('code', { hasText: 'mov eax, 5' })).toBeVisible()
    await expect(log.locator('img, b, script, a')).toHaveCount(0)
    expect(await page.evaluate(() => (window as HarnessWindow).__injected)).toBeUndefined()

    // The lines are below each other.
    const lineHeights = await log.evaluate((element) => {
      const reply = element.querySelector('[data-turn-state] > div:last-child .whitespace-pre-wrap')
      if (reply === null) throw new Error('The reply is not there.')
      return { height: reply.getBoundingClientRect().height, text: reply.textContent }
    })
    expect(lineHeights.text).toContain('First line.\nSecond line with mov eax, 5 in it.\n\n<img')
    expect(lineHeights.height).toBeGreaterThan(100)
    expect(errors).toEqual([])
  })

  /* ── (c) when it goes wrong ── */

  test('a 429 shows the friendly message with the wait time, counts it down, then the question can be sent again', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(
      page,
      'on',
      inTurn(
        failWith(
          429,
          {
            error: 'rate-limited',
            message: 'You are asking very fast. Please wait 3 seconds, then ask again.',
            retryAfterSeconds: 3,
          },
          { 'Retry-After': '3' },
        ),
        replyWith('Now it works: look at line 4.'),
      ),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Why did rsp change?')

    const log = conversation(page)
    await expect(log).toContainText(
      'You are asking very fast. Please wait 3 seconds, then ask again.',
    )
    // The failure is said in words, not by a color alone, and the question stays.
    await expect(log).toContainText('No reply')
    await expect(log).toContainText('Why did rsp change?')
    await expect(log.locator('[data-turn-state="failed"]')).toHaveCount(1)
    await expect(drawer(page).getByRole('button', { name: 'Stop' })).toHaveCount(0)
    await expect(announcer(page)).toHaveText(
      'No reply. You are asking very fast. Please wait 3 seconds, then ask again.',
    )

    // Until the wait is over, asking again would only get another 429: both ways are shut,
    // and the time left is shown and counts down.
    const again = log.getByRole('button', { name: /^Try again/ })
    await expect(again).toBeDisabled()
    await expect(again).toHaveText(/^Try again in [123] seconds?$/)
    await questionBox(page).fill('Another question')
    await expect(drawer(page).getByRole('button', { name: 'Send' })).toBeDisabled()
    await expect(drawer(page)).toContainText(/You can ask again in [123] seconds?\./)
    await page.keyboard.press('Enter')
    expect(mock.posts).toHaveLength(1)
    await expect(again).toHaveText('Try again in 1 second', { timeout: 4000 })
    await expect(again).toBeEnabled({ timeout: 3000 })
    await expect(again).toHaveText('Try again')
    await expect(drawer(page)).not.toContainText('You can ask again')
    await expect(drawer(page).getByRole('button', { name: 'Send' })).toBeEnabled()
    await questionBox(page).fill('')

    await again.click()
    await expect(log).toContainText('Now it works: look at line 4.')
    await expect(log).not.toContainText('You are asking very fast')
    await expect(log.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    await expect(log.locator('[data-turn-state]')).toHaveCount(1)

    // The same question went out twice, and the failed try is not part of the history.
    expect(mock.posts).toHaveLength(2)
    expect(mock.posts[1]).toEqual(mock.posts[0])
    expect(errors).toEqual([])
  })

  test('a 429 without a message still says how long to wait', async ({ page }) => {
    await mockTutor(page, 'on', (route) =>
      route.fulfill({ status: 429, headers: { 'Retry-After': '45' }, body: 'Too Many Requests' }),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Why?')
    await expect(conversation(page)).toContainText(
      'The tutor is getting too many questions. Please wait 45 seconds, then ask again.',
    )
  })

  test('a 503 says that the tutor is busy', async ({ page }) => {
    await mockTutor(
      page,
      'on',
      failWith(503, {
        error: 'tutor-busy',
        message: 'The tutor is busy right now. Please try again in a moment.',
      }),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Why?')
    await expect(conversation(page)).toContainText(
      'The tutor is busy right now. Please try again in a moment.',
    )
    await expect(conversation(page).getByRole('button', { name: 'Try again' })).toBeVisible()
  })

  test('a 502 says that the tutor is not set up correctly', async ({ page }) => {
    await mockTutor(
      page,
      'on',
      failWith(502, {
        error: 'tutor-not-set-up',
        message: 'The tutor is not set up correctly. Please tell your teacher.',
      }),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Why?')
    await expect(conversation(page)).toContainText(
      'The tutor is not set up correctly. Please tell your teacher.',
    )
  })

  test('a network failure is explained, and a later question still works', async ({ page }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(
      page,
      'on',
      inTurn((route) => route.abort('internetdisconnected'), replyWith('Back again.')),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'First question?')
    const log = conversation(page)
    await expect(log).toContainText(
      'The tutor could not be reached. Check your internet connection, then try again.',
    )

    // The student asks something else instead of trying again.
    await ask(page, 'Second question?')
    await expect(log).toContainText('Back again.')
    // The failed question is still shown, but it can no longer be sent again…
    await expect(log).toContainText('First question?')
    await expect(log.getByRole('button', { name: 'Try again' })).toHaveCount(0)
    // …and it is not part of what the tutor is told.
    expect(mock.posts[1]?.messages).toEqual([{ role: 'user', content: 'Second question?' }])
    expect(errors).toEqual([])
  })

  test('a reply that breaks off keeps its text and can be asked again', async ({
    page,
    replyServer,
  }) => {
    await mockTutor(page, 'on', inTurn(replyServer.answer, replyWith('The whole answer.')))
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Why?')
    const reply = await replyServer.next()
    await reply.send('Half an ans')
    const log = conversation(page)
    await expect(log).toContainText('Half an ans')

    // The connection drops in the middle of the reply.
    reply.breakOff()
    await expect(log).toContainText('The reply is not complete')
    await expect(log).toContainText('The connection was lost before the reply was finished.')
    await expect(log).toContainText('Half an ans')

    await log.getByRole('button', { name: 'Try again' }).click()
    await expect(log).toContainText('The whole answer.')
    await expect(log).not.toContainText('Half an ans')
  })

  test('a reply that broke off on the server is a failure that can be asked again, not an answer', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(
      page,
      'on',
      inTurn(
        replyWith(`Look at line 4. What is in ${END_MARK}interrupted`),
        replyWith(`${END_MARK}empty`),
        replyWith('The whole answer.'),
        replyWith('Next hint.'),
      ),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Why?')

    // The text that arrived stays, with a warning in words and a way to ask again.
    const log = conversation(page)
    await expect(log.locator('[data-turn-state="failed"]')).toHaveCount(1)
    await expect(log).toContainText('Look at line 4. What is in')
    await expect(log).toContainText('The reply is not complete')
    await expect(log).toContainText(
      'The tutor had a problem and stopped before the reply was finished. Please try again.',
    )
    await expect(announcer(page)).toHaveText(
      'The reply is not complete. The tutor had a problem and stopped before the reply was finished. Please try again.',
    )
    // The mark and its word are never shown.
    await expect(log).not.toContainText('interrupted')
    expect(await log.textContent()).not.toContain(END_MARK)

    // The model wrote nothing at all: also a failure, with no text.
    await log.getByRole('button', { name: 'Try again' }).click()
    await expect(log).toContainText('No reply')
    await expect(log).toContainText('The tutor sent an empty reply. Please try again.')
    await expect(log).not.toContainText('Look at line 4. What is in')

    await log.getByRole('button', { name: 'Try again' }).click()
    await expect(log).toContainText('The whole answer.')
    await expect(log.locator('[data-turn-state="done"]')).toHaveCount(1)
    await expect(log.locator('[data-turn-state]')).toHaveCount(1)

    // The broken replies were never part of what the tutor is told.
    await ask(page, 'And then?')
    await expect(log).toContainText('Next hint.')
    expect(mock.posts.slice(0, 3).map((body) => body.messages)).toEqual([
      [{ role: 'user', content: 'Why?' }],
      [{ role: 'user', content: 'Why?' }],
      [{ role: 'user', content: 'Why?' }],
    ])
    expect(mock.posts[3]?.messages).toEqual([
      { role: 'user', content: 'Why?' },
      { role: 'assistant', content: 'The whole answer.' },
      { role: 'user', content: 'And then?' },
    ])
    expect(errors).toEqual([])
  })

  test('a reply that the length limit cut off keeps its text, says so, and can be asked again', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(
      page,
      'on',
      inTurn(replyWith(`Look at line 4. What is in ${END_MARK}cut`), replyWith('A short hint.')),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Explain everything about the stack.')

    const log = conversation(page)
    await expect(log.locator('[data-turn-state="failed"]')).toHaveCount(1)
    await expect(log).toContainText('Look at line 4. What is in')
    await expect(log).toContainText('The reply is not complete')
    await expect(log).toContainText(
      'The reply was too long, so it was cut off. Try again, or ask about one thing at a time.',
    )
    await expect(log).not.toContainText('cut off.cut')
    expect(await log.textContent()).not.toContain(END_MARK)

    await log.getByRole('button', { name: 'Try again' }).click()
    await expect(log).toContainText('A short hint.')
    // The half reply was never part of what the tutor is told.
    expect(mock.posts[1]?.messages).toEqual([
      { role: 'user', content: 'Explain everything about the stack.' },
    ])
    expect(errors).toEqual([])
  })

  test('a refusal shows one plain sentence in place of the partial reply', async ({ page }) => {
    const refusal = "I can't help with that. Ask me about your assembly code."
    const mock = await mockTutor(
      page,
      'on',
      inTurn(replyWith(`Here is the start of ${END_MARK}refused`), replyWith('A hint.')),
    )
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Write my homework.')
    const log = conversation(page)
    await expect(log).toContainText(refusal)
    await expect(log).not.toContainText('Here is the start of')
    await expect(log.locator('[data-turn-state="done"]')).toHaveCount(1)
    await expect(announcer(page)).toHaveText(`Tutor: ${refusal}`)

    // The next question tells the tutor what the student saw.
    await ask(page, 'Then give me a hint.')
    await expect(log).toContainText('A hint.')
    expect(mock.posts[1]?.messages).toEqual([
      { role: 'user', content: 'Write my homework.' },
      { role: 'assistant', content: refusal },
      { role: 'user', content: 'Then give me a hint.' },
    ])
  })

  test('Stop ends a reply: the request is aborted and the text so far stays', async ({
    page,
    replyServer,
  }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(page, 'on', inTurn(replyServer.answer, replyWith('A new answer.')))
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Explain the stack.')
    const reply = await replyServer.next()
    await reply.send('The stack is a pile of ')
    const log = conversation(page)
    await expect(log).toContainText('The stack is a pile of')

    await drawer(page).getByRole('button', { name: 'Stop' }).click()
    await expect(log).toContainText('You stopped this reply.')
    await expect(log).toContainText('The stack is a pile of')
    await expect(announcer(page)).toHaveText(
      'You stopped this reply. Tutor: The stack is a pile of',
    )
    await expect(drawer(page).getByRole('button', { name: 'Stop' })).toHaveCount(0)
    await expect(log.locator('[data-turn-state="stopped"]')).toHaveCount(1)
    // The browser really closed the connection: the server pays for nothing more.
    await expect.poll(() => reply.closedEarly()).toBe(true)
    // After Stop the student can type at once.
    await expect(questionBox(page)).toBeFocused()

    // The next question tells the tutor what it had said before it was stopped.
    await ask(page, 'Go on.')
    await expect(log).toContainText('A new answer.')
    expect(mock.posts[1]?.messages).toEqual([
      { role: 'user', content: 'Explain the stack.' },
      { role: 'assistant', content: 'The stack is a pile of ' },
      { role: 'user', content: 'Go on.' },
    ])
    expect(errors).toEqual([])
  })

  /* ── (d) the keyboard ── */

  test('keyboard: open, type, Shift+Enter makes a line, Enter sends, Escape closes, focus returns', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    const mock = await mockTutor(page, 'on', replyWith('Look at line 4.'))
    await openHarness(page)

    // Open with the keyboard.
    await launcher(page).focus()
    await page.keyboard.press('Enter')
    await expect(drawer(page)).toBeVisible()

    // Focus moved into the drawer: with a keyboard and mouse straight to the text box,
    // on a touch screen to the heading (so the on-screen keyboard does not jump up).
    if (isPhone(page)) {
      await expect(drawer(page).getByRole('heading', { name: 'Tutor' })).toBeFocused()
      await questionBox(page).focus()
    } else {
      await expect(questionBox(page)).toBeFocused()
    }

    await page.keyboard.type('Line one')
    await page.keyboard.press('Shift+Enter')
    await page.keyboard.type('line two')
    await expect(questionBox(page)).toHaveValue('Line one\nline two')
    expect(mock.posts).toHaveLength(0)

    // Enter with Ctrl belongs to the page's own shortcuts: it does not send.
    await page.keyboard.press('Control+Enter')
    expect(mock.posts).toHaveLength(0)

    await page.keyboard.press('Enter')
    await expect(conversation(page)).toContainText('Look at line 4.')
    expect(mock.posts).toHaveLength(1)
    expect(mock.posts[0]?.messages).toEqual([{ role: 'user', content: 'Line one\nline two' }])
    await expect(questionBox(page)).toHaveValue('')
    await expect(questionBox(page)).toBeFocused()

    // Enter on an empty box sends nothing.
    await page.keyboard.press('Enter')
    await page.keyboard.type('   ')
    await page.keyboard.press('Enter')
    expect(mock.posts).toHaveLength(1)

    // Tab never reaches the page behind the drawer. (After the last control the browser
    // may give the focus to its own toolbar for one press; then it comes back.)
    const visited = new Set<string>()
    for (let presses = 1; presses <= 12; presses += 1) {
      await page.keyboard.press('Tab')
      const focus = await drawer(page).evaluate((dialog) => {
        const active = document.activeElement
        if (active === null || active === document.body) return 'the browser'
        if (!dialog.contains(active)) return `outside the drawer: ${active.tagName}`
        return active.getAttribute('aria-label') ?? active.textContent ?? active.tagName
      })
      expect(focus, `after ${presses} presses of Tab`).not.toContain('outside the drawer')
      visited.add(focus)
    }
    // It went around: the close button, the conversation and the text box all had a turn.
    expect([...visited]).toEqual(
      expect.arrayContaining(['Close the tutor', 'Conversation with the tutor', 'New chat']),
    )
    await questionBox(page).focus()

    // Escape closes, and the focus is back on the button that opened the drawer.
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toBeHidden()
    await expect(launcher(page)).toBeFocused()
    await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false')

    // The conversation is still there when the drawer opens again.
    await page.keyboard.press('Enter')
    await expect(conversation(page)).toContainText('Line one')
    await expect(conversation(page)).toContainText('Look at line 4.')
    expect(errors).toEqual([])
  })

  test('the close button and a click beside the drawer close it too', async ({ page }) => {
    await mockTutor(page, 'on')
    await openHarness(page)

    await openDrawer(page)
    await drawer(page).getByRole('button', { name: 'Close the tutor' }).click()
    await expect(drawer(page)).toBeHidden()
    await expect(launcher(page)).toBeFocused()

    await openDrawer(page)
    // A click inside the drawer does not close it…
    await conversation(page).click()
    await expect(drawer(page)).toBeVisible()
    // …a click on the dimmed page beside it does.
    await page.mouse.click(isPhone(page) ? 180 : 200, 40)
    await expect(drawer(page)).toBeHidden()
    await expect(launcher(page)).toBeFocused()
  })

  test('the text box holds 2000 characters and counts them near the limit', async ({ page }) => {
    const mock = await mockTutor(page, 'on')
    await openHarness(page)
    await openDrawer(page)
    const box = questionBox(page)
    const dialog = drawer(page)

    await box.fill('x'.repeat(1799))
    await expect(dialog).not.toContainText('of 2000 characters')
    await box.fill('x'.repeat(1800))
    await expect(dialog).toContainText('1800 of 2000 characters')
    // On a phone it is 14 px, the smallest text a student must read there.
    const counterSize = await dialog
      .getByText('1800 of 2000 characters')
      .evaluate((element) => getComputedStyle(element).fontSize)
    expect(counterSize).toBe(isPhone(page) ? '14px' : '12px')

    // Typing past the limit is not possible.
    await box.fill('x'.repeat(1999))
    await box.press('End')
    await page.keyboard.type('abc')
    await expect(box).toHaveValue(`${'x'.repeat(1999)}a`)
    await expect(dialog).toContainText('2000 of 2000 characters. This is the limit.')

    await box.press('Enter')
    await expect(conversation(page)).toContainText('Look at line 4.')
    expect(mock.posts[0]?.messages[0]?.content).toHaveLength(2000)
  })

  test('New chat forgets the conversation, and a reload does too: nothing is stored', async ({
    page,
  }) => {
    const mock = await mockTutor(page, 'on', replyWith('A hint about SECRET-TOPIC.'))
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'My question about SECRET-TOPIC')
    const log = conversation(page)
    await expect(log).toContainText('A hint about SECRET-TOPIC.')

    // Nothing of the conversation is kept in the browser.
    const stored = await page.evaluate(() => ({
      local: JSON.stringify(window.localStorage),
      session: JSON.stringify(window.sessionStorage),
      cookie: document.cookie,
    }))
    expect(stored.local).not.toContain('SECRET-TOPIC')
    expect(stored.session).not.toContain('SECRET-TOPIC')
    expect(stored.cookie).toBe('')

    await drawer(page).getByRole('button', { name: 'New chat' }).click()
    await expect(log).not.toContainText('SECRET-TOPIC')
    await expect(log).toContainText('Ask about the code on this page.')
    await expect(drawer(page).getByRole('button', { name: 'New chat' })).toBeDisabled()
    await expect(questionBox(page)).toBeFocused()

    // A question after "New chat" starts from nothing.
    await ask(page, 'A fresh question')
    await expect(log).toContainText('A hint about')
    expect(mock.posts[1]?.messages).toEqual([{ role: 'user', content: 'A fresh question' }])

    await page.reload()
    await openDrawer(page)
    await expect(conversation(page)).toContainText('Ask about the code on this page.')
    await expect(conversation(page)).not.toContainText('A fresh question')
  })

  /* ── (e) the phone, and the page behind the drawer ── */

  test('nothing scrolls sideways with the drawer open, and long text wraps', async ({ page }) => {
    await mockTutor(
      page,
      'on',
      replyWith(
        `A very long word: ${'0x7ffffffddff8'.repeat(12)} and \`${'mov_rax_'.repeat(20)}\` end.`,
      ),
    )
    await openHarness(page)
    await openDrawer(page)
    await expectNoSidewaysScroll(page)

    await ask(page, `Why${'?'.repeat(300)} and ${'averyveryverylongword'.repeat(8)}`)
    await expect(conversation(page)).toContainText('end.')
    await expectNoSidewaysScroll(page)

    // The drawer fits the screen, and nothing inside it is wider than it.
    const sizes = await drawer(page).evaluate((dialog) => {
      const log = dialog.querySelector('[role="region"]')
      if (log === null) throw new Error('The drawer has no conversation.')
      const box = dialog.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        // The part of the window that pages are drawn in (without a scrollbar).
        screenWidth: document.documentElement.clientWidth,
        screenHeight: document.documentElement.clientHeight,
        logScrollWidth: log.scrollWidth,
        logClientWidth: log.clientWidth,
      }
    })
    expect(sizes.left).toBeGreaterThanOrEqual(0)
    expect(sizes.right).toBeLessThanOrEqual(sizes.screenWidth)
    expect(sizes.top).toBeGreaterThanOrEqual(0)
    expect(sizes.bottom).toBeLessThanOrEqual(sizes.screenHeight)
    expect(sizes.logScrollWidth).toBeLessThanOrEqual(sizes.logClientWidth)

    if (isPhone(page)) {
      // A sheet at the bottom, as wide as the screen, with the page visible above it.
      expect(sizes.left).toBe(0)
      expect(sizes.right).toBe(sizes.screenWidth)
      expect(sizes.bottom).toBe(sizes.screenHeight)
      expect(sizes.top).toBeGreaterThan(40)
    } else {
      // A column on the right, as tall as the screen.
      expect(sizes.right).toBe(sizes.screenWidth)
      expect(sizes.top).toBe(0)
      expect(sizes.bottom).toBe(sizes.screenHeight)
      expect(sizes.left).toBeGreaterThan(sizes.screenWidth / 2)
    }
  })

  test('on a phone the page behind the drawer does not scroll', async ({ page }) => {
    test.skip(!isPhone(page), 'This is about the bottom sheet on a phone.')
    await mockTutor(page, 'on')
    await openHarness(page)

    // The page itself can be scrolled…
    await page.mouse.move(180, 100)
    await page.mouse.wheel(0, 300)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    const scrolledTo = await page.evaluate(() => window.scrollY)

    // …but not while the drawer is open.
    await openDrawer(page)
    await page.mouse.move(180, 60)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(250)
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolledTo)
    const locked = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)
    expect(locked).toBe('hidden')

    // Closing gives the page back as it was.
    await page.keyboard.press('Escape')
    await expect(drawer(page)).toBeHidden()
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolledTo)
    const unlocked = await page.evaluate(() => document.documentElement.style.overflow)
    expect(unlocked).toBe('')
    await page.mouse.wheel(0, 200)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolledTo)
  })

  test('on a short phone screen the conversation keeps room (as with an on-screen keyboard)', async ({
    page,
  }) => {
    test.skip(!isPhone(page), 'This is about the bottom sheet on a phone.')
    await mockTutor(page, 'on', replyWith('Look at line 4.'))
    await openHarness(page)
    await openDrawer(page)
    await ask(page, 'Why?')
    await expect(conversation(page)).toContainText('Look at line 4.')
    const note = drawer(page).getByText('The tutor gives hints.')
    await expect(note).toBeVisible()

    // An on-screen keyboard that makes the page shorter: 380 px of height are left.
    await page.setViewportSize({ width: 360, height: 380 })
    await expect(note).toBeHidden()
    // The note is still the description of the dialog (a screen reader reads it on opening).
    await expect(drawer(page)).toHaveAccessibleDescription(/The tutor gives hints\./)
    const short = await drawer(page).evaluate((dialog) => {
      const log = dialog.querySelector('[role="region"]')
      const box = dialog.querySelector('textarea')
      if (log === null || box === null) throw new Error('The drawer is not complete.')
      return {
        sheetTop: dialog.getBoundingClientRect().top,
        logHeight: log.clientHeight,
        boxBottom: box.getBoundingClientRect().bottom,
        screenHeight: document.documentElement.clientHeight,
      }
    })
    // The sheet takes the whole height, the text box is on the screen, and the
    // conversation keeps room for a few lines (with the note and 85 % height: about 40 px).
    expect(short.sheetTop).toBe(0)
    expect(short.boxBottom).toBeLessThanOrEqual(short.screenHeight)
    expect(short.logHeight).toBeGreaterThanOrEqual(140)
    await expectNoSidewaysScroll(page)

    // A tall screen again: the note is back.
    await page.setViewportSize({ width: 360, height: 740 })
    await expect(note).toBeVisible()
  })

  test('the button stays above a bar at the bottom of the screen (--tutor-bottom-offset)', async ({
    page,
  }) => {
    await mockTutor(page, 'on')
    await openHarness(page, '?bar=1')
    await expect(launcher(page)).toBeVisible()
    const button = await launcher(page).boundingBox()
    const bar = await page.getByTestId('control-bar').boundingBox()
    if (button === null || bar === null) throw new Error('The button or the bar has no box.')
    expect(bar.height).toBe(64)
    // The whole button is above the bar, with the same gap it otherwise keeps to the edge.
    expect(button.y + button.height).toBeLessThanOrEqual(bar.y - 8)

    // Without the bar the button sits 64 px lower.
    await page.goto(HARNESS)
    await expect(launcher(page)).toBeVisible()
    const plain = await launcher(page).boundingBox()
    expect(plain?.y).toBe(button.y + 64)
  })

  /* ── Screenshots for docs/screenshots/m7 (opt-in) ── */

  test.describe('screenshots', () => {
    test.skip(process.env.TUTOR_SHOTS !== '1', 'Set TUTOR_SHOTS=1 to save the screenshots.')

    for (const theme of ['light', 'dark'] as const) {
      test(`of the drawer, ${theme}`, async ({ page, replyServer }, testInfo) => {
        const shot = (name: string): Promise<Buffer> =>
          page.screenshot({
            path: `docs/screenshots/m7/${testInfo.project.name}-${theme}-${name}.png`,
          })

        const answers = [
          'Look at line 4. What is in `rsp` before the `push`, and what is in it after?',
          'Right. Now look at line 8. `ret` takes the top box of the stack and puts it in `rip`.\n\nWhich value is in the top box when `ret` runs?',
        ]
        await mockTutor(
          page,
          'on',
          inTurn(
            replyWith(answers[0] ?? ''),
            replyWith(answers[1] ?? ''),
            replyServer.answer,
            failWith(429, {
              error: 'rate-limited',
              message: 'You are asking very fast. Please wait 12 seconds, then ask again.',
              retryAfterSeconds: 12,
            }),
          ),
        )
        await openHarness(page, `?theme=${theme}&bar=${isPhone(page) ? '1' : '0'}`)
        await expect(launcher(page)).toBeVisible()
        await shot('1-button')

        await openDrawer(page)
        await shot('2-empty')

        await ask(page, 'Why does my program stop with an error at `ret`?')
        await expect(conversation(page)).toContainText('what is in it after?')
        await ask(page, 'It went down by 8, from 0x7ffffffddff8 to 0x7ffffffddff0.')
        await expect(conversation(page)).toContainText('when ret runs?')
        await shot('3-conversation')

        await ask(page, 'The value of rbx?')
        const reply = await replyServer.next()
        await reply.send('Yes. The top box holds the old value of `rbx`, not the')
        await expect(conversation(page)).toContainText('not the')
        await shot('4-streaming')
        await reply.send(' return address. What must happen before `ret`?')
        await reply.end()
        await expect(conversation(page)).toContainText('before ret?')

        await ask(page, 'I must pop rbx first?')
        await expect(conversation(page)).toContainText('Please wait 12 seconds')
        await shot('5-rate-limited')
      })

      test(`of a reply that broke off on the server, ${theme}`, async ({ page }, testInfo) => {
        await mockTutor(
          page,
          'on',
          inTurn(
            replyWith(
              'Look at line 4. What is in `rsp` before the `push`, and what is in it after?',
            ),
            replyWith(`Good question. \`ret\` takes the top box and ${END_MARK}interrupted`),
          ),
        )
        await openHarness(page, `?theme=${theme}&bar=${isPhone(page) ? '1' : '0'}`)
        await openDrawer(page)
        await ask(page, 'Why does my program stop with an error at `ret`?')
        await expect(conversation(page)).toContainText('what is in it after?')
        await ask(page, 'What does ret do?')
        await expect(conversation(page)).toContainText('The reply is not complete')
        await page.screenshot({
          path: `docs/screenshots/m7/${testInfo.project.name}-${theme}-6-interrupted.png`,
        })
      })
    }
  })
})
