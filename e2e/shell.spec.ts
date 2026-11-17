/**
 * The app shell, tested in a real browser: routing, layout, theme, keyboard use.
 *
 * Runs in both Playwright projects (desktop 1280×800, phone 360×740):
 *   E2E_DEV=1 E2E_PORT=5184 npx playwright test e2e/shell.spec.ts
 *
 * The placeholder pages will be replaced by the real features, so these tests check
 * what the shell promises for every page (one h1, a tab title, no sideways scrolling)
 * and check the words only on the shell's own pages (Home, About, Not found).
 *
 * The tests pass against the dev server and against the built site. A test that stands
 * in the way of a page file names the file by a part of its address that both have
 * ('AboutPage' is in '/src/features/about/AboutPage.tsx' and in '/assets/AboutPage-x.js').
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { expectNoSidewaysScroll, watchForErrors } from './helpers'

/** True when the tests run against the dev server (`E2E_DEV=1`), which has '/dev/kit'. */
const DEV_SERVER = process.env.E2E_DEV === '1'

const HOME_TITLE = 'Stack Step: learn x86-64 assembly one step at a time'

/** Every pattern of the route table, as a real address, with its tab title. */
const ROUTES = [
  { path: '/', title: HOME_TITLE },
  { path: '/stepper', title: 'Stepper · Stack Step' },
  { path: '/learn', title: 'Learn · Stack Step' },
  { path: '/learn/mov', title: 'mov: copy a value · Stack Step' },
  { path: '/practice', title: 'Practice · Stack Step' },
  { path: '/practice/quiz', title: 'Mixed quiz · Stack Step' },
  { path: '/practice/rip', title: 'Practice: Where is rip? · Stack Step' },
  { path: '/practice/weak', title: 'Practice my weak spots · Stack Step' },
  { path: '/cheatsheet', title: 'Cheat sheet · Stack Step' },
  { path: '/progress', title: 'Progress · Stack Step' },
  { path: '/about', title: 'About · Stack Step' },
] as const

const NAV_LINKS = [
  { name: 'Stepper', path: '/stepper' },
  { name: 'Learn', path: '/learn' },
  { name: 'Practice', path: '/practice' },
  { name: 'Cheat sheet', path: '/cheatsheet' },
  { name: 'Progress', path: '/progress' },
  { name: 'About', path: '/about' },
] as const

const DARK = /(^|\s)dark(\s|$)/

/**
 * The page of the address bar is on screen: not the page before it, and not nothing.
 * Use it after a link was followed, before the test goes on with the new page.
 */
async function expectPageIsShown(page: Page): Promise<void> {
  // The browser tells the app about a new address a moment after the address changes.
  // Let that happen first.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  await expect(page.locator('main#main:not([aria-busy])')).toHaveCount(1)
  await expect(page.locator('h1')).toHaveCount(1)
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`/#${path}`)
  await expectPageIsShown(page)
}

/**
 * Decides which requests a test stands in the way of: the script file of one page.
 * 'AboutPage' is '/src/features/about/AboutPage.tsx' on the dev server and
 * '/assets/AboutPage-<letters>.js' in the built site.
 */
function pageFile(name: string): (url: URL) => boolean {
  const file = new RegExp(`/${name}(\\.tsx|-[\\w-]+\\.js)$`)
  return (url) => file.test(url.pathname)
}

/**
 * One of the three big links of the home page, found by its title. Its name is the title
 * and then its caption ("Learn 14 short lessons, one idea each."): every visible word.
 */
function homeCard(page: Page, title: string): Locator {
  return page.getByRole('main').getByRole('link', { name: new RegExp(`^${title} [A-Z0-9]`) })
}

/**
 * The place of the shell's own "Loading…" message. It is always in the page; it holds the
 * message only while the page of the address bar is still downloading.
 */
function loadingMessage(page: Page): Locator {
  return page.locator('#page-loading-message')
}

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768
}

function header(page: Page): Locator {
  return page.getByRole('banner')
}

function menuButton(page: Page): Locator {
  return header(page).getByRole('button', { name: 'Menu' })
}

/** A link of the main menu. On a phone the menu is opened first. */
async function navLink(page: Page, name: string): Promise<Locator> {
  if (isPhone(page) && (await menuButton(page).getAttribute('aria-expanded')) !== 'true') {
    await menuButton(page).click()
  }
  return page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name, exact: true })
}

test.describe('home page', () => {
  test('shows one heading, one sentence and the three big links', async ({ page }) => {
    await open(page, '/')
    const main = page.getByRole('main')

    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      'Learn x86-64 assembly one step at a time',
    )

    const description = main.locator('h1 + p')
    await expect(description).toContainText('Stack Step runs your program one line at a time')
    const text = (await description.innerText()).trim()
    expect(text.endsWith('.')).toBe(true)
    expect(text.match(/[.!?]/g), 'the description is exactly one sentence').toHaveLength(1)

    for (const [name, href] of [
      ['Step Through Code', '#/stepper'],
      ['Learn', '#/learn'],
      ['Practice', '#/practice'],
    ]) {
      const link = homeCard(page, name)
      await expect(link).toBeVisible()
      await expect(link).toHaveAttribute('href', href)
    }
    // The name of each card is every word it shows, the title first (WCAG 2.5.3).
    await expect(homeCard(page, 'Learn')).toHaveAccessibleName(
      /^Learn \d+ short lessons, one idea each\.$/,
    )
    await expect(homeCard(page, 'Step Through Code')).toHaveAccessibleName(
      'Step Through Code Open the stepper with your code.',
    )
    // The three big links are the first links of the page region, in this order.
    const firstThree = await main
      .getByRole('link')
      .evaluateAll((links) => links.slice(0, 3).map((link) => link.getAttribute('href')))
    expect(firstThree).toEqual(['#/stepper', '#/learn', '#/practice'])
  })

  for (const { name, path, title } of [
    { name: 'Step Through Code', path: '/stepper', title: 'Stepper · Stack Step' },
    { name: 'Learn', path: '/learn', title: 'Learn · Stack Step' },
    { name: 'Practice', path: '/practice', title: 'Practice · Stack Step' },
  ]) {
    test(`the "${name}" link opens ${path}`, async ({ page }) => {
      await open(page, '/')
      await homeCard(page, name).click()
      await expect(page).toHaveURL(new RegExp(`#${path}$`))
      await expect(page).toHaveTitle(title)
      await expect(page.locator('h1')).toHaveCount(1)
    })
  }

  test('has smaller links to the cheat sheet and to the progress page', async ({ page }) => {
    await open(page, '/')
    const main = page.getByRole('main')
    await expect(main.getByRole('link', { name: 'Open the cheat sheet' })).toHaveAttribute(
      'href',
      '#/cheatsheet',
    )
    // "Cheat sheet" is an idiom: the page says once, in plain words, what it is.
    await expect(main.getByText('A one-page summary that you can print.')).toBeVisible()
    await expect(main.getByRole('link', { name: 'See your progress' })).toHaveAttribute(
      'href',
      '#/progress',
    )
  })

  test('all of the cheat sheet link takes a tap, also where the words under it come close', async ({
    page,
  }) => {
    await open(page, '/')
    const link = page.getByRole('main').getByRole('link', { name: 'Open the cheat sheet' })
    // Below the three big links on a phone: bring it onto the screen first.
    await link.scrollIntoViewIfNeeded()
    const box = await link.boundingBox()
    if (box === null) throw new Error('The link is not on screen.')
    expect(box.height).toBeGreaterThanOrEqual(44)
    // What a finger hits along the bottom edge of the link is the link itself.
    const hits = await page.evaluate(
      ({ x, y, width, height }) =>
        [0.25, 0.5, 0.75].map((share) => {
          const target = document.elementFromPoint(x + width * share, y + height - 2)
          return target?.closest('a')?.getAttribute('href') ?? target?.tagName ?? 'nothing'
        }),
      box,
    )
    expect(hits).toEqual(['#/cheatsheet', '#/cheatsheet', '#/cheatsheet'])
  })

  test('the three big links are big enough for a thumb', async ({ page }) => {
    await open(page, '/')
    for (const name of ['Step Through Code', 'Learn', 'Practice']) {
      const box = await homeCard(page, name).boundingBox()
      expect(box?.height ?? 0, `"${name}" is at least 72 px tall`).toBeGreaterThanOrEqual(72)
      expect(box?.width ?? 0, `"${name}" is at least 200 px wide`).toBeGreaterThanOrEqual(200)
    }
  })
})

