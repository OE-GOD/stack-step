import type { ReactNode } from 'react'
import { cx } from '../../../components/ui/cx'
import { groupsOfFour, shownHexDigits } from './answerText'

export interface HexTextProps {
  /** A number as a question shows it: '0x1111222233334444', '0x1f8'. Other text is shown as it is. */
  text: string
  /**
   * Keep the number on one line (a chip, whose box is made wide enough for it). By default
   * a long number may wrap between two groups.
   */
  nowrap?: boolean
  className?: string
}

/**
 * A hex number in the code font, its digits in groups of four: the one look of a whole
 * register on every page (the stepper's HexValue looks the same). The gaps are CSS margins,
 * not spaces, so copying it gives exactly `text`. A long number may wrap between groups,
 * never inside one (and `0x` stays with the first group), so it never pushes a phone
 * screen sideways.
 */
export function HexText({ text, nowrap = false, className }: HexTextProps): ReactNode {
  const digits = shownHexDigits(text)
  if (digits === null || !/^0x/i.test(text.trim())) {
    return <span className={cx('font-mono [overflow-wrap:anywhere]', className)}>{text}</span>
  }
  return (
    <span data-hex="" className={cx('font-mono', nowrap && 'whitespace-nowrap', className)}>
      {groupsOfFour(digits).map((group, index) => (
        <span
          key={index}
          className={cx('inline-block whitespace-nowrap', index > 0 && 'ml-[0.35ch]')}
        >
          {index === 0 && <span className="text-muted">0x</span>}
          {group}
        </span>
      ))}
    </span>
  )
}
