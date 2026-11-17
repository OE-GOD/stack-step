import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'
import { FIELD_CLASSES } from './fieldStyles'

/**
 * A drop-down list, drawn by the browser so that it works well on phones.
 * Every <select> attribute is passed through; put <option> elements inside.
 * Always give it a visible <label> (`<label htmlFor>` + `id`).
 */
export function Select({
  className,
  children,
  ...rest
}: ComponentPropsWithRef<'select'>): ReactNode {
  return (
    <select className={cx(FIELD_CLASSES, 'cursor-pointer', className)} {...rest}>
      {children}
    </select>
  )
}