test.describe('every route', () => {
  for (const { path, title } of ROUTES) {
    test(`${path} loads with one h1, its tab title, no errors and no sideways scrolling`, async ({
      page,
    }) => {
      const errors = watchForErrors(page)
      await open(page, path)

      await expect(page.locator('h1')).toBeVisible()
      await expect(page).toHaveTitle(title)
      await expectNoSidewaysScroll(page)

      // The landmarks of the frame are on every page.
      await expect(page.getByRole('banner')).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
      await expect(page.getByRole('main')).toBeVisible()
      await expect(page.getByRole('contentinfo')).toBeVisible()

      expect(errors, 'nothing is reported in the browser console').toEqual([])
    })
  }

  test('a query after the route does not change the page', async ({ page }) => {
    await open(page, '/stepper?x=1')
    await expect(page).toHaveTitle('Stepper · Stack Step')
    await open(page, '/learn/mov?from=home')
    await expect(page).toHaveTitle('mov: copy a value · Stack Step')
  })

  test('an address typed a little differently still opens the page', async ({ page }) => {
    // No slash after the '#'.
    await open(page, 'about')
    await expect(page).toHaveTitle('About · Stack Step')
    // A slash at the end.
    await open(page, '/progress/')
    await expect(page).toHaveTitle('Progress · Stack Step')
    // A letter written as an escape. The menu knows the page too.
    await open(page, '/%61bout')
    await expect(page).toHaveTitle('About · Stack Step')
    await expect(await navLink(page, 'About')).toHaveAttribute('aria-current', 'page')
  })

  test('an address with no hash at all is the home page', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('Learn x86-64 assembly one step at a time')
    await expect(page).toHaveTitle(HOME_TITLE)
  })
})

test.describe('unknown routes', () => {
  for (const path of ['/nope', '/learn/mov/extra', '/practice/quiz/1', '/Stepper']) {
    test(`${path} shows the Not found page`, async ({ page }) => {
      const errors = watchForErrors(page)
      await open(page, path)
      const main = page.getByRole('main')

      await expect(main.getByRole('heading', { level: 1 })).toHaveText('Page not found')
      await expect(page).toHaveTitle('Page not found · Stack Step')
      await expect(main.getByText(path, { exact: true })).toBeVisible()
      await expect(main.getByRole('link', { name: 'Go to the home page' })).toHaveAttribute(
        'href',
        '#/',
      )
      await expect(main.getByRole('link', { name: 'Go to the stepper' })).toHaveAttribute(
        'href',
        '#/stepper',
      )
      await expectNoSidewaysScroll(page)
      expect(errors).toEqual([])
    })
  }

  test('a very long unknown address does not make the page scroll sideways', async ({ page }) => {
    await open(page, `/${'no-such-page-'.repeat(12)}`)
    await expect(page.locator('h1')).toHaveText('Page not found')
    await expectNoSidewaysScroll(page)
  })

  test('the link to the home page leaves the Not found page', async ({ page }) => {
    await open(page, '/nope')
    await page.getByRole('main').getByRole('link', { name: 'Go to the home page' }).click()
    await expect(page.locator('h1')).toHaveText('Learn x86-64 assembly one step at a time')
  })

  test('an address with escapes is shown the way it reads', async ({ page }) => {
    await open(page, '/caf%C3%A9')
    await expect(page.locator('h1')).toHaveText('Page not found')
    await expect(page.getByRole('main').getByText('/café', { exact: true })).toBeVisible()
  })

  test('a lesson that does not exist links to the list of lessons', async ({ page }) => {
    const errors = watchForErrors(page)
    await open(page, '/learn/not-a-lesson')
    const main = page.getByRole('main')

    await expect(main.getByRole('heading', { level: 1 })).toHaveText('There is no such lesson')
    await expect(page).toHaveTitle('No such lesson · Stack Step')
    await expect(main.getByRole('link', { name: 'See all lessons' })).toHaveAttribute(
      'href',
      '#/learn',
    )
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })

  test('a practice topic that does not exist links to the practice hub', async ({ page }) => {
    const errors = watchForErrors(page)
    await open(page, '/practice/not-a-topic')
    const main = page.getByRole('main')

    await expect(main.getByRole('heading', { level: 1 })).toHaveText(
      'This practice topic does not exist',
    )
    await expect(page).toHaveTitle('No such practice topic · Stack Step')
    await expect(main.getByRole('link', { name: 'See all practice topics' })).toHaveAttribute(
      'href',
      '#/practice',
    )
    await expectNoSidewaysScroll(page)
    expect(errors).toEqual([])
  })
})

test.describe('about page', () => {
  test('says what the emulator is and what it is not', async ({ page }) => {
    await open(page, '/about')
    const main = page.getByRole('main')
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('About Stack Step')
    await expect(main.getByText('teaching subset').first()).toBeVisible()
    await expect(main.getByText('not a full CPU')).toBeVisible()
    for (const heading of [
      'What the emulator supports',
      'What the emulator does not support',
      'Where it differs from a real machine',
      'Lessons and practice problems',
      'Your data',
    ]) {
      await expect(main.getByRole('heading', { level: 2, name: heading })).toBeVisible()
    }
  })

  test('heading levels never skip a level', async ({ page }) => {
    await open(page, '/about')
    const levels = await page
      .locator('h1, h2, h3, h4, h5, h6')
      .evaluateAll((headings) => headings.map((heading) => Number(heading.tagName.slice(1))))
    expect(levels[0]).toBe(1)
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1], `heading ${i + 1} follows its level`).toBeLessThanOrEqual(1)
    }
  })
})

