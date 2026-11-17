// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Component, createRef, Suspense, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pageIsOnScreen, watchHistory } from './historyScroll'
import { eagerPage, lazyPage, type PageSource } from './lazyPage'
import { isNavItemActive, NAV_ITEMS } from './navItems'
import { PageContainer, PageHeader } from './Page'

const THEME_KEY = 'stackstep:theme'

/**
 * The theme store keeps its state in the module, so each test loads fresh copies
 * (the same thing a page reload does).
 */
async function loadThemeToggle() {
  vi.resetModules()
  const { ThemeToggle } = await import('./ThemeToggle')
  return ThemeToggle
}

async function loadAppShell() {
  vi.resetModules()
  const { AppShell } = await import('./AppShell')
  return AppShell
}

function nextHashChange(): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener('hashchange', () => resolve(), { once: true })
  })
}

async function goTo(hash: string): Promise<void> {
  if (window.location.hash === hash) return
  const changed = nextHashChange()
  window.location.hash = hash
  await changed
}

function isDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

function blocked(): never {
  throw new DOMException('The operation is insecure.', 'SecurityError')
}

/** A stand-in for window.matchMedia whose answer the test can change. */
function fakeDeviceTheme(startsDark: boolean): { setDark: (dark: boolean) => void } {
  const listeners = new Set<(event: { matches: boolean }) => void>()
  let dark = startsDark
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return dark
    },
    addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener)
    },
  }))
  return {
    setDark(next: boolean) {
      dark = next
      for (const listener of listeners) listener({ matches: next })
    },
  }
}

beforeEach(async () => {
  window.localStorage.clear()
  document.documentElement.classList.remove('dark')
  await goTo('#/')
})

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // jsdom follows a clicked link a moment later. Let that happen now, so that it cannot
  // change the address in the middle of the next test.
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('ThemeToggle', () => {
  it('says in words which theme it switches to', async () => {
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy()
  })

  it('starts from the theme that index.html picked', async () => {
    document.documentElement.classList.add('dark')
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy()
  })

  it('switches the theme and its own name, both ways', async () => {
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(isDark()).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(isDark()).toBe(false)
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeTruthy()
  })

  it('saves the choice as the plain word that index.html reads', async () => {
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button'))
    expect(window.localStorage.getItem(THEME_KEY)).toBe('dark')
    fireEvent.click(screen.getByRole('button'))
    expect(window.localStorage.getItem(THEME_KEY)).toBe('light')
  })

  it('still switches when storage is blocked', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    expect(isDark()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    expect(isDark()).toBe(false)
  })

  it('keeps two toggles on one page in step', async () => {
    const ThemeToggle = await loadThemeToggle()
    render(
      <>
        <ThemeToggle />
        <ThemeToggle />
      </>,
    )
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(screen.getAllByRole('button', { name: 'Switch to light theme' })).toHaveLength(2)
  })

  it('follows a choice made in another tab', async () => {
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)

    window.localStorage.setItem(THEME_KEY, 'dark')
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' }))
    })
    expect(isDark()).toBe(true)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy()
  })

  it('ignores storage events about other keys', async () => {
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)

    window.localStorage.setItem('stackstep:progress:v1', '{}')
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: 'stackstep:progress:v1', newValue: '{}' }),
      )
    })
    expect(isDark()).toBe(false)
  })

  it('follows the device until the student picks a theme', async () => {
    const device = fakeDeviceTheme(false)
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)

    act(() => device.setDark(true))
    expect(isDark()).toBe(true)
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeTruthy()
    // Following the device is not a choice: nothing is saved.
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull()

    // The student picks light. From now on the device has no say.
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }))
    act(() => device.setDark(false))
    act(() => device.setDark(true))
    expect(isDark()).toBe(false)
  })

  it('keeps a choice that could not be saved, even when the device changes', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    const device = fakeDeviceTheme(false)
    const ThemeToggle = await loadThemeToggle()
    render(<ThemeToggle />)

    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }))
    act(() => device.setDark(true))
    act(() => device.setDark(false))
    expect(isDark()).toBe(true)
  })

  it('stops listening for changes when it goes away', async () => {
    const ThemeToggle = await loadThemeToggle()
    const { unmount } = render(<ThemeToggle />)
    unmount()
    // A change after the toggle is gone must not fail.
    window.localStorage.setItem(THEME_KEY, 'dark')
    expect(() =>
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'dark' })),
    ).not.toThrow()
    expect(isDark()).toBe(true)
  })
})

