import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'

/** A key on the keyboard, drawn as a key: <Kbd>S</Kbd>, <Kbd>Shift</Kbd>. */
export function Kbd({ className, children, ...rest }: ComponentPropsWithRef<'kbd'>): ReactNode {
  return (
    <kbd
      className={cx(
        'inline-flex min-w-6 items-center justify-center rounded-md border border-b-2 border-line-strong bg-surface px-1.5 py-px font-mono text-[0.8125rem] leading-5 font-medium text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  )
}