test.describe('navigation', () => {
  test('the tab title changes after a navigation, and back again', async ({ page }) => {
    await open(page, '/')
    await expect(page).toHaveTitle(HOME_TITLE)

    await (await navLink(page, 'About')).click()
    await expect(page).toHaveURL(/#\/about$/)
    await expect(page).toHaveTitle('About · Stack Step')

    await header(page).getByRole('link', { name: 'Stack Step', exact: true }).click()
    await expect(page).toHaveTitle(HOME_TITLE)
  })

  test('every link of the main menu opens its page', async ({ page }) => {
    await open(page, '/')
    for (const { name, path } of NAV_LINKS) {
      const link = await navLink(page, name)
      await expect(link).toHaveAttribute('href', `#${path}`)
      await link.click()
      await expect(page).toHaveURL(new RegExp(`#${path}$`))
      await expectPageIsShown(page)
    }
  })

  test('the link of the current page is marked, also on pages below it', async ({ page }) => {
    await open(page, '/learn/mov')
    const nav = page.getByRole('navigation', { name: 'Main' })
    await expect(await navLink(page, 'Learn')).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('[aria-current]')).toHaveCount(1)

    // The mark is a bar, so it does not depend on color alone.
    const bars = (await navLink(page, 'Learn')).locator('span[aria-hidden="true"]')
    await expect(bars.filter({ visible: true })).toHaveCount(1)

    await open(page, '/')
    await expect(nav.locator('[aria-current]')).toHaveCount(0)
    await expect(
      header(page).getByRole('link', { name: 'Stack Step', exact: true }),
    ).toHaveAttribute('aria-current', 'page')
  })

  test('after a navigation, focus is on the page region and the page is at the top', async ({
    page,
  }) => {
    await open(page, '/about')
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

    await page.getByRole('contentinfo').getByRole('link', { name: 'About Stack Step' }).focus()
    await page.getByRole('main').getByRole('link', { name: 'Progress page' }).click()

    await expect(page).toHaveURL(/#\/progress$/)
    await expect(page.locator('main#main')).toBeFocused()
    expect(await page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('on the first load, focus is not moved', async ({ page }) => {
    await open(page, '/about')
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
  })

  test('the Back and Forward buttons of the browser move between pages', async ({ page }) => {
    await open(page, '/')
    await homeCard(page, 'Learn').click()
    await expect(page).toHaveTitle('Learn · Stack Step')
    await (await navLink(page, 'About')).click()
    await expect(page).toHaveTitle('About · Stack Step')

    await page.goBack()
    await expect(page).toHaveURL(/#\/learn$/)
    await expect(page).toHaveTitle('Learn · Stack Step')
    await page.goBack()
    await expect(page).toHaveTitle(HOME_TITLE)
    await page.goForward()
    await expect(page).toHaveTitle('Learn · Stack Step')
    await expect(page.locator('h1')).toHaveCount(1)
  })
})

test.describe('moving from page to page', () => {
  /** What the page region showed since the watch began. */
  interface PageRegionWatch {
    /** How often the page region changed and had no <h1> afterwards. */
    timesWithoutPage: number
    /** How often it held the "Loading…" stand-in of the app (src/App.tsx) instead of a page. */
    timesWithStandIn: number
  }

  /** Note every change of the page region from now on. */
  async function watchPageRegion(page: Page): Promise<void> {
    await page.evaluate(() => {
      const main = document.getElementById('main')
      if (main === null) throw new Error('no page region')
      const watch = { timesWithoutPage: 0, timesWithStandIn: 0 }
      Object.assign(window, { pageRegionWatch: watch })
      new MutationObserver(() => {
        if (main.querySelector('h1') === null) watch.timesWithoutPage += 1
        if (main.querySelector('[data-page-stand-in]') !== null) watch.timesWithStandIn += 1
      }).observe(main, { childList: true, subtree: true })
    })
  }

  function pageRegionWatch(page: Page): Promise<PageRegionWatch> {
    return page.evaluate(
      () => (window as unknown as { pageRegionWatch: PageRegionWatch }).pageRegionWatch,
    )
  }

  test('the old page stays until the new page is ready: the page region is never empty', async ({
    page,
  }) => {
    const errors = watchForErrors(page)
    await open(page, '/')
    await watchPageRegion(page)

    // Each of these pages is opened for the first time, so its file must be downloaded.
    for (const { name, path } of NAV_LINKS) {
      await (await navLink(page, name)).click()
      await expect(page).toHaveURL(new RegExp(`#${path}$`))
      await expectPageIsShown(page)
      await expect(page.locator('main#main')).toBeFocused()
    }
    await page.getByRole('contentinfo').getByRole('link', { name: 'About Stack Step' }).click()
    await header(page).getByRole('link', { name: 'Stack Step', exact: true }).click()
    await expect(page).toHaveTitle(HOME_TITLE)

    expect(await pageRegionWatch(page)).toEqual({ timesWithoutPage: 0, timesWithStandIn: 0 })
    expect(errors).toEqual([])
  })

  test('on a direct link, no loading stand-in is put where the page will be', async ({ page }) => {
    // Watch from before the site starts.
    await page.addInitScript(() => {
      const seen = { standIns: 0 }
      Object.assign(window, { firstLoadWatch: seen })
      new MutationObserver(() => {
        if (document.querySelector('#main [data-page-stand-in]') !== null) seen.standIns += 1
      }).observe(document, { childList: true, subtree: true })
    })
    await open(page, '/about')
    await expect(page.locator('h1')).toHaveText('About Stack Step')
    const seen = await page.evaluate(
      () => (window as unknown as { firstLoadWatch: { standIns: number } }).firstLoadWatch,
    )
    expect(seen.standIns).toBe(0)
    // Nothing is loading any more: the place for the message is empty.
    await expect(loadingMessage(page)).toHaveAttribute('role', 'status')
    await expect(loadingMessage(page)).toHaveText('')
  })

  test('while a page file downloads, the old page stays and a message says "Loading…"', async ({
    page,
  }) => {
    await page.route(pageFile('AboutPage'), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await route.continue()
    })
    await open(page, '/')
    await watchPageRegion(page)
    const main = page.locator('main#main')
    const message = loadingMessage(page)
    await expect(message).toHaveText('')

    await (await navLink(page, 'About')).click()

    // The address and the menu follow at once; the page and the tab name wait.
    await expect(page).toHaveURL(/#\/about$/)
    await expect(main).toHaveAttribute('aria-busy', 'true')
    await expect(message).toHaveText('Loading…')
    await expect(message).toBeVisible()
    await expect(page.locator('h1')).toHaveText('Learn x86-64 assembly one step at a time')
    await expect(page).toHaveTitle(HOME_TITLE)
    // The message is not inside the page region, which is marked busy.
    expect(await message.evaluate((element) => element.closest('main') === null)).toBe(true)

    // Then the page arrives.
    await expect(page.locator('h1')).toHaveText('About Stack Step')
    await expect(page).toHaveTitle('About · Stack Step')
    await expect(main).not.toHaveAttribute('aria-busy')
    await expect(message).toHaveText('')
    await expect(main).toBeFocused()
    expect(await pageRegionWatch(page)).toEqual({ timesWithoutPage: 0, timesWithStandIn: 0 })
  })

  test('on a direct link to a slow page, the frame is there at once with the message', async ({
    page,
  }) => {
    await page.route(pageFile('AboutPage'), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await route.continue()
    })
    await page.goto('/#/about')

    await expect(page.getByRole('banner')).toBeVisible()
    await expect(page.getByRole('contentinfo')).toBeVisible()
    await expect(page.locator('main#main')).toHaveAttribute('aria-busy', 'true')
    await expect(loadingMessage(page)).toHaveText('Loading…')
    await expect(page).toHaveTitle('About · Stack Step')
    await expect(page.locator('h1')).toHaveCount(0)

    await expect(page.locator('h1')).toHaveText('About Stack Step')
    await expect(loadingMessage(page)).toHaveText('')
    // The first page does not take the keyboard focus.
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
  })

  test('a page file that could not be downloaded is asked for again on the next visit', async ({
    page,
  }) => {
    let offline = true
    let requests = 0
    await page.route(pageFile('StepperPage'), async (route) => {
      requests += 1
      if (offline) await route.abort('internetdisconnected')
      else await route.continue()
    })
    await open(page, '/')
    const main = page.getByRole('main')
    const card = homeCard(page, 'Step Through Code')

    await card.click()
    await expect(page.locator('h1')).toHaveText('This page did not load')
    await expect(main.getByRole('alert')).toContainText('Check your internet connection.')
    await expect(page.locator('main#main')).not.toHaveAttribute('aria-busy')
    await expect(page.locator('main#main')).toBeFocused()
    const afterFirstVisit = requests
    expect(afterFirstVisit).toBeGreaterThan(0)

    // While the message is on screen, the site does not keep asking by itself.
    await page.waitForTimeout(500)
    expect(requests).toBe(afterFirstVisit)

    // Still no connection: the next visit asks again, and fails again.
    await main.getByRole('link', { name: 'Go to the home page' }).click()
    await expect(page.locator('h1')).toHaveText('Learn x86-64 assembly one step at a time')
    await card.click()
    await expect(page.locator('h1')).toHaveText('This page did not load')
    const afterSecondVisit = requests
    expect(afterSecondVisit).toBeGreaterThan(afterFirstVisit)
    await page.waitForTimeout(500)
    expect(requests).toBe(afterSecondVisit)

    // The connection is back: the third visit asks again and gets the page.
    offline = false
    await main.getByRole('link', { name: 'Go to the home page' }).click()
    await expect(page.locator('h1')).toHaveText('Learn x86-64 assembly one step at a time')
    await card.click()
    await expect(page).toHaveTitle('Stepper · Stack Step')
    await expectPageIsShown(page)
    await expect(page.locator('h1')).not.toHaveText('This page did not load')
    await expect(main.getByRole('alert')).toHaveCount(0)
    expect(requests).toBeGreaterThan(afterSecondVisit)
  })

  test('the first page can fail too, and Back tries it again', async ({ page }) => {
    let offline = true
    await page.route(pageFile('AboutPage'), async (route) => {
      if (offline) await route.abort('internetdisconnected')
      else await route.continue()
    })
    await page.goto('/#/about')
    await expect(page.locator('h1')).toHaveText('This page did not load')

    offline = false
    await page.getByRole('main').getByRole('link', { name: 'Go to the home page' }).click()
    await expect(page.locator('h1')).toHaveText('Learn x86-64 assembly one step at a time')
    await page.goBack()
    await expect(page.locator('h1')).toHaveText('About Stack Step')
  })

  test('a page with a mistake in it does not blame the internet', async ({ page }) => {
    await page.route(pageFile('ProgressPage'), (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: 'export default function ProgressPage() { throw new Error("a mistake in the page") }',
      }),
    )
    await open(page, '/progress')
    const alert = page.getByRole('main').getByRole('alert')

    await expect(page.locator('h1')).toHaveText('This page has a problem')
    await expect(alert).toContainText('You did nothing wrong.')
    await expect(alert).not.toContainText('internet')
    await expect(alert.getByRole('button', { name: 'Load the page again' })).toBeVisible()

    // The frame still works.
    await alert.getByRole('link', { name: 'Go to the home page' }).click()
    await expect(page.locator('h1')).toHaveText('Learn x86-64 assembly one step at a time')
  })
})

test.describe('your place on a page', () => {
  const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY))

  /** Scroll the About page to its link to the Progress page; returns how far that is. */
  async function scrollToProgressLink(page: Page): Promise<number> {
    await page
      .getByRole('main')
      .getByRole('link', { name: 'Progress page' })
      .scrollIntoViewIfNeeded()
    const y = await scrollY(page)
    expect(y, 'the About page is long enough to scroll').toBeGreaterThan(500)
    return y
  }

  test('Back returns to the place you left, and a link opens a page at the top', async ({
    page,
  }) => {
    await open(page, '/about')
    const place = await scrollToProgressLink(page)

    // A link: the new page starts at the top.
    await page.getByRole('main').getByRole('link', { name: 'Progress page' }).click()
    await expect(page).toHaveTitle('Progress · Stack Step')
    expect(await scrollY(page)).toBe(0)

    // Back: the old page, at the old place, with the focus on the page region.
    await page.goBack()
    await expect(page).toHaveTitle('About · Stack Step')
    await expect.poll(() => scrollY(page)).toBe(place)
    await expect(page.locator('main#main')).toBeFocused()

    // Forward: the Progress page was at the top.
    await page.goForward()
    await expect(page).toHaveTitle('Progress · Stack Step')
    await expect.poll(() => scrollY(page)).toBe(0)

    // And Back once more.
    await page.goBack()
    await expect(page).toHaveTitle('About · Stack Step')
    await expect.poll(() => scrollY(page)).toBe(place)
  })

  test('a link to a page you saw before opens it at the top again', async ({ page }) => {
    await open(page, '/about')
    await scrollToProgressLink(page)
    await page.getByRole('main').getByRole('link', { name: 'Progress page' }).click()
    await expect(page).toHaveTitle('Progress · Stack Step')

    // Not the Back button: a link. That is a new visit.
    await (await navLink(page, 'About')).click()
    await expect(page).toHaveTitle('About · Stack Step')
    expect(await scrollY(page)).toBe(0)
  })

  test('a reload keeps the place', async ({ page }) => {
    await open(page, '/about')
    const place = await scrollToProgressLink(page)

    await page.reload()
    await expect(page.locator('h1')).toHaveText('About Stack Step')
    await expect.poll(() => scrollY(page)).toBe(place)
  })

  test('a change of the query alone does not move the page or the focus', async ({ page }) => {
    await open(page, '/about')
    const place = await scrollToProgressLink(page)
    await page.evaluate(() => {
      window.location.hash = '#/about?x=1'
    })
    await expect(page).toHaveURL(/#\/about\?x=1$/)
    await expectPageIsShown(page)
    expect(await scrollY(page)).toBe(place)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('BODY')
  })
})

test.describe('theme', () => {
  test('the switch changes the theme, and the choice survives a reload', async ({ page }) => {
    await open(page, '/')
    const html = page.locator('html')
    await expect(html).not.toHaveClass(DARK)

    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await expect(html).toHaveClass(DARK)
    await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible()

    await page.reload()
    await expect(html).toHaveClass(DARK)

    await page.getByRole('button', { name: 'Switch to light theme' }).click()
    await expect(html).not.toHaveClass(DARK)
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible()

    await page.reload()
    await expect(html).not.toHaveClass(DARK)
  })

  test('the theme really changes the colors of the page', async ({ page }) => {
    await open(page, '/')
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const light = await background()
    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await expect.poll(background).not.toBe(light)
  })

  test('the theme stays when you open another page', async ({ page }) => {
    await open(page, '/')
    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await (await navLink(page, 'About')).click()
    await expect(page).toHaveTitle('About · Stack Step')
    await expect(page.locator('html')).toHaveClass(DARK)
  })

  test.describe('on a device that prefers dark', () => {
    test.use({ colorScheme: 'dark' })

    test('the site starts dark, and a saved choice wins over the device', async ({ page }) => {
      await open(page, '/')
      const html = page.locator('html')
      await expect(html).toHaveClass(DARK)

      await page.getByRole('button', { name: 'Switch to light theme' }).click()
      await expect(html).not.toHaveClass(DARK)
      await page.reload()
      await expect(html).not.toHaveClass(DARK)
    })
  })
})

test.describe('keyboard', () => {
  test('Tab reaches the skip link first, and the skip link moves focus to the page region', async ({
    page,
  }) => {
    await open(page, '/about')
    await page.keyboard.press('Tab')

    const skipLink = page.getByRole('link', { name: 'Skip to main content' })
    await expect(skipLink).toBeFocused()
    await expect(skipLink).toBeInViewport()

    await page.keyboard.press('Enter')
    await expect(page.locator('main#main')).toBeFocused()
    // The skip link must not change the route.
    await expect(page).toHaveURL(/#\/about$/)
    await expect(page.locator('h1')).toHaveText('About Stack Step')
  })

  test('the skip link is out of sight until it has focus', async ({ page }) => {
    await open(page, '/')
    await expect(page.getByRole('link', { name: 'Skip to main content' })).not.toBeInViewport()
  })

  test('the skip link is inside the header, so everything belongs to a landmark', async ({
    page,
  }) => {
    await open(page, '/about')
    await expect(
      page.getByRole('banner').getByRole('link', { name: 'Skip to main content' }),
    ).toHaveCount(1)
    // Nothing with text stands outside the landmarks (the empty place for "Loading…" aside).
    const outside = await page.evaluate(() => {
      const landmarks = 'header, nav, main, footer, [role="status"], dialog'
      return [...document.body.querySelectorAll('a, button, p, h1, h2, span')]
        .filter((element) => element.closest(landmarks) === null)
        .filter((element) => (element.textContent ?? '').trim() !== '')
        .map((element) => element.outerHTML.slice(0, 80))
    })
    expect(outside).toEqual([])
  })

  test('Tab moves through the header in the order it is shown', async ({ page }) => {
    await open(page, '/')
    const focusedName = () =>
      page.evaluate(() => {
        const element = document.activeElement
        return element?.getAttribute('aria-label') ?? element?.textContent?.trim() ?? ''
      })

    const expected = isPhone(page)
      ? ['Skip to main content', 'Stack Step', 'Menu', 'Switch to dark theme']
      : [
          'Skip to main content',
          'Stack Step',
          ...NAV_LINKS.map((link) => link.name),
          'Switch to dark theme',
        ]
    for (const name of expected) {
      await page.keyboard.press('Tab')
      expect(await focusedName()).toBe(name)
    }
    // The next stop is the first big link of the page.
    await page.keyboard.press('Tab')
    await expect(homeCard(page, 'Step Through Code')).toBeFocused()
  })
})

test.describe('phone menu', () => {
  test.beforeEach(({ page }) => {
    test.skip(!isPhone(page), 'The menu button exists only on screens narrower than 768 px.')
  })

  test('the menu button opens and closes the list of pages', async ({ page }) => {
    await open(page, '/')
    const button = menuButton(page)
    const nav = page.getByRole('navigation', { name: 'Main' })
    const learn = nav.getByRole('link', { name: 'Learn', exact: true })

    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(learn).toBeHidden()

    // `aria-controls` points at the list.
    const listId = await button.getAttribute('aria-controls')
    expect(listId).toBeTruthy()
    await expect(page.locator(`[id="${listId}"]`)).toHaveCount(1)

    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    for (const { name } of NAV_LINKS) {
      await expect(nav.getByRole('link', { name, exact: true })).toBeVisible()
    }
    await expectNoSidewaysScroll(page)

    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(learn).toBeHidden()
  })

  test('the menu closes after a navigation', async ({ page }) => {
    await open(page, '/')
    const button = menuButton(page)
    await button.click()
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'About', exact: true })
      .click()

    await expect(page).toHaveURL(/#\/about$/)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(
      page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Learn', exact: true }),
    ).toBeHidden()
    await expect(page.locator('main#main')).toBeFocused()
  })

  test('the menu also closes when you choose the page you are on', async ({ page }) => {
    await open(page, '/about')
    const button = menuButton(page)
    await button.click()
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'About', exact: true })
      .click()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    // The link is hidden now. The keyboard focus is on the page region, not lost.
    await expect(page.locator('main#main')).toBeFocused()
    await expect(page).toHaveURL(/#\/about$/)
  })

  test('a page that arrives late does not close the menu that was opened again', async ({
    page,
  }) => {
    await page.route(pageFile('AboutPage'), async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1200))
      await route.continue()
    })
    await open(page, '/')
    const button = menuButton(page)
    const nav = page.getByRole('navigation', { name: 'Main' })

    await button.click()
    await nav.getByRole('link', { name: 'About', exact: true }).click()
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('main#main')).toHaveAttribute('aria-busy', 'true')

    // The page is slow. The student opens the menu again to choose something else.
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')

    // The About page arrives. It must not take the focus (that would close the list).
    await expect(page.locator('h1')).toHaveText('About Stack Step')
    await expect(page.locator('main#main')).not.toHaveAttribute('aria-busy')
    await expect(button).toHaveAttribute('aria-expanded', 'true')
    await expect(nav.getByRole('link', { name: 'Learn', exact: true })).toBeVisible()
    await expect(page.locator('main#main')).not.toBeFocused()

    // The list still works.
    await nav.getByRole('link', { name: 'Learn', exact: true }).click()
    await expect(page).toHaveTitle('Learn · Stack Step')
    await expect(page.locator('main#main')).toBeFocused()
  })

  test('a tap outside the menu only closes it: what is under the finger is not opened', async ({
    page,
  }) => {
    await open(page, '/')
    const button = menuButton(page)
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')

    // The "Learn" card is in view below the open list.
    const card = homeCard(page, 'Learn')
    const box = await card.boundingBox()
    if (box === null) throw new Error('the Learn card is not on screen')
    const menuList = await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('list')
      .boundingBox()
    const y = box.y + box.height / 2
    expect(y, 'the tap is below the open list').toBeGreaterThan(
      (menuList?.y ?? 0) + (menuList?.height ?? 0),
    )

    await page.touchscreen.tap(box.x + box.width / 2, y)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    // Still the home page.
    await expect(page).toHaveURL(/#\/$/)
    await expect(page).toHaveTitle(HOME_TITLE)

    // With the list closed, the same tap opens the card.
    await page.touchscreen.tap(box.x + box.width / 2, y)
    await expect(page).toHaveURL(/#\/learn$/)
  })

  test('Escape closes the menu and puts focus back on the button', async ({ page }) => {
    await open(page, '/')
    const button = menuButton(page)
    await button.click()
    await page.keyboard.press('Tab')
    await expect(
      page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Stepper', exact: true }),
    ).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(button).toBeFocused()
  })

  test('a tap outside the menu closes it', async ({ page }) => {
    // The Not found page is short, so the area under its card is empty.
    await open(page, '/nope')
    const button = menuButton(page)
    await button.click()
    await expect(button).toHaveAttribute('aria-expanded', 'true')

    const main = await page.getByRole('main').boundingBox()
    const bottomOfMain = (main?.y ?? 0) + (main?.height ?? 0)
    await page.touchscreen.tap(180, bottomOfMain - 24)
    await expect(button).toHaveAttribute('aria-expanded', 'false')
    await expect(page).toHaveURL(/#\/nope$/)
    // As after Escape, the keyboard focus is back on the button.
    await expect(button).toBeFocused()
  })

  test('the menu button and the theme switch are big enough for a thumb', async ({ page }) => {
    await open(page, '/')
    for (const control of [menuButton(page), page.getByRole('button', { name: /^Switch to/ })]) {
      const box = await control.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    }
  })
})

test.describe('very large text on a phone', () => {
  test.beforeEach(({ page }) => {
    test.skip(!isPhone(page), 'A wide screen has room for large text.')
  })

  /** Set the text size of the browser itself (its "font size" setting), in px. 16 is normal. */
  async function setBrowserTextSize(page: Page, size: number): Promise<void> {
    const session = await page.context().newCDPSession(page)
    await session.send('Page.setFontSizes', {
      fontSizes: { standard: size, fixed: Math.round(size * 0.8125) },
    })
  }

  for (const size of [20, 24, 32]) {
    test(`at ${size} px (${Math.round((size / 16) * 100)} %) nothing scrolls sideways and the header stays whole`, async ({
      page,
    }) => {
      await setBrowserTextSize(page, size)
      for (const path of ['/', '/about', '/nope']) {
        await open(page, path)
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
          `${size}px`,
        )
        await expectNoSidewaysScroll(page)

        // The brand, the menu button and the theme switch are all on the screen …
        for (const control of [
          header(page).getByRole('link', { name: 'Stack Step', exact: true }),
          menuButton(page),
          page.getByRole('button', { name: /^Switch to/ }),
        ]) {
          const box = await control.boundingBox()
          expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
          expect((box?.x ?? 0) + (box?.width ?? 999)).toBeLessThanOrEqual(360)
        }
      }
      // … and the menu still works.
      await menuButton(page).click()
      await expect(await navLink(page, 'About')).toBeVisible()
      await expectNoSidewaysScroll(page)
    })
  }

  test('a screen as narrow as 240 px (a phone zoomed to 150 %) does not scroll sideways', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 240, height: 500 })
    for (const path of ['/', '/about', '/nope']) {
      await open(page, path)
      await expectNoSidewaysScroll(page)
    }
    // The word "Menu" is hidden to make room, but the button keeps its name.
    await expect(menuButton(page)).toBeVisible()
  })
})