describe('AppShell', () => {
  async function renderShell(busy?: boolean) {
    const AppShell = await loadAppShell()
    const mainRef = createRef<HTMLElement>()
    const page = (isBusy?: boolean) => (
      <AppShell mainRef={mainRef} busy={isBusy}>
        <h1>The page</h1>
      </AppShell>
    )
    const { rerender } = render(page(busy))
    return { mainRef, setBusy: (isBusy: boolean) => rerender(page(isBusy)) }
  }

  /** The list of pages that the Menu button shows and hides, and the shield over the page. */
  function phoneList() {
    const button = screen.getByRole('button', { name: 'Menu' })
    const shield = () => document.querySelector<HTMLElement>('nav div.touch-none')
    return { button, shield, isOpen: () => button.getAttribute('aria-expanded') === 'true' }
  }

  it('has a header, a main menu, a page region and a footer', async () => {
    const { mainRef } = await renderShell()
    expect(screen.getByRole('banner')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy()
    expect(screen.getByRole('contentinfo')).toBeTruthy()

    const main = screen.getByRole('main')
    expect(main.id).toBe('main')
    expect(main.getAttribute('tabindex')).toBe('-1')
    expect(mainRef.current).toBe(main)
    expect(main.textContent).toBe('The page')
  })

  it('lists the six pages in order, as real links', async () => {
    await renderShell()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const links = [...nav.querySelectorAll('a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
    ])
    expect(links).toEqual([
      ['Stepper', '#/stepper'],
      ['Learn', '#/learn'],
      ['Practice', '#/practice'],
      ['Cheat sheet', '#/cheatsheet'],
      ['Progress', '#/progress'],
      ['About', '#/about'],
    ])
  })

  it('starts with a skip link that moves focus to the page region and keeps the route', async () => {
    await goTo('#/learn/mov?x=1')
    const { mainRef } = await renderShell()

    const skipLink = screen.getByRole('link', { name: 'Skip to main content' })
    expect(document.querySelector('a')).toBe(skipLink)
    // Inside the header, so that it belongs to a landmark (axe: "region"), and its first child.
    const banner = screen.getByRole('banner')
    expect(banner.firstElementChild).toBe(skipLink)
    // It points at the page that is showing, never at "#main".
    expect(skipLink.getAttribute('href')).toBe('#/learn/mov?x=1')

    fireEvent.click(skipLink)
    expect(document.activeElement).toBe(mainRef.current)
    expect(window.location.hash).toBe('#/learn/mov?x=1')
  })

  it('marks the link of the current page, also on a page below it', async () => {
    await goTo('#/learn/mov')
    await renderShell()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const current = [...nav.querySelectorAll('[aria-current]')]
    expect(current.map((link) => link.textContent)).toEqual(['Learn'])
    expect(current[0].getAttribute('aria-current')).toBe('page')
    // The cue is a bar, not only a color.
    expect(current[0].querySelectorAll('span[aria-hidden="true"]').length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: 'Stack Step' }).getAttribute('aria-current')).toBeNull()
  })

  it('marks the brand link on the home page and no page of the menu', async () => {
    await renderShell()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(0)
    expect(screen.getByRole('link', { name: 'Stack Step' }).getAttribute('aria-current')).toBe(
      'page',
    )
  })

  it('moves the mark when the route changes', async () => {
    await renderShell()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    act(() => {
      window.location.hash = '#/practice/rip'
    })
    await waitFor(() => expect(nav.querySelector('[aria-current]')?.textContent).toBe('Practice'))
  })

  it('has a Menu button that shows and hides the list of pages', async () => {
    await renderShell()
    const button = screen.getByRole('button', { name: 'Menu' })
    const list = document.getElementById(button.getAttribute('aria-controls') ?? '')
    expect(list?.tagName).toBe('UL')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(list?.classList.contains('hidden')).toBe(true)

    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(list?.classList.contains('hidden')).toBe(false)

    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button)
  })

  it('closes the list of pages after a navigation', async () => {
    await renderShell()
    const button = screen.getByRole('button', { name: 'Menu' })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')

    act(() => {
      window.location.hash = '#/about'
    })
    await waitFor(() => expect(button.getAttribute('aria-expanded')).toBe('false'))
  })

  it('closes the list of pages when the link of the current page is chosen', async () => {
    await goTo('#/about')
    const { mainRef } = await renderShell()
    const button = screen.getByRole('button', { name: 'Menu' })
    fireEvent.click(button)
    const link = screen.getByRole('link', { name: 'About' })
    act(() => link.focus())

    fireEvent.click(link)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    // The list hides the link, so keyboard focus goes to the page region (not to nowhere).
    expect(document.activeElement).toBe(mainRef.current)
    expect(window.location.hash).toBe('#/about')
  })

  it('puts keyboard focus on the page region when any link of the open list is chosen', async () => {
    const { mainRef } = await renderShell()
    const { button } = phoneList()
    fireEvent.click(button)
    const link = screen.getByRole('link', { name: 'Learn' })
    act(() => link.focus())

    fireEvent.click(link)
    expect(document.activeElement).toBe(mainRef.current)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    // The link still does its work.
    await waitFor(() => expect(window.location.hash).toBe('#/learn'))
  })

  it('leaves keyboard focus alone when a link of the row is chosen (the list is closed)', async () => {
    await goTo('#/about')
    const { mainRef } = await renderShell()
    const link = screen.getByRole('link', { name: 'About' })
    act(() => link.focus())
    fireEvent.click(link)
    expect(document.activeElement).toBe(link)
    expect(document.activeElement).not.toBe(mainRef.current)
  })

  it('covers the page with a shield while the list is open', async () => {
    await renderShell()
    const { button, shield } = phoneList()
    expect(shield()).toBeNull()

    fireEvent.click(button)
    expect(shield()).not.toBeNull()
    // Nobody can read or reach it: it is only a place for a tap to land.
    expect(shield()?.getAttribute('aria-hidden')).toBe('true')
    expect(shield()?.textContent).toBe('')

    fireEvent.click(button)
    expect(shield()).toBeNull()
  })

  it('a tap on the shield closes the list when the finger lifts, not before', async () => {
    await renderShell()
    const { button, shield, isOpen } = phoneList()
    fireEvent.click(button)
    const element = shield()
    if (element === null) throw new Error('the shield is missing')

    // The press alone does not close the list: the shield must still be there for the
    // tap, or the tap would land on the page under it.
    fireEvent.pointerDown(element)
    expect(isOpen()).toBe(true)
    expect(shield()).toBe(element)

    fireEvent.click(element)
    expect(isOpen()).toBe(false)
    expect(shield()).toBeNull()
    // As after Escape, the keyboard focus is back on the button.
    expect(document.activeElement).toBe(button)
  })

  it('a press on the header outside the list still closes it', async () => {
    await renderShell()
    const { button, isOpen } = phoneList()
    fireEvent.click(button)
    fireEvent.pointerDown(screen.getByRole('link', { name: 'Stack Step' }))
    expect(isOpen()).toBe(false)
  })

  it('marks the current page with bars that Windows high-contrast mode keeps', async () => {
    await goTo('#/learn')
    await renderShell()
    const bars = screen.getByRole('link', { name: 'Learn' }).querySelectorAll('span[aria-hidden]')
    expect(bars).toHaveLength(2)
    for (const bar of bars)
      expect(bar.classList.contains('forced-colors:bg-[Highlight]')).toBe(true)
  })

  it('says in the footer what the site is, with a link to the About page', async () => {
    await renderShell()
    const footer = screen.getByRole('contentinfo')
    expect(footer.textContent).toContain(
      'Stack Step is a learning tool. The emulator covers a teaching subset of x86-64.',
    )
    const link = footer.querySelector('a')
    expect(link?.textContent).toBe('About Stack Step')
    expect(link?.getAttribute('href')).toBe('#/about')
  })

  describe('while the next page is downloading', () => {
    function loadingMessage(): HTMLElement {
      return screen.getByRole('status')
    }

    it('is not busy by default, and has an empty place for the loading message', async () => {
      await renderShell()
      const main = screen.getByRole('main')
      expect(main.hasAttribute('aria-busy')).toBe(false)
      expect(loadingMessage().textContent).toBe('')
      // The message is outside the page region: a busy region may hold its changes back.
      expect(main.contains(loadingMessage())).toBe(false)
      expect(main.textContent).toBe('The page')
    })

    it('marks the page region as busy at once, and keeps the page that is showing', async () => {
      await renderShell(true)
      const main = screen.getByRole('main')
      expect(main.getAttribute('aria-busy')).toBe('true')
      expect(main.textContent).toBe('The page')
    })

    it('shows "Loading…" only after a short wait', async () => {
      vi.useFakeTimers()
      await renderShell(true)
      expect(loadingMessage().textContent).toBe('')

      act(() => void vi.advanceTimersByTime(250))
      expect(loadingMessage().textContent).toBe('')

      act(() => void vi.advanceTimersByTime(100))
      expect(loadingMessage().textContent).toBe('Loading…')
      expect(loadingMessage().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    })

    it('never shows the message for a page that arrives quickly', async () => {
      vi.useFakeTimers()
      const { setBusy } = await renderShell(true)
      act(() => void vi.advanceTimersByTime(200))
      setBusy(false)
      act(() => void vi.advanceTimersByTime(1000))
      expect(loadingMessage().textContent).toBe('')
      expect(screen.getByRole('main').hasAttribute('aria-busy')).toBe(false)
    })

    it('takes the message away when the page is here, and waits again the next time', async () => {
      vi.useFakeTimers()
      const { setBusy } = await renderShell(true)
      act(() => void vi.advanceTimersByTime(400))
      expect(loadingMessage().textContent).toBe('Loading…')

      setBusy(false)
      expect(loadingMessage().textContent).toBe('')

      setBusy(true)
      expect(loadingMessage().textContent).toBe('')
      act(() => void vi.advanceTimersByTime(400))
      expect(loadingMessage().textContent).toBe('Loading…')
    })
  })

  it('has a theme switch in the header', async () => {
    await renderShell()
    const header = screen.getByRole('banner')
    expect(
      header.contains(screen.getByRole('button', { name: /^Switch to (dark|light) theme$/ })),
    ).toBe(true)
  })
})

