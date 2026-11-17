import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'
import { FIELD_CLASSES } from './fieldStyles'

export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** Use the code font: for a value that the student types as code, such as 0x7ffe. */
  mono?: boolean
}

/**
 * A text field. Every <input> attribute is passed through.
 *
 * - Always give it a visible <label> (`<label htmlFor>` + `id`), never only a placeholder.
 * - `aria-invalid="true"` colors the border. A color is not enough on its own: also say
 *   in words what is wrong (a <Callout tone="bad"> or a line of text under the field).
 */
export function Input({ mono = false, className, ...rest }: InputProps): ReactNode {
  return <input className={cx(FIELD_CLASSES, mono && 'font-mono', className)} {...rest} />
}
