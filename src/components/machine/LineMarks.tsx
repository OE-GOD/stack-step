import type { ReactNode } from 'react'
import { cx } from '../ui/cx'

/*
 * The marks of a line of code, drawn the same way as in the code editor's gutter: an
 * arrow for the line that runs next, an hourglass while a library function runs, and a
 * round dot for a breakpoint. They are shapes, so they never depend on color alone.
 */

const ARROW_PATH = 'M2 .8 11 6l-9 5.2z'
const HOURGLASS_PATH = 'M2 .5h8v2L7.1 6 10 9.5v2H2v-2L4.9 6 2 2.5z'

export function NextLineArrow({ className }: { className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      className={cx('size-3 fill-primary', className)}
    >
      <path d={ARROW_PATH} />
    </svg>
  )
}

export function LibraryHourglass({ className }: { className?: string }): ReactNode {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      className={cx('size-3 fill-primary', className)}
    >
      <path d={HOURGLASS_PATH} />
    </svg>
  )
}

/** A dot made of a border, so Windows high-contrast mode keeps it. */
export function BreakpointDot({ className }: { className?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx('inline-block size-2.5 rounded-full border-[5px] border-bad', className)}
    />
  )
}
