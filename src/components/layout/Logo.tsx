import type { ReactNode } from 'react'

export interface LogoProps {
  /** Width and height in pixels. Default 30. */
  size?: number
  className?: string
}

/**
 * The Stack Step mark: three boxes of a stack on a tile, and an arrow that points at the
 * top of the stack (the lowest box, because the stack grows down). The same drawing as
 * the favicon. Decoration only: the word "Stack Step" stands next to it.
 */
export function Logo({ size = 30, className }: LogoProps): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="48" height="48" rx="11" className="fill-brand" />
      <rect x="9" y="9" width="21" height="8" rx="2" className="fill-on-brand" opacity="0.5" />
      <rect x="9" y="20" width="21" height="8" rx="2" className="fill-on-brand" opacity="0.75" />
      <rect x="9" y="31" width="21" height="8" rx="2" className="fill-on-brand" />
      <path d="M43 35 34 29.5v11z" className="fill-brand-accent" />
    </svg>
  )
}
