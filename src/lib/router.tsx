/**
 * The tiny hash router. One import path for everything:
 *
 *   import { Link, matchPath, navigate, parseHash, toHref, useRoute } from '../lib/router'
 *
 * The logic lives in `routerCore.ts`; this file adds the <Link> component.
 * (`ShownRouteContext` and `useLiveRoute` are for the app shell only.)
 */
import type { ComponentPropsWithRef, ReactNode } from 'react'
import { toHref } from './routerCore'

// A file that holds a component should export only components, so that React Fast
// Refresh can update it in place. This re-export breaks that rule on purpose: it keeps
// one import path for the whole router, and this file almost never changes.
/* eslint-disable react-refresh/only-export-components */
export {
  matchPath,
  navigate,
  parseHash,
  ShownRouteContext,
  toHref,
  useLiveRoute,
  useRoute,
} from './routerCore'
/* eslint-enable react-refresh/only-export-components */
export type { Route } from './routerCore'

export interface LinkProps extends Omit<ComponentPropsWithRef<'a'>, 'href'> {
  /** The route to open, for example '/learn/mov' or '/stepper?s=abc'. */
  to: string
}

/**
 * A real <a href="#/…">, so middle-click, "copy link address" and the keyboard all work.
 * Every other anchor attribute (className, aria-*, onClick, ref, …) is passed through.
 */
export function Link({ to, children, ...rest }: LinkProps): ReactNode {
  return (
    <a href={toHref(to)} {...rest}>
      {children}
    </a>
  )
}
