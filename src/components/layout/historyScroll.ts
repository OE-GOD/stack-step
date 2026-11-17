/**
 * Where each page was scrolled to.
 *
 * - The Back and Forward buttons of the browser return to the place the student left.
 * - A link (a new entry in the browser's history) opens its page at the top.
 * - A reload keeps the place.
 *
 * The browser cannot do this alone on this site. It puts the old position back at once,
 * before the page of that address has been drawn (and before its file has arrived), so
 * the position is lost. This file switches the browser's own restoring off and scrolls at
 * the right moment: when <App> says that the page is on screen.
 *
 * How it works: every entry of the browser's history gets a name, kept in `history.state`
 * under `stackstep`. The scroll position of the page on screen is stored under the name
 * of its entry. When a page is put on screen, an entry that was seen before goes back to
 * its stored position, and a new entry starts at the top.
 *
 * The positions live in memory. When the document goes away (a reload, a visit to another
 * site) they are written to `sessionStorage`, which lasts as long as the tab, and read
 * back when the document starts again. If storage is blocked, a reload starts at the top.
 */

/** The key inside `history.state`. Other keys of the state are left alone. */
const STATE_KEY = 'stackstep'
/** The key in `sessionStorage`: { name of the entry: scroll position }. */
const STORAGE_KEY = 'stackstep:scroll'
/** Only the positions of this many entries, the latest ones, are kept over a reload. */
const MAX_STORED = 50

let watching = false
let counter = 0
/** Scroll positions by entry name. The entry that was written last is the last one. */
const positions = new Map<string, number>()
/** The entry the browser is on. */
let currentEntry = ''
/** The entry whose page is on screen. It is behind `currentEntry` while a page file downloads. */
let shownEntry: string | null = null
/** Where the page of `currentEntry` belongs when it is put on screen. */
let target = 0

function readEntryName(): string | null {
  const state: unknown = window.history.state
  if (typeof state !== 'object' || state === null) return null
  const name: unknown = (state as Record<string, unknown>)[STATE_KEY]
  return typeof name === 'string' && name !== '' ? name : null
}

function writeEntryName(name: string): void {
  try {
    const state: unknown = window.history.state
    const rest = typeof state === 'object' && state !== null ? state : {}
    window.history.replaceState({ ...rest, [STATE_KEY]: name }, '')
  } catch {
    // Some browsers limit how often the history may be written. Without a name the
    // entry only looks new again: its page opens at the top.
  }
}

/** A name that no other entry has, also not an entry from before a reload. */
function newEntryName(): string {
  counter += 1
  return `${Date.now().toString(36)}-${counter}`
}

function loadPositions(): void {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(STORAGE_KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null) return
    for (const [name, y] of Object.entries(stored)) {
      if (typeof y === 'number' && Number.isFinite(y) && y >= 0) positions.set(name, y)
    }
  } catch {
    // Storage is blocked, or what it holds is not ours: start with no positions.
  }
}

function storePositions(): void {
  try {
    const latest = [...positions].slice(-MAX_STORED)
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(latest)))
  } catch {
    // Storage is blocked or full: after a reload the page starts at the top.
  }
}

/** Find out which entry the browser is on now, and where its page belongs. */
function enterCurrentEntry(): void {
  try {
    // Each history entry has its own setting, so say it again for every entry.
    window.history.scrollRestoration = 'manual'
  } catch {
    // A very old browser: it restores by itself, as well as it can.
  }
  const name = readEntryName()
  if (name === null) {
    currentEntry = newEntryName()
    target = 0
    writeEntryName(currentEntry)
  } else {
    currentEntry = name
    target = positions.get(name) ?? 0
  }
}

function rememberPosition(): void {
  if (shownEntry === null) return
  // Delete first, so that this entry becomes the latest one of the list.
  positions.delete(shownEntry)
  positions.set(shownEntry, Math.round(window.scrollY))
}

/** The address changed (a link, Back, Forward). The page on screen is still the old one. */
function onAddressChange(): void {
  rememberPosition()
  enterCurrentEntry()
}

/** The document is going away: a reload, or a visit to another site. */
function onPageHide(): void {
  rememberPosition()
  storePositions()
}

function stopWatching(): void {
  if (!watching) return
  watching = false
  window.removeEventListener('popstate', onAddressChange)
  window.removeEventListener('hashchange', onAddressChange)
  window.removeEventListener('scroll', rememberPosition)
  window.removeEventListener('pagehide', onPageHide)
  positions.clear()
  shownEntry = null
}

/**
 * Start watching the browser's history. Call it before the app is first rendered, so that
 * this file hears about a new address before the app does. Calling it again does nothing.
 *
 * It returns a function that stops the watching and forgets every position in memory
 * (the tests use it; the site never stops).
 */
export function watchHistory(): () => void {
  if (!watching) {
    watching = true
    loadPositions()
    enterCurrentEntry()
    // A link fires both events, Back and Forward too. The work is the same and harmless
    // when done twice.
    window.addEventListener('popstate', onAddressChange)
    window.addEventListener('hashchange', onAddressChange)
    window.addEventListener('scroll', rememberPosition, { passive: true })
    window.addEventListener('pagehide', onPageHide)
  }
  return stopWatching
}

/**
 * Tell this file that the page of the current address is now on screen. Call it in a
 * layout effect, so that nothing is painted between the new page and its scroll position.
 *
 * `scroll: true` puts the page where it belongs: at the top for a new history entry, at
 * the place the student left for an entry that was seen before. Pass `scroll: false` when
 * the page did not change (only the query did).
 */
export function pageIsOnScreen(options: { scroll: boolean }): void {
  watchHistory()
  shownEntry = currentEntry
  if (options.scroll) window.scrollTo(0, target)
}
