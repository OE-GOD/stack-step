import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cx } from './cx'
import {
  CheckCircleIcon,
  InfoIcon,
  LightbulbIcon,
  WarningIcon,
  XCircleIcon,
  type IconProps,
} from './icons'

/**
 * - info:    a side note
 * - analogy: the everyday comparison of a lesson
 * - good:    the answer was right
 * - bad:     the answer was wrong
 * - warn:    something that often goes wrong
 */
export type CalloutTone = 'info' | 'analogy' | 'good' | 'bad' | 'warn'

interface ToneStyle {
  /** The word shown next to the icon when no `label` is given. */
  label: string
  box: string
  accent: string
  Icon: (props: IconProps) => ReactNode
}

const TONES: Record<CalloutTone, ToneStyle> = {
  info: {
    label: 'Note',
    box: 'border-primary/35 bg-primary-soft',
    accent: 'text-primary',
    Icon: InfoIcon,
  },
  analogy: {
    label: 'Think of it like this',
    box: 'border-line-strong/60 bg-surface-2',
    accent: 'text-ink',
    Icon: LightbulbIcon,
  },
  good: {
    label: 'Correct',
    box: 'border-good/40 bg-good-soft',
    accent: 'text-good',
    Icon: CheckCircleIcon,
  },
  bad: {
    label: 'Not correct',
    box: 'border-bad/40 bg-bad-soft',
    accent: 'text-bad',
    Icon: XCircleIcon,
  },
  warn: {
    label: 'Warning',
    box: 'border-warn/40 bg-warn-soft',
    accent: 'text-warn',
    Icon: WarningIcon,
  },
}

export interface CalloutProps extends ComponentPropsWithRef<'div'> {
  /** Default 'info'. */
  tone?: CalloutTone
  /** The word next to the icon. Each tone has its own default ("Note", "Correct", …). */
  label?: string
}

/**
 * A colored box for a note or for feedback. It always shows an icon and a word, so the
 * meaning never depends on color alone.
 *
 * Every other <div> attribute is passed through. For feedback that appears after an
 * answer, add `role="status"` so screen readers read it out.
 */
export function Callout({
  tone = 'info',
  label,
  className,
  children,
  ...rest
}: CalloutProps): ReactNode {
  const style = TONES[tone]
  return (
    <div className={cx('rounded-xl border px-4 py-3', style.box, className)} {...rest}>
      <p className={cx('flex items-center gap-2 text-sm font-bold', style.accent)}>
        <style.Icon size={18} />
        {label ?? style.label}
      </p>
      <div className="mt-1 text-ink [&>*+*]:mt-2">{children}</div>
    </div>
  )
}
