/**
 * The tiny hash router: everything except the <Link> component.
 * Import from './router', which re-exports this file and adds <Link>.
 *
 * The route lives in the URL hash, so the site works on any static host with no server
 * setup:
 *
 *   https://example.com/#/learn/mov?x=1   →   path '/learn/mov', query 'x=1'
 *
 * An empty hash means '/'.
 *
 * Because the hash IS the route, in-page anchors such as <a href="#section"> cannot be
 * used on this site: they would replace the route. To jump inside a page, use a button
 * that calls `element.scrollIntoView()` and `element.focus()`.
 *
 * The query is read with URLSearchParams, which reads '+' as a space. Encode query
 * values with encodeURIComponent or base64url (plain base64 would be damaged).
 */
import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'

export interface Route {
  /**
   * Starts with '/'. Has no '/' at the end, except for the root, which is '/'.
   * Already URL-decoded ('#/caf%C3%A9' gives '/café'), so the menu, `matchPath` and a
   * page all see the same text.
   */
  path: string
  /** Shared by every component on the page: read it, do not change it. */
  query: URLSearchParams
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '')
}

/** '/learn//mov/' → '/learn/mov';  'learn' → '/learn';  '' → '/'. */
function normalizePath(path: string): string {
  return `/${splitPath(path).join('/')}`
}

/** Split 'path?query' at the first '?'. The leading '#', if any, is dropped. */
function splitTarget(target: string): { path: string; search: string } {
  const text = target.startsWith('#') ? target.slice(1) : target
  const queryStart = text.indexOf('?')
  if (queryStart === -1) return { path: normalizePath(text), search: '' }
  return { path: normalizePath(text.slice(0, queryStart)), search: text.slice(queryStart + 1) }
}

/**
 * Decode one part of a path, once. It stays as written when
 * - a '%' does not start a valid escape ('100%'), or
 * - the decoded text would hold a '/' ('a%2Fb'): the path must keep its parts.
 */
function decodeSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment)
    return decoded.includes('/') ? segment : decoded
  } catch {
    return segment
  }
}

/** Parse a location hash ('#/learn/mov?x=1') into its parts. Pure. */
export function parseHash(hash: string): Route {
  const { path, search } = splitTarget(hash)
  return {
    path: `/${splitPath(path).map(decodeSegment).join('/')}`,
    query: new URLSearchParams(search),
  }
}

/**
 * '/learn/:lessonId' against '/learn/mov' → { lessonId: 'mov' }; null when no match. Pure.
 *
 * A ':name' part matches exactly one part of the path. Other parts must be equal
 * (letter case matters). A '/' at the end is ignored.
 *
 * Give it the path of a route (`useRoute().path`, `parseHash(…).path`): that path is
 * already URL-decoded, so the values are too. Nothing is decoded a second time here.
 */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const patternParts = splitPath(pattern)
  const pathParts = splitPath(path)
  if (patternParts.length !== pathParts.length) return null

  const params: Record<string, string> = {}
  for (let i = 0; i < patternParts.length; i++) {
    const expected = patternParts[i]
    const actual = pathParts[i]
    if (expected.startsWith(':')) params[expected.slice(1)] = actual
    else if (expected !== actual) return null
  }
  return params
}

/** Build an href for <a>: toHref('/learn/mov') → '#/learn/mov'. Pure. */
export function toHref(to: string): string {
  const { path, search } = splitTarget(to)
  return search === '' ? `#${path}` : `#${path}?${search}`
}

/** Go to a route. `replace` swaps the history entry instead of adding one. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  const href = toHref(to)
  if (options.replace) {
    // A full URL, so a <base> element could never send this somewhere else.
    const url = new URL(window.location.href)
    url.hash = href
    window.location.replace(url)
  } else {
    window.location.hash = href
  }
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function readHash(): string {
  return window.location.hash
}

function readHashOnServer(): string {
  return ''
}

/**
 * The route of the page that is SHOWING. <App> sets it around every page.
 *
 * The address bar changes the moment a link is chosen, but the page of the new address
 * may need a moment to download, and the page before it stays on screen until then. With
 * this, the page that is still on screen keeps seeing its own route, never the next one.
 */
export const ShownRouteContext = createContext<Route | null>(null)

/**
 * The route in the address bar right now. Only the app shell needs this one.
 * A page uses `useRoute`.
 */
export function useLiveRoute(): Route {
  // The snapshot is the hash string, so it only changes when the URL really changes.
  const hash = useSyncExternalStore(subscribeToHash, readHash, readHashOnServer)
  return useMemo(() => parseHash(hash), [hash])
}

/** Current route; re-renders the component when the hash changes. */
export function useRoute(): Route {
  const live = useLiveRoute()
  const shown = useContext(ShownRouteContext)
  return shown ?? live
}
