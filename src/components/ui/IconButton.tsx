import type { ComponentPropsWithRef, ReactNode } from 'react'
import { buttonClasses, type ButtonSize, type ButtonVariant } from './buttonStyles'

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'aria-label'> {
  /** What the button does, in words. Screen readers read it; nobody sees it. */
  label: string
  /** Default 'ghost'. */
  variant?: ButtonVariant
  /** Default 'md' (44 × 44 px). */
  size?: ButtonSize
}

/**
 * A square button that shows only an icon. `label` is required, so the button always has
 * a name: <IconButton label="Step back"><StepBackIcon /></IconButton>.
 * Prefer a <Button> with visible text for the main actions of a page.
 */
export function IconButton({
  label,
  variant = 'ghost',
  size,
  type = 'button',
  className,
  children,
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <button
      type={type}
      aria-label={label}
      className={buttonClasses({ variant, size, square: true, className })}
      {...rest}
    >
      {children}
    </button>
  )
}
