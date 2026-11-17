import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'
import { cx } from './cx'

export interface PanelProps extends Omit<ComponentPropsWithRef<'section'>, 'title'> {
  /** The heading of the card, for example "Registers". */
  title: ReactNode
  /** Small controls shown at the right of the heading (buttons, a badge, …). */
  actions?: ReactNode
  /** The heading level. Default 2, which is right for a card directly under the page's h1. */
  headingLevel?: 2 | 3 | 4
  /**
   * Leave out the space around the content, for a table or rows that reach the edges.
   * The content is then cut off at the card's round corners, so:
   * - do not put a <Popover> inside a flush panel (its panel would be cut);
   * - a control inside it draws its focus outline INSIDE its own edge (an outline outside
   *   the edge would be cut too). Use quiet controls there, such as a row that opens on
   *   click: on a filled blue button the blue outline could not be seen.
   */
  flush?: boolean
}

/**
 * A titled card: a <section> with a heading, named by that heading for screen readers.
 * Every other <section> attribute is passed through.
 */
export function Panel({
  title,
  actions,
  headingLevel = 2,
  flush = false,
  className,
  children,
  ...rest
}: PanelProps): ReactNode {
  const headingId = useId()
  const Heading = `h${headingLevel}` as const
  return (
    <section
      aria-labelledby={headingId}
      className={cx('rounded-xl border border-line bg-surface shadow-xs', className)}
      {...rest}
    >
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-1.5">
        <Heading id={headingId} className="text-base leading-tight font-semibold text-ink">
          {title}
        </Heading>
        {actions !== undefined && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      <div
        className={
          flush ? 'overflow-hidden rounded-b-xl [&_:focus-visible]:-outline-offset-2' : 'p-4'
        }
      >
        {children}
      </div>
    </section>
  )
}
