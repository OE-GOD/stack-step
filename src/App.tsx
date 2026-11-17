import {
  Suspense,
  useDeferredValue,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AppShell } from './components/layout/AppShell'
import { pageIsOnScreen } from './components/layout/historyScroll'
import { eagerPage, lazyPage, type PageSource } from './components/layout/lazyPage'
import { ErrorBoundary } from './components/ui/ErrorBoundary'
import { Loading } from './components/ui/Spinner'
import { isLessonId, lessonById } from './content/lessonList'
import { isTopicId, topicById } from './content/topics'
import HomePage from './features/home/HomePage'
import { matchPath, ShownRouteContext, useLiveRoute, type Route } from './lib/router'

const SITE_NAME = 'Stack Step'
/** The home page keeps the title that index.html starts with. */
const HOME_TITLE = 'Stack Step: learn x86-64 assembly one step at a time'

type RouteParams = Record<string, string>

interface RouteEntry {
  pattern: string
  /** The page's name in the browser tab ("Stepper · Stack Step"); null for the site's own title. */
  title: string | null | ((params: RouteParams) => string)
  /**
   * A check of the parameters. When it says no, the address is not this route (and so it
   * becomes "Page not found"). A page can therefore trust the id it reads from the route.
   */
  accepts?: (params: RouteParams) => boolean
  /** A page takes no props. It reads its own parameters with useRoute() + matchPath(). */
  page: PageSource
}

/**
 * The route table. The first entry that matches wins.
 *
 * Every page except Home is loaded only when it is first opened, which keeps the first
 * load small.
 */
const ROUTES: readonly RouteEntry[] = [
  { pattern: '/', title: null, page: eagerPage(HomePage) },
  {
    pattern: '/stepper',
    title: 'Stepper',
    page: lazyPage(() => import('./features/stepper/StepperPage')),
  },
  {
    pattern: '/learn',
    title: 'Learn',
    page: lazyPage(() => import('./features/lessons/LessonsIndexPage')),
  },
  {
    // Any id: for one that is not a lesson, the lesson page says so and links to the list.
    pattern: '/learn/:lessonId',
    title: ({ lessonId }) => (isLessonId(lessonId) ? lessonById(lessonId).title : 'No such lesson'),
    page: lazyPage(() => import('./features/lessons/LessonPage')),
  },
  {
    pattern: '/practice',
    title: 'Practice',
    page: lazyPage(() => import('./features/practice/PracticeHubPage')),
  },
  {
    // The practice hub, the quiz page and the progress page all call it "the mixed quiz".
    pattern: '/practice/quiz',
    title: 'Mixed quiz',
    page: lazyPage(() => import('./features/practice/QuizPage')),
  },
  {
    // A practice topic, or 'weak': a mix of the student's weakest topics. Any id: for one
    // that is not a topic, the practice page says so and links to the hub.
    pattern: '/practice/:topicId',
    title: ({ topicId }) => {
      if (topicId === 'weak') return 'Practice my weak spots'
      return isTopicId(topicId) ? `Practice: ${topicById(topicId).title}` : 'No such practice topic'
    },
    page: lazyPage(() => import('./features/practice/PracticeSessionPage')),
  },
  {
    pattern: '/cheatsheet',
    title: 'Cheat sheet',
    page: lazyPage(() => import('./features/cheatsheet/CheatSheetPage')),
  },
  {
    pattern: '/progress',
    title: 'Progress',
    page: lazyPage(() => import('./features/progress/ProgressPage')),
  },
  {
    pattern: '/about',
    title: 'About',
    page: lazyPage(() => import('./features/about/AboutPage')),
  },
  // For engineers only: every piece of the UI kit on one page. The built site does not
  // have this route (the build drops it, so '/dev/kit' is "Page not found" there).
  ...(import.meta.env.DEV
    ? [
        {
          pattern: '/dev/kit',
          title: 'UI kit',
          page: lazyPage(() => import('./components/ui/KitGallery')),
        },
      ]
    : []),
]

const NOT_FOUND: RouteEntry = {
  pattern: '',
  title: 'Page not found',
  page: lazyPage(() => import('./features/notfound/NotFoundPage')),
}

