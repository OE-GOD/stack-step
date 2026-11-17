import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { Link, useRoute } from '../../lib/router'
import { NoWrap } from '../ui/NoWrap'
import { Spinner } from '../ui/Spinner'
import { TextLink } from '../ui/TextLink'
import { Logo } from './Logo'
import { SiteNav } from './SiteNav'
import { ThemeToggle } from './ThemeToggle'

/** A page that arrives sooner than this shows no loading message at all. */
const LOADING_MESSAGE_WAIT_MS = 300

export interface AppShellProps {
  /** The page region. The app moves keyboard focus here after each navigation. */
  mainRef: RefObject<HTMLElement | null>
  /**
   * True while the page of the address bar is still downloading. The page region then
   * still shows the page before it (or nothing, on the first load).
   */
  busy?: boolean
  children: ReactNode
}

/**
 * "Loading…" in a small floating label. It waits a moment before it shows, so that a page
 * that arrives quickly never flashes a message.
 */
function LoadingMessage(): ReactNode {
  const [waitedLongEnough, setWaitedLongEnough] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setWaitedLongEnough(true), LOADING_MESSAGE_WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [])
  if (!waitedLongEnough) return null
  return (
    // Smaller on a phone, so that it fits into the space above the heading of a page.
    <p className="flex animate-fade-in items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 py-0.5 text-sm text-muted shadow-lg md:gap-2 md:px-4 md:py-2 md:text-base">
      <Spinner className="size-3.5 md:size-[1.125rem]" />
      Loading…
    </p>
  )
}

/**
 * The frame around every page: skip link, header (brand, main menu, theme switch), the
 * page region (<main id="main">) and the footer.
 *
 * The header and the footer are left out when a page is printed.
 */
export function AppShell({ mainRef, busy = false, children }: AppShellProps): ReactNode {
  // Outside a page, this is the route of the address bar: the menu marks the page that
  // the student just chose, also while that page is still downloading.
  const { path, query } = useRoute()
  const search = query.toString()
  const thisPage = search === '' ? path : `${path}?${search}`

  return (
    <div className="flex min-h-dvh flex-col">
      {/* `relative`: the phone menu is placed against the bottom edge of the header. */}
      <header className="relative z-20 border-b border-line bg-surface print:hidden">
        {/*
          The skip link is the first thing in the page and inside the header, so that
          everything on the page belongs to a landmark. It points at this same page, not
          at "#main": on this site the hash is the route. The click handler does the real
          work.
        */}
        <Link
          to={thisPage}
          className="skip-link"
          onClick={(event) => {
            event.preventDefault()
            mainRef.current?.focus()
          }}
        >
          Skip to main content
        </Link>
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-1 px-4 md:h-16 md:gap-3 md:px-6 lg:gap-6">
          <Link
            to="/"
            aria-current={path === '/' ? 'page' : undefined}
            className="-ml-1 flex min-h-11 items-center gap-2.5 rounded-lg pr-2 pl-1 text-lg font-bold tracking-tight whitespace-nowrap text-ink"
          >
            <Logo />
            {/*
              With very large text (a browser set to 150 % and more on a phone) the row
              has no room for the words: the logo alone stays, the name is still read out.
            */}
            <span className="max-[14.5em]:sr-only">Stack Step</span>
          </Link>
          <SiteNav
            path={path}
            className="ml-auto md:ml-0 md:flex-1"
            onChooseInList={() => mainRef.current?.focus({ preventScroll: true })}
          />
          <ThemeToggle className="-mr-2" />
        </div>
      </header>

      {/*
        The place for the loading message. It is always in the page and outside the page
        region, so a screen reader announces the message when it appears (the page region
        itself is marked busy, and changes inside a busy region may be held back).

        It floats just under the header, in the empty space that every page has above its
        heading, so it does not cover the page that is still showing.
      */}
      <div
        id="page-loading-message"
        role="status"
        className="pointer-events-none fixed inset-x-0 top-[3.75rem] z-10 flex justify-center md:top-[4.375rem] print:hidden"
      >
        {busy && <LoadingMessage />}
      </div>

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        aria-busy={busy ? true : undefined}
        className="flex-1"
      >
        {children}
      </main>

      {/*
        `data-site-footer`: while the tutor's floating button is on the page, src/index.css
        keeps room for it at the end of the page and beside this text.
      */}
      <footer data-site-footer="" className="border-t border-line print:hidden">
        <p className="mx-auto max-w-6xl px-4 py-6 text-sm text-pretty text-muted md:px-6">
          Stack Step is a learning tool. The emulator covers a teaching subset of{' '}
          <NoWrap>x86-64</NoWrap>.{' '}
          {/* The padding makes the link easier to hit with a thumb; the margin undoes its size. */}
          <TextLink to="/about" className="-my-3 inline-block py-3 whitespace-nowrap">
            About Stack Step
          </TextLink>
        </p>
      </footer>
    </div>
  )
}
