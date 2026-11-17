import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Panel } from '../ui/Panel'
import { cx } from '../ui/cx'
import { edgeFade, FOCUS_RING_FOR_CHILD, scrollStop, useScrollEdges } from './useScrollEdges'

export interface MachinePanelProps {
  title: string
  /** Inside the MiniStepper: no card, a small label instead of a heading. */
  compact?: boolean
  /** Small controls or a hint at the right of the heading (full size only). */
  actions?: ReactNode
  /** Content reaches the edges of the card (rows that open on click). */
  flush?: boolean
  /**
   * The card fills the height its parent gives it, and its content takes the space left
   * under the heading (for a list that scrolls inside the card).
   */
  fill?: boolean
  /**
   * On wide screens (1024 px and up) the card may be shorter than its content: the
   * content then scrolls under the heading, with a fade where it hides more, and the
   * keyboard can reach it to scroll it. Give the card a height limit with `className`.
   */
  scrollOnWide?: boolean
  /**
   * With `scrollOnWide`: whenever this changes, the content scrolls to its end (the newest
   * line of the output, the input box under it).
   */
  scrollEndKey?: unknown
  headingLevel?: 2 | 3 | 4
  className?: string
  id?: string
  children: ReactNode
}

/** The body is the last child of a kit <Panel>: it takes the height left under the heading. */
const FILL =
  'flex min-h-0 flex-col [&>:last-child]:flex [&>:last-child]:min-h-0 [&>:last-child]:flex-1 [&>:last-child]:flex-col'

const SCROLL_ON_WIDE =
  'lg:flex lg:min-h-0 lg:flex-col lg:[&>:last-child]:flex lg:[&>:last-child]:min-h-0 lg:[&>:last-child]:flex-col'

/**
 * The content of a `scrollOnWide` card: it scrolls on wide screens when the card is too
 * short for it. While it hides content, it fades at that edge and is a Tab stop.
 */
function ScrollOnWide({
  title,
  endKey,
  children,
}: {
  title: string
  endKey: unknown
  children: ReactNode
}): ReactNode {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const edges = useScrollEdges(boxRef, true, undefined, contentRef)
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box !== null && endKey !== undefined) box.scrollTop = box.scrollHeight
  }, [endKey])
  return (
    <div className={cx('lg:flex lg:min-h-0 lg:flex-1 lg:flex-col', FOCUS_RING_FOR_CHILD)}>
      <div
        ref={boxRef}
        data-scroll-box=""
        {...scrollStop(edges, title)}
        className={cx(
          'focus-visible:outline-none lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain',
          edgeFade(edges),
        )}
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  )
}

/**
 * The frame of every machine panel: a kit <Panel> on the stepper page, a light labelled
 * section inside the MiniStepper.
 */
export function MachinePanel({
  title,
  compact = false,
  actions,
  flush = false,
  fill = false,
  scrollOnWide = false,
  scrollEndKey,
  headingLevel,
  className,
  id,
  children,
}: MachinePanelProps): ReactNode {
  if (compact) {
    // A named group, not a landmark: the MiniStepper around it is the landmark, and a
    // page with several MiniSteppers would list many landmarks with the same names.
    return (
      <div role="group" aria-label={title} id={id} className={cx('min-w-0', className)}>
        <p className="mb-1 text-sm font-semibold text-muted">{title}</p>
        {children}
      </div>
    )
  }
  return (
    <Panel
      title={title}
      actions={actions}
      flush={flush}
      headingLevel={headingLevel}
      id={id}
      className={cx('min-w-0', fill && FILL, scrollOnWide && SCROLL_ON_WIDE, className)}
    >
      {scrollOnWide ? (
        <ScrollOnWide title={title} endKey={scrollEndKey}>
          {children}
        </ScrollOnWide>
      ) : (
        children
      )}
    </Panel>
  )
}
