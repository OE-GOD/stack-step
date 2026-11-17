import { memo, type ReactNode } from 'react'
import { groupHex, hexDigits } from '../../emulator'
import { cx } from '../ui/cx'
import { ChangedMark } from './ChangedMark'
import { leadingZeros } from './machineView'

export interface HexValueProps {
  value: bigint
  /** How many hex digits: 16 for a 64-bit value (the default), 0 = as many as needed. */
  digits?: number
  /** The value changed in the last step: bold, a dot, the word "changed" for screen readers. */
  changed?: boolean
  /**
   * Changes on every step (use the snapshot version). The short flash of a changed value
   * starts again whenever it changes.
   */
  flashKey?: number
  /** Dim the leading zeros, so the digits that matter stand out (default true). */
  dimZeros?: boolean
  /** Keep room for the "changed" dot even when there is none, so nothing moves (default true). */
  reserveMark?: boolean
  /** Gaps between groups of four digits (default true). */
  group?: boolean
  className?: string
}

/**
 * A number in hex, in the code font: `0x` + a fixed number of digits, in groups of four.
 *
 * The gaps between the groups are CSS margins, not spaces, so copying the value gives
 * `0x0000000000000007`. The element with `data-hex` holds exactly that text.
 */
export const HexValue = memo(function HexValue({
  value,
  digits = 16,
  changed = false,
  flashKey = 0,
  dimZeros = true,
  reserveMark = true,
  group = true,
  className,
}: HexValueProps): ReactNode {
  const text = hexDigits(value, digits)
  const zeros = dimZeros ? leadingZeros(text) : 0
  let position = 0
  // Groups of four digits, cut from the right ('40 1126').
  const groups = (group ? groupHex(value, digits).split(' ') : [text]).map((part, index) => {
    const start = position
    position += part.length
    // The part of this group that is still leading zeros.
    const dim = Math.min(part.length, Math.max(0, zeros - start))
    return (
      <span key={index} className={index > 0 ? 'ml-[0.35ch]' : undefined}>
        {dim > 0 && <span className="text-muted">{part.slice(0, dim)}</span>}
        {part.slice(dim)}
      </span>
    )
  })

  return (
    <span
      className={cx(
        'inline-flex items-center font-mono whitespace-nowrap',
        changed && 'font-bold',
        className,
      )}
    >
      {/* The key restarts the flash on every change. */}
      <span
        key={changed ? flashKey : 'still'}
        data-hex=""
        className={cx('-mx-0.5 rounded-sm px-0.5', changed && 'animate-flash')}
      >
        <span className="text-muted">0x</span>
        {groups}
      </span>
      {(changed || reserveMark) && <ChangedMark changed={changed} className="ml-1.5" />}
    </span>
  )
})