describe('isNavItemActive', () => {
  it.each([
    ['/learn', '/learn', true],
    ['/learn', '/learn/mov', true],
    ['/practice', '/practice/quiz', true],
    ['/learn', '/', false],
    ['/learn', '/learning', false],
    ['/progress', '/practice', false],
    ['/about', '/about-us', false],
  ])('%s on %s → %s', (to, path, expected) => {
    expect(isNavItemActive(to, path)).toBe(expected)
  })

  it('at most one item is active on any page', () => {
    for (const path of ['/', '/stepper', '/learn/mov', '/practice/weak', '/cheatsheet', '/nope']) {
      const active = NAV_ITEMS.filter((item) => isNavItemActive(item.to, path))
      expect(active.length).toBeLessThanOrEqual(1)
    }
  })
})

describe('PageContainer and PageHeader', () => {
  it('PageHeader shows the one h1 of the page and an optional introduction', () => {
    render(<PageHeader title="Progress" lead="What you have done so far." />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Progress')
    expect(screen.getByText('What you have done so far.')).toBeTruthy()
  })

  it('PageContainer picks a width and passes other attributes through', () => {
    render(
      <>
        <PageContainer data-testid="wide">a</PageContainer>
        <PageContainer width="text" className="pb-20" data-testid="text">
          b
        </PageContainer>
      </>,
    )
    expect(screen.getByTestId('wide').classList.contains('max-w-6xl')).toBe(true)
    const text = screen.getByTestId('text')
    expect(text.classList.contains('max-w-[45rem]')).toBe(true)
    expect(text.classList.contains('pb-20')).toBe(true)
  })
})

describe('lazyPage', () => {
  /** Shows what a failed page looks like to the app: the error's message. */
  class Catch extends Component<{ children: ReactNode }, { message: string | null }> {
    override state: { message: string | null } = { message: null }
    static getDerivedStateFromError(error: unknown) {
      return { message: error instanceof Error ? error.message : String(error) }
    }
    override render(): ReactNode {
      if (this.state.message !== null) return <p role="alert">{this.state.message}</p>
      return this.props.children
    }
  }

  /** One visit to the page: a fresh boundary around the component that the source has now. */
  function Visit({ source, name }: { source: PageSource; name: string }): ReactNode {
    const { Page } = source
    return (
      <Suspense fallback={<p>Loading…</p>}>
        <Catch key={name}>
          <Page />
        </Catch>
      </Suspense>
    )
  }

  function AboutPage(): ReactNode {
    return <h1>About</h1>
  }

  it('a page of the first download is ready at once', () => {
    const source = eagerPage(AboutPage)
    expect(source.Page).toBe(AboutPage)
    expect(source.isReady()).toBe(true)
    source.forgetFailedDownload()
    expect(source.Page).toBe(AboutPage)
  })

  it('downloads the page file when the page is first shown, and only once', async () => {
    const load = vi.fn(() => Promise.resolve({ default: AboutPage }))
    const source = lazyPage(load)
    expect(load).not.toHaveBeenCalled()
    expect(source.isReady()).toBe(false)

    const { rerender } = render(<Visit source={source} name="first" />)
    expect(await screen.findByRole('heading', { name: 'About' })).toBeTruthy()
    expect(source.isReady()).toBe(true)

    rerender(<Visit source={source} name="second" />)
    expect(screen.getByRole('heading', { name: 'About' })).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('asks the network again after a failed download was forgotten', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let online = false
    const load = vi.fn(() =>
      online
        ? Promise.resolve({ default: AboutPage })
        : Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
    )
    const source = lazyPage(load)
    const failedPage = source.Page

    const { rerender } = render(<Visit source={source} name="first" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to fetch')
    expect(source.isReady()).toBe(false)
    expect(load).toHaveBeenCalledTimes(1)

    // What <App> does after the message is on screen.
    source.forgetFailedDownload()
    expect(source.Page).not.toBe(failedPage)
    // Nothing is requested until the page is opened again.
    expect(load).toHaveBeenCalledTimes(1)

    online = true
    rerender(<Visit source={source} name="second" />)
    expect(await screen.findByRole('heading', { name: 'About' })).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(2)
    expect(source.isReady()).toBe(true)
  })

  it('without that, a failed download stays failed (this is what React.lazy does alone)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const load = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')))
    const source = lazyPage(load)

    const { rerender } = render(<Visit source={source} name="first" />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    rerender(<Visit source={source} name="second" />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps the page when nothing failed, or when the page itself is broken', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    function BrokenPage(): ReactNode {
      throw new Error('a mistake in the page')
    }
    const good = lazyPage(() => Promise.resolve({ default: AboutPage }))
    const broken = lazyPage(() => Promise.resolve({ default: BrokenPage }))
    const goodPage = good.Page
    const brokenPage = broken.Page

    // Before anything was shown.
    good.forgetFailedDownload()
    expect(good.Page).toBe(goodPage)

    render(
      <>
        <Visit source={good} name="good" />
        <Visit source={broken} name="broken" />
      </>,
    )
    expect(await screen.findByRole('heading', { name: 'About' })).toBeTruthy()
    expect((await screen.findByRole('alert')).textContent).toBe('a mistake in the page')

    // The download of both files worked, so there is nothing to forget.
    good.forgetFailedDownload()
    broken.forgetFailedDownload()
    expect(good.Page).toBe(goodPage)
    expect(broken.Page).toBe(brokenPage)
  })
})