test.describe('wide screens', () => {
  test.beforeEach(({ page }) => {
    test.skip(isPhone(page), 'The row of links exists only on screens of 768 px and wider.')
  })

  test('the pages are a row of links in the header, with no menu button', async ({ page }) => {
    await open(page, '/')
    await expect(menuButton(page)).toBeHidden()
    const nav = page.getByRole('navigation', { name: 'Main' })
    for (const { name, path } of NAV_LINKS) {
      const link = nav.getByRole('link', { name, exact: true })
      await expect(link).toBeVisible()
      await expect(link).toHaveAttribute('href', `#${path}`)
    }
  })

  test('the links still fit on one line at 768 px', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 })
    await open(page, '/')
    await expect(menuButton(page)).toBeHidden()
    const nav = page.getByRole('navigation', { name: 'Main' })
    const tops = await nav
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().top)))
    expect(new Set(tops).size, 'all links are on the same line').toBe(1)
    const heights = await nav
      .getByRole('link')
      .evaluateAll((links) => links.map((link) => Math.round(link.getBoundingClientRect().height)))
    expect(new Set(heights).size, 'no link wraps onto a second line').toBe(1)
    await expectNoSidewaysScroll(page)
  })
})

test.describe('the three big links of the home page', () => {
  const CARD_NAMES = ['Step Through Code', 'Learn', 'Practice'] as const

  function card(page: Page, name: string): Locator {
    return homeCard(page, name)
  }

  async function cardBoxes(page: Page) {
    const boxes = []
    for (const name of CARD_NAMES) {
      const box = await card(page, name).boundingBox()
      if (box === null) throw new Error(`the "${name}" link is not on screen`)
      boxes.push(box)
    }
    return boxes
  }

  for (const width of [360, 600, 768, 1023]) {
    test(`are a list of rows at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await open(page, '/')
      const [first, second, third] = await cardBoxes(page)
      expect(second.x).toBe(first.x)
      expect(third.x).toBe(first.x)
      expect(second.y).toBeGreaterThan(first.y + first.height)
      expect(third.y).toBeGreaterThan(second.y + second.height)
      await expectNoSidewaysScroll(page)
    })
  }

  for (const width of [1024, 1280]) {
    test(`stand side by side at ${width} px, all the same size, each caption on one line`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 })
      await open(page, '/')
      const [first, second, third] = await cardBoxes(page)
      expect(second.y).toBe(first.y)
      expect(third.y).toBe(first.y)
      expect(second.x).toBeGreaterThan(first.x + first.width)
      expect(third.x).toBeGreaterThan(second.x + second.width)
      expect(Math.round(second.height)).toBe(Math.round(first.height))
      expect(Math.round(third.height)).toBe(Math.round(first.height))
      await expectNoSidewaysScroll(page)

      // No card has a caption that breaks onto a second line while the others do not.
      for (const name of CARD_NAMES) {
        const lines = await card(page, name)
          .locator('p')
          .evaluate(
            (caption) =>
              caption.getBoundingClientRect().height /
              parseFloat(getComputedStyle(caption).lineHeight),
          )
        expect(lines, `the caption of "${name}" is one line`).toBeLessThan(1.5)
      }
    })
  }
})

test.describe('inline code', () => {
  /** Every code chip in the page region whose next (or previous) mark is on another line. */
  function marksApartFromTheirCode(page: Page): Promise<string[]> {
    return page.evaluate(() => {
      const main = document.getElementById('main')
      if (main === null) return ['no page region']
      const found: string[] = []
      const blockOf = (node: Node) =>
        (node instanceof Element ? node : node.parentElement)?.closest('li, p, dd, dt, td, th')
      const boxOfCharacter = (node: Node, offset: number) => {
        const range = document.createRange()
        range.setStart(node, offset)
        range.setEnd(node, offset + 1)
        return range.getBoundingClientRect()
      }
      for (const code of main.querySelectorAll('code')) {
        const chip = code.getBoundingClientRect()
        const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)

        walker.currentNode = code
        let after = walker.nextNode()
        while (after !== null && code.contains(after)) after = walker.nextNode()
        const textAfter = after?.nodeValue ?? ''
        if (after !== null && blockOf(after) === blockOf(code) && /^[,.;:!?)\]]/.test(textAfter)) {
          if (boxOfCharacter(after, 0).top > chip.bottom - 4) {
            found.push(`"${textAfter.slice(0, 8)}" starts a line after "${code.textContent}"`)
          }
        }

        walker.currentNode = code
        const before = walker.previousNode()
        const textBefore = before?.nodeValue ?? ''
        if (before !== null && blockOf(before) === blockOf(code) && /[([]$/.test(textBefore)) {
          if (boxOfCharacter(before, textBefore.length - 1).bottom < chip.top + 4) {
            found.push(`"${textBefore.slice(-8)}" ends a line before "${code.textContent}"`)
          }
        }
      }
      return found
    })
  }

  test('a comma or a period never starts a line after a piece of code', async ({ page }) => {
    const phone = isPhone(page)
    await open(page, '/about')
    await expect(page.getByRole('main').locator('code').first()).toBeVisible()

    // Every width of a phone, or a walk through the wider screens.
    const widths: number[] = []
    if (phone) for (let width = 320; width <= 430; width += 2) widths.push(width)
    else for (let width = 600; width <= 1280; width += 20) widths.push(width)

    for (const width of widths) {
      await page.setViewportSize({ width, height: 740 })
      expect(await marksApartFromTheirCode(page), `at ${width} px`).toEqual([])
      await expectNoSidewaysScroll(page)
    }
  })

  test('code that is wider than the line breaks inside itself and keeps its marks', async ({
    page,
  }) => {
    // The Not found page shows the address as code. Make it long, with a period after it.
    await open(page, `/${'a-very-long-address-'.repeat(8)}`)
    const code = page.getByRole('main').locator('code')
    await expect(code).toBeVisible()
    await code.evaluate((element) => element.after('.'))

    const lineHeight = await code.evaluate((element) =>
      parseFloat(getComputedStyle(element).lineHeight),
    )
    const box = await code.boundingBox()
    expect(box?.height ?? 0, 'the code takes more than one line').toBeGreaterThan(lineHeight * 1.5)
    await expectNoSidewaysScroll(page)
  })

  test('short code stays in one piece in a box sized to its text and in a table column', async ({
    page,
  }) => {
    // Seen before: an answer option made only of code ("push rbp" in a flex row) and code
    // in an auto-width table column were squeezed to one letter per line on phones.
    await open(page, '/about')
    const first = page.getByRole('main').locator('code').first()
    await expect(first).toBeVisible()
    const heights = await first.evaluate((sample) => {
      const copy = (text: string) => {
        const code = sample.cloneNode() as HTMLElement
        code.textContent = text
        return code
      }
      const row = document.createElement('label')
      row.style.cssText = 'display:flex;gap:8px;width:300px'
      const text = document.createElement('span')
      text.className = 'min-w-0'
      text.append(copy('push rbp'))
      row.append(document.createElement('input'), text)

      const table = document.createElement('table')
      table.style.width = '300px'
      const cells = table.insertRow().insertCell()
      cells.append(copy('rax'))
      table.rows[0]
        ?.insertCell()
        .append('A long sentence that would like all the room of the table.')

      sample.closest('main')?.prepend(row, table)
      const line = parseFloat(getComputedStyle(sample).lineHeight) * 1.5
      return [text, cells].map((box) => {
        const height = box.querySelector('code')?.getBoundingClientRect().height ?? 0
        return height <= line ? 'one line' : `${height} px tall`
      })
    })
    expect(heights).toEqual(['one line', 'one line'])
    await expectNoSidewaysScroll(page)
  })

  test('stays readable in a browser that does not know color-mix()', async ({ page }) => {
    // Such a browser skips every rule inside "@supports (color: color-mix(…))".
    // Do the same here: change those conditions to something no browser supports.
    let changed = 0
    await page.route(
      (url) => /index.*\.css/.test(url.pathname),
      async (route) => {
        const response = await route.fetch()
        const css = await response.text()
        const withoutColorMix = css.replace(
          /@supports\s*\(color:\s*color-mix\([^)]*\)\)/g,
          '@supports (color:no-such-function(red))',
        )
        if (withoutColorMix !== css) changed += 1
        await route.fulfill({ response, body: withoutColorMix })
      },
    )

    /** Elements that hold text or a drawing and whose own solid background has its color. */
    const unreadable = () =>
      page.evaluate(() => {
        const found: string[] = []
        for (const element of document.querySelectorAll<HTMLElement>('#main *')) {
          const hasOwnText = [...element.childNodes].some(
            (node) => node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').trim() !== '',
          )
          const holdsDrawing = element.querySelector(':scope > svg') !== null
          if (!hasOwnText && !holdsDrawing) continue
          const style = getComputedStyle(element)
          if (style.backgroundColor === style.color) {
            found.push(
              `<${element.tagName.toLowerCase()}> "${element.textContent.trim().slice(0, 20)}"`,
            )
          }
        }
        return found
      })

    for (const dark of [false, true]) {
      await open(page, '/about')
      if (dark) await page.getByRole('button', { name: 'Switch to dark theme' }).click()
      expect(changed, 'the style sheet has color-mix rules to switch off').toBeGreaterThan(0)

      const chip = page.getByRole('main').locator('code').first()
      const colors = await chip.evaluate((element) => {
        const style = getComputedStyle(element)
        return { text: style.color, background: style.backgroundColor }
      })
      // A see-through tint, not the solid text color.
      expect(colors.background).toMatch(/^rgba\(.*, 0\.0\d+\)$/)
      expect(colors.background).not.toBe(colors.text)
      expect(await unreadable()).toEqual([])

      await open(page, '/')
      expect(await unreadable()).toEqual([])
      if (dark) await page.getByRole('button', { name: 'Switch to light theme' }).click()
    }
  })
})

test.describe('printing', () => {
  /** The value of every color token (`--c-…`) of the style sheets, as the page has it now. */
  function colorTokens(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
      const names = new Set<string>()
      const collect = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule) {
            for (const name of rule.style) if (name.startsWith('--c-')) names.add(name)
          }
          if ('cssRules' in rule) collect(rule.cssRules as CSSRuleList)
        }
      }
      for (const sheet of document.styleSheets) collect(sheet.cssRules)
      const style = getComputedStyle(document.documentElement)
      return Object.fromEntries(
        [...names].sort().map((name) => [name, style.getPropertyValue(name).trim()]),
      )
    })
  }

  test('a page printed from the dark theme uses the light value of every color', async ({
    page,
  }) => {
    await open(page, '/about')
    const light = await colorTokens(page)
    expect(Object.keys(light).length, 'the color tokens were found').toBeGreaterThanOrEqual(30)
    expect(light['--c-ink']).toBe('#1b2330')

    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    const dark = await colorTokens(page)
    expect(dark['--c-ink']).not.toBe(light['--c-ink'])

    // If this fails: a light value was changed or a token was added in src/index.css.
    // Repeat the light value in the `@media print` block there.
    await page.emulateMedia({ media: 'print' })
    expect(await colorTokens(page)).toEqual(light)

    // What the paper shows: dark text, and no header or footer.
    const text = await page
      .getByRole('main')
      .locator('.prose > p')
      .first()
      .evaluate((element) => getComputedStyle(element).color)
    expect(text).toBe('rgb(27, 35, 48)')
    await expect(page.locator('header').first()).toBeHidden()
    await expect(page.locator('body > div > footer, #root footer').first()).toBeHidden()
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeHidden()
  })

  test('the light theme prints with its own colors', async ({ page }) => {
    await open(page, '/about')
    const light = await colorTokens(page)
    await page.emulateMedia({ media: 'print' })
    expect(await colorTokens(page)).toEqual(light)
  })
})

test.describe('colors of code', () => {
  /** The WCAG contrast ratio of two colors written as '#rrggbb'. */
  function contrast(first: string, second: string): number {
    const luminance = (hex: string) => {
      const [red, green, blue] = [1, 3, 5].map((start) => {
        const value = parseInt(hex.slice(start, start + 2), 16) / 255
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
    return (lighter + 0.05) / (darker + 0.05)
  }

  const TEXT = [
    'ink',
    'syn-mnemonic',
    'syn-register',
    'syn-number',
    'syn-comment',
    'syn-directive',
    'syn-string',
  ]
  /** The highlighted line of the stepper (the line that runs next), and code in general. */
  const BACKGROUNDS = ['current-line', 'code-bg']

  test('every color of code text is readable on the highlighted line and on the code background', async ({
    page,
  }) => {
    await open(page, '/')
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.getByRole('button', { name: 'Switch to dark theme' }).click()
        await expect(page.locator('html')).toHaveClass(DARK)
      }
      // The values the page really uses: a later rule of the style sheet can replace one.
      const tokens = await page.evaluate(
        (names) => {
          const style = getComputedStyle(document.documentElement)
          return Object.fromEntries(
            names.map((name) => [name, style.getPropertyValue(`--c-${name}`).trim()]),
          )
        },
        [...TEXT, ...BACKGROUNDS],
      )
      for (const [name, value] of Object.entries(tokens)) {
        expect(value, `--c-${name} is a color written as #rrggbb`).toMatch(/^#[0-9a-f]{6}$/i)
      }

      // Text must reach 4.5:1. (A comment on the highlighted line once had only 4.13:1.)
      for (const background of BACKGROUNDS) {
        for (const text of TEXT) {
          expect(
            contrast(tokens[text], tokens[background]),
            `${theme} theme: --c-${text} on --c-${background}`,
          ).toBeGreaterThanOrEqual(4.5)
        }
      }

      // The line that runs next must stand out on a projector too: at least 1.4:1.
      expect(
        contrast(tokens['current-line'], tokens['code-bg']),
        `${theme} theme: --c-current-line against --c-code-bg`,
      ).toBeGreaterThanOrEqual(1.4)
    }
  })

  test('"changed" differs from "wrong" and "warn" by lightness, not only by color', async ({
    page,
  }) => {
    await open(page, '/')
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.getByRole('button', { name: 'Switch to dark theme' }).click()
        await expect(page.locator('html')).toHaveClass(DARK)
      }
      const tokens = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        const value = (name: string) => style.getPropertyValue(`--c-${name}`).trim()
        return { changed: value('changed'), bad: value('bad'), warn: value('warn') }
      })
      // A student who does not see red and green apart still sees a lighter or darker mark.
      // (The old orange was 1.09:1 from "wrong" in the light theme, and 1.07:1 from "warn"
      // in the dark one.)
      for (const other of ['bad', 'warn'] as const) {
        expect(
          contrast(tokens.changed, tokens[other]),
          `${theme} theme: --c-changed against --c-${other}`,
        ).toBeGreaterThanOrEqual(1.3)
      }
    }
  })
})