function findRoute(path: string): { route: RouteEntry; params: RouteParams } {
  for (const route of ROUTES) {
    const params = matchPath(route.pattern, path)
    if (params !== null && (route.accepts === undefined || route.accepts(params))) {
      return { route, params }
    }
  }
  return { route: NOT_FOUND, params: {} }
}

function pageTitle(route: RouteEntry, params: RouteParams): string {
  const title = typeof route.title === 'function' ? route.title(params) : route.title
  return title === null ? HOME_TITLE : `${title} · ${SITE_NAME}`
}

/**
 * The stand-in for a page that has to wait for something of its own after it is on screen
 * (a page that loads a part of itself later and has no loading message for it).
 * Moving from page to page does not show it: see <App>.
 * (`data-page-stand-in` lets e2e/shell.spec.ts check that it stays away.)
 */
function PageLoading(): ReactNode {
  return (
    <div data-page-stand-in className="mx-auto w-full max-w-6xl px-4 py-10 md:px-6 md:py-14">
      <Loading className="animate-appear" />
    </div>
  )
}

export default function App(): ReactNode {
  // The address bar changes at once. The page changes when its file is here: until then
  // the page before it stays on screen (`useDeferredValue`), so a quick download shows no
  // loading message at all, and the page region is never empty for a moment.
  //
  // On the first load there is no page before it. A page that must be downloaded starts
  // as `null`: the page region stays empty until the file is here.
  const liveRoute = useLiveRoute()
  const [firstPageIsHere] = useState(() => findRoute(liveRoute.path).route.page.isReady())
  const deferredRoute = useDeferredValue<Route | null>(
    liveRoute,
    firstPageIsHere ? undefined : null,
  )
  // A change of the query alone is not a new page: the page sees it at once.
  const shownRoute =
    deferredRoute !== null && deferredRoute.path === liveRoute.path ? liveRoute : deferredRoute
  const busy = shownRoute !== liveRoute

  // While the first page downloads, the tab already has the name of that page.
  const { route, params } = findRoute((shownRoute ?? liveRoute).path)
  const title = pageTitle(route, params)
  // A layout effect, so that the tab gets its new name in the same moment as the page.
  useLayoutEffect(() => {
    document.title = title
  }, [title])

  // Where the keyboard focus was at the moment the address changed.
  const focusAtNavigation = useRef<Element | null>(null)
  const livePath = liveRoute.path
  useLayoutEffect(() => {
    focusAtNavigation.current = document.activeElement
  }, [livePath])

  // When another page has been put on screen: scroll to where it belongs (the top for a
  // link, the old place for Back and Forward), and put keyboard focus on the page region,
  // so that keyboard and screen reader users land on the new page.
  // - The first page keeps the focus at the top, so that the first Tab reaches the skip link.
  // - A change of the query alone (same path) is not another page.
  // - A page that arrives late does not take the focus away from something the student
  //   went to in the meantime (for example the menu, opened again to choose another page).
  const mainRef = useRef<HTMLElement | null>(null)
  const pathOnScreen = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (shownRoute === null) return
    const previousPath = pathOnScreen.current
    pathOnScreen.current = shownRoute.path
    const isAnotherPage = previousPath !== shownRoute.path
    pageIsOnScreen({ scroll: isAnotherPage })
    if (!isAnotherPage || previousPath === null) return
    const focused = document.activeElement
    const studentMovedFocus =
      focused !== null && focused !== document.body && focused !== focusAtNavigation.current
    if (!studentMovedFocus) mainRef.current?.focus({ preventScroll: true })
  }, [shownRoute])

  const { Page, forgetFailedDownload } = route.page
  return (
    <AppShell mainRef={mainRef} busy={busy}>
      {/*
        The Suspense boundary stays in place from page to page. That is what lets React keep
        the old page on screen while the next one downloads: a new boundary would show its
        fallback at once.
      */}
      <Suspense fallback={<PageLoading />}>
        {shownRoute !== null && (
          <ShownRouteContext value={shownRoute}>
            {/*
              The key gives every path a fresh page and a fresh boundary. When a page could
              not be shown, a failed download is forgotten only now, after the message is on
              screen: the next visit to the page then asks the network again.
            */}
            <ErrorBoundary key={shownRoute.path} onError={forgetFailedDownload}>
              <Page />
            </ErrorBoundary>
          </ShownRouteContext>
        )}
      </Suspense>
    </AppShell>
  )
}
