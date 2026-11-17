import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'

/** `changed` is the orange of "this value just changed". */
export type BadgeTone = 'neutral' | 'primary' | 'good' | 'bad' | 'warn' | 'changed'

const TONES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-surface-2 text-ink',
  primary: 'border-transparent bg-primary-soft text-primary',
  good: 'border-transparent bg-good-soft text-good',
  bad: 'border-transparent bg-bad-soft text-bad',
  warn: 'border-transparent bg-warn-soft text-warn',
  changed: 'border-transparent bg-changed-soft text-changed',
}

export interface BadgeProps extends ComponentPropsWithRef<'span'> {
  /** Default 'neutral'. */
  tone?: BadgeTone
}

/**
 * A small label, such as "Done" or "Lesson 5". The text must carry the meaning: the color
 * only supports it. On a phone it is 14 px, the smallest text a student must read there;
 * on wider screens 12 px.
 */
export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps): ReactNode {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm leading-5 font-semibold whitespace-nowrap md:text-xs',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  )
}
