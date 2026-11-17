import type { ReactNode } from 'react'
import { registerFamily, toSigned, type Reg64 } from '../../emulator'
import { cx } from '../ui/cx'
import { WarningIcon } from '../ui/icons'
import { RichText } from '../ui/RichText'
import { HexValue } from './HexValue'
import { byteHex, byteOf, registerParts } from './machineView'

/** Byte 7 (the highest) is drawn first, so the cells read like the hex number does. */
const BYTE_ORDER = [7, 6, 5, 4, 3, 2, 1, 0] as const

export interface RegisterPartsProps {
  id: string
  base: Reg64
  value: bigint
  /**
   * The value before the last step, when a 32-bit write in that step cleared the top
   * 32 bits; otherwise null.
   */
  clearedFrom: bigint | null
}

interface ByteBarProps {
  value: bigint
  firstByte: number
  byteCount: number
  /** Mark the top four bytes: a 32-bit write just set them to 0. */
  clearedTop: boolean
}

/**
 * Eight cells, one per byte of the register. The cells that belong to the name are filled
 * and show their two hex digits; the others are empty dashed outlines.
 */
function ByteBar({ value, firstByte, byteCount, clearedTop }: ByteBarProps): ReactNode {
  return (
    <span aria-hidden="true" className="inline-grid w-max grid-cols-8 gap-0.5">
      {BYTE_ORDER.map((index) => {
        const inside = index >= firstByte && index < firstByte + byteCount
        const cleared = clearedTop && index >= 4
        return (
          <span
            key={index}
            className={cx(
              'flex h-5 w-[1.625rem] items-center justify-center rounded-[3px] border font-mono text-[0.6875rem] leading-none max-lg:text-sm',
              !inside && 'border-dashed border-line',
              inside && !cleared && 'border-primary/45 bg-primary-soft text-ink',
              cleared && 'border-changed bg-changed-soft font-bold text-ink',
            )}
          >
            {inside ? byteHex(byteOf(value, index)) : ''}
          </span>
        )
      })}
    </span>
  )
}

/**
 * The open view of one register: every smaller name inside it (rax → eax, ax, ah, al),
 * with its value and a bar of eight byte cells that shows which bytes the name covers.
 * Below: the whole value as unsigned and signed decimal numbers.
 */
export function RegisterParts({ id, base, value, clearedFrom }: RegisterPartsProps): ReactNode {
  const parts = registerParts(base, value)
  const name32 = registerFamily(base).find((info) => info.size === 32)?.name ?? base

  return (
    <div id={id} className="@container border-t border-line bg-surface-2 py-2.5 pr-3 pl-9">
      <ul className="space-y-2">
        {parts.map((part) => (
          <li
            key={part.name}
            className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 @[23rem]:grid-cols-[2.5rem_3.5rem_auto_minmax(0,1fr)]"
          >
            <span className="font-mono text-sm font-semibold text-ink">{part.name}</span>
            <span className="text-xs whitespace-nowrap text-muted max-lg:text-sm">
              {part.size} bits
            </span>
            <HexValue
              value={part.value}
              digits={part.size / 4}
              reserveMark={false}
              className="justify-self-end text-[0.8125rem] max-lg:text-sm @[23rem]:order-last @[23rem]:justify-self-start"
            />
            <span className="col-span-3 @[23rem]:col-span-1">
              <ByteBar
                value={value}
                firstByte={part.firstByte}
                byteCount={part.byteCount}
                clearedTop={clearedFrom !== null && part.size === 64}
              />
            </span>
          </li>
        ))}
      </ul>

      {clearedFrom !== null && (
        <div className="mt-2.5 flex gap-2 rounded-md border border-changed/50 bg-surface px-2.5 py-2 text-sm">
          <WarningIcon size={16} className="mt-0.5 text-changed" />
          <div className="min-w-0">
            <p>
              <RichText
                text={`Writing \`${name32}\` (32 bits) also set the top 32 bits of \`${base}\` to 0.`}
              />
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted">
              Before this step:
              <HexValue
                value={clearedFrom}
                reserveMark={false}
                className="text-[0.8125rem] text-ink max-lg:text-sm"
              />
            </p>
          </div>
        </div>
      )}

      <p className="mt-2.5 text-xs text-muted max-lg:text-sm">
        Unsigned: <span className="font-mono text-ink">{value.toString()}</span>
        <span aria-hidden="true"> · </span>
        <span className="sr-only">. </span>
        Signed: <span className="font-mono text-ink">{toSigned(value, 64).toString()}</span>
      </p>
    </div>
  )
}
