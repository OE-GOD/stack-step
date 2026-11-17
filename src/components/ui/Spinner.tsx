import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'
import type { IconProps } from './icons'

/** A small turning circle. Decoration only: pair it with words, as <Loading> does. */
export function Spinner({ size = 18, className, ...rest }: IconProps): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      {...rest}
      className={cx('shrink-0 animate-spin', className)}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" />
    </svg>
  )
}

export interface LoadingProps extends ComponentPropsWithRef<'p'> {
  /** What is loading. Default "Loading…". */
  label?: string
}

/** "Loading…" with a spinner. Screen readers read it out (`role="status"`). */
export function Loading({ label = 'Loading…', className, ...rest }: LoadingProps): ReactNode {
  return (
    <p role="status" className={cx('flex items-center gap-2 text-muted', className)} {...rest}>
      <Spinner />
      {label}
    </p>
  )
}
