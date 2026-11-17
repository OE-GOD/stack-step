/**
 * Pages for the route table in src/App.tsx.
 *
 * Every page except Home is in its own file, which the browser downloads the first time
 * the page is opened (`React.lazy`). That keeps the first load small.
 *
 * A download can fail (a phone on a bad connection). React.lazy remembers a failure for
 * ever, so a plain lazy page could never be opened again without a full reload. Here a
 * failed download can be forgotten: the page then gets a new lazy component, which asks
 * the network again the next time the page is opened.
 */
import { lazy, type ComponentType } from 'react'

/** Downloads a page file. The default export of the file is the page component. */
export type PageLoader = () => Promise<{ default: ComponentType }>

export interface PageSource {
  /**
   * The page component. Read it each time you render: after a failed download that was
   * forgotten, it is a new component.
   */
  readonly Page: ComponentType
  /** True when the page can show at once: its file is already here. */
  readonly isReady: () => boolean
  /**
   * Call after the page failed to show. If the reason was a failed download, the failure
   * is forgotten, so the next visit to the page asks the network again. For any other
   * failure it does nothing.
   */
  readonly forgetFailedDownload: () => void
}

/** A page that is part of the first download. */
export function eagerPage(Page: ComponentType): PageSource {
  return { Page, isReady: () => true, forgetFailedDownload: () => undefined }
}

/** A page that is downloaded when it is first opened: lazyPage(() => import('./AboutPage')). */
export function lazyPage(load: PageLoader): PageSource {
  let ready = false
  let failed = false

  const makePage = (): ComponentType =>
    lazy(async () => {
      try {
        const file = await load()
        ready = true
        return file
      } catch (error) {
        failed = true
        throw error
      }
    })

  let Page = makePage()

  return {
    get Page() {
      return Page
    },
    isReady: () => ready,
    forgetFailedDownload() {
      if (!failed) return
      failed = false
      Page = makePage()
    },
  }
}
