/**
 * The look of a button, shared by <Button>, <IconButton> (real buttons) and <ButtonLink>
 * (a link that looks like a button).
 */
import { cx } from './cx'

/**
 * - primary:   the one main action of a page or panel (filled blue)
 * - secondary: every other action (outlined)
 * - ghost:     quiet actions in toolbars (no outline until hover)
 * - danger:    an action that throws data away, such as "Reset progress"
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

/** sm is 36 px tall; md (44 px) and lg (52 px) are big enough for a thumb. */
export type ButtonSize = 'sm' | 'md' | 'lg'

const BASE =
  'inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border text-center ' +
  'leading-tight font-semibold no-underline transition-colors select-none ' +
  'disabled:pointer-events-none disabled:opacity-55 ' +
  'aria-disabled:pointer-events-none aria-disabled:opacity-55'

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-primary text-on-primary hover:bg-primary-hover',
  secondary: 'border-line-strong bg-surface text-ink hover:bg-surface-2',
  ghost: 'border-transparent bg-transparent text-ink hover:bg-surface-2',
  danger: 'border-bad bg-surface text-bad hover:bg-bad-soft',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'min-h-9 px-3 py-1.5 text-sm',
  md: 'min-h-11 px-4 py-2 text-base',
  lg: 'min-h-13 px-6 py-2.5 text-lg',
}

/** For a button that holds only an icon: as wide as it is tall, no side space. */
const SQUARE_SIZES: Record<ButtonSize, string> = {
  sm: 'size-9',
  md: 'size-11',
  lg: 'size-13',
}

export interface ButtonStyleOptions {
  /** Default 'secondary'. */
  variant?: ButtonVariant
  /** Default 'md'. */
  size?: ButtonSize
  /** A square button for a single icon. */
  square?: boolean
  /**
   * Extra classes. They are added to the built-in ones, so use them to ADD something
   * (`w-full`, `mt-4`), not to replace a built-in class with another value of the same
   * kind (a second `px-…` or `bg-…` may lose).
   */
  className?: string
}

export function buttonClasses({
  variant = 'secondary',
  size = 'md',
  square = false,
  className,
}: ButtonStyleOptions = {}): string {
  return cx(BASE, VARIANTS[variant], square ? SQUARE_SIZES[size] : SIZES[size], className)
}
