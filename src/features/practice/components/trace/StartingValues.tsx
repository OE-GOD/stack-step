import type { ReactNode } from 'react'
import { HexText } from '../HexText'
import { WORDS } from './words'

export interface StartingValuesProps {
  /** The heading of the table. Default "Starting values". */
  title?: string
  rows: readonly { name: string; value: string }[]
}

/**
 * The registers before the first line runs: a small table, one register per row. The
 * values are in the code font and line up digit under digit, in groups of four like the
 * chips (and every whole register on the site), so a value is easy to compare with
 * another value and with a chip.
 */
export function StartingValues({ title, rows }: StartingValuesProps): ReactNode {
  return (
    <div className="w-fit max-w-full overflow-hidden rounded-xl border border-line bg-surface shadow-xs">
      <table className="text-left">
        <caption className="border-b border-line bg-surface-2 px-3 py-1.5 text-left text-sm font-semibold text-muted">
          {title ?? WORDS.startingValues}
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">{WORDS.register}</th>
            <th scope="col">{WORDS.value}</th>
          </tr>
        </thead>
        <tbody className="font-mono text-sm leading-[1.3]">
          {rows.map((row) => (
            <tr key={row.name} className="border-b border-line last:border-b-0">
              <th scope="row" className="py-1 pr-2 pl-3 font-bold sm:py-1.5">
                {row.name}
              </th>
              <td className="py-1 pr-3 sm:py-1.5">
                <HexText text={row.value} nowrap />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
