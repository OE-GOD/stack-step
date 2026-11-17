import type { ComponentPropsWithRef, ReactNode } from 'react'
import { buttonClasses, type ButtonSize, type ButtonVariant } from './buttonStyles'

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  /** Default 'secondary'. Use 'primary' for the one main action. */
  variant?: ButtonVariant
  /** Default 'md' (44 px tall). */
  size?: ButtonSize
}

/**
 * A button. Every <button> attribute is passed through (onClick, disabled, aria-*, ref, …).
 * `type` is "button" unless you say otherwise, so it never submits a form by accident.
 *
 * For a button that shows only an icon, use <IconButton>: it makes you give it a name.
 * `className` adds to the built-in classes (`w-full`, `mt-4`); see buttonStyles.ts.
 */
export function Button({
  variant,
  size,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button type={type} className={buttonClasses({ variant, size, className })} {...rest}>
      {children}
    </button>
  )
}
