import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'

/**
 * Text that screen readers read but nobody sees. Use it to name a control that shows only
 * an icon, or to add a word that sighted students get from the layout.
 */
export function VisuallyHidden({
  className,
  children,
  ...rest
}: ComponentPropsWithRef<'span'>): ReactNode {
  return (
    <span className={cx('sr-only', className)} {...rest}>
      {children}
    </span>
  )
}
