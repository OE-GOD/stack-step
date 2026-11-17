import { memo, type ReactNode } from 'react'
import { toSigned, type DataView, type MachineState } from '../../emulator'
import { cx } from '../ui/cx'
import { ChangedMark } from './ChangedMark'
import { HexValue } from './HexValue'
import { MachinePanel } from './MachinePanel'
import { dataChanged, visibleText } from './machineView'

export interface DataPanelProps {
  machine: MachineState
  /** Smaller text, no card (MiniStepper). */
  compact?: boolean
  title?: string
  /** Wide screens: the content scrolls under the heading when the card is height-limited. */
  scrollOnWide?: boolean
  className?: string
}

/** A long array shows this many numbers, then "and N more". */
const MAX_NUMBERS = 32

const BITS = { 1: 8, 2: 16, 4: 32, 8: 64 } as const

/** A string with its special characters written out: "Hello World!\n". */
function QuotedText({ text }: { text: string }): ReactNode {
  return (
    <span className="font-mono break-all text-syn-string">
      &quot;
      {visibleText(text).map((part, index) =>
        part.escape ? (
          <span key={index} className="rounded-sm bg-chip px-px text-syn-number">
            {part.text}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
      &quot;
    </span>
  )
}

/** The numbers of a .quad / .long / .word / .byte item, in hex and in decimal. */
function Numbers({ item }: { item: DataView }): ReactNode {
  const shown = item.values.slice(0, MAX_NUMBERS)
  const bits = BITS[item.elementSize]
  return (
    <>
      <ol className="flex flex-wrap gap-x-3 gap-y-1">
        {shown.map((value, index) => (
          <li key={index} className="flex items-baseline gap-1">
            <HexValue value={value} digits={0} reserveMark={false} />
            <span className="text-xs text-muted max-lg:text-sm">
              ({toSigned(value, bits).toString()})
            </span>
          </li>
        ))}
      </ol>
      {item.values.length > MAX_NUMBERS && (
        <p className="text-xs text-muted max-lg:text-sm">
          and {item.values.length - MAX_NUMBERS} more
        </p>
      )}
    </>
  )
}

interface DataItemProps {
  item: DataView
  changed: boolean
}

const DataItem = memo(function DataItem({ item, changed }: DataItemProps): ReactNode {
  return (
    <li className="py-2 text-sm first:pt-0 last:pb-0">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cx('font-mono text-ink', changed ? 'font-bold' : 'font-semibold')}>
          {item.label ?? '(no label)'}
        </span>
        {/* The address in the same form as the stack's addresses (groups of four digits). */}
        <span className="text-xs text-muted max-lg:text-sm">
          <HexValue value={item.address} digits={0} dimZeros={false} reserveMark={false} />
        </span>
        <span className="font-mono text-xs text-syn-directive max-lg:text-sm">
          {item.directive}
        </span>
        {item.readOnly && (
          <span className="rounded-full border border-line px-1.5 text-[0.6875rem] font-semibold text-muted max-lg:text-sm">
            read-only
          </span>
        )}
        {changed && <ChangedMark changed className="ml-0.5" />}
      </p>
      <div className={cx('mt-0.5', changed && 'font-bold')}>
        {item.text !== null ? <QuotedText text={item.text} /> : <Numbers item={item} />}
      </div>
    </li>
  )
})

/**
 * The program's data (`.string`, `.quad`, …): label, address, directive, current values.
 * Renders nothing when the program has no data.
 */
export function DataPanel({
  machine,
  compact = false,
  title = 'Data',
  scrollOnWide = false,
  className,
}: DataPanelProps): ReactNode {
  if (machine.data.length === 0) return null
  return (
    <MachinePanel title={title} compact={compact} scrollOnWide={scrollOnWide} className={className}>
      <ul className="divide-y divide-line">
        {machine.data.map((item, index) => (
          <DataItem
            key={`${item.address}-${index}`}
            item={item}
            changed={dataChanged(item, machine)}
          />
        ))}
      </ul>
    </MachinePanel>
  )
}
