/**
 * The optional AI tutor: a button near the bottom right of the page that opens a chat
 * drawer.
 *
 *   <TutorMount getContext={() => ({ page: 'stepper', code, machine, problem: null })} />
 *
 * The tutor is OFF by default. On mount this asks the tutor function (`GET /api/tutor`)
 * once per page load if a key is set on the server. Until the function says yes, this
 * renders nothing: no button, no placeholder, no layout shift. On a static host there is
 * no function, the request fails quietly, and the page works exactly as without a tutor.
 * The code of the drawer itself is downloaded only after the function said yes.
 *
 * For the page that uses it:
 * - `getContext` is called at the moment the student sends a question, so return what
 *   the page shows at that moment. It does not have to be the same function every time.
 * - The button is `position: fixed`. A page with its own bar at the bottom of the screen
 *   sets the CSS variable `--tutor-bottom-offset` (for example `64px`) on any element
 *   around this one, or on `:root`, and the button moves up by that much.
 * - Put it anywhere inside the page, but not inside an element with a CSS `transform` or
 *   `filter` (such an element takes over the positioning of fixed elements inside it).
 */
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { isTutorKnownEnabled, whenTutorEnabled } from './availability'
import type { TutorContext } from './context'

// What the page tells the tutor: { page, code, machine, problem }. See context.ts.
export type { TutorContext }

export interface TutorMountProps {
  getContext: () => TutorContext
}

/**
 * The drawer, downloaded on demand. If the download fails (the student went offline),
 * the tutor is simply not there: the page must never break because of the tutor.
 */
const TutorDrawer = lazy(() =>
  import('./TutorDrawer').catch(() => ({ default: (): ReactNode => null })),
)

/** If the tutor itself has a bug, it disappears. The page around it keeps working. */
class TutorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** Renders nothing unless the tutor function says that the tutor is turned on. */
export function TutorMount({ getContext }: TutorMountProps): ReactNode {
  const [enabled, setEnabled] = useState(isTutorKnownEnabled)

  useEffect(() => {
    if (enabled) return
    let mounted = true
    void whenTutorEnabled().then((answer) => {
      if (mounted && answer) setEnabled(true)
    })
    return () => {
      mounted = false
    }
  }, [enabled])

  if (!enabled) return null
  return (
    <TutorBoundary>
      <Suspense fallback={null}>
        <TutorDrawer getContext={getContext} />
      </Suspense>
    </TutorBoundary>
  )
}
