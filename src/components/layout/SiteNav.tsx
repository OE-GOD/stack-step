import type { ReactNode } from 'react'
import { Link } from '../../lib/router'
import { cx } from '../ui/cx'
import { CloseIcon, MenuIcon } from '../ui/icons'
import { useDisclosure } from '../ui/useDisclosure'
import { isNavItemActive, NAV_ITEMS } from './navItems'

export interface SiteNavProps {
  /** The path of the page in the address bar, for example '/learn/mov'. */
  path: string
  className?: string
  /**
   * Called when a link is chosen in the open phone list. The list closes and hides the
   * link, so whoever owns the page region should put keyboard focus there.
   */
  onChooseInList?: () => void
}

/**
 * The main menu.
 *
 * At 768 px and wider it is a row of links inside the header. Below that, a "Menu" button
 * shows and hides the same links as a list under the header. Choosing a link, pressing
 * Escape, or tapping outside closes the list. A tap outside only closes the list: it
 * does not also press what is under the finger.
 *
 * The link of the current page has `aria-current="page"` and a bar next to it, so the
 * cue is a shape and not only a color.
 */
export function SiteNav({ path, className, onChooseInList }: SiteNavProps): ReactNode {
  // Opening another page closes the list.
  const { open, close, buttonRef, panelRef, buttonProps, panelProps } = useDisclosure({
    closeOnChangeOf: path,
  })

  return (
    <nav aria-label="Main" className={cx('flex items-center', className)}>
      <button
        type="button"
        ref={buttonRef}
        {...buttonProps}
        className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg px-3 font-semibold text-ink transition-colors hover:bg-surface-2 md:hidden"
      >
        {open ? <CloseIcon /> : <MenuIcon />}
        {/*
          With large text (a browser set to 125 % and more on a small phone) the header row
          would not fit: the icon alone stays, and the button keeps its name "Menu".
          `em` in a screen-width rule follows the text size that the browser is set to.
        */}
        <span className="max-[17.5em]:sr-only">Menu</span>
      </button>

      {/*
        `contents`: this wrapper makes no box, so the list is laid out as before. It only
        tells the disclosure that the shield and the list both count as "inside".
      */}
      <div ref={panelRef} className="contents">
        {open && (
          // A shield over the page under the header (the header and the list are drawn
          // above it). A press on it is "inside", so it stays in place until the finger
          // lifts: the tap then lands on the shield and closes the list, and never
          // reaches the page. `touch-none`: a swipe on it does not scroll the page away
          // under the open list.
          <div
            aria-hidden="true"
            onClick={() => {
              close()
              // As after Escape: the focus goes back to the button that opened the list.
              buttonRef.current?.focus({ preventScroll: true })
            }}
            className="fixed inset-x-0 top-14 bottom-0 touch-none md:hidden"
          />
        )}
        <ul
          {...panelProps}
          className={cx(
            // Phone: a list under the header (the header is the positioned parent).
            open ? 'flex' : 'hidden',
            'absolute inset-x-0 top-full flex-col border-b border-line-strong bg-surface px-1 py-2 shadow-lg max-md:animate-slide-in',
            // Wider screens: always shown, as a row inside the header.
            'md:static md:flex md:flex-row md:items-center md:gap-1 md:border-0 md:bg-transparent md:p-0 md:shadow-none',
          )}
        >
          {NAV_ITEMS.map((item) => {
            const active = isNavItemActive(item.to, path)
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    // Only the phone list can be open. Close it also when the link is the
                    // page that is already showing (the address does not change then).
                    if (!open) return
                    close()
                    onChooseInList?.()
                  }}
                  className={cx(
                    'relative flex min-h-12 items-center rounded-lg px-3 font-medium whitespace-nowrap transition-colors hover:bg-surface-2 hover:text-ink md:min-h-11 md:px-2.5 md:text-[0.9375rem] lg:px-3',
                    active ? 'bg-primary-soft text-ink md:bg-transparent' : 'text-muted',
                  )}
                >
                  {item.label}
                  {active && (
                    <>
                      {/*
                        The bars are background colors. Windows high-contrast mode removes
                        those, except for its own colors: `Highlight` keeps the bars there.
                      */}
                      {/* In the phone list: a bar at the left edge. */}
                      <span
                        aria-hidden="true"
                        className="absolute inset-y-2.5 left-0 w-1 rounded-full bg-primary md:hidden forced-colors:bg-[Highlight]"
                      />
                      {/* In the row: a bar under the word. */}
                      <span
                        aria-hidden="true"
                        className="absolute inset-x-2.5 bottom-1 h-[3px] rounded-full bg-primary max-md:hidden lg:inset-x-3 forced-colors:bg-[Highlight]"
                      />
                    </>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      </div>
    </nav>
  )
}
