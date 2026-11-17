import type { ReactNode } from 'react'
import { Link, type LinkProps } from '../../lib/router'
import { cx } from './cx'

/**
 * A link to a route inside a sentence or a list. It is underlined, so it never depends on
 * color alone.
 */
export function TextLink({ className, children, ...rest }: LinkProps): ReactNode {
  return (
    <Link
      className={cx(
        'rounded-sm font-medium text-primary underline decoration-1 underline-offset-[0.2em]',
        'hover:text-primary-hover hover:decoration-2',
        className,
      )}
      {...rest}
    >
      {children}
    </Link>
  )
}