test.describe('high-contrast mode (forced colors)', () => {
  test('the current page is still marked in the menu', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' })
    await open(page, '/learn')
    const link = await navLink(page, 'Learn')
    await expect(link).toHaveAttribute('aria-current', 'page')

    // The mark is a bar. This mode removes background colors: the bar keeps a color of the
    // system, so it must differ from the page behind it.
    const bar = link.locator('span[aria-hidden="true"]').filter({ visible: true })
    await expect(bar).toHaveCount(1)
    const colors = await bar.evaluate((element) => ({
      bar: getComputedStyle(element).backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
      active: window.matchMedia('(forced-colors: active)').matches,
    }))
    expect(colors.active).toBe(true)
    expect(colors.bar).not.toBe(colors.page)
    expect(colors.bar).not.toBe('rgba(0, 0, 0, 0)')
  })
})

test.describe('UI kit page (dev server only)', () => {
  test.beforeEach(() => {
    test.skip(!DEV_SERVER, 'The built site has no /dev/kit page.')
  })

  test('a control in a flush panel has its whole focus outline inside itself', async ({ page }) => {
    test.skip(isPhone(page), 'Needs a keyboard.')
    await open(page, '/dev/kit')
    const row = page.getByRole('button', { name: /^rax/ })

    // Reach the row with the Tab key, so that the outline shows.
    await page.getByRole('combobox', { name: 'Example program' }).focus()
    for (let presses = 0; presses < 12; presses++) {
      await page.keyboard.press('Tab')
      if (await row.evaluate((element) => element === document.activeElement)) break
    }
    await expect(row).toBeFocused()

    const outline = await row.evaluate((element) => {
      const style = getComputedStyle(element)
      return { style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset }
    })
    // Drawn inside the row: the panel cuts off everything outside it.
    expect(outline).toEqual({ style: 'solid', width: '2px', offset: '-2px' })
  })

  test('a button-link that is switched off cannot be followed, also not with the keyboard', async ({
    page,
  }) => {
    test.skip(isPhone(page), 'Needs a keyboard.')
    await open(page, '/dev/kit')
    const link = page.getByRole('link', { name: 'Disabled link' })
    await expect(link).toHaveAttribute('aria-disabled', 'true')
    await expect(link).not.toHaveAttribute('href')

    // Walk through the panel with Tab: the link is never a stop.
    await page.getByRole('button', { name: 'primary sm' }).focus()
    for (let presses = 0; presses < 20; presses++) {
      await page.keyboard.press('Tab')
      await expect(link).not.toBeFocused()
    }
    // A press on it does nothing.
    await link.click({ force: true })
    await expect(page).toHaveURL(/#\/dev\/kit$/)
  })

  test('marks around code in a message stay with the code', async ({ page }) => {
    await open(page, '/dev/kit')
    const widths = isPhone(page) ? [320, 336, 344, 360, 390, 412] : [600, 768, 1024, 1280]
    for (const width of widths) {
      await page.setViewportSize({ width, height: 740 })
      const apart = await page.evaluate(() => {
        const found: string[] = []
        for (const code of document.querySelectorAll('#main code')) {
          const next = code.nextSibling
          if (next === null || next.nodeType !== Node.TEXT_NODE) continue
          if (!/^[,.;:!?)]/.test(next.nodeValue ?? '')) continue
          const range = document.createRange()
          range.setStart(next, 0)
          range.setEnd(next, 1)
          if (range.getBoundingClientRect().top > code.getBoundingClientRect().bottom - 4) {
            found.push(code.textContent)
          }
        }
        return found
      })
      expect(apart, `at ${width} px`).toEqual([])
    }
  })
})

test.describe('storage that is blocked', () => {
  test('the site still loads, and the theme switch works until the tab closes', async ({
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
    await open(page, '/')
    const html = page.locator('html')
    await expect(html).not.toHaveClass(DARK)

    await page.getByRole('button', { name: 'Switch to dark theme' }).click()
    await expect(html).toHaveClass(DARK)

    // The choice lasts while the tab stays open …
    await (await navLink(page, 'About')).click()
    await expect(page).toHaveTitle('About · Stack Step')
    await expect(html).toHaveClass(DARK)

    // … and is gone after a reload, because it could not be saved.
    await page.reload()
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(html).not.toHaveClass(DARK)

    expect(errors).toEqual([])
  })
})
