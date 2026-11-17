import type { ReactNode } from 'react'
import { HexText } from '../HexText'

export interface ChipLabelProps {
  /** The text of a chip, for example "rax = 0x0000000000000005". */
  label: string
}

/**
 * The text on a chip: the register name in bold, then the value in the one look of a
 * whole register on the site: its digits in groups of four with a small gap between the
 * groups (HexText). The tempting chips differ exactly in the top half, so the groups make
 * them easy to compare, here and with the feedback under the table.
 *
 * When the chip is too narrow for one line, the text breaks after the `=` and the value
 * gets a line of its own. Every cell and every column of the tray is at least as wide as
 * that line (CELL_WIDTH, TRAY_GRID), so a chip is never wider than its box.
 */
export function ChipLabel({ label }: ChipLabelProps): ReactNode {
  const cut = label.indexOf('=')
  if (cut === -1) return <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>

  const name = label.slice(0, cut).trim()
  const value = label.slice(cut + 1).trim()
  return (
    <span className="min-w-0">
      <span data-chip-name="" className="whitespace-nowrap">
        <span className="font-bold">{name}</span> =
      </span>{' '}
      <HexText text={value} nowrap />
    </span>
  )
}
