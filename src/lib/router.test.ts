// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createElement, createRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Link,
  matchPath,
  navigate,
  parseHash,
  ShownRouteContext,
  toHref,
  useLiveRoute,
  useRoute,
} from './router'

/** Wait until the browser has told everybody about a change of the hash. */
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

beforeEach(async () => {
  await goTo('#/')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('parseHash', () => {
  it.each([
    ['', '/'],
    ['#', '/'],
    ['#/', '/'],
    ['#/stepper', '/stepper'],
    ['#/learn/mov', '/learn/mov'],
    ['/learn/mov', '/learn/mov'],
    ['#learn/mov', '/learn/mov'],
    ['#/learn/', '/learn'],
    ['#/learn/mov/', '/learn/mov'],
    ['#//learn///mov', '/learn/mov'],
    ['#/Learn/MOV', '/Learn/MOV'],
  ])('reads the path of %j as %j', (hash, path) => {
    expect(parseHash(hash).path).toBe(path)
  })

  it.each([
    ['#/learn/a%20b', '/learn/a b'],
    ['#/caf%C3%A9', '/café'],
    ['#/%61bout', '/about'],
    ['#/learn/%6Dov?x=%31', '/learn/mov'],
  ])('decodes the path of %j to %j', (hash, path) => {
    expect(parseHash(hash).path).toBe(path)
  })

  it('decodes each part of the path only once', () => {
    // '%2541' is the text '%41', not the letter 'A'.
    expect(parseHash('#/learn/%2541').path).toBe('/learn/%41')
  })

  it.each([
    ['#/learn/100%', '/learn/100%'],
    ['#/learn/%E0%A4%A', '/learn/%E0%A4%A'],
    ['#/%', '/%'],
  ])('keeps a part that cannot be decoded as it is: %j', (hash, path) => {
    expect(parseHash(hash).path).toBe(path)
  })

  it('keeps a part that hides a slash as it is, so the path keeps its parts', () => {
    expect(parseHash('#/learn/a%2Fb').path).toBe('/learn/a%2Fb')
    expect(parseHash('#/learn/a%2fb/c%20d').path).toBe('/learn/a%2fb/c d')
  })

  it('splits the path from the query', () => {
    const { path, query } = parseHash('#/learn/mov?x=1')
    expect(path).toBe('/learn/mov')
    expect(query.get('x')).toBe('1')
    expect([...query.keys()]).toEqual(['x'])
  })

  it('gives an empty query when there is none', () => {
    expect([...parseHash('#/learn').query]).toEqual([])
    expect([...parseHash('#/learn?').query]).toEqual([])
    expect([...parseHash('').query]).toEqual([])
  })

  it('reads a query on the home page', () => {
    const { path, query } = parseHash('#/?tab=2')
    expect(path).toBe('/')
    expect(query.get('tab')).toBe('2')
    expect(parseHash('#?tab=2').path).toBe('/')
    expect(parseHash('#?tab=2').query.get('tab')).toBe('2')
  })

  it('decodes query values and keeps repeated keys', () => {
    const { query } = parseHash('#/stepper?s=mov%20rax%2C%205&note=a+b&tag=1&tag=2&empty=')
    expect(query.get('s')).toBe('mov rax, 5')
    expect(query.get('note')).toBe('a b')
    expect(query.getAll('tag')).toEqual(['1', '2'])
    expect(query.get('empty')).toBe('')
    expect(query.get('missing')).toBeNull()
  })

  it('only splits at the first question mark', () => {
    const { path, query } = parseHash('#/stepper?s=what?&t=1')
    expect(path).toBe('/stepper')
    expect(query.get('s')).toBe('what?')
    expect(query.get('t')).toBe('1')
  })

  it('gives a new query object every time', () => {
    expect(parseHash('#/a?x=1').query).not.toBe(parseHash('#/a?x=1').query)
  })
})

describe('matchPath', () => {
  it('matches a pattern without parameters', () => {
    expect(matchPath('/', '/')).toEqual({})
    expect(matchPath('/stepper', '/stepper')).toEqual({})
    expect(matchPath('/practice/quiz', '/practice/quiz')).toEqual({})
  })

  it('reads parameters', () => {
    expect(matchPath('/learn/:lessonId', '/learn/mov')).toEqual({ lessonId: 'mov' })
    expect(matchPath('/practice/:topicId', '/practice/weak')).toEqual({ topicId: 'weak' })
    expect(matchPath('/:a/x/:b', '/1/x/2')).toEqual({ a: '1', b: '2' })
  })

  it.each([
    ['/stepper', '/learn'],
    ['/stepper', '/'],
    ['/', '/stepper'],
    ['/learn', '/learn/mov'],
    ['/learn/:lessonId', '/learn'],
    ['/learn/:lessonId', '/learn/'],
    ['/learn/:lessonId', '/learn/mov/extra'],
    ['/learn/:lessonId', '/practice/mov'],
    ['/stepper', '/Stepper'],
    ['/stepper', '/stepperx'],
  ])('does not match %j against %j', (pattern, path) => {
    expect(matchPath(pattern, path)).toBeNull()
  })

  it('ignores a slash at the end and doubled slashes', () => {
    expect(matchPath('/learn/:lessonId', '/learn/mov/')).toEqual({ lessonId: 'mov' })
    expect(matchPath('/learn/:lessonId/', '/learn/mov')).toEqual({ lessonId: 'mov' })
    expect(matchPath('/stepper', '//stepper//')).toEqual({})
    expect(matchPath('/', '')).toEqual({})
  })

  it('works on the path that parseHash gives', () => {
    const { path } = parseHash('#/learn/stack-and-rsp/?from=home')
    expect(matchPath('/learn/:lessonId', path)).toEqual({ lessonId: 'stack-and-rsp' })
  })

  it('gives decoded parameters for a path from parseHash', () => {
    const lesson = (hash: string) => matchPath('/learn/:lessonId', parseHash(hash).path)
    expect(lesson('#/learn/a%20b')).toEqual({ lessonId: 'a b' })
    expect(lesson('#/learn/caf%C3%A9')).toEqual({ lessonId: 'café' })
    expect(lesson('#/learn/100%')).toEqual({ lessonId: '100%' })
    // A hidden slash does not make a new part of the path.
    expect(lesson('#/learn/a%2Fb')).toEqual({ lessonId: 'a%2Fb' })
  })

  it('matches fixed parts that were written with escapes, through parseHash', () => {
    expect(matchPath('/about', parseHash('#/%61bout').path)).toEqual({})
  })

  it('does not decode by itself: the path of a route is decoded already', () => {
    expect(matchPath('/learn/:lessonId', '/learn/%41')).toEqual({ lessonId: '%41' })
    expect(matchPath('/about', '/%61bout')).toBeNull()
  })
})

describe('toHref', () => {
  it.each([
    ['/learn/mov', '#/learn/mov'],
    ['/', '#/'],
    ['', '#/'],
    ['learn', '#/learn'],
    ['/learn/', '#/learn'],
    ['#/learn/mov', '#/learn/mov'],
    ['/stepper?s=abc', '#/stepper?s=abc'],
    ['/stepper?s=a%20b&t=1', '#/stepper?s=a%20b&t=1'],
    ['/stepper?', '#/stepper'],
    ['?tab=2', '#/?tab=2'],
  ])('turns %j into %j', (to, href) => {
    expect(toHref(to)).toBe(href)
  })

  it('is undone by parseHash', () => {
    const { path, query } = parseHash(toHref('/practice/rip?seed=7'))
    expect(path).toBe('/practice/rip')
    expect(query.get('seed')).toBe('7')
  })
})

describe('navigate', () => {
  it('changes the hash and adds a history entry', async () => {
    const before = window.history.length
    const changed = nextHashChange()
    navigate('/learn/mov?x=1')
    await changed
    expect(window.location.hash).toBe('#/learn/mov?x=1')
    expect(window.history.length).toBe(before + 1)
  })

  it('with replace, changes the hash without adding a history entry', async () => {
    const before = window.history.length
    const changed = nextHashChange()
    navigate('/about', { replace: true })
    await changed
    expect(window.location.hash).toBe('#/about')
    expect(window.history.length).toBe(before)
  })

  it('keeps the rest of the address', async () => {
    const page = window.location.href.split('#')[0]
    const changed = nextHashChange()
    navigate('/cheatsheet', { replace: true })
    await changed
    expect(window.location.href).toBe(`${page}#/cheatsheet`)
  })
})

describe('useRoute', () => {
  it('gives the current route', async () => {
    await goTo('#/learn/mov?x=1')
    const { result } = renderHook(() => useRoute())
    expect(result.current.path).toBe('/learn/mov')
    expect(result.current.query.get('x')).toBe('1')
  })

  it('gives the home page for an empty hash', async () => {
    await goTo('')
    const { result } = renderHook(() => useRoute())
    expect(result.current.path).toBe('/')
  })

  it('re-renders when the hash changes', async () => {
    const { result } = renderHook(() => useRoute())
    expect(result.current.path).toBe('/')

    act(() => navigate('/practice/rip'))
    await waitFor(() => expect(result.current.path).toBe('/practice/rip'))

    act(() => navigate('/progress', { replace: true }))
    await waitFor(() => expect(result.current.path).toBe('/progress'))
  })

  it('gives the same object while the hash stays the same', async () => {
    await goTo('#/stepper?s=abc')
    const { result, rerender } = renderHook(() => useRoute())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
    expect(result.current.query).toBe(first.query)
  })

  it('stops listening when the component goes away', () => {
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useRoute())
    const listeners = added.mock.calls.filter(([type]) => type === 'hashchange')
    expect(listeners.length).toBeGreaterThan(0)
    unmount()
    const gone = removed.mock.calls.filter(([type]) => type === 'hashchange')
    expect(gone).toHaveLength(listeners.length)
  })
})

describe('the route of the page that is showing', () => {
  // What <App> does around every page while the next page is still downloading.
  function shownAs(hash: string) {
    const shown = parseHash(hash)
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(ShownRouteContext, { value: shown }, children)
    return { shown, wrapper }
  }

  it('useRoute gives the route that the app is showing, not the address bar', async () => {
    await goTo('#/learn/mov?x=1')
    const { shown, wrapper } = shownAs('#/learn/mov?x=1')
    const { result } = renderHook(() => useRoute(), { wrapper })
    expect(result.current).toBe(shown)

    // The student chooses another page. Its file is still downloading: this page stays.
    act(() => navigate('/stepper'))
    await waitFor(() => expect(window.location.hash).toBe('#/stepper'))
    expect(result.current).toBe(shown)
    expect(result.current.path).toBe('/learn/mov')
    expect(result.current.query.get('x')).toBe('1')
  })

  it('useLiveRoute always follows the address bar', async () => {
    const { wrapper } = shownAs('#/learn/mov')
    const { result } = renderHook(() => useLiveRoute(), { wrapper })
    expect(result.current.path).toBe('/')

    act(() => navigate('/stepper?s=abc'))
    await waitFor(() => expect(result.current.path).toBe('/stepper'))
    expect(result.current.query.get('s')).toBe('abc')
  })

  it('without the app around it, useRoute is the address bar', async () => {
    await goTo('#/about')
    const { result } = renderHook(() => ({ route: useRoute(), live: useLiveRoute() }))
    expect(result.current.route.path).toBe('/about')
    expect(result.current.live.path).toBe('/about')
  })
})

describe('Link', () => {
  it('renders a real link to the route', () => {
    render(createElement(Link, { to: '/learn/mov' }, 'The mov lesson'))
    const link = screen.getByRole('link', { name: 'The mov lesson' })
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('#/learn/mov')
  })

  it('passes other attributes, the ref and the click handler through', () => {
    const onClick = vi.fn()
    const ref = createRef<HTMLAnchorElement>()
    render(
      createElement(
        Link,
        { to: '/about', className: 'big', 'aria-current': 'page', id: 'about-link', onClick, ref },
        'About',
      ),
    )
    const link = screen.getByRole('link', { name: 'About' })
    expect(link.className).toBe('big')
    expect(link.getAttribute('aria-current')).toBe('page')
    expect(link.id).toBe('about-link')
    expect(ref.current).toBe(link)
    link.click()
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('goes to the route when it is clicked', async () => {
    render(createElement(Link, { to: '/progress' }, 'Progress'))
    const changed = nextHashChange()
    screen.getByRole('link', { name: 'Progress' }).click()
    await changed
    expect(window.location.hash).toBe('#/progress')
  })
})