describe('historyScroll', () => {
  const STORAGE_KEY = 'stackstep:scroll'
  let stop: () => void = () => undefined
  let scrollTo: ReturnType<typeof vi.fn<(x: number, y: number) => void>>

  /** jsdom has no layout: say where the page is scrolled to. */
  function setScrollY(y: number): void {
    Object.defineProperty(window, 'scrollY', { value: y, configurable: true })
  }

  /** The name that this file gave to the history entry the browser is on. */
  function entryName(): unknown {
    return (window.history.state as { stackstep?: unknown } | null)?.stackstep
  }

  function stored(): Record<string, number> {
    return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, number>
  }

  /** What a reload does: the document starts again; only the browser keeps what it kept. */
  function reload(): void {
    window.dispatchEvent(new Event('pagehide'))
    stop()
    setScrollY(0)
    stop = watchHistory()
  }

  async function goBack(): Promise<void> {
    const changed = nextHashChange()
    window.history.back()
    await changed
  }

  async function goForward(): Promise<void> {
    const changed = nextHashChange()
    window.history.forward()
    await changed
  }

  beforeEach(async () => {
    scrollTo = vi.fn<(x: number, y: number) => void>()
    vi.stubGlobal('scrollTo', scrollTo)
    setScrollY(0)
    window.sessionStorage.clear()
    // A history entry of its own for every test, with nothing in its state.
    await goTo(`#/start-${Math.random().toString(36).slice(2)}`)
    stop = watchHistory()
  })

  afterEach(() => {
    stop()
    setScrollY(0)
    window.sessionStorage.clear()
  })

  it('gives the history entry a name and takes over the scrolling from the browser', () => {
    expect(entryName()).toEqual(expect.stringMatching(/\S/))
    expect(window.history.scrollRestoration).toBe('manual')
  })

  it('keeps what others put into the state of the entry', () => {
    stop()
    window.history.replaceState({ other: 1 }, '')
    stop = watchHistory()
    expect(window.history.state).toMatchObject({ other: 1 })
    expect(entryName()).toEqual(expect.stringMatching(/\S/))
  })

  it('opens the first page at the top', () => {
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0)
  })

  it('opens the page of a new entry at the top, and names the entry', async () => {
    pageIsOnScreen({ scroll: true })
    const first = entryName()
    setScrollY(700)

    await goTo('#/next')
    expect(entryName()).toEqual(expect.stringMatching(/\S/))
    expect(entryName()).not.toBe(first)
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
  })

  it('goes back to the place the student left, with Back and with Forward', async () => {
    pageIsOnScreen({ scroll: true })
    setScrollY(700)
    await goTo('#/second')
    pageIsOnScreen({ scroll: true })
    setScrollY(120)

    await goBack()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 700)
    setScrollY(700)

    await goForward()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 120)
  })

  it('remembers the position of the page on screen while the next page downloads', async () => {
    pageIsOnScreen({ scroll: true })
    setScrollY(300)
    // The address changes, but the old page stays on screen: `pageIsOnScreen` is not called.
    await goTo('#/slow')
    // The student keeps scrolling the old page.
    setScrollY(450)
    window.dispatchEvent(new Event('scroll'))

    // Back to the old address: its page never left the screen, so nothing moves.
    await goBack()
    pageIsOnScreen({ scroll: false })
    expect(scrollTo).toHaveBeenCalledTimes(1)

    // Forward: the slow page was never shown, so it opens at the top.
    await goForward()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
    // And Back again finds the last place of the old page.
    await goBack()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 450)
  })

  it('does not scroll when only the query changed', async () => {
    pageIsOnScreen({ scroll: true })
    setScrollY(500)
    await goTo(`${window.location.hash}?x=1`)
    pageIsOnScreen({ scroll: false })
    expect(scrollTo).toHaveBeenCalledTimes(1)

    // The position still belongs to the new entry from now on.
    setScrollY(900)
    await goTo('#/third')
    pageIsOnScreen({ scroll: true })
    await goBack()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 900)
  })

  it('keeps the place over a reload', () => {
    pageIsOnScreen({ scroll: true })
    setScrollY(1234.4)
    reload()
    expect(Object.values(stored())).toEqual([1234])

    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1234)
  })

  it('keeps the places of earlier pages over a reload too', async () => {
    pageIsOnScreen({ scroll: true })
    setScrollY(640)
    await goTo('#/second')
    pageIsOnScreen({ scroll: true })
    setScrollY(80)
    reload()

    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 80)
    await goBack()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640)
  })

  it('opens a page that was still downloading at the reload at the top', async () => {
    pageIsOnScreen({ scroll: true })
    await goTo('#/still-loading')
    // The old page is on screen and is scrolled; the new page never showed.
    setScrollY(800)
    reload()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
  })

  it('stores the places of the latest 50 entries only', async () => {
    pageIsOnScreen({ scroll: true })
    for (let visit = 1; visit <= 54; visit++) {
      setScrollY(visit)
      await goTo(`#/visit-${visit}`)
      pageIsOnScreen({ scroll: true })
    }
    setScrollY(1000)
    window.dispatchEvent(new Event('pagehide'))

    const places = Object.values(stored())
    expect(places).toHaveLength(50)
    // The first visits are gone; the page on screen is the last one.
    expect(places[0]).toBe(6)
    expect(places.at(-1)).toBe(1000)
  })

  it('works without storage: only a reload then starts at the top', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked)
    stop()
    stop = watchHistory()

    pageIsOnScreen({ scroll: true })
    setScrollY(700)
    await goTo('#/second')
    pageIsOnScreen({ scroll: true })
    await goBack()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 700)

    setScrollY(700)
    expect(reload).not.toThrow()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
  })

  it('ignores stored data that is not a list of places', () => {
    stop()
    window.sessionStorage.setItem(STORAGE_KEY, '{"a":"far","b":-5,"c":null,')
    stop = watchHistory()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)

    stop()
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [String(entryName())]: 'far', other: -5 }),
    )
    stop = watchHistory()
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
  })

  it('starts by itself when the app says that a page is on screen', () => {
    stop()
    window.history.replaceState(null, '')
    pageIsOnScreen({ scroll: true })
    expect(entryName()).toEqual(expect.stringMatching(/\S/))
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
    stop = watchHistory()
  })

  it('gives a new name to an entry whose name is broken', () => {
    stop()
    window.history.replaceState({ stackstep: { id: 7 } }, '')
    stop = watchHistory()
    expect(typeof entryName()).toBe('string')
    pageIsOnScreen({ scroll: true })
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
  })
})
