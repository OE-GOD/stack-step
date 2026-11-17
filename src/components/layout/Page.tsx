import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from '../ui/cx'

/**
 * - text: a column for reading (lessons, About); it fits the `prose` class exactly
 * - wide: the normal page width, the same as the header (stepper, practice, lists)
 * - full: the whole window
 */
export type PageWidth = 'text' | 'wide' | 'full'

const WIDTHS: Record<PageWidth, string> = {
  text: 'max-w-[45rem]',
  wide: 'max-w-6xl',
  full: 'max-w-none',
}

export interface PageContainerProps extends ComponentPropsWithRef<'div'> {
  /** Default 'wide'. */
  width?: PageWidth
}

/**
 * The outer box of every page: it centers the content and gives it the same side space
 * as the header (16 px on a phone, 24 px on wider screens).
 */
export function PageContainer({
  width = 'wide',
  className,
  children,
  ...rest
}: PageContainerProps): ReactNode {
  return (
    <div
      className={cx('mx-auto w-full px-4 py-8 md:px-6 md:py-12', WIDTHS[width], className)}
      {...rest}
    >
      {children}
    </div>
  )
}

export interface PageHeaderProps {
  /** The text of the page's one <h1>. */
  title: ReactNode
  /** One or two plain sentences under the title. */
  lead?: ReactNode
  /** Anything else that belongs to the top of the page (a badge, a button row). */
  children?: ReactNode
}

/** The top of a page: its one <h1> and an optional short introduction. */
export function PageHeader({ title, lead, children }: PageHeaderProps): ReactNode {
  return (
    <header className="mb-8 md:mb-10">
      <h1 className="text-3xl leading-tight font-extrabold tracking-tight text-balance md:text-4xl">
        {title}
      </h1>
      {lead !== undefined && (
        <p className="mt-3 max-w-2xl text-lg text-pretty text-muted">{lead}</p>
      )}
      {children}
    </header>
  )
}
